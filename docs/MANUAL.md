# yoyo 语言手册

> **版本**：Phase 1（9 个 opcode）
> **目标读者**：编译器研究者、自托管技术爱好者、极简语言设计者

---

## 0. 关于本手册

yoyo 是一门用于编写自托管编译器的小型指令式语言。它把 16,384 个 64 位寄存器当作
"状态数组"，所有操作都围绕这张表展开。

本手册面向已有编译器或汇编经验的读者。如果你只想知道怎么跑通 yoyo，看 §2；
想理解设计动机，看 §1 和 §7；想写自己的 yoyo 程序，从 §3 顺序读下去。

---

## 1. 简介

yoyo 的设计目标只有一个：**用尽可能小的语言子集，描述一个能编译自己的编译器**。

它的语言子集只有 9 个 opcode，刚好够写一个能编译自己的编译器。

结果是一个 2000 行左右的 `.ty` 源文件，可以编译出完整的 x86_64 PE32+ 可执行文件，
没有运行时依赖（没有 CRT、没有 Node.js、没有垃圾回收）。

**yoyo 不是通用编程语言**。它没有字符串、没有文件 I/O、没有浮点——这些是 Phase 2 的
事。它能做的事情，是把"字节流→汇编发射"这个流程写成可审计、可调试的代码。

---

## 2. 快速开始

### 2.1 构建编译器

从源码构建自托管的 yoyo 编译器：

```bash
node src/yoyo-gen.js          # 由 JS 生成器写出 projects/yoyo.ty
node src/yoyo.js projects/yoyo.ty build/yoyo.exe
```

`build/yoyo.exe` 就是自托管编译器本体。生成它需要 0.6 秒（Intel i5），产物约 87 KB。

### 2.2 编译并运行一个 yoyo 程序

```bash
node src/yoyo.js projects/test_minimal.ty build/test.exe
./build/test.exe              # 立即退出，退出码 0
```

或者直接用自托管编译器（行为完全一致）：

```bash
build/yoyo.exe projects/test_minimal.ty build/test.exe
```

### 2.3 验证自托管正确性

`make bootstrap-check` 会做三件事：
1. 两次生成 `yoyo.ty`，确认生成器是确定性的
2. 两次编译 `yoyo.ty`，确认编译输出字节级一致
3. 对比 SHA256 与 `bootstrap-baseline.txt` 里的锁

`make bootstrap-lock` 在严格模式上加上基线对比，CI 上跑这个。

---

## 3. 文件格式与词法

### 3.1 文件后缀

| 类型         | 后缀     | 说明                          |
|--------------|----------|-------------------------------|
| 源文件       | `.ty`    | 一行一条 yoyo 指令            |
| 编译产物     | `.exe`   | PE32+ Windows x64 可执行文件  |

### 3.2 词法规则

`.ty` 文件是 ASCII 纯文本。每行一条指令，由**空白分隔的十六进制 token** 组成。
注释以 `;` 开头直到行尾。空行允许。

```
; 这是注释
40 23                ; opcode 0x40（handler 起始），参数 0x23
30 50 00             ; opcode 0x30（SET state_50 = 0）
FF                   ; opcode 0xFF（RET）
```

- token 是 1 或 2 个十六进制字符（`0`–`FF`）
- 空白可以是空格、tab、换行
- 大小写不敏感：`0xFF` 和 `0xff` 等价
- 注释必须以 `;` 开头，独立成 token

### 3.3 数值范围

所有数值都是 8 位无符号（0–255）。状态槽是 64 位，但 SET 指令的参数仍是 8 位；
要加载 64 位常量，Phase 1 没有直接支持（编译器内部用 `movabs` 展开，详见 §7）。

---

## 4. 核心模型

### 4.1 状态数组

yoyo 程序的全部数据来自一张平坦的 **状态数组**——16,384 个 64 位槽，索引 0–16383。
通过 `state[N]` 访问。

**和其他语言的对应关系：**

| 概念        | C               | Python        | yoyo             |
|-------------|-----------------|---------------|------------------|
| 命名变量    | `int x`         | `x = 0`       | `state[50]`      |
| 写值        | `x = 42`        | `x = 42`      | `30 50 2A`       |
| 读值        | `y = x`         | `y = x`       | `60 51 50`       |
| 数组元素    | `a[i]`          | `a[i]`        | `state[i]`       |
| 指针        | `int *p`        | —             | ❌ 不存在         |
| 局部变量    | 函数内 `int x`  | 函数内 `x`    | ❌ 不存在         |
| 栈          | 调用栈          | 调用栈        | ❌ 不存在         |
| 堆          | `malloc`        | 自动          | ❌ 不存在         |

**和 C 数组的关键区别**：

- yoyo 的 `state[N]` 中 `N` 是**编译期立即数**，不是运行时表达式。要做"按索引查表"，
  你得自己写循环 + `INC` + `CMP`，没有 `state[rdi]` 这种用法。
