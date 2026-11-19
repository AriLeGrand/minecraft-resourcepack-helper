// Screen 4: animation. Works on the editor's open texture (the same document
// and undo history as the editor): frames, timing, frame order and the
// generated .mcmeta, with an in-game preview at the game's speed.
import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import {
  docOrder, formatOrder, frametimeOf, imageTicks, imageTime, isPlayable, loopLabel, loopTicks, MAX_TICKS, orderKind, parseOrder,
  pingPong, secondsLabel, splitStrip, type At, type Entry, type OrderKind,
} from "../editor/anim";
import { Canvas } from "../editor/Canvas";
import { isAnimated, PACK_ICON, targetLabel, type EditorDoc } from "../editor/doc";
import { activeTab, fileName, useEditor, type Tab } from "../editor/editorStore";
import { PixelView } from "../editor/Panels";
import { BlockPreview, LiveTexture } from "../editor/BlockPreview";
import { isBlockTexture } from "../editor/blockMesh";
import { useAnimPlayer } from "../editor/Player";
import { base64ToBytes, rgbaToHex, type Buf } from "../editor/pixels";
import { flatFrame } from "../editor/render";
import { toolDef } from "../editor/tools";
import { api, toError } from "../lib/api";
import { folderOf } from "../lib/logic";
import { useApp } from "../store";
import { NumberField, useShortcuts } from "./Editor";

const Nav = memo(NavBar);

function EmptyAnimation({ icon }: { icon: boolean }) {
  const go = useApp((s) => s.go);
  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <Nav />
        <div className="placeholder">
          <Icon name="animation" size={28} color="var(--muted)" />
          <div className="big">{icon ? "The pack icon is a still image" : "No texture is open"}</div>
          <div style={{ maxWidth: 440, textAlign: "center" }}>
            {icon
              ? "Minecraft shows pack.png as one picture. Switch to a texture tab in the editor to work on an animation."
              : "Open a texture first: pick it in the texture browser and choose “Edit texture”, or double-click it. Its frames, timing and frame order are then shown here."}
          </div>
          <button className="btn primary" onClick={() => go(icon ? "editor" : "textures")}>{icon ? "Back to the editor" : "Open the texture browser"}</button>
        </div>
      </div>
      <StatusBar />
    </>
  );
}

const AnimTop = memo(function AnimTop({ packName, path, dirty, animated, saving }: {
  packName: string; path: string; dirty: boolean; animated: boolean; saving: boolean;
}) {
  const go = useApp((s) => s.go);
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
          {animated && <span className="an-badge">Animated</span>}
          {dirty && <span className="ed-dirty" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
        </>
      }
      right={
        <>
          <button className="btn ghost an-back" onClick={() => go("editor")}>Back to editor</button>
          <button className="btn primary" disabled={saving} onClick={() => void useEditor.getState().save()}>Save to pack&nbsp;&nbsp;Ctrl S</button>
        </>
      }
    />
  );
});

/** Under the big frame: which frame, onion skin, and what a click on it does. */
function Caption({ doc }: { doc: EditorDoc }) {
  const onion = useEditor((s) => s.options.onionSkin);
  const tool = useEditor((s) => s.tool);
  const fg = useEditor((s) => s.fg);
  const n = doc.frames.length;
  return (
    <div className="an-caption">
      <span>Frame {doc.frameIndex + 1} of {n}{onion && n > 1 ? " · onion skin ±1 frame" : ""}</span>
      <span className="an-tool" title="The editor's current tool and colour. Change them in the editor or with their keys (B pencil, E eraser, G bucket …).">
        · {toolDef(tool).name}
        <span className="swatch checker"><span style={{ background: rgbaToHex(fg) }} /></span>
      </span>
    </div>
  );
}

interface PendingStrip {
  name: string;
  img: Buf;
  frameHeight: number;
}

