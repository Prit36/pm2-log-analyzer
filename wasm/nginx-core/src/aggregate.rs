use std::cmp::Ordering;
use std::hash::{BuildHasherDefault, Hasher};

use hashbrown::{HashMap, HashSet};
use pm2_core::{NormalizeMode, normalize_into};
use serde::{Deserialize, Serialize};

use crate::{Chunk, Engine, HourSlot, Intern, LARGE_BYTES, Normalized, Timing};

#[derive(Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Filters {
    pub normalize_mode: String,
    pub status_family: String,
    /// Exact HTTP status; 0 matches every status.
    pub status_code: u16,
    pub min_ms: f64,
    pub methods: Vec<String>,
    pub query: String,
    pub date_filter: String,
    pub metric: String,
    pub sort_key: String,
    pub sort_dir: String,
    pub top_n: usize,
}

impl Default for Filters {
    fn default() -> Self {
        Self {
            normalize_mode: "collapseIds".into(),
            status_family: "all".into(),
            status_code: 0,
            min_ms: 0.0,
            methods: Vec::new(),
            query: String::new(),
            date_filter: "all".into(),
            metric: "request".into(),
            sort_key: "count".into(),
            sort_dir: "desc".into(),
            top_n: 50,
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub total_lines: u64,
    pub matched_lines: u64,
    pub unmatched_count: u64,
    pub invalid_timing_count: u64,
    pub unmatched_sample: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    pub count: u64,
    pub avg_ms: Option<f64>,
    pub min_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p90_ms: Option<f64>,
    pub p95_ms: Option<f64>,
    pub p99_ms: Option<f64>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub count: u64,
    pub error_count: u64,
    pub body_bytes: u64,
    pub unique_clients: usize,
    pub request_time: Latency,
    pub upstream_time: Latency,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub method: String,
    pub path: String,
    pub count: u64,
    pub error_count: u64,
    pub body_bytes: u64,
    pub request_time: Latency,
    pub upstream_time: Latency,
}

/// Exact endpoint ranking for the overview, independent of the table sort and Top N.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hotspot {
    pub method: String,
    pub path: String,
    pub count: u64,
    pub error_count: u64,
    pub timed_count: u64,
    pub avg_ms: Option<f64>,
    pub p95_ms: Option<f64>,
}

/// Endpoints need this many timed requests before their p95 is ranked as slowest.
const HOTSPOT_MIN_TIMED: u64 = 1;
const HOTSPOT_LIMIT: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeBucket {
    pub label: String,
    pub count: u64,
    pub error_count: u64,
    pub body_bytes: u64,
    pub request_time: Latency,
    pub upstream_time: Latency,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Breakdown {
    pub value: String,
    pub count: u64,
    pub error_count: u64,
    pub body_bytes: u64,
}

#[derive(Serialize)]
pub struct StatusCount {
    pub status: u16,
    pub count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub summary: Summary,
    pub endpoints: Vec<Endpoint>,
    pub endpoint_count: usize,
    pub slowest_endpoints: Vec<Hotspot>,
    pub failing_endpoints: Vec<Hotspot>,
    pub hourly_stats: Vec<TimeBucket>,
    pub daily_stats: Vec<TimeBucket>,
    pub clients: Vec<Breakdown>,
    pub referrers: Vec<Breakdown>,
    pub user_agents: Vec<Breakdown>,
    pub client_count: usize,
    pub referrer_count: usize,
    pub user_agent_count: usize,
    pub status_counts: Vec<StatusCount>,
    pub dates: Vec<String>,
    pub methods: Vec<String>,
    pub diagnostics: Diagnostics,
}

/// Hashes a histogram bucket key with one 64-bit multiply. The default hasher's
/// 128-bit folded multiply is a `__multi3` call on Wasm.
#[derive(Default)]
pub(crate) struct KeyHasher(u64);

impl Hasher for KeyHasher {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            self.write_u8(byte);
        }
    }
    fn write_u8(&mut self, value: u8) {
        self.write_u16(u16::from(value));
    }
    fn write_u16(&mut self, value: u16) {
        // The multiply moves key bits into the top byte hashbrown uses for matching.
        self.0 = (self.0 ^ u64::from(value)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    }
    fn write_i16(&mut self, value: i16) {
        self.write_u16(value as u16);
    }
}

type KeyMap = HashMap<i16, u64, BuildHasherDefault<KeyHasher>>;

/// Most endpoint groups have only one observed bucket; they allocate no hash map.
/// Busy histograms switch to a dense key range, which every row of the summary and
/// time buckets reaches without hashing.
#[derive(Default)]
pub(crate) enum Histogram {
    #[default]
    Empty,
    Single(i16, u64),
    Multiple(KeyMap),
    Dense(Box<Dense>),
}

/// The bucket compact timing keys use for an exact 0 ms.
const ZERO_KEY: i16 = i16::MIN + 1;
/// Distinct keys before a map becomes dense.
const DENSE_AFTER: usize = 32;
/// The dense range spans at most this many slots per populated key, so it never
/// outgrows the map it replaces by more than a constant factor.
const DENSE_SPREAD: usize = 8;
/// Extra slots added on the side a range grows, so neighbouring keys do not reallocate.
const DENSE_PAD: usize = 16;

pub(crate) struct Dense {
    low: i32,
    counts: Vec<u64>,
    populated: usize,
    /// Keys the range cannot cover within its budget (for example exact zeros).
    rest: KeyMap,
}

impl Dense {
    /// Covers every key but the exact-zero bucket, if that range is dense enough.
    fn from_map(map: &mut KeyMap) -> Option<Self> {
        let keys = map.keys().copied().filter(|&key| key != ZERO_KEY);
        let low = i32::from(keys.clone().min()?);
        let high = i32::from(keys.max()?);
        if (high - low + 1) as usize > DENSE_SPREAD * map.len() {
            return None;
        }
        let mut dense = Self {
            low,
            counts: vec![0; (high - low + 1) as usize],
            populated: 0,
            rest: KeyMap::default(),
        };
        for (key, count) in map.drain() {
            dense.add(key, count);
        }
        Some(dense)
    }

