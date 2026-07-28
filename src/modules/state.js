// ── Canonical Application Config State ─────────────────────────────────────────

export const DEFAULT_CONFIG = {
    shadowOpacity: 55,
    showAnalemma: true,
    pinnedLocations: [
        { name: "London", lat: 51.5074, lon: -0.1278 },
        { name: "New York", lat: 40.7128, lon: -74.0060 },
        { name: "Hong Kong", lat: 22.3193, lon: 114.1694 }
    ],
    theme_settings: {},
    rotation_enabled: false,
    rotation_interval_min: 60,
    pause_on_battery: false,
    onboarding_seen: false,
    target_fps: 30
};

let currentConfig = { ...DEFAULT_CONFIG };

export function getConfig() {
    return currentConfig;
}

export function setConfig(newConfig) {
    currentConfig = { ...DEFAULT_CONFIG, ...newConfig };
    return currentConfig;
}

export function patchConfig(partial) {
    currentConfig = { ...currentConfig, ...partial };
    return currentConfig;
}

export function getThemeSettings(themePath) {
    if (!themePath) return {};
    return currentConfig.theme_settings?.[themePath] || {};
}

export function setThemeSettings(themePath, settings) {
    if (!themePath) return;
    if (!currentConfig.theme_settings) {
        currentConfig.theme_settings = {};
    }
    currentConfig.theme_settings[themePath] = {
        ...(currentConfig.theme_settings[themePath] || {}),
        ...settings
    };
    return currentConfig.theme_settings[themePath];
}
