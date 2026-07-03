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
| **M3: gen2 ≡ gen3** | **FAIL** (gen3 0xC0000005) |

## Why M3 still fails

`projects/yoyo.ty` currently uses a mix of:
  - **TIR intrinsics** for the 49 handlers (call H_xx, state.set, jcc.eq, etc.)
  - **Pre-emitted x64 blobs** via `data.blob` + `memcpy.data` for the runtime
    helper code (Win API call sequences, control flow, etc.)

When `yoyo.exe` runs on this source, it copies the pre-emitted blobs
verbatim into its output. The output is correct in shape (handlers +
blobs in the same layout), but the resulting binary has the same
compilation logic as the input — i.e., it is the SAME compiler, so
gen3 should be self-consistent... in theory.

In practice, the **scan path** in gen2 differs from the **TIR-x64
emit path** in gen1. yoyo.exe compiled by Node uses compileFromAnalyzed
(TIR-x64), but yoyo.exe compiled by yoyo.exe uses something different
(scan-emit of the .ty source). Both produce same-looking PEs but the
embedded scan-emit code in gen2 is buggy.

## The path forward

Translate the 4 data blobs in yoyo.ty to TIR intrinsics. Each blob is
raw x64 that does a specific job; replacing it with TIR means gen2's
internal logic becomes TIR-x64 emit, identical to gen1's.

| Blob | Offset | Size | Estimated TIR size |
|------|--------|------|--------------------|
| 0 | 0x4000 | 124928 bytes | ~50-80 KB TIR |
| 1 | 0xcc00 | 84 bytes | ~30-50 lines TIR |
| 2 | 0xcc54 | 23382 bytes | ~10-15 KB TIR |
| 3 | 0x14c54 | 1028 bytes | ~400-700 lines TIR |

Each blob contains one of the runtime helpers used by handlers:
  - **Blob 0** is the main runtime — string-table pointers, `call H_xx`
    setup, the `H_61/H_8d` repeated-handler cache, state-init.
  - **Blob 1** is the entry stub (called from `H_00` top).
  - **Blob 2** is the bulk of the helper code for `H_30` and friends.
  - **Blob 3** is the small `H_E0`-`H_EC` block — the most contained.

## Strategy: incremental, smallest-first

1. **Round 1**: Translate blob 3 (1028 bytes) to TIR intrinsics.
   Test M2 byte-match.
2. **Round 2**: Translate blob 1 (84 bytes). Test.
3. **Round 3**: Translate blob 2 (23 KB). Test.
4. **Round 4**: Translate blob 0 (125 KB) — the bulk of the work.
5. **Final**: All four blobs are TIR. Run bootstrap-native.sh 3 with
   TIR_BOOTSTRAP=1 and check `gen2 === gen3`.

Each round needs a tool to translate x64 bytes -> TIR ops. Since
yoyo.ty is already mostly TIR-intrinsics-form, the translation tool
can be a manual walk: read the blob bytes, identify Win API call
targets (`call_rip` to imported functions), parameter setup (mov
into RCX/RDX/R8/R9 stack), and translate each x64 sequence to a TIR
op sequence.

A rough translator would:
  - Match `e8 rel32` -> `call KERNEL32.dll.foo` if rel32 matches an
    IAT entry, else `call H_xx`
  - Match `48 8d 05 disp` -> `ld rax, [rip + disp]` -> `state.get`
  - Match Win API setup -> `load.file` / `write.file` / `alloc` etc

## After E

When gen2 ≡ gen3:
  - M3 PASS
  - The compiler is genuinely self-hosting in pure TIR (no scan path)
  - Future TIR work (TIR-WASM, TIR-AArch64) can build on this clean
    foundation

## Today's progress

Committed (Phase 5 step 5):
  - `git 07e2c5a` TIR backend op coverage complete (lower.js + emitTirOp)
  - `git f2b3bc4` yoyo.ty rewritten in TIR intrinsics form
  - `git cefdf37` Fix data.blob args[0] (preserve offset as number)

This document is the starting point for the multi-week E effort.