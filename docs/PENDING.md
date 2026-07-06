# Pending / Deferred

Items intentionally **not** blocking the aggressive evolution track (`docs/evolution.md`).

## Bootstrap Stage 3 — `gen2 ≡ gen3`

**Gate:** `bash scripts/bootstrap-native.sh 3` → `cmp gen2 gen3` byte-identical.

### Current state (2026-07-06, updated)

| Check | Status |
|-------|--------|
| M2 TIR-x64 ≡ x64 gen1 | **PASS** (0 byte diffs via `linux-emit-core.js`) |
| gen1 runs, emits gen2 | OK |
| gen2 forward fixups (`e8 rel32`) | OK (native `H_FE` resolver) |
| **M3: gen2 ≡ gen3** | **PASS** (Windows, 2026-07-05, hash `837CFD8...`) |
| M3: gen2 ≡ gen3 | **Pending verification** (Linux native via `bootstrap-native.sh`) |
| `TIR_BOOTSTRAP=1` gen1 | TIR-built gen1 ≡ x64 gen1 |

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