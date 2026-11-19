// Animation logic with exact numbers. Synthetic pixels only.
import { describe, expect, it } from "vitest";
import type { Animation } from "../lib/api";
import {
  blendFrames, defaultAnimation, deleteFrame, docOrder, duplicateFrame, entryStart, formatOrder, frameAt, imageTicks, imageTime,
  importReplacing, importSameSize, insertFrame, loopLabel, loopTicks, moveFrame, newFrame, orderKind, parseOrder, pingPong,
  playOrder, secondsLabel, setImageTime, splitStrip, withOrder, type Entry,
} from "./anim";
import { fromRaw, type EditorDoc } from "./doc";
import { getPx, newBuf, setPx, stackFrames, type Buf, type Rgba } from "./pixels";
import { BLUE, GREEN, opened, RED, solid } from "./testutil";

const e = (index: number, time: number | null = null): Entry => ({ index, time });
const anim = (patch: Partial<Animation> = {}): Animation => ({ ...defaultAnimation(), ...patch });
const order = (doc: EditorDoc) => docOrder(doc).map((x) => (x.time === null ? x.index : `${x.index}:${x.time}`));

/** A document of `n` frames, frame i filled with grey level i * 10 (so frames can be told apart). */
function framesDoc(n: number, animation: Animation | null = n > 1 ? anim() : null): EditorDoc {
  const frames = Array.from({ length: n }, (_, i) => [solid(2, 2, [i * 10, i * 10, i * 10, 255])]);
  const d = fromRaw(opened(frames, { doc: { animation } as never }));
  return { ...d, animation };
}
const grey = (doc: EditorDoc, frame: number) => getPx(doc.frames[frame].cels[0], 0, 0)[0] / 10;
const greys = (doc: EditorDoc) => doc.frames.map((_, i) => grey(doc, i));

describe("play order", () => {
  it("is every image in order when there is no list, with the images' own times", () => {
    expect(playOrder(null, [null, 5, null])).toEqual([e(0), e(1, 5), e(2)]);
    expect(playOrder(anim({ frames: [e(2), e(0, 3)] }), [null, null, null])).toEqual([e(2), e(0, 3)]);
  });

  it("ping-pong goes forward then back without repeating the ends", () => {
    expect(pingPong(6)).toEqual([0, 1, 2, 3, 4, 5, 4, 3, 2, 1]);
    expect(pingPong(2)).toEqual([0, 1]);
    expect(pingPong(1)).toEqual([0]);
  });

  it("knows its preset", () => {
    expect(orderKind(null, 3)).toBe("inOrder");
    expect(orderKind(anim({ frames: [e(0), e(1), e(2)] }), 3)).toBe("inOrder");
    expect(orderKind(anim({ frames: pingPong(4).map((i) => e(i)) }), 4)).toBe("pingPong");
    expect(orderKind(anim({ frames: [e(0), e(1), e(0), e(2)] }), 3)).toBe("custom");
  });

  it("parses and formats a typed order, checked against the frame count", () => {
    expect(parseOrder("0, 1, 0, 2", 3)).toEqual({ ok: true, entries: [e(0), e(1), e(0), e(2)] });
    expect(parseOrder("0 1;2:5", 3)).toEqual({ ok: true, entries: [e(0), e(1), e(2, 5)] });
    expect(formatOrder([e(0), e(2, 5)])).toBe("0, 2:5");
    const bad = parseOrder("0, 3", 3);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toBe("There is no frame 3: this texture has 3 frames, numbered 0 to 2.");
    expect(parseOrder("", 3).ok).toBe(false);
    expect(parseOrder("a", 3).ok).toBe(false);
    expect(parseOrder("1:0", 3).ok).toBe(false);
  });
});

