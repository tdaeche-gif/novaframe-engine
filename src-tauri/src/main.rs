// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod state;
mod system;
mod theme_protocol;
mod power;
mod installer;
mod deeplink;

use state::*;
use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_desktop_underlay::DesktopUnderlayExt;

#[cfg(target_os = "macos")]
use objc2_foundation::{NSPoint, NSRect};

use std::sync::atomic::{AtomicBool, Ordering};

// ── Autostart (launch on login) ─────────────────────────────────────────────
#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled {
        mgr.enable().map_err(|e| e.to_string())
    } else {
        mgr.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_settings_panel_locked(locked: bool) {
    SETTINGS_PANEL_LOCKED.store(locked, Ordering::Relaxed);
}

/// Anchor the settings window flush to the monitor's right edge, vertically
/// centered, at the given LOGICAL size. Does all math in PHYSICAL pixels
/// (monitor.position()/size() are already physical) and only converts to
/// logical at the point Tauri requires it, rounding to the nearest physical
/// pixel throughout.
///
/// Why: the previous version divided monitor position/size by scale_factor
/// into logical f64s, added/subtracted logical widths, and handed the result
/// to set_position(Logical). Every one of those divisions can produce a
/// fractional logical value (e.g. a secondary monitor whose physical origin
/// isn't a clean multiple of scale_factor); Tauri then multiplies back by
/// scale_factor to get physical pixels, and the rounding at THAT point can
/// land the window's right edge a pixel or two short of the true screen edge
/// — reported as the cog "floating" a few px off the right side on macOS
/// Retina displays. Computing entirely in physical pixels and rounding once,
/// right before the set_size/set_position calls, removes that drift.
fn place_settings_window(
    window: &tauri::WebviewWindow,
    monitor: &tauri::window::Monitor,
    logical_width: f64,
    logical_height: f64,
) {
    let scale_factor = monitor.scale_factor();
    let target_w = (logical_width * scale_factor).round() as u32;
    let target_h = (logical_height * scale_factor).round() as u32;

    let mon_pos = monitor.position();
    let mon_size = monitor.size();

    let x = mon_pos.x + mon_size.width as i32 - target_w as i32;
    let y = mon_pos.y + (mon_size.height as i32 - target_h as i32) / 2;

    // Idempotence: skip when the CLIENT (webview) area is already exactly at
    // the target rect. Poll threads (monitor poll, hover poll) route through
    // here; redundant set_size/set_position calls trigger repaints on Windows
    // that show as a periodic flicker.
    if let (Ok(ip), Ok(is)) = (window.inner_position(), window.inner_size()) {
        if ip.x == x && ip.y == y && is.width == target_w && is.height == target_h {
            return;
        }
    }

    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
        target_w, target_h,
    )));
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x, y,
    )));

    // Windows: borderless windows still carry an invisible DWM resize frame,
    // so the client (webview) area sits a few px INSIDE the outer rect we just
    // set — the cog rendered clipped off the screen's right edge with dead
    // transparent space above/below it. Same correction the main window does
    // in adjust_window_layouts: measure the frame insets, grow the outer rect
    // by the frame and shift it so the CLIENT lands exactly on the target.
    #[cfg(target_os = "windows")]
    if let (Ok(inner), Ok(outer_pos), Ok(outer_size), Ok(inner_size)) = (
        window.inner_position(),
        window.outer_position(),
        window.outer_size(),
        window.inner_size(),
    ) {
        let dx = inner.x - outer_pos.x;
        let dy = inner.y - outer_pos.y;
        let frame_w = outer_size.width.saturating_sub(inner_size.width);
        let frame_h = outer_size.height.saturating_sub(inner_size.height);
        if dx != 0 || dy != 0 || frame_w != 0 || frame_h != 0 {
            let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                target_w + frame_w,
                target_h + frame_h,
            )));
            let _ = window.set_position(tauri::Position::Physical(
                tauri::PhysicalPosition::new(x - dx, y - dy),
            ));
        }
    }
}

#[tauri::command]
fn expand_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        place_settings_window(&window, &monitor, 360.0, 650.0); // 320 panel + 40 cog tab
    }
    let _ = window.set_focus();
}

#[tauri::command]
fn collapse_settings_panel(window: tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = window.current_monitor() {
        // Collapsed window is sized to just the cog on every platform so the
        // hover-to-expand target is ONLY the visible settings icon — not the
        // full-height column above/below it. (Windows also needs this so the
        // WebView2/DWM layered-window outline can't draw a faint 600px-tall
        // border down the right edge.) The cog is vertically centered in both
        // the collapsed and expanded windows, so it stays at the same screen Y
        // across the transition.
        place_settings_window(&window, &monitor, COLLAPSED_WIDTH, COLLAPSED_HEIGHT);
    }
}

#[tauri::command]
fn log_from_js(app: tauri::AppHandle, message: String) {
    // Route JS console into the on-disk log too — the webview console is just as
    // invisible as stdout on a release (GUI-subsystem) Windows build.
    dlog(&app, &format!("[JS] {}", message));
}

