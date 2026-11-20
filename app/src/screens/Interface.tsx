// Screen 6: the interface (GUI) editor. The in-game screens assembled from
// the real pieces (the pack's image, else the game's) with each piece's
// stretch rule, a piece's stretch rule (stretch / tile / nine-slice) with the
// exact .mcmeta it writes, and the way into the pixel editor. Before 1.20.2
// the pieces are rectangles of shared images: the image is shown with the
// piece's rectangle, and drawing edits only that rectangle.
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { Icon } from "../components/Icon";
import { NavBar, StatusBar, TopBar } from "../components/Shell";
import { useEditor } from "../editor/editorStore";
import { newBuf, type Buf } from "../editor/pixels";
import {
  itemQuads, logicalSize, placeItems, ruleOf, SCALING_HELP, switchRule, withBorder, type Side,
} from "../gui/layout";
import {
  alphaAt, blitQuads, demoWidths, hitTest, imageScale, rectAt, renderSprite, sameScaling, scalingLabel, type Placed,
} from "../gui/slice";
import { api, images, type GuiOverview, type GuiPiece, type GuiScreen, type Scaling } from "../lib/api";
import { useApp } from "../store";

const Nav = memo(NavBar);

type Background = "world" | "dark" | "light";
const BACKGROUNDS: { v: Background; label: string }[] = [
  { v: "world", label: "In-game world" },
  { v: "dark", label: "Dark" },
  { v: "light", label: "Light" },
];

// remembered for the rest of the session
const memory = {
  screen: new Map<string, string>(),
  piece: new Map<string, string>(),
  scale: 2,
  background: "world" as Background,
  outlines: true,
  hover: true,
};

const SIDES: { key: Side; label: string }[] = [
  { key: "left", label: "Left" },
  { key: "top", label: "Top" },
  { key: "right", label: "Right" },
  { key: "bottom", label: "Bottom" },
];

const fileOf = (path: string) => `${path.split("/").pop()}.png`;

// ------------------------------------------------------------- images

const bufCache = new Map<string, Promise<Buf | null>>();

/** An image file as RGBA pixels (cached by URL; the URL changes when the file does). */
function loadBuf(url: string): Promise<Buf | null> {
  let p = bufCache.get(url);
  if (!p) {
    p = new Promise((ok) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx || c.width === 0 || c.height === 0) return ok(null);
        ctx.drawImage(img, 0, 0);
        try {
          const d = ctx.getImageData(0, 0, c.width, c.height);
          ok({ w: c.width, h: c.height, data: d.data });
        } catch {
          ok(null);
        }
      };
      img.onerror = () => ok(null);
      img.src = url;
    });
    bufCache.set(url, p);
    if (bufCache.size > 400) bufCache.delete(bufCache.keys().next().value as string);
  }
  return p;
}

/** Where a piece's image is read from: the pack's file when it has one, else the game's. */
function pieceUrl(p: GuiPiece, versionDir: string, stamp: number): string | null {
  if (p.in_pack) return images.packFull(p.path, stamp);
  if (p.in_version) return images.vanillaFull(versionDir, p.path);
  return null;
}

/** The images of a list of pieces, by texture path. */
function useBufs(pieces: GuiPiece[], versionDir: string, stamp: number): Map<string, Buf> {
  const [bufs, setBufs] = useState<Map<string, Buf>>(new Map());
  const key = pieces.map((p) => `${p.path}:${p.in_pack}:${p.in_version}`).join("|");
  useEffect(() => {
    let gone = false;
    const wanted = new Map<string, string>();
    for (const p of pieces) {
      const url = pieceUrl(p, versionDir, stamp);
      if (url) wanted.set(p.path, url);
    }
    void Promise.all([...wanted].map(async ([path, url]) => [path, await loadBuf(url)] as const)).then((list) => {
      if (gone) return;
      const m = new Map<string, Buf>();
      for (const [path, b] of list) if (b) m.set(path, b);
      setBufs(m);
    });
    return () => {
      gone = true;
    };
    // the key stands for the pieces
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, versionDir, stamp]);
  return bufs;
}

/** A canvas showing a pixel buffer at `zoom` CSS pixels per pixel. */
const BufCanvas = memo(function BufCanvas({ buf, zoom = 1, className, style }: { buf: Buf | null; zoom?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !buf || buf.w === 0 || buf.h === 0) return;
    c.width = buf.w;
    c.height = buf.h;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), 0, 0);
  }, [buf]);
  if (!buf || buf.w === 0 || buf.h === 0) return <span className={className} style={style} />;
  return <canvas ref={ref} className={className} style={{ width: buf.w * zoom, height: buf.h * zoom, imageRendering: "pixelated", ...style }} />;
});

