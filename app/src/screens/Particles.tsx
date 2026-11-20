// Screen 7: the particle viewer. A live scene that plays each particle with
// its real images (the pack's, else the game's), the particle's frames or its
// cells on the shared sheet of old versions, and the way into the editor.
// The movement is an approximation (see src/particles/sim.ts).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, StatusBar, TopBar } from "../components/Shell";
import { useEditor } from "../editor/editorStore";
import { api, images, type ParticleInfo, type ParticleList } from "../lib/api";
import { cellRect, cellsLabel, uniqueCells } from "../particles/cells";
import {
  alphaOf, familyOf, frameIndex, frameMode, newSim, ORIGIN, SCENE_H, SCENE_W, GROUND_Y, sizeOf, step, tintOf,
  type Emitter, type Family, type FrameMode, type Pt, type SimState,
} from "../particles/sim";
import { useApp } from "../store";

const Nav = memo(NavBar);

type SceneKind = "night" | "day" | "water";
type Source = "pack" | "vanilla";

// remembered for the rest of the session
const memory = { selected: new Map<string, string>(), scene: "night" as SceneKind, speed: 1, source: "pack" as Source, emitter: false };

const SCENES: { key: SceneKind; label: string; sky: [string, string]; ground: [string, string] }[] = [
  { key: "night", label: "Night", sky: ["#0b1020", "#18213a"], ground: ["#23301f", "#2f4a29"] },
  { key: "day", label: "Day", sky: ["#6ea6e8", "#b8d8f5"], ground: ["#5d8c3a", "#78a94b"] },
  { key: "water", label: "Underwater", sky: ["#123b5c", "#0b2840"], ground: ["#3a4b44", "#4b5f56"] },
];
const SPEEDS: { v: number; label: string }[] = [{ v: 0.25, label: "¼×" }, { v: 1, label: "1×" }, { v: 2, label: "2×" }];

const ORIGINS: Record<Emitter, Pt> = { torch: ORIGIN, campfire: [ORIGIN[0], 382], block: [ORIGIN[0], 350] };

// ------------------------------------------------------------- images

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => ok(img);
      img.onerror = () => ok(null);
      img.src = url;
    });
    imageCache.set(url, p);
    if (imageCache.size > 600) imageCache.delete(imageCache.keys().next().value as string);
  }
  return p;
}

function crop(img: CanvasImageSource, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return c;
}

/** First frame of an image (a few particle images are animated strips). */
function firstFrame(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight > w && img.naturalHeight % w === 0 ? w : img.naturalHeight;
  return crop(img, 0, 0, w, h);
}

/** The game's colour tint, the way it multiplies a particle's image. */
function tinted(src: HTMLCanvasElement, rgb: [number, number, number]): HTMLCanvasElement {
  const c = crop(src, 0, 0, src.width, src.height);
  const ctx = c.getContext("2d")!;
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "destination-in";
  ctx.drawImage(src, 0, 0);
  return c;
}

/** Where a texture is read from: the pack's file when shown and present, else the game's. */
function textureUrl(p: ParticleInfo, i: number, source: Source, versionDir: string, stamp: number): string {
  const tex = p.textures[i];
  return source === "pack" && p.in_pack[i] ? images.packFull(tex, stamp) : images.vanillaFull(versionDir, tex);
}

/** The particle's frames as small canvases, in play order. */
async function loadFrames(p: ParticleInfo, list: ParticleList, source: Source, versionDir: string, stamp: number): Promise<HTMLCanvasElement[]> {
  if (list.layout === "separate") {
    const imgs = await Promise.all(p.textures.map((_, i) => loadImage(textureUrl(p, i, source, versionDir, stamp))));
    return imgs.filter((i): i is HTMLImageElement => i !== null).map(firstFrame);
  }
  const img = p.textures.length ? await loadImage(textureUrl(p, 0, source, versionDir, stamp)) : null;
  if (!img) return [];
  const w = img.naturalWidth;
  if (p.cells.length > 0) {
    return p.cells.map((c) => cellRect(c, w, list.sheet_grid)).filter((r) => r !== null).map((r) => crop(img, r.x, r.y, r.w, r.h));
  }
  // a particle with its own file: a grid of frames (explosion 4×4), row by row
  const g = Math.max(1, p.grid);
  const size = Math.floor(w / g);
  const out: HTMLCanvasElement[] = [];
  for (let i = 0; i < g * g; i++) out.push(crop(img, (i % g) * size, Math.floor(i / g) * size, size, size));
  return out;
}

