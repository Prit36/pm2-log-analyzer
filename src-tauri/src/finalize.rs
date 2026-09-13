//! Native PM2 finalization: shard engines -> ready-to-render `AggregatedResult` JSON.
//!
//! Everything the UI needs (api rows with percentiles, summary, hourly/daily buckets,
//! cron aggregation, dates, unmatched sample) is computed here. JS only parses this
//! JSON and hands it to the store.

use hashbrown::hash_map::Entry;
use hashbrown::{HashMap, HashSet};

use pm2_core::{CronEv, DailyAcc, HourlyAcc, Pm2Engine};
use rayon::prelude::*;

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
struct CronRow {
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
struct CronSummary {
    starts: u32,
    dones: u32,
    fails: u32,
    jobs: usize,
    slowest_run: f64,
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

const NUM_MERGE_BUCKETS: usize = 16;

struct MergedEndpoint {
    count: u32,
    sum: f64,
    min: f32,
    max: f32,
    error_count: u32,
    sketch: Box<pm2_core::RelHist>,
}


/// Finalize the stored shard engines into the exact `AggregatedResult` JSON the UI renders.
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

    let mut total_matched = 0u32;
    let mut total_unmatched = 0u32;
    let mut sum_sum = 0.0f64;
    let mut sum_max = 0.0f32;
    let mut sum_errors = 0u32;
    let mut sum_slow = 0u32;
    let mut combined_summary_sketch = pm2_core::RelHist::new();
    let mut has_summary = false;

    // Partition endpoints by hash into 16 buckets in a single linear pass with ZERO clones
    let mut partitioned: [Vec<pm2_core::DecodedEndpoint>; NUM_MERGE_BUCKETS] =
        std::array::from_fn(|_| Vec::with_capacity(2048));

    for p in partials {
        total_matched += p.matched;
        total_unmatched += p.unmatched;
        if let Some(s) = &p.summary {
            has_summary = true;
            sum_sum += s.sum;
            if s.max > sum_max {
                sum_max = s.max;
            }
            sum_errors += s.errors;
            sum_slow += s.slow;
            combined_summary_sketch.merge(&s.sketch);
        }
        for ep in p.endpoints {
            let b = (ep.hash as usize) & (NUM_MERGE_BUCKETS - 1);
            partitioned[b].push(ep);
        }
    }

    let summary = if has_summary {
        LogSummary {
            matched: total_matched,
            unmatched: total_unmatched,
            max: sum_max,
            avg: if total_matched > 0 {
                sum_sum / total_matched as f64
            } else {
                0.0
            },
            p95_ms: combined_summary_sketch.quantile_ms(0.95),
            errors: sum_errors,
            slow: sum_slow,
        }
    } else {
        LogSummary {
            matched: total_matched,
            unmatched: total_unmatched,
            max: 0.0,
            avg: 0.0,
            p95_ms: 0.0,
            errors: 0,
            slow: 0,
        }
    };

