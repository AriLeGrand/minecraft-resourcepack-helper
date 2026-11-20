//! Desktop shell: thin commands over `packcreator-core`, the image protocol
//! and the file watcher. No pack logic lives here.

mod images;
mod watch;

use packcreator_core::batch::{self, BatchItem, BatchScan, ItemResult};
use packcreator_core::error::{CoreError, Result};
use packcreator_core::export::{self, AltTarget, Check, ExportKind, ExportOptions, ExportOutput};
use packcreator_core::extract;
use packcreator_core::gui::{self, Scaling};
use packcreator_core::gui_screens;
use packcreator_core::history;
use packcreator_core::import::{self, ImageInfo, ImportResult};
use packcreator_core::mcmeta::Animation;
use packcreator_core::minecraft::{self, InstalledVersion};
use packcreator_core::models;
use packcreator_core::notes;
use packcreator_core::pack::{self, PackSummary, Project};
use packcreator_core::particle_list;
use packcreator_core::particles::ParticleSheet;
use packcreator_core::rows::{self, NameEra, TextureRow};
use packcreator_core::scene;
use packcreator_core::settings::{self, RecentPack, Settings};
use packcreator_core::textures::{TextureEntry, VanillaIndex};
use packcreator_core::whats_new::{self, VersionDiff};
use packcreator_core::workfile;
use packcreator_core::McVersion;
// publishing and comparing
use packcreator_core::compare::{self, Comparison};
use packcreator_core::showcase;
use packcreator_core::{ctm, variants};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct OpenPack {
    pub dir: PathBuf,
    pub project: Project,
}

#[derive(Default)]
pub struct Inner {
    pub config_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub settings: Settings,
    pub minecraft_dir: Option<PathBuf>,
    pub versions: Vec<InstalledVersion>,
    pub indexes: HashMap<String, Arc<VanillaIndex>>,
    pub pack: Option<OpenPack>,
    pub watcher: Option<watch::PackWatcher>,
    /// The last batch-import scan: the only files the batch commands and the
    /// `pcimg://localhost/batch/<id>` route may read.
    pub batch: Option<BatchSession>,
    /// The texture whose earlier versions the inspector listed last: the only
    /// one the `pcimg://localhost/history/...` route may read versions of.
    pub history_tex: Option<String>,
    /// The last "Compare with another pack": the only files of the other pack
    /// that `compare_copy` and `pcimg://localhost/compare/<id>` may read.
    pub compare: Option<CompareSession>,
}

pub struct CompareSession {
    pub pack_dir: PathBuf,
    /// Per row id: their PNG (when they have one) and the texture it is in
    /// the open pack (when it matched one and is the file used for it).
    pub rows: Vec<(Option<PathBuf>, Option<String>)>,
}

pub struct BatchSession {
    pub pack_dir: PathBuf,
    /// Per row id: the source file and the textures it may become.
    pub rows: Vec<(PathBuf, Vec<String>)>,
}

#[derive(Default)]
pub struct AppState(pub Mutex<Inner>);

impl AppState {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn no_pack() -> CoreError {
    CoreError::new("no_pack", "No pack is open.")
        .hint("Create a pack or open one from the Home screen.")
}

impl Inner {
    fn version(&self, dir_name: &str) -> Result<InstalledVersion> {
        self.versions.iter().find(|v| v.dir_name == dir_name).cloned().ok_or_else(|| {
            CoreError::new("no_version", format!("Minecraft {dir_name} is not installed on this computer."))
                .hint("Install it from the Minecraft launcher and start it once, or pick another version.")
        })
    }

    fn index(&mut self, dir_name: &str) -> Option<Arc<VanillaIndex>> {
        if let Some(i) = self.indexes.get(dir_name) {
            return Some(i.clone());
        }
        let v = self.versions.iter().find(|v| v.dir_name == dir_name)?;
        let idx = Arc::new(extract::load_index(&self.cache_dir, v)?);
        self.indexes.insert(dir_name.to_owned(), idx.clone());
        Some(idx)
    }

    fn refresh_versions(&mut self) -> Option<CoreError> {
        self.indexes.clear();
        let dir = self
            .settings
            .minecraft_dir
            .as_ref()
            .map(PathBuf::from)
            .or_else(minecraft::default_minecraft_dir);
        self.minecraft_dir = dir.clone();
        match dir {
            None => {
                self.versions.clear();
                Some(CoreError::new(
                    "no_minecraft",
                    "The Minecraft folder could not be located.",
                ))
            }
            Some(d) => match minecraft::list_versions(&d) {
                Ok(v) => {
                    self.versions = v;
                    None
                }
                Err(e) => {
                    self.versions.clear();
                    Some(e)
                }
            },
        }
    }

    fn pack(&self) -> Result<&OpenPack> {
        self.pack.as_ref().ok_or_else(no_pack)
    }

