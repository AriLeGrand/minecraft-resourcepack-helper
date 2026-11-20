// One icon style for the whole app: 24-unit grid, stroke only.
const PATHS = {
  logo: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  textures: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  editor: "M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3",
  interface: "M4 5h16v14H4zM4 9h16M8 13h8M8 16h5",
  particles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  animation: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
  variety: "M4 4h7v7H4zM13 13h7v7h-7zM13 4l7 7M20 4l-7 7M4 13h7v7H4z",
  models: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  export: "M12 3v12M7 10l5 5 5-5M5 21h14",
  settings:
    "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM20 20l-4-4",
  check: "M5 12l5 5 9-10",
  folder: "M3 7h6l2 2h10v10H3z",
  clock: "M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 8v4l3 2",
  list: "M4 6h16M4 12h16M4 18h16",
  warn: "M12 8v5M12 16h.01M10.3 3.9L2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  close: "M6 6l12 12M18 6L6 18",
  share: "M12 3v12M8 7l4-4 4 4M5 12v8h14v-8",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3 3.7M6.6 6.6C3.8 8.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 5.4-1.6",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  unlock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2",
  plus: "M12 5v14M5 12h14",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  swap: "M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7",
  prev: "M15 6l-6 6 6 6",
  next: "M9 6l6 6-6 6",
} as const;

export type IconName = keyof typeof PATHS;

/** `d` draws a path that is not in the list (the editor's tool icons), in the same style. */
export function Icon({ name, d, size = 18, width = 1.6, color = "currentColor" }: { name?: IconName; d?: string; size?: number; width?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d ?? (name ? PATHS[name] : "")} />
    </svg>
  );
}
