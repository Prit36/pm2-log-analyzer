use super::*;

fn fixture(name: &str) -> String {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../tests/fixtures/archives")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

fn state() -> AppState {
    AppState {
        pm2_shards: Mutex::new(Vec::new()),
        mongo: Mutex::new(None),
    }
}

#[test]
fn archive_formats_produce_identical_log_counts() {
    configure_rayon_pool();
    for name in [
        "logs.zip",
        "logs.7z",
        "logs-deflate.7z",
        "logs.tar",
        "metadata.tar",
        "logs.tar.gz",
        "logs-concat.tar.gz",
        "logs.tar.bz2",
        "logs.tar.xz",
        "nested.zip",
        "nested.7z",
    ] {
        let result = ingest_native_internal(
            &[fixture(name)],
            &Pm2ParseOptions::default(),
            &MongoFilterOptions::default(),
            None,
            None,
            &state(),
        )
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(result.pm2.unwrap().hit_count, 1, "{name}");
        assert_eq!(result.mongo.unwrap().slow_query_count, 1, "{name}");
        assert_eq!(result.files.len(), 2, "{name}");
        assert!(
            result.files.iter().all(|file| !file.name.contains("error")),
            "{name}"
        );
    }
}

#[test]
fn mixed_archives_are_merged_in_batch_imports() {
    configure_rayon_pool();
    let result = ingest_native_internal(
        &[fixture("logs.7z"), fixture("logs.tar.xz")],
        &Pm2ParseOptions::default(),
        &MongoFilterOptions::default(),
        None,
        None,
        &state(),
    )
    .unwrap();
    assert_eq!(result.pm2.unwrap().hit_count, 2);
    assert_eq!(result.mongo.unwrap().slow_query_count, 2);
    assert_eq!(result.files.len(), 4);
}

#[test]
fn tar_aliases_decode_and_plain_tar_borrows_log_bytes() {
    for (name, content) in [
        ("logs.tar", "logs.tar"),
        ("logs.tgz", "logs.tar.gz"),
        ("logs.tbz", "logs.tar.bz2"),
        ("logs.tbz2", "logs.tar.bz2"),
        ("logs.txz", "logs.tar.xz"),
    ] {
        let mut count = 0;
        extended_archive::for_each_entry(
            name,
            extended_archive::ArchiveSource::Buffer(std::fs::read(fixture(content)).unwrap()),
            |_, bytes| {
                assert_eq!(matches!(bytes, Cow::Borrowed(_)), name == "logs.tar");
                count += 1;
            },
        )
        .unwrap();
        assert_eq!(count, 2, "{name}");
    }
}

#[test]
fn truncated_tar_entries_and_compression_trailers_fail() {
    for name in ["logs.tar", "logs.tar.gz", "logs.tar.bz2", "logs.tar.xz"] {
        let mut data = std::fs::read(fixture(name)).unwrap();
        data.truncate(if name == "logs.tar" {
            512
        } else {
            data.len() - 8
        });
        assert!(
            extended_archive::for_each_entry(
                name,
                extended_archive::ArchiveSource::Buffer(data),
                |_, _| {},
            )
            .is_err(),
            "{name}"
        );
    }
}

fn xz_stream(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = liblzma::write::XzEncoder::new(Vec::new(), 1);
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn bzip2_stream(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut encoder = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::fast());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn decoded_archive_entries(name: &str, data: Vec<u8>) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut entries = Vec::new();
    extended_archive::for_each_entry(
        name,
        extended_archive::ArchiveSource::Buffer(data),
        |name, bytes| entries.push((name.to_string(), bytes.into_owned())),
    )?;
    Ok(entries)
}

#[test]
fn parallel_decoders_preserve_concatenated_streams_split_inside_tar() {
    let data = std::fs::read(fixture("logs.tar")).unwrap();
    let expected = decoded_archive_entries("logs.tar", data.clone()).unwrap();
    let split = data.len() / 2 + 17;
    for (name, encode) in [
        ("logs.tar.xz", xz_stream as fn(&[u8]) -> Vec<u8>),
        ("logs.tar.bz2", bzip2_stream as fn(&[u8]) -> Vec<u8>),
    ] {
        let mut compressed = encode(&data[..split]);
        let second = encode(&data[split..]);
        compressed.extend_from_slice(&second);
        assert_eq!(
            decoded_archive_entries(name, compressed.clone()).unwrap(),
            expected,
            "{name}"
        );

        compressed.pop();
        assert!(decoded_archive_entries(name, compressed).is_err(), "{name}");
    }
}

#[test]
fn concatenated_xz_stream_padding_and_second_stream_checksums_are_validated() {
    let data = std::fs::read(fixture("logs.tar")).unwrap();
    let expected = decoded_archive_entries("logs.tar", data.clone()).unwrap();
    let split = data.len() / 2 + 17;
    let first = xz_stream(&data[..split]);
    let second = xz_stream(&data[split..]);
    for padding in [0, 4, 12] {
        let mut compressed = first.clone();
        compressed.resize(compressed.len() + padding, 0);
        compressed.extend_from_slice(&second);
        compressed.extend_from_slice(&[0; 8]);
        assert_eq!(
            decoded_archive_entries("logs.tar.xz", compressed).unwrap(),
            expected
        );
    }
    for padding in [1, 3, 5] {
        let mut compressed = first.clone();
        compressed.resize(compressed.len() + padding, 0);
        compressed.extend_from_slice(&second);
        assert!(decoded_archive_entries("logs.tar.xz", compressed).is_err());
    }
    for position in [0, second.len() - 4] {
        let mut compressed = first.clone();
        let mut corrupt = second.clone();
        corrupt[position] ^= 1;
        compressed.extend(corrupt);
        assert!(decoded_archive_entries("logs.tar.xz", compressed).is_err());
    }
}

#[test]
fn parallel_bzip2_rejects_corrupt_block_and_stream_checksums() {
    let compressed = bzip2_stream(&std::fs::read(fixture("logs.tar")).unwrap());
    for position in [10, compressed.len() - 2] {
        let mut corrupted = compressed.clone();
        corrupted[position] ^= 1;
        assert!(decoded_archive_entries("logs.tar.bz2", corrupted).is_err());
    }
}

#[test]
fn named_gzip_logs_keep_the_existing_decoder_path() {
    use std::io::Write;
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    encoder.write_all(b"GET /health 200 10ms\n").unwrap();
    let data = encoder.finish().unwrap();
    let items = expand_archive_bytes("api-out.log.gz", "api-out.log.gz", Cow::Owned(data), 0);
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].category, LogCategory::Pm2);
    assert_eq!(&*items[0].data, b"GET /health 200 10ms\n");
}

