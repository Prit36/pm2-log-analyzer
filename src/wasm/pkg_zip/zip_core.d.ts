/* tslint:disable */
/* eslint-disable */

/**
 * Zero-copy fast streaming decompressor for worker threads
 */
export class FastDecompressor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Release linear memory allocated for output buffer immediately.
     */
    clear(): void;
    /**
     * Decompress raw deflate bytes directly into linear memory.
     * Returns raw pointer in Wasm memory to avoid intermediate copies.
     */
    decompress_deflate(compressed: Uint8Array, uncompressed_size: number): number;
    /**
     * Decompress Gzip bytes directly into linear memory.
     */
    decompress_gzip(gz_bytes: Uint8Array): number;
    constructor();
    output_len(): number;
    output_ptr(): number;
}

/**
 * Fast classifier for standalone files or buffers
 */
export function classify_log_name_or_content(name: string, sample: Uint8Array): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_fastdecompressor_free: (a: number, b: number) => void;
    readonly classify_log_name_or_content: (a: number, b: number, c: number, d: number) => [number, number];
    readonly fastdecompressor_clear: (a: number) => void;
    readonly fastdecompressor_decompress_deflate: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly fastdecompressor_decompress_gzip: (a: number, b: number, c: number) => [number, number, number];
    readonly fastdecompressor_new: () => number;
    readonly fastdecompressor_output_len: (a: number) => number;
    readonly fastdecompressor_output_ptr: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
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