    fn pack_version(&self) -> Result<(InstalledVersion, Option<McVersion>)> {
        let p = self.pack()?;
        let v = self.version(&p.project.version_dir)?;
        let mc = v.mc_version();
        Ok((v, mc))
    }
}

// ------------------------------------------------------------ view types

#[derive(Serialize, Clone)]
pub struct VersionView {
    #[serde(flatten)]
    pub v: InstalledVersion,
    pub extracted: bool,
    pub usable: bool,
    /// `1.21.4`, or the folder name when the version is unknown.
    pub label: String,
}

#[derive(Serialize)]
pub struct Bootstrap {
    pub app_version: String,
    pub settings: Settings,
    pub minecraft_dir: Option<String>,
    pub minecraft_error: Option<CoreError>,
    pub versions: Vec<VersionView>,
    pub default_packs_dir: String,
}

#[derive(Serialize)]
pub struct PackState {
    pub dir: String,
    pub project: Project,
    pub version: Option<VersionView>,
    pub vanilla_ready: bool,
    pub export_dir: String,
}

fn version_views(inner: &Inner) -> Vec<VersionView> {
    inner
        .versions
        .iter()
        .map(|v| VersionView {
            extracted: extract::is_extracted(&inner.cache_dir, v),
            usable: v.usable(),
            label: v.id.clone().unwrap_or_else(|| v.dir_name.clone()),
            v: v.clone(),
        })
        .collect()
}

fn default_packs_dir(app: &AppHandle, inner: &Inner) -> String {
    if let Some(d) = &inner.settings.packs_dir {
        return d.clone();
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("Minecraft Packs").to_string_lossy().into_owned()
}

fn export_dir(inner: &Inner, pack_dir: &Path) -> PathBuf {
    match &inner.settings.export_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => pack_dir.parent().unwrap_or(pack_dir).join("export"),
    }
}

fn pack_state(inner: &Inner) -> Result<PackState> {
    let p = inner.pack()?;
    let views = version_views(inner);
    let version = views
        .into_iter()
        .find(|v| v.v.dir_name == p.project.version_dir);
    Ok(PackState {
        dir: p.dir.to_string_lossy().into_owned(),
        project: p.project.clone(),
        vanilla_ready: version.as_ref().is_some_and(|v| v.extracted),
        version,
        export_dir: export_dir(inner, &p.dir).to_string_lossy().into_owned(),
    })
}

fn bootstrap_view(app: &AppHandle, inner: &Inner, err: Option<CoreError>) -> Bootstrap {
    Bootstrap {
        app_version: app.package_info().version.to_string(),
        settings: inner.settings.clone(),
        minecraft_dir: inner
            .minecraft_dir
            .as_ref()
            .map(|p| p.to_string_lossy().into_owned()),
        minecraft_error: err,
        versions: version_views(inner),
        default_packs_dir: default_packs_dir(app, inner),
    }
}

fn save_settings_now(inner: &Inner) -> Result<()> {
    settings::save(&inner.config_dir, &inner.settings)
}

fn remember_pack(inner: &mut Inner) {
    let Some(p) = &inner.pack else { return };
    let scan = pack::scan_pack(&p.dir);
    let dir_name = p.project.version_dir.clone();
    let recent = RecentPack {
        path: p.dir.to_string_lossy().into_owned(),
        name: p.project.name.clone(),
        version: p
            .project
            .version_id
            .clone()
            .unwrap_or_else(|| dir_name.clone()),
        resolution: p.project.resolution,
        opened_ms: pack::now_ms(),
        done: 0,
        total: 0,
    };
    let idx = inner.index(&dir_name);
    let summary = pack::summarize(&scan, idx.as_deref());
    let recent = RecentPack {
        done: summary.done,
        total: summary.total,
        ..recent
    };
    inner.settings.touch_recent(recent);
    let _ = save_settings_now(inner);
}

fn set_open_pack(app: &AppHandle, inner: &mut Inner, dir: PathBuf, project: Project) {
    inner.watcher = watch::PackWatcher::start(app.clone(), &dir);
    inner.pack = Some(OpenPack { dir, project });
    remember_pack(inner);
}

// --------------------------------------------------------------- commands

#[tauri::command(async)]
fn bootstrap(app: AppHandle, state: State<AppState>) -> Bootstrap {
    let mut inner = state.lock();
    let err = inner.refresh_versions();
    bootstrap_view(&app, &inner, err)
}

/// `null` must mean "clear this setting", a missing key "leave it alone".
fn nullable<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> std::result::Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}

#[derive(Deserialize)]
struct SettingsPatch {
    #[serde(default, deserialize_with = "nullable")]
    minecraft_dir: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    external_editor: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    export_dir: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    packs_dir: Option<Option<String>>,
    export_kind_folder: Option<bool>,
    export_install: Option<bool>,
    export_only_changed: Option<bool>,
    export_optimize: Option<bool>,
}

