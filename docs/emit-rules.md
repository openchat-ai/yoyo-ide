# yoyo emit 规则表

> **目的**：把所有 yoyo opcode → x86 字节的映射集中到一个文件。
>
> 调试 yoyo 编译器时，**不再需要反复读 src/yoyo-gen.js / encode-x64.js / linux-self-emit.js**——查这张表就行。
>
> 来源：
> - `src/encode-x64.js`（x86 指令编码）
> - `src/yoyo-gen.js`（yoyo 编译器源代码生成）
> - `src/backends/linux-emit-core.js`、`win-emit-core.js`（运行时 emit）

## 0. 运行时约定（apply to all opcodes）

### State array

```
state[0x00..0xFFFF]  ← 64 位无符号整数数组
                       每个 slot 占 8 字节
                       运行时基址存在 R15 寄存器
                       state[slot] = [r15 + slot*8]
```

### 关键寄存器（启动 blob 设置）

| Register | Meaning | Set by |
|----------|---------|--------|
| `R15` | state array base | startup `VirtualAlloc` → R15 |
| `R14` | stdout handle | startup `GetStdHandle` → R14 |
| `R12` | last file size | LoadFile handler |
| `R13` | last file handle | LoadFile handler |
| `RCX, RDX, RSI, RDI, R8, R9` | scratch | any handler |

### Startup blob（每个 .exe 的开头）

68 bytes (Windows) / N bytes (Linux)，包含：

1. `VirtualAlloc(0, 0x20000, MEM_COMMIT|MEM_RESERVE, PAGE_EXECUTE_READWRITE)` → R15
2. 把 data section base 存到 `state[8]`（R15+0x40）
3. `GetStdHandle(STD_OUTPUT_HANDLE=-11)` → R14
4. `jmp H_00`（第一条 handler）

### IAT 调用约定

x64 Windows PE 通过 `[rip + disp32]` 间接调用 kernel32 导出函数：

```
FF 15 XX XX XX XX    call [rip + disp32]   ; disp32 = IAT[fn] - (CODE_RVA + current + 6)
```

disp32 是相对位移，**在生成时计算**（IAT 地址已知）。

Linux 通过 `syscall`：

```
48 C7 C0 XX 00 00 00    mov rax, syscall_nr
48 89 XX XX XX XX XX    mov reg, arg1
... (其他参数)
0F 05                  syscall
```

---

## 1. 整数寄存器操作

### `0x30 SET imm` — state[slot] = imm64

**yoyo 源码**：`30 ss vv vv vv vv vv vv vv` (10 字节)
**emit (x86)**：

```asm
48 B8 vv vv vv vv vv vv vv vv    mov rax, imm64
49 89 87 80 02 00 00             mov [r15 + slot*8], rax
```

**字节总数**：10 + 4 = 14
**yoyo 文件大小**：10

> **注意**：`49` 是 REX.WB（64 位操作数 + R15 base）。
> `slot*8` 是字节偏移，slot 0x00→0x00, slot 0x50→0x280, slot 0x45→0x228 等。

### `0x60 GET` — state[dst] = state[src]

**emit**：

```asm
48 8B 87 80 02 00 00       mov rax, [r15 + src*8]   ; load state[src]
49 89 87 80 02 00 00       mov [r15 + dst*8], rax  ; store state[dst]
```

**字节总数**：7 + 4 = 11

### `0x61 ADD imm` — state[slot] += imm

**emit**（imm 范围不同用不同指令）：

```asm
; imm ∈ [-128, 127]
48 83 87 80 02 00 00 XX       add qword [r15 + slot*8], imm8

; imm 超出 8 位
48 81 87 80 02 00 00 XX XX XX XX  add qword [r15 + slot*8], imm32
```

> **雷区**：`83` 用 imm8（带符号扩展），`81` 用 imm32。
> 如果 imm 是 `-1`，必须用 `81` + 4 字节全 FFFFFFFF，**不能**用 `83` + 单字节 FF（这是 -1 但行为不同！）。

### `0x62 SUB imm` — state[slot] -= imm

