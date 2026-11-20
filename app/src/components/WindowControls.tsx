// Minimise / maximise / close for the app's own title bar (the window has no
// Windows frame). Closing goes through the normal close request, so unsaved
// textures still ask Save / Discard / Cancel first.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!inTauri()) return;
    const win = getCurrentWindow();
    const sync = () => void win.isMaximized().then(setMaximized).catch(() => {});
    sync();
    const off = win.onResized(sync);
    return () => void off.then((f) => f());
  }, []);

  if (!inTauri()) return null;
  const win = getCurrentWindow();
  return (
    <div className="winctl">
      <button aria-label="Minimise" title="Minimise" onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5.5h10" stroke="currentColor" /></svg>
      </button>
      <button aria-label={maximized ? "Restore" : "Maximise"} title={maximized ? "Restore" : "Maximise"} onClick={() => void win.toggleMaximize()}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" /></svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor"><path d="M.5.5h9v9h-9z" /></svg>
        )}
      </button>
      <button className="close" aria-label="Close" title="Close" onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor"><path d="M0 0l10 10M10 0L0 10" /></svg>
      </button>
    </div>
  );
}
