# Bootstrap Workflow

This project currently uses a deterministic pre-bootstrap gate before true stage execution self-hosting.

## Commands

1. Quick check

```bash
bash scripts/bootstrap-check.sh
```

2. Strict report

```bash
bash scripts/bootstrap-check.sh --strict
```

3. Update fixed baseline (only when current state is intentionally accepted)

```bash
bash scripts/bootstrap-check.sh --strict --update-baseline
```

4. Lock mode (CI-style regression gate)

```bash
bash scripts/bootstrap-check.sh --strict --lock
```

## Make Targets

```bash
make bootstrap-check
make bootstrap-strict
make bootstrap-lock
make bootstrap-update-baseline
```

`make bootstrap-lock` is the recommended local pre-push gate.

## CI

GitHub Actions workflow:

- `.github/workflows/bootstrap-gate.yml`

The workflow runs `./scripts/bootstrap-check.sh --strict --lock` on push/PR to `main`.

## Files

- `bootstrap-report.txt`: current run summary
- `bootstrap-report-diff.txt`: comparison against fixed baseline
- `bootstrap-baseline.txt`: fixed baseline used by lock mode

`bootstrap-baseline.txt` should be kept under version control.
`bootstrap-report.txt` and `bootstrap-report-diff.txt` are runtime artifacts and should stay untracked.

## Exit behavior

- `0`: pass
- `1`: determinism check failed (`ky` or `exe` mismatch)
- `2`: invalid argument argument usage
- `3`: lock mode cannot find baseline
- `4`: lock mode baseline drift detected

## Component Relationships

```
create-mini-kyc3.js  ──生成──▶  mini-kyc.ky  ──编译──▶  mini-kyc.exe
       ↑                                │
  (JS 生成器)                  编译(第二阶段) │
  (H_30 emitter 源)                         ▼
       │                              mini-kyc.exe 自举自己
       │                                │
       └──────────  ── ── ── ── ── ── ── ┘
                          │
                   ky-compiler.js
                          │
                (JS 参考编译器，第一阶段)
```

**三个角色：**

1. **`create-mini-kyc3.js`** — Node.js 生成器。用 JS 写出 `mini-kyc.ky`（包括所有 H_30 emitter handlers 的 ky 代码）。改 emitter 逻辑后跑一次 `node create-mini-kyc3.js` 重新生成。

2. **`ky-compiler.js`** — JavaScript 写的参考编译器，把 `.ky` 编译成 `.exe`。bootstrap 第一阶段；是唯一能编译出 `mini-kyc.exe` 的工具。自举完成后理论上可扔掉。

3. **`mini-kyc.exe`** — 自托管编译器。一旦存在，它就能自己编译 `mini-kyc.ky`（第二、三、N 阶段），不再需要 `ky-compiler.js`。

**Bootstrap 链：**

```
[1] node create-mini-kyc3.js          →  projects/mini-kyc.ky
[2] node ky-compiler.js mini-kyc.ky   →  mini-kyc.exe           (gen 1)
[3] mini-kyc.exe                      →  output.exe (stage2)    (gen 2)
[4] output.exe                        →  output.exe (stage3)    (gen 3)
[5] ...                               →  ...                    (gen N)
```

gen 2 起所有 gen 的输出应该 byte-for-byte 一致（验证自举正确性）。当前 3 阶段 0 diff。
