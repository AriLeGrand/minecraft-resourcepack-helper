// Screen 2: texture browser, layout "list + compare".
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { NavBar, PackChips, StatusBar, TopBar } from "../components/Shell";
import { useEditor } from "../editor/editorStore";
import { api, images, type BatchScan, type ChangedTexture, type TextureDetail, type TextureRow, type WhatsNewView } from "../lib/api";
import {
  baseName, CATEGORIES, categoryLabel, compareChoices, countRows, dayLabel, defaultCompareVersion, filterRows, folderOf,
  matchesElsewhere, progressStats, realRenames, timeLabel, virtualWindow, whatsNewNotice, whatsNewOnly, whatsNewTitle, type WhatsNewMode,
} from "../lib/logic";
import { BatchImportDialog } from "../components/BatchImportDialog";
import { HistorySection } from "../components/HistorySection";
import { ProgressCard, ProgressDialog } from "../components/ProgressPanel";
import { ShareDialog } from "../components/ShareDialog";
import { NoteBadges, NotesSection, TeamFilters } from "../components/TeamNotes";
import { useNotes } from "../lib/notesStore";
import { useApp } from "../store";

const ROW_H = 41;
const STATUS_TEXT = { todo: "To do", done: "Done", changed: "Changed since export" } as const;

function thumbSrc(r: TextureRow, dirName: string, stamp: number): string {
  if (r.mine) return images.packFull(r.path, r.mine.modified_ms || stamp);
  return r.has_thumb ? images.vanillaThumb(dirName, r.path) : images.vanillaFull(dirName, r.path);
}

function sizeText(r: TextureRow): string {
  const w = r.mine?.width ?? r.width;
  const h = r.mine?.height ?? r.height;
  return `${w}×${h}`;
}

