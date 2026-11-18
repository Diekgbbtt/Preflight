import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const dir = await mkdtemp(join(tmpdir(), "preflight-bench-"));
try {
  const out = join(dir, "benchmark.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("quick-benchmark.ts", import.meta.url))], bundle: true, platform: "node", format: "esm", outfile: out });
  const child = spawn(process.execPath, [out], { stdio: "inherit", env: process.env });
  process.exitCode = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => resolve(code ?? 1)); });
} finally { await rm(dir, { recursive: true, force: true }); }