/// Fully quit the engine (all windows + the wallpaper underlay process) from the
/// settings-panel exit button, so users don't have to kill it via Task Manager.
#[tauri::command]
fn quit_engine(app: tauri::AppHandle) {
    println!("[Novaframe] quit_engine invoked — exiting.");
    // Failsafe: if exit handling wedges (e.g. a WebView2 teardown hang on
    // Windows), hard-kill the process after 2s so the user never needs
    // Task Manager to get rid of the engine.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(0);
    });
    app.exit(0);
}

// Async on purpose: a SYNC command runs on the main thread, and on Windows
// building a webview window from the main thread inside a command DEADLOCKS
// (WebviewWindowBuilder::build blocks on an event the blocked main loop can
// never process). Symptom: storefront opens as a frozen white window and the
// whole app hangs — settings dead, quit dead, Task Manager required. Async
// commands run off the main loop and Tauri dispatches the actual window
// creation to the main thread itself, which is also why this stays correct
// on macOS.
#[tauri::command]
async fn open_storefront_window(app: tauri::AppHandle) -> Result<(), String> {
    // Already open (or a previous session left it around): just focus it.
    if let Some(window) = app.get_webview_window("storefront") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Lazily create the storefront. It used to be declared in tauri.conf.json,
    // so Tauri built its WebView2 at startup and the hidden marketplace page ran
    // continuously in the background (~20% CPU on Windows). Now it only exists
    // while the user has the store open; closing it (decorated window → X)
    // destroys the webview and frees the cost. Reopening rebuilds it.
    let url = tauri::WebviewUrl::External(
        "https://www.novaframe.co.uk/explore?source=engine"
            .parse()
            .map_err(|_| "invalid storefront url".to_string())?,
    );
    let app_handle = app.clone();
    tauri::WebviewWindowBuilder::new(&app, "storefront", url)
        .title("Novaframe Marketplace")
        .inner_size(1280.0, 800.0)
        .resizable(true)
        .decorations(true)
        .on_navigation(move |nav_url| {
            let s = nav_url.as_str();
            if s.starts_with("novaframe://") {
                deeplink::process_deeplink_url(&app_handle, s);
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
/// The theme every fresh install starts with.

/// The theme every fresh install starts with.
///
/// Without this, a new user installs the engine and gets nothing — the desktop
/// looks exactly as it did, and they have to buy something before they can see
/// what they bought the engine for. Shipping one theme in the bundle turns the
/// download into a working live wallpaper on first launch.
///
/// Provisioned once, guarded by a marker file (same pattern as the autostart
/// default): a user who deletes this theme must not have it reappear on every
/// restart. `sync_shared_runtime` runs before this in setup(), so the shared
/// `../three.min.js` the theme loads is already in place one level up.
const DEFAULT_THEME_DIR: &str = "breathing-gradient";
const DEFAULT_THEME_FILES: [&str; 3] = ["index.html", "manifest.json", "novaframe-wallpaper.js"];

fn provision_default_theme(app: &tauri::AppHandle) {
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(e) => {
            dlog(app, &format!("[default-theme] no app_data_dir: {}", e));
            return;
        }
    };

    let marker = app_data.join(".default_theme_provisioned");
    if marker.exists() {
        return;
    }

    let dest_dir = app_data.join("themes").join(DEFAULT_THEME_DIR);
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        dlog(app, &format!("[default-theme] create dir failed: {}", e));
        return;
    }

    for name in DEFAULT_THEME_FILES {
        let src = match app.path().resolve(
            &format!("resources/default-theme/{}", name),
            tauri::path::BaseDirectory::Resource,
        ) {
            Ok(p) => p,
            Err(e) => {
                dlog(app, &format!("[default-theme] resolve {} failed: {}", name, e));
                return;
            }
        };
        if let Err(e) = std::fs::copy(&src, dest_dir.join(name)) {
            dlog(app, &format!("[default-theme] copy {} failed: {}", name, e));
            return;
        }
    }

    // Only marked once every file landed, so a partial copy is retried next
    // launch rather than leaving a broken theme the user can select.
    let _ = std::fs::write(&marker, b"1");
    dlog(app, &format!("[default-theme] provisioned {:?}", dest_dir));
}

/// Append a line to AppData/engine-debug.log. Release builds run as a Windows
/// GUI-subsystem app with NO console, so println! is invisible in the field —
/// this file is the only way to see what actually happened on a user's machine.
/// Best-effort: never panics, silently no-ops if the path is unavailable.
pub(crate) fn dlog(app: &tauri::AppHandle, msg: &str) {
    use std::io::Write;
    println!("{}", msg);
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("engine-debug.log"))
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{}] {}", ts, msg);
        }
    }
}

