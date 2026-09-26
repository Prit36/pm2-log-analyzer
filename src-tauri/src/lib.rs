mod archive;
mod cron;
mod classifier;
mod finalize;
mod payload;

use classifier::LogCategory;
use memmap2::MmapOptions;
use rayon::prelude::*;
use std::borrow::Cow;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

const LINE_EXTEND: usize = 256 * 1024;
const MAX_ARCHIVE_DEPTH: usize = 8;

#[derive(serde::Serialize, Clone, Debug)]
pub struct ProgressPayload {
    pub stage: String,
    pub processed: usize,
    pub total: usize,
    pub percent: u32,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
pub struct Pm2ParseOptions {
    #[serde(rename = "normalizeMode")]
    pub normalize_mode: Option<String>,
    #[serde(rename = "statusFamily")]
    pub status_family: Option<String>,
    #[serde(rename = "minMs")]
    pub min_ms: Option<f32>,
    #[serde(rename = "dateFilter")]
    pub date_filter: Option<String>,
    #[serde(rename = "cronQuery")]
    pub cron_query: Option<String>,
    #[serde(rename = "cronMinMs")]
    pub cron_min_ms: Option<f32>,
    #[serde(rename = "cronShowFailedOnly")]
    pub cron_show_failed_only: Option<bool>,
}

/// A large result payload the webview fetches over the loopback server.
#[derive(serde::Serialize, Clone, Debug)]
pub struct PayloadRef {
    pub url: String,
    pub bytes: usize,
    /// Not part of the IPC payload; lets tests read the bytes back.
    #[serde(skip)]
    pub id: u64,
}

/// The loopback payload server, started once when the app boots.
static PAYLOAD_SERVER: std::sync::OnceLock<std::sync::Arc<payload::PayloadServer>> =
    std::sync::OnceLock::new();

/// Hand a finished JSON result to the loopback server and describe where it is.
fn publish_payload(json: String) -> Option<PayloadRef> {
    let server = ensure_payload_server();
    let (id, url, bytes) = server.publish(json.into_bytes());
    Some(PayloadRef { id, url, bytes })
}

/// The payload server, started on first use (app boot, or a test that needs it).
fn ensure_payload_server() -> &'static std::sync::Arc<payload::PayloadServer> {
    PAYLOAD_SERVER.get_or_init(payload::PayloadServer::start)
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ParseResult {
    /// Loopback URL the webview fetches the ready-to-render JSON from
    pub payload: Option<PayloadRef>,
    pub hit_count: u32,
    pub unmatched_count: u32,
    pub methods_mask: u8,
    pub shard_count: usize,
    pub parse_wall_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ReaggResult {
    pub payload: Option<PayloadRef>,
    pub reagg_wall_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct MongoReaggResult {
    pub payload: Option<PayloadRef>,
    pub reagg_wall_ms: u64,
}

#[derive(serde::Deserialize, Clone, Debug, Default)]
pub struct MongoFilterOptions {
    pub op: Option<String>,
    #[serde(rename = "planFilter")]
    pub plan_filter: Option<u8>,
    #[serde(rename = "minDurationMs")]
    pub min_duration_ms: Option<u32>,
    pub collection: Option<String>,
    #[serde(rename = "searchQuery")]
    pub search_query: Option<String>,
    #[serde(rename = "highScanRatioOnly")]
    pub high_scan_ratio_only: Option<bool>,
    pub user: Option<String>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct MongoParseResult {
    pub payload: Option<PayloadRef>,
    pub parse_wall_ms: u64,
    pub slow_query_count: u32,
    pub total_lines: u32,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct NativeFileInfo {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub category: String,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct NativeIngestResult {
    pub pm2: Option<Pm2ParseResult>,
    pub mongo: Option<MongoParseResult>,
    pub files: Vec<NativeFileInfo>,
    pub total_bytes: u64,
    pub parse_wall_ms: u64,
}

pub struct AppState {
    pub pm2_shards: Mutex<Vec<pm2_core::Pm2Engine>>,
    pub mongo: Mutex<Option<mongo_core::MongoEngine>>,
}

pub(crate) fn mode_code(mode: Option<&str>) -> u8 {
    match mode {
        Some("stripQuery") => 1,
        Some("collapseIds") => 2,
        Some("raw") => 0,
        _ => 2,
    }
}

pub(crate) fn status_code(family: Option<&str>) -> u8 {
    match family {
        Some("2xx") => 2,
        Some("3xx") => 3,
        Some("4xx") => 4,
        Some("5xx") => 5,
        _ => 0,
    }
}

enum LogData {
    Mmap(memmap2::Mmap),
    Buffer(Vec<u8>),
}

impl std::ops::Deref for LogData {
    type Target = [u8];
    fn deref(&self) -> &[u8] {
        match self {
            LogData::Mmap(m) => m,
            LogData::Buffer(b) => b,
        }
    }
}

struct LogSourceItem {
    name: String,
    path: String,
    data: LogData,
    size: usize,
    category: LogCategory,
}

fn collect_paths_recursive(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        let child = entry.path();
        let file_name = child
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        if file_name.starts_with('.') || file_name.starts_with("__macosx") {
            continue;
        }
        if child.is_file() {
            if is_supported_folder_file(&child) {
                out.push(child);
            }
        } else {
            collect_paths_recursive(&child, out);
        }
    }
}

fn is_supported_folder_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    [".log", ".txt", ".json", ".out", ".err", ".zip", ".gz"]
        .iter()
        .any(|extension| name.ends_with(extension))
        || name.rsplit_once('.').is_some_and(|(_, extension)| {
            !extension.is_empty() && extension.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// Emit a `native-progress` event, when a window is attached.
fn emit_progress(
    app: Option<&tauri::AppHandle>,
    stage: &str,
    processed: usize,
    total: usize,
    percent: u32,
) {
    if let Some(app) = app {
        let _ = app.emit(
            "native-progress",
            ProgressPayload {
                stage: stage.to_string(),
                processed,
                total,
                percent,
            },
        );
    }
}

/// Byte counter shared by pipelines that run at the same time (ZIP inflate +
/// PM2 parse + Mongo parse), so the UI bar reflects all of them instead of
/// restarting on each stage.
struct SharedProgress<'a> {
    app: Option<&'a tauri::AppHandle>,
    done: AtomicU64,
    total: u64,
}

impl<'a> SharedProgress<'a> {
    fn new(app: Option<&'a tauri::AppHandle>, total: u64) -> Self {
        Self {
            app,
            done: AtomicU64::new(0),
            total,
        }
    }

    /// Count `bytes` as processed and report the running percentage (capped at
    /// 99 so "complete" stays reserved for the caller that owns the whole job).
    fn add(&self, bytes: u64) {
        if self.app.is_none() || self.total == 0 {
            return;
        }
        let done = self.done.fetch_add(bytes, Ordering::Relaxed) + bytes;
        emit_progress(
            self.app,
            "parsing",
            done as usize,
            self.total as usize,
            ((done * 100) / self.total).min(99) as u32,
        );
    }
}

/// Recursively expands all paths (files, directories, zip, gzip) into classified [`LogSourceItem`]s.
fn expand_log_sources(
    paths: &[String],
    app_handle: Option<&tauri::AppHandle>,
) -> Result<Vec<LogSourceItem>, String> {
    let file_paths = collect_candidate_paths(paths);
    if file_paths.is_empty() {
        return Err("No valid log or archive files found".into());
    }
    let total_paths = file_paths.len();
    let progress_count = AtomicUsize::new(0);

    let candidate_items: Vec<Vec<LogSourceItem>> = file_paths
        .into_par_iter()
        .map(|path| {
            let items = open_candidate(&path).map(expand_candidate).unwrap_or_default();
            let done = progress_count.fetch_add(1, Ordering::Relaxed) + 1;
            report_read_progress(app_handle, done, total_paths);
            items
        })
        .collect();

    let items: Vec<LogSourceItem> = candidate_items.into_iter().flatten().collect();
    Ok(items)
}

/// Every existing path under `paths`, with directories walked recursively.
fn collect_candidate_paths(paths: &[String]) -> Vec<PathBuf> {
    let mut file_paths = Vec::new();
    for candidate in paths {
        let path = Path::new(candidate);
        if path.exists() {
            collect_paths_recursive(path, &mut file_paths);
        }
    }
    file_paths
}

/// Report how far the file scan has come.
fn report_read_progress(app_handle: Option<&tauri::AppHandle>, done: usize, total: usize) {
    emit_progress(
        app_handle,
        "reading",
        done,
        total,
        ((done * 100) / total).min(99) as u32,
    );
}

/// One open candidate file, ready to be expanded.
struct CandidateFile {
    path: String,
    name: String,
    mmap: memmap2::Mmap,
    size: u64,
    category: LogCategory,
}

/// Open a candidate path and classify it; `None` for empty, unreadable, or skipped files.
fn open_candidate(path: &Path) -> Option<CandidateFile> {
    let path_str = path.to_string_lossy().to_string();
    let name = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or(&path_str)
        .to_string();
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if metadata.len() == 0 {
        return None;
    }
    let mmap = unsafe { MmapOptions::new().map(&file) }.ok()?;
    let category = classifier::classify_file_or_entry(&name, &mmap);
    if category == LogCategory::Skip {
        return None;
    }
    Some(CandidateFile {
        path: path_str,
        name,
        mmap,
        size: metadata.len(),
        category,
    })
}

/// Expand one candidate into the log items it carries.
fn expand_candidate(candidate: CandidateFile) -> Vec<LogSourceItem> {
    match candidate.category {
        LogCategory::Zip | LogCategory::Gzip => expand_archive_bytes(
            &candidate.name,
            &candidate.path,
            Cow::Borrowed(&candidate.mmap[..]),
            0,
        ),
        category => vec![LogSourceItem {
            name: candidate.name,
            path: candidate.path,
            data: LogData::Mmap(candidate.mmap),
            size: candidate.size as usize,
            category,
        }],
    }
}

/// Expand ZIP/GZIP content recursively while leaving ordinary logs in owned buffers.
fn expand_archive_bytes(
    name: &str,
    path: &str,
    data: Cow<'_, [u8]>,
    depth: usize,
) -> Vec<LogSourceItem> {
    if data.starts_with(b"PK\x03\x04") {
        if depth >= MAX_ARCHIVE_DEPTH {
            log::warn!("Skipping archive nested deeper than {MAX_ARCHIVE_DEPTH}: '{path}'");
            return Vec::new();
        }
        return expand_zip_bytes(data.as_ref(), path, depth);
    }

    if data.starts_with(b"\x1f\x8b") {
        if depth >= MAX_ARCHIVE_DEPTH {
            log::warn!("Skipping archive nested deeper than {MAX_ARCHIVE_DEPTH}: '{path}'");
            return Vec::new();
        }
        let mut output = Vec::new();
        if let Err(error) = archive::decompress_gzip(&data, &mut output) {
            log::warn!("Failed to decompress GZIP '{path}': {error}");
            return Vec::new();
        }
        let clean_name = name.strip_suffix(".gz").unwrap_or(name);
        return expand_archive_bytes(clean_name, path, Cow::Owned(output), depth + 1);
    }

    let mut category = classifier::classify_name(name);
    if category == LogCategory::Unknown {
        category = classifier::classify_content(&data);
    }
    if matches!(
        category,
        LogCategory::Skip | LogCategory::Zip | LogCategory::Gzip
    ) {
        return Vec::new();
    }

    let size = data.len();
    vec![LogSourceItem {
        name: name.rsplit('/').next().unwrap_or(name).to_string(),
        path: path.to_string(),
        data: LogData::Buffer(data.into_owned()),
        size,
        category,
    }]
}

/// Expand a ZIP archive into one item per usable entry, preferring large entries first.
fn expand_zip_bytes(data: &[u8], archive_path: &str, depth: usize) -> Vec<LogSourceItem> {
    let entries = match archive::parse_zip_entries(data) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("Failed to parse ZIP archive '{archive_path}': {error}");
            return Vec::new();
        }
    };
    let mut valid_entries: Vec<_> = entries.into_iter().filter(is_extractable_entry).collect();
    valid_entries.sort_by_key(|entry| std::cmp::Reverse(entry.compressed_size));

    valid_entries
        .into_par_iter()
        .flat_map_iter(|entry| extract_zip_item(data, archive_path, entry, depth + 1))
        .collect()
}

/// A ZIP directory row worth decompressing.
fn is_extractable_entry(entry: &archive::ZipEntryMeta) -> bool {
    let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
    !clean.starts_with('.')
        && !clean.starts_with("__macosx")
        && !entry.name.ends_with('/')
        && !clean.contains("error")
        && entry.uncompressed_size > 0
}

/// Decompress one ZIP entry, recursively expanding nested archives.
fn extract_zip_item(
    data: &[u8],
    archive_path: &str,
    entry: archive::ZipEntryMeta,
    depth: usize,
) -> Vec<LogSourceItem> {
    let name = entry.name.rsplit('/').next().unwrap_or(&entry.name);
    let path = format!("{archive_path}/{}", entry.name);
    let Ok(content) = archive::extract_zip_entry(data, &entry) else {
        return Vec::new();
    };
    expand_archive_bytes(name, &path, content, depth)
}

/// One shard range inside an in-memory log buffer.
struct ShardTaskRef<'a> {
    data: &'a [u8],
    start: usize,
    end: usize,
    file_size: usize,
}

pub fn parse_pm2_files_internal(
    paths: &[String],
    options: &Pm2ParseOptions,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult), String> {
    if paths.is_empty() {
        return Err("No file paths provided".into());
    }

    // Direct fast-path for single raw file (benchmarked path)
    if paths.len() == 1 {
        let path = &paths[0];
        let file_path = Path::new(path);
        if file_path.is_file() && !path.ends_with(".zip") && !path.ends_with(".gz") {
            let file = File::open(file_path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
            let mmap = unsafe { MmapOptions::new().map(&file) }
                .map_err(|e| format!("Failed to memory-map '{path}': {e}"))?;
            if mmap.len() >= 4 && &mmap[..4] != b"PK\x03\x04" && &mmap[..2] != b"\x1f\x8b" {
                return parse_pm2_raw_mmaps(vec![(path.clone(), mmap)], options, app_handle);
            }
        }
    }

    // Multi-source or archive/directory path
    let items = expand_log_sources(paths, app_handle)?;
    let pm2_items: Vec<_> = items
        .into_iter()
        .filter(|i| i.category == LogCategory::Pm2 || i.category == LogCategory::Unknown)
        .collect();

    if pm2_items.is_empty() {
        return Err("No PM2 API access logs found in provided sources".into());
    }

    parse_pm2_items(pm2_items, options, app_handle, None)
}

fn parse_pm2_raw_mmaps(
    mmaps_with_paths: Vec<(String, memmap2::Mmap)>,
    options: &Pm2ParseOptions,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult), String> {
    let started = Instant::now();
    let files = mmaps_with_paths
        .into_iter()
        .map(|(_path, mmap)| mmap)
        .collect();
    let (mmaps, ranges) = plan_shard_ranges(files, available_parallelism(), pm2_shard_plan);
    let total_bytes = total_mapped_bytes(&mmaps);
    let completed_bytes = AtomicU64::new(0);
    let shard_options = Pm2ShardOptions::new(options);

    let (mut shards, partials) = parse_pm2_mmap_shards(
        &mmaps,
        &ranges,
        &shard_options,
        app_handle,
        &completed_bytes,
        total_bytes,
    );
    drop_in_background(mmaps);
    emit_progress(
        app_handle,
        "complete",
        total_bytes as usize,
        total_bytes as usize,
        100,
    );

    let json = finalize::finalize_pm2_with_partials(&mut shards, options, partials)?;
    let result = pm2_result(&shards, json, started.elapsed().as_millis() as u64);
    Ok((shards, result))
}

/// Parse every planned shard slice in parallel, reporting progress as they finish.
fn parse_pm2_mmap_shards(
    mmaps: &[memmap2::Mmap],
    ranges: &[ShardRange],
    options: &Pm2ShardOptions,
    app_handle: Option<&tauri::AppHandle>,
    completed_bytes: &AtomicU64,
    total_bytes: u64,
) -> (Vec<pm2_core::Pm2Engine>, Vec<pm2_core::DecodedPartial>) {
    ranges
        .par_iter()
        .map(|&(file_index, start, end, file_size)| {
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (end + LINE_EXTEND).min(file_size);
            engine.parse_shard(
                &mmaps[file_index][start..read_end],
                start as f64,
                end as f64,
                file_size as f64,
            );
            advance_progress(completed_bytes, (end - start) as u64, total_bytes, app_handle);
            let partial = engine.reaggregate_decoded(
                options.mode,
                options.status,
                options.min_ms,
                options.date_filter.as_bytes(),
                true,
            );
            (engine, partial)
        })
        .unzip()
}

/// `(file index, shard start, shard end, file size)` for one rayon task.
type ShardRange = (usize, usize, usize, usize);

/// The parallelism every shard plan is sized to.
fn available_parallelism() -> usize {
    std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4)
}

/// Pair every mapped file with its planned shard ranges.
fn plan_shard_ranges(
    files: Vec<memmap2::Mmap>,
    cpus: usize,
    plan: fn(usize, usize) -> Vec<(usize, usize)>,
) -> (Vec<memmap2::Mmap>, Vec<ShardRange>) {
    let mut mmaps = Vec::with_capacity(files.len());
    let mut ranges = Vec::new();
    for (file_index, mmap) in files.into_iter().enumerate() {
        let file_size = mmap.len();
        for (start, end) in plan(file_size, cpus) {
            ranges.push((file_index, start, end, file_size));
        }
        mmaps.push(mmap);
    }
    (mmaps, ranges)
}

/// Total bytes across the mapped files.
fn total_mapped_bytes(mmaps: &[memmap2::Mmap]) -> u64 {
    mmaps.iter().map(|mmap| mmap.len() as u64).sum()
}

/// Unmapping multi-GB views blocks the caller for a while on Windows, so hand
/// them to a detached thread once parsing is done.
fn drop_in_background<Value: Send + 'static>(value: Value) {
    std::thread::spawn(move || drop(value));
}

/// Count one finished shard and report the running percentage.
fn advance_progress(
    completed: &AtomicU64,
    task_bytes: u64,
    total_bytes: u64,
    app_handle: Option<&tauri::AppHandle>,
) {
    let Some(app) = app_handle else {
        return;
    };
    let done = completed.fetch_add(task_bytes, Ordering::Relaxed) + task_bytes;
    let percent = (done * 100)
        .checked_div(total_bytes)
        .map(|percent| percent.min(99) as u32)
        .unwrap_or(99);
    emit_progress(
        Some(app),
        "parsing",
        done as usize,
        total_bytes as usize,
        percent,
    );
}

/// The reaggregation settings every PM2 shard parse shares.
struct Pm2ShardOptions {
    mode: u8,
    status: u8,
    min_ms: f32,
    date_filter: String,
}

impl Pm2ShardOptions {
    fn new(options: &Pm2ParseOptions) -> Self {
        Self {
            mode: mode_code(options.normalize_mode.as_deref()),
            status: status_code(options.status_family.as_deref()),
            min_ms: options.min_ms.unwrap_or(0.0),
            date_filter: options.date_filter.clone().unwrap_or_default(),
        }
    }
}

/// The counters and payload every PM2 parse result carries.
fn pm2_result(shards: &[pm2_core::Pm2Engine], json: String, elapsed_ms: u64) -> Pm2ParseResult {
    Pm2ParseResult {
        payload: publish_payload(json),
        hit_count: shards.iter().map(|shard| shard.hit_count()).sum(),
        unmatched_count: shards.iter().map(|shard| shard.unmatched_count()).sum(),
        methods_mask: shards
            .iter()
            .fold(0u8, |mask, shard| mask | shard.methods_mask()),
        shard_count: shards.len(),
        parse_wall_ms: elapsed_ms,
    }
}

/// The payload every Mongo parse result carries.
fn mongo_result(engine: &mongo_core::MongoEngine, json: String, elapsed_ms: u64) -> MongoParseResult {
    MongoParseResult {
        payload: publish_payload(json),
        parse_wall_ms: elapsed_ms,
        slow_query_count: engine.slow_query_count(),
        total_lines: engine.total_lines(),
    }
}

/// Reaggregate a merged Mongo engine with the current filters.
fn filtered_mongo_json(engine: &mongo_core::MongoEngine, options: &MongoFilterOptions) -> String {
    engine.reaggregate(
        options.op.as_deref().unwrap_or("all"),
        options.plan_filter.unwrap_or(0),
        options.min_duration_ms.unwrap_or(0),
        options.collection.as_deref().unwrap_or("all"),
        options.search_query.as_deref().unwrap_or(""),
        options.high_scan_ratio_only.unwrap_or(false),
        options.user.as_deref().unwrap_or("all"),
    )
}

/// Equal-sized shard ranges for one file, in one place so every caller splits a
/// file into identical shards.
fn pm2_shard_plan(file_size: usize, cpus: usize) -> Vec<(usize, usize)> {
    let n_shards = if file_size <= 8 * 1024 * 1024 {
        1
    } else {
        file_size.div_ceil(16 * 1024 * 1024).clamp(1, cpus.min(16))
    };
    let chunk_size = file_size.div_ceil(n_shards);
    let mut plan = Vec::with_capacity(n_shards);
    for i in 0..n_shards {
        let start = i * chunk_size;
        if start >= file_size {
            break;
        }
        plan.push((start, ((i + 1) * chunk_size).min(file_size)));
    }
    plan
}

fn mongo_shard_plan(file_size: usize, cpus: usize) -> Vec<(usize, usize)> {
    let n_shards = if file_size <= 8 * 1024 * 1024 {
        1
    } else {
        file_size.div_ceil(16 * 1024 * 1024).clamp(1, cpus.min(16))
    };
    let chunk_size = file_size.div_ceil(n_shards);
    let mut plan = Vec::with_capacity(n_shards);
    for i in 0..n_shards {
        let start = i * chunk_size;
        if start >= file_size {
            break;
        }
        plan.push((start, ((i + 1) * chunk_size).min(file_size)));
    }
    plan
}

fn parse_mongo_raw_mmaps(
    mmaps_with_paths: Vec<(String, memmap2::Mmap)>,
    options: &MongoFilterOptions,
    app_handle: Option<&tauri::AppHandle>,
    existing_engine: Option<mongo_core::MongoEngine>,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    let started = Instant::now();
    let files = mmaps_with_paths
        .into_iter()
        .map(|(_path, mmap)| mmap)
        .collect();
    let (mmaps, ranges) = plan_shard_ranges(files, available_parallelism(), mongo_shard_plan);
    let total_bytes = total_mapped_bytes(&mmaps);
    let completed_bytes = AtomicU64::new(0);

    let shards =
        parse_mongo_mmap_shards(&mmaps, &ranges, app_handle, &completed_bytes, total_bytes);
    drop_in_background(mmaps);
    emit_progress(
        app_handle,
        "complete",
        total_bytes as usize,
        total_bytes as usize,
        100,
    );

    let mut engine = existing_engine.unwrap_or_default();
    for shard in shards {
        engine.merge(shard);
    }
    let json = filtered_mongo_json(&engine, options);
    let result = mongo_result(&engine, json, started.elapsed().as_millis() as u64);
    Ok((engine, result))
}

/// Parse every planned shard slice in parallel, reporting progress as they finish.
fn parse_mongo_mmap_shards(
    mmaps: &[memmap2::Mmap],
    ranges: &[ShardRange],
    app_handle: Option<&tauri::AppHandle>,
    completed_bytes: &AtomicU64,
    total_bytes: u64,
) -> Vec<mongo_core::MongoEngine> {
    ranges
        .par_iter()
        .map(|&(file_index, start, end, file_size)| {
            let mut engine = mongo_core::MongoEngine::new();
            let read_end = (end + mongo_core::MONGO_LINE_EXTEND).min(file_size);
            engine.parse_shard(
                &mmaps[file_index][start..read_end],
                start as f64,
                end as f64,
                file_size as f64,
            );
            advance_progress(completed_bytes, (end - start) as u64, total_bytes, app_handle);
            engine
        })
        .collect()
}

fn parse_pm2_items(
    items: Vec<LogSourceItem>,
    options: &Pm2ParseOptions,
    app_handle: Option<&tauri::AppHandle>,
    shared_progress: Option<&SharedProgress>,
) -> Result<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult), String> {
    let started = Instant::now();
    let tasks = plan_pm2_item_ranges(&items, available_parallelism());

    let total_bytes: u64 = items.iter().map(|item| item.size as u64).sum();
    let local_progress;
    let progress = match shared_progress {
        Some(shared) => shared,
        None => {
            local_progress = SharedProgress::new(app_handle, total_bytes);
            &local_progress
        }
    };
    let shard_options = Pm2ShardOptions::new(options);

    let task_count = tasks.len();
    let t_shards = Instant::now();
    let (mut shards, partials) = parse_pm2_item_shards(&tasks, &shard_options, progress);
    let shards_ms = t_shards.elapsed().as_millis();
    drop_in_background(items);
    if shared_progress.is_none() {
        emit_progress(
            app_handle,
            "complete",
            total_bytes as usize,
            total_bytes as usize,
            100,
        );
    }

    let t_fin = Instant::now();
    let json = finalize::finalize_pm2_with_partials(&mut shards, options, partials)?;
    let fin_ms = t_fin.elapsed().as_millis();
    eprintln!("[pm2-timing] shards ({task_count} tasks): {shards_ms}ms, finalize: {fin_ms}ms");
    let result = pm2_result(&shards, json, started.elapsed().as_millis() as u64);
    Ok((shards, result))
}

/// Every shard range the in-memory items are split into.
fn plan_pm2_item_ranges<'a>(items: &'a [LogSourceItem], cpus: usize) -> Vec<ShardTaskRef<'a>> {
    let mut tasks = Vec::new();
    for item in items {
        for (start, end) in pm2_shard_plan(item.size, cpus) {
            tasks.push(ShardTaskRef {
                data: &item.data,
                start,
                end,
                file_size: item.size,
            });
        }
    }
    tasks
}

