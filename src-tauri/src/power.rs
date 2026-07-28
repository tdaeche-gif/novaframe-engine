use std::sync::atomic::Ordering;
use crate::dlog;
use crate::state::{
    BATTERY_SAVER_ENABLED, FULLSCREEN_ACTIVE, MANUAL_PAUSE, ON_BATTERY, WINDOW_OCCLUDED,
    recompute_wallpaper_visibility,
};

/// True when the machine is running on battery rather than mains power.
///
/// macOS: `pmset -g batt` prints "Now drawing from 'AC Power'" or "'Battery
/// Power'". Shelling out once a minute is cheaper in both code and binary size
/// than binding IOKit's power-source APIs for one boolean.
#[cfg(target_os = "macos")]
pub fn running_on_battery() -> bool {
    std::process::Command::new("/usr/bin/pmset")
        .args(["-g", "batt"])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).contains("Battery Power"))
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
pub fn running_on_battery() -> bool {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    unsafe {
        let mut status = SYSTEM_POWER_STATUS::default();
        if GetSystemPowerStatus(&mut status).is_ok() {
            // ACLineStatus: 0 = offline (battery), 1 = online, 255 = unknown.
            status.ACLineStatus == 0
        } else {
            false
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn running_on_battery() -> bool {
    false
}

/// Turn "pause on battery" on or off from the settings panel. Recomputes
/// immediately so switching it on while already unplugged pauses now, rather
/// than at the next poll.
#[tauri::command]
pub fn set_battery_saver(app: tauri::AppHandle, enabled: bool) {
    BATTERY_SAVER_ENABLED.store(enabled, Ordering::Relaxed);
    recompute_wallpaper_visibility(&app);
    dlog(&app, &format!("[pause] battery saver enabled={}", enabled));
}

/// Current pause state, for the frontend to QUERY rather than wait to be told.
#[tauri::command]
pub fn get_wallpaper_paused() -> bool {
    MANUAL_PAUSE.load(Ordering::Relaxed)
        || FULLSCREEN_ACTIVE.load(Ordering::Relaxed)
        || WINDOW_OCCLUDED.load(Ordering::Relaxed)
        || (BATTERY_SAVER_ENABLED.load(Ordering::Relaxed) && ON_BATTERY.load(Ordering::Relaxed))
}

/// Spawn the background battery source polling thread (polls every 60 seconds).
pub fn spawn_battery_monitor(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = running_on_battery();
        ON_BATTERY.store(last, Ordering::Relaxed);
        dlog(&app, &format!("[pause] power source at startup: on battery={}", last));
        loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let on_battery = running_on_battery();
            if on_battery != last {
                last = on_battery;
                ON_BATTERY.store(on_battery, Ordering::Relaxed);
                recompute_wallpaper_visibility(&app);
                dlog(&app, &format!("[pause] on battery={}", on_battery));
            }
        }
    });
}
