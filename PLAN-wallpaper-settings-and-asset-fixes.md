# PLAN: Wallpaper settings pipeline + asset loading fixes

Goal: fix the two broken wallpapers (Classic Mercator, Ignis) AND make the engine↔wallpaper
contract generic, so that ANY future theme installed into the engine gets:
1. working relative asset loading (images, shaders, fonts) inside its iframe, and
2. live settings updates from the panel sliders/toggles/colors without an iframe reload.

Execute phases in order. Each edit gives the file, an anchor (existing code to find), and the
exact replacement. Do not reformat surrounding code. After Phase 6, run the acceptance checklist.

Repos touched:
- Engine: `/Users/tdaeche/NovaframeEngine` (src/app.js, src-tauri/src/main.rs, src-tauri/Cargo.toml)
- Wallpapers: `/Users/tdaeche/Novaframe-Wallpapers/Published/{mercator-classic,ignis-solar-flares}`
- Template: `/Users/tdaeche/Novaframe-Wallpapers/_TEMPLATE` (engine repo copy: `themes/_TEMPLATE`)

Background (why): full audit findings are summarized at the bottom of this file ("Appendix: root
causes"). Read it before starting if anything seems arbitrary.

---

## Phase 1 — Engine: `theme://` custom protocol (fixes ALL relative asset loading)

**Root cause being fixed:** Tauri v2 `convertFileSrc()` returns
`asset://localhost/<encodeURIComponent(fullPath)>` — the slashes are `%2F`, so the whole
filesystem path is ONE url segment. Relative URLs inside the theme (`./world-map-mercator.jpg`,
`fetch('./shaders/terminator.vert')`) therefore resolve against `asset://localhost/` and point at
nothing. No `assetProtocol.scope` entry can ever fix this. We register a custom `theme://`
protocol whose URL paths are real directory paths, so relative resolution works natively.

### 1.1 `src-tauri/Cargo.toml` — add percent-decoding dep

In `[dependencies]` (near the other small utility deps), add:

```toml
percent-encoding = "2"
```

### 1.2 `src-tauri/src/main.rs` — register the protocol

**(a)** Add these two helper functions above `fn main()` (e.g. right after `sanitize_dir_name`):

```rust
fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        // GLSL shaders and anything unknown: plain text is fine for fetch()
        _ => "text/plain",
    }
}

/// Serve `theme://localhost/<absolute-fs-path>` (each segment percent-encoded).
/// Only paths under the AppData themes dir or the local dev wallpapers dir are allowed.
fn handle_theme_protocol(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    use percent_encoding::percent_decode_str;

    let deny = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
    };

    let decoded = match percent_decode_str(request.uri().path()).decode_utf8() {
        Ok(s) => s.to_string(),
        Err(_) => return deny(400),
    };
    let fs_path = std::path::PathBuf::from(&decoded);

    // Canonicalize to defeat ../ traversal; 404 if the file doesn't exist.
    let canon = match fs_path.canonicalize() {
        Ok(p) => p,
        Err(_) => return deny(404),
    };

    // Allowlist roots: installed themes + local dev wallpaper source tree.
    let themes_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("themes"))
        .and_then(|d| d.canonicalize().ok());
    let dev_root = std::path::PathBuf::from("/Users/tdaeche/Novaframe-Wallpapers")
        .canonicalize()
        .ok();

    let allowed = [themes_root, dev_root]
        .iter()
        .flatten()
        .any(|root| canon.starts_with(root));
    if !allowed {
        println!("[theme://] DENIED (outside allowed roots): {:?}", canon);
        return deny(403);
    }

    match std::fs::read(&canon) {
        Ok(bytes) => tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", mime_for(&canon))
            // Required: the main window (tauri://localhost origin) fetches manifests
            // cross-origin from theme://localhost.
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .unwrap(),
        Err(_) => deny(404),
    }
}
```

Note: `app.path().app_data_dir()` returns `Result` in tauri v2 — the `.ok()` above handles it.
`use tauri::Manager;` is already imported at the top of main.rs.

**(b)** In `fn main()`, chain the protocol onto the builder. Anchor — find:

```rust
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
```

Replace with:

```rust
        .plugin(tauri_plugin_store::Builder::new().build())
        .register_uri_scheme_protocol("theme", |ctx, request| {
            handle_theme_protocol(&ctx.app_handle().clone(), &request)
        })
        .setup(|app| {
```

(If the closure signature complains, tauri v2's handler is
`Fn(UriSchemeContext<'_, R>, http::Request<Vec<u8>>) -> http::Response<impl Into<Cow<[u8]>>>` —
`ctx.app_handle()` gives `&AppHandle`.)

**(c)** Build check: `cd /Users/tdaeche/NovaframeEngine && cargo check --manifest-path src-tauri/Cargo.toml`
must pass before continuing.

### 1.3 `src/app.js` — mount themes via `theme://`

**(a)** Add a helper near the top of app.js (right after `getThemesDir()`):

```js
// Build a theme:// URL from an absolute filesystem path. Unlike Tauri's
// convertFileSrc (which percent-encodes the WHOLE path into one URL segment,
// breaking every relative subresource inside the theme), this keeps real
// directory segments so `./img.jpg` and `fetch('./shaders/x.frag')` resolve.
function toThemeUrl(fsPath) {
    const encoded = fsPath.split('/').map(encodeURIComponent).join('/');
    // Windows/Android webviews expose custom schemes as http://<scheme>.localhost
    const isWindows = navigator.userAgent.includes('Windows');
    return isWindows
        ? `http://theme.localhost${encoded.startsWith('/') ? '' : '/'}${encoded}`
        : `theme://localhost${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}
```

**(b)** `ThemeManager.readManifest` — replace the convertFileSrc line. Anchor:

```js
            const uri = window.__TAURI__.core.convertFileSrc(`${themePath}/${candidate}`);
```

Replace with:

```js
            const uri = toThemeUrl(`${themePath}/${candidate}`);
```

Also delete the now-obsolete guard just above it (`if (!window.__TAURI__?.core?.convertFileSrc) { throw ... }`)
— replace that whole `if` block with nothing.

**(c)** `ThemeManager.loadExternalHtml` — anchor:

```js
        const fileSrc = window.__TAURI__.core.convertFileSrc(`${themePath}/${entry}`);
```

Replace with:

```js
        const fileSrc = toThemeUrl(`${themePath}/${entry}`);
```

Leave `assetProtocol` config in tauri.conf.json untouched (harmless, and other code may use it).

---

## Phase 2 — Engine: generic live-settings pipeline (`src/app.js`)

**Root cause being fixed:** sliders live in the *settings window*; the wallpaper iframe lives in
the *main window*. The slider handlers post to `ThemeManager.currentIframe`, which is always
`null` in the settings window, and the main window's `config-changed` listener only does
`config = event.payload` without forwarding anything. So NO theme ever receives live updates —
they only apply after an iframe reload. This fix is fully generic: it forwards the whole saved
settings object for the active theme whenever config changes, so every current and future theme
gets live updates with zero per-theme code.

### 2.1 Add one relay function (place directly after the `ThemeManager = { ... }` object literal,
before the `// ── Mouse passthrough` section):

```js
// ── Live settings relay (main window) ──────────────────────────────────────
// Forward the active theme's saved settings to the wallpaper iframe. Called
// whenever config changes (event from the settings window, or store poll).
// Sends the FULL settings object — themes treat every message as a partial
// patch, so resending unchanged keys is harmless and keeps this generic.
let _lastRelayedSettings = null;
function relayThemeSettingsToIframe() {
    const tp = ThemeManager.currentThemePath;
    const cw = ThemeManager.currentIframe?.contentWindow;
    if (!tp || !cw) return;
    const settings = config.theme_settings?.[tp];
    if (!settings) return;
    const serialized = JSON.stringify(settings);
    if (serialized === _lastRelayedSettings) return; // dedupe
    _lastRelayedSettings = serialized;
    try {
        cw.postMessage({ type: 'novaframe-settings', settings }, '*');
    } catch (_) {}
}
```

### 2.2 Hook the relay into the `config-changed` listener. Anchor:

```js
            window.__TAURI__.event.listen('config-changed', (event) => {
                if (event.payload) {
                    config = event.payload;
                }
            });
```

Replace with:

```js
            window.__TAURI__.event.listen('config-changed', (event) => {
                if (event.payload) {
                    config = event.payload;
                    relayThemeSettingsToIframe();
                }
            });
```

### 2.3 Hook the relay into the main-window store poll (covers the case where the Tauri event
is missed). In `ConfigManager.init`, anchor:

