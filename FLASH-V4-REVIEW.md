# Flash V4 Stash Review (`stash@{0}`)

`git stash push -u -m "flash-v4-mess-2026-06-27"` 留下的改动，按"该不该合并"分类。

## Patch 文件

| 文件 | 用途 |
|------|------|
| `.flash-v4-create-mini-kyc3.patch` | 728 行 generator 改动（原始出处） |
| `.flash-v4-ky-compiler.patch` | 1 行 opcode 51 size 改动 |
| `.flash-v4-mini-kyc-ky.patch` | 1175 行 regenerator 的产物 |
| `.flash-v4-input-ky.patch` | input.ky 测试残留（应丢弃） |

应用某个 patch: `git apply .flash-v4-<name>.patch`
丢弃某个 patch: `rm .flash-v4-<name>.patch`

---

## 类别 A：实打实的 bug 修复（**建议保留**）

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
- 在干净 main 上跑 `mini-kyc.exe projects/mini-kyc.ky` → EXIT 0xC0000005 ❌
- 但是 806 行的 mini-kyc.ky 没用任何会触发 IAT 调用的 opcode（无 20/50/51）
- 所以这个 crash **不是** IAT 引起的，是别的 bug

**结论**：公式推导在数学上对（推导见上），但**当前 main 上的 Stage 2 crash 跟 IAT 无关**。
flash v4 的修复是个真 bug 没错，但触发它的 opcode（20/50/51）现在还没在 mini-kyc.ky
里出现，所以修了也暂时测不出来。

**建议**：先在干净 main 上 debug 当前的 Stage 2 crash（看上去是 Phase 1 emitter bug，
不是 IAT）。Stage 2 通了之后再应用 IAT 修复 + 加 Phase 2 emitter。

---

## 类别 B：架构改动（**Phase 2 才需要**）

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

**Stage 1 闭环不需要**——806 行的 mini-kyc.ky 没有用到 84 opcode，handler 表里也没有
依赖 state_08 的代码。

**结论**：Stage 2 没通过前不要合。

### B.2 EOF handler H_62 → H_1E（修重复标签）

原 `create-mini-kyc3.js` 里 H_62 既被 scanner `JAE(0x62)` 引用（EOF 时跳去当 EOF handler），
又被 `41 62`（opcode 51 → WriteFile emitter）引用。ky-compiler.js 处理 40 62 时会
后者覆盖前者，EOF handler 实际不存在。

flash v4 改名 H_62 → H_1E 把两个职能分开。

**问题**：原版这个 bug 对 Stage 1 没影响（806 行 mini-kyc.ky 没有 opcode 51，
EOF 跳到 H_62 直接 RET 也是合理的——只是没跑 fixup resolver）。

**结论**：Stage 2 之前没意义。

### B.3 WriteFile size: `51 02 01 8800` → `51 02 01 0E`

```diff
-L('51 02 01 8800');
+L('51 02 01 0E');
```

配合 `ky-compiler.js` 把 opcode 51 的 emit 从 `mov r8, 0x8800` 改成 `stGet(R8, 0x0E)`
（即读 state_0E = write pos 当 size）。

**作用**：self-hosting compiler 在 runtime 用 state_0E 作为输出大小，跟 ky-compiler.js
构建出来的 .exe 用 pe-builder 算的总大小匹配。

**Stage 1 闭环不需要**：806 行 mini-kyc.ky 编译产物就是 PE 模板 + 启动块 + handlers，
handler code 是写进 .text section 的 0x4000 范围内，不会超过 0x8800 字节，写死 8800
反而是 OK 的（如果产物恰好 < 8800）。

**关键不确定**：**ky-compiler.js 实际产出的 mini-kyc.exe 字节数**——806 行 mini-kyc.ky
编译出来是 83968 字节（< 8800? 8800 = 34816，对不上！83968 > 34816）。
说明模板拷贝 `84 02 4000 8800` 截短了模板（实际模板大小约 0x14400 = 82944 字节），
需要重新算。

**结论**：必须先 Stage 2 看到底写多少字节、模板多大，才能判断这改动对不对。

---

## 类别 C：Phase 2 emitter（**过早，不动**）

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

