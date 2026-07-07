# Pending / Deferred

Items intentionally **not** blocking the aggressive evolution track (`docs/evolution.md`).

## Bootstrap Stage 3 — `gen2 ≡ gen3`

**Gate:** `bash scripts/bootstrap-native.sh 3` → `cmp gen2 gen3` byte-identical.

### Current state (2026-07-07, updated)

| Check | Status |
|-------|--------|
| M2 TIR-x64 ≡ x64 gen1 | **PASS** (0 byte diffs via `linux-emit-core.js`) |
| gen1 runs, emits gen2 | OK (Windows: gen2 = 264192 B, input-independent template copy) |
| gen2 forward fixups (`e8 rel32`) | OK (native `H_FE` resolver) |
| **M3: gen2 ≡ gen3 (Windows)** | **FAIL** (2026-07-07 re-test: gen2 exits 0 but emits **no** output.exe) |
| M3: gen2 ≡ gen3 (Linux) | **Pending verification** (native via `bootstrap-native.sh`) |
| `relocateSlice` byte corruption | **FIXED** (2026-07-07, instruction-boundary decoder) |
| `TIR_BOOTSTRAP=1` gen1 | TIR-built gen1 ≡ x64 gen1 |

> **2026-07-05 "M3 PASS (hash 837CFD8…)" is retracted.** Re-tested 2026-07-07 with
> reliable `cmd /c` runs (PowerShell `Start-Process` exit codes are unreliable — see
> the AGENTS.md blood-lesson). Current Windows behavior: `gen1` (node-compiled, 178 KB)
> always emits `output.exe` (even with **no** `input.ky`); `gen2` (overlay self-host,
> 264 KB) **never** emits output, exits 0 (not a crash). The old "AV / rep-movsb
> count 0x12E800" symptom no longer reproduces — that was an older build.

### relocateSlice fix (2026-07-07)

`relocateSlice` / `relocateSliceWithLayout` in `src/blob-handlers.js` used a byte-scan
for `e8`/`e9` with a partial `isModRMconsumer` heuristic. It only skipped `>=0xc0`
and `0x88-0x8b`, so it **still corrupted** `48 83 e8 xx` (sub rax,imm8),
`48 81 e8 xx` (sub rax,imm32), `48 83 e9 xx`, and `e8`/`e9` bytes inside `movabs`
immediates — where the `e8`/`e9` is a ModRM/immediate byte, not a branch opcode.

