//! MongoDB log analyzer Wasm core: parse bytes → compact columnar store → microsecond reagg.
#![allow(dead_code)]

mod fingerprint;
mod parse;
mod reagg;
mod store;

use wasm_bindgen::prelude::*;

pub use store::Engine;

#[wasm_bindgen]
pub struct MongoEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl MongoEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> MongoEngine {
        MongoEngine {
            inner: Engine::new(),
        }
    }

    pub fn clear(&mut self) {
        self.inner.clear();
    }

    /// Grow ingest window to `len` bytes; returns pointer into Wasm memory for JS writes.
    pub fn ingest_ptr(&mut self, len: u32) -> u32 {
        self.inner.ingest_ptr(len)
    }

    /// Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
    pub fn feed(&mut self, len: u32, abs_off: f64) -> u32 {
        self.inner.feed(len, abs_off as u64)
    }

    /// Finish shard (flush carry). Call after all feeds.
    pub fn end_shard(&mut self) {
        self.inner.end_shard();
    }

    pub fn slow_query_count(&self) -> u32 {
        self.inner.slow_query_count()
    }

    pub fn total_lines(&self) -> u32 {
        self.inner.total_lines as u32
    }

    /// Fast reaggregate returning serialized JSON string.
    pub fn reaggregate(
        &self,
        op: &str,
        plan_filter: u8,
        min_duration_ms: u32,
        collection: &str,
        search_query: &str,
        high_scan_ratio_only: bool,
        user: &str,
    ) -> String {
        let params = reagg::FilterParams {
            op,
            plan_filter,
            min_duration_ms,
            collection,
            search_query,
            high_scan_ratio_only,
            user,
        };
        reagg::reaggregate(&self.inner, params)
    }
    #[cfg(test)]
    pub fn write_ingest_for_test(&mut self, data: &[u8]) {
        let len = data.len() as u32;
        let _ = self.ingest_ptr(len);
        self.inner.ingest[..data.len()].copy_from_slice(data);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mongo_engine_basic() {
        let mut engine = MongoEngine::new();
        let sample = b"{\"t\":{\"$date\":\"2026-09-01T00:07:08.384+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn14142\",\"msg\":\"Slow query\",\"attr\":{\"type\":\"command\",\"ns\":\"esanad-prod.auto_master_references\",\"command\":{\"find\":\"auto_master_references\",\"filter\":{\"$and\":[{\"createdAt\":{\"$gte\":\"2026-08-31T16:02:00.271Z\"}}]},\"$db\":\"esanad-prod\"},\"planSummary\":\"COLLSCAN\",\"planningTimeMicros\":226,\"keysExamined\":0,\"docsExamined\":125726,\"nreturned\":0,\"remote\":\"20.233.24.214:56774\",\"protocol\":\"op_msg\",\"durationMillis\":109}}\n";

        engine.write_ingest_for_test(sample);
        let added = engine.feed(sample.len() as u32, 0.0);
        assert_eq!(added, 1);
        assert_eq!(engine.slow_query_count(), 1);

        let json = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        assert!(json.contains("auto_master_references"));
        assert!(json.contains("\"collscanCount\":1"));
    }

    #[test]
    fn test_mongo_engine_multi_line_and_filter() {
        let mut engine = MongoEngine::new();
        let chunk = b"{\"t\":{\"$date\":\"2026-09-01T00:00:01.000Z\"},\"s\":\"I\",\"c\":\"NETWORK\",\"id\":22943,\"ctx\":\"listener\",\"msg\":\"Connection accepted\",\"attr\":{\"connectionId\":1,\"connectionCount\":42,\"remote\":\"10.0.0.1:1234\"}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:01:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn1\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll1\",\"command\":{\"find\":\"coll1\",\"filter\":{\"x\":1}},\"planSummary\":\"IXSCAN { x: 1 }\",\"docsExamined\":10,\"keysExamined\":10,\"nreturned\":10,\"durationMillis\":50}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:02:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn2\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll2\",\"command\":{\"find\":\"coll2\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":1000,\"keysExamined\":0,\"nreturned\":5,\"durationMillis\":500}}\n";

        engine.write_ingest_for_test(chunk);
        let added = engine.feed(chunk.len() as u32, 0.0);
        engine.end_shard();
        assert_eq!(added, 2);
        assert_eq!(engine.slow_query_count(), 2);

        // Filter: collscan only
        let json_collscan = engine.reaggregate("all", 1, 0, "all", "", false, "all");
        assert!(json_collscan.contains("\"collscanCount\":1"));
        assert!(json_collscan.contains("\"slowQueryCount\":1"));

        // Filter: min duration 100ms
        let json_100ms = engine.reaggregate("all", 0, 100, "all", "", false, "all");
        assert!(json_100ms.contains("\"slowQueryCount\":1"));

        // Filter: all
        let json_all = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        assert!(json_all.contains("\"slowQueryCount\":2"));
        assert!(json_all.contains("\"accepted\":1"));
        assert!(json_all.contains("\"peakConcurrent\":42"));
    }

    #[test]
    fn test_mongo_engine_user_tracking() {
        let mut engine = MongoEngine::new();
        let chunk = b"{\"t\":{\"$date\":\"2026-09-01T07:57:16.966+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":5286306,\"ctx\":\"conn10476\",\"msg\":\"Successfully authenticated\",\"attr\":{\"client\":\"103.251.212.27:50576\",\"user\":\"prit-read-only\",\"db\":\"admin\",\"doc\":{\"application\":{\"name\":\"MongoDB Compass\"}}}}\n\
{\"t\":{\"$date\":\"2026-09-01T07:58:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn10476\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.cash_settlements\",\"command\":{\"find\":\"cash_settlements\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":500,\"keysExamined\":0,\"nreturned\":10,\"durationMillis\":1200}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:00:00.000+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":20436,\"ctx\":\"conn10476\",\"msg\":\"Checking authorization failed\",\"attr\":{\"error\":{\"code\":13,\"codeName\":\"Unauthorized\",\"errmsg\":\"not authorized\"}}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:05:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn99999\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.other\",\"command\":{\"find\":\"other\"},\"planSummary\":\"IXSCAN\",\"docsExamined\":1,\"keysExamined\":1,\"nreturned\":1,\"durationMillis\":80}}\n";

        engine.write_ingest_for_test(chunk);
        let added = engine.feed(chunk.len() as u32, 0.0);
        engine.end_shard();
        assert_eq!(added, 2);

        // Reaggregate all
        let json_all = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        assert!(json_all.contains("\"userName\":\"prit-read-only\""));
        assert!(json_all.contains("\"authFailCount\":1"));
        assert!(json_all.contains("\"appName\":\"MongoDB Compass\""));
        assert!(json_all.contains("\"userNames\":[\"prit-read-only\",\"system\"]"));

        // Filter for prit-read-only
        let json_user = engine.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        assert!(json_user.contains("\"slowQueryCount\":1"));
        assert!(json_user.contains("cash_settlements"));
        assert!(!json_user.contains("crm.other"));
    }

    #[test]
    #[ignore]
    fn test_benchmark_feed() {
        use std::time::Instant;
        let p = "../../mongodb_logs_sample/methaq-mongod.log";
        if !std::path::Path::new(p).exists() {
            return;
        }
        let data = std::fs::read(p).unwrap();

        // 1. Line splitting only
        let t_split0 = Instant::now();
        let mut lines = 0;
        let mut cursor = 0;
        while let Some(pos) = memchr::memchr(b'\n', &data[cursor..]) {
            lines += 1;
            cursor += pos + 1;
        }
        let split_ms = t_split0.elapsed().as_millis();
        println!("Line split only: {} lines in {}ms", lines, split_ms);

        // 2. parse_line only without store pushes
        let t_parse0 = Instant::now();
        let mut sq = 0;
        cursor = 0;
        while let Some(pos) = memchr::memchr(b'\n', &data[cursor..]) {
            let line = &data[cursor..cursor + pos];
            cursor += pos + 1;
            let trimmed = crate::store::trim_line(line);
            if !trimmed.is_empty() {
                if let crate::parse::ParsedLine::SlowQuery(_) = crate::parse::parse_line(trimmed) {
                    sq += 1;
                }
            }
        }
        let parse_only_ms = t_parse0.elapsed().as_millis();
        println!("parse_line only: {} slow queries in {}ms", sq, parse_only_ms);

        // 3. Full engine feed
        let mut engine = MongoEngine::new();
        let chunk_size = 16 * 1024 * 1024;
        let t0 = Instant::now();
        let mut off = 0;
        while off < data.len() {
            let take = (data.len() - off).min(chunk_size);
            engine.write_ingest_for_test(&data[off..off + take]);
            engine.feed(take as u32, off as f64);
            off += take;
        }
        engine.end_shard();
        let feed_ms = t0.elapsed().as_millis();
        let t1 = Instant::now();
        let json = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        let reagg_ms = t1.elapsed().as_millis();
        println!(
            "Rust native bench: feed={}ms ({:.1} MB/s) reagg={}ms jsonLen={} slowQueries={}",
            feed_ms,
            (data.len() as f64 / 1024.0 / 1024.0) / (feed_ms as f64 / 1000.0),
            reagg_ms,
            json.len(),
            engine.slow_query_count()
        );
    }
}
