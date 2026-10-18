# Archive performance measurements

Measured on 2026-10-15 on Windows x64, Intel Core i5-12400F (6 cores / 12 threads). These compare the initial new-format implementation with the optimized working tree. ZIP keeps its existing extraction path.

The same two files expand to 727,458,188 bytes: 268,663,135 bytes of PM2 logs and 458,795,053 bytes of MongoDB logs. Every final single-archive run produced 907,336 API requests, 82,191 slow queries, and 573 patterns. The 7z corpus has two LZMA2 folders, 256 KiB dictionaries, and independent reset ranges. Solid multi-file 7z and RAR4/RAR5 are additionally covered by correctness fixtures. The large RAR corpus uses **stored entries**; its numbers measure copying and ingestion, not compressed RAR decoding speed.

## Desktop

| Format | Before This Change (`6e67b91`) | After This Change | Latency Delta | Sampled Peak Before → After (MiB) | Memory Delta |
|---|---:|---:|---:|---:|---:|
| **7z** | 732 ms | **646 ms** | **-11.7%** | 670 → 644 MiB | **-26 MiB** |
| **TAR.GZ** | 759 ms | **719 ms** | **-5.3%** | 650 → 630 MiB | **-20 MiB** |
| **TAR.BZ2** | 2,233 ms | **1,582 ms** | **-29.1%** | 688 → 673 MiB | **-15 MiB** |
| **TAR.XZ** | 676 ms | **613 ms** | **-9.3%** | 641 → 614 MiB | **-27 MiB** |
| **RAR** | 737 ms | **668 ms** | **-9.4%** | 1,172 → 1,124 MiB | **-48 MiB** |
| **Plain TAR** | — | **391 ms** | — | — → 1,164 MiB | — |

## Browser

| Format | Before This Change (`6e67b91`) | After This Change | Latency Delta | Sampled Peak Before → After (MiB) | Memory Delta |
|---|---:|---:|---:|---:|---:|
| **7z** | 1,870 ms | **1,260 ms** | **-32.6%** | 2,055 → 1,941 MiB | **-114 MiB** |
| **TAR.GZ** | 1,811 ms | **1,707 ms** | **-5.7%** | 2,083 → 1,979 MiB | **-104 MiB** |
| **TAR.BZ2** | 11,934 ms | **11,000 ms** | **-7.8%** | 1,975 → 1,881 MiB | **-94 MiB** |
| **TAR.XZ** | 3,652 ms | **3,652 ms** | **0.0%** | 1,958 → 1,958 MiB | **0 MiB** |
| **RAR** | 1,604 ms | **1,474 ms** | **-8.1%** | 2,264 → 2,264 MiB | **0 MiB** |

Browser 7z extraction wall fell from ~1,072ms to 758ms via direct uninitialized output buffering and adaptive worker concurrency, and UI-ready latency plummeted from 1,870ms to 1,260ms (-32.6%) with eager manifest pipelining into PM2 shard workers. TAR streaming in Wasm eliminates intermediary JS byte buffering. Desktop Bzip2 and XZ use parallelized decoders with bounded chunk streaming into Rayon shards.

## Bounds and implementation

- Native compressed archives recycle three 16 MiB log buffers and overlap decoding with parsing. Mongo keeps its original logical shard boundaries and caches across physical decoder buffers. Oversized individual log lines can exceed the normal buffer size. Nested archive payloads are materialized for recursive decoding. Plain TAR entries borrow mmap slices.
- Native Bzip2 and XZ decode in parallel. Decoder thread budgets are divided across simultaneous archives; XZ reduces concurrency above a 64 MiB threading budget, with a separate 1 GiB decoder limit for larger dictionaries. Native 7z uses bounded codec threads where its layout supports them.
- Browser 7z scans a small metadata tail and LZMA2 chunk headers, then schedules independent reset groups through at most four workers. Its pool budget includes dictionaries, compressed input, Wasm output, and transferable output; batch imports divide the worker budget across archives. Unsupported layouts fall back before emitting files. CRCs are checked as segment results are combined.
- Browser RAR uses an 8 MiB manifest cache and a 64 MiB extraction cache, exact entry allocations, and direct transfers. TAR/GZIP copies into final entry allocations and skips unwanted entries before allocating them. Extraction workers terminate afterward. Browser entries are limited to 2 GiB.
- Batch imports release duplicate expanded buffers early using the existing size-based deduplication policy. In a two-archive browser test (7z + TAR.XZ, the same files twice), mean sampled peak fell from about 3,806 to 2,389 MiB and readiness from 4,369 to 3,826 ms. Native imports retain both copies and completed in 1,179 ms at 921 MiB. These browser/native counts differ by their existing deduplication policy.

## Verification and reproduction

Three runs per final desktop format and per browser 7z/RAR; browser Bzip2/XZ/TAR are single-run checks. Baselines for Bzip2/XZ/RAR are single runs, so their exact percentages are less precise. Working set samples are approximately 100 ms apart and include the app/browser process tree. They are sampled peaks, not exact allocator high-water marks. Browsers retain caches between runs; OS file caches are warm. Builds and benchmarks ran separately.

ZIP regression check (three runs): browser mean 1,182 ms, desktop mean 531 ms, with matching counts. Before this optimization pass the same ZIP benchmark averaged 1,356 ms / 533 ms; no ZIP timing regression was observed. ZIP is still faster than 7z on this corpus.

Encrypted and split-volume archives are unsupported.

Build with `pnpm tauri build --no-bundle`, then use `node scripts/bench/bench_import_batch.mjs --target both --runs 3 --no-history --skip-build <archive>`. Set `WEBVIEW2_USER_DATA_FOLDER` to a fresh benchmark profile to avoid persisted date filters. Full-size local corpora are not committed. Compact statistics are saved in [archive_formats_results.json](../scripts/bench/archive_formats_results.json).
