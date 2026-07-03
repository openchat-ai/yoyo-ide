# Aggressive evolution: TIR-first compiler

This document is the **intentional exit** from fixing Stage 3 by patching the meta-emitter forever. The meta-emitter (`yoyo-gen.js` → scan → in-image handlers) stays for bootstrap **gen1**, but **gen2+ must not depend on scan-emitted handler parity**.

## Problem statement

```
yoyo-gen.js  ──►  projects/yoyo.ty  ──►  yoyo.js (Node)  ──►  gen1
                              │
                              └──►  gen1 scan-emit  ──►  gen2  ──►  gen3
```

Two different “compilers” read the same text:

| Path | Executor | Codegen |
|------|----------|---------|
| Host | Node `compileLinux` | Direct x64 from opcodes |
| Self | gen1/gen2 scan + `H_30` emitters | Emits x64 into output buffer |

Stage 3 needs `f(gen2) = gen2`. That is a **fixed point of one function `f`**, not “Node layout == scan layout”.

Chasing parity handler-by-handler (`H_37`, `H_63`, `H_A8`, …) scales as **O(handlers × opcodes)** and fails on PC-relative blobs.

## Target architecture

```
                    ┌─────────────────┐
  projects/yoyo.ty  │  parse (lex)    │
        ───────────►│  file-order     │
                    │  handler map    │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  TIR module     │  ← single semantic truth
                    │  + fixup table  │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         backend-x64   backend-wasm   backend-tir-vm
              │              │              │
              ▼              ▼              ▼
           ELF/PE          .wasm         interpreter
```

### Invariants (non-negotiable)

1. **One lowering** — `lowerProgram()` produces the same TIR for host and self-host inputs.
2. **Fixups are data** — forward `call`/`jmp`/`jcc` recorded in `TirModule.fixups`, resolved in one pass (already proven in native `H_FE`).
3. **No scan-emitted codegen for evolution builds** — gen2+ images embed **TIR-codegen’d** handler bodies, not re-interpreted `41 e0` chains from `yoyo.ty`.
4. **Bootstrap ladder** — Node remains stage-0; TIR-x64 replaces stage-1 scan-emit when `TIR_BOOTSTRAP=1`.

## Phases

### Phase 0 — Skeleton (done)

- `docs/tir.md`, `src/tir/*`, `src/backends/registry.js`
- `--backend=tir` lowers then falls through to x64 (no semantic change)

### Phase 1 — Semantic lowering (this PR track)

- File-order handlers (`40 hh`), not `analyze()` merged sections
- Lower opcodes → `TirOp` (`call`, `jmp`, `jcc`, `state.set`, `emit.byte`, `alloc`, …)
- Record fixups at lowering time
- `scripts/tir-check.js` + unit checks on `projects/yoyo.ty`

### Phase 2 — TIR → x64 backend

- `src/backends/linux-emit-core.js` — shared opcode → x64 mapping
- `src/backends/tir-emit-linux.js` — TIR module emission
- **Gate M2:** `scripts/compare-backends.js` → **0 byte diffs** (analyze handler order)

### Phase 3 — Cut the dual path

- `TIR_BOOTSTRAP=1` in `scripts/bootstrap-native.sh` builds gen1 via `--backend=tir-x64`
- `TIR_HANDLER_ORDER=analyze|file` env for lowering/emission order
- gen1 TIR ≡ x64; gen2+ still scan-emitted until runtime TIR cutover

### Phase 4 — Multi-target

- `src/backends/tir-wasm.js` — WASM skeleton (`--backend=tir-wasm`)
- Optional typed state slots (replace implicit `state_XX` numbering) — TBD

### Phase 5 — Bootstrap Stage 3 via TIR

- gen1 via `TIR_BOOTSTRAP=1` — **ready**
- `gen2 === gen3` fixed point — **still FAIL** (scan path in gen2 output)

### Phase 6 — `.ytir` export + CI

- `src/tir/serialize.js`, `scripts/export-ytir.js`
- `scripts/evolution-check.sh` — M1 + M2 gates

## TIR design choices (aggressive)

### File-order handlers

`analyze()` merges `40 hh` sections until `FF` and **collapses** inner `40` labels — wrong for scanner handlers and fixup resolver. TIR uses **source line order** (same as `blob-handlers.js`).

### Fixup model

```js
{ kind: 'fixup.forward', hh, patchPos, width: 4 }
```

Resolver: `target = handlerOffset[hh]`, `rel32 = target - (patchPos + 4)`, skip if `patchPos < startupLen`.

### Intrinsics (replace meta-opcodes)

| yoyo | TIR |
|------|-----|
| `41 hh` | `call` / `tail_call` |
| `70 hh` | `jmp` |
| `71 hh` | `jcc.eq` |
| `a1 bb` | `emit.u8` |
| `20 ss sz` | `alloc` |
| `50 …` | `intrinsic.load_file` |

Intrinsics lower to platform calls in backend — **never** re-parsed as text.

### Determinism contract

- Handler order = first `40 hh` appearance in file
- Block order = source order within handler
- Fixup iteration order = emission order
- Backend must not use host `Map` iteration for labels

## What we stop doing

- Hand-editing `projects/yoyo.ty`
- Adding scan emitters in `yoyo-gen.js` for each new opcode (long-term)
- Blobbing PC-relative handler slices for self-host parity
- Expecting `compare-handler-slices.js` against `analyze()` boundaries

## Commands (evolution)

```bash
# Lower yoyo.ty → TIR summary
node scripts/tir-check.js projects/yoyo.ty

# M2 gate: x64 vs tir-x64 byte match
node scripts/compare-backends.js

# Full evolution CI (M1 + M2)
bash scripts/evolution-check.sh

# Export .ytir
node scripts/export-ytir.js projects/yoyo.ty build/yoyo.ytir

# TIR-only codegen (M2 — analyze order, byte-match x64)
node src/yoyo.js --backend=tir-x64 --target=linux projects/yoyo.ty build/yoyo

# Bootstrap with TIR gen1
TIR_BOOTSTRAP=1 bash scripts/bootstrap-native.sh 3
```

## Success metrics

| Milestone | Criterion | Status |
|-----------|-----------|--------|
| M1 | `tir-check` reports ≥120 handlers, ≥500 fixups on `projects/yoyo.ty` | **PASS** |
| M2 | TIR-x64 gen1 byte-match Node gen1 (Linux + Windows) | **PASS** (0 diffs both) |
| M3 | `bootstrap-native.sh 3` PASS via TIR path | **FAIL** (scan gen2) |
| M4 | `yoyo-gen` outputs TIR, not 2500-line meta-source | **TBD** |

Stage 3 meta-emitter parity is **documented as deferred** in `docs/PENDING.md` until M3.
