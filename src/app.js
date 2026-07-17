// Highest theme manifest_version this engine build knows how to render. A theme
// may set `manifest_version` in its manifest; if it declares a higher version
// than this, the engine can't guarantee correct rendering and skips it (prompting
// an engine update) rather than rendering it wrong. Manifests without the field
// are treated as v1 (the current format). Bump this whenever the manifest schema
// gains a breaking change.
const ENGINE_MANIFEST_VERSION = 1;

// True if a manifest requires a newer engine than this build supports.
function manifestNeedsNewerEngine(manifest) {
    const v = Number(manifest?.manifest_version);
    return Number.isFinite(v) && v > ENGINE_MANIFEST_VERSION;
}

// Helper to resolve the themes directory path in AppData dynamically
async function getThemesDir() {
    try {
        let themesDir = await window.__TAURI__.core.invoke('get_themes_dir');
        // Ensure no trailing slash
        if (themesDir.endsWith('/') || themesDir.endsWith('\\')) {
            themesDir = themesDir.slice(0, -1);
        }
        return themesDir;
    } catch (e) {
        console.error("[Novaframe] Failed to get appDataDir from Rust, falling back to local themes:", e);
        return 'themes';
    }
}

// Build a theme:// URL from an absolute filesystem path. Unlike Tauri's
// convertFileSrc (which percent-encodes the WHOLE path into one URL segment,
// breaking every relative subresource inside the theme), this keeps real
// directory segments so `./img.jpg` and `fetch('./shaders/x.frag')` resolve.
function toThemeUrl(fsPath) {
    // Normalize Windows backslashes to '/' before segmenting. Rust's
    // app_data_dir returns paths like C:\Users\..\themes\Name, and JS also
    // concatenates candidates with '/', producing mixed separators. Without
    // this, the entire theme dir collapses into one percent-encoded segment
    // (backslashes → %5C) instead of real path segments — which breaks every
    // relative subresource inside a theme (`./img.jpg`, `fetch('./x.frag')`)
    // on Windows. Encoding each real segment keeps those relative URLs resolving.
    const normalized = fsPath.replace(/\\/g, '/');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    const lead = encoded.startsWith('/') ? '' : '/';
    // Windows/Android webviews expose custom schemes as http://<scheme>.localhost
    return IS_WINDOWS_WEBVIEW
        ? `http://theme.localhost${lead}${encoded}`
        : `theme://localhost${lead}${encoded}`;
}

// Detect the host platform once at module load rather than per-call. The custom
// scheme host differs by webview (WebView2 on Windows exposes theme://localhost
// as http://theme.localhost), so this drives every theme URL. Kept as a UA check
// (reliable on WebView2/WKWebView) to avoid pulling the async os plugin into the
// synchronous toThemeUrl hot path.
const IS_WINDOWS_WEBVIEW = typeof navigator !== 'undefined'
    && /Windows/i.test(navigator.userAgent || '');

// Keep the docked settings panel expanded while a native <select> has its OS
// popup open. The popup renders outside the panel window's own frame (often
// above it, since the panel is docked to the screen edge) — without this, the
// Rust hover-poll loop sees the cursor leave the window bounds mid-selection
// and collapses the panel, yanking it out from under the open dropdown.
function setPanelLocked(locked) {
    if (window.__TAURI__?.core?.invoke) {
        window.__TAURI__.core.invoke('set_settings_panel_locked', { locked }).catch(() => {});
    }
}

// One delegated lock for EVERY control whose native popup can extend beyond
// the panel window (selects, color pickers) — including controls created
// dynamically for theme custom_settings, which per-element listeners missed.
// Lock when the popup could open; unlock only once a value is committed
// (change) or focus verifiably stays inside the page (the macOS color panel
// is a separate OS window, so its opening fires blur/focusout — unlocking
// there would collapse the panel under the open picker).
const POPUP_CONTROLS = 'select, input[type="color"]';
function initPanelLockDelegation() {
    const matches = (t) => t instanceof Element && t.closest(POPUP_CONTROLS);
    document.addEventListener('mousedown', (e) => { if (matches(e.target)) setPanelLocked(true); }, true);
    document.addEventListener('focusin',  (e) => { if (matches(e.target)) setPanelLocked(true); });
    document.addEventListener('change',   (e) => { if (matches(e.target)) setPanelLocked(false); });
    document.addEventListener('focusout', (e) => {
        if (!matches(e.target)) return;
        // Defer one tick: if the document still has focus, the popup closed
        // (or never opened) and focus merely moved within the panel — safe to
        // unlock. If an OS-level picker window took focus, keep the lock.
        setTimeout(() => { if (document.hasFocus()) setPanelLocked(false); }, 0);
    });
    // Focus returning to the webview with no popup control active means any
    // OS picker window closed without committing (e.g. color panel dismissed
    // with no change event) — release the lock so the panel can collapse.
    window.addEventListener('focus', () => {
        const el = document.activeElement;
        if (!(el instanceof Element) || !el.closest(POPUP_CONTROLS)) setPanelLocked(false);
    });
}

// Check and provision default theme inside system AppData on startup
async function verifyAndProvisionAppData() {
    const tauriFs = window.__TAURI_PLUGIN_FS__ || (window.__TAURI__ && window.__TAURI__.fs);
    if (!tauriFs) return;

    try {
        const themesDir = await getThemesDir();

        // ── Fix #4: Clean up empty mercator-classic folder ────────────────────
        // If mercator-classic was created empty (from a prior failed provision), remove it.
        // An empty folder appears in the dropdown but has no manifest → always falls back to Internal-Legacy.
        const mercatorPath = `${themesDir}/mercator-classic`;
        try {
            const files = await tauriFs.readDir(mercatorPath);
            if (!files || files.length === 0) {
                console.log("[Novaframe] Removing empty mercator-classic folder from AppData...");
                await tauriFs.remove(mercatorPath, { recursive: true });
            }
        } catch (e) {
            // Folder doesn't exist yet — that's fine
        }

    } catch (err) {
        console.error("[Novaframe] Failed to verify AppData:", err);
    }
}

// Set ignore cursor events safely by checking label boundaries
async function setIgnoreCursor(ignore) {
    if (window.__TAURI__ && window.__TAURI__.window) {
        try {
            const win = window.__TAURI__.window.getCurrentWindow();
            if (win.label === 'main') {
                await win.setIgnoreCursorEvents(ignore);
            }
        } catch (e) {
            console.error("[Novaframe] Failed to set ignore cursor events:", e);
        }
    }
}

function initDualWindowSystem() {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode') || 'main';

    if (mode === 'main') {
        document.getElementById('settingsPanel').style.display = 'none';

        setIgnoreCursor(true);

        ConfigManager.init().then(async () => {
            const savedTheme = await ConfigManager.getTheme();
            if (savedTheme) {
                ThemeManager.loadTheme(savedTheme);
            } else {
                ThemeManager.loadTheme();
            }
        }).catch(err => console.error(err));
    } else if (mode === 'settings') {
        // CONTROLS MODE: full-window settings panel (300x650 dock, docked right by Rust).
        document.getElementById('container').style.display = 'none';
        document.body.style.backgroundColor = 'transparent';
        document.documentElement.style.backgroundColor = 'transparent';
        // Apply current theme scope synchronously so the panel starts in the correct mode.
        applyThemeScope();
    }
}

