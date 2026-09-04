# Agent Note: Web build swaps dist atomically to avoid a blank served page

Status: implemented

English | [中文](2026-09-03-web-build-atomic-dist-swap.zh.md)

## Problem

The `dsh web` GUI serves `apps/web/dist` by reading files per request — `dsh-host-frontend-static` has no in-memory cache, deliberately, so `pnpm run dev:web`'s watch rebuild is visible on the next read. The `build:web` stage of `pnpm run build`, however, runs a plain `vite build`, whose default `emptyOutDir` clears the whole `dist` directory at build start. Running the build while the GUI was up therefore left `dist/index.html` missing for the whole build, and a page refresh in that window returned the empty 404 that `frontend-static` documents for a missing configured index — a blank page. The watch script already avoided this with `--no-emptyOutDir`; the one-shot build did not.

## Decision

`apps/web/vite.config.ts` now stages the build beside the served tree and swaps it in atomically. One `stageDistOutput` plugin sets `build.outDir` to `dist.staging`, records the worker bootstrap entry in `generateBundle`, and in its own `writeBundle` first splices `preview.html` into the staged tree, then moves the old `dist` to `dist.previous`, renames `dist.staging` into `dist`, and removes the backup. The splice and the swap share one hook because Rollup runs `writeBundle` and `closeBundle` hooks in parallel, so two plugins could not order the splice before the rename. Both renames are same-filesystem, so the served tree flips old→new without a missing-file window. `.gitignore` ignores `dist.staging` and `dist.previous` (a failed build leaves the staging tree, which the next build's `emptyOutDir` clears).

## Alternatives considered

**Add `--no-emptyOutDir` to the `build` script, matching `watch`.** Rejected: Vite then overwrites `index.html` in place but leaves every stale hashed asset behind, which accumulates across builds and pollutes the npm-published `dist` (`files: ["dist"]`).

**Cache index and assets in `frontend-static` and fall back to the cache on a missing file.** Rejected: it changes the locked "absent file → empty 404" contract the package documents and tests assert, and it must cache every hashed asset — not just the index — or a rebuilt page still fails loading its scripts.

**Rewrite `dist` in place after building elsewhere.** Rejected: a directory-level atomic replacement is only expressible as the two-rename swap; copying files in place is not atomic and reopens the window.

## Consequences

A `pnpm run build` no longer removes the index.html the running GUI serves. The swap window shrinks from the whole build to the two renames plus the backup removal — milliseconds, and a crash between the renames leaves `dist.previous` for the next build to clean. `dist.staging` and `dist.previous` are gitignored. No serve-side contract, package, or test changes: `dsh-host-frontend-static` still returns an empty 404 for an index that was never present.
