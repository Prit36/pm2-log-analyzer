import type { MongoOperationType } from "./types";

export type MongoParsedNode =
  | string
  | number
  | boolean
  | null
  | readonly MongoParsedNode[]
  | { readonly [key: string]: MongoParsedNode };

export type MongoDoc = { readonly [key: string]: MongoParsedNode };

export type MongoFingerprint = {
  readonly fingerprint: string;
  readonly filterKeys: readonly string[];
  readonly sortKeys: readonly string[];
};

function isPlainObject(value: MongoParsedNode | undefined): value is MongoDoc {
  return value !== null && value !== undefined && !Array.isArray(value) && value.constructor === Object;
}

function normalizeNode(node: MongoParsedNode): MongoParsedNode {
  if (node === null || node === undefined) return "?";
  if (Array.isArray(node)) {
    if (node.length === 0) return [];
    return node.map((item: MongoParsedNode) => normalizeNode(item));
  }
  if (isPlainObject(node)) {
    if ("$oid" in node) return "?oid";
    if ("$date" in node) return "?date";
    if ("$regex" in node || "$regularExpression" in node) return "regex";

    const keys = Object.keys(node).filter(
      (k) => !k.startsWith("lsid") && k !== "$db" && k !== "$readPreference",
    );
    const result: Record<string, MongoParsedNode> = {};
    for (const key of keys) {
      const child = node[key];
      if (child !== undefined) {
        if (Array.isArray(child)) {
          result[key] = child.map((c: MongoParsedNode) => {
            if (isPlainObject(c)) {
              return Object.keys(c).join("|");
            }
            return "?";
          });
        } else if (isPlainObject(child)) {
          result[key] = normalizeNode(child);
        } else {
          result[key] = "?";
        }
      }
    }
    return result;
  }
  return "?";
}

export function extractFingerprint(
  op: MongoOperationType,
  collection: string,
  command: MongoParsedNode,
): MongoFingerprint {
  const filterKeys: string[] = [];
  const sortKeys: string[] = [];

  const cmdObj: MongoDoc = isPlainObject(command) ? command : {};

  if (op === "find") {
    const rawFilter: MongoDoc = isPlainObject(cmdObj.filter) ? cmdObj.filter : {};
    filterKeys.push(...Object.keys(rawFilter));
    const normalizedFilter = JSON.stringify(normalizeNode(rawFilter));

    let sortPart = "";
    if (isPlainObject(cmdObj.sort)) {
      const sKeys = Object.keys(cmdObj.sort);
      sortKeys.push(...sKeys);
      sortPart = ` sort: {${sKeys.join(", ")}}`;
    }
    const fingerprint = `find(${normalizedFilter})${sortPart}`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "aggregate") {
    const pipelineNode = cmdObj.pipeline;
    const rawPipeline: readonly MongoParsedNode[] = Array.isArray(pipelineNode) ? pipelineNode : [];
    const stages = rawPipeline.map((stageItem: MongoParsedNode) => {
      if (isPlainObject(stageItem)) {
        const stageKeys = Object.keys(stageItem);
        const firstKey = stageKeys[0] ?? "?";
        if (firstKey === "$match" && isPlainObject(stageItem.$match)) {
          const mKeys = Object.keys(stageItem.$match);
          filterKeys.push(...mKeys);
          return `$match(${mKeys.join(", ")})`;
        }
        if (firstKey === "$sort" && isPlainObject(stageItem.$sort)) {
          const sKeys = Object.keys(stageItem.$sort);
          sortKeys.push(...sKeys);
          return `$sort(${sKeys.join(", ")})`;
        }
        return firstKey;
      }
      return "?";
    });
    const fingerprint = `aggregate([${stages.join(" ➔ ")}])`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "distinct") {
    const keyVal = cmdObj.key;
    const key = String(keyVal) === keyVal ? keyVal : "?";
    const rawQuery: MongoDoc = isPlainObject(cmdObj.query) ? cmdObj.query : {};
    filterKeys.push(...Object.keys(rawQuery));
    const normalizedQuery = JSON.stringify(normalizeNode(rawQuery));
    const fingerprint = `distinct("${key}", query=${normalizedQuery})`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "getMore") {
    const batchSize = cmdObj.batchSize ? String(cmdObj.batchSize) : "default";
    const fingerprint = `getMore(batchSize=${batchSize})`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "update") {
    const updateVal = cmdObj.update;
    const target = String(updateVal) === updateVal ? updateVal : collection;
    const fingerprint = `update(${target})`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "delete") {
    const delVal = cmdObj.delete;
    const target = String(delVal) === delVal ? delVal : collection;
    const fingerprint = `delete(${target})`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  if (op === "findAndModify") {
    const rawQuery: MongoDoc = isPlainObject(cmdObj.query) ? cmdObj.query : {};
    filterKeys.push(...Object.keys(rawQuery));
    const fingerprint = `findAndModify(query=${JSON.stringify(normalizeNode(rawQuery))})`;
    const result: MongoFingerprint = { fingerprint, filterKeys, sortKeys };
    return result;
  }

  const result: MongoFingerprint = { fingerprint: `${op}(${collection})`, filterKeys, sortKeys };
  return result;
}