// ── Theme Scope Visibility ─────────────────────────────────────────────────
// Sets <html data-theme-scope="legacy|dynamic"> so #legacySection hide/show is
// driven entirely by CSS, no inline styles.  Call this whenever a theme loads,
// falls back, or is set via UI.
//
//   legacy  = Novaframe world-map + sun (Internal-Legacy)
//   dynamic = any external-html / external-canvas theme like Ignis
function applyThemeScope() {
    const mode = ThemeManager?.currentManifest?.render_mode === 'internal-legacy'
        || !ThemeManager?.currentManifest
        ? 'legacy'
        : 'dynamic';
    document.documentElement.dataset.themeScope = mode;
}



// ── Theme Manager ──────────────────────────────────────────────────────────
// Loads one of three render modes per theme:
//   - "internal-legacy"  : legacy world-map canvas + sun (default if absent)
//   - "external-html"    : iframe mounted at full viewport, hides canvases
//   - "external-canvas"  : (future) iframe that paints its own canvas
//
// Each theme lives on disk as: <themesDir>/<theme_id>/ + engine_manifest.json
// The manifest tells us what the entry file is and which render mode to use.

const LEGACY_THEME_DEFAULTS = {
    mapImageSrc: 'assets/world-map-mercator.jpg',
    bgColor: '#0f141d',
    timelineHeight: 40,
    timelineBgColor: 'rgba(0, 5, 20, 0.78)',
    timelineTickColor: 'rgba(160, 180, 255, 0.45)',
    timelineTextColor: '#e0e8ff',
    shadowColorHex: '0, 8, 24',
    sunMarkerColor: '#ffd700',
    sunGlowColor: '#ffaa00',
    gridColor: 'rgba(255, 255, 255, 0.06)',
    equatorColor: 'rgba(255, 215, 0, 0.25)',
    pinColor: '#00a2ff',
    pinGlowColor: 'rgba(0, 162, 255, 0.5)',
    pinTextColor: 'rgba(224, 232, 255, 0.75)',
    shadow_color: '#000000',
    shadow_opacity: 0.5,
    show_analemma: true,
    use_gpu_shader: true
};

const ThemeManager = {
    currentTheme: { ...LEGACY_THEME_DEFAULTS },
    currentManifest: null,   // raw parsed engine_manifest.json of active theme (or null)
    currentIframe: null,     // <iframe> DOM node for external-html mode, else null
    currentThemePath: null,  // absolute path string of active theme, or null for legacy
    manifestCache: {},       // in-memory cache for render_mode mapped by themePath

    // Read the theme's manifest from disk. Throws on read failure.
    async readManifest(themePath) {
        for (const candidate of ['engine_manifest.json', 'manifest.json']) {
            const uri = toThemeUrl(`${themePath}/${candidate}`);
            const res = await fetch(uri);
            if (res.ok) {
                const m = await res.json();
                return { manifest: m, manifestFile: candidate };
            }
        }
        throw new Error(`Manifest not found under ${themePath}`);
    },

    async loadTheme(themePath, forceReload = false) {
        if (!themePath) {
            // No-op if we're already showing a theme
            if (this.currentThemePath === null && !this.currentManifest) return;
            // Unmount if empty theme passed
            this.unmountIframe();
            this.currentThemePath = null;
            this.currentManifest = null;
            setWelcomeVisible(true);
            return;
        }

        let parsed;
        try {
            parsed = await this.readManifest(themePath);
        } catch (err) {
            console.error("[Novaframe] Failed to read theme manifest:", err);
            return;
        }

        const manifest = parsed.manifest;

        // Forward-compat guard: refuse to render a theme built for a newer
        // manifest schema than this engine understands. Better a clear no-op +
        // console note than a silently broken render.
        if (manifestNeedsNewerEngine(manifest)) {
            console.warn(`[Novaframe] Not loading "${manifest.name || themePath}": manifest_version ${manifest.manifest_version} needs a newer engine (supports ${ENGINE_MANIFEST_VERSION}). Update Novaframe.`);
            return;
        }

        // Idempotency guard: skip the full render path if the theme is already
        // active (manifest + path match). Prevents double-mounts when an echo
        // event re-enters this function before the first call has finished.
        // Note: requires an already-mounted iframe — a matching path with no
        // mount (e.g. currentThemePath pre-set by a config writer) must still
        // render. forceReload bypasses it entirely (refresh button).
        if (!forceReload && this.currentIframe
            && themePath === this.currentThemePath
            && manifest.theme_id === this.currentManifest?.theme_id) {
            return;
        }

        const renderMode = manifest.render_mode || 'external-html';

        this.currentManifest = manifest;
        this.currentThemePath = themePath;

        if (renderMode === 'external-html' || renderMode === 'external-canvas') {
            await this.loadExternalHtml(themePath, manifest, renderMode);
        } else {
            console.error(`[Novaframe] Unknown render_mode "${renderMode}", falling back to external-html`);
            await this.loadExternalHtml(themePath, manifest, 'external-html');
        }

        applyThemeScope();
        await ConfigManager.setTheme(themePath);
    },


    async loadExternalHtml(themePath, manifest) {
        const entry = manifest.entry || 'index.html';
        const fileSrc = toThemeUrl(`${themePath}/${entry}`);
        const transparent = manifest.transparent !== false; // default true
        this.mountIframe(fileSrc, transparent, themePath);
    },

    mountIframe(src, transparent, themePath) {
        this.unmountIframe();
        setWelcomeVisible(false);
        const container = document.getElementById('container');
        if (!container) return;
        const iframe = document.createElement('iframe');
        iframe.id = 'themeFrame';
        iframe.src = src;
        iframe.setAttribute('allow', 'autoplay; fullscreen');
        iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-forms');
        Object.assign(iframe.style, {
            position: 'absolute',
            top: '0', left: '0',
            width: '100%', height: '100%',
            border: '0',
            backgroundColor: transparent ? 'transparent' : '#000',
            zIndex: '5',
            pointerEvents: 'auto'
        });

        // Helper to push the host viewport descriptor to the iframe. The theme
        // listens for these messages to size its canvas / shaders correctly so
        // there are no letterbox black bars regardless of screen resolution.
        const postViewport = (msgType = 'novaframe-theme-ready') => {
            try {
                const cw = iframe.contentWindow;
                if (!cw) return;
                const w = cw.innerWidth  || container.clientWidth;
                const h = cw.innerHeight || container.clientHeight;
                const dpr = cw.devicePixelRatio || window.devicePixelRatio || 1;
                cw.postMessage({
                    type: msgType,
                    transparent,
                    width: w,
                    height: h,
                    dpr
                }, '*');
            } catch (e) {}
        };

        iframe.addEventListener('load', () => {
            postViewport('novaframe-theme-ready');
            // Some themes read sizes before their RAFs settle — push once more
            // after the next paint to be safe.
            requestAnimationFrame(() => postViewport('novaframe-theme-ready'));

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
        });

        // The settings-panel slide animation resizes the main window. We don't
        // currently do that, but keep the listener in case future layout
        // changes cause viewport shifts.
        const resizeObserver = new ResizeObserver(() => postViewport('novaframe-theme-resize'));
        resizeObserver.observe(iframe);

        // Save the postViewport closure for cleanup on unmount.
        iframe._novaframeResizeCleanup = () => resizeObserver.disconnect();

        container.appendChild(iframe);
        this.currentIframe = iframe;
    },

    unmountIframe() {
        if (this.currentIframe) {
            try { this.currentIframe._novaframeResizeCleanup?.(); } catch (_) {}
            if (this.currentIframe.parentNode) {
                this.currentIframe.parentNode.removeChild(this.currentIframe);
            }
        }
        this.currentIframe = null;
        _lastRelayedSettings = null;
    }
};

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