/// Parse every planned item slice in parallel; `progress` counts finished bytes.
fn parse_pm2_item_shards(
    tasks: &[ShardTaskRef],
    options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
) -> (Vec<pm2_core::Pm2Engine>, Vec<pm2_core::DecodedPartial>) {
    tasks
        .par_iter()
        .map(|task| {
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (task.end + LINE_EXTEND).min(task.file_size);
            engine.parse_shard(
                &task.data[task.start..read_end],
                task.start as f64,
                task.end as f64,
                task.file_size as f64,
            );
            progress.add((task.end - task.start) as u64);
            let partial = engine.reaggregate_decoded(
                options.mode,
                options.status,
                options.min_ms,
                options.date_filter.as_bytes(),
                true,
            );
            (engine, partial)
        })
        .unzip()
}

pub fn parse_mongo_files_internal(
    paths: &[String],
    options: &MongoFilterOptions,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    if paths.is_empty() {
        return Err("No file paths provided".into());
    }

    // Direct fast-path for single raw file (benchmarked path)
    if paths.len() == 1 {
        let path = &paths[0];
        let file_path = Path::new(path);
        if file_path.is_file() && !path.ends_with(".zip") && !path.ends_with(".gz") {
            let file = File::open(file_path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
            let mmap = unsafe { MmapOptions::new().map(&file) }
                .map_err(|e| format!("Failed to memory-map '{path}': {e}"))?;
            if mmap.len() >= 4 && &mmap[..4] != b"PK\x03\x04" && &mmap[..2] != b"\x1f\x8b" {
                return parse_mongo_raw_mmaps(vec![(path.clone(), mmap)], options, app_handle, None);
            }
        }
    }

    let items = expand_log_sources(paths, app_handle)?;
    let mongo_items: Vec<_> = items
        .into_iter()
        .filter(|i| i.category == LogCategory::Mongo || i.category == LogCategory::Unknown)
        .collect();

    if mongo_items.is_empty() {
        return Err("No MongoDB logs found in provided sources".into());
    }

    parse_mongo_items(mongo_items, options, app_handle, None, None)
}

fn parse_mongo_items(
    items: Vec<LogSourceItem>,
    options: &MongoFilterOptions,
    app_handle: Option<&tauri::AppHandle>,
    existing_engine: Option<mongo_core::MongoEngine>,
    shared_progress: Option<&SharedProgress>,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    let started = Instant::now();
    let tasks = plan_mongo_item_ranges(&items, available_parallelism());

    let total_bytes: u64 = items.iter().map(|item| item.size as u64).sum();
    let local_progress;
    let progress = match shared_progress {
        Some(shared) => shared,
        None => {
            local_progress = SharedProgress::new(app_handle, total_bytes);
            &local_progress
        }
    };

    let task_count = tasks.len();
    let t_mshards = Instant::now();
    let shards = parse_mongo_item_shards(&tasks, progress);
    let mshards_ms = t_mshards.elapsed().as_millis();
    drop_in_background(items);
    if shared_progress.is_none() {
        emit_progress(
            app_handle,
            "complete",
            total_bytes as usize,
            total_bytes as usize,
            100,
        );
    }

    let t_mfin = Instant::now();
    let mut engine = existing_engine.unwrap_or_default();
    for shard in shards {
        engine.merge(shard);
    }
    let json = filtered_mongo_json(&engine, options);
    let mfin_ms = t_mfin.elapsed().as_millis();
    eprintln!("[mongo-timing] shards ({task_count} tasks): {mshards_ms}ms, merge+reagg: {mfin_ms}ms");
    let result = mongo_result(&engine, json, started.elapsed().as_millis() as u64);
    Ok((engine, result))
}

/// Every shard range the in-memory items are split into.
fn plan_mongo_item_ranges<'a>(items: &'a [LogSourceItem], cpus: usize) -> Vec<ShardTaskRef<'a>> {
    let mut tasks = Vec::new();
    for item in items {
        for (start, end) in mongo_shard_plan(item.size, cpus) {
            tasks.push(ShardTaskRef {
                data: &item.data,
                start,
                end,
                file_size: item.size,
            });
        }
    }
    tasks
}

