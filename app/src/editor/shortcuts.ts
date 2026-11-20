// Keyboard shortcuts of the editor (Aseprite-like). Pure: a key press goes
// in, the action it stands for comes out.
import { toolForKey, type ToolId } from "./tools";

export interface KeyPress {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export type Shortcut =
  | { do: "tool"; tool: ToolId }
  | { do: "undo" | "redo" | "save" | "selectAll" | "deselect" | "delete" | "copy" | "cut" | "paste" | "swap" | "commit" | "cancel" }
  | { do: "size"; delta: 1 | -1 }
  | { do: "zoom"; delta: 1 | -1 }
  | { do: "fit" }
  | { do: "frame"; delta: 1 | -1 };

/** The action for a key press, or `null` when the editor has none for it. */
export function shortcutFor(k: KeyPress): Shortcut | null {
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (k.alt) return null;
  if (k.ctrl) {
    switch (key) {
      case "z": return { do: k.shift ? "redo" : "undo" };
      case "y": return k.shift ? null : { do: "redo" };
      case "s": return k.shift ? null : { do: "save" };
      case "a": return k.shift ? null : { do: "selectAll" };
      case "d": return k.shift ? null : { do: "deselect" };
      case "c": return k.shift ? null : { do: "copy" };
      case "x": return k.shift ? null : { do: "cut" };
      case "v": return k.shift ? null : { do: "paste" };
      case "0": return { do: "fit" };
      default: return null;
    }
  }
  switch (key) {
    case "Delete":
    case "Backspace": return { do: "delete" };
    case "Enter": return { do: "commit" };
    case "Escape": return { do: "cancel" };
    case "ArrowLeft": return { do: "frame", delta: -1 };
    case "ArrowRight": return { do: "frame", delta: 1 };
    case "[": return { do: "size", delta: -1 };
    case "]": return { do: "size", delta: 1 };
    case "+":
    case "=": return { do: "zoom", delta: 1 };
    case "-":
    case "_": return { do: "zoom", delta: -1 };
    default: break;
  }
  if (key === "x" && !k.shift) return { do: "swap" };
  const tool = key.length === 1 ? toolForKey(key, k.shift) : null;
  return tool ? { do: "tool", tool } : null;
}

/** Shortcuts must not fire while the user types in a field. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    // checkboxes and sliders take no text: shortcuts keep working after a click on them
    const t = (el.type ?? "text").toLowerCase();
    return t !== "checkbox" && t !== "radio" && t !== "range" && t !== "button";
  }
  return el.isContentEditable === true;
}

/** What the editor needs to know about the control that has the focus. */
export interface FocusInfo {
  tagName?: string;
  type?: string;
  role?: string | null;
  /** The focus got there with the keyboard (`:focus-visible`), not with a mouse click. */
  keyboardFocus?: boolean;
}

/** The focus facts of a DOM element (`null` stays `null`). */
export function focusInfo(
  el: { tagName: string; type?: string; getAttribute(name: string): string | null; matches(selector: string): boolean } | null,
): FocusInfo | null {
  if (!el || !el.tagName) return null;
  let keyboardFocus = false;
  try {
    keyboardFocus = el.matches(":focus-visible");
  } catch {
    // an engine without :focus-visible: treat the focus as coming from the mouse
  }
  return { tagName: el.tagName, type: el.type, role: el.getAttribute("role"), keyboardFocus };
}

const PRESS_ROLES = ["button", "tab", "checkbox", "switch", "radio", "menuitem", "option", "link"];

/**
 * True when a key press belongs to the focused control and must not be taken
 * as an editor shortcut:
 * - a slider owns the arrow keys (they change its value);
 * - a button, link, checkbox or tab that was reached with the keyboard owns
 *   Enter and Space (they press it), and such a tab owns the arrow keys.
 * After a mouse click on a button the keys stay with the editor, so Space
 * still pans and Enter still finishes a shape.
 */
export function keyBelongsToControl(el: FocusInfo | null, key: string): boolean {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  const type = (el.type ?? "").toLowerCase();
  const role = (el.role ?? "").toLowerCase();
  const moves = key.startsWith("Arrow") || key === "Home" || key === "End" || key === "PageUp" || key === "PageDown";
  if ((tag === "INPUT" && type === "range") || role === "slider") return moves;
  if (!el.keyboardFocus) return false;
  if (role === "tab" && moves) return true;
  if (key !== "Enter" && key !== " " && key !== "Spacebar") return false;
  return tag === "BUTTON" || tag === "A" || tag === "SUMMARY"
    || (tag === "INPUT" && (type === "checkbox" || type === "radio" || type === "button" || type === "submit"))
    || PRESS_ROLES.includes(role);
}