// ── Mouse passthrough to iframe (for interactive themes like Ignis) ────────
window.addEventListener('mousemove', (e) => {
    const iframe = ThemeManager?.currentIframe;
    if (!iframe?.contentWindow) return;
    try {
        iframe.contentWindow.postMessage({
            type: 'novaframe-pointer',
            x: e.clientX, y: e.clientY,
            // Normalized 0-1 for theme authors
            nx: e.clientX / window.innerWidth,
            ny: e.clientY / window.innerHeight
        }, '*');
    } catch (_) {}
});

// ── Constants & Configuration ──────────────────────────────────────────────

// ── State Persistence Configurations (ConfigManager) ───────────────────────
const DEFAULT_CONFIG = {
    shadowOpacity: 55,
    showAnalemma: true,
    pinnedLocations: [
        { name: "London", lat: 51.5074, lon: -0.1278 },
        { name: "New York", lat: 40.7128, lon: -74.0060 },
        { name: "Hong Kong", lat: 22.3193, lon: 114.1694 }
    ],
    theme_settings: {}
};

let config = DEFAULT_CONFIG;

const ConfigManager = {
    store: null,
    async init() {
        const tauriStore = window.__TAURI_PLUGIN_STORE__ || (window.__TAURI__ && window.__TAURI__.store);
        if (!tauriStore) {
            console.warn("[ConfigManager] Native store not available, using localStorage");
            config = JSON.parse(localStorage.getItem('novaframe_config')) || DEFAULT_CONFIG;
            return;
        }
        
        try {
            if (tauriStore.load) {
                this.store = await tauriStore.load("novaframe_config.json");
            } else if (tauriStore.Store && tauriStore.Store.load) {
                this.store = await tauriStore.Store.load("novaframe_config.json");
            } else {
                this.store = new tauriStore.Store("novaframe_config.json");
            }
            
            // Migration Bridge
            const hasConfig = await this.store.has('novaframe_config');
            if (!hasConfig) {
                const oldConfig = localStorage.getItem('novaframe_config');
                if (oldConfig) {
                    console.log("[ConfigManager] Migrating localStorage to native JSON store...");
                    await this.store.set('novaframe_config', JSON.parse(oldConfig));
                    localStorage.removeItem('novaframe_config');
                } else {
                    await this.store.set('novaframe_config', DEFAULT_CONFIG);
                }
                
                const oldTheme = localStorage.getItem('activeTheme');
                if (oldTheme) {
                    await this.store.set('activeTheme', oldTheme);
                    localStorage.removeItem('activeTheme');
                }
                
                await this.store.save();
            }
            
            config = (await this.store.get('novaframe_config')) || DEFAULT_CONFIG;

            // Only the main window needs to poll the store for cross-window
            // config/theme changes. The settings window wrote the change — it
            // already knows. Both windows polling causes the theme to flicker as
            // each poll detects "changed" and triggers another loadTheme.
            const isMainWindow = window.location.search.includes('mode=main');
            if (isMainWindow) {
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
                        // Don't pre-set currentThemePath here — loadTheme's
                        // idempotency guard would then skip the actual render.
                        ThemeManager.loadTheme(normLatest);
                    }
                }, 1000);
            }

        } catch (e) {
            console.error("[ConfigManager] Native store failed:", e);
            config = JSON.parse(localStorage.getItem('novaframe_config')) || DEFAULT_CONFIG;
        }
    },
    async saveConfig() {
        if (this.store) {
            await this.store.set('novaframe_config', config);
            await this.store.save();
        }
        localStorage.setItem('novaframe_config', JSON.stringify(config));

        if (window.__TAURI__ && window.__TAURI__.event) {
            try {
                await window.__TAURI__.event.emit('config-changed', config);
            } catch (e) {
                console.error("[Novaframe] Config emit failed:", e);
            }
        }
    },
    async getTheme() {
        // Prefer the persistent native store, but fall back to localStorage if
        // the store hasn't been seeded yet (e.g. on the very first reload after
        // a fresh install — tauri-plugin-store save() can return before the
        // JSON file is flushed, so reading immediately after window.location.reload()
        // can return undefined). localStorage is sync and survives reload, so it's
        // a reliable source of truth in that narrow window.
        if (this.store) {
            const fromStore = await this.store.get('activeTheme');
            if (fromStore) return fromStore;
        }
        return localStorage.getItem('activeTheme');
    },
    async setTheme(themePath) {
        // Normalize empty string to null so we have one canonical "no theme" value.
        const next = themePath || null;

        // Skip writes + emits when the value hasn't actually changed.
        // Without this, every theme-changed listener that calls setTheme in
        // response to its own broadcast creates a feedback loop that flickers
        // the canvas and toggles #legacySection in the settings panel.
        if (next === ThemeManager.currentThemePath) return;
        ThemeManager.currentThemePath = next;

        if (this.store) {
            if (next) await this.store.set('activeTheme', next);
            else await this.store.delete('activeTheme');
            await this.store.save();
        }
        if (next) {
            localStorage.setItem('activeTheme', next);
        } else {
            localStorage.removeItem('activeTheme');
        }

        if (window.__TAURI__ && window.__TAURI__.event) {
            try {
                // Broadcast to all windows. The listener now dedupes against
                // currentThemePath so echoes don't trigger re-renders.
                await window.__TAURI__.event.emit('theme-changed', next);
            } catch (e) {
                console.error("[Novaframe] Theme emit failed:", e);
            }
        }
    }
};

