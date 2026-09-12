mod archive;
mod classifier;
mod finalize;

use classifier::LogCategory;
use memmap2::MmapOptions;
use rayon::prelude::*;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, Manager, State};

const LINE_EXTEND: usize = 256 * 1024;

/// Feed granularity for MongoDB logs: large enough to keep `feed_slice` cheap,
/// small enough that the progress bar moves during a multi-second ingest.
const MONGO_FEED_CHUNK_BYTES: usize = 16 * 1024 * 1024;

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

fn to_raw_value(json: String) -> Box<serde_json::value::RawValue> {
    serde_json::value::RawValue::from_string(json)
        .unwrap_or_else(|_| serde_json::value::RawValue::from_string("{}".to_string()).unwrap())
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ParseResult {
    /// Raw unescaped JSON object for zero-copy direct IPC delivery
    pub data: Box<serde_json::value::RawValue>,
    pub hit_count: u32,
    pub unmatched_count: u32,
    pub methods_mask: u8,
    pub shard_count: usize,
    pub parse_wall_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ReaggResult {
    pub data: Box<serde_json::value::RawValue>,
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
    pub data: Box<serde_json::value::RawValue>,
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
    if path.is_dir() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                let p = entry.path();
                let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                if file_name.starts_with('.') || file_name.starts_with("__macosx") {
                    continue;
                }
                collect_paths_recursive(&p, out);
            }
        }
    } else if path.is_file() {
        out.push(path.to_path_buf());
    }
}

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

/// Recursively expands all paths (files, directories, zip, gzip) into classified `LogSourceItem`s.
fn expand_log_sources(
    paths: &[String],
    app_handle: Option<&tauri::AppHandle>,
) -> Result<Vec<LogSourceItem>, String> {
    let mut file_paths = Vec::new();
    for p_str in paths {
        let p = Path::new(p_str);
        if !p.exists() {
            continue;
        }
        collect_paths_recursive(p, &mut file_paths);
    }

    if file_paths.is_empty() {
        return Err("No valid log or archive files found".into());
    }

    let mut items = Vec::new();
    let total_paths = file_paths.len();

    for (idx, path_buf) in file_paths.into_iter().enumerate() {
        let path_str = path_buf.to_string_lossy().to_string();
        let file_name = path_buf
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path_str)
            .to_string();

        let file = match File::open(&path_buf) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let metadata = match file.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if metadata.len() == 0 {
            continue;
        }

        let mmap = match unsafe { MmapOptions::new().map(&file) } {
            Ok(m) => m,
            Err(_) => continue,
        };

        let cat = classifier::classify_file_or_entry(&file_name, &mmap);
        if cat == LogCategory::Skip {
            continue;
        }

        emit_progress(
            app_handle,
            "reading",
            idx + 1,
            total_paths,
            (((idx + 1) * 100) / total_paths).min(99) as u32,
        );

        match cat {
            LogCategory::Zip => {
                match archive::parse_zip_entries(&mmap) {
                    Ok(entries) => {
                        let mut valid_entries: Vec<_> = entries
                            .into_iter()
                            .filter(|entry| {
                                let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
                                !clean.starts_with('.')
                                    && !clean.starts_with("__macosx")
                                    && !entry.name.ends_with('/')
                                    && !clean.contains("error")
                                    && entry.uncompressed_size > 0
                            })
                            .collect();

                        // Sort descending by compressed size (Longest Processing Time first)
                        valid_entries.sort_by_key(|b| std::cmp::Reverse(b.compressed_size));

                        let extracted: Vec<LogSourceItem> = valid_entries
                            .into_par_iter()
                            .filter_map(|entry| {
                                let entry_name = entry.name.clone();
                                let clean_name =
                                    entry_name.rsplit('/').next().unwrap_or(&entry_name);
                                if let Ok(cow) = archive::extract_zip_entry(&mmap, &entry) {
                                    let mut inner_cat = classifier::classify_name(&entry_name);
                                    if inner_cat == LogCategory::Unknown {
                                        inner_cat = classifier::classify_content(&cow);
                                    }
                                    if inner_cat == LogCategory::Skip {
                                        return None;
                                    }
                                    let size = cow.len();
                                    let data = cow.into_owned();
                                    Some(LogSourceItem {
                                        name: clean_name.to_string(),
                                        path: format!("{}/{}", path_str, entry_name),
                                        data: LogData::Buffer(data),
                                        size,
                                        category: inner_cat,
                                    })
                                } else {
                                    None
                                }
                            })
                            .collect();

                        items.extend(extracted);
                    }
                    Err(e) => {
                        log::warn!("Failed to parse ZIP archive '{}': {}", path_str, e);
                    }
                }
            }
            LogCategory::Gzip => {
                let mut out = Vec::new();
                if let Ok(()) = archive::decompress_gzip(&mmap, &mut out) {
                    let clean_name = file_name
                        .strip_suffix(".gz")
                        .unwrap_or(&file_name)
                        .to_string();
                    let mut inner_cat = classifier::classify_name(&clean_name);
                    if inner_cat == LogCategory::Unknown {
                        inner_cat = classifier::classify_content(&out);
                    }
                    if inner_cat != LogCategory::Skip {
                        let size = out.len();
                        items.push(LogSourceItem {
                            name: clean_name,
                            path: path_str,
                            data: LogData::Buffer(out),
                            size,
                            category: inner_cat,
                        });
                    }
                }
            }
            _ => {
                // Raw log file
                items.push(LogSourceItem {
                    name: file_name,
                    path: path_str,
                    data: LogData::Mmap(mmap),
                    size: metadata.len() as usize,
                    category: cat,
                });
            }
        }
    }

    Ok(items)
}

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
        let p = Path::new(path);
        if p.is_file() && !path.ends_with(".zip") && !path.ends_with(".gz") {
            let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
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
    let t0 = Instant::now();
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let mut mmaps = Vec::with_capacity(mmaps_with_paths.len());
    let mut tasks = Vec::new();

    for (file_idx, (_path, mmap)) in mmaps_with_paths.into_iter().enumerate() {
        let file_size = mmap.len();
        let n_shards = if file_size <= 16 * 1024 * 1024 {
            1
        } else {
            ((file_size + 32 * 1024 * 1024 - 1) / (32 * 1024 * 1024)).clamp(1, cpus.min(16))
        };
        let chunk_size = (file_size + n_shards - 1) / n_shards;
        for i in 0..n_shards {
            let start = i * chunk_size;
            if start >= file_size {
                break;
            }
            let end = ((i + 1) * chunk_size).min(file_size);
            tasks.push((file_idx, start, end, file_size));
        }
        mmaps.push(mmap);
    }

    let total_bytes: u64 = mmaps.iter().map(|m| m.len() as u64).sum();
    let completed_bytes = AtomicU64::new(0);

    let mut shards: Vec<pm2_core::Pm2Engine> = tasks
        .into_par_iter()
        .map(|(file_idx, start, end, file_size)| {
            let mmap = &mmaps[file_idx];
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (end + LINE_EXTEND).min(file_size);
            let slice = &mmap[start..read_end];
            engine.parse_shard(slice, start as f64, end as f64, file_size as f64);

            if let Some(app) = app_handle {
                let task_bytes = (end - start) as u64;
                let done = completed_bytes.fetch_add(task_bytes, Ordering::Relaxed) + task_bytes;
                let percent = if total_bytes > 0 {
                    ((done * 100) / total_bytes).min(99) as u32
                } else {
                    99
                };
                emit_progress(
                    Some(app),
                    "parsing",
                    done as usize,
                    total_bytes as usize,
                    percent,
                );
            }

            engine
        })
        .collect();

    // Tear down multi-GB mmaps in side thread so IPC and UI first-paint are not blocked
    std::thread::spawn(move || drop(mmaps));

    let shard_count = shards.len();
    emit_progress(
        app_handle,
        "complete",
        total_bytes as usize,
        total_bytes as usize,
        100,
    );

    let json = finalize::finalize_pm2(&mut shards, options)?;
    let total_hits: u32 = shards.iter().map(|s| s.hit_count()).sum();
    let total_unmatched: u32 = shards.iter().map(|s| s.unmatched_count()).sum();
    let combined_methods_mask: u8 = shards.iter().fold(0, |acc, s| acc | s.methods_mask());
    let elapsed = t0.elapsed().as_millis() as u64;

    Ok((
        shards,
        Pm2ParseResult {
            data: to_raw_value(json),
            hit_count: total_hits,
            unmatched_count: total_unmatched,
            methods_mask: combined_methods_mask,
            shard_count,
            parse_wall_ms: elapsed,
        },
    ))
}

