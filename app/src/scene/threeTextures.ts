// Texture helpers shared by the 3D views (only loaded with three.js).
import * as THREE from "three";

/** Hard pixels, no mipmaps, no colour conversion (as the game shows them). */
export function hardPixels<T extends THREE.Texture>(t: T): T {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  // the pixels go to the screen as they are, like the game (no colour conversion)
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`no image at ${url}`));
    img.src = url;
  });
}

/** First frame of an image (animated textures are vertical strips of square frames). */
export function firstFrame(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight > w && img.naturalHeight % w === 0 ? w : img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0);
  return c;
}

/** The game's "missing texture": magenta and black squares. */
export function missingTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 2;
  const g = c.getContext("2d");
  if (g) {
    g.fillStyle = "#f800f8";
    g.fillRect(0, 0, 2, 2);
    g.fillStyle = "#000";
    g.fillRect(1, 0, 1, 1);
    g.fillRect(0, 1, 1, 1);
  }
  return hardPixels(new THREE.CanvasTexture(c));
}

/** Loads the first image that exists among `urls` (pack first, then the game). */
export async function loadFirst(urls: string[]): Promise<THREE.Texture | null> {
  for (const url of urls) {
    try {
      return hardPixels(new THREE.CanvasTexture(firstFrame(await loadImage(url))));
    } catch {
      // not there: try the next one
    }
  }
  return null;
}
