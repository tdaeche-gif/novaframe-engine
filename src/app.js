console.log("[Novaframe] bundle sentinel: novaframe-app-v0.4.0-settings-fix");

// ── Tauri API imports ────────────────────────────────────────────────────────
// withGlobalTauri is false — window.__TAURI__ is NOT injected. All Tauri APIs
// must come from these imports. esbuild bundles this into src/app.bundle.js.
import { invoke } from '@tauri-apps/api/core';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { readDir, remove } from '@tauri-apps/plugin-fs';
import { Store } from '@tauri-apps/plugin-store';
import { check as updaterCheck } from '@tauri-apps/plugin-updater';
import { relaunch, exit as processExit } from '@tauri-apps/plugin-process';

import {
    ENGINE_MANIFEST_VERSION,
    IS_WINDOWS_WEBVIEW,
    manifestNeedsNewerEngine,
    toThemeUrl
} from './modules/constants.js';
import { getMode, isMainWindow, isSettingsWindow } from './modules/windowEnv.js';

import {
    safeInvoke,
    getThemesDir,
    getHardwareId,
    setIgnoreCursor,
    reportJsError
} from './modules/tauriBridge.js';



// Keep the docked settings panel expanded while a native <select> has its OS
// popup open. The popup renders outside the panel window's own frame (often
// above it, since the panel is docked to the screen edge) — without this, the
// Rust hover-poll loop sees the cursor leave the window bounds mid-selection
import { setPanelLocked, POPUP_CONTROLS, initPanelLockDelegation } from './modules/panelLock.js';


