/* tslint:disable */
/* eslint-disable */

/**
 * Opaque engine handle for JS.
 */
export class Pm2Engine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start shard ownership [start, end) within file_size.
     */
    begin_shard(start: number, end: number, file_size: number): void;
    clear(): void;
    cron_wire(): Uint8Array;
    daily_wire(): Uint8Array;
    dates_wire(): Uint8Array;
    /**
     * Finish shard (flush carry). Call after all feeds.
     */
    end_shard(): void;
    /**
     * Lazily build normalize map for one mode (0/1/2). Prefer this over finalize_paths.
     */
    ensure_mode(mode: number): void;
    /**
     * Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
     */
    feed(len: number, abs_off: number): number;
    finalize_paths(): void;
    hit_count(): number;
    hourly_wire(): Uint8Array;
    /**
     * Grow ingest window to `len` bytes; returns pointer into Wasm memory for JS writes.
     */
    ingest_ptr(len: number): number;
    methods_mask(): number;
    constructor();
    norm_path_bytes(mode: number, norm_id: number): Uint8Array | undefined;
    /**
     * One-shot parse (copies via wasm-bindgen) — tests / small text only.
     */
    parse_shard(buf: Uint8Array, shard_start: number, shard_end: number, file_size: number): number;
    path_bytes(path_id: number): Uint8Array | undefined;
    path_count(): number;
    reaggregate(normalize_mode: number, status_family: number, min_ms: number, date_filter: Uint8Array, need_summary: boolean): Uint8Array;
    summary_wire(): Uint8Array;
    unmatched_count(): number;
    unmatched_sample_wire(): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_pm2engine_free: (a: number, b: number) => void;
    readonly pm2engine_begin_shard: (a: number, b: number, c: number, d: number) => void;
    readonly pm2engine_clear: (a: number) => void;
    readonly pm2engine_cron_wire: (a: number) => [number, number];
    readonly pm2engine_daily_wire: (a: number) => [number, number];
    readonly pm2engine_dates_wire: (a: number) => [number, number];
    readonly pm2engine_end_shard: (a: number) => void;
    readonly pm2engine_ensure_mode: (a: number, b: number) => void;
    readonly pm2engine_feed: (a: number, b: number, c: number) => number;
    readonly pm2engine_finalize_paths: (a: number) => void;
    readonly pm2engine_hit_count: (a: number) => number;
    readonly pm2engine_hourly_wire: (a: number) => [number, number];
    readonly pm2engine_ingest_ptr: (a: number, b: number) => number;
    readonly pm2engine_methods_mask: (a: number) => number;
    readonly pm2engine_new: () => number;
    readonly pm2engine_norm_path_bytes: (a: number, b: number, c: number) => [number, number];
    readonly pm2engine_parse_shard: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly pm2engine_path_bytes: (a: number, b: number) => [number, number];
    readonly pm2engine_path_count: (a: number) => number;
    readonly pm2engine_reaggregate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly pm2engine_summary_wire: (a: number) => [number, number];
    readonly pm2engine_unmatched_count: (a: number) => number;
    readonly pm2engine_unmatched_sample_wire: (a: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