    let (
        api,
        (
            _total_unmatched_shards,
            methods_mask,
            active_hourly,
            daily_stats,
            dates,
            cron,
            cron_summary,
            unmatched_sample,
        ),
    ) = rayon::join(
        || {
            let api_buckets: Vec<Vec<ApiRow>> = partitioned
                .into_par_iter()
                .map(|bucket_endpoints| {
                    let mut maps: [hashbrown::HashMap<Vec<u8>, MergedEndpoint>; 6] = [
                        hashbrown::HashMap::with_capacity(256),
                        hashbrown::HashMap::with_capacity(64),
                        hashbrown::HashMap::with_capacity(32),
                        hashbrown::HashMap::with_capacity(16),
                        hashbrown::HashMap::with_capacity(16),
                        hashbrown::HashMap::with_capacity(16),
                    ];

                    for ep in bucket_endpoints {
                        let m = (ep.method as usize).min(5);
                        let map = &mut maps[m];
                        if let Some(acc) = map.get_mut(&ep.path) {
                            acc.count += ep.count;
                            acc.sum += ep.sum;
                            if ep.count > 0 && (acc.count == ep.count || ep.min < acc.min) {
                                acc.min = ep.min;
                            }
                            if ep.max > acc.max {
                                acc.max = ep.max;
                            }
                            acc.error_count += ep.error_count;
                            acc.sketch.merge(&ep.sketch);
                        } else {
                            map.insert(
                                ep.path,
                                MergedEndpoint {
                                    count: ep.count,
                                    sum: ep.sum,
                                    min: ep.min,
                                    max: ep.max,
                                    error_count: ep.error_count,
                                    sketch: ep.sketch,
                                },
                            );
                        }
                    }

                    let mut out = Vec::new();
                    for (m, map) in maps.into_iter().enumerate() {
                        let method = METHODS[m % METHODS.len()];
                        for (path, me) in map {
                            let path_str = String::from_utf8_lossy(&path).into_owned();
                            let [p50_ms, p90_ms, p95_ms, p99_ms] = me.sketch.quantiles4_ms();
                            out.push(ApiRow {
                                method,
                                path: path_str,
                                count: me.count,
                                avg_ms: round2(if me.count > 0 {
                                    me.sum / me.count as f64
                                } else {
                                    0.0
                                }),
                                p50_ms: round2(p50_ms as f64) as f32,
                                p90_ms: round2(p90_ms as f64) as f32,
                                p95_ms: round2(p95_ms as f64) as f32,
                                p99_ms: round2(p99_ms as f64) as f32,
                                max_ms: round2(if me.count > 0 { me.max } else { 0.0 } as f64) as f32,
                                min_ms: round2(if me.count > 0 { me.min } else { 0.0 } as f64) as f32,
                                error_count: me.error_count,
                            });
                        }
                    }
                    out
                })
                .collect();

            let total_unique: usize = api_buckets.iter().map(|b| b.len()).sum();
            let mut api = Vec::with_capacity(total_unique);
            for b in api_buckets {
                api.extend(b);
            }
            api
        },
        || {
            let total_unmatched: u32 = shards.iter().map(|s| s.unmatched_count()).sum();
            let methods_mask: u8 = shards.iter().fold(0u8, |acc, s| acc | s.methods_mask());

            let mut hourly: [HourlyAcc; 24] = std::array::from_fn(|_| HourlyAcc::new());
            for s in shards.iter() {
                for (i, h) in s.inner().hourly_accs().iter().enumerate() {
                    hourly[i].merge(h);
                }
            }

            let mut daily_map: HashMap<[u8; 10], DailyAcc> = HashMap::with_capacity(32);
            for s in shards.iter() {
                for da in s.inner().daily_accs() {
                    match daily_map.entry(da.date) {
                        Entry::Vacant(e) => {
                            e.insert(da.clone());
                        }
                        Entry::Occupied(mut e) => {
                            e.get_mut().merge(da);
                        }
                    }
                }
            }
            let mut daily: Vec<DailyAcc> = daily_map.into_values().collect();
            daily.sort_unstable_by_key(|a| a.date);

            let mut dates_set: HashSet<[u8; 10]> = HashSet::with_capacity(32);
            for s in shards.iter() {
                for &d in s.inner().dates() {
                    dates_set.insert(d);
                }
            }
            let mut dates: Vec<[u8; 10]> = dates_set.into_iter().collect();
            dates.sort_unstable();

            let mut cron_events: Vec<CronEv> = Vec::new();
            for s in shards.iter() {
                cron_events.extend_from_slice(s.inner().cron_events());
            }

            let mut unmatched_sample: Vec<String> = Vec::new();
            'sample: for s in shards.iter() {
                for sample in s.inner().unmatched_sample() {
                    if unmatched_sample.len() >= UNMATCHED_SAMPLE_CAP {
                        break 'sample;
                    }
                    unmatched_sample.push(String::from_utf8_lossy(sample).into_owned());
                }
            }

            let hourly_stats = finalize_hourly(&hourly);
            let daily_stats: Vec<DaySummary> = daily.iter().map(finalize_day).collect();
            let active_hourly = if date_filter.is_empty() {
                hourly_stats
            } else {
                daily_stats
                    .iter()
                    .find(|d| d.date == date_filter)
                    .map(|d| d.hourly_stats.clone())
                    .unwrap_or(hourly_stats)
            };

            let cron = aggregate_cron(&cron_events, options);
            let cron_summary = build_cron_summary(&cron_events, &date_filter, &cron);

            (
                total_unmatched,
                methods_mask,
                active_hourly,
                daily_stats,
                dates,
                cron,
                cron_summary,
                unmatched_sample,
            )
        },
    );

    let result = AggregatedResult {
        api,
        cron,
        summary,
        cron_summary,
        hourly_stats: active_hourly,
        methods: methods_from_mask(methods_mask),
        unmatched_sample,
        unmatched_count: total_unmatched,
        dates: dates
            .iter()
            .map(|d| String::from_utf8_lossy(d).into_owned())
            .collect(),
        daily_stats,
    };

