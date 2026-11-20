// Pack and export: the "Showcase" card (an image of the pack for CurseForge,
// Modrinth, Discord…) and the "Page text" dialog. The image is drawn on a
// canvas with the app's fonts and saved by Rust as a lossless PNG.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { bytesToBase64 } from "../editor/pixels";
import { api, images, type TextureRow } from "../lib/api";
import { baseName, bytesLabel, CATEGORIES, joinPath, matchesSearch, parseSectionCodes, safeFileName, searchWords } from "../lib/logic";
import {
  defaultShowcase, gridLayout, madeForLine, pageFileName, pageMarkdown, pageSummary, showcaseArea, SHOWCASE_BOX, SHOWCASE_H, SHOWCASE_MAX,
  SHOWCASE_W, sourceRect,
} from "../lib/showcase";
import { useApp } from "../store";

/** The user's choice per pack, kept while the app runs. */
const chosenByPack = new Map<string, string[]>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    // pcimg answers with Access-Control-Allow-Origin, so the canvas stays readable
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

interface DrawInput {
  name: string;
  description: string;
  versions: string[];
  resolution: number;
  textures: { path: string; animated: boolean }[];
  stamp: number;
}

/** Draws the showcase on a 1920×1080 canvas. */
async function drawShowcase(canvas: HTMLCanvasElement, input: DrawInput): Promise<void> {
  canvas.width = SHOWCASE_W;
  canvas.height = SHOWCASE_H;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  await Promise.all([
    document.fonts.load("600 64px 'Inter Variable'"),
    document.fonts.load("400 30px 'Inter Variable'"),
    document.fonts.load("400 26px 'JetBrains Mono'"),
  ]).catch(() => {});
  const [icon, ...tex] = await Promise.all([
    loadImage(images.packIcon(input.stamp)),
    ...input.textures.map((t) => loadImage(images.packFull(t.path, input.stamp))),
  ]);

  const { margin, header, gap } = SHOWCASE_BOX;
  const bg = ctx.createLinearGradient(0, 0, 0, SHOWCASE_H);
  bg.addColorStop(0, "#16171b");
  bg.addColorStop(1, "#0d0e10");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SHOWCASE_W, SHOWCASE_H);
  ctx.imageSmoothingEnabled = false;

  // header: icon, name, description with § colours
  const iconSize = header - 40;
  if (icon) {
    ctx.fillStyle = "#18191c";
    ctx.fillRect(margin, margin, iconSize, iconSize);
    ctx.drawImage(icon, margin, margin, iconSize, iconSize);
  }
  const tx = margin + (icon ? iconSize + 40 : 0);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ececf0";
  ctx.font = "600 64px 'Inter Variable', Inter, sans-serif";
  ctx.fillText(input.name, tx, margin + 70, SHOWCASE_W - tx - margin);
  let x = tx;
  const y = margin + 128;
  for (const run of parseSectionCodes(input.description)) {
    ctx.font = `${run.italic ? "italic " : ""}${run.bold ? 700 : 400} 30px 'Inter Variable', Inter, sans-serif`;
    ctx.fillStyle = run.color;
    const text = run.text.replace(/\n/g, " ");
    const w = ctx.measureText(text).width;
    if (x + w > SHOWCASE_W - margin) break;
    ctx.fillText(text, x, y);
    if (run.underline) ctx.fillRect(x, y + 5, w, 2);
    if (run.strike) ctx.fillRect(x, y - 10, w, 2);
    x += w;
  }

  // the textures, hard pixels, in dark cells
  const loaded = input.textures.map((t, i) => ({ t, img: tex[i] })).filter((x): x is { t: DrawInput["textures"][number]; img: HTMLImageElement } => !!x.img);
  const srcs = loaded.map(({ t, img }) => sourceRect(img.naturalWidth, img.naturalHeight, t.animated));
  const grid = gridLayout(showcaseArea(), srcs.map((s) => [s[2], s[3]] as [number, number]), gap);
  grid.tiles.forEach((tile, i) => {
    const [cx, cy, cell] = tile.cell;
    ctx.fillStyle = "#18191c";
    ctx.beginPath();
    ctx.roundRect(cx, cy, cell, cell, 10);
    ctx.fill();
    ctx.strokeStyle = "#2a2b30";
    ctx.lineWidth = 2;
    ctx.stroke();
    const [sx, sy, sw, sh] = srcs[i];
    const [dx, dy, dw, dh] = tile.dest;
    ctx.drawImage(loaded[i].img, sx, sy, sw, sh, dx, dy, dw, dh);
  });

  // footer
  ctx.font = "400 26px 'JetBrains Mono', monospace";
  ctx.fillStyle = "#9b9ca4";
  ctx.fillText(madeForLine(input.versions, input.resolution), margin, SHOWCASE_H - margin + 4);
}