```js
                setInterval(async () => {
                    const latestConfig = await this.store.get('novaframe_config');
                    if (latestConfig) config = latestConfig;
```

Replace with:

```js
                setInterval(async () => {
                    const latestConfig = await this.store.get('novaframe_config');
                    if (latestConfig) {
                        config = latestConfig;
                        relayThemeSettingsToIframe();
                    }
```

(The closing brace count changes: the original had no braces around `config = latestConfig;` —
make sure the `setInterval` body still parses. Final shape:

```js
                setInterval(async () => {
                    const latestConfig = await this.store.get('novaframe_config');
                    if (latestConfig) {
                        config = latestConfig;
                        relayThemeSettingsToIframe();
                    }

                    const latestTheme = await this.store.get('activeTheme');
                    const normLatest = latestTheme || null;
                    const normCurrent = ThemeManager.currentThemePath || null;
                    if (normLatest !== normCurrent) {
                        ThemeManager.currentThemePath = normLatest;
                        ThemeManager.loadTheme(normLatest);
                    }
                }, 1000);
```
)

### 2.4 Seed manifest defaults on iframe load (so brand-new installs get correct initial
settings even before the user ever opens the panel). In `mountIframe`, anchor:

```js
            // Dispatch saved theme settings if they exist
            if (config.theme_settings && config.theme_settings[themePath]) {
                const settings = config.theme_settings[themePath];
                try {
                    iframe.contentWindow.postMessage({
                        type: 'novaframe-settings',
                        settings
                    }, '*');
                } catch (_) {}
            }
```