    fn add(&mut self, key: i16, count: u64) {
        let wide = i32::from(key);
        let offset = wide - self.low;
        if offset >= 0 && (offset as usize) < self.counts.len() {
            let slot = &mut self.counts[offset as usize];
            self.populated += usize::from(*slot == 0);
            *slot += count;
            return;
        }
        let budget = DENSE_SPREAD * (self.populated + 1);
        let high = self.low + self.counts.len() as i32 - 1;
        let (mut low, mut new_high) = (self.low.min(wide), high.max(wide));
        if (new_high - low + 1) as usize > budget {
            *self.rest.entry(key).or_default() += count;
            return;
        }
        let pad = DENSE_PAD.min(budget - (new_high - low + 1) as usize) as i32;
        if wide < self.low {
            low = (low - pad).max(i32::from(i16::MIN));
        } else {
            new_high = (new_high + pad).min(i32::from(i16::MAX));
        }
        let mut counts = vec![0; (new_high - low + 1) as usize];
        let shift = (self.low - low) as usize;
        counts[shift..shift + self.counts.len()].copy_from_slice(&self.counts);
        counts[(wide - low) as usize] = count;
        self.counts = counts;
        self.low = low;
        self.populated += 1;
    }
}

impl Histogram {
    pub(crate) fn add(&mut self, key: i16, count: u64) {
        match self {
            Self::Empty => *self = Self::Single(key, count),
            Self::Single(old_key, old_count) if *old_key == key => *old_count += count,
            Self::Single(old_key, old_count) => {
                let mut map = KeyMap::with_capacity_and_hasher(2, Default::default());
                map.insert(*old_key, *old_count);
                map.insert(key, count);
                *self = Self::Multiple(map);
            }
            Self::Multiple(map) => {
                *map.entry(key).or_default() += count;
                // Retry at each power of two while the keys are too sparse for a range.
                if map.len() >= DENSE_AFTER
                    && map.len().is_power_of_two()
                    && let Some(dense) = Dense::from_map(map)
                {
                    *self = Self::Dense(Box::new(dense));
                }
            }
            Self::Dense(dense) => dense.add(key, count),
        }
    }

    pub(crate) fn buckets(&self) -> Vec<(i16, u64)> {
        match self {
            Self::Empty => Vec::new(),
            Self::Single(key, count) => vec![(*key, *count)],
            Self::Multiple(map) => map.iter().map(|(&key, &count)| (key, count)).collect(),
            Self::Dense(dense) => (dense.low..)
                .zip(&dense.counts)
                .filter(|&(_, &count)| count > 0)
                .map(|(key, &count)| (key as i16, count))
                .chain(dense.rest.iter().map(|(&key, &count)| (key, count)))
                .collect(),
        }
    }

