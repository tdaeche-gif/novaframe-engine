// Resolve the window role (main | settings) SYNCHRONOUSLY, before first paint.
// app.bundle.js also does this in initDualWindowSystem(), but that runs after
// async awaits — so on window.location.reload() (fired for both windows on
// theme-installed) the fullscreen main window would paint #settingsPanel across
// the whole screen for a frame before JS hid it. Setting the mode here lets
// CSS hide the wrong-window DOM immediately, killing that flash.
//
// Extracted from index.html inline script so script-src 'self' CSP allows it.
document.documentElement.dataset.mode =
    new URLSearchParams(location.search).get('mode') || 'main';