Replace with:

```js
            // Dispatch settings: manifest defaults overlaid with any saved values.
            // Guarantees a freshly installed theme starts from its manifest
            // defaults and a returning theme gets the user's saved state.
            const defaults = {};
            (ThemeManager.currentManifest?.custom_settings || []).forEach(s => {
                if (s.default !== undefined) defaults[s.id] = s.default;
            });
            const saved = (config.theme_settings && config.theme_settings[themePath]) || {};
            const settings = { ...defaults, ...saved };
            if (Object.keys(settings).length > 0) {
                _lastRelayedSettings = JSON.stringify(settings);
                try {
                    iframe.contentWindow.postMessage({
                        type: 'novaframe-settings',
                        settings
                    }, '*');
                } catch (_) {}
            }
```

### 2.5 Reset the dedupe cache on unmount. In `unmountIframe`, anchor:

```js
        this.currentIframe = null;
```

Replace with:

```js
        this.currentIframe = null;
        _lastRelayedSettings = null;
```

### 2.6 Fix the Classic Mercator pins UI never rendering. Anchor (app.js ~line 610):

```js
            if (ThemeManager.manifestCache[themePath].name === 'Classic Mercator') {
```

Replace with:

```js
            if (ThemeManager.manifestCache[themePath].label === 'Classic Mercator') {
```

(The cache is populated as `{ label, mode, custom_settings }` in `scanThemes` — there is no
`.name` key, so this condition was always false and the pins UI never appeared.)

### 2.7 Fix falsy-default seeding bug (a range default of `0` becomes `''`). Two anchors in
`updateSettingsScope`:

```js
                    input.checked = savedVal !== undefined ? savedVal : (setting.default || false);
```
→
```js
                    input.checked = savedVal !== undefined ? savedVal : (setting.default ?? false);
```

and:

```js
                    input.value = savedVal !== undefined ? savedVal : (setting.default || '');
```
→
```js
                    input.value = savedVal !== undefined ? savedVal : (setting.default ?? '');
```

### 2.8 Defuse two latent ReferenceErrors in app.js:

