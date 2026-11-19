// One icon style for the whole app: 24-unit grid, stroke only.
const PATHS = {
  logo: "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  textures: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  editor: "M4 20l4-1L19 8l-3-3L5 16l-1 4zM14 7l3 3",
  interface: "M4 5h16v14H4zM4 9h16M8 13h8M8 16h5",
  particles: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6",
  animation: "M4 5h16v14H4zM8 5v14M16 5v14M4 9h4M4 15h4M16 9h4M16 15h4",
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
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, width = 1.6, color = "currentColor" }: { name: IconName; size?: number; width?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
