//! JSON sections of the MongoDB reaggregation report.

use std::fmt::Write;

use super::write::{calc_percentile, write_epoch_to_iso, write_escaped_json};
use super::{CollectionAcc, Matches, PatternAcc, TimeBucketAcc};
use crate::fingerprint::MongoOp;
use crate::store::Engine;
use hashbrown::HashMap;

/// The `"summary"` object: totals, percentiles, and unique-count fields.
pub(super) fn write_summary(
    out: &mut String,
    engine: &Engine,
    matches: &Matches,
    pattern_count: usize,
    collection_count: usize,
) {
    let matched_count = matches.matched_indices.len();
    let [p50, p90, p95, p99] = matches.percentiles;
    let totals = &matches.totals;
    let avg_duration = if matched_count > 0 {
        (totals.sum_duration as f64) / (matched_count as f64)
    } else {
        0.0
    };
    let overall_scan_ratio = if totals.nreturned > 0 {
        (totals.docs_examined as f64) / (totals.nreturned as f64)
    } else {
        totals.docs_examined as f64
    };

    out.push_str(r#"{"summary":{"#);
    let _ = write!(
        out,
        r#""totalLines":{},"slowQueryCount":{},"collscanCount":{},"avgDurationMs":{:.1},"p50DurationMs":{},"p90DurationMs":{},"p95DurationMs":{},"p99DurationMs":{},"maxDurationMs":{},"totalDocsExamined":{},"totalKeysExamined":{},"totalReturned":{},"overallScanRatio":{:.1},"uniquePatterns":{},"uniqueCollections":{}"#,
        engine.total_lines,
        matched_count,
        totals.collscans,
        avg_duration,
        p50,
        p90,
        p95,
        p99,
        totals.max_duration,
        totals.docs_examined,
        totals.keys_examined,
        totals.nreturned,
        overall_scan_ratio,
        pattern_count,
        collection_count,
    );
    out.push_str("},");
}

/// The `"patterns"` array, ordered by total duration.
pub(super) fn write_patterns(
    out: &mut String,
    engine: &Engine,
    pattern_map: HashMap<u64, PatternAcc>,
) {
    out.push_str(r#""patterns":["#);
    let mut patterns: Vec<PatternAcc> = pattern_map.into_values().collect();
    patterns.sort_by(|left, right| right.total_duration_ms.cmp(&left.total_duration_ms));

    for (index, pattern) in patterns.iter_mut().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let view = PatternView::of(engine, pattern);
        write_pattern(out, engine, index, pattern, &view);
    }
    out.push_str("],");
}

/// One `patterns[]` entry, including its `exampleQuery`.
fn write_pattern(
    out: &mut String,
    engine: &Engine,
    index: usize,
    pattern: &mut PatternAcc,
    view: &PatternView,
) {
    pattern.sample_durations.sort_unstable();
    let p50 = calc_percentile(&pattern.sample_durations, 50.0);
    let p90 = calc_percentile(&pattern.sample_durations, 90.0);
    let p95 = calc_percentile(&pattern.sample_durations, 95.0);
    let p99 = calc_percentile(&pattern.sample_durations, 99.0);
    let avg = (pattern.total_duration_ms as f64) / (pattern.count as f64);
    let ratio = (pattern.total_docs as f64) / ((pattern.total_returned as f64).max(1.0));
    let op = MongoOp::from_u8(pattern.op).as_str();

    let _ = write!(out, r#"{{"id":"pat-{}","ns":""#, index);
    write_escaped_json(out, view.namespace);
    out.push_str(r#"","db":""#);
    write_escaped_json(out, view.db);
    out.push_str(r#"","collection":""#);
    write_escaped_json(out, view.collection);
    let _ = write!(out, r#"","op":"{}","fingerprint":""#, op);
    write_escaped_json(out, view.fingerprint);
    out.push_str(r#"","planSummary":""#);
    write_escaped_json(out, view.plan);
    let _ = write!(
        out,
        r#"","isCollscan":{},"count":{},"totalDurationMs":{},"avgDurationMs":{:.1},"minDurationMs":{},"maxDurationMs":{},"p50DurationMs":{},"p90DurationMs":{},"p95DurationMs":{},"p99DurationMs":{},"totalDocsExamined":{},"avgDocsExamined":{:.1},"totalKeysExamined":{},"avgKeysExamined":{:.1},"totalReturned":{},"avgReturned":{:.1},"scanRatio":{:.1},"collscanCount":{},"indexSuggestion":""#,
        pattern.is_collscan,
        pattern.count,
        pattern.total_duration_ms,
        avg,
        pattern.min_duration_ms,
        pattern.max_duration_ms,
        p50,
        p90,
        p95,
        p99,
        pattern.total_docs,
        (pattern.total_docs as f64) / (pattern.count as f64),
        pattern.total_keys,
        (pattern.total_keys as f64) / (pattern.count as f64),
        pattern.total_returned,
        (pattern.total_returned as f64) / (pattern.count as f64),
        ratio,
        pattern.collscan_count,
    );
    write_escaped_json(out, view.suggestion);
    out.push_str(r#"","exampleQuery":{"#);
    write_pattern_example(out, engine, index, pattern, view);
    out.push_str(r#""}}"#);
}

/// The `exampleQuery` object of one pattern, taken from its first matching row.
fn write_pattern_example(
    out: &mut String,
    engine: &Engine,
    index: usize,
    pattern: &PatternAcc,
    view: &PatternView,
) {
    let first = pattern.first_query_idx;
    let op = MongoOp::from_u8(pattern.op).as_str();
    let remote = &engine.remote_strings[engine.remote_ids[first] as usize];
    let docs = engine.docs_examined[first];
    let returned = engine.nreturned[first];
    let ratio = (docs as f64) / ((returned as f64).max(1.0));

    let _ = write!(out, r#""id":"query-example-{}","timestamp":""#, index);
    write_epoch_to_iso(out, engine.timestamps_ms[first]);
    let _ = write!(
        out,
        r#"","epochMs":{},"severity":"I","component":"COMMAND","ctx":"","ns":""#,
        engine.timestamps_ms[first],
    );
    write_escaped_json(out, view.namespace);
    out.push_str(r#"","db":""#);
    write_escaped_json(out, view.db);
    out.push_str(r#"","collection":""#);
    write_escaped_json(out, view.collection);
    let _ = write!(
        out,
        r#"","op":"{}","durationMs":{},"planSummary":""#,
        op, engine.durations_ms[first],
    );
    write_escaped_json(out, view.plan);
    let _ = write!(
        out,
        r#"","isCollscan":{},"keysExamined":{},"docsExamined":{},"nreturned":{},"scanRatio":{:.1},"numYields":{},"reslen":{},"remote":""#,
        pattern.is_collscan,
        engine.keys_examined[first],
        docs,
        returned,
        ratio,
        engine.num_yields[first],
        engine.reslens[first],
    );
    write_escaped_json(out, remote);
    let _ = write!(
        out,
        r#"","command":{{"operation":"{}","collection":""#,
        op,
    );
    write_escaped_json(out, view.collection);
    out.push_str(r#"","planSummary":""#);
    write_escaped_json(out, view.plan);
    out.push_str(r#"","fingerprint":""#);
    write_escaped_json(out, view.fingerprint);
    out.push_str(r#""},"fingerprint":""#);
    write_escaped_json(out, view.fingerprint);
    out.push_str(r#"","indexSuggestion":""#);
    write_escaped_json(out, view.suggestion);
}

/// The `"collections"` array, ordered by total duration.
pub(super) fn write_collections(
    out: &mut String,
    engine: &Engine,
    collection_map: HashMap<u16, CollectionAcc>,
) {
    out.push_str(r#""collections":["#);
    let mut collections: Vec<CollectionAcc> = collection_map.into_values().collect();
    collections.sort_by(|left, right| right.total_duration_ms.cmp(&left.total_duration_ms));

    for (index, acc) in collections.iter_mut().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_collection(out, engine, acc);
    }
    out.push_str("],");
}

fn write_collection(out: &mut String, engine: &Engine, acc: &mut CollectionAcc) {
    let namespace = &engine.ns_strings[acc.ns_id as usize];
    let (db, collection) = split_namespace(namespace);
    acc.sample_durations.sort_unstable();
    let p95 = calc_percentile(&acc.sample_durations, 95.0);
    let avg = (acc.total_duration_ms as f64) / (acc.count as f64);
    let ratio = (acc.total_docs as f64) / ((acc.total_returned as f64).max(1.0));

    out.push_str(r#"{"ns":""#);
    write_escaped_json(out, namespace);
    out.push_str(r#"","collection":""#);
    write_escaped_json(out, collection);
    out.push_str(r#"","db":""#);
    write_escaped_json(out, db);
    let _ = write!(
        out,
        r#"","queryCount":{},"totalDurationMs":{},"avgDurationMs":{:.1},"maxDurationMs":{},"p95DurationMs":{},"collscanCount":{},"totalDocsExamined":{},"totalReturned":{},"scanRatio":{:.1}}}"#,
        acc.count,
        acc.total_duration_ms,
        avg,
        acc.max_duration_ms,
        p95,
        acc.collscan_count,
        acc.total_docs,
        acc.total_returned,
        ratio,
    );
}

/// The `"timeBuckets"` array: one entry per non-empty hour of day.
pub(super) fn write_time_buckets(out: &mut String, time_buckets: [Option<TimeBucketAcc>; 24]) {
    out.push_str(r#""timeBuckets":["#);
    let mut written = 0;
    for (hour, bucket) in time_buckets.into_iter().enumerate() {
        let Some(mut acc) = bucket else {
            continue;
        };
        if written > 0 {
            out.push(',');
        }
        written += 1;
        acc.sample_durations.sort_unstable();
        let p95 = calc_percentile(&acc.sample_durations, 95.0);
        let avg = (acc.total_duration_ms as f64) / (acc.count as f64);
        let _ = write!(
            out,
            r#"{{"timeKey":"{:02}:00","hourLabel":"{:02}:00","queryCount":{},"collscanCount":{},"avgDurationMs":{:.1},"p95DurationMs":{},"maxDurationMs":{},"ops":{{}}}}"#,
            hour, hour, acc.count, acc.collscan_count, avg, p95, acc.max_duration_ms,
        );
    }
    out.push_str("],");
}

/// The `"slowQueries"` array: the 300 slowest matched rows.
pub(super) fn write_slow_queries(out: &mut String, engine: &Engine, mut matched_indices: Vec<usize>) {
    out.push_str(r#""slowQueries":["#);
    let top_limit = matched_indices.len().min(300);
    if matched_indices.len() > top_limit {
        matched_indices.select_nth_unstable_by(top_limit - 1, |&left, &right| {
            engine.durations_ms[right]
                .cmp(&engine.durations_ms[left])
                .then_with(|| left.cmp(&right))
        });
        matched_indices.truncate(top_limit);
    }
    matched_indices.sort_by(|&left, &right| {
        engine.durations_ms[right]
            .cmp(&engine.durations_ms[left])
            .then_with(|| left.cmp(&right))
    });

    for (index, &row) in matched_indices.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_slow_query(out, engine, row);
    }
    out.push_str("],");
}

/// One `slowQueries[]` entry.
fn write_slow_query(out: &mut String, engine: &Engine, row: usize) {
    let view = RowView::of(engine, row);
    let _ = write!(out, r#"{{"id":"query-{}","timestamp":""#, row);
    write_epoch_to_iso(out, engine.timestamps_ms[row]);
    let _ = write!(
        out,
        r#"","epochMs":{},"severity":"I","component":"COMMAND","ctx":""#,
        engine.timestamps_ms[row],
    );
    write_escaped_json(out, view.ctx);
    write_row_identity(out, &view);
    write_row_metrics(out, engine, row, &view);
    write_row_command(out, &view);
}

/// The `user`, `ns`, `db`, and `collection` of one row.
fn write_row_identity(out: &mut String, view: &RowView) {
    out.push_str(r#"","user":""#);
    write_escaped_json(out, view.user);
    out.push_str(r#"","ns":""#);
    write_escaped_json(out, view.namespace);
    out.push_str(r#"","db":""#);
    write_escaped_json(out, view.db);
    out.push_str(r#"","collection":""#);
    write_escaped_json(out, view.collection);
}

/// The op, duration, plan summary, and examined/returned counters of one row.
fn write_row_metrics(out: &mut String, engine: &Engine, row: usize, view: &RowView) {
    let docs = engine.docs_examined[row];
    let returned = engine.nreturned[row];
    let ratio = (docs as f64) / ((returned as f64).max(1.0));
    let _ = write!(
        out,
        r#"","op":"{}","durationMs":{},"planSummary":""#,
        view.op, engine.durations_ms[row],
    );
    write_escaped_json(out, view.plan);
    let _ = write!(
        out,
        r#"","isCollscan":{},"keysExamined":{},"docsExamined":{},"nreturned":{},"scanRatio":{:.1},"numYields":{},"reslen":{},"remote":""#,
        engine.is_collscan[row],
        engine.keys_examined[row],
        docs,
        returned,
        ratio,
        engine.num_yields[row],
        engine.reslens[row],
    );
    write_escaped_json(out, view.remote);
}

/// The nested `command` object plus the row's fingerprint and index suggestion.
fn write_row_command(out: &mut String, view: &RowView) {
    let _ = write!(
        out,
        r#"","command":{{"operation":"{}","collection":""#,
        view.op,
    );
    write_escaped_json(out, view.collection);
    out.push_str(r#"","planSummary":""#);
    write_escaped_json(out, view.plan);
    out.push_str(r#"","fingerprint":""#);
    write_escaped_json(out, view.fingerprint);
    out.push_str(r#"","user":""#);
    write_escaped_json(out, view.user);
    out.push_str(r#"","ctx":""#);
    write_escaped_json(out, view.ctx);
    out.push_str(r#""},"fingerprint":""#);
    write_escaped_json(out, view.fingerprint);
    out.push_str(r#"","indexSuggestion":""#);
    write_escaped_json(out, view.suggestion);
    out.push_str(r#""}"#);
}

/// The derived strings a slow-query row needs, resolved once.
struct RowView<'a> {
    namespace: &'a str,
    db: &'a str,
    collection: &'a str,
    fingerprint: &'a str,
    plan: &'a str,
    suggestion: &'a str,
    user: &'a str,
    ctx: &'a str,
    remote: &'a str,
    op: &'static str,
}

impl<'a> RowView<'a> {
    fn of(engine: &'a Engine, row: usize) -> Self {
        let namespace = &engine.ns_strings[engine.ns_ids[row] as usize];
        let (db, collection) = split_namespace(namespace);
        let user_id = engine.user_ids.get(row).copied().unwrap_or(0);
        let ctx_id = engine.ctx_ids.get(row).copied().unwrap_or(u16::MAX);
        Self {
            namespace,
            db,
            collection,
            fingerprint: &engine.fingerprint_strings[engine.fingerprint_ids[row] as usize],
            plan: &engine.plan_strings[engine.plan_ids[row] as usize],
            suggestion: &engine.index_suggestions[engine.fingerprint_ids[row] as usize],
            user: engine
                .user_strings
                .get(user_id as usize)
                .map(String::as_str)
                .unwrap_or("system"),
            ctx: if ctx_id != u16::MAX {
                engine
                    .ctx_strings
                    .get(ctx_id as usize)
                    .map(String::as_str)
                    .unwrap_or("")
            } else {
                ""
            },
            remote: &engine.remote_strings[engine.remote_ids[row] as usize],
            op: MongoOp::from_u8(engine.op_ids[row]).as_str(),
        }
    }
}

/// The per-pattern strings the JSON needs, resolved once.
struct PatternView<'a> {
    namespace: &'a str,
    db: &'a str,
    collection: &'a str,
    fingerprint: &'a str,
    plan: &'a str,
    suggestion: &'a str,
}

impl<'a> PatternView<'a> {
    fn of(engine: &'a Engine, pattern: &PatternAcc) -> Self {
        let namespace = &engine.ns_strings[pattern.ns_id as usize];
        let (db, collection) = split_namespace(namespace);
        Self {
            namespace,
            db,
            collection,
            fingerprint: &engine.fingerprint_strings[pattern.fp_id as usize],
            plan: &engine.plan_strings[pattern.plan_id as usize],
            suggestion: &engine.index_suggestions[pattern.fp_id as usize],
        }
    }
}

/// Split `db.collection` (or a bare namespace) into its two names.
fn split_namespace(namespace: &str) -> (&str, &str) {
    match namespace.find('.') {
        Some(dot) => (&namespace[..dot], &namespace[dot + 1..]),
        None => ("unknown", namespace),
    }
}