    fn merge(&mut self, other: Self) {
        for (key, count) in other.buckets() {
            self.add(key, count);
        }
    }
}

#[derive(Default)]
pub(crate) struct TimingAcc {
    pub(crate) count: u64,
    pub(crate) sum: f64,
    pub(crate) min: f32,
    pub(crate) max: f32,
    pub(crate) hist: Histogram,
}

impl TimingAcc {
    fn add(&mut self, value: f32, key: i16) {
        if key == i16::MIN {
            return;
        }
        if self.count == 0 {
            self.min = value;
            self.max = value;
        } else {
            self.min = self.min.min(value);
            self.max = self.max.max(value);
        }
        self.count += 1;
        self.sum += f64::from(value);
        self.hist.add(key, 1);
    }

    fn merge(&mut self, other: Self) {
        if other.count == 0 {
            return;
        }
        if self.count == 0 {
            *self = other;
            return;
        }
        self.count += other.count;
        self.sum += other.sum;
        self.min = self.min.min(other.min);
        self.max = self.max.max(other.max);
        self.hist.merge(other.hist);
    }

    fn quantiles(&self) -> [f64; 4] {
        let mut buckets = self.hist.buckets();
        buckets.sort_unstable_by_key(|entry| entry.0);
        // Nearest-rank quantiles include valid zeros in the sample count. A pair
        // [0, 845] therefore reports p95/p99 near 845, rather than flooring to zero.
        let targets = [0.5, 0.9, 0.95, 0.99].map(|q| (q * self.count as f64).ceil() - 1.0);
        let mut quantiles = [f64::from(self.max); 4];
        let mut rank = 0u64;
        let mut next = 0;
        for (key, count) in buckets {
            let value = if key == i16::MIN + 1 {
                0.0
            } else {
                bucket_value(key).clamp(f64::from(self.min), f64::from(self.max))
            };
            rank += count;
            while next < targets.len() && rank as f64 > targets[next] {
                quantiles[next] = value;
                next += 1;
            }
        }
        quantiles
    }

    fn sort_value(&self, key: &str) -> Option<f64> {
        if self.count == 0 {
            return None;
        }
        match key {
            "avgMs" => Some(round(self.sum / self.count as f64)),
            "maxMs" => Some(round(f64::from(self.max))),
            "p95Ms" => Some(round(self.quantiles()[2])),
            "p99Ms" => Some(round(self.quantiles()[3])),
            _ => None,
        }
    }