// ── Cities Database for Autocomplete ────────────────────────────────────────
const citiesDb = [
    { name: "London", lat: 51.5074, lon: -0.1278 },
    { name: "New York", lat: 40.7128, lon: -74.0060 },
    { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
    { name: "Paris", lat: 48.8566, lon: 2.3522 },
    { name: "Sydney", lat: -33.8688, lon: 151.2093 },
    { name: "Cairo", lat: 30.0444, lon: 31.2357 },
    { name: "Mumbai", lat: 19.0760, lon: 72.8777 },
    { name: "São Paulo", lat: -23.5505, lon: -46.6333 },
    { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
    { name: "Chicago", lat: 41.8781, lon: -87.6298 },
    { name: "Houston", lat: 29.7604, lon: -95.3698 },
    { name: "Phoenix", lat: 33.4484, lon: -112.0740 },
    { name: "Philadelphia", lat: 39.9526, lon: -75.1652 },
    { name: "San Antonio", lat: 29.4241, lon: -98.4936 },
    { name: "San Diego", lat: 32.7157, lon: -117.1611 },
    { name: "Dallas", lat: 32.7767, lon: -96.7970 },
    { name: "San Jose", lat: 37.3382, lon: -121.8863 },
    { name: "Hong Kong", lat: 22.3193, lon: 114.1694 },
    { name: "Singapore", lat: 1.3521, lon: 103.8198 },
    { name: "Berlin", lat: 52.5200, lon: 13.4050 },
    { name: "Rome", lat: 41.9028, lon: 12.4964 },
    { name: "Madrid", lat: 40.4168, lon: -3.7038 },
    { name: "Toronto", lat: 43.6532, lon: -79.3832 },
    { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
    { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 },
    { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
    { name: "Johannesburg", lat: -26.2041, lon: 28.0473 },
    { name: "Nairobi", lat: -1.2921, lon: 36.8219 },
    { name: "Dubai", lat: 25.2048, lon: 55.2708 },
    { name: "Moscow", lat: 55.7558, lon: 37.6173 },
    { name: "Beijing", lat: 39.9042, lon: 116.4074 },
    { name: "Seoul", lat: 37.5665, lon: 126.9780 },
    { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
    { name: "Jakarta", lat: -6.2088, lon: 106.8456 },
    { name: "Manila", lat: 14.5995, lon: 120.9842 },
    { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
    { name: "Auckland", lat: -36.8485, lon: 174.7633 },
    { name: "Honolulu", lat: 21.3069, lon: -157.8583 },
    { name: "Reykjavik", lat: 64.1466, lon: -21.9426 }
];

// ── Settings Synchronous Updater ─────────────────────────────────────────
function updateSettingsScope(themePath) {
    const selector = document.getElementById('themeSelector');
    if (selector) selector.value = themePath || '';
    
    let mode = 'internal-legacy'; // fallback
    if (themePath && ThemeManager.manifestCache[themePath]) {
        mode = ThemeManager.manifestCache[themePath].mode;
    }
    
    const scope = (mode === 'internal-legacy') ? 'legacy' : 'dynamic';
    const panel = document.getElementById('settingsPanel');
    if (panel) panel.dataset.themeScope = scope;
    document.documentElement.dataset.themeScope = scope;

    const customSettingsSection = document.getElementById('customSettingsSection');
    if (customSettingsSection) {
        customSettingsSection.innerHTML = ''; // clear previous
        
        let customSettings = null;
        if (themePath && ThemeManager.manifestCache[themePath]) {
            customSettings = ThemeManager.manifestCache[themePath].custom_settings;
        }

        if (customSettings && Array.isArray(customSettings)) {
            // Theme specific settings exist, ensure we have an object to store them
            if (!config.theme_settings) {
                config.theme_settings = {};
            }
            if (!config.theme_settings[themePath]) {
                config.theme_settings[themePath] = {};
            }

            customSettingsSection.appendChild(document.createElement('hr'));
            const header = document.createElement('h4');
            header.textContent = 'Theme Settings';
            customSettingsSection.appendChild(header);

            customSettings.forEach(setting => {
                const group = document.createElement('div');
                group.className = 'control-group';

                const label = document.createElement('label');
                label.textContent = setting.label || setting.id;
                label.htmlFor = `custom_setting_${setting.id}`;
                group.appendChild(label);

                // Dropdown settings: the engine builds an <input> for every other
                // type, but type:"select" needs a real <select>/<option> tree.
                if (setting.type === 'select') {
                    const select = document.createElement('select');
                    select.id = `custom_setting_${setting.id}`;
                    (setting.options || []).forEach(opt => {
                        const o = document.createElement('option');
                        o.value = opt.value;
                        o.textContent = opt.label ?? opt.value;
                        select.appendChild(o);
                    });

                    const savedVal = config.theme_settings[themePath][setting.id];
                    select.value = savedVal !== undefined ? savedVal : (setting.default ?? '');
                    if (savedVal === undefined) {
                        config.theme_settings[themePath][setting.id] = select.value;
                    }

                    select.addEventListener('change', (e) => {
                        const val = e.target.value;
                        config.theme_settings[themePath][setting.id] = val;
                        ConfigManager.saveConfig();

                        if (ThemeManager.currentIframe?.contentWindow) {
                            ThemeManager.currentIframe.contentWindow.postMessage({
                                type: 'novaframe-settings',
                                settings: { [setting.id]: val }
                            }, '*');
                        }
                    });

                    group.appendChild(select);
                    customSettingsSection.appendChild(group);
                    return; // skip the <input> path below
                }

                // Button: fire a one-shot action message, nothing stored in config
                if (setting.type === 'button') {
                    label.textContent = ''; // button has its own text; suppress the label
                    const btn = document.createElement('button');
                    btn.id = `custom_setting_${setting.id}`;
                    btn.textContent = setting.label || setting.id;
                    btn.className = 'custom-action-btn';
                    btn.addEventListener('click', () => {
                        if (ThemeManager.currentIframe?.contentWindow) {
                            ThemeManager.currentIframe.contentWindow.postMessage({
                                type: 'novaframe-settings',
                                settings: { [setting.id]: true }
                            }, '*');
                        }
                    });
                    group.appendChild(btn);
                    customSettingsSection.appendChild(group);
                    return; // skip the <input> path below
                }

                const input = document.createElement('input');
                input.id = `custom_setting_${setting.id}`;
                input.type = setting.type || 'text';
                
                if (setting.type === 'checkbox') {
                    group.classList.add('control-row');
                    const savedVal = config.theme_settings[themePath][setting.id];
                    input.checked = savedVal !== undefined ? savedVal : (setting.default ?? false);

                    if (savedVal === undefined) {
                        config.theme_settings[themePath][setting.id] = input.checked;
                    }

                    input.addEventListener('change', (e) => {
                        const val = e.target.checked;
                        config.theme_settings[themePath][setting.id] = val;
                        ConfigManager.saveConfig();

                        if (ThemeManager.currentIframe?.contentWindow) {
                            ThemeManager.currentIframe.contentWindow.postMessage({
                                type: 'novaframe-settings',
                                settings: { [setting.id]: val }
                            }, '*');
                        }
                    });
                } else {
                    if (setting.type === 'range') {
                        if (setting.min !== undefined) input.min = setting.min;
                        if (setting.max !== undefined) input.max = setting.max;
                        if (setting.step !== undefined) input.step = setting.step;
                    }

                    // Load saved value or default
                    const savedVal = config.theme_settings[themePath][setting.id];
                    input.value = savedVal !== undefined ? savedVal : (setting.default ?? '');

                    // Ensure default is applied immediately if no save exists
                    if (savedVal === undefined) {
                        config.theme_settings[themePath][setting.id] = input.value;
                    }

                    input.addEventListener('input', (e) => {
                        const val = setting.type === 'range' ? parseFloat(e.target.value) : e.target.value;
                        config.theme_settings[themePath][setting.id] = val;
                        ConfigManager.saveConfig();

                        // Live broadcast
                        if (ThemeManager.currentIframe?.contentWindow) {
                            ThemeManager.currentIframe.contentWindow.postMessage({
                                type: 'novaframe-settings',
                                settings: { [setting.id]: val }
                            }, '*');
                        }
                    });
                }

                // Panel locking for selects/color pickers is handled by the
                // delegated listeners in initPanelLockDelegation().

                group.appendChild(input);
                customSettingsSection.appendChild(group);
            });

        }
    }
}

// ── Bind UI Event Listeners ───────────────────────────────────────────────
async function initSettingsUI() {
    // 1. Scan and cache all available themes
    await scanThemes();
    
    // 2. Fetch active theme from store
    const activeTheme = await ConfigManager.getTheme();
    console.log("[Novaframe] Active theme from config:", activeTheme);
    const selector = document.getElementById('themeSelector');
    if (activeTheme && selector) {
        selector.value = activeTheme;
    }
    
    // 3. Synchronously apply UI layout scoping
    updateSettingsScope(activeTheme);

    // 4. Wire the exit button — fully quits the engine so the user never needs
    // Task Manager. The in-panel confirm keeps the panel locked open while up
    // (see modalInPanel) so the hover-poll loop can't collapse it mid-dialog.
    const quitBtn = document.getElementById('quitEngineBtn');

    if (quitBtn) {
        quitBtn.addEventListener('click', async () => {
            // Native confirm() centers in the ~360px settings window, pushing its
            // OK button off-screen. Use an in-panel modal that fits the width.
            const ok = await confirmInPanel(
                'Close Novaframe Engine? Your wallpaper will stop until you reopen it.',
                'Close Engine'
            );
            if (!ok) return;
            try {
                await window.__TAURI__.core.invoke('quit_engine');
            } catch (err) {
                console.error('[Novaframe] quit_engine invoke failed, falling back to process.exit:', err);
                const proc = window.__TAURI_PLUGIN_PROCESS__ || (window.__TAURI__ && window.__TAURI__.process);
                if (proc && proc.exit) {
                    await proc.exit(0);
                }
            }
        });
    }

    // 5. Wire the "Launch on startup" toggle — reflects the real OS state and
    // writes changes through the Rust set_autostart command.
    const autostartToggle = document.getElementById('autostartToggle');
    if (autostartToggle && window.__TAURI__?.core?.invoke) {
        try {
            autostartToggle.checked = await window.__TAURI__.core.invoke('get_autostart');
        } catch (err) {
            console.error('[Novaframe] get_autostart failed:', err);
        }
        autostartToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            try {
                await window.__TAURI__.core.invoke('set_autostart', { enabled });
            } catch (err) {
                console.error('[Novaframe] set_autostart failed:', err);
                // Revert the UI if the OS call failed.
                e.target.checked = !enabled;
            }
        });
    }
}

// ── Dynamic Theme Scanner (Module 1) ───────────────────────────────────────
async function scanThemes() {
    const selector = document.getElementById('themeSelector');
    if (!selector) return;
    
    selector.innerHTML = '<option value="" disabled selected>Select Wallpaper</option>';
    
    const tauriFs = window.__TAURI_PLUGIN_FS__ || (window.__TAURI__ && window.__TAURI__.fs);
    if (!tauriFs) return;
    
    try {
        const themesDir = await getThemesDir();
        console.log("[Novaframe] Scanning themes directory:", themesDir);
        const entries = await tauriFs.readDir(themesDir);
        console.log("[Novaframe] Found entries:", entries);
        
        // Read all manifests in parallel — sequential awaits made panel-open
        // latency scale linearly with installed theme count.
        const themeDirs = entries.filter(entry => {
            const isDir = entry.isDirectory === true || Array.isArray(entry.children);
            // Skip dotfolders — e.g. the transient `.staging-<id>` dir the Rust
            // installer uses mid-install. They aren't user themes.
            return isDir && entry.name && !entry.name.startsWith('.');
        });
        const scanned = await Promise.all(themeDirs.map(async (entry) => {
            const themePath = `${themesDir}/${entry.name}`;
            try {
                const { manifest } = await ThemeManager.readManifest(themePath);
                // Forward-compat: a theme built for a newer manifest schema
                // is kept out of the dropdown so the engine never renders a
                // format it doesn't understand.
                if (manifestNeedsNewerEngine(manifest)) {
                    console.warn(`[Novaframe] Skipping "${manifest.name || entry.name}": manifest_version ${manifest.manifest_version} needs a newer engine (supports ${ENGINE_MANIFEST_VERSION}).`);
                    return null;
                }
                return {
                    themePath,
                    label: manifest.name || entry.name,
                    mode: manifest.render_mode || 'external-html',
                    custom_settings: manifest.custom_settings || null,
                    // Used by checkThemeContentUpdates: theme_id is the
                    // marketplace wallpaper UUID, version the installed build.
                    theme_id: manifest.theme_id || null,
                    version: manifest.version || null
                };
            } catch (_) {
                return null;
            }
        }));
        for (const t of scanned) {
            if (!t) continue;
            const { themePath, label, mode, custom_settings, theme_id, version } = t;
            ThemeManager.manifestCache[themePath] = { label, mode, custom_settings, theme_id, version };

            const option = document.createElement('option');
            option.value = themePath;
            option.dataset.renderMode = mode;
            option.textContent = label;
            selector.appendChild(option);
        }

        const activeTheme = await ConfigManager.getTheme();
        console.log("[Novaframe] Active theme from config:", activeTheme);
        
        let targetTheme = activeTheme;
        
        // If activeTheme is missing or points to the old Internal-Legacy ("")
        if (!activeTheme || activeTheme === "") {
            const options = selector.querySelectorAll('option');
            const themeOptions = Array.from(options).filter(o => o.value !== '');
            if (themeOptions.length > 0) {
                targetTheme = themeOptions[0].value;
                console.log("[Novaframe] Auto-selecting first available theme:", targetTheme);
            }
        }
        
        if (targetTheme) {
            selector.value = targetTheme;
            if (selector.value !== targetTheme) {
                console.warn("[Novaframe] Active theme not in dropdown — was it installed correctly?", targetTheme);
                // Fallback to first theme if active theme is invalid
                const themeOptions = Array.from(selector.querySelectorAll('option')).filter(o => o.value !== '');
                if (themeOptions.length > 0) {
                    selector.value = themeOptions[0].value;
                    targetTheme = themeOptions[0].value;
                }
            }
            await ConfigManager.setTheme(targetTheme);
            // Only the main window mounts the wallpaper iframe. Loading here in
            // the settings window would render a hidden copy of the theme
            // (container is display:none but the iframe still runs its WebGL
            // loop), doubling GPU/CPU cost. The main window picks the change up
            // via its store poll / theme-changed event.
            const inSettingsWindow = window.__TAURI__
                && window.location.search.includes('mode=settings');
            if (!inSettingsWindow) {
                ThemeManager.loadTheme(targetTheme);
            }
        }
        
    } catch (e) {
        console.error("[Novaframe] scanThemes failed:", e);
    }
    
    // Reload button: remount the active wallpaper in the main window. Useful
    // when a theme's WebGL context wedges. Emits to all windows; only the main
    // window listens (theme-reload handler in DOMContentLoaded).
    const refreshBtn = document.getElementById('refreshThemeBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            if (window.__TAURI__?.event) {
                try { await window.__TAURI__.event.emit('theme-reload'); } catch (_) {}
            } else if (ThemeManager.currentThemePath) {
                ThemeManager.loadTheme(ThemeManager.currentThemePath, true);
            }
        });
    }

    const openStoreBtn = document.getElementById('openStoreBtn');
    if (openStoreBtn) {
        openStoreBtn.addEventListener('click', async () => {
            if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
                await window.__TAURI__.core.invoke('open_storefront_window');
            } else {
                console.error("Tauri invoke API not available.");
            }
        });
    }

    // NOTE: the `engine-apply-theme` deep-link listener used to be registered
    // here. It was moved to module scope (registerEngineApplyListener) so it is
    // registered exactly once — this function re-runs on every reload and can
    // early-return/throw before reaching this point, which on Windows left the
    // deep link either unhandled (blank dropdown) or handled by a stale/duplicate
    // listener racing a concurrent install.

    // Panel locking while the native dropdown popup is open is handled by
    // the delegated listeners in initPanelLockDelegation().
    selector.addEventListener('change', async (e) => {
        const selected = e.target.value;
        // Persist + broadcast. The broadcast fans out to all windows; the
        // settings-window listener will update its own dropdown highlight +
        // scope when it echoes back. The main-window listener will re-render.
        await ConfigManager.setTheme(selected);
    });
}

