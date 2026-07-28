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

    let file =
        fs::File::open(&temp_zip_path).map_err(|e| format!("Failed to open temp zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    fs::create_dir_all(&staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to access zip file: {}", e))?;

        let entry_name = file.name().to_string();

        if entry_name.starts_with("__MACOSX/") || entry_name == "__MACOSX" {
            continue;
        }

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
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to copy zip contents: {}", e))?;
        }
    }

    let find_manifest_dir = |start: &std::path::Path| -> Option<std::path::PathBuf> {
        if start.join("manifest.json").exists() || start.join("engine_manifest.json").exists() {
            return Some(start.to_path_buf());
        }
        if let Ok(read_dir) = fs::read_dir(start) {
            for entry in read_dir.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    let name = p.file_name().unwrap_or_default().to_string_lossy();
                    if !name.starts_with('.') && !name.starts_with("__MACOSX") {
                        if p.join("manifest.json").exists() || p.join("engine_manifest.json").exists() {
                            return Some(p);
                        }
                    }
                }
            }
        }
        None
    };

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
        named_dir = themes_dir.join(&final_name);
        let _ = fs::remove_dir_all(&named_dir);
    }

    fs::rename(&staging_dir, &named_dir)
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

    let mut temp_file =
        std::fs::File::create(dest).map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Error while downloading: {}", e))?;
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