/// Parse every planned item slice in parallel; `progress` counts finished bytes.
fn parse_mongo_item_shards(
    tasks: &[ShardTaskRef],
    progress: &SharedProgress<'_>,
) -> Vec<mongo_core::MongoEngine> {
    tasks
        .par_iter()
        .map(|task| {
            let mut engine = mongo_core::MongoEngine::new();
            let read_end = (task.end + mongo_core::MONGO_LINE_EXTEND).min(task.file_size);
            engine.parse_shard(
                &task.data[task.start..read_end],
                task.start as f64,
                task.end as f64,
                task.file_size as f64,
            );
            progress.add((task.end - task.start) as u64);
            engine
        })
        .collect()
}

#[expect(
    clippy::too_many_arguments,
    reason = "the entry points thread the Tauri app handle and engine state straight through"
)]
fn ingest_single_zip(
    zip_path: &str,
    mmap: &memmap2::Mmap,
    pm2_options: &Pm2ParseOptions,
    mongo_options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
    t0: Instant,
) -> Result<NativeIngestResult, String> {
    let ZipEntryGroups { pm2, mongo, unknown } = classify_zip_entries(archive::parse_zip_entries(mmap)?);
    let progress_bytes = zip_progress_bytes(&pm2, &mongo);
    let (extra_pm2, extra_mongo) = classify_unknown_zip_entries(mmap, zip_path, unknown);
    if pm2.is_empty() && mongo.is_empty() && extra_pm2.is_empty() && extra_mongo.is_empty() {
        return Err("No valid log files found in ZIP archive".into());
    }

    // Every archive byte is processed twice (inflate, then parse); entries that
    // had to be classified by content were already inflated above.
    let classified_bytes: u64 = extra_pm2
        .iter()
        .chain(&extra_mongo)
        .map(|item| item.size as u64)
        .sum();
    let progress = SharedProgress::new(app_handle, progress_bytes + classified_bytes);

    let (pm2_outcome, mongo_outcome) = rayon::join(
        || {
            ingest_zip_pm2(
                mmap,
                zip_path,
                pm2,
                extra_pm2,
                pm2_options,
                app_handle,
                &progress,
            )
        },
        || {
            ingest_zip_mongo(
                mmap,
                zip_path,
                mongo,
                extra_mongo,
                mongo_options,
                upload_mode,
                app_handle,
                &progress,
                state,
            )
        },
    );

    finish_zip_ingest(
        state,
        pm2_outcome?,
        mongo_outcome?,
        pm2_options,
        upload_mode,
        app_handle,
        t0,
    )
}