fn adjust_window_layouts(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale_factor = monitor.scale_factor();

            dlog(app, &format!(
                "[layout] monitor name={:?} phys_size={:?} phys_pos={:?} scale={}",
                monitor.name(), monitor.size(), monitor.position(), scale_factor
            ));

            // Windows: pass the monitor's raw physical bounds straight through.
            // Converting to logical and back introduces sub-pixel rounding that
            // leaves a ~1px gap on the screen edge (desktop shows through). macOS
            // (retina) sizes correctly via logical coords, so keep that path.
            #[cfg(target_os = "windows")]
            {
                let mon_size = *monitor.size();
                let mon_pos = *monitor.position();

                // Borderless Windows windows still carry an invisible DWM resize
                // frame, so the client (webview) area sits ~8px INSIDE the outer
                // rect. Measure the current frame insets (they're constant across
                // resizes) and compute the ONE outer rect whose CLIENT covers the
                // monitor exactly. Previously this set the raw monitor rect first
                // and then re-set the corrected rect — a visible double-resize —
                // and the monitor-poll safety net re-ran it every pass with no
                // "already correct" check, producing a flicker every few seconds.
                let (dx, dy, frame_w, frame_h) = match (
                    window.inner_position(),
                    window.outer_position(),
                    window.outer_size(),
                    window.inner_size(),
                ) {
                    (Ok(inner), Ok(outer_pos), Ok(outer_size), Ok(inner_size)) => (
                        inner.x - outer_pos.x,
                        inner.y - outer_pos.y,
                        outer_size.width.saturating_sub(inner_size.width),
                        outer_size.height.saturating_sub(inner_size.height),
                    ),
                    _ => (0, 0, 0, 0),
                };
                let want_w = mon_size.width + frame_w;
                let want_h = mon_size.height + frame_h;
                let want_x = mon_pos.x - dx;
                let want_y = mon_pos.y - dy;

                let already_placed = match (window.outer_position(), window.outer_size()) {
                    (Ok(p), Ok(s)) => {
                        p.x == want_x && p.y == want_y && s.width == want_w && s.height == want_h
                    }
                    _ => false,
                };
                if !already_placed {
                    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize::new(
                        want_w, want_h,
                    )));
                    let _ = window.set_position(tauri::Position::Physical(
                        tauri::PhysicalPosition::new(want_x, want_y),
                    ));
                    dlog(app, &format!(
                        "[layout] frame inset dx={} dy={} frame_w={} frame_h={} -> client aligned to monitor origin",
                        dx, dy, frame_w, frame_h
                    ));
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                let logical_size = monitor.size().to_logical::<f64>(scale_factor);
                let logical_pos = monitor.position().to_logical::<f64>(scale_factor);
                let _ = window.set_size(tauri::Size::Logical(logical_size));
                let _ = window.set_position(tauri::Position::Logical(logical_pos));
            }

            dlog(app, &format!(
                "[layout] main AFTER set: outer_pos={:?} outer_size={:?} inner_pos={:?} inner_size={:?}",
                window.outer_position(), window.outer_size(), window.inner_position(), window.inner_size()
            ));

            if let Some(settings_window) = app.get_webview_window("settings") {
                let current_width = if let Ok(size) = settings_window.inner_size() {
                    size.to_logical::<f64>(scale_factor).width
                } else {
                    25.0
                };
                // Mirror expand_settings_panel / collapse_settings_panel exactly
                // (same helper, same physical-pixel math — see
                // place_settings_window for why logical math was dropped).
                let expanded = current_width > 150.0;
                let target_width = if expanded { 360.0 } else { COLLAPSED_WIDTH };
                let target_height = if expanded { 650.0 } else { COLLAPSED_HEIGHT };
                place_settings_window(&settings_window, &monitor, target_width, target_height);
            }
        }
    }
}

/// Build the system-tray icon + menu (Show Settings / Pause / Quit). Best-effort:
/// logs and returns on failure rather than aborting startup.
fn build_tray(app: &tauri::AppHandle) {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::TrayIconBuilder;

    let show = match MenuItem::with_id(app, "tray_show", "Show Settings", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return dlog(app, &format!("[tray] item build failed: {}", e)),
    };
    let pause = match MenuItem::with_id(app, "tray_pause", "Pause Wallpaper", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return dlog(app, &format!("[tray] item build failed: {}", e)),
    };
    let quit = match MenuItem::with_id(app, "tray_quit", "Quit Novaframe", true, None::<&str>) {
        Ok(i) => i,
        Err(e) => return dlog(app, &format!("[tray] item build failed: {}", e)),
    };
    let sep = match PredefinedMenuItem::separator(app) {
        Ok(s) => s,
        Err(e) => return dlog(app, &format!("[tray] separator build failed: {}", e)),
    };
    let menu = match Menu::with_items(app, &[&show, &pause, &sep, &quit]) {
        Ok(m) => m,
        Err(e) => return dlog(app, &format!("[tray] menu build failed: {}", e)),
    };

    // Kept so the menu event handler can flip the label between Pause/Resume.
    let pause_item = pause.clone();

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("Novaframe Engine")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "tray_show" => {
                if let Some(w) = app.get_webview_window("settings") {
                    let _ = w.set_focus();
                    expand_settings_panel(w);
                }
            }
            "tray_pause" => {
                let paused = !MANUAL_PAUSE.load(Ordering::Relaxed);
                MANUAL_PAUSE.store(paused, Ordering::Relaxed);
                recompute_wallpaper_visibility(app);
                let _ = pause_item.set_text(if paused {
                    "Resume Wallpaper"
                } else {
                    "Pause Wallpaper"
                });
            }
            "tray_quit" => quit_engine(app.clone()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }

    if let Err(e) = builder.build(app) {
        dlog(app, &format!("[tray] build failed: {}", e));
    }
}

