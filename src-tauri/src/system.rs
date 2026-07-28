#[tauri::command]
pub fn get_hardware_id() -> Result<String, String> {
    machine_uid::get().map_err(|e| e.to_string())
}