describe("timing", () => {
  const pp = pingPong(6).map((i) => e(i));

  it("adds up the loop: 10 entries of 2 ticks are 20 ticks = 1.0 s", () => {
    expect(loopTicks(pp, 2)).toBe(20);
    expect(loopLabel(20)).toBe("1.0");
    expect(loopLabel(6)).toBe("0.30");
    expect(secondsLabel(2)).toBe("0.10");
    expect(loopTicks([e(0, 5), e(1)], 3)).toBe(8);
  });

  it("finds the entry and image shown at a tick, looping", () => {
    expect(frameAt(pp, 2, 0, true, false)).toMatchObject({ entry: 0, image: 0, sub: 0, ticks: 2 });
    expect(frameAt(pp, 2, 1, true, false)).toMatchObject({ entry: 0, image: 0, sub: 1 });
    expect(frameAt(pp, 2, 2, true, false)).toMatchObject({ entry: 1, image: 1, sub: 0 });
    expect(frameAt(pp, 2, 13, true, false)).toMatchObject({ entry: 6, image: 4, sub: 1 });
    expect(frameAt(pp, 2, 20, true, false)).toMatchObject({ entry: 0, image: 0, ended: false });
    expect(frameAt(pp, 2, 39, true, false)).toMatchObject({ entry: 9, image: 1, sub: 1 });
  });

  it("uses each entry's own duration", () => {
    const list = [e(0, 5), e(1), e(2, 1)];
    expect(frameAt(list, 3, 4, true, false)).toMatchObject({ entry: 0, sub: 4, ticks: 5 });
    expect(frameAt(list, 3, 5, true, false)).toMatchObject({ entry: 1, sub: 0, ticks: 3 });
    expect(frameAt(list, 3, 8, true, false)).toMatchObject({ entry: 2, sub: 0, ticks: 1 });
    expect(frameAt(list, 3, 9, true, false)).toMatchObject({ entry: 0, sub: 0 });
    expect(entryStart(list, 3, 2)).toBe(8);
  });

  it("stops on the last entry when not looping", () => {
    expect(frameAt(pp, 2, 19, false, false)).toMatchObject({ entry: 9, sub: 1, ended: false });
    expect(frameAt(pp, 2, 20, false, false)).toMatchObject({ entry: 9, image: 1, sub: 1, ended: true });
    expect(frameAt(pp, 2, 500, false, true)).toMatchObject({ entry: 9, next: null, ended: true });
  });

  it("blends into the next entry's image when interpolating (the last one into the first)", () => {
    expect(frameAt(pp, 2, 1, true, true)).toMatchObject({ image: 0, next: 1, sub: 1, ticks: 2 });
    expect(frameAt(pp, 2, 19, true, true)).toMatchObject({ image: 1, next: 0 });
    // the same image twice in a row is not blended
    expect(frameAt([e(0), e(0), e(1)], 1, 0, true, true).next).toBeNull();
    expect(frameAt(pp, 2, 1, true, false).next).toBeNull();
  });

  it("mixes colour like the game: d = 1 - sub/ticks, cut to whole numbers, alpha of the current image", () => {
    const a = solid(1, 1, [200, 100, 0, 255]);
    const b = solid(1, 1, [0, 51, 255, 40]);
    expect([...blendFrames(a, b, 0, 4).data]).toEqual([200, 100, 0, 255]);
    // d = 0.75: 150, 75 + 12.75 = 87.75 -> 87, 63.75 -> 63
    expect([...blendFrames(a, b, 1, 4).data]).toEqual([150, 87, 63, 255]);
    // d = 1/3: 66.66 -> 66, 33.33 + 34 = 67.33 -> 67, 170
    expect([...blendFrames(a, b, 2, 3).data]).toEqual([66, 67, 170, 255]);
  });
});