**emit**：和 ADD 类似，用 `83/5` 或 `81/5`：

```asm
48 83 AF 80 02 00 00 XX        sub qword [r15 + slot*8], imm8
48 81 AF 80 02 00 00 XX XX XX XX
```

> **雷区**：ModRM `/5` 是 SUB；容易写错成 `/4`（AND）。

### `0x65 CMP` — 设置 flags for state[a] vs state[b]

**yoyo-gen.js 实际使用 load + load + cmp-reg 模式**：

```asm
48 8B 87 80 02 00 00       mov rax, [r15 + a*8]   ; load state[a]
48 8B 97 80 02 00 00       mov rdx, [r15 + b*8]   ; load state[b]  ← 注意 dst=rdx
48 39 D0                  cmp rax, rdx           ; set flags
```
**总字节**：7 + 7 + 3 = 17

后续 JE/JNE/JL 等用 flags 决定跳转。

> **替代实现**（更短但 yoyo-gen.js 不用）：
> ```asm
> 48 8B 87 80 02 00 00       mov rax, [r15 + a*8]
> 48 3B 87 80 02 00 00       cmp rax, [r15 + b*8]
> ```
> 13 字节，更紧凑。yoyo-gen.js 不用——它优先选"reg-reg cmp"，因为这样 CMP 的两个值在 RAX/RDX 寄存器里，后续条件跳转之外的代码（如 SET 状态）能直接复用这些值。
>
> **雷区**：`48 3B 87 b*8` 是 `cmp rax, [r15+b*8]`——ModRM 用 `/r` 而不是 `/m`——别写错。

### `0x66 INC` / `0x67 DEC`

**yoyo-gen.js 实际使用 load + add + store 模式**（不用单条 `inc/dec [mem]`，因为 REX.W + `inc/dec [mem]` 有兼容性历史问题）：

```asm
; INC state[slot]  (0x66)
48 8B 87 80 02 00 00       mov rax, [r15 + slot*8]   ; load
48 83 C0 01                add rax, 1                ; rax + 1
49 89 87 80 02 00 00       mov [r15 + slot*8], rax   ; store
```
**总字节**：7 + 4 + 4 = 15

```asm
; DEC state[slot]  (0x67) — 类似，add rax, -1
48 8B 87 80 02 00 00       mov rax, [r15 + slot*8]
48 83 E8 01                sub rax, 1
49 89 87 80 02 00 00       mov [r15 + slot*8], rax
```

> **替代实现**（文档早期写的，**没在 yoyo 中使用**）：
> ```asm
> 48 FF 87 80 02 00 00       inc qword [r15 + slot*8]   ; INC
> 48 FF 8F 80 02 00 00       dec qword [r15 + slot*8]   ; DEC
> ```
> REX.W 必须有；`/0` 是 INC（ModRM `87`），`/1` 是 DEC（ModRM `8F`）。
> yoyo-gen.js 不用这个，更倾向于"显式 load-modify-store" 模式。
> **opcodes 0x67（DEC）和 0x66（INC）相反**——查 OPCODE 表别记错。

---

## 2. 控制流

### `0x40 handler start` — 标签

**不 emit 字节**——yoyo 编译器用 `handler[hh]` 字典记下当前 emit offset，handler 内的 jump/call 引用 hh 时再算偏移。

**Handler 表**：

```
handlerOffset[0x00] = code_offset  // emit 当前位置
handlerOffset[0x01] = ...
```

**Code alignment**：每个 handler **填充到 16 字节对齐**——短 handler（如只有 `C3`）后面跟 NOP（`0x90`）填充。

**验证**：`test-phase1.ty` 的 H_03（只有 `C3`）后面跟 `90 90 90...` 填充到下一个 16 字节边界。

### `0x41 call rel32` — `call H_hh`

**emit**：

```asm
E8 XX XX XX XX    call H_hh
```

**XX XX XX XX 是相对偏移**：`H_hh 的 emit offset - (call emit offset + 5)`