**Stage 2 没闭环前全部是噪音**——加再多 emitter，self-hosting 都还没跑通。

**正确做法**：先 Stage 2 跑通，再**一次加一个** emitter，每个跑一次 gate：

```
加 H_60 VirtualAlloc
  → node create-mini-kyc3.js
  → node ky-compiler.js projects/mini-kyc.ky mini-kyc.exe
  → sha256 mini-kyc.ky → 应该没变（只动了 generator）
  → sha256 mini-kyc.exe → 应该变了（新 emitter 被编进去了）
  → 如果 SHA256 完全没漂：检查 806 行 mini-kyc.ky 用没用 0x20，没有则 baseline 不该变
  → 如果用了 0x20 但 baseline 没变：说明 generator 实际没改输出，检查原因
  → 如果 baseline 变了：评估变化是否符合预期，是新 opcode 进去了还是 bug
```

按这种节奏加，每个 emitter 单独 commit，方便 bisect 出 bug。

---

## 类别 D：杂项（**应该丢弃**）

### D.1 `FORMAT.md` 删除

这是 textdb 的 TSV schema 文档，跟 yoyo compiler 毫无关系。

不知道为什么 staging 进去了——大概是 stash 时 `git add -A` 把无关文件捞进来了。

**结论**：直接丢弃。

### D.2 `projects/input.ky` 改动

`projects/input.ky` 应该是被意外提交的测试残留，不应该 tracked。

**结论**：丢弃。

---

## 建议处理顺序

1. **先丢弃类别 D**（FORMAT.md, input.ky）—— 跟工程目标无关。
2. **再决定类别 A**（IAT disp 修复）：
   - 在干净 main 上跑一次 `mini-kyc.exe`，记录 exit code
   - 如果是 0xC0000005 且 git history 显示 IAT 常量错，合 patch
   - 如果原版 exit 0，说明我对公式的推算错了，重新核对
3. **类别 B 全部不动**，等 Stage 2 验证
4. **类别 C 全部不动**，按"一次加一个 emitter"的节奏走
5. **最终目标**：stash `flash-v4-mess-2026-06-27` 整体 `git stash drop`，但保留这 4 个
   patch 文件 + 本 REVIEW.md 在 repo 里作为决策档案

---

## 一句话总结

flash v4 留下的**唯一有普遍价值的改动是 IAT disp32 修复**（类别 A.1），其余要么过早
（Phase 2 emitter），要么属于还没验证的架构改动，要么是无关残留。在 Stage 2 闭环之前
任何"合并 stash"的动作都是赌博。

## 当前 main 上的实际 bug（不是 flash v4 引入的）

```
$ mini-kyc.exe                    # 空输入
EXIT=0
output.exe = 34816 bytes          # 仅模板

$ mini-kyc.exe projects/mini-kyc.ky  # 806 行 mini-kyc.ky
EXIT=-1073741819 (0xC0000005)     # crash

$ mini-kyc.exe input.ky  # 6 行 Phase 1 ops (40 66 65 71 70 FF)
EXIT=-1073741819
output.exe = 34816 bytes          # WriteFile 跑了但还是 crash
```

**症状**：哪怕 mini-kyc.exe 自己能跑、能写 output.exe，**写完文件后 mini-kyc.exe 自己
crash**。ExitProcess 调用之前的某个 cleanup 代码段有问题，或者 ExitProcess 本身没被
正确发射到 mini-kyc.exe 自己的 .text section 末尾。

`mini-kyc.ky` 没用 opcode 51（write），所以 output.exe 应该是模板+启动块 + handlers。
`input.ky` 也没有 opcode 51。所以 output.exe = 34816 字节（仅模板）。

**这是 Phase 1 emitter 的 bug，跟 flash v4 无关**——是 copilot 在 39ee3b3 加 H_30 时
引入的（commit message 说"Phase 1 验证"实际上根本没验证过）。

下一步 debug 方向：
1. 用 hex diff 比对 ky-compiler.js 产出的 ref.exe 和当前 main 产出的 mini-kyc.exe
2. 看 ExitProcess 的 emit 是否在 ref 里、在 main 里位置对不对
3. 看 handlers 列表，H_00-H_FF 哪些存在、哪些缺失