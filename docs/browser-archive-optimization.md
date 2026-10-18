# Browser archive optimization — 2026-10-17

Browser-only changes measured against the clean starting commit `c7d4625`. Native extraction code is unchanged. [Raw results](../scripts/bench/browser_archive_optimization_results.json) include all 42 runs, parser stages, memory samples, min/max ranges, throughput, and output hashes.

This report records the first optimization pass. RAR was subsequently migrated entirely to Rust Wasm; see [the RAR migration and additional benchmarks](browser-rar-rust-migration.md) for the current implementation.

## Measurements

Windows x64, Intel Core i5-12400F (6 cores / 12 threads), Chromium 153.0.8010.12, Node 26.5.0. Three fresh browser processes per format and phase; production Vite preview; warm OS file caches. Benchmarks ran serially without concurrent builds or tests.

Each format expands to **727,458,188 bytes (693.76 MiB)** across two logs. All 42 runs produced **907,336 API requests, 82,191 slow queries, and 573 patterns**. UI-ready time includes extraction, parsing, KPI DOM updates, and two animation frames.

| Format | Input MiB | Extraction ms before → after | UI-ready ms before → after | UI latency change | Extraction MiB/s before → after |
|---|---:|---:|---:|---:|---:|
| 7z | 47.95 | 963 → 777 | 1,504 → 1,226 | -18.5% | 727.8 → 892.7 |
| TAR | 693.76 | 1,165 → 318 | 2,024 → 857 | -57.6% | 675.0 → 2,179.4 |
| TAR.GZ | 79.69 | 1,125 → 1,153 | 1,850 → 1,801 | -2.7% | 619.3 → 602.2 |
| TAR.BZ2 | 43.49 | 11,161 → 2,864 | 11,879 → 3,511 | -70.4% | 62.2 → 242.6 |
| TAR.XZ | 47.95 | 4,531 → 1,620 | 5,237 → 2,240 | -57.2% | 153.1 → 428.3 |
| RAR (stored) | 693.76 | 1,402 → 1,206 | 1,836 → 1,601 | -12.8% | 522.9 → 575.4 |
| ZIP regression | 81.19 | 579 → 525 | 1,156 → 1,083 | -6.3% | 1,210.1 → 1,323.5 |

Throughput is expanded MiB divided by extraction wall time, calculated per run and then averaged. It is not compressed input throughput.

| Format | UI-ready range before ms | UI-ready range after ms | Extraction-phase peak MiB before → after | Whole-import peak MiB before → after | Main JS heap peak MiB before → after |
|---|---:|---:|---:|---:|---:|
| 7z | 1,303–1,644 | 1,210–1,254 | 1,781 → 1,634 | 2,268 → 2,272 | 23.0 → 22.5 |
| TAR | 1,576–2,735 | 854–864 | 2,801 → 997 | 2,973 → 2,167 | 23.8 → 24.1 |
| TAR.GZ | 1,723–2,026 | 1,748–1,866 | 1,717 → 1,073 | 2,053 → 2,070 | 22.5 → 23.0 |
| TAR.BZ2 | 11,715–11,996 | 3,417–3,636 | 1,493 → 1,288 | 2,040 → 2,061 | 19.4 → 21.8 |
| TAR.XZ | 5,110–5,338 | 2,216–2,258 | 1,523 → 1,250 | 2,030 → 2,080 | 19.2 → 20.3 |
| RAR (stored) | 1,521–2,307 | 1,572–1,648 | 2,119 → 2,072 | 2,256 → 2,285 | 23.9 → 21.4 |
| ZIP regression | 1,085–1,285 | 1,040–1,127 | 1,525 → 1,435 | 2,110 → 2,137 | 21.4 → 26.0 |

Memory values are means of sampled per-run process-tree working-set peaks, approximately 100 ms apart. Extraction-phase peaks use extraction wall time as an approximate cutoff: Node upload and browser extraction clocks start slightly apart, and parsing can overlap extraction. These are not exact allocator high-water marks. JS heap samples are approximately 500 ms apart and exclude workers/Wasm. Raw samples and all ranges remain in the JSON.

The largest clear gains are Bzip2/XZ latency and plain-TAR memory. Gzip extraction time is essentially unchanged while extraction-phase memory falls about 643 MiB. Compressed formats still reach about 2 GiB during parsing; this pass does not claim lower whole-import memory for them. The small rises in their whole-import peaks are within observed run variance. Existing parallel 7z and the RAR codec were retained, so their measured latency changes do not establish new codec speedups.

