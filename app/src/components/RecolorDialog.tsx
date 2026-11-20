// "Recolour textures…" (Ctrl+K and the texture browser) and "Make variants…"
// (texture inspector). Both preview every chosen texture before and after,
// then write through Rust: replaced files go to the trash, the toast offers
// Undo. Textures with unsaved changes in the editor are skipped.
import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useEditor } from "../editor/editorStore";
import { api, type Category, type MapPair, type Recolor, type RecolorPreview, type WriteReport } from "../lib/api";
import { baseName, CATEGORIES } from "../lib/logic";
import { addToFamily, changesNothing, familyOf, NO_ADJUST, pickTextures, splitUnsaved, writeSummary, type Skipped } from "../lib/recolor";
import { useApp } from "../store";
import { Icon } from "./Icon";

/** Which of the two dialogs is open (one host in App, so Ctrl+K can open it from anywhere). */
export const useRecolor = create<{ recolor: boolean; variantsOf: string | null; openRecolor: () => void; openVariants: (path: string) => void; close: () => void }>()((set) => ({
  recolor: false,
  variantsOf: null,
  openRecolor: () => set({ recolor: true, variantsOf: null }),
  openVariants: (path) => set({ recolor: false, variantsOf: path }),
  close: () => set({ recolor: false, variantsOf: null }),
}));

export function RecolorHost() {
  const pack = useApp((s) => s.pack);
  const recolor = useRecolor((s) => s.recolor);
  const variantsOf = useRecolor((s) => s.variantsOf);
  const close = useRecolor((s) => s.close);
  if (!pack) return null;
  if (recolor) return <RecolorDialog onClose={close} />;
  if (variantsOf) return <VariantsDialog source={variantsOf} onClose={close} />;
  return null;
}

/** Paths of textures open in the editor with unsaved changes (for this pack). */
function useUnsaved(): Set<string> {
  const tabs = useEditor((s) => s.tabs);
  const dir = useApp((s) => s.pack?.dir);
  return useMemo(() => new Set(tabs.filter((t) => t.packDir === dir && t.doc.dirty).map((t) => t.doc.path)), [tabs, dir]);
}

/** Previews from Rust, asked again a moment after the inputs stop changing. */
function usePreviews(key: string, load: () => Promise<RecolorPreview[]>): { items: RecolorPreview[]; loading: boolean } {
  const [items, setItems] = useState<RecolorPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    const t = window.setTimeout(() => {
      latest.current()
        .then((r) => { if (n === seq.current) setItems(r); })
        .catch((e) => { if (n === seq.current) useApp.getState().showError(e, "The preview could not be made"); })
        .finally(() => { if (n === seq.current) setLoading(false); });
    }, 220);
    return () => window.clearTimeout(t);
  }, [key]);
  return { items, loading };
}

/** After a write: reload, toast with Undo, and a list of what was skipped or failed. */
async function afterWrite(verb: string, report: WriteReport, skipped: Skipped[], packDir: string) {
  const app = useApp.getState();
  await app.reload(true);
  await useEditor.getState().syncWithDisk();
  const written = [...report.replaced, ...report.created];
  const undo = async () => {
    try {
      const n = await api.recolorUndo(report, packDir);
      await useApp.getState().reload(true);
      await useEditor.getState().syncWithDisk();
      useApp.getState().toast(`Undone: ${n} texture${n === 1 ? "" : "s"} back as they were (the recoloured files are in the pack's trash).`);
    } catch (e) {
      useApp.getState().showError(e, "The change could not be undone");
    }
  };
  app.toast(writeSummary(verb, report, skipped.length), report.failed.length || skipped.length ? "warn" : "ok",
    written.length > 0 ? { label: "Undo", run: () => void undo() } : undefined);
  const lines = [
    ...skipped.map((s) => `${baseName(s.path)}: skipped, ${s.reason}`),
    ...report.failed.map((f) => `${baseName(f.path)}: ${f.message}`),
  ];
  if (lines.length > 0) {
    app.ask({
      title: `${lines.length} texture${lines.length === 1 ? " was" : "s were"} not changed`,
      text: lines.slice(0, 20).join("\n") + (lines.length > 20 ? `\n…and ${lines.length - 20} more` : ""),
      hint: "The other textures were written. Nothing was lost: replaced files are in .packcreator/trash.",
      buttons: [{ label: "OK", primary: true }],
    });
  }
}

