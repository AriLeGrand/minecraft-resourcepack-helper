// 3D preview of random variants: a 3×3 patch of the block, each one showing
// the model (and turn) picked for it, drawn with three.js like the editor's
// block preview (hard pixels, the game's face shading). Loaded on demand.
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { images, type BlockModel, type PreviewEntry } from "../lib/api";
import { modelFaces, QUAD_TRIANGLES, tintFor, type Vec3 } from "../editor/blockMesh";

export interface PatchPreviewProps {
  /** The weighted entries of the shown state. */
  entries: PreviewEntry[];
  /** Index into `entries` for each of the 9 blocks, row by row. */
  picks: number[];
  /** Resolved models by name. */
  models: Record<string, BlockModel>;
  versionDir: string;
  /** Bumped when files changed: textures are read again. */
  stamp: number;
  height: number;
}

const DEFAULT_VIEW = { yaw: Math.PI / 5, pitch: 0.62, zoom: 1 };

function hardPixels<T extends THREE.Texture>(t: T): T {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = () => fail(new Error(`no image at ${url}`));
    img.src = url;
  });
}

function firstFrame(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight > w && img.naturalHeight % w === 0 ? w : img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0);
  return c;
}

/** A block state's turn: `x` then `y`, clockwise in 90° steps as the game does it. */
export function turn(p: Vec3, x: number, y: number): Vec3 {
  let [a, b, c] = p;
  const ax = (-x * Math.PI) / 180;
  if (x % 360 !== 0) [b, c] = [b * Math.cos(ax) - c * Math.sin(ax), b * Math.sin(ax) + c * Math.cos(ax)];
  const ay = (-y * Math.PI) / 180;
  if (y % 360 !== 0) [a, c] = [a * Math.cos(ay) + c * Math.sin(ay), -a * Math.sin(ay) + c * Math.cos(ay)];
  return [a, b, c];
}

export function PatchPreview({ entries, picks, models, versionDir, stamp, height }: PatchPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const view = useRef({ ...DEFAULT_VIEW });

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const e = new Engine(el, view.current);
    engine.current = e;
    return () => {
      e.dispose();
      engine.current = null;
    };
  }, []);

  useEffect(() => {
    engine.current?.build(entries, picks, models, (tex) => [images.packFull(tex, stamp), images.vanillaFull(versionDir, tex)], stamp);
  }, [entries, picks, models, versionDir, stamp]);

  return (
    <div className="bp bare">
      <div
        ref={host} className="bp-view" style={{ height }}
        role="img" aria-label="3D preview: nine blocks, each showing the variant picked at random. Drag to turn it."
        title="Drag to turn · wheel to zoom · double-click to reset"
        onDoubleClick={() => { Object.assign(view.current, DEFAULT_VIEW); engine.current?.render(); }}
      />
    </div>
  );
}

type View = typeof DEFAULT_VIEW;

class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private loaded = new Map<string, Promise<THREE.Texture | null>>();
  private loadedStamp = -1;
  private frame = 0;
  private builds = 0;
  private observer: ResizeObserver;
  private disposed = false;

  constructor(private host: HTMLElement, private view: View) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    const canvas = this.renderer.domElement;
    canvas.className = "bp-canvas";
    host.prepend(canvas);
    this.scene.add(this.group);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    let drag: { x: number; y: number; id: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      this.view.yaw -= (e.clientX - drag.x) * 0.012;
      this.view.pitch = Math.max(-1.55, Math.min(1.55, this.view.pitch + (e.clientY - drag.y) * 0.012));
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.render();
    });
    const end = (e: PointerEvent) => {
      if (drag?.id === e.pointerId) drag = null;
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.view.zoom = Math.max(0.5, Math.min(4, this.view.zoom * Math.exp(-e.deltaY * 0.0015)));
      this.render();
    }, { passive: false });
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.render();
  }

  render() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.disposed) return;
      const { yaw, pitch, zoom } = this.view;
      const size = this.renderer.getSize(new THREE.Vector2());
      const aspect = size.x / Math.max(1, size.y);
      const half = 2.6 / zoom;
      const cam = this.camera;
      cam.left = -half * aspect;
      cam.right = half * aspect;
      cam.top = half;
      cam.bottom = -half;
      const d = 20;
      cam.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d);
      cam.lookAt(0, 0, 0);
      cam.updateProjectionMatrix();
      this.renderer.render(this.scene, cam);
    });
  }

  private texture(path: string, urls: (tex: string) => string[]): Promise<THREE.Texture | null> {
    let p = this.loaded.get(path);
    if (!p) {
      p = (async () => {
        for (const url of urls(path)) {
          try {
            return hardPixels(new THREE.CanvasTexture(firstFrame(await loadImage(url))));
          } catch {
            // not in the pack: the game's
          }
        }
        return null;
      })();
      this.loaded.set(path, p);
    }
    return p;
  }

  private clear() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
  }

  build(entries: PreviewEntry[], picks: number[], models: Record<string, BlockModel>, urls: (tex: string) => string[], stamp: number) {
    const build = ++this.builds;
    this.clear();
    if (stamp !== this.loadedStamp) {
      for (const p of this.loaded.values()) void p.then((t) => t?.dispose());
      this.loaded.clear();
      this.loadedStamp = stamp;
    }
    type Quad = { corners: Vec3[]; uvs: [number, number][]; color: THREE.Color };
    const groups = new Map<string, Quad[]>();
    picks.forEach((pick, i) => {
      const e = entries[pick];
      const model = e && models[e.model];
      if (!model) return;
      const ox = (i % 3) - 1;
      const oz = Math.floor(i / 3) - 1;
      for (const f of modelFaces(model)) {
        const key = f.texture ?? "";
        const list = groups.get(key) ?? [];
        const tint = f.tinted ? new THREE.Color(tintFor(f.texture)) : new THREE.Color(1, 1, 1);
        list.push({
          corners: f.corners.map((p) => {
            const t = turn([p[0] / 16 - 0.5, p[1] / 16 - 0.5, p[2] / 16 - 0.5], e.x, e.y);
            return [t[0] + ox, t[1], t[2] + oz] as Vec3;
          }),
          uvs: f.uvs,
          color: new THREE.Color(tint.r * f.shade, tint.g * f.shade, tint.b * f.shade),
        });
        groups.set(key, list);
      }
    });
    for (const [key, quads] of groups) {
      const pos = new Float32Array(quads.length * 12);
      const uv = new Float32Array(quads.length * 8);
      const col = new Float32Array(quads.length * 12);
      const idx: number[] = [];
      quads.forEach((q, i) => {
        for (let k = 0; k < 4; k++) {
          pos.set(q.corners[k], (i * 4 + k) * 3);
          uv.set([q.uvs[k][0], 1 - q.uvs[k][1]], (i * 4 + k) * 2);
          col.set([q.color.r, q.color.g, q.color.b], (i * 4 + k) * 3);
        }
        for (const t of QUAD_TRIANGLES) idx.push(i * 4 + t);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1, side: THREE.FrontSide });
      mat.visible = false;
      if (key) {
        void this.texture(key, urls).then((t) => {
          if (build !== this.builds || this.disposed) return;
          mat.map = t;
          mat.visible = t !== null;
          mat.needsUpdate = true;
          this.render();
        });
      }
      const mesh = new THREE.Mesh(geo, mat);
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.render();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.clear();
    for (const p of this.loaded.values()) void p.then((t) => t?.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
