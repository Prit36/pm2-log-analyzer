# Nginx access analysis

The Nginx tab runs the same Rust core in browser Wasm and the Tauri desktop application. It accepts standard combined access logs, including rotated files and entries inside the existing supported archive formats. Custom `log_format` layouts and Nginx error logs are outside this version.

## Formats and metrics

```text
94.206.29.30 - - [13/Oct/2026:12:33:59 +0400] "POST /api/admin/claims/motor/claim/v2/getAllClaimContainers?page=1&size=10 HTTP/1.1" 200 866 "https://portal.methaq.ae/" "Mozilla/5.0"
94.206.29.30 - - [13/Oct/2026:12:33:59 +0400] "POST /api/admin/claims/motor/claim/v2/getAllClaimContainers?page=1&size=10 HTTP/1.1" 200 866 "https://portal.methaq.ae/" "Mozilla/5.0" rt=0.845 urt=0.842
```

The first line contributes requests, status, bytes, client, referrer, and user-agent metrics. Its latency is unavailable. The second has a request time of 845 ms and an upstream time of 842 ms. Optional timings may occur independently or in either order. Finite nonnegative values are measured timings, including `0.000`; missing values, `-`, and malformed values never become artificial zero samples. Invalid timing fields are counted in parse diagnostics without discarding otherwise valid access lines.

`urt` lists use the sum of recorded numeric attempts separated by commas or colons. For example, `urt="0.010, 0.020 : 0.030"` contributes 60 ms. Unavailable attempts do not contribute a duration. This metric is labelled total recorded upstream time.

All HTTP methods are counted. The errors metric includes 4xx and 5xx responses. Bytes mean the combined format's `body_bytes_sent`, excluding response headers. Day/hour grouping follows the date and hour written in the log; the offset is parsed without converting to the computer timezone. Logs from different offsets therefore retain their respective local time labels.

Path normalization matches PM2's existing Exact / Strip query / Collapse IDs modes. Filters affect every report aggregate. A positive minimum-duration threshold excludes requests lacking the selected metric; the default zero threshold retains untimed requests. Percentiles use nearest-rank selection over logarithmic buckets with approximately 1% relative accuracy, including valid zero measurements. With two measured times of 0 and 845 ms, p95 selects the positive sample's bucket rather than zero.

Endpoint results are sorted globally before Top N is applied. The overview's "Slowest endpoints" (p95 of the selected timing, endpoints with at least 10 timed requests) and "Most errors" lists are ranked over all endpoint groups in the core, independent of the table sort and Top N. Clients, referrers, and user agents show the exact top 100 by requests, plus total distinct counts. Their logged values are retained without user-agent classification or referrer rewriting. Spreadsheet export includes the displayed report, both timing metrics, coverage, and filter metadata; it does not export every raw request.

## Execution and memory

- Rust retains compact request rows and interned strings; React receives aggregated reports.
- Browser input is split on newline boundaries across at most four persistent workers. Each uses a reusable ingest window of at most 32 MiB, with each file boundary flushed independently.
- Extracted archive buffers transfer directly to the parser; they are not retained as placeholder files for later reparsing.
- Partial reports use a binary wire format with quantile buckets and full group counts. Global merging precedes any top-list truncation.
- Native raw files use mmap slices and the existing Rayon pool. Commands run outside the WebView IPC thread and return reports through the loopback payload server.
- Append stages incoming shards and commits after successful aggregation. Failure or cancellation preserves committed data. Replace releases the previous dataset before parsing, so cancellation of a replacement leaves an empty Nginx dataset. Clear affects only Nginx and invalidates pending results.

## Verified measurements

Measured on the local Windows system on 2026-10-19 with a generated 166.4 MiB log containing 1,048,576 requests, 128 normalized endpoint groups, 256 clients, and 32 user agents. Both request and upstream timings are present on approximately 80% of requests. Three runs used the real production browser app and the release Tauri app.

| Metric | Browser Wasm | Native Tauri |
|---|---:|---:|
| Upload to painted KPIs | 405–482 ms | 115–141 ms |
| Parse and aggregate | 356–440 ms | 95–103 ms |
| Filter reaggregation | 10–53 ms | Not measured in this run |
| Sampled Chromium working set | 686–711 MiB | Not sampled by the timing runner |

Temporary verification also checked exact canonical browser/native report parity, valid zero and missing timings, chunk/file boundaries, append rollback and cancellation, all five dashboard views, the nine-sheet spreadsheet export, light/dark layouts, and a 390 px mobile viewport without page overflow. A mixed PM2/Mongo/Nginx ZIP populated all three stores; clearing each Nginx/native dataset preserved the other relevant datasets. The existing methaq ZIP regression produced 907,336 PM2 requests and 82,191 Mongo slow queries in both browser and native targets.

Lint/typecheck, production web and release native builds, Rust checks, Wasm regeneration, and formatting checks for changed source/config files passed. The full repository formatting check still reports four pre-existing, unchanged files: two RAR benchmark JSON reports and the vendored RAR / ZIP Cargo manifests.

## Reproduce measurements

```bash
pnpm wasm:build
pnpm lint
pnpm build
pnpm bench:nginx /path/to/access.log --runs 3 --skip-build
pnpm tauri build --no-bundle
pnpm bench:native:nginx /path/to/access.log --runs 3
# Mixed PM2/Mongo/Nginx archive, with peak working-set sampling:
pnpm bench:batch /path/to/mixed.zip --expect all --no-history
```

The browser runner reports parse time, upload-to-painted-KPI latency, filter reaggregation, frame gaps, and sampled Chromium working set on Windows. The native runner reports upload-to-paint, native/invoke/assembly timings, frame gaps, and DOM progress; the batch runner also samples native process-tree working set. RSS sampling is approximate and may miss brief peaks. Benchmark output goes to stdout; progress goes to stderr. Run benchmarks sequentially on an otherwise idle machine. A representative production Nginx log is needed to establish production throughput and memory; generated corpora only validate scaling for their chosen field cardinalities.
