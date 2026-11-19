// Screen 3: the pixel editor. Thin: the work is in src/editor.
import { useEffect } from "react";
import { Icon } from "../components/Icon";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import { Canvas } from "../editor/Canvas";
import { cancelPending, commitPending } from "../editor/controller";
import { frameTicks, targetLabel } from "../editor/doc";
import { fileName, useEditor, type Tab } from "../editor/editorStore";
import { LayersPanel, PalettePanel, PreviewPanel } from "../editor/Panels";
import { rgbaToHex, type Symmetry } from "../editor/pixels";
import { isTypingTarget, shortcutFor } from "../editor/shortcuts";
import { INKS, TOOLS, toolDef, usesFilled, usesTolerance, type InkChoice } from "../editor/tools";
import { baseName, folderOf } from "../lib/logic";
import { useApp } from "../store";

/** Keyboard shortcuts, active while a texture is open and nothing is being typed. */
function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState();
      if (app.modal || app.palette || isTypingTarget(e.target as HTMLElement | null)) return;
      const s = shortcutFor({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
      if (!s) return;
      e.preventDefault();
      const ed = useEditor.getState();
      switch (s.do) {
        case "tool": ed.setTool(s.tool); break;
        case "undo": ed.undo(); break;
        case "redo": ed.redo(); break;
        case "save": void ed.save(); break;
        case "selectAll": ed.selectAll(); break;
        case "deselect": ed.deselect(); break;
        case "delete": ed.deleteSelection(); break;
        case "copy": ed.copy(); break;
        case "cut": ed.cut(); break;
        case "paste": ed.paste(); break;
        case "swap": ed.swapColors(); break;
        case "size": ed.setOptions({ size: ed.options.size + s.delta }); break;
        case "zoom": ed.zoomStep(s.delta); break;
        case "fit": ed.setView(null); break;
        case "frame": ed.stepFrame(s.delta); break;
        case "commit": commitPending(); break;
        case "cancel": cancelPending(); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}

function ToolColumn() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const target = useEditor((s) => s.colorTarget);
  const setTarget = useEditor((s) => s.setColorTarget);
  const swap = useEditor((s) => s.swapColors);
  return (
    <div className="ed-tools">
      <div className="grid2" role="toolbar" aria-label="Tools">
        {TOOLS.map((t) => (
          <button key={t.id} aria-label={t.label} title={t.label} aria-pressed={tool === t.id} className={tool === t.id ? "on" : ""} onClick={(e) => { setTool(t.id); e.currentTarget.blur(); }}>
            <Icon d={t.icon} size={16} width={1.7} />
          </button>
        ))}
      </div>
      <div className="rule" />
      <div className="ed-colors">
        <button className={`bg checker ${target === "bg" ? "target" : ""}`} aria-label={`Background colour ${rgbaToHex(bg)}`} title="Background colour (right mouse button). Click to change it in the colour picker." onClick={() => setTarget("bg")}>
          <span style={{ background: `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${bg[3] / 255})` }} />
        </button>
        <button className={`fg checker ${target === "fg" ? "target" : ""}`} aria-label={`Foreground colour ${rgbaToHex(fg)}`} title="Foreground colour (left mouse button). Click to change it in the colour picker." onClick={() => setTarget("fg")}>
          <span style={{ background: `rgba(${fg[0]}, ${fg[1]}, ${fg[2]}, ${fg[3] / 255})` }} />
        </button>
      </div>
      <button className="ed-swap" aria-label="Swap colours" title="Swap colours (X)" onClick={swap}><Icon name="swap" size={14} width={1.7} /></button>
    </div>
  );
}

/** A number field that only applies whole numbers, on Enter or when left. */
function NumberField({ value, min, max, suffix, label, onChange }: { value: number; min: number; max: number; suffix: string; label: string; onChange: (n: number) => void }) {
  return (
    <span className="ed-num">
      <input
        type="number" aria-label={label} min={min} max={max} value={value}
        onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n)))); }}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur(); }}
      />
      <span>{suffix}</span>
    </span>
  );
}