Rewritten to use an **instruction-boundary-aware x64 decoder** (`decodeInstr`, ported
from the yoyo-decoder tool's `src/linscan.rs`). It relocates only the rel32/disp32
field of genuine `call/jmp/jcc/call[rip]/jmp[rip]/lea[rip]`. Verified: 10/10 unit
patterns (traps untouched, real branches relocated); changed gen1/gen2 bytes (proving
real prior corruption); `node yoyo.js` still builds gen1; M1→M2 still works;
`test-phase1` output byte-identical (no regression).

**Note:** this fix is necessary but **not sufficient** for Windows M3 — see below.

### Windows M2→M3 second root cause (open, 2026-07-07)

After the relocateSlice fix, M2→M3 still fails. Evidence (reliable `cmd` runs):

- `gen1` emits `output.exe` (264192 B) **regardless of `input.ky`** — template-copy driven.
- `gen2` emits nothing, exit 0, with or without `input.ky` — **not a crash**.
- gen1 (node direct compile) does **not** exercise the overlay+handler-map self-host
  mechanism for itself; gen2 depends entirely on it. So gen1 working does **not**
  validate the overlay path — only gen2 running does.
- Most likely: gen2 reaches its `WriteFile` but `CreateFileA("output.exe")` gets a bad
  pointer (a mis-relocated `lea rcx,[rip+disp]` to the "output.exe" string at data
  +0x8822), so file creation fails silently and gen2 exits 0. **Unconfirmed** — needs
  a runtime debugger (x64dbg/WinDbg) breakpoint on gen2's `CreateFileA`/`WriteFile`
  (`FF 15` IAT calls) to inspect `rcx`.
- Ruled out: relocateSlice (fixed, still fails); the unconditional Linux-`syscall`
  debug trace at `yoyo-gen.js:444-453` (it is emitted *by* gen2 into gen3, harmless to
  gen2's own run).

### History (retained for context)

The 2026-06-30 deep dive identified root cause: `projects/yoyo.ty` had **dual-purpose**
semantics — Node (`yoyo.js`) compiled it to gen1 via `compileLinux`; gen1 **scan-emitted**
the same source into gen2 via `genLinuxLoadFileHandler` / `H_B0` etc.

| gen1 | scan-emit gen2 | byte-match | runs as compiler? |
|------|----------------|------------|-------------------|
| Node `compileLinux` | `buildLinuxOutputStartup` → scan-emit handlers | ❌ divergent (mmap flags, `H_00`/`H_01`) | gen2: codeEnd=30, immediate EOF |

Three failures identified in PENDING (pre-fix):

1. **Fixup overflow** — fixed (`20 05/06 1000`, native `H_FE`, `a1` meta-emit).
2. **Scan-emitted handlers ≠ Node handlers** — fixed in `compileFromAnalyzed` path
   (commit `44c1e3d`, 2026-07-05). gen2 H_00/H_01 machine code now matches gen1.
3. **PC-relative handler blobs** — `relocateSlice()` in `blob-handlers.js`; full blob
   path still uses 4 pre-emitted `data.blob` entries.

After M3 fix:

> M3 was achieved by rebuilding `build/yoyo.exe` with the current code
> (TIR intrinsics form of yoyo.ty + compileFromAnalyzed path). The old
> binary was from commit `e0c1c64` and was out of sync with the current
> `yoyo.ty`. After rebuild, gen2 ≡ gen3.

### Remaining items (post-M3)

1. **Linux native verification** — `bash scripts/bootstrap-native.sh 3` not yet
   run end-to-end on Linux. The `linux-self-emit.js` LoadFile mmap flags were
   rewrittten to match `linux-runtime.emitLoadFile` in commit `1321cc9`. CI
   workflows (`strace-gen2.yml`, `bootstrap-native.yml`) added for diagnostic
   capture. **Status:** trace tooling in place; final PASS pending.

2. **Replace `data.blob` with pure TIR** — 4 `data.blob` entries in
   `projects/yoyo.ty` are pre-emitted x64 bytes that bypass TIR codegen.
   The `compileFromAnalyzed` path handles them consistently, so they don't
   cause scan/emit divergence, but they remain as a non-uniform code path.
   **Optional** (not required for self-hosting) per PHASE5-ROADMAP.md, but
   required for the "single codegen path" goal of `evolution.md`.

### Resolution strategy

See `docs/evolution.md` — TIR single codegen path. Once `data.blob` is
fully replaced by TIR intrinsics, the scan-emit path can be removed entirely.
`src/backends/tir-emit-linux.js` is the partial-op replacement already in
progress.

### What we tried (historical)

- Larger fixup arrays, always-forward jmp/call emitters
- Native fixup resolver blob (`buildLinuxFixupResolver`, handler `H_FE`)
- `a1` opcode (avoid `a0` → H_B0 scanner hijack)
- Optional `YOYO_BLOB=1` post-process — unstable / SIGILL on full blob
- strace-based hang diagnostics (commits `75011ce`…`f6afbdb`)

These are documented for traceability — the path forward is **TIR single codegen**,
not more meta-emitter patches.

## Items not blocking the evolution track

- TIR-WASM backend — Phase 4/6 work, separate module
- TIR-AArch64 backend — Phase 7, depends on Phase 6 (data.blob replacement)
- Typed state slots replacing `state_XX` numbering — TBD per `evolution.md` Phase 4