/// Store both halves of a ZIP ingest and assemble the result.
fn finish_zip_ingest(
    state: &AppState,
    pm2_outcome: Option<ZipPm2Outcome>,
    mongo_outcome: Option<ZipMongoOutcome>,
    pm2_options: &Pm2ParseOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    t0: Instant,
) -> Result<NativeIngestResult, String> {
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    let pm2 = match pm2_outcome {
        Some(mut outcome) => {
            total_bytes += sum_file_sizes(&outcome.files);
            files.append(&mut outcome.files);
            Some(store_pm2_zip_outcome(state, outcome, pm2_options, upload_mode)?)
        }
        None => None,
    };
    let mongo = match mongo_outcome {
        Some(mut outcome) => {
            total_bytes += sum_file_sizes(&outcome.files);
            files.append(&mut outcome.files);
            *state.mongo.lock().unwrap() = Some(outcome.engine);
            Some(outcome.result)
        }
        None => None,
    };
    emit_progress(app_handle, "complete", 100, 100, 100);
    Ok(NativeIngestResult {
        pm2,
        mongo,
        files,
        total_bytes,
        parse_wall_ms: t0.elapsed().as_millis() as u64,
    })
}

/// A ZIP archive's entries, split by how their names classified.
struct ZipEntryGroups {
    pm2: Vec<archive::ZipEntryMeta>,
    mongo: Vec<archive::ZipEntryMeta>,
    unknown: Vec<archive::ZipEntryMeta>,
}