describe("durations", () => {
  it("are stored with the images while the order is 'every image in order'", () => {
    let d = framesDoc(3, anim({ frametime: 2 }));
    d = setImageTime(d, 1, 6);
    expect(d.frames.map((f) => f.time)).toEqual([null, 6, null]);
    expect(d.animation?.frames).toBeNull();
    expect(imageTicks(d, 0)).toBe(2);
    expect(imageTicks(d, 1)).toBe(6);
  });

  it("are stored on every entry of the image when there is a list", () => {
    let d = framesDoc(3, anim({ frames: [e(0), e(1), e(0)] }));
    d = setImageTime(d, 0, 4);
    expect(order(d)).toEqual(["0:4", 1, "0:4"]);
    expect(imageTime(d, 0)).toBe(4);
    d = setImageTime(d, 0, null);
    expect(order(d)).toEqual([0, 1, 0]);
  });

  it("travel with the order when it changes", () => {
    let d = setImageTime(framesDoc(3), 1, 7);
    d = withOrder(d, pingPong(3).map((i) => e(i)));
    expect(order(d)).toEqual([0, "1:7", 2, "1:7"]);
    expect(d.frames.map((f) => f.time)).toEqual([null, null, null]);
    d = withOrder(d, null);
    expect(d.animation?.frames).toBeNull();
    expect(d.frames.map((f) => f.time)).toEqual([null, 7, null]);
    expect(withOrder(d, []).animation?.frames).toBeNull();
  });
});

describe("frame operations keep the play order consistent", () => {
  it("a new frame goes after the current one and becomes current", () => {
    const d = newFrame({ ...framesDoc(3), frameIndex: 1 });
    expect(d.frames.length).toBe(4);
    expect(d.frameIndex).toBe(2);
    expect(getPx(d.frames[2].cels[0], 0, 0)).toEqual([0, 0, 0, 0]);
    expect(greys(d).filter((_, i) => i !== 2)).toEqual([0, 1, 2]);
    expect(d.dirty).toBe(true);
  });

  it("a still texture that gets a second frame becomes animated with frame time 2", () => {
    const d = duplicateFrame(framesDoc(1, null));
    expect(d.frames.length).toBe(2);
    expect(d.animation).toEqual(defaultAnimation());
    expect(d.animation?.frametime).toBe(2);
  });

  it("renumbers a custom order when a frame is inserted, and plays the new frame after its neighbour", () => {
    const d = duplicateFrame({ ...framesDoc(3, anim({ frames: [e(0), e(2, 4), e(1), e(0)] })), frameIndex: 1 });
    // the copy of image 1 is image 2; the old image 2 is now 3
    expect(greys(d)).toEqual([0, 1, 1, 2]);
    expect(order(d)).toEqual([0, "3:4", 1, 2, 0]);
    expect(d.frameIndex).toBe(2);
  });

  it("keeps a ping-pong a ping-pong", () => {
    const d = newFrame({ ...framesDoc(3, anim({ frames: pingPong(3).map((i) => e(i)) })), frameIndex: 2 });
    expect(order(d)).toEqual([0, 1, 2, 3, 2, 1]);
    const del = deleteFrame(d, 3);
    expect(order(del)).toEqual([0, 1, 2, 1]);
  });

  it("an explicit 0..n-1 list stays 0..n-1", () => {
    const d = insertFrame(framesDoc(2, anim({ frames: [e(0), e(1, 3)] })), 1, { cels: [newBuf(2, 2)], time: null });
    expect(order(d)).toEqual([0, 1, "2:3"]);
  });

  it("deleting a frame removes its entries and renumbers the rest", () => {
    const d = deleteFrame({ ...framesDoc(4, anim({ frames: [e(3), e(1), e(2, 5), e(1), e(0)] })), frameIndex: 3 }, 1);
    expect(greys(d)).toEqual([0, 2, 3]);
    expect(order(d)).toEqual([2, "1:5", 0]);
    expect(d.frameIndex).toBe(2);
  });

  it("an order left empty falls back to every image in order", () => {
    const d = deleteFrame(framesDoc(3, anim({ frames: [e(1), e(1)] })), 1);
    expect(d.animation?.frames).toBeNull();
    expect(order(d)).toEqual([0, 1]);
  });

  it("the last frame cannot be deleted", () => {
    const d = framesDoc(1, null);
    expect(deleteFrame(d, 0)).toBe(d);
  });

  it("moving a frame changes the play order when it is 'in order'", () => {
    const d = moveFrame(setImageTime(framesDoc(3), 0, 4), 0, 1);
    expect(greys(d)).toEqual([1, 0, 2]);
    expect(d.frames.map((f) => f.time)).toEqual([null, 4, null]);
    expect(d.frameIndex).toBe(1);
    expect(moveFrame(d, 0, -1)).toBe(d);
    expect(moveFrame(d, 2, 1)).toBe(d);
  });

  it("moving a frame keeps a custom order showing the same pictures", () => {
    const d = moveFrame(framesDoc(3, anim({ frames: [e(0), e(2), e(0, 3)] })), 1, 1);
    expect(greys(d)).toEqual([0, 2, 1]);
    expect(order(d)).toEqual([0, 1, "0:3"]);
    expect(docOrder(d).map((x) => grey(d, x.index))).toEqual([0, 2, 0]);
  });
});