> **雷区**：相对偏移是**下一条指令**为基准，不是这条 call。
> 公式：`(target - (callPos + 5))` 作为有符号 32 位。

### `0x70 JMP` / `0x71 JE` / `0x72 JNE` / `0x73-0x7A` (各种条件)

**emit**：

```asm
; 短跳（-128..+127，相对当前指令末尾）
EB XX          jmp short
74 XX          je short
75 XX          jne short
7C XX          jl short (signed)
7D XX          jge short (signed)
7E XX          jle short (signed)
7F XX          jg short (signed)
72 XX          jb short (unsigned)
73 XX          jae short (unsigned)
76 XX          jbe short (unsigned)
77 XX          ja short (unsigned)

; 长跳（32 位）
E9 XX XX XX XX          jmp near
0F 84 XX XX XX XX       je near
0F 85 XX XX XX XX       jne near
0F 8C XX XX XX XX       jl near
0F 8D XX XX XX XX       jge near
0F 8E XX XX XX XX       jle near
0F 8F XX XX XX XX       jg near
0F 82 XX XX XX XX       jb near
0F 83 XX XX XX XX       jae near
0F 86 XX XX XX XX       jbe near
0F 87 XX XX XX XX       ja near
```

**关键决策**：
- yoyo.ty 解析时**不知道跳多远**——先 emit 短跳，占位 `0F 84 00 00 00 00`
- 所有 handler emit 完后，**回填 32 位偏移**

> **雷区**：短跳 `74 XX` 是 2 字节（jcc8），**XX 是相对位置**，不是绝对地址。
> 当 emit 时**还不知道目标距离**，必须先 emit 占位、最后 patch。

### `0xFF RET`

**emit**：`C3` （1 字节）

> 某些 handler 末尾会 emit 两个 `C3 C3`（如 H_01）——这是 yoyo-gen.js 的 16 字节对齐策略，不是 bug。

---

## 3. SSE2 浮点（IEEE 754 双精度）

> yoyo state 槽存的是 **IEEE 754 双精度位的 u64**。
> 浮点操作是寄存器 → 寄存器，不动 state 槽（除非显式 SET/GET）。

### `0x90 FADD` — f64 add

**emit**：

```asm
F2 0F 58 C1     addsd xmm0, xmm1    ; state[slot0] += state[slot1]
```

> SSE2 双精度：F2 前缀 + 0F 58 /r。
> ModRM：dst 在 reg 字段（3 位），src 在 r/m 字段。
> `C1` = mod=11 (reg-reg), reg=0 (xmm0), r/m=1 (xmm1)。
> **xmm 编号 8-15** 需要 REX.R（0x44），**别忘**。

### `0x91 FSUB` / `0x92 FMUL` / `0x93 FDIV`

```asm
F2 0F 5C C1     subsd xmm0, xmm1    ; 5C = SUB
F2 0F 59 C1     mulsd xmm0, xmm1    ; 59 = MUL
F2 0F 5E C1     divsd xmm0, xmm1    ; 5E = DIV
```

### `0x94/0x95 FCMP`（用 `ucomisd`）

```asm
66 0F 2E C1     ucomisd xmm0, xmm1    ; 比较 → flags
```

> 用 `ucomisd`（无序比较），不是 `comisd`。
> 后续 `jbe` / `jb` / `ja` / `jae` 据 flags 跳转。
> **特别注意 `ucomisd` 后的 flags**：相等时 ZF=PF=CF=1。

---

## 4. 文件 I/O

### `0x50 LoadFile` — 读文件到 state 槽

**emit**（Linux / Windows 不同）：

#### Windows (通过 IAT)

