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
    /**
     * Decode a dictionary-reset LZMA2 range into a reusable worker output window.
     */
    decompress_lzma2(compressed: Uint8Array, dict_size: number, output_size: number): number;
    constructor();
    output_crc(offset: number, length: number): number;
    output_len(): number;
    output_ptr(): number;
}

/**
 * Fast classifier for standalone files or buffers
 */
export function classify_log_name_or_content(name: string, sample: Uint8Array): string;

export function extract_tar_wasm(data: Uint8Array, on_entry: Function, on_skipped: Function): number;

/**
 * Returns a metadata-only LZMA2 plan, or undefined when the general decoder is required.
 */
export function inspect_sevenz(signature: Uint8Array, tail: Uint8Array, tail_offset: number, length: number): string | undefined;

export function sevenz_crc_combine(left: number, right: number, right_length: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_fastdecompressor_free: (a: number, b: number) => void;
    readonly classify_log_name_or_content: (a: number, b: number, c: number, d: number) => [number, number];
    readonly extract_tar_wasm: (a: number, b: number, c: any, d: any) => [number, number, number];
    readonly fastdecompressor_clear: (a: number) => void;
    readonly fastdecompressor_decompress_deflate: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly fastdecompressor_decompress_gzip: (a: number, b: number, c: number) => [number, number, number];
    readonly fastdecompressor_decompress_lzma2: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly fastdecompressor_new: () => number;
    readonly fastdecompressor_output_crc: (a: number, b: number, c: number) => [number, number, number];
    readonly fastdecompressor_output_len: (a: number) => number;
    readonly fastdecompressor_output_ptr: (a: number) => number;
    readonly inspect_sevenz: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly sevenz_crc_combine: (a: number, b: number, c: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
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