/** Choosing the frame height of a strip before it is imported. */
function ImportBar({ pending, doc, onChange, onDone }: {
  pending: PendingStrip; doc: EditorDoc; onChange: (p: PendingStrip) => void; onDone: () => void;
}) {
  const split = useMemo(() => splitStrip(pending.img, pending.frameHeight), [pending]);
  const importFrames = useEditor((s) => s.importFrames);
  const { img } = pending;
  const differs = split.ok && (img.w !== doc.width || split.frameHeight !== doc.height);
  return (
    <div className="an-import" role="group" aria-label="Import strip">
      <span className="mono">{pending.name}</span>
      <span className="dim">{img.w}×{img.h}</span>
      <label>
        Frame height
        <NumberField
          className="ed-num" label="Frame height" value={pending.frameHeight} min={1} max={img.h} suffix="px"
          onChange={(frameHeight) => onChange({ ...pending, frameHeight })}
        />
      </label>
      {split.ok ? (
        <span className={differs ? "warn" : "dim"}>
          → {split.frames.length} frame{split.frames.length === 1 ? "" : "s"} of {img.w}×{split.frameHeight}
          {differs ? ` (the texture is ${doc.width}×${doc.height}: its frames will be replaced)` : " into the active layer"}
        </span>
      ) : (
        <span className="warn an-importerr">{split.error}</span>
      )}
      <span className="grow" />
      <button className="an-btn" onClick={onDone}>Cancel</button>
      <button
        className="an-btn primary" disabled={!split.ok}
        onClick={() => {
          if (!split.ok) return;
          onDone();
          importFrames(split.frames, pending.name);
        }}
      >
        Import {split.ok ? `${split.frames.length} frame${split.frames.length === 1 ? "" : "s"}` : ""}
      </button>
    </div>
  );
}

/** The duration under a thumbnail; click to type another one. */
function Duration({ doc, index }: { doc: EditorDoc; index: number }) {
  const setFrameTime = useEditor((s) => s.setFrameTime);
  const [draft, setDraft] = useState<string | null>(null);
  const typed = useRef<string | null>(null);
  const own = imageTime(doc, index);
  const ticks = imageTicks(doc, index);
  const edit = (t: string | null) => {
    typed.current = t;
    setDraft(t);
  };
  const apply = () => {
    const t = typed.current;
    edit(null);
    if (t === null) return;
    if (t.trim() === "") {
      setFrameTime(index, null);
      return;
    }
    const n = Number(t);
    if (Number.isFinite(n) && n >= 1) setFrameTime(index, Math.min(MAX_TICKS, Math.round(n)));
  };
  if (draft !== null) {
    return (
      <input
        className="an-dur-input" type="number" min={1} max={MAX_TICKS} autoFocus aria-label={`Duration of frame ${index + 1} in ticks`}
        title="Ticks (1 tick = 0.05 s). Empty = the frame time. Enter applies, Escape cancels."
        value={draft}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => edit(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            edit(null);
            e.currentTarget.blur();
          }
          e.stopPropagation();
        }}
      />
    );
  }
  return (
    <button
      className={`an-dur ${own !== null ? "own" : ""}`}
      aria-label={`Frame ${index + 1} is shown for ${ticks} tick${ticks === 1 ? "" : "s"}. Click to change.`}
      title={`${ticks} tick${ticks === 1 ? "" : "s"} = ${secondsLabel(ticks)} s${own !== null ? " (own duration)" : " (the frame time)"}. Click to change.`}
      onClick={(e) => {
        e.stopPropagation();
        edit(String(own ?? ticks));
      }}
    >
      {ticks}t
    </button>
  );
}

const Thumb = memo(function Thumb({ buf, label }: { buf: Buf; label: string }) {
  return <PixelView buf={buf} box={70} label={label} />;
});

