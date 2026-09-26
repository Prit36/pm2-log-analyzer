use crate::{
    configure_rayon_pool, expand_archive_bytes, ingest_native_internal, parse_mongo_files_internal,
    parse_pm2_files_internal, AppState, LogCategory, LogData, MongoFilterOptions, Pm2ParseOptions,
};
use std::borrow::Cow;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

fn stored_zip(name: &str, data: &[u8]) -> Vec<u8> {
    fn push_u16(bytes: &mut Vec<u8>, value: u16) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    fn push_u32(bytes: &mut Vec<u8>, value: u32) {
        bytes.extend_from_slice(&value.to_le_bytes());
    }

    let name_bytes = name.as_bytes();
    let size = data.len() as u32;
    let mut zip = Vec::new();
    zip.extend_from_slice(b"PK\x03\x04");
    push_u16(&mut zip, 20);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u32(&mut zip, 0);
    push_u32(&mut zip, size);
    push_u32(&mut zip, size);
    push_u16(&mut zip, name_bytes.len() as u16);
    push_u16(&mut zip, 0);
    zip.extend_from_slice(name_bytes);
    zip.extend_from_slice(data);

    let central_offset = zip.len() as u32;
    zip.extend_from_slice(b"PK\x01\x02");
    push_u16(&mut zip, 20);
    push_u16(&mut zip, 20);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u32(&mut zip, 0);
    push_u32(&mut zip, size);
    push_u32(&mut zip, size);
    push_u16(&mut zip, name_bytes.len() as u16);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u32(&mut zip, 0);
    push_u32(&mut zip, 0);
    zip.extend_from_slice(name_bytes);

    let central_size = zip.len() as u32 - central_offset;
    zip.extend_from_slice(b"PK\x05\x06");
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 0);
    push_u16(&mut zip, 1);
    push_u16(&mut zip, 1);
    push_u32(&mut zip, central_size);
    push_u32(&mut zip, central_offset);
    push_u16(&mut zip, 0);
    zip
}

#[test]
fn test_nested_zip_and_gzip_logs_expand_recursively() {
    let gzip = [
        0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, 0xcb, 0x48, 0xcd, 0xc9,
        0xc9, 0x57, 0x28, 0xcf, 0x2f, 0xca, 0x49, 0xe1, 0x02, 0x00, 0x2d, 0x3b, 0x08, 0xaf,
        0x0c, 0x00, 0x00, 0x00,
    ];
    let inner = stored_zip("api-out.log.gz", &gzip);
    let outer = stored_zip("nested.zip", &inner);
    let items = expand_archive_bytes("outer.zip", "outer.zip", Cow::Borrowed(&outer), 0);

    assert_eq!(items.len(), 1);
    assert_eq!(items[0].category, LogCategory::Pm2);
    assert!(matches!(items[0].data, LogData::Buffer(_)));
    assert_eq!(&items[0].data[..], b"hello world\n");
}

#[test]
fn test_folder_filter_accepts_log_archives_and_skips_unrelated_files() {
    assert!(crate::is_supported_folder_file(Path::new("api-out.log.1")));
    assert!(crate::is_supported_folder_file(Path::new("nested.zip")));
    assert!(crate::is_supported_folder_file(Path::new("mongod.log.gz")));
    assert!(!crate::is_supported_folder_file(Path::new("notes.pdf")));
}

