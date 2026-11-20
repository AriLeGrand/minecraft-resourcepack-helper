// The frame every screen lives in: top bar, section bar, status bar.
import type { ReactNode } from "react";
import { useEditor } from "../editor/editorStore";
import { formatLabel } from "../lib/logic";
import { useApp, type Screen } from "../store";
import { Icon, type IconName } from "./Icon";

const SECTIONS: { key: Screen; label: string; icon: IconName; needsPack: boolean }[] = [
  { key: "home", label: "Home", icon: "home", needsPack: false },
  { key: "textures", label: "Textures", icon: "textures", needsPack: true },
  { key: "editor", label: "Editor", icon: "editor", needsPack: true },
  { key: "scene", label: "Scene", icon: "scene", needsPack: true },
  { key: "interface", label: "Interface", icon: "interface", needsPack: true },
  { key: "particles", label: "Particles", icon: "particles", needsPack: true },
  { key: "variety", label: "Variety", icon: "variety", needsPack: true },
  { key: "animation", label: "Animation", icon: "animation", needsPack: true },
  { key: "models", label: "Models (later)", icon: "models", needsPack: true },
  { key: "export", label: "Pack and export", icon: "export", needsPack: true },
  { key: "settings", label: "Settings", icon: "settings", needsPack: false },
];

export const sectionLabel = (s: Screen) => SECTIONS.find((x) => x.key === s)?.label ?? s;

export function TopBar({ right, crumbs }: { right?: ReactNode; crumbs?: ReactNode }) {
  const pack = useApp((s) => s.pack);
  const screen = useApp((s) => s.screen);
  const setPalette = useApp((s) => s.setPalette);
  return (
    <header className="topbar">
      <div className="crumbs">
        <Icon name="logo" size={20} color="var(--accent)" />
        {crumbs ?? (
          <>
            <span className="name ellipsis">{pack && screen !== "home" ? pack.project.name : "Pack Creator"}</span>
            {pack && screen !== "home" && (
              <>
                <span className="sep">/</span>
                <span className="leaf">{sectionLabel(screen)}</span>
              </>
            )}
          </>
        )}
      </div>
      <div className="topsearch">
        <div className="searchbox" onClick={() => setPalette(true)} role="button" aria-label="Search everything">
          <Icon name="search" size={14} width={2} />
          <input readOnly placeholder="Search textures, tools, commands…" onFocus={(e) => { e.target.blur(); setPalette(true); }} />
          <span className="kbd">Ctrl K</span>
        </div>
      </div>
      <div className="topright">{right}</div>
    </header>
  );
}

/** The default right side of the top bar when a pack is open. */
export function PackChips() {
  const pack = useApp((s) => s.pack);
  const go = useApp((s) => s.go);
  if (!pack) return <span className="dim">No pack open</span>;
  const label = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  return (
    <>
      <span className="chip">Java {label} · format {formatLabel(pack.project.format)}</span>
      <span className="chip">{pack.project.resolution}×</span>
      <button className="btn primary" onClick={() => go("export")}>Export</button>
    </>
  );
}

export function NavBar() {
  const screen = useApp((s) => s.screen);
  const pack = useApp((s) => s.pack);
  const go = useApp((s) => s.go);
  const toast = useApp((s) => s.toast);
  const unsaved = useEditor((s) => s.tabs.some((t) => t.doc.dirty));
  return (
    <nav className="nav" aria-label="Sections">
      {SECTIONS.map((s) => {
        const off = s.needsPack && !pack;
        return (
          <button
            key={s.key}
            title={s.label}
            aria-label={s.label}
            aria-current={screen === s.key}
            className={`${screen === s.key ? "on" : ""} ${off ? "off" : ""}`}
            onClick={() => (off ? toast("Create or open a pack first.", "warn") : go(s.key))}
          >
            <Icon name={s.icon} />
            {s.key === "editor" && unsaved && <span className="unsaved" aria-label="Unsaved changes" />}
          </button>
        );
      })}
    </nav>
  );
}

/** `right` replaces the pack folder shown at the right end (the editor shows where saving writes). */
export function StatusBar({ children, right }: { children?: ReactNode; right?: ReactNode }) {
  const status = useApp((s) => s.status);
  const busy = useApp((s) => s.busy);
  const pack = useApp((s) => s.pack);
  const version = useApp((s) => s.boot?.app_version);
  return (
    <footer className="statusbar">
      {busy ? (
        <span className="state">
          <span className="dot" style={{ background: "var(--accent)" }} />
          {busy.text}
          {busy.total > 0 && (
            <>
              <span className="progress"><div style={{ width: `${Math.round((busy.done / busy.total) * 100)}%` }} /></span>
              <span>{busy.done} / {busy.total}</span>
            </>
          )}
        </span>
      ) : (
        <span className="state">
          <span className="dot" style={{ background: "var(--ok)" }} />
          <span className="ellipsis" style={{ maxWidth: 520 }}>{status}</span>
        </span>
      )}
      {children}
      <span className="right mono ellipsis" style={{ maxWidth: 480 }}>{right ?? (pack ? pack.dir : `v${version ?? "0.1"} preview`)}</span>
    </footer>
  );
}
