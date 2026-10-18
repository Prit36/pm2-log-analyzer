# Browser RAR migration — 2026-10-18

The browser now extracts RAR entirely through a separate, lazily loaded Rust Wasm core. `node-unrar-js`, its 183-line adapter, Vite dependency preloading, and the old C++ UnRAR license notices are removed. `libarchive-wasm` was removed in the preceding archive optimization. Desktop code is unchanged.

## Portability fix

Published `unrar-rs` 0.11.0 compiles a Unix `libc::tm` / `libc::mktime` branch under `cfg(not(windows))`. That condition includes `wasm32-unknown-unknown`, where those libc APIs are unavailable. The pinned crate is vendored in `wasm/vendor/unrar-rs`; browser builds instead convert RAR4 DOS local timestamps using JavaScript `Date`, preserving timezone and daylight-saving interpretation. Windows and WASI paths are unchanged.

A browser test also exposed partial RAR4 headers being treated as clean EOF. The vendored header reader now returns an error after any partial seven-byte header. [Patch provenance](../wasm/vendor/unrar-rs/PATCH.md) records the published package checksum and all three changed upstream files. The original Apache-2.0 license and UnRAR decompression restriction are preserved verbatim.

The decoder reads through a bounded 8 MiB `BufReader` backed by worker Blob slices. Decoded spans copy directly into the final transferable JS entry buffer, avoiding a full Rust output allocation. Solid archives retain dictionary state when skipped entries precede selected files. Payload CRC failures, encrypted files, split volumes, truncated payloads, and oversized entries return errors.

The module is compiled only when RAR is selected. A lazy `.wasm` asset uses `WebAssembly.compileStreaming`, removing the intermediate 4.57 MB base64 JavaScript chunk. The Wasm binary is **3,425,448 bytes** (gzip level 9: **1,272,581 bytes**). The main JS bundle remains **2,253,021 bytes**; RAR adds no eager Wasm payload. Upload benchmarks start after initial page load, but include the RAR module's first lazy load and compilation in each fresh browser process. The server must serve `.wasm` as `application/wasm`, as Vite does.

## Benchmark method

Windows x64, Intel Core i5-12400F (6 cores / 12 threads), Chromium 153.0.8010.12, Node 26.5.0. Three fresh browser processes per corpus and phase, production Vite preview, warm OS file caches. Timed runs are serial without concurrent builds or tests.

Before is the preceding optimized archive implementation with the npm UnRAR decoder and 16 MiB input cache. After is this Rust implementation. All three RAR corpora contain identical logs: **727,458,188 expanded bytes (693.76 MiB)**. Compressed RAR5 archives were created with the official RAR 7.23 tool, `-m3 -md4m`; non-solid uses `-s-`, solid uses `-s`.

Memory measurements sample Chromium process-tree working sets approximately every 100 ms. Extraction-phase peaks use extraction wall time as an approximate cutoff; parsing can overlap extraction. Main-page JS heap samples exclude workers and Wasm. These are sampled observations rather than exact allocator high-water marks.

Before measurements were taken October 17, final after measurements October 18. [Raw results](../scripts/bench/browser_rar_rust_results.json) retain every final run, the two intermediate Rust trials, ZIP diagnostics, parser timings, RSS samples, and SHA-256 checks.

## Results

Means of three runs, with time in milliseconds and memory in MiB. All 18 before/after RAR imports produced **907,336 API requests, 82,191 slow queries, and 573 patterns**.

| RAR corpus | Archive bytes | Extraction before → after | UI-ready before → after | UI change | Expanded MiB/s before → after |
|---|---:|---:|---:|---:|---:|
| Stored | 727,458,304 | 1,225 → 1,278 | 1,635 → 1,690 | +3.4% | 566.8 → 542.9 |
| Compressed, non-solid | 30,142,994 | 1,376 → 1,307 | 1,757 → 1,671 | -4.9% | 504.4 → 531.0 |
| Compressed, solid | 30,142,641 | 1,391 → 1,290 | 1,760 → 1,653 | -6.1% | 498.8 → 537.7 |

Throughput is expanded MiB divided by extraction time for each run, then averaged.

| RAR corpus | UI-ready range before → after | Extraction-phase peak before → after | Whole-import peak before → after | Main JS heap peak before → after |
|---|---:|---:|---:|---:|
| Stored | 1,579–1,675 → 1,649–1,718 | 2,101.9 → 2,113.8 | 2,263.5 → 2,262.9 | 21.0 → 20.5 |
| Compressed, non-solid | 1,732–1,776 → 1,646–1,683 | 1,727.9 → 1,711.0 | 2,289.6 → 2,279.1 | 21.5 → 19.4 |
| Compressed, solid | 1,726–1,795 → 1,648–1,659 | 1,752.6 → 1,730.3 | 2,281.3 → 2,292.4 | 24.6 → 19.9 |

Compressed RAR is modestly faster; stored RAR regresses about 56 ms. Whole-import peak memory is effectively unchanged within the observed ranges; this migration does **not** establish a significant memory reduction. The earlier base64 Rust implementation was slower; its raw trials are retained rather than discarded.

ZIP diagnostic: the preceding optimized build averaged **1,083 ms** (1,040–1,127); this build averaged **1,160 ms** (1,084–1,286), a **7.2% increase**, with peak working set **2,137 → 2,129 MiB**. The ZIP decoder and main bundle size are unchanged, and fixture checks confirm ZIP does not load RAR. The slower first run contributes to the observed difference; these measurements do not prove zero regression.

Large stored, compressed, and solid RAR outputs match the independent TAR reference byte-for-byte:

| File | Bytes | SHA-256 |
|---|---:|---|
| api-out.log.1 | 268,663,135 | `2bdaca2b5d006860f58f73dcda546c03c04e30ed3d0bdd1cb8142c24be77f559` |
| mongod.log.1 | 458,795,053 | `9e709fbd51a60f6fbbc4846984a426ebb8f8d96b10a4d1f771f8f0818d814b23` |

Passed: 3 RAR Rust tests, 22 ZIP/archive Rust tests, 246 browser RAR assertions across three timezones, the full browser archive fixture suite, large-corpus hash parity, production build, Oxlint/TypeScript, changed-file formatting checks, and `git diff --check`. Desktop was not changed or benchmarked.

## Verification and reproduction

```powershell
pnpm wasm:build
pnpm run lint
pnpm run build
node scripts/bench/bench_import_batch.mjs --target browser --runs 3 --no-history --skip-build test_data/archive-perf-large/logs.rar
node scripts/bench/bench_import_batch.mjs --target browser --runs 3 --no-history --skip-build test_data/rar-rust/logs-compressed.rar
node scripts/bench/bench_import_batch.mjs --target browser --runs 3 --no-history --skip-build test_data/rar-rust/logs-solid.rar
```

Large private corpora and the temporary RAR creation tool are not committed. The temporary verification scripts and fixtures were removed after validation.
