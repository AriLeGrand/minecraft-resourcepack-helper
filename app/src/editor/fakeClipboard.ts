// Test double of @tauri-apps/plugin-clipboard-manager: an in-memory Windows
// clipboard. Use with
//   vi.mock("@tauri-apps/plugin-clipboard-manager", () => import("./fakeClipboard"));
// Only the image calls the editor uses are faked.

export const fake = {
  image: null as { rgba: Uint8Array; width: number; height: number } | null,
  /** When set, writeImage fails with this message. */
  writeError: null as string | null,
  writes: 0,
  reset() {
    fake.image = null;
    fake.writeError = null;
    fake.writes = 0;
  },
  /** Another program copies an image. */
  put(rgba: number[] | Uint8Array, width: number, height: number) {
    fake.image = { rgba: Uint8Array.from(rgba), width, height };
  },
};

export async function writeImage(image: unknown) {
  if (fake.writeError) throw fake.writeError;
  const { rgba, width, height } = image as { rgba: number[]; width: number; height: number };
  if (!Array.isArray(rgba)) throw new Error("expected RGBA as a plain array");
  fake.writes++;
  fake.put(rgba, width, height);
}

export async function readImage() {
  const img = fake.image;
  // the plugin's message when there is no image (arboard ContentNotAvailable)
  if (!img) throw "The clipboard contents were not available in the requested format or the clipboard is empty.";
  return {
    rgba: async () => img.rgba.slice(),
    size: async () => ({ width: img.width, height: img.height }),
    close: async () => {},
  };
}

export async function writeText() {}
