// "Batch import" dialog of the texture browser: every PNG of a folder (or the
// dropped files) matched to a texture of the pack, for review before import.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../editor/editorStore";
import { api, images, type BatchRow, type BatchScan } from "../lib/api";
import {
  canImport, checkAll, clashingTargets, countRows, effectiveStatus, initialChoices, planImport, resultSummary, setChecked,
  setFrames, setTarget, type Choices,
} from "../lib/batch";
import { baseName, virtualWindow } from "../lib/logic";
import { useApp } from "../store";

interface Props {
  scan: BatchScan;
  /** Changes with every scan, so thumbnails of an earlier scan are not reused. */
  scanStamp: number;
  onClose: () => void;
}

const ROW_H = 46;
type View = "all" | "checked" | "choose" | "skipped";

const STATUS_LABEL = {
  new: "New",
  replaces: "Replaces",
  same: "Same pixels as the pack",
  unknown: "Unknown",
  ambiguous: "Choose a texture",
} as const;

const RULE_LABEL = {
  pack_path: "Found by its path in a pack",
  texture_path: "Found by its folder and name",
  file_name: "Found by its file name",
  none: "No texture of this version has this name",
} as const;

export function BatchImportDialog({ scan, scanStamp, onClose }: Props) {
  const pack = useApp((s) => s.pack)!;
  const tabs = useEditor((s) => s.tabs);
  const [choices, setChoices] = useState<Choices>(() => initialChoices(scan.rows));
  const [view, setView] = useState<View>("all");
  const [working, setWorking] = useState(false);
  const rows = scan.rows;

  const unsaved = useMemo(
    () => new Set(tabs.filter((t) => t.packDir === pack.dir && t.doc.dirty).map((t) => t.doc.path)),
    [tabs, pack.dir],
  );
  const clashes = useMemo(() => clashingTargets(rows, choices), [rows, choices]);
  // duplicate targets that already have a ticked file
  const resolved = useMemo(
    () => new Set(rows.flatMap((r) => (choices[r.id]?.checked && choices[r.id].target ? [choices[r.id].target!] : []))),
    [rows, choices],
  );
  const counts = useMemo(() => countRows(rows, choices), [rows, choices]);
  const plan = useMemo(() => planImport(rows, choices, unsaved), [rows, choices, unsaved]);

  const needsChoice = (r: BatchRow) => {
    const c = choices[r.id];
    return (r.status === "ambiguous" && !c?.target) || (!!c?.target && clashes.has(c.target) && !resolved.has(c.target));
  };
  const shown = useMemo(() => rows.filter((r) => {
    const c = choices[r.id];
    if (view === "checked") return c?.checked;
    if (view === "choose") return r.status === "ambiguous" || r.duplicate || (!!c?.target && clashes.has(c.target));
    if (view === "skipped") return !c?.checked;
    return true;
  }), [rows, choices, view, clashes]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, working]);

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
  }, [view]);
  const win = virtualWindow(scrollTop, viewport, ROW_H, shown.length);

  const runImport = async () => {
    const app = useApp.getState();
    if (plan.items.length === 0) return;
    setWorking(true);
    try {
      const results = await api.batchImport(plan.items, pack.dir);
      await app.reload(true);
      const imported = results.filter((r) => r.ok).map((r) => r.target);
      const failed = results.filter((r) => !r.ok);
      onClose();
      app.toast(resultSummary(results, plan.skipped.length), failed.length || plan.skipped.length ? "warn" : "ok",
        imported.length
          ? { label: "Show", run: () => useApp.getState().setFilters({ only: imported, onlyLabel: "just imported", search: "" }) }
          : undefined);
      if (failed.length || plan.skipped.length) {
        const byId = new Map(rows.map((r) => [r.id, r]));
        const lines = [
          ...failed.map((f) => `${byId.get(f.id)?.rel ?? f.target} → ${f.target}: ${f.error?.message ?? "failed"}`),
          ...plan.skipped.map((s) => `${s.row.rel}: ${s.reason}`),
        ];
        app.ask({
          title: `${lines.length} file${lines.length === 1 ? " was" : "s were"} not imported`,
          text: lines.slice(0, 20).join("\n") + (lines.length > 20 ? `\n…and ${lines.length - 20} more` : ""),
          hint: "The other files were imported. Nothing in the pack was lost: replaced files are in .packcreator/trash.",
          buttons: [{ label: "OK", primary: true }],
        });
      }
    } catch (e) {
      setWorking(false);
      app.showError(e, "The images could not be imported");
    }
  };

  const total = plan.items.length;
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Batch import" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onClose(); }}>
      <div className="modal xwide batch">
        <h2>Batch import</h2>
        <p className="ellipsis" title={scan.folder}>
          {counts.total} PNG file{counts.total === 1 ? "" : "s"} in <span className="mono">{scan.folder}</span>, matched to Minecraft {pack.version?.label ?? pack.project.version_dir} textures.
          Images are copied exactly as they are: never resized, never changed.
        </p>
        {scan.truncated && <div className="notice warnline">Only the first {counts.total} PNG files are listed. Pick a smaller folder to see the rest.</div>}
        {scan.skipped_pack && <div className="notice">Files inside this pack itself were left out.</div>}

        <div className="batchbar">
          <div className="seg sm" role="group" aria-label="Show">
            <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>All ({counts.total})</button>
            <button className={view === "checked" ? "on" : ""} onClick={() => setView("checked")}>To import ({counts.checked})</button>
            <button className={view === "choose" ? "on" : ""} onClick={() => setView("choose")}>Needs a choice ({rows.filter(needsChoice).length})</button>
            <button className={view === "skipped" ? "on" : ""} onClick={() => setView("skipped")}>Not imported ({counts.total - counts.checked})</button>
          </div>
          <div className="counts">
            <span className="bchip new">{counts.new} new</span>
            <span className="bchip replaces">{counts.replaces} replace</span>
            <span className="bchip same">{counts.same} same</span>
            <span className="bchip ambiguous">{counts.ambiguous} to choose</span>
            {counts.duplicates > 0 && <span className="bchip ambiguous">{counts.duplicates} duplicates</span>}
            <span className="bchip unknown">{counts.unknown} unknown</span>
            {counts.wrongSize > 0 && <span className="bchip size">{counts.wrongSize} wrong size</span>}
          </div>
        </div>

        <div className="btable">
          <div className="bcols bhead">
            <span><input type="checkbox" aria-label="Tick all" checked={counts.checked > 0} ref={(el) => { if (el) el.indeterminate = counts.checked > 0 && counts.checked < rows.filter((r) => canImport(r, choices[r.id])).length; }} onChange={(e) => setChoices(checkAll(rows, choices, e.target.checked))} /></span>
            <span />
            <span>FILE</span>
            <span />
            <span>BECOMES</span>
            <span>STATUS</span>
            <span>FRAMES</span>
          </div>
          <div className="bbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            {shown.length === 0 && <div className="dim" style={{ padding: 16, fontSize: 12 }}>Nothing here.</div>}
            <div style={{ height: win.padTop }} />
            {shown.slice(win.first, win.last).map((r) => {
              const c = choices[r.id];
              const status = r.problem ? "unknown" : effectiveStatus(r, c);
              const clash = !!c?.target && clashes.has(c.target);
              const blocked = !!c?.target && unsaved.has(c.target);
              return (
                <div key={r.id} className={`bcols brow ${c?.checked ? "on" : ""}`}>
                  <span>
                    <input
                      type="checkbox"
                      aria-label={`Import ${r.rel}`}
                      checked={!!c?.checked}
                      disabled={!canImport(r, c) || working}
                      onChange={(e) => setChoices(setChecked(rows, choices, r.id, e.target.checked))}
                    />
                  </span>
                  <span className="thumb checker"><img className="pixel" loading="lazy" src={images.batchThumb(r.id, scanStamp)} alt="" /></span>
                  <span className="src" title={r.source}>
                    <span className="mono ellipsis">{baseName(r.rel)}</span>
                    <span className="dim ellipsis">{r.rel.includes("/") ? r.rel.slice(0, r.rel.lastIndexOf("/")) : " "} · {r.width}×{r.height}</span>
                  </span>
                  <span className="dim">→</span>
                  <span className="tgt">
                    {r.status === "ambiguous" ? (
                      <select
                        className="input"
                        aria-label={`Texture for ${r.rel}`}
                        value={c?.target ?? ""}
                        disabled={working}
                        onChange={(e) => setChoices(setTarget(rows, choices, r.id, e.target.value || null))}
                      >
                        <option value="">Choose one of {r.candidates.length}…</option>
                        {r.candidates.map((x) => <option key={x.path} value={x.path}>{x.path}{x.in_pack ? " (in pack)" : ""}</option>)}
                      </select>
                    ) : c?.target ? (
                      <>
                        <span className="mono ellipsis" title={c.target}>{c.target}</span>
                        <span className="dim ellipsis" title={RULE_LABEL[r.rule]}>
                          {r.renamed_from ? `renamed from ${r.renamed_from}` : RULE_LABEL[r.rule]}
                        </span>
                      </>
                    ) : (
                      <span className="dim ellipsis">{r.problem ?? RULE_LABEL[r.rule]}</span>
                    )}
                  </span>
                  <span className="chips">
                    <span className={`bchip ${status}`}>{r.problem ? "Cannot read" : STATUS_LABEL[status]}</span>
                    {clash && (c?.checked
                      ? <span className="bchip same" title="Another file also matches this texture; this one is imported">Duplicate: this one</span>
                      : resolved.has(c!.target!)
                        ? <span className="bchip same" title="Another file is imported as this texture">Duplicate: not used</span>
                        : <span className="bchip ambiguous" title="Two files would become this texture: tick the one to keep">Duplicate: pick one</span>)}
                    {r.wrong_size && r.expected && <span className="bchip size" title={`The pack is ${pack.project.resolution}×: this texture is usually ${r.expected[0]}×${r.expected[1]}. It is imported as it is.`}>Not {r.expected[0]}×{r.expected[1]}</span>}
                    {r.has_mcmeta && <span className="bchip same" title="The .mcmeta next to the file is imported with it">+ .mcmeta</span>}
                    {blocked && <span className="bchip unknown" title="Save or close the texture in the editor first">Unsaved in editor</span>}
                  </span>
                  <span>
                    {r.strip_frames ? (
                      <label className="check" title={`Use as ${r.strip_frames} animation frames (writes an .mcmeta, frame time 2)`}>
                        <input type="checkbox" checked={!!c?.frames} disabled={working} onChange={(e) => setChoices(setFrames(choices, r.id, e.target.checked))} />
                        {r.strip_frames} frames?
                      </label>
                    ) : <span className="dim">—</span>}
                  </span>
                </div>
              );
            })}
            <div style={{ height: win.padBottom }} />
          </div>
        </div>

        <div className="buttons">
          {plan.skipped.length > 0 && <span className="dim" style={{ marginRight: "auto", fontSize: 12, alignSelf: "center" }}>{plan.skipped.length} ticked file{plan.skipped.length === 1 ? "" : "s"} skipped: unsaved changes in the editor.</span>}
          <button className="btn md" onClick={onClose} disabled={working}>Cancel</button>
          <button className="btn md primary" disabled={total === 0 || working} onClick={() => void runImport()}>
            {working ? "Importing…" : `Import ${total} texture${total === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