```asm
; CreateFileA("input.ky", ...)
mov rcx, str_idx_rva       ; 文件名 RVA
mov rdx, 0x80000000        ; GENERIC_READ
mov r8, 0x00000001         ; FILE_SHARE_READ
... (12+ 参数)
call [rip + IAT.CreateFileA - ...]
mov r13, rax               ; file handle → state 备用

; GetFileSize
mov rcx, r13
call [rip + IAT.GetFileSize - ...]
mov r12, rax                ; size

; VirtualAlloc(size)
mov rcx, 0
mov rdx, r12
call [rip + IAT.VirtualAlloc - ...]
mov rdi, rax                ; buf

; ReadFile
mov rcx, r13                ; handle
mov rdx, rdi                ; buf
mov r8, r12                 ; size
mov r9, 0                   ; bytes read ptr
... (more params)
call [rip + IAT.ReadFile - ...]

; CloseHandle
mov rcx, r13
call [rip + IAT.CloseHandle - ...]

; store buf pointer in state[id]
mov [r15 + id*8], rdi
mov [r15 + (id+1)*8], r12   ; store size
```

#### Linux (通过 syscall)

```asm
; open(filename, O_RDONLY)
mov rax, 2              ; SYS_open
lea rdi, [filename]     ; pointer to "input.ky" string in data section
mov rsi, 0              ; O_RDONLY
syscall
mov r13, rax            ; fd

; fstat (or lseek + read end)
mov rax, 5              ; SYS_fstat
mov rdi, r13
mov rsi, stat_buf
syscall

; mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0)
mov rax, 9              ; SYS_mmap
mov rdi, 0
mov rsi, r12            ; size
mov rdx, 1              ; PROT_READ
mov r10, 2              ; MAP_PRIVATE
mov r8, r13             ; fd
mov r9, 0               ; offset
syscall
mov rdi, rax            ; buf

; close(fd)
mov rax, 3              ; SYS_close
mov rdi, r13
syscall

; store buf in state[id]
```

> **历史 bug**（commit `1321cc9`，2026-07-05）：
>
> | 错误版本 | 修复版本 |
> |---------|---------|
> | `mmap(file, RWX, SHARED)` | `mmap(NULL, size, R, PRIVATE\|ANONYMOUS)` |
> | | + `read(fd, buf, size)` |
> | | + `close(fd)` |
>
> Linux 5.x 内核**拒绝** `PROT_EXEC` + `MAP_SHARED` + file-backed 组合（EACCES）。
> 错误版本会让 handler 拿 NULL 当 buf，scan loop 死循环 → 120 秒超时 → 看起来像 hang。
>
> **症状**：
> - `gen2.elf strace`: `mmap(...) = EACCES`
> - 永不 emit output

### `0x51 WriteFile` — 从 state 槽写文件

（类似 LoadFile 的反向，略）

---

## 5. 内存操作

### `0x20 VirtualAlloc` — yoyo 用户代码用

（实际 yoyo 编译器代码本身不会用——这是给 yoyo 编译出来的程序用的）

### `0x84 MEMCPY` — 从 data 段复制到 .text

```asm
; rep movsb
48 89 C7                mov rdi, rsi        ; dst = ?
... (具体见 linux-self-emit.js / win-handler-overlay.js)
F3 A4                   rep movsb
```

> **雷区**：rep movsb 之前 RSI/RDI 必须设置正确。
> Linux 上 RSI/RDI 是 data section 还是 state array 取决于实现。

---

## 6. 文件格式

### PE (Windows)

- DOS header at offset 0
- PE signature at **0xF0**（yoyo 自定义位置，不是标准 0x3C）
- .text section at 0x400 (RVA 0x1000)
- .rdata section at 0x4400 (RVA 0x9000)
- IAT at .rdata 开头，8 entries × 8 bytes

### ELF (Linux)

- ELF header at offset 0
- .text at file offset 0 (typically), RVA BASE
- .data at file offset 0x9000 (with 0x1000 alignment)

---

## 7. 已知风险点 / 调试陷阱

### R1. 整数立即数 vs 浮点位模式

`SET 0x50 0x3ff8000000000000` 是把 64 位位模式 **作为 u64** 存到 state[0x50]。
这恰好是 IEEE 754 表示的 `1.5`。
但 yoyo.ty 看到的是 `30 50 3ff8000000000000` ——**它不知道这是浮点**。

`FADD 0x50 0x51` 假设 state[0x50] 和 state[0x51] 已经是浮点位模式。

