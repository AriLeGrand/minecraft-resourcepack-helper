// The pack palette in the editor's palette panel: a palette shared by every
// texture of the pack, saved in the project file (through Rust). Editable
// when "Pack palette" is the panel's source; shown as a small strip otherwise.
import { Icon } from "../components/Icon";
import { api } from "../lib/api";
import { useApp } from "../store";
import { flatten } from "./doc";
import { activeTab, useEditor } from "./editorStore";
import { addColour, fillFrom, MAX_PACK_COLOURS, moveColour, removeColour, SUGGESTED_MIN } from "./packPalette";
import { extractPalette, hexToRgba, rgbaToHex } from "./pixels";

const EMPTY: string[] = [];

export const usePackPalette = () => useApp((s) => s.pack?.project.pack_palette ?? EMPTY);

/** Saves the pack palette. `undoText` adds an Undo to the toast that puts the old list back. */
async function save(next: string[], status: string, undoText?: string) {
  const app = useApp.getState();
  const before = app.pack?.project.pack_palette ?? [];
  try {
    app.setPack(await api.updateProject({ pack_palette: next }));
    if (undoText) {
      app.toast(status, "ok", {
        label: "Undo",
        run: () => void api.updateProject({ pack_palette: before }).then((p) => { useApp.getState().setPack(p); useApp.getState().setStatus(undoText); }),
      });
    } else {
      app.setStatus(status);
    }
  } catch (e) {
    app.showError(e, "The pack palette could not be saved");
  }
}

function Swatches({ colours, small }: { colours: string[]; small?: boolean }) {
  const fg = useEditor((s) => s.fg);
  const bg = useEditor((s) => s.bg);
  const setColor = useEditor((s) => s.setColor);
  const fgHex = rgbaToHex([fg[0], fg[1], fg[2], 255]);
  const bgHex = rgbaToHex([bg[0], bg[1], bg[2], 255]);
  return (
    <div className={`ed-swatches ${small ? "pp-small" : ""}`}>
      {colours.map((hex) => (
        <button
          key={hex}
          title={`${hex.toUpperCase()} · pack palette · click: foreground, right-click: background`}
          aria-label={`Pack colour ${hex}`}
          className={`${hex === fgHex ? "fg" : ""} ${hex === bgHex ? "bg" : ""}`}
          style={{ background: hex }}
          onClick={() => { const c = hexToRgba(hex); if (c) setColor("fg", c); }}
          onContextMenu={(e) => { e.preventDefault(); const c = hexToRgba(hex); if (c) setColor("bg", c); }}
        />
      ))}
    </div>
  );
}

/** The editable pack palette (palette source "Pack palette"). */
export function PackPaletteEditor() {
  const colours = usePackPalette();
  const fg = useEditor((s) => s.fg);
  const fgHex = rgbaToHex([fg[0], fg[1], fg[2], 255]);
  const selected = colours.includes(fgHex) ? fgHex : null;
  const full = colours.length >= MAX_PACK_COLOURS;
  const fill = () => {
    const doc = activeTab(useEditor.getState())?.doc;
    if (!doc) return;
    const next = fillFrom(extractPalette(flatten(doc), MAX_PACK_COLOURS));
    if (next.length === 0) {
      useApp.getState().toast("This texture has no visible colours to take.", "warn");
      return;
    }
    void save(next, `Pack palette filled with ${next.length} colours of this texture.`, "Pack palette put back as it was.");
  };
  return (
    <>
      <div className="pp-tools" role="toolbar" aria-label="Pack palette">
        <button
          title={full ? `The pack palette is full (${MAX_PACK_COLOURS} colours)` : "Add the foreground colour to the pack palette"}
          disabled={full || !!selected}
          onClick={() => void save(addColour(colours, fg), `Added ${fgHex.toUpperCase()} to the pack palette.`)}
        >
          <Icon name="plus" size={12} width={2} /> Add
        </button>
        <button title="Remove the selected colour (the foreground colour) from the pack palette" disabled={!selected} onClick={() => selected && void save(removeColour(colours, selected), `Removed ${selected.toUpperCase()} from the pack palette.`, "Colour put back.")}>
          <Icon name="trash" size={12} width={2} />
        </button>
        <button aria-label="Move the selected colour left" title="Move the selected colour left" disabled={!selected || colours[0] === selected} onClick={() => selected && void save(moveColour(colours, selected, -1), "Pack palette reordered.")}>
          <Icon name="prev" size={12} width={2} />
        </button>
        <button aria-label="Move the selected colour right" title="Move the selected colour right" disabled={!selected || colours[colours.length - 1] === selected} onClick={() => selected && void save(moveColour(colours, selected, 1), "Pack palette reordered.")}>
          <Icon name="next" size={12} width={2} />
        </button>
        <span className="grow" />
        <button title="Replace the pack palette with the most used colours of this texture (Undo in the message)" onClick={fill}>Fill from this texture</button>
      </div>
      {colours.length === 0 ? (
        <div className="dim" style={{ fontSize: 11 }}>
          The pack palette is empty. Pick a colour and press Add, or fill it from this texture. It is shared by every texture of the pack;
          “Snap to pack palette” in the tool options then keeps every drawn colour inside it.
        </div>
      ) : (
        <>
          <Swatches colours={colours} />
          <div className="dim" style={{ fontSize: 11 }}>
            {colours.length} of {MAX_PACK_COLOURS} colours{colours.length < SUGGESTED_MIN ? ` · pack palettes usually have ${SUGGESTED_MIN} or more` : ""}. Click a colour to select it.
          </div>
        </>
      )}
    </>
  );
}

/** The pack palette as a small strip under another palette source. */
export function PackPaletteStrip() {
  const colours = usePackPalette();
  if (colours.length === 0) return null;
  return (
    <div className="pp-strip">
      <span className="caps">Pack palette</span>
      <Swatches colours={colours} small />
    </div>
  );
}