- **没有别名问题**：两个不同的 slot 永远指向不同的存储，没有 `&state[N]` 取址。
- **没有局部性**：所有 state 在整个程序里都可见，没有"作用域"概念。

**运行时约定**：
- `R15` 寄存器保存数组基址
- 读写路径：`[R15 + N*8]`
- 启动时数组全零

没有栈、没有堆、没有结构体。整门语言就是这张表 + 一组操作它的指令。

### 4.2 Handler

**Handler** 是 yoyo 的基本代码单元——一段以 `40 hh` 开头、`FF` 结束的指令序列。
`hh` 是 8 位编号（0–255），可看作函数名。

```
40 30                  ; H_30: 入口
30 50 42               ; state_50 = 0x42
60 0A 50               ; state_0A = state_50
FF                     ; 返回
```

调用 handler 用 `41 hh`（CALL），跳过去用 `70 hh`（JMP），从 handler 返回用 `FF`（RET）。
这三种跳转都是相对偏移——handler 可以在文件里随意排序，编译器在发射阶段会算出
正确的相对地址。

**前向引用是允许的**：在 `40 30` 之前写 `41 30`，编译器会记录 fixup，等 `40 30` 发射后
再回填偏移。

### 4.3 启动约定

一个 yoyo 程序是若干 handler 的集合。入口约定由调用者决定——通常主机编译器会
调用 `H_01`（`41 01`）。

`yoyo.ty` 的入口是 `H_01`（主扫描循环）。前 10 行长这样：

```
41 01            ; 调用 H_01（主扫描）
FF               ; 主流程返回
```

---

## 5. Opcode 参考

Phase 1 共 9 个 opcode + Phase 1.5 新增 2 个 jcc（`0x82` jl、`0x83` jg）：

| Opcode | 参数              | 含义                                    |
|--------|-------------------|-----------------------------------------|
| `30`   | `slot, val`       | SET：`state[slot] = val`                |
| `60`   | `dst, src`        | GET：`state[dst] = state[src]`          |
| `65`   | `a, b`            | CMP：比较 `state[a]` 和 `state[b]`      |
| `66`   | `slot`            | INC：`state[slot]++`                    |
| `70`   | `hh`              | JMP：跳到 handler `hh`                  |
| `71`   | `hh`              | JE：`state[a] == state[b]` 时跳         |
| `82`   | `hh`              | JL：signed `state[a] < state[b]` 时跳   |
| `83`   | `hh`              | JG：signed `state[a] > state[b]` 时跳   |
| `40`   | `hh`              | HANDLER：声明 handler `hh`              |
| `41`   | `hh`              | CALL：调用 handler `hh`                 |
| `FF`   | —                 | RET：从当前 handler 返回                |

> `71`/`82`/`83` 的两个 state 槽（`a` 和 `b`）由最近的 `65` 指令决定——`CMP` 设置标志位，
> jcc 读标志位。中间可以插入任意不修改标志位的指令。
>
> **关于 0x73-0x79 的 jcc 编号**：jcc32 表里 0x73-0x7A 物理存在（x86 有 10 个条件码），
> 但 yoyo.ty 内部已把这 7 个编号分配给 SUB/MUL/mem-write/ldb/memcpy 等指令。
> 所以**新增 jcc 用 0x82/0x83 占位**。Phase 2 会重新统一编号。

### 5.1 编码体积参考

每条 yoyo 指令被翻译成 1–193 字节的 x86_64 机器码：

| 指令       | x64 体积      | 用途                   |
|------------|---------------|------------------------|
| `FF`       | 1 B           | RET                    |
| `71`/`82`/`83` | 6 B       | 条件跳转（JE/JL/JG）  |
| `70`       | 5 B           | 无条件跳转             |
| `41`       | 5 B           | CALL                   |
| `30`       | 13–17 B       | SET（含 `movabs`）     |
| `60`       | 6–14 B        | GET                    |
| `65`       | 9–17 B        | CMP                    |
| `66`       | 12–18 B       | INC                    |

---

## 6. 编程模式

### 6.1 局部变量

没有栈。用一个或几个 state 槽当局部变量：

```
30 50 42               ; state_50 = 0x42   （局部变量初始化）
65 50 51               ; cmp state_50, state_51
71 60                  ; 如果相等就跳走
66 50                  ; state_50++
```

### 6.2 循环

用 `INC` + `CMP` + `JE` 写显式循环。下面把 `state_00` 从 0 加到 9：

```
40 23                  ; H_23: 初始化
30 50 00               ; state_50 = 0
30 51 0A               ; state_51 = 10
FF

40 24                  ; H_24: 循环体
66 50                  ; state_50++
65 50 51               ; cmp state_50, state_51
71 25                  ; je H_25（到 10 就退出）
70 24                  ; 否则继续
FF

40 25                  ; H_25: 结束
FF
```