// Width-constrained replacement for window.alert()/confirm(). Native dialogs
// render centered in the ~360px settings window, overflowing their buttons off
// the right edge — this overlay is constrained to the window width. Module
// scope so the deep-link listener (which runs outside initSettingsUI) can use
// it on its error paths, exactly when the user needs to read the message.
// Keeps the panel locked open while up so the hover-poll loop can't collapse
// the window out from under it.
//
//   message  – body text
//   buttons  – [{ label, value, variant, isDefault, isCancel }]
//              variant: 'primary' (green) | 'danger' (red) | 'neutral' (grey)
//              isDefault → focused + triggered by Enter
//              isCancel  → triggered by Escape + overlay click
// Resolves with the chosen button's `value`.
const MODAL_BTN_VARIANTS = {
    primary: 'background:#10b981;color:#022c22;',
    danger:  'background:#ef4444;color:#fff;',
    neutral: 'background:rgba(255,255,255,0.06);border-color:rgba(255,255,255,0.14);color:#e0e8ff;',
};
function modalInPanel({ message, buttons }) {
    return new Promise((resolve) => {
        setPanelLocked(true);

        const overlay = document.createElement('div');
        overlay.style.cssText =
            'position:fixed;inset:0;z-index:100000;display:flex;align-items:center;' +
            'justify-content:center;padding:12px;background:rgba(0,0,0,0.55);';

        const card = document.createElement('div');
        card.style.cssText =
            'box-sizing:border-box;width:100%;max-width:300px;background:#0f141d;' +
            'border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:18px 16px;' +
            'color:#e0e8ff;font-size:14px;line-height:1.4;box-shadow:0 8px 30px rgba(0,0,0,0.5);';

        const msg = document.createElement('p');
        msg.textContent = message;
        msg.style.cssText = 'margin:0 0 16px 0;';

        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;';

        const cleanup = (value) => {
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            setPanelLocked(false);
            resolve(value);
        };

        const defaultBtn = buttons.find(b => b.isDefault);
        const cancelBtn = buttons.find(b => b.isCancel);
        const onKey = (e) => {
            if (e.key === 'Enter' && defaultBtn) cleanup(defaultBtn.value);
            if (e.key === 'Escape' && cancelBtn) cleanup(cancelBtn.value);
        };

        let toFocus = null;
        for (const spec of buttons) {
            const btn = document.createElement('button');
            btn.textContent = spec.label;
            btn.style.cssText =
                'flex:1;padding:8px 10px;border-radius:6px;font-size:13px;font-weight:600;' +
                'cursor:pointer;border:1px solid transparent;' +
                (MODAL_BTN_VARIANTS[spec.variant] || MODAL_BTN_VARIANTS.neutral);
            btn.addEventListener('click', () => cleanup(spec.value));
            if (spec.isDefault) toFocus = btn;
            row.appendChild(btn);
        }

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay && cancelBtn) cleanup(cancelBtn.value);
        });
        document.addEventListener('keydown', onKey);

        card.appendChild(msg);
        card.appendChild(row);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        (toFocus || row.firstChild)?.focus();
    });
}

