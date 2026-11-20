// Screen 5: pack settings, checks with one-click fixes, export.
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import { NavBar, StatusBar, TopBar } from "../components/Shell";
import { PACK_ICON } from "../editor/doc";
import { useEditor } from "../editor/editorStore";
import { api, images, type Check, type VersionView } from "../lib/api";
import { bytesLabel, formatLabel, joinPath, parseSectionCodes, safeFileName, timeLabel } from "../lib/logic";
import { useApp } from "../store";

/** True for versions before the 1.13 rename of blocks/ and items/. */
function isOld(label: string): boolean {
  const m = label.match(/^1\.(\d+)/);
  return m !== null && Number(m[1]) < 13;
}

function altNote(main: string, v: VersionView): string {
  const names = isOld(main) !== isOld(v.label)
    ? isOld(v.label) ? "Old names (blocks/, items/) · files renamed automatically" : "New names (block/, item/) · files renamed automatically"
    : "Same folders · renamed files adjusted automatically";
  return `${names} · format ${formatLabel(v.format)}`;
}

export function Export() {
  const pack = useApp((s) => s.pack)!;
  const boot = useApp((s) => s.boot)!;
  const summary = useApp((s) => s.summary);
  const stamp = useApp((s) => s.stamp);
  const { setPack, setBoot, toast, showError, go, setFilters, reload, setBusy, ask } = useApp.getState();

  const project = pack.project;
  const mainLabel = pack.version?.label ?? project.version_id ?? project.version_dir;
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [folder, setFolder] = useState(boot.settings.export_kind_folder);
  const [install, setInstall] = useState(boot.settings.export_install);
  const [onlyChanged, setOnlyChanged] = useState(boot.settings.export_only_changed);
  const [also, setAlso] = useState<string[]>(project.also_export);
  const [working, setWorking] = useState(false);
  const now = Date.now();

  // one entry per real game version, other than the pack's own
  const alts = useMemo(() => {
    const seen = new Set<string>([mainLabel]);
    return boot.versions.filter((v) => {
      if (!v.usable || !v.format || seen.has(v.label)) return false;
      seen.add(v.label);
      return true;
    });
  }, [boot.versions, mainLabel]);

  const refreshChecks = useCallback(() => {
    api.runChecks().then(setChecks).catch(() => setChecks([]));
  }, []);
  useEffect(refreshChecks, [refreshChecks, stamp]);

  const saveProject = async (patch: { name?: string; description?: string }) => {
    try {
      setPack(await api.updateProject(patch));
      refreshChecks();
    } catch (e) {
      showError(e);
      setName(project.name);
    }
  };

  const fix = async (c: Check) => {
    if (c.fix === "Show") {
      setFilters({ only: c.paths, search: "" });
      go("textures");
      return;
    }
    try {
      toast(await api.applyFix(c.id));
      await reload(true);
      refreshChecks();
    } catch (e) {
      showError(e, "The fix could not be applied");
    }
  };

  const importIcon = async () => {
    const src = await open({ title: "Choose a square PNG (128×128 or 256×256 work well)", filters: [{ name: "PNG image", extensions: ["png"] }] });
    if (typeof src !== "string") return;
    try {
      await api.setPackIcon(src);
      await reload(true);
      refreshChecks();
      toast("Pack icon replaced.");
    } catch (e) {
      showError(e, "The icon could not be used");
    }
  };

  // "Draw" opens the icon in the built-in editor, on its own tab; saving writes pack.png
  const drawIcon = () => void useEditor.getState().openTexture(PACK_ICON);

  const openIconExternally = async () => {
    try {
      await api.editPackIcon();
      toast("Opened pack.png in your image editor. It refreshes here when you save.");
    } catch (e) {
      showError(e, "The icon could not be opened");
    }
  };

  const target = joinPath(pack.export_dir, `${safeFileName(project.name)} ${safeFileName(mainLabel)}${folder ? "" : ".zip"}`);
  const toFix = (checks ?? []).filter((c) => !c.ok).length;
  const iconCheck = checks?.find((c) => c.id === "pack_files" && c.ok);

  const doExport = async () => {
    setWorking(true);
    try {
      // copies for other versions need that version's texture list
      for (const dir of also) {
        const v = boot.versions.find((x) => x.dir_name === dir);
        if (v && !v.extracted) {
          setBusy({ text: `Extracting textures from Minecraft ${v.label}…`, done: 0, total: 0 });
          await api.extractVersion(dir);
        }
      }
      setBusy({ text: "Exporting…", done: 0, total: 0 });
      const report = await api.exportPack({ folder, install, only_changed: onlyChanged, also });
      setPack(report.pack);
      setBoot(await api.bootstrap());
      await reload(true);
      const first = report.outputs[0];
      const skipped = report.outputs.reduce((n, o) => n + o.skipped.length, 0);
      const copies = report.outputs.length - 1;
      const extra = copies > 0 ? ` and ${copies} more cop${copies === 1 ? "y" : "ies"}` : "";
      toast(
        `Exported ${first.files} files for ${first.version}${extra}${first.installed_to ? ", installed into Minecraft" : ""}.`,
        "ok",
        { label: "Show in folder", run: () => void api.reveal(first.path).catch(() => {}) },
      );
      if (skipped > 0) {
        const lines = report.outputs
          .filter((o) => o.skipped.length)
          .map((o) => `${o.version}: ${o.skipped.slice(0, 6).join(", ")}${o.skipped.length > 6 ? ` and ${o.skipped.length - 6} more` : ""}`);
        ask({
          title: `${skipped} texture${skipped === 1 ? " was" : "s were"} left out`,
          text: lines.join("\n"),
          hint: "This is expected: a texture is left out when it does not exist in that version, or when it is identical to the game's.",
          buttons: [{ label: "OK", primary: true }],
        });
      }
    } catch (e) {
      showError(e, "The export did not finish");
    } finally {
      setBusy(null);
      setWorking(false);
    }
  };

  return (
    <>
      <TopBar right={<span className="dim">{project.last_export_ms ? `Last export: ${timeLabel(project.last_export_ms, now)}` : "Not exported yet"}</span>} />
      <div className="body">
        <NavBar />
        <main className="page">
          <div className="exportpage">
            <section>
              <h1>Pack settings</h1>

              <div className="card pad" style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
                <div className="col" style={{ gap: 10, alignItems: "center" }}>
                  <div className="iconbox checker">
                    <img className="pixel" src={images.packIcon(stamp)} alt="Pack icon" onError={(e) => { e.currentTarget.style.visibility = "hidden"; }} />
                  </div>
                  <div className="dim" style={{ fontSize: 11 }}>pack.png{iconCheck ? ` · ${iconCheck.detail.split(" · ")[0]}` : ""}</div>
                  <div className="row" style={{ gap: 6 }}>
                    <button className="btn" title="Draw the icon in the built-in editor" onClick={drawIcon}>Draw</button>
                    <button className="btn" title="Use a PNG file as the icon" onClick={importIcon}>Import</button>
                  </div>
                  <button className="btn ghost" title="Open pack.png in your own image editor" onClick={openIconExternally}>Open externally</button>
                </div>
                <div className="col grow" style={{ flex: "1 1 260px", gap: 16 }}>
                  <div className="field">
                    <label htmlFor="pn">Name</label>
                    <input id="pn" className="input sm" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)}
                      onBlur={() => name.trim() !== project.name && void saveProject({ name })} />
                  </div>
                  <div className="field">
                    <label htmlFor="desc">Description</label>
                    <input id="desc" className="input sm mono" value={description} spellCheck={false} onChange={(e) => setDescription(e.target.value)}
                      onBlur={() => description !== project.description && void saveProject({ description })} />
                    <div className="descprev">
                      <span className="dim" style={{ fontSize: 11 }}>Preview</span>
                      {parseSectionCodes(description).map((r, i) => (
                        <span
                          key={i}
                          style={{
                            color: r.color, fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? "italic" : "normal", whiteSpace: "pre",
                            textDecoration: [r.underline ? "underline" : "", r.strike ? "line-through" : ""].join(" ").trim() || "none",
                          }}
                        >
                          {r.text}
                        </span>
                      ))}
                    </div>
                    <div className="hint">Colours: type § and a code, for example §b for aqua or §7 for grey.</div>
                  </div>
                </div>
              </div>

              <div className="card pad col" style={{ gap: 14 }}>
                <h2>Versions</h2>
                <div className="mainver">
                  <div>
                    <div style={{ fontWeight: 500 }}>Java {mainLabel}</div>
                    <div className="dim" style={{ fontSize: 11 }}>Main version · pack format {formatLabel(project.format)}</div>
                  </div>
                  <span style={{ fontSize: 11, color: "var(--link)" }}>Main</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-soft)" }}>Also export a copy for:</div>
                {alts.length === 0 && <div className="dim" style={{ fontSize: 12 }}>No other usable Minecraft version is installed on this computer.</div>}
                {alts.map((v) => (
                  <label key={v.dir_name} className="alt">
                    <input type="checkbox" checked={also.includes(v.dir_name)}
                      onChange={(e) => setAlso(e.target.checked ? [...also, v.dir_name] : also.filter((d) => d !== v.dir_name))} />
                    <span className="grow"><span className="t">Java {v.label}</span><span className="s">{altNote(mainLabel, v)}</span></span>
                  </label>
                ))}
              </div>
            </section>

            <aside>
              <div className="card checks" style={{ overflow: "hidden" }}>
                <div className="head">
                  <h2>Checks</h2>
                  <span style={{ fontSize: 12, color: toFix ? "var(--warn)" : "var(--ok)" }}>
                    {checks === null ? "Checking…" : toFix ? `${toFix} to fix` : "All good"}
                  </span>
                </div>
                {(checks ?? []).map((c) => (
                  <div key={c.id} className="checkrow">
                    <span className={`badge ${c.ok ? "ok" : "warn"}`}>{c.ok ? "✓" : "!"}</span>
                    <span className="grow"><span className="t">{c.title}</span><span className="s">{c.detail}</span></span>
                    {c.fix && <button className="btn" style={{ height: 28, padding: "0 10px" }} onClick={() => void fix(c)}>{c.fix}</button>}
                  </div>
                ))}
              </div>

              <div className="card col" style={{ padding: 18, gap: 14 }}>
                <h2>Export</h2>
                <div className="seg sm" role="group" aria-label="Format">
                  <button className={!folder ? "on" : ""} onClick={() => setFolder(false)}>.zip file</button>
                  <button className={folder ? "on" : ""} onClick={() => setFolder(true)}>Folder</button>
                </div>
                <label className="check"><input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} /> Install into Minecraft’s resourcepacks folder</label>
                <label className="check"><input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only include textures you changed</label>
                <div className="mono dim" style={{ fontSize: 11, overflowWrap: "anywhere", userSelect: "text" }}>→ {target}</div>
                <button className="btn primary xl" onClick={doExport} disabled={working}>{working ? "Exporting…" : "Export pack"}</button>
              </div>
            </aside>
          </div>
        </main>
      </div>
      <StatusBar>
        {summary && <span>{summary.textures} texture{summary.textures === 1 ? "" : "s"} · {summary.animated} animated · {bytesLabel(summary.bytes)}</span>}
      </StatusBar>
    </>
  );
}
