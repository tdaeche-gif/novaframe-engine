use tauri::Manager;
use tauri::Emitter;
use std::time::Instant;

use crate::dlog;
use crate::state::{LAST_DEEPLINK_SEEN, PENDING_DEEPLINK_TOKEN};

#[tauri::command]
pub fn flush_pending_deeplink(app: tauri::AppHandle) {
    if let Ok(mut guard) = PENDING_DEEPLINK_TOKEN.lock() {
        if let Some(token_str) = guard.take() {
            dlog(&app, &format!("[deeplink] flushing pending token_len={}", token_str.len()));
            if let Some(w) = app.get_webview_window("settings") {
                let _ = w.emit("engine-apply-theme", token_str);
            } else {
                let _ = app.emit("engine-apply-theme", token_str);
            }
        }
    }
}

pub fn process_deeplink_url(app: &tauri::AppHandle, url_str: &str) {
    dlog(app, &format!("[deeplink] received: {}", url_str));
    if url_str.starts_with("novaframe://apply") {
        let parsed = match tauri::Url::parse(url_str) {
            Ok(u) => u,
            Err(_) => return,
        };
        if let Some(query) = parsed.query() {
            let raw_token = query
                .split('&')
                .find(|p| p.starts_with("token="))
                .and_then(|p| p.strip_prefix("token="));

            let decoded_res = raw_token.and_then(decode_deeplink_token);
            match decoded_res {
                Some(token_str) => {
                    let now = Instant::now();
                    if let Ok(mut guard) = LAST_DEEPLINK_SEEN.lock() {
                        if let Some((ref last_token, last_time)) = *guard {
                            if last_token == &token_str && now.duration_since(last_time).as_millis() < 1500 {
                                dlog(app, "[deeplink] deduplicated duplicate trigger within 1.5s window");
                                return;
                            }
                        }
                        *guard = Some((token_str.clone(), now));
                    }

                    if let Some(target_win) = app.get_webview_window("settings") {
                        dlog(app, &format!("[deeplink] emitting engine-apply-theme token_len={}", token_str.len()));
                        if let Err(e) = target_win.emit("engine-apply-theme", token_str) {
                            dlog(app, &format!("[deeplink] emit engine-apply-theme error: {}", e));
                        }
                    } else {
                        dlog(app, &format!("[deeplink] settings window missing, buffering pending token_len={}", token_str.len()));
                        if let Ok(mut pending_guard) = PENDING_DEEPLINK_TOKEN.lock() {
                            *pending_guard = Some(token_str.clone());
                        }
                        let _ = app.emit("engine-apply-theme", token_str);
                    }
                }
                None => {
                    dlog(app, "[deeplink] token= param missing or invalid UTF-8");
                }
            }
        } else {
            dlog(app, "[deeplink] apply URL had no query string");
        }
    }
}

pub fn decode_deeplink_token(raw_token: &str) -> Option<String> {
    percent_encoding::percent_decode_str(raw_token)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}
