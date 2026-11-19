// Screen 3: the pixel editor. Thin: the work is in src/editor.
import { memo, useEffect, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import { Canvas } from "../editor/Canvas";
import { cancelPending, commitPending, sessionKind } from "../editor/controller";
import { frameTicks, PACK_ICON, targetLabel, type EditorDoc } from "../editor/doc";
import { activeTab, fileName, useEditor } from "../editor/editorStore";
import { releaseAfterMouse } from "../editor/focus";
import { LayersPanel, PalettePanel, PreviewPanel } from "../editor/Panels";
import { rgbaToHex, type Symmetry } from "../editor/pixels";
import { focusInfo, isTypingTarget, keyBelongsToControl, shortcutFor } from "../editor/shortcuts";
import { INKS, SELECT_TOOLS, TOOLS, toolDef, usesFilled, usesTolerance, type InkChoice } from "../editor/tools";
import { folderOf } from "../lib/logic";
import { useApp } from "../store";

/** True while the user has text marked on the page (Ctrl+C must copy that text). */
function hasMarkedText(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

/** Keyboard shortcuts, active while a texture is open (editor and animation screens). */
export function useShortcuts(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState();
      if (app.modal || app.palette) return;
      const s = shortcutFor({ key: e.key, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey });
      if (!s) return;
      const target = e.target as HTMLElement | null;
      const ed = useEditor.getState();
      if (isTypingTarget(target)) {
        // Keys typed into a field belong to the field, with one exception:
        // Ctrl+S saves from anywhere. Leaving the field first applies its value.
        if (s.do !== "save") return;
        e.preventDefault();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        void ed.save();
        return;
      }
      // a slider keeps its arrow keys; a button reached with the keyboard keeps Enter and Space
      if (keyBelongsToControl(focusInfo(target), e.key)) return;
      // keys that would do nothing here are left to the browser
      if ((s.do === "commit" || s.do === "cancel") && sessionKind() === null) return;
      if (s.do === "frame" && (activeTab(ed)?.doc.frames.length ?? 0) < 2) return;
      if (s.do === "copy" && hasMarkedText()) return;
      e.preventDefault();
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

// The parts below are memoised: while a tool is dragged the open tab changes
// many times a second, and only what really shows the change is drawn again.

const Nav = memo(NavBar);

const ToolColumn = memo(function ToolColumn() {
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
          <button key={t.id} aria-label={t.label} title={t.label} aria-pressed={tool === t.id} className={tool === t.id ? "on" : ""} onClick={() => setTool(t.id)}>
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
});

/**
 * A number field. What is typed is only a draft: the value is checked, rounded,
 * kept inside its limits and applied on Enter or when the field is left.
 * Escape puts the old value back.
 */
export function NumberField({ value, min, max, suffix, label, onChange, className = "ed-num" }: {
  value: number; min: number; max: number; suffix: string; label: string; onChange: (n: number) => void; className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // the latest draft, also for the blur that follows Enter / Escape in the same moment
  const typed = useRef<string | null>(null);
  const edit = (text: string | null) => {
    typed.current = text;
    setDraft(text);
  };
  const apply = () => {
    const text = typed.current;
    edit(null);
    if (text === null || text.trim() === "") return;
    const n = Number(text);
    if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, Math.round(n))));
  };
  return (
    <span className={className}>
      <input
        type="number" aria-label={label} min={min} max={max} step={1}
        title={`${min} to ${max}. Enter applies, Escape cancels.`}
        value={draft ?? String(value)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => edit(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            apply();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            edit(null);
            e.currentTarget.blur();
          }
        }}
      />
      <span>{suffix}</span>
    </span>
  );
}

/** Copy, paste and the selection commands, shown with the tools they belong to. */
function SelectionButtons() {
  const ed = useEditor.getState;
  const hasSelection = useEditor((s) => !!activeTab(s)?.doc.selection);
  const hasClip = useEditor((s) => s.clipboard !== null);
  return (
    <span className="ed-cmds" role="group" aria-label="Selection">
      <button title="Select everything (Ctrl+A)" onClick={() => ed().selectAll()}>Select all</button>
      <button title="Remove the selection (Ctrl+D)" disabled={!hasSelection} onClick={() => ed().deselect()}>Deselect</button>
      <button title="Copy the selected pixels, or the whole layer when nothing is selected (Ctrl+C)" onClick={() => ed().copy()}>Copy</button>
      <button title="Copy the selected pixels and clear them (Ctrl+X)" onClick={() => ed().cut()}>Cut</button>
      <button title={hasClip ? "Paste what was copied (Ctrl+V), then drag it into place" : "Nothing copied yet"} disabled={!hasClip} onClick={() => ed().paste()}>Paste</button>
      <button title="Clear the selected pixels, or the whole layer when nothing is selected (Delete)" onClick={() => ed().deleteSelection()}>Delete</button>
    </span>
  );
}

