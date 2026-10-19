use super::*;
use std::sync::atomic::AtomicBool;

#[derive(Default)]
pub struct NginxState {
    pub shards: Vec<nginx_core::Engine>,
}

#[derive(serde::Serialize, Clone, Debug)]
pub struct ParseResult {
    pub payload: Option<PayloadRef>,
    pub parse_wall_ms: u64,
    pub hit_count: usize,
    pub shard_count: usize,
}

pub(super) struct Ingest<'a> {
    pub options: &'a nginx_core::Filters,
    pub state: &'a AppState,
    pub generation: u64,
    pub replace: bool,
    prepared: AtomicBool,
}

impl<'a> Ingest<'a> {
    pub fn new(
        options: &'a nginx_core::Filters,
        state: &'a AppState,
        generation: u64,
        replace: bool,
    ) -> Self {
        Self {
            options,
            state,
            generation,
            replace,
            prepared: AtomicBool::new(false),
        }
    }

    /// Release old retained columns before replacement starts, once per import.
    pub fn prepare(&self) -> bool {
        let mut state = self.state.nginx.lock().unwrap();
        if !self.current() {
            return false;
        }
        if !self.prepared.swap(true, Ordering::Relaxed) && self.replace {
            state.shards.clear();
            self.state.nginx_active.store(false, Ordering::Release);
        }
        true
    }

    pub fn current(&self) -> bool {
        self.state.nginx_generation.load(Ordering::Acquire) == self.generation
    }

    /// Aggregate incoming and retained shards without committing failed appends.
    pub fn finish(
        &self,
        mut incoming: Vec<nginx_core::Engine>,
        started: Instant,
    ) -> Result<Option<ParseResult>, String> {
        if !self.current() {
            return Err("Nginx import cancelled".into());
        }
        if incoming.is_empty() {
            return Ok(None);
        }
        let mut state = self.state.nginx.lock().unwrap();
        if !self.current() {
            return Err("Nginx import cancelled".into());
        }
        let mut partials: Vec<_> = incoming
            .par_iter_mut()
            .map(|engine| engine.aggregate(self.options))
            .collect();
        if !self.replace {
            partials.extend(
                state
                    .shards
                    .par_iter_mut()
                    .map(|engine| engine.aggregate(self.options))
                    .collect::<Vec<_>>(),
            );
        }
        let json = serde_json::to_string(&nginx_core::merge_partials(partials, self.options))
            .map_err(|error| error.to_string())?;
        if !self.current() {
            return Err("Nginx import cancelled".into());
        }
        let retained = state.shards.len();
        if self.replace {
            state.shards = incoming;
        } else {
            state.shards.append(&mut incoming);
        }
        if !self.current() {
            state
                .shards
                .truncate(if self.replace { 0 } else { retained });
            self.state
                .nginx_active
                .store(!state.shards.is_empty(), Ordering::Release);
            return Err("Nginx import cancelled".into());
        }
        self.state
            .nginx_active
            .store(!state.shards.is_empty(), Ordering::Release);
        Ok(Some(ParseResult {
            payload: publish_payload(json),
            parse_wall_ms: started.elapsed().as_millis() as u64,
            hit_count: state.shards.iter().map(nginx_core::Engine::hit_count).sum(),
            shard_count: state.shards.len(),
        }))
    }
}

/// Align complete lines once, including lines longer than the normal lookahead.
pub(super) fn parse_slice(
    data: &[u8],
    progress: &SharedProgress<'_>,
    cpus: usize,
) -> Vec<nginx_core::Engine> {
    if progress.nginx.is_some_and(|context| !context.prepare()) {
        return Vec::new();
    }
    let plan = pm2_shard_plan(data.len(), cpus.min(16));
    let mut boundaries = Vec::with_capacity(plan.len() + 1);
    boundaries.push(0);
    for &(start, _) in plan.iter().skip(1) {
        let end = if data[start - 1] == b'\n' {
            start
        } else {
            data[start..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(data.len(), |offset| start + offset + 1)
        };
        if boundaries.last() != Some(&end) {
            boundaries.push(end);
        }
    }
    if boundaries.last() != Some(&data.len()) {
        boundaries.push(data.len());
    }
    boundaries
        .par_windows(2)
        .filter_map(|range| {
            let mut engine = nginx_core::Engine::new();
            for bytes in data[range[0]..range[1]].chunks(16 * 1024 * 1024) {
                if progress.nginx.is_some_and(|context| !context.current()) {
                    return None;
                }
                engine.feed_slice(bytes);
                progress.add(bytes.len() as u64);
            }
            engine.end_source();
            Some(engine)
        })
        .collect()
}

#[tauri::command]
pub async fn reaggregate_nginx(
    options: nginx_core::Filters,
    app: tauri::AppHandle,
) -> Result<Pm2ReaggResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let state = app.state::<AppState>();
        let mut nginx = state.nginx.lock().unwrap();
        if nginx.shards.is_empty() {
            return Err("Nginx engine is not initialized".into());
        }
        let partials = nginx
            .shards
            .par_iter_mut()
            .map(|engine| engine.aggregate(&options))
            .collect();
        let json = serde_json::to_string(&nginx_core::merge_partials(partials, &options))
            .map_err(|error| error.to_string())?;
        Ok(Pm2ReaggResult {
            payload: publish_payload(json),
            reagg_wall_ms: started.elapsed().as_millis() as u64,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ingest_nginx_text(
    text: String,
    options: nginx_core::Filters,
    app: tauri::AppHandle,
) -> Result<ParseResult, String> {
    if text.trim().is_empty() {
        return Err("No Nginx log text provided".into());
    }
    let generation = app
        .state::<AppState>()
        .nginx_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let state = app.state::<AppState>();
        let context = Ingest::new(&options, &state, generation, true);
        let mut progress = SharedProgress::new(Some(&app), text.len() as u64);
        progress.nginx = Some(&context);
        let shards = parse_slice(text.as_bytes(), &progress, available_parallelism());
        context
            .finish(shards, started)?
            .ok_or_else(|| "No Nginx log text provided".into())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_nginx(state: State<'_, AppState>) -> bool {
    state.nginx_generation.fetch_add(1, Ordering::AcqRel);
    state.nginx_active.load(Ordering::Acquire)
}

#[tauri::command]
pub fn nginx_engine_active(state: State<'_, AppState>) -> bool {
    state.nginx_active.load(Ordering::Acquire)
}

#[tauri::command]
pub async fn clear_nginx(app: tauri::AppHandle) -> Result<(), String> {
    let generation = app
        .state::<AppState>()
        .nginx_generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut nginx = state.nginx.lock().unwrap();
        if state.nginx_generation.load(Ordering::Acquire) == generation {
            nginx.shards.clear();
            state.nginx_active.store(false, Ordering::Release);
        }
    })
    .await
    .map_err(|error| error.to_string())
}
