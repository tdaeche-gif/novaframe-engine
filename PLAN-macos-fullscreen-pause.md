# PLAN — macOS: pause the wallpaper when a fullscreen app is frontmost

**Status:** ready to implement
**Scope:** `src-tauri/src/main.rs` only. No frontend changes. No new dependencies.
**Date:** 2026-07-27

---

## Why

Measured on 2026-07-27 with an instrumented probe theme running in the real
desktop underlay (`npm run tauri dev`), screen fully covered by another window
for ~18 seconds:

```
t+113s  drawn= 28.4  raf= 28.4  vis=visible  focus=false
t+120s  drawn= 29.4  raf= 29.4  vis=visible  focus=false
t+126s  drawn= 29.5  raf= 29.5  vis=visible  focus=false
```

Full 30fps the entire time the wallpaper was invisible. `engine-debug.log`
showed `occluded=false` for the whole session and **never logged a transition**.

Root cause: `macos_window_occluded()` (`main.rs:1119`) reads
`NSWindow.occlusionState`. The WindowServer does not compute a meaningful
occlusion state for a window parked at `kCGDesktopWindowLevel - 1`, so it
reports `Visible` no matter what covers the screen. The comment at `main.rs:1110`
("a maximized or full-screen app clears the `visible` bit for us") describes
behaviour that does not happen for this window class. This is not a polling bug
and cannot be fixed by polling differently.

Net effect today: every macOS user burns full GPU and battery rendering a
wallpaper they cannot see, whenever anything covers the screen.

## What this plan does and does not fix

**Fixes:** native-fullscreen apps — video playback, games, presentations,
fullscreen browser windows. This is where the battery actually goes.

**Does not fix:** merely *maximized* or tiled windows that cover the desktop
without entering a fullscreen space. Those keep rendering. Accepted, deliberate
limitation of this interim fix.

The complete fix is `CGWindowListCopyWindowInfo` coverage math, mirroring the
existing Windows `desktop_is_covered()`. It needs a new dependency for CFArray
handling and is deferred. **Do not attempt it in this change.**

---

## Signals considered and rejected

Record these so nobody re-derives them:

- **`NSWindow.isOnActiveSpace`** — would be perfect (entering fullscreen moves
  the user to a new space), but `tauri-plugin-desktop-underlay` sets
  `NSWindowCollectionBehaviorCanJoinAllSpaces` on our window
  (`src/core/macos.rs:16`), so it is always `true`. **Dead end — verified.**
- **`NSWorkspace.frontmostApplication`** — returns `NSRunningApplication`, which
  carries no window geometry. Cannot answer the question alone.
- **Fixing `occlusionState`** — the API does not track windows at this level.
  No amount of retry or cadence change helps.

## Signal chosen

`NSScreen.visibleFrame` vs `NSScreen.frame`.

When an app enters a native fullscreen space, macOS hides the menu bar and the
Dock, and `visibleFrame` grows to equal `frame`. In the normal desktop state
`visibleFrame` is inset by the menu bar (and the Dock, unless auto-hidden).

**The false positive that must be guarded:** a user who permanently auto-hides
*both* the Dock and the menu bar has `visibleFrame == frame` at all times. Left
unguarded, their wallpaper would be paused forever and look like a crash. This
is the single most important part of this change — an unguarded heuristic here
is worse than the bug it fixes.

---

## Implementation

### 1. Add the macOS arm of `is_fullscreen_app_active()`

The function already exists for Windows at `main.rs:1140` behind
`#[cfg(target_os = "windows")]`. Add a macOS sibling next to it. Do **not**
touch the Windows one.

```rust
/// True when a fullscreen app (video, game, presentation) owns the screen, so
/// the wallpaper render can be paused.
///
/// macOS gives us no usable direct signal here. `NSWindow.occlusionState` is
/// not tracked for a window at desktop level, and `isOnActiveSpace` is always
/// true because the underlay plugin sets `canJoinAllSpaces`. What a fullscreen
/// space *does* change is the menu bar and Dock: both hide, so `visibleFrame`
/// grows to meet `frame`.
///
/// Deliberately misses merely *maximized* windows. The full fix is a
/// CGWindowList coverage check; see PLAN-macos-fullscreen-pause.md.
#[cfg(target_os = "macos")]
fn is_fullscreen_app_active() -> bool {
    use objc2_app_kit::NSScreen;
    use objc2_foundation::MainThreadMarker;

    // Guard: users who permanently hide the Dock *and* menu bar always satisfy
    // the geometry test. Pausing their wallpaper forever would read as a crash,
    // so for them we report "not fullscreen" and simply never pause.
    if chrome_always_hidden() {
        return false;
    }

    let Some(mtm) = MainThreadMarker::new() else {
        return false; // caller must be on the main thread; see step 2
    };
    let Some(screen) = NSScreen::mainScreen(mtm) else {
        return false;
    };

    let frame = screen.frame();
    let visible = screen.visibleFrame();

    // Tolerance, not equality: visibleFrame can differ by a fraction of a point
    // from rounding on scaled displays.
    (frame.size.height - visible.size.height).abs() < 1.0
        && (frame.size.width - visible.size.width).abs() < 1.0
}
```