    fn finish(self) -> Latency {
        if self.count == 0 {
            return Latency::default();
        }
        let quantiles = self.quantiles();
        Latency {
            count: self.count,
            avg_ms: Some(round(self.sum / self.count as f64)),
            min_ms: Some(round(f64::from(self.min))),
            max_ms: Some(round(f64::from(self.max))),
            p50_ms: Some(round(quantiles[0])),
            p90_ms: Some(round(quantiles[1])),
            p95_ms: Some(round(quantiles[2])),
            p99_ms: Some(round(quantiles[3])),
        }
    }
}

fn round(value: f64) -> f64 {
    (value * 100.0).round() / 100.0
}

fn bucket_value(key: i16) -> f64 {
    static VALUES: std::sync::OnceLock<[f64; 512]> = std::sync::OnceLock::new();
    if (0..512).contains(&key) {
        VALUES.get_or_init(|| std::array::from_fn(|k| (1.01f64 / 0.99).powf(k as f64 - 0.5)))
            [key as usize]
    } else {
        (1.01f64 / 0.99).powf(f64::from(key) - 0.5)
    }
}

#[derive(Default)]
pub(crate) struct Counts {
    pub(crate) count: u64,
    pub(crate) errors: u64,
    pub(crate) bytes: u64,
}

impl Counts {
    fn add(&mut self, status: u16, bytes: u64) {
        self.count += 1;
        self.errors += u64::from(status >= 400);
        self.bytes += bytes;
    }
    fn merge(&mut self, other: Self) {
        self.add_counts(&other);
    }
    fn add_counts(&mut self, other: &Self) {
        self.count += other.count;
        self.errors += other.errors;
        self.bytes += other.bytes;
    }
}

#[derive(Default)]
pub(crate) struct Metrics {
    pub(crate) counts: Counts,
    pub(crate) request: TimingAcc,
    pub(crate) upstream: TimingAcc,
}

impl Metrics {
    fn add(&mut self, status: u16, bytes: u64, timing: Option<&Timing>) {
        self.counts.add(status, bytes);
        if let Some(timing) = timing {
            self.request.add(timing.request_ms, timing.request_key);
            self.upstream.add(timing.upstream_ms, timing.upstream_key);
        }
    }
    fn merge(&mut self, other: Self) {
        self.counts.merge(other.counts);
        self.request.merge(other.request);
        self.upstream.merge(other.upstream);
    }
}

#[derive(Default)]
pub struct Partial {
    pub(crate) summary: Metrics,
    pub(crate) endpoints: HashMap<(String, String), Metrics>,
    pub(crate) hourly: HashMap<String, Metrics>,
    pub(crate) daily: HashMap<String, Metrics>,
    pub(crate) clients: HashMap<String, Counts>,
    pub(crate) referrers: HashMap<String, Counts>,
    pub(crate) agents: HashMap<String, Counts>,
    pub(crate) statuses: HashMap<u16, u64>,
    pub(crate) dates: HashSet<String>,
    pub(crate) methods: HashSet<String>,
    pub(crate) diagnostics: Diagnostics,
}

/// Splits a canonical `METHOD path` endpoint key at the space after the method.
fn split_endpoint(endpoint: &str) -> (&str, &str) {
    endpoint.split_once(' ').unwrap_or((endpoint, ""))
}

/// Dense per-id counts become the shard's string-keyed map. Distinct raw values can
/// share one canonical text, so entries merge rather than overwrite.
fn counts_map(intern: &Intern, counts: Vec<Counts>) -> HashMap<String, Counts> {
    let mut map = HashMap::new();
    for (id, counts) in counts.into_iter().enumerate() {
        if counts.count > 0 {
            map.entry(intern.text(id as u32).into_owned())
                .or_insert_with(Counts::default)
                .merge(counts);
        }
    }
    map
}

fn dense<T: Default>(len: usize) -> Vec<T> {
    let mut values = Vec::with_capacity(len);
    values.resize_with(len, T::default);
    values
}

const PATH_OK: u8 = 1;
const METHOD_OK: u8 = 2;

/// Row selection resolved once per aggregate into per-id tables.
struct RowFilter<'a> {
    group_ids: Option<&'a [u32]>,
    group_flags: Option<Vec<u8>>,
    /// (text query matches, exact client queries match) per visitor.
    visitor_allowed: Option<Vec<(bool, bool)>>,
    time_allowed: Option<Vec<bool>>,
    family: u16,
    status_code: u16,
    min_ms: f64,
    upstream: bool,
}

/// Dense accumulators indexed by engine ids.
struct Totals {
    summary: Metrics,
    endpoints: Vec<Metrics>,
    hourly: Vec<Metrics>,
    daily: Vec<Metrics>,
    visitors: Vec<Counts>,
    // Parsed statuses are always 100..=599.
    statuses: [u64; 600],
}

