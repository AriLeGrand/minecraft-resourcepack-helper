// Toasts (no success popups), the modal for errors and questions, and Ctrl+K.
import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor } from "../editor/editorStore";
import { TOOLS } from "../editor/tools";
import { openCompare } from "./CompareDialog";
import { baseName, CATEGORIES, categoryLabel, matchesSearch, searchWords } from "../lib/logic";
import { useApp, type Screen } from "../store";
import { Icon } from "./Icon";

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="dot" style={{ background: t.kind === "ok" ? "var(--ok)" : "var(--warn)" }} />
          <span className="grow">{t.text}</span>
          {t.action && (
            <a onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</a>
          )}
        </div>
      ))}
    </div>
  );
}

export function ModalHost() {
  const modal = useApp((s) => s.modal);
  const close = useApp((s) => s.closeModal);
  useEffect(() => {
    if (!modal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal, close]);
  if (!modal) return null;
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-label={modal.title}>
      <div className="modal">
        <h2>{modal.title}</h2>
        <p>{modal.text}</p>
        {modal.hint && <div className="hintbox">{modal.hint}</div>}
        <div className="buttons">
          {modal.buttons.map((b, i) => (
            <button
              key={b.label}
              autoFocus={i === modal.buttons.length - 1}
              className={`btn md ${b.primary ? "primary" : ""} ${b.danger ? "danger" : ""}`}
              onClick={() => { close(); b.run?.(); }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

interface Item {
  label: string;
  kind: string;
  mono?: boolean;
  run: () => void;
}

const MAX_RESULTS = 60;

export function CommandPalette() {
  const open = useApp((s) => s.palette);
  const setOpen = useApp((s) => s.setPalette);
  const rows = useApp((s) => s.rows);
  const pack = useApp((s) => s.pack);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useApp.getState().palette);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  useEffect(() => {
    if (open) {
      setQ("");
      setIndex(0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const app = useApp.getState();
    const nav = (label: string, screen: Screen): Item => ({ label, kind: "Go to", run: () => app.go(screen) });
    const commands: Item[] = [nav("Home", "home"), nav("Settings", "settings")];
    if (pack) {
      commands.push(nav("Textures", "textures"), nav("Editor", "editor"), nav("Pack and export", "export"));
      // tools and editor commands, while a texture is open in the editor
      if (useEditor.getState().tabs.length > 0) {
        for (const t of TOOLS) {
          commands.push({ label: t.label, kind: "Tool", run: () => { useEditor.getState().setTool(t.id); app.go("editor"); } });
        }
        const ed = useEditor.getState;
        // these act on the open texture: show it, so the result is seen
        const edit = (label: string, run: () => void): Item => ({ label, kind: "Command", run: () => { app.go("editor"); run(); } });
        commands.push({ label: "Save to pack (Ctrl+S)", kind: "Command", run: () => void ed().save() });
        commands.push(
          edit("Undo (Ctrl+Z)", () => ed().undo()),
          edit("Redo (Ctrl+Y)", () => ed().redo()),
          edit("Copy (Ctrl+C)", () => ed().copy()),
          edit("Cut (Ctrl+X)", () => ed().cut()),
          edit("Paste (Ctrl+V)", () => void ed().paste()),
          edit("Select all (Ctrl+A)", () => ed().selectAll()),
          edit("Deselect (Ctrl+D)", () => ed().deselect()),
          edit("Delete selection (Del)", () => ed().deleteSelection()),
        );
      }
      for (const c of CATEGORIES) {
        commands.push({
          label: `Show ${c.label}`,
          kind: "Category",
          run: () => { app.setFilters({ category: c.key, only: null, search: "" }); app.go("textures"); },
        });
      }
      commands.push({ label: "Show textures changed since export", kind: "Filter", run: () => { app.setFilters({ category: "all", status: "changed", only: null }); app.go("textures"); } });
      commands.push({ label: "Compare with another pack…", kind: "Command", run: openCompare });
      commands.push({ label: "Close pack", kind: "Command", run: () => void app.closePack() });
    }
    const words = searchWords(q);
    const out = commands.filter((c) => matchesSearch(c.label, words));
    if (words.length > 0) {
      for (const r of rows) {
        if (out.length >= MAX_RESULTS) break;
        if (matchesSearch(r.path, words)) {
          out.push({
            label: r.path,
            mono: true,
            kind: categoryLabel(r.category),
            run: () => { app.setFilters({ category: r.category, only: null, search: "", status: "all", animated: false, renamed: false, wrongSize: false }); app.select(r.path); app.go("textures"); },
          });
        }
      }
    }
    return out;
  }, [open, q, rows, pack]);

  useEffect(() => {
    listRef.current?.querySelector(".it.on")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;
  const run = (it: Item | undefined) => {
    if (!it) return;
    setOpen(false);
    it.run();
  };
  return (
    <div className="scrim top" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="palette" role="dialog" aria-label="Search everything">
        <div className="q">
          <Icon name="search" size={16} width={2} />
          <input
            autoFocus
            value={q}
            placeholder={pack ? "Search textures, tools, commands…" : "Search commands…"}
            onChange={(e) => { setQ(e.target.value); setIndex(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(items.length - 1, i + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
              else if (e.key === "Enter") run(items[index]);
              else if (e.key === "Escape") setOpen(false);
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="list" ref={listRef}>
          {items.length === 0 && <div className="none">Nothing matches “{q}”.</div>}
          {items.map((it, i) => (
            <button key={`${it.kind}:${it.label}`} className={`it ${i === index ? "on" : ""}`} onMouseEnter={() => setIndex(i)} onClick={() => run(it)}>
              <span className={`ellipsis ${it.mono ? "mono" : ""}`}>{it.mono ? baseName(it.label) : it.label}</span>
              {it.mono && <span className="dim mono ellipsis" style={{ fontSize: 11 }}>{it.label}</span>}
              <span className="kind">{it.kind}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