fn clean(v: Option<String>) -> Option<String> {
    v.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

#[tauri::command(async)]
fn update_settings(
    app: AppHandle,
    state: State<AppState>,
    patch: SettingsPatch,
) -> Result<Bootstrap> {
    let mut inner = state.lock();
    let mut rescan = false;
    if let Some(v) = patch.minecraft_dir {
        inner.settings.minecraft_dir = clean(v);
        rescan = true;
    }
    if let Some(v) = patch.external_editor {
        inner.settings.external_editor = clean(v);
    }
    if let Some(v) = patch.export_dir {
        inner.settings.export_dir = clean(v);
    }
    if let Some(v) = patch.packs_dir {
        inner.settings.packs_dir = clean(v);
    }
    if let Some(v) = patch.export_kind_folder {
        inner.settings.export_kind_folder = v;
    }
    if let Some(v) = patch.export_install {
        inner.settings.export_install = v;
    }
    if let Some(v) = patch.export_only_changed {
        inner.settings.export_only_changed = v;
    }
    if let Some(v) = patch.export_optimize {
        inner.settings.export_optimize = v;
    }
    save_settings_now(&inner)?;
    let err = if rescan {
        inner.refresh_versions()
    } else {
        None
    };
    Ok(bootstrap_view(&app, &inner, err))
}

#[tauri::command(async)]
fn forget_recent(app: AppHandle, state: State<AppState>, path: String) -> Result<Bootstrap> {
    let mut inner = state.lock();
    inner.settings.forget_recent(&path);
    save_settings_now(&inner)?;
    Ok(bootstrap_view(&app, &inner, None))
}

#[derive(Serialize, Clone)]
struct Progress {
    dir_name: String,
    done: usize,
    total: usize,
}

/// Extracts the textures of one version into the cache (a no-op when done).
#[tauri::command(async)]
fn extract_version(app: AppHandle, state: State<AppState>, dir_name: String) -> Result<usize> {
    let (cache, version) = {
        let inner = state.lock();
        (inner.cache_dir.clone(), inner.version(&dir_name)?)
    };
    // the lock is not held while files are written
    let name = dir_name.clone();
    let index = extract::extract_version(&cache, &version, &mut |done, total| {
        let _ = app.emit(
            "extract-progress",
            Progress {
                dir_name: name.clone(),
                done,
                total,
            },
        );
    })?;
    let count = index.entries.len();
    state.lock().indexes.insert(dir_name, Arc::new(index));
    Ok(count)
}

#[tauri::command(async)]
fn clear_cache(state: State<AppState>, dir_name: String) -> Result<()> {
    let mut inner = state.lock();
    inner.indexes.remove(&dir_name);
    extract::clear_version(&inner.cache_dir, &dir_name)
}

#[derive(Deserialize)]
struct NewPack {
    name: String,
    description: Option<String>,
    version_dir: String,
    resolution: u32,
    location: String,
}

#[tauri::command(async)]
fn create_pack(app: AppHandle, state: State<AppState>, input: NewPack) -> Result<PackState> {
    let mut inner = state.lock();
    let version = inner.version(&input.version_dir)?;
    if !version.usable() {
        return Err(CoreError::new(
            "no_jar",
            format!("Minecraft {} cannot be used yet.", version.dir_name),
        )
        .hint("Start this version once from the Minecraft launcher, then try again."));
    }
    let dir = PathBuf::from(input.location.trim());
    if !dir.is_absolute() {
        return Err(CoreError::new(
            "bad_path",
            "Choose a full folder path for the pack, for example D:\\Packs\\My Pack.",
        ));
    }
    let description = input
        .description
        .unwrap_or_else(|| format!("{} resource pack", input.name.trim()));
    let project = pack::create_pack(&dir, &input.name, &description, &version, input.resolution)?;
    if let Some(parent) = dir.parent() {
        inner.settings.packs_dir = Some(parent.to_string_lossy().into_owned());
    }
    set_open_pack(&app, &mut inner, dir, project);
    pack_state(&inner)
}

#[tauri::command(async)]
fn open_pack(app: AppHandle, state: State<AppState>, path: String) -> Result<PackState> {
    let mut inner = state.lock();
    let dir = PathBuf::from(path);
    let project = pack::open_pack(&dir, &inner.versions)?;
    set_open_pack(&app, &mut inner, dir, project);
    pack_state(&inner)
}

#[tauri::command(async)]
fn import_zip(
    app: AppHandle,
    state: State<AppState>,
    zip: String,
    dest: String,
) -> Result<PackState> {
    let mut inner = state.lock();
    let dir = PathBuf::from(dest);
    export::import_zip(Path::new(&zip), &dir)?;
    let project = pack::open_pack(&dir, &inner.versions)?;
    set_open_pack(&app, &mut inner, dir, project);
    pack_state(&inner)
}

#[tauri::command(async)]
fn close_pack(state: State<AppState>) {
    let mut inner = state.lock();
    remember_pack(&mut inner);
    inner.pack = None;
    inner.watcher = None;
    inner.settings.last_pack = None;
    let _ = save_settings_now(&inner);
}

#[tauri::command(async)]
fn get_pack(state: State<AppState>) -> Result<PackState> {
    pack_state(&state.lock())
}

#[derive(Deserialize)]
struct ProjectPatch {
    name: Option<String>,
    description: Option<String>,
    also_export: Option<Vec<String>>,
    resolution: Option<u32>,
}

#[tauri::command(async)]
fn update_project(state: State<AppState>, patch: ProjectPatch) -> Result<PackState> {
    let mut inner = state.lock();
    let p = inner.pack.as_mut().ok_or_else(no_pack)?;
    if let Some(n) = patch.name {
        let n = n.trim();
        if n.is_empty() {
            return Err(CoreError::new("bad_name", "Give the pack a name."));
        }
        p.project.name = n.to_owned();
    }
    if let Some(d) = patch.description {
        p.project.description = d;
    }
    if let Some(a) = patch.also_export {
        p.project.also_export = a;
    }
    if let Some(r) = patch.resolution {
        if !pack::RESOLUTIONS.contains(&r) {
            return Err(CoreError::new(
                "bad_resolution",
                format!("{r}× is not a supported resolution."),
            ));
        }
        p.project.resolution = r;
    }
    pack::save_project(&p.dir, &p.project)?;
    pack::write_pack_mcmeta(&p.dir, &p.project)?;
    pack_state(&inner)
}

#[derive(Serialize)]
struct TextureList {
    rows: Vec<TextureRow>,
    summary: PackSummary,
}

#[tauri::command(async)]
fn load_textures(state: State<AppState>) -> Result<TextureList> {
    let mut inner = state.lock();
    let (dir, project) = {
        let p = inner.pack()?;
        (p.dir.clone(), p.project.clone())
    };
    let (_, mc) = inner.pack_version()?;
    let index = inner.index(&project.version_dir).ok_or_else(|| {
        CoreError::new(
            "not_extracted",
            "The game textures for this version are not extracted yet.",
        )
    })?;
    drop(inner);
    let scan = pack::scan_pack(&dir);
    Ok(TextureList {
        rows: rows::build_rows(&index, &scan, &project, mc.as_ref()),
        summary: pack::summarize(&scan, Some(&index)),
    })
}

#[derive(Serialize)]
struct TextureDetail {
    entry: Option<TextureEntry>,
    eras: Vec<NameEra>,
    pack_file: String,
}

#[tauri::command(async)]
fn texture_detail(state: State<AppState>, path: String) -> Result<TextureDetail> {
    let mut inner = state.lock();
    let (dir, version_dir) = {
        let p = inner.pack()?;
        (p.dir.clone(), p.project.version_dir.clone())
    };
    let (_, mc) = inner.pack_version()?;
    let index = inner.index(&version_dir);
    Ok(TextureDetail {
        entry: index.and_then(|i| i.get(&path).cloned()),
        eras: mc.map(|v| rows::name_eras(&path, &v)).unwrap_or_default(),
        pack_file: packcreator_core::textures::texture_file(&dir, &path)?
            .to_string_lossy()
            .into_owned(),
    })
}

#[tauri::command(async)]
fn inspect_image(path: String) -> Result<ImageInfo> {
    import::inspect_image(Path::new(&path))
}

#[tauri::command(async)]
fn import_texture(
    state: State<AppState>,
    path: String,
    source: String,
    frametime: Option<u32>,
) -> Result<ImportResult> {
    let dir = state.lock().pack()?.dir.clone();
    let anim = frametime.map(|f| Animation {
        frametime: f.max(1),
        ..Default::default()
    });
    import::import_image(&dir, &path, Path::new(&source), anim.as_ref())
}

/// Makes sure the pack has a file for this texture (starting from the game's
/// texture at the pack resolution) and returns its path.
fn working_file(inner: &Inner, path: &str) -> Result<PathBuf> {
    let p = inner.pack()?;
    let root = extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir);
    let cat = packcreator_core::textures::category_of(path);
    let scale = if cat.uses_pack_resolution() {
        (p.project.resolution / 16).max(1)
    } else {
        1
    };
    import::start_from_vanilla(&root, &p.dir, path, scale)
}

#[tauri::command(async)]
fn open_external(app: AppHandle, state: State<AppState>, path: String) -> Result<String> {
    let (file, editor) = {
        let inner = state.lock();
        (
            working_file(&inner, &path)?,
            inner.settings.external_editor.clone(),
        )
    };
    launch(&app, &file, editor.as_deref())?;
    Ok(file.to_string_lossy().into_owned())
}

