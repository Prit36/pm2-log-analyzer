/**
 * Aggregation shard: shared pathTable + SharedArrayBuffer columns; AGG_SLICE is start/end only.
 */

import { aggregateColumnSlice, type AggPartial, type ParseOptions } from "../parser";

export type AggShardRequest =
  | { type: "SET_PATH_TABLE"; pathTable: string[] }
  | {
      type: "SET_COLUMNS";
      methodCodes: SharedArrayBuffer;
      statuses: SharedArrayBuffer;
      durations: SharedArrayBuffer;
      pathIds: SharedArrayBuffer;
    }
  | {
      type: "AGG_SLICE";
      shardIndex: number;
      start: number;
      end: number;
      options: ParseOptions;
      needSummary: boolean;
    };

export type AggShardResult = {
  type: "AGG_RESULT";
  shardIndex: number;
  partial: AggPartial;
};

export type AggShardError = { type: "AGG_ERROR"; shardIndex: number; message: string };

let pathTable: string[] = [];
let methodCodes = new Uint8Array(0);
let statuses = new Uint16Array(0);
let durations = new Float32Array(0);
let pathIds = new Uint32Array(0);

self.onmessage = (e: MessageEvent<AggShardRequest>) => {
  const msg = e.data;
  if (msg.type === "SET_PATH_TABLE") {
    pathTable = msg.pathTable;
    return;
  }
  if (msg.type === "SET_COLUMNS") {
    methodCodes = new Uint8Array(msg.methodCodes);
    statuses = new Uint16Array(msg.statuses);
    durations = new Float32Array(msg.durations);
    pathIds = new Uint32Array(msg.pathIds);
    return;
  }
  if (msg.type !== "AGG_SLICE") return;
  try {
    const partial = aggregateColumnSlice(
      methodCodes,
      statuses,
      durations,
      pathIds,
      pathTable,
      msg.start,
      msg.end,
      msg.options,
      msg.needSummary,
    );
    const result: AggShardResult = {
      type: "AGG_RESULT",
      shardIndex: msg.shardIndex,
      partial,
    };
    self.postMessage(result);
  } catch (err) {
    const errMsg: AggShardError = {
      type: "AGG_ERROR",
      shardIndex: msg.shardIndex,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(errMsg);
  }
};
