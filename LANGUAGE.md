# yoyo Language

## Naming

| Concept | Name | Note |
|---------|------|------|
| **Language** | **yoyo** | The real name. Spelled lowercase. |
| **Source file extension** | **`.ty`** | k→t, like `.c` for C. |
| **Object file extension** | **`.tyo`** | Like `.o` for C. |
| **Compiler** | **yoyo compiler** | No special suffix; just call it the yoyo compiler. |
| **Self-hosted compiler binary** | `mini-kyc.exe` | Existing artifact; keep for now. |
| **Host compiler script** | `ky-compiler.js` | Existing file; keep for now. |

The reasoning: the **language** is "yoyo". The file extension mirrors C's convention
(`.c`/`.o` ↔ `.ty`/`.tyo`). The compiler is just the "yoyo compiler" — no need
for a special tool name (like how nobody calls the C compiler "cc" except in shell
shortcuts; it's just "the C compiler").

## Extension etymology

- **`.ky`** (legacy) → **`.ty`** (target). Same letters, k→t.
- **`.c`** → **`.o`**: source → object. Same pattern: **`.ty`** → **`.tyo`**.
- **`ty`** can also be read as **唐尧** (Táng Yáo, legendary ancient emperor)
  or **唐悠悠** (Táng Yōuyōu) — both fitting the "yoyo" / "悠悠" theme.

## File types in this repo

| File | Type |
|------|------|
| `projects/mini-kyc.ky` | yoyo source (legacy `.ky`; **migration to `.ty` is future work**) |
| `mini-kyc.exe` | yoyo compiler (self-hosted binary; legacy name) |
| `output.exe` | yoyo compiler (Stage 2+ output) |
| `ky-compiler.js` | yoyo compiler (Node.js host; legacy name) |
| `*.ky` | yoyo source (legacy) |
| `*.ty` | yoyo source (target) |
| `*.tyo` | yoyo object (target, future) |

## Compiler artifacts

| Stage | Tool | Input | Output |
|-------|------|-------|--------|
| Bootstrap (gen 1) | `ky-compiler.js` (Node.js, the yoyo compiler) | `.ky` source | `.exe` |
| Self-hosted (gen 2+) | `mini-kyc.exe` (the yoyo compiler) | `.ky` source | `.exe` |
| Future (`.ty` migration) | the yoyo compiler (renamed) | `.ty` source | `.tyo` / `.exe` |

## References

- `spec.md` §0 — TL;DR
- `BOOTSTRAP.md` — Component Relationships
- `TASKS.md` — Current state

## TODO

- [ ] Migrate `projects/mini-kyc.ky` → `projects/mini-kyc.ty`
- [ ] Update `create-mini-kyc*.js` to emit `.ty` files
- [ ] Update `ky-compiler.js` to accept `.ty` (or both `.ty` and `.ky`)
- [ ] Decide whether to rename `ky-compiler.js` / `mini-kyc.exe` (binary compat concerns)
- [ ] Update scripts (`bootstrap-check.ps1`) for new extensions
- [ ] **Generic CLI file args** (currently `mini-kyc.exe` is hardcoded to read `input.ky`
  and write `output.exe`; needs Phase 2 opcodes 50/51 + dynamic string table)
- [ ] **String table generalization** (H_86/H_88/H_8A/H_8C are special-cased for
  "input.ky"/"output.exe"; should be data-driven)


