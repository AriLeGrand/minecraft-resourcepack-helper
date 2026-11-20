// The Scene's 3D view: a small diorama of blocks drawn with three.js, with
// the pack's textures (the game's where the pack has none) and the pixels of
// every open editor tab, unsaved edits included.
//
// One mesh per texture (all faces using it merged), so the whole scene is a
// few dozen draw calls. Nothing runs while the view stands still; every GPU
// object is freed when the view goes away.
import { memo, useEffect, useRef } from "react";
import * as THREE from "three";
import { images, type SceneBlock } from "../lib/api";
import { flatten } from "../editor/doc";
import { shownDoc, useEditor, type Tab } from "../editor/editorStore";
import { bufToCanvas } from "../editor/render";
import { type SceneGrid } from "./grid";
import { lightColor, SKY_COLOR, type TimeOfDay } from "./light";
import { blockData, buildScene, type Batch, type SceneBlockData } from "./sceneMesh";
import { hardPixels, loadFirst, missingTexture } from "./threeTextures";

export type CameraPreset = "orbit" | "first";

export interface SceneViewProps {
  grid: SceneGrid;
  blocks: SceneBlock[];
  packDir: string;
  versionDir: string;
  /** Bumped when pack files changed (images are fetched again). */
  stamp: number;
  time: TimeOfDay;
  level: number;
  ao: boolean;
  /** Selected cell index, or null. */
  selected: number | null;
  onPick: (cell: number | null) => void;
  /** Changing `n` moves the camera to the preset. */
  camera: { preset: CameraPreset; n: number };
  /** Quads drawn / hidden, for the status line. */
  onStats?: (s: { quads: number; culled: number; batches: number }) => void;
}

export const SceneView = memo(function SceneView(p: SceneViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const pickRef = useRef(p.onPick);
  pickRef.current = p.onPick;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const e = new Engine(el, p.packDir, (c) => pickRef.current(c));
    engine.current = e;
    return () => {
      e.dispose();
      engine.current = null;
    };
    // the engine belongs to one pack: a new pack makes a new view
  }, [p.packDir]);

  useEffect(() => {
    engine.current?.setSources(p.versionDir, p.stamp);
  }, [p.versionDir, p.stamp]);

  const { onStats } = p;
  useEffect(() => {
    const s = engine.current?.setScene(p.grid, p.blocks, p.ao);
    if (s) onStats?.(s);
  }, [p.grid, p.blocks, p.ao, onStats]);

  useEffect(() => {
    engine.current?.setLight(p.time, p.level);
  }, [p.time, p.level]);

  useEffect(() => {
    engine.current?.setSelected(p.selected);
  }, [p.selected, p.grid]);

  useEffect(() => {
    engine.current?.cameraPreset(p.camera.preset);
  }, [p.camera]);

  return (
    <div
      ref={host} className="sc-view"
      role="img" aria-label="3D scene. Drag to turn, right-drag to move, wheel to zoom, click a block to select it."
    />
  );
});

interface Orbit {
  yaw: number;
  pitch: number;
  dist: number;
  target: THREE.Vector3;
}

interface LiveEntry {
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  size: string;
  /** What was painted last, to skip unchanged tabs. */
  doc: Tab["doc"] | null;
  preview: Tab["preview"];
}

