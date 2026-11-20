import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => import("./fakeClipboard"));

import { fake } from "./fakeClipboard";
import { newBuf, setPx } from "./pixels";
import {
  choosePaste, externalClip, externalOrigin, externalPasteStatus, imageToBuf, isNoImage, readForPaste, readSystemImage,
  resetSystemClipboard, sameBuf, writeSystemImage,
} from "./sysClipboard";
import { art, bufFrom, GREEN, RED } from "./testutil";

beforeEach(() => {
  fake.reset();
  resetSystemClipboard();
});

describe("imageToBuf", () => {
  it("keeps the RGBA exactly, alpha included", () => {
    const rgba = Uint8Array.from([255, 0, 0, 255, 10, 20, 30, 128, 0, 0, 0, 0, 1, 2, 3, 4]);
    const b = imageToBuf(rgba, 2, 2);
    expect([b.w, b.h]).toEqual([2, 2]);
    expect(Array.from(b.data)).toEqual(Array.from(rgba));
  });

  it("takes an image whose alpha bytes are all unused (0) as opaque", () => {
    const b = imageToBuf(Uint8Array.from([255, 0, 0, 0, 0, 0, 0, 0]), 2, 1);
    expect(Array.from(b.data)).toEqual([255, 0, 0, 255, 0, 0, 0, 255]);
  });

  it("leaves a fully transparent black image transparent", () => {
    expect(Array.from(imageToBuf(new Uint8Array(8), 2, 1).data)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("refuses a size that does not match the bytes", () => {
    expect(() => imageToBuf(new Uint8Array(12), 2, 2)).toThrow(/damaged/);
    expect(() => imageToBuf(new Uint8Array(0), 0, 0)).toThrow(/no size/);
  });
});

describe("choosePaste", () => {
  const internal = { x: 3, y: 1, buf: bufFrom(["#"]) };
  const mine = bufFrom(["#"]);

  it("prefers a newer image from another program", () => {
    const other = bufFrom(["##"]);
    expect(choosePaste(other, mine, internal)).toEqual({ kind: "external", buf: other });
  });

  it("uses the app's own clipboard (with its position) when Windows still holds what the app copied", () => {
    expect(choosePaste(bufFrom(["#"]), mine, internal)).toEqual({ kind: "internal", clip: internal });
  });

  it("uses the app's own clipboard when Windows has no image", () => {
    expect(choosePaste(null, mine, internal)).toEqual({ kind: "internal", clip: internal });
  });

  it("pastes an outside image even when it equals what was copied, if nothing is copied inside", () => {
    expect(choosePaste(mine, mine, null).kind).toBe("external");
  });

  it("has nothing to paste with neither", () => {
    expect(choosePaste(null, null, null)).toEqual({ kind: "none" });
  });

  it("compares sizes and pixels", () => {
    expect(sameBuf(bufFrom(["#."]), bufFrom(["#."]))).toBe(true);
    expect(sameBuf(bufFrom(["#."]), bufFrom([".#"]))).toBe(false);
    expect(sameBuf(bufFrom(["#."]), bufFrom(["#", "."]))).toBe(false);
    expect(sameBuf(null, bufFrom(["#"]))).toBe(false);
  });
});

describe("placement", () => {
  it("lands at the top-left pixel in view", () => {
    // zoomed in 10×, the texture's corner is 35 px left of and 12 px above the canvas
    expect(externalOrigin({ zoom: 10, panX: -35, panY: -12 }, 16, 16)).toEqual([3, 1]);
  });

  it("lands at 0,0 when the whole texture is in view", () => {
    expect(externalOrigin({ zoom: 8, panX: 40, panY: 30 }, 16, 16)).toEqual([0, 0]);
  });

  it("stays on the texture when panned past it", () => {
    expect(externalOrigin({ zoom: 1, panX: -500, panY: -500 }, 16, 16)).toEqual([15, 15]);
  });

  it("never resizes the image", () => {
    const big = newBuf(40, 20);
    const clip = externalClip(big, { zoom: 8, panX: 0, panY: 0 }, 16, 16);
    expect([clip.x, clip.y, clip.buf]).toEqual([0, 0, big]);
  });

  it("says when the image is bigger than the texture", () => {
    expect(externalPasteStatus(newBuf(32, 8), 16, 16)).toMatch(/32×8 .*bigger than this 16×16 texture/);
    expect(externalPasteStatus(newBuf(8, 8), 16, 16)).not.toMatch(/bigger/);
  });
});

describe("plugin wrappers", () => {
  it("writes raw RGBA and reads it back exactly", async () => {
    const b = newBuf(2, 1);
    setPx(b, 0, 0, RED);
    setPx(b, 1, 0, [GREEN[0], GREEN[1], GREEN[2], 77]);
    expect(await writeSystemImage(b)).toBeNull();
    const r = await readSystemImage();
    expect(r.error).toBeNull();
    expect(Array.from(r.buf!.data)).toEqual(Array.from(b.data));
  });

  it("remembers what it wrote, so Paste can tell it from another program's image", async () => {
    const b = bufFrom(["#."]);
    void writeSystemImage(b);
    // read right after: waits for the write to land
    const r = await readForPaste();
    expect(sameBuf(r.buf, r.mine)).toBe(true);
    fake.put([1, 2, 3, 255], 1, 1);
    const r2 = await readForPaste();
    expect(sameBuf(r2.buf, r2.mine)).toBe(false);
  });

  it("reports a refused write, and the image already there no longer counts as newer", async () => {
    fake.put([1, 2, 3, 255], 1, 1);
    fake.writeError = "access denied";
    expect(await writeSystemImage(bufFrom(["#"]))).toBe("access denied");
    const r = await readForPaste();
    expect(choosePaste(r.buf, r.mine, { x: 0, y: 0, buf: bufFrom(["#"]) }).kind).toBe("internal");
  });

  it("an empty clipboard is no image, not an error", async () => {
    expect(await readSystemImage()).toEqual({ buf: null, error: null });
    expect(isNoImage("The clipboard contents were not available in the requested format or the clipboard is empty.")).toBe(true);
    expect(isNoImage("Conversion failure")).toBe(false);
  });

  it("a damaged image is an error", async () => {
    fake.image = { rgba: new Uint8Array(3), width: 1, height: 1 };
    const r = await readSystemImage();
    expect(r.buf).toBeNull();
    expect(r.error).toMatch(/damaged/);
  });

  it("keeps the copied pixels even if the caller changes its buffer afterwards", async () => {
    const b = bufFrom(["#"]);
    const job = writeSystemImage(b);
    b.data.fill(0);
    await job;
    expect(art((await readSystemImage()).buf!)).toEqual(["#"]);
  });
});
