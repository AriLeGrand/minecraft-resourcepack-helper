// Frame operations and animation settings through the real editor store:
// undo steps, the unsaved flag and what a save sends. Fake Rust side,
// synthetic pixels only.
import { beforeEach, describe, expect, it, vi } from "vitest";

const rust = vi.hoisted(() => ({
  editorOpen: vi.fn(),
  editorSave: vi.fn(),
  loadTextures: vi.fn(),
  closePack: vi.fn(),
  bootstrap: vi.fn(),
  getPack: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  api: rust,
  images: {},
  toError: (e: unknown) => ({ kind: "error", message: String(e), hint: null }),
}));

import type { PackState, RawDoc } from "../lib/api";
import { useApp } from "../store";
import { docOrder, pingPong } from "./anim";
import { pointerDown, pointerUp, resetController, setPreviewScheduler } from "./controller";
import { fromRaw } from "./doc";
import { activeTab, openForTest, useEditor } from "./editorStore";
import { base64ToBytes, getPx } from "./pixels";
import { BLUE, GREEN, opened, RED, solid } from "./testutil";
import { defaultOptions } from "./tools";

const ed = () => useEditor.getState();
const tab = () => activeTab(ed())!;
const doc = () => tab().doc;
const labels = () => tab().history.undo.map((c) => c.label);
const order = () => docOrder(doc()).map((e) => (e.time === null ? e.index : `${e.index}:${e.time}`));
const PACK = { dir: "/pack", project: { name: "Test pack", version_dir: "1.21.4" }, version: null } as unknown as PackState;

function answer(label: string) {
  const modal = useApp.getState().modal;
  if (!modal) throw new Error("no question is open");
  const b = modal.buttons.find((x) => x.label === label);
  if (!b) throw new Error(`no button "${label}"`);
  useApp.getState().closeModal();
  b.run?.();
}

beforeEach(() => {
  resetController();
  setPreviewScheduler(null);
  Object.values(rust).forEach((f) => f.mockReset());
  rust.loadTextures.mockResolvedValue({ rows: [], summary: null });
  rust.editorSave.mockResolvedValue(undefined);
  useApp.setState({ pack: { ...PACK, vanilla_ready: true } as PackState, rows: [], modal: null, toasts: [], screen: "animation" });
  useEditor.setState({ tabs: [], activeId: null, tool: "pencil", options: defaultOptions, fg: RED, bg: BLUE, clipboard: null, text: null });
});

/** A still 2×2 texture filled with one colour. */
const openStill = () => openForTest(fromRaw(opened([[solid(2, 2, GREEN)]], { path: "block/test" })));

