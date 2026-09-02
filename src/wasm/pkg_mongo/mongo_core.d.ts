/* tslint:disable */
/* eslint-disable */

export class MongoEngine {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    /**
     * Finish shard (flush carry). Call after all feeds.
     */
    end_shard(): void;
    /**
     * Parse `len` bytes previously written at ingest_ptr; `abs_off` is file offset of those bytes.
     */
    feed(len: number, abs_off: number): number;
    /**
     * Grow ingest window to `len` bytes; returns pointer into Wasm memory for JS writes.
     */
    ingest_ptr(len: number): number;
    constructor();
    /**
     * Fast reaggregate returning serialized JSON string.
     */
    reaggregate(op: string, plan_filter: number, min_duration_ms: number, collection: string, search_query: string, high_scan_ratio_only: boolean): string;
    slow_query_count(): number;
    total_lines(): number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_mongoengine_free: (a: number, b: number) => void;
    readonly mongoengine_clear: (a: number) => void;
    readonly mongoengine_end_shard: (a: number) => void;
    readonly mongoengine_feed: (a: number, b: number, c: number) => number;
    readonly mongoengine_ingest_ptr: (a: number, b: number) => number;
    readonly mongoengine_new: () => number;
    readonly mongoengine_reaggregate: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number) => [number, number];
    readonly mongoengine_slow_query_count: (a: number) => number;
    readonly mongoengine_total_lines: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
