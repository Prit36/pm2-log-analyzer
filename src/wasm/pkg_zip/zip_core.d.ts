/* tslint:disable */
/* eslint-disable */

export class ZipExtractor {
    free(): void;
    [Symbol.dispose](): void;
    classify_entry_content(data: Uint8Array): string;
    extract_entry(index: number): Uint8Array;
    inspect(): any;
    constructor(bytes: Uint8Array);
}

/**
 * Fast classifier for standalone files or buffers
 */
export function classify_log_name_or_content(name: string, sample: Uint8Array): string;

/**
 * Standalone Gzip decompressor for dropped .gz files
 */
export function decompress_gz_bytes(data: Uint8Array): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_zipextractor_free: (a: number, b: number) => void;
    readonly classify_log_name_or_content: (a: number, b: number, c: number, d: number) => [number, number];
    readonly decompress_gz_bytes: (a: number, b: number) => [number, number, number];
    readonly zipextractor_classify_entry_content: (a: number, b: number, c: number) => [number, number];
    readonly zipextractor_extract_entry: (a: number, b: number) => [number, number, number];
    readonly zipextractor_inspect: (a: number) => [number, number, number];
    readonly zipextractor_new: (a: number, b: number) => [number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
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
