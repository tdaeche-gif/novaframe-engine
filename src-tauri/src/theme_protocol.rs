use tauri::Manager;
use crate::dlog;

pub fn mime_for(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "wasm" => "application/wasm",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        // GLSL shaders and anything unknown: plain text is fine for fetch()
        _ => "text/plain",
    }
}

/// Origins allowed to read theme assets over `theme://`.
///
/// - `tauri://localhost` / `http://tauri.localhost` — the main and settings
///   windows (the scheme differs between WKWebView and WebView2).
/// - `theme://localhost` / `http://theme.localhost` — one theme asset fetching
///   another when the frame is not sandboxed (marketplace preview capture).
/// - `null` is handled separately: the theme iframe is mounted with
///   `sandbox="allow-scripts"` and no `allow-same-origin`, so it has an opaque
///   origin and every `fetch('./shader.frag')` inside it sends `Origin: null`.
const ALLOWED_ORIGINS: [&str; 4] = [
    "tauri://localhost",
    "http://tauri.localhost",
    "theme://localhost",
    "http://theme.localhost",
];

/// Decide the `Access-Control-Allow-Origin` value for a request, or `None` if
/// the origin is not permitted to read theme content at all.
///
/// This used to unconditionally answer `*`. The custom scheme handler is
/// registered app-wide, so a wildcard let ANY page loaded in ANY of the app's
/// webviews — including the remote marketplace window — `fetch()` the raw
/// source of every wallpaper the user has purchased. Those assets are the
/// product; a wildcard here is a straight exfiltration path around DRM.
///
/// A missing Origin header is allowed: plain subresource loads (`<img>`,
/// `<script>`, stylesheet, iframe navigation) do not send one, and those are
/// exactly how a theme's own HTML pulls in its files.
fn allowed_cors_origin(request: &tauri::http::Request<Vec<u8>>) -> Option<String> {
    let origin = match request.headers().get("Origin").and_then(|v| v.to_str().ok()) {
        // No Origin header — a non-CORS subresource load. Nothing to reflect.
        None => return Some("null".to_string()),
        Some(o) => o,
    };
    if origin == "null" {
        return Some("null".to_string());
    }
    if ALLOWED_ORIGINS.contains(&origin) {
        return Some(origin.to_string());
    }

    // `tauri dev` serves the frontend from a dev server, so in a debug build the
    // main and settings windows have an http://localhost:<port> origin rather
    // than tauri://localhost — without this, every theme asset 403s and the
    // wallpaper is blank for the entire dev loop. Release builds load from
    // frontendDist and never take this branch, so the storefront origin stays
    // denied where it matters.
    #[cfg(debug_assertions)]
    if origin.starts_with("http://localhost:") || origin.starts_with("http://127.0.0.1:") {
        return Some(origin.to_string());
    }

    None
}

pub fn handle_theme_protocol(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    // Resolved once: every response (including denials) must carry a consistent
    // ACAO or the webview reports a confusing generic network error instead of
    // the real status.
    let cors_origin = allowed_cors_origin(request);

    let deny_origin = cors_origin.clone().unwrap_or_else(|| "null".to_string());
    let deny = move |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", deny_origin.clone())
            .body(Vec::new())
            .unwrap()
    };

    let Some(cors_origin) = cors_origin else {
        dlog(
            app,
            &format!(
                "[theme://] 403 DENIED (origin not allowed): {:?}",
                request.headers().get("Origin")
            ),
        );
        return deny(403);
    };

    let decoded = match urlencoding::decode(request.uri().path()) {
        Ok(s) => s.into_owned(),
        Err(_) => return deny(400),
    };

    // Windows custom-scheme URLs arrive with the path as "/C:/Users/..." — a
    // leading slash BEFORE the drive letter that PathBuf/canonicalize can't
    // resolve, so every manifest/asset fetch 404s and the dropdown ends up empty.
    // Strip that leading slash when it precedes a "<drive>:" prefix.
    #[cfg(target_os = "windows")]
    let decoded = {
        let b = decoded.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
            decoded[1..].to_string()
        } else {
            decoded
        }
    };

    let fs_path = std::path::PathBuf::from(&decoded);

    // Canonicalize to defeat ../ traversal; 404 if the file doesn't exist.
    let canon = match fs_path.canonicalize() {
        Ok(p) => p,
        Err(e) => {
            // 404s stay logged in release: an empty dropdown in the field is
            // almost always a path that failed to resolve here, and this line
            // is the only evidence of it.
            dlog(app, &format!("[theme://] 404 canonicalize FAILED path={:?} err={}", decoded, e));
            return deny(404);
        }
    };

    // Allowlist roots: installed themes + local dev wallpaper source tree.
    let themes_root = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("themes"))
        .and_then(|d| d.canonicalize().ok());
    // Local wallpaper source tree — only allowed in dev builds so a personal
    // path is never baked into shipped release binaries.
    #[cfg(debug_assertions)]
    let dev_root = std::path::PathBuf::from("/Users/tdaeche/Novaframe-Wallpapers")
        .canonicalize()
        .ok();
    #[cfg(not(debug_assertions))]
    let dev_root: Option<std::path::PathBuf> = None;

    let allowed = [themes_root, dev_root]
        .iter()
        .flatten()
        .any(|root| canon.starts_with(root));
    if !allowed {
        dlog(app, &format!("[theme://] 403 DENIED (outside allowed roots): {:?}", canon));
        return deny(403);
    }

    // Intentional Protocol Interception: All requests for novaframe-wallpaper.js
    // across installed themes are intercepted and served directly from app resources
    // so every theme automatically inherits canonical runtime updates (e.g. dynamic FPS).
    let served_path = if canon.file_name().and_then(|n| n.to_str()) == Some("novaframe-wallpaper.js") {
        app.path()
            .resolve("resources/default-theme/novaframe-wallpaper.js", tauri::path::BaseDirectory::Resource)
            .ok()
            .filter(|p| p.exists())
            .unwrap_or_else(|| canon.clone())
    } else {
        canon.clone()
    };

    match std::fs::read(&served_path) {
        Ok(bytes) => {
            // Debug-only: a theme pulls shaders, textures and manifests over this
            // handler, and dlog does a file open/write/close per call. Logging
            // every 200 in release meant a disk write per asset request, forever.
            #[cfg(debug_assertions)]
            dlog(app, &format!("[theme://] 200 served {} bytes: {:?}", bytes.len(), served_path));
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime_for(&served_path))
                // Required: the main window (tauri://localhost origin) fetches manifests
                // cross-origin from theme://localhost, and the sandboxed theme iframe
                // fetches its own assets from an opaque ("null") origin.
                .header("Access-Control-Allow-Origin", cors_origin)
                .body(bytes)
                .unwrap()
        }
        Err(_) => deny(404),
    }
}
