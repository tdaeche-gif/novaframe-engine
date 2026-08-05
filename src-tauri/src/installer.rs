use tauri::Manager;
use tauri::Emitter;
use crate::dlog;

pub fn sync_shared_runtime(app: &tauri::AppHandle) {
    let themes_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("themes"),
        Err(e) => {
            dlog(app, &format!("[shared-runtime] no app_data_dir: {}", e));
            return;
        }
    };
    if let Err(e) = std::fs::create_dir_all(&themes_dir) {
        dlog(app, &format!("[shared-runtime] create themes dir failed: {}", e));
        return;
    }
    let dest = themes_dir.join("three.min.js");

    let src = match app
        .path()
        .resolve("resources/three.min.js", tauri::path::BaseDirectory::Resource)
    {
        Ok(p) => p,
        Err(e) => {
            dlog(app, &format!("[shared-runtime] resolve resource failed: {}", e));
            return;
        }
    };

    let src_len = std::fs::metadata(&src).map(|m| m.len()).ok();
    let dest_len = std::fs::metadata(&dest).map(|m| m.len()).ok();
    if src_len.is_some() && src_len == dest_len {
        return;
    }

    match std::fs::copy(&src, &dest) {
        Ok(n) => dlog(app, &format!("[shared-runtime] wrote three.min.js ({} bytes) -> {:?}", n, dest)),
        Err(e) => dlog(app, &format!("[shared-runtime] copy failed src={:?} err={}", src, e)),
    }
}

static INSTALL_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ── Install limits ───────────────────────────────────────────────────────────
// A theme is HTML/JS/GLSL plus a few textures; the largest shipped wallpaper is
// well under 50 MB. These caps exist so a wrong URL, a truncated CDN response or
// a hostile archive cannot fill the user's disk.
//
// The extraction caps matter most: nothing about a zip's *compressed* size
// bounds what it expands to. A 1 MB archive of compressed zeroes decompresses to
// hundreds of GB, and `std::io::copy` will happily write every byte.
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;
const MAX_EXTRACTED_BYTES: u64 = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 5_000;