const OptionsBar = memo(function OptionsBar() {
  const tool = useEditor((s) => s.tool);
  const o = useEditor((s) => s.options);
  const set = useEditor((s) => s.setOptions);
  const animated = useEditor((s) => (activeTab(s)?.doc.frames.length ?? 0) > 1);
  const selecting = SELECT_TOOLS.includes(tool) || tool === "move";
  return (
    <div className="ed-options">
      <span className="toolname">{toolDef(tool).name}</span>
      <span className="rule" />
      <label>Size <NumberField label="Brush size" value={o.size} min={1} max={64} suffix="px" onChange={(size) => set({ size })} /></label>
      <label>Ink
        <select className="ed-select" aria-label="Ink" value={o.ink} onChange={(e) => { set({ ink: e.target.value as InkChoice }); releaseAfterMouse(e); }}>
          {INKS.map((i) => <option key={i.key} value={i.key}>{i.label}</option>)}
        </select>
      </label>
      <label>Opacity <NumberField label="Opacity" value={o.opacity} min={0} max={100} suffix="%" onChange={(opacity) => set({ opacity })} /></label>
      <label className="tick"><input type="checkbox" checked={o.pixelPerfect} onChange={(e) => set({ pixelPerfect: e.target.checked })} /> Pixel-perfect</label>
      <label>Symmetry
        <select className="ed-select" aria-label="Symmetry" value={o.symmetry} onChange={(e) => { set({ symmetry: e.target.value as Symmetry }); releaseAfterMouse(e); }}>
          <option value="none">Off</option>
          <option value="x">Left / right</option>
          <option value="y">Top / bottom</option>
          <option value="both">Both</option>
        </select>
      </label>
      <label className="tick" title="Shows the texture repeated around itself; drawing wraps around the edges"><input type="checkbox" checked={o.tiled} onChange={(e) => set({ tiled: e.target.checked })} /> Tiled</label>
      <label
        className="tick"
        title={animated
          ? "Shows the frame before and the frame after faintly under the one you are drawing. Display only: it is never saved."
          : "Shows the neighbouring frames faintly. This texture has only one frame, so there is nothing to show."}
      >
        <input type="checkbox" checked={o.onionSkin} onChange={(e) => set({ onionSkin: e.target.checked })} /> Onion skin
      </label>
      {(usesFilled(tool) || usesTolerance(tool) || tool === "blur" || tool === "text") && <span className="rule" />}
      {usesFilled(tool) && (
        <label className="tick"><input type="checkbox" checked={o.filled} onChange={(e) => set({ filled: e.target.checked })} /> Filled</label>
      )}
      {usesTolerance(tool) && (
        <>
          <label className="tick"><input type="checkbox" checked={o.contiguous} onChange={(e) => set({ contiguous: e.target.checked })} /> Touching only</label>
          <label>Tolerance <NumberField label="Tolerance" value={o.tolerance} min={0} max={255} suffix="" onChange={(tolerance) => set({ tolerance })} /></label>
        </>
      )}
      {tool === "blur" && (
        <label>Mode
          <select className="ed-select" aria-label="Blur mode" value={o.blurMode} onChange={(e) => { set({ blurMode: e.target.value as "blur" | "jumble" }); releaseAfterMouse(e); }}>
            <option value="blur">Blur</option>
            <option value="jumble">Jumble</option>
          </select>
        </label>
      )}
      {tool === "text" && (
        <label>Text height <NumberField label="Text height" value={o.textSize} min={4} max={64} suffix="px" onChange={(textSize) => set({ textSize })} /></label>
      )}
      {selecting && <SelectionButtons />}
    </div>
  );
});

const FileTabs = memo(function FileTabs() {
  const tabs = useEditor((s) => s.tabs);
  const activeId = useEditor((s) => s.activeId);
  const activate = useEditor((s) => s.activate);
  const closeTab = useEditor((s) => s.closeTab);
  const listRef = useRef<HTMLDivElement>(null);

  /** Left / Right / Home / End move between the tabs, for someone working with the keyboard. */
  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!e.currentTarget.matches(":focus-visible")) return;
    const to = e.key === "ArrowLeft" ? index - 1 : e.key === "ArrowRight" ? index + 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : -1;
    if (to < 0 || to >= tabs.length || to === index) return;
    e.preventDefault();
    e.stopPropagation();
    activate(tabs[to].id);
    listRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <div className="ed-filetabs" role="tablist" aria-label="Open textures" ref={listRef}>
      {tabs.map((t, i) => {
        const name = fileName(t.doc.path);
        const on = t.id === activeId;
        return (
          <div
            key={t.id}
            role="presentation"
            className={`ftab ${on ? "on" : ""}`}
            title={`${targetLabel(t.doc)}${t.doc.dirty ? " · unsaved changes" : ""}`}
            onAuxClick={(e) => { if (e.button === 1) void closeTab(t.id); }}
          >
            <button
              role="tab"
              className="pick"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              // on press, not on release: switching feels immediate
              onMouseDown={(e) => { if (e.button === 0) activate(t.id); }}
              onClick={() => activate(t.id)}
              onKeyDown={(e) => onKey(e, i)}
            >
              <span className="mono ellipsis">{name}</span>
              {t.doc.dirty && <span className="dirty" role="img" aria-label="Unsaved changes" />}
            </button>
            <button className="close" aria-label={`Close ${name}`} title="Close" tabIndex={on ? 0 : -1} onClick={() => void closeTab(t.id)}>
              <Icon name="close" size={12} width={2} />
            </button>
          </div>
        );
      })}
    </div>
  );
});