### 2. Add the auto-hide guard

Read once at startup and cache — these are user preferences that change rarely,
and shelling out on a poll would be wasteful.

Shelling out to `defaults` is consistent with existing precedent in this file:
`running_on_battery()` (`main.rs:~73`) already shells out to `/usr/bin/pmset`
once a minute rather than binding IOKit, for the same reason.

```rust
/// True when the user permanently hides both the Dock and the menu bar, which
/// makes the `visibleFrame == frame` fullscreen test useless for them.
/// Read once at startup: these are preferences, not state.
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
```

Note `&&`, not `||`. Hiding only the Dock still leaves the menu bar inset, so
the test remains valid; only hiding *both* defeats it.

### 3. Wire it into the existing macOS poll

The macOS occlusion poll already exists at `main.rs:~1441`, runs once a second,
and correctly marshals onto the main thread via `run_on_main_thread`. Reuse it —
do **not** add a second thread. `NSScreen` must be read on the main thread, which
is why `is_fullscreen_app_active()` takes a `MainThreadMarker`.

Inside the existing `run_on_main_thread` closure, alongside the current
`macos_window_occluded` call, add a parallel transition check that stores into
`FULLSCREEN_ACTIVE` (the static already exists at `main.rs:39`; today only
Windows writes it, and `recompute_wallpaper_visibility` already ORs it in at
`main.rs:51` — so no plumbing is needed downstream):

```rust
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
```

Mirror the existing `last` / `logged_first` `Arc<AtomicBool>` pattern in that
thread — the first reading is logged unconditionally so the log distinguishes
"poll never ran" from "state never changed". Keep that property.

If `chrome_always_hidden()` is true, log it once at startup so a support
conversation can spot instantly why a user never pauses.

### 4. Leave `macos_window_occluded` alone

It stays, it stays wired, and it keeps returning `false`. It costs nothing and
becomes useful if Apple ever tracks these windows. **Update its doc comment**
(`main.rs:1105-1117`) to say it is known not to fire for a desktop-level window
and that fullscreen pausing is handled by `is_fullscreen_app_active()` — the
current comment actively misleads.

---

## Verification

Real measurement, not reasoning. A probe theme rendering an on-screen HUD, read
by `screencapture`, is the cheapest readout — the theme iframe is null-origin
sandboxed so it cannot report out any other way without an engine-side bridge.
The harness used on 2026-07-27 is described in the memory note
`novaframe-loop-throttle-2026-07-27`.

Test under `npm run tauri dev`. **Not** `tauri build --debug` — that bundle never
requested any theme asset and renders nothing; unexplained, separate issue.

1. Wallpaper visible on the desktop → `engine-debug.log` shows
   `fullscreen app active=false`, frames continue.
2. Put a video into native fullscreen → within ~1s the log shows
   `fullscreen app active=true`, and the probe's `drawn` drops to 0.
3. Leave fullscreen → `active=false`, frames resume within ~1s, and the first
   frame after resume has a sane `dt` (the loop resets `lastTs` in `ensureLoop`).
4. Merely maximize a window → stays `false`, frames continue. This is the
   documented limitation, not a regression.
5. Set `defaults write com.apple.dock autohide -bool true` and
   `defaults write NSGlobalDomain _HIHideMenuBar -bool true`, restart the engine
   → guard log line appears, `active=false` permanently, wallpaper never pauses.
   **Put both settings back afterwards.**

## Constraints

- `cargo check` must be warning-clean before claiming done (CLAUDE.md).
- No new dependencies. `objc2`, `objc2-foundation`, `objc2-app-kit` are already
  macOS deps in `Cargo.toml`.
- Do not touch the updater signing keys or `tauri.conf.json`.
- Do not modify the Windows paths.
- The working tree already has unrelated uncommitted changes to `.gitignore`,
  `package.json`, `tauri.conf.json`, `src/index.html`, and an untracked
  `src/mode-init.js`. Leave them alone.