const FrameStrip = memo(function FrameStrip({ doc }: { doc: EditorDoc }) {
  const select = useEditor((s) => s.selectFrame);
  const newFrame = useEditor((s) => s.newFrame);
  const used = useMemo(() => new Set(docOrder(doc).map((e) => e.index)), [doc]);
  const listRef = useRef<HTMLDivElement>(null);
  // keep the selected frame in view
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".an-frame.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [doc.frameIndex, doc.frames.length]);
  return (
    <div className="an-strip" ref={listRef} role="listbox" aria-label="Frames" aria-orientation="horizontal">
      {doc.frames.map((_, i) => {
        const on = i === doc.frameIndex;
        const unused = !used.has(i);
        return (
          <div
            key={i}
            role="option"
            aria-selected={on}
            className={`an-frame ${on ? "on" : ""} ${unused ? "unused" : ""}`}
            title={unused ? `Frame ${i + 1} is not in the frame order, so the game never shows it` : `Frame ${i + 1} (number ${i} in the file)`}
            onMouseDown={(e) => { if (e.button === 0) select(i); }}
          >
            <div className="thumb checker"><Thumb buf={flatFrame(doc, i)} label={`Frame ${i + 1}`} /></div>
            <div className="meta">
              <span className="n">{i + 1}</span>
              <Duration doc={doc} index={i} />
            </div>
          </div>
        );
      })}
      <button className="an-add" aria-label="New frame" title="Add an empty frame after the current one" onClick={newFrame}>+</button>
    </div>
  );
});

const Toolbar = memo(function Toolbar({ count, frameIndex, playing, loop, playable, onPlay, onLoop, onImport }: {
  count: number; frameIndex: number; playing: boolean; loop: boolean; playable: boolean;
  onPlay: () => void; onLoop: (on: boolean) => void; onImport: () => void;
}) {
  const ed = useEditor.getState;
  const onion = useEditor((s) => s.options.onionSkin);
  return (
    <div className="an-toolbar">
      <button className="an-sq" aria-label="First frame" title="First frame" onClick={() => ed().selectFrame(0)}>«</button>
      <button className="an-play" disabled={!playable} title={playable ? "Play the preview at the game's speed" : "Add a frame to have something to play"} onClick={onPlay}>
        {playing ? "Pause" : "Play"}
      </button>
      <button className="an-sq" aria-label="Last frame" title="Last frame" onClick={() => ed().selectFrame(count - 1)}>»</button>
      <span className="vr" />
      <label className="tick" title="Shows the frame before and the frame after faintly under the one you are drawing. Never saved.">
        <input type="checkbox" checked={onion} onChange={(e) => ed().setOptions({ onionSkin: e.target.checked })} /> Onion skin
      </label>
      <label className="tick" title="Off: the preview stops on the last frame. The game always loops.">
        <input type="checkbox" checked={loop} onChange={(e) => onLoop(e.target.checked)} /> Loop
      </label>
      <span className="grow" />
      <button className="an-sq" aria-label="Move frame left" title="Move the frame one place left" disabled={frameIndex <= 0} onClick={() => ed().moveFrame(-1)}>
        <Icon name="prev" size={14} width={2} />
      </button>
      <button className="an-sq" aria-label="Move frame right" title="Move the frame one place right" disabled={frameIndex >= count - 1} onClick={() => ed().moveFrame(1)}>
        <Icon name="next" size={14} width={2} />
      </button>
      <button className="an-btn" title="Add an empty frame after the current one" onClick={() => ed().newFrame()}>+ New frame</button>
      <button className="an-btn" title="Copy the current frame (all layers) and put the copy after it" onClick={() => ed().duplicateFrame()}>Duplicate</button>
      <button className="an-btn" title={count > 1 ? "Delete the current frame" : "A texture needs at least one frame"} disabled={count <= 1} onClick={() => ed().deleteFrame()}>Delete</button>
      <button className="an-btn" title="Read a vertical strip of frames from an image file" onClick={onImport}>Import strip…</button>
    </div>
  );
});

