# TIR (Typed Intermediate Representation)

TIR is the typed IR layer between yoyo source and native code emission.

**Aggressive evolution track:** see [`evolution.md`](evolution.md)  
**Deferred bootstrap item:** Stage 3 meta-emitter parity → [`PENDING.md`](PENDING.md)

## Goals

- Separate **parsing / lowering** from **codegen** so backends can target x64, WASM, etc.
- Preserve bootstrap compatibility: default path remains direct x64 meta-emitter (`--backend=x64`).
- **Single semantic path** for host and self-host (fixes Stage 3 without per-handler scan parity).

## Pipeline

```
projects/yoyo.ty  →  parse + file-order handlers  →  TIR module  →  backend  →  ELF/PE
```

## Module shape

```js
{
  name: 'yoyo',
  handlerOrder: [0, 1, 0x20, …],
  functions: [
    {
      name: 'H1',
      blocks: [{ label: 'entry', ops: [
        { kind: 'label', hh: 1 },
        { kind: 'state.cmp', a: 0x0c, b: 0x0d },
        { kind: 'jcc.ae', hh: 0xcc },
        …
      ]}]
    }
  ],
  fixups: [{ hh: 0x64, site: { … }, rawOp: 0x70 }],
  meta: { handlerCount, fixupCount, topOpCount }
}
```

## Opcodes (`src/tir/ops.js`)

| Kind | yoyo source |
|------|-------------|
| `call` | `41 hh` |
| `jmp` | `70 hh` |
| `jcc.*` | `71`–`78`, `7a`, `82`, `83` |
| `emit.u8` | `a1 bb` |
| `raw.a0` | `a0 <hex>` |
| `alloc` | `20 ss sz` |
| `intrinsic.load_file` | `50 …` |

Forward fixups are recorded at lower time (`fixups[]`).

## Status

| Component | State |
|-----------|--------|
| `docs/evolution.md` | **Aggressive roadmap** |
| `docs/PENDING.md` | Stage 3 deferred |
| `src/tir/lower.js` | File-order lowering + fixups |
| `src/tir/verify.js` | Module validation |
| `src/tir/print.js` | Human-readable dump |
| `src/backends/tir-x64.js` | Phase 2 stub |
| `--backend=tir` | Lower + verify + x64 fallback |
| `--backend=tir-x64` | Lower + verify (codegen TBD) |

## Commands

```bash
node scripts/tir-check.js projects/yoyo.ty
node scripts/tir-check.js projects/yoyo.ty --verbose
node src/yoyo.js --backend=tir --target=linux projects/yoyo.ty build/yoyo
```

## Milestones

See `docs/evolution.md` — M1: ≥200 handlers & ≥500 fixups on `projects/yoyo.ty` via `tir-check`.
