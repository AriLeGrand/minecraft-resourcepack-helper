// "Compare with another pack…" (Pack and export, Ctrl+K): pick a .zip or a
// folder, see what differs, look at theirs / mine / the game side by side,
// copy their textures into the open pack, or share the list as text.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useEditor } from "../editor/editorStore";
import { api, images, type Comparison } from "../lib/api";
import {
  canCopy, COMPARE_LABEL, compareFileName, compareShareText, countCompare, filterCompare, planCopy, rowName, rowNote, shortName, tickShown,
  type CompareFilter, type CompareShareFormat,
} from "../lib/compare";
import { formatLabel, joinPath, parseSectionCodes, virtualWindow } from "../lib/logic";
import { useApp } from "../store";

interface CompareState {
  /** The "zip or folder?" question is shown. */
  asking: boolean;
  result: Comparison | null;
  /** Changes with every comparison, so images of an earlier one are not reused. */
  stamp: number;
}

const useCompare = create<CompareState>(() => ({ asking: false, result: null, stamp: 0 }));

/** Opens "Compare with another pack" (asks for a .zip or a folder first). */
export const openCompare = () => useCompare.setState({ asking: true });

async function runCompare(source: string): Promise<boolean> {
  const app = useApp.getState();
  const pack = app.pack;
  if (!pack) return false;
  app.setBusy({ text: "Comparing the packs…", done: 0, total: 0 });
  try {
    const result = await api.comparePacks(source, pack.dir);
    useCompare.setState({ asking: false, result, stamp: Date.now() });
    return true;
  } catch (e) {
    app.showError(e, "The packs could not be compared");
    return false;
  } finally {
    app.setBusy(null);
  }
}

async function choose(kind: "zip" | "folder") {
  const pack = useApp.getState().pack;
  const picked = kind === "zip"
    ? await open({ title: "Choose the other pack (.zip)", filters: [{ name: "Resource pack", extensions: ["zip"] }], defaultPath: pack?.export_dir })
    : await open({ title: "Choose the other pack's folder", directory: true, defaultPath: pack?.export_dir });
  if (typeof picked === "string") await runCompare(picked);
}

// Development only: the native file dialog cannot be driven by the test tool
// (tools/shot.mjs), so it can hand a path straight to the comparison (like D-055).
if (import.meta.env.DEV) {
  const w = window as unknown as { __packCreatorDev?: Record<string, unknown> };
  w.__packCreatorDev = { ...w.__packCreatorDev, compare: runCompare };
}

/** Renders the dialogs; mounted once in App. */
export function CompareHost() {
  const asking = useCompare((s) => s.asking);
  const result = useCompare((s) => s.result);
  const stamp = useCompare((s) => s.stamp);
  const pack = useApp((s) => s.pack);
  // a comparison belongs to the pack it was made for
  useEffect(() => {
    useCompare.setState({ result: null, asking: false });
  }, [pack?.dir]);
  if (!pack) return null;
  if (result) return <CompareDialog result={result} stamp={stamp} onClose={() => useCompare.setState({ result: null })} />;
  if (asking) return <AskSource onClose={() => useCompare.setState({ asking: false })} />;
  return null;
}

function AskSource({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Compare with another pack" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <h2>Compare with another pack</h2>
        <p>See which textures differ between your pack and another one: a friend’s version, an older export, or a pack made for another Minecraft version (old names are understood). Nothing is changed until you copy.</p>
        <div className="buttons">
          <button className="btn md" onClick={onClose}>Cancel</button>
          <button className="btn md" onClick={() => void choose("folder")}>A folder…</button>
          <button className="btn md primary" autoFocus onClick={() => void choose("zip")}>A .zip file…</button>
        </div>
      </div>
    </div>
  );
}

const ROW_H = 44;
const FILTERS: CompareFilter[] = ["all", "different", "only_theirs", "only_mine", "same"];

function Description({ text }: { text: string }) {
  return (
    <span className="ellipsis">
      {parseSectionCodes(text).map((r, i) => (
        <span key={i} style={{ color: r.color, fontWeight: r.bold ? 700 : 400, fontStyle: r.italic ? "italic" : "normal" }}>{r.text}</span>
      ))}
    </span>
  );
}

