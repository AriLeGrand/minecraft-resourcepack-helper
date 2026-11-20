// Progress of the pack: the small card at the top of the browser's side bar
// and the summary it opens (overall, per category, today / this week).
import { useEffect } from "react";
import type { ProgressStats } from "../lib/logic";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ProgressCard({ stats, onOpen }: { stats: ProgressStats; onOpen: () => void }) {
  const o = stats.overall;
  return (
    <button className="progcard" onClick={onOpen} title="Show the progress of the pack">
      <span className="pc-head"><span>Progress</span><span className="pc-pct">{o.pct}%</span></span>
      <span className="pbar"><span style={{ width: `${o.pct}%` }} /></span>
      <span className="pc-sub">{o.done} / {o.total} done{stats.today ? ` · ${stats.today} today` : ""}</span>
    </button>
  );
}

export function ProgressDialog({ stats, packName, onClose, onShowChanged }: {
  stats: ProgressStats;
  packName: string;
  onClose: () => void;
  /** Lists the textures changed since the last export. */
  onShowChanged: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const o = stats.overall;
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Progress" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide progress-modal">
        <h2>Progress of {packName}</h2>
        <div className="pm-big">
          <span className="pm-pct">{o.pct}%</span>
          <span className="dim">{o.done} of {plural(o.total, "texture")} done, {o.total - o.done} to do</span>
        </div>
        <span className="pbar pm-bar"><span style={{ width: `${o.pct}%` }} /></span>
        <div className="pm-cards">
          <div><span className="pm-n">{stats.today}</span><span className="dim">saved today</span></div>
          <div><span className="pm-n">{stats.week}</span><span className="dim">saved this week</span></div>
          <div>
            <span className="pm-n" style={{ color: stats.changed ? "var(--warn)" : undefined }}>{stats.changed}</span>
            <span className="dim">changed since export{stats.changed > 0 && <> · <a onClick={onShowChanged}>Show</a></>}</span>
          </div>
        </div>
        <div className="pm-cats">
          {stats.categories.map((c) => (
            <div key={c.key} className="pm-cat">
              <span>{c.label}</span>
              <span className="pbar"><span style={{ width: `${c.pct}%` }} /></span>
              <span className="dim mono">{c.done} / {c.total}</span>
              <span className="mono">{c.pct}%</span>
            </div>
          ))}
        </div>
        <div className="dim" style={{ fontSize: 11 }}>
          Done = the pack has its own file. Today and this week count the pack’s files by the time they were last saved (the week starts on Monday).
        </div>
        <div className="buttons">
          <button className="btn md primary" autoFocus onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
