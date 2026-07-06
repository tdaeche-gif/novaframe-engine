// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;

#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect};

use std::sync::atomic::{AtomicBool, Ordering};

// Set while a native control (e.g. the theme <select>) has an open OS popup.
// Native select dropdowns render as a popup outside the settings NSWindow's own
// frame — when the popup extends above the window's top edge (common, since the
// panel is docked to screen-edge and the dropdown often has more items than fit
// below), the cursor moving into that popup is technically outside `frame`, so
// the hover-poll loop below would see "not hovered" and collapse the window out
// from under the open popup. While this flag is set, the loop treats the panel
// as hovered unconditionally so it can't collapse mid-selection.
static SETTINGS_PANEL_LOCKED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
fn get_hardware_id() -> Result<String, String> {
    machine_uid::get().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings_panel_locked(locked: bool) {
    SETTINGS_PANEL_LOCKED.store(locked, Ordering::Relaxed);
}

#[tauri::command]
fn expand_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let panel_width: f64 = 360.0; // 320 panel + 40 cog tab
        let panel_height: f64 = 600.0;
        let monitor_h = monitor.size().height as f64 / scale_factor;
        let monitor_w = monitor.size().width as f64 / scale_factor;
        // Anchor to far-right of monitor
        let logical_x = (monitor.position().x as f64 / scale_factor) + (monitor_w - panel_width);
        let logical_y = (monitor.position().y as f64 / scale_factor)
            + (monitor_h - panel_height) / 2.0;

        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            panel_width,
            panel_height,
        )));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            logical_x, logical_y,
        )));
    }
}

#[tauri::command]
fn collapse_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = 600.0;
        let logical_width = 40.0;
        let monitor_h = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor)
            + (monitor.size().width as f64 / scale_factor)
            - logical_width;
        let logical_y =
            (monitor.position().y as f64 / scale_factor) + (monitor_h - logical_height) / 2.0;

        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            logical_width,
            logical_height,
        )));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(
            logical_x, logical_y,
        )));
    }
}

#[tauri::command]
fn log_from_js(message: String) {
    println!("[JS] {}", message);
}

#[tauri::command]
async fn open_storefront_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("storefront") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("storefront window not registered".into())
    }
}