/** A large, hard-pixel picture, scaled by a whole number to fit its box when it can. */
function BigPicture({ src, label, size, note }: { src: string | null; label: string; size: [number, number] | null; note?: string }) {
  const box = 140;
  const [natural, setNatural] = useState<[number, number] | null>(null);
  const shown = size ?? natural;
  const side = shown ? Math.max(shown[0], shown[1]) : 0;
  const k = side > 0 && side <= box ? Math.floor(box / side) : 0;
  const style = shown && k > 0 ? { width: shown[0] * k, height: shown[1] * k } : { maxWidth: box, maxHeight: box };
  return (
    <div className="cmpbig">
      <div className="pic checker">
        {src
          ? <img className="pixel" src={src} alt={label} style={style} onLoad={(e) => setNatural([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} />
          : <span className="dim">{note ?? "None"}</span>}
      </div>
      <div className="lbl"><b>{label}</b>{shown && <span className="dim"> · {shown[0]}×{shown[1]}</span>}</div>
    </div>
  );
}

function CompareDialog({ result, stamp, onClose }: { result: Comparison; stamp: number; onClose: () => void }) {
  const pack = useApp((s) => s.pack)!;
  const appStamp = useApp((s) => s.stamp);
  const tabs = useEditor((s) => s.tabs);
  const [filter, setFilter] = useState<CompareFilter>(() => (countCompare(result.rows).different > 0 ? "different" : "all"));
  const [search, setSearch] = useState("");
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<number | null>(null);
  const [working, setWorking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const rows = result.rows;
  const counts = useMemo(() => countCompare(rows), [rows]);
  const shown = useMemo(() => filterCompare(rows, filter, search), [rows, filter, search]);
  const unsaved = useMemo(() => new Set(tabs.filter((t) => t.packDir === pack.dir && t.doc.dirty).map((t) => t.doc.path)), [tabs, pack.dir]);
  const plan = useMemo(() => planCopy(rows, ticked, unsaved), [rows, ticked, unsaved]);
  const current = rows.find((r) => r.id === selected) ?? shown[0] ?? null;
  const version = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working && !sharing) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, working, sharing]);

  // virtual list
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filter, search]);
  const win = virtualWindow(scrollTop, viewport, ROW_H, shown.length);
  const copyable = shown.filter(canCopy);
  const allTicked = copyable.length > 0 && copyable.every((r) => ticked.has(r.id));

  const copyTheirs = async () => {
    const app = useApp.getState();
    if (plan.ids.length === 0) return;
    setWorking(true);
    try {
      const results = await api.compareCopy(plan.ids, pack.dir);
      await app.reload(true);
      const ok = results.filter((r) => r.ok && !r.unchanged);
      const failed = results.filter((r) => !r.ok);
      const replaced = ok.filter((r) => r.replaced).length;
      const parts = [`Copied ${ok.length} texture${ok.length === 1 ? "" : "s"} from ${result.name}, byte for byte`];
      if (replaced) parts.push(`${replaced} replaced (the old files are in the pack's trash)`);
      if (plan.skipped.length) parts.push(`${plan.skipped.length} skipped`);
      if (failed.length) parts.push(`${failed.length} failed`);
      app.toast(`${parts.join(", ")}.`, failed.length || plan.skipped.length ? "warn" : "ok");
      if (failed.length || plan.skipped.length) {
        const byId = new Map(rows.map((r) => [r.id, r]));
        app.ask({
          title: `${failed.length + plan.skipped.length} texture${failed.length + plan.skipped.length === 1 ? " was" : "s were"} not copied`,
          text: [
            ...failed.map((f) => `${rowName(byId.get(f.id)!)}: ${f.error?.message ?? "failed"}`),
            ...plan.skipped.map((s) => `${rowName(s.row)}: ${s.reason}`),
          ].slice(0, 20).join("\n"),
          hint: "The other textures were copied. Nothing in your pack was lost: replaced files are in .packcreator/trash.",
          buttons: [{ label: "OK", primary: true }],
        });
      }
      setTicked(new Set());
      // compare again, so the list shows the new state
      await runCompare(result.source);
    } catch (e) {
      app.showError(e, "The textures could not be copied");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Compare with another pack" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onClose(); }}>
      <div className="modal xwide batch cmp">
        <div className="row" style={{ gap: 10, alignItems: "baseline" }}>
          <h2 className="ellipsis">{pack.project.name} compared with {result.name}</h2>
          {result.format && <span className="dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>their format {formatLabel(result.format)}</span>}
        </div>
        <div className="dim row" style={{ fontSize: 12, gap: 8 }}>
          {result.description && <Description text={result.description} />}
          <span className="mono ellipsis grow" style={{ fontSize: 11, textAlign: "right" }} title={result.source}>{result.source}</span>
        </div>
        {(result.skipped_big > 0 || result.truncated) && (
          <div className="notice warnline">
            {result.skipped_big > 0 && `${result.skipped_big} file${result.skipped_big === 1 ? " was" : "s were"} too big to compare (over 16 MB). `}
            {result.truncated && "The .zip has a very large number of files: only the first 50 000 were read."}
          </div>
        )}

        <div className="batchbar">
          <div className="seg sm" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                {f === "all" ? "All" : COMPARE_LABEL[f]} ({counts[f]})
              </button>
            ))}
          </div>
          <input className="input sm" style={{ marginLeft: "auto", width: 220 }} placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} spellCheck={false} aria-label="Search the comparison" />
        </div>

        <div className="cmpmain">
          <div className="btable">
            <div className="ccols bhead">
              <span><input type="checkbox" aria-label="Tick all shown" checked={allTicked} disabled={copyable.length === 0 || working} onChange={(e) => setTicked(tickShown(ticked, shown, e.target.checked))} /></span>
              <span>THEIRS</span>
              <span>MINE</span>
              <span>TEXTURE</span>
              <span>RESULT</span>
            </div>
            <div className="bbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
              {shown.length === 0 && <div className="dim" style={{ padding: 16, fontSize: 12 }}>Nothing here.</div>}
              <div style={{ height: win.padTop }} />
              {shown.slice(win.first, win.last).map((r) => {
                const note = rowNote(r);
                return (
                  <div key={r.id} className={`ccols brow crow ${current?.id === r.id ? "sel" : ""} ${ticked.has(r.id) ? "on" : ""}`} onClick={() => setSelected(r.id)}>
                    <span onClick={(e) => e.stopPropagation()}>
                      {canCopy(r) && (
                        <input type="checkbox" aria-label={`Copy theirs: ${rowName(r)}`} checked={ticked.has(r.id)} disabled={working}
                          onChange={(e) => { const n = new Set(ticked); if (e.target.checked) n.add(r.id); else n.delete(r.id); setTicked(n); }} />
                      )}
                    </span>
                    <span className="thumb checker">{r.theirs && <img className="pixel" loading="lazy" src={images.compareTheirs(r.id, stamp)} alt="" />}</span>
                    <span className="thumb checker">{r.my_size && r.path && <img className="pixel" loading="lazy" src={images.packFull(r.path, appStamp)} alt="" />}</span>
                    <span className="src" title={rowName(r)}>
                      <span className="mono ellipsis">{shortName(r)}</span>
                      <span className="dim ellipsis">{note || rowName(r)}</span>
                    </span>
                    <span><span className={`bchip cmp-${r.status}`}>{COMPARE_LABEL[r.status]}</span></span>
                  </div>
                );
              })}
              <div style={{ height: win.padBottom }} />
            </div>
          </div>

          <div className="cmpside">
            {current ? (
              <>
                <div className="mono" style={{ fontSize: 13, overflowWrap: "anywhere", userSelect: "text" }}>{rowName(current)}</div>
                <div className="dim" style={{ fontSize: 11 }}>{COMPARE_LABEL[current.status]}{rowNote(current) ? ` · ${rowNote(current)}` : ""}</div>
                <div className="cmpbigs">
                  <BigPicture key={`t${current.id}-${stamp}`} label="Theirs" src={current.theirs ? images.compareTheirs(current.id, stamp) : null} size={current.their_size} note="Not in their pack" />
                  <BigPicture key={`m${current.id}-${appStamp}`} label="Mine" src={current.my_size && current.path ? images.packFull(current.path, appStamp) : null} size={current.my_size} note="Not in your pack" />
                  <BigPicture key={`g${current.id}`} label={`Game ${version}`} src={current.in_game && current.path ? images.vanillaFull(pack.project.version_dir, current.path) : null} size={null} note="Not in the game" />
                </div>
                {current.theirs && current.theirs !== current.path && <div className="dim mono" style={{ fontSize: 11 }}>Their file: {current.theirs}.png</div>}
              </>
            ) : <div className="dim">Pick a row to see it larger.</div>}
          </div>
        </div>

        <div className="buttons">
          {plan.skipped.length > 0 && <span className="dim" style={{ marginRight: "auto", fontSize: 12, alignSelf: "center" }}>{plan.skipped.length} ticked texture{plan.skipped.length === 1 ? "" : "s"} skipped: unsaved changes in the editor.</span>}
          <button className="btn md" onClick={onClose} disabled={working}>Close</button>
          <button className="btn md" onClick={() => setSharing(true)} disabled={working}>Share list…</button>
          <button className="btn md primary" disabled={plan.ids.length === 0 || working} onClick={() => void copyTheirs()}
            title="Their PNG (and .mcmeta) is copied byte for byte; your file goes to the pack's trash">
            {working ? "Copying…" : `Copy theirs into my pack (${plan.ids.length})`}
          </button>
        </div>
      </div>
      {sharing && <ShareCompare result={result} onClose={() => setSharing(false)} />}
    </div>
  );
}