// Check and provision default theme inside system AppData on startup
async function verifyAndProvisionAppData() {
    try {
        const themesDir = await getThemesDir();

        // ── Fix #4: Clean up empty mercator-classic folder ────────────────────
        // If mercator-classic was created empty (from a prior failed provision), remove it.
        // An empty folder appears in the dropdown but has no manifest → always falls back to Internal-Legacy.
        const mercatorPath = `${themesDir}/mercator-classic`;
        try {
            const files = await readDir(mercatorPath);
            if (!files || files.length === 0) {
                console.log("[Novaframe] Removing empty mercator-classic folder from AppData...");
                await remove(mercatorPath, { recursive: true });
            }
        } catch (e) {
            // Folder doesn't exist yet — that's fine
        }

    } catch (err) {
        console.error("[Novaframe] Failed to verify AppData:", err);
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
        applyThemeScope(ThemeManager.currentManifest);
    }
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

import {
    ThemeManager,
    applyThemeScope,
    pushCurrentOcclusion,
    relayThemeSettingsToIframe,
    getLastKnownOcclusion,
    setLastKnownOcclusion
} from './modules/themeManager.js';

// ── Mouse passthrough to iframe (for interactive themes like Ignis) ────────
let mousePending = false;
let lastX = NaN, lastY = NaN;
window.addEventListener('mousemove', (e) => {
    if (mousePending) return;
    if (lastX === e.clientX && lastY === e.clientY) return;
    const dx = Math.abs(e.clientX - lastX), dy = Math.abs(e.clientY - lastY);
    if (!isNaN(dx) && dx < 1.5 && dy < 1.5) return;
    lastX = e.clientX;
    lastY = e.clientY;

    mousePending = true;
    requestAnimationFrame(() => {
        mousePending = false;
        const iframe = ThemeManager?.currentIframe;
        if (!iframe || iframe.style.display === 'none' || !iframe.contentWindow) return;
        try {
            iframe.contentWindow.postMessage({
                type: 'novaframe-pointer',
                x: e.clientX, y: e.clientY,
                nx: e.clientX / window.innerWidth,
                ny: e.clientY / window.innerHeight
            }, '*');
        } catch (_) {}
    });
});


// ── Constants & Configuration ──────────────────────────────────────────────

// ── State Persistence Configurations (ConfigManager) ───────────────────────
import {
    DEFAULT_CONFIG,
    getConfig,
    setConfig,
    patchConfig,
    getThemeSettings,
    setThemeSettings
} from './modules/state.js';

let config = getConfig();


const ConfigManager = {
    store: null,
    async init() {
        try {
            this.store = await Store.load("novaframe_config.json");
            
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
            
            config = setConfig((await this.store.get('novaframe_config')) || DEFAULT_CONFIG);
        } catch (e) {
            console.error("[ConfigManager] Native store failed:", e);
            config = setConfig(JSON.parse(localStorage.getItem('novaframe_config')) || DEFAULT_CONFIG);
        }
    },
    async saveConfig() {
        config = setConfig(config);
        if (this.store) {
            await this.store.set('novaframe_config', config);
            await this.store.save();
        }
        localStorage.setItem('novaframe_config', JSON.stringify(config));

        try {
            await emit('config-changed', config);
        } catch (e) {
            console.error("[Novaframe] Config emit failed:", e);
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

        try {
            // Broadcast to all windows. The listener now dedupes against
            // currentThemePath so echoes don't trigger re-renders.
            await emit('theme-changed', next);
        } catch (e) {
            console.error("[Novaframe] Theme emit failed:", e);
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
                    btn.addEventListener('click', async () => {
                        // Optimistic local update (e.g. for the preview iframe in the settings window)
                        if (ThemeManager.currentIframe?.contentWindow) {
                            ThemeManager.currentIframe.contentWindow.postMessage({
                                type: 'novaframe-settings',
                                settings: { [setting.id]: true }
                            }, '*');

                        }
                        
                        // Broadcast to other windows (specifically the background underlay window)
                        try {
                            await emit('theme-action', setting.id);
                        } catch (e) {
                            console.error("[Novaframe] Theme action emit failed:", e);
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
    // 1. Wire the exit button — fully quits the engine so the user never needs Task Manager
    const quitBtn = document.getElementById('quitEngineBtn');
    if (quitBtn && !quitBtn._wired) {
        quitBtn._wired = true;
        quitBtn.addEventListener('click', async () => {
            console.log('[Novaframe] Exit button clicked — quitting engine');
            try {
                await invoke('quit_engine');
            } catch (err) {
                console.error('[Novaframe] quit_engine invoke failed:', err);
            }
        });
    }

    // 2. Wire the Browse Marketplace and reload buttons
    const selector = document.getElementById('themeSelector');
    if (selector) {
        selector.addEventListener('change', async (e) => {
            const selected = e.target.value;
            await ConfigManager.setTheme(selected);
        });
    }

    const refreshBtn = document.getElementById('refreshThemeBtn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            try { await emit('theme-reload'); } catch (_) {
                if (ThemeManager.currentThemePath) {
                    ThemeManager.loadTheme(ThemeManager.currentThemePath, true);
                }
            }
        });
    }

    const openStoreBtn = document.getElementById('openStoreBtn');
    if (openStoreBtn && !openStoreBtn._wired) {
        openStoreBtn._wired = true;
        openStoreBtn.addEventListener('click', async () => {
            await invoke('open_storefront_window').catch(err =>
                console.error("[Novaframe] open_storefront_window failed:", err)
            );
        });
    }

    // 3. Wire the "Launch on startup" toggle
    const autostartToggle = document.getElementById('autostartToggle');
    if (autostartToggle) {
        try {
            autostartToggle.checked = await invoke('get_autostart');
        } catch (err) {
            console.error('[Novaframe] get_autostart failed:', err);
        }
        autostartToggle.addEventListener('change', async (e) => {
            const enabled = e.target.checked;
            try {
                await invoke('set_autostart', { enabled });
            } catch (err) {
                console.error('[Novaframe] set_autostart failed:', err);
                e.target.checked = !enabled;
            }
        });
    }

    // 4. Library management, rotation and power controls
    initDeleteThemeButton();
    initBatterySaverToggle();
    initRotationControls();

    // 5. Scan available themes and update active theme selection
    await scanThemes();
    
    const activeTheme = await ConfigManager.getTheme();
    console.log("[Novaframe] Active theme from config:", activeTheme);
    if (activeTheme && selector) {
        selector.value = activeTheme;
    }
    
    updateSettingsScope(activeTheme);
}

// ── Library management ─────────────────────────────────────────────────────
// Until now the only way to remove a wallpaper was to find AppData by hand.
// The engine installs one theme per purchase and never removed anything, so a
// library grew monotonically and the dropdown with it.
function initDeleteThemeButton() {
    const btn = document.getElementById('deleteThemeBtn');
    const selector = document.getElementById('themeSelector');
    if (!btn || !selector) return;

    btn.addEventListener('click', async () => {
        const themePath = selector.value;
        if (!themePath) return;

        const label = ThemeManager.manifestCache[themePath]?.label || 'this wallpaper';
        const dirName = themePath.split('/').pop();

        const ok = await confirmInPanel(
            `Remove "${label}" from this machine? You can re-apply it any time from My Vault.`,
            'Remove'
        );
        if (!ok) return;

        try {
            await invoke('delete_theme', { name: dirName });
        } catch (err) {
            console.error('[Novaframe] delete_theme failed:', err);
            alertInPanel(`Could not remove that wallpaper: ${err}`);
            return;
        }

        // Forget the cached manifest and the active-theme pointer, then rescan:
        // scanThemes auto-selects the first remaining theme when the active one
        // is gone, which is exactly the behaviour wanted here.
        delete ThemeManager.manifestCache[themePath];
        if ((await ConfigManager.getTheme()) === themePath) {
            await ConfigManager.setTheme('');
        }
        await scanThemes();
        updateSettingsScope(await ConfigManager.getTheme());
    });
}

// ── Pause on battery ───────────────────────────────────────────────────────
function initBatterySaverToggle() {
    const toggle = document.getElementById('batterySaverToggle');
    if (!toggle) return;

    toggle.checked = config.pause_on_battery === true;
    // Rust holds this in an atomic that resets on every launch, so push the
    // saved value back in at startup rather than waiting for a user change.
    invoke('set_battery_saver', { enabled: toggle.checked })
        .catch(err => console.error('[Novaframe] set_battery_saver failed:', err));

    toggle.addEventListener('change', async (e) => {
        const enabled = e.target.checked;
        config.pause_on_battery = enabled;
        await ConfigManager.saveConfig();
        try {
            await invoke('set_battery_saver', { enabled });
        } catch (err) {
            console.error('[Novaframe] set_battery_saver failed:', err);
        }
    });
}

// ── Rotation ───────────────────────────────────────────────────────────────
// Owned by the settings window alone. The main window already polls the store
// for `activeTheme` once a second, so switching the theme here propagates
// through the existing path — no second mount mechanism, no risk of both
// windows rotating out of step.
let _rotationTimer = null;

function initRotationControls() {
    const toggle = document.getElementById('rotationToggle');
    const intervalRow = document.getElementById('rotationIntervalRow');
    const intervalSelect = document.getElementById('rotationInterval');
    if (!toggle || !intervalSelect || !intervalRow) return;

    toggle.checked = config.rotation_enabled === true;
    intervalSelect.value = String(config.rotation_interval_min || 60);
    intervalRow.style.display = toggle.checked ? 'block' : 'none';

    toggle.addEventListener('change', async (e) => {
        config.rotation_enabled = e.target.checked;
        intervalRow.style.display = e.target.checked ? 'block' : 'none';
        await ConfigManager.saveConfig();
        startRotationTimer();
    });

    intervalSelect.addEventListener('change', async (e) => {
        config.rotation_interval_min = Number(e.target.value) || 60;
        await ConfigManager.saveConfig();
        startRotationTimer();
    });

    startRotationTimer();
}

function startRotationTimer() {
    if (_rotationTimer) {
        clearInterval(_rotationTimer);
        _rotationTimer = null;
    }
    if (!config.rotation_enabled) return;

    const minutes = Number(config.rotation_interval_min) || 60;
    _rotationTimer = setInterval(rotateToNextTheme, minutes * 60 * 1000);
}

async function rotateToNextTheme() {
    const selector = document.getElementById('themeSelector');
    if (!selector) return;

    const options = Array.from(selector.querySelectorAll('option')).filter(o => o.value !== '');
    // One wallpaper isn't a rotation; two or more is.
    if (options.length < 2) return;

    const current = await ConfigManager.getTheme();
    const index = options.findIndex(o => o.value === current);
    const next = options[(index + 1) % options.length];
    if (!next || next.value === current) return;

    selector.value = next.value;
    await ConfigManager.setTheme(next.value);
    updateSettingsScope(next.value);
    console.log('[Novaframe] rotation → ', next.textContent);
}

// ── Dynamic Theme Scanner (Module 1) ───────────────────────────────────────
async function scanThemes() {
    const selector = document.getElementById('themeSelector');
    if (!selector) return;
    
    selector.innerHTML = '<option value="" disabled selected>Select Wallpaper</option>';
    
    const tauriFs = { readDir };
    if (!tauriFs) return;
    
    try {
        const themesDir = await getThemesDir();
        console.log("[Novaframe] Scanning themes directory:", themesDir);
        const entries = await tauriFs.readDir(themesDir);
        console.log("[Novaframe] Found entries:", entries);
        
        // Read all manifests in parallel — sequential awaits made panel-open
        // latency scale linearly with installed theme count.
        const themeDirs = entries.filter(entry => entry?.name && !entry.name.startsWith('.'));
        if (themeDirs.length === 0 && entries.length > 0) {
            console.warn('[Novaframe] scanThemes: every entry was filtered out', entries);
        }

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
                const renderMode = manifest.render_mode || 'external-html';
                return {
                    themePath,
                    label: manifest.name || entry.name,
                    mode: renderMode,
                    render_mode: renderMode,
                    custom_settings: manifest.custom_settings || null,
                    // Used by checkThemeContentUpdates: theme_id is the
                    // marketplace wallpaper UUID, version the installed build.
                    theme_id: manifest.theme_id || null,
                    version: manifest.version || null
                };
            } catch (scanErr) {
                console.warn("[Novaframe] scanThemes skipped directory:", themePath, scanErr);
                return null;
            }
        }));
        for (const t of scanned) {
            if (!t) continue;
            const { themePath, label, mode, render_mode, custom_settings, theme_id, version } = t;
            ThemeManager.manifestCache[themePath] = { label, mode, render_mode, custom_settings, theme_id, version };

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
            const inSettingsWindow = window.location.search.includes('mode=settings');
            if (!inSettingsWindow) {
                ThemeManager.loadTheme(targetTheme);
            }
        }
        
    } catch (e) {
        console.error("[Novaframe] scanThemes failed:", e);
    }
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
const applyQueue = [];
let isProcessingApplyQueue = false;

async function processApplyQueue() {
    if (isProcessingApplyQueue || applyQueue.length === 0) return;
    isProcessingApplyQueue = true;

    while (applyQueue.length > 0) {
        const token = applyQueue.shift();
        const TAG = '[Main]';
        const stamp = `[${Date.now() % 100000}]`;
        console.log(TAG, stamp, 'engine-apply-theme processing token len:', token?.length ?? 0);

        try {
            const applyTask = invoke('handle_engine_apply', { token });
            const timeoutTask = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Engine apply timed out after 15s')), 15000)
            );
            const installedThemeId = await Promise.race([applyTask, timeoutTask]);
            console.log(TAG, stamp, `✅ Rust handle_engine_apply returned dir=${installedThemeId}`);

            const themesDir = await getThemesDir();
            const absoluteThemePath = `${themesDir}/${installedThemeId}`;
            await ConfigManager.setTheme(absoluteThemePath);
            console.log(TAG, stamp, 'ConfigManager.setTheme ok.');
        } catch (err) {
            console.error(TAG, stamp, '❌ handle_engine_apply failed:', err);
            const msg = typeof err === 'string' ? err : (err?.message ?? 'License verification failed.');
            await alertInPanel(msg);
        }
    }

    isProcessingApplyQueue = false;
}

