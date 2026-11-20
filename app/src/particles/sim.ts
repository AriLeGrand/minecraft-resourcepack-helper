// The particle viewer's scene: a small, deterministic simulation. A resource
// pack decides how a particle LOOKS (its images and their order), never how it
// moves; the movement here is an approximation per family of particles, made
// to show the images the way the game roughly plays them. Pure: no DOM.

/** Size of the scene in CSS pixels. */
export const SCENE_W = 620;
export const SCENE_H = 480;
/** Top of the ground strip. */
export const GROUND_Y = SCENE_H - 70;
/** Where particles come from (the top of the torch / block / campfire). */
export const ORIGIN: Pt = [SCENE_W / 2, 352];
/** Never more particles than this at once. */
export const MAX_ALIVE = 120;

export type Pt = [number, number];
/** How a particle picks its image: over its lifetime, one at random, or the only one. */
export type FrameMode = "age" | "random" | "single";
export type Emitter = "torch" | "campfire" | "block";

export type FamilyKey =
  | "smoke" | "campfire" | "flame" | "drip" | "splash" | "bubble" | "inward" | "burst" | "float" | "spark" | "drift" | "generic";

export interface Family {
  key: FamilyKey;
  /** New particles per simulated second. */
  rate: number;
  /** Lifetime in seconds, from–to. */
  life: [number, number];
  /** Where new particles appear. */
  spawn: "point" | "wide" | "ring" | "burst" | "above";
  /** Start speed in px/s: x is a random spread (±), y is the base (negative = up). */
  vx: number;
  vy: number;
  /** px/s² downwards (negative floats up). */
  gravity: number;
  /** Speed kept per second (1 = none lost). */
  drag: number;
  /** Size on screen in px at birth and at death. */
  size: [number, number];
  /** Fades out towards the end of its life. */
  fade: boolean;
  /** Pulled towards the emitter (portal, enchanting glyphs). */
  inward?: boolean;
  emitter: Emitter;
}

const FAMILIES: Record<FamilyKey, Omit<Family, "key">> = {
  smoke: { rate: 12, life: [1.2, 2.0], spawn: "point", vx: 16, vy: -42, gravity: -6, drag: 0.6, size: [20, 14], fade: true, emitter: "torch" },
  campfire: { rate: 3.5, life: [3.5, 5.5], spawn: "wide", vx: 6, vy: -55, gravity: 0, drag: 0.9, size: [30, 34], fade: true, emitter: "campfire" },
  flame: { rate: 10, life: [0.5, 0.9], spawn: "point", vx: 5, vy: -14, gravity: 0, drag: 0.8, size: [10, 6], fade: false, emitter: "torch" },
  drip: { rate: 2.5, life: [1.0, 1.4], spawn: "above", vx: 0, vy: 0, gravity: 260, drag: 1, size: [10, 10], fade: false, emitter: "block" },
  splash: { rate: 14, life: [0.5, 0.9], spawn: "wide", vx: 60, vy: -120, gravity: 420, drag: 0.9, size: [10, 10], fade: false, emitter: "block" },
  bubble: { rate: 8, life: [1.4, 2.2], spawn: "wide", vx: 10, vy: -55, gravity: -10, drag: 0.9, size: [8, 8], fade: false, emitter: "block" },
  inward: { rate: 14, life: [1.2, 1.8], spawn: "ring", vx: 0, vy: 0, gravity: 0, drag: 1, size: [10, 6], fade: false, inward: true, emitter: "block" },
  burst: { rate: 7, life: [0.6, 1.0], spawn: "burst", vx: 70, vy: 0, gravity: 0, drag: 0.5, size: [40, 48], fade: false, emitter: "block" },
  float: { rate: 3, life: [1.2, 1.6], spawn: "above", vx: 10, vy: -30, gravity: 0, drag: 0.9, size: [14, 14], fade: true, emitter: "block" },
  spark: { rate: 12, life: [0.8, 1.4], spawn: "point", vx: 70, vy: -110, gravity: 160, drag: 0.7, size: [10, 6], fade: true, emitter: "block" },
  drift: { rate: 6, life: [2.5, 3.5], spawn: "above", vx: 20, vy: 18, gravity: 8, drag: 0.95, size: [10, 10], fade: true, emitter: "block" },
  generic: { rate: 8, life: [1.0, 1.6], spawn: "point", vx: 20, vy: -30, gravity: 0, drag: 0.8, size: [12, 10], fade: true, emitter: "block" },
};

