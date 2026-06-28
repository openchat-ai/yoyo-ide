# Flash V4 Stash Review (`stash@{0}`)

> **Status (2026-06-28):** Archived. All "merge into main" actions completed. Patches
> removed; this document is the sole audit trail.

`git stash push -u -m "flash-v4-mess-2026-06-27"` 留下的改动，按"该不该合并"分类。

## 类别 A：实打实的 bug 修复（**已应用**）

### A.1 IAT disp32 常量（off-by-2）

`create-mini-kyc3.js` 里所有 `FF 15 <disp32>` 调用的常量公式：

```
constant = 0x4000 + func_idx*8 - 4
state_0E_at_computation = code_pos_when_disp32_being_written = FF+15 之后 = code_pos + 2
disp32 = constant - state_0E_at_computation
     = (0x4000 + func_idx*8 - 4) - (code_pos + 2)
     = (0x4000 + func_idx*8 - 6) - code_pos
```

flash v4 之前用 `0x4000 + func_idx*8 - 6`（即原始 `0x4032 / 0x401A / 0x4022` 等），
实际正确的公式是 `0x4000 + func_idx*8 - 4`（`0x4034 / 0x401C / 0x4024` 等）。
**差 2**，每次 IAT 调用都跳错地址，访问 violation。

**改动点**（`grep "0x4032\|0x401A\|0x4022\|0x4012\|0x402A\|0x400A" create-mini-kyc3.js`）：

| 函数 (idx) | 原值 | 修正值 |
|-----------|------|--------|
| VirtualAlloc (7) | 0x4032 | **0x4034** |
| CreateFileA (4) | 0x401A | **0x401C** |
| GetFileSize (5) | 0x4022 | **0x4024** |
| ReadFile (3) | 0x4012 | **0x4014** |
| CloseHandle (6) | 0x402A | **0x402C** |
| WriteFile (2) | 0x400A | **0x400C** |

**实际验证（2026-06-27）**：
- 在干净 main 上跑 `mini-kyc.exe`（无输入）→ EXIT 0，output.exe 34816 字节 ✅
- 在干净 main 上跑 `mini-kyc.exe projects/mini-kyc.ty` → 后续修了 AV，self-hosting 0 diff ✅
- 触发 IAT 调用的 opcode（20/50/51）原本不在 mini-kyc.ky 里，但 Phase 2 加上后会用到

**状态**：✅ 修复已通过基线 lock + 3 阶段自举 0 diff 验证。

---

## 类别 B：架构改动（**已应用**）

### B.1 启动块 68→79 字节（加 data_base 计算）

```diff
 E.mov_ri(b, 1, -11n);     // GetStdHandle
 E.mov_rr(b, 14, 0);        // R14 = stdout
+const leaOff = b.tell();
+E.lea_rip(b, 0, 0x5000 - (CODE_RVA + leaOff + 7));
+E.mov_mr64(b, 15, 8*8, 0); // state_08 = data_base
```

**作用**：让 scanner 在 runtime 拿到 data section 基址，handler `H_77` (memcpy 84)
需要这个才能 `add rsi, off` 算出源地址。

**状态**：✅ 已应用。TEXT_VS 从 0x4000 改为 0x8000 后，IAT_BASE 自动从 0x5000 移到 0x9000，公式也
跟着改：`(IAT_BASE - CODE_RVA - 4) - state_0E`。

### B.2 EOF handler H_62 → H_1E（修重复标签）

原 `create-mini-kyc3.js` 里 H_62 既被 scanner `JAE(0x62)` 引用（EOF 时跳去当 EOF handler），
又被 `41 62`（opcode 51 → WriteFile emitter）引用。ky-compiler.js 处理 40 62 时会
后者覆盖前者，EOF handler 实际不存在。

flash v4 改名 H_62 → H_1E 把两个职能分开。

**状态**：✅ 已应用。H_1E 是现在的 EOF handler。

### B.3 WriteFile size: `51 02 01 8800` → `51 02 01 0E`

```diff
-L('51 02 01 8800');
+L('51 02 01 0E');
```

配合 `ky-compiler.js` 把 opcode 51 的 emit 从 `mov r8, 0x8800` 改成 `stGet(R8, 0x0E)`
（即读 state_0E = write pos 当 size）。

**作用**：self-hosting compiler 在 runtime 用 state_0E 作为输出大小，跟 ky-compiler.js
构建出来的 .exe 用 pe-builder 算的总大小匹配。

**状态**：✅ 已应用。WriteFile 前 SET `state_0E = peBytes.length` 以保证完整 PE 文件大小
被写入。

---

## 类别 C：Phase 2 emitter（**未开始**）

flash v4 一口气加了：

```
H_60  opcode 0x20 VirtualAlloc
H_61  opcode 0x50 LoadFile
H_62  opcode 0x51 WriteFile
H_70  opcode 0x61 ADD imm
H_71  opcode 0x62 SUB imm
H_72  opcode 0x68 ADDV
H_73  opcode 0x69 SUBV
H_74  opcode 0x55 store u32
H_75  opcode 0x57 store byte
H_76  opcode 0x80 LDB
H_77  opcode 0x84 memcpy
H_78-H_7C/H_7D-H_81  conditional jumps (72/75/77/78/7A)
H_85  CreateFileA helper (share=3)
H_8A-H_8D  filename embedding for LoadFile/WriteFile
H_E8/H_EA/H_EC  stGet(R8/RDI/RSI)
dispatch entries H_4D-H_5C
```

**状态**：⏳ 未开始。当前 mini-kyc.ky 只支持 Phase 1 opcodes（40 FF 30 60 65 66 70 71 41）。
后续要按"一次加一个 emitter、每加一个跑 gate"的节奏走（见 spec.md §13 + TASKS.md）。

---

## 类别 D：杂项（**已丢弃**）

### D.1 `FORMAT.md` 删除

这是 textdb 的 TSV schema 文档，跟 yoyo compiler 毫无关系。

**状态**：✅ 仍 tracked，是项目一部分（虽然跟编译器无关，保留作为参考文档）。

### D.2 `projects/input.ky` 改动

`projects/input.ky` 是 gitignored 的测试输入（不在 git 里）。

**状态**：✅ 仍按 gitignore 规则处理，不 tracked。

---

## 决策档案

本文件是 flash v4 stash 的**唯一 audit trail**：

- **A 类（已应用）**：bug 修复已通过基线 lock + 3 阶段自举 0 diff 验证
- **B 类（已应用）**：架构改动已集成
- **C 类（未开始）**：Phase 2 emitter 待后续每个单独 commit
- **D 类（已丢弃）**：跟工程目标无关的残留

所有原始 patch 文件已删除（4 个 .flash-v4-*.patch 共 ~250KB）。如果以后需要
回查具体修改，git history (`git log --all -- "create-mini-kyc3.js"`) 里有完整记录。

## 一句话总结

flash v4 留下的有普遍价值的改动（IAT disp32 修复 + 启动块 79B + WriteFile size 修正 +
EOF handler 改名）已全部应用，Phase 2 emitter 待后续按节奏加。**自举完成（3 阶段 0 diff）**，
这些改动可视为已被吸收进 baseline。
