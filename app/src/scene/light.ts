// Light for the 3D views, following the game's lightmap (the small texture
// the game builds every frame from sky light × block light; Java Edition
// `LightTexture.updateLightTexture`, 1.19–1.21). Pure maths, tested.
//
// What is used (written down from the game's code as remembered; the screen
// says these are approximations):
// - brightness(level) = f / (4 − 3f) with f = level / 15 (overworld, no
//   ambient light). 1.8.9's brightness table gives the same curve.
// - sky: s = skyDarken · 0.95 + 0.05; colour = lerp((s, s, 1), white, 0.35)
//   · brightness(sky level) · s. skyDarken is 1 at noon and 0.2 at night.
// - block light: b = brightness(level) · 1.5 (the torch flicker is taken at
//   its average); colour (b, b·((0.6b + 0.4)·0.6 + 0.4), b·(0.6b² + 0.4)),
//   the warm torch tint.
// - sum, lerp 4 % towards grey 0.75, clamp; then the "Brightness" option at
//   its default 50 %: lerp halfway to 1 − (1 − c)⁴; lerp 4 % to grey; clamp.

export type TimeOfDay = "day" | "sunset" | "night";
export type Rgb = [number, number, number];

export const TIMES: { v: TimeOfDay; label: string }[] = [
  { v: "day", label: "Day" },
  { v: "sunset", label: "Sunset" },
  { v: "night", label: "Night" },
];

/** The game's sky darkness factor (`getSkyDarken`): noon, about tick 11 500, midnight. */
export const SKY_DARKEN: Record<TimeOfDay, number> = { day: 1, sunset: 0.6, night: 0.2 };

/** Sky colour behind the scene (plains), 0xRRGGBB. Approximations of the game's sky. */
export const SKY_COLOR: Record<TimeOfDay, number> = { day: 0x78a7ff, sunset: 0xd98a5a, night: 0x0b0f1e };

/** Default "Brightness" option of the game (0 = Moody, 1 = Bright). */
export const DEFAULT_GAMMA = 0.5;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Brightness of a light level 0..15 (the game's curve, 0 → 0, 15 → 1). */
export function brightness(level: number): number {
  const f = clamp01(Math.round(level) / 15);
  return f / (4 - 3 * f);
}

/** Colour of block light alone (torch-warm), before the sky is added. */
export function blockLightColor(level: number): Rgb {
  const b = brightness(level) * 1.5;
  return [b, b * ((b * 0.6 + 0.4) * 0.6 + 0.4), b * (b * b * 0.6 + 0.4)];
}

/** Colour of sky light alone for this time of day. */
export function skyLightColor(time: TimeOfDay, skyLevel = 15): Rgb {
  const s = SKY_DARKEN[time] * 0.95 + 0.05;
  const k = brightness(skyLevel) * s;
  return [lerp(s, 1, 0.35) * k, lerp(s, 1, 0.35) * k, k];
}

const notGamma = (c: number) => 1 - (1 - c) ** 4;

/**
 * The lightmap colour (0..1 per channel) a face gets with this block light
 * level, sky light level and time of day. Multiplies the texture colour.
 */
export function lightColor(blockLevel: number, time: TimeOfDay, skyLevel = 15, gamma = DEFAULT_GAMMA): Rgb {
  const bl = blockLightColor(blockLevel);
  const sk = skyLightColor(time, skyLevel);
  return [0, 1, 2].map((i) => {
    let c = lerp(bl[i] + sk[i], 0.75, 0.04);
    c = clamp01(c);
    c = lerp(c, notGamma(c), gamma);
    c = lerp(c, 0.75, 0.04);
    return clamp01(c);
  }) as Rgb;
}

/** Shown next to the slider: "7 · 18 %" (the brightness the curve gives). */
export function levelLabel(level: number): string {
  return `${level} · ${Math.round(brightness(level) * 100)} %`;
}