/// Equal-sized shard ranges for one file, in one place so every caller splits a
/// file into identical shards.
fn pm2_shard_plan(file_size: usize, cpus: usize) -> Vec<(usize, usize)> {
    let n_shards = if file_size <= 8 * 1024 * 1024 {
        1
    } else {
        ((file_size + 16 * 1024 * 1024 - 1) / (16 * 1024 * 1024)).clamp(1, cpus.min(16))
    };
    let chunk_size = (file_size + n_shards - 1) / n_shards;
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

fn parse_pm2_items(
    items: Vec<LogSourceItem>,
    options: &Pm2ParseOptions,
    app_handle: Option<&tauri::AppHandle>,
    shared_progress: Option<&SharedProgress>,
) -> Result<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult), String> {
    let t0 = Instant::now();
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    let mut tasks = Vec::new();

    for item in &items {
        let file_size = item.size;
        for (start, end) in pm2_shard_plan(file_size, cpus) {
            tasks.push(ShardTaskRef {
                data: &item.data,
                start,
                end,
                file_size,
            });
        }
    }

    let total_bytes: u64 = items.iter().map(|i| i.size as u64).sum();
    let local_progress;
    let progress = match shared_progress {
        Some(shared) => shared,
        None => {
            local_progress = SharedProgress::new(app_handle, total_bytes);
            &local_progress
        }
    };

    let mut shards: Vec<pm2_core::Pm2Engine> = tasks
        .into_par_iter()
        .map(|task| {
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (task.end + LINE_EXTEND).min(task.file_size);
            let slice = &task.data[task.start..read_end];
            engine.parse_shard(
                slice,
                task.start as f64,
                task.end as f64,
                task.file_size as f64,
            );
            progress.add((task.end - task.start) as u64);
            engine
        })
        .collect();

    // Clean up memory in background
    std::thread::spawn(move || drop(items));

    let shard_count = shards.len();
    if shared_progress.is_none() {
        emit_progress(
            app_handle,
            "complete",
            total_bytes as usize,
            total_bytes as usize,
            100,
        );
    }

    let json = finalize::finalize_pm2(&mut shards, options)?;
    let total_hits: u32 = shards.iter().map(|s| s.hit_count()).sum();
    let total_unmatched: u32 = shards.iter().map(|s| s.unmatched_count()).sum();
    let combined_methods_mask: u8 = shards.iter().fold(0, |acc, s| acc | s.methods_mask());
    let elapsed = t0.elapsed().as_millis() as u64;

    Ok((
        shards,
        Pm2ParseResult {
            data: to_raw_value(json),
            hit_count: total_hits,
            unmatched_count: total_unmatched,
            methods_mask: combined_methods_mask,
            shard_count,
            parse_wall_ms: elapsed,
        },
    ))
}

