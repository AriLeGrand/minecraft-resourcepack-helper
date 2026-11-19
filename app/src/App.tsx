import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { CommandPalette, ModalHost, Toasts } from "./components/Overlays";
import { NavBar, PackChips, sectionLabel, StatusBar, TopBar } from "./components/Shell";
import { Browser } from "./screens/Browser";
import { Export } from "./screens/Export";
import { Settings } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { useApp, type Screen } from "./store";

const LATER: Partial<Record<Screen, string>> = {
  editor: "The built-in pixel editor is the next stage. For now, “Open externally” in the texture browser sends a texture to your own image editor.",
  animation: "The animation timeline arrives in stage 3.",
  particles: "The particle viewer arrives in stage 4.",
  interface: "The interface (GUI) editor arrives in stage 5.",
  models: "3D models are planned for later. Blockbench is the tool for those today.",
};

function ComingLater({ screen }: { screen: Screen }) {
  const go = useApp((s) => s.go);
  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <NavBar />
        <div className="placeholder">
          <div className="big">{sectionLabel(screen).replace(" (later)", "")}</div>
          <div style={{ maxWidth: 440, textAlign: "center" }}>{LATER[screen]}</div>
          <button className="btn" onClick={() => go("textures")}>Back to textures</button>
        </div>
      </div>
      <StatusBar />
    </>
  );
}

export function App() {
  const screen = useApp((s) => s.screen);
  const boot = useApp((s) => s.boot);
  const pack = useApp((s) => s.pack);

  useEffect(() => {
    void useApp.getState().init();
    // files changed on disk (external editor, Explorer): refresh quietly
    const changed = listen("pack-changed", () => void useApp.getState().reload(true));
    const progress = listen<{ done: number; total: number }>("extract-progress", (e) => {
      const { busy, setBusy } = useApp.getState();
      if (busy) setBusy({ ...busy, done: e.payload.done, total: e.payload.total });
    });
    // the web view's own right-click menu makes no sense in an app
    const noMenu = (e: MouseEvent) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    };
    window.addEventListener("contextmenu", noMenu);
    return () => {
      void changed.then((off) => off());
      void progress.then((off) => off());
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  let content;
  if (!boot) content = <div className="placeholder">Starting…</div>;
  else if (screen === "settings") content = <Settings />;
  else if (!pack || screen === "home") content = <Welcome />;
  else if (screen === "textures") content = <Browser />;
  else if (screen === "export") content = <Export />;
  else content = <ComingLater screen={screen} />;

  return (
    <div className="app">
      {content}
      <Toasts />
      <ModalHost />
      <CommandPalette />
    </div>
  );
}
