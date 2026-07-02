# AGENTS.md

## Cursor Cloud specific instructions

### What this repo is
`yoyo` is a self-hosting compiler toolchain (no long-running services, no DB, no web
server). A Node.js host compiler (`src/yoyo.js`, driven by generator `src/yoyo-gen.js`)
turns the `.ty` source in `projects/yoyo.ty` into a native executable, which can then
recompile itself. Two output targets exist:
- `--target=win` (default): x86_64 Windows **PE** (`.exe`). CI uses this target.
- `--target=linux`: x86_64 **ELF** that runs natively on Linux (no Wine).

The only npm dependency is `koffi`, used solely by `tools/debug.js` (a Windows-only
debugger) — it is not needed to build, self-host, or run the gate.

### Runtimes / environment (already provisioned by the update script)
- `npm install` is the whole dependency setup (installs `koffi`).
- Node: the default `node` on PATH is `/exec-daemon/node` (v22). CI pins Node 20, but
  generator/compiler output is **byte-identical** on v20 and v22 (verified), so there is
  no need to switch Node versions. `nvm use 20` does not change `node` because
  `/exec-daemon` precedes nvm on PATH; invoke the nvm binary by full path if you ever
  truly need v20.
- **Wine** (`/usr/bin/wine`) is required only to *run the produced Windows PE* on Linux
  (`scripts/test-stage2.sh`, `scripts/bootstrap-selfhost.sh`). It is NOT part of the
  update script; install with `sudo apt-get install -y wine64 wine` if a fresh VM lacks
  it, then `wine wineboot --init` once. Prefer the native Linux target to avoid Wine.

### Build / run / test (standard commands live in `Makefile` and `docs/spec.md` §12)
- Determinism gate (core CI logic): `bash scripts/bootstrap-check.sh` → expect
  `bootstrap-check: PASS` (compiles twice, compares). This is the reliable "env works"
  signal.
- Native Linux self-host (no Wine): `bash scripts/bootstrap-native.sh 2` → `stage 2 PASS`
  (Node builds `build/yoyo`, that ELF runs and recompiles the compiler source).
- Windows PE self-host (needs Wine): build `build/yoyo.exe` then `bash scripts/test-stage2.sh`.
- There is no lint step and no unit-test framework; the `.ty` files under `tests/` and
  `projects/` are compiler inputs, and the bootstrap scripts are the test suite.

### Non-obvious gotchas
- **The `--strict --lock` gate is currently RED on `main`** (and in GitHub CI). The
  committed `bootstrap-baseline.txt` is stale relative to the current source: the source
  now produces `yoyo.ty=9838E958…` / `yoyo.exe=1D12F6C1…`, while the baseline still lists
  the older `DB8967F6…` / `5FD9A2FF…`. This is a pre-existing repo/baseline drift, not an
  environment problem — the determinism check itself passes. Do not "fix" it during env
  setup; a maintainer must intentionally run `bootstrap-check.sh --strict --update-baseline`.
- **Stage 3 is a known failure**: `bash scripts/bootstrap-native.sh 3` fails at
  `gen2 === gen3` by design (see `docs/PENDING.md`). Use stage 2 to prove the toolchain.
- **The produced compiler ignores CLI args**: `build/yoyo` / `build/yoyo.exe` always read
  `./input.ky` and write `./output` (`output.exe` on win) in the current directory. If
  `input.ky` is missing it hangs (CPU spin, no output). The bootstrap scripts handle this
  by copying inputs into a temp workdir.
- `build/` is gitignored except the tracked binary `build/yoyo.exe`; rebuilding it will
  show a dirty `build/yoyo.exe` — do not commit that change.
- Small `.ty` fragments (e.g. `tests/minimal.ty`) are compiler snippets, not standalone
  programs; compiling and running them can segfault (bare `ret`, no exit syscall). Only
  the full compiler source is a runnable program.
