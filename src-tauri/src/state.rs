use tauri::Emitter;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

pub static LAST_DEEPLINK_SEEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);
pub static PENDING_DEEPLINK_TOKEN: Mutex<Option<String>> = Mutex::new(None);

pub static SETTINGS_PANEL_LOCKED: AtomicBool = AtomicBool::new(false);

pub const COLLAPSED_WIDTH: f64 = 30.0;
pub const COLLAPSED_HEIGHT: f64 = 30.0;

pub static MANUAL_PAUSE: AtomicBool = AtomicBool::new(false);
pub static FULLSCREEN_ACTIVE: AtomicBool = AtomicBool::new(false);
pub static WINDOW_OCCLUDED: AtomicBool = AtomicBool::new(false);
pub static ON_BATTERY: AtomicBool = AtomicBool::new(false);
pub static BATTERY_SAVER_ENABLED: AtomicBool = AtomicBool::new(false);

pub fn recompute_wallpaper_visibility(app: &tauri::AppHandle) {
    let paused = MANUAL_PAUSE.load(Ordering::Relaxed)
        || FULLSCREEN_ACTIVE.load(Ordering::Relaxed)
        || WINDOW_OCCLUDED.load(Ordering::Relaxed)
        || (BATTERY_SAVER_ENABLED.load(Ordering::Relaxed) && ON_BATTERY.load(Ordering::Relaxed));
    let _ = app.emit("occlusion-change", !paused);
}