impl Totals {
    /// One call per chunk lets the Wasm runtime switch to optimized code between
    /// chunks; a single call over every row stays in the baseline tier throughout.
    #[inline(never)]
    fn add_chunk(
        &mut self,
        chunk: &Chunk,
        first_row: usize,
        filter: &RowFilter,
        times: &[HourSlot],
        large_bytes: &HashMap<usize, u64>,
    ) {
        let mut timings = chunk.timings.iter();
        for (offset, row) in chunk.rows.iter().enumerate() {
            // Advance the sparse timing cursor before any filter skips the row.
            let timing = if row.timed { timings.next() } else { None };
            let group = filter
                .group_ids
                .map_or(row.endpoint, |ids| ids[row.endpoint as usize]);
            let flags = filter
                .group_flags
                .as_ref()
                .map_or(PATH_OK | METHOD_OK, |flags| flags[group as usize]);
            let (client_matches, exact_client_matches) = filter
                .visitor_allowed
                .as_ref()
                .map_or((true, true), |allowed| allowed[row.visitor as usize]);
            let family = filter.family;
            if (flags & PATH_OK == 0 && !client_matches)
                || !exact_client_matches
                || flags & METHOD_OK == 0
                || filter
                    .time_allowed
                    .as_ref()
                    .is_some_and(|allowed| !allowed[row.time as usize])
                || (family == 9 && row.status < 400)
                || (family != 0 && family != 9 && row.status / 100 != family)
                || (filter.status_code != 0 && row.status != filter.status_code)
            {
                continue;
            }
            if filter.min_ms > 0.0 {
                let millis = timing.map_or(f32::NAN, |timing| {
                    if filter.upstream {
                        timing.upstream_ms
                    } else {
                        timing.request_ms
                    }
                });
                if !millis.is_finite() || f64::from(millis) < filter.min_ms {
                    continue;
                }
            }
            let bytes = if row.bytes == LARGE_BYTES {
                large_bytes[&(first_row + offset)]
            } else {
                u64::from(row.bytes)
            };
            let status = row.status;
            self.summary.add(status, bytes, timing);
            self.endpoints[group as usize].add(status, bytes, timing);
            self.hourly[row.time as usize].add(status, bytes, timing);
            self.daily[times[row.time as usize].date as usize].add(status, bytes, timing);
            self.visitors[row.visitor as usize].add(status, bytes);
            self.statuses[status as usize] += 1;
        }
    }
}

impl Engine {
    /// Groups every endpoint not yet seen by `mode`'s cache.
    pub(crate) fn normalize_pending(&mut self, mode: NormalizeMode) {
        let cache = self.normalized[mode as usize - 1].get_or_insert_with(Normalized::default);
        for id in cache.ids.len()..self.endpoints.len() {
            let endpoint = self.endpoints.text(id as u32);
            let (method, path) = split_endpoint(&endpoint);
            cache.key.clear();
            cache.key.extend_from_slice(method.as_bytes());
            cache.key.push(b' ');
            cache
                .key
                .extend_from_slice(normalize_into(path.as_bytes(), mode, &mut cache.scratch));
            cache.ids.push(cache.groups.intern(&cache.key).0);
        }
    }

