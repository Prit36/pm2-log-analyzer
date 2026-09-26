# PM2 & MongoDB Log Analyzer

High-performance, client-side ops console and native desktop application for massive PM2 HTTP access logs, cron jobs, and MongoDB query logs. Ingest raw log files, gzip archives, zip archives, or entire directories—get real-time KPI metrics, filterable API and query tables, percentile charts, execution diagnostics, and formatted Excel workbooks.

Runs 100% locally with zero backend dependencies. Logs never leave your machine.

---

## Dual Targets

The analyzer supports two first-class runtime targets sharing a unified React 19 UI:

1. **Browser Web Application (WebAssembly + Web Workers)**:
   - Zero-install, client-side Single Page Application (SPA).
   - Rust engines compiled to WebAssembly with SIMD128, relaxed-simd, and Binaryen `wasm-opt -O3`.
   - Multi-threaded Web Worker architecture with zero-copy transferable `ArrayBuffer` pipelines.
   - Cross-Origin Isolation (COOP/COEP) enabled.
2. **Native Desktop Application (Tauri v2 + Rust)**:
   - Standalone desktop shell running native Rust cores directly on the host OS.
   - Memory-mapped file I/O (`mmap`) with Rayon multi-threading (up to 16 CPU shards).
   - High-throughput entry decompression via `libdeflater` and streaming raw-deflate iterators.
   - Ephemeral loopback HTTP payload server (`PayloadServer` on `127.0.0.1` at 300+ MB/s) to eliminate IPC serialization bottlenecks.
   - Detached-thread unmapping to avoid Windows `UnmapViewOfFile` stalls.

---

## Features

### Ingestion & Archive Pipeline
- **Flexible Sources**: Single log files (`.log`, `.txt`), compressed logs (`.gz`, `.gzip`), ZIP archives (`.zip`), nested folders/directories, and pasted text.
- **Smart Auto-Classification**: Automatically detects and categorizes PM2 vs. MongoDB entries, skips irrelevant assets/system files, and dispatches them to their respective engines.
- **Batch Multi-Archive Import**: Parallel decompression and direct shard partitioning for multi-archive or multi-file drops.
- **Session Control**: Append additional logs to an active session or replace existing analysis.
- **Privacy First**: All parsing and aggregation executes locally. No log data or telemetry is ever transmitted over the network.
- **Excel Export**: Generate formatted multi-sheet Excel workbooks (`.xlsx`) for PM2 endpoints, cron jobs, MongoDB slow queries, and query patterns.

### PM2 HTTP & Cron Analysis
- **Noise Filtering**: Automatically drops `OPTIONS` preflight requests (typically ~25.9% of corpus) and Socket.IO/websocket tracking frames (~10.8%) at parse time.
- **KPI Summary**: Total requests, matched HTTP lines, unmatched lines, error rate, p95 duration, slow call count, unique endpoints, and active cron jobs.
- **Dynamic Filtering**: Filter by HTTP method (`GET`, `POST`, `PUT`, `DELETE`, etc.), HTTP status family (`2xx`, `3xx`, `4xx`, `5xx`), minimum duration threshold, path search (substring/regex), and time ranges.
- **Path Normalization**: Three modes—`exact` (verbatim URL), `strip query` (removes query strings), or `collapse IDs` (normalizes numeric and UUID path segments).
- **Virtualized API Table**: Sort by hits, avg duration, p50, p90, p95, p99, error count, and error rate. One-click copy for endpoint paths and status code breakdowns.
- **Latency Distribution Chart**: Logarithmic histogram powered by `RelHist` sketches with interactive bucket inspection and wide/side-by-side layout toggles.
- **Cron Job Monitor**: Tracks schedules, execution counts, completions, failures, run durations, and copy-as-TSV export.

