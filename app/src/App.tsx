import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect } from "react";
import { CommandPalette, ModalHost, Toasts } from "./components/Overlays";
import { NavBar, PackChips, sectionLabel, StatusBar, TopBar } from "./components/Shell";
import { RecolorHost } from "./components/RecolorDialog";
import { useEditor } from "./editor/editorStore";
import { Animation } from "./screens/Animation";
import { Browser } from "./screens/Browser";
import { Editor } from "./screens/Editor";
import { Export } from "./screens/Export";
import { Interface } from "./screens/Interface";
import { Particles } from "./screens/Particles";
import { Settings } from "./screens/Settings";
import { Welcome } from "./screens/Welcome";
import { useApp, type Screen } from "./store";

const LATER: Partial<Record<Screen, string>> = {
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
    // files changed on disk (external editor, Explorer): refresh quietly, then
    // reload open editor tabs whose file changed (tabs with unsaved edits keep them)
    const changed = listen("pack-changed", () => {
      void useApp.getState().reload(true).then(() => useEditor.getState().syncWithDisk());
    });
    // quitting with unsaved textures asks Save / Discard / Cancel first
    const closing = getCurrentWindow().onCloseRequested(async (event) => {
      if (!(await useApp.getState().confirmLeave())) event.preventDefault();
    });
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
      void closing.then((off) => off());
      void progress.then((off) => off());
      window.removeEventListener("contextmenu", noMenu);
    };
  }, []);

  let content;
  if (!boot) content = <div className="placeholder">Starting…</div>;
  else if (screen === "settings") content = <Settings />;
  else if (!pack || screen === "home") content = <Welcome />;
  else if (screen === "textures") content = <Browser />;
  else if (screen === "editor") content = <Editor />;
  else if (screen === "animation") content = <Animation />;
  else if (screen === "export") content = <Export />;
  else if (screen === "particles") content = <Particles />;
  else if (screen === "interface") content = <Interface />;
  else content = <ComingLater screen={screen} />;

  return (
    <div className="app">
      {content}
      <Toasts />
      <ModalHost />
      <CommandPalette />
      <RecolorHost />
    </div>
  );
}