/// Locate the directory holding the theme manifest inside an extracted archive.
///
/// Returns `start` itself for a flat zip, or the single wrapper folder one level
/// down for a zip packaged with a containing directory. Whatever this returns is
/// what gets moved into the themes directory — see the rename in
/// `download_and_install_theme`.
pub(crate) fn find_manifest_dir(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let has_manifest = |p: &std::path::Path| {
        p.join("manifest.json").exists() || p.join("engine_manifest.json").exists()
    };

    if has_manifest(start) {
        return Some(start.to_path_buf());
    }
    if let Ok(read_dir) = std::fs::read_dir(start) {
        for entry in read_dir.flatten() {
            let p = entry.path();
            if p.is_dir() {
                let name = p.file_name().unwrap_or_default().to_string_lossy();
                if !name.starts_with('.') && !name.starts_with("__MACOSX") && has_manifest(&p) {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// Extract a downloaded theme archive into `staging_dir`, enforcing entry-count
/// and total-size caps. Blocking; call under `spawn_blocking`.
fn extract_zip(zip_path: &std::path::Path, staging_dir: &std::path::Path) -> Result<(), String> {
    use std::fs;

    let file = fs::File::open(zip_path).map_err(|e| format!("Failed to open temp zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!(
            "Refusing archive: {} entries exceeds the {} entry limit",
            archive.len(),
            MAX_ZIP_ENTRIES
        ));
    }

    fs::create_dir_all(staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    let mut extracted: u64 = 0;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to access zip file: {}", e))?;

        let entry_name = file.name().to_string();

        if entry_name.starts_with("__MACOSX/") || entry_name == "__MACOSX" {
            continue;
        }

        // enclosed_name() is what defends against `../` entries and absolute
        // paths — it returns None for anything that would escape the root.
        let outpath = match file.enclosed_name() {
            Some(path) => staging_dir.join(path),
            None => continue,
        };

        if file.is_dir() {
            fs::create_dir_all(&outpath)
                .map_err(|e| format!("Failed to create extracted dir: {}", e))?;
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p)
                        .map_err(|e| format!("Failed to create parent dir: {}", e))?;
                }
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create extracted file: {}", e))?;

            // Cap per entry against the REMAINING budget, so the running total
            // is what's enforced rather than any single file's size. `take`
            // stops the copy at the limit instead of trusting the header.
            let remaining = MAX_EXTRACTED_BYTES.saturating_sub(extracted);
            let written = std::io::copy(&mut std::io::Read::take(&mut file, remaining + 1), &mut outfile)
                .map_err(|e| format!("Failed to copy zip contents: {}", e))?;
            extracted += written;
            if extracted > MAX_EXTRACTED_BYTES {
                return Err(format!(
                    "Refusing archive: extracted size exceeds the {} byte limit",
                    MAX_EXTRACTED_BYTES
                ));
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn handle_engine_apply(app: tauri::AppHandle, token: String) -> Result<String, String> {
    let _guard = INSTALL_MUTEX.lock().await;
    let hardware_id = machine_uid::get().unwrap_or_else(|_| "unknown-device".to_string());
    dlog(&app, &format!("[engine-apply] starting verification for token len={}", token.len()));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client init failed: {}", e))?;

    let payload = serde_json::json!({
        "token": token,
        "hardwareId": hardware_id
    });

    let res = client
        .post("https://api.novaframe.co.uk/api/engine/verify-token")
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("License verification network request failed: {}", e))?;

    let status = res.status();
    let body_text = res.text().await.unwrap_or_default();
    dlog(&app, &format!("[engine-apply] verify-token status={} body_len={}", status, body_text.len()));

    if !status.is_success() {
        return Err(format!("Server error HTTP {}: {}", status, body_text));
    }

    let data: serde_json::Value = serde_json::from_str(&body_text)
        .map_err(|e| format!("Invalid server response: {}", e))?;

    if !data.get("success").and_then(|v| v.as_bool()).unwrap_or(false) {
        let err_msg = data.get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("License verification failed");
        return Err(err_msg.to_string());
    }

    let wallpaper = data.get("wallpaper").ok_or("Missing wallpaper details in response")?;
    let wallpaper_id = wallpaper.get("id").and_then(|v| v.as_str()).ok_or("Missing wallpaper id")?.to_string();
    let download_url = wallpaper.get("downloadUrl").and_then(|v| v.as_str()).ok_or("Missing download url")?.to_string();
    let wallpaper_title = wallpaper.get("title").and_then(|v| v.as_str()).map(|s| s.to_string());

    download_and_install_theme(app, download_url, wallpaper_id, wallpaper_title).await
}

#[tauri::command]
pub async fn check_theme_updates_rust(themes: serde_json::Value) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .post("https://api.novaframe.co.uk/api/engine/check-theme-updates")
        .json(&serde_json::json!({ "themes": themes }))
        .send()
        .await
        .map_err(|e| format!("Network request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json)
}

#[tauri::command]
pub fn get_themes_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {}", e))?
        .join("themes");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn download_and_install_theme(
    app: tauri::AppHandle,
    url: String,
    theme_id: String,
    wallpaper_title: Option<String>,
) -> Result<String, String> {
    use std::fs;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {}", e))?;
    let themes_dir = app_data_dir.join("themes");

    if !themes_dir.exists() {
        fs::create_dir_all(&themes_dir)
            .map_err(|e| format!("Failed to create themes dir: {}", e))?;
    }

    let temp_zip_path = std::env::temp_dir().join(format!("novaframe-{}.zip", theme_id));
    let _zip_guard = TempFileGuard(temp_zip_path.clone());

    let staging_dir = themes_dir.join(format!(".staging-{}", theme_id));
    let _ = fs::remove_dir_all(&staging_dir);
    let _staging_guard = TempDirGuard(staging_dir.clone());

    dlog(&app, &format!("[install] START theme_id={} title={:?} url_len={}", theme_id, wallpaper_title, url.len()));

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    const MAX_ATTEMPTS: u32 = 3;
    let mut last_err = String::new();
    let mut downloaded = false;
    for attempt in 1..=MAX_ATTEMPTS {
        match download_to_file(&client, &url, &temp_zip_path).await {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(e) => {
                last_err = e;
                println!(
                    "[Novaframe] Download attempt {}/{} failed: {}",
                    attempt, MAX_ATTEMPTS, last_err
                );
                if attempt < MAX_ATTEMPTS {
                    tokio::time::sleep(std::time::Duration::from_millis(1500 * attempt as u64))
                        .await;
                }
            }
        }
    }
    if !downloaded {
        return Err(format!("Download failed after {} attempts: {}", MAX_ATTEMPTS, last_err));
    }

    println!(
        "[Novaframe] Download complete, extracting to staging {:?}",
        staging_dir
    );

    // Extraction is entirely blocking file I/O. Running it inline on a tokio
    // worker (this command is `async`, and holds INSTALL_MUTEX across a download
    // whose timeout is 180s) pins a runtime thread for the duration.
    {
        let zip_path = temp_zip_path.clone();
        let staging = staging_dir.clone();
        tokio::task::spawn_blocking(move || extract_zip(&zip_path, &staging))
            .await
            .map_err(|e| format!("Extraction task failed: {}", e))??;
    }

    let target_dir = match find_manifest_dir(&staging_dir) {
        Some(dir) => dir,
        None => return Err("Downloaded archive missing manifest.json".into()),
    };

    if !target_dir.join("manifest.json").exists() && target_dir.join("engine_manifest.json").exists() {
        let _ = fs::copy(target_dir.join("engine_manifest.json"), target_dir.join("manifest.json"));
    }

    let mut folder_slug = wallpaper_title
        .as_deref()
        .map(slugify_title)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| theme_id.clone());

    if folder_slug.is_empty() {
        folder_slug = format!("theme-{}", theme_id);
    }

    let mut final_name = folder_slug.clone();
    let mut named_dir = themes_dir.join(&final_name);

    if named_dir.exists() {
        let existing_id = read_marketplace_id(&named_dir);
        let is_same_wallpaper = existing_id.as_deref() == Some(&theme_id);

        if !is_same_wallpaper {
            let mut counter = 2;
            loop {
                let candidate_name = format!("{}-{}", folder_slug, counter);
                let candidate_dir = themes_dir.join(&candidate_name);
                if !candidate_dir.exists() {
                    final_name = candidate_name;
                    named_dir = candidate_dir;
                    break;
                }
                if read_marketplace_id(&candidate_dir).as_deref() == Some(&theme_id) {
                    final_name = candidate_name;
                    named_dir = candidate_dir;
                    break;
                }
                counter += 1;
            }
        }
    }

    let sidecar_data = serde_json::json!({
        "marketplace_id": theme_id,
        "installed_at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        "title": wallpaper_title
    });
    let _ = fs::write(
        target_dir.join(".nova_meta.json"),
        serde_json::to_string_pretty(&sidecar_data).unwrap_or_default(),
    );

    if named_dir.exists() {
        let _ = fs::remove_dir_all(&named_dir);
    }

    // Move `target_dir`, NOT `staging_dir`.
    //
    // find_manifest_dir() deliberately looks one level down, so a zip built with
    // a top-level wrapper folder resolves to `staging/<wrapper>`. Renaming
    // `staging_dir` in that case installed the theme as
    // `<themes>/<slug>/<wrapper>/manifest.json` — one level too deep for
    // scanThemes(), which reads `<themes>/<name>/manifest.json`. The install
    // reported success and the wallpaper silently never appeared in the
    // dropdown. It also put .nova_meta.json a level below where
    // read_marketplace_id() looks, so re-applying the same wallpaper never
    // matched and piled up `slug-2`, `slug-3`, ... forever.
    //
    // The TempDirGuard on staging_dir cleans up the now-empty wrapper.
    fs::rename(&target_dir, &named_dir)
        .map_err(|e| format!("Failed to move staged theme into place: {}", e))?;

    dlog(&app, &format!("[install] DONE installed at {:?} -> emitting theme-installed", named_dir));

    let absolute_path = named_dir.to_string_lossy().to_string();
    let _ = app.emit("theme-installed", absolute_path);

    Ok(final_name)
}

struct TempFileGuard(std::path::PathBuf);
impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

struct TempDirGuard(std::path::PathBuf);
impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn download_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status: {}", response.status()));
    }

    // Reject an oversized body before a single byte hits the disk when the
    // server is honest enough to declare a length.
    if let Some(len) = response.content_length() {
        if len > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Refusing download: {} bytes exceeds the {} byte limit",
                len, MAX_DOWNLOAD_BYTES
            ));
        }
    }

    let mut temp_file =
        std::fs::File::create(dest).map_err(|e| format!("Failed to create temp file: {}", e))?;

    // And enforce it again while streaming, because Content-Length is a hint,
    // not a promise — a chunked response can omit or lie about it.
    let mut written: u64 = 0;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Error while downloading: {}", e))?;
        written += chunk.len() as u64;
        if written > MAX_DOWNLOAD_BYTES {
            return Err(format!(
                "Aborted download: exceeded the {} byte limit",
                MAX_DOWNLOAD_BYTES
            ));
        }
        temp_file
            .write_all(&chunk)
            .map_err(|e| format!("Error writing chunk: {}", e))?;
    }
    temp_file
        .flush()
        .map_err(|e| format!("Error flushing temp file: {}", e))?;
    Ok(())
}

