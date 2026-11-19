// Screen 1: start a new pack, recent packs, installed versions.
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, StatusBar, TopBar } from "../components/Shell";
import { api, images, toError, type VersionView } from "../lib/api";
import { agoLabel, baseName, formatLabel, joinPath, safeFileName } from "../lib/logic";
import { useApp } from "../store";

const RESOLUTIONS = [16, 32, 64, 128, 256];

function versionState(v: VersionView): { text: string; color: string } {
  if (!v.has_jar) return { text: "Never started", color: "var(--text-2)" };
  if (v.problem) return { text: "Damaged", color: "var(--warn)" };
  return v.extracted ? { text: "Extracted", color: "var(--ok)" } : { text: "Not extracted", color: "var(--text-2)" };
}

const SOURCE_TEXT = {
  game_files: "read from the game files",
  table: "from the built-in table (old versions do not say it)",
  guess: "estimated: this version is newer than the app knows",
} as const;

export function Welcome() {
  const boot = useApp((s) => s.boot);
  const enterPack = useApp((s) => s.enterPack);
  const showError = useApp((s) => s.showError);
  const toast = useApp((s) => s.toast);
  const go = useApp((s) => s.go);
  const setBoot = useApp((s) => s.setBoot);
  const ask = useApp((s) => s.ask);

  const usable = useMemo(() => (boot?.versions ?? []).filter((v) => v.usable), [boot]);
  const [name, setName] = useState("My Pack");
  const [versionDir, setVersionDir] = useState("");
  const [resolution, setResolution] = useState(16);
  const [location, setLocation] = useState("");
  const [locationEdited, setLocationEdited] = useState(false);
  const [working, setWorking] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    if (!versionDir && usable.length > 0) setVersionDir(usable[0].dir_name);
  }, [usable, versionDir]);

  useEffect(() => {
    if (boot && !locationEdited) setLocation(joinPath(boot.default_packs_dir, safeFileName(name)));
  }, [boot, name, locationEdited]);

  if (!boot) return null;
  const version = usable.find((v) => v.dir_name === versionDir);
  const now = Date.now();

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    try {
      await work();
    } catch (e) {
      showError(e);
    } finally {
      setWorking(false);
    }
  };

  const create = () =>
    run(async () => {
      const pack = await api.createPack({ name, version_dir: versionDir, resolution, location });
      toast(`Created ${pack.project.name}`);
      await enterPack(pack);
    });

  const browseLocation = async () => {
    const dir = await open({ directory: true, title: "Folder that will contain the pack" });
    if (typeof dir === "string") {
      setLocation(joinPath(dir, safeFileName(name)));
      setLocationEdited(true);
    }
  };

  const openFolder = (then?: () => void) =>
    run(async () => {
      const dir = await open({ directory: true, title: "Choose a pack folder (the one that contains pack.mcmeta)" });
      if (typeof dir !== "string") return;
      await enterPack(await api.openPack(dir));
      then?.();
    });

  const importZip = () =>
    run(async () => {
      const zip = await open({ title: "Choose a resource pack .zip", filters: [{ name: "Resource pack", extensions: ["zip"] }] });
      if (typeof zip !== "string") return;
      const title = baseName(zip.replace(/\\/g, "/")).replace(/\.zip$/i, "");
      const dest = joinPath(boot.default_packs_dir, safeFileName(title));
      const pack = await api.importZip(zip, dest);
      toast(`Imported into ${dest}`);
      await enterPack(pack);
    });

  const openRecent = (path: string) =>
    run(async () => {
      try {
        await enterPack(await api.openPack(path));
      } catch (e) {
        const err = toError(e);
        ask({
          title: "This pack could not be opened",
          text: err.message,
          hint: err.hint,
          buttons: [
            { label: "Remove from the list", run: () => void api.forgetRecent(path).then(setBoot) },
            { label: "OK", primary: true },
          ],
        });
      }
    });

  const changeMinecraft = async () => {
    const dir = await open({ directory: true, title: "Choose your .minecraft folder" });
    if (typeof dir === "string") {
      try {
        setBoot(await api.updateSettings({ minecraft_dir: dir }));
      } catch (e) {
        showError(e);
      }
    }
  };

  const recent = showAll ? boot.settings.recent : boot.settings.recent.slice(0, 4);
  const withJar = boot.versions.filter((v) => v.has_jar).length;

  return (
    <>
      <TopBar right={<span className="dim">No pack open</span>} />
      <div className="body">
        <NavBar />
        <main className="page">
          <div className="start">
            <section>
              <div>
                <h1>Start a new pack</h1>
                <p className="lead">Pick a Minecraft version and a resolution. Textures are extracted from your game automatically.</p>
              </div>

              {boot.minecraft_error ? (
                <div className="banner warn">
                  <Icon name="warn" width={2} color="var(--warn)" />
                  <div className="grow">
                    {boot.minecraft_error.message} {boot.minecraft_error.hint}
                  </div>
                  <a onClick={changeMinecraft} style={{ fontSize: 12 }}>Choose folder</a>
                </div>
              ) : (
                <div className="banner">
                  <Icon name={usable.length ? "check" : "warn"} width={2} color={usable.length ? "var(--link)" : "var(--warn)"} />
                  <div className="grow">
                    {usable.length ? "Minecraft found in " : "Minecraft folder: "}
                    <span className="mono" style={{ fontSize: 12 }}>{boot.minecraft_dir}</span>
                    {" · "}
                    {usable.length
                      ? `${withJar} version${withJar === 1 ? "" : "s"} installed`
                      : "no version has been started yet. Start a version once from the Minecraft launcher, then come back."}
                  </div>
                  <a onClick={changeMinecraft} style={{ fontSize: 12 }}>Change</a>
                </div>
              )}

              <div className="card newpack">
                <div className="field">
                  <label htmlFor="packname">Pack name</label>
                  <input id="packname" className="input" value={name} onChange={(e) => setName(e.target.value)} spellCheck={false} />
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                  <div className="field" style={{ flex: "1 1 220px" }}>
                    <label htmlFor="ver">Minecraft version</label>
                    <select id="ver" className="input" value={versionDir} onChange={(e) => setVersionDir(e.target.value)} disabled={usable.length === 0}>
                      {usable.length === 0 && <option>No version available</option>}
                      {usable.map((v) => (
                        <option key={v.dir_name} value={v.dir_name}>
                          Java {v.label}{v.dir_name !== v.label ? ` (${v.dir_name})` : ""} · installed
                        </option>
                      ))}
                    </select>
                    <div className="hint">
                      {version ? `Pack format ${formatLabel(version.format)} · ${version.format_source ? SOURCE_TEXT[version.format_source] : ""}` : " "}
                    </div>
                  </div>
                  <div className="field" style={{ flex: "1 1 220px" }}>
                    <span className="label">Resolution</span>
                    <div className="seg" role="group" aria-label="Resolution">
                      {RESOLUTIONS.map((r) => (
                        <button key={r} className={r === resolution ? "on" : ""} onClick={() => setResolution(r)}>{r}×</button>
                      ))}
                    </div>
                    <div className="hint">GUI and entities can use their own scale later</div>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="loc">Location</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input id="loc" className="input mono grow" value={location} spellCheck={false}
                      onChange={(e) => { setLocation(e.target.value); setLocationEdited(true); }} />
                    <button className="btn" style={{ height: 36, padding: "0 14px" }} onClick={browseLocation}>Browse</button>
                  </div>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, paddingTop: 4 }}>
                  <button className="btn primary lg" onClick={create} disabled={working || !version || !name.trim() || !location.trim()}>Create pack</button>
                  <span className="dim" style={{ fontSize: 12 }}>Creates the folder, pack.mcmeta and a placeholder pack.png</span>
                </div>
              </div>

              <div className="quick">
                <button onClick={() => openFolder()} disabled={working}>
                  <Icon name="folder" size={20} color="var(--text-soft)" />
                  <span><span className="t">Open pack folder</span><span className="s">Continue an existing pack</span></span>
                </button>
                <button onClick={importZip} disabled={working}>
                  <Icon name="export" size={20} color="var(--text-soft)" />
                  <span><span className="t">Import .zip</span><span className="s">Edit a pack you downloaded</span></span>
                </button>
                <button
                  disabled={working}
                  onClick={() => openFolder(() => { go("export"); toast("Tick the versions to port to under “Also export a copy for”."); })}
                >
                  <Icon name="clock" size={20} color="var(--text-soft)" />
                  <span><span className="t">Port to another version</span><span className="s">Renames files between versions</span></span>
                </button>
              </div>
            </section>

            <aside>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <h2>Recent packs</h2>
                {boot.settings.recent.length > 4 && (
                  <a style={{ fontSize: 12 }} onClick={() => setShowAll(!showAll)}>{showAll ? "Show fewer" : "Show all"}</a>
                )}
              </div>
              <div className="card recent">
                {recent.length === 0 && <div className="empty">Packs you create or open will appear here.</div>}
                {recent.map((p) => (
                  <button key={p.path} className="item" onClick={() => openRecent(p.path)} title={p.path} disabled={working}>
                    <div className="icon"><img className="pixel" src={images.recentIcon(p.path)} alt="" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} /></div>
                    <div className="grow col" style={{ gap: 6 }}>
                      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
                        <span className="ellipsis" style={{ fontWeight: 500 }}>{p.name}</span>
                        <span className="dim" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{agoLabel(p.opened_ms, now)}</span>
                      </div>
                      <div className="row" style={{ gap: 8 }}>
                        <div className="bar"><div style={{ width: `${p.total ? Math.min(100, (p.done / p.total) * 100) : 0}%` }} /></div>
                        <span className="dim" style={{ fontSize: 11, whiteSpace: "nowrap" }}>
                          {p.version} · {p.resolution}× · {p.done} / {p.total || "?"}
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <h2 style={{ marginTop: 8 }}>Installed versions</h2>
              <div className="card installs">
                {boot.versions.length === 0 && <div className="empty">No Minecraft version found on this computer.</div>}
                {boot.versions.map((v) => {
                  const st = versionState(v);
                  return (
                    <div key={v.dir_name} className="v" title={v.problem ?? (v.has_jar ? "" : "Start this version once from the Minecraft launcher to use it.")}>
                      <span className="mono ellipsis">{v.dir_name}</span>
                      <span style={{ color: st.color, whiteSpace: "nowrap" }}>{st.text}</span>
                    </div>
                  );
                })}
              </div>
            </aside>
          </div>
        </main>
      </div>
      <StatusBar />
    </>
  );
}