function registerEngineApplyListener() {
    if (engineApplyListenerRegistered) return;
    engineApplyListenerRegistered = true;

    listen('engine-apply-theme', (event) => {
        const token = event?.payload;
        if (token) {
            applyQueue.push(token);
            processApplyQueue();
        }
    });

    invoke('flush_pending_deeplink').catch(() => {});
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
        invoke('log_from_js', {
            message: `[${label}] ${info?.stack || info?.message || String(info)}`
        }).catch(() => {});
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

    await verifyAndProvisionAppData();
    await ConfigManager.init();
    initDualWindowSystem();

    if (isSettingsWindow()) {
        registerEngineApplyListener();
        initSettingsUI();
    }

    // Inter-window event triggers
    listen('theme-changed', async (event) => {
        const newTheme = event.payload || null;

        if (isMainWindow()) {
            if (newTheme === ThemeManager.currentThemePath) return;
            ThemeManager.loadTheme(newTheme);
        } else {
            ThemeManager.currentThemePath = newTheme;
            updateSettingsScope(newTheme);
        }
    });

    listen('theme-reload', () => {
        if (isMainWindow() && ThemeManager.currentThemePath) {
            ThemeManager.loadTheme(ThemeManager.currentThemePath, true);
        }
    });

    listen('theme-installed', async (event) => {
        const absoluteThemePath = event.payload;
        console.log("[Novaframe] Received theme-installed event with path:", absoluteThemePath);
        await ConfigManager.setTheme(absoluteThemePath);
        if (isSettingsWindow()) {
            window.location.reload();
        } else {
            ThemeManager.loadTheme(absoluteThemePath);
        }
    });

    listen('config-changed', (event) => {
        if (event.payload) {
            config = setConfig(event.payload);
            relayThemeSettingsToIframe(ThemeManager.currentThemePath, ThemeManager.currentIframe, config);
        }
    });

    listen('theme-action', (event) => {
        const settingId = event.payload;
        if (settingId && ThemeManager.currentIframe?.contentWindow) {
            ThemeManager.currentIframe.contentWindow.postMessage({
                type: 'novaframe-settings',
                settings: { [settingId]: true }
            }, '*');
        }
    });

    let lastTick = Date.now();
    const SLEEP_GAP_MS = 20000;
    if (isMainWindow()) setInterval(() => {

        const now = Date.now();
        const gap = now - lastTick;
        if (gap > SLEEP_GAP_MS) {
            if (getLastKnownOcclusion()) {
                console.log(`[Novaframe] timer gap ${gap}ms while paused — skipping iframe reload`);
            } else if (ThemeManager.currentIframe) {
                console.log(`[Novaframe] timer gap ${gap}ms — reloading iframe to restore WebGL context`);
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

    listen('occlusion-change', (event) => {
        const isVisible = event.payload;
        setLastKnownOcclusion(!isVisible);
        if (ThemeManager.currentIframe) {
            ThemeManager.currentIframe.style.display = isVisible ? 'block' : 'none';
            if (ThemeManager.currentIframe.contentWindow) {
                try {
                    ThemeManager.currentIframe.contentWindow.postMessage({
                        type: 'novaframe-occlusion',
                        occluded: !isVisible
                    }, '*');
                } catch (_) {}
            }
        }
    });
});


import {
    relaunchApp,
    checkAndInstallUpdate,
    setWelcomeVisible,
    showOnboardingOnce,
    checkThemeContentUpdates
} from './modules/updater.js';

// Auto-Updater Integration DOM Bindings
const updateBtn = document.getElementById('updateBtn');
const updateStatus = document.getElementById('updateStatus');

if (updateBtn) {
    updateBtn.addEventListener('click', async () => {
        try {
            await checkAndInstallUpdate({ silent: false });
        } catch (error) {
            console.error('Update error:', error);
            if (updateStatus) {
                updateStatus.innerText = `Update failed: ${error}`;
                updateStatus.style.color = '#ef4444';
            }
        } finally {
            setTimeout(() => {
                if (updateStatus && (updateStatus.innerText.includes('latest version') || updateStatus.innerText.includes('failed'))) {
                    updateStatus.innerText = '';
                }
            }, 5000);
        }
    });
}

// Automatic background check execution
if (isSettingsWindow()) {
    const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
    const silentCheck = () => checkAndInstallUpdate({ silent: true })
        .catch(err => console.error('[Updater] background check failed:', err));
    const themeCheck = () => checkThemeContentUpdates(ThemeManager.getInstalledManifests())
        .catch(err => console.error('[ThemeUpdates] background check failed:', err));
    setTimeout(silentCheck, 60 * 1000);
    setInterval(silentCheck, AUTO_CHECK_INTERVAL_MS);
    setTimeout(themeCheck, 20 * 1000);
    setInterval(themeCheck, AUTO_CHECK_INTERVAL_MS);
} else {
    setTimeout(() => {
        if (!ThemeManager.currentManifest) {
            setWelcomeVisible(true);
        } else {
            showOnboardingOnce(config, () => ConfigManager.saveConfig());
        }
    }, 2500);
}

// ── Global DOM Click Diagnostic Listener ──────────────────────────────────────
document.addEventListener('click', (e) => {
    const targetId = e.target.id || e.target.tagName || 'unknown';
    invoke('log_from_js', {
        message: `[DOM-CLICK] target=${targetId} mode=${getMode()}`
    }).catch(() => {});
}, true);

// ── Top-level fail-open control wiring ──────────────────────────────────────
function wireCriticalControls() {
    const quitBtn = document.getElementById('quitEngineBtn');
    if (quitBtn && !quitBtn._wired) {
        quitBtn._wired = true;
        quitBtn.addEventListener('click', async () => {
            invoke('log_from_js', { message: '[CLICK] quitEngineBtn clicked' }).catch(() => {});
            try { await invoke('quit_engine'); }
            catch (err) { console.error('[Novaframe] quit_engine failed:', err); }
        });
    }
    const openStoreBtn = document.getElementById('openStoreBtn');
    if (openStoreBtn && !openStoreBtn._wired) {
        openStoreBtn._wired = true;
        openStoreBtn.addEventListener('click', async () => {
            invoke('log_from_js', { message: '[CLICK] openStoreBtn clicked' }).catch(() => {});
            try { await invoke('open_storefront_window'); }
            catch (err) { console.error('[Novaframe] open_storefront_window failed:', err); }
        });
    }
}
wireCriticalControls();