/// Split a ZIP's entries by name, dropping the ones not worth inflating.
fn classify_zip_entries(entries: Vec<archive::ZipEntryMeta>) -> ZipEntryGroups {
    let mut groups = ZipEntryGroups {
        pm2: Vec::new(),
        mongo: Vec::new(),
        unknown: Vec::new(),
    };
    for entry in entries {
        if !is_extractable_entry(&entry) {
            continue;
        }
        match classifier::classify_name(&entry.name) {
            LogCategory::Pm2 => groups.pm2.push(entry),
            LogCategory::Mongo => groups.mongo.push(entry),
            LogCategory::Skip => {}
            _ => groups.unknown.push(entry),
        }
    }
    // Longest Processing Time first: the biggest entries start earliest.
    groups
        .pm2
        .sort_by_key(|entry| std::cmp::Reverse(entry.compressed_size));
    groups
        .mongo
        .sort_by_key(|entry| std::cmp::Reverse(entry.compressed_size));
    groups
}

/// Inflate the entries whose names were inconclusive and classify their bytes.
fn classify_unknown_zip_entries(
    mmap: &memmap2::Mmap,
    zip_path: &str,
    entries: Vec<archive::ZipEntryMeta>,
) -> (Vec<LogSourceItem>, Vec<LogSourceItem>) {
    let mut pm2 = Vec::new();
    let mut mongo = Vec::new();
    for entry in entries {
        let Ok(cow) = archive::extract_zip_entry(mmap, &entry) else {
            continue;
        };
        let category = classifier::classify_content(&cow);
        let item = zip_entry_item(cow, &entry.name, zip_path, category);
        match category {
            LogCategory::Pm2 => pm2.push(item),
            LogCategory::Mongo => mongo.push(item),
            _ => {}
        }
    }
    (pm2, mongo)
}

/// One already-inflated ZIP entry as a log item.
fn zip_entry_item(
    data: std::borrow::Cow<'_, [u8]>,
    entry_name: &str,
    zip_path: &str,
    category: LogCategory,
) -> LogSourceItem {
    let clean = entry_name.rsplit('/').next().unwrap_or(entry_name);
    let size = data.len();
    LogSourceItem {
        name: clean.to_string(),
        path: format!("{}/{}", zip_path, entry_name),
        data: LogData::Buffer(data.into_owned()),
        size,
        category,
    }
}

/// Inflate one category's entries in parallel, counting bytes as they finish.
fn inflate_zip_entries(
    mmap: &memmap2::Mmap,
    zip_path: &str,
    entries: Vec<archive::ZipEntryMeta>,
    category: LogCategory,
    progress: &SharedProgress<'_>,
) -> Vec<LogSourceItem> {
    entries
        .into_par_iter()
        .filter_map(|entry| {
            let cow = archive::extract_zip_entry(mmap, &entry).ok()?;
            progress.add(entry.uncompressed_size as u64);
            Some(zip_entry_item(cow, &entry.name, zip_path, category))
        })
        .collect()
}

/// The per-file rows the UI lists for one category.
fn native_file_infos(items: &[LogSourceItem], category: &str) -> Vec<NativeFileInfo> {
    items
        .iter()
        .map(|item| NativeFileInfo {
            name: item.name.clone(),
            path: item.path.clone(),
            size: item.size as u64,
            category: category.to_string(),
        })
        .collect()
}

/// The archive bytes a ZIP ingest reports progress against.
fn zip_progress_bytes(pm2: &[archive::ZipEntryMeta], mongo: &[archive::ZipEntryMeta]) -> u64 {
    let archive_bytes: u64 = pm2
        .iter()
        .chain(mongo)
        .map(|entry| entry.uncompressed_size as u64)
        .sum();
    archive_bytes * 2
}

/// The PM2 half of a ZIP ingest.
struct ZipPm2Outcome {
    shards: Vec<pm2_core::Pm2Engine>,
    result: Pm2ParseResult,
    files: Vec<NativeFileInfo>,
}

/// The Mongo half of a ZIP ingest.
struct ZipMongoOutcome {
    engine: mongo_core::MongoEngine,
    result: MongoParseResult,
    files: Vec<NativeFileInfo>,
}

/// Inflate and parse the PM2 entries of a ZIP archive.
fn ingest_zip_pm2(
    mmap: &memmap2::Mmap,
    zip_path: &str,
    entries: Vec<archive::ZipEntryMeta>,
    extra: Vec<LogSourceItem>,
    options: &Pm2ParseOptions,
    app_handle: Option<&tauri::AppHandle>,
    progress: &SharedProgress<'_>,
) -> Result<Option<ZipPm2Outcome>, String> {
    if entries.is_empty() && extra.is_empty() {
        return Ok(None);
    }
    let mut items = inflate_zip_entries(mmap, zip_path, entries, LogCategory::Pm2, progress);
    items.extend(extra);
    if items.is_empty() {
        return Ok(None);
    }
    let files = native_file_infos(&items, "pm2");
    let (shards, result) = parse_pm2_items(items, options, app_handle, Some(progress))?;
    Ok(Some(ZipPm2Outcome {
        shards,
        result,
        files,
    }))
}