/** A part of an image, for swatches and the legacy panel. */
function cropBuf(b: Buf, x: number, y: number, w: number, h: number): Buf {
  const out = newBuf(Math.max(0, w), Math.max(0, h));
  for (let r = 0; r < h; r++) {
    const sy = y + r;
    if (sy < 0 || sy >= b.h) continue;
    for (let c = 0; c < w; c++) {
      const sx = x + c;
      if (sx < 0 || sx >= b.w) continue;
      const s = (sy * b.w + sx) * 4;
      out.data.set(b.data.subarray(s, s + 4), (r * w + c) * 4);
    }
  }
  return out;
}

// ------------------------------------------------------------- assembled preview

interface PreviewProps {
  screen: GuiScreen;
  bufs: Map<string, Buf>;
  k: number;
  drafts: ReadonlyMap<string, Scaling>;
  hover: boolean;
  outlines: boolean;
  selected: string | null;
  onPick: (id: string) => void;
  onDraw: (id: string) => void;
}

function drawText(ctx: CanvasRenderingContext2D, item: GuiScreen["layout"][number], k: number, box: Placed | null) {
  if (!item.text) return;
  ctx.font = `${Math.round(7 * k)}px "JetBrains Mono", monospace`;
  ctx.textBaseline = "middle";
  const align = item.align ?? "center";
  ctx.textAlign = align;
  let x = item.x * k;
  let y = (item.y + 4) * k;
  if (box) {
    y = (box.y + box.h / 2) * k;
    x = align === "left" ? (box.x + 4) * k : align === "right" ? (box.x + box.w - 4) * k : (box.x + box.w / 2) * k;
  }
  const color = item.color ?? "#ffffff";
  if (item.outline) {
    ctx.fillStyle = "#000000";
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.fillText(item.text, x + dx * k, y + dy * k);
  } else if (item.shadow !== false) {
    // the game's shadow: the colour at a quarter brightness, one pixel down-right
    const n = parseInt(color.slice(1), 16);
    const q = (s: number) => ((n >> s) & 255) >> 2;
    ctx.fillStyle = `rgb(${q(16)}, ${q(8)}, ${q(0)})`;
    ctx.fillText(item.text, x + k, y + k);
  }
  ctx.fillStyle = color;
  ctx.fillText(item.text, x, y);
}

const ScreenPreview = memo(function ScreenPreview({ screen, bufs, k, drafts, hover, outlines, selected, onPick, onDraw }: PreviewProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [over, setOver] = useState<Placed | null>(null);
  const byId = useMemo(() => new Map(screen.pieces.map((p) => [p.id, p])), [screen]);
  const placed = useMemo(() => placeItems(screen, hover), [screen, hover]);
  const W = screen.size[0];
  const H = screen.size[1];

  const quadsOf = useCallback((p: Placed) => {
    const piece = byId.get(p.piece)!;
    const item = screen.layout[p.index];
    const rule = ruleOf(piece, drafts);
    return { piece, item, rule, quads: itemQuads(item, piece, rule, p.w, p.h), logical: logicalSize(piece, item, rule) };
  }, [byId, screen, drafts]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = W * k;
    c.height = H * k;
    const ctx = c.getContext("2d")!;
    const out = newBuf(W * k, H * k);
    for (const p of placed) {
      const { piece, quads, logical } = quadsOf(p);
      const b = bufs.get(piece.path);
      if (b) blitQuads(out, b, logical, quads, p.x, p.y, k);
    }
    ctx.putImageData(new ImageData(out.data, out.w, out.h), 0, 0);
    // text: inside its piece when it has one
    const boxes = new Map(placed.map((p) => [p.index, p]));
    screen.layout.forEach((item, i) => drawText(ctx, item, k, boxes.get(i) ?? null));
    // outlines
    ctx.save();
    if (outlines) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      for (const p of placed) ctx.strokeRect(p.x * k + 0.5, p.y * k + 0.5, p.w * k - 1, p.h * k - 1);
    }
    if (over) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.strokeRect(over.x * k + 0.5, over.y * k + 0.5, over.w * k - 1, over.h * k - 1);
    }
    ctx.strokeStyle = "#5b8cff";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    for (const p of placed) {
      if (p.piece !== selected) continue;
      const o = Math.min(4, k * 2);
      ctx.strokeRect(p.x * k - o + 1, p.y * k - o + 1, p.w * k + 2 * o - 2, p.h * k + 2 * o - 2);
    }
    ctx.restore();
  }, [placed, quadsOf, bufs, k, W, H, outlines, over, selected, screen.layout]);

  const at = (e: MouseEvent<HTMLCanvasElement>): Placed | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const gx = Math.floor((e.clientX - r.left) / k);
    const gy = Math.floor((e.clientY - r.top) / k);
    return hitTest(placed, gx, gy, (p, lx, ly) => {
      const { piece, quads, logical } = quadsOf(p);
      const b = bufs.get(piece.path);
      return !!b && alphaAt(b, logical, quads, lx, ly) > 0;
    });
  };

  return (
    <canvas
      ref={ref}
      className="gi-canvas"
      style={{ width: W * k, height: H * k, cursor: over ? "pointer" : "default" }}
      title={over ? `${byId.get(over.piece)?.name ?? over.piece} · double-click to draw it` : undefined}
      onMouseMove={(e) => {
        const p = at(e);
        if (p?.index !== over?.index) setOver(p);
      }}
      onMouseLeave={() => setOver(null)}
      onClick={(e) => {
        const p = at(e);
        if (p) onPick(p.piece);
      }}
      onDoubleClick={(e) => {
        const p = at(e);
        if (p) onDraw(p.piece);
      }}
    />
  );
});

