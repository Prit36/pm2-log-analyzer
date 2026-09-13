//! Fast reaggregation kernel in Rust.

mod diagnostics;
mod report;
mod write;

use hashbrown::HashMap;

use crate::fingerprint::MongoOp;
use crate::store::Engine;
use write::calc_percentile;

pub struct FilterParams<'a> {
    pub op: &'a str,
    pub plan_filter: u8, // 0 = all, 1 = collscan_only, 2 = ixscan_only
    pub min_duration_ms: u32,
    pub collection: &'a str,
    pub search_query: &'a str,
    pub high_scan_ratio_only: bool,
    pub user: &'a str,
}

pub(super) struct PatternAcc {
    pub(super) fp_id: u16,
    pub(super) ns_id: u16,
    pub(super) plan_id: u16,
    pub(super) op: u8,
    pub(super) is_collscan: bool,
    pub(super) count: u32,
    pub(super) total_duration_ms: u64,
    pub(super) min_duration_ms: u32,
    pub(super) max_duration_ms: u32,
    pub(super) total_docs: u64,
    pub(super) total_keys: u64,
    pub(super) total_returned: u64,
    pub(super) collscan_count: u32,
    pub(super) sample_durations: Vec<u32>,
    pub(super) first_query_idx: usize,
}

impl PatternAcc {
    fn new(row: &MatchedRow, keys_examined: u32) -> Self {
        Self {
            fp_id: row.fingerprint_id,
            ns_id: row.ns_id,
            plan_id: row.plan_id,
            op: row.op,
            is_collscan: row.is_collscan,
            count: 1,
            total_duration_ms: row.duration as u64,
            min_duration_ms: row.duration,
            max_duration_ms: row.duration,
            total_docs: row.docs_examined as u64,
            total_keys: keys_examined as u64,
            total_returned: row.nreturned as u64,
            collscan_count: u32::from(row.is_collscan),
            sample_durations: vec![row.duration],
            first_query_idx: row.index,
        }
    }

    fn record(&mut self, row: &MatchedRow, keys_examined: u32) {
        self.count += 1;
        self.total_duration_ms += row.duration as u64;
        if row.duration < self.min_duration_ms {
            self.min_duration_ms = row.duration;
        }
        if row.duration > self.max_duration_ms {
            self.max_duration_ms = row.duration;
        }
        self.total_docs += row.docs_examined as u64;
        self.total_keys += keys_examined as u64;
        self.total_returned += row.nreturned as u64;
        if row.is_collscan {
            self.collscan_count += 1;
        }
        self.sample_durations.push(row.duration);
    }
}

pub(super) struct CollectionAcc {
    pub(super) ns_id: u16,
    pub(super) count: u32,
    pub(super) total_duration_ms: u64,
    pub(super) max_duration_ms: u32,
    pub(super) collscan_count: u32,
    pub(super) total_docs: u64,
    pub(super) total_returned: u64,
    pub(super) sample_durations: Vec<u32>,
}

impl CollectionAcc {
    fn new(row: &MatchedRow) -> Self {
        Self {
            ns_id: row.ns_id,
            count: 1,
            total_duration_ms: row.duration as u64,
            max_duration_ms: row.duration,
            collscan_count: u32::from(row.is_collscan),
            total_docs: row.docs_examined as u64,
            total_returned: row.nreturned as u64,
            sample_durations: vec![row.duration],
        }
    }

    fn record(&mut self, row: &MatchedRow) {
        self.count += 1;
        self.total_duration_ms += row.duration as u64;
        if row.duration > self.max_duration_ms {
            self.max_duration_ms = row.duration;
        }
        if row.is_collscan {
            self.collscan_count += 1;
        }
        self.total_docs += row.docs_examined as u64;
        self.total_returned += row.nreturned as u64;
        self.sample_durations.push(row.duration);
    }
}

pub(super) struct TimeBucketAcc {
    pub(super) count: u32,
    pub(super) collscan_count: u32,
    pub(super) total_duration_ms: u64,
    pub(super) max_duration_ms: u32,
    pub(super) sample_durations: Vec<u32>,
}

impl TimeBucketAcc {
    fn new(row: &MatchedRow) -> Self {
        Self {
            count: 1,
            collscan_count: u32::from(row.is_collscan),
            total_duration_ms: row.duration as u64,
            max_duration_ms: row.duration,
            sample_durations: vec![row.duration],
        }
    }