/** Flat image and a 3D block, both playing at the game's speed. */
const LivePreview = memo(function LivePreview({ doc, packDir, playing, loop, onEnded, onEntry }: {
  doc: EditorDoc; packDir: string; playing: boolean; loop: boolean; onEnded: () => void; onEntry: (entry: number | null) => void;
}) {
  const counter = useRef<HTMLSpanElement>(null);
  const count = doc.frames.length;
  const versionDir = useApp((s) => s.pack?.project.version_dir ?? "");
  // the 3D view takes the player's pictures: one clock for both
  const [live] = useState(() => new LiveTexture());
  const onPaint = useCallback((buf: Buf) => live.set(buf), [live]);
  const onShow = useCallback((at: At) => {
    if (counter.current) counter.current.textContent = `frame ${at.image + 1} / ${count}`;
    onEntry(at.entry);
  }, [count, onEntry]);
  const slot = useAnimPlayer(doc, { playing, loop, onEnded, onShow, onPaint });
  const scale = 112 / Math.max(doc.width, doc.height);
  const block = isBlockTexture(doc.path);
  return (
    <section className="an-panel">
      <div className="head">
        <h2 className="caps">In-game preview</h2>
        <span className="dim" ref={counter} aria-live="off">frame {doc.frameIndex + 1} / {count}</span>
      </div>
      <div className="an-live">
        <canvas
          ref={slot(0)} className="pixel" role="img" aria-label="The texture as the game shows it"
          style={{ width: Math.round(doc.width * scale), height: Math.round(doc.height * scale) }}
        />
        {block && (
          <div className="an-3d">
            <BlockPreview texture={doc.path} live={live} packDir={packDir} versionDir={versionDir} height={132} cubeFirst bare />
          </div>
        )}
      </div>
    </section>
  );
});

const PRESETS: { kind: OrderKind; label: string; hint: string }[] = [
  { kind: "inOrder", label: "In order", hint: "In order: every frame from top to bottom" },
  { kind: "pingPong", label: "Ping-pong", hint: "Ping-pong: plays forward then back" },
  { kind: "custom", label: "Custom", hint: "Custom: your own order. Frames can repeat." },
];