    pub fn aggregate(&mut self, filters: &Filters) -> Partial {
        let mode = match filters.normalize_mode.as_str() {
            "stripQuery" => NormalizeMode::StripQuery,
            "collapseIds" => NormalizeMode::CollapseIds,
            _ => NormalizeMode::Exact,
        };
        if mode != NormalizeMode::Exact {
            self.normalize_pending(mode);
        }
        let (groups, group_ids) = match (mode, &self.normalized) {
            (NormalizeMode::StripQuery, [Some(cache), _])
            | (NormalizeMode::CollapseIds, [_, Some(cache)]) => {
                (&cache.groups, Some(cache.ids.as_slice()))
            }
            _ => (&self.endpoints, None),
        };
        let query = filters.query.to_lowercase();
        let parts: Vec<&str> = query.split_whitespace().collect();
        let mut client_queries: Vec<&str> = Vec::new();
        let mut text_parts: Vec<&str> = Vec::new();
        for &part in &parts {
            if let Some(ip) = part.strip_prefix("ip:") {
                client_queries.push(ip);
            } else if parts.len() > 1 && part.parse::<std::net::IpAddr>().is_ok() {
                client_queries.push(part);
            } else {
                text_parts.push(part);
            }
        }
        let text_query = text_parts.join(" ");
        // Per-id filter tables are only built when a filter can reject something.
        let group_flags: Option<Vec<u8>> = (!text_query.is_empty() || !filters.methods.is_empty())
            .then(|| {
                (0..groups.len() as u32)
                    .map(|id| {
                        let endpoint = groups.text(id);
                        let (method, path) = split_endpoint(&endpoint);
                        let path_ok =
                            text_query.is_empty() || path.to_lowercase().contains(&text_query);
                        let method_ok = filters.methods.is_empty()
                            || filters.methods.iter().any(|allowed| allowed == method);
                        (u8::from(path_ok) * PATH_OK) | (u8::from(method_ok) * METHOD_OK)
                    })
                    .collect()
            });
        let visitor_allowed: Option<Vec<(bool, bool)>> =
            (!text_query.is_empty() || !client_queries.is_empty()).then(|| {
                let clients: Vec<(bool, bool)> = (0..self.clients.len() as u32)
                    .map(|id| {
                        let client = self.clients.text(id).to_lowercase();
                        (
                            text_query.is_empty() || client.contains(&text_query),
                            client_queries.iter().all(|query| client == *query),
                        )
                    })
                    .collect();
                self.visitor_fields
                    .iter()
                    .map(|fields| clients[fields[0] as usize])
                    .collect()
            });
        let time_allowed: Option<Vec<bool>> =
            (filters.date_filter != "all" && !filters.date_filter.is_empty()).then(|| {
                self.times
                    .iter()
                    .map(|time| filters.date_filter.as_bytes() == self.dates[time.date as usize])
                    .collect()
            });
        let family = match filters.status_family.as_str() {
            "2xx" => 2,
            "3xx" => 3,
            "4xx" => 4,
            "5xx" => 5,
            // 4xx + 5xx, the same responses counted as errors.
            "errors" => 9,
            _ => 0,
        };
        let upstream = filters.metric == "upstream";
        let filter = RowFilter {
            group_ids,
            group_flags,
            visitor_allowed,
            time_allowed,
            family,
            status_code: filters.status_code,
            min_ms: filters.min_ms,
            upstream,
        };
        let mut totals = Totals {
            summary: Metrics::default(),
            endpoints: dense(groups.len()),
            hourly: dense(self.times.len()),
            daily: dense(self.dates.len()),
            visitors: dense(self.visitors.len()),
            statuses: [0; 600],
        };
        let mut first_row = 0;
        for chunk in &self.chunks {
            totals.add_chunk(chunk, first_row, &filter, &self.times, &self.large_bytes);
            first_row += chunk.rows.len();
        }
        let Totals {
            summary,
            endpoints,
            hourly,
            daily,
            visitors,
            statuses,
        } = totals;
        let mut clients: Vec<Counts> = dense(self.clients.len());
        let mut referrers: Vec<Counts> = dense(self.referrers.len());
        let mut agents: Vec<Counts> = dense(self.agents.len());
        for (counts, &[client, referrer, agent]) in visitors.iter().zip(&self.visitor_fields) {
            if counts.count > 0 {
                clients[client as usize].add_counts(counts);
                referrers[referrer as usize].add_counts(counts);
                agents[agent as usize].add_counts(counts);
            }
        }
        let mut endpoint_map = HashMap::new();
        for (id, metrics) in endpoints.into_iter().enumerate() {
            if metrics.counts.count > 0 {
                let endpoint = groups.text(id as u32);
                let (method, path) = split_endpoint(&endpoint);
                endpoint_map
                    .entry((method.to_owned(), path.to_owned()))
                    .or_insert_with(Metrics::default)
                    .merge(metrics);
            }
        }
        // Dates are formatted from validated ASCII digits.
        let date_text =
            |date: u32| String::from_utf8_lossy(&self.dates[date as usize]).into_owned();
        Partial {
            summary,
            endpoints: endpoint_map,
            hourly: hourly
                .into_iter()
                .enumerate()
                .filter(|(_, metrics)| metrics.counts.count > 0)
                .map(|(id, metrics)| {
                    let time = &self.times[id];
                    (
                        format!("{} {:02}:00", date_text(time.date), time.hour),
                        metrics,
                    )
                })
                .collect(),
            daily: daily
                .into_iter()
                .enumerate()
                .filter(|(_, metrics)| metrics.counts.count > 0)
                .map(|(id, metrics)| (date_text(id as u32), metrics))
                .collect(),
            clients: counts_map(&self.clients, clients),
            referrers: counts_map(&self.referrers, referrers),
            agents: counts_map(&self.agents, agents),
            statuses: (0u16..)
                .zip(statuses)
                .filter(|&(_, count)| count > 0)
                .collect(),
            dates: (0..self.dates.len() as u32).map(date_text).collect(),
            methods: (0..self.methods.len() as u32)
                .map(|id| self.methods.text(id).into_owned())
                .collect(),
            diagnostics: self.diagnostics.clone(),
        }
    }
}

