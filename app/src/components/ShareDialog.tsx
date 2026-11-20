// "Share the to-do list" dialog of the texture browser: pick what to share and
// how, see the result, then copy it or save it as a file.
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, type TextureRow } from "../lib/api";
import { formatLabel, joinPath } from "../lib/logic";
import { useNotes } from "../lib/notesStore";
import { formatShareList, SHARE_FORMATS, shareFileName, type ShareFormat } from "../lib/share";
import { useApp } from "../store";

interface Props {
  /** What the list shows right now (category, search and filters applied). */
  visible: TextureRow[];
  /** Every texture of the pack's version. */
  all: TextureRow[];
  /** e.g. "Blocks" or "All textures". */
  viewTitle: string;
  onClose: () => void;
}

export function ShareDialog({ visible, all, viewTitle, onClose }: Props) {
  const pack = useApp((s) => s.pack)!;
  const toast = useApp((s) => s.toast);
  const showError = useApp((s) => s.showError);
  const [scope, setScope] = useState<"view" | "pack">("view");
  const [format, setFormat] = useState<ShareFormat>("checklist");
  const [includeDone, setIncludeDone] = useState(true);
  const [byPerson, setByPerson] = useState(false);
  const notes = useNotes((s) => s.notes);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const version = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  const rows = scope === "view" ? visible : all;
  const text = useMemo(
    () =>
      formatShareList(rows, {
        format,
        includeDone,
        packName: pack.project.name,
        subtitle: `Java ${version} · ${pack.project.resolution}× · format ${formatLabel(pack.project.format)}`
          + (scope === "view" && viewTitle !== "All textures" ? ` · ${viewTitle}` : ""),
        now: Date.now(),
        notes,
        byPerson,
      }),
    [rows, format, includeDone, pack, version, scope, viewTitle, notes, byPerson],
  );
  const lines = rows.filter((r) => !r.extra && (includeDone || r.status === "todo")).length;

  const copy = async () => {
    try {
      // through Windows itself: works even when the browser's clipboard is refused
      await writeText(text);
    } catch (e) {
      showError(e, "The list could not be copied");
      return;
    }
    toast(`Copied the list (${lines} texture${lines === 1 ? "" : "s"}). Paste it where you want to share it.`);
    onClose();
  };

  const saveFile = async () => {
    const f = SHARE_FORMATS.find((x) => x.key === format)!;
    const path = await save({
      title: "Save the to-do list",
      defaultPath: joinPath(pack.export_dir, shareFileName(pack.project.name, format)),
      filters: [{ name: f.label, extensions: [f.ext] }],
    });
    if (typeof path !== "string") return;
    try {
      await api.saveShareList(path, text);
      toast("Saved the to-do list.", "ok", { label: "Show in folder", run: () => void api.reveal(path).catch(() => {}) });
      onClose();
    } catch (e) {
      showError(e, "The list could not be saved");
    }
  };

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label="Share the to-do list" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal wide">
        <h2>Share the to-do list</h2>
        <p>Send the list of textures to a friend or to your team, so you can split the work.</p>

        <div className="sharegrid">
          <span className="label">Textures</span>
          <div className="seg sm" role="group" aria-label="Which textures">
            <button className={scope === "view" ? "on" : ""} onClick={() => setScope("view")}>
              This view · {viewTitle} ({visible.filter((r) => !r.extra).length})
            </button>
            <button className={scope === "pack" ? "on" : ""} onClick={() => setScope("pack")}>
              Whole pack ({all.filter((r) => !r.extra).length})
            </button>
          </div>
          <span className="label">Format</span>
          <div className="seg sm" role="group" aria-label="Format">
            {SHARE_FORMATS.map((f) => (
              <button key={f.key} className={format === f.key ? "on" : ""} onClick={() => setFormat(f.key)} title={f.hint}>{f.label}</button>
            ))}
          </div>
          <span />
          <label className="check">
            <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
            Also list finished textures (ticked)
          </label>
          <span />
          <label className="check" title="One part per person (from “Assigned to” in the inspector), Unassigned last">
            <input type="checkbox" checked={byPerson} onChange={(e) => setByPerson(e.target.checked)} />
            Group by person
          </label>
        </div>

        <div className="dim" style={{ fontSize: 11 }}>{SHARE_FORMATS.find((f) => f.key === format)!.hint} · {lines} texture{lines === 1 ? "" : "s"}</div>
        <textarea className="sharepreview mono" readOnly value={text} aria-label="Preview of the shared list" spellCheck={false} />

        <div className="buttons">
          <button className="btn md" onClick={onClose}>Close</button>
          <button className="btn md" onClick={() => void saveFile()}>Save as file…</button>
          <button className="btn md primary" autoFocus onClick={() => void copy()}>Copy</button>
        </div>
      </div>
    </div>
  );
}
