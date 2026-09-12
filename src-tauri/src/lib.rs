mod finalize;

use memmap2::MmapOptions;
use rayon::prelude::*;
use std::fs::File;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{Emitter, State};

const CHUNK_SIZE: usize = 32 * 1024 * 1024;
const LINE_EXTEND: usize = 256 * 1024;

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

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ParseResult {
    /// Ready-to-render `AggregatedResult` JSON (all aggregation done natively).
    pub json: String,
    pub hit_count: u32,
    pub unmatched_count: u32,
    pub methods_mask: u8,
    pub shard_count: usize,
    pub parse_wall_ms: u64,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct Pm2ReaggResult {
    pub json: String,
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
    pub json: String,
    pub parse_wall_ms: u64,
    pub slow_query_count: u32,
    pub total_lines: u32,
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

struct ShardTask {
    file_idx: usize,
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

    let t0 = Instant::now();
    let cpus = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let mut mmaps = Vec::new();
    let mut tasks = Vec::new();

    for (file_idx, path) in paths.iter().enumerate() {
        let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
        let mmap = unsafe { MmapOptions::new().map(&file) }
            .map_err(|e| format!("Failed to memory-map '{path}': {e}"))?;
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
            tasks.push(ShardTask {
                file_idx,
                start,
                end,
                file_size,
            });
        }
        mmaps.push(mmap);
    }

    let total_bytes: u64 = mmaps.iter().map(|m| m.len() as u64).sum();
    let completed_bytes = std::sync::atomic::AtomicU64::new(0);

    let mut shards: Vec<pm2_core::Pm2Engine> = tasks
        .into_par_iter()
        .map(|task| {
            let mmap = &mmaps[task.file_idx];
            let mut engine = pm2_core::Pm2Engine::new();
            let read_end = (task.end + LINE_EXTEND).min(task.file_size);
            let slice = &mmap[task.start..read_end];
            engine.parse_shard(slice, task.start as f64, task.end as f64, task.file_size as f64);

            if let Some(app) = app_handle {
                let task_bytes = (task.end - task.start) as u64;
                let done = completed_bytes.fetch_add(task_bytes, std::sync::atomic::Ordering::Relaxed) + task_bytes;
                let percent = if total_bytes > 0 {
                    ((done * 100) / total_bytes).min(99) as u32
                } else {
                    99
                };
                let _ = app.emit(
                    "native-progress",
                    ProgressPayload {
                        stage: "parsing".into(),
                        processed: done as usize,
                        total: total_bytes as usize,
                        percent,
                    },
                );
            }

            engine
        })
        .collect();

    // The mmaps are only read during the shard parse above. Unmapping a multi-GB
    // view costs ~0.6s on Windows; tear it down on a side thread so the IPC
    // response (and therefore the first paint) is not blocked by it.
    std::thread::spawn(move || drop(mmaps));

    let shard_count = shards.len();

    if let Some(app) = app_handle {
        let _ = app.emit(
            "native-progress",
            ProgressPayload {
                stage: "complete".into(),
                processed: total_bytes as usize,
                total: total_bytes as usize,
                percent: 100,
            },
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
            json,
            hit_count: total_hits,
            unmatched_count: total_unmatched,
            methods_mask: combined_methods_mask,
            shard_count,
            parse_wall_ms: elapsed,
        },
    ))
}

#[tauri::command]
fn parse_pm2_files(
    paths: Vec<String>,
    options: Pm2ParseOptions,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Pm2ParseResult, String> {
    let (shards, res) = parse_pm2_files_internal(&paths, &options, Some(&app))?;
    let mut lock = state.pm2_shards.lock().unwrap();
    *lock = shards;
    Ok(res)
}

#[tauri::command]
fn reaggregate_pm2(
    options: Pm2ParseOptions,
    state: State<'_, AppState>,
) -> Result<Pm2ReaggResult, String> {
    let t0 = Instant::now();
    let mut lock = state.pm2_shards.lock().unwrap();
    if lock.is_empty() {
        return Err("PM2 engine is not initialized".into());
    }
    let json = finalize::finalize_pm2(lock.as_mut_slice(), &options)?;
    Ok(Pm2ReaggResult {
        json,
        reagg_wall_ms: t0.elapsed().as_millis() as u64,
    })
}

pub fn parse_mongo_files_internal(
    paths: &[String],
    options: &MongoFilterOptions,
) -> Result<(mongo_core::MongoEngine, MongoParseResult), String> {
    if paths.is_empty() {
        return Err("No file paths provided".into());
    }

    let t0 = Instant::now();
    let mut engine = mongo_core::MongoEngine::new();

    for path in paths {
        let file = File::open(path).map_err(|e| format!("Failed to open '{path}': {e}"))?;
        let mmap = unsafe { MmapOptions::new().map(&file) }
            .map_err(|e| format!("Failed to memory-map '{path}': {e}"))?;

        let mut offset = 0usize;
        while offset < mmap.len() {
            let take = CHUNK_SIZE.min(mmap.len() - offset);
            engine.write_slice(&mmap[offset..offset + take]);
            engine.feed(take as u32, offset as f64);
            offset += take;
        }
        engine.end_shard();
    }

    let elapsed = t0.elapsed().as_millis() as u64;
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

    Ok((
        engine,
        MongoParseResult {
            json,
            parse_wall_ms: elapsed,
            slow_query_count,
            total_lines,
        },
    ))
}

#[tauri::command]
fn parse_mongo_files(
    paths: Vec<String>,
    options: MongoFilterOptions,
    state: State<'_, AppState>,
) -> Result<MongoParseResult, String> {
    let (engine, res) = parse_mongo_files_internal(&paths, &options)?;
    let mut lock = state.mongo.lock().unwrap();
    *lock = Some(engine);
    Ok(res)
}

#[tauri::command]
fn reaggregate_mongo(
    options: MongoFilterOptions,
    state: State<'_, AppState>,
) -> Result<String, String> {
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
}

#[tauri::command]
fn clear_engine(state: State<'_, AppState>) {
    let mut pm2 = state.pm2_shards.lock().unwrap();
    pm2.clear();
    let mut mongo = state.mongo.lock().unwrap();
    *mongo = None;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
        let v: serde_json::Value = serde_json::from_str(&res.json).expect("valid result JSON");
        assert!(
            v["api"].as_array().is_some_and(|a| !a.is_empty()),
            "Expected api rows"
        );
        assert_eq!(v["summary"]["matched"].as_u64().unwrap(), res.hit_count as u64);
        assert!(!v["dailyStats"].as_array().unwrap().is_empty());
        println!(
            "PM2 Native parsed {} hits in {}ms ({} shards), result JSON {} KB",
            res.hit_count,
            res.parse_wall_ms,
            res.shard_count,
            res.json.len() / 1024
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
            res.json.len() / 1024,
        );
        assert_eq!(res.hit_count, 20315200);
        assert!(serde_json::from_str::<serde_json::Value>(&res.json).is_ok());
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
        )
        .expect("Failed to parse Mongo log");

        assert!(res.total_lines > 0, "Expected total_lines > 0");
        println!(
            "Mongo Native parsed {} lines ({} slow) in {}ms",
            res.total_lines, res.slow_query_count, res.parse_wall_ms
        );
    }
}

