/* tslint:disable */
/* eslint-disable */

export class NginxAggregator {
    free(): void;
    [Symbol.dispose](): void;
    add_partial(bytes: Uint8Array): void;
    finish(filters_json: string): string;
    constructor();
}

export class NginxEngine {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    end_source(): void;
    feed(len: number): void;
    hit_count(): number;
    ingest_ptr(len: number): number;
    constructor();
    partial(filters_json: string): Uint8Array;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_nginxaggregator_free: (a: number, b: number) => void;
    readonly __wbg_nginxengine_free: (a: number, b: number) => void;
    readonly nginxaggregator_add_partial: (a: number, b: number, c: number) => [number, number];
    readonly nginxaggregator_finish: (a: number, b: number, c: number) => [number, number, number, number];
    readonly nginxaggregator_new: () => number;
    readonly nginxengine_clear: (a: number) => void;
    readonly nginxengine_end_source: (a: number) => void;
    readonly nginxengine_feed: (a: number, b: number) => void;
    readonly nginxengine_hit_count: (a: number) => number;
    readonly nginxengine_ingest_ptr: (a: number, b: number) => number;
    readonly nginxengine_new: () => number;
    readonly nginxengine_partial: (a: number, b: number, c: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
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
