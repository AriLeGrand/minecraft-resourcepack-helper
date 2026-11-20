// Scene: a small diorama of blocks in 3D with the pack's textures (and the
// unsaved pixels of open editor tabs), presets, a custom scene saved with the
// pack, and the game's light (time of day, block light, ambient occlusion).
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import { useEditor } from "../editor/editorStore";
import { api, images, type SceneBlock } from "../lib/api";
import { useApp } from "../store";
import {
  cellIndex, cellOf, fromSceneFile, gardenScene, houseScene, MAX_DEPTH, MAX_HEIGHT, MAX_WIDTH, newCustomScene, pickRole,
  PRESETS, resizeGrid, setBlock, toSceneFile, usedIds, wallScene, type PresetId, type Role, type SceneGrid,
} from "../scene/grid";
import { levelLabel, TIMES } from "../scene/light";
import { useLighting } from "../scene/lighting";
import { SceneView } from "../scene/LazySceneView";
import type { CameraPreset } from "../scene/SceneView";

const Nav = memo(NavBar);

// kept while the app runs: the preset and the block picked last
let lastPreset: PresetId = "house";
let lastBrush: string | null = null;

/** A texture's first frame, the pack's file or else the game's. */
function TexThumb({ path, versionDir, stamp, size = 28 }: { path: string; versionDir: string; stamp: number; size?: number }) {
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [path, stamp]);
  return (
    <img
      className="sc-thumb" alt="" width={size} height={size} draggable={false}
      src={fallback ? images.vanillaFull(versionDir, path) : images.packFull(path, stamp)}
      onError={() => { if (!fallback) setFallback(true); }}
    />
  );
}

/** The texture that best shows a block in a small square (its top, else any face). */
function faceTexture(b: SceneBlock | undefined): string | null {
  if (!b) return null;
  for (const m of b.models) for (const e of m.elements) {
    const t = e.faces.up?.texture ?? e.faces.north?.texture;
    if (t) return t;
  }
  return null;
}

function textureList(b: SceneBlock | undefined): string[] {
  if (!b) return [];
  const s = new Set<string>();
  for (const m of b.models) for (const e of m.elements) for (const f of Object.values(e.faces)) if (f?.texture) s.add(f.texture);
  return [...s].sort();
}

