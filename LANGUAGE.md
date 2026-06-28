# yoyo Language

## Naming

| Concept | Name | Note |
|---------|------|------|
| **Language** | **yoyo** | The real name. Spelled lowercase. |
| **Source file extension** | **`.ty`** | Like C's `.c` |
| **Object file extension** | **`.tyo`** | Like C's `.o` |
| **Compiler** | **ky compiler** (`kyc`) | "ky" is a legacy tool name, not the language. |
| **Self-hosted compiler binary** | `mini-kyc.exe` | Existing artifact; do not rename. |

The reasoning is: the **language** is "yoyo", but the **compiler** keeps the historical "ky" name (like `gcc` is the C compiler, not "the C compiler is also called C"). `ky` here is just a label.

## Why this naming

- **`yoyo`** — the project is `yoyo-ide`; the language is named after it.
- **`.ty`** — short, no major conflict (only TiVo video files in legacy contexts). Pairs naturally with `.tyo`.
- **`.tyo`** — analogue to C's `.o`. No real conflict in the wild.
- **`ky compiler` / `kyc`** — historical name. Renaming the compiler is a separate concern; the current `ky-compiler.js` and `mini-kyc.exe` keep the "kyc" prefix.

## File types in this repo

| File | Type |
|------|------|
| `projects/mini-kyc.ky` | yoyo source (legacy `.ky` extension; **migration to `.ty` is future work**) |
| `mini-kyc.exe` | yoyo object / self-hosted compiler |
| `output.exe` | yoyo object / Stage 2+ output |
| `*.ky` | yoyo source (legacy) |
| `*.tyo` | reserved for future object files |

## Compiler artifacts

| Stage | Tool | Input | Output |
|-------|------|-------|--------|
| Bootstrap (gen 1) | `ky-compiler.js` (Node.js) | `.ky` source | `.exe` |
| Self-hosted (gen 2+) | `mini-kyc.exe` | `.ky` source | `.exe` |
| Future (`.ty` migration) | renamed compiler | `.ty` source | `.tyo` / `.exe` |

## References

- `spec.md` §0 — TL;DR
- `BOOTSTRAP.md` — Component Relationships
- `TASKS.md` — Current state

## TODO

- [ ] Migrate `projects/mini-kyc.ky` → `projects/mini-kyc.ty`
- [ ] Update `create-mini-kyc*.js` to emit `.ty` files
- [ ] Update `ky-compiler.js` to accept `.ty` (or both `.ty` and `.ky`)
- [ ] Update scripts (`bootstrap-check.ps1`) for new extensions
- [ ] Decide: rename `mini-kyc.exe`? Keep for now (binary compatibility).
