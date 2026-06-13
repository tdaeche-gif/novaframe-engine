use tauri::Manager;
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_desktop_underlay::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let main_window = app.get_webview_window("main").unwrap();
            let _ = main_window.set_desktop_underlay(true);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
