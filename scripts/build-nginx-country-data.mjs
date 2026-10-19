#!/usr/bin/env node
// Regenerate the bundled offline country database; --update accepts a new upstream snapshot.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../src/nginx/data/", import.meta.url);
const repository = "https://github.com/sapics/ip-location-db";
const licenseUrl = "https://opendatacommons.org/licenses/pddl/1-0/";
const refresh = process.argv.includes("--update");
if (process.argv.slice(2).some((arg) => arg !== "--update")) {
  throw new Error("Usage: node scripts/build-nginx-country-data.mjs [--update]");
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let previous;
try {
  previous = JSON.parse(await readFile(new URL("manifest.json", output), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`${response.status} downloading ${url}`);
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    lastModified: response.headers.get("last-modified"),
  };
}

async function compile(family) {
  const sourceFile = `user-country-ipv${family}-num.csv`;
  const sourceUrl = `${repository}/releases/download/latest/${sourceFile}`;
  const checksumUrl = `${repository}/releases/download/checksum/${sourceFile}.sha256`;
  const [source, checksum] = await Promise.all([download(sourceUrl), download(checksumUrl)]);
  const officialHash = checksum.bytes.toString("utf8").trim().split(/\s+/)[0];
  const sourceSha256 = sha256(source.bytes);
  if (!/^[a-f0-9]{64}$/.test(officialHash) || officialHash !== sourceSha256) {
    throw new Error(
      `Official SHA-256 mismatch for ${sourceFile}; retry after the release finishes`,
    );
  }
  const pinnedHash = previous?.sources?.[`ipv${family}`]?.sourceSha256;
  if (!refresh && pinnedHash && pinnedHash !== sourceSha256) {
    throw new Error(`${sourceFile} changed upstream; use --update to accept the new snapshot`);
  }

  const lines = source.bytes.toString("utf8").trimEnd().split("\n");
  const recordBytes = family === 4 ? 10 : 34;
  const binary = Buffer.alloc(lines.length * recordBytes);
  const maximum = (1n << BigInt(family === 4 ? 32 : 128)) - 1n;
  let previousEnd = -1n;
  let rangeCount = 0;
  let skippedRanges = 0;
  for (let index = 0; index < lines.length; index++) {
    const fields = lines[index].trimEnd().split(",");
    const [first, last, country] = fields;
    if (fields.length !== 3 || !/^\d+$/.test(first) || !/^\d+$/.test(last)) {
      throw new Error(`Malformed ${sourceFile} row ${index + 1}`);
    }
    const start = BigInt(first);
    const end = BigInt(last);
    if (start <= previousEnd || end < start || end > maximum) {
      throw new Error(`Unsorted, overlapping, or invalid ${sourceFile} range at row ${index + 1}`);
    }
    previousEnd = end;
    if (!/^[A-Z]{2}$/.test(country) || country === "ZZ" || country === "XX") {
      skippedRanges++;
      continue;
    }
    const offset = rangeCount * recordBytes;
    if (family === 4) {
      binary.writeUInt32BE(Number(start), offset);
      binary.writeUInt32BE(Number(end), offset + 4);
    } else {
      binary.writeBigUInt64BE(start >> 64n, offset);
      binary.writeBigUInt64BE(start & 0xffffffffffffffffn, offset + 8);
      binary.writeBigUInt64BE(end >> 64n, offset + 16);
      binary.writeBigUInt64BE(end & 0xffffffffffffffffn, offset + 24);
    }
    binary.write(country, offset + recordBytes - 2, 2, "ascii");
    rangeCount++;
  }
  if (rangeCount === 0) throw new Error(`No country ranges found in ${sourceFile}`);
  const bytes = binary.subarray(0, rangeCount * recordBytes);
  return {
    bytes,
    metadata: {
      sourceUrl,
      checksumUrl,
      sourceLastModified: source.lastModified,
      sourceSha256,
      binaryFile: `country-ipv${family}.bin`,
      binarySha256: sha256(bytes),
      rangeCount,
      recordBytes,
      binaryBytes: bytes.length,
      skippedRanges,
    },
  };
}

const [ipv4, ipv6] = await Promise.all([compile(4), compile(6)]);
const sourceDates = [ipv4, ipv6].map(({ metadata }) => metadata.sourceLastModified);
if (sourceDates.some((date) => !date || !Number.isFinite(Date.parse(date)))) {
  throw new Error("Upstream source snapshot is missing a valid Last-Modified date");
}
const snapshotDate = new Date(Math.max(...sourceDates.map(Date.parse))).toISOString().slice(0, 10);
const manifest = {
  schemaVersion: 1,
  database: "sapics/ip-location-db user-country",
  snapshotDate,
  repository,
  license: {
    name: "PDDL-1.0",
    url: licenseUrl,
    sourceUrl: `${repository}#original-databases-update-daily`,
  },
  sources: { ipv4: ipv4.metadata, ipv6: ipv6.metadata },
};
await mkdir(output, { recursive: true });
for (const { bytes, metadata } of [ipv4, ipv6]) {
  await writeFile(new URL(metadata.binaryFile, output), bytes);
  console.log(`${metadata.binaryFile}: ${metadata.rangeCount} ranges, ${bytes.length} bytes`);
}
await writeFile(new URL("manifest.json", output), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Country snapshot ${snapshotDate}: ${fileURLToPath(output)}`);