    fn record(&mut self, row: &MatchedRow) {
        self.count += 1;
        self.total_duration_ms += row.duration as u64;
        if row.duration > self.max_duration_ms {
            self.max_duration_ms = row.duration;
        }
        if row.is_collscan {
            self.collscan_count += 1;
        }
        self.sample_durations.push(row.duration);
    }
}

pub(super) struct UserQueryAcc {
    pub(super) count: u32,
    pub(super) collscan_count: u32,
    pub(super) total_duration_ms: u64,
    pub(super) min_duration_ms: u32,
    pub(super) max_duration_ms: u32,
    pub(super) total_docs: u64,
    pub(super) total_keys: u64,
    pub(super) total_returned: u64,
    pub(super) sample_durations: Vec<u32>,
    pub(super) ops: HashMap<u8, u32>,
    pub(super) colls: HashMap<u16, (u32, u64, u32)>,
}

impl UserQueryAcc {
    fn new(row: &MatchedRow, keys_examined: u32) -> Self {
        let mut ops = HashMap::new();
        ops.insert(row.op, 1);
        let mut colls = HashMap::new();
        colls.insert(row.ns_id, (1, row.duration as u64, u32::from(row.is_collscan)));
        Self {
            count: 1,
            collscan_count: u32::from(row.is_collscan),
            total_duration_ms: row.duration as u64,
            min_duration_ms: row.duration,
            max_duration_ms: row.duration,
            total_docs: row.docs_examined as u64,
            total_keys: keys_examined as u64,
            total_returned: row.nreturned as u64,
            sample_durations: vec![row.duration],
            ops,
            colls,
        }
    }

    fn record(&mut self, row: &MatchedRow, keys_examined: u32) {
        self.count += 1;
        self.total_duration_ms += row.duration as u64;
        if row.duration > self.max_duration_ms {
            self.max_duration_ms = row.duration;
        }
        if row.duration < self.min_duration_ms {
            self.min_duration_ms = row.duration;
        }
        if row.is_collscan {
            self.collscan_count += 1;
        }
        self.total_docs += row.docs_examined as u64;
        self.total_keys += keys_examined as u64;
        self.total_returned += row.nreturned as u64;
        self.sample_durations.push(row.duration);
        *self.ops.entry(row.op).or_insert(0) += 1;
        let coll = self.colls.entry(row.ns_id).or_insert((0, 0, 0));
        coll.0 += 1;
        coll.1 += row.duration as u64;
        if row.is_collscan {
            coll.2 += 1;
        }
    }
}

/// One row's values, once it has passed every filter.
#[derive(Clone, Copy)]
struct MatchedRow {
    index: usize,
    duration: u32,
    ns_id: u16,
    op: u8,
    plan_id: u16,
    fingerprint_id: u16,
    remote_id: u16,
    user_id: u16,
    docs_examined: u32,
    keys_examined: u32,
    nreturned: u32,
    is_collscan: bool,
}

/// Filter-independent totals over the matched set.
#[derive(Default)]
pub(super) struct QueryTotals {
    pub(super) docs_examined: u64,
    pub(super) keys_examined: u64,
    pub(super) nreturned: u64,
    pub(super) collscans: u32,
    pub(super) max_duration: u32,
    pub(super) sum_duration: u64,
}

impl QueryTotals {
    fn record(&mut self, row: &MatchedRow) {
        self.sum_duration += row.duration as u64;
        if row.duration > self.max_duration {
            self.max_duration = row.duration;
        }
        if row.is_collscan {
            self.collscans += 1;
        }
        self.docs_examined += row.docs_examined as u64;
        self.keys_examined += row.keys_examined as u64;
        self.nreturned += row.nreturned as u64;
    }
}

/// Every row that passed the filters, plus the accumulators built from them.
pub(super) struct Matches {
    pub(super) pattern_map: HashMap<u64, PatternAcc>,
    pub(super) collection_map: HashMap<u16, CollectionAcc>,
    pub(super) time_buckets: [Option<TimeBucketAcc>; 24],
    pub(super) user_map: HashMap<u16, UserQueryAcc>,
    pub(super) matched_indices: Vec<usize>,
    pub(super) percentiles: [u32; 4],
    pub(super) totals: QueryTotals,
    all_durations: Vec<u32>,
}