function useEscape(onClose: () => void, working: boolean) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !working) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, working]);
}

function PreviewCard({ item, unsaved, ticked, onTick }: { item: RecolorPreview; unsaved: boolean; ticked?: boolean; onTick?: (on: boolean) => void }) {
  return (
    <div className={`rc-card ${ticked === false ? "off" : ""}`} title={item.path}>
      <div className="rc-name">
        {onTick && <input type="checkbox" aria-label={`Write ${item.path}`} checked={!!ticked} onChange={(e) => onTick(e.target.checked)} />}
        <span className="mono ellipsis">{baseName(item.path)}</span>
      </div>
      <div className="rc-pair">
        <span className="checker">{item.before ? <img className="pixel" src={item.before} alt={`${item.path} now`} /> : null}</span>
        <Icon name="next" size={12} width={2} color="var(--muted)" />
        <span className="checker">{item.after ? <img className="pixel" src={item.after} alt={`${item.path} after`} /> : null}</span>
      </div>
      <div className="rc-note">
        {item.error ? <span style={{ color: "var(--danger)" }}>{item.error}</span>
          : unsaved ? <span style={{ color: "var(--warn)" }}>Unsaved in editor: skipped</span>
          : <span className="dim">{item.in_pack ? "Your texture" : "From the game"}</span>}
      </div>
    </div>
  );
}

function Slider({ label, value, min, max, unit, onChange }: { label: string; value: number; min: number; max: number; unit: string; onChange: (v: number) => void }) {
  return (
    <label className="rc-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={1} value={value} aria-label={label} onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={() => onChange(0)} />
      <span className="mono">{value > 0 ? "+" : ""}{value}{unit}</span>
    </label>
  );
}

// ------------------------------------------------------------- recolour

