// The Tiled preview of a block texture with its seams: Rust measures the
// frame a moment after it stops changing; a note names the edge and the
// edge is outlined between the tiles.
import { useEffect, useState, type ReactNode } from "react";
import { api, type SeamReport } from "../lib/api";
import { bytesToBase64, type Buf } from "./pixels";
import { seamMessage, tileSize } from "./seams";

export function SeamNote({ buf, box, repeat, children }: { buf: Buf; box: number; repeat: number; children: ReactNode }) {
  const [report, setReport] = useState<SeamReport | null>(null);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(() => {
      api.seamMeasure(buf.w, buf.h, bytesToBase64(buf.data))
        .then((r) => { if (live) setReport(r); })
        .catch(() => { if (live) setReport(null); });
    }, 300);
    return () => { live = false; window.clearTimeout(t); };
  }, [buf]);
  const text = seamMessage(report);
  const { tw, th } = tileSize(buf.w, buf.h, box, repeat);
  const lines: { left?: number; top?: number; vertical: boolean }[] = [];
  for (let i = 1; i < repeat; i++) {
    if (report?.columns.seam) lines.push({ left: Math.round(tw * i), vertical: true });
    if (report?.rows.seam) lines.push({ top: Math.round(th * i), vertical: false });
  }
  return (
    <div className="seam-wrap">
      <div className="seam-view">
        {children}
        {lines.map((l, i) => (
          <span key={i} className={`seam-line ${l.vertical ? "v" : "h"}`} style={l.vertical ? { left: l.left } : { top: l.top }} />
        ))}
      </div>
      {text && (
        <div className="seam-note" role="status" title="The colours jump across this edge much more than between neighbouring pixels inside the texture, so the edge shows as a line when blocks sit side by side.">
          {text}
        </div>
      )}
    </div>
  );
}
