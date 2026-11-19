// Right column of the editor: preview, palette with the colour picker, layers.
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { ColorPicker } from "./ColorPicker";
import { flatten, REFERENCE_OPACITY, type EditorDoc } from "./doc";
import { useEditor, withPreview, type Preview, type Tab } from "./editorStore";
import { releaseAfterMouse } from "./focus";
import { hexToRgba, rgbaToHex, rgbToHsv, type Buf } from "./pixels";
import { bufToCanvas } from "./render";

/** A pixel buffer shown with hard pixels, `repeat` × `repeat` times, fitted into a box. */
function PixelView({ buf, box, repeat = 1, label }: { buf: Buf; box: number; repeat?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // one scratch canvas for the life of the view, not a new one per redraw
  const tileRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const tile = bufToCanvas(buf, tileRef.current ?? undefined);
    tileRef.current = tile;
    c.width = buf.w * repeat;
    c.height = buf.h * repeat;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    for (let y = 0; y < repeat; y++) for (let x = 0; x < repeat; x++) ctx.drawImage(tile, x * buf.w, y * buf.h);
  }, [buf, repeat]);
  const w = buf.w * repeat;
  const h = buf.h * repeat;
  const scale = Math.min(box / w, box / h);
  // whole-number enlargement when the image is small enough, so every pixel is the same size
  const s = scale >= 1 ? Math.floor(scale) : scale;
  return <canvas ref={ref} className="pixel" role="img" aria-label={label} style={{ width: Math.round(w * s), height: Math.round(h * s) }} />;
}

const LATER = "arrives in a later stage";

