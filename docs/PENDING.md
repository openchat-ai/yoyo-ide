# Pending / Deferred

Items intentionally **not** blocking the aggressive evolution track (`docs/evolution.md`).

## Stage 3 Linux bootstrap — `gen2 === gen3`

**Gate:** `bash scripts/bootstrap-native.sh 3` → `cmp gen2 gen3` byte-identical.

### Current state (2026-06-30)

| Check | Status |
|-------|--------|
| gen1 runs, emits gen2 | OK |
| gen2 forward fixups (`e8 rel32`) | **3** bad sites (was 526) via native `H_FE` resolver |
| gen2 self-host (`gen2` → gen3) | **FAIL** — ~27k vs ~370 bytes of real `.text`; handler map empty in gen3 |
| `cmp gen2 gen3` | ~27k differing bytes |

### Root cause (confirmed, 2026-06-30 deep dive)

`projects/yoyo.ty` is **dual-purpose**: Node (`yoyo.js`) compiles it to gen1; gen1 **scan-emits** the same source into gen2.

| Artifact | Entry startup | `.text` handlers | Runs as compiler? |
|----------|---------------|------------------|-------------------|
| gen1 (`build/yoyo`) | `buildLinuxStartup` → state @ `STATE_BUF_OFF` | Node `compileLinux` | **Yes** |
| gen2 (gen1 scan output) | `buildLinuxOutputStartup` → state @ `OUTPUT_STATE_BUF_OFF` | Scan-emitted | **No** — `codeEnd=30`, immediate EOF |

gen1 compiling `yoyo.ty` → output with `codeEnd=27056` (44-byte data diff vs Node compile).  
gen2 running on `yoyo.ty` → output with `codeEnd=30`, `table[1]=0` (scan never emits handlers).

gen2's own `.text` is byte-identical to gen1's scan output (not to Node gen1 `.text`). The scan-emitted runtime path does not execute the scanner loop correctly — `read_ptr >= end_ptr` on first `H_01` iteration (LoadFile / pointer init failure in emitted `H_00`).

Today:

1. **Fixup overflow** — fixed (`20 05/06 1000`, native `H_FE`, `a1` meta-emit).
2. **Scan-emitted handlers ≠ Node handlers** — gen2 `H_00`/`H_01` machine code differs; runtime scan broken.
3. **PC-relative handler blobs** — `relocateSlice()` added in `blob-handlers.js`; full blob path still unstable.

### Resolution strategy

See `docs/evolution.md` — TIR single codegen path. `src/backends/tir-emit-linux.js` started (partial op lowering).

### What we tried

- Larger fixup arrays, always-forward jmp/call emitters
- Native fixup resolver blob (`buildLinuxFixupResolver`, handler `H_FE`)
- `a1` opcode (avoid `a0` → H_B0 scanner hijack)
- Optional `YOYYO_BLOB=1` post-process — unstable / SIGILL on full blob

### Resolution strategy (deferred to evolution)

Do **not** chase byte parity only in the meta-emitter. See `docs/evolution.md`:

- **TIR** as single semantic IR after parse
- **One codegen path** for host (Node) and self-hosted output
- Bootstrap Stage 3 becomes a property of **TIR determinism**, not `yoyo-gen.js` ↔ scan parity

Until TIR-x64 can compile `projects/yoyo.ty`, Stage 3 remains **open** on branch `cursor/stage3-meta-emitter-fixes-e6fe` (PR #4) with partial fixup fixes landed.
