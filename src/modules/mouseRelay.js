// ── Mouse Relay Module ──────────────────────────────────────────────────────────
// Dynamic cursor event forwarding to interactive theme iframes.
//
// NOTE: despite what this header used to claim, the relay is currently attached
// for EVERY theme — themeManager.mountIframe() calls enableMouseRelay()
// unconditionally. No shipped wallpaper consumes `novaframe-pointer` (the house
// build rule is "no pointer"), so this is a mousemove listener running for
// nothing on most installs.
//
// To make it opt-in: add `"interactive": true` to the manifests of any theme
// that actually reads pointer messages, then gate the enableMouseRelay() call
// in themeManager.js on that flag. Left as-is for now because flipping it blind
// would silently break any theme that does use it.

let isAttached = false;
let mousePending = false;
let lastX = NaN, lastY = NaN;
let getIframeCallback = null;

function handleMouseMove(e) {
    if (mousePending) return;
    if (lastX === e.clientX && lastY === e.clientY) return;
    const dx = Math.abs(e.clientX - lastX), dy = Math.abs(e.clientY - lastY);
    if (!isNaN(dx) && dx < 1.5 && dy < 1.5) return;
    lastX = e.clientX;
    lastY = e.clientY;

    mousePending = true;
    requestAnimationFrame(() => {
        mousePending = false;
        const iframe = getIframeCallback ? getIframeCallback() : null;
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
}

export function enableMouseRelay(getIframeFn) {
    getIframeCallback = getIframeFn;
    if (!isAttached) {
        window.addEventListener('mousemove', handleMouseMove);
        isAttached = true;
        console.log('[Novaframe] Mouse relay ENABLED for interactive theme');
    }
}

export function disableMouseRelay() {
    if (isAttached) {
        window.removeEventListener('mousemove', handleMouseMove);
        isAttached = false;
        lastX = NaN;
        lastY = NaN;
        console.log('[Novaframe] Mouse relay DISABLED (saving mouse event CPU cycles)');
    }
}

export function isMouseRelayActive() {
    return isAttached;
}