export function Scene() {
  const pack = useApp((s) => s.pack);
  const stamp = useApp((s) => s.stamp);
  const toast = useApp((s) => s.toast);
  const showError = useApp((s) => s.showError);
  const setStatus = useApp((s) => s.setStatus);
  const packDir = pack?.dir ?? "";
  const versionDir = pack?.project.version_dir ?? "";
  const { time, level, ao, setTime, setLevel, setAo } = useLighting();
  const openTabs = useEditor((s) => s.tabs);

  const [available, setAvailable] = useState<string[] | null>(null);
  const [preset, setPreset] = useState<PresetId>(lastPreset);
  const [brush, setBrushState] = useState<string | null>(lastBrush);
  const [custom, setCustom] = useState<SceneGrid | null>(null);
  const [layer, setLayer] = useState(1);
  const [query, setQuery] = useState("");
  const [cache, setCache] = useState<Map<string, SceneBlock>>(new Map());
  const [selected, setSelected] = useState<number | null>(null);
  const [camera, setCamera] = useState<{ preset: CameraPreset; n: number }>({ preset: "orbit", n: 0 });
  const [stats, setStats] = useState<{ quads: number; culled: number; batches: number } | null>(null);
  const [saved, setSaved] = useState<"saved" | "saving" | "idle">("idle");

  const setBrush = (id: string) => {
    lastBrush = id;
    setBrushState(id);
  };
  const choosePreset = (p: PresetId) => {
    lastPreset = p;
    setPreset(p);
    setSelected(null);
  };

  // the blocks this version can place
  useEffect(() => {
    if (!packDir) return;
    let gone = false;
    api.sceneBlockList(packDir).then(
      (list) => { if (!gone) setAvailable(list); },
      (e) => { if (!gone) { setAvailable([]); showError(e, "The list of blocks could not be read"); } },
    );
    return () => { gone = true; };
  }, [packDir, showError]);

  const avail = useMemo(() => new Set(available ?? []), [available]);
  const pick = useCallback((r: Role) => pickRole(r, avail), [avail]);
  const brushId = brush && (avail.size === 0 || avail.has(brush)) ? brush : pick("planks");

  // the custom scene saved with the pack (or a new one)
  useEffect(() => {
    if (!packDir || available === null) return;
    let gone = false;
    api.sceneLoad(packDir).then(
      (f) => { if (!gone) setCustom((f && fromSceneFile(f)) || newCustomScene(pickRole("grass", new Set(available)))); },
      (e) => {
        if (gone) return;
        setCustom(newCustomScene(pickRole("grass", new Set(available))));
        showError(e, "The custom scene could not be read");
      },
    );
    return () => { gone = true; };
  }, [packDir, available, showError]);

  // saving the custom scene shortly after each change
  const pending = useRef<SceneGrid | null>(null);
  const timer = useRef(0);
  const flushSave = useCallback(() => {
    window.clearTimeout(timer.current);
    const g = pending.current;
    pending.current = null;
    if (!g || !packDir) return;
    setSaved("saving");
    api.sceneSave(toSceneFile(g), packDir).then(
      () => { setSaved("saved"); setStatus("Custom scene saved in .packcreator/scene.json"); },
      (e) => { setSaved("idle"); showError(e, "The custom scene could not be saved"); },
    );
  }, [packDir, setStatus, showError]);
  useEffect(() => () => flushSave(), [flushSave]);
  const changeCustom = (g: SceneGrid) => {
    setCustom(g);
    pending.current = g;
    setSaved("saving");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flushSave, 400);
  };

  const grid = useMemo<SceneGrid | null>(() => {
    if (available === null) return null;
    if (preset === "house") return houseScene(pick);
    if (preset === "garden") return gardenScene(pick);
    if (preset === "wall") return wallScene(brushId);
    return custom;
  }, [available, preset, pick, brushId, custom]);

  // resolved models of the blocks used (fetched once per block; again when pack files change)
  useEffect(() => setCache(new Map()), [stamp, packDir]);
  const ids = useMemo(() => (grid ? usedIds(grid) : []), [grid]);
  useEffect(() => {
    const missing = ids.filter((id) => !cache.has(id));
    if (!packDir || missing.length === 0) return;
    let gone = false;
    api.sceneBlocks(missing, packDir).then(
      (list) => {
        if (gone) return;
        setCache((c) => {
          const n = new Map(c);
          for (const b of list) n.set(b.id, b);
          return n;
        });
      },
      (e) => { if (!gone) showError(e, "The blocks of the scene could not be read"); },
    );
    return () => { gone = true; };
  }, [ids, cache, packDir, showError]);
  const blocks = useMemo(() => ids.map((id) => cache.get(id)).filter((b): b is SceneBlock => !!b), [ids, cache]);
  const problems = blocks.filter((b) => b.error);

  const selId = selected !== null && grid ? grid.blocks[selected] ?? "" : "";
  const selBlock = selId ? cache.get(selId) : undefined;
  const selCell = selected !== null && grid ? cellOf(grid, selected) : null;
  const onPick = useCallback((cell: number | null) => {
    setSelected(cell);
    if (cell !== null && preset === "custom" && grid) setLayer(cellOf(grid, cell)[1]);
  }, [preset, grid]);

  const live = openTabs.filter((t) => t.packDir === packDir);
  const liveUsed = live.filter((t) => blocks.some((b) => textureList(b).includes(t.doc.path)));
  const unsavedUsed = liveUsed.filter((t) => t.doc.dirty);

  const shownBlocks = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = available ?? [];
    return q ? list.filter((id) => id.includes(q.replace(/\s+/g, "_"))) : list;
  }, [available, query]);

  const editTexture = (path: string) => void useEditor.getState().openTexture(path);

  if (!pack) return null;
  const usedSet = new Set(ids);

  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <Nav />
        <aside className="pv-list sc-list">
          <div className="pv-listhead">
            <span className="caps">Blocks</span>
            <span className="dim" style={{ fontSize: 11 }}>{available ? `${shownBlocks.length} of ${available.length}` : ""}</span>
          </div>
          <label className="searchbox pv-search">
            <Icon name="search" size={14} width={2} />
            <input placeholder="Search blocks…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search blocks" />
          </label>
          <div className="dim sc-listhint">Pick a block for the wall test and for painting the custom scene.</div>
          <div className="pv-rows" role="listbox" aria-label="Blocks">
            {shownBlocks.map((id) => (
              <button
                key={id} role="option" aria-selected={id === brushId}
                className={`pv-row ${id === brushId ? "on" : ""}`}
                onClick={() => setBrush(id)}
                title={usedSet.has(id) ? `${id} · in this scene` : id}
              >
                <span className="name mono ellipsis">{id}</span>
                {usedSet.has(id) && <span className="pv-dot done" aria-label="In this scene" />}
              </button>
            ))}
            {available && shownBlocks.length === 0 && <div className="dim" style={{ padding: 8, fontSize: 12 }}>No block matches “{query}”.</div>}
            {!available && <div className="dim" style={{ padding: 8, fontSize: 12 }}>Reading the blocks…</div>}
          </div>
        </aside>
        <main className="pv-main">
          <div className="pv-toolbar">
            <span className="pv-seg" role="group" aria-label="Scene">
              {PRESETS.map((p) => (
                <button key={p.id} className={p.id === preset ? "on" : ""} aria-pressed={p.id === preset} title={p.hint} onClick={() => choosePreset(p.id)}>{p.label}</button>
              ))}
            </span>
            <span className="pv-seg" role="group" aria-label="Time of day">
              {TIMES.map((t) => (
                <button key={t.v} className={t.v === time ? "on" : ""} aria-pressed={t.v === time} onClick={() => setTime(t.v)}>{t.label}</button>
              ))}
            </span>
            <label className="pv-tool sc-level" title="Block light (torches, lamps) 0–15, the same everywhere, with the game's brightness curve">
              Light
              <input type="range" min={0} max={15} step={1} value={level} aria-label="Block light level" onChange={(e) => setLevel(Number(e.target.value))} />
              <span className="mono sc-levelval">{levelLabel(level)}</span>
            </label>
            <button className="pv-btn" aria-pressed={ao} title="Ambient occlusion: corners next to blocks are darker (the game's smooth lighting)" onClick={() => setAo(!ao)}>
              AO {ao ? "on" : "off"}
            </button>
            <span className="pv-tool sc-cam">
              <button className="pv-btn" title="Back to the starting view (or double-click the scene)" onClick={() => setCamera((c) => ({ preset: "orbit", n: c.n + 1 }))}>Reset view</button>
              <button className="pv-btn" title="Look from the ground at eye height" onClick={() => setCamera((c) => ({ preset: "first", n: c.n + 1 }))}>First person</button>
            </span>
          </div>
          <div className="sc-stage">
            {grid && (
              <SceneView
                grid={grid} blocks={blocks} packDir={packDir} versionDir={versionDir} stamp={stamp}
                time={time} level={level} ao={ao} selected={selected} onPick={onPick} camera={camera} onStats={setStats}
              />
            )}
            <div className="sc-hint">Drag to turn · right-drag to move · wheel to zoom · click a block to select it</div>
            {unsavedUsed.length > 0 && (
              <div className="sc-live" title={unsavedUsed.map((t) => t.doc.path).join("\n")}>
                Showing {unsavedUsed.length} unsaved texture{unsavedUsed.length === 1 ? "" : "s"} from the editor
              </div>
            )}
          </div>
        </main>
        <aside className="pv-side sc-side">
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Selected block</h2>
              {selCell && <span className="mono dim" style={{ fontSize: 10 }}>x {selCell[0]} · y {selCell[1]} · z {selCell[2]}</span>}
            </div>
            {!selId ? (
              <div className="pv-text">Click a block in the scene to see its textures and edit them.</div>
            ) : (
              <>
                <div className="sc-selname mono">{selId}</div>
                {selBlock?.error && <div className="pv-shared">{selBlock.error}</div>}
                {selBlock && selBlock.models.length > 0 && (
                  <div className="pv-text mono" style={{ fontSize: 10 }}>{selBlock.models.map((m) => m.name).join(" + ")}</div>
                )}
                <div className="sc-texlist">
                  {textureList(selBlock).map((t) => {
                    const tab = live.find((x) => x.doc.path === t);
                    return (
                      <div key={t} className="sc-texrow">
                        <TexThumb path={t} versionDir={versionDir} stamp={stamp} />
                        <span className="mono ellipsis sc-texname" title={t}>{t}</span>
                        {tab && <span className={`sc-tag ${tab.doc.dirty ? "warn" : ""}`}>{tab.doc.dirty ? "unsaved" : "open"}</span>}
                        <button className="pv-btn" onClick={() => editTexture(t)}>Edit texture</button>
                      </div>
                    );
                  })}
                </div>
                <div className="pv-actions">
                  <button className="pv-btn" disabled={selId === brushId} onClick={() => { setBrush(selId); toast(`${selId} picked for the wall test and painting`); }}>Pick this block</button>
                </div>
              </>
            )}
          </section>
          {preset === "custom" && custom && (
            <CustomEditor
              grid={custom} layer={Math.min(layer, custom.height - 1)} setLayer={setLayer} brush={brushId}
              cache={cache} versionDir={versionDir} stamp={stamp} saved={saved}
              selected={selected} onChange={changeCustom} onSelect={setSelected}
            />
          )}
          <section className="pv-sec last">
            <div className="pv-sechead"><h2 className="caps">About this view</h2></div>
            <div className="pv-text">
              Blocks show their default state without the blockstate's rotations (stairs face east). Grass and leaves use
              the plains colours. Light follows the game's lightmap: full sky light everywhere, the block light the same on
              every face (no torches or shadows). Corners darken with ambient occlusion like the game's smooth lighting.
            </div>
            {problems.length > 0 && (
              <div className="pv-shared">
                Not drawn: {problems.map((b) => <span key={b.id} className="mono" title={b.error ?? ""}>{b.id} </span>)}
              </div>
            )}
          </section>
        </aside>
      </div>
      <StatusBar>
        {stats && (
          <span className="dim" style={{ fontSize: 11 }}>
            {stats.quads} faces drawn · {stats.culled} hidden by neighbours · {stats.batches} texture{stats.batches === 1 ? "" : "s"}
          </span>
        )}
      </StatusBar>
    </>
  );
}