fn read_marketplace_id(theme_dir: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(theme_dir.join(".nova_meta.json")).ok()?;
    let json: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    json.get("marketplace_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

pub fn is_safe_theme_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.')
}

#[tauri::command]
pub fn delete_theme(app: tauri::AppHandle, name: String) -> Result<(), String> {
    if !is_safe_theme_name(&name) {
        return Err("Invalid theme name".into());
    }

    let themes_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {}", e))?
        .join("themes");

    let target = themes_dir.join(&name);
    if !target.is_dir() {
        return Err("Theme not found".into());
    }
    let canonical_target = target.canonicalize().map_err(|e| e.to_string())?;
    let canonical_root = themes_dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_target.starts_with(&canonical_root) || canonical_target == canonical_root {
        return Err("Refusing to delete outside the themes directory".into());
    }

    std::fs::remove_dir_all(&canonical_target).map_err(|e| e.to_string())?;
    dlog(&app, &format!("[library] deleted theme {:?}", canonical_target));
    Ok(())
}

fn slugify_title(s: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;

    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_was_dash = false;
        } else if (c.is_whitespace() || c == '-' || c == '_') && !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = out.trim_end_matches('-');
    if trimmed.chars().count() > 80 {
        trimmed.chars().take(80).collect()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a zip in a temp dir from (name, contents) pairs. Entry names with a
    /// trailing '/' become directories.
    fn make_zip(label: &str, entries: &[(&str, &[u8])]) -> (std::path::PathBuf, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("nova-test-{}-{}", label, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let zip_path = root.join("theme.zip");
        let file = std::fs::File::create(&zip_path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        for (name, body) in entries {
            if name.ends_with('/') {
                w.add_directory(name.trim_end_matches('/'), opts).unwrap();
            } else {
                w.start_file(*name, opts).unwrap();
                w.write_all(body).unwrap();
            }
        }
        w.finish().unwrap();

        let staging = root.join("staging");
        (zip_path, staging)
    }

    #[test]
    fn flat_zip_puts_manifest_at_the_root() {
        let (zip, staging) = make_zip(
            "flat",
            &[("manifest.json", b"{}"), ("index.html", b"<html></html>")],
        );
        extract_zip(&zip, &staging).unwrap();

        let target = find_manifest_dir(&staging).expect("manifest dir found");
        assert_eq!(target, staging);
        assert!(target.join("manifest.json").exists());
    }

    /// The install renames `target_dir` (not `staging_dir`) into place. For a zip
    /// with a wrapper folder those differ — and renaming the wrong one installed
    /// the theme one level too deep, where scanThemes() never found it.
    #[test]
    fn wrapper_folder_zip_resolves_to_the_inner_dir() {
        let (zip, staging) = make_zip(
            "wrapper",
            &[
                ("Deep Space/", b""),
                ("Deep Space/manifest.json", b"{}"),
                ("Deep Space/index.html", b"<html></html>"),
            ],
        );
        extract_zip(&zip, &staging).unwrap();

        let target = find_manifest_dir(&staging).expect("manifest dir found");
        assert_ne!(target, staging, "must descend into the wrapper folder");
        assert_eq!(target, staging.join("Deep Space"));
        // What actually matters: the dir we move into place has the manifest at
        // ITS root, so the installed theme is <themes>/<slug>/manifest.json.
        assert!(target.join("manifest.json").exists());
    }

    #[test]
    fn macosx_metadata_dir_is_not_mistaken_for_the_theme() {
        let (zip, staging) = make_zip(
            "macosx",
            &[
                ("__MACOSX/", b""),
                ("__MACOSX/manifest.json", b"{}"),
                ("Real Theme/", b""),
                ("Real Theme/manifest.json", b"{}"),
            ],
        );
        extract_zip(&zip, &staging).unwrap();

        assert!(!staging.join("__MACOSX").exists(), "__MACOSX must be skipped");
        assert_eq!(find_manifest_dir(&staging).unwrap(), staging.join("Real Theme"));
    }

    #[test]
    fn rejects_archive_with_too_many_entries() {
        let names: Vec<String> = (0..MAX_ZIP_ENTRIES + 1).map(|i| format!("f{}.txt", i)).collect();
        let entries: Vec<(&str, &[u8])> = names.iter().map(|n| (n.as_str(), &b"x"[..])).collect();
        let (zip, staging) = make_zip("manyentries", &entries);

        let err = extract_zip(&zip, &staging).unwrap_err();
        assert!(err.contains("entry limit"), "unexpected error: {}", err);
    }

    /// A zip bomb: tiny compressed, enormous expanded. Nothing about the archive
    /// size bounds what io::copy will write, so the cap must be on output bytes.
    #[test]
    fn rejects_archive_that_expands_past_the_size_cap() {
        let big = vec![0u8; 8 * 1024 * 1024]; // compresses to almost nothing
        let mut entries: Vec<(String, &[u8])> = Vec::new();
        for i in 0..80 {
            entries.push((format!("blob{}.bin", i), &big[..]));
        }
        let refs: Vec<(&str, &[u8])> = entries.iter().map(|(n, b)| (n.as_str(), *b)).collect();
        let (zip, staging) = make_zip("bomb", &refs);

        assert!(
            std::fs::metadata(&zip).unwrap().len() < 1024 * 1024,
            "test archive should be small on disk"
        );
        let err = extract_zip(&zip, &staging).unwrap_err();
        assert!(err.contains("byte limit"), "unexpected error: {}", err);
    }

    #[test]
    fn path_traversal_entries_are_dropped() {
        let (zip, staging) = make_zip(
            "traversal",
            &[
                ("../../escaped.txt", b"nope"),
                ("manifest.json", b"{}"),
            ],
        );
        extract_zip(&zip, &staging).unwrap();

        assert!(staging.join("manifest.json").exists());
        assert!(!staging.parent().unwrap().join("escaped.txt").exists());
        assert!(!staging.join("../../escaped.txt").exists());
    }
}
