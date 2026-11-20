//! Watches the open pack so previews refresh when a texture is saved in an
//! external editor. Events are grouped: one `pack-changed` per burst.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct PackWatcher {
    // dropping the watcher stops it and ends the thread (the channel closes)
    _watcher: RecommendedWatcher,
}

impl PackWatcher {
    pub fn start(app: AppHandle, pack_dir: &Path) -> Option<Self> {
        let (tx, rx) = mpsc::channel::<()>();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                // the app's own folder changes on every save of the project file
                let ours = event
                    .paths
                    .iter()
                    .all(|p| p.components().any(|c| c.as_os_str() == ".packcreator"));
                if !ours && !event.kind.is_access() {
                    let _ = tx.send(());
                }
            }
        })
        .ok()?;
        watcher.watch(pack_dir, RecursiveMode::Recursive).ok()?;
        std::thread::spawn(move || {
            while rx.recv().is_ok() {
                // wait until the burst is over (editors write in several steps)
                while rx.recv_timeout(Duration::from_millis(250)).is_ok() {}
                let _ = app.emit("pack-changed", ());
            }
        });
        Some(Self { _watcher: watcher })
    }
}
