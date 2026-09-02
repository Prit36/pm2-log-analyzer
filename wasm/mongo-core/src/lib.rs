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
    ) -> String {
        let params = reagg::FilterParams {
            op,
            plan_filter,
            min_duration_ms,
            collection,
            search_query,
            high_scan_ratio_only,
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

        let json = engine.reaggregate("all", 0, 0, "all", "", false);
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
        let json_collscan = engine.reaggregate("all", 1, 0, "all", "", false);
        assert!(json_collscan.contains("\"collscanCount\":1"));
        assert!(json_collscan.contains("\"slowQueryCount\":1"));

        // Filter: min duration 100ms
        let json_100ms = engine.reaggregate("all", 0, 100, "all", "", false);
        assert!(json_100ms.contains("\"slowQueryCount\":1"));

        // Filter: all
        let json_all = engine.reaggregate("all", 0, 0, "all", "", false);
        assert!(json_all.contains("\"slowQueryCount\":2"));
        assert!(json_all.contains("\"accepted\":1"));
        assert!(json_all.contains("\"peakConcurrent\":42"));
    }
}
