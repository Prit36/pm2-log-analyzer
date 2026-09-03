//! Fast reaggregation kernel in Rust.

use std::fmt::Write;
use hashbrown::HashMap;

use crate::fingerprint::MongoOp;
use crate::store::Engine;

pub struct FilterParams<'a> {
    pub op: &'a str,
    pub plan_filter: u8, // 0 = all, 1 = collscan_only, 2 = ixscan_only
    pub min_duration_ms: u32,
    pub collection: &'a str,
    pub search_query: &'a str,
    pub high_scan_ratio_only: bool,
    pub user: &'a str,
}

struct PatternAcc {
    fp_id: u16,
    ns_id: u16,
    plan_id: u16,
    op: u8,
    is_collscan: bool,
    count: u32,
    total_duration_ms: u64,
    min_duration_ms: u32,
    max_duration_ms: u32,
    total_docs: u64,
    total_keys: u64,
    total_returned: u64,
    collscan_count: u32,
    sample_durations: Vec<u32>,
    first_query_idx: usize,
}

struct CollectionAcc {
    ns_id: u16,
    count: u32,
    total_duration_ms: u64,
    max_duration_ms: u32,
    collscan_count: u32,
    total_docs: u64,
    total_returned: u64,
    sample_durations: Vec<u32>,
}

struct TimeBucketAcc {
    hour: u8,
    count: u32,
    collscan_count: u32,
    total_duration_ms: u64,
    max_duration_ms: u32,
    sample_durations: Vec<u32>,
}

struct UserQueryAcc {
    count: u32,
    collscan_count: u32,
    total_duration_ms: u64,
    min_duration_ms: u32,
    max_duration_ms: u32,
    total_docs: u64,
    total_keys: u64,
    total_returned: u64,
    sample_durations: Vec<u32>,
    ops: HashMap<u8, u32>,
    colls: HashMap<u16, (u32, u64, u32)>,
}

