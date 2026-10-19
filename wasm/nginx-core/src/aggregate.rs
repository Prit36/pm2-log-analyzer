use std::cmp::Ordering;

use hashbrown::{HashMap, HashSet};
use pm2_core::{NormalizeMode, normalize_into};
use serde::{Deserialize, Serialize};

use crate::{Engine, Normalized, Row};

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

/// Most endpoint groups have only one observed bucket; they allocate no hash map.
#[derive(Default)]
pub(crate) enum Histogram {
    #[default]
    Empty,
    Single(i16, u64),
    Multiple(HashMap<i16, u64>),
}

impl Histogram {
    pub(crate) fn add(&mut self, key: i16, count: u64) {
        match self {
            Self::Empty => *self = Self::Single(key, count),
            Self::Single(old_key, old_count) if *old_key == key => *old_count += count,
            Self::Single(old_key, old_count) => {
                let mut map = HashMap::with_capacity(2);
                map.insert(*old_key, *old_count);
                map.insert(key, count);
                *self = Self::Multiple(map);
            }
            Self::Multiple(map) => *map.entry(key).or_default() += count,
        }
    }

    pub(crate) fn buckets(&self) -> Vec<(i16, u64)> {
        match self {
            Self::Empty => Vec::new(),
            Self::Single(key, count) => vec![(*key, *count)],
            Self::Multiple(map) => map.iter().map(|(&key, &count)| (key, count)).collect(),
        }
    }

    fn merge(&mut self, other: Self) {
        match other {
            Self::Empty => {}
            Self::Single(key, count) => self.add(key, count),
            Self::Multiple(map) => {
                for (key, count) in map {
                    self.add(key, count);
                }
            }
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
    fn add(&mut self, row: &Row) {
        self.count += 1;
        self.errors += u64::from(row.status >= 400);
        self.bytes += row.bytes;
    }
    fn merge(&mut self, other: Self) {
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
    fn add(&mut self, row: &Row) {
        self.counts.add(row);
        self.request.add(row.request_ms, row.request_key);
        self.upstream.add(row.upstream_ms, row.upstream_key);
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

impl Engine {
    pub fn aggregate(&mut self, filters: &Filters) -> Partial {
        let mode = match filters.normalize_mode.as_str() {
            "stripQuery" => NormalizeMode::StripQuery,
            "collapseIds" => NormalizeMode::CollapseIds,
            _ => NormalizeMode::Exact,
        };
        let normalized = if mode == NormalizeMode::Exact {
            None
        } else {
            let index = mode as usize - 1;
            let cache = self.normalized[index].get_or_insert_with(Normalized::default);
            let mut scratch = Vec::new();
            for path in &self.paths.values[cache.ids.len()..] {
                let id = cache
                    .paths
                    .intern(normalize_into(path.as_bytes(), mode, &mut scratch));
                cache.ids.push(id);
            }
            Some(cache)
        };
        let (path_values, path_ids) = match normalized {
            Some(cache) => (&cache.paths.values, Some(&cache.ids)),
            None => (&self.paths.values, None),
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
        let path_allowed: Vec<bool> = path_values
            .iter()
            .map(|path| text_query.is_empty() || path.to_lowercase().contains(&text_query))
            .collect();
        let client_allowed: Vec<(bool, bool)> = self
            .clients
            .values
            .iter()
            .map(|client| {
                let client = client.to_lowercase();
                (
                    text_query.is_empty() || client.contains(&text_query),
                    client_queries.iter().all(|query| client == *query),
                )
            })
            .collect();
        let method_allowed: Vec<bool> = self
            .methods
            .values
            .iter()
            .map(|method| filters.methods.is_empty() || filters.methods.contains(method))
            .collect();
        let date_allowed: Vec<bool> = self
            .dates
            .values
            .iter()
            .map(|date| {
                filters.date_filter == "all"
                    || filters.date_filter.is_empty()
                    || filters.date_filter == *date
            })
            .collect();
        let family = match filters.status_family.as_str() {
            "2xx" => 2,
            "3xx" => 3,
            "4xx" => 4,
            "5xx" => 5,
            // 4xx + 5xx, the same responses counted as errors.
            "errors" => 9,
            _ => 0,
        };
        let mut summary = Metrics::default();
        let mut endpoints: HashMap<(u32, u32), Metrics> = HashMap::new();
        let mut hourly: HashMap<(u32, u8), Metrics> = HashMap::new();
        let mut daily: HashMap<u32, Metrics> = HashMap::new();
        let mut clients: HashMap<u32, Counts> = HashMap::new();
        let mut referrers: HashMap<u32, Counts> = HashMap::new();
        let mut agents: HashMap<u32, Counts> = HashMap::new();
        let mut statuses = HashMap::new();
        for row in &self.rows {
            let path = path_ids.map_or(row.path, |ids| ids[row.path as usize]);
            let (client_matches, exact_client_matches) = client_allowed[row.client as usize];
            if (!path_allowed[path as usize] && !client_matches)
                || !exact_client_matches
                || !method_allowed[row.method as usize]
                || !date_allowed[row.date as usize]
                || (family == 9 && row.status < 400)
                || (family != 0 && family != 9 && row.status / 100 != family)
                || (filters.status_code != 0 && row.status != filters.status_code)
            {
                continue;
            }
            let millis = if filters.metric == "upstream" {
                row.upstream_ms
            } else {
                row.request_ms
            };
            if filters.min_ms > 0.0 && (!millis.is_finite() || f64::from(millis) < filters.min_ms) {
                continue;
            }
            summary.add(row);
            endpoints.entry((row.method, path)).or_default().add(row);
            hourly.entry((row.date, row.hour)).or_default().add(row);
            daily.entry(row.date).or_default().add(row);
            clients.entry(row.client).or_default().add(row);
            referrers.entry(row.referrer).or_default().add(row);
            agents.entry(row.agent).or_default().add(row);
            *statuses.entry(row.status).or_default() += 1;
        }
        Partial {
            summary,
            endpoints: endpoints
                .into_iter()
                .map(|((method, path), value)| {
                    (
                        (
                            self.methods.values[method as usize].clone(),
                            path_values[path as usize].clone(),
                        ),
                        value,
                    )
                })
                .collect(),
            hourly: hourly
                .into_iter()
                .map(|((date, hour), value)| {
                    (
                        format!("{} {hour:02}:00", self.dates.values[date as usize]),
                        value,
                    )
                })
                .collect(),
            daily: daily
                .into_iter()
                .map(|(date, value)| (self.dates.values[date as usize].clone(), value))
                .collect(),
            clients: clients
                .into_iter()
                .map(|(id, value)| (self.clients.values[id as usize].clone(), value))
                .collect(),
            referrers: referrers
                .into_iter()
                .map(|(id, value)| (self.referrers.values[id as usize].clone(), value))
                .collect(),
            agents: agents
                .into_iter()
                .map(|(id, value)| (self.agents.values[id as usize].clone(), value))
                .collect(),
            statuses,
            dates: self.dates.values.iter().cloned().collect(),
            methods: self.methods.values.iter().cloned().collect(),
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
