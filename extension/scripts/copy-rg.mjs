// Copies the platform ripgrep binary into the built extension.
// @vscode/ripgrep is ESM-only; the extension bundle stays CommonJS and reads
// the binary from dist at runtime.
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rgPath } from "@vscode/ripgrep";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const destination = join(scriptDir, "..", "dist", process.platform === "win32" ? "rg.exe" : "rg");

await mkdir(dirname(destination), { recursive: true });
await copyFile(rgPath, destination);
await chmod(destination, 0o755);
