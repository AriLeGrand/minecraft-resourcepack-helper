// Colour picker: saturation / brightness square, hue and alpha sliders, hex field.
import { useEffect, useRef, useState } from "react";
import { hexToRgba, hsvToRgb, rgbaToHex, rgbToHsv, type Rgba } from "./pixels";

/** Calls `onMove` with the pointer position inside the element as 0..1, while the button is down. */
function useDrag(onMove: (x: number, y: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    onMove(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  return {
    ref,
    onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      move(e);
    },
    onPointerMove: (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
    },
  };
}

export function ColorPicker({ color, onChange }: { color: Rgba; onChange: (c: Rgba) => void }) {
  // hue and saturation are kept here: black and greys have none of their own
  const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(color[0], color[1], color[2]));
  const [hex, setHex] = useState(rgbaToHex(color));

  useEffect(() => {
    setHex(rgbaToHex(color));
    setHsv((old) => {
      const [r, g, b] = hsvToRgb(old[0], old[1], old[2]);
      return r === color[0] && g === color[1] && b === color[2] ? old : rgbToHsv(color[0], color[1], color[2]);
    });
  }, [color]);

  const set = (h: number, s: number, v: number, a = color[3]) => {
    setHsv([h, s, v]);
    const [r, g, b] = hsvToRgb(h, s, v);
    onChange([r, g, b, a]);
  };

  const sv = useDrag((x, y) => set(hsv[0], Math.round(x * 100), Math.round((1 - y) * 100)));
  const hue = useDrag((x) => set(Math.min(359, Math.round(x * 360)), hsv[1], hsv[2]));
  const alpha = useDrag((x) => onChange([color[0], color[1], color[2], Math.round(x * 255)]));

  const [pr, pg, pb] = hsvToRgb(hsv[0], 100, 100);
  const solid = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;

  const commitHex = () => {
    const c = hexToRgba(hex);
    if (c) onChange(c);
    else setHex(rgbaToHex(color));
  };

  return (
    <div className="ed-picker">
      <div
        className="sv"
        {...sv}
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, rgb(${pr}, ${pg}, ${pb}))` }}
        aria-label="Saturation and brightness"
      >
        <span className="knob" style={{ left: `${hsv[1]}%`, top: `${100 - hsv[2]}%`, background: solid }} />
      </div>
      <div className="slider hue" {...hue} aria-label="Hue">
        <span className="knob" style={{ left: `${(hsv[0] / 360) * 100}%` }} />
      </div>
      <div className="slider alpha checker" {...alpha} aria-label="Opacity of the colour">
        <div className="fill" style={{ background: `linear-gradient(to right, transparent, ${solid})` }} />
        <span className="knob" style={{ left: `${(color[3] / 255) * 100}%` }} />
      </div>
      <div className="hexrow">
        <input
          className="input mono"
          aria-label="Hex colour"
          spellCheck={false}
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={commitHex}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitHex();
              e.currentTarget.blur();
            }
          }}
        />
        <span className="dim mono">A {Math.round((color[3] / 255) * 100)}%</span>
      </div>
    </div>
  );
}