// ------------------------------------------------------------- shared image (before 1.20.2)

interface SharedProps {
  screen: GuiScreen;
  buf: Buf | null;
  zoom: number;
  outlines: boolean;
  selected: GuiPiece | null;
  onPick: (id: string) => void;
  onDraw: (id: string) => void;
}

const SharedPreview = memo(function SharedPreview({ screen, buf, zoom, outlines, selected, onPick, onDraw }: SharedProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [gw, gh] = screen.size;
  // the pack's image may be a whole multiple of the game's
  const s = buf ? imageScale([buf.w, buf.h], [gw, gh]) ?? buf.w / gw : 1;
  const k = zoom / s;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = gw * zoom;
    c.height = gh * zoom;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, c.width, c.height);
    if (buf) {
      const tmp = document.createElement("canvas");
      tmp.width = buf.w;
      tmp.height = buf.h;
      tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.w, buf.h), 0, 0);
      ctx.drawImage(tmp, 0, 0, buf.w * k, buf.h * k);
    }
    const rects = screen.pieces.filter((p) => p.rect && p.in_version);
    if (selected?.rect) {
      // everything but the piece is dimmed
      const [x, y, w, h] = selected.rect.map((v) => v * zoom);
      ctx.fillStyle = "rgba(13, 14, 16, 0.55)";
      ctx.beginPath();
      ctx.rect(0, 0, c.width, c.height);
      ctx.rect(x, y, w, h);
      ctx.fill("evenodd");
    }
    if (outlines) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
      ctx.lineWidth = 1;
      for (const p of rects) {
        const [x, y, w, h] = p.rect!.map((v) => v * zoom);
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }
    if (selected?.rect) {
      const [x, y, w, h] = selected.rect.map((v) => v * zoom);
      ctx.strokeStyle = "#5b8cff";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    }
  }, [buf, gw, gh, zoom, k, outlines, selected, screen.pieces]);

  const at = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return rectAt(screen.pieces.filter((p) => p.in_version), Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom));
  };
  return (
    <canvas
      ref={ref}
      className="gi-canvas gi-sheet"
      style={{ width: gw * zoom, height: gh * zoom }}
      onClick={(e) => {
        const p = at(e);
        if (p) onPick(p.id);
      }}
      onDoubleClick={(e) => {
        const p = at(e);
        if (p) onDraw(p.id);
      }}
    />
  );
});

// ------------------------------------------------------------- right panel parts