/** three.js part: renderer, camera, merged meshes, textures, mouse and picking. */
class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.05, 200);
  private group = new THREE.Group();
  private meshes: { mesh: THREE.Mesh; batch: Batch }[] = [];
  private outline: THREE.LineSegments;
  private orbit: Orbit = { yaw: 0, pitch: 0, dist: 10, target: new THREE.Vector3() };
  private grid: SceneGrid | null = null;
  private light = new THREE.Color(1, 1, 1);
  private files = new Map<string, Promise<THREE.Texture | null>>();
  private live = new Map<string, LiveEntry>();
  private used = new Set<string>();
  private missing = missingTexture();
  private versionDir = "";
  private stamp = 0;
  private frame = 0;
  private liveFrame = 0;
  private observer: ResizeObserver;
  private unsubscribe: () => void;
  private disposed = false;
  private presetDone = false;

  constructor(private host: HTMLElement, private packDir: string, private onPick: (cell: number | null) => void) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    const canvas = this.renderer.domElement;
    canvas.className = "sc-canvas";
    host.prepend(canvas);
    this.scene.add(this.group);
    this.outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02)),
      new THREE.LineBasicMaterial({ color: new THREE.Color().setHex(0xffffff, THREE.LinearSRGBColorSpace), depthTest: false, transparent: true }),
    );
    this.outline.renderOrder = 1000;
    this.outline.visible = false;
    this.group.add(this.outline);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    this.resize();
    this.unsubscribe = useEditor.subscribe(() => this.scheduleLive());
    this.bindMouse(canvas);
  }

  private bindMouse(canvas: HTMLCanvasElement) {
    let drag: { x: number; y: number; id: number; pan: boolean; moved: number } | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.button !== 2 && e.button !== 1) return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId, pan: e.button !== 0 || e.shiftKey, moved: 0 };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      drag.x = e.clientX;
      drag.y = e.clientY;
      const o = this.orbit;
      if (drag.pan) {
        // move the target in the screen plane, by the distance at the target
        const k = (o.dist * Math.tan((this.camera.fov * Math.PI) / 360) * 2) / Math.max(1, this.host.clientHeight);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        o.target.addScaledVector(right, -dx * k).addScaledVector(up, dy * k);
      } else {
        o.yaw -= dx * 0.008;
        o.pitch = Math.max(-0.2, Math.min(1.5, o.pitch + dy * 0.008));
      }
      this.render();
    });
    const end = (e: PointerEvent) => {
      if (drag?.id !== e.pointerId) return;
      const click = drag.moved < 4 && !drag.pan;
      drag = null;
      if (click) this.pick(e);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", () => { drag = null; });
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.orbit.dist = Math.max(1.5, Math.min(60, this.orbit.dist * Math.exp(e.deltaY * 0.0012)));
      this.render();
    }, { passive: false });
    canvas.addEventListener("dblclick", () => this.cameraPreset("orbit"));
  }

  private pick(e: PointerEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hits = ray.intersectObjects(this.meshes.filter((m) => m.mesh.visible).map((m) => m.mesh), false);
    for (const h of hits) {
      const entry = this.meshes.find((m) => m.mesh === h.object);
      if (!entry || h.faceIndex === undefined || h.faceIndex === null) continue;
      this.onPick(entry.batch.cells[Math.floor(h.faceIndex / 2)] ?? null);
      return;
    }
    this.onPick(null);
  }

  private resize() {
    const w = Math.max(1, this.host.clientWidth);
    const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
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
    const o = this.orbit;
    const cam = this.camera;
    cam.position.set(
      o.target.x + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist,
      o.target.y + Math.sin(o.pitch) * o.dist,
      o.target.z + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(o.target);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    this.renderer.render(this.scene, cam);
  }

  cameraPreset(preset: CameraPreset) {
    const g = this.grid;
    if (!g) return;
    const span = Math.max(g.width, g.depth, g.height);
    if (preset === "first") {
      // standing on the ground in front of the scene, eyes at 1.62 blocks
      this.orbit = { yaw: 0.35, pitch: 0.06, dist: Math.max(g.width, g.depth) * 0.75 + 2.5, target: new THREE.Vector3(0, 2.62, 0) };
    } else {
      this.orbit = { yaw: Math.PI / 5, pitch: 0.55, dist: span * 1.75 + 2, target: new THREE.Vector3(0, g.height * 0.35, 0) };
    }
    this.render();
  }

  setSources(versionDir: string, stamp: number) {
    if (versionDir === this.versionDir && stamp === this.stamp) return;
    this.versionDir = versionDir;
    this.stamp = stamp;
    // pack files may have changed: fetch every file texture again
    const old = [...this.files.values()];
    this.files.clear();
    for (const m of this.meshes) this.applyTexture(m.mesh.material as THREE.MeshBasicMaterial, m.batch.texture);
    for (const p of old) void p.then((t) => t?.dispose());
  }

  private fileTexture(path: string): Promise<THREE.Texture | null> {
    let p = this.files.get(path);
    if (!p) {
      p = loadFirst([images.packFull(path, this.stamp), images.vanillaFull(this.versionDir, path)]);
      this.files.set(path, p);
    }
    return p;
  }

  /** The editor tab's pixels when the texture is open, else the file's. */
  private applyTexture(mat: THREE.MeshBasicMaterial, path: string | null) {
    if (path === null) {
      mat.map = this.missing;
      mat.visible = true;
      mat.needsUpdate = true;
      return;
    }
    const live = this.live.get(path);
    if (live) {
      mat.map = live.tex;
      mat.visible = true;
      mat.needsUpdate = true;
      this.render();
      return;
    }
    const files = this.files;
    void this.fileTexture(path).then((t) => {
      // replaced meanwhile (new scene, new stamp or now open in the editor)
      if (this.disposed || files !== this.files || this.live.has(path) || !this.meshes.some((m) => m.mesh.material === mat)) return;
      mat.map = t ?? this.missing;
      mat.visible = true;
      mat.needsUpdate = true;
      this.render();
    });
  }

  private scheduleLive() {
    if (this.disposed || this.liveFrame) return;
    this.liveFrame = requestAnimationFrame(() => {
      this.liveFrame = 0;
      this.updateLive();
    });
  }

  /** Paints the open editor tabs whose texture the scene uses. */
  private updateLive() {
    if (this.disposed) return;
    const tabs = useEditor.getState().tabs.filter((t) => t.packDir === this.packDir && this.used.has(t.doc.path));
    const seen = new Set<string>();
    const changed = new Set<string>();
    for (const tab of tabs) {
      const path = tab.doc.path;
      seen.add(path);
      let e = this.live.get(path);
      if (e && e.doc === tab.doc && e.preview === tab.preview) continue;
      const buf = flatten(shownDoc(tab));
      const size = `${buf.w}x${buf.h}`;
      if (!e) {
        const canvas = bufToCanvas(buf);
        e = { canvas, tex: hardPixels(new THREE.CanvasTexture(canvas)), size, doc: tab.doc, preview: tab.preview };
        this.live.set(path, e);
        changed.add(path);
      } else {
        bufToCanvas(buf, e.canvas);
        if (size !== e.size) {
          // a texture cannot change size on the GPU: make a new one
          e.tex.dispose();
          e.tex = hardPixels(new THREE.CanvasTexture(e.canvas));
          e.size = size;
          changed.add(path);
        } else e.tex.needsUpdate = true;
        e.doc = tab.doc;
        e.preview = tab.preview;
      }
    }
    // tabs closed: back to the file
    for (const [path, e] of this.live) {
      if (seen.has(path)) continue;
      this.live.delete(path);
      changed.add(path);
      e.tex.dispose();
    }
    for (const m of this.meshes) {
      if (m.batch.texture !== null && changed.has(m.batch.texture)) this.applyTexture(m.mesh.material as THREE.MeshBasicMaterial, m.batch.texture);
    }
    this.render();
  }

  private clearMeshes() {
    for (const { mesh } of this.meshes) {
      this.group.remove(mesh);
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.meshes = [];
  }

  setScene(grid: SceneGrid, blocks: SceneBlock[], ao: boolean) {
    const sizeChanged = !this.grid || this.grid.width !== grid.width || this.grid.depth !== grid.depth || this.grid.height !== grid.height;
    this.grid = grid;
    this.clearMeshes();
    const data = new Map<string, SceneBlockData>();
    for (const b of blocks) if (b.models.length) data.set(b.id, blockData(b.id, b.models));
    const built = buildScene(grid, data, ao);
    this.group.position.set(-grid.width / 2, 0, -grid.depth / 2);
    this.used = new Set(built.batches.map((b) => b.texture).filter((t): t is string => t !== null));
    built.batches.forEach((batch, i) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(batch.positions, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(batch.uvs, 2));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(batch.colors, 3));
      geo.setIndex(batch.indices);
      geo.computeBoundingSphere();
      const translucent = batch.layer === "translucent";
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.FrontSide, alphaTest: translucent ? 0.01 : 0.1,
        transparent: translucent, depthWrite: !translucent,
      });
      mat.color.copy(this.light);
      // shown once its texture is there
      mat.visible = false;
      const mesh = new THREE.Mesh(geo, mat);
      // overlays (grass sides) after what they cover, see-through ones last
      mesh.renderOrder = (translucent ? 100 : 0) + batch.order * 10 + i * 0.001;
      this.group.add(mesh);
      this.meshes.push({ mesh, batch });
      this.applyTexture(mat, batch.texture);
    });
    this.updateLive();
    if (sizeChanged || !this.presetDone) {
      this.presetDone = true;
      this.cameraPreset("orbit");
    }
    this.render();
    return { quads: built.quads, culled: built.culled, batches: built.batches.length };
  }

  setLight(time: TimeOfDay, level: number) {
    const [r, g, b] = lightColor(level, time);
    this.light.setRGB(r, g, b);
    for (const { mesh } of this.meshes) (mesh.material as THREE.MeshBasicMaterial).color.copy(this.light);
    this.scene.background = new THREE.Color().setHex(SKY_COLOR[time], THREE.LinearSRGBColorSpace);
    this.render();
  }

  setSelected(cell: number | null) {
    const g = this.grid;
    if (cell === null || !g || cell >= g.blocks.length) {
      this.outline.visible = false;
    } else {
      const x = cell % g.width;
      const z = Math.floor(cell / g.width) % g.depth;
      const y = Math.floor(cell / (g.width * g.depth));
      this.outline.position.set(x + 0.5, y + 0.5, z + 0.5);
      this.outline.visible = true;
    }
    this.render();
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.liveFrame);
    this.observer.disconnect();
    this.unsubscribe();
    this.clearMeshes();
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    for (const e of this.live.values()) e.tex.dispose();
    this.live.clear();
    this.missing.dispose();
    for (const p of this.files.values()) void p.then((t) => t?.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
