use super::{merge_pm2_partials, Engine};

#[test]
fn chunked_matches_oneshot() {
    let sample = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n\
socket connected\n\
2026-07-24T00:00:11: POST /api/x 201 3.1 ms - -\n";
    let mut oneshot = Engine::new();
    oneshot.parse_shard(sample, 0, sample.len(), sample.len());

    let mut chunked = Engine::new();
    chunked.begin_shard(0, sample.len() as u64, sample.len() as u64);
    let mut offset = 0usize;
    while offset < sample.len() {
        let take = (sample.len() - offset).min(17);
        let _ = chunked.ingest_ptr(take as u32);
        chunked.ingest[..take].copy_from_slice(&sample[offset..offset + take]);
        chunked.feed(take as u32, offset as u64);
        offset += take;
    }
    chunked.end_shard();
    assert_eq!(oneshot.hit_count(), chunked.hit_count());
    assert_eq!(oneshot.unmatched_count(), chunked.unmatched_count());
    assert_eq!(oneshot.hit_count(), 2);
    assert_eq!(oneshot.unmatched_count(), 1);
}

#[test]
fn hourly_wire_uses_timestamp_hours() {
    let sample = b"2026-07-24T03:00:10: GET /api/a 200 12.5 ms - 42\n\
2026-07-24T15:00:11: POST /api/b 500 40 ms - 1\n\
40ms GET /api/c\n";
    let mut engine = Engine::new();
    engine.parse_shard(sample, 0, sample.len(), sample.len());

    let wire = engine.hourly_wire();
    assert_eq!(&wire[0..4], &0x504D3248u32.to_le_bytes());
    assert_eq!(u16::from_le_bytes(wire[4..6].try_into().unwrap()), 1);
    assert_eq!(u16::from_le_bytes(wire[6..8].try_into().unwrap()), 24);

    let mut offset = 8usize;
    let mut records = [(0u32, 0u32, 0.0f64, 0.0f32); 24];
    for record in &mut records {
        record.0 = u32::from_le_bytes(wire[offset..offset + 4].try_into().unwrap());
        record.1 = u32::from_le_bytes(wire[offset + 4..offset + 8].try_into().unwrap());
        record.2 = f64::from_le_bytes(wire[offset + 8..offset + 16].try_into().unwrap());
        record.3 = f32::from_le_bytes(wire[offset + 16..offset + 20].try_into().unwrap());
        let sketch_len =
            u32::from_le_bytes(wire[offset + 20..offset + 24].try_into().unwrap()) as usize;
        offset += 24 + sketch_len;
    }

    assert_eq!(records[3].0, 1);
    assert_eq!(records[3].1, 0);
    assert!((records[3].2 - 12.5).abs() < 0.01);
    assert!((records[3].3 - 12.5).abs() < 0.01);
    assert_eq!(records[15].0, 1);
    assert_eq!(records[15].1, 1);
    assert!((records[15].2 - 40.0).abs() < 0.01);
    assert!((records[15].3 - 40.0).abs() < 0.01);
    assert_eq!(records[0].0, 0);

    assert_eq!(offset, wire.len());
}

#[test]
fn multi_day_dates_and_reaggregate() {
    let sample = b"2026-08-14T10:00:00: GET /api/users 200 50 ms - 100\n\
2026-08-14T11:00:00: POST /api/orders 201 120 ms - 200\n\
2026-08-15T09:00:00: GET /api/users 200 40 ms - 100\n\
2026-08-15T10:00:00: GET /api/health 200 5 ms - 20\n";
    let mut engine = Engine::new();
    engine.parse_shard(sample, 0, sample.len(), sample.len());

    assert_eq!(engine.hit_count(), 4);
    assert_eq!(engine.dates.len(), 2);
    assert_eq!(engine.dates[0], *b"2026-08-14");
    assert_eq!(engine.dates[1], *b"2026-08-15");

    // reaggregate all days
    let all_wire = engine.reaggregate(0, 0, 0.0, b"", true);
    assert!(!all_wire.is_empty());

    // reaggregate day 1 only
    let day1_wire = engine.reaggregate(0, 0, 0.0, b"2026-08-14", true);
    assert!(!day1_wire.is_empty());

    // daily wire
    let daily = engine.daily_wire();
    assert!(!daily.is_empty());
    assert_eq!(&daily[0..4], &0x504D3244u32.to_le_bytes());
}

#[test]
fn mid_line_chunk_boundary() {
    let sample = b"2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n";
    let split = 20; // inside timestamp
    let mut engine = Engine::new();
    engine.begin_shard(0, sample.len() as u64, sample.len() as u64);
    let _ = engine.ingest_ptr(split as u32);
    engine.ingest[..split].copy_from_slice(&sample[..split]);
    engine.feed(split as u32, 0);
    let rest = sample.len() - split;
    let _ = engine.ingest_ptr(rest as u32);
    engine.ingest[..rest].copy_from_slice(&sample[split..]);
    engine.feed(rest as u32, split as u64);
    engine.end_shard();
    assert_eq!(engine.hit_count(), 1);
    assert!(engine.summary_ready);
    assert!(engine.summary_sum > 0.0);
}

#[test]
fn boundary_after_newline_keeps_first_line() {
    let sample = b"first line\n2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n";
    let start = 11u64;
    let mut engine = Engine::new();
    engine.begin_shard(start, sample.len() as u64, sample.len() as u64);
    let suffix = &sample[start as usize - 1..];
    let _ = engine.ingest_ptr(suffix.len() as u32);
    engine.ingest[..suffix.len()].copy_from_slice(suffix);
    engine.feed(suffix.len() as u32, start - 1);
    engine.end_shard();
    assert_eq!(engine.hit_count(), 1);
    assert_eq!(engine.unmatched_count(), 0);
}

#[test]
fn offsets_above_u32_remain_exact() {
    let sample = b"partial shard prefix\n2026-07-24T00:00:10: GET /api/health 200 12.5 ms - 42\n";
    let start = 4_500_000_000u64;
    let end = start + sample.len() as u64;
    let mut engine = Engine::new();
    engine.begin_shard(start, end, end + 1);
    let _ = engine.ingest_ptr(sample.len() as u32);
    engine.ingest[..sample.len()].copy_from_slice(sample);
    engine.feed(sample.len() as u32, start);
    engine.end_shard();
    assert_eq!(engine.hit_count(), 1);
    assert_eq!(engine.unmatched_count(), 0);
}

#[test]
fn merge_pm2_partials_combines_shards() {
    let sample_a = b"2026-07-24T00:00:10: GET /api/user 200 10.0 ms - 42\n";
    let sample_b = b"2026-07-24T00:00:11: GET /api/user 200 20.0 ms - 42\n\
2026-07-24T00:00:12: POST /api/login 201 5.0 ms - 10\n";
    let mut engine_a = Engine::new();
    engine_a.parse_shard(sample_a, 0, sample_a.len(), sample_a.len());
    let wire_a = engine_a.reaggregate(0, 0, 0.0, b"", true);

    let mut engine_b = Engine::new();
    engine_b.parse_shard(sample_b, 0, sample_b.len(), sample_b.len());
    let wire_b = engine_b.reaggregate(0, 0, 0.0, b"", true);

    let merged = merge_pm2_partials(&[wire_a, wire_b]);
    assert_eq!(&merged[0..4], &0x504D3250u32.to_le_bytes());
    let endpoint_count = u32::from_le_bytes(merged[8..12].try_into().unwrap());
    assert_eq!(endpoint_count, 2);
    let total_matched = u32::from_le_bytes(merged[12..16].try_into().unwrap());
    assert_eq!(total_matched, 3);
}
