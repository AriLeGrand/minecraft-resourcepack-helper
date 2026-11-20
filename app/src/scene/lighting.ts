// The light chosen for the 3D views (Scene, editor and animation previews),
// kept for the session. No three.js here.
import { create } from "zustand";
import type { TimeOfDay } from "./light";

interface Lighting {
  time: TimeOfDay;
  /** Block light level 0..15. */
  level: number;
  /** Ambient occlusion in the Scene (the single-block preview has no neighbours). */
  ao: boolean;
  setTime: (t: TimeOfDay) => void;
  setLevel: (l: number) => void;
  setAo: (on: boolean) => void;
}

export const useLighting = create<Lighting>((set) => ({
  time: "day",
  level: 0,
  ao: true,
  setTime: (time) => set({ time }),
  setLevel: (level) => set({ level: Math.max(0, Math.min(15, Math.round(level))) }),
  setAo: (ao) => set({ ao }),
}));
