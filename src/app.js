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
        const baseDir = tauriFs.BaseDirectory;
        const appData = baseDir.AppData;

        // Check if themes/mercator-classic exists in AppData
        const hasTheme = await tauriFs.exists("themes/mercator-classic", { baseDir: appData });
        if (!hasTheme) {
            console.log("[Novaframe] Provisioning default theme to AppData...");
            
            // Create target folders recursively
            await tauriFs.mkdir("themes/mercator-classic", { baseDir: appData, recursive: true });
            
            // Fetch default manifest.json from local build folder assets
            const manifestRes = await fetch("themes/mercator-classic/manifest.json");
            if (!manifestRes.ok) throw new Error("manifest.json not found in bundle");
            const manifestText = await manifestRes.text();
            
            // Write manifest.json to AppData
            await tauriFs.writeTextFile("themes/mercator-classic/manifest.json", manifestText, { baseDir: appData });
            
            // Fetch default map image
            const mapRes = await fetch("themes/mercator-classic/world-map-mercator.jpg");
            if (!mapRes.ok) throw new Error("world-map-mercator.jpg not found in bundle");
            const mapBuf = await mapRes.arrayBuffer();
            
            // Write map image to AppData
            await tauriFs.writeFile("themes/mercator-classic/world-map-mercator.jpg", new Uint8Array(mapBuf), { baseDir: appData });
            
            console.log("[Novaframe] Default theme provisioned successfully in AppData.");
        }
    } catch (err) {
        console.error("[Novaframe] Failed to provision default theme in AppData:", err);
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
        // CONTROLS MODE: Transparent 300px window anchored right
        document.getElementById('container').style.display = 'none';
        document.body.style.backgroundColor = 'transparent';
        document.documentElement.style.backgroundColor = 'transparent'; 
        
        const panel = document.getElementById('settingsPanel');
        panel.style.top = '0px';
        panel.style.height = '100vh';
        panel.style.left = '0px'; 
        panel.style.right = 'auto';

        if (window.__TAURI__ && window.__TAURI__.core) {
            const notifyActive = () => {
                if (window.__TAURI__ && window.__TAURI__.event) {
                    window.__TAURI__.event.emit('settings-active', true);
                }
            };
            window.addEventListener('mousemove', notifyActive);
            window.addEventListener('mousedown', notifyActive);
            window.addEventListener('keydown', notifyActive);

            let debounceTimeout = null;
            let targetState = null;

            const debounceAction = (state, actionFn) => {
                targetState = state;
                if (debounceTimeout) clearTimeout(debounceTimeout);
                debounceTimeout = setTimeout(async () => {
                    if (targetState === state) {
                        await actionFn();
                    }
                }, 16);
            };

            panel.addEventListener('mouseenter', () => {
                debounceAction('expanded', async () => {
                    try { await window.__TAURI__.core.invoke('expand_settings_panel'); } catch (e) { console.error(e); }
                    notifyActive();
                });
            });

            panel.addEventListener('mouseleave', () => {
                debounceAction('collapsed', async () => {
                    try { await window.__TAURI__.core.invoke('collapse_settings_panel'); } catch (e) { console.error(e); }
                    if (window.__TAURI__ && window.__TAURI__.event) {
                        window.__TAURI__.event.emit('settings-active', false);
                    }
                });
            });
        }
    }
}

// ── Canvas & context setup ─────────────────────────────────────────────────
const baseCanvas = document.getElementById('novaframeCanvas');
const baseCtx = baseCanvas.getContext('2d', { alpha: false });

const canvas = document.getElementById('overlayCanvas');
const ctx = canvas.getContext('2d', { alpha: true });