// Single-button acknowledgement. Resolves when dismissed.
function alertInPanel(message) {
    return modalInPanel({
        message,
        buttons: [{ label: 'OK', value: undefined, variant: 'primary', isDefault: true, isCancel: true }],
    });
}

// Two-button confirm. Resolves true on confirm, false on cancel/Escape/overlay.
function confirmInPanel(message, confirmLabel = 'Confirm', variant = 'danger') {
    return modalInPanel({
        message,
        buttons: [
            { label: 'Cancel', value: false, variant: 'neutral', isCancel: true },
            { label: confirmLabel, value: true, variant, isDefault: true },
        ],
    });
}

// Maps the backend's stable error codes ({ error, code }) to messages a
// user can act on. Codes are defined in marketplace-backend/src/utils/apiError.ts.
function friendlyApiError(data) {
    switch (data?.code) {
        case 'UNAUTHORIZED':
            return "Your session could not be verified. Please open the marketplace and sign in again.";
        case 'TOKEN_EXPIRED':
            return "This install link has expired. Please click Apply on the wallpaper again in the marketplace.";
        case 'NOT_PURCHASED':
            return "This wallpaper hasn't been purchased on your account. If you just bought it, wait a few seconds and try again.";
        case 'DEVICE_LIMIT':
            return "You've reached the 2-device limit for this wallpaper. Open My Vault in the marketplace to reset your devices, then try again.";
        case 'NOT_FOUND':
            return "This wallpaper is no longer available in the marketplace.";
        case 'SERVER_ERROR':
            return "The marketplace server hit a problem. Please try again in a minute.";
        default:
            return "License verification failed: " + (data?.error || "unknown error");
    }
}

