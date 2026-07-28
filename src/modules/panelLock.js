// ── Docked Settings Panel Locking Delegation ──────────────────────────────────
import { invoke } from '@tauri-apps/api/core';

export const POPUP_CONTROLS = 'select, input[type="color"]';

export function setPanelLocked(locked) {
    invoke('set_settings_panel_locked', { locked }).catch(() => {});
}

export function initPanelLockDelegation() {
    const matches = (t) => t instanceof Element && t.closest(POPUP_CONTROLS);
    document.addEventListener('mousedown', (e) => { if (matches(e.target)) setPanelLocked(true); }, true);
    document.addEventListener('focusin',  (e) => { if (matches(e.target)) setPanelLocked(true); });
    document.addEventListener('change',   (e) => { if (matches(e.target)) setPanelLocked(false); });
    document.addEventListener('focusout', (e) => {
        if (!matches(e.target)) return;
        setTimeout(() => { if (document.hasFocus()) setPanelLocked(false); }, 0);
    });
}
