// A list (select) holds on to the keyboard while it has the focus, so the
// editor's shortcuts would stop working after an entry was picked with the
// mouse. The focus is given back then. Someone working with the keyboard keeps
// it where it is (the arrow keys go on changing the list).
import type { ChangeEvent } from "react";

let lastInputWasKey = false;
if (typeof window !== "undefined") {
  window.addEventListener("keydown", () => { lastInputWasKey = true; }, true);
  window.addEventListener("pointerdown", () => { lastInputWasKey = false; }, true);
}

/** Call from a select's `onChange`. */
export function releaseAfterMouse(e: ChangeEvent<HTMLSelectElement>) {
  if (!lastInputWasKey) e.currentTarget.blur();
}
