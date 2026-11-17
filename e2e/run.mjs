// E2E launcher: builds the suite, mounts the built extension in the local
// VS Code binary, and runs the extension-host tests.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(e2eDir, "..");
const extensionDir = join(repoRoot, "extension");
const fixtureDir = join(e2eDir, "fixture");
const suiteEntry = join(e2eDir, "suite", "index.ts");
const suiteOut = join(e2eDir, "dist", "suite.cjs");

const defaultVscode =
  platform() === "darwin"
    ? "/Applications/Visual Studio Code.app/Contents/MacOS/Code"
    : platform() === "win32"
      ? join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe")
      : "/usr/share/code/code";
const vscodeBin = process.env.VSCODE_BIN ?? defaultVscode;

if (!existsSync(vscodeBin)) {
  console.error(`VS Code binary not found: ${vscodeBin}`);
  console.error("Set VSCODE_BIN to a working VS Code executable.");
  process.exit(2);
}

const esbuild = join(repoRoot, "node_modules", ".bin", platform() === "win32" ? "esbuild.cmd" : "esbuild");
const build = spawn(esbuild, [
  suiteEntry,
  "--bundle",
  "--platform=node",
  "--target=node18",
  "--format=cjs",
  "--external:vscode",
  `--outfile=${suiteOut}`,
], { cwd: repoRoot, stdio: "inherit" });

const buildCode = await new Promise((resolveCode) => build.on("exit", resolveCode));
if (buildCode !== 0) process.exit(buildCode ?? 1);

const temp = await mkdtemp(join(tmpdir(), "preflight-e2e-"));
const workspace = join(temp, "workspace");
const userData = join(temp, "user-data");
const extensions = join(temp, "extensions");
await cp(fixtureDir, workspace, { recursive: true });

const args = [
  `--extensionDevelopmentPath=${extensionDir}`,
  `--extensionTestsPath=${suiteOut}`,
  `--user-data-dir=${userData}`,
  `--extensions-dir=${extensions}`,
  "--disable-gpu",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
  "--no-sandbox",
  workspace,
];

if (process.argv.includes("--dry-run")) {
  console.log(`${vscodeBin} ${args.join(" ")}`);
  if (process.env.PREFLIGHT_E2E_KEEP !== "1") await rm(temp, { recursive: true, force: true });
  process.exit(0);
}

const child = spawn(vscodeBin, args, {
  cwd: workspace,
  stdio: "inherit",
  env: {
    ...process.env,
    PREFLIGHT_E2E: "1",
    PREFLIGHT_E2E_REPO: repoRoot,
    PREFLIGHT_E2E_WORKSPACE: workspace,
    PREFLIGHT_E2E_EXTENSION: extensionDir,
    PREFLIGHT_E2E_RG: join(extensionDir, "dist", platform() === "win32" ? "rg.exe" : "rg"),
    PREFLIGHT_E2E_FIXTURES: join(extensionDir, "test", "fixtures"),
  },
});

child.on("error", (error) => {
  console.error(`Failed to start VS Code: ${error.message}`);
});
const [code, signal] = await new Promise((resolveExit) => child.on("exit", (exitCode, exitSignal) => resolveExit([exitCode, exitSignal])));
if (process.env.PREFLIGHT_E2E_KEEP !== "1") await rm(temp, { recursive: true, force: true });
if (code !== 0) {
  console.error(signal ? `VS Code was killed by ${signal}.` : `VS Code exited with code ${code ?? "unknown"}.`);
  console.error("If the process aborts before any output, run this command from a normal GUI Terminal.");
  console.error("Set VSCODE_BIN to a working VS Code executable if needed.");
}
process.exit(code ?? 1);