pub fn reaggregate(engine: &Engine, filters: FilterParams) -> String {
    let n = engine.durations_ms.len();

    let mut pattern_map: HashMap<u64, PatternAcc> = HashMap::new();
    let mut collection_map: HashMap<u16, CollectionAcc> = HashMap::new();
    let mut time_buckets: [Option<TimeBucketAcc>; 24] = Default::default();
    let mut user_map: HashMap<u16, UserQueryAcc> = HashMap::new();

    let mut matched_indices = Vec::with_capacity(n);
    let mut all_durations = Vec::with_capacity(n);

    let mut total_docs = 0u64;
    let mut total_keys = 0u64;
    let mut total_returned = 0u64;
    let mut total_collscans = 0u32;
    let mut max_duration = 0u32;
    let mut sum_duration = 0u64;

    let op_filter_num = match filters.op {
        "find" => MongoOp::Find as u8,
        "aggregate" => MongoOp::Aggregate as u8,
        "distinct" => MongoOp::Distinct as u8,
        "getMore" => MongoOp::GetMore as u8,
        "insert" => MongoOp::Insert as u8,
        "update" => MongoOp::Update as u8,
        "delete" => MongoOp::Delete as u8,
        "findAndModify" => MongoOp::FindAndModify as u8,
        _ => 0, // all
    };

    let target_user_id = if filters.user != "all" && !filters.user.is_empty() {
        engine.user_table.get(filters.user).copied()
    } else {
        None
    };

    let search_lower = filters.search_query.to_lowercase();

    for i in 0..n {
        let dur = engine.durations_ms[i];
        if dur < filters.min_duration_ms {
            continue;
        }

        let is_coll = engine.is_collscan[i];
        if filters.plan_filter == 1 && !is_coll {
            continue;
        }
        if filters.plan_filter == 2 && is_coll {
            continue;
        }

        let op = engine.op_ids[i];
        if op_filter_num != 0 && op != op_filter_num {
            continue;
        }

        let ns_id = engine.ns_ids[i];
        let ns_str = &engine.ns_strings[ns_id as usize];
        if filters.collection != "all" && ns_str != filters.collection {
            continue;
        }

        let u_id = engine.user_ids.get(i).copied().unwrap_or(0);
        if let Some(want_uid) = target_user_id {
            if u_id != want_uid {
                continue;
            }
        }

        let docs = engine.docs_examined[i];
        let ret = engine.nreturned[i];
        let scan_ratio = (docs as f64) / ((ret as f64).max(1.0));
        if filters.high_scan_ratio_only && scan_ratio < 100.0 {
            continue;
        }

        let plan_id = engine.plan_ids[i];
        let fp_id = engine.fingerprint_ids[i];
        let fp_str = &engine.fingerprint_strings[fp_id as usize];
        let remote_id = engine.remote_ids[i];
        let remote_str = &engine.remote_strings[remote_id as usize];
        let user_str = engine.user_strings.get(u_id as usize).map(|s| s.as_str()).unwrap_or("");

        if !search_lower.is_empty() {
            let matches_ns = ns_str.to_lowercase().contains(&search_lower);
            let matches_fp = fp_str.to_lowercase().contains(&search_lower);
            let matches_plan = engine.plan_strings[plan_id as usize]
                .to_lowercase()
                .contains(&search_lower);
            let matches_remote = remote_str.to_lowercase().contains(&search_lower);
            let matches_user = user_str.to_lowercase().contains(&search_lower);
            if !matches_ns && !matches_fp && !matches_plan && !matches_remote && !matches_user {
                continue;
            }
        }

        matched_indices.push(i);
        all_durations.push(dur);

        sum_duration += dur as u64;
        if dur > max_duration {
            max_duration = dur;
        }
        if is_coll {
            total_collscans += 1;
        }
        total_docs += docs as u64;
        total_keys += engine.keys_examined[i] as u64;
        total_returned += ret as u64;

        // Group by pattern (composite key ensures collections and plans never collide)
        let pattern_key: u64 = ((ns_id as u64) << 48)
            | ((op as u64) << 40)
            | ((plan_id as u64) << 24)
            | (fp_id as u64);

        if let Some(acc) = pattern_map.get_mut(&pattern_key) {
            acc.count += 1;
            acc.total_duration_ms += dur as u64;
            if dur < acc.min_duration_ms {
                acc.min_duration_ms = dur;
            }
            if dur > acc.max_duration_ms {
                acc.max_duration_ms = dur;
            }
            acc.total_docs += docs as u64;
            acc.total_keys += engine.keys_examined[i] as u64;
            acc.total_returned += ret as u64;
            if is_coll {
                acc.collscan_count += 1;
            }
            acc.sample_durations.push(dur);
        } else {
            pattern_map.insert(
                pattern_key,
                PatternAcc {
                    fp_id,
                    ns_id,
                    plan_id,
                    op,
                    is_collscan: is_coll,
                    count: 1,
                    total_duration_ms: dur as u64,
                    min_duration_ms: dur,
                    max_duration_ms: dur,
                    total_docs: docs as u64,
                    total_keys: engine.keys_examined[i] as u64,
                    total_returned: ret as u64,
                    collscan_count: if is_coll { 1 } else { 0 },
                    sample_durations: vec![dur],
                    first_query_idx: i,
                },
            );
        }

        // Group by collection
        if let Some(c_acc) = collection_map.get_mut(&ns_id) {
            c_acc.count += 1;
            c_acc.total_duration_ms += dur as u64;
            if dur > c_acc.max_duration_ms {
                c_acc.max_duration_ms = dur;
            }
            if is_coll {
                c_acc.collscan_count += 1;
            }
            c_acc.total_docs += docs as u64;
            c_acc.total_returned += ret as u64;
            c_acc.sample_durations.push(dur);
        } else {
            collection_map.insert(
                ns_id,
                CollectionAcc {
                    ns_id,
                    count: 1,
                    total_duration_ms: dur as u64,
                    max_duration_ms: dur,
                    collscan_count: if is_coll { 1 } else { 0 },
                    total_docs: docs as u64,
                    total_returned: ret as u64,
                    sample_durations: vec![dur],
                },
            );
        }

        // Group by hour
        let ts_ms = engine.timestamps_ms[i];
        let sec = (ts_ms / 1000) as i64;
        let hour = (((sec % 86400) + 86400) % 86400 / 3600) as usize;

        if let Some(t_acc) = &mut time_buckets[hour] {
            t_acc.count += 1;
            t_acc.total_duration_ms += dur as u64;
            if dur > t_acc.max_duration_ms {
                t_acc.max_duration_ms = dur;
            }
            if is_coll {
                t_acc.collscan_count += 1;
            }
            t_acc.sample_durations.push(dur);
        } else {
            time_buckets[hour] = Some(TimeBucketAcc {
                hour: hour as u8,
                count: 1,
                collscan_count: if is_coll { 1 } else { 0 },
                total_duration_ms: dur as u64,
                max_duration_ms: dur,
                sample_durations: vec![dur],
            });
        }

        // Group by user
        if let Some(u_acc) = user_map.get_mut(&u_id) {
            u_acc.count += 1;
            u_acc.total_duration_ms += dur as u64;
            if dur > u_acc.max_duration_ms {
                u_acc.max_duration_ms = dur;
            }
            if dur < u_acc.min_duration_ms {
                u_acc.min_duration_ms = dur;
            }
            if is_coll {
                u_acc.collscan_count += 1;
            }
            u_acc.total_docs += docs as u64;
            u_acc.total_keys += engine.keys_examined[i] as u64;
            u_acc.total_returned += ret as u64;
            u_acc.sample_durations.push(dur);
            *u_acc.ops.entry(op).or_insert(0) += 1;
            let c_entry = u_acc.colls.entry(ns_id).or_insert((0, 0, 0));
            c_entry.0 += 1;
            c_entry.1 += dur as u64;
            if is_coll {
                c_entry.2 += 1;
            }
        } else {
            let mut ops = HashMap::new();
            ops.insert(op, 1);
            let mut colls = HashMap::new();
            colls.insert(ns_id, (1, dur as u64, if is_coll { 1 } else { 0 }));
            user_map.insert(
                u_id,
                UserQueryAcc {
                    count: 1,
                    collscan_count: if is_coll { 1 } else { 0 },
                    total_duration_ms: dur as u64,
                    min_duration_ms: dur,
                    max_duration_ms: dur,
                    total_docs: docs as u64,
                    total_keys: engine.keys_examined[i] as u64,
                    total_returned: ret as u64,
                    sample_durations: vec![dur],
                    ops,
                    colls,
                },
            );
        }
    }

    let matched_count = matched_indices.len();
    all_durations.sort_unstable();

    let p50 = calc_percentile(&all_durations, 50.0);
    let p90 = calc_percentile(&all_durations, 90.0);
    let p95 = calc_percentile(&all_durations, 95.0);
    let p99 = calc_percentile(&all_durations, 99.0);
    let avg_dur = if matched_count > 0 {
        (sum_duration as f64) / (matched_count as f64)
    } else {
        0.0
    };
    let overall_scan_ratio = if total_returned > 0 {
        (total_docs as f64) / (total_returned as f64)
    } else {
        total_docs as f64
    };

    // Pre-allocate 1MB output buffer to prevent reallocations
    let mut out = String::with_capacity(1024 * 1024);
    out.push_str("{\"summary\":{");
    let _ = write!(
        out,
        "\"totalLines\":{},\"slowQueryCount\":{},\"collscanCount\":{},\"avgDurationMs\":{:.1},\"p50DurationMs\":{},\"p90DurationMs\":{},\"p95DurationMs\":{},\"p99DurationMs\":{},\"maxDurationMs\":{},\"totalDocsExamined\":{},\"totalKeysExamined\":{},\"totalReturned\":{},\"overallScanRatio\":{:.1},\"uniquePatterns\":{},\"uniqueCollections\":{}",
        engine.total_lines,
        matched_count,
        total_collscans,
        avg_dur,
        p50,
        p90,
        p95,
        p99,
        max_duration,
        total_docs,
        total_keys,
        total_returned,
        overall_scan_ratio,
        pattern_map.len(),
        collection_map.len()
    );
    out.push_str("},");

    // Patterns
    out.push_str("\"patterns\":[");
    let mut patterns: Vec<PatternAcc> = pattern_map.into_values().collect();
    patterns.sort_by(|a, b| b.total_duration_ms.cmp(&a.total_duration_ms));

    for (p_idx, p) in patterns.iter_mut().enumerate() {
        if p_idx > 0 {
            out.push(',');
        }
        let ns = &engine.ns_strings[p.ns_id as usize];
        let (db, collection) = if let Some(dot) = ns.find('.') {
            (&ns[..dot], &ns[dot + 1..])
        } else {
            ("unknown", ns.as_str())
        };
        let fp = &engine.fingerprint_strings[p.fp_id as usize];
        let plan = &engine.plan_strings[p.plan_id as usize];
        let sug = &engine.index_suggestions[p.fp_id as usize];

        p.sample_durations.sort_unstable();
        let p_p50 = calc_percentile(&p.sample_durations, 50.0);
        let p_p90 = calc_percentile(&p.sample_durations, 90.0);
        let p_p95 = calc_percentile(&p.sample_durations, 95.0);
        let p_p99 = calc_percentile(&p.sample_durations, 99.0);
        let p_avg = (p.total_duration_ms as f64) / (p.count as f64);
        let p_scan_ratio = (p.total_docs as f64) / ((p.total_returned as f64).max(1.0));

        let _ = write!(out, "{{\"id\":\"pat-{}\",\"ns\":\"", p_idx);
        write_escaped_json(&mut out, ns);
        out.push_str("\",\"db\":\"");
        write_escaped_json(&mut out, db);
        out.push_str("\",\"collection\":\"");
        write_escaped_json(&mut out, collection);
        let _ = write!(
            out,
            "\",\"op\":\"{}\",\"fingerprint\":\"",
            MongoOp::from_u8(p.op).as_str()
        );
        write_escaped_json(&mut out, fp);
        out.push_str("\",\"planSummary\":\"");
        write_escaped_json(&mut out, plan);
        let _ = write!(
            out,
            "\",\"isCollscan\":{},\"count\":{},\"totalDurationMs\":{},\"avgDurationMs\":{:.1},\"minDurationMs\":{},\"maxDurationMs\":{},\"p50DurationMs\":{},\"p90DurationMs\":{},\"p95DurationMs\":{},\"p99DurationMs\":{},\"totalDocsExamined\":{},\"avgDocsExamined\":{:.1},\"totalKeysExamined\":{},\"avgKeysExamined\":{:.1},\"totalReturned\":{},\"avgReturned\":{:.1},\"scanRatio\":{:.1},\"collscanCount\":{},\"indexSuggestion\":\"",
            p.is_collscan,
            p.count,
            p.total_duration_ms,
            p_avg,
            p.min_duration_ms,
            p.max_duration_ms,
            p_p50,
            p_p90,
            p_p95,
            p_p99,
            p.total_docs,
            (p.total_docs as f64) / (p.count as f64),
            p.total_keys,
            (p.total_keys as f64) / (p.count as f64),
            p.total_returned,
            (p.total_returned as f64) / (p.count as f64),
            p_scan_ratio,
            p.collscan_count
        );
        write_escaped_json(&mut out, sug);
        out.push_str("\",\"exampleQuery\":{");

        let ex_remote = &engine.remote_strings[engine.remote_ids[p.first_query_idx] as usize];
        let _ = write!(out, "\"id\":\"query-example-{}\",\"timestamp\":\"", p_idx);
        write_epoch_to_iso(&mut out, engine.timestamps_ms[p.first_query_idx]);
        let _ = write!(
            out,
            "\",\"epochMs\":{},\"severity\":\"I\",\"component\":\"COMMAND\",\"ctx\":\"\",\"ns\":\"",
            engine.timestamps_ms[p.first_query_idx]
        );
        write_escaped_json(&mut out, ns);
        out.push_str("\",\"db\":\"");
        write_escaped_json(&mut out, db);
        out.push_str("\",\"collection\":\"");
        write_escaped_json(&mut out, collection);
        let _ = write!(
            out,
            "\",\"op\":\"{}\",\"durationMs\":{},\"planSummary\":\"",
            MongoOp::from_u8(p.op).as_str(),
            engine.durations_ms[p.first_query_idx]
        );
        write_escaped_json(&mut out, plan);
        let ex_docs = engine.docs_examined[p.first_query_idx];
        let ex_ret = engine.nreturned[p.first_query_idx];
        let ex_scan_ratio = (ex_docs as f64) / ((ex_ret as f64).max(1.0));
        let _ = write!(
            out,
            "\",\"isCollscan\":{},\"keysExamined\":{},\"docsExamined\":{},\"nreturned\":{},\"scanRatio\":{:.1},\"numYields\":{},\"reslen\":{},\"remote\":\"",
            p.is_collscan,
            engine.keys_examined[p.first_query_idx],
            ex_docs,
            ex_ret,
            ex_scan_ratio,
            engine.num_yields[p.first_query_idx],
            engine.reslens[p.first_query_idx]
        );
        write_escaped_json(&mut out, ex_remote);
        let _ = write!(
            out,
            "\",\"command\":{{\"operation\":\"{}\",\"collection\":\"",
            MongoOp::from_u8(p.op).as_str()
        );
        write_escaped_json(&mut out, collection);
        out.push_str("\",\"planSummary\":\"");
        write_escaped_json(&mut out, plan);
        out.push_str("\",\"fingerprint\":\"");
        write_escaped_json(&mut out, fp);
        out.push_str("\"},\"fingerprint\":\"");
        write_escaped_json(&mut out, fp);
        out.push_str("\",\"indexSuggestion\":\"");
        write_escaped_json(&mut out, sug);
        out.push_str("\"}}");
    }
    out.push_str("],");

    // Collections
    out.push_str("\"collections\":[");
    let mut collections: Vec<CollectionAcc> = collection_map.into_values().collect();
    collections.sort_by(|a, b| b.total_duration_ms.cmp(&a.total_duration_ms));

    for (c_idx, c) in collections.iter_mut().enumerate() {
        if c_idx > 0 {
            out.push(',');
        }
        let ns = &engine.ns_strings[c.ns_id as usize];
        let (db, collection) = if let Some(dot) = ns.find('.') {
            (&ns[..dot], &ns[dot + 1..])
        } else {
            ("unknown", ns.as_str())
        };
        c.sample_durations.sort_unstable();
        let c_p95 = calc_percentile(&c.sample_durations, 95.0);
        let c_avg = (c.total_duration_ms as f64) / (c.count as f64);
        let c_scan_ratio = (c.total_docs as f64) / ((c.total_returned as f64).max(1.0));

        out.push_str("{\"ns\":\"");
        write_escaped_json(&mut out, ns);
        out.push_str("\",\"collection\":\"");
        write_escaped_json(&mut out, collection);
        out.push_str("\",\"db\":\"");
        write_escaped_json(&mut out, db);
        let _ = write!(
            out,
            "\",\"queryCount\":{},\"totalDurationMs\":{},\"avgDurationMs\":{:.1},\"maxDurationMs\":{},\"p95DurationMs\":{},\"collscanCount\":{},\"totalDocsExamined\":{},\"totalReturned\":{},\"scanRatio\":{:.1}}}",
            c.count,
            c.total_duration_ms,
            c_avg,
            c.max_duration_ms,
            c_p95,
            c.collscan_count,
            c.total_docs,
            c.total_returned,
            c_scan_ratio
        );
    }
    out.push_str("],");

    // Time Buckets
    out.push_str("\"timeBuckets\":[");
    let mut t_idx = 0;
    for hour in 0..24 {
        if let Some(tb) = &mut time_buckets[hour] {
            if t_idx > 0 {
                out.push(',');
            }
            t_idx += 1;
            tb.sample_durations.sort_unstable();
            let tb_p95 = calc_percentile(&tb.sample_durations, 95.0);
            let tb_avg = (tb.total_duration_ms as f64) / (tb.count as f64);

            let _ = write!(
                out,
                "{{\"timeKey\":\"{:02}:00\",\"hourLabel\":\"{:02}:00\",\"queryCount\":{},\"collscanCount\":{},\"avgDurationMs\":{:.1},\"p95DurationMs\":{},\"maxDurationMs\":{},\"ops\":{{}}}}",
                hour,
                hour,
                tb.count,
                tb.collscan_count,
                tb_avg,
                tb_p95,
                tb.max_duration_ms
            );
        }
    }
    out.push_str("],");

    // Top Slow Queries (up to 300 queries for the virtualized slow queries table)
    out.push_str("\"slowQueries\":[");
    let k = matched_indices.len().min(300);
    let mut top_slow = matched_indices;
    if top_slow.len() > k {
        top_slow.select_nth_unstable_by(k - 1, |&a, &b| {
            engine.durations_ms[b].cmp(&engine.durations_ms[a]).then_with(|| a.cmp(&b))
        });
        top_slow.truncate(k);
    }
    top_slow.sort_by(|&a, &b| engine.durations_ms[b].cmp(&engine.durations_ms[a]).then_with(|| a.cmp(&b)));

    for (q_idx, &idx) in top_slow.iter().enumerate() {
        if q_idx > 0 {
            out.push(',');
        }
        let ns = &engine.ns_strings[engine.ns_ids[idx] as usize];
        let (db, collection) = if let Some(dot) = ns.find('.') {
            (&ns[..dot], &ns[dot + 1..])
        } else {
            ("unknown", ns.as_str())
        };
        let fp = &engine.fingerprint_strings[engine.fingerprint_ids[idx] as usize];
        let plan = &engine.plan_strings[engine.plan_ids[idx] as usize];
        let is_coll = engine.is_collscan[idx];
        let sug = &engine.index_suggestions[engine.fingerprint_ids[idx] as usize];
        let docs = engine.docs_examined[idx];
        let ret = engine.nreturned[idx];
        let scan_ratio = (docs as f64) / ((ret as f64).max(1.0));

        let u_id = engine.user_ids.get(idx).copied().unwrap_or(0);
        let user_name = engine.user_strings.get(u_id as usize).map(|s| s.as_str()).unwrap_or("system");
        let ctx_id = engine.ctx_ids.get(idx).copied().unwrap_or(u16::MAX);
        let ctx_str = if ctx_id != u16::MAX {
            engine.ctx_strings.get(ctx_id as usize).map(|s| s.as_str()).unwrap_or("")
        } else {
            ""
        };
        let remote = &engine.remote_strings[engine.remote_ids[idx] as usize];

        let _ = write!(out, "{{\"id\":\"query-{}\",\"timestamp\":\"", idx);
        write_epoch_to_iso(&mut out, engine.timestamps_ms[idx]);
        let _ = write!(
            out,
            "\",\"epochMs\":{},\"severity\":\"I\",\"component\":\"COMMAND\",\"ctx\":\"",
            engine.timestamps_ms[idx]
        );
        write_escaped_json(&mut out, ctx_str);
        out.push_str("\",\"user\":\"");
        write_escaped_json(&mut out, user_name);
        out.push_str("\",\"ns\":\"");
        write_escaped_json(&mut out, ns);
        out.push_str("\",\"db\":\"");
        write_escaped_json(&mut out, db);
        out.push_str("\",\"collection\":\"");
        write_escaped_json(&mut out, collection);
        let _ = write!(
            out,
            "\",\"op\":\"{}\",\"durationMs\":{},\"planSummary\":\"",
            MongoOp::from_u8(engine.op_ids[idx]).as_str(),
            engine.durations_ms[idx]
        );
        write_escaped_json(&mut out, plan);
        let _ = write!(
            out,
            "\",\"isCollscan\":{},\"keysExamined\":{},\"docsExamined\":{},\"nreturned\":{},\"scanRatio\":{:.1},\"numYields\":{},\"reslen\":{},\"remote\":\"",
            is_coll,
            engine.keys_examined[idx],
            docs,
            ret,
            scan_ratio,
            engine.num_yields[idx],
            engine.reslens[idx]
        );
        write_escaped_json(&mut out, remote);
        let _ = write!(
            out,
            "\",\"command\":{{\"operation\":\"{}\",\"collection\":\"",
            MongoOp::from_u8(engine.op_ids[idx]).as_str()
        );
        write_escaped_json(&mut out, collection);
        out.push_str("\",\"planSummary\":\"");
        write_escaped_json(&mut out, plan);
        out.push_str("\",\"fingerprint\":\"");
        write_escaped_json(&mut out, fp);
        out.push_str("\",\"user\":\"");
        write_escaped_json(&mut out, user_name);
        out.push_str("\",\"ctx\":\"");
        write_escaped_json(&mut out, ctx_str);
        out.push_str("\"},\"fingerprint\":\"");
        write_escaped_json(&mut out, fp);
        out.push_str("\",\"indexSuggestion\":\"");
        write_escaped_json(&mut out, sug);
        out.push_str("\"}");
    }
    out.push_str("],");

    // Diagnostics: Connections
    out.push_str("\"connections\":{");
    let _ = write!(
        out,
        "\"accepted\":{},\"ended\":{},\"peakConcurrent\":{},\"authSuccess\":{},\"authFailed\":{},\"drivers\":[",
        engine.conn_accepted, engine.conn_ended, engine.conn_peak, engine.auth_success, engine.auth_fail
    );
    for (d_idx, d) in engine.drivers.iter().enumerate() {
        if d_idx > 0 {
            out.push(',');
        }
        out.push_str("{\"driverName\":\"");
        write_escaped_json(&mut out, &d.name);
        out.push_str("\",\"driverVersion\":\"");
        write_escaped_json(&mut out, &d.version);
        out.push_str("\",\"platform\":\"");
        write_escaped_json(&mut out, &d.platform);
        out.push_str("\",\"osName\":\"");
        write_escaped_json(&mut out, &d.os_name);
        out.push_str("\",\"osVersion\":\"");
        write_escaped_json(&mut out, &d.os_version);
        let _ = write!(out, "\",\"count\":{}}}", d.count);
    }
    out.push_str("],\"clientIps\":[]},");

    // Diagnostics: Errors
    out.push_str("\"errors\":[");
    for (e_idx, e) in engine.errors.iter().enumerate() {
        if e_idx > 0 {
            out.push(',');
        }
        let sev = match e.severity {
            b'W' => "W",
            b'E' => "E",
            b'F' => "F",
            _ => "I",
        };
        out.push_str("{\"timestamp\":\"");
        write_escaped_json(&mut out, &e.timestamp);
        let _ = write!(
            out,
            "\",\"severity\":\"{}\",\"component\":\"COMMAND\",\"id\":{},\"msg\":\"",
            sev, e.id
        );
        write_escaped_json(&mut out, &e.msg);
        let _ = write!(out, "\",\"count\":{}}}", e.count);
    }
    out.push_str("],");

    // Diagnostics: Checkpoints
    out.push_str("\"checkpoints\":[");
    for (ck_idx, ck) in engine.checkpoints.iter().enumerate() {
        if ck_idx > 0 {
            out.push(',');
        }
        out.push_str("{\"timestamp\":\"");
        write_escaped_json(&mut out, &ck.timestamp);
        out.push_str("\",\"msg\":\"");
        write_escaped_json(&mut out, &ck.msg);
        out.push_str("\"}");
    }
    out.push_str("],");

    // Dates
    out.push_str("\"dates\":[");
    for (d_idx, d) in engine.dates.iter().enumerate() {
        if d_idx > 0 {
            out.push(',');
        }
        out.push('"');
        write_escaped_json(&mut out, d);
        out.push('"');
    }
    out.push_str("],");

    // Operations
    out.push_str("\"operations\":[");
    let mut ops_seen: Vec<&str> = Vec::with_capacity(8);
    for op in 1..=8 {
        if (engine.ops_mask & (1 << op)) != 0 {
            ops_seen.push(MongoOp::from_u8(op).as_str());
        }
    }
    ops_seen.sort_unstable();
    for (o_idx, op) in ops_seen.iter().enumerate() {
        if o_idx > 0 {
            out.push(',');
        }
        out.push('"');
        out.push_str(op);
        out.push('"');
    }
    out.push_str("],");

    // Users aggregation
    out.push_str("\"users\":[");
    let mut candidate_uids: Vec<u16> = (0..engine.user_strings.len() as u16).collect();
    candidate_uids.sort_by(|&a, &b| {
        let a_is_sys = a == 0;
        let b_is_sys = b == 0;
        if a_is_sys != b_is_sys {
            return a_is_sys.cmp(&b_is_sys); // non-system before system
        }
        let a_cnt = user_map.get(&a).map(|u| u.count).unwrap_or(0);
        let b_cnt = user_map.get(&b).map(|u| u.count).unwrap_or(0);
        b_cnt.cmp(&a_cnt).then_with(|| a.cmp(&b))
    });

    for (u_idx, &uid) in candidate_uids.iter().enumerate() {
        if u_idx > 0 {
            out.push(',');
        }
        let u_name = engine.user_strings.get(uid as usize).map(|s| s.as_str()).unwrap_or("system");
        let default_meta = crate::store::UserMeta::default();
        let meta = engine.user_meta.get(uid as usize).unwrap_or(&default_meta);

        let (count, collscan_count, total_dur, min_dur, max_dur, p95_dur, avg_dur, total_docs, total_keys, total_ret, scan_ratio, ops_map, top_colls) = 
            if let Some(u_acc) = user_map.get_mut(&uid) {
                u_acc.sample_durations.sort_unstable();
                let p95 = calc_percentile(&u_acc.sample_durations, 95.0);
                let avg = (u_acc.total_duration_ms as f64) / (u_acc.count as f64);
                let ratio = (u_acc.total_docs as f64) / ((u_acc.total_returned as f64).max(1.0));

                let mut coll_vec: Vec<(&u16, &(u32, u64, u32))> = u_acc.colls.iter().collect();
                coll_vec.sort_by(|a, b| b.1.0.cmp(&a.1.0));

                (u_acc.count, u_acc.collscan_count, u_acc.total_duration_ms, u_acc.min_duration_ms, u_acc.max_duration_ms, p95, avg, u_acc.total_docs, u_acc.total_keys, u_acc.total_returned, ratio, Some(&u_acc.ops), coll_vec)
            } else {
                (0, 0, 0, 0, 0, 0, 0.0, 0, 0, 0, 0.0, None, Vec::new())
            };

        out.push_str("{\"userName\":\"");
        write_escaped_json(&mut out, u_name);
        out.push_str("\",\"authDb\":\"");
        write_escaped_json(&mut out, &meta.auth_db);
        out.push_str("\",\"appName\":\"");
        write_escaped_json(&mut out, &meta.app_name);
        out.push_str("\",\"clientIps\":[");
        for (ip_idx, ip) in meta.client_ips.iter().enumerate() {
            if ip_idx > 0 { out.push(','); }
            out.push('"');
            write_escaped_json(&mut out, ip);
            out.push('"');
        }
        out.push_str("],");
        let _ = write!(
            out,
            "\"totalOperations\":{},\"slowQueryCount\":{},\"collscanCount\":{},\"totalDurationMs\":{},\"avgDurationMs\":{:.1},\"minDurationMs\":{},\"maxDurationMs\":{},\"p95DurationMs\":{},\"totalDocsExamined\":{},\"totalKeysExamined\":{},\"totalReturned\":{},\"scanRatio\":{:.1},\"firstActive\":\"",
            count,
            count,
            collscan_count,
            total_dur,
            avg_dur,
            min_dur,
            max_dur,
            p95_dur,
            total_docs,
            total_keys,
            total_ret,
            scan_ratio
        );
        if meta.first_seen_ms > 0 {
            write_epoch_to_iso(&mut out, meta.first_seen_ms);
        }
        out.push_str("\",\"lastActive\":\"");
        if meta.last_seen_ms > 0 {
            write_epoch_to_iso(&mut out, meta.last_seen_ms);
        }
        let _ = write!(
            out,
            "\",\"authSuccessCount\":{},\"authFailCount\":{},\"operations\":{{",
            meta.auth_success_count,
            meta.auth_fail_count
        );
        if let Some(ops) = ops_map {
            let mut o_entries: Vec<(&u8, &u32)> = ops.iter().collect();
            o_entries.sort_by(|a, b| b.1.cmp(a.1));
            for (oi, (op_code, cnt)) in o_entries.into_iter().enumerate() {
                if oi > 0 { out.push(','); }
                let _ = write!(out, "\"{}\":{}", MongoOp::from_u8(*op_code).as_str(), cnt);
            }
        }
        out.push_str("},\"topCollections\":[");
        for (ci, (ns_id, (cnt, dur, collscans))) in top_colls.into_iter().take(20).enumerate() {
            if ci > 0 { out.push(','); }
            let ns_str = &engine.ns_strings[*ns_id as usize];
            out.push_str("{\"ns\":\"");
            write_escaped_json(&mut out, ns_str);
            let _ = write!(
                out,
                "\",\"count\":{},\"totalDurationMs\":{},\"collscanCount\":{}}}",
                cnt, dur, collscans
            );
        }
        out.push_str("]}");
    }
    out.push_str("],\"userNames\":[");
    let mut names_list: Vec<&str> = Vec::new();
    for &uid in &candidate_uids {
        let name = engine.user_strings.get(uid as usize).map(|s| s.as_str()).unwrap_or("");
        if !name.is_empty() && !names_list.contains(&name) {
            names_list.push(name);
        }
    }
    for (ni, name) in names_list.iter().enumerate() {
        if ni > 0 { out.push(','); }
        out.push('"');
        write_escaped_json(&mut out, name);
        out.push('"');
    }
    out.push_str("]}");

    out
}

