//! The `pcimg` protocol: lets the UI show PNG files as `<img>` without
//! opening the whole disk to the web view. Only two places can be read:
//! the vanilla cache and the pack that is open.
//!
//! * `pcimg://localhost/vanilla/<version folder>/thumb/<texture path>`
//! * `pcimg://localhost/vanilla/<version folder>/full/<texture path>`
//! * `pcimg://localhost/pack/full/<texture path>`
//! * `pcimg://localhost/pack/icon`
//! * `pcimg://localhost/packicon?dir=<pack folder>` (recent packs: `pack.png` only)

use crate::AppState;
use packcreator_core::extract::vanilla_dir;
use packcreator_core::textures::{is_safe_texture_path, texture_file, thumb_file};
use std::path::PathBuf;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager};

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && s.is_char_boundary(i + 1)
            && s.is_char_boundary(i + 3)
        {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn resolve(app: &AppHandle, path: &str, query: Option<&str>) -> Option<PathBuf> {
    let state = app.state::<AppState>();
    let inner = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let path = percent_decode(path.trim_start_matches('/'));
    let mut parts = path.splitn(2, '/');
    match parts.next()? {
        "vanilla" => {
            let rest = parts.next()?;
            let mut p = rest.splitn(3, '/');
            let (dir_name, kind, tex) = (p.next()?, p.next()?, p.next()?);
            if !is_safe_texture_path(tex)
                || !is_safe_texture_path(dir_name)
                || dir_name.contains('/')
            {
                return None;
            }
            let root = vanilla_dir(&inner.cache_dir, dir_name);
            if kind == "thumb" {
                let t = thumb_file(&root, tex);
                if t.is_file() {
                    return Some(t);
                }
            }
            texture_file(&root, tex).ok()
        }
        "pack" => {
            let pack = inner.pack.as_ref()?;
            let rest = parts.next()?;
            if rest == "icon" {
                return Some(pack.dir.join("pack.png"));
            }
            let tex = rest.strip_prefix("full/")?;
            texture_file(&pack.dir, tex).ok()
        }
        "packicon" => {
            // only pack.png of a folder that is in the recent list
            let dir = query?.split('&').find_map(|kv| kv.strip_prefix("dir="))?;
            let dir = percent_decode(dir);
            let known = inner.settings.recent.iter().any(|r| r.path == dir);
            known.then(|| PathBuf::from(dir).join("pack.png"))
        }
        _ => None,
    }
}

pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let file = resolve(app, uri.path(), uri.query());
    let not_found = || {
        Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Vec::new())
            .expect("valid response")
    };
    let Some(file) = file else { return not_found() };
    match std::fs::read(&file) {
        Ok(bytes) => Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", "image/png")
            .header("Cache-Control", "no-store")
            .header("Access-Control-Allow-Origin", "*")
            .body(bytes)
            .expect("valid response"),
        Err(_) => not_found(),
    }
}