export function Browser() {
  const pack = useApp((s) => s.pack)!;
  const rows = useApp((s) => s.rows);
  const summary = useApp((s) => s.summary);
  const loading = useApp((s) => s.loading);
  const busy = useApp((s) => s.busy);
  const filters = useApp((s) => s.filters);
  const setFilters = useApp((s) => s.setFilters);
  const selected = useApp((s) => s.selected);
  const select = useApp((s) => s.select);
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const stamp = useApp((s) => s.stamp);
  const reload = useApp((s) => s.reload);
  const whatsNew = useApp((s) => s.whatsNew);

  const dirName = pack.project.version_dir;
  const notes = useNotes((s) => s.notes);
  const me = useNotes((s) => s.me);
  useEffect(() => {
    void useNotes.getState().load(pack.dir);
  }, [pack.dir]);
  const noteCtx = useMemo(() => ({ notes, me }), [notes, me]);
  const visible = useMemo(() => filterRows(rows, filters, noteCtx), [rows, filters, noteCtx]);
  const counts = useMemo(() => countRows(rows, filters.category), [rows, filters.category]);
  const elsewhere = useMemo(() => matchesElsewhere(rows, filters, noteCtx), [rows, filters, noteCtx]);
  const inList = useMemo(() => new Set(rows.map((r) => r.path)), [rows]);
  const [showProgress, setShowProgress] = useState(false);
  const selectedRow = useMemo(() => rows.find((r) => r.path === selected) ?? null, [rows, selected]);
  // textures Mojang redrew since the compared version, for the row tag
  const redrawn = useMemo(() => new Set(whatsNew?.diff.changed.map((c) => c.path) ?? []), [whatsNew]);
  // which "What's new" list is shown, if any
  const whatsNewMode = (["new", "changed", "renamed"] as const).find(
    (m) => whatsNew && filters.only && filters.onlyTitle === whatsNewTitle(whatsNew, m),
  ) ?? null;
  const redrawnInPack = useMemo(() => rows.filter((r) => r.mine && redrawn.has(r.path)).length, [rows, redrawn]);
  const now = Date.now();
  // file times change only on reload; the stats follow the rows
  const stats = useMemo(() => progressStats(rows, Date.now()), [rows]);
  const catProgress = useMemo(() => new Map(stats.categories.map((c) => [c.key as string, c.pct])), [stats]);

  // virtual list
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    setViewport(el.clientHeight);
    return () => ro.disconnect();
  }, [view, loading]);
  useEffect(() => {
    // a new filter starts at the top
    bodyRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
  }, [filters]);
  // bring a texture picked in Ctrl+K into view
  useEffect(() => {
    if (!selected || view !== "list") return;
    const i = visible.findIndex((r) => r.path === selected);
    const el = bodyRef.current;
    if (i < 0 || !el) return;
    const top = i * ROW_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTo({ top: Math.max(0, top - el.clientHeight / 2) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const win = virtualWindow(scrollTop, viewport, ROW_H, visible.length);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = visible.findIndex((r) => r.path === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) select(next.path);
  };

  const [sharing, setSharing] = useState(false);
  const [batch, setBatch] = useState<{ scan: BatchScan; stamp: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const scanPaths = async (paths: string[]) => {
    const app = useApp.getState();
    if (paths.length === 0 || app.busy) return;
    app.setBusy({ text: "Matching the images to the textures…", done: 0, total: 0 });
    try {
      const scan = await api.batchScan(paths, pack.dir);
      if (scan.rows.length === 0) {
        app.toast("No PNG files there. Batch import takes PNG files (and their .mcmeta files).", "warn");
      } else {
        setBatch({ scan, stamp: Date.now() });
      }
    } catch (e) {
      app.showError(e, "The images could not be read");
    } finally {
      app.setBusy(null);
    }
  };
  const pickFolder = async () => {
    const dir = await open({ directory: true, title: "Folder with the PNG files to import" });
    if (typeof dir === "string") await scanPaths([dir]);
  };
  // dropping PNG files or a folder anywhere on the window
  const scanRef = useRef(scanPaths);
  scanRef.current = scanPaths;
  const batchOpen = batch !== null || sharing;
  useEffect(() => {
    if (batchOpen) return;
    let unlisten: (() => void) | null = null;
    let gone = false;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter") setDragging(p.paths.length > 0);
        else if (p.type === "leave") setDragging(false);
        else if (p.type === "drop") {
          setDragging(false);
          void scanRef.current(p.paths);
        }
      })
      .then((u) => {
        if (gone) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      gone = true;
      unlisten?.();
      setDragging(false);
    };
  }, [batchOpen]);
  const title = filters.only ? filters.onlyTitle ?? "Selected textures" : filters.category === "all" ? "All textures" : categoryLabel(filters.category);
  const total = filters.category === "all" ? rows.length : counts.byCategory[filters.category] ?? 0;
  const done = filters.category === "all"
    ? Object.values(counts.doneByCategory).reduce((a, b) => a + b, 0)
    : counts.doneByCategory[filters.category] ?? 0;

  return (
    <>
      <TopBar right={<PackChips />} />
      <div className="body">
        <NavBar />
        <aside className="side">
          {rows.length > 0 && <ProgressCard stats={stats} onOpen={() => setShowProgress(true)} />}
          <div className="group">
            <div className="caps">Categories</div>
            <button className={`cat ${filters.category === "all" && !filters.only ? "on" : ""}`} onClick={() => setFilters({ category: "all", only: null })}>
              <span className="grow">All textures</span><span className="n">{rows.length}</span>
            </button>
            {CATEGORIES.map((c) => (
              <button key={c.key} className={`cat ${filters.category === c.key && !filters.only ? "on" : ""}`} onClick={() => setFilters({ category: c.key, only: null })}>
                <span className="grow">{c.label}</span><span className="n">{counts.byCategory[c.key] ?? 0}</span>
                {catProgress.has(c.key) && (
                  <span className="catbar" title={`${catProgress.get(c.key)}% done`}><span style={{ width: `${catProgress.get(c.key)}%` }} /></span>
                )}
              </button>
            ))}
          </div>
          <div className="group">
            <div className="caps">Status</div>
            {(["all", "todo", "done", "changed"] as const).map((s) => (
              <label key={s}>
                <input type="radio" name="st" checked={filters.status === s} onChange={() => setFilters({ status: s })} />
                {s === "all" ? "All" : STATUS_TEXT[s]}
                {s !== "all" && <span className="n">{counts.status[s]}</span>}
              </label>
            ))}
          </div>
          <div className="group">
            <div className="caps">Only show</div>
            <label><input type="checkbox" checked={filters.animated} onChange={(e) => setFilters({ animated: e.target.checked })} /> Animated</label>
            <label><input type="checkbox" checked={filters.renamed} onChange={(e) => setFilters({ renamed: e.target.checked })} /> Renamed in other versions</label>
            <label><input type="checkbox" checked={filters.wrongSize} onChange={(e) => setFilters({ wrongSize: e.target.checked })} /> Wrong size for {pack.project.resolution}×</label>
            <WhatsNewPanel mode={whatsNewMode} />
          </div>
          <TeamFilters filters={filters} setFilters={setFilters} inList={inList} />
        </aside>

        <main className="main" onKeyDown={onKeyDown} tabIndex={-1} style={{ outline: "none" }}>
          <div className="listhead">
            <h1>{title}</h1>
            <span className="dim" style={{ fontSize: 12 }}>
              {filters.only ? `${visible.length} textures` : `${total} textures · ${done} done`}
            </span>
            <div className="grow" />
            <label className="searchbox">
              <Icon name="search" size={14} width={2} />
              <input
                aria-label="Filter textures"
                placeholder={`Filter ${title.toLowerCase()}`}
                value={filters.search}
                spellCheck={false}
                onChange={(e) => setFilters({ search: e.target.value, only: null })}
              />
            </label>
            <button className="btn" onClick={() => void pickFolder()} disabled={rows.length === 0 || !!busy} title="Import a folder of PNG files: each one is matched to its texture (you can also drop files or a folder on the window)">
              <span className="row" style={{ gap: 6 }}><Icon name="folder" size={14} width={2} />Batch import…</span>
            </button>
            <button className="btn" onClick={() => setSharing(true)} disabled={rows.length === 0} title="Share the to-do list (copy or save as a file)">
              <span className="row" style={{ gap: 6 }}><Icon name="share" size={14} width={2} />Share list</span>
            </button>
            <div className="viewtoggle" role="group" aria-label="View">
              <button aria-label="List view" className={view === "list" ? "on" : ""} onClick={() => setView("list")}><Icon name="list" size={14} width={2} /></button>
              <button aria-label="Grid view" className={view === "grid" ? "on" : ""} onClick={() => setView("grid")}><Icon name="textures" size={14} width={2} /></button>
            </div>
          </div>

          {whatsNew && whatsNewMode && (
            <div className="notice">
              <span>{whatsNewNotice(whatsNew, redrawnInPack)}.</span>
              <a onClick={() => setFilters({ only: null })}>Show everything</a>
            </div>
          )}
          {filters.only && !whatsNewMode && (
            <div className="notice">
              Showing the {filters.only.length} texture{filters.only.length === 1 ? "" : "s"} {filters.onlyLabel ?? "from the check"}.
              <a onClick={() => setFilters({ only: null })}>Show everything</a>
            </div>
          )}
          {elsewhere > 0 && (
            <div className="notice">
              {elsewhere} more match{elsewhere === 1 ? "" : "es"} in other categories.
              <a onClick={() => setFilters({ category: "all" })}>Search all categories</a>
            </div>
          )}

          {loading || (busy && rows.length === 0) ? (
            <div className="center">
              <div className="big">{busy ? busy.text : "Loading textures…"}</div>
              {busy && busy.total > 0 && <div>{busy.done} / {busy.total} files</div>}
              <div style={{ fontSize: 12 }}>Textures are read from your own game files. This happens once per version.</div>
            </div>
          ) : rows.length === 0 ? (
            <div className="center">
              <div className="big">The game textures are not available</div>
              <div style={{ fontSize: 12, maxWidth: 420 }}>Minecraft {pack.version?.label ?? dirName} could not be read. Start it once from the launcher, then try again.</div>
              <button className="btn" onClick={() => void reload()}>Try again</button>
            </div>
          ) : visible.length === 0 ? (
            <div className="center">
              <div className="big">No texture matches</div>
              <div style={{ fontSize: 12 }}>Change the search or the filters on the left.</div>
            </div>
          ) : view === "list" ? (
            <>
              <div className="cols thead">
                <span>NAME</span><span>SIZE</span><span>ANIMATED</span><span>STATUS</span><span>EDITED</span>
              </div>
              <div className="tbody" ref={bodyRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
                <div style={{ height: win.padTop }} />
                {visible.slice(win.first, win.last).map((r) => (
                  <div
                    key={r.path}
                    className={`cols trow ${r.path === selected ? "sel" : ""}`}
                    onClick={() => select(r.path)}
                    onDoubleClick={() => void editTexture(r.path)}
                  >
                    <span className="name">
                      <span className="thumb checker"><img className="pixel" loading="lazy" src={thumbSrc(r, dirName, stamp)} alt="" /></span>
                      <span className="mono ellipsis" title={r.path}>
                        {baseName(r.path)}
                        {filters.category === "all" || filters.only ? <span className="dim"> · {folderOf(r.path)}</span> : folderOf(r.path).includes("/") ? <span className="dim"> · {folderOf(r.path).split("/").slice(1).join("/")}</span> : null}
                      </span>
                      <NoteBadges path={r.path} />
                      {r.mine && redrawn.has(r.path) && (
                        <span className="tag redrawn" title={`Mojang redrew the game's texture in ${whatsNew!.diff.other_is_older ? whatsNew!.diff.this_version : whatsNew!.diff.other_version}: your drawing may need an update`}>redrawn by Mojang</span>
                      )}
                    </span>
                    <span style={{ color: r.wrong_size ? "var(--warn)" : "var(--text-soft)" }}>{sizeText(r)}</span>
                    <span className="dim">{r.animated ? `${r.frames} frames` : "—"}</span>
                    <span className={`status st-${r.status}`} title={r.extra ? "Not in this version" : STATUS_TEXT[r.status]}><span className="dot" /><span className="ellipsis">{r.extra ? "Not in this version" : STATUS_TEXT[r.status]}</span></span>
                    <span className="dim">{r.mine ? dayLabel(r.mine.modified_ms, now) : "—"}</span>
                  </div>
                ))}
                <div style={{ height: win.padBottom }} />
              </div>
            </>
          ) : (
            <GridView rows={visible} dirName={dirName} stamp={stamp} selected={selected} onSelect={select} />
          )}
        </main>

        <Inspector row={selectedRow} now={now} />
      </div>
      {showProgress && (
        <ProgressDialog
          stats={stats}
          packName={pack.project.name}
          onClose={() => setShowProgress(false)}
          onShowChanged={() => {
            setShowProgress(false);
            setFilters({ category: "all", status: "changed", only: null });
          }}
        />
      )}
      {sharing && <ShareDialog visible={visible} all={rows} viewTitle={title} onClose={() => setSharing(false)} />}
      {batch && <BatchImportDialog scan={batch.scan} scanStamp={batch.stamp} onClose={() => setBatch(null)} />}
      {dragging && (
        <div className="droptarget">
          <div>Drop to import into {pack.project.name}</div>
          <div className="dim">PNG files or a folder: each image is matched to its texture, then you review the list.</div>
        </div>
      )}
      <StatusBar>
        {summary && <span>{summary.done} / {summary.total} textures done</span>}
      </StatusBar>
    </>
  );
}

const GRID_BATCH = 400;

/** Grid view draws in batches as you scroll, so thousands of tiles stay light. */
function GridView({ rows, dirName, stamp, selected, onSelect }: {
  rows: TextureRow[]; dirName: string; stamp: number; selected: string | null; onSelect: (p: string) => void;
}) {
  const [shown, setShown] = useState(GRID_BATCH);
  useEffect(() => setShown(GRID_BATCH), [rows]);
  return (
    <div
      className="grid"
      onScroll={(e) => {
        const el = e.currentTarget;
        if (el.scrollTop + el.clientHeight > el.scrollHeight - 600 && shown < rows.length) setShown(shown + GRID_BATCH);
      }}
    >
      {rows.slice(0, shown).map((r) => (
        <button key={r.path} className={`tile ${r.path === selected ? "sel" : ""}`} title={r.path} onClick={() => onSelect(r.path)} onDoubleClick={() => void editTexture(r.path)}>
          <span className="thumb checker">
            <img className="pixel" loading="lazy" src={thumbSrc(r, dirName, stamp)} alt="" />
            {r.status !== "todo" && <span className="dot" style={{ background: r.status === "done" ? "var(--ok)" : "var(--warn)" }} />}
          </span>
          <span className="mono ellipsis">{baseName(r.path)}</span>
        </button>
      ))}
    </div>
  );
}


// ------------------------------------------------------- what's new

/** Side bar: "What's new since…" another installed version. */
function WhatsNewPanel({ mode }: { mode: WhatsNewMode | null }) {
  const pack = useApp((s) => s.pack)!;
  const boot = useApp((s) => s.boot);
  const busy = useApp((s) => s.busy);
  const rows = useApp((s) => s.rows);
  const whatsNew = useApp((s) => s.whatsNew);
  const setFilters = useApp((s) => s.setFilters);
  const packLabel = pack.version?.label ?? pack.project.version_id ?? pack.project.version_dir;
  const choices = useMemo(
    () => compareChoices(boot?.versions ?? [], pack.project.version_dir, packLabel),
    [boot, pack.project.version_dir, packLabel],
  );
  const [other, setOther] = useState<string | null>(() => whatsNew?.diff.other_dir ?? defaultCompareVersion(choices, packLabel));
  const inPack = useMemo(() => {
    const set = new Set(whatsNew?.diff.changed.map((c) => c.path) ?? []);
    return rows.filter((r) => r.mine && set.has(r.path)).length;
  }, [rows, whatsNew]);

  if (choices.length === 0) {
    return <div className="dim" style={{ fontSize: 11, padding: "6px 8px" }}>Install another Minecraft version to see what changed between versions.</div>;
  }
  const chosen = choices.find((v) => v.dir_name === other) ?? null;
  const current = whatsNew && whatsNew.diff.other_dir === other ? whatsNew : null;

  const show = (w: WhatsNewView, m: WhatsNewMode) => {
    useApp.getState().select(null);
    setFilters({ only: whatsNewOnly(w, m), onlyTitle: whatsNewTitle(w, m), onlyLabel: "" });
  };
  const run = async () => {
    const app = useApp.getState();
    if (!chosen || app.busy) return;
    try {
      if (!chosen.extracted) {
        app.setBusy({ text: `Extracting textures from Minecraft ${chosen.label}…`, done: 0, total: 0 });
        await api.extractVersion(chosen.dir_name);
        app.setBoot(await api.bootstrap());
      }
      app.setBusy({ text: `Comparing ${packLabel} with ${chosen.label}…`, done: 0, total: 0 });
      const w = await api.whatsNew(chosen.dir_name, pack.dir);
      app.setWhatsNew(w);
      show(w, "new");
      app.setStatus(`Compared ${packLabel} with ${chosen.label} in ${w.millis < 1000 ? `${w.millis} ms` : `${(w.millis / 1000).toFixed(1)} s`}`);
    } catch (e) {
      app.showError(e, `Minecraft ${chosen.label} could not be compared`);
    } finally {
      app.setBusy(null);
    }
  };

  const older = current?.diff.other_is_older ?? true;
  const modes: { key: WhatsNewMode; label: string; n: number }[] = current
    ? [
        { key: "new", label: older ? "New" : "Gone", n: current.diff.added.length },
        { key: "changed", label: older ? "Changed" : "Redrawn", n: current.diff.changed.length },
        { key: "renamed", label: "Renamed", n: realRenames(current).length },
      ]
    : [];
  // the other version's textures that have no match in the pack's version
  const otherOnly = current?.diff.removed ?? [];

  return (
    <div className="whatsnew">
      <div className="wn-head">What’s new since…</div>
      <div className="row" style={{ gap: 6 }}>
        <select className="input sm" aria-label="Version to compare with" value={other ?? ""} onChange={(e) => setOther(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
          {choices.map((v) => <option key={v.dir_name} value={v.dir_name}>{v.label === v.dir_name ? v.label : `${v.label} (${v.dir_name})`}</option>)}
        </select>
        {!current && (
          <button className="btn" style={{ height: 34 }} disabled={!chosen || !!busy} onClick={() => void run()} title={`Compare the game textures of ${packLabel} with another version`}>Compare</button>
        )}
      </div>
      {current && (
        <>
          <div className="seg sm" role="group" aria-label="What is new">
            {modes.map((m) => (
              <button
                key={m.key}
                className={mode === m.key ? "on" : ""}
                title={whatsNewTitle(current, m.key)}
                onClick={() => (mode === m.key ? setFilters({ only: null }) : show(current, m.key))}
              >
                <span>{m.label}</span><span className="n">{m.n}</span>
              </button>
            ))}
          </div>
          <div className="dim" style={{ fontSize: 11, padding: "0 2px" }}>
            {current.diff.changed.length} redrawn by Mojang, {inPack} of them in your pack.
          </div>
          {otherOnly.length > 0 && (
            <details className="wn-removed">
              <summary>{older ? `${otherOnly.length} removed since ${current.diff.other_version}` : `${otherOnly.length} added in ${current.diff.other_version}`}</summary>
              <div className="mono">
                {otherOnly.map((p) => <div key={p}>{p}</div>)}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Inspector: what changed for this texture since the compared version. */
function WhatsNewFacts({ row, w }: { row: TextureRow; w: WhatsNewView }) {
  const d = w.diff;
  const changed: ChangedTexture | undefined = d.changed.find((c) => c.path === row.path);
  const renamed = d.renamed.find((r) => r.to === row.path && !r.folder_only);
  const added = d.added.includes(row.path);
  if (!changed && !renamed && !added) return null;
  const older = d.other_is_older;
  // the older version on the left
  const sides = changed
    ? [
        { dir: d.other_dir, path: changed.other_path, version: d.other_version, w: changed.other_width, h: changed.other_height },
        { dir: d.this_dir, path: changed.path, version: d.this_version, w: changed.width, h: changed.height },
      ]
    : [];
  if (!older) sides.reverse();
  return (
    <div className="eras">
      <div className="caps">{older ? `Since ${d.other_version}` : `Compared with ${d.other_version}`}</div>
      {added && <div style={{ fontSize: 12 }}>{older ? `New in ${d.this_version}: not in ${d.other_version}.` : `Gone in ${d.other_version}.`}</div>}
      {renamed && (
        <div style={{ fontSize: 12 }}>
          Called <span className="mono">{renamed.from}</span> in {d.other_version}.
        </div>
      )}
      {changed && (
        <>
          <div style={{ fontSize: 12 }}>
            <span className="tag redrawn">redrawn by Mojang</span>
            {row.mine && <span style={{ color: "var(--warn)" }}> Your pack has its own drawing: check it still matches.</span>}
          </div>
          <div className="compare">
            {sides.map((s) => (
              <div key={s.version}>
                <div className="preview checker"><img className="pixel" src={images.vanillaFull(s.dir, s.path)} alt={`Game texture in ${s.version}`} /></div>
                <div className="dim" style={{ fontSize: 11 }}>{s.version} · {s.w}×{s.h}</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------- actions

/** "Edit texture" and double-click: the built-in editor, on its own tab. */
function editTexture(path: string) {
  return useEditor.getState().openTexture(path);
}

/** "Open externally": the user's own image editor; the file is watched and refreshes here on save. */
async function openExternally(path: string) {
  const app = useApp.getState();
  try {
    await api.openExternal(path);
    await app.reload(true);
    app.toast(`Opened ${baseName(path)}.png in your image editor. It refreshes here when you save.`);
  } catch (e) {
    app.showError(e, "The texture could not be opened");
  }
}

async function importImage(row: TextureRow) {
  const app = useApp.getState();
  const pack = app.pack;
  if (!pack) return;
  const src = await open({ title: `Image for ${baseName(row.path)}`, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "bmp", "gif"] }] });
  if (typeof src !== "string") return;
  const doImport = async (frametime: number | null) => {
    try {
      const r = await api.importTexture(row.path, src, frametime);
      await app.reload(true);
      const size = `${r.info.width}×${r.info.height}`;
      const notes = [
        r.wrote_mcmeta ? `as ${r.info.strip_frames} animation frames` : "",
        r.converted ? "converted to PNG" : "",
        r.replaced ? "the previous file is in the pack's trash" : "",
      ].filter(Boolean).join(", ");
      app.toast(`Imported ${baseName(row.path)} at ${size}, not resized${notes ? ` (${notes})` : ""}.`);
    } catch (e) {
      app.showError(e, "The image could not be imported");
    }
  };
  try {
    const info = await api.inspectImage(src);
    const alreadyAnimated = row.animated || row.mine?.animated;
    if (info.strip_frames && !alreadyAnimated) {
      app.ask({
        title: "Use this image as animation frames?",
        text: `The image is ${info.width}×${info.height}: that is ${info.strip_frames} square frames stacked on top of each other.`,
        hint: "As an animation, the app also writes the small .mcmeta file the game needs. The image itself is never changed.",
        buttons: [
          { label: "Cancel" },
          { label: "Keep as one image", run: () => void doImport(null) },
          { label: `Use as ${info.strip_frames} frames`, primary: true, run: () => void doImport(2) },
        ],
      });
    } else {
      await doImport(null);
    }
  } catch (e) {
    app.showError(e, "The image could not be imported");
  }
}

function revertTexture(row: TextureRow) {
  const app = useApp.getState();
  app.ask({
    title: `Remove your ${baseName(row.path)}?`,
    text: "The game's own texture will be used again.",
    hint: "Your file is not deleted: it is moved to the .packcreator/trash folder inside the pack.",
    buttons: [
      { label: "Cancel" },
      {
        label: "Revert to vanilla", danger: true,
        run: () => void api.revertTexture(row.path).then(() => app.reload(true)).then(() => app.toast(`${baseName(row.path)} is back to vanilla.`)).catch((e) => app.showError(e)),
      },
    ],
  });
}

// ------------------------------------------------------------ inspector

function Inspector({ row, now }: { row: TextureRow | null; now: number }) {
  const pack = useApp((s) => s.pack)!;
  const stamp = useApp((s) => s.stamp);
  const whatsNew = useApp((s) => s.whatsNew);
  const [detail, setDetail] = useState<TextureDetail | null>(null);
  const path = row?.path ?? null;

  useEffect(() => {
    setDetail(null);
    if (!path) return;
    let live = true;
    api.textureDetail(path).then((d) => { if (live) setDetail(d); }).catch(() => {});
    return () => { live = false; };
  }, [path, stamp]);

  if (!row) {
    return (
      <aside className="inspector">
        <div className="center" style={{ padding: 0 }}>
          <Icon name="textures" size={28} color="var(--muted)" />
          <div>Select a texture to compare it with the game’s.</div>
          <div style={{ fontSize: 12 }}>Double-click to edit it.</div>
        </div>
      </aside>
    );
  }
  const dirName = pack.project.version_dir;
  const mine = row.mine;
  const statusLine =
    row.extra ? "Not used by this version"
    : row.status === "todo" ? "To do"
    : row.status === "changed" ? `Changed since export · edited ${timeLabel(mine!.modified_ms, now)}`
    : pack.project.last_export_ms ? `Done · exported ${timeLabel(pack.project.last_export_ms, now)}`
    : `Done · edited ${timeLabel(mine!.modified_ms, now)}`;
  const usedBy = detail?.entry?.used_by ?? [];

  return (
    <aside className="inspector">
      <div>
        <div className="title">{baseName(row.path)}</div>
        <div className="sub">textures/{row.path}.png</div>
      </div>
      <div className="compare">
        <div>
          <div className="preview checker">
            {row.extra ? <span className="none">Not in the game</span> : <img className="pixel" src={images.vanillaFull(dirName, row.path)} alt="Vanilla texture" />}
          </div>
          <div className="dim" style={{ fontSize: 11 }}>Vanilla{row.extra ? "" : ` · ${row.width}×${row.height}`}</div>
        </div>
        <div>
          <div className={`preview checker ${mine ? "mine" : ""}`}>
            {mine ? <img className="pixel" src={images.packFull(row.path, mine.modified_ms || stamp)} alt="Your texture" /> : <span className="none">Not made yet</span>}
          </div>
          <div style={{ fontSize: 11, color: mine ? (row.wrong_size ? "var(--warn)" : "var(--ok)") : "var(--text-2)" }}>
            Your pack{mine ? ` · ${mine.width}×${mine.height}` : ""}{row.wrong_size ? ` · not ${pack.project.resolution}×` : ""}
          </div>
        </div>
      </div>
      <dl className="facts">
        <dt>Status</dt>
        <dd style={{ color: row.status === "done" ? "var(--ok)" : row.status === "changed" ? "var(--warn)" : "var(--text)" }}>{statusLine}</dd>
        <dt>Animated</dt>
        <dd>{row.animated ? `Yes · ${row.frames} frames${detail?.entry?.animated ? ` · ${detail.entry.frametime} tick${detail.entry.frametime === 1 ? "" : "s"} each` : ""}` : "No"}</dd>
        {usedBy.length > 0 && (
          <>
            <dt>Used by</dt>
            <dd>
              {usedBy.slice(0, 5).map((m) => <span key={m} className="tag">{m}</span>)}
              {usedBy.length + (detail?.entry?.used_by_more ?? 0) > 5 && <span className="tag">+{usedBy.length - 5 + (detail?.entry?.used_by_more ?? 0)}</span>}
            </dd>
          </>
        )}
      </dl>
      {whatsNew && <WhatsNewFacts row={row} w={whatsNew} />}
      <NotesSection path={row.path} />
      <HistorySection row={row} />
      {detail && detail.eras.length > 0 && (
        <div className="eras">
          <div className="caps">Name across versions</div>
          {detail.eras.map((e) => (
            <div key={e.label} className={`era ${e.current ? "cur" : ""}`}>
              <span className="dim" style={{ whiteSpace: "nowrap" }}>{e.label}</span>
              <span className="mono" style={{ color: e.current ? undefined : "var(--text-soft)" }}>{e.name}</span>
            </div>
          ))}
        </div>
      )}
      <div className="actions">
        <button className="btn primary block" style={{ height: 38, fontSize: 13 }} onClick={() => void editTexture(row.path)} disabled={row.extra && !mine}>Edit texture</button>
        <div className="rowbtns">
          <button className="btn" onClick={() => void importImage(row)}>Import image</button>
          <button className="btn" onClick={() => void openExternally(row.path)}>Open externally</button>
          <button className="btn ghost" onClick={() => revertTexture(row)} disabled={!mine}>Revert</button>
        </div>
      </div>
    </aside>
  );
}
