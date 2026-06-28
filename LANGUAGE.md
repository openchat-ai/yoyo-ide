# yoyo Language

## Naming

| Concept | Name | Note |
|---------|------|------|
| **Language** | **yoyo** | The real name. Spelled lowercase. |
| **Source file extension** | **`.ty`** | Like C's `.c` |
| **Object file extension** | **`.tyo`** | Like C's `.o` |
| **Compiler** | **yoyo compiler** (`yoyoc`) | Compiler name = language name. |
| **Self-hosted compiler binary** | `mini-kyc.exe` | Existing artifact; keep for now. |
| **Host compiler script** | `ky-compiler.js` | Existing file; keep for now. |

The reasoning is: the **language** is "yoyo" and the **compiler** is the "yoyo compiler".
Like the C language has the C compiler, yoyo has the yoyo compiler. The historical
`ky` prefix in `ky-compiler.js` and `mini-kyc.exe` is legacy and is being phased out.

## Why this naming

- **`yoyo`** — the project is `yoyo-ide`; the language is named after it.
- **`.ty`** — short, no major conflict (only TiVo video files in legacy contexts). Pairs naturally with `.tyo`.
- **`.tyo`** — analogue to C's `.o`. No real conflict in the wild.
- **`yoyo compiler` / `yoyoc`** — compiler name matches language name (parallel to C/C compiler).

## File types in this repo

| File | Type |
|------|------|
| `projects/mini-kyc.ky` | yoyo source (legacy `.ky` extension; **migration to `.ty` is future work**) |
| `mini-kyc.exe` | yoyo compiler (self-hosted binary; legacy name) |
| `output.exe` | yoyo compiler (Stage 2+ output) |
| `ky-compiler.js` | yoyo compiler (Node.js host) |
| `*.ky` | yoyo source (legacy) |
| `*.ty` | yoyo source (target) |
| `*.tyo` | yoyo object (target, future) |

## Compiler artifacts

| Stage | Tool | Input | Output |
|-------|------|-------|--------|
| Bootstrap (gen 1) | `ky-compiler.js` (Node.js yoyoc) | `.ky` source | `.exe` |
| Self-hosted (gen 2+) | `mini-kyc.exe` (yoyoc) | `.ky` source | `.exe` |
| Future (`.ty` migration) | `yoyoc` (renamed) | `.ty` source | `.tyo` / `.exe` |

## References

- `spec.md` §0 — TL;DR
- `BOOTSTRAP.md` — Component Relationships
- `TASKS.md` — Current state

## TODO

- [ ] Migrate `projects/mini-kyc.ky` → `projects/mini-kyc.ty`
- [ ] Update `create-mini-kyc*.js` to emit `.ty` files
- [ ] Update `ky-compiler.js` to accept `.ty` (or both `.ty` and `.ky`)
- [ ] Rename `ky-compiler.js` → `yoyoc.js` (and keep alias if needed)
- [ ] Rename `mini-kyc.exe` → `yoyoc.exe` (later, for clean naming)
- [ ] Update scripts (`bootstrap-check.ps1`) for new extensions

