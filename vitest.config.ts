import { configDefaults, defineConfig } from "vitest/config";

/**
 * Keeps `npm test` scoped to this checkout. The repo keeps agent worktrees
 * under `.worktrees/` at the root; without the exclude, vitest's default
 * include sweeps their test copies too, and two checkouts sharing one fake
 * CLI temp directory delete it out from under each other mid-run.
 * The pattern is root-anchored on purpose: a leading `**` does not traverse
 * into dot directories here.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