fn launch(app: &AppHandle, file: &Path, editor: Option<&str>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    match editor {
        Some(exe) => std::process::Command::new(exe).arg(file).spawn().map(|_| ()).map_err(|e| {
            CoreError::new("editor", format!("Could not start {exe}: {e}"))
                .hint("Check the external editor path in Settings, or clear it to use the default program for PNG files.")
        }),
        None => app.opener().open_path(file.to_string_lossy(), None::<&str>).map_err(|e| {
            CoreError::new("editor", format!("Windows could not open the file: {e}"))
                .hint("Choose an editor in Settings (for example Aseprite.exe).")
        }),
    }
}

/// The open pack, but only when it is the pack the editor tab belongs to.
/// The check runs under the state lock, so a pack that is being switched at
/// this moment can never receive another pack's texture.
fn own_pack<'a>(inner: &'a Inner, pack_dir: &str) -> Result<&'a OpenPack> {
    let p = inner.pack()?;
    if p.dir != Path::new(pack_dir) {
        return Err(CoreError::new(
            "wrong_pack",
            "This texture belongs to a pack that is not the open one, so nothing was read or written.",
        )
        .hint(format!("Open the pack in {pack_dir} again, then try once more.")));
    }
    Ok(p)
}

#[derive(Serialize)]
struct WhatsNewView {
    diff: VersionDiff,
    /// Changed textures (pack's names) the pack has its own file for.
    changed_in_pack: Vec<String>,
    /// How long the comparison took (0 or close when it came from the cache).
    millis: u64,
}

/// "What's new in this version": the pack's version compared with another
/// installed one. The other version is extracted first if needed (with the
/// usual progress events); the result is cached per pair of jars.
#[tauri::command(async)]
fn whats_new(
    app: AppHandle,
    state: State<AppState>,
    other_dir_name: String,
    pack_dir: String,
) -> Result<WhatsNewView> {
    let started = std::time::Instant::now();
    let (dir, cache, this, other, this_index) = {
        let mut inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        let dir = p.dir.clone();
        let version_dir = p.project.version_dir.clone();
        let this = inner.version(&version_dir)?;
        let other = inner.version(&other_dir_name)?;
        let index = inner.index(&version_dir).ok_or_else(|| {
            CoreError::new(
                "not_extracted",
                "The game textures for this version are not extracted yet.",
            )
        })?;
        (dir, inner.cache_dir.clone(), this, other, index)
    };
    let emit = |done: usize, total: usize| {
        let _ = app.emit(
            "extract-progress",
            Progress {
                dir_name: other_dir_name.clone(),
                done,
                total,
            },
        );
    };
    // the lock is not held while files are extracted or compared
    let other_index = Arc::new(extract::extract_version(&cache, &other, &mut |d, t| {
        emit(d, t)
    })?);
    state
        .lock()
        .indexes
        .insert(other_dir_name.clone(), other_index.clone());
    let diff = whats_new::compare(&cache, &this, &this_index, &other, &other_index, &emit)?;
    let mine: std::collections::HashSet<String> =
        pack::scan_pack(&dir).into_iter().map(|t| t.path).collect();
    let changed_in_pack = diff
        .changed
        .iter()
        .filter(|c| mine.contains(&c.path))
        .map(|c| c.path.clone())
        .collect();
    own_pack(&state.lock(), &pack_dir)?;
    Ok(WhatsNewView {
        diff,
        changed_in_pack,
        millis: started.elapsed().as_millis() as u64,
    })
}

/// Batch import, step 1: matches every PNG of `paths` (a folder, or dropped
/// files and folders) to a texture of the pack's version. Nothing is written. The rows are remembered so that only
/// these files can be shown or imported afterwards.
#[tauri::command(async)]
fn batch_scan(state: State<AppState>, paths: Vec<String>, pack_dir: String) -> Result<BatchScan> {
    let (dir, resolution, version_dir) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        (
            p.dir.clone(),
            p.project.resolution,
            p.project.version_dir.clone(),
        )
    };
    let (index, mc) = {
        let mut inner = state.lock();
        let (_, mc) = inner.pack_version()?;
        let index = inner.index(&version_dir).ok_or_else(|| {
            CoreError::new(
                "not_extracted",
                "The game textures for this version are not extracted yet.",
            )
        })?;
        (index, mc)
    };
    let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    let scan = batch::scan(&sources, &dir, &index, mc.as_ref(), resolution)?;
    let mut inner = state.lock();
    own_pack(&inner, &pack_dir)?;
    inner.batch = Some(BatchSession {
        pack_dir: dir,
        rows: scan
            .rows
            .iter()
            .map(|r| {
                let targets = r.candidates.iter().map(|c| c.path.clone()).collect();
                (PathBuf::from(&r.source), targets)
            })
            .collect(),
    });
    Ok(scan)
}

/// Batch import, step 2: imports the accepted rows of the last scan. Each
/// item gets its own result; a failure does not stop the others.
#[tauri::command(async)]
fn batch_import(
    state: State<AppState>,
    items: Vec<BatchItem>,
    pack_dir: String,
) -> Result<Vec<ItemResult>> {
    let (dir, work, mut refused) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        let session = inner
            .batch
            .as_ref()
            .filter(|b| b.pack_dir == p.dir)
            .ok_or_else(|| CoreError::new("no_scan", "Scan the folder again, then import."))?;
        let mut work = Vec::new();
        let mut refused = Vec::new();
        for it in items {
            match session.rows.get(it.id) {
                Some((src, targets)) if targets.contains(&it.target) => {
                    work.push((it.id, src.clone(), it.target, it.frames))
                }
                _ => refused.push(ItemResult {
                    id: it.id,
                    target: it.target,
                    ok: false,
                    replaced: false,
                    wrote_mcmeta: false,
                    unchanged: false,
                    error: Some(CoreError::new(
                        "bad_item",
                        "This file was not matched to that texture by the scan.",
                    )),
                }),
            }
        }
        (p.dir.clone(), work, refused)
    };
    let mut out = batch::import_all(&dir, &work);
    out.append(&mut refused);
    Ok(out)
}