#[test]
fn legacy_parsers_expand_new_archive_formats() {
    configure_rayon_pool();
    for name in ["logs.7z", "logs.tar.gz", "logs.tar.bz2", "logs.tar.xz"] {
        let paths = [fixture(name)];
        let (_, pm2) = parse_pm2_files_internal(&paths, &Pm2ParseOptions::default(), None).unwrap();
        let (_, mongo) =
            parse_mongo_files_internal(&paths, &MongoFilterOptions::default(), None).unwrap();
        assert_eq!(pm2.hit_count, 1, "{name}");
        assert_eq!(mongo.slow_query_count, 1, "{name}");
    }
}

#[test]
fn rar4_and_rar5_solid_entries_are_decoded_in_order() {
    for name in ["rar3-solid.rar", "rar5-solid.rar"] {
        let mut entries = Vec::new();
        extended_archive::for_each_entry(
            name,
            extended_archive::ArchiveSource::Buffer(std::fs::read(fixture(name)).unwrap()),
            |name, bytes| entries.push((name.to_string(), bytes.into_owned())),
        )
        .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(entries.len(), 2, "{name}");
        assert_eq!(entries[0].0, "stest1.txt");
        assert_eq!(entries[1].0, "stest2.txt");
        assert_eq!(entries[0].1.len(), 2048);
        assert_eq!(entries[0].1, entries[1].1);
        assert_eq!(&entries[0].1[..16], b"000\n001\n002\n003\n");
    }
}

#[test]
fn rar_corrupt_compressed_data_is_rejected() {
    let mut bytes = std::fs::read(fixture("rar5-solid.rar")).unwrap();
    // The upstream fixture's first compressed member spans bytes 57..115.
    bytes[80] ^= 1;
    assert!(extended_archive::for_each_entry(
        "rar5-solid.rar",
        extended_archive::ArchiveSource::Buffer(bytes),
        |_, _| {},
    )
    .is_err());
}