/// Inflate and parse the Mongo entries of a ZIP archive.
#[expect(
    clippy::too_many_arguments,
    reason = "the ZIP branches thread the archive, its options, and the progress ticker"
)]
fn ingest_zip_mongo(
    mmap: &memmap2::Mmap,
    zip_path: &str,
    entries: Vec<archive::ZipEntryMeta>,
    extra: Vec<LogSourceItem>,
    options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    progress: &SharedProgress<'_>,
    state: &AppState,
) -> Result<Option<ZipMongoOutcome>, String> {
    if entries.is_empty() && extra.is_empty() {
        return Ok(None);
    }
    let mut items = inflate_zip_entries(mmap, zip_path, entries, LogCategory::Mongo, progress);
    items.extend(extra);
    if items.is_empty() {
        return Ok(None);
    }
    let files = native_file_infos(&items, "mongo");
    let existing = if upload_mode == Some("append") {
        state.mongo.lock().unwrap().take()
    } else {
        None
    };
    let (engine, result) = parse_mongo_items(items, options, app_handle, existing, Some(progress))?;
    Ok(Some(ZipMongoOutcome {
        engine,
        result,
        files,
    }))
}

/// Store the PM2 half of a ZIP ingest and build its result.
fn store_pm2_zip_outcome(
    state: &AppState,
    outcome: ZipPm2Outcome,
    options: &Pm2ParseOptions,
    upload_mode: Option<&str>,
) -> Result<Pm2ParseResult, String> {
    let mut lock = state.pm2_shards.lock().unwrap();
    if upload_mode != Some("append") {
        *lock = outcome.shards;
        return Ok(outcome.result);
    }
    lock.extend(outcome.shards);
    let json = finalize::finalize_pm2(lock.as_mut_slice(), options)?;
    let hit_count = lock.iter().map(|shard| shard.hit_count()).sum();
    let unmatched_count = lock.iter().map(|shard| shard.unmatched_count()).sum();
    let methods_mask = lock
        .iter()
        .fold(0, |mask, shard| mask | shard.methods_mask());
    let shard_count = lock.len();
    Ok(Pm2ParseResult {
        payload: publish_payload(json),
        hit_count,
        unmatched_count,
        methods_mask,
        shard_count,
        parse_wall_ms: outcome.result.parse_wall_ms,
    })
}

/// Sum the sizes of the files an ingest reported.
fn sum_file_sizes(files: &[NativeFileInfo]) -> u64 {
    files.iter().map(|file| file.size).sum()
}

#[derive(Default)]
struct IngestPipelineOutcome {
    pm2_shards: Vec<pm2_core::Pm2Engine>,
    pm2_partials: Vec<pm2_core::DecodedPartial>,
    mongo_shards: Vec<mongo_core::MongoEngine>,
    files: Vec<NativeFileInfo>,
}

impl IngestPipelineOutcome {
    fn merge(&mut self, mut other: IngestPipelineOutcome) {
        self.pm2_shards.append(&mut other.pm2_shards);
        self.pm2_partials.append(&mut other.pm2_partials);
        self.mongo_shards.append(&mut other.mongo_shards);
        self.files.append(&mut other.files);
    }
}