#[tauri::command]
fn get_themes_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {}", e))?
        .join("themes");
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
async fn download_and_install_theme(
    app: tauri::AppHandle,
    url: String,
    theme_id: String,
    wallpaper_title: Option<String>,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use std::fs;
    use std::io::{Read, Write};
    use std::path::Path;

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app_data_dir: {}", e))?;
    let themes_dir = app_data_dir.join("themes");

    // Ensure themes directory exists
    if !themes_dir.exists() {
        fs::create_dir_all(&themes_dir)
            .map_err(|e| format!("Failed to create themes dir: {}", e))?;
    }

    // Prepare temp file path
    let temp_zip_path = std::env::temp_dir().join(format!("{}.zip", theme_id));

    println!("[Novaframe] Downloading theme {} from {}", theme_id, url);

    // Download using reqwest
    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("Failed to fetch: {}", e))?;

    if !response.status().is_success() {
        return Err(format!(
            "Download failed with status: {}",
            response.status()
        ));
    }

    let mut temp_file = fs::File::create(&temp_zip_path)
        .map_err(|e| format!("Failed to create temp file: {}", e))?;

    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Error while downloading: {}", e))?;
        temp_file
            .write_all(&chunk)
            .map_err(|e| format!("Error writing chunk: {}", e))?;
    }

    println!(
        "[Novaframe] Download complete, extracting to {:?}",
        themes_dir
    );

    // Extract using zip crate
    let file =
        fs::File::open(&temp_zip_path).map_err(|e| format!("Failed to open temp zip: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip archive: {}", e))?;

    let target_theme_dir = themes_dir.join(&theme_id);

    if !target_theme_dir.exists() {
        fs::create_dir_all(&target_theme_dir)
            .map_err(|e| format!("Failed to create target theme dir: {}", e))?;
    }

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to access zip file: {}", e))?;

        let entry_name = file.name().to_string();

        // Skip macOS resource-fork junk that some zip tools include.
        if entry_name.starts_with("__MACOSX/") || entry_name == "__MACOSX" {
            continue;
        }

        // Strip any single top-level directory inside the archive so files land
        // directly under <themes_dir>/<theme_id>/. e.g. archive contains
        // "myTheme/index.html" → we want .../themes/<theme_id>/index.html
        let stripped = entry_name
            .splitn(2, '/')
            .nth(1)
            .unwrap_or("")
            .to_string();

        // If the archive has no top-level wrapper (already flat), keep the full path.
        let relative_path = if stripped.is_empty() {
            entry_name.clone()
        } else {
            stripped
        };

        let outpath = match file.enclosed_name() {
            Some(_) => target_theme_dir.join(&relative_path),
            None => continue,
        };

        if entry_name.ends_with('/') {
            fs::create_dir_all(&outpath).unwrap_or_default();
        } else {
            if let Some(p) = outpath.parent() {
                if !p.exists() {
                    fs::create_dir_all(p).unwrap_or_default();
                }
            }
            let mut outfile = fs::File::create(&outpath)
                .map_err(|e| format!("Failed to create extracted file: {}", e))?;
            std::io::copy(&mut file, &mut outfile)
                .map_err(|e| format!("Failed to write extracted file: {}", e))?;
        }
    }

    // Clean up
    let _ = fs::remove_file(temp_zip_path);

    // ── Rename install dir from UUID → human-readable title ─────────────────
    // This makes the settings-panel dropdown show "Ignis: Interactive Solar Wind"
    // instead of a raw UUID. Falls back to the UUID folder name if no title was
    // supplied (shouldn't happen with the new listener, but defensive).
    let display_name = wallpaper_title
        .as_deref()
        .map(|t| sanitize_dir_name(t))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| theme_id.clone());

    let named_dir = themes_dir.join(&display_name);

    if named_dir != target_theme_dir {
        if named_dir.exists() {
            // Same-named theme already installed — remove the stale one first so
            // scanThemes doesn't pick up duplicate entries.
            let _ = fs::remove_dir_all(&named_dir);
        }
        // Rename the just-extracted UUID folder to the human-readable name.
        if let Err(e) = fs::rename(&target_theme_dir, &named_dir) {
            println!(
                "[Novaframe] Rename UUID → title failed ({}); keeping UUID folder name.",
                e
            );
        }
    }

    println!(
        "[Novaframe] Theme installed successfully at {:?}",
        if named_dir.exists() { &named_dir } else { &target_theme_dir }
    );

    // Notify the main window that a theme was installed
    use tauri::Emitter;
    let final_dir = if named_dir.exists() { &named_dir } else { &target_theme_dir };
    let absolute_path = final_dir.to_string_lossy().to_string();
    let _ = app.emit("theme-installed", absolute_path);

    Ok(display_name)
}

/// Sanitize a wallpaper title for use as a directory name:
///   - strip path separators and other filesystem-unsafe chars
///   - collapse whitespace
///   - trim leading/trailing dots and whitespace
///   - cap at 80 chars
fn sanitize_dir_name(input: &str) -> String {
    let cleaned: String = input
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let collapsed: String = trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if collapsed.is_empty() {
        return String::new();
    }
    if collapsed.chars().count() > 80 {
        collapsed.chars().take(80).collect()
    } else {
        collapsed
    }
}

fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        // GLSL shaders and anything unknown: plain text is fine for fetch()
        _ => "text/plain",
    }
}

/// Serve `theme://localhost/<absolute-fs-path>` (each segment percent-encoded).
/// Only paths under the AppData themes dir or the local dev wallpapers dir are allowed.
///
/// This exists because Tauri's `convertFileSrc` percent-encodes the WHOLE path into a
/// single URL segment, which breaks every relative subresource inside a theme
/// (`./img.jpg`, `fetch('./shaders/x.frag')`). Serving with real directory segments
/// lets relative URLs resolve natively.
fn handle_theme_protocol(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let deny = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };

    let decoded = match urlencoding::decode(request.uri().path()) {
        Ok(s) => s.into_owned(),
        Err(_) => return deny(400),
    };
    let fs_path = std::path::PathBuf::from(&decoded);

    // Canonicalize to defeat ../ traversal; 404 if the file doesn't exist.
    let canon = match fs_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return deny(404),
    };

    // Allowlist roots: installed themes + local dev wallpaper source tree.
    let themes_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("themes"))
        .and_then(|d| d.canonicalize().ok());
    let dev_root = std::path::PathBuf::from("/Users/tdaeche/Novaframe-Wallpapers")
        .canonicalize()
        .ok();

    let allowed = [themes_root, dev_root]
        .iter()
        .flatten()
        .any(|root| canon.starts_with(root));
    if !allowed {
        println!("[theme://] DENIED (outside allowed roots): {:?}", canon);
        return deny(403);
    }

    match std::fs::read(&canon) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime_for(&canon))
            // Required: the main window (tauri://localhost origin) fetches manifests
            // cross-origin from theme://localhost.
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => deny(404),
    }
}