**Corpus limits:** RAR uses stored entries, so its large-file benchmark measures reading, copying, and ingestion. Compressed solid RAR4/RAR5 are tested for correctness, without a large compressed-RAR speed claim. The 7z corpus has independent LZMA2 reset ranges and 256 KiB dictionaries. XZ has 694 independently checked 1 MiB blocks, 256 KiB dictionaries, and CRC32 checks. A single large solid LZMA2 stream cannot gain the same parallelism.

## Implementation

- Removed `libarchive-wasm`. General 7z now uses the existing Rust `sevenz-rust2` codec with Deflate/Bzip2/PPMd enabled. The existing parallel LZMA2 path remains.
- Sequential TAR/Gzip and fallback XZ/7z use bounded Rust input reads backed by worker `FileReaderSync`. A reusable 1 MiB Rust scratch window copies into the final JS entry buffer, removing whole compressed-input copies and full expanded-entry Rust allocations.
- Plain TAR validates metadata/offsets in Rust, then reads at most two entry Blob slices directly into transferable buffers.
- Bzip2 uses `pbz2-core` SIMD and at most four workers. Compressed input is capped at 2,400,016 bytes per block; block/stream CRCs and boundaries are checked, including false scanner candidates and concatenation. Small files and single-worker batch budgets use the bounded sequential decoder. Four versus eight workers showed no useful gain, so four was retained.
- XZ validates header/footer/index CRCs, physical ranges, and block headers before dispatch. At most four workers decode synthetic single-block streams with Rust, retaining original checks. Plain LZMA2 blocks/dictionaries are capped at 16 MiB; concatenated streams, filter chains, and unsupported layouts fall back before entries are emitted.
- Incremental TAR retains a 512-byte header and at most 1 MiB of metadata. It resolves GNU/PAX metadata through the tar crate, streams payloads, skips sparse physical data/extension headers, and rejects incomplete output. Emitted entries retain the existing 2 GiB browser limit.
- In this first pass, RAR retained `node-unrar-js` with a smaller read cache because `unrar-rs` failed browser compilation on `libc::tm`/`libc::mktime`. The subsequent [RAR migration](browser-rar-rust-migration.md) fixes that portability issue and removes the npm decoder and adapter completely.

The Rust archive Wasm grows from **390,674 to 548,096 bytes**; the **613,235-byte libarchive Wasm asset is removed**. Embedding the larger Rust module raises the main JS bundle from 2,039,736 to 2,253,021 bytes (gzip level 9: 705,859 → 802,840 bytes). This is a startup/bundle-size tradeoff; upload benchmarks begin after page load.

## Correctness and checks

All six archive formats extracted identical SHA-256 hashes, also checked independently against Python tarfile output:

| File | Bytes | SHA-256 |
|---|---:|---|
| api-out.log.1 | 268,663,135 | `2bdaca2b5d006860f58f73dcda546c03c04e30ed3d0bdd1cb8142c24be77f559` |
| mongod.log.1 | 458,795,053 | `9e709fbd51a60f6fbbc4846984a426ebb8f8d96b10a4d1f771f8f0818d814b23` |

Passed: 22 Rust tests; browser fixture suite; large-corpus byte parity; production build; Oxlint/TypeScript; formatting checks on changed code; `git diff --check`. Coverage includes aliases/wrong extensions, GNU/PAX metadata, sparse skipping, solid/nested archives, parallel XZ with CRC64, concatenated gzip/Bzip2, block/stream corruption, truncation, encrypted/split-volume rejection, and mixed uploads. Desktop extraction was not changed or benchmarked.

## Reproduction

Build once and benchmark each archive separately to preserve the single-archive pipeline. Do not run builds/tests concurrently with timed runs.

```powershell
pnpm wasm:build
pnpm run lint
pnpm run build
node scripts/bench/bench_import_batch.mjs --target browser --runs 3 --no-history --skip-build test_data/archive-perf-large/logs.tar.bz2
```

Repeat the benchmark for `.7z`, `.tar`, `.tar.gz`, `.tar.xz`, and `.rar`. ZIP regression uses the original `methaq-api&mongodb-07-09.zip`. Large private corpora are not committed. The before build uses the starting commit; after measurements use the working tree accompanying this report.
