# yoyo 语言手册

> **状态**：Phase 1（早期采用阶段）。支持 9 个 opcode：`40 FF 30 60 65 66 70 71 41`。
> 自托管编译器（`mini-kyc.exe`）就是用这个子集构建的。Phase 2 计划再加 ~25 个
> opcode（文件 I/O、位操作、条件跳转等）。

读这本手册，你会学到：
- 读懂一个 `.ty` 源文件
- 理解状态机
- 手工写一个简单程序
- 编译并运行它

## 1. Hello, world

yoyo 语言本身没有"打印字符串"——唯一的输出机制是写文件（opcode `51`）。所以
"hello world" 就是写一个含 `"Hello, world!\n"` 的文件。

但说实话，yoyo 程序的典范就是 yoyo 编译器自己。看 `projects/mini-kyc.ty`——
那是一个 2000 行的 `.ty` 程序，编译别的 `.ty` 程序。

## 2. 文件后缀和工具链

| 概念 | 值 |
|------|-----|
| 源文件后缀 | `.ty`（之前是 `.ky`，是 legacy） |
| 编译器 | `mini-kyc.exe`（自托管）或 `ky-compiler.js`（Node.js 主机） |
| 输出 | Windows x64 `.exe`（无 DLL/CRT/Node 依赖） |

**从源码构建编译器：**

```bash
node create-mini-kyc3.js          # 生成 projects/mini-kyc.ty
node ky-compiler.js projects/mini-kyc.ty mini-kyc.exe
```

**编译一个程序：**

```bash
mini-kyc.exe <input.ty> <output.exe>
```

（注意：截至 2026-06-28，`mini-kyc.exe` 还硬编码读 `input.ky` 写 `output.exe`。上面
的 CLI 形式是计划中的。详见 spec §14 的 Phase 2 TODO。）

## 3. 词法

`.ty` 文件是纯 ASCII 文本。一行一条指令。token 是空格分隔的十六进制数（0-9、a-f、A-F）。
注释以 `;` 开头到行尾。空行和只有 `;` 的行允许。

```
; 这是注释
40 23            ; opcode 0x40（handler 起始），参数 = 0x23
30 50 00         ; opcode 0x30（SET state_50 = 0）
FF               ; opcode 0xFF（RET）
```

规则：
- 一行一条指令（技术上：opcode + 参数，然后换行）
- 十六进制 token 1 或 2 个字符（`0` 到 `FF`）
- 空白分隔符：空格、tab、换行
- 注释：`;` 到行尾
- 大小写不敏感：`0xFF` 和 `0xff` 一样

## 4. 核心概念

### 4.1 状态槽（state slots）

yoyo 程序操作一个扁平的 16384 个 u64 槽（"状态数组"）。槽地址是 0–16383，
通过 `state[N]` 访问（N 是槽号）。

运行时，R15 保存状态数组的基址。所有 state 读写都走 `[r15 + N*8]`。

### 4.2 Opcode（Phase 1）

| Opcode | 参数 | 含义 |
|--------|------|------|
| `30` | `slot, val` | SET：`state[slot] = val` |
| `60` | `dst, src` | GET：`state[dst] = state[src]` |
| `65` | `a, b` | CMP：`cmp state[a], state[b]`（设标志位） |
| `66` | `slot` | INC：`state[slot]++` |
| `70` | `hh` | JMP：无条件跳到 handler `hh`（相对） |
| `71` | `hh` | JE：相等时跳（`state[a] == state[b]` 时） |
| `40` | `hh` | HANDLER 起始：定义 handler `hh` |
| `41` | `hh` | CALL：调用 handler `hh`（前向引用 → fixup） |
| `FF` | （无） | RET：从当前 handler 返回 |

参数 1–3 总是存在。无参 opcode（`FF`）后面没有 token。

### 4.3 Handlers

Handler 是命名代码块，用 8 位数字标识（0–255）。用 `40 hh` 声明，以 `FF` 结束。
Handler 就像其他语言的函数，但存储为扁平数组——编译器维护一个
`handler_table[hh]` 表，把 handler 编号映射到该 handler 代码在输出 `.text` 段中的
字节偏移。

Handler 可以**前向引用**：在 `40 30` 定义之前写 `41 30`（CALL handler 0x30）没问题。
编译器记录一个 fixup，等 `40 30` 发射后，再把调用的相对偏移打上补丁。

### 4.4 启动时的状态

yoyo 程序启动时，状态数组被分配（128KB，全零）。没有 I/O 函数设好——主机编译器
（或程序自己的启动代码）负责在跑用户代码前设置好 stdin/stdout。

对自托管的 yoyo 程序（被 `mini-kyc.exe` 编译出来的）：
- `R15` = 状态数组基址
- `R14` = stdout 句柄
- `state_02` = 输出缓冲区（用于写文件）
- `state_03` = write base（输出缓冲区 + 0x400，即 `.text` 起始）
- `state_0E` = code offset（下一个字节写在哪）

## 5. 你的第一个程序

写一个把 `"Hi\n"` 写到 `out.txt` 的程序。

等等——**yoyo 在 Phase 1 没有字符串支持**。字符串是 Phase 2 特性（opcode `12`）。
所以你没法轻松打印文本。

最简单的有意义的程序就是**返回 0**：

```
; a.ty — 空程序，以 0 退出
FF
```

就这样。`FF` 是 RET。前面没有 handler，程序立即返回。ExitProcess 在最后被调用。

