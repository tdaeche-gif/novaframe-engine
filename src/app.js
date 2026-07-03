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
//   legacy  = Geochron world-map + sun (Internal-Legacy)
//   dynamic = any external-html / external-canvas theme like Ignis
function applyThemeScope() {
    const mode = ThemeManager?.currentManifest?.render_mode === 'internal-legacy'
        || !ThemeManager?.currentManifest
        ? 'legacy'
        : 'dynamic';
    document.documentElement.dataset.themeScope = mode;
}

// ── Canvas & context setup ─────────────────────────────────────────────────
const baseCanvas = document.getElementById('novaframeCanvas');
const baseCtx = baseCanvas.getContext('2d', { alpha: false });

const canvas = document.getElementById('overlayCanvas');
const ctx = canvas.getContext('2d', { alpha: true });

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
        if (!window.__TAURI__?.core?.convertFileSrc) {
            throw new Error("Tauri convertFileSrc unavailable");
        }
        for (const candidate of ['engine_manifest.json', 'manifest.json']) {
            const uri = window.__TAURI__.core.convertFileSrc(`${themePath}/${candidate}`);
            const res = await fetch(uri);
            if (res.ok) {
                const m = await res.json();
                return { manifest: m, manifestFile: candidate };
            }
        }
        throw new Error(`Manifest not found under ${themePath}`);
    },

    async loadTheme(themePath) {
        if (!themePath) {
            // No-op if we're already showing legacy.
            if (this.currentThemePath === null && !this.currentManifest) return;
            this.fallbackToLegacy();
            return;
        }

        let parsed;
        try {
            parsed = await this.readManifest(themePath);
        } catch (err) {
            console.error("[Novaframe] Failed to read theme manifest, falling back:", err);
            this.fallbackToLegacy();
            return;
        }

        const manifest = parsed.manifest;

        // Idempotency guard: skip the full render path if the theme is already
        // active (manifest + path match). Prevents double-mounts when an echo
        // event re-enters this function before the first call has finished.
        if (themePath === this.currentThemePath && manifest.theme_id === this.currentManifest?.theme_id) {
            return;
        }

        const renderMode = manifest.render_mode || 'internal-legacy';

        this.currentManifest = manifest;
        this.currentThemePath = themePath;

        if (renderMode === 'internal-legacy') {
            await this.loadInternalLegacy(themePath, manifest);
        } else if (renderMode === 'external-html' || renderMode === 'external-canvas') {
            await this.loadExternalHtml(themePath, manifest, renderMode);
        } else {
            console.error(`[Novaframe] Unknown render_mode "${renderMode}", falling back`);
            this.fallbackToLegacy();
            return;
        }

        applyThemeScope();
        await ConfigManager.setTheme(themePath);
    },

    async loadInternalLegacy(themePath, manifest) {
        // Tear down any iframe from previous external mode
        this.unmountIframe();

        // Only honor legacy `assets.background_image` + `render_engine` shape.
        // New wallpapers that declare `render_mode: "external-html"` skip this path.
        const bgImage = manifest.assets?.background_image;
        if (bgImage) {
            const imageUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${bgImage}`);
            const imgResponse = await fetch(imageUri, { method: 'HEAD' });
            if (!imgResponse.ok) throw new Error("Map image missing at " + imageUri);
            this.currentTheme = { ...LEGACY_THEME_DEFAULTS, ...(manifest.settings || {}) };
            this.currentTheme.mapImageSrc = imageUri;
        } else {
            // No custom asset — just apply settings overrides, keep default map.
            this.currentTheme = { ...LEGACY_THEME_DEFAULTS, ...(manifest.settings || {}) };
        }

        // Optional external shader sources
        if (manifest.render_engine?.vertex_shader && manifest.render_engine?.fragment_shader) {
            const vertUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${manifest.render_engine.vertex_shader}`);
            const fragUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${manifest.render_engine.fragment_shader}`);
            const [vertRes, fragRes] = await Promise.all([fetch(vertUri), fetch(fragUri)]);
            if (!vertRes.ok) throw new Error("Vertex shader missing");
            if (!fragRes.ok) throw new Error("Fragment shader missing");
            glShaderSources.vert = await vertRes.text();
            glShaderSources.frag = await fragRes.text();
            glInitialized = false;
        } else {
            glShaderSources.vert = null;
            glShaderSources.frag = null;
        }

        this.applyThemeToDOM();
        showCanvases();
    },

    async loadExternalHtml(themePath, manifest) {
        const entry = manifest.entry || 'index.html';
        const fileSrc = window.__TAURI__.core.convertFileSrc(`${themePath}/${entry}`);
        const transparent = manifest.transparent !== false; // default true
        this.mountIframe(fileSrc, transparent);
        hideCanvases();
    },

    mountIframe(src, transparent) {
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

            // Dispatch saved theme settings if they exist
            if (config.theme_settings && config.theme_settings[absoluteThemePath]) {
                const settings = config.theme_settings[absoluteThemePath];
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
    },

    fallbackToLegacy() {
        this.unmountIframe();
        this.currentManifest = null;
        this.currentTheme = { ...LEGACY_THEME_DEFAULTS };
        this.applyThemeToDOM();
        showCanvases();
        this.currentThemePath = null;
        applyThemeScope();
        // Persist the absence of an active theme so scanThemes auto-select can fire.
        ConfigManager.setTheme(null);
    },

    applyThemeToDOM() {
        // Only relevant for internal-legacy mode; external-html mode hides canvases.
        if (this.currentTheme.mapImageSrc) {
            mapImage.src = this.currentTheme.mapImageSrc;
        }
        document.documentElement.style.backgroundColor = this.currentTheme.bgColor;
        document.body.style.backgroundColor = this.currentTheme.bgColor;
    }
};

// ── Canvas visibility helpers ──────────────────────────────────────────────
function hideCanvases() {
    const c1 = document.getElementById('novaframeCanvas');
    const c2 = document.getElementById('overlayCanvas');
    if (c1) c1.style.display = 'none';
    if (c2) c2.style.display = 'none';
}
function showCanvases() {
    const c1 = document.getElementById('novaframeCanvas');
    const c2 = document.getElementById('overlayCanvas');
    if (c1) c1.style.display = '';
    if (c2) c2.style.display = '';
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

const mapImage = new Image();
const cityLightsImage = new Image();
cityLightsImage.onload = () => {
    console.log("[Novaframe] City lights asset loaded.");
    if (glInitialized && !cityLightsUploaded) {
        startLoop();
    }
};
cityLightsImage.src = 'assets/world-city-lights.png';

let isMapLoaded = false;
let rafStarted = false;
let rafId = null;
let activeUntil = 0;
let isWindowOccluded = false;
let timeoutId = null;

function startLoop() {
    if (rafStarted) return;
    rafStarted = true;

    const isInteractive = Date.now() < activeUntil;
    if (isInteractive) {
        rafId = requestAnimationFrame(render);
    } else {
        timeoutId = setTimeout(() => {
            rafStarted = false;
            render(performance.now());
        }, 10000); // 10-second idle draw interval
    }
}

mapImage.onload = () => {
    isMapLoaded = true;
    console.log(`[Novaframe] Map asset loaded: ${mapImage.naturalWidth}x${mapImage.naturalHeight}`);
    resizeCanvas();
    startLoop();
};

mapImage.onerror = (err) => {
    console.error(`[Novaframe] ASSET LOAD FAILURE — missing mapImage asset`);
    if (!mapImage.src.includes('assets/world-map-mercator.jpg')) {
        ThemeManager.fallbackToLegacy();
    } else {
        // Even if the legacy map is missing (e.g. moved to themes folder), start the loop!
        isMapLoaded = false;
        resizeCanvas();
        startLoop();
    }
};

window.addEventListener('resize', () => {
    resizeCanvas();
    lastCacheWidth = -1;
    lastCacheHeight = -1;
});

function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1; 
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    // Set backing store to full physical pixels for Retina clarity
    baseCanvas.width = width * dpr;
    baseCanvas.height = height * dpr;
    baseCanvas.style.transform = `scale(${1 / dpr})`;
    baseCanvas.style.transformOrigin = 'top left';
    baseCanvas.style.width = (width * dpr) + 'px';
    baseCanvas.style.height = (height * dpr) + 'px';
    baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.transform = `scale(${1 / dpr})`;
    canvas.style.transformOrigin = 'top left';
    canvas.style.width = (width * dpr) + 'px';
    canvas.style.height = (height * dpr) + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    drawStaticMap(width, height);
    
    if (window.__TAURI__ && window.__TAURI__.core) {
        window.__TAURI__.core.invoke('log_from_js', { 
            message: `resizeCanvas: logical=${width}x${height}, dpr=${dpr}, canvas=${canvas.width}x${canvas.height}` 
        }).catch(err => console.error(err));
    }
}

// ── Constants & Configuration ──────────────────────────────────────────────
const CACHE_LIFETIME = 60000;          // Recompute terminator every 60 s
const DRAW_INTERVAL = 1000;            // Base fallback frame throttle (1 FPS)

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
                    if (latestConfig) config = latestConfig;

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
                
                if (setting.type === 'range') {
                    if (setting.min !== undefined) input.min = setting.min;
                    if (setting.max !== undefined) input.max = setting.max;
                    if (setting.step !== undefined) input.step = setting.step;
                }

                // Load saved value or default
                const savedVal = config.theme_settings[themePath][setting.id];
                input.value = savedVal !== undefined ? savedVal : (setting.default || '');

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
    if (activeTheme && document.getElementById('themeSelector')) {
        const selector = document.getElementById('themeSelector');
        selector.value = activeTheme;
    }
    
    // 3. Synchronously apply UI layout scoping
    updateSettingsScope(activeTheme);

    const opacitySlider = document.getElementById('opacitySlider'); //
    const pinsList = document.getElementById('pinsList'); //
    const addPinBtn = document.getElementById('addPinBtn'); //

    // Set initial structural UI values
    opacitySlider.value = config.shadowOpacity; //
    
    // Shadow slider listener
    opacitySlider.addEventListener('input', (e) => {
        config.shadowOpacity = parseInt(e.target.value);
        ConfigManager.saveConfig();
    });
    
    // Analemma toggle listener
    const analemmaToggle = document.getElementById('analemmaToggle');
    if (analemmaToggle) {
        analemmaToggle.checked = config.showAnalemma !== false;
        analemmaToggle.addEventListener('change', (e) => {
            config.showAnalemma = e.target.checked;
            ConfigManager.saveConfig();
        });
    }
    
    // Add location function
    addPinBtn.addEventListener('click', () => {
        const name = document.getElementById('pinName').value.trim(); //
        const lat = parseFloat(document.getElementById('pinLat').value); //
        const lon = parseFloat(document.getElementById('pinLon').value); //
        
        if (name && !isNaN(lat) && !isNaN(lon)) {
            config.pinnedLocations.push({ name, lat, lon });
            ConfigManager.saveConfig();
            renderUIList(); //
            // Clear input fields
            document.getElementById('pinName').value = ''; //
            document.getElementById('pinLat').value = ''; //
            document.getElementById('pinLon').value = ''; //
        }
    });

    // Populate cities autocomplete list
    const citiesList = document.getElementById('citiesList');
    if (citiesList) {
        citiesList.innerHTML = '';
        citiesDb.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.name;
            citiesList.appendChild(opt);
        });
    }

    // Auto-autocomplete on input and immediate add
    const pinNameInput = document.getElementById('pinName');
    if (pinNameInput) {
        pinNameInput.addEventListener('input', (e) => {
            const val = e.target.value.trim();
            const matched = citiesDb.find(c => c.name.toLowerCase() === val.toLowerCase());
            if (matched) {
                // Check if already pinned
                const exists = config.pinnedLocations.some(loc => loc.name.toLowerCase() === matched.name.toLowerCase());
                if (!exists) {
                    config.pinnedLocations.push({ name: matched.name, lat: matched.lat, lon: matched.lon });
                    ConfigManager.saveConfig();
                    renderUIList();
                }
                // Clear fields
                pinNameInput.value = '';
                document.getElementById('pinLat').value = '';
                document.getElementById('pinLon').value = '';
            }
        });
    }
    
    function renderUIList() {
        pinsList.innerHTML = '';
        config.pinnedLocations.forEach((loc, index) => {
            const item = document.createElement('div');
            item.className = 'pin-item';
            item.innerHTML = `
                <div class="pin-info">
                    <span class="pin-name">${loc.name}</span>
                    <span class="pin-coords">${loc.lat.toFixed(1)}°, ${loc.lon.toFixed(1)}°</span>
                </div>
                <button class="delete-btn" data-index="${index}">&times;</button>
            `;
            pinsList.appendChild(item);
        });
    }
    
    pinsList.addEventListener('click', (e) => {
        if (e.target.classList.contains('delete-btn')) {
            const index = parseInt(e.target.getAttribute('data-index'));
            config.pinnedLocations.splice(index, 1);
            ConfigManager.saveConfig();
            renderUIList();
        }
    });
    
    renderUIList();
}

// ── Dynamic Theme Scanner (Module 1) ───────────────────────────────────────
async function scanThemes() {
    const selector = document.getElementById('themeSelector');
    if (!selector) return;
    
    selector.innerHTML = '<option value="">Internal-Legacy</option>';
    
    const tauriFs = window.__TAURI_PLUGIN_FS__ || (window.__TAURI__ && window.__TAURI__.fs);
    if (!tauriFs) return;
    
    try {
        const themesDir = await getThemesDir();
        console.log("[Novaframe] Scanning themes directory:", themesDir);
        const entries = await tauriFs.readDir(themesDir);
        console.log("[Novaframe] Found entries:", entries);
        
        for (const entry of entries) {
            // Fix #2: Tauri v2 plugin-fs uses entry.isDirectory (boolean).
            // Tauri v1 used entry.children (array). Support both shapes.
            const isDir = entry.isDirectory === true || Array.isArray(entry.children);
            if (isDir && entry.name) {
                const themePath = `${themesDir}/${entry.name}`;
                // Peek manifest for a friendly label and a render_mode tag
                let label = entry.name;
                let mode = 'unknown';
                let custom_settings = null;
                try {
                    const { manifest } = await ThemeManager.readManifest(themePath);
                    if (manifest.name) label = `${manifest.name}`;
                    mode = manifest.render_mode || 'internal-legacy';
                    if (manifest.custom_settings) custom_settings = manifest.custom_settings;
                } catch (_) {
                    // Skip dirs without a valid manifest — they aren't loadable themes.
                    continue;
                }
                
                // Save to in-memory cache
                ThemeManager.manifestCache[themePath] = { label, mode, custom_settings };

                const option = document.createElement('option');
                option.value = themePath;
                option.dataset.renderMode = mode;
                // Suffix the mode label so power users can tell at a glance
                const modeTag = ''; // Removed (html) and (canvas) suffixes for production
                option.textContent = `${label}${modeTag}`;
                selector.appendChild(option);
            }
        }

        const activeTheme = await ConfigManager.getTheme();
        console.log("[Novaframe] Active theme from config:", activeTheme);
        if (activeTheme) {
            selector.value = activeTheme;
            if (selector.value !== activeTheme) {
                console.warn("[Novaframe] Active theme not in dropdown — was it installed correctly?", activeTheme);
            }
        } else {
            // No active theme persisted yet — if exactly one theme is on disk,
            // auto-select it. This handles the first-time reload after a fresh
            // install where the store hadn't been flushed before reload.
            const options = selector.querySelectorAll('option');
            const themeOptions = Array.from(options).filter(o => o.value !== '');
            if (themeOptions.length === 1) {
                console.log("[Novaframe] Auto-selecting the only available theme:", themeOptions[0].value);
                selector.value = themeOptions[0].value;
                await ConfigManager.setTheme(themeOptions[0].value);
                ThemeManager.loadTheme(themeOptions[0].value);
            }
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

    if (window.__TAURI__ && window.__TAURI__.event && window.__TAURI__.event.listen) {
        window.__TAURI__.event.listen('engine-apply-theme', async (event) => {
            const TAG = '[Main]';
            const stamp = `[${Date.now() % 100000}]`;
            const token = event?.payload;
            console.log(TAG, stamp, 'engine-apply-theme listener fired. payload type:', typeof token, 'length:', token?.length ?? 'null');
            console.log("[Novaframe] Received apply theme request from deep link with token:", token);

            try {
                console.log(TAG, stamp, 'POST /api/engine/verify-token ...');
                const response = await fetch('https://api.novaframe.co.uk/api/engine/verify-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
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
                    alert("License Verification Failed: " + data.error);
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

    selector.addEventListener('change', async (e) => {
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
                }
            });

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

            window.__TAURI__.event.listen('settings-active', (event) => {
                const isActive = event.payload;
                if (isActive) {
                    activeUntil = Date.now() + 15000;
                    if (!rafId) {
                        if (timeoutId) {
                            clearTimeout(timeoutId);
                            timeoutId = null;
                        }
                        rafStarted = false;
                        startLoop();
                    }
                } else {
                    activeUntil = 0;
                }
            });
        }
    } else {
        await ConfigManager.init();
        initSettingsUI();
    }
});
// ── State ──────────────────────────────────────────────────────────────────
let terminatorCache = null; //
let lastCacheTime = 0; //
let lastCacheWidth = -1; //
let lastCacheHeight = -1; //
let lastDrawTime = 0; //

// ── Astronomical helpers ───────────────────────────────────────────────────

function getDayOfYear(date) {
    const start = new Date(Date.UTC(date.getUTCFullYear(), 0, 1)); //
    return Math.floor((date - start) / 86400000) + 1; //
}

function getSubsolarPoint(date) {
    const n = getDayOfYear(date); //
    const declination = -23.44 * Math.cos((2 * Math.PI / 365.24) * (n + 10)); //
    const B = (2 * Math.PI / 365.24) * (n - 81); //
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); //
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600; //

    let longitude = 180 - utcH * 15 + eot / 4; //
    if (longitude < -180) longitude += 360; //
    if (longitude > 180) longitude -= 360; //

    return { declination, longitude, eot }; //
}

// ── Mercator projection ────────────────────────────────────────────────────

function latToMercatorY(lat) {
    const MAX_LAT = 82.007; // Cutoff for the background map
    lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const latRad = lat * (Math.PI / 180);
    const y = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    const maxY = Math.log(Math.tan(Math.PI / 4 + (MAX_LAT * Math.PI / 180) / 2));
    return 0.5 - (y / (2 * maxY));
}

// ── Terminator polygon ─────────────────────────────────────────────────────

function computeTerminatorPolygon(w, h) {
    const subsolar = getSubsolarPoint(new Date()); //
    const decRad = subsolar.declination * (Math.PI / 180); //
    const subLonRad = subsolar.longitude * (Math.PI / 180); //
    const pts = []; //

    for (let x = 0; x <= w; x += 2) { //
        const lon = (x / w) * 360 - 180; //
        const lonRad = lon * (Math.PI / 180); //

        let latRad; //
        if (Math.abs(subsolar.declination) < 0.001) { //
            latRad = Math.cos(lonRad - subLonRad) >= 0 ? Math.PI / 2 : -Math.PI / 2; //
        } else {
            latRad = Math.atan2(-Math.cos(lonRad - subLonRad), Math.tan(decRad)); //
        }

        const lat = latRad * (180 / Math.PI); //
        const y = latToMercatorY(lat) * h; //
        pts.push({ x, y }); //
    }

    const nightPoleY = subsolar.declination > 0 ? h : 0; //
    pts.push({ x: w, y: nightPoleY }); //
    pts.push({ x: 0, y: nightPoleY }); //

    return pts; //
}

// ── Feature Overlay Modules ────────────────────────────────────────────────

function drawStaticMap(winW, winH) {
    if (!isMapLoaded) {
        baseCtx.fillStyle = '#1a2540';
        baseCtx.fillRect(0, 0, winW, winH);
        baseCtx.fillStyle = '#ffffff';
        baseCtx.font = '18px sans-serif';
        baseCtx.fillText('Loading map asset…', 24, 24);
        return;
    }
    
    baseCtx.fillStyle = ThemeManager.currentTheme.bgColor;
    baseCtx.fillRect(0, 0, winW, winH);

    baseCtx.save();
    applyMapProjection(baseCtx, winW, winH);
    baseCtx.drawImage(mapImage, 0, 0, winW, winH);
    drawTimeZones(winW, winH);
    baseCtx.restore();
}

function drawTimeZones(mapW, mapH) {
    baseCtx.save();
    baseCtx.strokeStyle = ThemeManager.currentTheme.gridColor;
    baseCtx.setLineDash([4, 8]);
    baseCtx.lineWidth = 1;
    
    for (let h = -11; h <= 12; h++) {
        const lon = h * 15;
        const x = ((lon + 180) / 360) * mapW;
        baseCtx.beginPath();
        baseCtx.moveTo(x, 0);
        baseCtx.lineTo(x, mapH);
        baseCtx.stroke();
    }
    
    // Draw Equator Line
    baseCtx.beginPath();
    baseCtx.moveTo(0, mapH / 2);
    baseCtx.lineTo(mapW, mapH / 2);
    baseCtx.strokeStyle = ThemeManager.currentTheme.equatorColor;
    baseCtx.stroke();
    baseCtx.restore();
}

function drawLocationPins(mapW, mapH, rafTime) {
    ctx.save(); //
    config.pinnedLocations.forEach(loc => {
        const x = ((loc.lon + 180) / 360) * mapW; //
        const y = latToMercatorY(loc.lat) * mapH; //
        
        const pulseRadius = 4 + Math.abs(Math.sin(rafTime / 600)) * 7; //
        
        ctx.strokeStyle = ThemeManager.currentTheme.pinGlowColor; //
        ctx.lineWidth = 2; //
        ctx.beginPath(); //
        ctx.arc(x, y, pulseRadius, 0, Math.PI * 2); //
        ctx.stroke(); //
        
        ctx.beginPath(); //
        ctx.arc(x, y, 3, 0, Math.PI * 2); //
        ctx.fillStyle = ThemeManager.currentTheme.pinColor; //
        ctx.fill(); //
        
        ctx.font = '12px "Inter", -apple-system, sans-serif'; //
        ctx.textAlign = 'center'; //
        ctx.fillStyle = ThemeManager.currentTheme.pinTextColor; //
        ctx.fillText(` ${loc.name}`, x + 6, y + 3); //
    });

    ctx.restore(); //
}

// ── Initialization ─────────────────────────────────────────────────────────
// Initialization is now properly awaited in DOMContentLoaded via ConfigManager.init()

function drawSolarAnalemma(mapW, mapH, currentSubsolar) {
    if (config.showAnalemma === false) return; // Feature toggle

    ctx.save(); //
    ctx.strokeStyle = ThemeManager.currentTheme.equatorColor; //
    ctx.setLineDash([2, 4]); //
    ctx.lineWidth = 1.5; //
    ctx.beginPath(); //

    const dummyDate = new Date(); //
    const currentDay = getDayOfYear(dummyDate); //
    let currentDayX = 0; //
    let currentDayY = 0; //

    for (let d = 1; d <= 365; d++) { //
        dummyDate.setUTCMonth(0); //
        dummyDate.setUTCDate(d); //
        
        const declination = -23.44 * Math.cos((2 * Math.PI / 365.24) * (d + 10)); //
        const B = (2 * Math.PI / 365.24) * (d - 81); //
        const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); //
        const eotDeg = eot / 4; //
        
        const lon = currentSubsolar.longitude + eotDeg; //
        const x = ((lon + 180) / 360) * mapW; //
        const y = latToMercatorY(declination) * mapH; //

        if (d === 1) ctx.moveTo(x, y); //
        else ctx.lineTo(x, y); //

        if (d === currentDay) { //
            currentDayX = x; //
            currentDayY = y; //
        }
    }
    ctx.closePath(); //
    ctx.stroke(); //

    ctx.restore(); //
    ctx.save(); //
    ctx.fillStyle = ThemeManager.currentTheme.sunMarkerColor; //
    ctx.shadowColor = ThemeManager.currentTheme.sunGlowColor; //
    ctx.shadowBlur = 8; //
    ctx.beginPath(); //
    ctx.arc(currentDayX, currentDayY, 4, 0, Math.PI * 2); //
    ctx.fill(); //
    ctx.restore(); //
}



function renderTimeline(mapW, winW, offsetX, topY) {
    const now = new Date(); //
    const utcH = now.getUTCHours() + now.getUTCMinutes() / 60 + now.getUTCSeconds() / 3600; //

    ctx.fillStyle = ThemeManager.currentTheme.timelineBgColor; //
    ctx.fillRect(0, topY, winW, ThemeManager.currentTheme.timelineHeight); //
    
    ctx.fillStyle = ThemeManager.currentTheme.timelineTextColor; //
    ctx.strokeStyle = ThemeManager.currentTheme.timelineTickColor; //
    ctx.lineWidth = 1; //
    ctx.font = '11px "SF Mono", "Fira Mono", monospace'; //
    ctx.textAlign = 'center'; //
    ctx.textBaseline = 'middle'; //

    for (let h = 0; h < 24; h++) { //
        const lon = (h - utcH) * 15; //
        let xScreen = (lon + 180) / 360 * winW; //
        xScreen = ((xScreen % winW) + winW) % winW; //
        const xWin = xScreen - offsetX; //

        if (xWin < -60 || xWin > winW + 60) continue; //

        const isQuarter = h % 6 === 0; //
        const tickH = isQuarter ? 10 : 5; //
        ctx.beginPath(); //
        ctx.moveTo(xWin, topY + ThemeManager.currentTheme.timelineHeight - tickH); //
        ctx.lineTo(xWin, topY + ThemeManager.currentTheme.timelineHeight); //
        ctx.stroke(); //

        const label = String(h).padStart(2, '0') + ':00'; //
        ctx.fillStyle = isQuarter ? '#ffffff' : ThemeManager.currentTheme.timelineTextColor; //
        ctx.fillText(label, xWin, topY + (ThemeManager.currentTheme.timelineHeight - tickH) / 2); //
    }
}

// ── Projection & Crop ──────────────────────────────────────────────────────

function applyMapProjection(ctx, winW, winH) {
    if (!isMapLoaded) return;
    
    const mapAspect = mapImage.naturalWidth / mapImage.naturalHeight;
    const screenAspect = winW / winH;
    
    let drawW, drawH;
    if (screenAspect > mapAspect) {
        // Screen is wider than the map: scale to fit width
        drawW = winW;
        drawH = winW / mapAspect;
    } else {
        // Screen is taller than the map: scale to fit height
        drawH = winH;
        drawW = drawH * mapAspect;
    }
    
    // Center horizontally
    const offsetX = (winW - drawW) / 2;
    
    // Calculate how much the map overflows the screen vertically
    const overflowY = Math.max(0, drawH - winH);
    
    const offsetY = -overflowY / 2;
    
    // Clip the rendering to the screen bounds
    ctx.beginPath();
    ctx.rect(0, 0, winW, winH);
    ctx.clip();
    
    // Transform context so the 0..winW, 0..winH rendering code automatically 
    // stretches correctly across the newly scaled and shifted projection.
    ctx.translate(offsetX, offsetY);
    ctx.scale(drawW / winW, drawH / winH);
}

// ── WebGL GPU Terminator (Module 4) ────────────────────────────────────────

let glCanvas = null;
let glContext = null;
let glProgram = null;
let glLocs = {};
let glInitialized = false;
let glFailed = false;
let glBuffer = null;
let cityLightsTexture = null;
let cityLightsUploaded = false;
let glShaderSources = { vert: null, frag: null }; // Populated by ThemeManager.loadTheme()

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("[WebGL] Shader compile error:", gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function initWebGLShader(winW, winH) {
    if (glFailed) return false;
    if (glInitialized) {
        if (glCanvas.width !== winW || glCanvas.height !== winH) {
            glCanvas.width = winW;
            glCanvas.height = winH;
            glContext.viewport(0, 0, winW, winH);
        }
        return true;
    }
    
    try {
        glCanvas = document.createElement('canvas');
        glCanvas.width = winW;
        glCanvas.height = winH;
        glContext = glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
        if (!glContext) throw new Error("WebGL context not available");
        
        // Use externally-loaded shader source (from active theme) or fall back to inline defaults
        const vsSource = glShaderSources.vert ?? `
            attribute vec2 aVertexPosition;
            varying vec2 vUv;
            void main() {
                vUv = aVertexPosition * 0.5 + 0.5;
                vUv.y = 1.0 - vUv.y;
                gl_Position = vec4(aVertexPosition, 0.0, 1.0);
            }
        `;
        
        const fsSource = glShaderSources.frag ?? `
            precision mediump float;
            varying vec2 vUv;
            uniform vec2 uSubsolar; // x = lon, y = lat
            uniform vec4 uColor;
            uniform sampler2D uCityLights;
            
            #define PI 3.14159265359
            
            void main() {
                float lon = (vUv.x - 0.5) * 360.0;
                float y_merc = (0.5 - vUv.y) * 2.0 * 2.66068;
                float latRad = 2.0 * atan(exp(y_merc)) - PI / 2.0;
                float lonRad = lon * PI / 180.0;
                float subLatRad = uSubsolar.y * PI / 180.0;
                float subLonRad = uSubsolar.x * PI / 180.0;
                
                float cosAngle = sin(latRad)*sin(subLatRad) + cos(latRad)*cos(subLatRad)*cos(lonRad - subLonRad);
                
                // Twilight zone transition (cosAngle from 0.0 to -0.20)
                float alpha = smoothstep(0.0, -0.20, cosAngle);
                
                // Sample city lights mask (greyscale)
                float lightsMask = texture2D(uCityLights, vUv).r;
                
                vec3 shadowColor = uColor.rgb;
                float shadowAlpha = uColor.a * alpha;
                
                // Warm golden glow for lights, only visible on the night side (alpha)
                vec3 lightsColor = vec3(1.0, 0.88, 0.52);
                float lightsAlpha = lightsMask * alpha * 0.95;
                
                vec3 finalRgb = mix(shadowColor, lightsColor, lightsAlpha);
                float finalAlpha = max(shadowAlpha, lightsAlpha);
                
                gl_FragColor = vec4(finalRgb, finalAlpha);
            }
        `;
        
        const vs = compileShader(glContext, glContext.VERTEX_SHADER, vsSource);
        const fs = compileShader(glContext, glContext.FRAGMENT_SHADER, fsSource);
        
        if (!vs || !fs) throw new Error("Shader compilation failed");
        
        glProgram = glContext.createProgram();
        glContext.attachShader(glProgram, vs);
        glContext.attachShader(glProgram, fs);
        glContext.linkProgram(glProgram);
        
        if (!glContext.getProgramParameter(glProgram, glContext.LINK_STATUS)) {
            throw new Error("Program link failed");
        }
        
        glLocs = {
            position: glContext.getAttribLocation(glProgram, 'aVertexPosition'),
            subsolar: glContext.getUniformLocation(glProgram, 'uSubsolar'),
            color: glContext.getUniformLocation(glProgram, 'uColor'),
            cityLights: glContext.getUniformLocation(glProgram, 'uCityLights')
        };
        
        glBuffer = glContext.createBuffer();
        glContext.bindBuffer(glContext.ARRAY_BUFFER, glBuffer);
        const positions = new Float32Array([
            -1.0, -1.0,   1.0, -1.0,   -1.0,  1.0,
            -1.0,  1.0,   1.0, -1.0,    1.0,  1.0
        ]);
        glContext.bufferData(glContext.ARRAY_BUFFER, positions, glContext.STATIC_DRAW);
        
        cityLightsTexture = glContext.createTexture();
        glContext.bindTexture(glContext.TEXTURE_2D, cityLightsTexture);
        glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA, 1, 1, 0, glContext.RGBA, glContext.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MIN_FILTER, glContext.LINEAR);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_MAG_FILTER, glContext.LINEAR);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_S, glContext.CLAMP_TO_EDGE);
        glContext.texParameteri(glContext.TEXTURE_2D, glContext.TEXTURE_WRAP_T, glContext.CLAMP_TO_EDGE);
        cityLightsUploaded = false;
        
        glInitialized = true;
        return true;
    } catch (e) {
        console.warn("[WebGL] Shader initialization failed, falling back to CPU", e);
        glFailed = true;
        return false;
    }
}

function renderWebGLTerminator(ctx2d, winW, winH, subsolarPoint, r, g, b, a) {
    if (cityLightsImage.complete && !cityLightsUploaded && glContext) {
        glContext.bindTexture(glContext.TEXTURE_2D, cityLightsTexture);
        glContext.pixelStorei(glContext.UNPACK_FLIP_Y_WEBGL, false);
        glContext.texImage2D(glContext.TEXTURE_2D, 0, glContext.RGBA, glContext.RGBA, glContext.UNSIGNED_BYTE, cityLightsImage);
        cityLightsUploaded = true;
        console.log("[WebGL] City lights texture uploaded successfully.");
    }

    glContext.viewport(0, 0, winW, winH);
    glContext.clearColor(0, 0, 0, 0);
    glContext.clear(glContext.COLOR_BUFFER_BIT);
    
    glContext.useProgram(glProgram);
    
    glContext.bindBuffer(glContext.ARRAY_BUFFER, glBuffer);
    glContext.vertexAttribPointer(glLocs.position, 2, glContext.FLOAT, false, 0, 0);
    glContext.enableVertexAttribArray(glLocs.position);
    
    glContext.uniform2f(glLocs.subsolar, subsolarPoint.longitude, subsolarPoint.declination);
    glContext.uniform4f(glLocs.color, r / 255, g / 255, b / 255, a);
    
    glContext.activeTexture(glContext.TEXTURE0);
    glContext.bindTexture(glContext.TEXTURE_2D, cityLightsTexture);
    glContext.uniform1i(glLocs.cityLights, 0);
    
    glContext.drawArrays(glContext.TRIANGLES, 0, 6);
    
    ctx2d.drawImage(glCanvas, 0, 0, winW, winH);
}

// ── Main render loop ───────────────────────────────────────────────────────

function drawFrame(rafTime) {
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    // 1. Clear dynamic overlay
    ctx.clearRect(0, 0, winW, winH);

    // Apply viewport projection to prevent stretching and crop Antarctica
    ctx.save();
    applyMapProjection(ctx, winW, winH);

    // 2. Draw night-shadow terminator polygon
    const subsolar = getSubsolarPoint(new Date());
    const colors = ThemeManager.currentTheme.shadowColorHex.split(',').map(n => parseInt(n.trim()));
    const useGpu = ThemeManager.currentTheme.use_gpu_shader;
    const shadowOpacity = config.shadowOpacity / 100;
    
    if (useGpu && initWebGLShader(winW, winH)) {
        renderWebGLTerminator(ctx, winW, winH, subsolar, colors[0]||0, colors[1]||0, colors[2]||0, shadowOpacity);
    } else {
        // Fallback: CPU polygon rendering
        const sizeChanged = winW !== lastCacheWidth || winH !== lastCacheHeight;
        if (!terminatorCache || rafTime - lastCacheTime > CACHE_LIFETIME || sizeChanged) {
            terminatorCache = computeTerminatorPolygon(winW, winH);
            lastCacheTime = rafTime;
            lastCacheWidth = winW;
            lastCacheHeight = winH;
        }

        ctx.fillStyle = `rgba(${ThemeManager.currentTheme.shadowColorHex}, ${shadowOpacity})`;

        ctx.beginPath();
        ctx.moveTo(terminatorCache[0].x, terminatorCache[0].y);
        for (let i = 1; i < terminatorCache.length; i++) {
            ctx.lineTo(terminatorCache[i].x, terminatorCache[i].y);
        }
        ctx.closePath();
        ctx.fill();
    }

    // 5. Draw advanced astronomical and positional layers over the map space
    drawSolarAnalemma(winW, winH, subsolar);
    drawLocationPins(winW, winH, rafTime);

    // Restore coordinate system to standard for UI overlays
    ctx.restore();

    // 6. Draw linear layout timeline strip
    const MAC_OS_MENU_BAR_OFFSET = 40;
    const timelineY = MAC_OS_MENU_BAR_OFFSET;
    renderTimeline(winW, winW, 0, timelineY);
}

function render(rafTime) {
    if (document.hidden || isWindowOccluded) {
        rafId = null;
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        rafStarted = false;
        return;
    }

    drawFrame(rafTime);
    lastDrawTime = rafTime;

    rafId = null;
    if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
    }
    rafStarted = false;

    startLoop();
}

// ── Visibility API Handler ────────────────────────────────────────────────
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = null;
        }
        if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
        }
        rafStarted = false;
    } else {
        lastDrawTime = 0;
        startLoop();
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