#[inline(always)]
fn calc_percentile(sorted: &[u32], p: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = (((sorted.len() as f64) * (p / 100.0)).ceil() as usize).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

#[inline]
pub fn write_escaped_json(out: &mut String, s: &str) {
    let bytes = s.as_bytes();
    let mut last = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let esc = match b {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            _ => continue,
        };
        if i > last {
            // SAFETY: original string is valid UTF-8, ascii char boundary slice is valid UTF-8
            out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[last..i]) });
        }
        out.push_str(esc);
        last = i + 1;
    }
    if last < bytes.len() {
        // SAFETY: original string is valid UTF-8, ascii char boundary slice is valid UTF-8
        out.push_str(unsafe { std::str::from_utf8_unchecked(&bytes[last..]) });
    }
}

pub fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    write_escaped_json(&mut out, s);
    out
}

pub fn write_epoch_to_iso(out: &mut String, epoch_ms: i64) {
    if epoch_ms <= 0 {
        out.push_str("1970-01-01T00:00:00.000Z");
        return;
    }
    let total_sec = epoch_ms / 1000;
    let millis = epoch_ms % 1000;
    let sec_in_day = (total_sec % 86400 + 86400) % 86400;
    let hour = sec_in_day / 3600;
    let min = (sec_in_day % 3600) / 60;
    let sec = sec_in_day % 60;

    let mut days = total_sec / 86400;
    let mut year = 1970;
    loop {
        let leap = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 1 } else { 0 };
        let days_in_year = 365 + leap;
        if days >= days_in_year {
            days -= days_in_year;
            year += 1;
        } else {
            break;
        }
    }
    let leap = if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) { 1 } else { 0 };
    let month_days = [31, 28 + leap, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 1;
    for &d in &month_days {
        if days >= d {
            days -= d;
            month += 1;
        } else {
            break;
        }
    }
    let day = days + 1;
    let _ = write!(
        out,
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, min, sec, millis
    );
}

pub fn epoch_to_iso(epoch_ms: i64) -> String {
    let mut out = String::with_capacity(24);
    write_epoch_to_iso(&mut out, epoch_ms);
    out
}
