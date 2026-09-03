//! Fast reaggregation kernel in Rust.

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
    date_str: String,
    count: u32,
    collscan_count: u32,
    total_duration_ms: u64,
    max_duration_ms: u32,
    sample_durations: Vec<u32>,
}

pub fn reaggregate(engine: &Engine, filters: FilterParams) -> String {
    let n = engine.durations_ms.len();

    let mut pattern_map: HashMap<u64, PatternAcc> = HashMap::new();
    let mut collection_map: HashMap<u16, CollectionAcc> = HashMap::new();
    let mut time_map: HashMap<String, TimeBucketAcc> = HashMap::new();

    let mut matched_indices = Vec::with_capacity(n.min(32768));
    let mut all_durations = Vec::with_capacity(n.min(32768));

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

        if !search_lower.is_empty() {
            let matches_ns = ns_str.to_lowercase().contains(&search_lower);
            let matches_fp = fp_str.to_lowercase().contains(&search_lower);
            let matches_plan = engine.plan_strings[plan_id as usize]
                .to_lowercase()
                .contains(&search_lower);
            let matches_remote = remote_str.to_lowercase().contains(&search_lower);
            if !matches_ns && !matches_fp && !matches_plan && !matches_remote {
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
        let hour = (((sec % 86400) + 86400) % 86400 / 3600) as u8;
        let hour_key = format!("{:02}:00", hour);

        if let Some(t_acc) = time_map.get_mut(&hour_key) {
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
            time_map.insert(
                hour_key.clone(),
                TimeBucketAcc {
                    hour,
                    date_str: hour_key,
                    count: 1,
                    collscan_count: if is_coll { 1 } else { 0 },
                    total_duration_ms: dur as u64,
                    max_duration_ms: dur,
                    sample_durations: vec![dur],
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

    // Serialize to JSON String
    let mut out = String::with_capacity(65536);
    out.push_str("{\"summary\":{");
    out.push_str(&format!("\"totalLines\":{},", engine.total_lines));
    out.push_str(&format!("\"slowQueryCount\":{},", matched_count));
    out.push_str(&format!("\"collscanCount\":{},", total_collscans));
    out.push_str(&format!("\"avgDurationMs\":{:.1},", avg_dur));
    out.push_str(&format!("\"p50DurationMs\":{},", p50));
    out.push_str(&format!("\"p90DurationMs\":{},", p90));
    out.push_str(&format!("\"p95DurationMs\":{},", p95));
    out.push_str(&format!("\"p99DurationMs\":{},", p99));
    out.push_str(&format!("\"maxDurationMs\":{},", max_duration));
    out.push_str(&format!("\"totalDocsExamined\":{},", total_docs));
    out.push_str(&format!("\"totalKeysExamined\":{},", total_keys));
    out.push_str(&format!("\"totalReturned\":{},", total_returned));
    out.push_str(&format!("\"overallScanRatio\":{:.1},", overall_scan_ratio));
    out.push_str(&format!("\"uniquePatterns\":{},", pattern_map.len()));
    out.push_str(&format!("\"uniqueCollections\":{}", collection_map.len()));
    out.push_str("},");

    // Patterns
    out.push_str("\"patterns\":[");
    let mut patterns: Vec<PatternAcc> = pattern_map.into_values().collect();
    patterns.sort_by(|a, b| b.total_duration_ms.cmp(&a.total_duration_ms));

    for (p_idx, p) in patterns.iter().enumerate() {
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

        let mut sorted_durs = p.sample_durations.clone();
        sorted_durs.sort_unstable();
        let p_p50 = calc_percentile(&sorted_durs, 50.0);
        let p_p90 = calc_percentile(&sorted_durs, 90.0);
        let p_p95 = calc_percentile(&sorted_durs, 95.0);
        let p_p99 = calc_percentile(&sorted_durs, 99.0);
        let p_avg = (p.total_duration_ms as f64) / (p.count as f64);
        let p_scan_ratio = (p.total_docs as f64) / ((p.total_returned as f64).max(1.0));

        out.push_str("{");
        out.push_str(&format!("\"id\":\"pat-{}\",", p_idx));
        out.push_str(&format!("\"ns\":\"{}\",", escape_json(ns)));
        out.push_str(&format!("\"db\":\"{}\",", escape_json(db)));
        out.push_str(&format!("\"collection\":\"{}\",", escape_json(collection)));
        out.push_str(&format!("\"op\":\"{}\",", MongoOp::from_u8(p.op).as_str()));
        out.push_str(&format!("\"fingerprint\":\"{}\",", escape_json(fp)));
        out.push_str(&format!("\"planSummary\":\"{}\",", escape_json(plan)));
        out.push_str(&format!("\"isCollscan\":{},", p.is_collscan));
        out.push_str(&format!("\"count\":{},", p.count));
        out.push_str(&format!("\"totalDurationMs\":{},", p.total_duration_ms));
        out.push_str(&format!("\"avgDurationMs\":{:.1},", p_avg));
        out.push_str(&format!("\"minDurationMs\":{},", p.min_duration_ms));
        out.push_str(&format!("\"maxDurationMs\":{},", p.max_duration_ms));
        out.push_str(&format!("\"p50DurationMs\":{},", p_p50));
        out.push_str(&format!("\"p90DurationMs\":{},", p_p90));
        out.push_str(&format!("\"p95DurationMs\":{},", p_p95));
        out.push_str(&format!("\"p99DurationMs\":{},", p_p99));
        out.push_str(&format!("\"totalDocsExamined\":{},", p.total_docs));
        out.push_str(&format!("\"avgDocsExamined\":{:.1},", (p.total_docs as f64) / (p.count as f64)));
        out.push_str(&format!("\"totalKeysExamined\":{},", p.total_keys));
        out.push_str(&format!("\"avgKeysExamined\":{:.1},", (p.total_keys as f64) / (p.count as f64)));
        out.push_str(&format!("\"totalReturned\":{},", p.total_returned));
        out.push_str(&format!("\"avgReturned\":{:.1},", (p.total_returned as f64) / (p.count as f64)));
        out.push_str(&format!("\"scanRatio\":{:.1},", p_scan_ratio));
        out.push_str(&format!("\"collscanCount\":{},", p.collscan_count));
        out.push_str(&format!("\"indexSuggestion\":\"{}\",", escape_json(sug)));

        // Example query
        let ex_remote = &engine.remote_strings[engine.remote_ids[p.first_query_idx] as usize];
        out.push_str("\"exampleQuery\":{");
        out.push_str(&format!("\"id\":\"query-example-{}\",", p_idx));
        out.push_str(&format!("\"timestamp\":\"{}\",", epoch_to_iso(engine.timestamps_ms[p.first_query_idx])));
        out.push_str(&format!("\"epochMs\":{},", engine.timestamps_ms[p.first_query_idx]));
        out.push_str(&format!("\"severity\":\"I\","));
        out.push_str(&format!("\"component\":\"COMMAND\","));
        out.push_str(&format!("\"ctx\":\"\","));
        out.push_str(&format!("\"ns\":\"{}\",", escape_json(ns)));
        out.push_str(&format!("\"db\":\"{}\",", escape_json(db)));
        out.push_str(&format!("\"collection\":\"{}\",", escape_json(collection)));
        out.push_str(&format!("\"op\":\"{}\",", MongoOp::from_u8(p.op).as_str()));
        out.push_str(&format!("\"durationMs\":{},", engine.durations_ms[p.first_query_idx]));
        out.push_str(&format!("\"planSummary\":\"{}\",", escape_json(plan)));
        out.push_str(&format!("\"isCollscan\":{},", p.is_collscan));
        out.push_str(&format!("\"keysExamined\":{},", engine.keys_examined[p.first_query_idx]));
        out.push_str(&format!("\"docsExamined\":{},", engine.docs_examined[p.first_query_idx]));
        out.push_str(&format!("\"nreturned\":{},", engine.nreturned[p.first_query_idx]));
        out.push_str(&format!("\"scanRatio\":{:.1},", p_scan_ratio));
        out.push_str(&format!("\"numYields\":{},", engine.num_yields[p.first_query_idx]));
        out.push_str(&format!("\"reslen\":{},", engine.reslens[p.first_query_idx]));
        out.push_str(&format!("\"remote\":\"{}\",", escape_json(ex_remote)));
        out.push_str(&format!(
            "\"command\":{{\"operation\":\"{}\",\"collection\":\"{}\",\"planSummary\":\"{}\",\"fingerprint\":\"{}\"}},",
            MongoOp::from_u8(p.op).as_str(),
            escape_json(collection),
            escape_json(plan),
            escape_json(fp)
        ));
        out.push_str(&format!("\"fingerprint\":\"{}\",", escape_json(fp)));
        out.push_str(&format!("\"indexSuggestion\":\"{}\"", escape_json(sug)));
        out.push_str("}");

        out.push('}');
    }
    out.push_str("],");

    // Collections
    out.push_str("\"collections\":[");
    let mut collections: Vec<CollectionAcc> = collection_map.into_values().collect();
    collections.sort_by(|a, b| b.total_duration_ms.cmp(&a.total_duration_ms));

    for (c_idx, c) in collections.iter().enumerate() {
        if c_idx > 0 {
            out.push(',');
        }
        let ns = &engine.ns_strings[c.ns_id as usize];
        let (db, collection) = if let Some(dot) = ns.find('.') {
            (&ns[..dot], &ns[dot + 1..])
        } else {
            ("unknown", ns.as_str())
        };
        let mut sorted = c.sample_durations.clone();
        sorted.sort_unstable();
        let c_p95 = calc_percentile(&sorted, 95.0);
        let c_avg = (c.total_duration_ms as f64) / (c.count as f64);
        let c_scan_ratio = (c.total_docs as f64) / ((c.total_returned as f64).max(1.0));

        out.push_str("{");
        out.push_str(&format!("\"ns\":\"{}\",", escape_json(ns)));
        out.push_str(&format!("\"collection\":\"{}\",", escape_json(collection)));
        out.push_str(&format!("\"db\":\"{}\",", escape_json(db)));
        out.push_str(&format!("\"queryCount\":{},", c.count));
        out.push_str(&format!("\"totalDurationMs\":{},", c.total_duration_ms));
        out.push_str(&format!("\"avgDurationMs\":{:.1},", c_avg));
        out.push_str(&format!("\"maxDurationMs\":{},", c.max_duration_ms));
        out.push_str(&format!("\"p95DurationMs\":{},", c_p95));
        out.push_str(&format!("\"collscanCount\":{},", c.collscan_count));
        out.push_str(&format!("\"totalDocsExamined\":{},", c.total_docs));
        out.push_str(&format!("\"totalReturned\":{},", c.total_returned));
        out.push_str(&format!("\"scanRatio\":{:.1}", c_scan_ratio));
        out.push('}');
    }
    out.push_str("],");

    // Time Buckets
    out.push_str("\"timeBuckets\":[");
    let mut time_buckets: Vec<TimeBucketAcc> = time_map.into_values().collect();
    time_buckets.sort_by(|a, b| a.hour.cmp(&b.hour));

    for (t_idx, tb) in time_buckets.iter().enumerate() {
        if t_idx > 0 {
            out.push(',');
        }
        let mut sorted = tb.sample_durations.clone();
        sorted.sort_unstable();
        let tb_p95 = calc_percentile(&sorted, 95.0);
        let tb_avg = (tb.total_duration_ms as f64) / (tb.count as f64);

        out.push_str("{");
        out.push_str(&format!("\"timeKey\":\"{}\",", tb.date_str));
        out.push_str(&format!("\"hourLabel\":\"{}\",", tb.date_str));
        out.push_str(&format!("\"queryCount\":{},", tb.count));
        out.push_str(&format!("\"collscanCount\":{},", tb.collscan_count));
        out.push_str(&format!("\"avgDurationMs\":{:.1},", tb_avg));
        out.push_str(&format!("\"p95DurationMs\":{},", tb_p95));
        out.push_str(&format!("\"maxDurationMs\":{},", tb.max_duration_ms));
        out.push_str("\"ops\":{}");
        out.push('}');
    }
    out.push_str("],");

    // Top Slow Queries (up to 300 queries for the virtualized slow queries table)
    out.push_str("\"slowQueries\":[");
    let mut top_slow: Vec<usize> = matched_indices.clone();
    top_slow.sort_by(|&a, &b| engine.durations_ms[b].cmp(&engine.durations_ms[a]));

    for (q_idx, &idx) in top_slow.iter().take(300).enumerate() {
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

        out.push_str("{");
        out.push_str(&format!("\"id\":\"query-{}\",", idx));
        out.push_str(&format!("\"timestamp\":\"{}\",", epoch_to_iso(engine.timestamps_ms[idx])));
        out.push_str(&format!("\"epochMs\":{},", engine.timestamps_ms[idx]));
        out.push_str(&format!("\"severity\":\"I\","));
        out.push_str(&format!("\"component\":\"COMMAND\","));
        out.push_str(&format!("\"ctx\":\"\","));
        out.push_str(&format!("\"ns\":\"{}\",", escape_json(ns)));
        out.push_str(&format!("\"db\":\"{}\",", escape_json(db)));
        out.push_str(&format!("\"collection\":\"{}\",", escape_json(collection)));
        out.push_str(&format!("\"op\":\"{}\",", MongoOp::from_u8(engine.op_ids[idx]).as_str()));
        out.push_str(&format!("\"durationMs\":{},", engine.durations_ms[idx]));
        out.push_str(&format!("\"planSummary\":\"{}\",", escape_json(plan)));
        out.push_str(&format!("\"isCollscan\":{},", is_coll));
        out.push_str(&format!("\"keysExamined\":{},", engine.keys_examined[idx]));
        out.push_str(&format!("\"docsExamined\":{},", docs));
        out.push_str(&format!("\"nreturned\":{},", ret));
        out.push_str(&format!("\"scanRatio\":{:.1},", scan_ratio));
        out.push_str(&format!("\"numYields\":{},", engine.num_yields[idx]));
        out.push_str(&format!("\"reslen\":{},", engine.reslens[idx]));
        let remote = &engine.remote_strings[engine.remote_ids[idx] as usize];
        out.push_str(&format!("\"remote\":\"{}\",", escape_json(remote)));
        out.push_str(&format!(
            "\"command\":{{\"operation\":\"{}\",\"collection\":\"{}\",\"planSummary\":\"{}\",\"fingerprint\":\"{}\"}},",
            MongoOp::from_u8(engine.op_ids[idx]).as_str(),
            escape_json(collection),
            escape_json(plan),
            escape_json(fp)
        ));
        out.push_str(&format!("\"fingerprint\":\"{}\",", escape_json(fp)));
        out.push_str(&format!("\"indexSuggestion\":\"{}\"", escape_json(sug)));
        out.push('}');
    }
    out.push_str("],");

    // Diagnostics: Connections
    out.push_str("\"connections\":{");
    out.push_str(&format!("\"accepted\":{},", engine.conn_accepted));
    out.push_str(&format!("\"ended\":{},", engine.conn_ended));
    out.push_str(&format!("\"peakConcurrent\":{},", engine.conn_peak));
    out.push_str(&format!("\"authSuccess\":{},", engine.auth_success));
    out.push_str(&format!("\"authFailed\":{},", engine.auth_fail));
    out.push_str("\"drivers\":[");
    for (d_idx, d) in engine.drivers.iter().enumerate() {
        if d_idx > 0 {
            out.push(',');
        }
        out.push_str("{");
        out.push_str(&format!("\"driverName\":\"{}\",", escape_json(&d.name)));
        out.push_str(&format!("\"driverVersion\":\"{}\",", escape_json(&d.version)));
        out.push_str(&format!("\"platform\":\"{}\",", escape_json(&d.platform)));
        out.push_str(&format!("\"osName\":\"{}\",", escape_json(&d.os_name)));
        out.push_str(&format!("\"osVersion\":\"{}\",", escape_json(&d.os_version)));
        out.push_str(&format!("\"count\":{}", d.count));
        out.push('}');
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
        out.push_str("{");
        out.push_str(&format!("\"timestamp\":\"{}\",", escape_json(&e.timestamp)));
        out.push_str(&format!("\"severity\":\"{}\",", sev));
        out.push_str(&format!("\"component\":\"COMMAND\","));
        out.push_str(&format!("\"id\":{},", e.id));
        out.push_str(&format!("\"msg\":\"{}\",", escape_json(&e.msg)));
        out.push_str(&format!("\"count\":{}", e.count));
        out.push('}');
    }
    out.push_str("],");

    // Diagnostics: Checkpoints
    out.push_str("\"checkpoints\":[");
    for (ck_idx, ck) in engine.checkpoints.iter().enumerate() {
        if ck_idx > 0 {
            out.push(',');
        }
        out.push_str("{");
        out.push_str(&format!("\"timestamp\":\"{}\",", escape_json(&ck.timestamp)));
        out.push_str(&format!("\"msg\":\"{}\"", escape_json(&ck.msg)));
        out.push('}');
    }
    out.push_str("],");

    // Dates
    out.push_str("\"dates\":[");
    for (d_idx, d) in engine.dates.iter().enumerate() {
        if d_idx > 0 {
            out.push(',');
        }
        out.push_str(&format!("\"{}\"", escape_json(d)));
    }
    out.push_str("],");

    // Operations
    out.push_str("\"operations\":[");
    let mut ops_seen: Vec<&str> = Vec::new();
    for &op in &engine.op_ids {
        let name = MongoOp::from_u8(op).as_str();
        if !ops_seen.contains(&name) {
            ops_seen.push(name);
        }
    }
    ops_seen.sort_unstable();
    for (o_idx, op) in ops_seen.iter().enumerate() {
        if o_idx > 0 {
            out.push(',');
        }
        out.push_str(&format!("\"{}\"", op));
    }
    out.push_str("]");
    out.push('}');

    out
}

#[inline]
fn calc_percentile(sorted: &[u32], p: f64) -> u32 {
    if sorted.is_empty() {
        return 0;
    }
    let idx = (((sorted.len() as f64) * (p / 100.0)).ceil() as usize).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

fn escape_json(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out
}

pub fn epoch_to_iso(epoch_ms: i64) -> String {
    if epoch_ms <= 0 {
        return String::from("1970-01-01T00:00:00.000Z");
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
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, min, sec, millis
    )
}