**(a)** The `occlusion-change` listener references undeclared legacy variables (`rafId`,
`timeoutId`, `rafStarted`, `lastDrawTime`, `startLoop`, `isWindowOccluded`) — the first
occlusion event where `isVisible === true` will throw. Anchor (whole listener):

```js
            window.__TAURI__.event.listen('occlusion-change', (event) => {
                const isVisible = event.payload;
                isWindowOccluded = !isVisible;
                
                // Broadcast to external themes so they can pause their render loops
                if (ThemeManager.currentIframe?.contentWindow) {
                    try {
                        ThemeManager.currentIframe.contentWindow.postMessage({
                            type: 'novaframe-occlusion',
                            occluded: isWindowOccluded
                        }, '*');
                    } catch (_) {}
                }

                if (isVisible) {
                    lastDrawTime = 0; // force redraw
                    if (!rafId) {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        rafStarted = false;
                        startLoop();
                    }
                }
            });
```

Replace with:

```js
            window.__TAURI__.event.listen('occlusion-change', (event) => {
                const isVisible = event.payload;
                // Broadcast to external themes so they can pause their render loops
                if (ThemeManager.currentIframe?.contentWindow) {
                    try {
                        ThemeManager.currentIframe.contentWindow.postMessage({
                            type: 'novaframe-occlusion',
                            occluded: !isVisible
                        }, '*');
                    } catch (_) {}
                }
            });
```

**(b)** `ThemeManager.applyThemeToDOM` references a global `mapImage` that no longer exists
(legacy internal-legacy renderer). It has no callers — delete the entire `applyThemeToDOM`
method (and the trailing comma of the previous member if needed).

---

## Phase 3 — Classic Mercator wallpaper fixes
File: `/Users/tdaeche/Novaframe-Wallpapers/Published/mercator-classic/index.html`

### 3.1 Declare the missing WebGL globals (currently every one of these is an undeclared
identifier; `if (glFailed)` in `initWebGLShader` throws a ReferenceError on the FIRST frame,
which kills the whole `requestAnimationFrame` loop — no terminator, pins, analemma or timeline
ever draw). Anchor:

```js
        // Load Shader Sources
        let glShaderSources = { vert: null, frag: null };
```

Replace with:

```js
        // WebGL terminator layer state
        let glFailed = false;
        let glInitialized = false;
        let glCanvas = null;
        let glContext = null;
        let glProgram = null;
        let glLocs = null;
        let glBuffer = null;
        let cityLightsTexture = null;
        let cityLightsUploaded = false;

        // Load Shader Sources
        let glShaderSources = { vert: null, frag: null };
```

### 3.2 Accept `pinned_locations` (and be defensive about types) in the settings listener.
Anchor:

```js
            if (data.type === 'novaframe-settings') {
                const settings = data.settings;
                if (settings.shadow_opacity !== undefined) config.shadowOpacity = settings.shadow_opacity;
                if (settings.show_analemma !== undefined) config.showAnalemma = settings.show_analemma;
                
                // Redraw static map to reflect any immediate changes if needed
                drawStaticMap(winW, winH);
            }
```

Replace with:

```js
            if (data.type === 'novaframe-settings') {
                const settings = data.settings;
                if (settings.shadow_opacity !== undefined) config.shadowOpacity = Number(settings.shadow_opacity);
                if (settings.show_analemma !== undefined) config.showAnalemma = settings.show_analemma === true || settings.show_analemma === 'true';
                if (Array.isArray(settings.pinned_locations)) config.pinnedLocations = settings.pinned_locations;

                // Redraw static map to reflect any immediate changes if needed
                drawStaticMap(winW, winH);
            }
```

### 3.3 No asset-path changes needed: once Phase 1 ships, the existing relative paths
(`./world-map-mercator.jpg`, `./world-city-lights.png`, `./shaders/…`) resolve correctly under
`theme://`. They also keep working when the file is opened over plain `http://` for browser dev.

### 3.4 (Optional, low priority) `computeTerminatorPolygon` is defined but never called — if
WebGL init fails, the terminator silently disappears rather than falling back to CPU. Either
delete the function or leave a `// TODO: CPU fallback` note. Do not attempt to wire it up in
this pass.

---