### MongoDB Slow Query & Performance Diagnostics
- **Structured JSON Ingestion**: Supports MongoDB 4.4, 5.0, 6.0, and 7.0+ structured JSON logs (`mongod.log`).
- **Slow Query Detection**: Ingests operations flagged with `"msg":"Slow query"` and duration metrics.
- **Query Pattern Fingerprinting**: Normalizes predicates, projections, and sort specifications to group similar queries into actionable patterns.
- **5 Dedicated Views**:
  1. **Query Patterns**: Grouped patterns with frequency, execution plan, `docsExamined` vs. `nreturned` ratios, and latency quantiles.
  2. **Slow Queries**: Virtualized query log browser with namespace, duration, and execution plan filtering.
  3. **User & Client Activity**: Connection tracking, client IP addresses, authenticated users, and operation distributions.
  4. **Latency & Distribution Charts**: Interactive hourly timeline and operation type breakdowns (`query`, `update`, `aggregate`, `command`).
  5. **Diagnostics & Index Recommendations**: Automatic detection of unindexed `COLLSCAN` queries and high scan-to-return ratios with suggested compound indexes.
- **Query Detail Modal**: Deep inspection of raw query JSON, parsed filters, sort keys, execution stats, and explain plan diagnostics.

---

## Tech Stack

| Layer | Technology | Details |
|---|---|---|
| **UI** | React 19, Tailwind CSS 4, Zustand, Recharts, react-window | Reactive UI with grouped shallow selectors, dark/light theme, virtualized data tables |
| **App Shell** | TypeScript 7 (strict), Vite 8 | Fast build, scoped Tailwind styles, zero network dependencies |
| **Desktop Shell** | Tauri v2, WebView2, Rayon | Native OS integration, background progress streaming, loopback payload server |
| **Tooling** | oxlint, oxfmt, Playwright | High-speed linting, formatting, and automated browser/CDP benchmarks |
| **PM2 Engine** | Rust → Wasm / Native (`wasm/pm2-core`) | 16-byte `PackedEntry` columnar vectors, SIMD `memchr_iter`, `RelHist` logarithmic histograms, `rapidhash` |
| **MongoDB Engine** | Rust → Wasm / Native (`wasm/mongo-core`) | Zero-alloc JSON scanners, cascading forward metric cursors, string intern arenas, query shape normalizer |
| **ZIP Engine** | Rust → Wasm / Native (`wasm/zip-core`) | Pure-Rust SIMD `zlib-rs` (browser) and `libdeflater` (native), zero-copy slice extraction |

---

## Benchmarks & Performance

Measured on the reference test system:
- **CPU**: Intel Core i5-12400F (6 cores / 12 threads)
- **RAM**: 16 GB DDR4
- **OS**: Windows 11 Pro (build 26200)
- **Runner**: Chromium via Playwright (Browser Wasm) & WebView2 CDP (Native Tauri)

### 1. PM2 Large-Scale Ingestion (5.22 GiB Stress Corpus)
Corpus: `test_data/api-out-5gb.log` (5,350 MiB, ~53.4M lines: 20.3M matched HTTP, 33.1M unmatched lines, 5,416 endpoints, 9 cron jobs).

| Metric | Browser Wasm (4 workers) | Native Desktop (Tauri + Rayon) |
|---|---|---|
| **Parse Wall** | **4.23 s** | **~1.05 – 1.40 s** |
| **Upload → KPI Ready** | **4.25 s** | **1.52 s** |
| **Throughput** | **1,265.5 MB/s** | **3,400 – 3,600+ MB/s** |
| **Peak Working Set / RSS** | **~1.62 GiB** | **~1.8 – 2.4 GiB** |
| **Filter Reaggregation (Avg)** | **~96.5 ms** | **~18 – 35 ms** |
| **Committed Ingest Memory** | Bounded (4 × 32 MiB) | Zero-copy `mmap` |

*Historical context: Before workers and streaming (`ef58f1f`), ~50 MB files crashed the browser tab. On the earlier 535 MiB corpus, parse dropped from 12.2 s (JS baseline) → 0.98 s (Wasm) → 196 ms (Native).*