// ------------------------------------------------------------- scene

interface SceneProps {
  particle: ParticleInfo;
  frames: HTMLCanvasElement[];
  mode: FrameMode;
  family: Family;
  scene: SceneKind;
  speed: number;
  playing: boolean;
  showEmitter: boolean;
  onCount: (n: number) => void;
}

function drawEmitter(ctx: CanvasRenderingContext2D, e: Emitter, id: string) {
  if (e === "torch") {
    ctx.fillStyle = "#7a5530";
    ctx.fillRect(304, 360, 12, 50);
    ctx.fillStyle = "#5a3d22";
    ctx.fillRect(313, 360, 3, 50);
    const soul = id.startsWith("soul");
    ctx.shadowColor = soul ? "rgba(95,215,232,0.6)" : "rgba(255,190,70,0.6)";
    ctx.shadowBlur = 22;
    ctx.fillStyle = soul ? "#5fd7e8" : "#ffc84a";
    ctx.fillRect(302, 350, 16, 14);
    ctx.shadowBlur = 0;
  } else if (e === "campfire") {
    ctx.fillStyle = "#6b4a2b";
    ctx.fillRect(250, 392, 120, 18);
    ctx.fillStyle = "#4a321c";
    ctx.fillRect(250, 406, 120, 4);
    ctx.shadowColor = "rgba(255,140,40,0.55)";
    ctx.shadowBlur = 30;
    ctx.fillStyle = "#ff9a2e";
    ctx.fillRect(270, 380, 80, 14);
    ctx.shadowBlur = 0;
  } else {
    ctx.fillStyle = "#6f6f74";
    ctx.fillRect(280, 350, 60, 60);
    ctx.fillStyle = "#8a8a90";
    ctx.fillRect(280, 350, 60, 6);
    ctx.fillRect(280, 350, 6, 60);
    ctx.fillStyle = "#55555a";
    ctx.fillRect(280, 404, 60, 6);
    ctx.fillRect(334, 350, 6, 60);
  }
}

