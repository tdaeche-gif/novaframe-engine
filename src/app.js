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
    const encoded = fsPath.split('/').map(encodeURIComponent).join('/');
    const lead = encoded.startsWith('/') ? '' : '/';
    // Windows/Android webviews expose custom schemes as http://<scheme>.localhost
    const isWindows = navigator.userAgent.includes('Windows');
    return isWindows
        ? `http://theme.localhost${lead}${encoded}`
        : `theme://localhost${lead}${encoded}`;
}

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
        // CONTROLS MODE: full-window settings panel (300x600 dock, docked right by Rust).
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

        // Idempotency guard: skip the full render path if the theme is already
        // active (manifest + path match). Prevents double-mounts when an echo
        // event re-enters this function before the first call has finished.
        if (themePath === this.currentThemePath && manifest.theme_id === this.currentManifest?.theme_id) {
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
                        ThemeManager.currentThemePath = normLatest;
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

                group.appendChild(input);
                customSettingsSection.appendChild(group);
            });

            // Hardcoded legacy pins logic for Classic Mercator
            if (ThemeManager.manifestCache[themePath].label === 'Classic Mercator') {
                // Inputs stack vertically (City on its own row, Lat/Lon paired,
                // full-width Add button) using the .add-pin-form styles so nothing
                // ever overflows the panel width horizontally.
                const legacyHTML = `
                    <div class="control-group" style="margin-top: 16px;">
                        <label>Pinned Locations</label>
                        <div id="pinsList" class="settings-list" style="max-height: 150px; overflow-y: auto; margin-bottom: 8px;"></div>
                        <div class="add-pin-form">
                            <input type="text" id="newPinName" placeholder="City">
                            <div class="row">
                                <input type="text" id="newPinLat" placeholder="Lat">
                                <input type="text" id="newPinLon" placeholder="Lon">
                            </div>
                            <button id="addPinBtn">Add Location</button>
                        </div>
                    </div>
                `;
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = legacyHTML;
                customSettingsSection.appendChild(tempDiv.firstElementChild);
                
                const pinsList = document.getElementById('pinsList');
                const addPinBtn = document.getElementById('addPinBtn');
                
                const getPins = () => config.theme_settings[themePath].pinned_locations || [];
                const savePins = (pins) => {
                    config.theme_settings[themePath].pinned_locations = pins;
                    ConfigManager.saveConfig();
                    if (ThemeManager.currentIframe?.contentWindow) {
                        ThemeManager.currentIframe.contentWindow.postMessage({ type: 'novaframe-settings', settings: { pinned_locations: pins } }, '*');
                    }
                };

                const renderPins = () => {
                    pinsList.innerHTML = '';
                    getPins().forEach((pin, index) => {
                        const item = document.createElement('div');
                        item.className = 'pin-item';
                        item.innerHTML = `
                            <div class="pin-info">
                                <div class="pin-name">${pin.name}</div>
                                <div class="pin-coords">${pin.lat}, ${pin.lon}</div>
                            </div>
                            <button class="delete-btn" data-index="${index}" title="Remove">×</button>
                        `;
                        pinsList.appendChild(item);
                    });
                    pinsList.querySelectorAll('.delete-btn').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                            const idx = parseInt(e.target.dataset.index);
                            const pins = getPins();
                            pins.splice(idx, 1);
                            savePins(pins);
                            renderPins();
                        });
                    });
                };
                
                addPinBtn.addEventListener('click', () => {
                    const name = document.getElementById('newPinName').value;
                    const lat = parseFloat(document.getElementById('newPinLat').value);
                    const lon = parseFloat(document.getElementById('newPinLon').value);
                    if (name && !isNaN(lat) && !isNaN(lon)) {
                        const pins = getPins();
                        pins.push({ name, lat, lon });
                        savePins(pins);
                        renderPins();
                        document.getElementById('newPinName').value = '';
                        document.getElementById('newPinLat').value = '';
                        document.getElementById('newPinLon').value = '';
                    }
                });
                
                if (!config.theme_settings[themePath].pinned_locations) {
                    config.theme_settings[themePath].pinned_locations = [
                        { name: "London", lat: 51.5074, lon: -0.1278 },
                        { name: "New York", lat: 40.7128, lon: -74.0060 },
                        { name: "Tokyo", lat: 35.6762, lon: 139.6503 }
                    ];
                }
                renderPins();
            }
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

}