### 2. MongoDB Log Analysis (336 MiB `mongod.log`)
Corpus: `mongodb_logs_sample/methaq-mongod.log` (335.9 MiB, 56,872 slow queries, 9,656 `COLLSCAN`s, 395 query patterns, 51 collections).

| Metric | Browser Wasm (2 workers) | Native Desktop (Tauri + Rayon) |
|---|---|---|
| **Parse Wall** | **348 ms** | **65 ms** (down to 57 ms) |
| **Upload → UI Ready** | **368 ms** | **147 ms** (down to 104 ms) |
| **Throughput** | **964.8 MB/s** | **5,168+ MB/s** (native wall) |
| **Peak Working Set / RSS** | **~337 MB** (post-parse reclaimed) | **~815 MB** |
| **Filter Reaggregation (Avg)** | **21.8 ms** | **17.3 ms** (down to 14 ms) |

### 3. ZIP Archive Ingestion (81.2 MiB Archive → 727 MiB Decompressed)
Corpus: `methaq-api&mongodb-07-09.zip` (contains mixed PM2 HTTP logs and MongoDB JSON logs).

| Metric | Browser Wasm | Native Desktop (Tauri) |
|---|---|---|
| **Extraction Wall** | **0.65 s** (`zlib-rs` worker pool) | **~180 – 240 ms** (`libdeflater`) |
| **Upload → UI Ready** | **1.50 s** (extract + PM2 + Mongo) | **~447 – 610 ms** |
| **Archive Throughput** | **1,064 MB/s** (uncompressed) | **>1,600 MB/s** (uncompressed) |
| **Peak Working Set / RSS** | **~1.61 GiB** (down from 3.7 GiB) | **~520 – 840 MB** |

### 4. Multi-Archive Batch Import (9 Files / 247.6 MiB Compressed)
Corpus: 9 mixed archives and compressed files (`.zip`, `.gz`) yielding 3.72M PM2 requests and 81.8K Mongo slow queries.

| Metric | Browser Wasm | Native Desktop (Tauri) |
|---|---|---|
| **Upload → UI Ready** | **2,818 ms** (2.82 s) | **812 ms** (1.71× faster) |
| **Native Wall** | — | **586 ms** (2.01× faster) |
| **Peak Working Set / RSS** | **4,155 MB** (4.15 GiB) | **2,549 MB** (2.55 GiB) |

---

## Architecture & Engineering Highlights

```text
[ Browser / Web Target ]
File Drop / Pick (log, gz, zip, folder)
  → Parallel Worker Pool (zlib-rs RFC 1951 raw deflate / gzip)
  → PM2: 4 Persistent Shard Workers
       32 MiB reusable Wasm ingest window (ingest_ptr + feed)
       16-byte PackedEntry struct vectors
       SIMD memchr newline batching & fast first-byte probe gate
       Early shards run ENSURE_MODE(collapseIds) while siblings feed
  → Mongo: Sharded Wasm Workers
       Cascading forward JSON metric cursors (extract_forward_*)
       Compact binary wire format (encode_shard + merge_shard_bytes)
       Immediate post-parse worker termination (reclaims 50% RSS)
  → RelHist logarithmic histogram sketch merge
  → Zustand reactive store → React 19 UI (virtualized tables)

[ Native Desktop Target (Tauri v2) ]
File Drop / Pick / Directory Picker
  → Background async command (AppHandle::state::<AppState>())
  → Memory-mapped files (mmap) partitioned across Rayon thread pool
  → Zero-copy slice parsing (feed_slice) with LINE_EXTEND lookahead
  → Streaming ZIP extraction via libdeflater and archive::DeflateStream
  → Fused Rust finalizer (finalize.rs) with cache-partitioned hash merge
  → Result delivered over ephemeral 127.0.0.1 PayloadServer (300+ MB/s)
  → Detached background thread handles UnmapViewOfFile (zero UI freeze)
```

---

## Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v20+ recommended)
- [Rust toolchain](https://rustup.rs/) (for native desktop app or compiling Wasm)

### 1. Web Application (Browser SPA)

```bash
# Install dependencies
npm install

# Start local development server
npm run dev

# Build production bundle
npm run build

# Preview production build locally
npm run preview
```

### 2. Desktop Application (Tauri v2)

```bash
# Run desktop app in development mode
npm run tauri:dev

# Build standalone release executable (no installer bundle)
npm run build:exe
# Executable generated at: src-tauri/target/release/app.exe
```

### 3. Linting & Formatting

```bash
# Lint with oxlint and TypeScript
npm run lint

# Automatically apply safe lint fixes
npm run lint:fix

# Format code with oxfmt
npm run fmt

# Check formatting
npm run fmt:check
```

### 4. Rebuild WebAssembly Modules (Optional)

Recompiles Rust crates to Wasm and embeds optimized byte arrays into TypeScript files (`src/wasm/*Bytes.ts`):

- Requires `wasm32-unknown-unknown` target.
- Requires `wasm-bindgen-cli` (v0.2.126 matching `Cargo.toml`).
- Requires `wasm-opt` from [Binaryen](https://github.com/WebAssembly/binaryen/releases) on your `PATH`.

```bash
npm run wasm:build
```

---

## Benchmark Suite

Automated Playwright and CDP-driven benchmark scripts reside in `scripts/bench/`:

```bash
# Benchmark PM2 parser in browser (defaults to test_data/api-out-5gb.log)
npm run bench -- --runs 5 --note "pm2-browser"

# Benchmark MongoDB parser in browser
npm run bench:mongo -- --runs 3

# Benchmark ZIP extraction and parsing in browser
npm run bench:zip

# Benchmark PM2 native desktop pipeline (requires npm run build:exe first)
npm run bench:native -- test_data/api-out-5gb.log --runs 3

# Benchmark MongoDB native desktop pipeline
npm run bench:native:mongo

# Benchmark ZIP archive native desktop pipeline
npm run bench:native:zip

# Benchmark batch multi-archive import (browser & native comparison)
npm run bench:batch
```

Benchmark histories and stage breakdowns are appended to `scripts/bench/*_history.json`.

---

## Project Structure

```text
├── src/
│   ├── components/        # React components (ApiTable, FilterBar, LatencyChart, KpiRow)
│   │   └── mongo/         # Mongo views (Patterns, SlowQueries, Diagnostics, UserActivity)
│   ├── hooks/             # Worker and store bridge hooks
│   ├── mongo/             # MongoDB domain types, formatting, and Excel export
│   ├── services/          # Native Tauri IPC bridge (nativeBridge.ts)
│   ├── store/             # Zustand state stores (analysisStore, mongoStore, appModeStore)
│   ├── utils/             # Formatters, RelHist sketches, ZIP extractor (zipExtractor.ts)
│   ├── wasm/              # Embedded Wasm bytes and wasm-bindgen glue
│   └── workers/           # Web Workers (logParserWorker, mongoParserWorker, zipExtractWorker)
├── src-tauri/             # Tauri v2 native desktop application (Rust)
│   ├── src/
│   │   ├── archive.rs     # Decompression engine (libdeflater, DeflateStream)
│   │   ├── finalize.rs    # Fused result finalizer and RelHist merge
│   │   ├── payload.rs     # Ephemeral loopback HTTP payload server
│   │   └── lib.rs         # Rayon sharded ingest, Tauri commands, mmap management
│   └── tauri.conf.json    # Tauri desktop configuration
├── wasm/
│   ├── pm2-core/          # Rust crate: PM2 parsing, normalization, RelHist
│   ├── mongo-core/        # Rust crate: MongoDB JSON parsing, query fingerprinting
│   └── zip-core/          # Rust crate: SIMD zlib-rs deflate/gzip decompressor
├── scripts/
│   ├── bench/             # Benchmark scripts & historical JSON logs
│   └── wasm-build.mjs     # Multi-crate Wasm compilation & wasm-opt optimizer script
└── test_data/             # Sample and stress corpus log files
```

---

## License

Private / Internal repository. All rights reserved.
