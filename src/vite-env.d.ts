/// <reference types="vite/client" />

declare module "*?worker&inline" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module "*?worker" {
  const workerConstructor: {
    new (): Worker;
  };
  export default workerConstructor;
}

declare module "../wasm/pkg/pm2_core.js" {
  export class Pm2Engine {
    constructor();
    free(): void;
    clear(): void;
    ingest_ptr(len: number): number;
    begin_shard(start: number, end: number, file_size: number): void;
    feed(len: number, abs_off: number): number;
    end_shard(): void;
    parse_shard(buf: Uint8Array, shard_start: number, shard_end: number, file_size: number): number;
    ensure_mode(mode: number): void;
    finalize_paths(): void;
    reaggregate(
      normalize_mode: number,
      status_family: number,
      min_ms: number,
      need_summary: boolean,
    ): Uint8Array;
    hit_count(): number;
    unmatched_count(): number;
    path_count(): number;
    methods_mask(): number;
    cron_wire(): Uint8Array;
    unmatched_sample_wire(): Uint8Array;
    path_bytes(path_id: number): Uint8Array | undefined;
    norm_path_bytes(mode: number, norm_id: number): Uint8Array | undefined;
  }
  export default function init(module_or_path?: {
    module_or_path: WebAssembly.Module | BufferSource;
  }): Promise<{ memory: WebAssembly.Memory }>;
  export function initSync(module: { module: BufferSource | WebAssembly.Module }): {
    memory: WebAssembly.Memory;
  };
}

declare module "../wasm/pkg_mongo/mongo_core.js" {
  export class MongoEngine {
    constructor();
    free(): void;
    clear(): void;
    ingest_ptr(len: number): number;
    feed(len: number, abs_off: number): number;
    end_shard(): void;
    slow_query_count(): number;
    total_lines(): number;
    reaggregate(
      op: string,
      plan_filter: number,
      min_duration_ms: number,
      collection: string,
      search_query: string,
      high_scan_ratio_only: boolean,
    ): string;
  }
  export default function init(module_or_path?: {
    module_or_path: WebAssembly.Module | BufferSource;
  }): Promise<{ memory: WebAssembly.Memory }>;
  export function initSync(module: { module: BufferSource | WebAssembly.Module }): {
    memory: WebAssembly.Memory;
  };
}
