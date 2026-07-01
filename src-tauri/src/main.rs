// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;

#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect};

#[tauri::command]
fn expand_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = 600.0;
        let monitor_h = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor)
            + (monitor.size().width as f64 / scale_factor)
            - 300.0;
        let logical_y =
            (monitor.position().y as f64 / scale_factor) + (monitor_h - logical_height) / 2.0;

        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
            300.0,
            logical_height,
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
        let logical_height = 40.0;
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
    println!("[JS Log] {}", message);
}

#[tauri::command]
fn open_storefront_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("storefront") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
async fn download_and_install_theme(
    app: tauri::AppHandle,
    url: String,
    theme_id: String,
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

    // We expect the zip to extract directly into themes_dir/theme_id,
    // or if the zip already contains a root folder, we might need to handle it.
    // For safety, we will extract to target_theme_dir and strip any top-level folder if it exists.

    if !target_theme_dir.exists() {
        fs::create_dir_all(&target_theme_dir)
            .map_err(|e| format!("Failed to create target theme dir: {}", e))?;
    }

    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to access zip file: {}", e))?;
        let outpath = match file.enclosed_name() {
            Some(path) => {
                // Determine if we need to strip a top-level directory
                // Wait, to keep it simple, just extract it as is into target_theme_dir
                target_theme_dir.join(path)
            }
            None => continue,
        };

        if file.name().ends_with('/') {
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

    println!("[Novaframe] Theme installed successfully.");
    Ok(theme_id)
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_desktop_underlay::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            
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
                let _ = window.set_ignore_cursor_events(true);
                let _ = window.set_desktop_underlay(true);

                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_background_color(Some(tauri::Color(0, 0, 0, 0)));
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
                    std::thread::spawn(move || {
                        let mut was_hovered = false;
                        loop {
                            std::thread::sleep(std::time::Duration::from_millis(100));
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
                                            let window_for_closure = settings_clone.clone();
                                            let _ = settings_clone.run_on_main_thread(move || {
                                                if let Ok(ns_window_ptr) = window_for_closure.ns_window() {
                                                    let ns_window = ns_window_ptr as *mut objc2::runtime::AnyObject;
                                                    let _: () = objc2::msg_send![ns_window, setLevel: 3isize];
                                                }
                                            });
                                        } else {
                                            collapse_settings_panel(settings_clone.clone());
                                            let window_for_closure = settings_clone.clone();
                                            let _ = settings_clone.run_on_main_thread(move || {
                                                if let Ok(ns_window_ptr) = window_for_closure.ns_window() {
                                                    let ns_window = ns_window_ptr as *mut objc2::runtime::AnyObject;
                                                    let _: () = objc2::msg_send![ns_window, setLevel: 3isize];
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                        }
                    });
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![expand_settings_panel, collapse_settings_panel, log_from_js, open_storefront_window, download_and_install_theme])
        .run(tauri::generate_context!())
        .expect("error while running Novaframe desktop runtime application");
}