const ParticleScene = memo(function ParticleScene(props: SceneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(props);
  live.current = props;
  const sim = useRef<SimState>(newSim(1));

  // a new particle (or new images) starts an empty scene
  useEffect(() => {
    sim.current = newSim(1);
  }, [props.particle.id]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = SCENE_W * dpr;
    canvas.height = SCENE_H * dpr;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    let last = performance.now();
    let lastCount = -1;
    let countAt = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const p = live.current;
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const emitter = p.family.emitter;
      if (p.playing) sim.current = step(sim.current, p.family, dt, p.speed, ORIGINS[emitter]);
      const sc = SCENES.find((s) => s.key === p.scene)!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const sky = ctx.createLinearGradient(0, 0, 0, SCENE_H);
      sky.addColorStop(0, sc.sky[0]);
      sky.addColorStop(p.scene === "water" ? 1 : 0.7, sc.sky[1]);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, SCENE_W, SCENE_H);
      ctx.fillStyle = sc.ground[0];
      ctx.fillRect(0, GROUND_Y, SCENE_W, SCENE_H - GROUND_Y);
      ctx.fillStyle = sc.ground[1];
      ctx.fillRect(0, GROUND_Y, SCENE_W, 4);
      if (p.showEmitter) drawEmitter(ctx, emitter, p.particle.id);
      ctx.imageSmoothingEnabled = false;
      const n = p.frames.length;
      for (const q of sim.current.parts) {
        const size = sizeOf(q, p.family);
        ctx.globalAlpha = alphaOf(q, p.family);
        const x = Math.round(q.x - size / 2);
        const y = Math.round(q.y - size / 2);
        if (n > 0) {
          const img = p.frames[frameIndex(q, n, p.mode)];
          // keep the image's shape (most are square); never smoothed
          const h = Math.round((size * img.height) / Math.max(1, img.width));
          ctx.drawImage(img, x, y, size, h);
        } else {
          ctx.fillStyle = "#c4c5cc";
          ctx.fillRect(x, y, size, size);
        }
      }
      ctx.globalAlpha = 1;
      if (p.scene === "water") {
        ctx.fillStyle = "rgba(30, 90, 160, 0.18)";
        ctx.fillRect(0, 0, SCENE_W, SCENE_H);
      }
      const count = sim.current.parts.length;
      if (count !== lastCount && now - countAt > 250) {
        lastCount = count;
        countAt = now;
        p.onCount(count);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const emitterLabel = props.showEmitter ? `Emitter: ${props.family.emitter}` : "Particles only";
  return (
    <div className="pv-scene">
      <canvas ref={canvasRef} style={{ width: SCENE_W, height: SCENE_H }} role="img" aria-label={`Scene playing ${props.particle.id}`} />
      <div className="pv-scenelabel">{emitterLabel}</div>
    </div>
  );
});

// ------------------------------------------------------------- pieces

function Seg<T extends string | number>({ label, value, options, onPick }: {
  label: string; value: T; options: { v: T; label: string }[]; onPick: (v: T) => void;
}) {
  return (
    <span className="pv-tool">
      {label}
      <span role="group" aria-label={label} className="pv-seg">
        {options.map((o) => (
          <button key={String(o.v)} className={o.v === value ? "on" : ""} aria-pressed={o.v === value} onClick={() => onPick(o.v)}>{o.label}</button>
        ))}
      </span>
    </span>
  );
}

/** A small picture of a particle's first image (a crop of the sheet for old versions). */
function Swatch({ p, list, versionDir, stamp }: { p: ParticleInfo; list: ParticleList; versionDir: string; stamp: number }) {
  if (p.textures.length === 0) return <span className="pv-swatch none" />;
  const url = textureUrl(p, 0, "pack", versionDir, stamp);
  let style: React.CSSProperties;
  if (list.layout === "sheet") {
    const g = p.cells.length ? list.sheet_grid : Math.max(1, p.grid);
    const cell = p.cells[0] ?? 0;
    style = {
      backgroundImage: `url("${url}")`,
      backgroundSize: `${g * 12}px ${g * 12}px`,
      backgroundPosition: `-${(cell % g) * 12}px -${Math.floor(cell / g) * 12}px`,
    };
  } else {
    style = { backgroundImage: `url("${url}")`, backgroundSize: "12px auto", backgroundPosition: "0 0" };
  }
  return <span className="pv-swatch" style={style} />;
}

function countLabel(p: ParticleInfo, list: ParticleList): string {
  if (list.layout === "separate") return p.textures.length === 0 ? "no images" : `${p.textures.length} fr`;
  if (p.cells.length === 0) return "own file";
  const n = uniqueCells(p.cells).length;
  return n === 1 ? "1 cell" : `${n} cells`;
}

function FrameThumb({ canvas, label, mine, onOpen }: { canvas: HTMLCanvasElement | undefined; label: string; mine: boolean; onOpen?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    c.width = 40;
    c.height = 40;
    ctx.clearRect(0, 0, 40, 40);
    if (!canvas) return;
    ctx.imageSmoothingEnabled = false;
    const k = Math.max(1, Math.floor(36 / Math.max(canvas.width, canvas.height)));
    const w = canvas.width * k;
    const h = canvas.height * k;
    const s = Math.min(1, 36 / Math.max(w, h));
    ctx.drawImage(canvas, Math.round((40 - w * s) / 2), Math.round((40 - h * s) / 2), Math.round(w * s), Math.round(h * s));
  }, [canvas]);
  const body = (
    <>
      <canvas ref={ref} className={`pv-thumb ${mine ? "mine" : ""}`} />
      <span className="pv-thumbname mono ellipsis">{label}</span>
    </>
  );
  return onOpen
    ? <button className="pv-frame" title={`${label}${mine ? " · in your pack" : " · the game's image"}. Click to edit it.`} onClick={onOpen}>{body}</button>
    : <div className="pv-frame">{body}</div>;
}