fn parse_pm2_slice(
    data: &[u8],
    options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> (Vec<pm2_core::Pm2Engine>, Vec<pm2_core::DecodedPartial>) {
    let plan = pm2_shard_plan(data.len(), cpus);
    plan.par_iter()
        .map(|&(start, end)| {
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (end + LINE_EXTEND).min(data.len());
            engine.parse_shard(
                &data[start..read_end],
                start as f64,
                end as f64,
                data.len() as f64,
            );
            progress.add((end - start) as u64);
            let partial = engine.reaggregate_decoded(
                options.mode,
                options.status,
                options.min_ms,
                options.date_filter.as_bytes(),
                true,
            );
            (engine, partial)
        })
        .unzip()
}

fn parse_mongo_slice(
    data: &[u8],
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> Vec<mongo_core::MongoEngine> {
    let plan = mongo_shard_plan(data.len(), cpus);
    plan.par_iter()
        .map(|&(start, end)| {
            let mut engine = mongo_core::MongoEngine::new();
            let read_end = (end + mongo_core::MONGO_LINE_EXTEND).min(data.len());
            engine.parse_shard(
                &data[start..read_end],
                start as f64,
                end as f64,
                data.len() as f64,
            );
            progress.add((end - start) as u64);
            engine
        })
        .collect()
}

fn pipeline_log_slice(
    name: &str,
    path: &str,
    data: &[u8],
    category: LogCategory,
    shard_options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> IngestPipelineOutcome {
    let mut outcome = IngestPipelineOutcome::default();
    let size = data.len();
    if size == 0 {
        return outcome;
    }
    match category {
        LogCategory::Pm2 => {
            outcome.files.push(NativeFileInfo {
                name: name.to_string(),
                path: path.to_string(),
                size: size as u64,
                category: "pm2".to_string(),
            });
            let (shards, partials) = parse_pm2_slice(data, shard_options, progress, cpus);
            outcome.pm2_shards = shards;
            outcome.pm2_partials = partials;
        }
        LogCategory::Mongo => {
            outcome.files.push(NativeFileInfo {
                name: name.to_string(),
                path: path.to_string(),
                size: size as u64,
                category: "mongo".to_string(),
            });
            outcome.mongo_shards = parse_mongo_slice(data, progress, cpus);
        }
        _ => {}
    }
    outcome
}

fn pipeline_archive_bytes(
    name: &str,
    path: &str,
    data: Cow<'_, [u8]>,
    depth: usize,
    shard_options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> IngestPipelineOutcome {
    if data.starts_with(b"PK\x03\x04") {
        if depth >= MAX_ARCHIVE_DEPTH {
            log::warn!("Skipping archive nested deeper than {MAX_ARCHIVE_DEPTH}: '{path}'");
            return IngestPipelineOutcome::default();
        }
        return pipeline_zip_bytes(&data, path, depth, shard_options, progress, cpus);
    }

    if data.starts_with(b"\x1f\x8b") {
        if depth >= MAX_ARCHIVE_DEPTH {
            log::warn!("Skipping archive nested deeper than {MAX_ARCHIVE_DEPTH}: '{path}'");
            return IngestPipelineOutcome::default();
        }
        let mut output = Vec::new();
        if let Err(error) = archive::decompress_gzip(&data, &mut output) {
            log::warn!("Failed to decompress GZIP '{path}': {error}");
            return IngestPipelineOutcome::default();
        }
        let clean_name = name.strip_suffix(".gz").unwrap_or(name);
        return pipeline_archive_bytes(clean_name, path, Cow::Owned(output), depth + 1, shard_options, progress, cpus);
    }

    let mut category = classifier::classify_name(name);
    if category == LogCategory::Unknown {
        category = classifier::classify_content(&data);
    }
    if matches!(category, LogCategory::Skip | LogCategory::Zip | LogCategory::Gzip) {
        return IngestPipelineOutcome::default();
    }

    let clean = name.rsplit('/').next().unwrap_or(name);
    pipeline_log_slice(clean, path, &data, category, shard_options, progress, cpus)
}

fn pipeline_zip_bytes(
    zip_bytes: &[u8],
    archive_path: &str,
    depth: usize,
    shard_options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> IngestPipelineOutcome {
    let entries = match archive::parse_zip_entries(zip_bytes) {
        Ok(entries) => entries,
        Err(error) => {
            log::warn!("Failed to parse ZIP archive '{archive_path}': {error}");
            return IngestPipelineOutcome::default();
        }
    };
    let mut valid_entries: Vec<_> = entries.into_iter().filter(is_extractable_entry).collect();
    valid_entries.sort_by_key(|entry| std::cmp::Reverse(entry.compressed_size));

    let outcomes: Vec<IngestPipelineOutcome> = valid_entries
        .into_par_iter()
        .map(|entry| {
            let name = entry.name.rsplit('/').next().unwrap_or(&entry.name);
            let path = format!("{archive_path}/{}", entry.name);
            let Ok(content) = archive::extract_zip_entry(zip_bytes, &entry) else {
                return IngestPipelineOutcome::default();
            };
            pipeline_archive_bytes(name, &path, content, depth + 1, shard_options, progress, cpus)
        })
        .collect();

    let mut merged = IngestPipelineOutcome::default();
    for outcome in outcomes {
        merged.merge(outcome);
    }
    merged
}

fn pipeline_candidate(
    candidate: CandidateFile,
    shard_options: &Pm2ShardOptions,
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> IngestPipelineOutcome {
    match candidate.category {
        LogCategory::Zip | LogCategory::Gzip => {
            pipeline_archive_bytes(
                &candidate.name,
                &candidate.path,
                Cow::Borrowed(&candidate.mmap[..]),
                0,
                shard_options,
                progress,
                cpus,
            )
        }
        category => {
            pipeline_log_slice(
                &candidate.name,
                &candidate.path,
                &candidate.mmap,
                category,
                shard_options,
                progress,
                cpus,
            )
        }
    }
}

pub fn ingest_native_internal(
    paths: &[String],
    pm2_options: &Pm2ParseOptions,
    mongo_options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
) -> Result<NativeIngestResult, String> {
    let t0 = Instant::now();
    if let Some(result) = ingest_single_file(
        paths,
        pm2_options,
        mongo_options,
        upload_mode,
        app_handle,
        state,
        t0,
    )? {
        return Ok(result);
    }

    let file_paths = collect_candidate_paths(paths);
    if file_paths.is_empty() {
        return Err("No valid log or archive files found".into());
    }

    let candidates: Vec<CandidateFile> = file_paths
        .into_par_iter()
        .filter_map(|path| open_candidate(&path))
        .collect();

    if candidates.is_empty() {
        return Err("No valid log files found in provided sources".into());
    }

    let total_bytes: u64 = candidates
        .iter()
        .map(|c| {
            if c.mmap.len() >= 4 && &c.mmap[..4] == b"PK\x03\x04" {
                archive::parse_zip_entries(&c.mmap)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter(|e| is_extractable_entry(e))
                            .map(|e| e.uncompressed_size as u64)
                            .sum()
                    })
                    .unwrap_or(c.size)
            } else {
                c.size
            }
        })
        .sum();

    let cpus = available_parallelism();
    let shard_options = Pm2ShardOptions::new(pm2_options);
    let progress = SharedProgress::new(app_handle, total_bytes);

    let t_pipeline = Instant::now();
    let candidate_outcomes: Vec<IngestPipelineOutcome> = candidates
        .into_par_iter()
        .map(|c| pipeline_candidate(c, &shard_options, &progress, cpus))
        .collect();
    let pipeline_ms = t_pipeline.elapsed().as_millis();

    let mut total_outcome = IngestPipelineOutcome::default();
    for outcome in candidate_outcomes {
        total_outcome.merge(outcome);
    }

    if total_outcome.pm2_shards.is_empty() && total_outcome.mongo_shards.is_empty() {
        return Err("No valid log files found in provided sources".into());
    }

    let existing_mongo = if upload_mode == Some("append") {
        state.mongo.lock().unwrap().take()
    } else {
        None
    };

    let mut pm2_shards = total_outcome.pm2_shards;
    let pm2_partials = total_outcome.pm2_partials;
    let mongo_shards = total_outcome.mongo_shards;

    let t_final = Instant::now();
    let (pm2_outcome, mongo_outcome) = rayon::join(
        || -> Result<Option<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult)>, String> {
            if pm2_shards.is_empty() {
                return Ok(None);
            }
            let json = finalize::finalize_pm2_with_partials(&mut pm2_shards, pm2_options, pm2_partials)?;
            let result = pm2_result(&pm2_shards, json, t0.elapsed().as_millis() as u64);
            Ok(Some((pm2_shards, result)))
        },
        || -> Result<Option<(mongo_core::MongoEngine, MongoParseResult)>, String> {
            if mongo_shards.is_empty() {
                return Ok(None);
            }
            let mut engine = existing_mongo.unwrap_or_default();
            for shard in mongo_shards {
                engine.merge(shard);
            }
            let json = filtered_mongo_json(&engine, mongo_options);
            let result = mongo_result(&engine, json, t0.elapsed().as_millis() as u64);
            Ok(Some((engine, result)))
        },
    );
    let final_ms = t_final.elapsed().as_millis();

    let files = total_outcome.files;
    let files_total_bytes: u64 = files.iter().map(|f| f.size).sum();

    let res = finish_native_ingest(
        state,
        pm2_outcome?,
        mongo_outcome?,
        files,
        files_total_bytes,
        pm2_options,
        upload_mode,
        t0,
    );
    eprintln!("[timing] pipeline: {pipeline_ms}ms, finalize: {final_ms}ms, total: {}ms", t0.elapsed().as_millis());
    res
}


/// Store both halves of a multi-source ingest and assemble the result.
#[expect(
    clippy::too_many_arguments,
    reason = "the ingest entry point threads the app handle and engine state through"
)]
fn finish_native_ingest(
    state: &AppState,
    pm2_outcome: Option<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult)>,
    mongo_outcome: Option<(mongo_core::MongoEngine, MongoParseResult)>,
    files: Vec<NativeFileInfo>,
    total_bytes: u64,
    pm2_options: &Pm2ParseOptions,
    upload_mode: Option<&str>,
    t0: Instant,
) -> Result<NativeIngestResult, String> {
    let pm2 = match pm2_outcome {
        Some((shards, result)) => {
            Some(store_pm2_shards(state, shards, result, pm2_options, upload_mode)?)
        }
        None => None,
    };
    let mongo = match mongo_outcome {
        Some((engine, result)) => {
            *state.mongo.lock().unwrap() = Some(engine);
            Some(result)
        }
        None => None,
    };
    Ok(NativeIngestResult {
        pm2,
        mongo,
        files,
        total_bytes,
        parse_wall_ms: t0.elapsed().as_millis() as u64,
    })
}

/// The fast path for one file: `None` when the caller should fall back to the
/// general directory/archive expansion.
fn ingest_single_file(
    paths: &[String],
    pm2_options: &Pm2ParseOptions,
    mongo_options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
    t0: Instant,
) -> Result<Option<NativeIngestResult>, String> {
    if paths.len() != 1 {
        return Ok(None);
    }
    let path = &paths[0];
    let file_path = Path::new(path);
    if !file_path.is_file() {
        return Ok(None);
    }
    let file =
        File::open(file_path).map_err(|error| format!("Failed to open '{path}': {error}"))?;
    let mmap = unsafe { MmapOptions::new().map(&file) }
        .map_err(|error| format!("Failed to memory-map '{path}': {error}"))?;

    if mmap.len() >= 4 && &mmap[..4] == b"PK\x03\x04" {
        return ingest_single_zip(
            path,
            &mmap,
            pm2_options,
            mongo_options,
            upload_mode,
            app_handle,
            state,
            t0,
        )
        .map(Some);
    }
    if is_compressed_or_archive(path, &mmap) {
        return Ok(None);
    }
    ingest_raw_file(
        path,
        file_path,
        mmap,
        pm2_options,
        mongo_options,
        upload_mode,
        app_handle,
        state,
        t0,
    )
}

/// Whether the general expansion, rather than the raw-file fast path, owns this file.
fn is_compressed_or_archive(path: &str, mmap: &memmap2::Mmap) -> bool {
    path.ends_with(".zip")
        || path.ends_with(".gz")
        || (mmap.len() >= 2 && &mmap[..2] == b"\x1f\x8b")
}