describe("strips", () => {
  const strip = (w: number, colors: Rgba[], fh = w) => stackFrames(colors.map((c) => solid(w, fh, c)));

  it("cuts a strip into square frames by default, pixel-exact", () => {
    const img = strip(2, [RED, GREEN, BLUE]);
    setPx(img, 1, 5, [1, 2, 3, 4]);
    const s = splitStrip(img);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(s.frames.length).toBe(3);
    expect(s.frameHeight).toBe(2);
    expect(getPx(s.frames[1], 0, 0)).toEqual(GREEN);
    expect(getPx(s.frames[2], 1, 1)).toEqual([1, 2, 3, 4]);
    expect(s.frames.every((f: Buf) => f.w === 2 && f.h === 2)).toBe(true);
  });

  it("takes another frame height when asked", () => {
    const s = splitStrip(strip(4, [RED, GREEN], 2), 2);
    expect(s.ok && s.frames.length).toBe(2);
  });

  it("refuses a height that is not a whole number of frames", () => {
    const s = splitStrip(newBuf(16, 50));
    expect(s.ok).toBe(false);
    expect(!s.ok && s.error).toBe(
      "The image is 16×50: its height is not a whole number of 16-pixel frames (3 frames use 48 rows, 2 are left over). " +
      "Make the image a multiple of 16 pixels tall, or choose another frame height.",
    );
    expect(splitStrip(newBuf(16, 8)).ok).toBe(false);
    expect(splitStrip(newBuf(16, 16), 0).ok).toBe(false);
  });

  it("a strip of the document's size goes into the active layer and adds frames", () => {
    const d = importSameSize(framesDoc(1, null), [solid(2, 2, RED), solid(2, 2, GREEN), solid(2, 2, BLUE)]);
    expect(d.frames.length).toBe(3);
    expect(d.frames.map((f) => getPx(f.cels[0], 0, 0))).toEqual([RED, GREEN, BLUE]);
    expect(d.animation?.frametime).toBe(2);
  });

  it("a strip of another size replaces frames and layers at its own size", () => {
    const base = { ...framesDoc(3, anim({ frames: [e(2), e(0)] })), vanilla: solid(1, 1, RED) };
    const d = importReplacing(base, [solid(4, 4, GREEN), solid(4, 4, BLUE)]);
    expect([d.width, d.height, d.layers.length, d.frames.length]).toEqual([4, 4, 1, 2]);
    expect(d.layers[0].name).toBe("Imported");
    expect(getPx(d.frames[1].cels[0], 3, 3)).toEqual(BLUE);
    // the order used frame 2, which no longer exists
    expect(d.animation?.frames).toBeNull();
    expect(d.reference?.w).toBe(4);
    expect(d.selection).toBeNull();
  });
});
