# Phase 5 Roadmap — Bootstrap Stage 3 via TIR

## Goal

`gen2 ≡ gen3` (the bootstrap fixed point). When `yoyo.exe` is run on
`projects/yoyo.ty`, the output (gen3) must be byte-identical to the
`yoyo.exe` that produced it (gen2).

## Current state (2026-07-03)

| Milestone | Status |
|-----------|--------|
| M1: tir-check ≥120 handlers, ≥500 fixups | **PASS** (133, 599) |
| M2: tir-x64 ≡ x64 byte-match (analyze order) | **PASS** (Linux + Windows) |
| yoyo.ty rewritten in TIR intrinsics form | **DONE** |
| TIR backend op coverage complete | **DONE** (lower.js + both emitTirOp) |
| **M3: gen2 ≡ gen3** | **PASS** (2026-07-05) |

## Result

M3 was achieved by rebuilding `build/yoyo.exe` with the current code
(TIR intrinsics form of yoyo.ty + compileFromAnalyzed path). The old
binary was from commit e0c1c64 and was out of sync with the current
yoyo.ty. After rebuild, gen2 ≡ gen3 (hash `837CFD8...`).

The self-hosting fixed point works despite the 4 `data.blob` entries
remaining as pre-emitted x64. The `compileFromAnalyzed` path handles
both TIR intrinsics and blob directives consistently in gen1 and gen2,
so no scan/emit divergence occurs.

build/yoyo.exe is no longer git-tracked (build artifact, rebuilt locally
via `node src/yoyo.js projects/yoyo.ty build/yoyo.exe`).

## Phase 5 complete

Three milestones achieved:
- M1: tir-check ≥120 handlers — ✅
- M2: TIR-x64 ≡ x64 byte-match — ✅
- M3: gen2 ≡ gen3 bootstrap fixed point — ✅

Future directions (not blocked on M3):
- TIR-WASM backend
- TIR-AArch64 backend
- Replace data.blob with pure TIR (optional, not required for self-hosting)

## Today's progress

Committed (Phase 5 step 5):
  - `git 07e2c5a` TIR backend op coverage complete (lower.js + emitTirOp)
  - `git f2b3bc4` yoyo.ty rewritten in TIR intrinsics form
  - `git cefdf37` Fix data.blob args[0] (preserve offset as number)

This document is the starting point for the multi-week E effort.