fn adjust_window_layouts(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale_factor = monitor.scale_factor();
            let logical_size = monitor.size().to_logical::<f64>(scale_factor);
            let logical_pos = monitor.position().to_logical::<f64>(scale_factor);

            let _ = window.set_size(tauri::Size::Logical(logical_size));
            let _ = window.set_position(tauri::Position::Logical(logical_pos));

            if let Some(settings_window) = app.get_webview_window("settings") {
                let current_width = if let Ok(size) = settings_window.inner_size() {
                    size.to_logical::<f64>(scale_factor).width
                } else {
                    25.0
                };
                let target_width = if current_width > 150.0 { 300.0 } else { 40.0 };
                let logical_width = monitor.size().width as f64 / scale_factor;
                let logical_height = if current_width > 150.0 { 600.0 } else { 40.0 };
                let monitor_h = monitor.size().height as f64 / scale_factor;
                let logical_x =
                    (monitor.position().x as f64 / scale_factor) + logical_width - target_width;
                let logical_y = (monitor.position().y as f64 / scale_factor)
                    + (monitor_h - logical_height) / 2.0;

                let _ = settings_window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    target_width,
                    logical_height,
                )));
                let _ = settings_window.set_position(tauri::Position::Logical(
                    tauri::LogicalPosition::new(logical_x, logical_y),
                ));
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        // Must be the first plugin registered. Without it, clicking a
        // novaframe:// deep link on Windows launches a second full engine
        // instance (two wallpaper windows, doubled CPU, orphan settings
        // panel) instead of delivering the URL to the running one. The
        // "deep-link" feature forwards the URL to on_open_url automatically.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("settings") {
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_desktop_underlay::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .register_uri_scheme_protocol("theme", |ctx, request| {
            handle_theme_protocol(&ctx.app_handle().clone(), &request)
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // On Windows/Linux the novaframe:// scheme lives in the registry /
            // desktop files. The NSIS installer registers it, but re-assert at
            // runtime so portable/dev builds and moved installs still work.
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            {
                if let Err(e) = handle.deep_link().register_all() {
                    println!("[Novaframe] deep-link register_all failed: {}", e);
                }
            }

            // Handle incoming deep links (novaframe://apply?url=...)
            let dl_handle = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    let url_str = url.as_str();
                    println!("Received deep link: {}", url_str);
                    if url_str.starts_with("novaframe://apply") {
                        if let Some(query) = url.query() {
                            // Basic extraction of token= param
                            if let Some(token) = query.split('&').find(|p| p.starts_with("token=")).map(|p| p.trim_start_matches("token=")) {
                                // Send event to JS frontend to handle verification
                                let _ = dl_handle.emit("engine-apply-theme", token);
                            }
                        }
                    }
                }
            });

            adjust_window_layouts(&app.handle().clone());

            // Spawn monitor configuration polling thread
            let handle_clone = handle.clone();
            std::thread::spawn(move || {
                let mut last_monitors_hash = String::new();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if let Ok(monitors) = handle_clone.available_monitors() {
                        let mut hash = String::new();
                        for m in monitors {
                            hash.push_str(&format!("{:?};{:?};{};", m.position(), m.size(), m.scale_factor()));
                        }
                        if hash != last_monitors_hash {
                            last_monitors_hash = hash;
                            adjust_window_layouts(&handle_clone);
                        }
                    }
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                // Underlay first: on Windows this reparents the window into the
                // desktop (WorkerW) layer, which can reset extended window
                // styles — so apply click-through *after* it, and log failures
                // instead of swallowing them (a failed underlay leaves a
                // full-screen window sitting over the desktop eating clicks).
                if let Err(e) = window.set_desktop_underlay(true) {
                    println!("[Novaframe] set_desktop_underlay failed: {}", e);
                }
                if let Err(e) = window.set_ignore_cursor_events(true) {
                    println!("[Novaframe] set_ignore_cursor_events failed: {}", e);
                }

                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }

                #[cfg(target_os = "macos")]
                {
                    let main_window_clone = window.clone();
                    std::thread::spawn(move || {
                        let mut last_visible = true;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            if let Ok(ns_window_ptr) = main_window_clone.ns_window() {
                                if ns_window_ptr.is_null() {
                                    continue;
                                }
                                unsafe {
                                    let ns_window = ns_window_ptr as *mut objc2::runtime::AnyObject;
                                    let state: usize = objc2::msg_send![ns_window, occlusionState];
                                    let is_visible = (state & 2) != 0; // NSWindowOcclusionStateVisible is 1 << 1 (2)
                                    if is_visible != last_visible {
                                        last_visible = is_visible;
                                        let _ = main_window_clone.emit("occlusion-change", is_visible);
                                    }
                                }
                            }
                        }
                    });
                }
            }

            if let Some(settings_window) = app.get_webview_window("settings") {
                #[cfg(target_os = "macos")]
                {
                    let settings_clone = settings_window.clone();
                    // Hover-toggle settings window: poll mouse position against
                    // the window's NSRect every 100ms; when the cursor enters
                    // or leaves, expand (275x600) or collapse (40x600). The
                    // CSS @media queries inside the webview handle the visual
                    // reveal of the panel-handle vs panel-content based on
                    // viewport width.                                                 */
                    std::thread::spawn(move || {
                        let mut was_hovered = false;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(100));

                            if SETTINGS_PANEL_LOCKED.load(Ordering::Relaxed) {
                                if !was_hovered {
                                    was_hovered = true;
                                    expand_settings_panel(settings_clone.clone());
                                }
                                continue;
                            }

                            if let Ok(ns_window_ptr) = settings_clone.ns_window() {
                                if ns_window_ptr.is_null() {
                                    continue;
                                }
                                unsafe {
                                    let ns_window = ns_window_ptr as *mut objc2::runtime::AnyObject;
                                    let ns_event_class = objc2::class!(NSEvent);
                                    let mouse_loc: NSPoint = objc2::msg_send![ns_event_class, mouseLocation];
                                    let frame: NSRect = objc2::msg_send![ns_window, frame];

                                    let is_hovered = mouse_loc.x >= frame.origin.x &&
                                                     mouse_loc.x <= frame.origin.x + frame.size.width &&
                                                     mouse_loc.y >= frame.origin.y &&
                                                     mouse_loc.y <= frame.origin.y + frame.size.height;

                                    if is_hovered != was_hovered {
                                        was_hovered = is_hovered;
                                        if is_hovered {
                                            expand_settings_panel(settings_clone.clone());
                                        } else {
                                            collapse_settings_panel(settings_clone.clone());
                                        }
                                    }
                                }
                            }
                        }
                    });
                }

                // Windows/Linux equivalent of the macOS NSEvent hover loop
                // above — without it the settings cog can never expand on
                // these platforms. Uses Tauri's cross-platform global cursor
                // position against the window's physical outer rect.
                #[cfg(not(target_os = "macos"))]
                {
                    let settings_clone = settings_window.clone();
                    std::thread::spawn(move || {
                        let mut was_hovered = false;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(100));

                            if SETTINGS_PANEL_LOCKED.load(Ordering::Relaxed) {
                                if !was_hovered {
                                    was_hovered = true;
                                    expand_settings_panel(settings_clone.clone());
                                }
                                continue;
                            }

                            let (cursor, pos, size) = match (
                                settings_clone.cursor_position(),
                                settings_clone.outer_position(),
                                settings_clone.outer_size(),
                            ) {
                                (Ok(c), Ok(p), Ok(s)) => (c, p, s),
                                _ => continue,
                            };

                            let is_hovered = cursor.x >= pos.x as f64
                                && cursor.x <= (pos.x + size.width as i32) as f64
                                && cursor.y >= pos.y as f64
                                && cursor.y <= (pos.y + size.height as i32) as f64;

                            if is_hovered != was_hovered {
                                was_hovered = is_hovered;
                                if is_hovered {
                                    expand_settings_panel(settings_clone.clone());
                                } else {
                                    collapse_settings_panel(settings_clone.clone());
                                }
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![expand_settings_panel, collapse_settings_panel, set_settings_panel_locked, log_from_js, open_storefront_window, download_and_install_theme, get_themes_dir, get_hardware_id])
        .run(tauri::generate_context!())
        .expect("error while running Novaframe desktop runtime application");
}
