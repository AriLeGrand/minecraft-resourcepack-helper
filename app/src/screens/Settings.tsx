// Settings: folders, external editor, extracted versions.
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import { api, type SettingsPatch, type Upscale } from "../lib/api";
import { formatLabel } from "../lib/logic";
import { useApp } from "../store";

export function Settings() {
  const boot = useApp((s) => s.boot)!;
  const pack = useApp((s) => s.pack);
  const { setBoot, setPack, showError, toast, ensureExtracted } = useApp.getState();
  const [busyDir, setBusyDir] = useState<string | null>(null);
  const s = boot.settings;

  const save = async (patch: SettingsPatch, done: string) => {
    try {
      setBoot(await api.updateSettings(patch));
      if (pack) setPack(await api.getPack());
      toast(done);
    } catch (e) {
      showError(e);
    }
  };

  const pickDir = async (title: string) => {
    const d = await open({ directory: true, title });
    return typeof d === "string" ? d : null;
  };

  const pickEditor = async () => {
    const exe = await open({ title: "Choose your image editor (for example Aseprite.exe)", filters: [{ name: "Programs", extensions: ["exe", "bat", "cmd", "lnk", "app", "*"] }] });
    if (typeof exe === "string") await save({ external_editor: exe }, "External editor set.");
  };

  const extract = async (dir: string, label: string) => {
    setBusyDir(dir);
    if (await ensureExtracted(dir, label)) toast(`Textures of ${label} extracted.`);
    setBoot(await api.bootstrap());
    setBusyDir(null);
  };

  const clear = async (dir: string, label: string) => {
    setBusyDir(dir);
    try {
      await api.clearCache(dir);
      setBoot(await api.bootstrap());
      if (pack) setPack(await api.getPack());
      toast(`Extracted files of ${label} removed. They can be extracted again at any time.`);
    } catch (e) {
      showError(e);
    }
    setBusyDir(null);
  };

  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <NavBar />
        <main className="page">
          <div className="settings">
            <h1>Settings</h1>

            <div className="card pad col" style={{ gap: 16 }}>
              <h2>Minecraft</h2>
              <div className="field">
                <span className="label">Game folder</span>
                <div className="pathrow">
                  <input className="input mono grow" readOnly value={boot.minecraft_dir ?? "Not found"} />
                  <button className="btn" style={{ height: 36 }} onClick={async () => { const d = await pickDir("Choose your .minecraft folder"); if (d) await save({ minecraft_dir: d }, "Minecraft folder changed."); }}>Browse</button>
                  {s.minecraft_dir && <button className="btn ghost" style={{ height: 36 }} onClick={() => void save({ minecraft_dir: null }, "Using the default Minecraft folder.")}>Use default</button>}
                </div>
                {boot.minecraft_error && <div className="hint" style={{ color: "var(--warn)" }}>{boot.minecraft_error.message} {boot.minecraft_error.hint}</div>}
              </div>
            </div>

            <div className="card pad col" style={{ gap: 16 }}>
              <h2>Editing</h2>
              <div className="field">
                <span className="label">External editor</span>
                <div className="pathrow">
                  <input className={`input grow ${s.external_editor ? "mono" : ""}`} readOnly value={s.external_editor ?? "The program Windows uses for PNG files"} />
                  <button className="btn" style={{ height: 36 }} onClick={pickEditor}>Browse</button>
                  {s.external_editor && <button className="btn ghost" style={{ height: 36 }} onClick={() => void save({ external_editor: null }, "Using the default program for PNG files.")}>Use default</button>}
                </div>
                <div className="hint">Used by “Open externally”. Pick Aseprite.exe, Paint.NET, GIMP… The app refreshes when you save there.</div>
              </div>
              <div className="field">
                <span className="label">Starting from the game’s texture at 32× and more</span>
                <select
                  className="input" style={{ maxWidth: 420 }} aria-label="How the game's texture is enlarged"
                  value={s.upscale ?? "nearest"}
                  onChange={(e) => void save({ upscale: e.target.value as Upscale }, e.target.value === "smooth" ? "New textures start smoothed with Scale2x / Scale3x." : "New textures start with hard pixels.")}
                >
                  <option value="nearest">Hard pixels (default)</option>
                  <option value="smooth">Smooth pixel-art (Scale2x / Scale3x / Scale4x family)</option>
                </select>
                <div className="hint">
                  Used when a texture is opened in the editor or opened externally before your pack has it. Smooth rounds diagonal steps
                  without blurring: only the texture’s own colours are used. Textures already in your pack are never rescaled.
                </div>
              </div>
            </div>

            <div className="card pad col" style={{ gap: 16 }}>
              <h2>Export</h2>
              <div className="field">
                <span className="label">Export folder</span>
                <div className="pathrow">
                  <input className={`input grow ${s.export_dir ? "mono" : ""}`} readOnly value={s.export_dir ?? "An “export” folder next to each pack"} />
                  <button className="btn" style={{ height: 36 }} onClick={async () => { const d = await pickDir("Folder for exported packs"); if (d) await save({ export_dir: d }, "Export folder changed."); }}>Browse</button>
                  {s.export_dir && <button className="btn ghost" style={{ height: 36 }} onClick={() => void save({ export_dir: null }, "Exports go next to each pack again.")}>Use default</button>}
                </div>
              </div>
            </div>

            <div className="card col" style={{ overflow: "hidden" }}>
              <div className="pad" style={{ paddingBottom: 12 }}>
                <h2>Game textures on this computer</h2>
                <div className="dim" style={{ fontSize: 12, marginTop: 6 }}>
                  Textures are read from your own installed game and kept in the app’s cache. They are never included in the app or in your packs.
                </div>
              </div>
              {boot.versions.length === 0 && <div className="empty">No Minecraft version found.</div>}
              {boot.versions.map((v) => (
                <div key={v.dir_name} className="checkrow" style={{ borderTop: "1px solid var(--line-soft)", borderBottom: 0 }}>
                  <span className="grow">
                    <span className="t mono" style={{ fontSize: 12 }}>{v.dir_name}</span>
                    <span className="s">
                      {!v.has_jar ? "Never started: start it once from the Minecraft launcher"
                        : v.problem ? v.problem
                        : `Java ${v.label} · pack format ${formatLabel(v.format)} · ${v.extracted ? "extracted" : "not extracted"}`}
                    </span>
                  </span>
                  {v.usable && (v.extracted
                    ? <button className="btn ghost" disabled={busyDir !== null} onClick={() => void clear(v.dir_name, v.label)}>Remove extracted files</button>
                    : <button className="btn" disabled={busyDir !== null} onClick={() => void extract(v.dir_name, v.label)}>{busyDir === v.dir_name ? "Extracting…" : "Extract"}</button>)}
                </div>
              ))}
            </div>

            <div className="row" style={{ gap: 12 }}>
              <span className="dim grow" style={{ fontSize: 12 }}>Blockwright {boot.app_version} preview. Open source under the MIT License. Not affiliated with Mojang or Microsoft.</span>
              <button className="btn ghost" onClick={() => void save({ welcome_seen: false }, "Welcome tour opened.")}>Show the welcome tour</button>
            </div>
          </div>
        </main>
      </div>
      <StatusBar />
    </>
  );
}
