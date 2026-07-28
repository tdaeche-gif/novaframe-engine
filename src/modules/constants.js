// ── Engine constants ──────────────────────────────────────────────────────────
// Highest theme manifest_version this engine build knows how to render. A theme
// may set `manifest_version` in its manifest; if it declares a higher version
// than this, the engine can't guarantee correct rendering and skips it (prompting
// an engine update) rather than rendering it wrong. Manifests without the field
// are treated as v1 (the current format). Bump this whenever the manifest schema
// gains a breaking change.
export const ENGINE_MANIFEST_VERSION = 1;

// True if a manifest requires a newer engine than this build supports.
export function manifestNeedsNewerEngine(manifest) {
    const v = Number(manifest?.manifest_version);
    return Number.isFinite(v) && v > ENGINE_MANIFEST_VERSION;
}

// Build a theme:// URL from an absolute filesystem path. Unlike Tauri's
// convertFileSrc (which percent-encodes the WHOLE path into one URL segment,
// breaking every relative subresource inside the theme), this keeps real
// directory segments so `./img.jpg` and `fetch('./shaders/x.frag')` resolve.
export function toThemeUrl(fsPath) {
    // Normalize Windows backslashes to '/' before segmenting. Rust's
    // app_data_dir returns paths like C:\Users\..\themes\Name, and JS also
    // concatenates candidates with '/', producing mixed separators. Without
    // this, the entire theme dir collapses into one percent-encoded segment
    // (backslashes → %5C) instead of real path segments — which breaks every
    // relative subresource inside a theme (`./img.jpg`, `fetch('./x.frag')`)
    // on Windows. Encoding each real segment keeps those relative URLs resolving.
    const normalized = fsPath.replace(/\\/g, '/');
    const encoded = normalized.split('/').map(encodeURIComponent).join('/');
    const lead = encoded.startsWith('/') ? '' : '/';
    // Windows/Android webviews expose custom schemes as http://<scheme>.localhost
    return IS_WINDOWS_WEBVIEW
        ? `http://theme.localhost${lead}${encoded}`
        : `theme://localhost${lead}${encoded}`;
}

// Detect the host platform once at module load rather than per-call. The custom
// scheme host differs by webview (WebView2 on Windows exposes theme://localhost
// as http://theme.localhost), so this drives every theme URL. Kept as a UA check
// (reliable on WebView2/WKWebView) to avoid pulling the async os plugin into the
// synchronous toThemeUrl hot path.
export const IS_WINDOWS_WEBVIEW = typeof navigator !== 'undefined'
    && /Windows/i.test(navigator.userAgent || '');