稍微有趣一点的程序——往文件写一个字节——需要 Phase 2 opcode。目前 yoyo 的
正经用途是写编译器，就像 `mini-kyc.ty` 那样。

## 6. mini-kyc.ty 的模式

`mini-tyc.ty` 用一种特定的模式：handler `01` 是主扫描循环，状态机驱动分派，
handler `63-65` 是 fixup 解析器。研究它是学 yoyo 惯用法最快的方式。

### 6.1 启动块

每个 yoyo 程序都以一些设置开始。这是 `mini-tyc.ty` 顶层代码的简化版：

```
; 分配输出缓冲区
20 02 00040000   ; （仅 Phase 2 —— Phase 1 硬编码大小）

; 状态初始化
30 0e 00         ; code_offset = 0

; 跑主扫描循环
41 01            ; 调用 H_01（主扫描）

; 写输出
51 02 01 0E      ; （仅 Phase 2）

; 退出
FF
```

### 6.2 计数器循环

下面这个程序把 `state_00` 一直加到等于 10：

```
40 23              ; H_23: 计数器循环入口
30 50 00           ; state_50 = 0
30 51 0A           ; state_51 = 10
40 24
30 00 00           ; state_00 = 0
FF

40 25              ; H_25: 加并检查
66 00              ; state_00++
65 00 51           ; cmp state_00, state_51
71 26              ; je H_26（完成）
70 25              ; jmp H_25（循环）
FF

40 26              ; H_26: 完成
FF
```

注意：它在循环，但没产生任何输出。要看到它，需要调试工具。yoyo 没有内建 print。

## 7. 主机编译器的工作方式

yoyo 编译器（`mini-kyc.exe` 和它的兄弟 `ky-compiler.js`）是两次扫描的编译器：

**第一遍：扫描。** 读 `.ty` 文件，tokenize 成 opcodes + 参数，建立所有指令的列表。

**第二遍：发射。** 遍历指令列表。对每个 opcode，调用对应的 emitter handler
（比如 `H_33` 处理 SET，`H_43` 处理前向 CALL）。每个 handler 把 x86_64 机器码发射到
代码缓冲区。

**前向引用：** 当一个 CALL 指向还没发射的 handler 时，emitter 记录
`{target_handler, position_of_disp32}` 到 fixup 数组。扫描完成后，fixup 解析器
遍历这个数组，把每个 `disp32` 补上正确的相对偏移。

输出是一个 PE32+ 可执行文件，通过 IAT 用 8 个 Windows API 函数：
`ExitProcess`、`GetStdHandle`、`WriteFile`、`ReadFile`、`CreateFileA`、
`GetFileSize`、`CloseHandle`、`VirtualAlloc`。

## 8. 工具

- **编译 `.ty` 到 `.exe**：`node ky-compiler.js input.ty output.exe`
- **运行编译好的程序**：直接执行 `.exe`（比如 `output.exe`）
- **调试运行中的程序**：用 `debug.js`（Windows Debug API via koffi）

## 9. 常用模式

### 9.1 局部变量

yoyo 没有栈。用一个 state 槽：

```
30 50 42        ; state_50 = 0x42   ; 局部变量初始化
65 50 51        ; cmp state_50, state_51
71 ...          ; 用它
```

### 9.2 函数调用（带返回值）

没有 caller-saved/callee-saved 约定。约定哪个 state 槽放返回值就行：

```
40 30
60 0A 50        ; state_0A = state_50  ; 返回值放 state_0A
FF

40 31
41 30          ; 调用 H_30
; state_0A 现在是返回值
FF
```

### 9.3 加载常量

唯一的"加载常量" opcode 是 `30`（SET 64-bit）。实际加载由运行时的
`movabs rax, imm64` 指令完成。

## 10. 常见陷阱

1. **前向引用**没问题，编译器用 fixup 处理。
2. **Handler 编号 0 是特殊的**——它经常是入口或空操作。
3. **状态数组是 0 索引的**。`state_0` 是第一个槽。
4. **没有字符串、浮点、结构体**——就是 64 位整数的扁平数组。
5. **指令行内不能有注释**——注释必须以 `;` 开头。

## 11. Phase 1 没有的

下面这些是常见语言特性，yoyo Phase 1 没有：

| 特性 | 状态 |
|------|------|
| 字符串（`12` opcode） | Phase 2 |
| 文件 I/O（`50`/`51` opcode） | Phase 2 |
| 计数循环（`68`/`69`/等） | Phase 2 |
| 其他条件跳转（`72-7A`） | Phase 2（部分实现，但被门控） |
| 位操作 | Phase 2 |
| 浮点 | 不计划（PE 用 int64 state） |
| 结构体 / 对象 | 不适用（扁平状态数组） |
| 递归函数 | 可以，但调用深度受栈限制 |
| 闭包 / lambda | 不适用 |

## 12. 下一步

- **读 `projects/mini-tyc.ty`**——一个真实的、能跑的 yoyo 程序（编译器自己）。
  这是最好的参考。
- **读 `spec.md`**——技术参考。§0、§5、§6 对学习最有用。
- **读 `encode-x64.js`**——yoyo 编译器怎么发射 x86_64 机器码。
- **改编译器的代码**——试试在 `encode-x64.js` 里改一个 opcode 的编码，看
  会发生什么。

欢迎来到 yoyo。慢慢来，多读别人的代码，改动后**永远跑 bootstrap gate**
（`make bootstrap-lock`）。