/** The piece at its own size, bigger, with the nine-slice lines. */
function BigPreview({ piece, buf, rule, logical }: { piece: GuiPiece; buf: Buf | null; rule: Scaling; logical: [number, number] }) {
  const [lw, lh] = logical;
  // small sprites are enlarged by whole steps, big images (the logo, containers) shrunk to fit
  const fit = Math.min(296 / lw, (piece.scalable ? 48 : 120) / lh);
  const z = fit >= 1 ? Math.min(8, Math.floor(fit)) : fit;
  const k = Math.max(1, Math.floor(z));
  const shown = useMemo(() => (buf ? renderSprite(buf, logical, { type: "stretch" }, lw, lh, k) : null), [buf, logical, lw, lh, k]);
  const b = rule.type === "nine_slice" ? rule.border : null;
  return (
    <div className="gi-big">
      <div style={{ position: "relative", width: lw * z, height: lh * z }}>
        {shown ? <BufCanvas buf={shown} zoom={z / k} /> : <span className="dim" style={{ fontSize: 11 }}>No image</span>}
        {b && (
          <>
            <div className="gi-guide v" style={{ left: b.left * z }} />
            <div className="gi-guide v" style={{ left: (lw - b.right) * z }} />
            <div className="gi-guide h" style={{ top: b.top * z }} />
            <div className="gi-guide h" style={{ top: (lh - b.bottom) * z }} />
          </>
        )}
      </div>
      {!piece.in_version && !piece.in_pack && <span className="gi-bignote">Not in this version</span>}
    </div>
  );
}

/** The piece drawn at three widths with the rule being edited. */
function StretchDemo({ buf, rule, logical }: { buf: Buf | null; rule: Scaling; logical: [number, number] }) {
  const { widths, k } = demoWidths(logical);
  const rows = useMemo(() => (buf ? widths.map((w) => renderSprite(buf, logical, rule, w, logical[1], k)) : []), [buf, logical, rule, widths.join(","), k]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="gi-demo">
      <span className="gi-demolabel">Preview at 3 widths</span>
      {rows.map((r, i) => <BufCanvas key={i} buf={r} />)}
    </div>
  );
}

// ------------------------------------------------------------- the screen