/// The JSON a result published to the loopback payload server.
fn result_json(payload: &Option<crate::PayloadRef>) -> String {
    let payload = payload.as_ref().expect("result payload");
    let server = crate::ensure_payload_server();
    String::from_utf8(server.bytes(payload.id).expect("payload bytes")).expect("utf-8 payload")
}

    #[test]
    fn test_native_pm2_parse_sample() {
        let path = Path::new("../test_data/api-out.log");
        if !path.exists() {
            eprintln!("Sample log not found, skipping");
            return;
        }
        let (_shards, res) = parse_pm2_files_internal(
            &["../test_data/api-out.log".to_string()],
            &Pm2ParseOptions::default(),
            None,
        )
        .expect("Failed to parse PM2 log");

        assert!(res.hit_count > 0, "Expected hit_count > 0");
        assert!(res.parse_wall_ms < 10000, "Expected fast parse");
        let result: serde_json::Value =
            serde_json::from_str(&result_json(&res.payload)).expect("valid result JSON");
        assert!(
            result["api"].as_array().is_some_and(|rows| !rows.is_empty()),
            "Expected api rows",
        );
        assert_eq!(
            result["summary"]["matched"].as_u64().unwrap(),
            res.hit_count as u64,
        );
        assert!(!result["dailyStats"].as_array().unwrap().is_empty());
        println!(
            "PM2 Native parsed {} hits in {}ms ({} shards), result JSON {} KB",
            res.hit_count,
            res.parse_wall_ms,
            res.shard_count,
            result_json(&res.payload).len() / 1024,
        );
    }

    #[test]
    #[ignore]
    fn test_native_pm2_parse_5gb() {
        let path = Path::new("../test_data/api-out-5gb.log");
        if !path.exists() {
            eprintln!("5GB log not found, skipping");
            return;
        }
        let t0 = Instant::now();
        let (_shards, res) = parse_pm2_files_internal(
            &["../test_data/api-out-5gb.log".to_string()],
            &Pm2ParseOptions::default(),
            None,
        )
        .expect("Failed to parse PM2 5GB log");
        println!(
            "5GB parse+finalize: {} hits in {}ms across {} shards (total wall: {}ms), result JSON {} KB",
            res.hit_count,
            res.parse_wall_ms,
            res.shard_count,
            t0.elapsed().as_millis(),
            result_json(&res.payload).len() / 1024,
        );
        assert_eq!(res.hit_count, 20315200);
        assert!(serde_json::from_str::<serde_json::Value>(&result_json(&res.payload)).is_ok());
    }

    #[test]
    fn test_native_mongo_parse_sample() {
        let path = Path::new("../mongodb_logs_sample/eSanad-mongod.log");
        if !path.exists() {
            eprintln!("Sample mongo log not found, skipping");
            return;
        }
        let (_engine, res) = parse_mongo_files_internal(
            &["../mongodb_logs_sample/eSanad-mongod.log".to_string()],
            &MongoFilterOptions::default(),
            None,
        )
        .expect("Failed to parse Mongo log");

        assert!(res.total_lines > 0, "Expected total_lines > 0");
        println!(
            "Mongo Native parsed {} lines ({} slow) in {}ms",
            res.total_lines, res.slow_query_count, res.parse_wall_ms,
        );
    }

    /// `parse_mongo_items` feeds big logs in `MONGO_FEED_CHUNK_BYTES` slices so the
    /// UI can show progress; splitting the byte stream must not change results.
    #[test]
    fn test_mongo_chunked_feed_matches_single_shot() {
        let path = Path::new("../mongodb_logs_sample/methaq-mongod.log");
        if !path.exists() {
            eprintln!("Large mongo log not found, skipping");
            return;
        }
        let data = std::fs::read(path).expect("read mongo log");

        let mut single = mongo_core::MongoEngine::new();
        single.feed_slice(&data);
        single.end_shard();

        let mut chunked = mongo_core::MongoEngine::new();
        for chunk in data.chunks(4 * 1024 * 1024) {
            chunked.feed_slice(chunk);
        }
        chunked.end_shard();

        assert_eq!(single.total_lines(), chunked.total_lines());
        assert_eq!(single.slow_query_count(), chunked.slow_query_count());

        // Reagg emits patterns in hash order and numbers their `id` from
        // that order, so compare content with array order and ids removed.
        let single_json = mongo_reagg_json(&single);
        let chunked_json = mongo_reagg_json(&chunked);
        assert_eq!(
            json_content(&single_json),
            json_content(&chunked_json),
            "chunked feed changed the aggregation",
        );
    }

    #[test]
    fn test_native_mongo_sharded_parse_matches_single() {
        let path = Path::new("../mongodb_logs_sample/methaq-mongod.log");
        if !path.exists() {
            eprintln!("Large mongo log not found, skipping");
            return;
        }
        let (_engine, res) = parse_mongo_files_internal(
            &["../mongodb_logs_sample/methaq-mongod.log".to_string()],
            &MongoFilterOptions::default(),
            None,
        )
        .expect("Failed to parse Mongo log");

        assert!(res.total_lines > 0);
        assert_eq!(res.total_lines, 141911);
        assert_eq!(res.slow_query_count, 56872);
        println!(
            "Native Sharded Mongo parsed {} lines ({} slow) in {}ms",
            res.total_lines, res.slow_query_count, res.parse_wall_ms,
        );
    }

    fn mongo_reagg_json(engine: &mongo_core::MongoEngine) -> serde_json::Value {
        serde_json::from_str(&engine.reaggregate("all", 0, 0, "all", "", false, "all"))
            .expect("valid mongo result JSON")
    }

    /// Canonical form for comparing aggregations: arrays sorted by content and
    /// `id` fields dropped (ids are numbered from hash-map iteration order).
    fn json_content(value: &serde_json::Value) -> serde_json::Value {
        match value {
            serde_json::Value::Array(items) => {
                let mut sorted: Vec<serde_json::Value> = items.iter().map(json_content).collect();
                sorted.sort_by_cached_key(|item| item.to_string());
                serde_json::Value::Array(sorted)
            }
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.iter()
                    .filter(|(k, _)| k.as_str() != "id")
                    .map(|(key, value)| (key.clone(), json_content(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    #[test]
    fn test_ingest_native_mixed() {
        let p_pm2 = Path::new("../test_data/api-out.log");
        let p_mongo = Path::new("../mongodb_logs_sample/eSanad-mongod.log");
        if !p_pm2.exists() || !p_mongo.exists() {
            eprintln!("Test files not found, skipping");
            return;
        }

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let paths = vec![
            "../test_data/api-out.log".to_string(),
            "../mongodb_logs_sample/eSanad-mongod.log".to_string(),
        ];

        let res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("Failed to ingest mixed logs");

        assert!(res.pm2.is_some(), "Expected PM2 result");
        assert!(res.mongo.is_some(), "Expected Mongo result");
        assert_eq!(res.files.len(), 2);
        println!(
            "Mixed ingest succeeded: PM2 {} hits, Mongo {} lines, wall {}ms",
            res.pm2.as_ref().unwrap().hit_count,
            res.mongo.as_ref().unwrap().total_lines,
            res.parse_wall_ms,
        );
    }

    fn create_test_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let mut zip = Vec::new();
        let mut cd = Vec::new();

        for (name, data) in entries {
            let local_header_offset = zip.len() as u32;
            push_local_header(&mut zip, name, data);
            push_central_record(&mut cd, name, data, local_header_offset);
        }

        let cd_offset = zip.len() as u32;
        let cd_size = cd.len() as u32;
        zip.extend_from_slice(&cd);
        push_eocd(&mut zip, entries.len() as u16, cd_offset, cd_size);

        std::fs::write(path, zip).expect("write test zip");
    }

    /// A stored (uncompressed) local file header plus its data.
    fn push_local_header(zip: &mut Vec<u8>, name: &str, data: &[u8]) {
        let name_bytes = name.as_bytes();
        let len = data.len() as u32;
        zip.extend_from_slice(b"PK\x03\x04");
        zip.extend_from_slice(&20u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u32.to_le_bytes());
        zip.extend_from_slice(&len.to_le_bytes());
        zip.extend_from_slice(&len.to_le_bytes());
        zip.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(name_bytes);
        zip.extend_from_slice(data);
    }

    /// The matching central-directory record.
    fn push_central_record(cd: &mut Vec<u8>, name: &str, data: &[u8], local_header_offset: u32) {
        let name_bytes = name.as_bytes();
        let len = data.len() as u32;
        cd.extend_from_slice(b"PK\x01\x02");
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&20u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&len.to_le_bytes());
        cd.extend_from_slice(&len.to_le_bytes());
        cd.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u16.to_le_bytes());
        cd.extend_from_slice(&0u32.to_le_bytes());
        cd.extend_from_slice(&local_header_offset.to_le_bytes());
        cd.extend_from_slice(name_bytes);
    }

    /// The end-of-central-directory record.
    fn push_eocd(zip: &mut Vec<u8>, entries: u16, cd_offset: u32, cd_size: u32) {
        zip.extend_from_slice(b"PK\x05\x06");
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
        zip.extend_from_slice(&entries.to_le_bytes());
        zip.extend_from_slice(&entries.to_le_bytes());
        zip.extend_from_slice(&cd_size.to_le_bytes());
        zip.extend_from_slice(&cd_offset.to_le_bytes());
        zip.extend_from_slice(&0u16.to_le_bytes());
    }

    #[test]
    fn test_ingest_native_zip() {
        configure_rayon_pool();
        let zip_path = Path::new("target/test_archive.zip");
        let pm2_data = b"2026-09-12 10:00:00: GET /api/v1/users 200 12.3 ms - 100\n2026-09-12 10:00:01: POST /api/v1/login 200 45.6 ms - 200\n";
        let mongo_data = b"{\"t\":{\"$date\":\"2026-09-12T10:00:00.000Z\"},\"s\":\"I\",\"c\":\"COMMAND\",\"ctx\":\"conn1\",\"msg\":\"Slow query\",\"attr\":{\"durationMillis\":120}}\n";
        let err_data = b"Some error occurred\n";

        create_test_zip(
            zip_path,
            &[
                ("api-out.log", pm2_data),
                ("mongod.log", mongo_data),
                ("api-error.log", err_data),
                (".DS_Store", b"\x00\x00"),
            ],
        );

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let paths = vec![zip_path.to_string_lossy().to_string()];
        let res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("Failed to ingest ZIP archive");

        let _ = std::fs::remove_file(zip_path);

        assert!(res.pm2.is_some(), "Expected PM2 result from zip");
        assert!(res.mongo.is_some(), "Expected Mongo result from zip");
        assert_eq!(res.pm2.as_ref().unwrap().hit_count, 2);
        assert_eq!(res.mongo.as_ref().unwrap().slow_query_count, 1);
        assert_eq!(
            res.files.len(),
            2,
            "Error and metadata files should be skipped",
        );
        println!(
            "ZIP ingest verified: PM2 hits {}, Mongo slow {}, valid files {}",
            res.pm2.as_ref().unwrap().hit_count,
            res.mongo.as_ref().unwrap().slow_query_count,
            res.files.len(),
        );
    }

    #[test]
    fn test_profile_methaq_zip() {
        let zip_path = Path::new("C:/Users/My_Home/Downloads/methaq-api&mongodb-07-09.zip");
        if !zip_path.exists() {
            println!("methaq zip not found, skipping");
            return;
        }

        let paths = vec![zip_path.to_string_lossy().to_string()];

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let t_ingest = Instant::now();
        let ingest_res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("ingest_native_internal");
        let ingest_wall = t_ingest.elapsed().as_millis();

        println!(
            "FULL INGEST NATIVE: wall {}ms (pm2 hits: {}, mongo lines: {})",
            ingest_wall,
            ingest_res.pm2.as_ref().map(|pm2| pm2.hit_count).unwrap_or(0),
            ingest_res
                .mongo
                .as_ref()
                .map(|m| m.total_lines)
                .unwrap_or(0),
        );
    }

    #[test]
    fn test_profile_batch_import() {
        configure_rayon_pool();
        let download_dir = "C:/Users/My_Home/Downloads";
        let file_names = [
            "monday-14-09.zip",
            "16-09-api.zip",
            "21-09-api.zip",
            "12-days-pm2logs-5-to-16-sep.zip",
            "pm2.log.2.gz",
            "api-error.log.2.gz",
            "24-09-api.zip",
            "api-out.log.2.gz",
            "22-09-all-logs.zip",
        ];
        let paths: Vec<String> = file_names
            .iter()
            .map(|name| format!("{download_dir}/{name}"))
            .filter(|p| Path::new(p).exists())
            .collect();
        if paths.len() != file_names.len() {
            println!("Some batch files missing, skipping test");
            return;
        }

        let state = AppState {
            pm2_shards: Mutex::new(Vec::new()),
            mongo: Mutex::new(None),
        };

        let t0 = Instant::now();
        let res = ingest_native_internal(
            &paths,
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            Some("replace"),
            None,
            &state,
        )
        .expect("batch ingest_native_internal");
        let wall = t0.elapsed().as_millis();

        println!(
            "BATCH INGEST: wall {}ms, pm2 hits {}, mongo lines {}",
            wall,
            res.pm2.as_ref().map(|p| p.hit_count).unwrap_or(0),
            res.mongo.as_ref().map(|m| m.total_lines).unwrap_or(0),
        );
    }
