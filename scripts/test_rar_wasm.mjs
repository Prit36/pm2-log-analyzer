import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";

const fixtures = Object.fromEntries(
  await Promise.all(
    ["dos-time.rar", "rar3-solid.rar", "rar5-solid.rar", "rar5-psw.rar", "rar5-vols.part1.rar"].map(
      async (name) => [
        name,
        Array.from(await readFile(new URL(`../tests/fixtures/archives/${name}`, import.meta.url))),
      ],
    ),
  ),
);
const server = await createServer({ server: { host: "127.0.0.1", port: 4188, strictPort: true } });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true });
  for (const [timezoneId, expectedTimestamp] of [
    ["UTC", "2020-06-01T12:34:56.000Z"],
    ["Asia/Kolkata", "2020-06-01T07:04:56.000Z"],
    ["America/New_York", "2020-06-01T16:34:56.000Z"],
  ]) {
    const context = await browser.newContext({ timezoneId });
    try {
      const page = await context.newPage();
      await page.goto("http://127.0.0.1:4188");
      const result = await page.evaluate(
        async ({ fixtures, expectedTimestamp }) => {
          const { compileRarCoreModule } = await import("/src/wasm/loadRarCore.ts");
          const { initSync, RarExtractor } = await import("/src/wasm/pkg_rar/rar_core.js");
          const wasm = initSync({ module: await compileRarCoreModule() });
          let checks = 0;
          const check = (condition, message) => {
            if (!condition) throw new Error(message);
            checks++;
          };
          const open = (input) => {
            const bytes = Uint8Array.from(input);
            return new RarExtractor(bytes.length, (offset, pointer, length) => {
              check(
                Number.isSafeInteger(offset) && offset >= 0 && offset + length <= bytes.length,
                "RAR read exceeds input bounds",
              );
              new Uint8Array(wasm.memory.buffer, pointer, length).set(
                bytes.subarray(offset, offset + length),
              );
            });
          };
          const extract = (archive, index) => {
            const entries = JSON.parse(archive.manifest());
            const output = new Uint8Array(entries[index].size);
            let position = 0;
            const size = archive.extract(index, (pointer, length) => {
              check(position + length <= output.length, "RAR output exceeds declared size");
              output.set(new Uint8Array(wasm.memory.buffer, pointer, length), position);
              position += length;
            });
            check(size === output.length && position === output.length, "RAR output is incomplete");
            return new TextDecoder().decode(output);
          };
          const rejects = (input, message, expectedError) => {
            let archive;
            let error;
            try {
              archive = open(input);
              for (let index = 0; index < JSON.parse(archive.manifest()).length; index++) {
                extract(archive, index);
              }
            } catch (caught) {
              error = String(caught);
            } finally {
              archive?.free();
            }
            check(error !== undefined, message);
            if (expectedError) check(expectedError.test(error), `${message}: ${error}`);
          };

          let archive = open(fixtures["dos-time.rar"]);
          try {
            const entries = JSON.parse(archive.manifest());
            check(entries.length === 1, "DOS fixture has one member");
            check(entries[0].name === "api-out.log", "DOS fixture filename");
            check(entries[0].size === 23 && !entries[0].directory, "DOS fixture metadata");
            check(
              entries[0].modifiedMs === Date.parse(expectedTimestamp),
              `DOS local timestamp: ${entries[0].modifiedMs} expected ${expectedTimestamp}`,
            );
            check(extract(archive, 0) === "GET /timestamp 200 1ms\n", "DOS fixture payload");
            let indexError;
            try {
              archive.extract(1, () => {});
            } catch (error) {
              indexError = String(error);
            }
            check(indexError?.includes("Invalid RAR entry index"), "Invalid index is rejected");
          } finally {
            archive.free();
          }

          const expected = Array.from(
            { length: 512 },
            (_, number) => String(number).padStart(3, "0") + "\n",
          ).join("");
          for (const name of ["rar3-solid.rar", "rar5-solid.rar"]) {
            archive = open(fixtures[name]);
            try {
              check(JSON.parse(archive.manifest()).length === 2, `${name} member count`);
              check(extract(archive, 0) === expected, `${name} first member`);
              check(extract(archive, 1) === expected, `${name} second member`);
            } finally {
              archive.free();
            }
            archive = open(fixtures[name]);
            try {
              archive.skip(0);
              check(extract(archive, 1) === expected, `${name} dictionary survives skipped member`);
            } finally {
              archive.free();
            }
          }

          const stored = Uint8Array.from(fixtures["dos-time.rar"]);
          const fileHeaderOffset = 20;
          const headerSize = new DataView(stored.buffer).getUint16(fileHeaderOffset + 5, true);
          const dataOffset = fileHeaderOffset + headerSize;
          check(dataOffset === 63, "DOS stored fixture payload offset");
          const corrupt = stored.slice();
          corrupt[dataOffset] ^= 0x40;
          rejects(corrupt, "Corrupted stored payload must fail CRC verification", /crc|checksum/i);
          rejects(stored.subarray(0, 25), "Truncated header must fail");
          rejects(stored.subarray(0, dataOffset + 10), "Truncated stored payload must fail");
          rejects(fixtures["rar5-psw.rar"], "Encrypted RAR must fail", /password|encrypt/i);
          rejects(fixtures["rar5-vols.part1.rar"], "Split RAR must fail", /split|volume/i);
          return { checks, timestamp: expectedTimestamp };
        },
        { fixtures, expectedTimestamp },
      );
      assert.ok(result.checks > 20, "Browser executed the RAR assertions");
      console.log(JSON.stringify({ timezoneId, ...result }));
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await server.close();
}