/** Frame order chips and the editor for them. */
function FrameOrder({ doc, chipRefs }: { doc: EditorDoc; chipRefs: React.MutableRefObject<(HTMLSpanElement | null)[]> }) {
  const setOrder = useEditor((s) => s.setOrder);
  const count = doc.frames.length;
  const entries = useMemo(() => docOrder(doc), [doc]);
  const kind = orderKind(doc.animation, count);
  const [editing, setEditing] = useState(false);
  const [custom, setCustom] = useState<string | null>(null);
  const text = custom ?? formatOrder(entries);
  const parsed = custom === null ? null : parseOrder(custom, count);
  const shownKind = custom !== null ? "custom" : kind;
  const applyCustom = () => {
    if (!parsed) return;
    if (parsed.ok) {
      setOrder(parsed.entries, "Custom frame order");
      setCustom(null);
    }
  };
  const choose = (k: OrderKind) => {
    if (k === "custom") {
      setCustom(formatOrder(entries));
      return;
    }
    setCustom(null);
    if (k === "inOrder") setOrder(null, "Frames in order");
    else setOrder(pingPong(count).map((index): Entry => ({ index, time: null })), "Ping-pong order");
  };
  return (
    <div className="an-order">
      <span className="label">Frame order</span>
      <div className="chips">
        {entries.map((e, i) => (
          <span
            key={i} ref={(el) => { chipRefs.current[i] = el; }} className="chip-n mono"
            title={`Step ${i + 1}: frame ${e.index + 1} of the strip (number ${e.index} in the file), ${e.time ?? frametimeOf(doc.animation)} ticks`}
          >
            {e.time === null ? e.index : `${e.index}:${e.time}`}
          </span>
        ))}
        <button className="an-editlink" aria-expanded={editing} onClick={() => { setEditing(!editing); setCustom(null); }}>
          {editing ? "Done" : "Edit…"}
        </button>
      </div>
      <span className="dim small">{PRESETS.find((p) => p.kind === shownKind)?.hint}</span>
      {editing && (
        <div className="an-ordereditor">
          <div className="seg sm an-seg" role="group" aria-label="Frame order preset">
            {PRESETS.map((p) => (
              <button key={p.kind} className={shownKind === p.kind ? "on" : ""} aria-pressed={shownKind === p.kind} disabled={p.kind === "pingPong" && count < 3} onClick={() => choose(p.kind)}>
                {p.label}
              </button>
            ))}
          </div>
          {shownKind === "custom" && (
            <>
              <div className="an-customrow">
                <input
                  className="input mono" aria-label="Custom frame order" spellCheck={false}
                  value={text}
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyCustom();
                    else if (e.key === "Escape") setCustom(null);
                  }}
                />
                <button className="an-btn primary" disabled={!parsed || !parsed.ok} onClick={applyCustom}>Apply</button>
              </div>
              {parsed && !parsed.ok ? (
                <span className="warn small">{parsed.error}</span>
              ) : (
                <span className="dim small">Numbers count from 0 like in the file (the first frame is 0). Write 2:5 to show frame 2 for 5 ticks.</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

const Settings = memo(function Settings({ doc, chipRefs }: { doc: EditorDoc; chipRefs: React.MutableRefObject<(HTMLSpanElement | null)[]> }) {
  const setFrametime = useEditor((s) => s.setFrametime);
  const setInterpolate = useEditor((s) => s.setInterpolate);
  const ft = frametimeOf(doc.animation);
  if (!isAnimated(doc)) {
    return (
      <section className="an-panel">
        <h2 className="caps">Animation settings (.mcmeta)</h2>
        <span className="dim small">This texture has one frame, so it is a still image and gets no .mcmeta file. Add a frame (+ New frame, Duplicate) or import a strip to animate it.</span>
      </section>
    );
  }
  return (
    <section className="an-panel an-settings">
      <h2 className="caps">Animation settings (.mcmeta)</h2>
      <div className="an-row">
        <span>Frame time</span>
        <div className="an-ft">
          <NumberField className="an-num" label="Frame time in ticks" value={ft} min={1} max={MAX_TICKS} suffix="" onChange={setFrametime} />
          <span className="dim">ticks = {secondsLabel(ft)} s</span>
        </div>
      </div>
      <div className="an-row">
        <span>Smooth between frames</span>
        <label className="tick mono" title="The game blends each frame into the next one, tick by tick">
          <input type="checkbox" checked={doc.animation?.interpolate ?? false} onChange={(e) => setInterpolate(e.target.checked)} /> interpolate
        </label>
      </div>
      <FrameOrder doc={doc} chipRefs={chipRefs} />
    </section>
  );
});

/** The .mcmeta text a save writes, as Rust makes it. */
const Generated = memo(function Generated({ tab }: { tab: Tab }) {
  const doc = tab.doc;
  const animated = isAnimated(doc);
  const times = doc.frames.map((f) => f.time);
  const key = JSON.stringify([doc.path, doc.animation, times, tab.packDir, animated]);
  const [result, setResult] = useState<{ key: string; text?: string; error?: { message: string; hint: string | null } } | null>(null);
  useEffect(() => {
    if (!animated) return;
    let stale = false;
    const t = window.setTimeout(() => {
      api.animationMcmeta(doc.path, doc.animation, times, tab.packDir)
        .then((text) => { if (!stale) setResult({ key, text }); })
        .catch((e) => { if (!stale) setResult({ key, error: toError(e) }); });
    }, 120);
    return () => {
      stale = true;
      window.clearTimeout(t);
    };
    // the key holds everything the text depends on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const n = doc.frames.length;
  return (
    <section className="an-panel">
      <div className="head">
        <h2 className="caps">Generated file</h2>
        <span className="dim">{animated ? "written on save" : "none"}</span>
      </div>
      {animated ? (
        result?.error ? (
          <div className="an-error" role="alert">
            <div>{result.error.message}</div>
            {result.error.hint && <div className="dim">{result.error.hint}</div>}
          </div>
        ) : (
          <pre className={`an-file ${result?.key === key ? "" : "stale"}`} aria-label=".mcmeta file">{result?.text ?? " "}</pre>
        )
      ) : (
        <div className="dim small">A still image is saved without a .mcmeta file.</div>
      )}
      <div className="dim small">
        Image saved as one {doc.width}×{doc.height * n} strip{n > 1 ? ` (${n} frames stacked)` : ""}
      </div>
    </section>
  );
});

const AnimStatus = memo(function AnimStatus({ doc }: { doc: EditorDoc }) {
  const entries = docOrder(doc);
  const total = loopTicks(entries, frametimeOf(doc.animation));
  const n = doc.frames.length;
  return (
    <StatusBar right={<>→ {targetLabel(doc)}</>}>
      <span>{n} frame{n === 1 ? "" : "s"} · {doc.width}×{doc.height} each</span>
      {isPlayable(doc) && <span>Loop length {loopLabel(total)} s</span>}
      {doc.dirty && <span style={{ color: "var(--warn)" }}>Unsaved changes</span>}
    </StatusBar>
  );
});

/** Where Import strip looks for the frame height: as wide as the image, or the texture's own frame height. */
function defaultFrameHeight(img: Buf, doc: EditorDoc): number {
  if (img.h % img.w === 0) return img.w;
  if (img.w === doc.width && img.h % doc.height === 0) return doc.height;
  return img.w;
}

export function Animation() {
  const tab = useEditor(activeTab);
  const pack = useApp((s) => s.pack);
  const [playing, setPlaying] = useState(true);
  const [loop, setLoop] = useState(true);
  const [pending, setPending] = useState<PendingStrip | null>(null);
  const chipRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const liveChip = useRef<HTMLSpanElement | null>(null);
  useShortcuts(tab !== null && tab.doc.path !== PACK_ICON);

  const onEnded = useCallback(() => setPlaying(false), []);
  // the order chip being played is lit without rendering the screen again
  const onEntry = useCallback((entry: number | null) => {
    const el = entry === null ? null : chipRefs.current[entry] ?? null;
    if (el === liveChip.current) return;
    liveChip.current?.classList.remove("live");
    el?.classList.add("live");
    liveChip.current = el;
  }, []);

  // a strip read for another tab is not imported into this one
  const tabId = tab?.id;
  useEffect(() => setPending(null), [tabId]);

  /** Reads the chosen file and shows the import bar. */
  const loadStrip = useCallback(async (src: string) => {
    const app = useApp.getState();
    try {
      const raw = await api.readImageRaw(src);
      const data = base64ToBytes(raw.rgba);
      if (data.length !== raw.width * raw.height * 4) throw new Error("The image data does not match its size.");
      const img: Buf = { w: raw.width, h: raw.height, data };
      const current = activeTab(useEditor.getState());
      if (!current) return;
      setPending({ name: src.split(/[\\/]/).pop() ?? src, img, frameHeight: defaultFrameHeight(img, current.doc) });
    } catch (e) {
      app.showError(e, "The strip could not be read");
    }
  }, []);

  // Development only: the native file dialog cannot be driven by the test
  // tool (tools/shot.mjs), so it can hand a path straight to the import.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __packCreatorDev?: { importStrip: (p: string) => Promise<void> } };
    w.__packCreatorDev = { importStrip: loadStrip };
    return () => {
      delete w.__packCreatorDev;
    };
  }, [loadStrip]);

  if (!tab || !pack) return <EmptyAnimation icon={false} />;
  if (tab.doc.path === PACK_ICON) return <EmptyAnimation icon />;
  const doc = tab.doc;
  const playable = isPlayable(doc);

  const importStrip = async () => {
    let src: string | string[] | null;
    try {
      src = await open({ title: "Import a strip of frames", filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif"] }] });
    } catch (e) {
      useApp.getState().showError(e, "The file could not be chosen");
      return;
    }
    if (src && !Array.isArray(src)) await loadStrip(src);
  };

  return (
    <>
      <AnimTop packName={pack.project.name} path={doc.path} dirty={doc.dirty} animated={isAnimated(doc)} saving={tab.saving} />
      <div className="body">
        <Nav />
        <main className="an-main">
          <div className="an-stage">
            <Canvas tab={tab} />
            <Caption doc={doc} />
          </div>
          <div className="an-timeline">
            <Toolbar
              count={doc.frames.length} frameIndex={doc.frameIndex} playing={playing && playable} loop={loop} playable={playable}
              onPlay={() => setPlaying(!(playing && playable))} onLoop={setLoop} onImport={() => void importStrip()}
            />
            {pending && <ImportBar pending={pending} doc={doc} onChange={setPending} onDone={() => setPending(null)} />}
            <FrameStrip doc={doc} />
          </div>
        </main>
        <aside className="an-side">
          <LivePreview doc={doc} packDir={tab.packDir} playing={playing && playable} loop={loop} onEnded={onEnded} onEntry={onEntry} />
          <Settings doc={doc} chipRefs={chipRefs} />
          <Generated tab={tab} />
        </aside>
      </div>
      <AnimStatus doc={doc} />
    </>
  );
}
