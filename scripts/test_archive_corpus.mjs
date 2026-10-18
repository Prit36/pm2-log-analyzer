import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const paths = process.argv.slice(2).map((path) => resolve(path));
if (paths.length < 2)
  throw new Error(
    "Usage: node scripts/test_archive_corpus.mjs <reference-archive> <candidate-archive> [...]",
  );
const server = await createServer({ server: { host: "127.0.0.1", port: 4187, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  let reference;
  for (const path of paths) {
    const page = await browser.newPage();
    await page.goto("http://127.0.0.1:4187");
    await page.evaluate(() => {
      const input = document.createElement("input");
      input.type = "file";
      input.id = "corpus-file";
      document.body.append(input);
    });
    await page.locator("#corpus-file").setInputFiles(path);
    const result = await page.evaluate(async () => {
      const { extractArchive } = await import("/src/utils/zipExtractor.ts");
      const file = document.querySelector("#corpus-file").files[0];
      const hashes = [];
      const captured = new Set();
      const hash = async (category, name, size, buffer) => ({
        category,
        name,
        size,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      });
      const capture = (category, payload) => {
        for (const file of payload.files) {
          captured.add(category + " " + file.name);
          hashes.push(
            payload.directBuffer
              ? hash(category, file.name, file.size, payload.directBuffer.buffer)
              : file.arrayBuffer().then((buffer) => hash(category, file.name, file.size, buffer)),
          );
        }
      };
      const logs = await extractArchive(file, {
        onPm2Ready: (payload) => capture("pm2", payload),
        onMongoReady: (payload) => capture("mongo", payload),
      });
      for (const [category, files] of [
        ["pm2", logs.pm2Files],
        ["mongo", logs.mongoFiles],
      ]) {
        for (const file of files) {
          if (!captured.has(category + " " + file.name))
            hashes.push(
              file.arrayBuffer().then((buffer) => hash(category, file.name, file.size, buffer)),
            );
        }
      }
      return (await Promise.all(hashes)).sort(
        (a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name),
      );
    });
    if (reference) assert.deepEqual(result, reference, path);
    else reference = result;
    console.log(JSON.stringify({ path, files: result }));
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