/// Opens a texture (or the pack icon) in the built-in editor. Nothing is
/// written until it is saved.
#[tauri::command(async)]
fn editor_open(
    state: State<AppState>,
    path: String,
    pack_dir: String,
) -> Result<workfile::OpenedRaw> {
    let inner = state.lock();
    let p = own_pack(&inner, &pack_dir)?;
    let root = extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir);
    let cat = packcreator_core::textures::category_of(&path);
    // the shared particle sheet of old versions follows the pack resolution too
    let sheet = path == ParticleSheet::builtin().file;
    let scale = if path != workfile::ICON_PATH && (cat.uses_pack_resolution() || sheet) {
        (p.project.resolution / 16).max(1)
    } else {
        1
    };
    workfile::open_raw(&p.dir, &root, &path, scale)
}

/// Saves the document: flattened PNG into the pack, layers into the working file.
#[tauri::command(async)]
fn editor_save(
    state: State<AppState>,
    path: String,
    doc: workfile::RawDoc,
    flat: String,
    pack_dir: String,
) -> Result<()> {
    let (dir, vanilla) = model_roots(&state, &pack_dir)?;
    let first = packcreator_core::textures::texture_file(&dir, &path).is_ok_and(|f| !f.is_file());
    workfile::save_raw(&dir, &path, &doc, &flat)?;
    // a new interface sprite keeps the game's stretch rule (see gui::keep_vanilla_scaling)
    if first {
        gui::keep_vanilla_scaling(&dir, &vanilla, &path)?;
    }
    Ok(())
}

/// The `.mcmeta` text a save of this animation would write (merged with the
/// pack's existing file), for the animation screen.
#[tauri::command(async)]
fn animation_mcmeta(
    state: State<AppState>,
    path: String,
    animation: Option<packcreator_core::mcmeta::Animation>,
    times: Vec<Option<u32>>,
    pack_dir: String,
) -> Result<String> {
    let dir = own_pack(&state.lock(), &pack_dir)?.dir.clone();
    workfile::mcmeta_preview(&dir, &path, animation.as_ref(), &times, times.len())
}

/// The pack folder and the extracted game folder of the editor tab's pack.
fn model_roots(state: &State<AppState>, pack_dir: &str) -> Result<(PathBuf, PathBuf)> {
    let inner = state.lock();
    let p = own_pack(&inner, pack_dir)?;
    let vanilla = extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir);
    Ok((p.dir.clone(), vanilla))
}

/// A block model, resolved for the 3D preview (the pack's model files win).
#[tauri::command(async)]
fn block_model(
    state: State<AppState>,
    name: String,
    pack_dir: String,
) -> Result<models::BlockModel> {
    let (pack, vanilla) = model_roots(&state, &pack_dir)?;
    models::block_model(Some(&pack), &vanilla, &name)
}

/// The models the 3D preview offers for a texture: the cube, then the block
/// models that use it, most useful first.
#[tauri::command(async)]
fn models_for_texture(
    state: State<AppState>,
    path: String,
    pack_dir: String,
) -> Result<Vec<models::ModelChoice>> {
    let (pack, vanilla) = model_roots(&state, &pack_dir)?;
    Ok(models::models_for_texture(Some(&pack), &vanilla, &path))
}

// ---- Scene screen (package B) ----

/// The blocks of a scene, each resolved to the models of its default state.
#[tauri::command(async)]
fn scene_blocks(
    state: State<AppState>,
    ids: Vec<String>,
    pack_dir: String,
) -> Result<Vec<scene::SceneBlock>> {
    let (pack, vanilla) = model_roots(&state, &pack_dir)?;
    Ok(scene::scene_blocks(Some(&pack), &vanilla, &ids))
}

/// Every block the scene can place (blockstate names of the game and the pack).
#[tauri::command(async)]
fn scene_block_list(state: State<AppState>, pack_dir: String) -> Result<Vec<String>> {
    let (pack, vanilla) = model_roots(&state, &pack_dir)?;
    Ok(scene::list_blocks(Some(&pack), &vanilla))
}

/// The custom scene saved in `.packcreator/scene.json`, if any.
#[tauri::command(async)]
fn scene_load(state: State<AppState>, pack_dir: String) -> Result<Option<scene::SceneFile>> {
    let (pack, _) = model_roots(&state, &pack_dir)?;
    scene::load_scene(&pack)
}

/// Saves the custom scene into `.packcreator/scene.json`.
#[tauri::command(async)]
fn scene_save(state: State<AppState>, scene: scene::SceneFile, pack_dir: String) -> Result<()> {
    let (pack, _) = model_roots(&state, &pack_dir)?;
    scene::save_scene(&pack, &scene)
}

/// Every particle of the pack's version, for the particle viewer.
#[tauri::command(async)]
fn particle_list(state: State<AppState>, pack_dir: String) -> Result<particle_list::ParticleList> {
    let (pack, vanilla, version) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        let version = inner.pack_version().ok().and_then(|(_, mc)| mc);
        (
            p.dir.clone(),
            extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir),
            version,
        )
    };
    particle_list::list(&pack, &vanilla, version.as_ref())
}

/// "Add frame": copies the particle's last frame into a new image in the pack
/// and appends it to the pack's `particles/<id>.json`.
#[tauri::command(async)]
fn particle_add_frame(
    state: State<AppState>,
    id: String,
    pack_dir: String,
) -> Result<particle_list::AddedFrame> {
    let (pack, vanilla) = model_roots(&state, &pack_dir)?;
    particle_list::add_frame(&pack, &vanilla, &id)
}

/// Every interface screen and piece for the pack's version, with status.
#[tauri::command(async)]
fn gui_overview(state: State<AppState>, pack_dir: String) -> Result<gui_screens::GuiOverview> {
    let (pack, vanilla, version) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        let version = inner.pack_version().ok().and_then(|(_, mc)| mc);
        (
            p.dir.clone(),
            extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir),
            version,
        )
    };
    gui_screens::overview(&pack, &vanilla, version.as_ref())
}

