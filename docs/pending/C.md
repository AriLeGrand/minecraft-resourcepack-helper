# Package C · Organising a pack (pending notes for the lead)

## Decisions

**D-? · Notes, tags and "assigned to" per texture.**
Each texture can have a free-text note, tags (free words) and the name of
who does it. They live in `.packcreator/notes.json` (`core/src/notes.rs`),
never exported: `{"schema":1,"textures":{"block/stone":{"note","tags","assignee","updated_ms"}}}`,
keys sorted so the file diffs well when a team shares the pack in git.
Every change is read-modify-write under a process-wide lock and written in
one step (temporary file + rename). Rust cleans what it stores: text trimmed,
note cut at 4000 characters, tags and names on one line (40 characters),
duplicate tags dropped regardless of case (the first spelling wins), at most
12 tags, an empty entry removed. A missing file is an empty list; unknown
fields and invalid texture keys are ignored; a file that is not valid JSON is
renamed to `notes.damaged-<time>.json` (never deleted) and the pack starts an
empty list, which the UI reports once with a warning toast. Commands
`notes_load(packDir)` and `notes_set(path, note, packDir)` check `own_pack`.
The export check's "Rename" fix carries a texture's note (and its history
folder) to the new name; a note already on the new name is kept. In the UI
(`src/lib/notesStore.ts`) the notes are loaded once per pack. The inspector's
**Notes** section saves the note and the assignee when the field loses focus
and a tag as soon as it is added or removed; the status bar says "Saved the
notes of stone" (no toast). Tag suggestions are the tags already used (most
used first) followed by "needs redo", "waiting feedback", "in progress",
"check in game"; name suggestions are the names already used. List rows show
a note mark (with the number of tags; tooltip shows tags and note) and the
assignee's initials. The side bar's **Team** group filters by tag, by who
("Anyone / Mine / Unassigned / each name", names compared without case) and
"Has a note"; these filters combine with the others and count in "N more
matches in other categories". "Mine" needs the user's own name, typed in the
side bar ("I am") and kept on this computer only (browser storage, per
viewer, not in the pack), because the pack may be shared by several people.

**D-? · Share list: notes, tags, assignee, group by person.**
Checklist and plain text add `· tags: a, b · assigned to Alex · note: …`
after each texture (a note's line breaks become " / "). "Group by person" in
the share dialog makes one part per assignee (A→Z, any case, "Unassigned"
last) and then leaves out "assigned to". The CSV gets the columns `note`,
`tags` (joined with "; ") and `assigned_to`; the existing column that held
the automatic remarks (animated, changed since export, wrong size) was
renamed from `notes` to `details` so it is not confused with `note`. The CSV
`category` column is now the texture's own category, also when grouped by
person.

**D-? · Pack history: every replaced texture can be found and restored.**
`core/src/history.rs` lists the earlier versions of one texture from two
places: `.packcreator/trash/<time>/assets/minecraft/textures/<texture>.png`
(import, batch import, revert and any tool using `import::move_to_trash`
already put replaced files there) and a new
`.packcreator/history/<texture>/<time>.png` (`history-icon/` for the pack
icon). The editor's save (`workfile::save`) now copies the PNG it is about to
replace into the history folder during the staging step (only when the bytes
differ; a PNG that cannot be read stops the save instead of being lost). The
copy keeps the file time of the old version, so the list shows when each
version was *made* ("Today 14:32"). If the save fails, the copy is removed
again; the all-or-nothing logic is otherwise unchanged. **Restore** reads
the chosen version, writes it to a temporary file, moves the current PNG into
the history folder, then renames the temporary file into place (any failure
puts the current file back), so a restore can always be undone; the version
restored from stays where it was. Only the PNG is restored: the `.mcmeta`
stays, and the editor's layers no longer match the PNG so the editor opens
the restored PNG as one layer (its layers go to the trash on the next save,
as before). Restoring identical bytes changes nothing. Cap: the history
folder of one texture keeps at most **50 files and 20 MB**; above that the
oldest files are deleted after each save or restore, the newest is always
kept. The trash is never pruned by the app. Version ids are `h-<file>` /
`t-<trash folder>` (letters, digits, `-`, `_` only), resolved only inside the
texture's own history folder or the texture's own place in one trash folder.
Commands: `texture_history(path, packDir)` and `restore_version(path, id, packDir)`.
The `pcimg` protocol gets `pcimg://localhost/history/<id>/<texture>`, served
only for the texture whose history was listed last (remembered in the app
state) and only through `history::version_file`. Inspector: **History**
section with thumbnails and dates, click one to see it large next to the
current file, "Restore this version"; the toast after a restore has an
**Undo** button (restores the file that was just moved into the history).

**D-? · Progress stats.**
Pure helpers in `src/lib/logic.ts` (`progressStats`, `progressOf`,
`startOfWeek`): done / total overall and per category count only the
textures of the pack's game version (pack files the game does not have are
not progress); percent is rounded down (100 % only when everything is done).
"Saved today" and "this week" (from Monday 00:00, local time) count the
pack's files by their file time; "changed since export" is the status count.
Side bar: a Progress card at the top (percent, bar, "N / M done · K today")
that opens the Progress summary (overall, three counters, one bar per
category, "Show" lists the changed textures); each category row has a thin
progress bar. The Home screen's recent-pack bar is unchanged. The list
heading says "N of M textures" while a team filter is on.

## README

**Organising a pack** (texture browser): write a note, tags ("needs redo",
"waiting feedback"…) and who does it for each texture in the inspector; filter
the list by tag, by person ("Mine", "Unassigned", a name) or "Has a note";
share the to-do list grouped by person. The inspector's **History** shows the
earlier versions of a texture (every editor save, import, batch import and
revert keeps the old file) and restores any of them, undoably. A Progress
card in the side bar opens a summary: percent done overall and per category,
textures saved today and this week, and how many changed since the last
export.

## Limitations

- Restoring an earlier version restores the PNG only, not its `.mcmeta`; restoring an animation with a different number of frames may need its animation settings checked.
- The history folder of each texture is capped at 50 versions / 20 MB (oldest deleted first); the trash folder is not capped and not cleaned by the app.
- Versions of a texture saved under an old name before an export "Rename" fix are not listed under the new name when they are in the trash (the history folder and the notes do follow the rename).
- "Mine" uses a name kept in this computer's browser storage, not in the pack: it must be typed once per computer.
- Notes are not merged when two people edit `notes.json` at the same time on different computers (last save of the file wins; git shows the conflict).
- "Saved today / this week" come from file times, so copying or syncing a pack (which can change file times) changes these counts.
- The pack icon's history (`.packcreator/history-icon/`) is kept on disk but not shown in the app.
