# mini-kyc 编译目标 / 任务清单

## Stage 1: 决定性 gate（已恢复）

- `scripts/bootstrap-check.sh`：两次生成 + 两次编译 + SHA256 比对
- `bootstrap-baseline.txt`：锁定 baseline SHA256
- `.github/workflows/bootstrap-gate.yml`：CI 卡点
- `BOOTSTRAP.md`：使用说明

任何对 `create-mini-kyc3.js` / `ky-compiler.js` / `encode-x64.js` / `pe-builder.js` 的改动，**必须**跑 `bash scripts/bootstrap-check.sh --strict --lock`，SHA256 漂了就是回归。

## 当前基线（2026-06-27 恢复后）

```
mini-kyc.ky.sha256: cd2bffec671f75f86d40e62a1c5e4cf44c4382260c02086d560cf4e6123d6969
mini-kyc.exe.sha256: 938e7940cf5521c8922e1928cda67854f62e12e0d090e3dae0eb2f34bb355453
```

## 历史教训

- `babb051` 引入 bootstrap gate（baseline = 658c237c... / a806f0f...）
- `39ee3b3` 加 H_30 emitter 时**误删整套 bootstrap 基础设施**（5 个文件 + .gitignore）
- 此后没有任何 gate 在跑，flash v4 阶段无脑改 `create-mini-kyc3.js` 引入 16 个 Phase 2 opcode emitter + 启动块改造 + WriteFile size 改动 + IAT disp 改动，全无验证
- 已 stash 留底（`flash-v4-mess-2026-06-27`），未丢弃任何决策但需要逐条重审

## 下一步（建议路径）

### A. Stage 2: Phase 1 自举（mini-kyc.exe → mini-kyc2.exe）

- 输入是 `mini-kyc.ky`，输出是另一个 `.exe`
- 必须和 Node.js 编译产物 bit-identical
- 失败的几种原因：扫描器/发射器 bug、handler 表错位、IAT disp 错、startup blob 不一致
- 验证手段：跟 ky-compiler.js 产出的 `.exe` 做 cmp

### B. Stage 3: 三阶段自举（mini-kyc2.exe → mini-kyc3.exe）

- Stage 2 通过之后才做
- mini-kyc2.exe 编译 mini-kyc.ky → mini-kyc3.exe
- 三者必须 bit-identical

### C. Phase 2: 加剩余 opcode emitter

- 当前 mini-kyc.ky 支持 9 个 opcode（`40 FF 30 60 65 66 70 71 41`）
- 完整 self-hosting 需要：61 62 65 68 69 70-7A 80 84 20 50 51
- **必须在 Stage 2 通过后、且 Stage 1 gate 跑通的基础上做**
- 每加一个 opcode，跑一次 `bootstrap-check.sh --strict --lock` 确认基线没漂

## 已完成

- ✅ 恢复 babb051 bootstrap 基础设施
- ✅ 更新 baseline 到 H_30 之后的"已知良好"状态
- ✅ 验证决定性：同输入两次跑产出 bit-identical
- ✅ Stash flash v4 改动到 `flash-v4-mess-2026-06-27`
- ✅ flash v4 patch 逐条重审：4 个 patch（A/B/C/D），A 和 B 已应用，C 已丢弃，D 已丢弃
- ✅ `spec.md` 编写完成（~700 行，16 章）
- ✅ `debug.js` — Windows Debug API debugger 通过 koffi 实现（功能完整，可设 INT3/硬件断点/读状态槽/读进程内存）
- ✅ `run-safe.ps1` — 带超时 kill 的安全 exe 启动器
- ✅ `test-stage2.ps1` — Stage 2 自动测试脚本
- ✅ **INT3 探针确认启动段完全正常**：VirtualAlloc(R15=0xc20000)、GetStdHandle(R14=0xac0) 均成功
- ✅ **定位 Access Violation 在 RVA 0x10fd**（LoadFile 内部 ReadFile 调用时 RDX=0）
- ✅ **确定输入文件存在**：input.ky（97271 bytes）被成功 CreateFileA + GetFileSize，state[0x0A]=0xd40000，state[0x0B]=0x17bf7

## 当前卡点（2026-06-29）

### ✅ 已解决

三阶段自举完整跑通，0 diff。修了三个 bug：

1. **H_76 (LDB emitter)**：把 `state_52` 当 state slot 读而非 literal offset，fixup resolver 读到垃圾地址
2. **TEXT_VS 0x4000 不够**：发射代码溢出 .text 段
3. **WriteFile 截断**：只写 `state_0E` 字节，.rdata 段没写全。WriteFile 前 SET `state_0E = peBytes.length`

### 验证

```
[1] node create-mini-kyc3.js        → projects/mini-kyc.ky
[2] node ky-compiler.js mini-kyc.ky → mini-kyc.exe           (gen 1, 87040B)
[3] mini-kyc.exe                    → output.exe (stage2)    (gen 2, 51200B)
[4] output.exe (gen 2)              → output.exe (stage3)    (gen 3, 51200B)
[5] output.exe (gen 3)              → output.exe (stage4)    (gen 4, 51200B)
```

gen 2/3/4 三者 byte-for-byte 完全一致（0 diff / 51200 bytes）。

## 待办

- [ ] 更新 bootstrap-baseline.txt 为新 SHA256（自举 0 diff 后）
- [ ] Stage 1 lock gate 在 CI 跑通
- [ ] Phase 2: 加剩余 opcode emitter（61 62 65 68 69 70-7A 80 84 20 50 51）
- [ ] emitter 一致性测试基础设施（避免再出现 H_76 那种"reference vs self" mismatches）