impl Matches {
    fn new(count: usize) -> Self {
        Self {
            pattern_map: HashMap::new(),
            collection_map: HashMap::new(),
            time_buckets: Default::default(),
            user_map: HashMap::new(),
            matched_indices: Vec::with_capacity(count),
            percentiles: [0; 4],
            totals: QueryTotals::default(),
            all_durations: Vec::with_capacity(count),
        }
    }

    fn record_row(&mut self, engine: &Engine, row: MatchedRow) {
        self.matched_indices.push(row.index);
        self.all_durations.push(row.duration);
        self.totals.record(&row);
        self.record_pattern(&row);
        self.record_collection(&row);
        self.record_hour(engine, &row);
        self.record_user(engine, &row);
    }

    fn finish(&mut self) {
        self.all_durations.sort_unstable();
        self.percentiles = [
            calc_percentile(&self.all_durations, 50.0),
            calc_percentile(&self.all_durations, 90.0),
            calc_percentile(&self.all_durations, 95.0),
            calc_percentile(&self.all_durations, 99.0),
        ];
    }

    /// Group by `(namespace, op, plan, fingerprint)`; the composite key keeps
    /// unrelated collections and plans from colliding.
    fn record_pattern(&mut self, row: &MatchedRow) {
        let key = ((row.ns_id as u64) << 48)
            | ((row.op as u64) << 40)
            | ((row.plan_id as u64) << 24)
            | (row.fingerprint_id as u64);
        match self.pattern_map.get_mut(&key) {
            Some(acc) => acc.record(row, row.keys_examined),
            None => {
                self.pattern_map
                    .insert(key, PatternAcc::new(row, row.keys_examined));
            }
        }
    }

    fn record_collection(&mut self, row: &MatchedRow) {
        match self.collection_map.get_mut(&row.ns_id) {
            Some(acc) => acc.record(row),
            None => {
                self.collection_map.insert(row.ns_id, CollectionAcc::new(row));
            }
        }
    }

    fn record_hour(&mut self, engine: &Engine, row: &MatchedRow) {
        let seconds = (engine.timestamps_ms[row.index] / 1000) as i64;
        let hour = ((((seconds % 86400) + 86400) % 86400) / 3600) as usize;
        match &mut self.time_buckets[hour] {
            Some(acc) => acc.record(row),
            slot => *slot = Some(TimeBucketAcc::new(row)),
        }
    }

    fn record_user(&mut self, engine: &Engine, row: &MatchedRow) {
        let keys_examined = engine.keys_examined[row.index];
        match self.user_map.get_mut(&row.user_id) {
            Some(acc) => acc.record(row, keys_examined),
            None => {
                self.user_map
                    .insert(row.user_id, UserQueryAcc::new(row, keys_examined));
            }
        }
    }
}

/// The per-query filter predicates, resolved once per aggregation.
struct FilterSpec<'a> {
    min_duration_ms: u32,
    plan_filter: u8,
    op_filter: u8,
    collection: &'a str,
    target_user_id: Option<u16>,
    high_scan_ratio_only: bool,
    search_lower: String,
}

impl<'a> FilterSpec<'a> {
    fn new(engine: &Engine, filters: &'a FilterParams<'a>) -> Self {
        Self {
            min_duration_ms: filters.min_duration_ms,
            plan_filter: filters.plan_filter,
            op_filter: op_code(filters.op),
            collection: filters.collection,
            target_user_id: if filters.user != "all" && !filters.user.is_empty() {
                engine.user_table.get(filters.user).copied()
            } else {
                None
            },
            high_scan_ratio_only: filters.high_scan_ratio_only,
            search_lower: filters.search_query.to_lowercase(),
        }
    }

    /// `Some(row)` when the entry at `index` passes every filter.
    fn matching_row(&self, engine: &Engine, index: usize) -> Option<MatchedRow> {
        let duration = engine.durations_ms[index];
        let is_collscan = engine.is_collscan[index];
        if duration < self.min_duration_ms || !self.plan_allows(is_collscan) {
            return None;
        }
        let op = engine.op_ids[index];
        if self.op_filter != 0 && op != self.op_filter {
            return None;
        }
        let ns_id = engine.ns_ids[index];
        let namespace = &engine.ns_strings[ns_id as usize];
        if self.collection != "all" && namespace != self.collection {
            return None;
        }
        let user_id = engine.user_ids.get(index).copied().unwrap_or(0);
        if self.target_user_id.is_some_and(|target| user_id != target) {
            return None;
        }
        let docs_examined = engine.docs_examined[index];
        let nreturned = engine.nreturned[index];
        if self.high_scan_ratio_only && scan_ratio(docs_examined, nreturned) < 100.0 {
            return None;
        }
        let row = MatchedRow {
            index,
            duration,
            ns_id,
            op,
            plan_id: engine.plan_ids[index],
            fingerprint_id: engine.fingerprint_ids[index],
            remote_id: engine.remote_ids[index],
            user_id,
            docs_examined,
            keys_examined: engine.keys_examined[index],
            nreturned,
            is_collscan,
        };
        self.search_allows(engine, &row, namespace).then_some(row)
    }