/** The whole sheet with this particle's cells highlighted and the rest dimmed. */
function SheetView({ img, cells, grid }: { img: HTMLImageElement | null; cells: number[]; grid: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const SIZE = 304;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = SIZE * dpr;
    c.height = SIZE * dpr;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0d0e10";
    ctx.fillRect(0, 0, SIZE, SIZE);
    const cell = SIZE / grid;
    // checker so transparent pixels read as empty
    for (let y = 0; y < grid * 2; y++) for (let x = 0; x < grid * 2; x++) {
      ctx.fillStyle = (x + y) % 2 ? "#17181b" : "#1d1e22";
      ctx.fillRect((x * cell) / 2, (y * cell) / 2, cell / 2, cell / 2);
    }
    ctx.imageSmoothingEnabled = false;
    if (img) ctx.drawImage(img, 0, 0, SIZE, SIZE);
    const mine = new Set(cells);
    ctx.fillStyle = "rgba(13, 14, 16, 0.78)";
    for (let i = 0; i < grid * grid; i++) {
      if (mine.has(i)) continue;
      ctx.fillRect((i % grid) * cell, Math.floor(i / grid) * cell, cell, cell);
    }
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 1.5;
    for (const i of mine) ctx.strokeRect((i % grid) * cell + 0.75, Math.floor(i / grid) * cell + 0.75, cell - 1.5, cell - 1.5);
  }, [img, cells, grid]);
  return <canvas ref={ref} className="pv-sheet" style={{ width: SIZE, height: SIZE }} role="img" aria-label="The particle sheet with this particle's cells highlighted" />;
}

// ------------------------------------------------------------- screen