## Phase 4 — Ignis wallpaper fixes
File: `/Users/tdaeche/Novaframe-Wallpapers/Published/ignis-solar-flares/index.html`

### 4.1 Kill the 4K CSS override (it wins over the inline styles `renderer.setSize()` writes,
because of `!important`, so the canvas always displays at 3840×2160 CSS px, center-cropped by
the flex container). Anchor (inside `<style>`):

```css
        body,
        html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #000000;
            display: flex;
            justify-content: center;
            align-items: center;
        }

        /* The canvas is physically 4K, but we will scale it with JS */
        canvas {
            display: block;
            width: 3840px !important;
            height: 2160px !important;
            transform-origin: center center;
        }
```

Replace with:

```css
        body,
        html {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background-color: #000000;
        }

        canvas {
            display: block;
        }
```

### 4.2 Remove the dead 4K init (cosmetic but avoids future confusion). Anchor:

```js
        // HARDCODE RESOLUTION TO 4K (3840x2160)
        // 'false' prevents Three.js from setting CSS inline width/height so we can control it
        renderer.setPixelRatio(1);
        renderer.setSize(3840, 2160, false);
```

Replace with:

```js
        renderer.setPixelRatio(1);
```

(The `onWindowResize()` call below already sets the real size before the first frame.)
Also update the stale uniform init. Anchor:

```js
            u_resolution: { type: "v2", value: new THREE.Vector2(3840, 2160) },
```

Replace with:

```js
            u_resolution: { type: "v2", value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
```

### 4.3 Fix the engine-pointer mapping (still maps into 4K space; must map into the live
window space that `u_resolution` uses). Anchor:

```js
            if (data.type === 'novaframe-pointer') {
                targetMouse.x = data.nx * 3840;
                targetMouse.y = (1.0 - data.ny) * 2160;
                return;
            }
```

Replace with:

```js
            if (data.type === 'novaframe-pointer') {
                targetMouse.x = data.nx * window.innerWidth;
                targetMouse.y = (1.0 - data.ny) * window.innerHeight;
                return;
            }
```

### 4.4 Fix the flare-intensity blowout. GLSL `mix(a, b, t)` EXTRAPOLATES when `t > 1` — at
high intensity `corona` reaches ~2 and `pow(corona,2.0)*2.0` ≈ 8, blasting every pixel far past
yellow/white (the "solid yellow blob"). Principle: intensity may only widen the falloff
(`boost` divisor = reach), never multiply mix weights; every mix weight gets clamped; a soft
tone-map keeps `corona` ≤ 1. Anchor (in the fragment shader):

```glsl
            float sunBody = smoothstep(0.4, 0.35, dist);
            // Calculate exponential boost based on intensity slider (0.0 to 1.0)
            float boost = 1.0 + pow(u_flare_intensity, 2.0) * 4.0; 
            float corona = exp(-dist * (2.5 / boost)) * f * (1.0 + u_flare_intensity);

            vec3 colorDark = vec3(0.0, 0.0, 0.0);
            vec3 colorRed = u_core_temp; // remove * 0.5 to keep original brightness
            vec3 colorYellow = mix(colorRed, vec3(1.0, 0.8, 0.2), 0.5);
            vec3 colorWhite = vec3(1.0, 0.9, 0.8);

            vec3 finalColor = mix(colorDark, colorRed, corona * 1.5);
            finalColor = mix(finalColor, colorYellow, pow(corona, 2.0) * 2.0);
            finalColor = mix(finalColor, colorWhite, sunBody + pow(corona, 5.0));
```

Replace with:

