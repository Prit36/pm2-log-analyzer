//! Cron event aggregation for the PM2 result.

use hashbrown::HashMap;
use pm2_core::CronEv;

use crate::Pm2ParseOptions;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CronRow {
    name: String,
    runs: usize,
    starts: u32,
    fails: u32,
    avg_ms: f64,
    p50_ms: f64,
    p90_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
    min_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_duration_ms: Option<f64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CronSummary {
    starts: u32,
    dones: u32,
    fails: u32,
    jobs: usize,
    slowest_run: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CronBucket {
    name: String,
    starts: u32,
    durations: Vec<f64>,
    fails: u32,
    last_run_ts: Option<String>,
    last_duration_ms: Option<f64>,
}

pub(crate) fn aggregate_cron(events: &[CronEv], options: &Pm2ParseOptions) -> Vec<CronRow> {
    let filter = CronFilter::new(options);
    let mut buckets: HashMap<Vec<u8>, CronBucket> = HashMap::new();
    let mut start_map: HashMap<Vec<u8>, Option<Vec<u8>>> = HashMap::new();

    for event in events {
        if !filter.accepts(event) {
            continue;
        }
        let bucket = buckets
            .entry(event.name.clone())
            .or_insert_with(|| CronBucket::new(event));
        if event.event == 0 {
            bucket.starts += 1;
            start_map.insert(event.name.clone(), event.ts.clone());
            continue;
        }
        let duration = resolve_cron_duration(event, &start_map, filter.min_ms);
        start_map.remove(&event.name);
        bucket.record_finish(duration, event);
    }

    buckets
        .into_values()
        .filter(|bucket| filter.accepts_row(bucket))
        .map(CronRow::from_bucket)
        .collect()
}

/// The filter knobs of one cron aggregation.
struct CronFilter {
    query: String,
    min_ms: f32,
    show_failed_only: bool,
    date_filter: String,
}

impl CronFilter {
    fn new(options: &Pm2ParseOptions) -> Self {
        Self {
            query: options
                .cron_query
                .as_deref()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase(),
            min_ms: options.cron_min_ms.unwrap_or(0.0),
            show_failed_only: options.cron_show_failed_only.unwrap_or(false),
            date_filter: options.date_filter.clone().unwrap_or_default(),
        }
    }

    /// Whether the event is inside the filtered date window and name query.
    fn accepts(&self, event: &CronEv) -> bool {
        if !is_in_date_window(event, &self.date_filter) {
            return false;
        }
        self.query.is_empty()
            || String::from_utf8_lossy(&event.name)
                .to_ascii_lowercase()
                .contains(&self.query)
    }

    fn accepts_row(&self, bucket: &CronBucket) -> bool {
        !self.show_failed_only || bucket.fails > 0
    }
}

/// Whether the event carries a timestamp inside `date_filter` (or has none).
fn is_in_date_window(event: &CronEv, date_filter: &str) -> bool {
    if date_filter.is_empty() {
        return true;
    }
    match &event.ts {
        Some(timestamp) => timestamp.starts_with(date_filter.as_bytes()),
        None => true,
    }
}

impl CronBucket {
    fn new(event: &CronEv) -> Self {
        Self {
            name: String::from_utf8_lossy(&event.name).into_owned(),
            starts: 0,
            durations: Vec::new(),
            fails: 0,
            last_run_ts: None,
            last_duration_ms: None,
        }
    }

    /// Record a finished run: its duration, timestamp, and failure count.
    fn record_finish(&mut self, duration: Option<f64>, event: &CronEv) {
        if let Some(value) = duration {
            self.durations.push(value);
            self.last_duration_ms = Some(value);
            if let Some(timestamp) = &event.ts {
                self.last_run_ts = Some(String::from_utf8_lossy(timestamp).into_owned());
            }
        }
        if event.event == 2 {
            self.fails += 1;
        }
    }
}

impl CronRow {
    /// Summarize one bucket's run durations.
    fn from_bucket(bucket: CronBucket) -> Self {
        let mut sorted = bucket.durations;
        sorted.sort_unstable_by(f64::total_cmp);
        let runs = sorted.len();
        let sum: f64 = sorted.iter().sum();
        Self {
            name: bucket.name,
            runs,
            starts: bucket.starts,
            fails: bucket.fails,
            avg_ms: if runs > 0 { sum / runs as f64 } else { 0.0 },
            p50_ms: percentile(&sorted, 50.0),
            p90_ms: percentile(&sorted, 90.0),
            p95_ms: percentile(&sorted, 95.0),
            p99_ms: percentile(&sorted, 99.0),
            min_ms: sorted.first().copied().unwrap_or(0.0),
            max_ms: sorted.last().copied().unwrap_or(0.0),
            last_run_ts: bucket.last_run_ts,
            last_duration_ms: bucket.last_duration_ms,
        }
    }
}

/// Nearest-rank percentile on an ascending array (parity with `src/parser/percentiles.ts`).
pub(crate) fn percentile(sorted: &[f64], quantile: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (((quantile / 100.0) * sorted.len() as f64).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len() - 1);
    sorted[idx]
}

fn resolve_cron_duration(
    ev: &CronEv,
    start_map: &HashMap<Vec<u8>, Option<Vec<u8>>>,
    min_ms: f32,
) -> Option<f64> {
    if let Some(d) = ev.duration_ms {
        return (d >= min_ms).then_some(d as f64);
    }
    let start_ts = start_map.get(&ev.name)?.as_ref()?;
    let end_ts = ev.ts.as_ref()?;
    let start = parse_ts_seconds(start_ts)?;
    let end = parse_ts_seconds(end_ts)?;
    if end < start {
        return None;
    }
    let dur = ((end - start) * 1000) as f64;
    (dur >= min_ms as f64).then_some(dur)
}

/// `YYYY-MM-DD[T ]HH:MM:SS` -> seconds since the civil epoch (wall clock, no timezone).
pub(crate) fn parse_ts_seconds(timestamp: &[u8]) -> Option<i64> {
    if timestamp.len() < 19 {
        return None;
    }
    let num = |start: usize, len: usize| -> Option<i64> {
        let mut value: i64 = 0;
        for offset in 0..len {
            let digit = *timestamp.get(start + offset)?;
            if !digit.is_ascii_digit() {
                return None;
            }
            value = value * 10 + (digit - b'0') as i64;
        }
        Some(value)
    };
    let year = num(0, 4)?;
    let month = num(5, 2)?;
    let day = num(8, 2)?;
    let hour = num(11, 2)?;
    let minute = num(14, 2)?;
    let second = num(17, 2)?;
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

/// Days since 1970-01-01 (Howard Hinnant's civil algorithm).
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let adjusted_year = if month <= 2 { year - 1 } else { year };
    let era = if adjusted_year >= 0 {
        adjusted_year
    } else {
        adjusted_year - 399
    } / 400;
    let year_of_era = adjusted_year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

pub(crate) fn build_cron_summary(
    events: &[CronEv],
    date_filter: &str,
    rows: &[CronRow],
) -> CronSummary {
    let mut starts = 0u32;
    let mut dones = 0u32;
    let mut fails = 0u32;
    for event in events {
        if !is_in_date_window(event, date_filter) {
            continue;
        }
        match event.event {
            0 => starts += 1,
            1 => dones += 1,
            _ => fails += 1,
        }
    }
    CronSummary {
        starts,
        dones,
        fails,
        jobs: rows.len(),
        slowest_run: rows
            .iter()
            .fold(0.0f64, |slowest, row| slowest.max(row.max_ms)),
    }
}
