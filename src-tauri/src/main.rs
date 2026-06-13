// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;

#[tauri::command]
fn expand_settings_panel(window: tauri::Window) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor) + (monitor.size().width as f64 / scale_factor) - 300.0;
        let logical_y = monitor.position().y as f64 / scale_factor;
        
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(300.0, logical_height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
    }
}

#[tauri::command]
fn collapse_settings_panel(window: tauri::Window) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor) + (monitor.size().width as f64 / scale_factor) - 30.0;
        let logical_y = monitor.position().y as f64 / scale_factor;
        
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(30.0, logical_height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
    }
}

#[tauri::command]
fn log_from_js(message: String) {
    println!("[JS Log] {}", message);
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
                    30.0
                };
                let target_width = if current_width > 150.0 { 300.0 } else { 30.0 };
                let logical_width = monitor.size().width as f64 / scale_factor;
                let logical_height = monitor.size().height as f64 / scale_factor;
                let logical_x = (monitor.position().x as f64 / scale_factor) + logical_width - target_width;
                let logical_y = monitor.position().y as f64 / scale_factor;
                
                let _ = settings_window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(target_width, logical_height)));
                let _ = settings_window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
            }
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_desktop_underlay::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            adjust_window_layouts(&handle);

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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![expand_settings_panel, collapse_settings_panel, log_from_js])
        .run(tauri::generate_context!())
        .expect("error while running Geochron desktop runtime application");
}