```glsl
            float sunBody = smoothstep(0.4, 0.35, dist);
            // Intensity widens the corona's reach by flattening the exponential
            // falloff. It must NOT multiply the color-mix weights below — GLSL
            // mix() extrapolates past its endpoints when the weight exceeds 1,
            // which is what blew the screen out to solid yellow.
            float boost = 1.0 + pow(u_flare_intensity, 2.0) * 4.0;
            float corona = exp(-dist * (2.5 / boost)) * f;
            // Soft tone-map: brightens with intensity but saturates at 1.0.
            corona = 1.0 - exp(-corona * (1.0 + u_flare_intensity));

            vec3 colorDark = vec3(0.0, 0.0, 0.0);
            vec3 colorRed = u_core_temp;
            vec3 colorYellow = mix(colorRed, vec3(1.0, 0.8, 0.2), 0.5);
            vec3 colorWhite = vec3(1.0, 0.9, 0.8);

            vec3 finalColor = mix(colorDark, colorRed, clamp(corona * 1.5, 0.0, 1.0));
            finalColor = mix(finalColor, colorYellow, clamp(pow(corona, 2.0) * 2.0, 0.0, 1.0));
            finalColor = mix(finalColor, colorWhite, clamp(sunBody + pow(corona, 5.0), 0.0, 1.0));
```

At slider = 100 the falloff constant drops from 2.5 to 0.5 (5× reach — flares extend far into
space); at slider = 1 it is ~2.5 (tight corona). Colors stay bounded at every value.

---

## Phase 5 — Generic wallpaper settings contract (future themes)

### 5.1 Document the contract in `/Users/tdaeche/Novaframe-Wallpapers/wallpaper_workflow.md`
(append a section, keep existing content):

```markdown
## Engine ↔ Wallpaper settings contract (v1)

The engine posts `message` events into the theme iframe. A theme MUST handle:

- `{ type: 'novaframe-settings', settings: {...} }`
  `settings` is a PARTIAL object: any subset of the ids declared in the theme's
  `engine_manifest.json` `custom_settings`. It is sent (a) once on iframe load with
  manifest defaults merged with saved user values, and (b) live on every panel change.
  Values arrive as: range → number (may arrive as string after reload; coerce with
  Number()), checkbox → boolean, color → '#rrggbb' string, text → string.
  Handlers must be idempotent — the engine may resend unchanged values.

- `{ type: 'novaframe-pointer', x, y, nx, ny }` — nx/ny are 0..1 normalized to the
  engine window. Map with nx * window.innerWidth / ny * window.innerHeight. Never
  hardcode a resolution.

- `{ type: 'novaframe-occlusion', occluded: bool }` — pause render loops when true.

Asset rules: use RELATIVE paths for everything (`./img.jpg`, `fetch('./shaders/x.frag')`).
The engine serves the theme directory over its `theme://` protocol, so relative URLs work
in-engine and in a plain browser during development. Never use absolute filesystem paths
or `asset://` URLs inside a theme.

Sizing rules: size canvases from `window.innerWidth/innerHeight`, listen for `resize`.
No fixed-resolution CSS, no `transform: scale()` letterbox hacks.
```

### 5.2 Update the starter template `/Users/tdaeche/NovaframeEngine/themes/_TEMPLATE/index.html`
(and mirror to `/Users/tdaeche/Novaframe-Wallpapers/Templates` if a copy exists there): make sure
it contains a reference message listener implementing the contract above:

```js
window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'novaframe-settings') {
        // Merge partial patch into local config; coerce types defensively.
        Object.assign(config, data.settings);
        applySettings(); // theme-specific: update uniforms / redraw
    } else if (data.type === 'novaframe-pointer') {
        pointer.x = data.nx * window.innerWidth;
        pointer.y = data.ny * window.innerHeight;
    } else if (data.type === 'novaframe-occlusion') {
        setPaused(data.occluded === true);
    }
});
window.parent.postMessage({ type: 'novaframe-ready' }, '*');
```

(Adapt names to whatever structure the template already has — the required behavior is: handle
all three message types, treat settings as a partial patch, no hardcoded resolutions.)

---

## Phase 6 — Deploy + rebuild distributables

### 6.1 Sync the fixed sources into the installed AppData themes (the copies currently
installed are STALE — they predate every recent fix; this alone caused several "fix didn't
work" cycles). Keep the existing installed directory names (saved `activeTheme` paths point
at them):

```bash
rsync -av --delete \
  "/Users/tdaeche/Novaframe-Wallpapers/Published/mercator-classic/" \
  "$HOME/Library/Application Support/com.novaframe.desktop.wallpaper/themes/mercator-classic/"

