// Notes, tags and "assigned to" in the texture browser: the inspector's
// Notes section, the side bar filters and the small marks on list rows.
import { useEffect, useMemo, useState } from "react";
import type { TextureNote } from "../lib/api";
import type { AssigneeFilter, Filters } from "../lib/logic";
import { addTag, emptyNote, hasContent, initials, nameSuggestions, tagSuggestions, usedTags } from "../lib/notes";
import { useNotes } from "../lib/notesStore";
import { Icon } from "./Icon";

/** A sheet of paper with lines (not in the shared icon list). */
export const NOTE_ICON = "M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h5";

/** Marks on a list row: note / tags, and the assignee's initials. */
export function NoteBadges({ path }: { path: string }) {
  const n = useNotes((s) => s.notes[path]);
  if (!hasContent(n)) return null;
  const about = [n.tags.length ? `Tags: ${n.tags.join(", ")}` : "", n.note.trim() ? `Note: ${n.note.trim()}` : ""].filter(Boolean).join("\n");
  return (
    <>
      {about && (
        <span className="noteflag" title={about} aria-label="Has notes">
          <Icon d={NOTE_ICON} size={13} width={1.8} />
          {n.tags.length > 0 && <span className="noteflag-n">{n.tags.length}</span>}
        </span>
      )}
      {n.assignee && <span className="initials" title={`Assigned to ${n.assignee}`}>{initials(n.assignee)}</span>}
    </>
  );
}

/** Inspector: note, tags and who does it. Text is saved when the field loses focus. */
export function NotesSection({ path }: { path: string }) {
  const stored = useNotes((s) => s.notes[path]);
  const notes = useNotes((s) => s.notes);
  const me = useNotes((s) => s.me);
  const save = useNotes((s) => s.save);
  const [draft, setDraft] = useState<TextureNote>(() => stored ?? emptyNote());
  const [tagText, setTagText] = useState("");
  // another texture, or the file changed under us: start from what is stored
  useEffect(() => {
    setDraft(stored ?? emptyNote());
    setTagText("");
  }, [path, stored]);
  const tags = useMemo(() => tagSuggestions(notes).filter((t) => !draft.tags.some((x) => x.toLowerCase() === t.toLowerCase())), [notes, draft.tags]);
  const names = useMemo(() => nameSuggestions(notes, me), [notes, me]);

  const commit = (next: TextureNote) => {
    setDraft(next);
    void save(path, next);
  };
  const pushTag = () => {
    const next = addTag(draft.tags, tagText);
    setTagText("");
    if (next !== draft.tags) commit({ ...draft, tags: next });
  };

  return (
    <div className="eras notesbox">
      <div className="caps">Notes</div>
      <textarea
        className="input notearea"
        aria-label="Note"
        placeholder="A note for this texture (what to change, ideas, feedback)…"
        value={draft.note}
        spellCheck
        onChange={(e) => setDraft({ ...draft, note: e.target.value })}
        onBlur={() => commit(draft)}
      />
      <div className="tagrow">
        {draft.tags.map((t) => (
          <span key={t} className="tag chip">
            {t}
            <button aria-label={`Remove the tag ${t}`} title="Remove" onClick={() => commit({ ...draft, tags: draft.tags.filter((x) => x !== t) })}>
              <Icon name="close" size={10} width={2.4} />
            </button>
          </span>
        ))}
        <input
          className="taginput"
          aria-label="Add a tag"
          list="pc-tag-list"
          placeholder={draft.tags.length ? "Add a tag" : "Add a tag (needs redo, waiting feedback…)"}
          value={tagText}
          onChange={(e) => setTagText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              pushTag();
            } else if (e.key === "Backspace" && tagText === "" && draft.tags.length) {
              commit({ ...draft, tags: draft.tags.slice(0, -1) });
            }
          }}
          onBlur={pushTag}
        />
        <datalist id="pc-tag-list">{tags.map((t) => <option key={t} value={t} />)}</datalist>
      </div>
      <div className="assignrow">
        <span className="dim">Assigned to</span>
        <input
          className="input sm"
          aria-label="Assigned to"
          list="pc-name-list"
          placeholder="Nobody yet"
          value={draft.assignee}
          onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
        />
        <datalist id="pc-name-list">{names.map((n) => <option key={n} value={n} />)}</datalist>
        {me && draft.assignee.trim().toLowerCase() !== me.toLowerCase() && (
          <button className="btn ghost" title={`Assign to yourself (${me})`} onClick={() => commit({ ...draft, assignee: me })}>Me</button>
        )}
      </div>
    </div>
  );
}