export function Interface() {
  const pack = useApp((s) => s.pack);
  const stamp = useApp((s) => s.stamp);
  const setStatus = useApp((s) => s.setStatus);
  const showError = useApp((s) => s.showError);
  const toast = useApp((s) => s.toast);
  const tabs = useEditor((s) => s.tabs);
  const packDir = pack?.dir ?? "";
  const versionDir = pack?.project.version_dir ?? "";
  const versionLabel = pack?.version?.label ?? pack?.project.version_id ?? versionDir;

  const [overview, setOverview] = useState<GuiOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screenId, setScreenId] = useState<string | null>(() => memory.screen.get(packDir) ?? null);
  const [pieceIds, setPieceIds] = useState<Map<string, string>>(() => new Map(memory.piece));
  const [scale, setScale] = useState(memory.scale);
  const [background, setBackground] = useState<Background>(memory.background);
  const [outlines, setOutlines] = useState(memory.outlines);
  const [hover, setHover] = useState(memory.hover);
  const [drafts, setDrafts] = useState<Map<string, Scaling>>(new Map());
  const [fields, setFields] = useState<Record<Side, string> | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{ text: string | null; error: string | null; path: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!packDir) return;
    try {
      const o = await api.guiOverview(packDir);
      setOverview(o);
      setError(null);
    } catch (e) {
      setError(String((e as { message?: string }).message ?? e));
    }
  }, [packDir]);
  useEffect(() => {
    void refresh();
  }, [refresh, stamp]);

  const screen = overview?.screens.find((s) => s.id === screenId) ?? overview?.screens[0] ?? null;
  const pieceId = screen ? pieceIds.get(`${packDir}:${screen.id}`) : undefined;
  const piece = screen ? screen.pieces.find((p) => p.id === pieceId) ?? screen.pieces.find((p) => p.in_version || p.in_pack) ?? screen.pieces[0] ?? null : null;
  const shared = overview?.layout === "shared";

  const pickScreen = (id: string) => {
    setScreenId(id);
    memory.screen.set(packDir, id);
  };
  const pick = useCallback((id: string) => {
    if (!screen) return;
    setPieceIds((m) => {
      const next = new Map(m);
      next.set(`${packDir}:${screen.id}`, id);
      memory.piece.set(`${packDir}:${screen.id}`, id);
      return next;
    });
  }, [packDir, screen]);

  const bufs = useBufs(screen?.pieces ?? [], versionDir, stamp);
  const sharedBuf = shared && screen?.pieces[0] ? bufs.get(screen.pieces[0].path) ?? null : null;

  // the rule shown for the selected piece: a draft while borders are typed, else the one on disk
  const saved = piece?.scaling?.scaling ?? { type: "stretch" as const };
  const rule = piece ? ruleOf(piece, drafts) : saved;
  const logical = piece ? logicalSize(piece, null, rule) : ([1, 1] as [number, number]);

  // border fields follow the selected piece's saved rule
  const savedKey = piece ? `${piece.path}:${JSON.stringify(saved)}` : "";
  useEffect(() => {
    setFields(saved.type === "nine_slice"
      ? { left: String(saved.border.left), top: String(saved.border.top), right: String(saved.border.right), bottom: String(saved.border.bottom) }
      : null);
    setFieldError(null);
    // savedKey stands for the saved rule
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  // the generated file, from Rust, for the rule shown
  const ruleKey = JSON.stringify(rule);
  useEffect(() => {
    if (!piece?.scalable || shared) {
      setMeta(null);
      return;
    }
    let gone = false;
    const t = setTimeout(() => {
      api.guiScalingPreview(piece.path, rule, packDir)
        .then((text) => { if (!gone) setMeta({ text, error: null, path: piece.path }); })
        .catch((e) => { if (!gone) setMeta({ text: null, error: String((e as { message?: string }).message ?? e), path: piece.path }); });
    }, 120);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // ruleKey stands for the rule
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [piece?.path, piece?.scalable, ruleKey, packDir, shared, stamp, overview]);

  if (!pack) return null;

  const dropDraft = (path: string) => setDrafts((m) => {
    if (!m.has(path)) return m;
    const next = new Map(m);
    next.delete(path);
    return next;
  });

  /** Writes a rule into the pack now, with Undo in the toast. */
  const apply = async (next: Scaling) => {
    if (!piece || busy) return;
    const path = piece.path;
    const file = `${fileOf(path)}.mcmeta`;
    setBusy(true);
    try {
      const change = await api.guiSetScaling(path, next, packDir);
      dropDraft(path);
      await refresh();
      if (change.before === change.after) {
        setStatus(`${piece.name}: ${scalingLabel(next)} (nothing to change)`);
        return;
      }
      const what = change.after === null ? `${file} removed` : change.before === null ? `${file} written` : `${file} updated`;
      toast(`${piece.name}: ${scalingLabel(next)} · ${what}`, "ok", {
        label: "Undo",
        run: () => {
          void api.guiRestoreMcmeta(path, change.before, packDir)
            .then(() => refresh())
            .then(() => setStatus(`Undone: ${file} is back as it was`))
            .catch((e) => showError(e, `${file} could not be put back`));
        },
      });
    } catch (e) {
      dropDraft(path);
      showError(e, `The stretch rule of ${piece.name} could not be saved`);
    } finally {
      setBusy(false);
    }
  };

  const setType = (type: Scaling["type"]) => {
    if (!piece?.scaling || rule.type === type) return;
    void apply(switchRule(type, saved, piece.scaling.vanilla, logicalSize(piece, null, piece.scaling.vanilla)));
  };

  const typeBorder = (side: Side, text: string) => {
    if (!piece || !fields || rule.type !== "nine_slice") return;
    const f = { ...fields, [side]: text };
    setFields(f);
    // the other fields as typed, then this one
    let r: Scaling = saved.type === "nine_slice" ? saved : rule;
    let err: string | null = null;
    for (const s of SIDES) {
      const res = withBorder(r, s.key, f[s.key]);
      if ("error" in res) {
        err = res.error;
        break;
      }
      r = res.rule;
    }
    setFieldError(err);
    setDrafts((m) => {
      const next = new Map(m);
      if (err || sameScaling(r, saved)) next.delete(piece.path);
      else next.set(piece.path, r);
      return next;
    });
  };
  const commitBorders = () => {
    if (!piece || fieldError) return;
    const d = drafts.get(piece.path);
    if (d && !sameScaling(d, saved)) void apply(d);
  };
  const onFieldKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
    if (e.key === "Escape") {
      dropDraft(piece?.path ?? "");
      setFields(saved.type === "nine_slice"
        ? { left: String(saved.border.left), top: String(saved.border.top), right: String(saved.border.right), bottom: String(saved.border.bottom) }
        : null);
      setFieldError(null);
    }
  };

  const draw = (id: string) => {
    const p = screen?.pieces.find((x) => x.id === id);
    if (!p || !screen) return;
    if (shared ? !p.in_version : !p.in_version && !p.in_pack) {
      toast(`${p.name} does not exist in Minecraft ${versionLabel}.`, "warn");
      return;
    }
    if (shared && p.rect) {
      void useEditor.getState().openRect(p.path, { piece: p.name, rect: p.rect, imageSize: screen.size });
    } else {
      void useEditor.getState().openTexture(p.path);
    }
  };

  const paths = new Set(screen?.pieces.map((p) => p.path) ?? []);
  const unsaved = tabs.filter((t) => t.packDir === packDir && t.doc.dirty && paths.has(t.doc.path));
  const saveUnsaved = async () => {
    for (const t of unsaved) if (!(await useEditor.getState().save(t.id))) return;
  };

  const top = (
    <TopBar
      crumbs={
        <>
          <span className="name ellipsis">{pack.project.name}</span>
          <span className="sep">/</span>
          <span className="leaf" style={{ color: "var(--text-2)" }}>Interface</span>
          {screen && (
            <>
              <span className="sep">/</span>
              <span className="ellipsis">{screen.name}</span>
            </>
          )}
          <span className="gi-mode" role="group" aria-label="Editor mode">
            <button title="Draw the selected piece in the pixel editor" disabled={!piece} onClick={() => piece && draw(piece.id)}>Pixels</button>
            <button className="on" aria-pressed="true">Layout</button>
          </span>
        </>
      }
      right={
        <>
          <span className="dim" style={{ fontSize: 12 }}>{shared ? "Zoom" : "GUI scale"}</span>
          <span className="gi-seg" role="group" aria-label={shared ? "Zoom" : "GUI scale"}>
            {[1, 2, 3].map((n) => (
              <button key={n} className={scale === n ? "on" : ""} aria-pressed={scale === n} onClick={() => { setScale(n); memory.scale = n; }}>{n}×</button>
            ))}
          </span>
          {unsaved.length > 0 && (
            <button className="btn primary" title={`Unsaved in the editor: ${unsaved.map((t) => t.doc.path).join(", ")}`} onClick={() => void saveUnsaved()}>
              Save to pack
            </button>
          )}
        </>
      }
    />
  );

  const doneCount = screen ? screen.pieces.filter((p) => p.in_pack && (p.in_version || p.in_pack)).length : 0;
  const footer = (
    <StatusBar right={<>→ textures/{shared ? `${screen?.folder ?? "gui"}.png` : `${screen?.folder ?? "gui/sprites"}/`}</>}>
      {screen && (
        <span>
          {screen.name} · {screen.total} piece{screen.total === 1 ? "" : "s"} · {shared ? (screen.done > 0 ? "image in your pack" : "image not in your pack yet") : `${doneCount} done`}
        </span>
      )}
      <span>Interface pieces exist from Java 1.20.2 · older versions use one big gui image</span>
    </StatusBar>
  );

  const scalable = !!piece?.scalable && !shared;
  const st = piece?.scaling ?? null;
  const ratio = piece?.pack_size && piece.size ? piece.pack_size[0] / (shared ? (screen?.size[0] ?? 1) : logical[0]) : null;
  const sharedRect = shared && piece?.rect ? piece.rect : null;
  const imgScale = sharedBuf && screen ? imageScale([sharedBuf.w, sharedBuf.h], screen.size) ?? 1 : 1;
  const legacyCrop = sharedRect && sharedBuf
    ? cropBuf(sharedBuf, sharedRect[0] * imgScale, sharedRect[1] * imgScale, sharedRect[2] * imgScale, sharedRect[3] * imgScale)
    : null;

  return (
    <>
      {top}
      <div className="body">
        <Nav />
        <aside className="gi-list">
          <div className="gi-group">
            <div className="caps gi-head">Screens</div>
            {overview?.screens.map((s) => (
              <button key={s.id} className={`gi-screen ${s.id === screen?.id ? "on" : ""}`} aria-current={s.id === screen?.id} onClick={() => pickScreen(s.id)}>
                <span className="grow ellipsis">{s.name}</span>
                <span className="n">{s.total}</span>
              </button>
            ))}
            {!overview && !error && <div className="dim" style={{ padding: 8, fontSize: 12 }}>Reading the interface…</div>}
          </div>
          <div className="gi-group gi-pieces">
            <div className="caps gi-head">Pieces on this screen</div>
            <div className="gi-rows" role="listbox" aria-label="Pieces">
              {screen?.pieces.map((p) => {
                const b = bufs.get(p.path);
                // a shared image is in the pack for every piece, even those of later versions
                const present = shared ? p.in_version : p.in_version || p.in_pack;
                const sw = shared && p.rect && b ? cropBuf(b, p.rect[0] * imgScale, p.rect[1] * imgScale, p.rect[2] * imgScale, p.rect[3] * imgScale) : b ?? null;
                return (
                  <button
                    key={p.id}
                    role="option"
                    aria-selected={p.id === piece?.id}
                    className={`gi-piece ${p.id === piece?.id ? "on" : ""} ${present ? "" : "absent"}`}
                    title={present ? `${p.name} · ${p.used_on}` : `${p.name} does not exist in ${versionLabel}`}
                    onClick={() => pick(p.id)}
                    onDoubleClick={() => draw(p.id)}
                  >
                    <span className="gi-swatch"><Swatch buf={sw} /></span>
                    <span className="name mono ellipsis">{p.name}</span>
                    <span className={`st ${present && p.in_pack ? "done" : ""}`}>{present ? (p.in_pack ? "Done" : "To do") : "—"}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <main className="gi-main">
          <div className="gi-toolbar">
            <label className="gi-tool">
              Background
              <select className="gi-select" value={background} onChange={(e) => { const v = e.target.value as Background; setBackground(v); memory.background = v; }}>
                {BACKGROUNDS.map((b) => <option key={b.v} value={b.v}>{b.label}</option>)}
              </select>
            </label>
            <label className="gi-tool"><input type="checkbox" checked={outlines} onChange={(e) => { setOutlines(e.target.checked); memory.outlines = e.target.checked; }} /> Show piece outlines</label>
            {!shared && (
              <label className="gi-tool"><input type="checkbox" checked={hover} onChange={(e) => { setHover(e.target.checked); memory.hover = e.target.checked; }} /> Show hover states</label>
            )}
            <span className="gi-hint">Click a piece to select it · double-click to draw on it</span>
          </div>
          <div className={`gi-stage bg-${background}`}>
            {error && (
              <div className="pv-error">
                <Icon name="warn" size={16} width={2} color="var(--warn)" />
                <span>The interface could not be read: {error}</span>
              </div>
            )}
            {screen && !shared && (
              <ScreenPreview
                screen={screen} bufs={bufs} k={scale} drafts={drafts} hover={hover} outlines={outlines}
                selected={piece?.id ?? null} onPick={pick} onDraw={draw}
              />
            )}
            {screen && shared && (
              <SharedPreview screen={screen} buf={sharedBuf} zoom={scale} outlines={outlines} selected={piece} onPick={pick} onDraw={draw} />
            )}
          </div>
        </main>

        <aside className="gi-side">
          {piece && screen && (
            <section className="gi-sec">
              <div>
                <div className="gi-title mono">{piece.name}</div>
                <div className="gi-path mono">
                  textures/{piece.path}.png{sharedRect ? ` · ${sharedRect[2]}×${sharedRect[3]} at ${sharedRect[0]}, ${sharedRect[1]}` : ""}
                </div>
              </div>
              {shared ? (
                <div className="gi-big">
                  {legacyCrop ? <BufCanvas buf={legacyCrop} zoom={Math.max(1, Math.min(8, Math.floor(Math.min(296 / legacyCrop.w, 48 / legacyCrop.h))))} /> : <span className="dim" style={{ fontSize: 11 }}>No image</span>}
                </div>
              ) : (
                <BigPreview piece={piece} buf={bufs.get(piece.path) ?? null} rule={rule} logical={logical} />
              )}
              <dl className="gi-dl">
                <dt>Vanilla size</dt>
                <dd>{piece.size ? `${piece.size[0]} × ${piece.size[1]} px` : `Not in ${versionLabel}`}</dd>
                <dt>In your pack{ratio && ratio !== 1 && Number.isFinite(ratio) ? ` (${Number(ratio.toFixed(2))}×)` : ""}</dt>
                <dd>
                  {piece.pack_size
                    ? `${piece.pack_size[0]} × ${piece.pack_size[1]} px${shared ? " (the whole image)" : ""}`
                    : <span className="dim">Not yet: the game's image is used</span>}
                </dd>
                <dt>Used on</dt>
                <dd>{piece.used_on}</dd>
              </dl>
            </section>
          )}

          {piece && screen && (
            <section className="gi-sec">
              <h2 className="caps">How it stretches</h2>
              {scalable && st ? (
                <>
                  <div className="gi-tabs" role="group" aria-label="Scaling">
                    {(["stretch", "tile", "nine_slice"] as const).map((t) => (
                      <button key={t} className={rule.type === t ? "on" : ""} aria-pressed={rule.type === t} disabled={busy} onClick={() => setType(t)}>
                        {t === "stretch" ? "Stretch" : t === "tile" ? "Tile" : "Nine-slice"}
                      </button>
                    ))}
                  </div>
                  <div className="gi-help">{SCALING_HELP[rule.type]}</div>
                  {rule.type === "nine_slice" && fields && (
                    <>
                      <div className="gi-borders">
                        {SIDES.map((s) => (
                          <label key={s.key}>
                            {s.label}
                            <input
                              type="number" min={0} step={1} value={fields[s.key]} aria-label={`${s.label} border`}
                              onChange={(e) => typeBorder(s.key, e.target.value)} onBlur={commitBorders} onKeyDown={onFieldKey}
                            />
                          </label>
                        ))}
                      </div>
                      {fieldError && <div className="gi-error">{fieldError}</div>}
                      <label className="gi-check" title={`The rule's size in GUI pixels is ${rule.width} × ${rule.height}`}>
                        <input type="checkbox" checked={rule.stretch_inner} disabled={busy} onChange={(e) => void apply({ ...rule, stretch_inner: e.target.checked })} />
                        Stretch the inside instead of repeating it (1.21.5+)
                      </label>
                    </>
                  )}
                  {rule.type === "tile" && (
                    <div className="gi-help">Size in GUI pixels: {rule.width} × {rule.height}{piece.pack_size && ratio && ratio !== 1 ? `; your ${piece.pack_size[0]}×${piece.pack_size[1]} image is drawn at that size` : ""}.</div>
                  )}
                  {st.source === "pack_png_only" && st.vanilla.type !== "stretch" && (
                    <div className="gi-warn">
                      <Icon name="warn" size={14} width={2} color="var(--warn)" />
                      <span>Your pack has {fileOf(piece.path)} without a .mcmeta, so the game stretches it. The game's own uses {scalingLabel(st.vanilla).toLowerCase()}: choose it again to write the file.</span>
                    </div>
                  )}
                  {st.error && (
                    <div className="gi-warn">
                      <Icon name="warn" size={14} width={2} color="var(--warn)" />
                      <span>Your {fileOf(piece.path)}.mcmeta could not be read ({st.error}). Choosing a rule rewrites it.</span>
                    </div>
                  )}
                  <StretchDemo buf={bufs.get(piece.path) ?? null} rule={rule} logical={logical} />
                </>
              ) : shared ? (
                <div className="pv-note">
                  Java {versionLabel} has no stretch rules: the game draws this piece at a fixed size from its rectangle of{" "}
                  <span className="mono">{fileOf(piece.path)}</span>. From 1.20.2 every piece is its own image that can stretch, tile or nine-slice.
                  <div className="dim" style={{ marginTop: 6, fontSize: 11 }}>
                    {piece.checked.length
                      ? `Rectangle checked pixel by pixel against the 1.21.11 ${piece.modern?.split("/").pop()} sprite in ${piece.checked.join(" and ")}.`
                      : "Rectangle taken from the game's drawing code (no modern sprite to compare)."}
                  </div>
                </div>
              ) : (
                <div className="pv-note">
                  The game draws this image at a fixed size, so it has no stretch rule. Only images in <span className="mono">gui/sprites/</span> can stretch, tile or nine-slice.
                </div>
              )}
            </section>
          )}

          {piece && screen && (
            <section className="gi-sec last">
              {scalable && (
                <>
                  <div className="gi-sechead">
                    <h2 className="caps">Generated file</h2>
                    <span className="mono dim" style={{ fontSize: 10 }}>{fileOf(piece.path)}.mcmeta</span>
                  </div>
                  {meta?.path === piece.path && meta.error ? (
                    <div className="gi-error">{meta.error}</div>
                  ) : (
                    <pre className="gi-json">
                      {meta?.path !== piece.path ? "…" : meta.text ?? (st?.pack_has_png
                        ? "No file: the game stretches the image."
                        : "No file in your pack: the game's own rule applies.")}
                    </pre>
                  )}
                </>
              )}
              <div className="gi-actions">
                <button className="btn primary" disabled={!piece.in_version && !piece.in_pack} onClick={() => draw(piece.id)}>Draw this piece</button>
                {scalable && st && (
                  <button
                    className="btn"
                    disabled={busy || (sameScaling(st.scaling, st.vanilla) && !drafts.has(piece.path))}
                    title="Back to the game's own stretch rule for this piece"
                    onClick={() => { if (drafts.has(piece.path)) { dropDraft(piece.path); setFieldError(null); } void apply(st.vanilla); }}
                  >
                    Revert
                  </button>
                )}
              </div>
            </section>
          )}
        </aside>
      </div>
      {footer}
    </>
  );
}

/** A piece in the list: its image squeezed into 30×12 without smoothing. */
const Swatch = memo(function Swatch({ buf }: { buf: Buf | null }) {
  if (!buf || buf.w === 0 || buf.h === 0) return null;
  const z = Math.min(30 / buf.w, 12 / buf.h);
  return <BufCanvas buf={buf} zoom={z} />;
});