describe("frames as undo steps", () => {
  it("adds, duplicates and moves frames, each one step that marks the texture unsaved", () => {
    openStill();
    ed().duplicateFrame();
    expect([doc().frames.length, doc().frameIndex, doc().dirty]).toEqual([2, 1, true]);
    expect(doc().animation?.frametime).toBe(2);
    ed().newFrame();
    expect(doc().frames.length).toBe(3);
    expect(getPx(doc().frames[2].cels[0], 0, 0)).toEqual([0, 0, 0, 0]);
    ed().moveFrame(-1);
    expect(doc().frameIndex).toBe(1);
    expect(getPx(doc().frames[1].cels[0], 0, 0)).toEqual([0, 0, 0, 0]);
    expect(labels()).toEqual(["Duplicate frame", "New frame", "Move frame left"]);

    ed().undo();
    ed().undo();
    ed().undo();
    expect([doc().frames.length, doc().animation, doc().frameIndex]).toEqual([1, null, 0]);
    expect(doc().dirty).toBe(true);
    ed().redo();
    expect(doc().frames.length).toBe(2);
  });

  it("draws on the frame that is selected, and undo of the drawing finds that frame again", () => {
    openStill();
    ed().newFrame();
    ed().selectFrame(1);
    pointerDown({ p: [0, 0], button: 0, shift: false, alt: false });
    pointerUp({ p: [0, 0], button: 0, shift: false, alt: false });
    expect(getPx(doc().frames[1].cels[0], 0, 0)).toEqual(RED);
    expect(getPx(doc().frames[0].cels[0], 0, 0)).toEqual(GREEN);
    ed().selectFrame(0);
    ed().undo();
    expect(doc().frameIndex).toBe(1);
    expect(getPx(doc().frames[1].cels[0], 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it("undo of a frame step keeps the lock a layer has now", () => {
    openStill();
    ed().newFrame();
    ed().patchLayer(0, { locked: true });
    ed().undo();
    expect(doc().frames.length).toBe(1);
    expect(doc().layers[0].locked).toBe(true);
  });

  it("asks before deleting a frame with pixels, and not for an empty one", () => {
    openStill();
    ed().newFrame();
    ed().deleteFrame();
    expect(useApp.getState().modal).toBeNull();
    expect(doc().frames.length).toBe(1);
    ed().duplicateFrame();
    ed().deleteFrame();
    expect(useApp.getState().modal?.title).toBe("Delete frame 2?");
    answer("Cancel");
    expect(doc().frames.length).toBe(2);
    ed().deleteFrame();
    answer("Delete frame");
    expect(doc().frames.length).toBe(1);
    ed().deleteFrame();
    expect(doc().frames.length).toBe(1);
  });
});

describe("animation settings", () => {
  it("frame time, smoothing, order and durations are undo steps; nothing changes when the value is the same", () => {
    openStill();
    ed().duplicateFrame();
    ed().duplicateFrame();
    ed().setFrametime(3);
    ed().setFrametime(3);
    ed().setInterpolate(true);
    ed().setOrder(pingPong(3).map((index) => ({ index, time: null })), "Ping-pong");
    ed().setFrameTime(1, 6);
    expect(labels()).toEqual(["Duplicate frame", "Duplicate frame", "Frame time", "Smooth between frames", "Ping-pong", "Frame duration"]);
    expect(order()).toEqual([0, "1:6", 2, "1:6"]);
    expect([doc().animation?.frametime, doc().animation?.interpolate]).toEqual([3, true]);
    ed().undo();
    ed().undo();
    expect(order()).toEqual([0, 1, 2]);
    expect(doc().animation?.frames).toBeNull();
  });

  it("a save sends the frames, the durations and the play order", async () => {
    openStill();
    ed().newFrame();
    ed().setOrder([{ index: 1, time: 4 }, { index: 0, time: null }]);
    expect(await ed().save()).toBe(true);
    const [path, raw, flat] = rust.editorSave.mock.calls[0] as [string, RawDoc, string];
    expect(path).toBe("block/test");
    expect(raw.frames.length).toBe(2);
    expect(raw.animation).toEqual({ frametime: 2, interpolate: false, frames: [{ index: 1, time: 4 }, { index: 0, time: null }], width: null, height: null });
    // the flattened strip is 2×4: frame 0 green on top, frame 1 empty below
    const bytes = base64ToBytes(flat);
    expect(bytes.length).toBe(2 * 4 * 4);
    expect([...bytes.slice(0, 4)]).toEqual(GREEN);
    expect([...bytes.slice(16, 20)]).toEqual([0, 0, 0, 0]);
    expect(doc().dirty).toBe(false);
  });
});

describe("import strip", () => {
  it("frames of the texture's size go into the active layer at once", () => {
    openStill();
    ed().importFrames([solid(2, 2, RED), solid(2, 2, BLUE)], "strip.png");
    expect(useApp.getState().modal).toBeNull();
    expect(doc().frames.map((f) => getPx(f.cels[0], 1, 1))).toEqual([RED, BLUE]);
    expect(labels()).toEqual(["Import strip"]);
    ed().undo();
    expect(doc().frames.length).toBe(1);
  });

  it("frames of another size are only imported after asking, as one undo step", () => {
    openStill();
    ed().importFrames([solid(4, 4, RED), solid(4, 4, BLUE), solid(4, 4, GREEN)], "strip.png");
    expect(useApp.getState().modal?.title).toBe("Replace the frames with 4×4 frames?");
    answer("Cancel");
    expect([doc().width, doc().frames.length]).toEqual([2, 1]);
    ed().importFrames([solid(4, 4, RED), solid(4, 4, BLUE), solid(4, 4, GREEN)], "strip.png");
    answer("Replace frames");
    expect([doc().width, doc().height, doc().frames.length, doc().layers.length]).toEqual([4, 4, 3, 1]);
    expect(tab().view).toBeNull();
    ed().undo();
    expect([doc().width, doc().height, doc().frames.length]).toEqual([2, 2, 1]);
    expect(getPx(doc().frames[0].cels[0], 0, 0)).toEqual(GREEN);
  });
});
