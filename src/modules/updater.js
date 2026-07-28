// ── Binary Auto-Updater & Theme Content Update Checks ─────────────────────────
import { check as updaterCheck } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isMainWindow, isSettingsWindow } from './windowEnv.js';

let updateInstalledPendingRestart = false;

export async function relaunchApp() {
    await relaunch();
}

export async function checkAndInstallUpdate({ silent }) {
    const updateStatus = document.getElementById('updateStatus');
    const updateRestartBanner = document.getElementById('updateRestartBanner');

    const setStatus = (text, color) => {
        if (silent || !updateStatus) return;
        updateStatus.innerText = text;
        if (color) updateStatus.style.color = color;
    };

    if (updateInstalledPendingRestart) {
        setStatus('Update ready — restart to apply.', '#10b981');
        return;
    }

    const update = await updaterCheck();
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
        console.log(`[Updater] v${update.version} installed in background; awaiting restart.`);
        if (updateRestartBanner) updateRestartBanner.style.display = 'block';
    } else {
        setStatus('Update installed! Restarting...', '#10b981');
        setTimeout(relaunchApp, 1500);
    }
}

export function setWelcomeVisible(visible) {
    const overlay = document.getElementById('welcomeOverlay');
    if (!overlay) return;
    overlay.style.display = visible && isMainWindow() ? 'flex' : 'none';
}

export async function showOnboardingOnce(config, saveConfigFn) {
    const overlay = document.getElementById('onboardingOverlay');
    if (!overlay) return;
    if (config?.onboarding_seen === true) return;

    if (config) {
        config.onboarding_seen = true;
    }
    if (saveConfigFn) {
        await saveConfigFn();
    }

    overlay.style.display = 'flex';
    requestAnimationFrame(() => { overlay.style.opacity = '1'; });

    setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.style.display = 'none'; }, 700);
    }, 9000);
}

export async function checkThemeContentUpdates(installedManifests = []) {
    const notice = document.getElementById('themeUpdatesNotice');
    if (!notice) return;

    const installed = installedManifests
        .filter(m => m.theme_id)
        .map(m => ({ id: m.theme_id, version: m.version || '' }));
    if (installed.length === 0) return;

    try {
        const { invoke } = await import('@tauri-apps/api/core');
        const data = await invoke('check_theme_updates_rust', { themes: installed });
        const updates = data?.updates;
        if (!Array.isArray(updates) || updates.length === 0) {
            notice.style.display = 'none';
            return;
        }
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
