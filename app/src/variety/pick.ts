// The random pick of the variants preview: seeded, so "Shuffle" gives a new
// arrangement and everything else (a weight change, a redraw) keeps it.
// The game picks per block position with its own hash; only the
// proportions match, not the exact arrangement.

/** A small seeded generator (mulberry32): numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Index of the entry picked by `r` in [0, 1), proportional to the weights. */
export function pickIndex(weights: number[], r: number): number {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let x = r * total;
  for (let i = 0; i < weights.length; i++) {
    x -= Math.max(0, weights[i]);
    if (x < 0) return i;
  }
  return weights.length - 1;
}

/** `count` picks (indexes) for the patch, from a seed. */
export function pickPatch(weights: number[], count: number, seed: number): number[] {
  const next = rng(seed);
  return Array.from({ length: count }, () => pickIndex(weights, next()));
}
