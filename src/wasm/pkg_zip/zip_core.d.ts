/* tslint:disable */
/* eslint-disable */

export class BzipBlockDecoder {
    free(): void;
    [Symbol.dispose](): void;
    block_length(): number;
    crc(): number;
    decode(input: Uint8Array, start_bit: number): number;
    end_bit(): number;
    constructor();
    output_len(): number;
}

export class BzipScanner {
    free(): void;
    [Symbol.dispose](): void;
    markers(): string;
    constructor();
    scan(bytes: Uint8Array): void;
}

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

export class TarStream {
    free(): void;
    [Symbol.dispose](): void;
    feed(bytes: Uint8Array): void;
    finish(): number;
    constructor(begin: Function, chunk: Function, commit: Function, skipped: Function);
}

export class XzBlockDecoder {
    free(): void;
    [Symbol.dispose](): void;
    decode(input: Uint8Array, check: number, unpadded: number, size: number): number;
    constructor();
    output_len(): number;
}

/**
 * Fast classifier for standalone files or buffers
 */
export function classify_log_name_or_content(name: string, sample: Uint8Array): string;

export function extract_archive_stream(length: number, format: string, read: Function, begin: Function, chunk: Function, commit: Function, skipped: Function, on_manifest: Function): number;

/**
 * Returns a metadata-only LZMA2 plan, or undefined when the general decoder is required.
 */
export function inspect_sevenz(signature: Uint8Array, tail: Uint8Array, tail_offset: number, length: number): string | undefined;

export function inspect_tar_blob(length: number, read: Function): string;

export function inspect_xz_blob(length: number, read: Function): string | undefined;

export function sevenz_crc_combine(left: number, right: number, right_length: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_bzipblockdecoder_free: (a: number, b: number) => void;
    readonly __wbg_bzipscanner_free: (a: number, b: number) => void;
    readonly __wbg_fastdecompressor_free: (a: number, b: number) => void;
    readonly __wbg_tarstream_free: (a: number, b: number) => void;
    readonly bzipblockdecoder_block_length: (a: number) => number;
    readonly bzipblockdecoder_crc: (a: number) => number;
    readonly bzipblockdecoder_decode: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly bzipblockdecoder_end_bit: (a: number) => number;
    readonly bzipblockdecoder_new: () => number;
    readonly bzipblockdecoder_output_len: (a: number) => number;
    readonly bzipscanner_markers: (a: number) => [number, number];
    readonly bzipscanner_new: () => number;
    readonly bzipscanner_scan: (a: number, b: number, c: number) => void;
    readonly classify_log_name_or_content: (a: number, b: number, c: number, d: number) => [number, number];
    readonly extract_archive_stream: (a: number, b: number, c: number, d: any, e: any, f: any, g: any, h: any, i: any) => [number, number, number];
    readonly fastdecompressor_clear: (a: number) => void;
    readonly fastdecompressor_decompress_deflate: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly fastdecompressor_decompress_gzip: (a: number, b: number, c: number) => [number, number, number];
    readonly fastdecompressor_decompress_lzma2: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly fastdecompressor_new: () => number;
    readonly fastdecompressor_output_crc: (a: number, b: number, c: number) => [number, number, number];
    readonly fastdecompressor_output_len: (a: number) => number;
    readonly fastdecompressor_output_ptr: (a: number) => number;
    readonly inspect_sevenz: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number];
    readonly inspect_tar_blob: (a: number, b: any) => [number, number, number, number];
    readonly inspect_xz_blob: (a: number, b: any) => [number, number, number, number];
    readonly tarstream_feed: (a: number, b: number, c: number) => [number, number];
    readonly tarstream_finish: (a: number) => [number, number, number];
    readonly tarstream_new: (a: any, b: any, c: any, d: any) => number;
    readonly xzblockdecoder_decode: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly xzblockdecoder_output_len: (a: number) => number;
    readonly xzblockdecoder_new: () => number;
    readonly sevenz_crc_combine: (a: number, b: number, c: number) => number;
    readonly __wbg_xzblockdecoder_free: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
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
