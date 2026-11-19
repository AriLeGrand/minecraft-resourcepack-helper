import { describe, expect, it } from "vitest";
import { isTypingTarget, shortcutFor, type KeyPress } from "./shortcuts";

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