/// The pack folder and game folder for a stretch-rule command, refused for
/// anything but a sprite of a version that has stretch rules.
fn sprite_roots(state: &State<AppState>, pack_dir: &str, path: &str) -> Result<(PathBuf, PathBuf)> {
    let inner = state.lock();
    let p = own_pack(&inner, pack_dir)?;
    let version = inner.pack_version().ok().and_then(|(_, mc)| mc);
    if version.is_some_and(|v| gui_screens::Regions::builtin().applies_to(&v)) {
        return Err(CoreError::new(
            "no_scaling",
            "This Minecraft version has no stretch rules: interface pieces are fixed rectangles of shared images.",
        ));
    }
    if !path.starts_with("gui/sprites/") {
        return Err(CoreError::new(
            "no_scaling",
            format!("{path} is drawn at a fixed size; only images in gui/sprites/ can have a stretch rule."),
        ));
    }
    Ok((
        p.dir.clone(),
        extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir),
    ))
}

/// The exact `.mcmeta` text the pack would have with this stretch rule
/// (`None` = no file).
#[tauri::command(async)]
fn gui_scaling_preview(
    state: State<AppState>,
    path: String,
    scaling: Scaling,
    pack_dir: String,
) -> Result<Option<String>> {
    let (pack, vanilla) = sprite_roots(&state, &pack_dir, &path)?;
    gui::preview(&pack, &vanilla, &path, &scaling)
}

/// Writes a sprite's stretch rule into the pack. Returns the file before
/// and after (for Undo).
#[tauri::command(async)]
fn gui_set_scaling(
    state: State<AppState>,
    path: String,
    scaling: Scaling,
    pack_dir: String,
) -> Result<gui::MetaChange> {
    let (pack, vanilla) = sprite_roots(&state, &pack_dir, &path)?;
    gui::set_scaling(&pack, &vanilla, &path, &scaling)
}

/// Undo: puts the pack's `.mcmeta` of a sprite back exactly as it was
/// (`None` removes it).
#[tauri::command(async)]
fn gui_restore_mcmeta(
    state: State<AppState>,
    path: String,
    text: Option<String>,
    pack_dir: String,
) -> Result<()> {
    let (pack, _) = sprite_roots(&state, &pack_dir, &path)?;
    gui::put_mcmeta(&pack, &path, text.as_deref())
}

/// Reads an image file as raw RGBA, pixel-exact ("Import strip").
#[tauri::command(async)]
fn read_image_raw(path: String) -> Result<workfile::RawImage> {
    workfile::read_image_raw(Path::new(&path))
}

/// Saves a shared to-do list (already formatted by the UI) to a .md, .txt or
/// .csv file the user chose in the save dialog.
#[tauri::command(async)]
fn save_share_list(path: String, text: String) -> Result<()> {
    packcreator_core::share::write_list(Path::new(&path), &text)
}

#[tauri::command(async)]
fn reveal(app: AppHandle, path: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&path).map_err(|e| {
        CoreError::new(
            "reveal",
            format!("Could not show {path} in the file explorer: {e}"),
        )
    })
}

#[tauri::command(async)]
fn revert_texture(state: State<AppState>, path: String) -> Result<bool> {
    let dir = state.lock().pack()?.dir.clone();
    import::revert(&dir, &path)
}

#[tauri::command(async)]
fn set_pack_icon(state: State<AppState>, source: String) -> Result<()> {
    let dir = state.lock().pack()?.dir.clone();
    let info = import::inspect_image(Path::new(&source))?;
    if info.width != info.height {
        return Err(CoreError::new(
            "bad_icon",
            format!(
                "The icon must be square; this image is {}×{}.",
                info.width, info.height
            ),
        )
        .hint("Use a square image such as 128×128 or 256×256."));
    }
    if !info.is_png {
        return Err(CoreError::new("bad_icon", "The icon must be a PNG file."));
    }
    let dest = dir.join("pack.png");
    import::move_to_trash(&dir, &dest, pack::now_ms())?;
    std::fs::copy(&source, &dest)
        .map(|_| ())
        .map_err(|e| CoreError::io(&dest, &e))
}

#[tauri::command(async)]
fn edit_pack_icon(app: AppHandle, state: State<AppState>) -> Result<()> {
    let (file, editor) = {
        let inner = state.lock();
        (
            inner.pack()?.dir.join("pack.png"),
            inner.settings.external_editor.clone(),
        )
    };
    launch(&app, &file, editor.as_deref())
}

struct CheckContext {
    dir: PathBuf,
    project: Project,
    index: Option<Arc<VanillaIndex>>,
    version: Option<McVersion>,
}

fn check_context(state: &State<AppState>) -> Result<CheckContext> {
    let mut inner = state.lock();
    let (dir, project) = {
        let p = inner.pack()?;
        (p.dir.clone(), p.project.clone())
    };
    let version = inner.pack_version().ok().and_then(|(_, mc)| mc);
    let index = inner.index(&project.version_dir);
    Ok(CheckContext {
        dir,
        project,
        index,
        version,
    })
}

#[tauri::command(async)]
fn run_checks(state: State<AppState>) -> Result<Vec<Check>> {
    let c = check_context(&state)?;
    let scan = pack::scan_pack(&c.dir);
    Ok(export::run_checks(
        &c.dir,
        &c.project,
        &scan,
        c.index.as_deref(),
        c.version.as_ref(),
    ))
}

#[tauri::command(async)]
fn apply_fix(state: State<AppState>, id: String) -> Result<String> {
    let c = check_context(&state)?;
    let scan = pack::scan_pack(&c.dir);
    export::apply_fix(
        &c.dir,
        &c.project,
        &id,
        &scan,
        c.index.as_deref(),
        c.version.as_ref(),
    )
}

#[derive(Deserialize)]
struct ExportRequest {
    folder: bool,
    install: bool,
    only_changed: bool,
    also: Vec<String>,
    /// "Make PNG files smaller (same pixels)".
    #[serde(default)]
    optimize_png: bool,
}

#[derive(Serialize)]
struct ExportReport {
    outputs: Vec<ExportOutput>,
    pack: PackState,
}