/// Classify one raw file and hand it to its pipeline.
#[expect(
    clippy::too_many_arguments,
    reason = "the single-file entry point threads the app handle and engine state through"
)]
fn ingest_raw_file(
    path: &str,
    file_path: &Path,
    mmap: memmap2::Mmap,
    pm2_options: &Pm2ParseOptions,
    mongo_options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
    t0: Instant,
) -> Result<Option<NativeIngestResult>, String> {
    let file_name = file_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path)
        .to_string();
    let category = classifier::classify_file_or_entry(&file_name, &mmap);
    let size = mmap.len() as u64;
    match category {
        LogCategory::Mongo => ingest_single_mongo_file(
            path.to_string(),
            file_name,
            size,
            mmap,
            mongo_options,
            upload_mode,
            app_handle,
            state,
            t0,
        )
        .map(Some),
        LogCategory::Pm2 | LogCategory::Unknown => ingest_single_pm2_file(
            path.to_string(),
            file_name,
            size,
            mmap,
            pm2_options,
            upload_mode,
            app_handle,
            state,
            t0,
        )
        .map(Some),
        _ => Ok(None),
    }
}

/// Ingest one raw MongoDB log file.
#[expect(
    clippy::too_many_arguments,
    reason = "the single-file entry point threads the app handle and engine state through"
)]
fn ingest_single_mongo_file(
    path: String,
    file_name: String,
    size: u64,
    mmap: memmap2::Mmap,
    options: &MongoFilterOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
    t0: Instant,
) -> Result<NativeIngestResult, String> {
    let existing = if upload_mode == Some("append") {
        state.mongo.lock().unwrap().take()
    } else {
        None
    };
    let (engine, result) = parse_mongo_raw_mmaps(
        vec![(path.clone(), mmap)],
        options,
        app_handle,
        existing,
    )?;
    *state.mongo.lock().unwrap() = Some(engine);
    Ok(single_file_result(
        "mongo".to_string(),
        file_name,
        path,
        size,
        Some(result),
        None,
        t0,
    ))
}

/// Ingest one raw PM2 (or unclassified) log file.
#[expect(
    clippy::too_many_arguments,
    reason = "the single-file entry point threads the app handle and engine state through"
)]
fn ingest_single_pm2_file(
    path: String,
    file_name: String,
    size: u64,
    mmap: memmap2::Mmap,
    options: &Pm2ParseOptions,
    upload_mode: Option<&str>,
    app_handle: Option<&tauri::AppHandle>,
    state: &AppState,
    t0: Instant,
) -> Result<NativeIngestResult, String> {
    let (shards, result) = parse_pm2_raw_mmaps(vec![(path.clone(), mmap)], options, app_handle)?;
    let result = store_pm2_shards(state, shards, result, options, upload_mode)?;
    Ok(single_file_result(
        "pm2".to_string(),
        file_name,
        path,
        size,
        None,
        Some(result),
        t0,
    ))
}

/// The result of a single-file ingest.
fn single_file_result(
    category: String,
    file_name: String,
    path: String,
    size: u64,
    mongo: Option<MongoParseResult>,
    pm2: Option<Pm2ParseResult>,
    t0: Instant,
) -> NativeIngestResult {
    NativeIngestResult {
        pm2,
        mongo,
        files: vec![NativeFileInfo {
            name: file_name,
            path,
            size,
            category,
        }],
        total_bytes: size,
        parse_wall_ms: t0.elapsed().as_millis() as u64,
    }
}


/// Store parsed PM2 shards, merging into the existing set when appending.
fn store_pm2_shards(
    state: &AppState,
    shards: Vec<pm2_core::Pm2Engine>,
    result: Pm2ParseResult,
    options: &Pm2ParseOptions,
    upload_mode: Option<&str>,
) -> Result<Pm2ParseResult, String> {
    let mut lock = state.pm2_shards.lock().unwrap();
    if upload_mode != Some("append") {
        *lock = shards;
        return Ok(result);
    }
    lock.extend(shards);
    let json = finalize::finalize_pm2(lock.as_mut_slice(), options)?;
    let hit_count = lock.iter().map(|shard| shard.hit_count()).sum();
    let unmatched_count = lock.iter().map(|shard| shard.unmatched_count()).sum();
    let methods_mask = lock
        .iter()
        .fold(0, |mask, shard| mask | shard.methods_mask());
    let shard_count = lock.len();
    Ok(Pm2ParseResult {
        payload: publish_payload(json),
        hit_count,
        unmatched_count,
        methods_mask,
        shard_count,
        parse_wall_ms: result.parse_wall_ms,
    })
}

#[tauri::command]
fn clear_engine(state: State<'_, AppState>) {
    let mut pm2 = state.pm2_shards.lock().unwrap();
    pm2.clear();
    let mut mongo = state.mongo.lock().unwrap();
    *mongo = None;
}

/// Worker stacks must survive rayon's nested-wait execution: a worker that
/// waits on a job runs other jobs on the same stack, so deep pipelines
/// (`rayon::join` into `scope`/`par_iter` pipelines) can outgrow the 2MB
/// default. Reserve address space, not committed memory.
const RAYON_STACK_BYTES: usize = 16 * 1024 * 1024;

fn configure_rayon_pool() {
    let _ = rayon::ThreadPoolBuilder::new()
        .thread_name(|index| format!("log-analyzer-{index}"))
        .stack_size(RAYON_STACK_BYTES)
        .build_global();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
#[tauri::command]
async fn parse_pm2_files(
    paths: Vec<String>,
    options: Pm2ParseOptions,
    app: tauri::AppHandle,
) -> Result<Pm2ParseResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Pm2ParseResult, String> {
        let (shards, res) = parse_pm2_files_internal(&paths, &options, Some(&handle))?;
        let state = handle.state::<AppState>();
        *state.pm2_shards.lock().unwrap() = shards;
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reaggregate_pm2(
    options: Pm2ParseOptions,
    app: tauri::AppHandle,
) -> Result<Pm2ReaggResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<Pm2ReaggResult, String> {
        let t0 = Instant::now();
        let state = handle.state::<AppState>();
        let mut lock = state.pm2_shards.lock().unwrap();
        if lock.is_empty() {
            return Err("PM2 engine is not initialized".into());
        }
        let json = finalize::finalize_pm2(lock.as_mut_slice(), &options)?;
        Ok(Pm2ReaggResult {
            payload: publish_payload(json),
            reagg_wall_ms: t0.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn parse_mongo_files(
    paths: Vec<String>,
    options: MongoFilterOptions,
    app: tauri::AppHandle,
) -> Result<MongoParseResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<MongoParseResult, String> {
        let (engine, res) = parse_mongo_files_internal(&paths, &options, Some(&handle))?;
        let state = handle.state::<AppState>();
        *state.mongo.lock().unwrap() = Some(engine);
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn reaggregate_mongo(
    options: MongoFilterOptions,
    app: tauri::AppHandle,
) -> Result<MongoReaggResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<MongoReaggResult, String> {
        let t0 = Instant::now();
        let state = handle.state::<AppState>();
        let lock = state.mongo.lock().unwrap();
        let engine = lock.as_ref().ok_or("MongoDB engine is not initialized")?;

        let json = engine.reaggregate(
            options.op.as_deref().unwrap_or("all"),
            options.plan_filter.unwrap_or(0),
            options.min_duration_ms.unwrap_or(0),
            options.collection.as_deref().unwrap_or("all"),
            options.search_query.as_deref().unwrap_or(""),
            options.high_scan_ratio_only.unwrap_or(false),
            options.user.as_deref().unwrap_or("all"),
        );
        Ok(MongoReaggResult {
            payload: publish_payload(json),
            reagg_wall_ms: t0.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ingest_native_files(
    paths: Vec<String>,
    pm2_options: Pm2ParseOptions,
    mongo_options: MongoFilterOptions,
    upload_mode: Option<String>,
    app: tauri::AppHandle,
) -> Result<NativeIngestResult, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<NativeIngestResult, String> {
        let state = handle.state::<AppState>();
        ingest_native_internal(
            &paths,
            &pm2_options,
            &mongo_options,
            upload_mode.as_deref(),
            Some(&handle),
            &state,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_rayon_pool();
    ensure_payload_server();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            parse_pm2_files,
            reaggregate_pm2,
            parse_mongo_files,
            reaggregate_mongo,
            ingest_native_files,
            clear_engine,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests;
