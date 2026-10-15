# Archive performance measurements

Measured on 2026-10-15 on Windows x64, Intel Core i5-12400F (6 cores / 12 threads). These compare the initial new-format implementation with the optimized working tree. ZIP keeps its existing extraction path.

The same two files expand to 727,458,188 bytes: 268,663,135 bytes of PM2 logs and 458,795,053 bytes of MongoDB logs. Every final single-archive run produced 907,336 API requests, 82,191 slow queries, and 573 patterns. The 7z corpus has two LZMA2 folders, 256 KiB dictionaries, and independent reset ranges. Solid multi-file 7z and RAR4/RAR5 are additionally covered by correctness fixtures. The large RAR corpus uses **stored entries**; its numbers measure copying and ingestion, not compressed RAR decoding speed.

## Desktop

| Format | Before (ms) | After (ms) | Sampled peak before → after (MiB) |
|---|---:|---:|---:|
| 7z | 842 | 732 | 1005 → 670 |
| TAR.GZ | 897 | 759 | 998 → 650 |
| TAR.BZ2 | 10508 | 2233 | 994 → 688 |
| TAR.XZ | 3937 | 676 | 995 → 641 |
| RAR (stored) | 786 | 737 | 1591 → 1172 |

## Browser

| Format | Before (ms) | After (ms) | Sampled peak before → after (MiB) |
|---|---:|---:|---:|
| 7z | 3268 | 1870 | 2034 → 2055 |
| TAR.GZ | 1767 | 1811 | 2063 → 2083 |
| TAR.BZ2 | 11341 | 11934 | 1902 → 1975 |
| TAR.XZ | 3767 | 3652 | 1924 → 1958 |
| RAR (stored) | 2145 | 1604 | 2313 → 2264 |

Browser Bzip2 and XZ still use the general serial decoder; their measurements show no established speed improvement. TAR.GZ timing stayed within run variation; its streaming path avoids retaining a complete compressed-input copy. Browser peak memory is dominated by parser workers and expanded data, so faster 7z decoding does not materially reduce the overall peak.

## Bounds and implementation

- Native compressed archives recycle three 16 MiB log buffers and overlap decoding with parsing. Mongo keeps its original logical shard boundaries and caches across physical decoder buffers. Oversized individual log lines can exceed the normal buffer size. Nested archive payloads are materialized for recursive decoding. Plain TAR entries borrow mmap slices.
- Native Bzip2 and XZ decode in parallel. Decoder thread budgets are divided across simultaneous archives; XZ reduces concurrency above a 64 MiB threading budget, with a separate 1 GiB decoder limit for larger dictionaries. Native 7z uses bounded codec threads where its layout supports them.
- Browser 7z scans a small metadata tail and LZMA2 chunk headers, then schedules independent reset groups through at most four workers. Its pool budget includes dictionaries, compressed input, Wasm output, and transferable output; batch imports divide the worker budget across archives. Unsupported layouts fall back before emitting files. CRCs are checked as segment results are combined.
- Browser RAR uses an 8 MiB manifest cache and a 64 MiB extraction cache, exact entry allocations, and direct transfers. TAR/GZIP copies into final entry allocations and skips unwanted entries before allocating them. Extraction workers terminate afterward. Browser entries are limited to 2 GiB.
- Batch imports release duplicate expanded buffers early using the existing size-based deduplication policy. In a two-archive browser test (7z + TAR.XZ, the same files twice), mean sampled peak fell from about 3,806 to 2,389 MiB and readiness from 4,369 to 3,826 ms. Native imports retain both copies and completed in 1,179 ms at 921 MiB. These browser/native counts differ by their existing deduplication policy.

## Verification and reproduction

Three runs per final desktop format and per browser 7z/RAR; browser Bzip2/XZ/TAR are single-run checks. Baselines for Bzip2/XZ/RAR are single runs, so their exact percentages are less precise. Working set samples are approximately 100 ms apart and include the app/browser process tree. They are sampled peaks, not exact allocator high-water marks. Browsers retain caches between runs; OS file caches are warm. Builds and benchmarks ran separately.

ZIP regression check (three runs): browser mean 1,182 ms, desktop mean 531 ms, with matching counts. Before this optimization pass the same ZIP benchmark averaged 1,356 ms / 533 ms; no ZIP timing regression was observed. ZIP is still faster than 7z on this corpus.

Run `node scripts/test_archives.mjs`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, and `cargo test --manifest-path wasm/zip-core/Cargo.toml`. The tests cover extraction parity, aliases, metadata variants, concatenated streams, solid archives, cross-file CRCs, corruption/truncation, encryption/split-volume rejection, oversized lines, nesting, batch imports, and canonical Mongo report parity. Encrypted and split-volume archives are unsupported.

Build with `pnpm tauri build --no-bundle`, then use `node scripts/bench/bench_import_batch.mjs --target both --runs 3 --no-history --skip-build <archive>`. Set `WEBVIEW2_USER_DATA_FOLDER` to a fresh benchmark profile to avoid persisted date filters. Full-size local corpora are not committed. Compact statistics are saved in [archive_formats_results.json](../scripts/bench/archive_formats_results.json).