function ShareCompare({ result, onClose }: { result: Comparison; onClose: () => void }) {
  const pack = useApp((s) => s.pack)!;
  const [format, setFormat] = useState<CompareShareFormat>("markdown");
  const [includeSame, setIncludeSame] = useState(false);
  const version = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  const text = useMemo(() => compareShareText(result, {
    format, includeSame, myName: pack.project.name, subtitle: `Java ${version} · ${pack.project.resolution}× · compared with ${result.source}`,
  }), [result, format, includeSame, pack.project, version]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copy = async () => {
    const { toast, showError } = useApp.getState();
    try {
      await writeText(text);
      toast("Copied the comparison. Paste it where you want to share it.");
      onClose();
    } catch (e) {
      showError(e, "The list could not be copied");
    }
  };
  const saveFile = async () => {
    const { toast, showError } = useApp.getState();
    const path = await save({
      title: "Save the comparison",
      defaultPath: joinPath(pack.export_dir, compareFileName(pack.project.name, result.name, format)),
      filters: [format === "markdown" ? { name: "Markdown", extensions: ["md"] } : { name: "Text", extensions: ["txt"] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.saveShareList(path, text);
      toast("Saved the comparison.", "ok", { label: "Show in folder", run: () => void api.reveal(path).catch(() => {}) });
      onClose();
    } catch (e) {
      showError(e, "The list could not be saved");
    }
  };
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Share the comparison" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <h2>Share the comparison</h2>
        <div className="row" style={{ gap: 12 }}>
          <div className="seg sm" role="group" aria-label="Format" style={{ width: 260 }}>
            <button className={format === "markdown" ? "on" : ""} onClick={() => setFormat("markdown")}>Markdown</button>
            <button className={format === "text" ? "on" : ""} onClick={() => setFormat("text")}>Plain text</button>
          </div>
          <label className="check"><input type="checkbox" checked={includeSame} onChange={(e) => setIncludeSame(e.target.checked)} /> Also list identical textures</label>
        </div>
        <textarea className="sharepreview mono" readOnly value={text} aria-label="Preview of the comparison" spellCheck={false} />
        <div className="buttons">
          <button className="btn md" onClick={onClose}>Close</button>
          <button className="btn md" onClick={() => void saveFile()}>Save as file…</button>
          <button className="btn md primary" autoFocus onClick={() => void copy()}>Copy</button>
        </div>
      </div>
    </div>
  );
}
