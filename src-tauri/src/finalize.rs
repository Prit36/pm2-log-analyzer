//! Native PM2 finalization: shard engines -> ready-to-render [`AggregatedResult`] JSON.
//!
//! Everything the UI needs (api rows with percentiles, summary, hourly/daily buckets,
//! cron aggregation, dates, unmatched sample) is computed here. JS only parses this
//! JSON and hands it to the store.

use hashbrown::hash_map::Entry;
use hashbrown::{HashMap, HashSet};

use pm2_core::{CronEv, DailyAcc, HourlyAcc, Pm2Engine};
use rayon::prelude::*;

use crate::cron::{aggregate_cron, build_cron_summary, CronRow, CronSummary};
use crate::{mode_code, status_code, Pm2ParseOptions};

const METHODS: [&str; 6] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
const UNMATCHED_SAMPLE_CAP: usize = 40;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiRow {
    method: &'static str,
    path: String,
    count: u32,
    avg_ms: f64,
    p50_ms: f32,
    p90_ms: f32,
    p95_ms: f32,
    p99_ms: f32,
    max_ms: f32,
    min_ms: f32,
    error_count: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LogSummary {
    matched: u32,
    unmatched: u32,
    max: f32,
    avg: f64,
    p95_ms: f32,
    errors: u32,
    slow: u32,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct HourlyBucket {
    hour: u8,
    label: String,
    count: u32,
    error_count: u32,
    avg_ms: i64,
    p95_ms: i64,
    p99_ms: i64,
    max_ms: i64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DaySummary {
    date: String,
    count: u32,
    error_count: u32,
    avg_ms: i64,
    p95_ms: i64,
    p99_ms: i64,
    max_ms: i64,
    slow_count: u32,
    hourly_stats: Vec<HourlyBucket>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AggregatedResult {
    api: Vec<ApiRow>,
    cron: Vec<CronRow>,
    summary: LogSummary,
    cron_summary: CronSummary,
    hourly_stats: Vec<HourlyBucket>,
    methods: Vec<&'static str>,
    unmatched_sample: Vec<String>,
    unmatched_count: u32,
    dates: Vec<String>,
    daily_stats: Vec<DaySummary>,
}

/// Endpoint merge partitions. Sized well above the worker count so a rayon
/// scheduler with a long tail still packs the work evenly.
const NUM_MERGE_BUCKETS: usize = 64;

struct MergedEndpoint {
    count: u32,
    sum: f64,
    min: f32,
    max: f32,
    error_count: u32,
    sketch: Box<pm2_core::RelHist>,
}

impl MergedEndpoint {
    /// Start an accumulator from an endpoint that is not in the map yet.
    fn from_endpoint(endpoint: &pm2_core::DecodedEndpoint) -> Self {
        Self {
            count: endpoint.count,
            sum: endpoint.sum,
            min: endpoint.min,
            max: endpoint.max,
            error_count: endpoint.error_count,
            sketch: endpoint.sketch.clone(),
        }
    }

    /// Fold one more endpoint in, preserving the smallest non-zero minimum.
    fn absorb(&mut self, endpoint: &pm2_core::DecodedEndpoint) {
        self.count += endpoint.count;
        self.sum += endpoint.sum;
        if endpoint.count > 0 && (self.count == endpoint.count || endpoint.min < self.min) {
            self.min = endpoint.min;
        }
        if endpoint.max > self.max {
            self.max = endpoint.max;
        }
        self.error_count += endpoint.error_count;
        self.sketch.merge(&endpoint.sketch);
    }
}


/// Finalize the stored shard engines into the exact [`AggregatedResult`] JSON the UI renders.
pub fn finalize_pm2(shards: &mut [Pm2Engine], options: &Pm2ParseOptions) -> Result<String, String> {
    let mode = mode_code(options.normalize_mode.as_deref());
    let status = status_code(options.status_family.as_deref());
    let min_ms = options.min_ms.unwrap_or(0.0);
    let date_filter = options.date_filter.clone().unwrap_or_default();

    let partials: Vec<pm2_core::DecodedPartial> = shards
        .par_iter_mut()
        .map(|e| e.reaggregate_decoded(mode, status, min_ms, date_filter.as_bytes(), true))
        .collect();

    finalize_pm2_with_partials(shards, options, partials)
}

/// Finalize using precomputed shard partials (skips redundant re-aggregation pass).
pub fn finalize_pm2_with_partials(
    shards: &mut [Pm2Engine],
    options: &Pm2ParseOptions,
    partials: Vec<pm2_core::DecodedPartial>,
) -> Result<String, String> {
    let date_filter = options.date_filter.clone().unwrap_or_default();
    let MergedPartials { summary, partitioned } = merge_partials(partials);
    let (api, diagnostics) = rayon::join(
        || merge_api_endpoints(partitioned),
        || collect_shard_diagnostics(shards, &date_filter, options),
    );

    let result = AggregatedResult {
        api,
        cron: diagnostics.cron,
        summary,
        cron_summary: diagnostics.cron_summary,
        hourly_stats: diagnostics.hourly,
        methods: methods_from_mask(diagnostics.methods_mask),
        unmatched_sample: diagnostics.unmatched_sample,
        unmatched_count: diagnostics.total_unmatched,
        dates: diagnostics
            .dates
            .iter()
            .map(|bytes| String::from_utf8_lossy(bytes).into_owned())
            .collect(),
        daily_stats: diagnostics.daily,
    };

    serde_json::to_string(&result).map_err(|error| format!("failed to serialize PM2 result: {error}"))
}

/// The merged summary plus every endpoint, hash-partitioned for the parallel pass.
struct MergedPartials {
    summary: LogSummary,
    partitioned: [Vec<pm2_core::DecodedEndpoint>; NUM_MERGE_BUCKETS],
}

/// Totals accumulated across the shard partials before they become a [`LogSummary`].
struct PartialTotals {
    matched: u32,
    unmatched: u32,
    sum: f64,
    max: f32,
    errors: u32,
    slow: u32,
    sketch: pm2_core::RelHist,
    has_summary: bool,
}

impl PartialTotals {
    fn new() -> Self {
        Self {
            matched: 0,
            unmatched: 0,
            sum: 0.0,
            max: 0.0,
            errors: 0,
            slow: 0,
            sketch: pm2_core::RelHist::new(),
            has_summary: false,
        }
    }

    fn absorb(&mut self, partial: &pm2_core::DecodedPartial) {
        self.matched += partial.matched;
        self.unmatched += partial.unmatched;
        if let Some(summary) = &partial.summary {
            self.has_summary = true;
            self.sum += summary.sum;
            if summary.max > self.max {
                self.max = summary.max;
            }
            self.errors += summary.errors;
            self.slow += summary.slow;
            self.sketch.merge(&summary.sketch);
        }
    }

    fn into_summary(self) -> LogSummary {
        if !self.has_summary {
            return LogSummary {
                matched: self.matched,
                unmatched: self.unmatched,
                max: 0.0,
                avg: 0.0,
                p95_ms: 0.0,
                errors: 0,
                slow: 0,
            };
        }
        LogSummary {
            matched: self.matched,
            unmatched: self.unmatched,
            max: self.max,
            avg: if self.matched > 0 {
                self.sum / self.matched as f64
            } else {
                0.0
            },
            p95_ms: self.sketch.quantile_ms(0.95),
            errors: self.errors,
            slow: self.slow,
        }
    }
}

/// Merge every shard partial into one bucket set plus its summary.
fn merge_partials(partials: Vec<pm2_core::DecodedPartial>) -> MergedPartials {
    let mut totals = PartialTotals::new();
    let mut partitioned: [Vec<pm2_core::DecodedEndpoint>; NUM_MERGE_BUCKETS] =
        std::array::from_fn(|_| Vec::with_capacity(512));
    for partial in partials {
        totals.absorb(&partial);
        for endpoint in partial.endpoints {
            let bucket = (endpoint.hash as usize) & (NUM_MERGE_BUCKETS - 1);
            partitioned[bucket].push(endpoint);
        }
    }
    MergedPartials {
        summary: totals.into_summary(),
        partitioned,
    }
}

/// Merge the partitioned endpoints into one row per `(method, path)`.
fn merge_api_endpoints(
    partitioned: [Vec<pm2_core::DecodedEndpoint>; NUM_MERGE_BUCKETS],
) -> Vec<ApiRow> {
    let buckets: Vec<Vec<ApiRow>> = partitioned.into_par_iter().map(merge_api_bucket).collect();
    let total_unique: usize = buckets.iter().map(Vec::len).sum();
    let mut api = Vec::with_capacity(total_unique);
    for bucket in buckets {
        api.extend(bucket);
    }
    api
}

/// One hash bucket's rows.
fn merge_api_bucket(bucket_endpoints: Vec<pm2_core::DecodedEndpoint>) -> Vec<ApiRow> {
    let mut maps: ApiMethodMaps = ApiMethodMaps::new();
    for endpoint in bucket_endpoints {
        maps.absorb(endpoint);
    }
    maps.into_rows()
}

/// Per-method endpoint accumulators for one bucket.
struct ApiMethodMaps {
    maps: [HashMap<Vec<u8>, MergedEndpoint>; 6],
}

impl ApiMethodMaps {
    fn new() -> Self {
        Self {
            maps: [
                HashMap::with_capacity(256),
                HashMap::with_capacity(64),
                HashMap::with_capacity(32),
                HashMap::with_capacity(16),
                HashMap::with_capacity(16),
                HashMap::with_capacity(16),
            ],
        }
    }

    fn absorb(&mut self, endpoint: pm2_core::DecodedEndpoint) {
        let method = (endpoint.method as usize).min(5);
        let map = &mut self.maps[method];
        match map.get_mut(&endpoint.path) {
            Some(acc) => acc.absorb(&endpoint),
            None => {
                map.insert(
                    endpoint.path.clone(),
                    MergedEndpoint::from_endpoint(&endpoint),
                );
            }
        }
    }

    fn into_rows(self) -> Vec<ApiRow> {
        let mut rows = Vec::new();
        for (index, map) in self.maps.into_iter().enumerate() {
            let method = METHODS[index % METHODS.len()];
            for (path, merged) in map {
                rows.push(api_row(method, &path, &merged));
            }
        }
        rows
    }
}

/// One API row from a merged endpoint.
fn api_row(method: &'static str, path: &[u8], merged: &MergedEndpoint) -> ApiRow {
    let [p50_ms, p90_ms, p95_ms, p99_ms] = merged.sketch.quantiles4_ms();
    let avg = if merged.count > 0 {
        merged.sum / merged.count as f64
    } else {
        0.0
    };
    ApiRow {
        method,
        path: String::from_utf8_lossy(path).into_owned(),
        count: merged.count,
        avg_ms: round2(avg),
        p50_ms: round2(p50_ms as f64) as f32,
        p90_ms: round2(p90_ms as f64) as f32,
        p95_ms: round2(p95_ms as f64) as f32,
        p99_ms: round2(p99_ms as f64) as f32,
        max_ms: round2(if merged.count > 0 { merged.max } else { 0.0 } as f64) as f32,
        min_ms: round2(if merged.count > 0 { merged.min } else { 0.0 } as f64) as f32,
        error_count: merged.error_count,
    }
}

/// Everything the result needs from the shard engines themselves.
struct ShardDiagnostics {
    total_unmatched: u32,
    methods_mask: u8,
    hourly: Vec<HourlyBucket>,
    daily: Vec<DaySummary>,
    dates: Vec<[u8; 10]>,
    cron: Vec<CronRow>,
    cron_summary: CronSummary,
    unmatched_sample: Vec<String>,
}

/// Roll the shard columns up into the hourly, daily, cron, and diagnostic sections.
fn collect_shard_diagnostics(
    shards: &[Pm2Engine],
    date_filter: &str,
    options: &Pm2ParseOptions,
) -> ShardDiagnostics {
    let hourly = merge_hourly(shards);
    let daily = merge_daily(shards);
    let hourly_stats = finalize_hourly(&hourly);
    let daily_stats: Vec<DaySummary> = daily.iter().map(finalize_day).collect();
    let active_hourly = if date_filter.is_empty() {
        hourly_stats
    } else {
        daily_stats
            .iter()
            .find(|day| day.date == date_filter)
            .map(|day| day.hourly_stats.clone())
            .unwrap_or(hourly_stats)
    };

    let cron_events = collect_cron_events(shards);
    let cron = aggregate_cron(&cron_events, options);
    let cron_summary = build_cron_summary(&cron_events, date_filter, &cron);

    ShardDiagnostics {
        total_unmatched: shards.iter().map(|shard| shard.unmatched_count()).sum(),
        methods_mask: shards
            .iter()
            .fold(0u8, |mask, shard| mask | shard.methods_mask()),
        hourly: active_hourly,
        daily: daily_stats,
        dates: collect_dates(shards),
        cron,
        cron_summary,
        unmatched_sample: collect_unmatched_samples(shards),
    }
}

/// The 24 hour-of-day buckets, merged across shards.
fn merge_hourly(shards: &[Pm2Engine]) -> [HourlyAcc; 24] {
    let mut hourly: [HourlyAcc; 24] = std::array::from_fn(|_| HourlyAcc::new());
    for shard in shards {
        for (index, bucket) in shard.inner().hourly_accs().iter().enumerate() {
            hourly[index].merge(bucket);
        }
    }
    hourly
}

/// The per-day rollups, merged and sorted by date.
fn merge_daily(shards: &[Pm2Engine]) -> Vec<DailyAcc> {
    let mut daily_map: HashMap<[u8; 10], DailyAcc> = HashMap::with_capacity(32);
    for shard in shards {
        for acc in shard.inner().daily_accs() {
            match daily_map.entry(acc.date) {
                Entry::Vacant(slot) => {
                    slot.insert(acc.clone());
                }
                Entry::Occupied(mut slot) => {
                    slot.get_mut().merge(acc);
                }
            }
        }
    }
    let mut daily: Vec<DailyAcc> = daily_map.into_values().collect();
    daily.sort_unstable_by_key(|acc| acc.date);
    daily
}

/// Every distinct date any shard saw, sorted.
fn collect_dates(shards: &[Pm2Engine]) -> Vec<[u8; 10]> {
    let mut dates: HashSet<[u8; 10]> = HashSet::with_capacity(32);
    for shard in shards {
        for &date in shard.inner().dates() {
            dates.insert(date);
        }
    }
    let mut dates: Vec<[u8; 10]> = dates.into_iter().collect();
    dates.sort_unstable();
    dates
}

/// Every cron event, concatenated in shard order.
fn collect_cron_events(shards: &[Pm2Engine]) -> Vec<CronEv> {
    let mut events: Vec<CronEv> = Vec::new();
    for shard in shards {
        events.extend_from_slice(shard.inner().cron_events());
    }
    events
}

/// Up to [`UNMATCHED_SAMPLE_CAP`] unmatched lines, in shard order.
fn collect_unmatched_samples(shards: &[Pm2Engine]) -> Vec<String> {
    let mut samples: Vec<String> = Vec::new();
    'outer: for shard in shards {
        for sample in shard.inner().unmatched_sample() {
            if samples.len() >= UNMATCHED_SAMPLE_CAP {
                break 'outer;
            }
            samples.push(String::from_utf8_lossy(sample).into_owned());
        }
    }
    samples
}

/// Two decimals: the UI renders integer milliseconds (`formatMs`), so extra
/// digits only cost IPC bytes (they were ~2.3MB of the methaq payload).
fn round2(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}


fn methods_from_mask(mask: u8) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = METHODS
        .iter()
        .enumerate()
        .filter(|(i, _)| mask & (1u8 << i) != 0)
        .map(|(_, m)| *m)
        .collect();
    out.sort_unstable();
    out
}

fn finalize_bucket(hour: u8, acc: &HourlyAcc) -> HourlyBucket {
    let [_, _, p95, p99] = acc.sketch.quantiles4_ms();
    HourlyBucket {
        hour,
        label: format!("{hour:02}:00"),
        count: acc.count,
        error_count: acc.error_count,
        avg_ms: if acc.count > 0 {
            (acc.sum / acc.count as f64).round() as i64
        } else {
            0
        },
        p95_ms: p95.round() as i64,
        p99_ms: p99.round() as i64,
        max_ms: acc.max.round() as i64,
    }
}

fn finalize_hourly(buckets: &[HourlyAcc; 24]) -> Vec<HourlyBucket> {
    buckets
        .iter()
        .enumerate()
        .map(|(index, acc)| finalize_bucket(index as u8, acc))
        .collect()
}

fn finalize_day(day: &DailyAcc) -> DaySummary {
    let [_, _, p95, p99] = day.sketch.quantiles4_ms();
    DaySummary {
        date: String::from_utf8_lossy(&day.date).into_owned(),
        count: day.count,
        error_count: day.error_count,
        avg_ms: if day.count > 0 {
            (day.sum / day.count as f64).round() as i64
        } else {
            0
        },
        p95_ms: p95.round() as i64,
        p99_ms: p99.round() as i64,
        max_ms: day.max.round() as i64,
        slow_count: day.slow_count,
        hourly_stats: finalize_hourly(&day.hourly),
    }
}

#[cfg(test)]
mod tests {
    use crate::cron::{days_from_civil, parse_ts_seconds, percentile};

    #[test]
    fn ts_and_civil_math() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 7, 24), 20658);
        assert_eq!(
            parse_ts_seconds(b"2026-07-24T00:00:10"),
            Some(20658 * 86_400 + 10),
        );
        assert_eq!(
            parse_ts_seconds(b"2026-07-24 00:01:10"),
            Some(20658 * 86_400 + 70),
        );
        assert_eq!(parse_ts_seconds(b"nope"), None);
    }

    #[test]
    fn nearest_rank_percentile() {
        let values = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile(&values, 50.0), 3.0);
        assert_eq!(percentile(&values, 95.0), 5.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }
}