export function RecolorDialog({ onClose }: { onClose: () => void }) {
  const pack = useApp((s) => s.pack)!;
  const rows = useApp((s) => s.rows);
  const filters = useApp.getState().filters;
  const unsaved = useUnsaved();
  const [search, setSearch] = useState(filters.search);
  const [category, setCategory] = useState<Category | "all">(filters.category);
  const [mode, setMode] = useState<"adjust" | "map">("adjust");
  const [adjust, setAdjust] = useState(NO_ADJUST);
  const [pairs, setPairs] = useState<MapPair[]>([{ from: "#7f5f3f", to: "#3f5f7f" }]);
  const [tolerance, setTolerance] = useState(24);
  const [working, setWorking] = useState(false);
  useEscape(onClose, working);

  const chosen = useMemo(() => pickTextures(rows, search, category), [rows, search, category]);
  const paths = useMemo(() => chosen.map((r) => r.path), [chosen]);
  const op: Recolor = mode === "adjust" ? { kind: "adjust", ...adjust } : { kind: "map", pairs, tolerance };
  const key = JSON.stringify([paths, op, pack.dir]);
  const { items, loading } = usePreviews(key, () => (paths.length ? api.recolorPreview(paths, op, pack.dir) : Promise.resolve([])));
  const idle = changesNothing(op);
  const { ok, skipped } = splitUnsaved(paths, unsaved);

  const apply = async () => {
    if (ok.length === 0 || idle) return;
    setWorking(true);
    try {
      const report = await api.recolorApply(ok, op, pack.dir);
      onClose();
      await afterWrite("Recoloured", report, skipped, pack.dir);
    } catch (e) {
      setWorking(false);
      useApp.getState().showError(e, "The textures could not be recoloured");
    }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Recolour textures" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onClose(); }}>
      <div className="modal xwide rc">
        <h2>Recolour textures</h2>
        <div className="rc-top">
          <label className="searchbox">
            <Icon name="search" size={14} width={2} />
            <input aria-label="Textures to recolour" placeholder="Textures whose name contains… (for example planks)" value={search} spellCheck={false} autoFocus onChange={(e) => setSearch(e.target.value)} />
          </label>
          <select className="input sm" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value as Category | "all")}>
            <option value="all">All categories</option>
            {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          </select>
          <div className="seg sm" role="group" aria-label="How to recolour">
            <button className={mode === "adjust" ? "on" : ""} onClick={() => setMode("adjust")}>Adjust</button>
            <button className={mode === "map" ? "on" : ""} onClick={() => setMode("map")}>Colour map</button>
          </div>
        </div>
        <div className="rc-ops">
          {mode === "adjust" ? (
            <>
              <Slider label="Hue" value={adjust.hue} min={-180} max={180} unit="°" onChange={(hue) => setAdjust({ ...adjust, hue })} />
              <Slider label="Saturation" value={adjust.saturation} min={-100} max={100} unit="%" onChange={(saturation) => setAdjust({ ...adjust, saturation })} />
              <Slider label="Brightness" value={adjust.brightness} min={-100} max={100} unit="%" onChange={(brightness) => setAdjust({ ...adjust, brightness })} />
              <Slider label="Contrast" value={adjust.contrast} min={-100} max={100} unit="%" onChange={(contrast) => setAdjust({ ...adjust, contrast })} />
              <button className="btn ghost" disabled={idle} onClick={() => setAdjust(NO_ADJUST)}>Reset</button>
            </>
          ) : (
            <>
              {pairs.map((p, i) => (
                <span key={i} className="rc-mappair">
                  <input type="color" aria-label={`From colour ${i + 1}`} value={p.from} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, from: e.target.value } : q)))} />
                  <span className="mono">{p.from}</span>
                  <Icon name="next" size={12} width={2} color="var(--muted)" />
                  <input type="color" aria-label={`To colour ${i + 1}`} value={p.to} onChange={(e) => setPairs(pairs.map((q, j) => (j === i ? { ...q, to: e.target.value } : q)))} />
                  <span className="mono">{p.to}</span>
                  <button className="ed-iconbtn" aria-label="Remove this pair" title="Remove this pair" disabled={pairs.length <= 1} onClick={() => setPairs(pairs.filter((_, j) => j !== i))}><Icon name="close" size={12} width={2} /></button>
                </span>
              ))}
              <button className="btn ghost" disabled={pairs.length >= 8} onClick={() => setPairs([...pairs, { from: "#000000", to: "#ffffff" }])}>Add pair</button>
              <Slider label="Tolerance" value={tolerance} min={0} max={128} unit="" onChange={setTolerance} />
            </>
          )}
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          {chosen.length} texture{chosen.length === 1 ? "" : "s"} chosen{chosen.length > items.length && items.length > 0 ? ` (preview of the first ${items.length})` : ""}.
          {" "}Textures not in your pack yet start from the game’s texture at {pack.project.resolution}×. Alpha is never changed.
          {mode === "map" && " Colours within the tolerance of a “from” colour move with it and keep their small difference."}
        </div>
        <div className={`rc-grid ${loading ? "busy" : ""}`}>
          {chosen.length === 0 && <div className="dim" style={{ padding: 16, fontSize: 12 }}>No texture matches. Change the search or the category.</div>}
          {items.map((it) => <PreviewCard key={it.path} item={it} unsaved={unsaved.has(it.path)} />)}
        </div>
        <div className="buttons">
          {skipped.length > 0 && <span className="dim" style={{ marginRight: "auto", fontSize: 12, alignSelf: "center" }}>{skipped.length} skipped: unsaved changes in the editor.</span>}
          <button className="btn md" onClick={onClose} disabled={working}>Cancel</button>
          <button className="btn md primary" disabled={ok.length === 0 || idle || working} onClick={() => void apply()}>
            {working ? "Recolouring…" : `Recolour ${ok.length} texture${ok.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- variants

export function VariantsDialog({ source, onClose }: { source: string; onClose: () => void }) {
  const pack = useApp((s) => s.pack)!;
  const rows = useApp((s) => s.rows);
  const unsaved = useUnsaved();
  const all = useMemo(() => rows.filter((r) => !r.extra).map((r) => r.path), [rows]);
  const [family, setFamily] = useState<string[]>(() => familyOf(source, all));
  const [off, setOff] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  useEscape(onClose, working);

  const key = JSON.stringify([source, family, pack.dir]);
  const { items, loading } = usePreviews(key, () => (family.length ? api.variantsPreview(source, family, pack.dir) : Promise.resolve([])));
  const ticked = family.filter((p) => !off.has(p));
  const { ok, skipped } = splitUnsaved(ticked, unsaved);
  const sourceMine = rows.find((r) => r.path === source)?.mine;

  const add = () => {
    const r = addToFamily(family, typed, all, source);
    setFamily(r.list);
    setTypedError(r.error);
    if (!r.error) setTyped("");
  };
  const apply = async () => {
    if (ok.length === 0) return;
    setWorking(true);
    try {
      const report = await api.variantsApply(source, ok, pack.dir);
      onClose();
      await afterWrite(`Made ${baseName(source)} variants:`, report, skipped, pack.dir);
    } catch (e) {
      setWorking(false);
      useApp.getState().showError(e, "The variants could not be made");
    }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Make variants" onMouseDown={(e) => { if (e.target === e.currentTarget && !working) onClose(); }}>
      <div className="modal xwide rc">
        <h2>Make variants of <span className="mono">{baseName(source)}</span></h2>
        <p>
          Your {sourceMine ? "" : "(not yet drawn, so the game’s) "}{baseName(source)} is recoloured to look like each texture below: its shading stays, the colours
          come from that texture in the game, ordered from dark to light.
        </p>
        <div className="rc-family">
          {family.map((p) => (
            <span key={p} className="rc-chip">
              <span className="mono">{baseName(p)}</span>
              <button aria-label={`Remove ${p}`} title="Remove from the list" onClick={() => setFamily(family.filter((q) => q !== p))}><Icon name="close" size={11} width={2} /></button>
            </span>
          ))}
          <input
            className="input sm mono" style={{ width: 200 }} aria-label="Add a texture" placeholder="Add a texture…" value={typed}
            onChange={(e) => { setTyped(e.target.value); setTypedError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <button className="btn" onClick={add} disabled={!typed.trim()}>Add</button>
          {typedError && <span style={{ color: "var(--warn)", fontSize: 12 }}>{typedError}</span>}
        </div>
        <div className={`rc-grid ${loading ? "busy" : ""}`}>
          {family.length === 0 && <div className="dim" style={{ padding: 16, fontSize: 12 }}>No texture of the same family was found. Add textures by name above.</div>}
          {items.filter((it) => family.includes(it.path)).map((it) => (
            <PreviewCard
              key={it.path} item={it} unsaved={unsaved.has(it.path)} ticked={!off.has(it.path)}
              onTick={(on) => { const n = new Set(off); if (on) n.delete(it.path); else n.add(it.path); setOff(n); }}
            />
          ))}
        </div>
        <div className="buttons">
          {skipped.length > 0 && <span className="dim" style={{ marginRight: "auto", fontSize: 12, alignSelf: "center" }}>{skipped.length} skipped: unsaved changes in the editor.</span>}
          <button className="btn md" onClick={onClose} disabled={working}>Cancel</button>
          <button className="btn md primary" disabled={ok.length === 0 || working} onClick={() => void apply()}>
            {working ? "Writing…" : `Write ${ok.length} variant${ok.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