export const PreviewPanel = memo(function PreviewPanel({ doc: saved, preview }: { doc: EditorDoc; preview: Preview | null }) {
  const mode = useEditor((s) => s.previewTab);
  const setMode = useEditor((s) => s.setPreviewTab);
  // The side preview follows the canvas with low priority: while a tool is
  // dragged, the canvas is drawn first and this catches up when there is time.
  const latest = useMemo(() => ({ saved, preview }), [saved, preview]);
  const shown = useDeferredValue(latest);
  const doc = useMemo(() => withPreview(shown.saved, shown.preview), [shown]);
  const flat = useMemo(() => flatten(doc), [doc]);
  return (
    <section className="ed-panel">
      <div className="head">
        <h2 className="caps">Preview</h2>
        <div className="ed-tabs" role="tablist" aria-label="Preview mode">
          <button role="tab" disabled title={`3D preview ${LATER}`}>3D</button>
          <button role="tab" aria-selected={mode === "tiled"} className={mode === "tiled" ? "on" : ""} onClick={() => setMode("tiled")}>Tiled</button>
          <button role="tab" aria-selected={mode === "original"} className={mode === "original" ? "on" : ""} onClick={() => setMode("original")}>Original</button>
          <button role="tab" disabled title={`Animated preview ${LATER}`}>Animated</button>
        </div>
      </div>
      <div className="ed-preview">
        {mode === "tiled" ? (
          <PixelView buf={flat} box={196} repeat={3} label="Texture repeated 3 by 3" />
        ) : (
          <div className="pair">
            <div>
              <div className="cell checker">
                {doc.vanilla ? <PixelView buf={doc.vanilla} box={112} label="The game's texture" /> : <span className="none">Not in the game</span>}
              </div>
              <div className="dim">{doc.vanilla ? `Vanilla ${doc.vanilla.w}×${doc.vanilla.h}` : "Vanilla"}</div>
            </div>
            <div>
              <div className="cell checker"><PixelView buf={flat} box={112} label="Your texture" /></div>
              <div style={{ color: "var(--ok)" }}>Yours {doc.width}×{doc.height}</div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
});

/** A refresh arrow in the app's icon style (24 grid, stroke only). */
const REFRESH = "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7";

export const PalettePanel = memo(function PalettePanel({ palette, hasVanilla, source }: { palette: string[]; hasVanilla: boolean; source: Tab["paletteSource"] }) {
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const target = useEditor((s) => s.colorTarget);
  const setColor = useEditor((s) => s.setColor);
  const setTarget = useEditor((s) => s.setColorTarget);
  const loadPalette = useEditor((s) => s.loadPalette);
  const current = target === "fg" ? fg : bg;
  const [h, s, v] = rgbToHsv(current[0], current[1], current[2]);
  const fgHex = rgbaToHex(fg);
  const bgHex = rgbaToHex(bg);
  // what the refresh button reads the colours from again
  const again: "vanilla" | "image" = source === "vanilla" && hasVanilla ? "vanilla" : "image";
  return (
    <section className="ed-panel">
      <div className="head">
        <h2 className="caps">Palette</h2>
        <div className="ed-palsrc">
          <select
            className="ed-select"
            aria-label="Palette colours"
            value={source}
            onChange={(e) => {
              loadPalette(e.target.value as "vanilla" | "image");
              releaseAfterMouse(e);
            }}
          >
            {source === "saved" && <option value="saved">Saved with texture</option>}
            <option value="vanilla" disabled={!hasVanilla}>From vanilla</option>
            <option value="image">From image</option>
          </select>
          <button
            aria-label={again === "vanilla" ? "Take the colours from the game's texture again" : "Take the colours from your drawing again"}
            title={again === "vanilla" ? "Take the colours from the game's texture again" : "Take the colours from your drawing as it is now"}
            onClick={() => loadPalette(again)}
          >
            <Icon d={REFRESH} size={13} width={2} />
          </button>
        </div>
      </div>
      {palette.length === 0 ? (
        <div className="dim" style={{ fontSize: 11 }}>No colours yet. Draw something, then press the refresh button above to take the colours from your drawing.</div>
      ) : (
        <div className="ed-swatches">
          {palette.map((hex) => (
            <button
              key={hex}
              title={`${hex.toUpperCase()} · click: foreground, right-click: background`}
              aria-label={`Colour ${hex}`}
              className={`${hex === fgHex ? "fg" : ""} ${hex === bgHex ? "bg" : ""}`}
              style={{ background: hex }}
              onClick={() => { const c = hexToRgba(hex); if (c) setColor("fg", c); }}
              onContextMenu={(e) => { e.preventDefault(); const c = hexToRgba(hex); if (c) setColor("bg", c); }}
            />
          ))}
        </div>
      )}
      <div className="ed-readout mono">
        <span>{rgbaToHex(current).toUpperCase()}</span>
        <span className="dim">H{h} S{s} V{v}</span>
      </div>
      <div className="seg sm ed-target" role="group" aria-label="Colour to change">
        <button className={target === "fg" ? "on" : ""} onClick={() => setTarget("fg")}>Foreground</button>
        <button className={target === "bg" ? "on" : ""} onClick={() => setTarget("bg")}>Background</button>
      </div>
      <ColorPicker color={current} onChange={(c) => setColor(target, c)} />
    </section>
  );
});

function LayerName({ doc, index }: { doc: EditorDoc; index: number }) {
  const patchLayer = useEditor((s) => s.patchLayer);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const layer = doc.layers[index];
  if (!editing) {
    return (
      <span
        className="name ellipsis"
        title="Double-click to rename"
        onDoubleClick={() => { setName(layer.name); setEditing(true); }}
      >
        {layer.name}
      </span>
    );
  }
  const done = (keep: boolean) => {
    if (keep) patchLayer(index, { name });
    setEditing(false);
  };
  return (
    <input
      className="input rename"
      autoFocus
      aria-label="Layer name"
      value={name}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") done(true);
        else if (e.key === "Escape") done(false);
      }}
    />
  );
}

export const LayersPanel = memo(function LayersPanel({ doc }: { doc: EditorDoc }) {
  const ed = useEditor.getState;
  const active = doc.layers[doc.activeLayer];
  // top layer first, like every layer list
  const order = doc.layers.map((_, i) => i).reverse();
  return (
    <section className="ed-panel ed-layers">
      <div className="head">
        <h2 className="caps">Layers</h2>
        <div className="tools">
          <button aria-label="Move layer up" title="Move layer up" disabled={doc.activeLayer >= doc.layers.length - 1} onClick={() => ed().moveLayer(doc.activeLayer, 1)}><Icon name="up" size={13} width={2} /></button>
          <button aria-label="Move layer down" title="Move layer down" disabled={doc.activeLayer <= 0} onClick={() => ed().moveLayer(doc.activeLayer, -1)}><Icon name="down" size={13} width={2} /></button>
          <button aria-label="Duplicate layer" title="Duplicate layer" onClick={() => ed().duplicateLayer(doc.activeLayer)}><Icon name="copy" size={13} width={2} /></button>
          <button aria-label="Delete layer" title="Delete layer" disabled={doc.layers.length <= 1} onClick={() => ed().deleteLayer(doc.activeLayer)}><Icon name="trash" size={13} width={2} /></button>
          <button aria-label="Add layer" title="Add layer" onClick={() => ed().addLayer()}><Icon name="plus" size={13} width={2} /></button>
        </div>
      </div>
      <div className="list">
        {order.map((i) => {
          const l = doc.layers[i];
          return (
            <div key={l.id} className={`layer ${i === doc.activeLayer ? "on" : ""} ${l.visible ? "" : "hidden"}`} onMouseDown={() => ed().setActiveLayer(i)}>
              <button aria-label={l.visible ? "Hide layer" : "Show layer"} title={l.visible ? "Hide layer" : "Show layer"} onClick={(e) => { e.stopPropagation(); ed().setActiveLayer(i); ed().patchLayer(i, { visible: !l.visible }); }}>
                <Icon name={l.visible ? "eye" : "eyeOff"} size={14} width={2} />
              </button>
              <LayerName doc={doc} index={i} />
              <span className="meta">{l.locked ? "Locked" : "Normal"} · {l.opacity}%</span>
              <button aria-label={l.locked ? "Unlock layer" : "Lock layer"} title={l.locked ? "Unlock layer" : "Lock layer"} className={l.locked ? "lit" : ""} onClick={(e) => { e.stopPropagation(); ed().setActiveLayer(i); ed().patchLayer(i, { locked: !l.locked }); }}>
                <Icon name={l.locked ? "lock" : "unlock"} size={13} width={2} />
              </button>
            </div>
          );
        })}
        <div className={`layer ref ${doc.reference && doc.referenceVisible ? "" : "hidden"}`}>
          <button
            aria-label={doc.referenceVisible ? "Hide the vanilla reference" : "Show the vanilla reference"}
            title={doc.reference ? "The game's texture, shown faintly under your drawing. It is never saved into your texture." : "The game has no texture with this name"}
            disabled={!doc.reference}
            onClick={() => ed().toggleReference()}
          >
            <Icon name={doc.reference && doc.referenceVisible ? "eye" : "eyeOff"} size={14} width={2} />
          </button>
          <span className="name ellipsis">Vanilla reference</span>
          <span className="meta">{doc.reference ? `Locked · ${REFERENCE_OPACITY}%` : "Not in the game"}</span>
          <span className="lockmark"><Icon name="lock" size={13} width={2} /></span>
        </div>
      </div>
      {active && (
        <label className="ed-opacity">
          <span>Opacity</span>
          <input
            type="range" min={0} max={100} aria-label="Layer opacity"
            value={active.opacity}
            onChange={(e) => ed().patchLayer(doc.activeLayer, { opacity: Number(e.target.value) })}
          />
          <span className="mono">{active.opacity}%</span>
        </label>
      )}
    </section>
  );
});
