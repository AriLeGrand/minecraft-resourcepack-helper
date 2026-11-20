// Inspector: earlier versions of the selected texture (the pack's history and
// trash folders), preview next to the current file, "Restore this version".
import { useEffect, useState } from "react";
import { api, images, type HistoryVersion, type TextureRow } from "../lib/api";
import { baseName, bytesLabel, stampLabel } from "../lib/logic";
import { useApp } from "../store";

/** The history id of a file the restore just moved into the history folder. */
function keptId(kept: string): string {
  const name = kept.slice(Math.max(kept.lastIndexOf("/"), kept.lastIndexOf("\\")) + 1);
  return `h-${name.replace(/\.png$/i, "")}`;
}

export function HistorySection({ row }: { row: TextureRow }) {
  const pack = useApp((s) => s.pack)!;
  const stamp = useApp((s) => s.stamp);
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const path = row.path;
  const now = Date.now();

  useEffect(() => {
    let live = true;
    api.textureHistory(path, pack.dir)
      .then((v) => { if (live) setVersions(v); })
      .catch(() => { if (live) setVersions([]); });
    return () => { live = false; };
  }, [path, pack.dir, stamp]);
  useEffect(() => setChosen(null), [path]);

  if (!versions) return null;
  const pick = versions.find((v) => v.id === chosen) ?? null;

  const restore = async (v: HistoryVersion) => {
    const app = useApp.getState();
    setBusy(true);
    try {
      const r = await api.restoreVersion(path, v.id, pack.dir);
      await app.reload(true);
      setChosen(null);
      const when = stampLabel(v.made_ms, Date.now());
      if (r.kept) {
        const undoId = keptId(r.kept);
        app.toast(`Restored ${baseName(path)} from ${when}. The file it replaced is in the history.`, "ok", {
          label: "Undo",
          run: () => void api.restoreVersion(path, undoId, pack.dir).then(() => app.reload(true)).then(() => app.setStatus(`Undid the restore of ${baseName(path)}`)).catch((e) => app.showError(e, "The restore could not be undone")),
        });
      } else {
        app.setStatus(`${baseName(path)} is already that version`);
      }
    } catch (e) {
      app.showError(e, "That version could not be restored");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="eras">
      <div className="caps">History{versions.length ? ` · ${versions.length}` : ""}</div>
      {versions.length === 0 ? (
        <div className="dim" style={{ fontSize: 12 }}>No earlier versions yet. When the app replaces this texture (saving in the editor, importing, reverting), the old file is kept here.</div>
      ) : (
        <div className="histgrid" role="list">
          {versions.map((v) => (
            <button
              key={v.id}
              role="listitem"
              className={`hist ${v.id === chosen ? "on" : ""}`}
              title={`${v.kind === "trash" ? "In the pack's trash" : "In the pack's history"} · made ${stampLabel(v.made_ms, now)} · replaced ${stampLabel(v.replaced_ms, now)} · ${v.width}×${v.height} · ${bytesLabel(v.bytes)}`}
              onClick={() => setChosen(v.id === chosen ? null : v.id)}
            >
              <span className="thumb checker"><img className="pixel" loading="lazy" src={images.historyVersion(v.id, path)} alt="" /></span>
              <span className="when">{stampLabel(v.made_ms, now)}</span>
            </button>
          ))}
        </div>
      )}
      {pick && (
        <>
          <div className="compare">
            <div>
              <div className="preview checker"><img className="pixel" src={images.historyVersion(pick.id, path)} alt="Earlier version" /></div>
              <div className="dim" style={{ fontSize: 11 }}>{stampLabel(pick.made_ms, now)} · {pick.width}×{pick.height}</div>
            </div>
            <div>
              <div className={`preview checker ${row.mine ? "mine" : ""}`}>
                {row.mine ? <img className="pixel" src={images.packFull(path, row.mine.modified_ms || stamp)} alt="Current texture" /> : <span className="none">Not in the pack now</span>}
              </div>
              <div className="dim" style={{ fontSize: 11 }}>Now{row.mine ? ` · ${row.mine.width}×${row.mine.height}` : ""}</div>
            </div>
          </div>
          <button className="btn" disabled={busy} onClick={() => void restore(pick)} title="The current file goes to the history first, so this can be undone">
            Restore this version
          </button>
        </>
      )}
    </div>
  );
}