const FAMILY_OF: [FamilyKey, RegExp][] = [
  ["campfire", /^campfire_/],
  ["smoke", /(^|_)smoke$|^poof$|^cloud$|^squid_ink$|^glow_squid_ink$|^sneeze$|^dust_plume$|^white_ash$|^ash$|^item_snowball_poof$|^spit$|^witch$|^effect$|^entity_effect$|^instant_effect$|^ambient_entity_effect$|^dragon_breath$|^dust/],
  ["flame", /flame$|^lava$|^soul$|^sculk_soul$/],
  ["drip", /^(dripping|falling|landing)_/],
  ["splash", /^splash$|^rain$|^fishing$/],
  ["bubble", /bubble|^current_down$|^underwater$|^dolphin$/],
  ["inward", /portal$|^enchant$|^nautilus$|^vault_connection$|^ominous_spawning$|^trial_spawner/],
  ["burst", /explosion|^flash$|^sonic_boom$|^sweep_attack$|gust|^shriek$|^sculk_charge/],
  ["float", /^heart$|^note$|^angry_villager$|^happy_villager$|^damage_indicator$|^wax_|^glow$|^egg_crack$|^scrape$|^composter$|^infested$|^raid_omen$|^trial_omen$|^firefly$/],
  ["spark", /^firework$|^end_rod$|^electric_spark$|^totem_of_undying$|crit$|^enchanted_hit$|^crit$|^trail$/],
  ["drift", /leaves$|spore|^snowflake$|^mycelium$|^falling_dust$/],
];

/** Which movement preset a particle uses. Clearly approximate. */
export function familyOf(id: string): Family {
  const key = FAMILY_OF.find(([, re]) => re.test(id))?.[0] ?? "generic";
  return { key, ...FAMILIES[key] };
}

/** Particles whose image is picked at random (the rest play their images over their lifetime). */
const RANDOM_FRAMES = /^enchant$|^nautilus$|portal$|^splash$|^rain$|^vault_connection$|^ominous_spawning$/;

/** How the particle picks its image. `legacy` is the mode from the old sheet map. */
export function frameMode(id: string, frames: number, legacy?: string | null): FrameMode {
  if (frames <= 1) return "single";
  if (legacy === "random") return "random";
  if (legacy === "age" || legacy === "state") return "age";
  return RANDOM_FRAMES.test(id) ? "random" : "age";
}

/** Light tints the game puts on some particles (grey smoke, purple portal…); `null` = the image as it is. */
export function tintOf(id: string): [number, number, number] | null {
  if (/^(smoke|large_smoke)$/.test(id)) return [120, 120, 120];
  if (/^(poof|cloud|item_snowball_poof|sneeze|white_smoke)$/.test(id)) return [235, 235, 235];
  if (/portal$/.test(id)) return [190, 110, 240];
  if (/^(witch)$/.test(id)) return [170, 90, 200];
  if (/^(effect|entity_effect|ambient_entity_effect|instant_effect)$/.test(id)) return [140, 170, 250];
  if (/^dust$/.test(id)) return [230, 30, 30];
  if (/^squid_ink$/.test(id)) return [20, 20, 24];
  if (/^dragon_breath$/.test(id)) return [200, 60, 220];
  if (/^(rain|splash|underwater|fishing|bubble|bubble_pop|bubble_column_up|current_down)$/.test(id)) return [140, 180, 255];
  return null;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Seconds lived. */
  age: number;
  life: number;
  /** A number fixed at birth: picks the image in "random" mode. */
  pick: number;
}

export interface SimState {
  parts: Particle[];
  /** Fraction of the next particle to spawn. */
  acc: number;
  /** State of the random number generator. */
  seed: number;
  /** Total particles spawned. */
  spawned: number;
}

export const newSim = (seed = 1): SimState => ({ parts: [], acc: 0, seed: seed >>> 0 || 1, spawned: 0 });