export function Particles() {
  const pack = useApp((s) => s.pack);
  const stamp = useApp((s) => s.stamp);
  const setStatus = useApp((s) => s.setStatus);
  const showError = useApp((s) => s.showError);
  const reload = useApp((s) => s.reload);
  const tabs = useEditor((s) => s.tabs);

  const [list, setList] = useState<ParticleList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(pack ? (memory.selected.get(pack.dir) ?? null) : null);
  const [scene, setScene] = useState<SceneKind>(memory.scene);
  const [speed, setSpeed] = useState(memory.speed);
  const [source, setSource] = useState<Source>(memory.source);
  const [showEmitter, setShowEmitter] = useState(memory.emitter);
  const [playing, setPlaying] = useState(true);
  const [alive, setAlive] = useState(0);
  const [frames, setFrames] = useState<HTMLCanvasElement[]>([]);
  const [sheetImg, setSheetImg] = useState<HTMLImageElement | null>(null);
  const [adding, setAdding] = useState(false);

  Object.assign(memory, { scene, speed, source, emitter: showEmitter });

  const packDir = pack?.dir ?? "";
  const versionDir = pack?.project.version_dir ?? "";

  // the list again whenever the pack's files change (stamp goes up on every reload)
  useEffect(() => {
    if (!packDir) return;
    let gone = false;
    api.particleList(packDir).then(
      (l) => {
        if (gone) return;
        setList(l);
        setError(null);
      },
      (e) => {
        if (!gone) setError((e as { message?: string }).message ?? String(e));
      },
    );
    return () => {
      gone = true;
    };
  }, [packDir, stamp]);

  const particle = useMemo(() => {
    if (!list) return null;
    return list.particles.find((p) => p.id === selected)
      ?? list.particles.find((p) => p.id === "smoke")
      ?? list.particles[0] ?? null;
  }, [list, selected]);

  const pick = useCallback((id: string) => {
    setSelected(id);
    if (packDir) memory.selected.set(packDir, id);
  }, [packDir]);

  // the images of the particle being shown
  useEffect(() => {
    if (!particle || !list) return;
    let gone = false;
    void loadFrames(particle, list, source, versionDir, stamp).then((f) => {
      if (gone) return;
      const tint = tintOf(particle.id);
      setFrames(tint ? f.map((c) => tinted(c, tint)) : f);
    });
    return () => {
      gone = true;
    };
  }, [particle, list, source, versionDir, stamp]);

  // the plain (untinted) frames for the panel
  const [plainFrames, setPlainFrames] = useState<HTMLCanvasElement[]>([]);
  useEffect(() => {
    if (!particle || !list) return;
    let gone = false;
    void loadFrames(particle, list, "pack", versionDir, stamp).then((f) => { if (!gone) setPlainFrames(f); });
    if (list.layout === "sheet" && particle.textures[0]) {
      void loadImage(textureUrl(particle, 0, "pack", versionDir, stamp)).then((i) => { if (!gone) setSheetImg(i); });
    }
    return () => {
      gone = true;
    };
  }, [particle, list, versionDir, stamp]);

  const shown = useMemo(() => {
    if (!list) return [];
    const q = query.trim().toLowerCase();
    return q ? list.particles.filter((p) => p.id.includes(q)) : list.particles;
  }, [list, query]);

  if (!pack) return null;

  const sheetMode = list?.layout === "sheet";
  const versionLabel = pack.version?.label ?? pack.project.version_id ?? versionDir;
  const family = particle ? familyOf(particle.id) : familyOf("generic");
  const nFrames = particle ? (sheetMode ? (particle.cells.length || particle.grid * particle.grid) : particle.textures.length) : 0;
  const mode = particle ? frameMode(particle.id, nFrames, particle.mode) : "single";
  const unsaved = particle ? tabs.filter((t) => t.packDir === packDir && t.doc.dirty && particle.textures.includes(t.doc.path)) : [];

  const editFrame = (tex: string) => void useEditor.getState().openTexture(tex);
  const addFrame = async () => {
    if (!particle || adding) return;
    setAdding(true);
    try {
      const a = await api.particleAddFrame(particle.id, packDir);
      await reload(true);
      setStatus(`Added ${a.texture.split("/").pop()}.png (a copy of the last frame) to ${particle.id}; particles/${particle.id}.json now lists it`);
    } catch (e) {
      showError(e, `A frame could not be added to ${particle.id}`);
    } finally {
      setAdding(false);
    }
  };
  const editCells = () => {
    if (!particle || !list?.sheet) return;
    void useEditor.getState().openCells(list.sheet, {
      particle: particle.id, cells: particle.cells, shared: particle.shared_with, grid: list.sheet_grid,
    });
  };
  const saveUnsaved = async () => {
    for (const t of unsaved) if (!(await useEditor.getState().save(t.id))) return;
  };

  const top = (
    <TopBar
      crumbs={
        <>
          <span className="name ellipsis">{pack.project.name}</span>
          <span className="sep">/</span>
          <span className="leaf">Particles</span>
          {particle && (
            <>
              <span className="sep">/</span>
              <span className="mono" style={{ fontSize: 12 }}>{particle.id}</span>
            </>
          )}
        </>
      }
      right={
        <>
          <button className="btn" style={{ fontWeight: 600 }} onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Play"}</button>
          {unsaved.length > 0 && (
            <button className="btn primary" title={`Unsaved in the editor: ${unsaved.map((t) => t.doc.path).join(", ")}`} onClick={() => void saveUnsaved()}>
              Save to pack
            </button>
          )}
        </>
      }
    />
  );

  const footer = (
    <StatusBar
      right={<>→ {sheetMode
        ? (particle && particle.cells.length === 0 ? `textures/${particle.textures[0]}.png` : "textures/particle/particles.png (one shared sheet)")
        : `textures/particle/ + particles/${particle?.id ?? "<id>"}.json`}</>}
    >
      {list && <span>Particles: {list.done} / {list.total} done</span>}
      <span>1.14 and newer: one image per particle · older: one shared sheet</span>
    </StatusBar>
  );

  return (
    <>
      {top}
      <div className="body">
        <Nav />
        <aside className="pv-list">
          <div className="pv-listhead">
            <span className="caps">Particles</span>
            <span className="dim" style={{ fontSize: 11 }}>{list ? `${shown.length} of ${list.particles.length}` : ""}</span>
          </div>
          <label className="searchbox pv-search">
            <Icon name="search" size={14} width={2} />
            <input type="text" aria-label="Search particles" placeholder="Search particles…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="pv-rows" role="listbox" aria-label="Particles">
            {list && shown.map((p) => (
              <button
                key={p.id}
                role="option"
                aria-selected={p.id === particle?.id}
                className={`pv-row ${p.id === particle?.id ? "on" : ""} ${p.in_version ? "" : "absent"}`}
                title={p.in_version ? `${p.id} · ${p.status === "done" ? "in your pack" : p.status === "partly" ? "partly in your pack" : "the game's images"}` : `${p.id} does not exist in ${versionLabel}`}
                onClick={() => pick(p.id)}
              >
                <Swatch p={p} list={list} versionDir={versionDir} stamp={stamp} />
                <span className="name mono ellipsis">{p.id}</span>
                {p.status !== "todo" && p.in_version && <span className={`pv-dot ${p.status}`} aria-label={p.status === "done" ? "Done" : "Partly done"} />}
                <span className="n">{countLabel(p, list)}</span>
              </button>
            ))}
            {list && shown.length === 0 && <div className="dim" style={{ padding: 8, fontSize: 12 }}>No particle matches “{query}”.</div>}
            {!list && !error && <div className="dim" style={{ padding: 8, fontSize: 12 }}>Reading the particles…</div>}
          </div>
        </aside>

        <main className="pv-main">
          <div className="pv-toolbar">
            <Seg label="Scene" value={scene} options={SCENES.map((s) => ({ v: s.key, label: s.label }))} onPick={setScene} />
            <Seg label="Speed" value={speed} options={SPEEDS.map((s) => ({ v: s.v, label: s.label }))} onPick={setSpeed} />
            <Seg label="Show" value={source} options={[{ v: "pack", label: "Your pack" }, { v: "vanilla", label: "Vanilla" }]} onPick={setSource} />
            <span className="pv-tool" title="The layout follows the pack's Minecraft version">
              Pack
              <span className="pv-seg readonly" role="group" aria-label="Texture layout">
                <span className="on">{sheetMode ? `${versionLabel} · one sheet` : `${versionLabel} · one image each`}</span>
              </span>
            </span>
            <button className="pv-btn" aria-pressed={showEmitter} onClick={() => setShowEmitter(!showEmitter)}>
              {showEmitter ? "Hide torch / block" : "Show torch / block"}
            </button>
            <span className="pv-alive">{alive} particles alive</span>
          </div>
          <div className="pv-stage">
            {error && (
              <div className="pv-error">
                <Icon name="warn" size={16} width={2} color="var(--warn)" />
                <span>The particles could not be read: {error}</span>
              </div>
            )}
            {particle && (
              <ParticleScene
                particle={particle} frames={frames} mode={mode} family={family} scene={scene} speed={speed}
                playing={playing} showEmitter={showEmitter} onCount={setAlive}
              />
            )}
          </div>
        </main>

        <aside className="pv-side">
          {particle && list && !sheetMode && (
            <section className="pv-sec">
              <div className="pv-sechead">
                <h2 className="caps">Textures · {particle.textures.length} image{particle.textures.length === 1 ? "" : "s"}</h2>
                <span className="dim" style={{ fontSize: 11 }}>
                  {particle.textures.length === 0 ? "uses other textures" : mode === "random" ? "one picked at random" : mode === "age" ? "played over its lifetime" : "single image"}
                </span>
              </div>
              {particle.textures.length > 0 ? (
                <div className="pv-frames">
                  {particle.textures.map((t, i) => (
                    <FrameThumb key={`${t}:${i}`} canvas={plainFrames[i]} label={t.split("/").pop()!} mine={particle.in_pack[i]} onOpen={() => editFrame(t)} />
                  ))}
                </div>
              ) : (
                <div className="pv-note">This particle has no images of its own: the game draws it from a block or item texture.</div>
              )}
              {particle.skipped.length > 0 && (
                <div className="pv-note">Not shown (another namespace): <span className="mono">{particle.skipped.join(", ")}</span></div>
              )}
              <div className="pv-actions">
                <button className="pv-btn primary" disabled={particle.textures.length === 0} title="Opens the first frame in the editor. Each frame is its own texture: click a frame above to open that one." onClick={() => editFrame(particle.textures[0])}>Edit frames</button>
                <button className="pv-btn" disabled={particle.textures.length === 0 || adding} title="Copies the last frame into a new image in your pack and adds it to the end of the particle's frame list" onClick={() => void addFrame()}>{adding ? "Adding…" : "Add frame"}</button>
              </div>
            </section>
          )}

          {particle && list && sheetMode && (
            <section className="pv-sec">
              <div className="pv-sechead">
                <h2 className="caps">{particle.cells.length ? "Particle sheet" : "Particle image"}</h2>
                <span className="mono dim" style={{ fontSize: 10 }}>
                  {particle.textures[0]?.split("/").pop()}.png{sheetImg ? ` · ${sheetImg.naturalWidth}×${sheetImg.naturalHeight}` : ""}
                </span>
              </div>
              {particle.cells.length > 0 ? (
                <>
                  <SheetView img={sheetImg} cells={uniqueCells(particle.cells)} grid={list.sheet_grid} />
                  <div className="pv-text">
                    {uniqueCells(particle.cells).length > 1 ? `The ${uniqueCells(particle.cells).length} highlighted cells (${cellsLabel(particle.cells)}) are ` : `The highlighted cell (${cellsLabel(particle.cells)}) is `}
                    {particle.id}. Everything else on the sheet belongs to other particles and is left untouched.
                    {!particle.in_version && ` ${particle.id} does not exist in ${versionLabel} yet, so the game does not use these cells.`}
                  </div>
                  {particle.shared_with.length > 0 && (
                    <div className="pv-shared">
                      <Icon name="warn" size={14} width={2} color="var(--warn)" />
                      <span>
                        {uniqueCells(particle.cells).length === 1 ? "This cell is" : "These cells are"} shared with{" "}
                        <span className="mono">{particle.shared_with.join(", ")}</span>. A change shows on {particle.shared_with.length === 1 ? "that particle" : "those particles"} too.
                      </span>
                    </div>
                  )}
                  <div className="caps" style={{ paddingTop: 4 }}>Only this particle</div>
                  <div className="pv-cells">
                    {particle.cells.map((c, i) => <FrameThumb key={`${c}:${i}`} canvas={plainFrames[i]} label={String(c)} mine={particle.in_pack[0]} />)}
                  </div>
                  <div className="pv-actions">
                    <button className="pv-btn primary" onClick={editCells}>Edit only these cells</button>
                  </div>
                </>
              ) : (
                <>
                  <div className="pv-text">
                    {particle.id} is not on the sheet: it uses its own image, <span className="mono">textures/{particle.textures[0]}.png</span>
                    {particle.grid > 1 ? ` (${particle.grid}×${particle.grid} frames, played over its lifetime).` : "."}
                    {!particle.in_version && ` It is not used in ${versionLabel}.`}
                  </div>
                  <div className="pv-cells">
                    {plainFrames.map((c, i) => <FrameThumb key={i} canvas={c} label={String(i)} mine={particle.in_pack[0]} />)}
                  </div>
                  <div className="pv-actions">
                    <button className="pv-btn primary" onClick={() => editFrame(particle.textures[0])}>Edit {particle.textures[0].split("/").pop()}.png</button>
                  </div>
                </>
              )}
            </section>
          )}

          {particle && list && (
            <section className="pv-sec">
              <div className="pv-sechead">
                <h2 className="caps">Particle file</h2>
                <span className="mono dim" style={{ fontSize: 10 }}>
                  {sheetMode ? `textures/${particle.textures[0] ?? "particle/particles"}.png` : `particles/${particle.id}.json${particle.json_from_pack ? " · your pack" : " · the game's"}`}
                </span>
              </div>
              {sheetMode ? (
                <div className="pv-note">
                  1.13.2 and older have no particle files: each particle sits at a fixed spot on the sheet. The app knows those spots, so you only ever edit the cells of the particle you picked.
                </div>
              ) : (
                <pre className="pv-json">{particle.json ?? ""}</pre>
              )}
            </section>
          )}

          <section className="pv-sec last">
            <div className="pv-warnbox">
              <Icon name="warn" size={16} width={2} color="var(--warn)" />
              <span>A resource pack can change how a particle <b>looks</b> (its images and their order), not how it <b>moves</b>. Movement here is an approximation of the game.</span>
            </div>
          </section>
        </aside>
      </div>
      {footer}
    </>
  );
}