**调试陷阱**：如果你在 SET 时用了 `3ff8000000000000` 但忘了先 FADD，state[0x50] 确实是 1.5，但比较 `state[0x50]` 和整数时结果会出乎意料。

### R2. 短跳/长跳选择

emit 阶段不知道目标距离。**先 emit 占位 `0F 84 00 00 00 00`（6 字节），最后 patch**。
如果你看到 `00 00 00 00`，可能是未 patch 的占位——**这是 bug，不是无操作**。

### R3. REX 前缀缺失

x64 模式需要 REX.W（48）才能 64 位操作。如果 emit 缺了 REX，前 32 位会截断。

**特别容易出错的地方**：
- `add [r15 + slot*8], imm` ——缺 REX.W 会只加 32 位
- `mov [r15 + slot*8], rax` ——同上

**yoyo-gen.js 里所有这些都用 REX.W（48 或 49）开头**——但 linux-self-emit.js / win-handler-overlay.js 里的 scan-emit 路径**容易漏**。

> **commit `1321cc9` 修的就是这个类别的问题**（scan-emit 的 H_61 LoadFile 没用 REX）。

### R4. ModRM /reg 字段方向

```
modrm: [mod:2][reg:3][r/m:3]
```

`mov dst, src` 在 AT&T 语法里 `mov src, dst`——**reg 字段是 source**。
Intel 语法 `mov dst, src`——**reg 字段是 dst**。

yoyo emit 用 **Intel 习惯**——reg 字段是 **destination**。

如果你看到 `add [mem], rax`，ModRM 的 reg 字段是 rax，r/m 字段是 [mem]。

### R5. Linux mmap flags

| flags | 含义 | 适用 |
|-------|------|------|
| `MAP_PRIVATE \| MAP_ANONYMOUS` | 私有匿名内存 | file-backed mmap 后 read |
| `MAP_SHARED` | 共享映射（file-backed） | 拒绝（Linux 5.x） |
| `PROT_READ` | 只读 | file-backed mmap 必须 |
| `PROT_EXEC` | 可执行 | file-backed 拒绝 |
| `PROT_WRITE` | 可写 | file-backed 拒绝 |

> **永远不要** file-backed mmap + `MAP_SHARED` + `PROT_EXEC` —— 必 EACCES。

---

## 8. 用法

调试 yoyo 时，**看到 yoyo.ty 的一行 + 不理解**：

1. 查这张表，对应 opcode
2. 看 emit 的字节序列
3. 比对生成的 .exe / .elf 实际字节

调试 M3（gen2 ≠ gen3）时：

1. 字节 diff 在哪段？
2. 那段对应的 yoyo opcode 是哪个？
3. 对比 Node `compileFromAnalyzed` 和 scan-emit 的 emit 字节
4. 用这张表定位差异

---

## 9. 未来补充

- TIR → x64 emit 路径（Phase 6 替换 data.blob 后）
- TIR → WASM emit
- TIR → ARM emit

这些路径**目前**还在 evolution，**这张表主要覆盖 scan-emit 路径**。

---

## 10. 参考

- Intel SDM Volume 2 (x86 instruction encoding)
- `src/encode-x64.js` — yoyo 用的所有 x86 emit 函数
- `src/yoyo-gen.js` — yoyo 编译器源代码生成
- `src/backends/{linux,win}-emit-core.js` — 运行时 emit
- `src/linux-self-emit.js` — scan-emit Linux 路径
- `src/win-handler-overlay.js` — scan-emit Windows 路径

---

## 11. 验证记录

### 验证 1：`projects/test-phase1.ty`（2026-07-06）

**test-phase1.ty 包含的 opcode**：`30 60 65 66 70 71 41 40 FF`（无 50/51，无 SSE2）

**编译命令**：
```bash
node src/yoyo.js projects/test-phase1.ty build/test-phase1.exe
# → 100352 bytes
```

**.text 实际字节**（startup blob 之后从 0x475 开始）：

#### H_01 — `state[0x50] = 0; state[0x51] = 3; call H_02; ret`