impl Partial {
    pub(crate) fn merge(&mut self, other: Self) {
        self.summary.merge(other.summary);
        for (key, value) in other.endpoints {
            self.endpoints.entry(key).or_default().merge(value);
        }
        for (key, value) in other.hourly {
            self.hourly.entry(key).or_default().merge(value);
        }
        for (key, value) in other.daily {
            self.daily.entry(key).or_default().merge(value);
        }
        for (key, value) in other.clients {
            self.clients.entry(key).or_default().merge(value);
        }
        for (key, value) in other.referrers {
            self.referrers.entry(key).or_default().merge(value);
        }
        for (key, value) in other.agents {
            self.agents.entry(key).or_default().merge(value);
        }
        for (status, count) in other.statuses {
            *self.statuses.entry(status).or_default() += count;
        }
        self.dates.extend(other.dates);
        self.methods.extend(other.methods);
        self.diagnostics.total_lines += other.diagnostics.total_lines;
        self.diagnostics.matched_lines += other.diagnostics.matched_lines;
        self.diagnostics.unmatched_count += other.diagnostics.unmatched_count;
        self.diagnostics.invalid_timing_count += other.diagnostics.invalid_timing_count;
        let available = 40usize.saturating_sub(self.diagnostics.unmatched_sample.len());
        self.diagnostics.unmatched_sample.extend(
            other
                .diagnostics
                .unmatched_sample
                .into_iter()
                .take(available),
        );
    }

    pub(crate) fn finish(self, filters: &Filters) -> Report {
        let endpoint_count = self.endpoints.len();
        let client_count = self.clients.len();
        let referrer_count = self.referrers.len();
        let user_agent_count = self.agents.len();
        let mut candidates: Vec<_> = self
            .endpoints
            .into_iter()
            .map(|((method, path), metrics)| {
                let time = if filters.metric == "upstream" {
                    &metrics.upstream
                } else {
                    &metrics.request
                };
                let sort_value = time.sort_value(&filters.sort_key);
                (method, path, metrics, sort_value)
            })
            .collect();
        let compare = |a: &(String, String, Metrics, Option<f64>),
                       b: &(String, String, Metrics, Option<f64>)| {
            let order = match filters.sort_key.as_str() {
                "path" => a.1.cmp(&b.1),
                "errorCount" => a.2.counts.errors.cmp(&b.2.counts.errors),
                "bodyBytes" => a.2.counts.bytes.cmp(&b.2.counts.bytes),
                "avgMs" | "p95Ms" | "p99Ms" | "maxMs" => optional_cmp(a.3, b.3, &filters.sort_dir),
                _ => a.2.counts.count.cmp(&b.2.counts.count),
            };
            let order = if filters.sort_dir == "asc" {
                order
            } else {
                order.reverse()
            };
            order
                .then_with(|| a.1.cmp(&b.1))
                .then_with(|| a.0.cmp(&b.0))
        };
        let upstream = filters.metric == "upstream";
        let timing = |metrics| selected_timing(metrics, upstream);
        let hotspot = |index: usize, p95_ms: Option<f64>| {
            let (method, path, metrics, _) = &candidates[index];
            let time = timing(metrics);
            Hotspot {
                method: method.clone(),
                path: path.clone(),
                count: metrics.counts.count,
                error_count: metrics.counts.errors,
                timed_count: time.count,
                avg_ms: time.sort_value("avgMs"),
                p95_ms,
            }
        };
        let by_name = |a: usize, b: usize| {
            candidates[a]
                .1
                .cmp(&candidates[b].1)
                .then_with(|| candidates[a].0.cmp(&candidates[b].0))
        };
        let mut slow: Vec<(f64, usize)> = candidates
            .iter()
            .enumerate()
            .filter_map(|(index, (_, _, metrics, _))| {
                let time = timing(metrics);
                if time.count < HOTSPOT_MIN_TIMED {
                    return None;
                }
                time.sort_value("p95Ms").map(|p95| (p95, index))
            })
            .collect();
        slow.sort_unstable_by(|a, b| b.0.total_cmp(&a.0).then_with(|| by_name(a.1, b.1)));
        let slowest_endpoints: Vec<_> = slow
            .into_iter()
            .take(HOTSPOT_LIMIT)
            .map(|(p95, index)| hotspot(index, Some(p95)))
            .collect();
        let mut failing: Vec<usize> = (0..candidates.len())
            .filter(|&index| candidates[index].2.counts.errors > 0)
            .collect();
        failing.sort_unstable_by(|&a, &b| {
            candidates[b]
                .2
                .counts
                .errors
                .cmp(&candidates[a].2.counts.errors)
                .then_with(|| by_name(a, b))
        });
        let failing_endpoints: Vec<_> = failing
            .into_iter()
            .take(HOTSPOT_LIMIT)
            .map(|index| hotspot(index, timing(&candidates[index].2).sort_value("p95Ms")))
            .collect();
        if filters.top_n > 0 && filters.top_n < candidates.len() {
            candidates.select_nth_unstable_by(filters.top_n, &compare);
            candidates.truncate(filters.top_n);
        }
        candidates.sort_unstable_by(compare);
        let endpoints = candidates
            .into_iter()
            .map(|(method, path, metrics, _)| Endpoint {
                method,
                path,
                count: metrics.counts.count,
                error_count: metrics.counts.errors,
                body_bytes: metrics.counts.bytes,
                request_time: metrics.request.finish(),
                upstream_time: metrics.upstream.finish(),
            })
            .collect();
        let summary = Summary {
            count: self.summary.counts.count,
            error_count: self.summary.counts.errors,
            body_bytes: self.summary.counts.bytes,
            unique_clients: client_count,
            request_time: self.summary.request.finish(),
            upstream_time: self.summary.upstream.finish(),
        };
        let mut status_counts: Vec<_> = self
            .statuses
            .into_iter()
            .map(|(status, count)| StatusCount { status, count })
            .collect();
        status_counts.sort_unstable_by_key(|entry| entry.status);
        let mut dates: Vec<_> = self.dates.into_iter().collect();
        dates.sort_unstable();
        let mut methods: Vec<_> = self.methods.into_iter().collect();
        methods.sort_unstable();
        Report {
            summary,
            endpoints,
            endpoint_count,
            slowest_endpoints,
            failing_endpoints,
            hourly_stats: time_buckets(self.hourly),
            daily_stats: time_buckets(self.daily),
            clients: breakdown(self.clients),
            referrers: breakdown(self.referrers),
            user_agents: breakdown(self.agents),
            client_count,
            referrer_count,
            user_agent_count,
            status_counts,
            dates,
            methods,
            diagnostics: self.diagnostics,
        }
    }
}

