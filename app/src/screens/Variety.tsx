// The Variety section: random variants (the game picks one of several
// models per block, no mod needed) and connected textures (OptiFine's compact
// method, needs OptiFine or Continuity). Every file is written by Rust
// (core/src/variants.rs, core/src/ctm.rs); this screen shows and drives it.
import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, StatusBar, TopBar } from "../components/Shell";
import { useEditor } from "../editor/editorStore";
import { api, images, toError, type BlockEntry, type BlockModel, type CoreError, type CtmInfo, type VariantsInfo } from "../lib/api";
import { useApp } from "../store";
import { layout, PREVIEW } from "../variety/ctm";
import { pickPatch } from "../variety/pick";

const Nav = memo(NavBar);
const PatchPreview = lazy(() => import("../variety/PatchPreview").then((m) => ({ default: m.PatchPreview })));

type Tab = "variants" | "ctm";

// remembered for the rest of the session
const memory = { tab: "variants" as Tab, block: new Map<string, string>(), seed: 1 };

const FACES: { v: string; label: string }[] = [
  { v: "all", label: "All faces" },
  { v: "sides", label: "Sides only" },
  { v: "top bottom", label: "Top and bottom" },
];

const name = (path: string) => path.split("/").pop() ?? path;

/** Closes the editor tabs of these files (asking Save / Discard / Cancel). `false` = the user cancelled. */
async function closeTabs(paths: string[], packDir: string): Promise<boolean> {
  for (const t of useEditor.getState().tabs.filter((t) => t.packDir === packDir && paths.includes(t.doc.path))) {
    if (!(await useEditor.getState().closeTab(t.id))) return false;
  }
  return true;
}

/** A texture of the pack, else the game's. */
function Thumb({ tex, versionDir, stamp, size = 40, mine }: { tex: string; versionDir: string; stamp: number; size?: number; mine?: boolean }) {
  const [fallback, setFallback] = useState(false);
  useEffect(() => setFallback(false), [tex, stamp]);
  return (
    <img
      className={`pv-thumb${mine ? " mine" : ""}`} style={{ width: size, height: size }} alt=""
      src={fallback ? images.vanillaFull(versionDir, tex) : images.packFull(tex, stamp)}
      onError={() => setFallback(true)}
    />
  );
}

