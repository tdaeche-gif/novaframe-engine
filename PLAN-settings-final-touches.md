# Settings Panel — Final UI Touches

Two remaining issues to address:

1. **Cog position + panel sizing** — cog must sit **just outside** the settings panel (to the right of it, hugging the right edge of the screen). It must remain visible and correctly sized in both collapsed and expanded states.
2. **Legacy-only controls** — when a non-legacy theme is active (e.g. Ignis), the legacy section (`#legacySection`: shadow opacity, analemma toggle, tracked pins + form) must not be visible.

This plan replaces the current `#settingsPanel > .panel-handle + .panel-content` layout with a layout where the **panel content is anchored to the right edge of the settings webview** and the **cog floats as a vertical tab to the right of the panel**. The settings webview window resizes between the two states, but the **cog geometry never changes** — it sits flush against the right edge of the now-expanded window.

---

## 1. Layout topology

```
┌──────────────────── monitor ────────────────────┐
│                                                  │
│                                                  │
│                                                  │
│                                       ┌─[⚙]─┐    │   ← cog tab on the FAR right
│                                       │       │    │
│                                       │ panel │    │
│                                       │       │    │
│                                       └───────┘    │
│                                                  │
└──────────────────────────────────────────────────┘
                       ▲
                  right edge of monitor

States:
- COLLAPSED: window is 40×600, only the cog tab is in view. No panel rectangle shown.
- HOVERED:   window is 360×600, panel rectangle slides in to the LEFT of the cog
             tab; cog geometry unchanged; cog stays in the same screen position.
```

**Key invariant**: the cog is **DOM-positioned outside the panel-content rectangle**, flush right, fixed 40×40. The panel rectangle grows leftward on hover. This means the cog's screen-space bounding box never moves — it remains at the same (x, y) on screen regardless of state. Only the panel rectangle to its left changes.

---

## 2. Component reorganisation

### DOM

```
#settingsPanel (flex row, justify-content: flex-end)
├── .panel-content (flex 0 0 320px) — panel rectangle
│   └── (existing controls: theme selector, marketplace button,
│        legacy section, update, etc.)
└── .panel-handle (flex 0 0 40px × 40px) — cog tab
    └── <svg class="cog-icon"> ... </svg>
```

Order: `.panel-content` FIRST in DOM, `.panel-handle` SECOND. With `flex-direction: row; justify-content: flex-end`, the cog will visually sit at the FAR RIGHT and the panel rectangle to its left.

### Sizing semantics

