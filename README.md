# PM2 Log Analyzer

Browser-only ops console for large PM2 HTTP / cron logs. Drop a file (or paste text), get KPI cards, filterable API latency tables, percentile charts, cron summaries, and Excel export — all client-side. No backend.

**Default stress corpus:** `test_data/api-out-5gb.log` (~5.22 GiB) — **36,572,842** matched HTTP lines, **27,427,800** unmatched, **6,107** endpoints, **9** cron jobs (10× concat of the older 535 MiB file). The climb in [Performance journey](#performance-journey) §1 was timed on `api-out-500mb.log`; §2 is the current 5 GiB gate. Benches are real Chromium + Vite preview + Web Workers via Playwright (`scripts/bench/bench.mjs`). Full session log: [`scripts/bench/history.json`](scripts/bench/history.json).

The story starts earlier than either corpus: before [`ef58f1f`](https://github.com/Prit36/pm2-log-analyzer/commit/ef58f1f), even **~50 MB** files could hang or crash the tab (main-thread parse). See [Performance journey](#performance-journey).

---

## What it does

- Ingest PM2-style log lines (HTTP access + `[cron]` events) from file drop or paste
- Parse and aggregate in workers (Rust/Wasm today; JS workers earlier)
- Show KPIs (matched / unmatched / p95 / errors / slow calls)
- Filter by method, status family, min duration, path normalize mode (exact / strip query / collapse IDs)
- Virtualized API table, RelHist-based latency chart, cron table
- Export filtered API + cron sheets to Excel

---

## Tech stack

| Layer | Choice |
|-------|--------|
| UI | React 19, Tailwind CSS 4, Zustand, Recharts, react-window |
| App shell | TypeScript 7 (strict), Vite 8 |
| Tooling | pnpm, oxlint, oxfmt, Playwright (browser benches) |
| Parse / reagg | Rust → Wasm (`wasm/pm2-core`), `wasm-bindgen` 0.2.126, Binaryen `wasm-opt -O3` |
| Hot crates | `hashbrown` 0.17 (foldhash for RelHist), `rapidhash` 4 (path maps), `memchr` 2.8 (SIMD newlines / `memmem`) |
| Workers | 4 persistent shard workers; chunked 8 MiB ingest into Wasm linear memory (`ingest_ptr` + `feed`) |
| Cross-origin isolation | COOP/COEP headers so `SharedArrayBuffer` / Wasm threads features stay available where needed |

---

## Quick start

```bash
pnpm install
pnpm dev
```

Open the URL Vite prints, drop a `.log` file.

### Production build

```bash
pnpm build
pnpm preview
```

Output is a single `dist/index.html` (plus a small logo asset).

### Lint / format / self-check

```bash
pnpm lint
pnpm fmt
pnpm selfcheck
```

---

## Rust / Wasm rebuild (optional)

Needed only when changing `wasm/pm2-core`. Requires:

- Rust toolchain with `wasm32-unknown-unknown`
- `wasm-bindgen-cli` **matching** `Cargo.toml` (currently `0.2.126`)
- `wasm-opt` from [Binaryen](https://github.com/WebAssembly/binaryen/releases) **on PATH** (build fails if missing)

```bash
pnpm wasm:build    # cargo test + release Wasm + wasm-opt + embed into src/wasm/pm2CoreBytes.ts
pnpm build
```

On Windows, if `cargo install wasm-bindgen-cli` fails (e.g. missing `dlltool`), install the matching [GitHub release binary](https://github.com/wasm-bindgen/wasm-bindgen/releases) into a directory on your PATH.

---

## Benchmarks

### How to run

```bash
pnpm build
node scripts/bench/bench.mjs --runs 5 --note "my-note"
# defaults to test_data/api-out-5gb.log (~5.22 GiB); pass a path to override:
# node scripts/bench/bench.mjs test_data/api-out-500mb.log --runs 5 --note "500mb"
# or skip Vite rebuild:
node scripts/bench/bench.mjs --runs 5 --note "my-note" --skip-build
```

Results append to `scripts/bench/history.json`. Prefer a quiet shell (fresh Chromium, no stacked agent previews) for gate numbers. Each run prints a compact `stages (avg ms): …` line (`feed`, `firstReagg`, warm reagg shard/decode/finish, etc.).

### Reference machine

| Spec | Value |
|------|--------|
| OS | Windows 11 Pro 25H2 (build 26200) |
| CPU | Intel Core i5-12400F (6 cores / 12 threads) |
| RAM | 16 GB |
| GPU | NVIDIA GeForce RTX 5060 |
| Bench runner | Chromium via Playwright against `vite preview` |

Numbers move with CPU load and thermal state; treat the table as relative progress on this box.

### Performance journey

#### 0. Make it usable at all (`ef58f1f`)

Before any of the timed 535 MiB work, even **~50 MB** logs could lock or crash the tab: parsing ran on the **main thread**, held multi‑MB strings in React state, and rendered huge DOM tables.

**First fix** ([`ef58f1f`](https://github.com/Prit36/pm2-log-analyzer/commit/ef58f1f) — *Optimize large PM2 log analysis for 50MB+ files*):

- Move parse into a **Web Worker** with **streaming** file reads  
- Keep compact **typed-array** columns instead of per-line objects  
- **Virtualize** result tables so the UI stays responsive  

That turned “crashes / multi‑minute freezes on modest files” into something you could open and interact with. Section 1 below is further optimization on the **~535 MiB** stress corpus; section 2 is the later **~5.22 GiB** default. Playwright benches live in `scripts/bench/history.json`.

#### 1. Instrumented climb (same 535 MiB corpus)

Early post-worker UI still felt heavy on huge files (multi‑second filter reagg + multi‑GB RSS). Instrumented browser benches start at `864a2f3` and track the climb down.

| Milestone | Note / commit | Parse (avg) | Reagg (avg) | Chromium RSS peak | What changed |
|-----------|---------------|-------------|-----------------|-------------------|--------------|
| First usable (qualitative) | `ef58f1f` | — (not in history.json) | — | — | Worker + streaming + typed arrays + virtualized tables; ~50 MB no longer kills the tab |
| Instrumented baseline | `864a2f3` | **~12.2 s** | **~3.2 s** | **~2.6 GiB** | Worker path, still single-shard JS; filter reagg expensive |
| Perf phase A+B | `perf-phase-A+B*` | ~7.6–11 s | ~1.0–1.4 s | ~1.8–2.2 GiB | Scanner / sketch / allocation cuts |
| Multicore shard parse | `perf-multicore` / `5e86fa5` | **~3.4–3.9 s** | ~0.8–1.0 s | ~1.2 GiB | Shard file across workers; RelHist replaces DDSketch |
| JS parallel reagg (SAB) | `my-run` / `51e1079` → `0ff459f` | **~2.71 s** | **~326 ms** | **~1.33 GiB** | SharedArrayBuffer columns + parallel reagg workers |
| First Rust/Wasm attempt | `rust-wasm-gate` | ~3.56 s | ~132 ms | ~1.66 GiB | Full-shard TypedArray→Wasm copies — faster reagg, worse parse/RSS |
| Chunked Wasm ingest | `wasm-chunked-smoke` | ~1.49 s | ~134 ms | ~1.16 GiB | 8 MiB `ingest_ptr` window; columns stay in-shard |
| Wasm ship gate | `wasm-ship-gate` | **~1.37 s** | **~108 ms** | **~1.16 GiB** | Dense reagg slots + summary-at-`end_shard` |
| Manual quiet opt | (post `wasm-opt` + `memchr`) | **~1.33 s** | **~97 ms** | ~1.15 GiB | Required `wasm-opt -O3`, SIMD newline scan |
| hashbrown + foldhash | `hashbrown-foldhash` | **~1.28 s** | **~86 ms** | ~1.15 GiB | Drop ahash (no AES on Wasm) |
| Modernize (manual) | `rust-modernize-manual` | **~1.19 s** | **~86 ms** | ~1.15 GiB | rapidhash path maps, `entry_ref`, `Cow` normalize, `memmem`, no RelHist clone |
| Stage breakdown | `stage-breakdown` | ~1.19 s | ~86 ms | ~1.15 GiB | Bench prints parse/reagg stage ms (`feed`, `firstReagg`, …) via `__PM2_BENCH__` |
| Sub-1s (quiet) | `rss-restore-quiet` / `e7dd750`+ | **~0.98 s** | **~86 ms** | **~1.15 GiB** | Cron/`memchr` gate + method order; overlap `ENSURE_MODE`; no parse-time `summary_wire` (that path only grew RSS ~20 MB) |

**Net**

- **Usability:** ~50 MB logs went from tab crash / multi‑minute hang → interactive (worker + streaming + virtualization).  
- **Speed (quiet-shell best vs first instrumented 535 MiB baseline):** parse **~12.2 s → ~0.98 s** (~12×); filter reagg **~3.2 s → ~86 ms** (~37×); peak Chromium RSS **~2.6 GiB → ~1.15 GiB** (~2.3× less).

Exact result parity held across the timed journey: matched **3,718,450**, unmatched **2,788,590**, endpoints **6,107**, cron **9**.

Quiet stage map at the sub-1s point (avg ms): `feed≈524` (still the largest slice), `firstReagg≈159` (was ~414 before `ENSURE_MODE` overlap), warm reagg `shard≈32` / `decode≈10` / `finish≈24`.

#### 2. Scale-up: 5 GiB default corpus (`5gb default`)

Default bench file switched to `test_data/api-out-5gb.log` (~5.22 GiB / ~5350 MiB) — same line mix as the 535 MiB corpus, repeated 10×. Session **47** in `history.json` (`5gb default`, 5 runs):

| Metric | Avg (±stddev) |
|--------|----------------|
| Parse wall | **8.39 s ± 0.09** |
| Upload → KPI ready | **8.41 s ± 0.10** |
| Throughput | **638 MB/s** |
| Chromium RSS peak | **~3.93 GiB** |
| Reagg avg | **322 ms** |

Result parity: matched **36,572,842**, unmatched **27,427,800**, endpoints **6,107**, cron **9**.

Stages (avg ms): `read≈1386`, `feed≈5456`, `endShard≈310`, `firstReagg≈919` (`shard≈838` / `decode≈39` / `finish≈42`); warm reagg `shard≈267` / `decode≈13` / `finish≈25`.

Rough scale check vs quiet 535 MiB (~0.98 s parse / ~86 ms reagg / ~1.15 GiB RSS): ~10× bytes → ~8.6× parse wall, ~3.7× reagg, ~3.4× RSS peak — feed still dominates; first reagg and RSS grow sub-linearly with the repeated corpus (same endpoint cardinality).

### Architecture (current)

```text
File drop
  → coordinator worker (compile Wasm module once)
  → 4 shard workers, each with one Pm2Engine
       write 8 MiB chunks into Wasm ingest window
       feed / end_shard → columnar hits + path arena + summary
       early shards: ENSURE_MODE(collapseIds) while siblings still feed
  → absorb cron/unmatched meta
  → first / filter reagg → in-shard reaggregate → compact PM2P partials
       (first reagg carries summary; later runs reuse coordinator cache)
  → coordinator merge → Zustand → UI
```

Failed approach (kept as a lesson): copying whole shards into Rust and keeping dual JS/Wasm residency beat reagg slightly but missed parse/RSS gates. Chunked in-place ingest fixed that. Stuffing cold `ensure_mode` only into `end_shard` is a wall wash — overlap it with sibling feeds instead. Shipping RelHist `summary_wire` at parse grew peak RSS ~20 MB with no wall win — leave summary on the first PM2P reagg.

---

## Project layout

```text
src/                 React app, workers, Wasm glue
src/wasm/pkg/        Generated wasm-bindgen JS + .wasm (bytes also embedded in pm2CoreBytes.ts)
wasm/pm2-core/       Rust crate (parse, normalize, RelHist, Engine)
scripts/bench/       Playwright browser bench + history.json
scripts/wasm-build.mjs
test_data/           Sample / large logs (not required for install)
```

---

## License

See repository license if present; otherwise treat as private / unspecified until one is added.