/** Mulberry32: the next random number in [0, 1) and the new state. Deterministic. */
export function nextRandom(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

function spawn(f: Family, origin: Pt, rnd: () => number): Particle {
  const [cx, cy] = origin;
  const life = f.life[0] + (f.life[1] - f.life[0]) * rnd();
  const pick = Math.floor(rnd() * 1e6);
  const spread = (n: number) => (rnd() - 0.5) * 2 * n;
  switch (f.spawn) {
    case "ring": {
      const a = rnd() * Math.PI * 2;
      const r = 90 + rnd() * 60;
      return { x: cx + Math.cos(a) * r, y: cy - 30 + Math.sin(a) * r * 0.6, vx: 0, vy: 0, age: 0, life, pick };
    }
    case "burst":
      return { x: cx + spread(40), y: cy - 30 + spread(30), vx: spread(f.vx), vy: spread(f.vx), age: 0, life, pick };
    case "wide":
      return { x: cx + spread(36), y: cy, vx: spread(f.vx), vy: f.vy * (0.8 + rnd() * 0.4), age: 0, life, pick };
    case "above":
      return { x: cx + spread(26), y: cy - 4 + spread(4), vx: spread(f.vx), vy: f.vy * (0.8 + rnd() * 0.4), age: 0, life, pick };
    default:
      return { x: cx + spread(4), y: cy, vx: spread(f.vx), vy: f.vy * (0.8 + rnd() * 0.4), age: 0, life, pick };
  }
}

/**
 * Moves the scene on by `dt` real seconds at `speed` (¼×, 1×, 2×): particles
 * age and move, the dead ones go, new ones are born at the family's rate.
 * Returns a new state; the old one is left as it was.
 */
export function step(state: SimState, f: Family, dt: number, speed: number, origin: Pt = ORIGIN, max = MAX_ALIVE): SimState {
  const t = Math.max(0, dt) * Math.max(0, speed);
  let seed = state.seed;
  const rnd = () => {
    const [v, s] = nextRandom(seed);
    seed = s;
    return v;
  };
  const keep = Math.pow(f.drag, t);
  const [cx, cy] = origin;
  const parts: Particle[] = [];
  for (const p of state.parts) {
    const age = p.age + t;
    if (age >= p.life) continue;
    let { vx, vy } = p;
    if (f.inward) {
      // pulled towards a point just above the emitter, faster as they age
      vx = (cx - p.x) * 1.6;
      vy = (cy - 20 - p.y) * 1.6;
    } else {
      vy += f.gravity * t;
      vx *= keep;
      vy = f.gravity === 0 ? vy * keep : vy;
    }
    let x = p.x + vx * t;
    let y = p.y + vy * t;
    // things that fall stop on the ground
    if (y > GROUND_Y - 2 && vy > 0) {
      y = GROUND_Y - 2;
      vy = 0;
      vx *= 0.5;
    }
    x = Math.max(-40, Math.min(SCENE_W + 40, x));
    parts.push({ ...p, x, y, vx, vy, age });
  }
  let acc = state.acc + f.rate * t;
  let spawned = state.spawned;
  while (acc >= 1) {
    acc -= 1;
    if (parts.length >= max) continue;
    parts.push(spawn(f, origin, rnd));
    spawned++;
  }
  return { parts, acc, seed, spawned };
}

/** 0 at birth, 1 at death. */
export const lifeFraction = (p: Particle) => (p.life > 0 ? Math.min(1, Math.max(0, p.age / p.life)) : 1);

/**
 * The image a particle shows. "age" works like the game's sprite set:
 * `index = age * (frames - 1) / lifetime`, so the first image at birth and the
 * last one at the end.
 */
export function frameIndex(p: Particle, frames: number, mode: FrameMode): number {
  if (frames <= 1 || mode === "single") return 0;
  if (mode === "random") return p.pick % frames;
  return Math.min(frames - 1, Math.max(0, Math.floor((p.age * (frames - 1)) / p.life)));
}

/** Size on screen in px. */
export function sizeOf(p: Particle, f: Family): number {
  const k = lifeFraction(p);
  return Math.round(f.size[0] + (f.size[1] - f.size[0]) * k);
}

/** Opacity: families that fade lose it over the last part of their life. */
export function alphaOf(p: Particle, f: Family): number {
  if (!f.fade) return 1;
  const k = lifeFraction(p);
  return k < 0.6 ? 1 : Math.max(0, 1 - (k - 0.6) / 0.4);
}