#[tauri::command(async)]
fn export_pack(state: State<AppState>, request: ExportRequest) -> Result<ExportReport> {
    let (dir, project, main, alts, opts) = {
        let mut inner = state.lock();
        let (dir, project) = {
            let p = inner.pack()?;
            (p.dir.clone(), p.project.clone())
        };
        let (_, mc) = inner.pack_version()?;
        let main = mc.ok_or_else(|| {
            CoreError::new(
                "no_version",
                "The pack's Minecraft version could not be identified.",
            )
        })?;
        let mut alts = Vec::new();
        for name in &request.also {
            let v = inner.version(name)?;
            let (Some(version), Some(format)) = (v.mc_version(), v.format) else {
                return Err(CoreError::new(
                    "no_version",
                    format!("{name} cannot be used as an export target."),
                )
                .hint("Start that version once from the Minecraft launcher."));
            };
            alts.push(AltTarget {
                label: v.id.clone().unwrap_or_else(|| v.dir_name.clone()),
                version,
                format,
                index: inner.index(name).map(|i| (*i).clone()),
            });
        }
        let install_dir = if request.install {
            let mc_dir = inner.minecraft_dir.clone().ok_or_else(|| {
                CoreError::new(
                    "no_minecraft",
                    "The Minecraft folder is not known, so the pack cannot be installed.",
                )
                .hint(
                    "Set the Minecraft folder in Settings, or turn off \"Install into Minecraft\".",
                )
            })?;
            Some(mc_dir.join("resourcepacks"))
        } else {
            None
        };
        let opts = ExportOptions {
            kind: if request.folder {
                ExportKind::Folder
            } else {
                ExportKind::Zip
            },
            out_dir: export_dir(&inner, &dir),
            install_dir,
            only_changed: request.only_changed,
            vanilla_root: Some(extract::vanilla_dir(&inner.cache_dir, &project.version_dir)),
            optimize_png: request.optimize_png,
        };
        inner.settings.export_optimize = request.optimize_png;
        inner.settings.export_kind_folder = request.folder;
        inner.settings.export_install = request.install;
        inner.settings.export_only_changed = request.only_changed;
        let _ = save_settings_now(&inner);
        (dir, project, main, alts, opts)
    };
    let outputs = export::export_pack(&dir, &project, &main, &alts, &opts)?;
    let mut inner = state.lock();
    if let Some(p) = inner.pack.as_mut() {
        p.project.last_export_ms = Some(pack::now_ms());
        p.project.also_export = request.also;
        pack::save_project(&p.dir, &p.project)?;
    }
    remember_pack(&mut inner);
    Ok(ExportReport {
        outputs,
        pack: pack_state(&inner)?,
    })
}

// --------------------------------------------- publishing and comparing

/// Saves the showcase image drawn by the UI (raw RGBA, base64) as a PNG file
/// the user chose. Only `.png` files are written.
#[tauri::command(async)]
fn save_showcase(path: String, width: u32, height: u32, rgba: String) -> Result<u64> {
    showcase::save(Path::new(&path), width, height, &rgba)
}

/// "Compare with another pack": reads a `.zip` (unpacked into the cache,
/// safe paths and size caps) or a folder, and compares its textures with the
/// open pack's. The rows are remembered for `compare_copy` and the image route.
#[tauri::command(async)]
fn compare_packs(state: State<AppState>, source: String, pack_dir: String) -> Result<Comparison> {
    let (dir, version_dir, cache) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        (
            p.dir.clone(),
            p.project.version_dir.clone(),
            inner.cache_dir.clone(),
        )
    };
    let (index, mc) = {
        let mut inner = state.lock();
        let (_, mc) = inner.pack_version()?;
        let index = inner.index(&version_dir).ok_or_else(|| {
            CoreError::new(
                "not_extracted",
                "The game textures for this version are not extracted yet.",
            )
        })?;
        // the earlier comparison's files are about to go
        inner.compare = None;
        (index, mc)
    };
    let work_parent = cache.join("compare");
    compare::clear_work(&work_parent);
    let work = work_parent.join(pack::now_ms().to_string());
    let source_path = PathBuf::from(&source);
    let their = compare::open_their_pack(&source_path, &dir, &work)?;
    let result = compare::compare(&source_path, &their, &dir, &index, mc.as_ref())?;
    let mut inner = state.lock();
    own_pack(&inner, &pack_dir)?;
    inner.compare = Some(CompareSession {
        pack_dir: dir,
        rows: result
            .rows
            .iter()
            .map(|r| {
                let file = compare::their_file(&their.root, r);
                let target = r.path.clone().filter(|_| r.shadowed_by.is_none());
                (file, target)
            })
            .collect(),
    });
    Ok(result)
}

/// "Copy theirs into my pack" for rows of the last comparison: each PNG (and
/// its `.mcmeta`) byte for byte, replaced files to the trash.
#[tauri::command(async)]
fn compare_copy(
    state: State<AppState>,
    ids: Vec<usize>,
    pack_dir: String,
) -> Result<Vec<ItemResult>> {
    let (dir, work, mut refused) = {
        let inner = state.lock();
        let p = own_pack(&inner, &pack_dir)?;
        let session = inner
            .compare
            .as_ref()
            .filter(|c| c.pack_dir == p.dir)
            .ok_or_else(|| CoreError::new("no_compare", "Compare the packs again, then copy."))?;
        let mut work = Vec::new();
        let mut refused = Vec::new();
        for id in ids {
            match session.rows.get(id) {
                Some((Some(src), Some(target))) => work.push((id, src.clone(), target.clone(), false)),
                _ => refused.push(ItemResult {
                    id,
                    target: String::new(),
                    ok: false,
                    replaced: false,
                    wrote_mcmeta: false,
                    unchanged: false,
                    error: Some(CoreError::new(
                        "bad_item",
                        "This row has no file of the other pack that matches a texture of this pack.",
                    )),
                }),
            }
        }
        (p.dir.clone(), work, refused)
    };
    let mut out = batch::import_all(&dir, &work);
    out.append(&mut refused);
    Ok(out)
}

// ------------------------------------------------- variety (random variants, CTM)

/// Pack folder, game folder, era (before 1.13?) and enlargement (pack
/// resolution / 16) for the Variety screen, for the pack the screen belongs to.
fn variety_roots(state: &State<AppState>, pack_dir: &str) -> Result<(PathBuf, PathBuf, bool, u32)> {
    let inner = state.lock();
    let p = own_pack(&inner, pack_dir)?;
    let vanilla = extract::vanilla_dir(&inner.cache_dir, &p.project.version_dir);
    let flat = McVersion::parse("1.13").expect("valid version");
    let legacy = match inner.pack_version().ok().and_then(|(_, mc)| mc) {
        Some(v) => v < flat,
        // unknown version: old versions keep block textures in `blocks/`
        None => vanilla.join("assets/minecraft/textures/blocks").is_dir(),
    };
    Ok((
        p.dir.clone(),
        vanilla,
        legacy,
        (p.project.resolution / 16).max(1),
    ))
}