    fn plan_allows(&self, is_collscan: bool) -> bool {
        match self.plan_filter {
            1 => is_collscan,
            2 => !is_collscan,
            _ => true,
        }
    }

    /// The free-text search spans namespace, fingerprint, plan, remote, and user.
    fn search_allows(&self, engine: &Engine, row: &MatchedRow, namespace: &str) -> bool {
        if self.search_lower.is_empty() {
            return true;
        }
        if namespace.to_lowercase().contains(&self.search_lower) {
            return true;
        }
        let fingerprint = &engine.fingerprint_strings[row.fingerprint_id as usize];
        if fingerprint.to_lowercase().contains(&self.search_lower) {
            return true;
        }
        let plan = &engine.plan_strings[row.plan_id as usize];
        if plan.to_lowercase().contains(&self.search_lower) {
            return true;
        }
        let remote = &engine.remote_strings[row.remote_id as usize];
        if remote.to_lowercase().contains(&self.search_lower) {
            return true;
        }
        let user = engine
            .user_strings
            .get(row.user_id as usize)
            .map(String::as_str)
            .unwrap_or("");
        user.to_lowercase().contains(&self.search_lower)
    }
}

/// Examined-per-returned ratio, floored at one returned row.
fn scan_ratio(examined: u32, returned: u32) -> f64 {
    (examined as f64) / ((returned as f64).max(1.0))
}

/// The op code a filter string selects; `0` means every op.
fn op_code(op: &str) -> u8 {
    match op {
        "find" => MongoOp::Find as u8,
        "aggregate" => MongoOp::Aggregate as u8,
        "distinct" => MongoOp::Distinct as u8,
        "getMore" => MongoOp::GetMore as u8,
        "insert" => MongoOp::Insert as u8,
        "update" => MongoOp::Update as u8,
        "delete" => MongoOp::Delete as u8,
        "findAndModify" => MongoOp::FindAndModify as u8,
        _ => 0,
    }
}

pub fn reaggregate(engine: &Engine, filters: FilterParams) -> String {
    let matches = collect_matches(engine, &filters);
    let mut out = String::with_capacity(1024 * 1024);
    report::write_summary(
        &mut out,
        engine,
        &matches,
        matches.pattern_map.len(),
        matches.collection_map.len(),
    );

    let Matches {
        pattern_map,
        collection_map,
        time_buckets,
        user_map,
        matched_indices,
        ..
    } = matches;

    report::write_patterns(&mut out, engine, pattern_map);
    report::write_collections(&mut out, engine, collection_map);
    report::write_time_buckets(&mut out, time_buckets);
    report::write_slow_queries(&mut out, engine, matched_indices);
    diagnostics::write_connections(&mut out, engine);
    diagnostics::write_errors(&mut out, engine);
    diagnostics::write_checkpoints(&mut out, engine);
    diagnostics::write_dates(&mut out, engine);
    diagnostics::write_operations(&mut out, engine);

    let candidates = diagnostics::candidate_user_ids(engine, &user_map);
    diagnostics::write_users(&mut out, engine, user_map, &candidates);
    out.push_str(r#","userNames":["#);
    diagnostics::write_user_names(&mut out, engine, &candidates);
    out.push_str("]}");
    out
}

/// The filtered scan that every report section is built from.
fn collect_matches(engine: &Engine, filters: &FilterParams) -> Matches {
    let spec = FilterSpec::new(engine, filters);
    let mut matches = Matches::new(engine.durations_ms.len());
    for index in 0..engine.durations_ms.len() {
        if let Some(row) = spec.matching_row(engine, index) {
            matches.record_row(engine, row);
        }
    }
    matches.finish();
    matches
}