rsync -av --delete \
  "/Users/tdaeche/Novaframe-Wallpapers/Published/ignis-solar-flares/" \
  "$HOME/Library/Application Support/com.novaframe.desktop.wallpaper/themes/Ignis_ Interactive Solar Wind/"
```

Note: `--delete` removes stale files (e.g. the leftover `ignis_solar_winds.wpk`). The Ignis
target keeps its installed name "Ignis_ Interactive Solar Wind".

### 6.2 Rebuild the marketplace zip for Mercator — the current
`/Users/tdaeche/NovaframeEngine/themes/geochron_classic_mercator.zip` is BROKEN: it contains no
`index.html` and no `world-city-lights.png`, and carries an old `manifest.json`. Rebuild from
Published (flat archive, engine strips one top-level dir if present so flat is safest):

```bash
cd /Users/tdaeche/Novaframe-Wallpapers/Published/mercator-classic
zip -r /tmp/mercator-classic.zip . -x '.DS_Store' -x '*/.DS_Store'
```

Then upload/replace wherever the marketplace backend stores wallpaper zips (Supabase storage —
out of scope for this plan; flag to the user if credentials are needed).

---

## Acceptance checklist (run the engine with `npm run tauri dev` from /Users/tdaeche/NovaframeEngine)

1. **Rust console shows no `[theme://] DENIED`** lines during theme load.
2. **Mercator renders**: world map visible (not solid blue), day/night terminator overlays it,
   city-light dots on the night side, three default pins with labels, timeline bar at top.
3. **Mercator live settings**: open the settings panel → Shadow Opacity slider changes the
   terminator darkness *immediately, without reloading*. Show Analemma toggle hides/shows the
   figure-8 immediately.
4. **Mercator pins UI**: "Pinned Locations" list appears in the panel (it never rendered
   before). Adding a pin (e.g. Sydney, -33.8688, 151.2093) makes it appear on the map within
   a second; removing one deletes it from the map.
5. **Ignis fills the screen** with no black bars and no cropping at any window size (test by
   changing display resolution or with a second monitor if available).
6. **Ignis live settings**: Flare Intensity slider 1→100 makes flares extend dramatically
   without the screen becoming a solid yellow blob; Core Temperature color picker retints the
   sun live; Flare Speed changes motion live.
7. **Ignis pointer**: moving the mouse across the desktop distorts plasma at the cursor
   position (not offset/scaled away from it).
8. **Regression**: switching themes in the dropdown still swaps wallpapers; restart the app —
   the last theme and its settings persist and are applied on first paint.
9. **No JS errors**: the Rust console (`log_from_js` forwards `window.onerror`) shows no
   ReferenceErrors during load, theme switch, or settings changes.

---

## Appendix: root causes (from the audit, for context)

1. **Stale installs**: AppData theme copies predated all recent source fixes (old Ignis 4K
   `scaleToFit` build; Mercator without `onerror`/shader-fallback code). Fixed by 6.1.
2. **Relative assets broken in-engine**: Tauri v2 `convertFileSrc` percent-encodes the whole
   path into a single URL segment → relative subresource URLs resolve to nonexistent scope-
   blocked paths. Scope whitelisting cannot fix it. Fixed by Phase 1 (`theme://`).
3. **Live settings never delivered**: sliders run in the settings window where
   `ThemeManager.currentIframe` is null; the main window never relayed `config-changed` to the
   iframe. Fixed by Phase 2.
4. **Mercator ReferenceError**: nine undeclared WebGL globals; first `drawFrame` threw and
   killed the rAF loop. Fixed by 3.1.
5. **Pins UI dead**: `manifestCache[..].name` vs stored key `label`. Fixed by 2.6. Wallpaper
   also ignored `pinned_locations` messages. Fixed by 3.2.
6. **Ignis blowout**: unclamped GLSL `mix()` weights extrapolate past endpoints. Fixed by 4.4.
7. **Ignis letterbox/crop**: `!important` 4K CSS overrode `renderer.setSize` inline styles;
   pointer handler mapped into 4K space. Fixed by 4.1–4.3.
8. **Latent crashes**: `occlusion-change` handler used undeclared legacy loop vars;
   `applyThemeToDOM` referenced a deleted global. Fixed by 2.8.