// Guard so the deep-link listener is bound exactly once per JS context. Deep
// links (novaframe://apply?token=…) are emitted from Rust to ALL windows; only
// the settings window performs the download/install to avoid two windows racing
// the same extract+rename (which on Windows corrupts the theme dir → blank
// dropdown). Registered from DOMContentLoaded, decoupled from scanThemes so a
// failed theme scan can never leave the deep link unhandled.
let engineApplyListenerRegistered = false;
function registerEngineApplyListener() {
    if (engineApplyListenerRegistered) return;
    if (!(window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen)) {
        console.error('[Main] window.__TAURI__.event.listen is NOT available. The deep-link event cannot be received.');
        return;
    }
    engineApplyListenerRegistered = true;

    window.__TAURI__.event.listen('engine-apply-theme', async (event) => {
        const TAG = '[Main]';
        const stamp = `[${Date.now() % 100000}]`;
        const token = event?.payload;
        console.log(TAG, stamp, 'engine-apply-theme listener fired. payload type:', typeof token, 'length:', token?.length ?? 'null');
        console.log("[Novaframe] Received apply theme request from deep link with token:", token);

        try {
            // Hardware fingerprint for device-locked purchases. If the Rust
            // command fails we still verify — the backend treats a missing
            // hardwareId as a legacy client and skips enforcement.
            let hardwareId = null;
            try {
                hardwareId = await window.__TAURI__.core.invoke('get_hardware_id');
            } catch (hwErr) {
                console.error(TAG, stamp, 'get_hardware_id failed:', hwErr);
            }

            console.log(TAG, stamp, 'POST /api/engine/verify-token ...');
            const response = await fetch('https://api.novaframe.co.uk/api/engine/verify-token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, hardwareId })
            });
            console.log(TAG, stamp, 'verify-token responded with HTTP', response.status);

            const data = await response.json();

            if (response.ok && data.success) {
                const wallpaperId = data.wallpaper.id;
                const downloadUrl = data.wallpaper.downloadUrl;
                const wallpaperTitle = data.wallpaper.title;
                console.log(TAG, stamp, 'verify-token OK. wallpaperId=', wallpaperId, 'title=', JSON.stringify(wallpaperTitle), 'downloadUrl length=', downloadUrl?.length ?? 0);

                // Call the Rust command to download and install the theme
                console.log(TAG, stamp, `Invoking Rust download_and_install_theme themeId=${wallpaperId} title=${wallpaperTitle} ...`);
                let installedThemeId;
                try {
                    // Tauri v2 serializes Rust function arguments as camelCase on the
                    // JS side. Rust declares `theme_id` / `wallpaper_title` but the JS
                    // keys must be camelCase: `themeId` / `wallpaperTitle`.
                    installedThemeId = await window.__TAURI__.core.invoke('download_and_install_theme', {
                        url: downloadUrl,
                        themeId: wallpaperId,
                        wallpaperTitle: wallpaperTitle
                    });
                    console.log(TAG, stamp, `✅ Rust install returned dir=${installedThemeId}`);
                } catch (rustErr) {
                    console.error(TAG, stamp, '❌ Rust download_and_install_theme rejected:', rustErr);
                    await alertInPanel('Engine install command rejected: ' + (rustErr?.message ?? rustErr));
                    return;
                }

                console.log(`[Novaframe] Theme ${installedThemeId} installed successfully! Loading it...`);

                // Rust emits `theme-installed` on success, which both windows already
                // listen for (that handler sets the theme + reloads). Setting it here
                // too is harmless (idempotent) and keeps the flow working even if the
                // event is missed.
                const themesDir = await getThemesDir();
                const absoluteThemePath = `${themesDir}/${installedThemeId}`;
                await ConfigManager.setTheme(absoluteThemePath);
                console.log(TAG, stamp, 'ConfigManager.setTheme ok.');
            } else {
                console.error(TAG, stamp, 'verify-token returned !ok || !success:', data);
                console.error("Token verification failed:", data.error);
                await alertInPanel(friendlyApiError(data));
            }
        } catch (err) {
            console.error(TAG, stamp, '❌ exception in listener:', err);
            console.error("Error verifying token:", err);
            await alertInPanel("Error verifying license token.");
        }
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Delegated panel locking for selects + color pickers (covers dynamically
    // created custom-setting controls too).
    initPanelLockDelegation();

    // Apply initial scope before settings UI bootstraps so the panel renders correctly.
    applyThemeScope();

    // Surface uncaught JS errors to Rust logs (visible in `tauri dev` console)
    // so we don't need DevTools attached to diagnose runtime failures.
    const reportErr = (label, info) => {
        try {
            if (window.__TAURI__?.core?.invoke) {
                window.__TAURI__.core.invoke('log_from_js', {
                    message: `[${label}] ${info?.stack || info?.message || String(info)}`
                });
            }
        } catch (_) {}
    };
    window.addEventListener('error', (e) => reportErr('window.error', e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => reportErr('unhandledrejection', e.reason));

    // Standalone Storage Fallback listener (cross-origin browser support)
    window.addEventListener('storage', (e) => {
        if (e.key === 'activeTheme') {
            const newTheme = e.newValue || null;
            ThemeManager.loadTheme(newTheme);
        } else if (e.key === 'novaframe_config') {
            try {
                if (e.newValue) {
                    config = JSON.parse(e.newValue);
                }
            } catch (err) {}
        }
    });

    if (window.__TAURI__) {
        await verifyAndProvisionAppData();
        await ConfigManager.init();
        initDualWindowSystem();

        // Settings UI only exists in the settings (controls) window. Mounting
        // it on the main window would render an unused overlay whose cog is
        // also unreachable behind the wallpaper iframe.
        const isSettingsWindow = window.location.search.includes('mode=settings');
        if (isSettingsWindow) {
            initSettingsUI();
            // Exactly one window handles the deep-link download/install; the
            // settings window is always alive (never destroyed/collapsed away)
            // and is the one the marketplace deep link focuses. Registering in
            // both windows would race the same install.
            registerEngineApplyListener();
        }

        if (window.__TAURI__.event) {
            // Inter-window event triggers
            window.__TAURI__.event.listen('theme-changed', async (event) => {
                const newTheme = event.payload || null;
                const isMainWindow = window.location.search.includes('mode=main');

                if (isMainWindow) {
                    // Skip if theme hasn't actually changed — guards against
                    // echo loops where the same window receives its own broadcast
                    // back. ThemeManager.loadTheme has its own idempotency guard.
                    if (newTheme === ThemeManager.currentThemePath) return;
                    ThemeManager.loadTheme(newTheme);
                } else {
                    // Settings window: ALWAYS mirror the new state. Echoes are
                    // cheap here because we never touch the iframe / canvases.
                    ThemeManager.currentThemePath = newTheme;
                    updateSettingsScope(newTheme);
                }
            });

            // Refresh button in the settings panel: hard-remount the active
            // theme's iframe (main window only — settings window has no mount).
            window.__TAURI__.event.listen('theme-reload', () => {
                const isMainWindow = window.location.search.includes('mode=main');
                if (isMainWindow && ThemeManager.currentThemePath) {
                    ThemeManager.loadTheme(ThemeManager.currentThemePath, true);
                }
            });

            window.__TAURI__.event.listen('theme-installed', async (event) => {
                const absoluteThemePath = event.payload;
                console.log("[Novaframe] Received theme-installed event with path:", absoluteThemePath);
                await ConfigManager.setTheme(absoluteThemePath);
                // Full reload — scanThemes() will re-run and select the newly installed theme
                window.location.reload();
            });

            window.__TAURI__.event.listen('config-changed', (event) => {
                if (event.payload) {
                    config = event.payload;
                    relayThemeSettingsToIframe();
                }
            });

            // macOS Sleep Failsafe (Bulletproof)
            // When the OS goes to sleep, the WebGL context in the iframe is often lost or frozen.
            // A delta-time interval detects if the CPU actually slept (e.g. >5 seconds passed between 1s intervals).
            // Main window only — the settings window never mounts an iframe,
            // so its copy of this timer was pure waste.
            let lastTick = Date.now();
            if (!isSettingsWindow) setInterval(() => {
                const now = Date.now();
                if (now - lastTick > 5000) {
                    console.log("Wake from sleep detected. Reloading iframe to restore WebGL context.");
                    if (ThemeManager.currentIframe) {
                        // Force a hard reload of the iframe to obliterate the dead WebGL context
                        const currentSrc = ThemeManager.currentIframe.src;
                        ThemeManager.currentIframe.src = 'about:blank';
                        setTimeout(() => {
                            ThemeManager.currentIframe.src = currentSrc;
                        }, 50);
                    }
                }
                lastTick = now;
            }, 1000);

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


        }
    } else {
        await ConfigManager.init();
        initSettingsUI();
    }
});


// Auto-Updater Integration
const updateBtn = document.getElementById('updateBtn');
const updateStatus = document.getElementById('updateStatus');
const updateRestartBanner = document.getElementById('updateRestartBanner');
const updateRestartBtn = document.getElementById('updateRestartBtn');

async function relaunchApp() {
    const proc = window.__TAURI_PLUGIN_PROCESS__ || (window.__TAURI__ && window.__TAURI__.process);
    if (proc && proc.relaunch) {
        await proc.relaunch();
    } else {
        console.error('[Updater] process.relaunch not available');
    }
}

// Shared check/download/install. silent=true: no status text unless an update
// is actually found and installed, in which case the restart banner appears
// instead of force-relaunching (decisions 2-3 in the distribution plan).
// silent=false (manual button): verbose progress + auto-relaunch as before.
let updateInstalledPendingRestart = false;

async function checkAndInstallUpdate({ silent }) {
    const setStatus = (text, color) => {
        if (silent || !updateStatus) return;
        updateStatus.innerText = text;
        if (color) updateStatus.style.color = color;
    };

    const updater = window.__TAURI_PLUGIN_UPDATER__ || (window.__TAURI__ && window.__TAURI__.updater);
    if (!updater) {
        setStatus('Updater not available in this build.', '#ef4444');
        return;
    }

    if (updateInstalledPendingRestart) {
        // Already downloaded and installed this session — just needs a restart.
        setStatus('Update ready — restart to apply.', '#10b981');
        return;
    }

    const update = await updater.check();
    if (!update) {
        setStatus('You are on the latest version.', '#10b981');
        return;
    }

    setStatus(`Update found: v${update.version}. Downloading...`, '#3b82f6');
    let downloaded = 0;
    let contentLength = 0;

    await update.downloadAndInstall((event) => {
        switch (event.event) {
            case 'Started':
                contentLength = event.data.contentLength;
                setStatus('Downloading... 0%');
                break;
            case 'Progress':
                downloaded += event.data.chunkLength;
                if (contentLength) {
                    const percent = Math.round((downloaded / contentLength) * 100);
                    setStatus(`Downloading... ${percent}%`);
                }
                break;
            case 'Finished':
                setStatus('Installing...');
                break;
        }
    });

    updateInstalledPendingRestart = true;

    if (silent) {
        // Background update: don't yank the app out from under the user.
        console.log(`[Updater] v${update.version} installed in background; awaiting restart.`);
        if (updateRestartBanner) updateRestartBanner.style.display = 'block';
    } else {
        setStatus('Update installed! Restarting...', '#10b981');
        setTimeout(relaunchApp, 1500);
    }
}

if (updateRestartBtn) {
    updateRestartBtn.addEventListener('click', relaunchApp);
}

if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
        try {
            updateStatus.innerText = 'Checking for updates...';
            updateStatus.style.color = '#888';
            updateBtn.disabled = true;
            await checkAndInstallUpdate({ silent: false });
        } catch (error) {
            console.error('Update error:', error);
            updateStatus.innerText = `Update failed: ${error}`;
            updateStatus.style.color = '#ef4444';
        } finally {
            updateBtn.disabled = false;
            setTimeout(() => {
                if (updateStatus.innerText.includes('latest version') || updateStatus.innerText.includes('failed')) {
                    updateStatus.innerText = '';
                }
            }, 5000);
        }
    });
}