export function Variety() {
  const pack = useApp((s) => s.pack);
  const stamp = useApp((s) => s.stamp);
  const [tab, setTab] = useState<Tab>(memory.tab);
  const [blocks, setBlocks] = useState<BlockEntry[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const packDir = pack?.dir ?? "";
  const versionDir = pack?.project.version_dir ?? "";
  const key = `${packDir}|${tab}`;
  const [block, setBlock] = useState<string | null>(memory.block.get(key) ?? null);
  memory.tab = tab;

  useEffect(() => setBlock(memory.block.get(`${packDir}|${tab}`) ?? null), [packDir, tab]);

  useEffect(() => {
    if (!packDir) return;
    let gone = false;
    api.varietyBlocks(packDir).then(
      (b) => { if (!gone) { setBlocks(b); setListError(null); } },
      (e) => { if (!gone) setListError(toError(e).message); },
    );
    return () => { gone = true; };
  }, [packDir, stamp]);

  const pick = useCallback((b: string) => {
    memory.block.set(key, b);
    setBlock(b);
  }, [key]);

  const shown = useMemo(() => {
    if (!blocks) return [];
    const q = query.trim().toLowerCase();
    return q ? blocks.filter((b) => b.name.includes(q)) : blocks;
  }, [blocks, query]);

  if (!pack) return null;

  const top = (
    <TopBar
      crumbs={
        <>
          <span className="name ellipsis">{pack.project.name}</span>
          <span className="sep">/</span>
          <span className="leaf">Variety</span>
          {block && (
            <>
              <span className="sep">/</span>
              <span className="mono" style={{ fontSize: 12 }}>{block}</span>
            </>
          )}
        </>
      }
    />
  );

  return (
    <>
      {top}
      <div className="body">
        <Nav />
        <aside className="pv-list">
          <div className="pv-listhead">
            <span className="caps">Blocks</span>
            <span className="dim" style={{ fontSize: 11 }}>{blocks ? `${shown.length} of ${blocks.length}` : ""}</span>
          </div>
          <label className="searchbox pv-search">
            <Icon name="search" size={14} width={2} />
            <input type="text" aria-label="Search blocks" placeholder="Search blocks…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <div className="pv-rows" role="listbox" aria-label="Blocks">
            {shown.map((b) => {
              const parts = tab === "variants" && b.multipart;
              return (
                <button
                  key={b.name} role="option" aria-selected={b.name === block}
                  className={`pv-row ${b.name === block ? "on" : ""} ${parts ? "absent" : ""}`}
                  title={parts ? `${b.name} is built from parts ("multipart"): random variants cannot be added` : b.name}
                  onClick={() => pick(b.name)}
                >
                  <span className="name mono ellipsis">{b.name}</span>
                  {parts && <span className="n">parts</span>}
                  {tab === "variants" && b.has_variants && <span className="pv-dot done" aria-label="Has random variants" />}
                  {b.in_pack && <span className="n" title="Your pack has its own block state file">pack</span>}
                </button>
              );
            })}
            {blocks && shown.length === 0 && <div className="dim" style={{ padding: 8, fontSize: 12 }}>{blocks.length ? `No block matches “${query}”.` : "The game files have no block states. Extract them again from Settings."}</div>}
            {!blocks && !listError && <div className="dim" style={{ padding: 8, fontSize: 12 }}>Reading the blocks…</div>}
            {listError && <div className="pv-error">{listError}</div>}
          </div>
        </aside>
        {tab === "variants"
          ? <VariantsView key={`v|${packDir}|${block}`} block={block} packDir={packDir} versionDir={versionDir} stamp={stamp} tab={tab} setTab={setTab} />
          : <CtmView key={`c|${packDir}|${block}`} block={block} packDir={packDir} versionDir={versionDir} stamp={stamp} tab={tab} setTab={setTab} />}
      </div>
      <StatusBar right={<>→ {tab === "variants" ? `blockstates/${block ?? "<block>"}.json + models/block/ + textures/` : `optifine/ctm/${block ?? "<block>"}/`}</>}>
        <span>{tab === "variants" ? "Random variants: built into the game" : "Connected textures: need OptiFine or Continuity"}</span>
      </StatusBar>
    </>
  );
}

interface ViewProps {
  block: string | null;
  packDir: string;
  versionDir: string;
  stamp: number;
  tab: Tab;
  setTab: (t: Tab) => void;
}

function Tabs({ tab, setTab, children }: { tab: Tab; setTab: (t: Tab) => void; children?: React.ReactNode }) {
  return (
    <div className="pv-toolbar">
      <span className="pv-seg" role="tablist" aria-label="Kind of variety">
        <button role="tab" aria-selected={tab === "variants"} className={tab === "variants" ? "on" : ""} onClick={() => setTab("variants")}>Random variants</button>
        <button role="tab" aria-selected={tab === "ctm"} className={tab === "ctm" ? "on" : ""} onClick={() => setTab("ctm")}>Connected textures</button>
      </span>
      {children}
    </div>
  );
}

function Problem({ error }: { error: CoreError }) {
  return (
    <div className="pv-error" style={{ maxWidth: 520 }}>
      <Icon name="warn" size={16} width={2} color="var(--warn)" />
      <span>{error.message}{error.hint && <><br /><span className="dim">{error.hint}</span></>}</span>
    </div>
  );
}

// ------------------------------------------------------------ random variants

function VariantsView({ block, packDir, versionDir, stamp, tab, setTab }: ViewProps) {
  const { showError, setStatus, reload, toast } = useApp.getState();
  const [info, setInfo] = useState<VariantsInfo | null>(null);
  const [error, setError] = useState<CoreError | null>(null);
  const [texture, setTexture] = useState<string | null>(null);
  const [models, setModels] = useState<Record<string, BlockModel>>({});
  const [seed, setSeed] = useState(memory.seed);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!block) return;
    let gone = false;
    api.variantsInfo(block, packDir).then(
      (i) => { if (!gone) { setInfo(i); setError(null); } },
      (e) => { if (!gone) { setInfo(null); setError(toError(e)); } },
    );
    return () => { gone = true; };
  }, [block, packDir, stamp]);

  // the models the preview can pick from
  const names = useMemo(() => [...new Set(info?.preview.map((p) => p.model) ?? [])], [info]);
  useEffect(() => {
    let gone = false;
    void Promise.all(names.map((n) => api.blockModel(n, packDir).then((m) => [n, m] as const, () => null))).then((list) => {
      if (gone) return;
      const out: Record<string, BlockModel> = {};
      for (const x of list) if (x) out[x[0]] = x[1];
      setModels(out);
    });
    return () => { gone = true; };
  }, [names, packDir, stamp]);

  const weights = useMemo(() => info?.preview.map((p) => p.weight) ?? [], [info]);
  const picks = useMemo(() => pickPatch(weights, 9, seed), [weights, seed]);
  const chosen = info?.texture ?? texture ?? info?.textures[0] ?? null;

  const apply = async (what: string, run: () => Promise<VariantsInfo>) => {
    if (busy) return;
    setBusy(true);
    try {
      setInfo(await run());
      await reload(true);
      setStatus(what);
    } catch (e) {
      showError(e, `${block}: that did not work`);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    if (!block || !chosen || busy) return;
    setBusy(true);
    try {
      const a = await api.variantsAdd(block, chosen, packDir);
      setInfo(a.info);
      await reload(true);
      toast(`Added ${name(a.texture)}: a copy of ${name(chosen)} to draw on`);
      void useEditor.getState().openTexture(a.texture);
    } catch (e) {
      showError(e, `No variant was added to ${block}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: number, tex: string) => {
    if (!block || !(await closeTabs([tex], packDir))) return;
    await apply(`Removed ${name(tex)}: its texture and model are in .packcreator/trash`, () => api.variantsRemove(block, n, packDir));
  };

  const setChoice = (n: number, weight: number, rotate: boolean) => {
    if (!block) return;
    const w = Math.max(1, Math.min(100, Math.round(weight) || 1));
    void apply(`${n === 1 ? "Original" : `Variant ${n}`}: weight ${w}${rotate ? ", turned at random" : ""}`, () => api.variantsSet(block, n, w, rotate, packDir));
  };

  const shuffle = () => {
    memory.seed = seed + 1;
    setSeed(seed + 1);
  };

  const total = weights.reduce((a, b) => a + b, 0);

  return (
    <>
      <main className="pv-main">
        <Tabs tab={tab} setTab={setTab}>
          <span className="pv-tool dim">The game picks one at random for each block, by weight. No mod needed.</span>
          <button className="pv-btn" style={{ marginLeft: "auto" }} disabled={!info || info.variants.length === 0} onClick={shuffle} title="Pick again at random">Shuffle</button>
        </Tabs>
        <div className="pv-stage">
          {!block && <div className="dim">Pick a block on the left, such as stone, dirt or a plank.</div>}
          {error && <Problem error={error} />}
          {info && (
            <div className="vy-stage">
              <Suspense fallback={<div style={{ height: 420 }} aria-busy="true" />}>
                <PatchPreview entries={info.preview} picks={picks} models={models} versionDir={versionDir} stamp={stamp} height={420} />
              </Suspense>
              <div className="vy-caption">
                {info.variants.length === 0
                  ? `${block} as it is now: one look for every block. Add a variant to see the mix.`
                  : `3×3 patch of ${block}, state “${info.preview_key || "(any)"}”: ${info.preview.length} possible look${info.preview.length === 1 ? "" : "s"}, picked at random. Shuffle for another pick.`}
              </div>
            </div>
          )}
        </div>
      </main>

      <aside className="pv-side">
        {info && (
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Texture to vary</h2>
              <span className="dim" style={{ fontSize: 11 }}>{info.legacy ? "before 1.13: old names" : `${info.keys.length} state${info.keys.length === 1 ? "" : "s"}`}</span>
            </div>
            {info.texture ? (
              <div className="pv-text">Variants of <span className="mono">{info.texture}</span>. Remove them all to vary another texture of this block.</div>
            ) : (
              <select className="ed-select" aria-label="Texture to vary" value={chosen ?? ""} onChange={(e) => setTexture(e.target.value)}>
                {info.textures.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            <div className="pv-actions">
              <button className="pv-btn primary" disabled={!chosen || busy} onClick={() => void add()} title="Copies the texture to a new file next to it, opens it in the editor, and writes the model and block state">
                {busy ? "Working…" : "Add a variant"}
              </button>
            </div>
          </section>
        )}

        {info && chosen && (
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Looks · {info.variants.length + 1}</h2>
              <span className="dim" style={{ fontSize: 11 }}>weight 1–100</span>
            </div>
            <VariantRow
              label="Original" tex={chosen} versionDir={versionDir} stamp={stamp} weight={info.original.weight} rotate={info.original.rotate}
              share={info.variants.length ? shareOf(info, 1, total) : null} disabled={busy || info.variants.length === 0}
              onSet={(w, r) => setChoice(1, w, r)}
            />
            {info.variants.map((v) => (
              <VariantRow
                key={v.n} label={name(v.texture)} tex={v.texture} versionDir={versionDir} stamp={stamp} weight={v.weight} rotate={v.rotate}
                share={shareOf(info, v.n, total)} disabled={busy} mine
                onSet={(w, r) => setChoice(v.n, w, r)}
                onEdit={() => void useEditor.getState().openTexture(v.texture)}
                onRemove={() => void remove(v.n, v.texture)}
              />
            ))}
            <div className={info.has_rotations ? "pv-shared" : "pv-text"}>
              {info.has_rotations && <Icon name="warn" size={14} width={2} color="var(--warn)" />}
              <span>
                “Turn at random” adds the look turned 0°, 90°, 180° and 270°. Good for blocks that look the same from every side (stone, dirt, sand);
                {info.has_rotations ? " this block already turns its model for some states (logs, furnaces…), so random turns may point it the wrong way." : " not for blocks that face a direction."}
              </span>
            </div>
          </section>
        )}

        {info && (
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Block state file</h2>
              <span className="mono dim" style={{ fontSize: 10 }}>blockstates/{info.block}.json{info.blockstate ? " · your pack" : " · the game's"}</span>
            </div>
            {info.blockstate
              ? <pre className="pv-json">{info.blockstate}</pre>
              : <div className="pv-note">The pack has no block state for {info.block}; the game's is used. Adding a variant writes one, made from {info.base_from_pack ? "the pack's file" : "the game's file"}.</div>}
            {info.models.length > 0 && <div className="pv-text">Models with the texture: <span className="mono">{info.models.join(", ")}</span>. Each variant gets a copy named <span className="mono">…_2</span>, <span className="mono">…_3</span>.</div>}
          </section>
        )}
      </aside>
    </>
  );
}

function shareOf(info: VariantsInfo, n: number, total: number): number | null {
  if (total <= 0) return null;
  // the entries of variant n use the models <model>_n; the original's are the rest
  const lookOf = (m: string) => info.variants.find((v) => info.models.some((o) => m === `${o}_${v.n}`))?.n ?? 1;
  const sum = info.preview.filter((p) => lookOf(p.model) === n).reduce((a, p) => a + p.weight, 0);
  return Math.round((sum / total) * 100);
}

function VariantRow({ label, tex, versionDir, stamp, weight, rotate, share, disabled, mine, onSet, onEdit, onRemove }: {
  label: string; tex: string; versionDir: string; stamp: number; weight: number; rotate: boolean; share: number | null; disabled: boolean; mine?: boolean;
  onSet: (weight: number, rotate: boolean) => void; onEdit?: () => void; onRemove?: () => void;
}) {
  const [w, setW] = useState(String(weight));
  useEffect(() => setW(String(weight)), [weight]);
  const commit = () => {
    const n = Number(w);
    if (Number.isFinite(n) && Math.round(n) !== weight) onSet(n, rotate);
    else setW(String(weight));
  };
  return (
    <div className="vy-row">
      <button className="pv-frame" onClick={onEdit} disabled={!onEdit} title={onEdit ? `Draw ${label} in the editor` : undefined}>
        <Thumb tex={tex} versionDir={versionDir} stamp={stamp} size={36} mine={mine} />
      </button>
      <div className="vy-rowmain">
        <div className="vy-rowhead">
          <span className="mono ellipsis" style={{ fontSize: 11 }}>{label}</span>
          {share !== null && <span className="dim" style={{ fontSize: 10 }}>{share}%</span>}
        </div>
        <div className="vy-rowopts">
          <label className="vy-weight" title="How often this look is picked, compared with the others">
            Weight
            <input
              type="number" min={1} max={100} value={w} disabled={disabled} aria-label={`Weight of ${label}`}
              onChange={(e) => setW(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }}
            />
          </label>
          <label className="vy-check" title="Also use this look turned 0/90/180/270 degrees">
            <input type="checkbox" checked={rotate} disabled={disabled} onChange={(e) => onSet(weight, e.target.checked)} />
            Turn at random
          </label>
        </div>
      </div>
      {onRemove && (
        <button className="vy-icon" title={`Remove ${label} (its files go to the trash)`} aria-label={`Remove ${label}`} disabled={disabled} onClick={onRemove}>
          <Icon name="trash" size={14} />
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------ connected textures

function CtmView({ block, packDir, versionDir, stamp, tab, setTab }: ViewProps) {
  const { showError, setStatus, reload, ask } = useApp.getState();
  const [info, setInfo] = useState<CtmInfo | null>(null);
  const [error, setError] = useState<CoreError | null>(null);
  const [texture, setTexture] = useState<string | null>(null);
  const [faces, setFaces] = useState("all");
  const [match, setMatch] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!block) return;
    let gone = false;
    api.ctmInfo(block, packDir).then(
      (i) => { if (!gone) { setInfo(i); setError(null); } },
      (e) => { if (!gone) { setInfo(null); setError(toError(e)); } },
    );
    return () => { gone = true; };
  }, [block, packDir, stamp]);

  const made = info?.tiles.every((t) => t.exists) ?? false;
  const chosen = texture ?? info?.textures[0] ?? null;
  const matchBlocks = match ?? info?.default_match ?? "";

  const run = async (what: string, call: () => Promise<CtmInfo>) => {
    if (busy) return;
    setBusy(true);
    try {
      setInfo(await call());
      await reload(true);
      setStatus(what);
    } catch (e) {
      showError(e, `Connected textures for ${block}: that did not work`);
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!block || !chosen || !info) return;
    const doIt = async () => {
      if (!(await closeTabs(info.tiles.map((t) => t.path), packDir))) return;
      await run(`Made 5 starting tiles from ${name(chosen)} and ${block}.properties. Click a tile to draw it.`,
        () => api.ctmCreate(block, chosen, faces, matchBlocks, packDir));
    };
    if (made || info.properties) {
      ask({
        title: `Make the tiles of ${block} again?`,
        text: `The five tiles and ${block}.properties are written again from ${chosen}.`,
        hint: "Your current tiles are not lost: they go to the pack's .packcreator/trash folder.",
        buttons: [
          { label: "Cancel" },
          { label: "Make again", primary: true, run: () => void doIt() },
        ],
      });
    } else await doIt();
  };

  const remove = async () => {
    if (!block || !info || !(await closeTabs(info.tiles.map((t) => t.path), packDir))) return;
    await run(`Removed the connected textures of ${block}: the files are in .packcreator/trash`, () => api.ctmRemove(block, packDir));
  };

  return (
    <>
      <main className="pv-main">
        <Tabs tab={tab} setTab={setTab} />
        <div className="pv-stage">
          <div className="vy-mod">
            <Icon name="warn" size={18} width={2} color="var(--warn)" />
            <span><b>Needs the OptiFine or Continuity mod.</b> Plain Minecraft ignores connected textures; players without one of these mods see the normal block.</span>
          </div>
          {!block && <div className="dim">Pick a block on the left. Glass, bookshelves and planks work well.</div>}
          {error && <Problem error={error} />}
          {info && chosen && <WallPreview info={info} texture={chosen} versionDir={versionDir} stamp={stamp} />}
        </div>
      </main>

      <aside className="pv-side">
        {info && (
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Compact method · 5 tiles</h2>
              <span className="dim" style={{ fontSize: 11 }}>{info.legacy ? "before 1.13: old block ids" : "method=ctm_compact"}</span>
            </div>
            <label className="vy-field">
              <span>Start from</span>
              <select className="ed-select" aria-label="Texture to start from" value={chosen ?? ""} onChange={(e) => setTexture(e.target.value)}>
                {info.textures.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label className="vy-field">
              <span>Faces</span>
              <select className="ed-select" aria-label="Faces" value={faces} onChange={(e) => setFaces(e.target.value)}>
                {FACES.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
              </select>
            </label>
            <label className="vy-field">
              <span>Blocks</span>
              <input className="vy-input mono" aria-label="matchBlocks" value={matchBlocks} onChange={(e) => setMatch(e.target.value)} title="matchBlocks: the block ids that use these tiles, separated by spaces" />
            </label>
            <div className="pv-text">Tile 0 is the texture as it is. The others are made by removing border sides from it: a starting point to draw on.</div>
            <div className="pv-actions">
              <button className="pv-btn primary" disabled={!chosen || busy} onClick={() => void create()}>{made ? "Make the tiles again" : "Make the 5 tiles"}</button>
              {(made || info.properties) && <button className="pv-btn" disabled={busy} onClick={() => void remove()}>Remove</button>}
            </div>
          </section>
        )}

        {info && (
          <section className="pv-sec">
            <div className="pv-sechead">
              <h2 className="caps">Tiles</h2>
              <span className="mono dim" style={{ fontSize: 10 }}>optifine/ctm/{info.block}/</span>
            </div>
            <div className="vy-tiles">
              {info.tiles.map((t, i) => (
                <button key={t.path} className="pv-frame" disabled={!t.exists} title={t.exists ? `Draw tile ${i} in the editor` : "Not made yet"} onClick={() => void useEditor.getState().openTexture(t.path)}>
                  {t.exists
                    ? <img className="pv-thumb mine" alt="" src={images.packOptifine(t.path, stamp)} />
                    : <span className="pv-thumb" />}
                  <span className="pv-thumbname">{i} · {TILE_NAMES[i]}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {info && (
          <section className="pv-sec last">
            <div className="pv-sechead">
              <h2 className="caps">Properties file</h2>
              <span className="mono dim" style={{ fontSize: 10 }}>{info.block}.properties</span>
            </div>
            {info.properties ? <pre className="pv-json">{info.properties}</pre> : <div className="pv-note">Not made yet.</div>}
          </section>
        )}
      </aside>
    </>
  );
}

const TILE_NAMES = ["alone", "all sides", "up · down", "left · right", "corners"];

const CELL = 64;

/** The 4×4 wall and the L shape, each quarter from its tile (or the plain texture before the tiles exist). */
function WallPreview({ info, texture, versionDir, stamp }: { info: CtmInfo; texture: string; versionDir: string; stamp: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const made = info.tiles.every((t) => t.exists);
  useEffect(() => {
    let gone = false;
    const load = (urls: string[]) => new Promise<HTMLImageElement | null>((ok) => {
      const next = (i: number) => {
        if (i >= urls.length) return ok(null);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => ok(img);
        img.onerror = () => next(i + 1);
        img.src = urls[i];
      };
      next(0);
    });
    const plain = [images.packFull(texture, stamp), images.vanillaFull(versionDir, texture)];
    const sources = made ? info.tiles.map((t) => [images.packOptifine(t.path, stamp)]) : [plain];
    void Promise.all(sources.map(load)).then((imgs) => {
      const c = canvas.current;
      if (gone || !c) return;
      const g = c.getContext("2d");
      if (!g) return;
      g.clearRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = false;
      for (const p of layout(PREVIEW)) {
        const img = imgs[made ? p.tile : 0];
        if (!img) continue;
        const w = img.naturalWidth;
        const h = img.naturalHeight > w ? w : img.naturalHeight;
        const qx = p.quarter % 2;
        const qy = Math.floor(p.quarter / 2);
        // with the plain texture every quarter is just that quarter of the texture
        g.drawImage(img, (qx * w) / 2, (qy * h) / 2, w / 2, h / 2, p.col * CELL + (qx * CELL) / 2, p.row * CELL + (qy * CELL) / 2, CELL / 2, CELL / 2);
      }
    });
    return () => { gone = true; };
  }, [info, texture, versionDir, stamp, made]);
  return (
    <div className="vy-stage">
      <canvas ref={canvas} className="vy-wall" width={PREVIEW[0].length * CELL} height={PREVIEW.length * CELL} aria-label={`Preview: a wall of ${info.block} and an L shape`} />
      <div className="vy-caption">
        {made
          ? "A 4×4 wall and an L shape, each block made of four quarters from the tiles, the way OptiFine's compact method joins them."
          : "Without tiles: every block shows the plain texture. Make the 5 tiles to see the blocks join."}
      </div>
    </div>
  );
}
