import { describe, expect, it } from "vitest";
import { focusInfo, isTypingTarget, keyBelongsToControl, shortcutFor, type KeyPress } from "./shortcuts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key, ctrl: false, shift: false, alt: false, ...mods });

describe("shortcuts", () => {
  it("picks tools by their Aseprite-like keys", () => {
    expect(shortcutFor(press("b"))).toEqual({ do: "tool", tool: "pencil" });
    expect(shortcutFor(press("B", { shift: true }))).toEqual({ do: "tool", tool: "spray" });
    expect(shortcutFor(press("S", { shift: true }))).toEqual({ do: "tool", tool: "shade" });
    expect(shortcutFor(press("m"))).toEqual({ do: "tool", tool: "marquee" });
    expect(shortcutFor(press("h"))).toEqual({ do: "tool", tool: "hand" });
    expect(shortcutFor(press("s"))).toBeNull();
  });
  it("knows the editing commands", () => {
    expect(shortcutFor(press("z", { ctrl: true }))).toEqual({ do: "undo" });
    expect(shortcutFor(press("Z", { ctrl: true, shift: true }))).toEqual({ do: "redo" });
    expect(shortcutFor(press("y", { ctrl: true }))).toEqual({ do: "redo" });
    expect(shortcutFor(press("s", { ctrl: true }))).toEqual({ do: "save" });
    expect(shortcutFor(press("a", { ctrl: true }))).toEqual({ do: "selectAll" });
    expect(shortcutFor(press("d", { ctrl: true }))).toEqual({ do: "deselect" });
    expect(shortcutFor(press("c", { ctrl: true }))).toEqual({ do: "copy" });
    expect(shortcutFor(press("x", { ctrl: true }))).toEqual({ do: "cut" });
    expect(shortcutFor(press("v", { ctrl: true }))).toEqual({ do: "paste" });
    expect(shortcutFor(press("Delete"))).toEqual({ do: "delete" });
    expect(shortcutFor(press("x"))).toEqual({ do: "swap" });
    expect(shortcutFor(press("["))).toEqual({ do: "size", delta: -1 });
    expect(shortcutFor(press("]"))).toEqual({ do: "size", delta: 1 });
    expect(shortcutFor(press("+", { shift: true }))).toEqual({ do: "zoom", delta: 1 });
    expect(shortcutFor(press("="))).toEqual({ do: "zoom", delta: 1 });
    expect(shortcutFor(press("-"))).toEqual({ do: "zoom", delta: -1 });
    expect(shortcutFor(press("Enter"))).toEqual({ do: "commit" });
    expect(shortcutFor(press("Escape"))).toEqual({ do: "cancel" });
    expect(shortcutFor(press("ArrowRight"))).toEqual({ do: "frame", delta: 1 });
  });
  it("keeps Ctrl combinations apart from tool keys", () => {
    // Ctrl+V pastes, V alone is the Move tool; Ctrl+K belongs to the command search
    expect(shortcutFor(press("v"))).toEqual({ do: "tool", tool: "move" });
    expect(shortcutFor(press("k", { ctrl: true }))).toBeNull();
    expect(shortcutFor(press("b", { ctrl: true }))).toBeNull();
    expect(shortcutFor(press("b", { alt: true }))).toBeNull();
    expect(shortcutFor(press("F5"))).toBeNull();
    expect(shortcutFor(press("Shift", { shift: true }))).toBeNull();
  });
  it("does not fire while typing", () => {
    expect(isTypingTarget({ tagName: "INPUT", type: "text" })).toBe(true);
    expect(isTypingTarget({ tagName: "input", type: "number" })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
    expect(isTypingTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isTypingTarget({ tagName: "SELECT" })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "INPUT", type: "checkbox" })).toBe(false);
    expect(isTypingTarget({ tagName: "INPUT", type: "range" })).toBe(false);
    expect(isTypingTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isTypingTarget({ tagName: "CANVAS" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("review fixes: keys that belong to the focused control", () => {
  const byKeyboard = (tagName: string, extra: { type?: string; role?: string } = {}) => ({ tagName, keyboardFocus: true, ...extra });
  const byMouse = (tagName: string, extra: { type?: string; role?: string } = {}) => ({ tagName, keyboardFocus: false, ...extra });

  it("leaves Enter and Space to a button, link, checkbox or tab reached with the keyboard", () => {
    for (const key of ["Enter", " "]) {
      expect(keyBelongsToControl(byKeyboard("BUTTON"), key)).toBe(true);
      expect(keyBelongsToControl(byKeyboard("A"), key)).toBe(true);
      expect(keyBelongsToControl(byKeyboard("INPUT", { type: "checkbox" }), key)).toBe(true);
      expect(keyBelongsToControl(byKeyboard("DIV", { role: "tab" }), key)).toBe(true);
    }
    // other keys stay shortcuts, also on a focused button
    expect(keyBelongsToControl(byKeyboard("BUTTON"), "b")).toBe(false);
    expect(keyBelongsToControl(byKeyboard("BUTTON"), "ArrowLeft")).toBe(false);
    expect(keyBelongsToControl(byKeyboard("BUTTON"), "Escape")).toBe(false);
  });
  it("keeps Enter and Space for the editor after a mouse click on a button (Space pans, Enter finishes a shape)", () => {
    expect(keyBelongsToControl(byMouse("BUTTON"), " ")).toBe(false);
    expect(keyBelongsToControl(byMouse("BUTTON"), "Enter")).toBe(false);
    expect(keyBelongsToControl(byMouse("INPUT", { type: "checkbox" }), " ")).toBe(false);
    expect(keyBelongsToControl(null, " ")).toBe(false);
    expect(keyBelongsToControl({}, "Enter")).toBe(false);
    expect(keyBelongsToControl(byKeyboard("DIV"), "Enter")).toBe(false);
    expect(keyBelongsToControl(byKeyboard("CANVAS"), " ")).toBe(false);
  });
  it("leaves the arrow keys to a slider, however it got the focus", () => {
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(keyBelongsToControl(byMouse("INPUT", { type: "range" }), key)).toBe(true);
      expect(keyBelongsToControl(byMouse("DIV", { role: "slider" }), key)).toBe(true);
    }
    // a slider takes no letters: tool shortcuts keep working
    expect(keyBelongsToControl(byMouse("INPUT", { type: "range" }), "b")).toBe(false);
    expect(keyBelongsToControl(byMouse("INPUT", { type: "range" }), " ")).toBe(false);
    // a tab moves with the arrows only for someone using the keyboard
    expect(keyBelongsToControl(byKeyboard("BUTTON", { role: "tab" }), "ArrowRight")).toBe(true);
    expect(keyBelongsToControl(byMouse("BUTTON", { role: "tab" }), "ArrowRight")).toBe(false);
  });
  it("reads the focus facts from an element", () => {
    const el = (keyboard: boolean | "throws") => ({
      tagName: "BUTTON", type: "submit",
      getAttribute: (name: string) => (name === "role" ? "tab" : null),
      matches: (sel: string) => {
        if (keyboard === "throws") throw new Error("unknown selector");
        return sel === ":focus-visible" && keyboard;
      },
    });
    expect(focusInfo(el(true))).toEqual({ tagName: "BUTTON", type: "submit", role: "tab", keyboardFocus: true });
    expect(focusInfo(el(false))?.keyboardFocus).toBe(false);
    expect(focusInfo(el("throws"))?.keyboardFocus).toBe(false);
    expect(focusInfo(null)).toBeNull();
  });
});
