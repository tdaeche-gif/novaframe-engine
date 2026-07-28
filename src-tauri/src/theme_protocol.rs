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

pub fn handle_theme_protocol(
    app: &tauri::AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let deny = |status: u16| {
        tauri::http::Response::builder()
            .status(status)
            .header("Access-Control-Allow-Origin", "*")
            .body(Vec::new())
            .unwrap()
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
            dlog(app, &format!("[theme://] 200 served {} bytes: {:?}", bytes.len(), served_path));
            tauri::http::Response::builder()
                .status(200)
                .header("Content-Type", mime_for(&served_path))
                // Required: the main window (tauri://localhost origin) fetches manifests
                // cross-origin from theme://localhost.
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes)
                .unwrap()
        }
        Err(_) => deny(404),
    }
}