pub fn parse_mongo_files_internal(
    paths: &[String],
    options: &MongoFilterOptions,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    if paths.is_empty() {
        return Err("No file paths provided".into());
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
    let t0 = Instant::now();
    let mut engine = existing_engine.unwrap_or_else(mongo_core::MongoEngine::new);

    let total_bytes: usize = items.iter().map(|i| i.size).sum();
    let local_progress;
    let progress = match shared_progress {
        Some(shared) => shared,
        None => {
            local_progress = SharedProgress::new(app_handle, total_bytes as u64);
            &local_progress
        }
    };

    for item in &items {
        let data: &[u8] = &item.data;
        // Feed in chunks: splitting the byte stream is lossless (`feed_slice`
        // keeps the partial line carry) and keeps progress live on huge logs.
        for chunk in data.chunks(MONGO_FEED_CHUNK_BYTES) {
            engine.feed_slice(chunk);
            progress.add(chunk.len() as u64);
        }
        engine.end_shard();
    }
    if shared_progress.is_none() {
        emit_progress(app_handle, "complete", total_bytes, total_bytes, 100);
    }

    let json = engine.reaggregate(
        options.op.as_deref().unwrap_or("all"),
        options.plan_filter.unwrap_or(0),
        options.min_duration_ms.unwrap_or(0),
        options.collection.as_deref().unwrap_or("all"),
        options.search_query.as_deref().unwrap_or(""),
        options.high_scan_ratio_only.unwrap_or(false),
        options.user.as_deref().unwrap_or("all"),
    );

    let slow_query_count = engine.slow_query_count();
    let total_lines = engine.total_lines();
    let elapsed = t0.elapsed().as_millis() as u64;

    Ok((
        engine,
        MongoParseResult {
            data: to_raw_value(json),
            parse_wall_ms: elapsed,
            slow_query_count,
            total_lines,
        },
    ))
}

/// Window size and pool depth for the streaming ZIP ingest: reusing a few small
/// buffers keeps the decompressed bytes cache-resident instead of faulting in a
/// full-size allocation.
const STREAM_WINDOW_BYTES: usize = 8 * 1024 * 1024;
const STREAM_WINDOW_POOL: usize = 3;

/// Inflate one deflated MongoDB log through a small window pool while a consumer
/// thread feeds the engine, so the parse overlaps decompression and no
/// full-size output buffer is allocated.
fn parse_mongo_entry_streamed(
    raw: &[u8],
    options: &MongoFilterOptions,
    progress: &SharedProgress,
    existing_engine: Option<mongo_core::MongoEngine>,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    let t0 = Instant::now();
    let mut engine = existing_engine.unwrap_or_else(mongo_core::MongoEngine::new);

    let (full_tx, full_rx) = std::sync::mpsc::sync_channel::<(Vec<u8>, usize)>(STREAM_WINDOW_POOL);
    let (free_tx, free_rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(STREAM_WINDOW_POOL);
    for _ in 0..STREAM_WINDOW_POOL {
        free_tx
            .send(vec![0u8; STREAM_WINDOW_BYTES])
            .map_err(|e| e.to_string())?;
    }

    let mut stream = archive::DeflateStream::new(raw);
    std::thread::scope(|scope| -> Result<(), String> {
        let engine_ref = &mut engine;
        let progress_ref = progress;
        let consumer = scope.spawn(move || {
            while let Ok((buf, len)) = full_rx.recv() {
                engine_ref.feed_slice(&buf[..len]);
                progress_ref.add(len as u64 * 2);
                let _ = free_tx.send(buf);
            }
        });

        while !stream.finished() {
            let mut buf = free_rx.recv().map_err(|e| e.to_string())?;
            let len = stream.fill(&mut buf)?;
            if len == 0 {
                break;
            }
            full_tx.send((buf, len)).map_err(|e| e.to_string())?;
        }
        drop(full_tx);
        consumer.join().map_err(|_| "mongo feed thread panicked")?;
        Ok(())
    })?;

    engine.end_shard();
    let json = engine.reaggregate(
        options.op.as_deref().unwrap_or("all"),
        options.plan_filter.unwrap_or(0),
        options.min_duration_ms.unwrap_or(0),
        options.collection.as_deref().unwrap_or("all"),
        options.search_query.as_deref().unwrap_or(""),
        options.high_scan_ratio_only.unwrap_or(false),
        options.user.as_deref().unwrap_or("all"),
    );
    let slow_query_count = engine.slow_query_count();
    let total_lines = engine.total_lines();
    let elapsed = t0.elapsed().as_millis() as u64;

    Ok((
        engine,
        MongoParseResult {
            data: to_raw_value(json),
            parse_wall_ms: elapsed,
            slow_query_count,
            total_lines,
        },
    ))
}

#[allow(clippy::too_many_arguments, clippy::type_complexity)]
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
    let entries = archive::parse_zip_entries(mmap)?;

    let mut pm2_entries = Vec::new();
    let mut mongo_entries = Vec::new();
    let mut unknown_entries = Vec::new();

    for entry in entries {
        let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
        if clean.starts_with('.')
            || clean.starts_with("__macosx")
            || entry.name.ends_with('/')
            || clean.contains("error")
            || entry.uncompressed_size == 0
        {
            continue;
        }

        let cat = classifier::classify_name(&entry.name);
        match cat {
            LogCategory::Pm2 => pm2_entries.push(entry),
            LogCategory::Mongo => mongo_entries.push(entry),
            LogCategory::Skip => {}
            _ => unknown_entries.push(entry),
        }
    }

    let mut extra_pm2 = Vec::new();
    let mut extra_mongo = Vec::new();

    for entry in unknown_entries {
        if let Ok(cow) = archive::extract_zip_entry(mmap, &entry) {
            let cat = classifier::classify_content(&cow);
            let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
            let size = cow.len();
            let data = cow.into_owned();
            let item = LogSourceItem {
                name: clean.to_string(),
                path: format!("{}/{}", zip_path, entry.name),
                data: LogData::Buffer(data),
                size,
                category: cat,
            };
            if cat == LogCategory::Pm2 {
                extra_pm2.push(item);
            } else if cat == LogCategory::Mongo {
                extra_mongo.push(item);
            }
        }
    }

    if pm2_entries.is_empty()
        && mongo_entries.is_empty()
        && extra_pm2.is_empty()
        && extra_mongo.is_empty()
    {
        return Err("No valid log files found in ZIP archive".into());
    }

    // Sort descending by compressed size for optimal LPT scheduling
    pm2_entries.sort_by_key(|e| std::cmp::Reverse(e.compressed_size));
    mongo_entries.sort_by_key(|e| std::cmp::Reverse(e.compressed_size));

    // Every archive byte is processed twice (inflate, then parse); entries that
    // had to be classified by content were already inflated above.
    let archive_bytes: u64 = pm2_entries
        .iter()
        .chain(mongo_entries.iter())
        .map(|e| e.uncompressed_size as u64)
        .sum();
    let classified_bytes: u64 = extra_pm2
        .iter()
        .chain(extra_mongo.iter())
        .map(|i| i.size as u64)
        .sum();
    let progress = SharedProgress::new(app_handle, archive_bytes * 2 + classified_bytes);

    let (pm2_outcome, mongo_outcome) = rayon::join(
        || -> Result<Option<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult, Vec<NativeFileInfo>)>, String> {
            if pm2_entries.is_empty() && extra_pm2.is_empty() {
                return Ok(None);
            }

            let mut items: Vec<LogSourceItem> = pm2_entries
                .into_par_iter()
                .filter_map(|entry| {
                    let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
                    let cow = archive::extract_zip_entry(mmap, &entry).ok()?;
                    progress.add(entry.uncompressed_size as u64);
                    let size = cow.len();
                    Some(LogSourceItem {
                        name: clean.to_string(),
                        path: format!("{}/{}", zip_path, entry.name),
                        data: LogData::Buffer(cow.into_owned()),
                        size,
                        category: LogCategory::Pm2,
                    })
                })
                .collect();

            items.extend(extra_pm2);

            if items.is_empty() {
                return Ok(None);
            }

            let file_infos: Vec<NativeFileInfo> = items
                .iter()
                .map(|it| NativeFileInfo {
                    name: it.name.clone(),
                    path: it.path.clone(),
                    size: it.size as u64,
                    category: "pm2".into(),
                })
                .collect();

            let (shards, res) = parse_pm2_items(items, pm2_options, app_handle, Some(&progress))?;
            Ok(Some((shards, res, file_infos)))
        },
        || -> Result<Option<(mongo_core::MongoEngine, MongoParseResult, Vec<NativeFileInfo>)>, String> {
            if mongo_entries.is_empty() && extra_mongo.is_empty() {
                return Ok(None);
            }

            // Streaming fast path: a single deflated entry is fed to the engine
            // while it inflates, so the parse hides behind decompression.
            if extra_mongo.is_empty()
                && mongo_entries.len() == 1
                && mongo_entries[0].compression_method == 8
            {
                let entry = &mongo_entries[0];
                let raw = &mmap[entry.data_start..entry.data_start + entry.compressed_size];
                let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
                let file_infos = vec![NativeFileInfo {
                    name: clean.to_string(),
                    path: format!("{}/{}", zip_path, entry.name),
                    size: entry.uncompressed_size as u64,
                    category: "mongo".into(),
                }];
                let existing = if upload_mode == Some("append") {
                    state.mongo.lock().unwrap().take()
                } else {
                    None
                };
                let (engine, res) = parse_mongo_entry_streamed(
                    raw,
                    mongo_options,
                    &progress,
                    existing,
                )?;
                return Ok(Some((engine, res, file_infos)));
            }

            let mut items: Vec<LogSourceItem> = mongo_entries
                .into_par_iter()
                .filter_map(|entry| {
                    let clean = entry.name.rsplit('/').next().unwrap_or(&entry.name);
                    let cow = archive::extract_zip_entry(mmap, &entry).ok()?;
                    progress.add(entry.uncompressed_size as u64);
                    let size = cow.len();
                    Some(LogSourceItem {
                        name: clean.to_string(),
                        path: format!("{}/{}", zip_path, entry.name),
                        data: LogData::Buffer(cow.into_owned()),
                        size,
                        category: LogCategory::Mongo,
                    })
                })
                .collect();

            items.extend(extra_mongo);

            if items.is_empty() {
                return Ok(None);
            }

            let file_infos: Vec<NativeFileInfo> = items
                .iter()
                .map(|it| NativeFileInfo {
                    name: it.name.clone(),
                    path: it.path.clone(),
                    size: it.size as u64,
                    category: "mongo".into(),
                })
                .collect();

            let existing = if upload_mode == Some("append") {
                state.mongo.lock().unwrap().take()
            } else {
                None
            };

            let (engine, res) = parse_mongo_items(items, mongo_options, app_handle, existing, Some(&progress))?;
            Ok(Some((engine, res, file_infos)))
        },
    );

    let pm2_pair = pm2_outcome?;
    let mongo_pair = mongo_outcome?;

    let mut all_files = Vec::new();
    let mut total_bytes = 0u64;

    let pm2_result = if let Some((shards, res, files)) = pm2_pair {
        for f in &files {
            total_bytes += f.size;
        }
        all_files.extend(files);

        let mut lock = state.pm2_shards.lock().unwrap();
        if upload_mode == Some("append") {
            lock.extend(shards);
            let combined_json = finalize::finalize_pm2(lock.as_mut_slice(), pm2_options)?;
            let hit_count = lock.iter().map(|s| s.hit_count()).sum();
            let unmatched_count = lock.iter().map(|s| s.unmatched_count()).sum();
            let methods_mask = lock.iter().fold(0, |acc, s| acc | s.methods_mask());
            let shard_count = lock.len();
            Some(Pm2ParseResult {
                data: to_raw_value(combined_json),
                hit_count,
                unmatched_count,
                methods_mask,
                shard_count,
                parse_wall_ms: res.parse_wall_ms,
            })
        } else {
            *lock = shards;
            Some(res)
        }
    } else {
        None
    };

    let mongo_result = if let Some((engine, res, files)) = mongo_pair {
        for f in &files {
            total_bytes += f.size;
        }
        all_files.extend(files);

        *state.mongo.lock().unwrap() = Some(engine);
        Some(res)
    } else {
        None
    };

    emit_progress(app_handle, "complete", 100, 100, 100);

    Ok(NativeIngestResult {
        pm2: pm2_result,
        mongo: mongo_result,
        files: all_files,
        total_bytes,
        parse_wall_ms: t0.elapsed().as_millis() as u64,
    })
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

    // Fast-path: single file (raw or zip)
    if paths.len() == 1 {
        let path = &paths[0];
        let p = Path::new(path);
        if p.is_file() {
            let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
            let mmap = unsafe { MmapOptions::new().map(&file) }
                .map_err(|e| format!("Failed to memory-map '{path}': {e}"))?;

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
                );
            }

            if !path.ends_with(".zip")
                && !path.ends_with(".gz")
                && (mmap.len() < 2 || &mmap[..2] != b"\x1f\x8b")
            {
                let file_name = p.file_name().and_then(|n| n.to_str()).unwrap_or(path);
                let cat = classifier::classify_file_or_entry(file_name, &mmap);
                let size = mmap.len() as u64;

                if cat == LogCategory::Mongo {
                    let (engine, res) = parse_mongo_items(
                        vec![LogSourceItem {
                            name: file_name.to_string(),
                            path: path.clone(),
                            data: LogData::Mmap(mmap),
                            size: size as usize,
                            category: LogCategory::Mongo,
                        }],
                        mongo_options,
                        app_handle,
                        if upload_mode == Some("append") {
                            state.mongo.lock().unwrap().take()
                        } else {
                            None
                        },
                        None,
                    )?;
                    *state.mongo.lock().unwrap() = Some(engine);
                    return Ok(NativeIngestResult {
                        pm2: None,
                        mongo: Some(res),
                        files: vec![NativeFileInfo {
                            name: file_name.to_string(),
                            path: path.clone(),
                            size,
                            category: "mongo".into(),
                        }],
                        total_bytes: size,
                        parse_wall_ms: t0.elapsed().as_millis() as u64,
                    });
                } else if cat == LogCategory::Pm2 || cat == LogCategory::Unknown {
                    let (shards, res) =
                        parse_pm2_raw_mmaps(vec![(path.clone(), mmap)], pm2_options, app_handle)?;
                    let mut lock = state.pm2_shards.lock().unwrap();
                    if upload_mode == Some("append") {
                        lock.extend(shards);
                        let combined_json =
                            finalize::finalize_pm2(lock.as_mut_slice(), pm2_options)?;
                        let hit_count = lock.iter().map(|s| s.hit_count()).sum();
                        let unmatched_count = lock.iter().map(|s| s.unmatched_count()).sum();
                        let methods_mask = lock.iter().fold(0, |acc, s| acc | s.methods_mask());
                        let shard_count = lock.len();
                        return Ok(NativeIngestResult {
                            pm2: Some(Pm2ParseResult {
                                data: to_raw_value(combined_json),
                                hit_count,
                                unmatched_count,
                                methods_mask,
                                shard_count,
                                parse_wall_ms: res.parse_wall_ms,
                            }),
                            mongo: None,
                            files: vec![NativeFileInfo {
                                name: file_name.to_string(),
                                path: path.clone(),
                                size,
                                category: "pm2".into(),
                            }],
                            total_bytes: size,
                            parse_wall_ms: t0.elapsed().as_millis() as u64,
                        });
                    } else {
                        *lock = shards;
                    }
                    return Ok(NativeIngestResult {
                        pm2: Some(res),
                        mongo: None,
                        files: vec![NativeFileInfo {
                            name: file_name.to_string(),
                            path: path.clone(),
                            size,
                            category: "pm2".into(),
                        }],
                        total_bytes: size,
                        parse_wall_ms: t0.elapsed().as_millis() as u64,
                    });
                }
            }
        }
    }

    // Expand all directories, zip archives, gzip streams, and raw files
    let items = expand_log_sources(paths, app_handle)?;
    if items.is_empty() {
        return Err("No valid log files found in provided sources".into());
    }

    let mut pm2_items = Vec::new();
    let mut mongo_items = Vec::new();
    let mut file_infos = Vec::new();
    let mut total_bytes = 0u64;

    for item in items {
        total_bytes += item.size as u64;
        let cat_str = match item.category {
            LogCategory::Mongo => "mongo",
            LogCategory::Pm2 => "pm2",
            _ => "unknown",
        };
        file_infos.push(NativeFileInfo {
            name: item.name.clone(),
            path: item.path.clone(),
            size: item.size as u64,
            category: cat_str.into(),
        });

        if item.category == LogCategory::Mongo {
            mongo_items.push(item);
        } else {
            pm2_items.push(item);
        }
    }

    let progress = SharedProgress::new(app_handle, total_bytes);

    let (pm2_outcome, mongo_outcome) = rayon::join(
        || -> Result<Option<(Vec<pm2_core::Pm2Engine>, Pm2ParseResult)>, String> {
            if pm2_items.is_empty() {
                Ok(None)
            } else {
                parse_pm2_items(pm2_items, pm2_options, app_handle, Some(&progress)).map(Some)
            }
        },
        || -> Result<Option<(mongo_core::MongoEngine, MongoParseResult)>, String> {
            if mongo_items.is_empty() {
                Ok(None)
            } else {
                let existing = if upload_mode == Some("append") {
                    state.mongo.lock().unwrap().take()
                } else {
                    None
                };
                parse_mongo_items(mongo_items, mongo_options, app_handle, existing, Some(&progress))
                    .map(Some)
            }
        },
    );

    let pm2_pair = pm2_outcome?;
    let mongo_pair = mongo_outcome?;

    let pm2_result = if let Some((shards, res)) = pm2_pair {
        let mut lock = state.pm2_shards.lock().unwrap();
        if upload_mode == Some("append") {
            lock.extend(shards);
            let combined_json = finalize::finalize_pm2(lock.as_mut_slice(), pm2_options)?;
            let hit_count = lock.iter().map(|s| s.hit_count()).sum();
            let unmatched_count = lock.iter().map(|s| s.unmatched_count()).sum();
            let methods_mask = lock.iter().fold(0, |acc, s| acc | s.methods_mask());
            let shard_count = lock.len();
            Some(Pm2ParseResult {
                data: to_raw_value(combined_json),
                hit_count,
                unmatched_count,
                methods_mask,
                shard_count,
                parse_wall_ms: res.parse_wall_ms,
            })
        } else {
            *lock = shards;
            Some(res)
        }
    } else {
        None
    };

    let mongo_result = if let Some((engine, res)) = mongo_pair {
        *state.mongo.lock().unwrap() = Some(engine);
        Some(res)
    } else {
        None
    };

    emit_progress(app_handle, "complete", 100, 100, 100);

    Ok(NativeIngestResult {
        pm2: pm2_result,
        mongo: mongo_result,
        files: file_infos,
        total_bytes,
        parse_wall_ms: t0.elapsed().as_millis() as u64,
    })
}