/// True when macOS considers the wallpaper window hidden behind other windows.
///
/// NOTE: For a window at `kCGDesktopWindowLevel - 1` (the desktop underlay
/// level used by tauri-plugin-desktop-underlay), the WindowServer does NOT
/// compute a meaningful occlusion state. `occlusionState` always reports
/// `Visible` regardless of what covers the screen. The comment that used to
/// live here — "a maximized or full-screen app clears the visible bit for us"
/// — described behaviour that does NOT happen for this window class and is
/// therefore always false in practice. The function is kept because it costs
/// nothing and becomes meaningful if Apple ever extends occlusion tracking
/// to desktop-level windows. Fullscreen-app pausing is handled separately
/// by `is_fullscreen_app_active()` (macOS arm).
#[cfg(target_os = "macos")]
fn macos_window_occluded(window: &tauri::WebviewWindow) -> bool {
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSWindow, NSWindowOcclusionState};

    let ptr = match window.ns_window() {
        Ok(p) => p as *mut AnyObject,
        Err(_) => return false,
    };
    if ptr.is_null() {
        return false;
    }

    // Safe as long as the window is alive, which it is: we hold a WebviewWindow
    // for the whole poll and Tauri owns the NSWindow behind it.
    let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let state = ns_window.occlusionState();
    !state.contains(NSWindowOcclusionState::Visible)
}

/// True when the user permanently hides both the Dock and the menu bar, which
/// makes the `visibleFrame == frame` fullscreen test useless for them.
///
/// Read once at startup and cached: these are user preferences, not ephemeral
/// state, and shelling out on every poll would be its own battery drain.
/// The pattern matches `running_on_battery()`, which shells out to `/usr/bin/pmset`
/// for the same reason.
///
/// Note `&&` (not `||`): hiding only the Dock still leaves the menu-bar inset,
/// so the test remains valid; only hiding *both* defeats it.
#[cfg(target_os = "macos")]
fn chrome_always_hidden() -> bool {
    static CACHED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *CACHED.get_or_init(|| {
        let read_bool = |domain: &str, key: &str| -> bool {
            std::process::Command::new("/usr/bin/defaults")
                .args(["read", domain, key])
                .output()
                .ok()
                .map(|out| String::from_utf8_lossy(&out.stdout).trim() == "1")
                .unwrap_or(false)
        };
        let dock_hidden = read_bool("com.apple.dock", "autohide");
        let menu_hidden = read_bool("NSGlobalDomain", "_HIHideMenuBar");
        dock_hidden && menu_hidden
    })
}

/// True when a fullscreen app (video, game, presentation) owns the screen, so
/// the wallpaper render can be paused to free the GPU.
///
/// macOS gives us no usable direct signal here. `NSWindow.occlusionState` is
/// not tracked for a window at desktop level (see `macos_window_occluded` doc),
/// and `isOnActiveSpace` is always true because the underlay plugin sets
/// `canJoinAllSpaces`. What a fullscreen space *does* change is the menu bar
/// and Dock: both hide, so `NSScreen.visibleFrame` grows to meet `frame`.
///
/// Deliberately misses merely *maximized* windows that don't enter a fullscreen
/// space. The full fix is a CGWindowList coverage check mirroring the Windows
/// `desktop_is_covered()`; that needs a new dependency and is deferred.
///
/// Guard: a user who permanently auto-hides *both* the Dock and the menu bar
/// satisfies `visibleFrame == frame` at all times, so `chrome_always_hidden()`
/// is checked first and returns false for them to avoid pausing forever.
#[cfg(target_os = "macos")]
fn is_fullscreen_app_active() -> bool {
    // Guard: if the user permanently hides both chrome elements, visibleFrame
    // always equals frame and the test below is a false positive forever.
    if chrome_always_hidden() {
        return false;
    }

    // Use raw msg_send! to avoid requiring the NSScreen typed-wrapper feature
    // in Cargo.toml — this matches the pattern used elsewhere in this file.
    unsafe {
        let ns_screen_class = objc2::class!(NSScreen);
        // +mainScreen can return nil if there is no screen (rare: headless CI).
        let main_screen: *mut objc2::runtime::AnyObject =
            objc2::msg_send![ns_screen_class, mainScreen];
        if main_screen.is_null() {
            return false;
        }

        let frame: objc2_foundation::NSRect = objc2::msg_send![main_screen, frame];
        let visible: objc2_foundation::NSRect = objc2::msg_send![main_screen, visibleFrame];

        // Tolerance, not equality: visibleFrame can differ by a fraction of a
        // point due to rounding on scaled (Retina) displays.
        (frame.size.height - visible.size.height).abs() < 1.0
            && (frame.size.width - visible.size.width).abs() < 1.0
    }
}

#[cfg(target_os = "windows")]
fn is_fullscreen_app_active() -> bool {
    use windows::Win32::UI::Shell::{
        SHQueryUserNotificationState, QUNS_BUSY, QUNS_PRESENTATION_MODE,
        QUNS_RUNNING_D3D_FULL_SCREEN,
    };
    unsafe {
        match SHQueryUserNotificationState() {
            Ok(state) => {
                state == QUNS_BUSY
                    || state == QUNS_RUNNING_D3D_FULL_SCREEN
                    || state == QUNS_PRESENTATION_MODE
            }
            Err(_) => false,
        }
    }
}