#[test]
fn split_and_encrypted_rar_archives_report_the_limitation() {
    for (name, expected) in [
        ("rar5-vols.part1.rar", "Split RAR"),
        ("rar5-psw.rar", "Password-protected RAR"),
    ] {
        let error = extended_archive::for_each_entry(
            name,
            extended_archive::ArchiveSource::Buffer(std::fs::read(fixture(name)).unwrap()),
            |_, _| panic!("{name} must not produce entries"),
        )
        .unwrap_err();
        assert!(error.contains(expected), "{name}: {error}");
    }
}

#[test]
fn damaged_and_encrypted_archives_fail() {
    configure_rayon_pool();
    for name in ["corrupt.7z", "encrypted.7z"] {
        assert!(
            extended_archive::for_each_entry(
                name,
                extended_archive::ArchiveSource::Buffer(std::fs::read(fixture(name)).unwrap()),
                |_, _| panic!("{name} must not produce entries"),
            )
            .is_err(),
            "{name}"
        );
        assert!(
            ingest_native_internal(
                &[fixture(name)],
                &Pm2ParseOptions::default(),
                &MongoFilterOptions::default(),
                None,
                None,
                &state(),
            )
            .is_err(),
            "{name}"
        );
    }
}

#[test]
fn archive_aliases_and_signatures_are_classified_before_log_names() {
    for name in [
        "logs.RAR",
        "api-out.7z",
        "mongod.tar",
        "api-out.TGZ",
        "logs.tbz",
        "logs.tbz2",
        "logs.txz",
    ] {
        assert_eq!(
            classifier::classify_name(name),
            LogCategory::Archive,
            "{name}"
        );
        assert!(is_supported_folder_file(Path::new(name)), "{name}");
    }
    for name in ["logs.7z", "logs.tar", "rar3-solid.rar", "rar5-solid.rar"] {
        let data = std::fs::read(fixture(name)).unwrap();
        assert_eq!(
            classifier::classify_file_or_entry("api-out.log", &data),
            LogCategory::Archive
        );
    }
    assert_eq!(
        classifier::classify_file_or_entry("mongod.log.gz", b"\x1f\x8b"),
        LogCategory::Gzip
    );
}

#[test]
fn recursive_archives_stop_at_depth_limit() {
    let data = std::fs::read(fixture("logs.7z")).unwrap();
    assert!(
        expand_archive_bytes("logs.7z", "logs.7z", Cow::Owned(data), MAX_ARCHIVE_DEPTH).is_empty()
    );
}

fn gzip_tar_entry(name: &str, data: &[u8]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    archive.append_data(&mut header, name, data).unwrap();
    archive.into_inner().unwrap().finish().unwrap()
}

#[test]
fn streamed_archives_preserve_oversized_lines_and_final_partial_lines() {
    configure_rayon_pool();
    let mut data = b"GET /health 200 10 ms - 42\n".to_vec();
    data.resize(17 * 1024 * 1024, b'x');
    data.extend_from_slice(b"\nGET /ready 200 11 ms - 43");
    let outcome = pipeline_extended_archive(
        "logs.tar.gz",
        "logs.tar.gz",
        extended_archive::ArchiveSource::Buffer(gzip_tar_entry("api-out.log", &data)),
        0,
        &Pm2ShardOptions::new(&Pm2ParseOptions::default()),
        &SharedProgress::new(None, data.len() as u64),
        2,
    );
    assert!(outcome.archive_errors.is_empty());
    assert_eq!(
        outcome
            .pm2_shards
            .iter()
            .map(|shard| shard.hit_count())
            .sum::<u32>(),
        2
    );
    assert_eq!(
        outcome
            .pm2_shards
            .iter()
            .map(|shard| shard.unmatched_count())
            .sum::<u32>(),
        1
    );
    assert_eq!(outcome.files.len(), 1);
    assert_eq!(outcome.files[0].size, data.len() as u64);
}

#[test]
fn bad_compression_trailers_discard_already_parsed_stream_chunks() {
    configure_rayon_pool();
    let line = b"GET /health 200 10 ms - 42\n";
    let data = line.repeat((17 * 1024 * 1024) / line.len());
    let mut archive = gzip_tar_entry("api-out.log", &data);
    let trailer = archive.len() - 8;
    archive[trailer] ^= 1;
    let outcome = pipeline_extended_archive(
        "logs.tar.gz",
        "logs.tar.gz",
        extended_archive::ArchiveSource::Buffer(archive),
        0,
        &Pm2ShardOptions::new(&Pm2ParseOptions::default()),
        &SharedProgress::new(None, data.len() as u64),
        2,
    );
    assert!(!outcome.archive_errors.is_empty());
    assert!(outcome.pm2_shards.is_empty());
    assert!(outcome.mongo_shards.is_empty());
    assert!(outcome.files.is_empty());
}