// ── Dynamic Theme Scanner (Module 1) ───────────────────────────────────────
async function scanThemes() {
    const selector = document.getElementById('themeSelector');
    if (!selector) return;
    
    selector.innerHTML = '<option value="" disabled>Select a Theme...</option>';
    
    const tauriFs = window.__TAURI_PLUGIN_FS__ || (window.__TAURI__ && window.__TAURI__.fs);
    if (!tauriFs) return;
    
    try {
        const themesDir = await getThemesDir();
        console.log("[Novaframe] Scanning themes directory:", themesDir);
        const entries = await tauriFs.readDir(themesDir);
        console.log("[Novaframe] Found entries:", entries);
        
        for (const entry of entries) {
            const isDir = entry.isDirectory === true || Array.isArray(entry.children);
            if (isDir && entry.name) {
                const themePath = `${themesDir}/${entry.name}`;
                let label = entry.name;
                let mode = 'unknown';
                let custom_settings = null;
                try {
                    const { manifest } = await ThemeManager.readManifest(themePath);
                    if (manifest.name) label = `${manifest.name}`;
                    mode = manifest.render_mode || 'external-html';
                    if (manifest.custom_settings) custom_settings = manifest.custom_settings;
                } catch (_) {
                    continue;
                }
                
                ThemeManager.manifestCache[themePath] = { label, mode, custom_settings };

                const option = document.createElement('option');
                option.value = themePath;
                option.dataset.renderMode = mode;
                option.textContent = `${label}`;
                selector.appendChild(option);
            }
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
            ThemeManager.loadTheme(targetTheme);
        }
        
    } catch (e) {
        console.error("[Novaframe] scanThemes failed:", e);
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

    if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
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
                        alert('Engine install command rejected: ' + (rustErr?.message ?? rustErr));
                        return;
                    }

                    console.log(`[Novaframe] Theme ${installedThemeId} installed successfully! Loading it...`);

                    // Switch to the newly installed theme
                    const themesDir = await getThemesDir();
                    const absoluteThemePath = `${themesDir}/${installedThemeId}`;
                    await ConfigManager.setTheme(absoluteThemePath);
                    console.log(TAG, stamp, 'ConfigManager.setTheme ok. Reloading main window...');

                    // Full reload — scanThemes() will re-run on load and select the new theme
                    window.location.reload();
                } else {
                    console.error(TAG, stamp, 'verify-token returned !ok || !success:', data);
                    console.error("Token verification failed:", data.error);
                    alert(friendlyApiError(data));
                }
            } catch (err) {
                console.error(TAG, stamp, '❌ exception in listener:', err);
                console.error("Error verifying token:", err);
                alert("Error verifying license token.");
            }
        });
    } else {
        console.error('[Main] window.__TAURI__.event.listen is NOT available. The event cannot be received.');
    }

    // Lock the panel open while the native dropdown popup is open (mousedown
    // covers pointer-opened popups, focus covers keyboard-opened ones). Unlock
    // on change (an option was picked) or blur (closed without picking, e.g.
    // Escape or clicking away) — whichever fires first closes the popup.
    selector.addEventListener('mousedown', () => setPanelLocked(true));
    selector.addEventListener('focus', () => setPanelLocked(true));
    selector.addEventListener('blur', () => setPanelLocked(false));

    selector.addEventListener('change', async (e) => {
        setPanelLocked(false);
        const selected = e.target.value;
        // Persist + broadcast. The broadcast fans out to all windows; the
        // settings-window listener will update its own dropdown highlight +
        // scope when it echoes back. The main-window listener will re-render.
        await ConfigManager.setTheme(selected);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
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
            let lastTick = Date.now();
            setInterval(() => {
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

if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
        try {
            updateStatus.innerText = 'Checking for updates...';
            updateStatus.style.color = '#888';
            updateBtn.disabled = true;

            const updater = window.__TAURI_PLUGIN_UPDATER__ || (window.__TAURI__ && window.__TAURI__.updater);
            if (!updater) {
                updateStatus.innerText = 'Updater not available in this build.';
                updateStatus.style.color = '#ef4444';
                return;
            }

            const update = await updater.check();
            if (update) {
                updateStatus.innerText = `Update found: v${update.version}. Downloading...`;
                updateStatus.style.color = '#3b82f6';
                
                let downloaded = 0;
                let contentLength = 0;
                
                await update.downloadAndInstall((event) => {
                    switch (event.event) {
                        case 'Started':
                            contentLength = event.data.contentLength;
                            updateStatus.innerText = `Downloading... 0%`;
                            break;
                        case 'Progress':
                            downloaded += event.data.chunkLength;
                            if (contentLength) {
                                const percent = Math.round((downloaded / contentLength) * 100);
                                updateStatus.innerText = `Downloading... ${percent}%`;
                            }
                            break;
                        case 'Finished':
                            updateStatus.innerText = `Installing...`;
                            break;
                    }
                });

                updateStatus.innerText = 'Update installed! Restarting...';
                updateStatus.style.color = '#10b981';
                setTimeout(async () => {
                    const process = window.__TAURI_PLUGIN_PROCESS__ || (window.__TAURI__ && window.__TAURI__.process);
                    if (process && process.relaunch) {
                        await process.relaunch();
                    }
                }, 1500);
            } else {
                updateStatus.innerText = 'You are on the latest version.';
                updateStatus.style.color = '#10b981';
            }
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