/// True when every monitor's work area is fully covered by some other app's
/// window — i.e. the desktop wallpaper is invisible and rendering it is pure
/// waste.
///
/// This is the Windows counterpart to the macOS `NSWindow.occlusionState` poll.
/// Windows has no equivalent API for a desktop-underlay window: our wallpaper
/// window lives under WorkerW and is `alwaysOnBottom`, so Chromium always
/// considers it visible and never throttles it on its own. Without this check
/// the only thing that ever paused the render on Windows was
/// `is_fullscreen_app_active()`, which does NOT fire for a merely *maximized*
/// window — so a maximized browser meant a full-screen shader running at 30fps
/// into pixels nobody could see.
///
/// Coverage is tested against each monitor's WORK AREA (`rcWork`), not its full
/// bounds: a maximized window stops at the taskbar, and the wallpaper strip
/// behind an opaque taskbar isn't visible either.
///
/// Known limit: this only detects a SINGLE window covering a monitor. Two
/// half-screen windows tiled side by side also hide the desktop but are not
/// caught here — that needs real region subtraction. The common case (one
/// maximized window) is what matters and this catches it.
#[cfg(target_os = "windows")]
fn desktop_is_covered() -> bool {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, TRUE};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
    };
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetClassNameW, GetWindowRect, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible,
    };

    // Shell windows that are always full-screen but are not "covering" anything:
    // Progman/WorkerW ARE the desktop, and the tray is the taskbar itself.
    const SHELL_CLASSES: [&str; 5] = [
        "Progman",
        "WorkerW",
        "Shell_TrayWnd",
        "SHELLDLL_DefView",
        "Windows.UI.Core.CoreWindow",
    ];

    unsafe extern "system" fn monitor_proc(
        _mon: HMONITOR,
        _hdc: HDC,
        _rc: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        let out = unsafe { &mut *(data.0 as *mut Vec<RECT>) };
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if unsafe { GetMonitorInfoW(_mon, &mut info) }.as_bool() {
            out.push(info.rcWork); // work area, not rcMonitor — see doc comment
        }
        TRUE
    }

    unsafe extern "system" fn window_proc(hwnd: HWND, data: LPARAM) -> BOOL {
        let out = unsafe { &mut *(data.0 as *mut Vec<RECT>) };
        unsafe {
            if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                return TRUE;
            }
            // Skip our own windows — the wallpaper window is itself full-screen
            // and would otherwise "cover" every monitor and pause forever.
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == GetCurrentProcessId() {
                return TRUE;
            }
            // Cloaked windows are visible-but-not-rendered (suspended UWP apps,
            // windows on another virtual desktop). They hide nothing.
            let mut cloaked = 0u32;
            if DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            )
            .is_ok()
                && cloaked != 0
            {
                return TRUE;
            }
            let mut buf = [0u16; 64];
            let n = GetClassNameW(hwnd, &mut buf) as usize;
            let class = String::from_utf16_lossy(&buf[..n]);
            if SHELL_CLASSES.iter().any(|c| *c == class) {
                return TRUE;
            }
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_ok() && r.right > r.left && r.bottom > r.top {
                out.push(r);
            }
        }
        TRUE
    }

    let mut monitors: Vec<RECT> = Vec::new();
    unsafe {
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_proc),
            LPARAM(&mut monitors as *mut _ as isize),
        );
    }
    if monitors.is_empty() {
        return false; // no info = assume visible, never pause on a guess
    }

    let mut windows: Vec<RECT> = Vec::new();
    unsafe {
        if EnumWindows(Some(window_proc), LPARAM(&mut windows as *mut _ as isize)).is_err() {
            return false;
        }
    }

    // A few px of slack: maximized windows sit a hair inside/outside the work
    // area depending on DPI and invisible resize borders.
    const SLACK: i32 = 4;
    monitors.iter().all(|m| {
        windows.iter().any(|w| {
            w.left <= m.left + SLACK
                && w.top <= m.top + SLACK
                && w.right >= m.right - SLACK
                && w.bottom >= m.bottom - SLACK
        })
    })
}