// ── First-run welcome overlay (main window) ────────────────────────────────
// The main window is click-through, so the overlay only points the user at
// the interactive right-edge settings tab; it can't hold buttons itself.
function setWelcomeVisible(visible) {
    const overlay = document.getElementById('welcomeOverlay');
    if (!overlay) return;
    const isMainWindow = (new URLSearchParams(window.location.search).get('mode') || 'main') === 'main';
    overlay.style.display = visible && isMainWindow ? 'flex' : 'none';
}

// ── Theme content updates ───────────────────────────────────────────────────
// Asks the backend which installed themes have a newer build published
// (compares manifest.version against wallpapers.engine_manifest.version).
// Refreshing still goes through the normal Vault re-apply flow — this only
// surfaces the notice; it never downloads anything itself.
async function checkThemeContentUpdates() {
    const notice = document.getElementById('themeUpdatesNotice');
    if (!notice) return;

    const installed = Object.values(ThemeManager.manifestCache)
        .filter(m => m.theme_id)
        .map(m => ({ id: m.theme_id, version: m.version || '' }));
    if (installed.length === 0) return;

    try {
        const res = await fetch('https://api.novaframe.co.uk/api/engine/check-theme-updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ themes: installed }),
        });
        if (!res.ok) return;
        const { updates } = await res.json();
        if (!Array.isArray(updates) || updates.length === 0) {
            notice.style.display = 'none';
            return;
        }
        // Build with DOM nodes, not innerHTML — titles come from the server and
        // must never be interpreted as markup inside the settings webview.
        const names = updates.map(u => u.title || u.id).join(', ');
        notice.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = 'Wallpaper update available:';
        notice.append(strong, ` ${names}. Open the Marketplace, go to `,
            Object.assign(document.createElement('strong'), { textContent: 'My Vault' }),
            ' and hit Apply to refresh.');
        notice.style.display = 'block';
    } catch (err) {
        console.log('[ThemeUpdates] check failed (offline?):', err);
    }
}

// Automatic background check: ~1 min after launch, then every 24h.
// Runs only in the settings webview (mode=settings) so exactly one window
// polls, and the restart banner is in the panel the user actually sees.
{
    const mode = new URLSearchParams(window.location.search).get('mode') || 'main';
    if (mode === 'settings') {
        const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
        const silentCheck = () => checkAndInstallUpdate({ silent: true })
            .catch(err => console.error('[Updater] background check failed:', err));
        const themeCheck = () => checkThemeContentUpdates()
            .catch(err => console.error('[ThemeUpdates] background check failed:', err));
        setTimeout(silentCheck, 60 * 1000);
        setInterval(silentCheck, AUTO_CHECK_INTERVAL_MS);
        // Theme scan must have populated manifestCache first — scanThemes runs
        // during initSettingsUI, well before this fires.
        setTimeout(themeCheck, 20 * 1000);
        setInterval(themeCheck, AUTO_CHECK_INTERVAL_MS);
    } else {
        // Main window: if nothing is mounted shortly after startup, this is a
        // fresh install — show the welcome instructions.
        setTimeout(() => {
            if (!ThemeManager.currentManifest) setWelcomeVisible(true);
        }, 2500);
    }
}
