// ── Theme Lifecycle, Manifest Parsing & Sandbox Management ─────────────────────
import { invoke } from '@tauri-apps/api/core';
import { readTextFile } from '@tauri-apps/plugin-fs';
import {
    ENGINE_MANIFEST_VERSION,
    manifestNeedsNewerEngine,
    toThemeUrl
} from './constants.js';
import { getConfig } from './state.js';
import { isMainWindow } from './windowEnv.js';

let _lastKnownOccluded = false;
let _lastRelayedSettings = null;

// Occlusion state is cached here (the module that owns the iframe) so the
// main window's sleep failsafe in app.js can read it without a Rust round trip.
export function getLastKnownOcclusion() {
    return _lastKnownOccluded;
}

export function setLastKnownOcclusion(occluded) {
    _lastKnownOccluded = occluded;
}

export function applyThemeScope(manifest) {
    const mode = manifest?.render_mode === 'internal-legacy' || !manifest
        ? 'legacy'
        : 'dynamic';
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.dataset.themeScope = mode;
    }
}

export function toggleWelcomeOverlay(show) {
    if (typeof document === 'undefined') return;
    const overlay = document.getElementById('welcomeOverlay');
    if (!overlay) return;
    overlay.style.display = show && isMainWindow() ? 'flex' : 'none';
}

export async function pushCurrentOcclusion(iframe) {
    let occluded = _lastKnownOccluded;
    try {
        occluded = await invoke('get_wallpaper_paused');
    } catch (e) {
        console.warn('[Novaframe] get_wallpaper_paused unavailable, using cached state', e);
    }
    _lastKnownOccluded = occluded;
    if (iframe) {
        iframe.style.display = occluded ? 'none' : 'block';
        try {
            iframe.contentWindow?.postMessage({ type: 'novaframe-occlusion', occluded }, '*');
        } catch (_) {}
    }
}

export function relayThemeSettingsToIframe(currentThemePath = ThemeManager.currentThemePath, currentIframe = ThemeManager.currentIframe, configPassed = null) {
    const tp = currentThemePath || ThemeManager.currentThemePath;
    const cw = (currentIframe || ThemeManager.currentIframe)?.contentWindow;
    if (!tp || !cw) return;
    const cfg = configPassed || getConfig();
    const settings = cfg?.theme_settings?.[tp];
    if (!settings) return;
    const serialized = JSON.stringify(settings);
    if (serialized === _lastRelayedSettings) return;
    _lastRelayedSettings = serialized;
    try {
        cw.postMessage({ type: 'novaframe-settings', settings }, '*');
    } catch (_) {}
}

export const ThemeManager = {
    manifestCache: {},
    currentManifest: null,
    currentThemePath: null,
    currentIframe: null,

    getInstalledManifests() {
        return Object.values(this.manifestCache).map(m => ({ ...m }));
    },

    async readManifest(themePath) {
        const candidate = 'manifest.json';
        const fileFsPath = `${themePath}/${candidate}`;
        const url = toThemeUrl(fileFsPath);
        try {
            const res = await fetch(url).catch(() => null);
            if (res && res.ok) {
                const m = await res.json();
                return { manifest: m, manifestFile: candidate };
            }
        } catch (_) {}

        try {
            const content = await readTextFile(fileFsPath);
            if (content) {
                const m = JSON.parse(content);
                return { manifest: m, manifestFile: candidate };
            }
        } catch (_) {}

        throw new Error(`Manifest not found under ${themePath}`);
    },

    async loadTheme(themePath, forceReload = false, configOverride = null) {
        if (!themePath) {
            if (this.currentThemePath === null && !this.currentManifest) return;
            this.unmountIframe();
            this.currentThemePath = null;
            this.currentManifest = null;
            toggleWelcomeOverlay(true);
            applyThemeScope(null);
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

        if (manifestNeedsNewerEngine(manifest)) {
            console.warn(`[Novaframe] Not loading "${manifest.name || themePath}": manifest_version ${manifest.manifest_version} needs a newer engine (supports ${ENGINE_MANIFEST_VERSION}). Update Novaframe.`);
            return;
        }

        if (!forceReload && this.currentIframe
            && themePath === this.currentThemePath
            && manifest.theme_id === this.currentManifest?.theme_id) {
            const entry = manifest.entry || 'index.html';
            const expectedSrc = toThemeUrl(`${themePath}/${entry}`);
            if (this.currentIframe.src === expectedSrc && document.getElementById('themeFrame')) {
                return;
            }
        }


        const renderMode = manifest.render_mode || 'external-html';

        this.currentManifest = manifest;
        this.currentThemePath = themePath;
        this.manifestCache[themePath] = manifest;

        if (renderMode === 'external-html' || renderMode === 'external-canvas') {
            await this.loadExternalHtml(themePath, manifest, configOverride);
        } else {
            console.error(`[Novaframe] Unknown render_mode "${renderMode}", falling back to external-html`);
            await this.loadExternalHtml(themePath, manifest, configOverride);
        }

        applyThemeScope(manifest);
    },

    async loadExternalHtml(themePath, manifest, configOverride) {
        const entry = manifest.entry || 'index.html';
        const fileSrc = toThemeUrl(`${themePath}/${entry}`);
        const transparent = manifest.transparent !== false;
        this.mountIframe(fileSrc, transparent, themePath, configOverride);
    },

    mountIframe(src, transparent, themePath, configOverride) {
        this.unmountIframe();
        toggleWelcomeOverlay(false);
        const container = document.getElementById('container');
        if (!container) return;
        const iframe = document.createElement('iframe');
        iframe.id = 'themeFrame';
        iframe.src = src;
        iframe.setAttribute('allow', 'autoplay; fullscreen');
        iframe.setAttribute('sandbox', 'allow-scripts');
        Object.assign(iframe.style, {
            position: 'absolute',
            top: '0', left: '0',
            width: '100%', height: '100%',
            border: '0',
            backgroundColor: transparent ? 'transparent' : '#000',
            zIndex: '5',
            pointerEvents: 'auto'
        });

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
            requestAnimationFrame(() => postViewport('novaframe-theme-ready'));
            pushCurrentOcclusion(iframe);

            const cfg = configOverride || getConfig();
            const defaults = {};
            (ThemeManager.currentManifest?.custom_settings || []).forEach(s => {
                if (s.default !== undefined) defaults[s.id] = s.default;
            });
            const saved = (cfg?.theme_settings && cfg.theme_settings[themePath]) || {};
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

        let resizeDebounce = null;
        const resizeObserver = new ResizeObserver(() => {
            if (resizeDebounce) clearTimeout(resizeDebounce);
            resizeDebounce = setTimeout(() => postViewport('novaframe-theme-resize'), 150);
        });
        resizeObserver.observe(iframe);
        iframe._novaframeResizeCleanup = () => {
            if (resizeDebounce) clearTimeout(resizeDebounce);
            resizeObserver.disconnect();
        };

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