| 文档说 | 实际字节 | 匹配 |
|--------|--------|------|
| `48 B8 00 00 00 00 00 00 00 00` mov rax, 0 | `48 B8 00 00 00 00 00 00 00 00` | ✅ |
| `49 89 87 80 02 00 00` mov [r15+0x280], rax | `49 89 87 80 02 00 00` | ✅ |
| `48 B8 03 00 00 00 00 00 00 00` mov rax, 3 | `48 B8 03 00 00 00 00 00 00 00` | ✅ |
| `49 89 87 88 02 00 00` mov [r15+0x288], rax | `49 89 87 88 02 00 00` | ✅ |
| `E8 02 00 00 00` call H_02 (rel32=+2) | `E8 02 00 00 00` | ✅ |
| `C3` ret | `C3 C3` (双重 ret，code alignment) | ✅ |

#### H_02 — `inc state[0x50]; cmp state[0x50], state[0x51]; je H_03; jmp H_02`

| 文档说 | 实际字节 | 匹配 |
|--------|--------|------|
| INC: `48 8B 87 80 02 00 00; 48 83 C0 01; 49 89 87 80 02 00 00` | 完全一致 | ✅ |
| CMP: `48 8B 87 80 02 00 00; 48 8B 97 88 02 00 00; 48 39 D0` | 完全一致 | ✅ |
| JE: `0F 84 05 00 00 00` (rel32=+5) | `0F 84 05 00 00 00` | ✅ |
| JMP near: `E9 D2 FF FF FF` (rel32=-0x2E) | `E9 D2 FF FF FF` | ✅ |

#### H_03 — `ret`

| 文档说 | 实际字节 | 匹配 |
|--------|--------|------|
| `C3` ret | `90 90 90...` (NOP 填充) | ⚠️ **不一致** |

**不一致原因**：H_03 短于 16 字节（只有 `C3`），其余用 `0x90`（NOP）填充到 16 字节对齐。文档应当说明代码段填充策略。

### 验证 2：`projects/test-float.ty`（2026-07-06）

**test-float.ty 包含的 opcode**：`30 90`（SET imm + FADD）

> **未完成**：`projects/test-float.ty` 在整理 commit 中被 agent 误删，文件不存在。需要从 git history 恢复或重新写一个简单测试。

### 验证 3：发现并修正的错误

| 错误位置 | 原文档 | 修正后 | 来源 |
|---------|--------|--------|------|
| §1 INC | `48 FF 87 slot*8`（单条 inc 指令）| load + add + store 模式（3 条）| test-phase1.ty 实际字节 |
| §1 CMP | `48 8B 87 a*8; 48 3B 87 b*8`（用 `cmp rax, [mem]`）| load + load + cmp-reg 模式 | test-phase1.ty 实际字节 |

### 验证 4：已知局限

- **未验证 SSE2 opcodes**（0x90-0x95）：需要 test-float.ty
- **未验证 IAT 调用**（0x50/0x51 LoadFile/WriteFile）：需要更长测试
- **未验证 fixup patch**：占位字节 `0F 84 00 00 00 00` 和最终 emit 的差异
- **未验证 NOP 填充**：`H_03` 后面用 `90` 填充到 16 字节对齐，但 yoyo-gen.js 里没找到对应代码

---

## 12. 给后续验证者的提示

如果你想扩展验证（加更多 opcode）：

1. **新增 opcode 测试**：在 `projects/` 下写新 `.ty`，**只用待验证的 opcode**。
2. **编译**：`node src/yoyo.js projects/test-X.ty build/test-X.exe`
3. **提取 .text**：`File.ReadAllBytes(build/test-X.exe)`，从 0x440 开始
4. **跳过 startup blob**：startup 长度 = 68 字节，但有 alignment padding，实际可能到 0x475
5. **对照 §1-§7**：每个 yoyo opcode 在二进制里都应该有**固定的字节序列**

**诀窍**：第一次跑新 .ty 时，**记录整个 .text section**——这样发现新 emit 模式时能直接对照源码确认。