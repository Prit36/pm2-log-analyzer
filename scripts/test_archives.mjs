import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const port = 4186;
const base = `http://127.0.0.1:${port}`;
const fixtures = resolve("tests/fixtures/archives");
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port)],
  {
    stdio: "pipe",
    windowsHide: true,
  },
);
let serverLog = "";
server.stdout.on("data", (data) => {
  serverLog += data;
});
server.stderr.on("data", (data) => {
  serverLog += data;
});
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {
      /* server starting */
    }
    if (attempt === 100) throw new Error(`Vite did not start: ${serverLog}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("pageerror", (error) => console.error(error));
  await page.goto(base);
  await page.locator('input[type="file"]').first().waitFor({ state: "attached" });
  await page.waitForLoadState("networkidle");
  const extract = async (name, fileName = name, truncate = 0) =>
    page.evaluate(
      async ({ encoded, fileName }) => {
        const { extractArchive } = await import("/src/utils/zipExtractor.ts");
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        const start = performance.now();
        const result = await extractArchive(new File([bytes], fileName));
        return {
          pm2: await Promise.all(result.pm2Files.map(async (f) => [f.name, await f.text()])),
          mongo: await Promise.all(result.mongoFiles.map(async (f) => [f.name, await f.text()])),
          skipped: result.skipped,
          ms: Math.round(performance.now() - start),
        };
      },
      {
        encoded: readFileSync(resolve(fixtures, name))
          .subarray(0, truncate || undefined)
          .toString("base64"),
        fileName,
      },
    );
  const reference = await extract("logs.zip");
  assert.ok(
    !requests.some((url) => /archiveExtractWorker|unrar.*wasm|libarchive.*wasm/.test(url)),
    "ZIP must not load the new decoders",
  );
  await page.screenshot({ path: resolve("test_data/archive-picker.png"), fullPage: true });
  assert.equal(reference.pm2.length, 1);
  assert.equal(reference.mongo.length, 1);
  for (const name of [
    "logs.7z",
    "logs-deflate.7z",
    "logs.tar",
    "logs.tar.gz",
    "logs.tar.bz2",
    "logs.tar.xz",
    "metadata.tar",
    "logs-concat.tar.gz",
    "nested.zip",
    "nested.7z",
  ]) {
    const result = await extract(name);
    assert.deepEqual(result.pm2, reference.pm2, name);
    assert.deepEqual(result.mongo, reference.mongo, name);
    console.log(`${name}: parity OK (${result.ms}ms)`);
  }
  const solidBytes = readFileSync(resolve(fixtures, "solid-reset.7z"));
  const testSolid = (corrupt = false) =>
    page.evaluate(
      async ({ encoded, corrupt }) => {
        const { compileZipCoreModule } = await import("/src/wasm/loadZipCore.ts");
        const { default: init } = await import("/src/wasm/pkg_zip/zip_core.js");
        const { extractSevenZip } = await import("/src/workers/sevenZipExtractor.ts");
        await init({ module_or_path: await compileZipCoreModule() });
        const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
        if (corrupt) bytes[45] ^= 0x40;
        const entries = [];
        const total = await extractSevenZip(
          new File([bytes], "solid-reset.7z"),
          (name, data) => entries.push({ name, data }),
          () => {},
          () => false,
        );
        return {
          total,
          entries: await Promise.all(
            entries.map(async ({ name, data }) => ({
              name,
              size: data.length,
              hash: Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", data)),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join(""),
            })),
          ),
        };
      },
      { encoded: solidBytes.toString("base64"), corrupt },
    );
  const solid = await testSolid();
  assert.equal(solid.total, 11000004, "solid reset fixture must use the parallel fast path");
  const seed = readFileSync(resolve(fixtures, "logs.tar")).subarray(512, 700);
  for (const [name, size] of [
    ["api-out.log", 4500001],
    ["mongod.log", 6500003],
  ]) {
    const expected = Buffer.allocUnsafe(size);
    for (let offset = 0; offset < size; offset += seed.length)
      seed.copy(expected, offset, 0, Math.min(seed.length, size - offset));
    assert.deepEqual(
      solid.entries.find((entry) => entry.name === name),
      {
        name,
        size,
        hash: createHash("sha256").update(expected).digest("hex"),
      },
    );
  }
  await assert.rejects(
    testSolid(true),
    /checksum|corrupt|invalid|data|lzma|decode|range|overflow/i,
  );
  console.log("solid-reset.7z: parallel reset ranges, cross-file CRC, corruption rejection OK");
  for (const [name, alias] of [
    ["logs.tar.gz", "logs.tgz"],
    ["logs.tar.bz2", "logs.tbz"],
    ["logs.tar.bz2", "logs.tbz2"],
    ["logs.tar.xz", "logs.txz"],
  ]) {
    const result = await extract(name, alias);
    assert.deepEqual(result.pm2, reference.pm2, alias);
    assert.deepEqual(result.mongo, reference.mongo, alias);
  }
  for (const name of ["rar3-solid.rar", "rar5-solid.rar"]) {
    const result = await extract(name);
    assert.equal(result.pm2.length, 2, name);
    const content = Array.from({ length: 512 }, (_, i) => String(i).padStart(3, "0") + "\n").join(
      "",
    );
    assert.deepEqual(
      result.pm2.map(([, text]) => text),
      [content, content],
      name,
    );
    console.log(`${name}: extraction OK (${result.ms}ms)`);
  }
  for (const name of ["encrypted.7z", "corrupt.7z", "rar5-psw.rar", "rar5-vols.part1.rar"]) {
    await assert.rejects(
      extract(name),
      /password|encrypted|archive|unrecognized|truncated|damaged|header|split/i,
      name,
    );
    console.log(`${name}: rejected OK`);
  }
  for (const name of ["logs.tar", "logs.tar.gz", "logs.tar.bz2", "logs.tar.xz"]) {
    const truncate = name === "logs.tar" ? 512 : readFileSync(resolve(fixtures, name)).length - 8;
    await assert.rejects(extract(name, name, truncate), undefined, name + " truncated");
    console.log(name + ": truncation rejected OK");
  }
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles([resolve(fixtures, "logs.7z"), resolve(fixtures, "logs.tar.gz")]);
  await page.evaluate(async () => {
    const { useAnalysisStore } = await import("/src/store/analysisStore.ts");
    const { useMongoStore } = await import("/src/store/mongoStore.ts");
    window.archiveTestCounts = () => ({
      pm2: useAnalysisStore.getState().result?.summary.matched,
      mongo: useMongoStore.getState().result?.summary.slowQueryCount,
    });
  });
  await page.waitForFunction(
    () => {
      const counts = window.archiveTestCounts();
      return counts.pm2 === 1 && counts.mongo === 1;
    },
    undefined,
    { timeout: 30000 },
  );
  const counts = await page.evaluate(() => window.archiveTestCounts());
  // Identical extracted files are deduplicated by the existing upload stores.
  assert.equal(counts.pm2, 1);
  assert.equal(counts.mongo, 1);
  console.log("Mixed archive upload: PM2 and Mongo parsers OK");
  await page.screenshot({ path: resolve("test_data/archive-upload.png"), fullPage: true });
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  await browser?.close();
  server.kill();
}