fn main() {
    tauri::Builder::default()
        // Must be the first plugin registered. Without it, clicking a
        // novaframe:// deep link on Windows launches a second full engine
        // instance (two wallpaper windows, doubled CPU, orphan settings
        // panel) instead of delivering the URL to the running one. The
        // "deep-link" feature forwards the URL to on_open_url automatically.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(w) = app.get_webview_window("settings") {
                let _ = w.set_focus();
            }
            for arg in args {
                if arg.starts_with("novaframe://apply") {
                    deeplink::process_deeplink_url(app, &arg);
                }
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Launch on login. Args "--minimized" lets us tell an autostarted launch
        // apart from a manual one if we ever want to skip showing the panel.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_desktop_underlay::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .register_uri_scheme_protocol("theme", |ctx, request| {
            theme_protocol::handle_theme_protocol(&ctx.app_handle().clone(), &request)
        })
        .setup(|app| {
            let handle = app.handle().clone();

            dlog(&handle, &format!("==== engine start v{} os={} ====",
                env!("CARGO_PKG_VERSION"), std::env::consts::OS));

            // Ensure the shared three.js runtime is present before any theme loads.
            installer::sync_shared_runtime(&handle);

            // First run only: put one theme on the desktop so the engine does
            // something the moment it opens. scanThemes() auto-selects the
            // first available theme when none is active, so this needs no
            // frontend change — it just has to exist before the scan.
            provision_default_theme(&handle);

            // Register deep link scheme across all desktop OS targets so dev/debug and moved
            // installs re-bind LaunchServices / OS scheme registry on launch.
            if let Err(e) = handle.deep_link().register_all() {
                dlog(&handle, &format!("[Novaframe] deep-link register_all failed: {}", e));
            }

            // Handle incoming deep links (novaframe://apply?url=...)
            let dl_handle = handle.clone();
            handle.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    deeplink::process_deeplink_url(&dl_handle, url.as_str());
                }
            });

            // Cold-start deep link processing (catch URL if app opened via deep link)
            if let Ok(Some(urls)) = handle.deep_link().get_current() {
                for url in urls {
                    deeplink::process_deeplink_url(&handle, url.as_str());
                }
            }

            adjust_window_layouts(&app.handle().clone());

            // ── First-run: enable autostart once ────────────────────────────
            // A wallpaper should persist across reboots, so default it ON — but
            // only the first time, so a user who later turns it off stays off.
            // A marker file in app_data records that we've done the default.
            {
                use tauri_plugin_autostart::ManagerExt;
                if let Ok(dir) = handle.path().app_data_dir() {
                    let marker = dir.join(".autostart_initialized");
                    if !marker.exists() {
                        let _ = std::fs::create_dir_all(&dir);
                        match handle.autolaunch().enable() {
                            Ok(_) => dlog(&handle, "[autostart] enabled by default (first run)"),
                            Err(e) => dlog(&handle, &format!("[autostart] default enable failed: {}", e)),
                        }
                        let _ = std::fs::write(&marker, b"1");
                    }
                }
            }

            // ── System tray ─────────────────────────────────────────────────
            build_tray(&handle);

            // ── Pause-on-hidden (Windows) ───────────────────────────────────
            // macOS pauses via the NSWindow occlusion loop further down. Windows
            // has no such signal for a desktop-underlay window, so poll two
            // things here:
            //   1. SHQueryUserNotificationState — a fullscreen game/presentation.
            //   2. desktop_is_covered() — every monitor's work area covered by
            //      some other app's window (the ordinary "maximized browser"
            //      case, which (1) does NOT report).
            // Without (2) the wallpaper shader ran at full rate behind every
            // maximized window — the single biggest source of idle GPU load on
            // Windows.
            #[cfg(target_os = "windows")]
            {
                let fs_handle = handle.clone();
                std::thread::spawn(move || {
                    let mut last_fullscreen = false;
                    let mut last_covered = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(800));

                        let fullscreen = is_fullscreen_app_active();
                        if fullscreen != last_fullscreen {
                            last_fullscreen = fullscreen;
                            FULLSCREEN_ACTIVE.store(fullscreen, Ordering::Relaxed);
                            recompute_wallpaper_visibility(&fs_handle);
                            dlog(&fs_handle, &format!("[pause] fullscreen app active={}", fullscreen));
                        }

                        // Skip the (more expensive) window enumeration while a
                        // fullscreen app already has us paused.
                        let covered = if fullscreen { last_covered } else { desktop_is_covered() };
                        if covered != last_covered {
                            last_covered = covered;
                            WINDOW_OCCLUDED.store(covered, Ordering::Relaxed);
                            recompute_wallpaper_visibility(&fs_handle);
                            dlog(&fs_handle, &format!("[pause] desktop covered={}", covered));
                        }
                    }
                });
            }

            // macOS: poll the wallpaper window's occlusion state AND the
            // fullscreen-app heuristic. Both must run on the main thread —
            // AppKit is not thread-safe — so they ride the app's own event loop
            // via run_on_main_thread instead of a std::thread like Windows.
            //
            // The occlusion poll (macos_window_occluded) is kept because it
            // costs nothing and will become useful if Apple ever tracks windows
            // at desktop level. Today it always returns false; see its doc.
            //
            // The fullscreen poll (is_fullscreen_app_active) detects native
            // fullscreen spaces via the visibleFrame == frame heuristic.
            #[cfg(target_os = "macos")]
            {
                // Log once at startup if the auto-hide guard is active, so a
                // support conversation can immediately see why pausing never fires.
                if chrome_always_hidden() {
                    dlog(&handle, "[pause] macOS: Dock and menu bar both permanently hidden; \
                        fullscreen heuristic disabled (visibleFrame guard)");
                }

                let occ_handle = handle.clone();
                std::thread::spawn(move || {
                    let last_occ = std::sync::Arc::new(AtomicBool::new(false));
                    let logged_first_occ = std::sync::Arc::new(AtomicBool::new(false));
                    let last_fs = std::sync::Arc::new(AtomicBool::new(false));
                    let logged_first_fs = std::sync::Arc::new(AtomicBool::new(false));
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(1000));
                        let logged_first_occ = logged_first_occ.clone();
                        let logged_first_fs = logged_first_fs.clone();
                        let h = occ_handle.clone();
                        let last_occ = last_occ.clone();
                        let last_fs = last_fs.clone();
                        let _ = occ_handle.run_on_main_thread(move || {
                            if let Some(w) = h.get_webview_window("main") {
                                // ── Occlusion state (currently always false for
                                //    desktop-level windows; kept for future use) ──
                                let occluded = macos_window_occluded(&w);
                                // First reading goes in the log unconditionally,
                                // so the log distinguishes "poll never ran" from
                                // "state never changed".
                                if !logged_first_occ.swap(true, Ordering::Relaxed) {
                                    dlog(&h, &format!("[pause] macOS occlusion poll started, occluded={}", occluded));
                                }
                                if occluded != last_occ.load(Ordering::Relaxed) {
                                    last_occ.store(occluded, Ordering::Relaxed);
                                    WINDOW_OCCLUDED.store(occluded, Ordering::Relaxed);
                                    recompute_wallpaper_visibility(&h);
                                    dlog(&h, &format!("[pause] macOS window occluded={}", occluded));
                                }

                                // ── Fullscreen-app heuristic (visibleFrame ≈ frame) ──
                                let fullscreen = is_fullscreen_app_active();
                                if !logged_first_fs.swap(true, Ordering::Relaxed) {
                                    dlog(&h, &format!("[pause] macOS fullscreen poll started, fullscreen={}", fullscreen));
                                }
                                if fullscreen != last_fs.load(Ordering::Relaxed) {
                                    last_fs.store(fullscreen, Ordering::Relaxed);
                                    FULLSCREEN_ACTIVE.store(fullscreen, Ordering::Relaxed);
                                    recompute_wallpaper_visibility(&h);
                                    dlog(&h, &format!("[pause] macOS fullscreen app active={}", fullscreen));
                                }
                            }
                        });
                    }
                });
            }

            // Power source poll. One minute is plenty — nobody plugs in and out
            // faster than that, and a shell-out per second would be its own
            // battery drain.
            power::spawn_battery_monitor(handle.clone());

            // Spawn monitor configuration polling thread
            let handle_clone = handle.clone();
            std::thread::spawn(move || {
                let mut last_monitors_hash = String::new();
                #[cfg_attr(not(target_os = "windows"), allow(unused_mut, unused_variables))]
                let mut last_drift_attempt = String::new();
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    if let Ok(monitors) = handle_clone.available_monitors() {
                        let mut hash = String::new();
                        for m in monitors {
                            hash.push_str(&format!("{:?};{:?};{};", m.position(), m.size(), m.scale_factor()));
                        }
                        if hash != last_monitors_hash {
                            last_monitors_hash = hash;
                            #[cfg(target_os = "windows")]
                            last_drift_attempt.clear();
                            adjust_window_layouts(&handle_clone);
                        }
                    }

                    // Safety net: re-assert even when the monitor set is unchanged
                    // if the main window has drifted from its monitor's size (the
                    // startup reparent race can leave it at the config 1920x1080).
                    // Without this a static non-1080p display would stay wrong.
                    //
                    // Convergence guard: if a correction was already attempted and
                    // the size STILL doesn't match (Windows refused/clamped the
                    // resize — e.g. a WorkerW/DPI quirk on that machine), stop
                    // retrying until the monitor set changes. Re-firing the same
                    // failed correction every poll re-composites the wallpaper and
                    // the translucent settings panel over it — visible as a
                    // periodic flicker/"refresh" every few seconds.
                    #[cfg(target_os = "windows")]
                    if let Some(w) = handle_clone.get_webview_window("main") {
                        if let (Ok(sz), Ok(Some(mon))) = (w.inner_size(), w.current_monitor()) {
                            let ms = mon.size();
                            let dw = (sz.width as i64 - ms.width as i64).abs();
                            let dh = (sz.height as i64 - ms.height as i64).abs();
                            if dw > 2 || dh > 2 {
                                let attempt_key = format!(
                                    "{}x{}@{:?}->{}x{}",
                                    sz.width, sz.height, mon.position(), ms.width, ms.height
                                );
                                if attempt_key != last_drift_attempt {
                                    adjust_window_layouts(&handle_clone);
                                    dlog(&handle_clone, &format!(
                                        "[layout] drift correction attempted: {}", attempt_key
                                    ));
                                    last_drift_attempt = attempt_key;
                                }
                            } else {
                                last_drift_attempt.clear();
                            }
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
                    dlog(&handle, &format!("[Novaframe] set_desktop_underlay failed: {}", e));
                }
                if let Err(e) = window.set_ignore_cursor_events(true) {
                    dlog(&handle, &format!("[Novaframe] set_ignore_cursor_events failed: {}", e));
                }

                // OPAQUE on Windows, deliberately. This window IS the desktop
                // background: its page paints solid (`body` is #0f141d, the theme
                // iframe is #000), so there is never anything to see through it.
                // It used to be `transparent: true` + alpha 0, which makes it a
                // per-pixel-alpha layered window. That costs on two fronts:
                //   - DWM must alpha-blend a full monitor-sized surface every
                //     refresh (2560x1440 @ 120Hz), and
                //   - a layered window can't be reliably occlusion-culled, since
                //     the compositor must assume something behind may show
                //     through — so covering it with another window doesn't
                //     dependably stop the work.
                // See tauri.windows.conf.json, which sets `transparent: false`
                // for this window on Windows only (macOS config is untouched).
                #[cfg(target_os = "windows")]
                {
                    let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 255)));
                }

                // Re-run the full layout pass AFTER the underlay reparent so the
                // frame-inset correction (see adjust_window_layouts) is applied
                // to the final window state, not the pre-reparent one.
                dlog(&handle, &format!(
                    "[Novaframe] main POST-underlay: outer_pos={:?} outer_size={:?}",
                    window.outer_position(), window.outer_size()
                ));
                adjust_window_layouts(&handle);

                // The WorkerW reparent above resets the window bounds, and the OS
                // can apply that reset ASYNCHRONOUSLY — landing after the
                // synchronous re-layout on line above, leaving the window at its
                // config 1920x1080. On a non-1080p monitor (e.g. 1440p) that shows
                // as a wallpaper that doesn't fill the screen, and the monitor-poll
                // thread only re-fires when the monitor set *changes*, so a static
                // display never self-corrects. Re-assert the layout a few times
                // over the first ~1.3s to win the race against the reparent reset.
                #[cfg(target_os = "windows")]
                {
                    let retry_handle = handle.clone();
                    std::thread::spawn(move || {
                        for delay in [150u64, 400, 800] {
                            std::thread::sleep(std::time::Duration::from_millis(delay));
                            adjust_window_layouts(&retry_handle);
                        }
                    });
                }

            }

            if let Some(settings_window) = app.get_webview_window("settings") {
                // WebView2 renders a `transparent: true` window's unpainted
                // regions as OPAQUE unless the background color is explicitly set
                // to fully transparent. Without this the 40px strip left of the
                // panel content (everything except the cog + panel body) shows as
                // a solid block — the cog appears to have "its own section". The
                // main window already does this; the settings window was missed.
                #[cfg(target_os = "windows")]
                {
                    let _ = settings_window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                }

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
                            let mut sleep_ms = 800u64;

                            if SETTINGS_PANEL_LOCKED.load(Ordering::Relaxed) {
                                if !was_hovered {
                                    was_hovered = true;
                                    expand_settings_panel(settings_clone.clone());
                                }
                                std::thread::sleep(std::time::Duration::from_millis(150));
                                continue;
                            }

                            if let Ok(ns_window_ptr) = settings_clone.ns_window() {
                                if !ns_window_ptr.is_null() {
                                    unsafe {
                                        let ns_window = ns_window_ptr as *mut objc2::runtime::AnyObject;
                                        let ns_event_class = objc2::class!(NSEvent);
                                        let mouse_loc: NSPoint = objc2::msg_send![ns_event_class, mouseLocation];
                                        let frame: NSRect = objc2::msg_send![ns_window, frame];

                                        let is_near = mouse_loc.x >= (frame.origin.x - 50.0);
                                        if is_near {
                                            sleep_ms = 100;
                                        }

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
                            std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
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
                            std::thread::sleep(std::time::Duration::from_millis(150));

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
        .invoke_handler(tauri::generate_handler![expand_settings_panel, collapse_settings_panel, set_settings_panel_locked, log_from_js, quit_engine, open_storefront_window, installer::download_and_install_theme, installer::handle_engine_apply, installer::check_theme_updates_rust, installer::get_themes_dir, system::get_hardware_id, set_autostart, get_autostart, power::get_wallpaper_paused, installer::delete_theme, power::set_battery_saver, deeplink::flush_pending_deeplink])
        .run(tauri::generate_context!())
        .expect("error while running Novaframe desktop runtime application");
}

#[cfg(test)]
mod tests {
    use super::installer::is_safe_theme_name;

    #[test]
    fn rejects_path_traversal_and_separators() {
        // Every one of these would let a webview-triggered delete escape the
        // themes directory.
        for bad in ["", "..", "../..", "a/b", "a\\b", "..\\windows", ".hidden", "x/../../etc"] {
            assert!(!is_safe_theme_name(bad), "should reject {:?}", bad);
        }
    }

    #[test]
    fn accepts_real_theme_dir_names() {
        for good in ["breathing-gradient", "Lightning Storm", "Serif Monogram Initials", "deep-space"] {
            assert!(is_safe_theme_name(good), "should accept {:?}", good);
        }
    }

    #[test]
    fn test_deeplink_token_decoding_preserves_plus_slashes_and_equals() {
        use super::deeplink::decode_deeplink_token;
        let token = "eyJhbGciOiJIUzI1NiJ9+test/token==";
        let decoded = decode_deeplink_token(token);
        assert_eq!(decoded, Some("eyJhbGciOiJIUzI1NiJ9+test/token==").map(String::from));

        let encoded_plus = "hello%2Bworld";
        assert_eq!(decode_deeplink_token(encoded_plus), Some("hello+world").map(String::from));
    }
}