macro_rules! roots {
    ($t:expr) => {
        variants::Roots {
            pack: &$t.0,
            vanilla: &$t.1,
            legacy: $t.2,
        }
    };
}

/// Every block with a block state file (game or pack).
#[tauri::command(async)]
fn variety_blocks(state: State<AppState>, pack_dir: String) -> Result<Vec<variants::BlockEntry>> {
    let t = variety_roots(&state, &pack_dir)?;
    Ok(variants::list_blocks(&t.0, &t.1))
}

#[tauri::command(async)]
fn variants_info(
    state: State<AppState>,
    block: String,
    pack_dir: String,
) -> Result<variants::BlockInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    variants::info(roots!(t), &block)
}

/// Adds the next random variant of `texture` (texture copy, models, block state).
#[tauri::command(async)]
fn variants_add(
    state: State<AppState>,
    block: String,
    texture: String,
    pack_dir: String,
) -> Result<variants::Added> {
    let t = variety_roots(&state, &pack_dir)?;
    variants::add(roots!(t), &block, &texture, t.3)
}

/// Weight / random turns of the original (`n` 1) or of variant `n`.
#[tauri::command(async)]
fn variants_set(
    state: State<AppState>,
    block: String,
    n: u32,
    weight: u32,
    rotate: bool,
    pack_dir: String,
) -> Result<variants::BlockInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    variants::set_choice(roots!(t), &block, n, variants::Choice { weight, rotate })
}

/// Removes variant `n` (its files go to the trash).
#[tauri::command(async)]
fn variants_remove(
    state: State<AppState>,
    block: String,
    n: u32,
    pack_dir: String,
) -> Result<variants::BlockInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    variants::remove(roots!(t), &block, n)
}

#[tauri::command(async)]
fn ctm_info(state: State<AppState>, block: String, pack_dir: String) -> Result<ctm::CtmInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    ctm::info(roots!(t), &block)
}

/// Writes the five starting tiles and the `.properties` file (old files to the trash).
#[tauri::command(async)]
fn ctm_create(
    state: State<AppState>,
    block: String,
    texture: String,
    faces: String,
    match_blocks: String,
    pack_dir: String,
) -> Result<ctm::CtmInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    ctm::create(roots!(t), &block, &texture, &faces, &match_blocks, t.3)
}

#[tauri::command(async)]
fn ctm_remove(state: State<AppState>, block: String, pack_dir: String) -> Result<ctm::CtmInfo> {
    let t = variety_roots(&state, &pack_dir)?;
    ctm::remove(roots!(t), &block)
}

// ----------------------------------------------------------------- setup

// ---------------------------------------------- notes, tags and history

#[tauri::command(async)]
fn notes_load(state: State<AppState>, pack_dir: String) -> Result<notes::LoadedNotes> {
    let dir = own_pack(&state.lock(), &pack_dir)?.dir.clone();
    notes::load(&dir)
}

#[tauri::command(async)]
fn notes_set(
    state: State<AppState>,
    path: String,
    note: notes::TextureNote,
    pack_dir: String,
) -> Result<notes::TextureNote> {
    let dir = own_pack(&state.lock(), &pack_dir)?.dir.clone();
    notes::set(&dir, &path, &note)
}

/// Earlier versions of one texture (history and trash folders of the pack).
#[tauri::command(async)]
fn texture_history(
    state: State<AppState>,
    path: String,
    pack_dir: String,
) -> Result<Vec<history::Version>> {
    let dir = {
        let mut inner = state.lock();
        let dir = own_pack(&inner, &pack_dir)?.dir.clone();
        inner.history_tex = Some(path.clone());
        dir
    };
    history::list(&dir, &path)
}

#[tauri::command(async)]
fn restore_version(
    state: State<AppState>,
    path: String,
    id: String,
    pack_dir: String,
) -> Result<history::Restored> {
    let dir = own_pack(&state.lock(), &pack_dir)?.dir.clone();
    history::restore(&dir, &path, &id)
}

fn env_dir(key: &str) -> Option<PathBuf> {
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .register_uri_scheme_protocol("pcimg", |ctx, request| {
            images::serve(ctx.app_handle(), &request)
        })
        .setup(|app| {
            let state = app.state::<AppState>();
            let mut inner = state.lock();
            // The two environment variables let tests run against a scratch folder.
            inner.config_dir = env_dir("PACKCREATOR_CONFIG_DIR")
                .or_else(|| app.path().app_config_dir().ok())
                .unwrap_or_else(|| PathBuf::from("."));
            inner.cache_dir = env_dir("PACKCREATOR_CACHE_DIR")
                .or_else(|| app.path().app_cache_dir().ok())
                .unwrap_or_else(|| PathBuf::from("./cache"));
            inner.settings = settings::load(&inner.config_dir);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            update_settings,
            forget_recent,
            extract_version,
            clear_cache,
            create_pack,
            open_pack,
            import_zip,
            close_pack,
            get_pack,
            update_project,
            load_textures,
            texture_detail,
            inspect_image,
            import_texture,
            open_external,
            editor_open,
            editor_save,
            animation_mcmeta,
            read_image_raw,
            block_model,
            models_for_texture,
            scene_blocks,
            scene_block_list,
            scene_load,
            scene_save,
            particle_list,
            particle_add_frame,
            gui_overview,
            gui_scaling_preview,
            gui_set_scaling,
            gui_restore_mcmeta,
            reveal,
            save_share_list,
            revert_texture,
            set_pack_icon,
            edit_pack_icon,
            run_checks,
            apply_fix,
            export_pack,
            batch_scan,
            batch_import,
            whats_new,
            notes_load,
            notes_set,
            texture_history,
            restore_version,
            save_showcase,
            compare_packs,
            compare_copy,
            variety_blocks,
            variants_info,
            variants_add,
            variants_set,
            variants_remove,
            ctm_info,
            ctm_create,
            ctm_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pack Creator");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_patch_tells_null_from_missing() {
        let p: SettingsPatch =
            serde_json::from_str(r#"{"external_editor":null,"export_dir":"D:/out"}"#).unwrap();
        assert_eq!(p.external_editor, Some(None));
        assert_eq!(p.export_dir, Some(Some("D:/out".to_owned())));
        assert_eq!(p.minecraft_dir, None);
        assert_eq!(p.export_install, None);
    }
}
