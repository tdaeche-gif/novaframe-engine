// ── Window environment helper ────────────────────────────────────────────────
// Single source of truth for which Tauri window this webview is running in.
// Supports both query string ?mode=settings|main and Tauri v2 window label.

export function getMode() {
    if (typeof window !== 'undefined') {
        const queryMode = new URLSearchParams(window.location.search).get('mode');
        if (queryMode) return queryMode;
        if (window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label) {
            return window.__TAURI_INTERNALS__.metadata.currentWindow.label;
        }
    }
    return 'main';
}

export function isMainWindow() {
    return getMode() === 'main';
}

export function isSettingsWindow() {
    const mode = getMode();
    if (mode) console.log('[Novaframe] window mode =', mode);
    return mode === 'settings';
}