    serde_json::to_string(&result).map_err(|e| format!("failed to serialize PM2 result: {e}"))
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

fn finalize_bucket(hour: u8, b: &HourlyAcc) -> HourlyBucket {
    let [_, _, p95, p99] = b.sketch.quantiles4_ms();
    HourlyBucket {
        hour,
        label: format!("{hour:02}:00"),
        count: b.count,
        error_count: b.error_count,
        avg_ms: if b.count > 0 {
            (b.sum / b.count as f64).round() as i64
        } else {
            0
        },
        p95_ms: p95.round() as i64,
        p99_ms: p99.round() as i64,
        max_ms: b.max.round() as i64,
    }
}

fn finalize_hourly(buckets: &[HourlyAcc; 24]) -> Vec<HourlyBucket> {
    buckets
        .iter()
        .enumerate()
        .map(|(i, b)| finalize_bucket(i as u8, b))
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

struct CronBucket {
    name: String,
    starts: u32,
    durations: Vec<f64>,
    fails: u32,
    last_run_ts: Option<String>,
    last_duration_ms: Option<f64>,
}

fn aggregate_cron(events: &[CronEv], options: &Pm2ParseOptions) -> Vec<CronRow> {
    let query = options
        .cron_query
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let min_ms = options.cron_min_ms.unwrap_or(0.0);
    let show_failed_only = options.cron_show_failed_only.unwrap_or(false);
    let date_filter = options.date_filter.as_deref().unwrap_or("");

    let mut buckets: HashMap<Vec<u8>, CronBucket> = HashMap::new();
    let mut start_map: HashMap<Vec<u8>, Option<Vec<u8>>> = HashMap::new();

    for ev in events {
        if !date_filter.is_empty() {
            if let Some(ts) = &ev.ts {
                if !ts.starts_with(date_filter.as_bytes()) {
                    continue;
                }
            }
        }
        if !query.is_empty()
            && !String::from_utf8_lossy(&ev.name)
                .to_ascii_lowercase()
                .contains(&query)
        {
            continue;
        }

        let bucket = buckets
            .entry(ev.name.clone())
            .or_insert_with(|| CronBucket {
                name: String::from_utf8_lossy(&ev.name).into_owned(),
                starts: 0,
                durations: Vec::new(),
                fails: 0,
                last_run_ts: None,
                last_duration_ms: None,
            });

        if ev.event == 0 {
            bucket.starts += 1;
            start_map.insert(ev.name.clone(), ev.ts.clone());
            continue;
        }

        let duration = resolve_cron_duration(ev, &start_map, min_ms);
        start_map.remove(&ev.name);
        if let Some(d) = duration {
            bucket.durations.push(d);
            bucket.last_duration_ms = Some(d);
            if let Some(ts) = &ev.ts {
                bucket.last_run_ts = Some(String::from_utf8_lossy(ts).into_owned());
            }
        }
        if ev.event == 2 {
            bucket.fails += 1;
        }
    }

    buckets
        .into_values()
        .filter(|b| !show_failed_only || b.fails > 0)
        .map(|b| {
            let mut sorted = b.durations;
            sorted.sort_unstable_by(f64::total_cmp);
            let runs = sorted.len();
            let sum: f64 = sorted.iter().sum();
            CronRow {
                name: b.name,
                runs,
                starts: b.starts,
                fails: b.fails,
                avg_ms: if runs > 0 { sum / runs as f64 } else { 0.0 },
                p50_ms: percentile(&sorted, 50.0),
                p90_ms: percentile(&sorted, 90.0),
                p95_ms: percentile(&sorted, 95.0),
                p99_ms: percentile(&sorted, 99.0),
                min_ms: sorted.first().copied().unwrap_or(0.0),
                max_ms: sorted.last().copied().unwrap_or(0.0),
                last_run_ts: b.last_run_ts,
                last_duration_ms: b.last_duration_ms,
            }
        })
        .collect()
}

/// Nearest-rank percentile on an ascending array (parity with `src/parser/percentiles.ts`).
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = (((p / 100.0) * sorted.len() as f64).ceil() as usize)
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
fn parse_ts_seconds(ts: &[u8]) -> Option<i64> {
    if ts.len() < 19 {
        return None;
    }
    let num = |i: usize, n: usize| -> Option<i64> {
        let mut v: i64 = 0;
        for k in 0..n {
            let c = *ts.get(i + k)?;
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        Some(v)
    };
    let y = num(0, 4)?;
    let mo = num(5, 2)?;
    let d = num(8, 2)?;
    let h = num(11, 2)?;
    let mi = num(14, 2)?;
    let s = num(17, 2)?;
    Some(days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + s)
}

/// Days since 1970-01-01 (Howard Hinnant's civil algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn build_cron_summary(events: &[CronEv], date_filter: &str, rows: &[CronRow]) -> CronSummary {
    let mut starts = 0u32;
    let mut dones = 0u32;
    let mut fails = 0u32;
    for e in events {
        if !date_filter.is_empty() {
            if let Some(ts) = &e.ts {
                if !ts.starts_with(date_filter.as_bytes()) {
                    continue;
                }
            }
        }
        match e.event {
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
        slowest_run: rows.iter().fold(0.0f64, |m, r| m.max(r.max_ms)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_and_civil_math() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 7, 24), 20658);
        assert_eq!(
            parse_ts_seconds(b"2026-07-24T00:00:10"),
            Some(20658 * 86_400 + 10)
        );
        assert_eq!(
            parse_ts_seconds(b"2026-07-24 00:01:10"),
            Some(20658 * 86_400 + 70)
        );
        assert_eq!(parse_ts_seconds(b"nope"), None);
    }

    #[test]
    fn nearest_rank_percentile() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(percentile(&v, 50.0), 3.0);
        assert_eq!(percentile(&v, 95.0), 5.0);
        assert_eq!(percentile(&[], 50.0), 0.0);
    }
}
