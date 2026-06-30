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

### Root cause (confirmed)

`projects/yoyo.ty` is **dual-purpose**: Node (`yoyo.js`) compiles it to gen1; gen1 **scan-emits** the same source into gen2. Those two paths are not required to agree on layout, but Stage 3 needs **gen2's emitted machine code to be a fixed point** when gen2 runs as compiler.

Today:

1. **Fixup overflow** — fixed (`20 05/06 1000`, native `H_FE`, `a1` meta-emit).
2. **Scan-emitted handlers ≠ Node handlers** — gen2's in-image `H_01` / `H_30` / … execute incorrectly; gen3 `codeEnd ≈ 0x1e`, handler table all zero.
3. **PC-relative handler blobs** — copying reference slices with `a0`/`a1` blobs breaks when relocated (SIGILL).

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