const assigneeValue = (a: AssigneeFilter) => (a.kind === "name" ? `name:${a.name}` : a.kind);
const parseAssignee = (v: string): AssigneeFilter =>
  v.startsWith("name:") ? { kind: "name", name: v.slice(5) } : v === "mine" ? { kind: "mine" } : v === "none" ? { kind: "none" } : { kind: "any" };

/** Side bar: filter by tag, by assignee and "Has a note". */
export function TeamFilters({ filters, setFilters, inList }: {
  filters: Filters;
  setFilters: (f: Partial<Filters>) => void;
  /** Texture paths of the pack's list (counts only count those). */
  inList: Set<string>;
}) {
  const notes = useNotes((s) => s.notes);
  const me = useNotes((s) => s.me);
  const setMe = useNotes((s) => s.setMe);
  const [meText, setMeText] = useState(me);
  useEffect(() => setMeText(me), [me]);
  const listed = useMemo(() => Object.entries(notes).filter(([p]) => inList.has(p)).map(([, n]) => n), [notes, inList]);
  const tags = useMemo(() => usedTags(Object.fromEntries(listed.map((n, i) => [i, n]))), [listed]);
  const names = useMemo(() => nameSuggestions(Object.fromEntries(listed.map((n, i) => [i, n]))), [listed]);
  const count = (pred: (n: TextureNote) => boolean) => listed.filter(pred).length;
  const lower = (s: string) => s.trim().toLowerCase();
  const withNote = count((n) => n.note.trim() !== "");
  // a filter on a tag or name nobody uses any more still shows, so it can be cleared
  const tagChoices = filters.tag && !tags.some((t) => lower(t) === lower(filters.tag!)) ? [filters.tag, ...tags] : tags;
  const a = filters.assignee;
  const nameChoices = a.kind === "name" && !names.some((n) => lower(n) === lower(a.name)) ? [a.name, ...names] : names;

  return (
    <div className="group team">
      <div className="caps">Team</div>
      <label className="sel">
        <span>Tag</span>
        <select className="input sm" aria-label="Filter by tag" value={filters.tag ?? ""} onChange={(e) => setFilters({ tag: e.target.value || null, only: null })}>
          <option value="">Any</option>
          {tagChoices.map((t) => <option key={t} value={t}>{t} ({count((n) => n.tags.some((x) => lower(x) === lower(t)))})</option>)}
        </select>
      </label>
      <label className="sel">
        <span>Who</span>
        <select className="input sm" aria-label="Filter by who does it" value={assigneeValue(a)} onChange={(e) => setFilters({ assignee: parseAssignee(e.target.value), only: null })}>
          <option value="any">Anyone</option>
          <option value="mine">Mine{me ? ` (${me})` : ""}</option>
          <option value="none">Unassigned</option>
          {nameChoices.map((n) => <option key={n} value={`name:${n}`}>{n} ({count((x) => lower(x.assignee) === lower(n))})</option>)}
        </select>
      </label>
      {a.kind === "mine" && (
        <label className="sel" title="Your name, as you write it in “Assigned to”. Kept on this computer only.">
          <span>I am</span>
          <input
            className="input sm"
            aria-label="Your name"
            list="pc-side-names"
            placeholder="Your name"
            value={meText}
            onChange={(e) => setMeText(e.target.value)}
            onBlur={() => setMe(meText)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
          />
          <datalist id="pc-side-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
        </label>
      )}
      <label>
        <input type="checkbox" checked={filters.hasNote} onChange={(e) => setFilters({ hasNote: e.target.checked, only: null })} /> Has a note
        <span className="n">{withNote}</span>
      </label>
    </div>
  );
}
