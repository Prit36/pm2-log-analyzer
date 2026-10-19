import { spawn, execFile, execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const take = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index < 0 ? fallback : args.splice(index, 2)[1];
};
const runs = Math.max(1, Number(take("--runs", "3")) || 3);
const base = take("--url", "http://127.0.0.1:4176");
const skipBuild = args.includes("--skip-build");
const file = args.find((arg) => !arg.startsWith("--"));
if (!file)
  throw new Error(
    "Usage: pnpm bench:nginx <access.log> [--runs 3] [--skip-build] [--url http://127.0.0.1:5173]",
  );
const filePath = resolve(file);
const fileBytes = statSync(filePath).size;
const log = (...values) => console.error("[nginx-bench]", ...values);
let server;
let browser;

async function rssMB() {
  if (process.platform !== "win32") return null;
  const script =
    "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(chrome|chrome-headless-shell|headless_shell|chromium)\\.exe$' -and ($_.CommandLine -match 'ms-playwright|playwright_chromium') }; if ($p) { ($p | Measure-Object WorkingSetSize -Sum).Sum } else { 0 }";
  const output = await new Promise((resolvePromise, reject) =>
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolvePromise(stdout)),
    ),
  );
  const value = Number(output.trim());
  return Number.isFinite(value) ? value / 1024 / 1024 : null;
}

try {
  if (!skipBuild)
    execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error("Preview not ready");
  } catch {
    const url = new URL(base);
    server = spawn(
      process.execPath,
      [
        "node_modules/vite/bin/vite.js",
        "preview",
        "--host",
        url.hostname,
        "--port",
        url.port,
        "--strictPort",
      ],
      { stdio: ["ignore", "ignore", "inherit"], windowsHide: true },
    );
    let ready = false;
    for (let index = 0; index < 100; index++) {
      try {
        if ((await fetch(base)).ok) {
          ready = true;
          break;
        }
      } catch {
        /* Preview is starting. */
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    if (!ready) throw new Error("Preview did not start");
  }
  browser = await chromium.launch({ headless: true });
  const results = [];
  for (let index = 0; index < runs; index++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByTestId("app-switcher-nginx").click();
    await page.getByTestId("nginx-file-input").waitFor({ state: "attached" });
    const beforeRssMB = await rssMB();
    const memory = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        memory.push(await rssMB());
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
    })();
    await page.evaluate(() => {
      window.__nginxFrameProbe = {
        start: performance.now(),
        last: performance.now(),
        maxGap: 0,
        frames: 0,
        done: false,
      };
      const frame = () => {
        const probe = window.__nginxFrameProbe;
        const now = performance.now();
        probe.maxGap = Math.max(probe.maxGap, now - probe.last);
        probe.last = now;
        probe.frames++;
        if (!probe.done) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    log(`run ${index + 1}/${runs}: ${filePath}`);
    await page.getByTestId("nginx-file-input").setInputFiles(filePath);
    await page.waitForFunction(() => (window.__NGINX_BENCH__?.parseWallMs ?? 0) > 0, null, {
      timeout: 600_000,
    });
    await page.getByTestId("nginx-kpi-row").waitFor();
    const measured = await page.evaluate(
      () =>
        new Promise((resolvePromise) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const probe = window.__nginxFrameProbe;
              probe.done = true;
              resolvePromise({
                ...window.__NGINX_BENCH__,
                uiReadyMs: performance.now() - probe.start,
                maxFrameGapMs: probe.maxGap,
                frames: probe.frames,
              });
            }),
          ),
        ),
    );
    sampling = false;
    await sampler;
    measured.rssBeforeMB = beforeRssMB;
    const rssSamples = memory.filter((sample) => sample !== null);
    measured.rssPeakMB = rssSamples.length ? Math.max(...rssSamples) : null;
    measured.rssAfterMB = await rssMB();
    for (const label of ["5xx", "All status"]) {
      const previous = await page.evaluate(() => window.__NGINX_BENCH__.reaggTimes.length);
      await page
        .getByTestId("nginx-filter-status")
        .getByRole("button", { name: label, exact: true })
        .click();
      await page.waitForFunction(
        (length) => window.__NGINX_BENCH__.reaggTimes.length > length,
        previous,
      );
    }
    measured.reaggTimes = await page.evaluate(() => window.__NGINX_BENCH__.reaggTimes);
    if (errors.length) throw new Error(errors.join("\n"));
    results.push(measured);
    log(
      `ready ${measured.uiReadyMs.toFixed(0)}ms, parse ${measured.parseWallMs}ms, ${measured.requestCount} requests, RSS peak ${measured.rssPeakMB?.toFixed(0) ?? "unavailable"} MiB`,
    );
    await context.close();
  }
  const best = Math.min(...results.map((result) => result.uiReadyMs));
  console.log(
    JSON.stringify(
      {
        method: "browser-nginx",
        file: filePath,
        fileBytes,
        runs: results,
        summary: { bestUiReadyMs: best, throughputMBps: fileBytes / 1024 / 1024 / (best / 1000) },
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  server?.kill();
}
