use crate::{MongoEngine, MONGO_LINE_EXTEND};
use std::time::Instant;

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
        assert!(json.contains(r#""collscanCount":1"#));
    }

    #[test]
    fn search_filter_preserves_unicode_case_insensitive_matching() {
        let mut engine = MongoEngine::new();
        let sample = r#"{"t":{"$date":"2026-09-01T00:00:00.000Z"},"s":"I","c":"COMMAND","id":51803,"ctx":"conn1","msg":"Slow query","attr":{"ns":"db.Äpfel","command":{"find":"Äpfel"},"planSummary":"COLLSCAN","docsExamined":1,"keysExamined":0,"nreturned":1,"durationMillis":25}}"#;

        engine.write_ingest_for_test(sample.as_bytes());
        engine.feed(sample.len() as u32, 0.0);
        engine.end_shard();

        let json = engine.reaggregate("all", 0, 0, "all", "äPFEL", false, "all");
        assert!(json.contains(r#""slowQueryCount":1"#));
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
        assert!(json_collscan.contains(r#""collscanCount":1"#));
        assert!(json_collscan.contains(r#""slowQueryCount":1"#));

        // Filter: min duration 100ms
        let json_100ms = engine.reaggregate("all", 0, 100, "all", "", false, "all");
        assert!(json_100ms.contains(r#""slowQueryCount":1"#));

        // Filter: all
        let json_all = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        assert!(json_all.contains(r#""slowQueryCount":2"#));
        assert!(json_all.contains(r#""accepted":1"#));
        assert!(json_all.contains(r#""peakConcurrent":42"#));
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
        assert!(json_all.contains(r#""userName":"prit-read-only""#));
        assert!(json_all.contains(r#""authFailCount":1"#));
        assert!(json_all.contains(r#""appName":"MongoDB Compass""#));
        assert!(json_all.contains(r#""userNames":["prit-read-only","system"]"#));

        // Filter for prit-read-only
        let json_user = engine.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        assert!(json_user.contains(r#""slowQueryCount":1"#));
        assert!(json_user.contains("cash_settlements"));
        assert!(!json_user.contains("crm.other"));
    }

    /// Everything below `#[ignore]` is a manual, release-mode throughput probe.
    #[test]
    #[ignore]
    fn test_benchmark_feed() {
        let path = "../../mongodb_logs_sample/methaq-mongod.log";
        if !std::path::Path::new(path).exists() {
            return;
        }
        let data = std::fs::read(path).unwrap();
        bench_line_splitting(&data);
        bench_parse_line_only(&data);
        bench_engine_feed(&data);
    }

    fn bench_line_splitting(data: &[u8]) {
        let started = Instant::now();
        let mut lines = 0;
        let mut cursor = 0;
        while let Some(position) = memchr::memchr(b'\n', &data[cursor..]) {
            lines += 1;
            cursor += position + 1;
        }
        println!("Line split only: {} lines in {}ms", lines, started.elapsed().as_millis());
    }

    fn bench_parse_line_only(data: &[u8]) {
        let started = Instant::now();
        let mut slow_queries = 0;
        let mut cursor = 0;
        while let Some(position) = memchr::memchr(b'\n', &data[cursor..]) {
            let line = &data[cursor..cursor + position];
            cursor += position + 1;
            let trimmed = crate::store::trim_line(line);
            if !trimmed.is_empty()
                && matches!(
                    crate::parse::parse_line(trimmed),
                    crate::parse::ParsedLine::SlowQuery(_),
                )
            {
                slow_queries += 1;
            }
        }
        println!(
            "parse_line only: {} slow queries in {}ms",
            slow_queries,
            started.elapsed().as_millis(),
        );
    }

    fn bench_engine_feed(data: &[u8]) {
        let mut engine = MongoEngine::new();
        let chunk_size = 16 * 1024 * 1024;
        let started = Instant::now();
        let mut offset = 0;
        while offset < data.len() {
            let take = (data.len() - offset).min(chunk_size);
            engine.write_ingest_for_test(&data[offset..offset + take]);
            engine.feed(take as u32, offset as f64);
            offset += take;
        }
        engine.end_shard();
        let feed_ms = started.elapsed().as_millis();
        let reagg_started = Instant::now();
        let json = engine.reaggregate("all", 0, 0, "all", "", false, "all");
        println!(
            "Rust native bench: feed={}ms ({:.1} MB/s) reagg={}ms jsonLen={} slowQueries={}",
            feed_ms,
            (data.len() as f64 / 1024.0 / 1024.0) / (feed_ms as f64 / 1000.0),
            reagg_started.elapsed().as_millis(),
            json.len(),
            engine.slow_query_count(),
        );
    }

    #[test]
    fn test_mongo_sharded_parse_and_merge_parity() {
        let sample = b"{\"t\":{\"$date\":\"2026-09-01T00:00:01.000Z\"},\"s\":\"I\",\"c\":\"NETWORK\",\"id\":22943,\"ctx\":\"listener\",\"msg\":\"Connection accepted\",\"attr\":{\"connectionId\":1,\"connectionCount\":42,\"remote\":\"10.0.0.1:1234\"}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:01:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn1\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll1\",\"command\":{\"find\":\"coll1\",\"filter\":{\"x\":1}},\"planSummary\":\"IXSCAN { x: 1 }\",\"docsExamined\":10,\"keysExamined\":10,\"nreturned\":10,\"durationMillis\":50}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:02:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn2\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll2\",\"command\":{\"find\":\"coll2\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":1000,\"keysExamined\":0,\"nreturned\":5,\"durationMillis\":500}}\n\
{\"t\":{\"$date\":\"2026-09-01T07:57:16.966+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":5286306,\"ctx\":\"conn10476\",\"msg\":\"Successfully authenticated\",\"attr\":{\"client\":\"103.251.212.27:50576\",\"user\":\"prit-read-only\",\"db\":\"admin\",\"doc\":{\"application\":{\"name\":\"MongoDB Compass\"}}}}\n\
{\"t\":{\"$date\":\"2026-09-01T07:58:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn10476\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.cash_settlements\",\"command\":{\"find\":\"cash_settlements\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":500,\"keysExamined\":0,\"nreturned\":10,\"durationMillis\":1200}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:00:00.000+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":20436,\"ctx\":\"conn10476\",\"msg\":\"Checking authorization failed\",\"attr\":{\"error\":{\"code\":13,\"codeName\":\"Unauthorized\",\"errmsg\":\"not authorized\"}}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:05:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn99999\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.other\",\"command\":{\"find\":\"other\"},\"planSummary\":\"IXSCAN\",\"docsExamined\":1,\"keysExamined\":1,\"nreturned\":1,\"durationMillis\":80}}\n";

        // 1. Single engine parsing whole buffer
        let mut single = MongoEngine::new();
        single.parse_shard(sample, 0.0, sample.len() as f64, sample.len() as f64);
        assert_eq!(single.slow_query_count(), 4);
        assert_eq!(single.total_lines(), 7);

        // 2. Multi-shard parsing across 3 shards with boundaries cutting right through JSON lines
        let file_size = sample.len();
        let chunk1 = file_size / 3;
        let chunk2 = (file_size * 2) / 3;

        let mut shard0 = MongoEngine::new();
        let mut shard1 = MongoEngine::new();
        let mut shard2 = MongoEngine::new();

        let s0_end = (chunk1 + MONGO_LINE_EXTEND).min(file_size);
        shard0.parse_shard(&sample[..s0_end], 0.0, chunk1 as f64, file_size as f64);

        let s1_end = (chunk2 + MONGO_LINE_EXTEND).min(file_size);
        shard1.parse_shard(&sample[chunk1..s1_end], chunk1 as f64, chunk2 as f64, file_size as f64);

        shard2.parse_shard(&sample[chunk2..], chunk2 as f64, file_size as f64, file_size as f64);

        // Merge shards: 0 + 1 + 2
        shard0.merge(shard1);
        shard0.merge(shard2);

        assert_eq!(shard0.slow_query_count(), single.slow_query_count());
        assert_eq!(shard0.total_lines(), single.total_lines());

        let single_all = single.reaggregate("all", 0, 0, "all", "", false, "all");
        let merged_all = shard0.reaggregate("all", 0, 0, "all", "", false, "all");
        assert_eq!(single_all, merged_all);

        let single_user = single.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        let merged_user = shard0.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        assert_eq!(single_user, merged_user);
    }

    /// Split `sample` into three overlapping shard parses, as the browser does.
    fn parse_three_shards(sample: &[u8]) -> [MongoEngine; 3] {
        let file_size = sample.len();
        let chunk1 = file_size / 3;
        let chunk2 = (file_size * 2) / 3;

        let mut shard0 = MongoEngine::new();
        let mut shard1 = MongoEngine::new();
        let mut shard2 = MongoEngine::new();

        let shard0_end = (chunk1 + MONGO_LINE_EXTEND).min(file_size);
        shard0.parse_shard(&sample[..shard0_end], 0.0, chunk1 as f64, file_size as f64);

        let shard1_end = (chunk2 + MONGO_LINE_EXTEND).min(file_size);
        shard1.parse_shard(
            &sample[chunk1..shard1_end],
            chunk1 as f64,
            chunk2 as f64,
            file_size as f64,
        );

        shard2.parse_shard(
            &sample[chunk2..],
            chunk2 as f64,
            file_size as f64,
            file_size as f64,
        );
        [shard0, shard1, shard2]
    }

    #[test]
    fn test_mongo_sharded_encode_and_merge_bytes_parity() {
        let sample = b"{\"t\":{\"$date\":\"2026-09-01T00:00:01.000Z\"},\"s\":\"I\",\"c\":\"NETWORK\",\"id\":22943,\"ctx\":\"listener\",\"msg\":\"Connection accepted\",\"attr\":{\"connectionId\":1,\"connectionCount\":42,\"remote\":\"10.0.0.1:1234\"}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:01:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn1\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll1\",\"command\":{\"find\":\"coll1\",\"filter\":{\"x\":1}},\"planSummary\":\"IXSCAN { x: 1 }\",\"docsExamined\":10,\"keysExamined\":10,\"nreturned\":10,\"durationMillis\":50}}\n\
{\"t\":{\"$date\":\"2026-09-01T00:02:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn2\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"db1.coll2\",\"command\":{\"find\":\"coll2\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":1000,\"keysExamined\":0,\"nreturned\":5,\"durationMillis\":500}}\n\
{\"t\":{\"$date\":\"2026-09-01T07:57:16.966+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":5286306,\"ctx\":\"conn10476\",\"msg\":\"Successfully authenticated\",\"attr\":{\"client\":\"103.251.212.27:50576\",\"user\":\"prit-read-only\",\"db\":\"admin\",\"doc\":{\"application\":{\"name\":\"MongoDB Compass\"}}}}\n\
{\"t\":{\"$date\":\"2026-09-01T07:58:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn10476\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.cash_settlements\",\"command\":{\"find\":\"cash_settlements\"},\"planSummary\":\"COLLSCAN\",\"docsExamined\":500,\"keysExamined\":0,\"nreturned\":10,\"durationMillis\":1200}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:00:00.000+04:00\"},\"s\":\"I\",\"c\":\"ACCESS\",\"id\":20436,\"ctx\":\"conn10476\",\"msg\":\"Checking authorization failed\",\"attr\":{\"error\":{\"code\":13,\"codeName\":\"Unauthorized\",\"errmsg\":\"not authorized\"}}}\n\
{\"t\":{\"$date\":\"2026-09-01T08:05:00.000+04:00\"},\"s\":\"I\",\"c\":\"COMMAND\",\"id\":51803,\"ctx\":\"conn99999\",\"msg\":\"Slow query\",\"attr\":{\"ns\":\"crm.other\",\"command\":{\"find\":\"other\"},\"planSummary\":\"IXSCAN\",\"docsExamined\":1,\"keysExamined\":1,\"nreturned\":1,\"durationMillis\":80}}\n";

        let mut single = MongoEngine::new();
        single.parse_shard(sample, 0.0, sample.len() as f64, sample.len() as f64);

        let [mut shard0, shard1, shard2] = parse_three_shards(sample);

        // Serialize shard1 & shard2 to byte arrays
        let wire1 = shard1.encode_shard();
        let wire2 = shard2.encode_shard();
        assert!(!wire1.is_empty());
        assert!(!wire2.is_empty());

        // Coordinator merges shard byte arrays
        shard0.merge_shard_bytes(&wire1);
        shard0.merge_shard_bytes(&wire2);

        assert_eq!(shard0.slow_query_count(), single.slow_query_count());
        assert_eq!(shard0.total_lines(), single.total_lines());

        let single_all = single.reaggregate("all", 0, 0, "all", "", false, "all");
        let merged_all = shard0.reaggregate("all", 0, 0, "all", "", false, "all");
        assert_eq!(single_all, merged_all);

        let single_user = single.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        let merged_user = shard0.reaggregate("all", 0, 0, "all", "", false, "prit-read-only");
        assert_eq!(single_user, merged_user);
    }