// ── Theme Manager ──────────────────────────────────────────────────────────
const ThemeManager = {
    currentTheme: {
        mapImageSrc: 'assets/world-map-mercator.jpg',
        bgColor: '#0f141d',
        timelineHeight: 40,
        timelineBgColor: 'rgba(0, 5, 20, 0.78)',
        timelineTickColor: 'rgba(160, 180, 255, 0.45)',
        timelineTextColor: '#e0e8ff',
        shadowColorHex: '0, 8, 24', // RGB comma separated for opacity injection
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
    },
    
    async loadTheme(themePath) {
        if (!themePath) {
            this.fallbackToLegacy();
            return;
        }

        try {
            const manifestUri = window.__TAURI__.core.convertFileSrc(`${themePath}/manifest.json`);
            const response = await fetch(manifestUri);
            if (!response.ok) throw new Error("Manifest not found at " + manifestUri);
            
            const manifest = await response.json();
            
            const imageUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${manifest.assets.background_image}`);
            
            const imgResponse = await fetch(imageUri, { method: 'HEAD' });
            if (!imgResponse.ok) throw new Error("Map image missing at " + imageUri);

            this.currentTheme = {
                ...this.currentTheme,
                ...manifest.settings
            };
            this.currentTheme.mapImageSrc = imageUri;

            // Load external shader sources if the theme declares a render_engine block
            if (manifest.render_engine && manifest.render_engine.vertex_shader && manifest.render_engine.fragment_shader) {
                const vertUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${manifest.render_engine.vertex_shader}`);
                const fragUri = window.__TAURI__.core.convertFileSrc(`${themePath}/${manifest.render_engine.fragment_shader}`);
                const [vertRes, fragRes] = await Promise.all([fetch(vertUri), fetch(fragUri)]);
                if (!vertRes.ok) throw new Error("Vertex shader missing at " + vertUri);
                if (!fragRes.ok) throw new Error("Fragment shader missing at " + fragUri);
                glShaderSources.vert = await vertRes.text();
                glShaderSources.frag = await fragRes.text();
                glInitialized = false; // Force WebGL re-init with new shader sources
                console.log("[Novaframe] External shaders loaded from theme:", manifest.render_engine);
            } else {
                glShaderSources.vert = null; // Reset to inline fallback
                glShaderSources.frag = null;
            }
            
            this.applyThemeToDOM();
            await ConfigManager.setTheme(themePath);
        } catch (err) {
            console.error("[Novaframe] Theme load failed, gracefully falling back to legacy internal map:", err);
            this.fallbackToLegacy();
        }
    },
    
    fallbackToLegacy() {
        this.currentTheme = {
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
        this.applyThemeToDOM();
        ConfigManager.setTheme(null);
    },

    applyThemeToDOM() {
        mapImage.src = this.currentTheme.mapImageSrc;
        document.documentElement.style.backgroundColor = this.currentTheme.bgColor;
        document.body.style.backgroundColor = this.currentTheme.bgColor;
    }
};

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
    ]
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
            
            // Periodically sync config in wallpaper mode if changed from settings panel
            setInterval(async () => {
                const latestConfig = await this.store.get('novaframe_config');
                if (latestConfig) config = latestConfig;
                
                // Theme sync
                const latestTheme = await this.store.get('activeTheme');
                const normLatest = latestTheme || null;
                const normCurrent = ThemeManager.currentThemePath || null;
                if (normLatest !== normCurrent) {
                    ThemeManager.currentThemePath = normLatest;
                    ThemeManager.loadTheme(normLatest);
                }
            }, 1000);
            
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
                if (window.__TAURI__.event.emitTo) {
                    await window.__TAURI__.event.emitTo('main', 'config-changed', config);
                } else {
                    await window.__TAURI__.event.emit('config-changed', config);
                }
            } catch (e) {
                console.error("[Novaframe] Config emit failed:", e);
            }
        }
    },
    async getTheme() {
        if (this.store) return await this.store.get('activeTheme');
        return localStorage.getItem('activeTheme');
    },
    async setTheme(themePath) {
        ThemeManager.currentThemePath = themePath;
        if (this.store) {
            if (themePath) await this.store.set('activeTheme', themePath);
            else await this.store.delete('activeTheme');
            await this.store.save();
        }
        if (themePath) {
            localStorage.setItem('activeTheme', themePath);
        } else {
            localStorage.removeItem('activeTheme');
        }

        if (window.__TAURI__ && window.__TAURI__.event) {
            try {
                if (window.__TAURI__.event.emitTo) {
                    await window.__TAURI__.event.emitTo('main', 'theme-changed', themePath);
                } else {
                    await window.__TAURI__.event.emit('theme-changed', themePath);
                }
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

// ── Bind UI Event Listeners ───────────────────────────────────────────────
function initSettingsUI() {
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
    scanThemes();
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
        const entries = await tauriFs.readDir(themesDir);
        
        for (const entry of entries) {
            if (entry.isDirectory) {
                const themePath = `${themesDir}/${entry.name}`;
                try {
                    const option = document.createElement('option');
                    option.value = themePath;
                    option.textContent = entry.name;
                    selector.appendChild(option);
                } catch(e) {}
            }
        }
        
        const activeTheme = await ConfigManager.getTheme();
        if (activeTheme) {
            selector.value = activeTheme;
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
            const token = event.payload;
            console.log("[Novaframe] Received apply theme request from deep link with token:", token);
            
            try {
                const response = await fetch('https://api.novaframe.co.uk/api/engine/verify-token', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token })
                });
                
                const data = await response.json();
                
                if (response.ok && data.success) {
                    const wallpaperId = data.wallpaper.id;
                    const downloadUrl = data.wallpaper.downloadUrl;
                    
                    // Call the Rust command to download and install the theme
                    console.log(`[Novaframe] Invoking Rust to download and install theme ${wallpaperId}...`);
                    const installedThemeId = await window.__TAURI__.core.invoke('download_and_install_theme', { 
                        url: downloadUrl,
                        themeId: wallpaperId
                    });
                    
                    console.log(`[Novaframe] Theme ${installedThemeId} installed successfully! Loading it...`);
                    
                    // Switch to the newly installed theme
                    await ConfigManager.setTheme(installedThemeId);
                    
                } else {
                    console.error("Token verification failed:", data.error);
                    alert("License Verification Failed: " + data.error);
                }
            } catch (err) {
                console.error("Error verifying token:", err);
                alert("Error verifying license token.");
            }
        });
    }

    selector.addEventListener('change', async (e) => {
        const selected = e.target.value;
        await ConfigManager.setTheme(selected);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    // Standalone Storage Fallback listener (cross-origin browser support)
    window.addEventListener('storage', (e) => {
        if (e.key === 'activeTheme') {
            const newTheme = e.newValue || null;
            if (newTheme !== ThemeManager.currentThemePath) {
                ThemeManager.currentThemePath = newTheme;
                ThemeManager.loadTheme(newTheme);
            }
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
        initSettingsUI();

        if (window.__TAURI__.event) {
            // Inter-window event triggers
            window.__TAURI__.event.listen('theme-changed', (event) => {
                const newTheme = event.payload || null;
                if (newTheme !== ThemeManager.currentThemePath) {
                    ThemeManager.currentThemePath = newTheme;
                    ThemeManager.loadTheme(newTheme);
                }
            });

            window.__TAURI__.event.listen('config-changed', (event) => {
                if (event.payload) {
                    config = event.payload;
                }
            });

            window.__TAURI__.event.listen('occlusion-change', (event) => {
                const isVisible = event.payload;
                isWindowOccluded = !isVisible;
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