interface CustomProps {
  grid: SceneGrid;
  layer: number;
  setLayer: (y: number) => void;
  brush: string;
  cache: Map<string, SceneBlock>;
  versionDir: string;
  stamp: number;
  saved: "saved" | "saving" | "idle";
  selected: number | null;
  onChange: (g: SceneGrid) => void;
  onSelect: (cell: number | null) => void;
}

/** The custom scene: its size, and one layer at a time painted with the picked block. */
function CustomEditor({ grid, layer, setLayer, brush, cache, versionDir, stamp, saved, selected, onChange, onSelect }: CustomProps) {
  const painting = useRef<"paint" | "erase" | null>(null);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  useEffect(() => {
    const up = () => { painting.current = null; };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);
  const apply = (x: number, z: number, mode: "paint" | "erase") => {
    const g = gridRef.current;
    const id = mode === "paint" ? brush : "";
    if (g.blocks[cellIndex(g, x, layer, z)] === id) return;
    const next = setBlock(g, x, layer, z, id);
    gridRef.current = next;
    onChange(next);
  };
  const resize = (w: number, d: number, h: number) => {
    onSelect(null);
    onChange(resizeGrid(grid, w, d, h));
  };
  const fill = (id: string) => {
    let g = grid;
    for (let z = 0; z < g.depth; z++) for (let x = 0; x < g.width; x++) g = setBlock(g, x, layer, z, id);
    onChange(g);
  };
  const rows = [];
  for (let z = 0; z < grid.depth; z++) {
    for (let x = 0; x < grid.width; x++) {
      const i = cellIndex(grid, x, layer, z);
      const id = grid.blocks[i];
      const tex = faceTexture(cache.get(id));
      rows.push(
        <button
          key={`${x},${z}`}
          className={`sc-cell ${id ? "" : "air"} ${selected === i ? "sel" : ""}`}
          title={`x ${x}, z ${z}: ${id || "air"}. Click to place ${brush}, right-click to clear.`}
          aria-label={`x ${x}, z ${z}: ${id || "air"}`}
          onPointerDown={(e) => {
            const mode = e.button === 2 || e.altKey ? "erase" : "paint";
            painting.current = mode;
            // painting does not change the selection: the panel above would move under the mouse
            apply(x, z, mode);
          }}
          onPointerEnter={() => { if (painting.current) apply(x, z, painting.current); }}
        >
          {id && (tex ? <TexThumb path={tex} versionDir={versionDir} stamp={stamp} size={22} /> : <span className="sc-initials">{id.slice(0, 2)}</span>)}
        </button>,
      );
    }
  }
  const size = (label: string, value: number, max: number, set: (v: number) => void) => (
    <label className="sc-size">
      {label}
      <input type="number" min={1} max={max} value={value} onChange={(e) => set(Number(e.target.value))} />
    </label>
  );
  return (
    <section className="pv-sec">
      <div className="pv-sechead">
        <h2 className="caps">Custom scene</h2>
        <span className="dim" style={{ fontSize: 10 }}>{saved === "saving" ? "Saving…" : saved === "saved" ? "Saved with the pack" : ".packcreator/scene.json"}</span>
      </div>
      <div className="sc-sizes">
        {size("Width", grid.width, MAX_WIDTH, (v) => resize(v, grid.depth, grid.height))}
        {size("Depth", grid.depth, MAX_DEPTH, (v) => resize(grid.width, v, grid.height))}
        {size("Height", grid.height, MAX_HEIGHT, (v) => resize(grid.width, grid.depth, v))}
      </div>
      <div className="pv-tool">
        <span className="dim" style={{ fontSize: 11 }}>Layer</span>
        <span className="pv-seg" role="group" aria-label="Layer">
          {Array.from({ length: grid.height }, (_, y) => (
            <button key={y} className={y === layer ? "on" : ""} aria-pressed={y === layer} onClick={() => setLayer(y)}>
              {y === 0 ? "Ground" : `y ${y}`}
            </button>
          ))}
        </span>
      </div>
      <div
        className="sc-grid" role="grid" aria-label={`Layer ${layer} of the custom scene`}
        style={{ gridTemplateColumns: `repeat(${grid.width}, 26px)` }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {rows}
      </div>
      <div className="pv-text">North is at the top. Click or drag to place <span className="mono">{brush}</span>; right-click or Alt-click clears.</div>
      <div className="pv-actions">
        <button className="pv-btn" onClick={() => fill(brush)}>Fill layer</button>
        <button className="pv-btn" onClick={() => fill("")}>Clear layer</button>
      </div>
    </section>
  );
}
