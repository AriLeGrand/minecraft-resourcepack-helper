// The 3D block preview: the texture being edited on a block model (a plain
// cube, or one of the game's models that use the texture: stairs, slab…),
// drawn with three.js the way the game does it (hard pixels, directional
// shading, cut-out transparency, plains grass colour on tinted faces).
//
// The scene is only drawn when something changed (drag, new pixels, resize);
// nothing runs while it stands still. Every GPU object is freed when the model
// changes or the view goes away.
import { memo, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { api, images, toError, type BlockModel, type ModelChoice } from "../lib/api";
import { cubeModel, modelFaces, QUAD_TRIANGLES, tintFor } from "./blockMesh";
import { releaseAfterMouse } from "./focus";
import type { LiveTexture } from "./liveTexture";
import { Icon } from "../components/Icon";

const RESET = "M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7";
const SUN = "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8z";

const CUBE = ":cube";
const DEFAULT_VIEW = { yaw: Math.PI / 4, pitch: Math.PI / 6, zoom: 1 };

// what was picked per texture, and the background, for the rest of the session
const picked = new Map<string, string>();
let lightBackground = false;

function hardPixels<T extends THREE.Texture>(t: T): T {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  // the pixels go to the screen as they are, like the game (no colour conversion)
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

/** First frame of an image (animated textures are vertical strips of square frames). */
function firstFrame(img: HTMLImageElement): HTMLCanvasElement {
  const w = img.naturalWidth;
  const h = img.naturalHeight > w && img.naturalHeight % w === 0 ? w : img.naturalHeight;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")?.drawImage(img, 0, 0);
  return c;
}

/** The game's "missing texture": magenta and black squares. */
function missingTexture(): THREE.Texture {
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

export interface BlockPreviewProps {
  /** Path of the texture being edited (`block/oak_planks`). */
  texture: string;
  live: LiveTexture;
  packDir: string;
  versionDir: string;
  /** Height of the view in pixels. */
  height: number;
  /** Start with the plain cube instead of the most useful model. */
  cubeFirst?: boolean;
  /** No own background or border (the view sits inside another box). */
  bare?: boolean;
  label?: string;
}

export const BlockPreview = memo(function BlockPreview({ texture, live, packDir, versionDir, height, cubeFirst = false, bare = false, label }: BlockPreviewProps) {
  const host = useRef<HTMLDivElement>(null);
  const [choices, setChoices] = useState<ModelChoice[]>([{ name: CUBE, label: "Cube" }]);
  const [choice, setChoice] = useState<string | null>(picked.get(texture) ?? null);
  const [model, setModel] = useState<BlockModel>(() => cubeModel(texture));
  const [error, setError] = useState<string | null>(null);
  const [light, setLight] = useState(lightBackground);
  const view = useRef({ ...DEFAULT_VIEW });
  const engine = useRef<Engine | null>(null);

  // the models that use this texture
  useEffect(() => {
    let gone = false;
    setChoices([{ name: CUBE, label: "Cube" }]);
    setChoice(picked.get(texture) ?? null);
    api.modelsForTexture(texture, packDir).then(
      (list) => { if (!gone) setChoices(list); },
      () => { /* only the cube then */ },
    );
    return () => { gone = true; };
  }, [texture, packDir]);

  // the model shown: what was picked, else the most useful one (or the cube)
  const shown = choice ?? (cubeFirst || choices.length < 2 ? CUBE : choices[1].name);
  useEffect(() => {
    let gone = false;
    setError(null);
    if (shown === CUBE) {
      setModel(cubeModel(texture));
      return;
    }
    api.blockModel(shown, packDir).then(
      (m) => {
        if (gone) return;
        if (m.builtin || m.elements.length === 0) {
          setError(`${shown} has no shape the preview can draw.`);
          setModel(cubeModel(texture));
        } else setModel(m);
      },
      (e) => {
        if (gone) return;
        setError(toError(e).message);
        setModel(cubeModel(texture));
      },
    );
    return () => { gone = true; };
  }, [shown, texture, packDir]);

  // the renderer lives as long as the view
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

  // the model's meshes, built again when the model changes
  useEffect(() => {
    engine.current?.setModel(model, texture, live, (tex) => [images.packFull(tex, Date.now()), images.vanillaFull(versionDir, tex)]);
  }, [model, texture, live, versionDir]);

  const pick = (name: string) => {
    picked.set(texture, name);
    setChoice(name);
  };
  const reset = () => {
    Object.assign(view.current, DEFAULT_VIEW);
    engine.current?.render();
  };
  const toggleLight = () => {
    lightBackground = !light;
    setLight(!light);
  };
  const options = choices.some((c) => c.name === shown) ? choices : [...choices, { name: shown, label: shown.split("/").pop() ?? shown }];

  return (
    <div className={`bp${bare ? " bare" : ""}`}>
      <div
        ref={host} className={`bp-view${light ? " light" : ""}`} style={{ height }}
        role="img" aria-label={label ?? `3D preview of ${texture} on the ${options.find((o) => o.name === shown)?.label ?? "cube"} model. Drag to turn it.`}
        title="Drag to turn · wheel to zoom · double-click to reset"
        onDoubleClick={reset}
      >
        {error && <div className="bp-error">{error} Showing the cube.</div>}
      </div>
      <div className="bp-bar">
        <select
          className="ed-select bp-model" aria-label="Block model" value={shown}
          title="Which block model the texture is shown on"
          onChange={(e) => { pick(e.target.value); releaseAfterMouse(e); }}
        >
          {options.map((c) => <option key={c.name} value={c.name}>{c.label}</option>)}
        </select>
        <button className="bp-btn" title="Turn back to the starting view (or double-click the view)" aria-label="Reset view" onClick={reset}>
          <Icon d={RESET} size={14} />
        </button>
        <button
          className={`bp-btn${light ? " on" : ""}`} aria-pressed={light} aria-label="Light background"
          title={light ? "Dark background" : "Light background"} onClick={toggleLight}
        >
          <Icon d={SUN} size={14} />
        </button>
      </div>
    </div>
  );
});

type View = typeof DEFAULT_VIEW;

/** three.js part: renderer, camera, meshes, textures and the mouse. */
class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  private group = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  /** Textures loaded from the pack or the game, by path. */
  private loaded = new Map<string, Promise<THREE.Texture | null>>();
  private missing = missingTexture();
  private liveTex: THREE.CanvasTexture | null = null;
  private liveSize = "";
  private liveMaterials: THREE.MeshBasicMaterial[] = [];
  private unsubscribe: (() => void) | null = null;
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

  /** Draws on the next screen refresh (several changes in one frame draw once). */
  render() {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private draw() {
    if (this.disposed) return;
    const { yaw, pitch, zoom } = this.view;
    const size = this.renderer.getSize(new THREE.Vector2());
    const aspect = size.x / Math.max(1, size.y);
    const half = 1.25 / zoom;
    const cam = this.camera;
    cam.left = -half * aspect;
    cam.right = half * aspect;
    cam.top = half;
    cam.bottom = -half;
    const d = 10;
    cam.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d);
    cam.up.set(0, 1, 0);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    this.renderer.render(this.scene, cam);
  }

  private texture(path: string, urls: (tex: string) => string[]): Promise<THREE.Texture | null> {
    let p = this.loaded.get(path);
    if (!p) {
      p = (async () => {
        for (const url of urls(path)) {
          try {
            return hardPixels(new THREE.CanvasTexture(firstFrame(await loadImage(url))));
          } catch {
            // the pack does not have it: try the game
          }
        }
        return null;
      })();
      this.loaded.set(path, p);
    }
    return p;
  }

  private uploadLive(live: LiveTexture) {
    const c = live.canvas;
    // nothing painted yet: the faces wait for the first picture
    if (c.width === 0 || c.height === 0) return;
    const size = `${c.width}x${c.height}`;
    if (!this.liveTex || size !== this.liveSize) {
      // a texture cannot change size on the GPU: make a new one
      this.liveTex?.dispose();
      this.liveTex = hardPixels(new THREE.CanvasTexture(c));
      this.liveSize = size;
      for (const m of this.liveMaterials) {
        m.map = this.liveTex;
        m.visible = true;
        m.needsUpdate = true;
      }
    } else this.liveTex.needsUpdate = true;
    this.render();
  }

  private clearMeshes() {
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.meshes = [];
    this.liveMaterials = [];
  }

  setModel(model: BlockModel, edited: string, live: LiveTexture, urls: (tex: string) => string[]) {
    const build = ++this.builds;
    this.clearMeshes();
    this.unsubscribe?.();
    this.unsubscribe = live.subscribe(() => this.uploadLive(live));
    this.uploadLive(live);

    // faces grouped by texture: one mesh (and one material) per texture
    const groups = new Map<string, ReturnType<typeof modelFaces>>();
    for (const f of modelFaces(model)) {
      const key = f.texture ?? "";
      const list = groups.get(key) ?? [];
      list.push(f);
      groups.set(key, list);
    }
    for (const [key, faces] of groups) {
      const pos = new Float32Array(faces.length * 12);
      const uv = new Float32Array(faces.length * 8);
      const col = new Float32Array(faces.length * 12);
      const idx: number[] = [];
      faces.forEach((f, i) => {
        const tint = f.tinted ? new THREE.Color(tintFor(f.texture)) : new THREE.Color(1, 1, 1);
        for (let k = 0; k < 4; k++) {
          const p = f.corners[k];
          pos.set([p[0] / 16 - 0.5, p[1] / 16 - 0.5, p[2] / 16 - 0.5], (i * 4 + k) * 3);
          // canvas textures are flipped: v = 0 is the bottom row
          uv.set([f.uvs[k][0], 1 - f.uvs[k][1]], (i * 4 + k) * 2);
          col.set([tint.r * f.shade, tint.g * f.shade, tint.b * f.shade], (i * 4 + k) * 3);
        }
        for (const t of QUAD_TRIANGLES) idx.push(i * 4 + t);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
      geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, transparent: true, alphaTest: 0.1, side: THREE.FrontSide,
      });
      if (key === edited) {
        mat.map = this.liveTex;
        mat.visible = this.liveTex !== null;
        this.liveMaterials.push(mat);
      } else if (key === "") {
        mat.map = this.missing;
      } else {
        // shown once loaded; until then the face is left out
        mat.visible = false;
        void this.texture(key, urls).then((t) => {
          if (build !== this.builds || this.disposed) return;
          mat.map = t ?? this.missing;
          mat.visible = true;
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
    this.unsubscribe?.();
    this.clearMeshes();
    this.liveTex?.dispose();
    this.missing.dispose();
    for (const p of this.loaded.values()) void p.then((t) => t?.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