const FrameStrip = memo(function FrameStrip({ doc }: { doc: EditorDoc }) {
  const step = useEditor((s) => s.stepFrame);
  const go = useApp((s) => s.go);
  const ticks = frameTicks(doc);
  const many = doc.frames.length > 1;
  return (
    <div className="ed-frames">
      {many ? (
        <>
          <button aria-label="Previous frame" title="Previous frame (←)" onClick={() => step(-1)}><Icon name="prev" size={14} width={2} /></button>
          <button aria-label="Next frame" title="Next frame (→)" onClick={() => step(1)}><Icon name="next" size={14} width={2} /></button>
          <span className="count">{doc.frameIndex + 1} / {doc.frames.length}</span>
          <span className="dim">· {ticks} tick{ticks === 1 ? "" : "s"}</span>
        </>
      ) : (
        <span className="dim" style={{ marginLeft: 2 }}>{doc.animation ? "Animated · 1 frame" : "Still image · 1 frame"}</span>
      )}
      {doc.path !== PACK_ICON && (
        <button className="ed-link" title="Frames, timing and frame order, with an in-game preview" onClick={() => go("animation")}>
          Open animation view
        </button>
      )}
    </div>
  );
});

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

const EditorTop = memo(function EditorTop({ packName, path, dirty, canUndo, canRedo, saving, version }: {
  packName: string; path: string; dirty: boolean; canUndo: boolean; canRedo: boolean; saving: boolean; version: string;
}) {
  const ed = useEditor.getState;
  const folder = folderOf(path);
  return (
    <TopBar
      crumbs={
        <>
          <span className="name ellipsis">{packName}</span>
          {folder && (
            <>
              <span className="sep">/</span>
              <span className="leaf ellipsis">{folder}</span>
            </>
          )}
          <span className="sep">/</span>
          <span className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fileName(path)}</span>
          {dirty && <span className="ed-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
        </>
      }
      right={
        <>
          <button className="ed-iconbtn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => ed().undo()}><Icon name="undo" size={15} width={2} /></button>
          <button className="ed-iconbtn" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={() => ed().redo()}><Icon name="redo" size={15} width={2} /></button>
          <span className="chip">Java {version}</span>
          <button className="btn primary" disabled={saving} onClick={() => void ed().save()}>Save to pack&nbsp;&nbsp;Ctrl S</button>
        </>
      }
    />
  );
});

/** The pixel under the pointer. On its own, so that moving the mouse redraws nothing else. */
function CursorReadout({ width, height }: { width: number; height: number }) {
  const cursor = useEditor((s) => s.cursor);
  const tiled = useEditor((s) => s.options.tiled);
  const wrap = (n: number, size: number) => ((n % size) + size) % size;
  const inside = cursor && (tiled || (cursor[0] >= 0 && cursor[1] >= 0 && cursor[0] < width && cursor[1] < height));
  if (!cursor || !inside) return <span>x – · y –</span>;
  return <span>x {tiled ? wrap(cursor[0], width) : cursor[0]} · y {tiled ? wrap(cursor[1], height) : cursor[1]}</span>;
}

const EditorStatus = memo(function EditorStatus({ target, width, height, frames, dirty }: {
  target: string; width: number; height: number; frames: number; dirty: boolean;
}) {
  return (
    <StatusBar right={<>→ {target}</>}>
      <CursorReadout width={width} height={height} />
      <span>{width}×{height} · {frames} frame{frames === 1 ? "" : "s"} · RGBA</span>
      {dirty && <span style={{ color: "var(--warn)" }}>Unsaved changes</span>}
    </StatusBar>
  );
});

export function Editor() {
  const tab = useEditor(activeTab);
  const pack = useApp((s) => s.pack);
  useShortcuts(tab !== null);
  if (!tab || !pack) return <EmptyEditor />;

  const doc = tab.doc;
  const version = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  const frames = doc.frames.length;

  return (
    <>
      <EditorTop
        packName={pack.project.name} path={doc.path} dirty={doc.dirty} version={version} saving={tab.saving}
        canUndo={tab.history.undo.length > 0} canRedo={tab.history.redo.length > 0}
      />
      <div className="body">
        <Nav />
        <ToolColumn />
        <main className="ed-main">
          <FileTabs />
          <OptionsBar />
          <Canvas tab={tab} />
          <FrameStrip doc={doc} />
        </main>
        <aside className="ed-side">
          <PreviewPanel doc={doc} preview={tab.preview} />
          <PalettePanel palette={doc.palette} hasVanilla={doc.vanilla !== null} source={tab.paletteSource} />
          <LayersPanel doc={doc} />
        </aside>
      </div>
      <EditorStatus target={targetLabel(doc)} width={doc.width} height={doc.height} frames={frames} dirty={doc.dirty} />
    </>
  );
}