#[test]
fn nested_streaming_archives_work_with_one_rayon_worker() {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(1)
        .stack_size(16 * 1024 * 1024)
        .build()
        .unwrap();
    let outcome = pool.install(|| {
        pipeline_extended_archive(
            "nested.7z",
            "nested.7z",
            extended_archive::ArchiveSource::Buffer(std::fs::read(fixture("nested.7z")).unwrap()),
            0,
            &Pm2ShardOptions::new(&Pm2ParseOptions::default()),
            &SharedProgress::new(None, 1),
            1,
        )
    });
    assert!(outcome.archive_errors.is_empty());
    assert_eq!(
        outcome
            .pm2_shards
            .iter()
            .map(|shard| shard.hit_count())
            .sum::<u32>(),
        1
    );
    assert_eq!(
        outcome
            .mongo_shards
            .iter()
            .map(|shard| shard.slow_query_count())
            .sum::<u32>(),
        1
    );
}

fn canonical_mongo(mut value: serde_json::Value) -> serde_json::Value {
    match &mut value {
        serde_json::Value::Object(fields) => {
            fields.remove("id");
            for field in fields.values_mut() {
                *field = canonical_mongo(std::mem::take(field));
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                *item = canonical_mongo(std::mem::take(item));
            }
            items.sort_by_cached_key(serde_json::Value::to_string);
        }
        _ => {}
    }
    value
}

fn mongo_snapshot(shards: Vec<mongo_core::MongoEngine>) -> serde_json::Value {
    let mut engine = mongo_core::MongoEngine::new();
    for shard in shards {
        engine.merge(shard);
    }
    canonical_mongo(
        serde_json::from_str(&filtered_mongo_json(
            &engine,
            &MongoFilterOptions::default(),
        ))
        .unwrap(),
    )
}

#[test]
fn streamed_mongo_preserves_logical_shard_caches_and_full_report() {
    configure_rayon_pool();
    let mut query = String::new();
    extended_archive::for_each_entry(
        "logs.tar",
        extended_archive::ArchiveSource::Buffer(std::fs::read(fixture("logs.tar")).unwrap()),
        |name, bytes| {
            if name == "mongod.log" {
                query = String::from_utf8(bytes.into_owned()).unwrap().replace(
                    "\"durationMillis\"",
                    "\"queryHash\":\"AAA\",\"durationMillis\"",
                );
            }
        },
    )
    .unwrap();
    let mut data = br#"{"t":{"$date":"2026-07-24T00:00:09.000+00:00"},"ctx":"conn1","msg":"Authentication succeeded","attr":{"user":"alice","db":"test"}}
"#.to_vec();
    let padding = format!(
        "{{\"msg\":\"padding\",\"data\":\"{}\"}}\n",
        "x".repeat(4096)
    );
    for (position, key) in [(0, "first"), (17, "second"), (25, "third"), (33, "fourth")] {
        while data.len() < position * 1024 * 1024 {
            data.extend_from_slice(padding.as_bytes());
        }
        data.extend_from_slice(
            query
                .replace("\"id\":1", &format!("\"{key}\":1"))
                .as_bytes(),
        );
    }
    while data.len() < 40 * 1024 * 1024 {
        data.extend_from_slice(padding.as_bytes());
    }
    let progress = SharedProgress::new(None, data.len() as u64);
    let expected = mongo_snapshot(parse_mongo_slice(&data, &progress, 2));
    assert_eq!(expected["patterns"].as_array().unwrap().len(), 2);
    let outcome = pipeline_extended_archive(
        "logs.tar.gz",
        "logs.tar.gz",
        extended_archive::ArchiveSource::Buffer(gzip_tar_entry("mongod.log", &data)),
        0,
        &Pm2ShardOptions::new(&Pm2ParseOptions::default()),
        &progress,
        2,
    );
    assert!(outcome.archive_errors.is_empty());
    assert_eq!(mongo_snapshot(outcome.mongo_shards), expected);
}