function OptionsBar() {
  const tool = useEditor((s) => s.tool);
  const o = useEditor((s) => s.options);
  const set = useEditor((s) => s.setOptions);
  const blurAfter = (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => e.currentTarget.blur();
  return (
    <div className="ed-options">
      <span className="toolname">{toolDef(tool).name}</span>
      <span className="rule" />
      <label>Size <NumberField label="Brush size" value={o.size} min={1} max={64} suffix="px" onChange={(size) => set({ size })} /></label>
      <label>Ink
        <select className="ed-select" aria-label="Ink" value={o.ink} onChange={(e) => { set({ ink: e.target.value as InkChoice }); blurAfter(e); }}>
          {INKS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
        </select>
      </label>
      <label>Opacity <NumberField label="Opacity" value={o.opacity} min={0} max={100} suffix="%" onChange={(opacity) => set({ opacity })} /></label>
      <label className="tick"><input type="checkbox" checked={o.pixelPerfect} onChange={(e) => { set({ pixelPerfect: e.target.checked }); blurAfter(e); }} /> Pixel-perfect</label>
      <label>Symmetry
        <select className="ed-select" aria-label="Symmetry" value={o.symmetry} onChange={(e) => { set({ symmetry: e.target.value as Symmetry }); blurAfter(e); }}>
          <option value="none">Off</option>
          <option value="x">Left / right</option>
          <option value="y">Top / bottom</option>
          <option value="both">Both</option>
        </select>
      </label>
      <label className="tick" title="Shows the texture repeated around itself; drawing wraps around the edges"><input type="checkbox" checked={o.tiled} onChange={(e) => { set({ tiled: e.target.checked }); blurAfter(e); }} /> Tiled</label>
      <label className="tick" title="Shows the frames before and after faintly. Used by the animation view."><input type="checkbox" checked={o.onionSkin} onChange={(e) => { set({ onionSkin: e.target.checked }); blurAfter(e); }} /> Onion skin</label>
      {(usesFilled(tool) || usesTolerance(tool) || tool === "blur" || tool === "text") && <span className="rule" />}
      {usesFilled(tool) && (
        <label className="tick"><input type="checkbox" checked={o.filled} onChange={(e) => { set({ filled: e.target.checked }); blurAfter(e); }} /> Filled</label>
      )}
      {usesTolerance(tool) && (
        <>
          <label className="tick"><input type="checkbox" checked={o.contiguous} onChange={(e) => { set({ contiguous: e.target.checked }); blurAfter(e); }} /> Touching only</label>
          <label>Tolerance <NumberField label="Tolerance" value={o.tolerance} min={0} max={255} suffix="" onChange={(tolerance) => set({ tolerance })} /></label>
        </>
      )}
      {tool === "blur" && (
        <label>Mode
          <select className="ed-select" aria-label="Blur mode" value={o.blurMode} onChange={(e) => { set({ blurMode: e.target.value as "blur" | "jumble" }); blurAfter(e); }}>
            <option value="blur">Blur</option>
            <option value="jumble">Jumble</option>
          </select>
        </label>
      )}
      {tool === "text" && (
        <label>Text height <NumberField label="Text height" value={o.textSize} min={4} max={64} suffix="px" onChange={(textSize) => set({ textSize })} /></label>
      )}
    </div>
  );
}

function FileTabs() {
  const tabs = useEditor((s) => s.tabs);
  const activeId = useEditor((s) => s.activeId);
  const activate = useEditor((s) => s.activate);
  const closeTab = useEditor((s) => s.closeTab);
  return (
    <div className="ed-filetabs" role="tablist" aria-label="Open textures">
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tab"
          aria-selected={t.id === activeId}
          className={`ftab ${t.id === activeId ? "on" : ""}`}
          title={`textures/${t.doc.path}.png${t.doc.dirty ? " · unsaved changes" : ""}`}
          onMouseDown={(e) => { if (e.button === 0) activate(t.id); }}
          onAuxClick={(e) => { if (e.button === 1) void closeTab(t.id); }}
        >
          <span className="mono ellipsis">{fileName(t.doc.path)}</span>
          {t.doc.dirty && <span className="dirty" aria-label="Unsaved changes" />}
          <button aria-label={`Close ${fileName(t.doc.path)}`} title="Close" onMouseDown={(e) => e.stopPropagation()} onClick={() => void closeTab(t.id)}>
            <Icon name="close" size={12} width={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

function FrameStrip({ tab }: { tab: Tab }) {
  const step = useEditor((s) => s.stepFrame);
  const doc = tab.doc;
  const ticks = frameTicks(doc);
  return (
    <div className="ed-frames">
      <button aria-label="Previous frame" title="Previous frame (←)" onClick={() => step(-1)}><Icon name="prev" size={14} width={2} /></button>
      <button aria-label="Next frame" title="Next frame (→)" onClick={() => step(1)}><Icon name="next" size={14} width={2} /></button>
      <span className="count">{doc.frameIndex + 1} / {doc.frames.length}</span>
      <span className="dim">· {ticks} tick{ticks === 1 ? "" : "s"}</span>
      <span className="dim grow" style={{ textAlign: "right" }}>You are editing one frame of an animation. The timeline arrives with the animation view.</span>
    </div>
  );
}

function EmptyEditor() {
  const go = useApp((s) => s.go);
  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <NavBar />
        <div className="placeholder">
          <Icon name="editor" size={28} color="var(--muted)" />
          <div className="big">No texture is open</div>
          <div style={{ maxWidth: 420, textAlign: "center" }}>Pick a texture in the texture browser and choose “Edit texture”, or double-click it. It opens here on its own tab.</div>
          <button className="btn primary" onClick={() => go("textures")}>Open the texture browser</button>
        </div>
      </div>
      <StatusBar />
    </>
  );
}

export function Editor() {
  const tab = useEditor((s) => s.tabs.find((t) => t.id === s.activeId) ?? null);
  const cursor = useEditor((s) => s.cursor);
  const options = useEditor((s) => s.options);
  const pack = useApp((s) => s.pack);
  useShortcuts(tab !== null);
  if (!tab || !pack) return <EmptyEditor />;

  const doc = tab.doc;
  const ed = useEditor.getState;
  const folder = folderOf(doc.path);
  const version = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  const inside = cursor && (options.tiled || (cursor[0] >= 0 && cursor[1] >= 0 && cursor[0] < doc.width && cursor[1] < doc.height));
  const wrap = (n: number, size: number) => ((n % size) + size) % size;
  const frames = doc.frames.length;

  return (
    <>
      <TopBar
        crumbs={
          <>
            <span className="name ellipsis">{pack.project.name}</span>
            {folder && (
              <>
                <span className="sep">/</span>
                <span className="leaf ellipsis">{folder}</span>
              </>
            )}
            <span className="sep">/</span>
            <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{baseName(doc.path)}.png</span>
            {doc.dirty && <span className="ed-dirty" aria-label="Unsaved changes" title="Unsaved changes" />}
          </>
        }
        right={
          <>
            <button className="ed-iconbtn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={tab.history.undo.length === 0} onClick={() => ed().undo()}><Icon name="undo" size={15} width={2} /></button>
            <button className="ed-iconbtn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={tab.history.redo.length === 0} onClick={() => ed().redo()}><Icon name="redo" size={15} width={2} /></button>
            <span className="chip">Java {version}</span>
            <button className="btn primary" disabled={tab.saving} onClick={() => void ed().save()}>Save to pack&nbsp;&nbsp;Ctrl S</button>
          </>
        }
      />
      <div className="body">
        <NavBar />
        <ToolColumn />
        <main className="ed-main">
          <FileTabs />
          <OptionsBar />
          <Canvas tab={tab} />
          {frames > 1 && <FrameStrip tab={tab} />}
        </main>
        <aside className="ed-side">
          <PreviewPanel tab={tab} />
          <PalettePanel tab={tab} />
          <LayersPanel tab={tab} />
        </aside>
      </div>
      <StatusBar right={<>→ {targetLabel(doc)}</>}>
        <span>{inside && cursor ? `x ${options.tiled ? wrap(cursor[0], doc.width) : cursor[0]} · y ${options.tiled ? wrap(cursor[1], doc.height) : cursor[1]}` : "x – · y –"}</span>
        <span>{doc.width}×{doc.height} · {frames} frame{frames === 1 ? "" : "s"} · RGBA</span>
        {doc.dirty && <span style={{ color: "var(--warn)" }}>Unsaved changes</span>}
      </StatusBar>
    </>
  );
}