- `.panel-content`: `flex: 0 0 320px; height: 600px;` — fixed width, fixed height. On collapse (window=40px wide), this rectangle **exceeds** the available window width and gets clipped by the window edges. (Tauri's webview clips content past its bounds.)
- `.panel-handle`: `flex: 0 0 40px; width: 40px; height: 40px; align-self: center;` — fixed 40×40, always visible. Color: subtle background pill (rounded), no border on its right edge (it IS the right edge).

When the window is 40 wide:
- `.panel-content` (320px) overflows to the left of the window. Window clips it. Only cog visible.

When the window is 360 wide (collapsed 40 + panel 320):
- Both fit. Cog at right edge, panel rectangle to its left.

### Cog as a separate "tab"

- `background: rgba(10, 15, 26, 0.75); border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;`
- `border-right: none;` (no border on the right edge — there's nothing to its right except the screen edge)
- `backdrop-filter: blur(10px);`
- Hover: `border-color: rgba(0,162,255,0.5); background: rgba(10,15,26,0.9);`
- Cog icon: 22×22, rotates 180° on hover. Existing CSS is fine.

The cog tab is **round-edged on the LEFT** (where it meets the panel rectangle) and **square-edged on the RIGHT** (screen boundary). Radius: `border-radius: 12px 0 0 12px;` would round the left side (matching the panel); the right side stays square. If the panel has `border-radius: 12px 0 0 12px` too, the visual seam between them is clean.

---

## 3. Panel-content styling (tight)

Goal: no empty padding. Reasonable density. Visual matches a control sidebar in apps like Discord.

```css
.panel-content {
    flex: 0 0 320px;
    width: 320px;
    height: 600px;
    padding: 16px 16px;
    box-sizing: border-box;
    background: rgba(10, 15, 26, 0.78);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-right: 1px solid rgba(255, 255, 255, 0.08); /* visual right edge before cog */
    border-radius: 12px 0 0 12px;
    box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0;
    pointer-events: auto;
    opacity: 1;
    transition: opacity 0.3s cubic-bezier(0.25, 1, 0.5, 1);
}

.panel-content > * + * {
    margin-top: 12px;
}

.control-group {
    margin-bottom: 0;          /* gap handled by parent flex gap */
    width: 100%;
    box-sizing: border-box;
}
```

Reduce control-group spacing. Forms and labels keep their 8px gaps internally.

When the window is 40px wide (collapsed), `.panel-content` is clipped by window edges but its opacity stays 1 — that is fine because it isn't visible anyway. **No opacity transition needed across window states.**

---

## 4. Rust changes

Two commands already exist: `expand_settings_panel` and `collapse_settings_panel`. Update `expand_settings_panel` only — change width from 275 → **360** (so the window is wide enough to fit both 320px panel-content + 40px cog).

`collapse_settings_panel` keeps width at **40**, height at **600** (so the cog stays vertically centred when window is narrow-tall).

```rust
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
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(panel_width, panel_height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(logical_x, logical_y)));
    }
}
```

`collapse_settings_panel` keeps the existing 40×600 logic.

Settings window initial size in `tauri.conf.json` remains `40×600` (collapsed).

---

## 5. CSS — show/hide legacy section based on active theme

### Mark the panel with `data-theme-scope` derived from the active theme

We need both:
- `data-theme-scope="legacy"` when current theme manifest declares `render_mode: "internal-legacy"` (or no theme).
- `data-theme-scope="dynamic"` for everything else.

Two places to set it:
1. The settings panel itself (`#settingsPanel`): `panel.dataset.themeScope = ...`.
2. Also on `<html>` (for any future checks). Both set, cheap.

### CSS

```css
#settingsPanel[data-theme-scope="dynamic"] #legacySection { display: none; }
#settingsPanel[data-theme-scope="legacy"]  #legacySection { display: block; }
```

The selector is on `#settingsPanel` (specificity 1,1,0,0 → id + id) so it always wins over the default `<section>` `display: block`.

### JavaScript

New function:

```js
async function applyThemeScopeFromStore() {
    try {
        const themePath = await ConfigManager.getTheme();
        let scope = 'legacy';
        if (themePath) {
            try {
                const { manifest } = await ThemeManager.readManifest(themePath);
                scope = (manifest.render_mode === 'internal-legacy') ? 'legacy' : 'dynamic';
            } catch (_) {
                scope = 'dynamic'; // unreadable manifest → conservative hide
            }
        }
        const panel = document.getElementById('settingsPanel');
        if (panel) panel.dataset.themeScope = scope;
        document.documentElement.dataset.themeScope = scope;
    } catch (e) {
        console.warn('[settings] applyThemeScopeFromStore failed:', e);
    }
}
```

Call sites:

1. Inside `initSettingsUI()` (settings window only) — call once at the top, after the existing structural setup. This ensures the panel reflects the **persisted** active theme, not the empty initial state.
2. Inside `theme-changed` listener — settings branch — replace the existing `applyThemeScope()` call with `applyThemeScopeFromStore()`. The store's `setTheme` already broadcasts, and both windows run the listener.
3. Keep the existing `applyThemeScope()` call in:
   - `initDualWindowSystem` mode=settings path (initial paint before async).
   - `ThemeManager.loadTheme` end (after main-window iframe mounts).
   - `ThemeManager.fallbackToLegacy` (when manifest can't be read).
   - The `theme-changed` listener's main-window branch is now redundant for the settings panel scope, but `applyThemeScope()` keeps `<html data-theme-scope>` in sync for any future main-window checks.

### Why this fixes the bug

The settings window's `#legacySection` was leaking through because `applyThemeScope()` was the only path that set `data-theme-scope`, and it ran **before** the persisted theme was loaded. The fix is the post-init sync: after `ConfigManager.init()` resolves the stored `themePath`, we read the manifest and derive the correct scope. The `theme-changed` broadcast also fires on every selection change, so the scope stays in lockstep.

---

## 6. Files touched

| File | Change |
|---|---|
| `GeochronEngine/src-tauri/src/main.rs` | Update `expand_settings_panel`: panel_width 360, panel_height 600, anchor to monitor's right edge. |
| `GeochronEngine/src/style.css` | Restyle `#settingsPanel` as flex-row with `justify-content: flex-end`. Update `.panel-handle` (40×40 tab, no right border, rounded-left corners). Update `.panel-content` (320×600, padding 16px, rounded-left corners, opacity 1 always). Add `#settingsPanel[data-theme-scope="dynamic"] #legacySection { display: none; }` (replace existing rule that targeted `<html>`). |
| `GeochronEngine/src/app.js` | Add `applyThemeScopeFromStore()`. Call it from `initSettingsUI()` and from the `theme-changed` listener's settings branch. Existing `applyThemeScope()` kept for main-window paths. |
| `GeochronEngine/src/index.html` | No change if DOM order is already `panel-content` then `panel-handle`. Verify by inspection; flip order if needed. |

No backend / no wpk changes. No Rust or JS contract changes for theme authors.

---

## 7. Verification

After the change, with the engine running and Ignis selected as the active theme:

1. **Cog placement**: a 40×40 cog tab sits at the **far right edge** of the monitor, vertically centred, at all times. Even when no hover is active.
2. **Collapsed state**: only the cog tab is visible. No dark panel rectangle sticking out to the left of it.
3. **Hover state**: hovering over the cog (or the area immediately to its left) → window expands to 360px wide. The panel rectangle appears immediately to the **LEFT** of the cog, with a tight 16px padding inside. Cog stays in the same screen position. Hover away → window collapses back to 40px, cog stays.
4. **Legacy section visibility with Ignis active**: settings panel shows only "Active Theme" dropdown + "Browse Marketplace" + "Check for Updates". No shadow opacity slider, no analemma toggle, no tracked pins, no add-pin form.
5. **Switch to Internal-Legacy**: legacy controls reappear. Switching back to Ignis: legacy controls disappear.
6. **First launch after engine restart with Ignis already persisted**: settings panel opens to collapsed (cog only); expand on hover → only common controls visible. Legacy controls do **not** flash visible briefly. (This is the bug fix.)

---

## 8. Out of scope (intentionally)

- Removing the depth of "extra clear padding around" inside `.panel-content` further (e.g. eliminating the panel rectangle's own border). The 16px padding is the agreed reduced padding; further tightening (or alternatively, a wider panel) is a follow-up if you want to dial it in once more.
- Animations on panel slide. The current transition is just a window resize. Acceptable for v1.
- Auto-hide cog after inactivity. You mentioned this in a previous turn; deferred.
- Whatever sub-pixel polish on the cog icon's rotation/timing.

---

## 9. Open question

If after step 5 verification you want the panel rectangle to be **even tighter** (less inner padding, narrower or wider), say "tighter" or specify dimensions and I'll adjust. Otherwise this plan ships as-is.
