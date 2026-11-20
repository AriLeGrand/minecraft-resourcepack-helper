// The Windows clipboard for the pixel editor's Copy / Cut / Paste (D-076).
//
// Copy writes the copied pixels to Windows as an image (raw RGBA through Tauri's
// clipboard plugin, which puts PNG and CF_DIBV5 on the clipboard, so alpha is
// kept). The app's own clipboard stays the source of truth inside the app: it
// keeps the exact pixels and where they came from. Paste takes the Windows
// image only when it is not the one Blockwright itself put there last.
//
// The choices are pure functions (tested); the plugin calls are thin wrappers.
import { readImage, writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { newBuf, type Buf, type Clip, type Pt } from "./pixels";
import { screenToPixel, type View } from "./view";

/**
 * The plugin's raw RGBA as an editor image. Some programs put 32-bit bitmaps
 * on the clipboard whose alpha bytes are all 0 (the alpha is "not used"): such
 * an image would paste as nothing, so it is taken as fully opaque instead.
 */
export function imageToBuf(rgba: Uint8Array, w: number, h: number): Buf {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) throw new Error(`The clipboard image has no size (${w}×${h}).`);
  if (rgba.length !== w * h * 4) throw new Error(`The clipboard image is damaged: ${rgba.length} bytes for ${w}×${h} pixels.`);
  const buf = newBuf(w, h);
  buf.data.set(rgba);
  let anyAlpha = false;
  let anyColour = false;
  for (let i = 0; i < buf.data.length; i += 4) {
    if (buf.data[i + 3] !== 0) {
      anyAlpha = true;
      break;
    }
    if (buf.data[i] || buf.data[i + 1] || buf.data[i + 2]) anyColour = true;
  }
  if (!anyAlpha && anyColour) for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = 255;
  return buf;
}

export function sameBuf(a: Buf | null, b: Buf | null): boolean {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return false;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) return false;
  return true;
}

export type PasteChoice =
  | { kind: "external"; buf: Buf }
  | { kind: "internal"; clip: Clip }
  | { kind: "none" };

/**
 * What Paste uses: the Windows image when there is one and it is not what
 * Blockwright itself left there (`mine`), else the app's own clipboard.
 */
export function choosePaste(external: Buf | null, mine: Buf | null, internal: Clip | null): PasteChoice {
  if (external && !(internal && sameBuf(external, mine))) return { kind: "external", buf: external };
  if (internal) return { kind: "internal", clip: internal };
  return { kind: "none" };
}

/** Where an image from another program lands: the top-left texture pixel in view (or 0,0). */
export function externalOrigin(view: View, docW: number, docH: number): Pt {
  const [x, y] = screenToPixel(view, 0, 0);
  return [Math.max(0, Math.min(x, docW - 1)), Math.max(0, Math.min(y, docH - 1))];
}

/** An image from another program as a clip that the editor pastes (never resized). */
export function externalClip(buf: Buf, view: View, docW: number, docH: number): Clip {
  const [x, y] = externalOrigin(view, docW, docH);
  return { x, y, buf };
}

/** The status line after pasting an image from another program. */
export function externalPasteStatus(buf: Buf, docW: number, docH: number): string {
  const size = `${buf.w}×${buf.h}`;
  if (buf.w > docW || buf.h > docH) {
    return `Pasted a ${size} image from the clipboard. It is bigger than this ${docW}×${docH} texture and was not resized: ` +
      "only the part over the texture is kept. Drag to move it into place.";
  }
  return `Pasted a ${size} image from the clipboard. Drag to move it into place.`;
}

/** The message of a plugin error (they arrive as plain strings). */
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** arboard's "nothing in that format" error: no image, not a failure. */
export const isNoImage = (e: unknown) => /not available|empty/i.test(errorText(e));

// ------------------------------------------------------------ plugin side

/** What Blockwright last left on the Windows clipboard (null = nothing known). */
let mine: Buf | null = null;
/** The last write, so Paste reads the clipboard only after it has landed. */
let pending: Promise<void> = Promise.resolve();

export type ReadResult = { buf: Buf | null; error: string | null };

/** Reads the clipboard image as exact RGBA (no browser canvas in between). */
export async function readSystemImage(): Promise<ReadResult> {
  let img: Awaited<ReturnType<typeof readImage>>;
  try {
    img = await readImage();
  } catch (e) {
    return isNoImage(e) ? { buf: null, error: null } : { buf: null, error: errorText(e) };
  }
  try {
    const [rgba, size] = await Promise.all([img.rgba(), img.size()]);
    return { buf: imageToBuf(rgba, size.width, size.height), error: null };
  } catch (e) {
    return { buf: null, error: errorText(e) };
  } finally {
    img.close().catch(() => {});
  }
}

/**
 * Puts copied pixels on the Windows clipboard. Resolves to an error message
 * when Windows refused them (the app's own clipboard still has them).
 */
export function writeSystemImage(buf: Buf): Promise<string | null> {
  const copy: Buf = { w: buf.w, h: buf.h, data: buf.data.slice() };
  const job = pending.then(async () => {
    try {
      // a plain array: JSON has no byte arrays, and this is what tauri::image::JsImage::Rgba reads
      await writeImage({ rgba: Array.from(copy.data), width: copy.w, height: copy.h } as unknown as Parameters<typeof writeImage>[0]);
      mine = copy;
      return null;
    } catch (e) {
      // whatever image is there now must not win over what was just copied
      mine = (await readSystemImage()).buf;
      return errorText(e);
    }
  });
  pending = job.then(() => {});
  return job;
}

/** Reads the clipboard for Paste, after any copy still being written. */
export async function readForPaste(): Promise<ReadResult & { mine: Buf | null }> {
  await pending;
  const r = await readSystemImage();
  return { ...r, mine };
}

/** Test hook. */
export function resetSystemClipboard() {
  mine = null;
  pending = Promise.resolve();
}
