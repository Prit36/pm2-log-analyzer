use mongo_core::MongoEngine;
use std::hint::black_box;
use std::time::Instant;

fn main() {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "mongodb_logs_sample/methaq-mongod.log".to_owned());
    let data = std::fs::read(path).expect("read MongoDB fixture");
    let mut engine = MongoEngine::new();
    let parse_started = Instant::now();
    for chunk in data.chunks(16 * 1024 * 1024) {
        engine.feed_slice(chunk);
    }
    engine.end_shard();
    eprintln!(
        "parse_ms={} slow_queries={}",
        parse_started.elapsed().as_millis(),
        engine.slow_query_count(),
    );

    for query in ["cash", "zzunlikelysearchtoken"] {
        for run in 0..9 {
            let started = Instant::now();
            let json = engine.reaggregate("all", 0, 0, "all", query, false, "all");
            let elapsed = started.elapsed();
            black_box(json.len());
            println!(
                "query={query} run={run} reagg_ms={} json_len={}",
                elapsed.as_secs_f64() * 1000.0,
                json.len(),
            );
        }
    }
}
