//! Connection, error, checkpoint, date, and user sections of the report.

use std::fmt::Write;

use super::write::{calc_percentile, write_epoch_to_iso, write_escaped_json};
use super::UserQueryAcc;
use crate::fingerprint::MongoOp;
use crate::store::Engine;
use hashbrown::HashMap;

/// The `"connections"` object: counters plus the driver versions seen.
pub(super) fn write_connections(out: &mut String, engine: &Engine) {
    out.push_str(r#""connections":{"#);
    let _ = write!(
        out,
        r#""accepted":{},"ended":{},"peakConcurrent":{},"authSuccess":{},"authFailed":{},"drivers":["#,
        engine.conn_accepted,
        engine.conn_ended,
        engine.conn_peak,
        engine.auth_success,
        engine.auth_fail,
    );
    for (index, driver) in engine.drivers.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(r#"{"driverName":""#);
        write_escaped_json(out, &driver.name);
        out.push_str(r#"","driverVersion":""#);
        write_escaped_json(out, &driver.version);
        out.push_str(r#"","platform":""#);
        write_escaped_json(out, &driver.platform);
        out.push_str(r#"","osName":""#);
        write_escaped_json(out, &driver.os_name);
        out.push_str(r#"","osVersion":""#);
        write_escaped_json(out, &driver.os_version);
        let _ = write!(out, r#"","count":{}}}"#, driver.count);
    }
    out.push_str(r#"],"clientIps":[]},"#);
}

/// The `"errors"` array.
pub(super) fn write_errors(out: &mut String, engine: &Engine) {
    out.push_str(r#""errors":["#);
    for (index, error) in engine.errors.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let severity = match error.severity {
            b'W' => "W",
            b'E' => "E",
            b'F' => "F",
            _ => "I",
        };
        out.push_str(r#"{"timestamp":""#);
        write_escaped_json(out, &error.timestamp);
        let _ = write!(
            out,
            r#"","severity":"{}","component":"COMMAND","id":{},"msg":""#,
            severity, error.id,
        );
        write_escaped_json(out, &error.msg);
        let _ = write!(out, r#"","count":{}}}"#, error.count);
    }
    out.push_str("],");
}

/// The `"checkpoints"` array.
pub(super) fn write_checkpoints(out: &mut String, engine: &Engine) {
    out.push_str(r#""checkpoints":["#);
    for (index, checkpoint) in engine.checkpoints.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(r#"{"timestamp":""#);
        write_escaped_json(out, &checkpoint.timestamp);
        out.push_str(r#"","msg":""#);
        write_escaped_json(out, &checkpoint.msg);
        out.push_str(r#""}"#);
    }
    out.push_str("],");
}

/// The `"dates"` array.
pub(super) fn write_dates(out: &mut String, engine: &Engine) {
    out.push_str(r#""dates":["#);
    for (index, date) in engine.dates.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        write_escaped_json(out, date);
        out.push('"');
    }
    out.push_str("],");
}

/// The `"operations"` array: the distinct ops seen during the parse.
pub(super) fn write_operations(out: &mut String, engine: &Engine) {
    out.push_str(r#""operations":["#);
    let mut seen: Vec<&str> = Vec::with_capacity(8);
    for op in 1..=8 {
        if (engine.ops_mask & (1 << op)) != 0 {
            seen.push(MongoOp::from_u8(op).as_str());
        }
    }
    seen.sort_unstable();
    for (index, op) in seen.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(op);
        out.push('"');
    }
    out.push_str("],");
}

/// User ids ordered as the report needs them: most active first, `system` last.
pub(super) fn candidate_user_ids(engine: &Engine, user_map: &HashMap<u16, UserQueryAcc>) -> Vec<u16> {
    let mut candidates: Vec<u16> = (0..engine.user_strings.len() as u16).collect();
    candidates.sort_by(|&left, &right| {
        let left_is_system = left == 0;
        let right_is_system = right == 0;
        if left_is_system != right_is_system {
            return left_is_system.cmp(&right_is_system);
        }
        let left_count = user_map.get(&left).map(|acc| acc.count).unwrap_or(0);
        let right_count = user_map.get(&right).map(|acc| acc.count).unwrap_or(0);
        right_count.cmp(&left_count).then_with(|| left.cmp(&right))
    });
    candidates
}

/// The `"users"` array.
pub(super) fn write_users(
    out: &mut String,
    engine: &Engine,
    mut user_map: HashMap<u16, UserQueryAcc>,
    candidates: &[u16],
) {
    out.push_str(r#""users":["#);
    for (index, &user_id) in candidates.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        write_user(out, engine, user_id, user_map.get_mut(&user_id));
    }
    out.push(']');
}

/// One `users[]` entry: auth metadata plus the user's accumulated query statistics.
fn write_user(out: &mut String, engine: &Engine, user_id: u16, acc: Option<&mut UserQueryAcc>) {
    let user_name = engine
        .user_strings
        .get(user_id as usize)
        .map(String::as_str)
        .unwrap_or("system");
    let default_meta = crate::store::UserMeta::default();
    let meta = engine.user_meta.get(user_id as usize).unwrap_or(&default_meta);
    let stats = UserStats::of(acc);

    out.push_str(r#"{"userName":""#);
    write_escaped_json(out, user_name);
    write_auth_metadata(out, meta);
    write_user_totals(out, &stats, meta);
    write_user_operations(out, &stats.ops);
    write_user_collections(out, engine, &stats.top_collections);
    out.push_str("]}");
}

/// The user's `authDb`, `appName`, and client address list.
fn write_auth_metadata(out: &mut String, meta: &crate::store::UserMeta) {
    out.push_str(r#"","authDb":""#);
    write_escaped_json(out, &meta.auth_db);
    out.push_str(r#"","appName":""#);
    write_escaped_json(out, &meta.app_name);
    out.push_str(r#"","clientIps":["#);
    for (index, ip) in meta.client_ips.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        write_escaped_json(out, ip);
        out.push('"');
    }
    out.push_str("],");
}

/// The user's query totals, activity window, and auth counters.
fn write_user_totals(out: &mut String, stats: &UserStats, meta: &crate::store::UserMeta) {
    let _ = write!(
        out,
        r#""totalOperations":{},"slowQueryCount":{},"collscanCount":{},"totalDurationMs":{},"avgDurationMs":{:.1},"minDurationMs":{},"maxDurationMs":{},"p95DurationMs":{},"totalDocsExamined":{},"totalKeysExamined":{},"totalReturned":{},"scanRatio":{:.1},"firstActive":""#,
        stats.count,
        stats.count,
        stats.collscan_count,
        stats.total_duration_ms,
        stats.avg_duration_ms,
        stats.min_duration_ms,
        stats.max_duration_ms,
        stats.p95_duration_ms,
        stats.total_docs,
        stats.total_keys,
        stats.total_returned,
        stats.scan_ratio,
    );
    if meta.first_seen_ms > 0 {
        write_epoch_to_iso(out, meta.first_seen_ms);
    }
    out.push_str(r#"","lastActive":""#);
    if meta.last_seen_ms > 0 {
        write_epoch_to_iso(out, meta.last_seen_ms);
    }
    let _ = write!(
        out,
        r#"","authSuccessCount":{},"authFailCount":{},"operations":{{"#,
        meta.auth_success_count, meta.auth_fail_count,
    );
}

/// The user's per-operation query counts, then the `topCollections` key.
fn write_user_operations(out: &mut String, ops: &[(u8, u32)]) {
    for (index, (op, count)) in ops.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        let _ = write!(out, r#""{}":{}"#, MongoOp::from_u8(*op).as_str(), count);
    }
    out.push_str(r#"},"topCollections":["#);
}

/// The user's busiest collections, capped at twenty.
fn write_user_collections(out: &mut String, engine: &Engine, collections: &[(u16, u32, u64, u32)]) {
    for (index, &(ns_id, count, duration, collscans)) in collections.iter().take(20).enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(r#"{"ns":""#);
        write_escaped_json(out, &engine.ns_strings[ns_id as usize]);
        let _ = write!(
            out,
            r#"","count":{},"totalDurationMs":{},"collscanCount":{}}}"#,
            count, duration, collscans,
        );
    }
}

/// The `"userNames"` array: every distinct user name.
pub(super) fn write_user_names(out: &mut String, engine: &Engine, candidates: &[u16]) {
    let mut names: Vec<&str> = Vec::new();
    for &user_id in candidates {
        let name = engine
            .user_strings
            .get(user_id as usize)
            .map(String::as_str)
            .unwrap_or("");
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    for (index, name) in names.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('"');
        write_escaped_json(out, name);
        out.push('"');
    }
}

/// The statistics of one user, defaulted when they have no matched queries.
#[derive(Default)]
struct UserStats {
    count: u32,
    collscan_count: u32,
    total_duration_ms: u64,
    min_duration_ms: u32,
    max_duration_ms: u32,
    p95_duration_ms: u32,
    avg_duration_ms: f64,
    total_docs: u64,
    total_keys: u64,
    total_returned: u64,
    scan_ratio: f64,
    ops: Vec<(u8, u32)>,
    top_collections: Vec<(u16, u32, u64, u32)>,
}

impl UserStats {
    fn of(acc: Option<&mut UserQueryAcc>) -> Self {
        let Some(acc) = acc else {
            return Self::default();
        };
        acc.sample_durations.sort_unstable();
        let mut ops: Vec<(u8, u32)> = acc.ops.iter().map(|(&op, &count)| (op, count)).collect();
        ops.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| left.0.cmp(&right.0)));
        let mut top_collections: Vec<(u16, u32, u64, u32)> = acc
            .colls
            .iter()
            .map(|(&ns_id, &(count, duration, collscans))| (ns_id, count, duration, collscans))
            .collect();
        top_collections.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.2.cmp(&left.2)));
        Self {
            count: acc.count,
            collscan_count: acc.collscan_count,
            total_duration_ms: acc.total_duration_ms,
            min_duration_ms: acc.min_duration_ms,
            max_duration_ms: acc.max_duration_ms,
            p95_duration_ms: calc_percentile(&acc.sample_durations, 95.0),
            avg_duration_ms: (acc.total_duration_ms as f64) / (acc.count as f64),
            total_docs: acc.total_docs,
            total_keys: acc.total_keys,
            total_returned: acc.total_returned,
            scan_ratio: (acc.total_docs as f64) / ((acc.total_returned as f64).max(1.0)),
            ops,
            top_collections,
        }
    }
}