// Every command below does whole-file work (absorb, aggregate, serialize) that
// takes hundreds of milliseconds to seconds. They are async on purpose: a sync
// Tauri command runs on the webview's IPC thread, which stalls the window and
// delays every `native-progress` event until the job is already finished.
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
            data: to_raw_value(json),
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
) -> Result<String, String> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let state = handle.state::<AppState>();
        let lock = state.mongo.lock().unwrap();
        let engine = lock.as_ref().ok_or("MongoDB engine is not initialized")?;

        Ok(engine.reaggregate(
            options.op.as_deref().unwrap_or("all"),
            options.plan_filter.unwrap_or(0),
            options.min_duration_ms.unwrap_or(0),
            options.collection.as_deref().unwrap_or("all"),
            options.search_query.as_deref().unwrap_or(""),
            options.high_scan_ratio_only.unwrap_or(false),
            options.user.as_deref().unwrap_or("all"),
        ))
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
pub fn run() {
    configure_rayon_pool();
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
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_native_pm2_parse_sample() {
        let p = Path::new("../test_data/api-out.log");
        if !p.exists() {
            eprintln!("Sample log not found, skipping");
            return;
        }
        let (_shards, res) = parse_pm2_files_internal(
            &["../test_data/api-out.log".to_string()],
            &Pm2ParseOptions::default(),
            None,
        )
        .expect("Failed to parse PM2 log");

        assert!(res.hit_count > 0, "Expected hit_count > 0");
        assert!(res.parse_wall_ms < 10000, "Expected fast parse");
        let v: serde_json::Value =
            serde_json::from_str(res.data.get()).expect("valid result JSON");
        assert!(
            v["api"].as_array().is_some_and(|a| !a.is_empty()),
            "Expected api rows"
        );
        assert_eq!(
            v["summary"]["matched"].as_u64().unwrap(),
            res.hit_count as u64
        );
        assert!(!v["dailyStats"].as_array().unwrap().is_empty());
        println!(
            "PM2 Native parsed {} hits in {}ms ({} shards), result JSON {} KB",
            res.hit_count,
            res.parse_wall_ms,
            res.shard_count,
            res.data.get().len() / 1024
        );
    }

    #[test]
    #[ignore]
    fn test_native_pm2_parse_5gb() {
        let p = Path::new("../test_data/api-out-5gb.log");
        if !p.exists() {
            eprintln!("5GB log not found, skipping");
            return;
        }
        let t0 = Instant::now();
        let (_shards, res) = parse_pm2_files_internal(
            &["../test_data/api-out-5gb.log".to_string()],
            &Pm2ParseOptions::default(),
            None,
        )
        .expect("Failed to parse PM2 5GB log");
        println!(
            "5GB parse+finalize: {} hits in {}ms across {} shards (total wall: {}ms), result JSON {} KB",
            res.hit_count,
            res.parse_wall_ms,
            res.shard_count,
            t0.elapsed().as_millis(),
            res.data.get().len() / 1024,
        );
        assert_eq!(res.hit_count, 20315200);
        assert!(serde_json::from_str::<serde_json::Value>(res.data.get()).is_ok());
    }

    #[test]
    fn test_native_mongo_parse_sample() {
        let p = Path::new("../mongodb_logs_sample/eSanad-mongod.log");
        if !p.exists() {
            eprintln!("Sample mongo log not found, skipping");
            return;
        }
        let (_engine, res) = parse_mongo_files_internal(
            &["../mongodb_logs_sample/eSanad-mongod.log".to_string()],
            &MongoFilterOptions::default(),
            None,
        )
        .expect("Failed to parse Mongo log");

        assert!(res.total_lines > 0, "Expected total_lines > 0");
        println!(
            "Mongo Native parsed {} lines ({} slow) in {}ms",
            res.total_lines, res.slow_query_count, res.parse_wall_ms
        );
    }

    /// `parse_mongo_items` feeds big logs in `MONGO_FEED_CHUNK_BYTES` slices so the
    /// UI can show progress; splitting the byte stream must not change results.
    #[test]
    fn test_mongo_chunked_feed_matches_single_shot() {
        let p = Path::new("../mongodb_logs_sample/methaq-mongod.log");
        if !p.exists() {
            eprintln!("Large mongo log not found, skipping");
            return;
        }
        let data = std::fs::read(p).expect("read mongo log");

        let mut single = mongo_core::MongoEngine::new();
        single.feed_slice(&data);
        single.end_shard();

        let mut chunked = mongo_core::MongoEngine::new();
        for chunk in data.chunks(4 * 1024 * 1024) {
            chunked.feed_slice(chunk);
        }
        chunked.end_shard();

        assert_eq!(single.total_lines(), chunked.total_lines());
        assert_eq!(single.slow_query_count(), chunked.slow_query_count());

        // Reagg emits patterns in hash order and numbers their `id` from
        // that order, so compare content with array order and ids removed.
        let a = mongo_reagg_json(&single);
        let b = mongo_reagg_json(&chunked);
        assert_eq!(
            json_content(&a),
            json_content(&b),
            "chunked feed changed the aggregation"
        );
    }

    fn mongo_reagg_json(engine: &mongo_core::MongoEngine) -> serde_json::Value {
        serde_json::from_str(&engine.reaggregate("all", 0, 0, "all", "", false, "all"))
            .expect("valid mongo result JSON")
    }

    /// Canonical form for comparing aggregations: arrays sorted by content and
    /// `id` fields dropped (ids are numbered from hash-map iteration order).
    fn json_content(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(items) => {
                let mut sorted: Vec<serde_json::Value> = items.iter().map(json_content).collect();
                sorted.sort_by_cached_key(|item| item.to_string());
                serde_json::Value::Array(sorted)
            }
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.iter()
                    .filter(|(k, _)| k.as_str() != "id")
                    .map(|(k, v)| (k.clone(), json_content(v)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn test_ingest_native_mixed() {
        let p_pm2 = Path::new("../test_data/api-out.log");
        let p_mongo = Path::new("../mongodb_logs_sample/eSanad-mongod.log");
        if !p_pm2.exists() || !p_mongo.exists() {
            eprintln!("Test files not found, skipping");
            return;
        }

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let paths = vec![
            "../test_data/api-out.log".to_string(),
            "../mongodb_logs_sample/eSanad-mongod.log".to_string(),
        ];

        let res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("Failed to ingest mixed logs");

        assert!(res.pm2.is_some(), "Expected PM2 result");
        assert!(res.mongo.is_some(), "Expected Mongo result");
        assert_eq!(res.files.len(), 2);
        println!(
            "Mixed ingest succeeded: PM2 {} hits, Mongo {} lines, wall {}ms",
            res.pm2.as_ref().unwrap().hit_count,
            res.mongo.as_ref().unwrap().total_lines,
            res.parse_wall_ms
        );
    }

    fn create_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = Vec::new();
        let mut cd = Vec::new();

        for (name, data) in entries {
            let lh_offset = zip.len() as u32;
            let name_bytes = name.as_bytes();
            let len = data.len() as u32;

            zip.extend_from_slice(b"PK\x03\x04");
            zip.extend_from_slice(&20u16.to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(&0u32.to_le_bytes());
            zip.extend_from_slice(&len.to_le_bytes());
            zip.extend_from_slice(&len.to_le_bytes());
            zip.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            zip.extend_from_slice(&0u16.to_le_bytes());
            zip.extend_from_slice(name_bytes);
            zip.extend_from_slice(data);

            cd.extend_from_slice(b"PK\x01\x02");
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&20u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u32.to_le_bytes());
            cd.extend_from_slice(&len.to_le_bytes());
            cd.extend_from_slice(&len.to_le_bytes());
            cd.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u16.to_le_bytes());
            cd.extend_from_slice(&0u32.to_le_bytes());
            cd.extend_from_slice(&lh_offset.to_le_bytes());
            cd.extend_from_slice(name_bytes);
        }

        let cd_offset = zip.len() as u32;
        let cd_size = cd.len() as u32;
        let num_entries = entries.len() as u16;
        zip.extend_from_slice(&cd);

        zip.extend_from_slice(b"PK\x05\x06");
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&num_entries.to_le_bytes());
        zip.extend_from_slice(&num_entries.to_le_bytes());
        zip.extend_from_slice(&cd_size.to_le_bytes());
        zip.extend_from_slice(&cd_offset.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());

        std::fs::write(path, zip).expect("write test zip");
    }

    #[test]
    fn test_ingest_native_zip() {
        let zip_path = Path::new("target/test_archive.zip");
        let pm2_data = b"2026-09-12 10:00:00: GET /api/v1/users 200 12.3 ms - 100\n2026-09-12 10:00:01: POST /api/v1/login 200 45.6 ms - 200\n";
        let mongo_data = b"{\"t\":{\"$date\":\"2026-09-12T10:00:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"ctx\":\"conn1\",\"msg\":\"Slow query\",\"attr\":{\"durationMillis\":120}}\n";
        let err_data = b"Some error occurred\n";

        create_test_zip(
            zip_path,
            &[
                ("api-out.log", pm2_data),
                ("mongod.log", mongo_data),
                ("api-error.log", err_data),
                (".DS_Store", b"\x00\x00"),
            ],
        );

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let paths = vec![zip_path.to_string_lossy().to_string()];
        let res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("Failed to ingest ZIP archive");

        let _ = std::fs::remove_file(zip_path);

        assert!(res.pm2.is_some(), "Expected PM2 result from zip");
        assert!(res.mongo.is_some(), "Expected Mongo result from zip");
        assert_eq!(res.pm2.as_ref().unwrap().hit_count, 2);
        assert_eq!(res.mongo.as_ref().unwrap().slow_query_count, 1);
        assert_eq!(
            res.files.len(),
            2,
            "Error and metadata files should be skipped"
        );
        println!(
            "ZIP ingest verified: PM2 hits {}, Mongo slow {}, valid files {}",
            res.pm2.as_ref().unwrap().hit_count,
            res.mongo.as_ref().unwrap().slow_query_count,
            res.files.len()
        );
    }

    #[test]
    fn test_profile_methaq_zip() {
        let zip_path = Path::new("C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip");
        if !zip_path.exists() {
            println!("methaq zip not found, skipping");
            return;
        }

        let paths = vec![zip_path.to_string_lossy().to_string()];

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let t_ingest = Instant::now();
        let ingest_res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("ingest_native_internal");
        let ingest_wall = t_ingest.elapsed().as_millis();

        println!(
            "FULL INGEST NATIVE: wall {}ms (pm2 hits: {}, mongo lines: {})",
            ingest_wall,
            ingest_res.pm2.as_ref().map(|p| p.hit_count).unwrap_or(0),
            ingest_res
                .mongo
                .as_ref()
                .map(|m| m.total_lines)
                .unwrap_or(0),
        );
    }
}
