// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, Emitter};
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect};

#[tauri::command]
fn expand_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = 600.0;
        let monitor_h = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor) + (monitor.size().width as f64 / scale_factor) - 300.0;
        let logical_y = (monitor.position().y as f64 / scale_factor) + (monitor_h - logical_height) / 2.0;
        
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(300.0, logical_height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
    }
}

#[tauri::command]
fn collapse_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        let scale_factor = monitor.scale_factor();
        let logical_height = 40.0;
        let logical_width = 40.0;
        let monitor_h = monitor.size().height as f64 / scale_factor;
        let logical_x = (monitor.position().x as f64 / scale_factor) + (monitor.size().width as f64 / scale_factor) - logical_width;
        let logical_y = (monitor.position().y as f64 / scale_factor) + (monitor_h - logical_height) / 2.0;
        
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(logical_width, logical_height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
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
                let logical_x = (monitor.position().x as f64 / scale_factor) + logical_width - target_width;
                let logical_y = (monitor.position().y as f64 / scale_factor) + (monitor_h - logical_height) / 2.0;
                
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
        .invoke_handler(tauri::generate_handler![expand_settings_panel, collapse_settings_panel, log_from_js, open_storefront_window])
        .run(tauri::generate_context!())
        .expect("error while running Novaframe desktop runtime application");
}