### 6.3 函数调用（带返回值）

没有 caller-saved / callee-saved 约定。约定一个 state 槽做返回值即可：

```
40 30                  ; H_30: 被调函数
60 0A 50               ; state_0A = state_50   （返回值放 state_0A）
FF

40 31                  ; H_31: 调用方
41 30                  ; 调用 H_30
; 此时 state_0A 是返回值
FF
```

### 6.4 前向引用

`41 hh` 可以出现在 `40 hh` 之前。编译器记录 fixup，发射到 `40 hh` 时回填。

```
41 30                  ; 前向调用 H_30
FF

40 30                  ; H_30 在下面定义
30 50 00
FF
```

---

## 7. 编译器工作原理

yoyo 编译器是**两遍扫描**的简单汇编器：

**第一遍：词法分析。** 读 `.ty`，按行 tokenize 成 `(opcode, args[])` 列表。

**第二遍：发射。** 遍历指令列表。对每个 opcode，调用对应的 emitter handler
（`H_33` 处理 SET、`H_43` 处理 CALL 等）。每个 handler 把 x86_64 机器码
emit 到代码缓冲区。

**前向引用的 fixup：** 当 emitter 遇到一个目标 handler 还没发射的 `41 hh` 时，
它先在缓冲区写一条占位 `CALL rel32`（`rel32 = 0`），同时把
`(hh, position_of_disp32)` 记入 fixup 列表。全部发射完成后，fixup 解析器
遍历这张表，把每个 `disp32` 改成正确的相对偏移。

**输出：** PE32+ 可执行文件，通过 IAT 调用 8 个 Windows API：
`ExitProcess`、`GetStdHandle`、`WriteFile`、`ReadFile`、`CreateFileA`、
`GetFileSize`、`CloseHandle`、`VirtualAlloc`。没有 CRT、没有依赖。

这种结构极小、极透明——整个编译器 2000 行 `.ty`，全部 9 个 opcode 自己实现，
连 fixup 解析器都是 yoyo 代码。

---

## 8. 工具链

| 工具                       | 作用                                              |
|----------------------------|---------------------------------------------------|
| `src/yoyo-gen.js`          | 由 JS 生成 `projects/yoyo.ty` 源码                 |
| `src/yoyo.js`              | 把 `.ty` 编译成 `.exe`（Node.js 主机实现）         |
| `build/yoyo.exe`           | 同上，自托管版本（行为完全一致）                   |
| `src/encode-x64.js`        | x86_64 指令编码库（被 `src/yoyo.js` 使用）        |
| `src/pe-builder.js`        | PE 文件构建器（被 `src/yoyo.js` 使用）            |
| `tools/debug.js`           | Windows Debug API 调试器（基于 koffi）            |
| `scripts/bootstrap-check.*`| 一致性 + 基线门禁                                 |

常用命令：

```bash
# 完整 bootstrap 验证
make bootstrap-check

# 严格模式 + 基线对比（CI 用）
make bootstrap-lock

# 调试编译产物的崩溃
node tools/debug.js output.exe
```

---

## 9. 限制与路线图

### 9.1 Phase 1 不支持的特性

| 特性                | 状态                       |
|---------------------|----------------------------|
| 字符串              | Phase 2（opcode `12`）     |
| 文件 I/O            | Phase 2（opcode `50`/`51`）|
| 位运算              | Phase 2                    |
| 其他条件跳转        | Phase 2（`72`-`7A`）       |
| 浮点                | 不计划                     |
| 结构体 / 对象       | 不适用                     |
| 闭包 / lambda       | 不适用                     |

### 9.2 路线图

- **Phase 2**：补齐剩余 ~25 个 opcode，重点是字符串、文件 I/O、位操作
- **Phase 3**：让 `yoyo.exe` 编译 `yoyo.exe` 的输出与自身 SHA256 相同（三阶段自举）
- **Phase 4**：从 Node.js 完全退役，只用 yoyo 工具链

---

## 10. 进一步阅读

- **`projects/yoyo.ty`** — 2000 行的真实 yoyo 程序。读它就是最快的入门。
- **`docs/spec.md`** — 技术参考。§0（动机）、§5（opcode 编码）、§6（fixup）值得细读。
- **`src/encode-x64.js`** — 看 yoyo 怎么把每条 opcode 翻译成 x86_64 机器码。
- **`src/pe-builder.js`** — 134 行实现 PE32+ 头。
- **`docs/FLASH-V4-REVIEW.md`** — 一段历史：fixup 解析器从崩溃到修通的全过程。

修改任何编译器源码后，**永远跑 `make bootstrap-lock`**——这是最后一道保险。

---

*手册版本 1.0 · 对应 yoyo Phase 1（9 个 opcode）*