fn selected_timing(metrics: &Metrics, upstream: bool) -> &TimingAcc {
    if upstream {
        &metrics.upstream
    } else {
        &metrics.request
    }
}

fn optional_cmp(a: Option<f64>, b: Option<f64>, direction: &str) -> Ordering {
    match (a, b) {
        (Some(a), Some(b)) => a.total_cmp(&b),
        (None, None) => Ordering::Equal,
        (None, Some(_)) => {
            if direction == "asc" {
                Ordering::Greater
            } else {
                Ordering::Less
            }
        }
        (Some(_), None) => {
            if direction == "asc" {
                Ordering::Less
            } else {
                Ordering::Greater
            }
        }
    }
}

fn time_buckets(map: HashMap<String, Metrics>) -> Vec<TimeBucket> {
    let mut buckets: Vec<_> = map
        .into_iter()
        .map(|(label, metrics)| TimeBucket {
            label,
            count: metrics.counts.count,
            error_count: metrics.counts.errors,
            body_bytes: metrics.counts.bytes,
            request_time: metrics.request.finish(),
            upstream_time: metrics.upstream.finish(),
        })
        .collect();
    buckets.sort_unstable_by(|a, b| a.label.cmp(&b.label));
    buckets
}

fn breakdown(map: HashMap<String, Counts>) -> Vec<Breakdown> {
    let mut rows: Vec<_> = map
        .into_iter()
        .map(|(value, counts)| Breakdown {
            value,
            count: counts.count,
            error_count: counts.errors,
            body_bytes: counts.bytes,
        })
        .collect();
    let compare =
        |a: &Breakdown, b: &Breakdown| b.count.cmp(&a.count).then_with(|| a.value.cmp(&b.value));
    if rows.len() > 100 {
        rows.select_nth_unstable_by(100, &compare);
        rows.truncate(100);
    }
    rows.sort_unstable_by(compare);
    rows
}

pub fn merge_partials(partials: Vec<Partial>, filters: &Filters) -> Report {
    let mut partials = partials.into_iter();
    let mut total = partials.next().unwrap_or_default();
    for partial in partials {
        total.merge(partial);
    }
    total.finish(filters)
}
