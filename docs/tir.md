# TIR (Typed Intermediate Representation)

TIR is the planned typed IR layer between the yoyo source scanner and native code emission.

## Goals

- Separate **parsing / typing** from **codegen** so backends can target x64, WASM, etc.
- Preserve bootstrap compatibility: default path remains direct x64 meta-emitter (`--backend=x64`).
- Enable incremental vertical slices: parse → lower → emit one construct at a time.

## Pipeline (target)

```
yoyo.ty scan  →  TIR module  →  backend registry  →  ELF/PE bytes
```

## Module shape (sketch)

```js
{
  name: 'input',
  functions: [
    {
      name: 'H00',
      params: [],
      blocks: [
        { label: 'entry', ops: [ { kind: 'call', target: 'H01' } ] }
      ]
    }
  ]
}
```

## Status

| Stage | State |
|-------|--------|
| `docs/tir.md` | skeleton |
| `src/tir/` | parse + lower stubs |
| `src/backends/registry.js` | x64 default + tir placeholder |
| CLI `--backend=tir` | wired, no-op lower for now |

## Next slices

1. Lower handler `40 hh` / `41 hh` into TIR `label` + `call`.
2. Mirror fixup metadata (hh, patch_pos) in TIR for deterministic resolver tests.
3. Share fixup resolver tests with `scripts/bootstrap-native.sh 3`.