/** The labels of the pack's main version and of its export copies. */
export function useExportVersions(also: string[]): string[] {
  const pack = useApp((s) => s.pack)!;
  const boot = useApp((s) => s.boot)!;
  const main = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  return useMemo(() => {
    const out = [main];
    for (const dir of also) {
      const label = boot.versions.find((v) => v.dir_name === dir)?.label ?? dir;
      if (!out.includes(label)) out.push(label);
    }
    return out;
  }, [main, also, boot.versions]);
}

export function ShowcaseCard({ also }: { also: string[] }) {
  const pack = useApp((s) => s.pack)!;
  const rows = useApp((s) => s.rows);
  const stamp = useApp((s) => s.stamp);
  const versions = useExportVersions(also);
  const [chosen, setChosen] = useState<string[] | null>(() => chosenByPack.get(pack.dir) ?? null);
  const [picking, setPicking] = useState(false);
  const [paging, setPaging] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const paths = useMemo(() => chosen ?? defaultShowcase(rows), [chosen, rows]);
  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const textures = useMemo(
    () => paths.filter((p) => byPath.get(p)?.mine).map((p) => ({ path: p, animated: !!byPath.get(p)!.mine!.animated })),
    [paths, byPath],
  );
  const input: DrawInput = useMemo(() => ({
    name: pack.project.name, description: pack.project.description, versions, resolution: pack.project.resolution, textures, stamp,
  }), [pack.project.name, pack.project.description, pack.project.resolution, versions, textures, stamp]);

  // a small preview, redrawn when anything shown on it changes
  useEffect(() => {
    let live = true;
    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvasRef.current = canvas;
    const t = setTimeout(() => {
      drawShowcase(canvas, input)
        .then(() => { if (live) setPreview(canvas.toDataURL("image/jpeg", 0.85)); })
        .catch(() => { if (live) setPreview(null); });
    }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [input]);

  const choose = (list: string[] | null) => {
    if (list) chosenByPack.set(pack.dir, list);
    else chosenByPack.delete(pack.dir);
    setChosen(list);
  };

  const saveImage = async () => {
    const { toast, showError } = useApp.getState();
    const path = await save({
      title: "Save the showcase image",
      defaultPath: joinPath(pack.export_dir, `${safeFileName(pack.project.name)} showcase.png`),
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (typeof path !== "string") return;
    setWorking(true);
    try {
      const canvas = document.createElement("canvas");
      await drawShowcase(canvas, input);
      const data = canvas.getContext("2d")!.getImageData(0, 0, SHOWCASE_W, SHOWCASE_H).data;
      const size = await api.saveShowcase(path, SHOWCASE_W, SHOWCASE_H, bytesToBase64(data));
      toast(`Saved the showcase image (${SHOWCASE_W}×${SHOWCASE_H}, ${bytesLabel(size)}).`, "ok", {
        label: "Show in folder", run: () => void api.reveal(path).catch(() => {}),
      });
    } catch (e) {
      showError(e, "The showcase image could not be saved");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="card col showcase" style={{ padding: 18, gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <h2 className="grow">Showcase</h2>
        <button className="btn" onClick={() => setPaging(true)} title="Text for the CurseForge or Modrinth page">Page text…</button>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>
        An image of your pack for CurseForge, Modrinth or Discord: the icon, name, description and {textures.length} texture{textures.length === 1 ? "" : "s"}.
      </div>
      <div className="scpreview checker">
        {preview ? <img src={preview} alt="Showcase preview" /> : <span className="dim">Drawing…</span>}
      </div>
      <div className="row" style={{ gap: 8 }}>
        <span className="dim grow" style={{ fontSize: 11 }}>{chosen ? "Your choice" : "Most recently edited, blocks and items first"} · {SHOWCASE_W}×{SHOWCASE_H}</span>
        <button className="btn" onClick={() => setPicking(true)}>Choose textures…</button>
        <button className="btn primary" disabled={working || textures.length === 0} onClick={() => void saveImage()}>{working ? "Saving…" : "Save image…"}</button>
      </div>
      {picking && <ShowcasePicker initial={paths} onClose={() => setPicking(false)} onDone={(list) => { choose(list); setPicking(false); }} />}
      {paging && <PageTextDialog versions={versions} onClose={() => setPaging(false)} />}
    </div>
  );
}

function ShowcasePicker({ initial, onDone, onClose }: { initial: string[]; onDone: (list: string[] | null) => void; onClose: () => void }) {
  const rows = useApp((s) => s.rows);
  const stamp = useApp((s) => s.stamp);
  const [list, setList] = useState<string[]>(initial);
  const [q, setQ] = useState("");
  const mine = useMemo(() => rows.filter((r) => r.mine && !r.extra), [rows]);
  const shown = useMemo(() => {
    const words = searchWords(q);
    return mine.filter((r) => matchesSearch(r.path, words)).slice(0, 400);
  }, [mine, q]);
  const order = (r: TextureRow) => CATEGORIES.findIndex((c) => c.key === r.category);
  const sorted = useMemo(() => [...shown].sort((a, b) => order(a) - order(b) || a.path.localeCompare(b.path)), [shown]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = (p: string) => setList((l) => (l.includes(p) ? l.filter((x) => x !== p) : l.length >= SHOWCASE_MAX ? l : [...l, p]));
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Choose showcase textures" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide scpicker">
        <h2>Textures on the showcase</h2>
        <p>Pick up to {SHOWCASE_MAX} textures of your pack. They are shown in the order you pick them.</p>
        <div className="row" style={{ gap: 8 }}>
          <input className="input sm grow" autoFocus placeholder="Search your textures…" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
          <span className={list.length >= SHOWCASE_MAX ? "" : "dim"} style={{ fontSize: 12, color: list.length >= SHOWCASE_MAX ? "var(--warn)" : undefined }}>{list.length} / {SHOWCASE_MAX}</span>
        </div>
        <div className="scgrid">
          {sorted.length === 0 && <div className="dim" style={{ padding: 12, fontSize: 12 }}>{mine.length === 0 ? "Your pack has no textures yet." : "Nothing matches."}</div>}
          {sorted.map((r) => {
            const n = list.indexOf(r.path);
            return (
              <button key={r.path} className={`sctile ${n >= 0 ? "on" : ""}`} title={r.path} onClick={() => toggle(r.path)} disabled={n < 0 && list.length >= SHOWCASE_MAX}>
                <span className="checker"><img className="pixel" loading="lazy" src={images.packFull(r.path, stamp)} alt="" /></span>
                <span className="mono ellipsis">{baseName(r.path)}</span>
                {n >= 0 && <span className="num">{n + 1}</span>}
              </button>
            );
          })}
        </div>
        <div className="buttons">
          <button className="btn md" style={{ marginRight: "auto" }} onClick={() => onDone(null)}>Back to the default</button>
          <button className="btn md" onClick={() => setList([])}>Clear</button>
          <button className="btn md" onClick={onClose}>Cancel</button>
          <button className="btn md primary" onClick={() => onDone(list)}>Use these {list.length}</button>
        </div>
      </div>
    </div>
  );
}

function PageTextDialog({ versions, onClose }: { versions: string[]; onClose: () => void }) {
  const pack = useApp((s) => s.pack)!;
  const rows = useApp((s) => s.rows);
  const info = useMemo(() => ({
    name: pack.project.name,
    description: pack.project.description,
    versions,
    resolution: pack.project.resolution,
    rows,
    zipName: `${safeFileName(pack.project.name)} ${safeFileName(versions[0])}.zip`,
  }), [pack.project, versions, rows]);
  const summary = useMemo(() => pageSummary(info), [info]);
  const [text, setText] = useState(() => pageMarkdown(info));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = async (what: string, label: string) => {
    const { toast, showError } = useApp.getState();
    try {
      await writeText(what);
      toast(`Copied the ${label}. Paste it on the CurseForge or Modrinth page.`);
    } catch (e) {
      showError(e, "The text could not be copied");
    }
  };

  const saveFile = async () => {
    const { toast, showError } = useApp.getState();
    const path = await save({
      title: "Save the page text",
      defaultPath: joinPath(pack.export_dir, pageFileName(pack.project.name)),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.saveShareList(path, text);
      toast("Saved the page text.", "ok", { label: "Show in folder", run: () => void api.reveal(path).catch(() => {}) });
    } catch (e) {
      showError(e, "The page text could not be saved");
    }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Page text" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <h2>Page text for CurseForge / Modrinth</h2>
        <p>Both sites take Markdown. Edit it here before you copy it: the counts come from your pack.</p>
        <div className="field">
          <span className="label">Summary (one line, at most 256 characters)</span>
          <div className="row" style={{ gap: 8 }}>
            <input className="input sm grow" readOnly value={summary} />
            <button className="btn" onClick={() => void copy(summary, "summary")}>Copy</button>
          </div>
        </div>
        <textarea className="sharepreview mono" style={{ height: 320 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Page text" spellCheck={false} />
        <div className="buttons">
          <button className="btn md" style={{ marginRight: "auto" }} onClick={() => setText(pageMarkdown(info))}>Start again</button>
          <button className="btn md" onClick={onClose}>Close</button>
          <button className="btn md" onClick={() => void saveFile()}>Save as .md…</button>
          <button className="btn md primary" onClick={() => void copy(text, "page text")}>Copy</button>
        </div>
      </div>
    </div>
  );
}
