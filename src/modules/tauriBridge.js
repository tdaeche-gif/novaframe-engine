// ── Tauri IPC Bridge & Native Plugin Wrappers ───────────────────────────────
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export async function safeInvoke(cmd, args = {}, options = {}) {
    const { silent = false, defaultValue = null } = options;
    try {
        return await invoke(cmd, args);
    } catch (err) {
        if (!silent) {
            console.error(`[TauriBridge] IPC '${cmd}' failed:`, err);
        }
        return defaultValue;
    }
}

export async function getThemesDir() {
    try {
        let themesDir = await invoke('get_themes_dir');
        if (themesDir.endsWith('/') || themesDir.endsWith('\\')) {
            themesDir = themesDir.slice(0, -1);
        }
        return themesDir;
    } catch (e) {
        console.error("[Novaframe] Failed to get appDataDir from Rust, falling back to local themes:", e);
        return 'themes';
    }
}

export async function getHardwareId() {
    return await safeInvoke('get_hardware_id', {}, { silent: true, defaultValue: null });
}

export async function setIgnoreCursor(ignore) {
    try {
        const win = getCurrentWindow();
        if (win.label === 'main') {
            await win.setIgnoreCursorEvents(ignore);
        }
    } catch (e) {
        console.error("[Novaframe] Failed to set ignore cursor events:", e);
    }
}

export function reportJsError(label, info) {
    invoke('log_from_js', {
        message: `[${label}] ${info?.stack || info?.message || String(info)}`
    }).catch(() => {});
}
