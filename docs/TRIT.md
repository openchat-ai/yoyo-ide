# Trit — yoyo 语言的平衡三进制类型

> **Trit** 是 yoyo 语言的一类**三值决策**抽象。**与交易无关**——是语言级
> 的"3 值投票 + 求和决策"模式，可在任何需要"多信号合一动作"的场景使用。

## 1. 概念

yoyo 的 state 槽是 `u64`（无符号 64 位整数），可存任意整数。Trit 是**约定
俗成**的 3 值决策编码：

| trit 值 | 抽象含义 | 默认应用约定（可改） |
|---------|----------|---------------------|
| `0`     | 负向 / 反对 / 卖 | sell |
| `1`     | 中性 / 观望 / 持 | hold |
| `2`     | 正向 / 支持 / 买 | buy |

## 1.1 trit 是 -1/0/+1 还是 0/1/2？

**答：在 yoyo 代码里，trit 始终是 0/1/2**——这是**唯一合法**的写法。

| 层 | 值的集合 | 出现位置 |
|----|----------|----------|
| **数学**（balanced ternary 概念） | $\{-1, 0, +1\}$ | 仅在理论文档（zhenxungupiao 的 THEORY-TERNARY-METAPHYSICS.md）|
| **代码**（yoyo 源码里写的） | $\{0, 1, 2\}$ | **所有 .ty 文件**——ternary_signal.ty、indicators.ty、stock_gui.ty、stock_app.ty 等 |

**两者的关系是常数偏移**：

```
trit_code = sign + 1       编码时用
sign      = trit_code - 1  解码时用
```

| 数学 (sign) | 代码 (trit) | 决策约定 |
|-------------|-------------|----------|
| -1          | **0**       | 卖 |
|  0          | **1**       | 持 |
| +1          | **2**       | 买 |

**不是"两种 trit"——是同一个 trit 在不同层的表示**。理论文档写 $\{-1,0,+1\}$
是为了引用 Setun（1958 苏联平衡三进制计算机）那个数学传统；yoyo 代码写
$\{0,1,2\}$ 是因为 yoyo state 是 u64 且要避开负立即数歧义（见 §1.2）。

## 1.2 为什么代码用 0/1/2 而不是 -1/0/+1

yoyo `0x30 SET imm` 在 x64 emit 是 `mov qword [r15+slot*8], val`——`val` 是
32-bit 立即数**符号扩展**到 64-bit。所以：

| yoyo 源码 | 实际存到 state | 二义性 |
|----------|----------------|--------|
| `30 0A FF` | `0xFFFFFFFFFFFFFFFF`（= -1 as signed, 但也是 255 as u64）| ❌ |
| `30 0A 02` | `0x0000000000000002` | ✅ 唯一 |

**用 0/1/2 完全避开这个二义性**。这也是为什么所有 trit 投票的代码
（ternary_signal.ty、indicators.ty 等）都用 0/1/2。

## 2. handler 库

标准 trit 决策核心在 `projects/ternary_signal.ty`，**5 个 handler**：

| Handler | 角色 | 入参 | 出参 |
|---------|------|------|------|
| `H_20`  | `trit_collect` | `state[0A..0A+N-1]` | `state[20] = Σ trit` |
| `H_50`  | `vote_to_count` | `state[30] = vote` | `state[20] += vote` |
| `H_30`  | `trit_decide` | `state[20]` sum, `state[21]` threshold | `state[22]` decision |
| `H_31`  | `set_hold` | — | `state[22] = 1` |
| `H_32`  | `set_buy`  | — | `state[22] = 2` |

调用方约定（**不是硬性**，可改）：

```
[indicator 1]  → state[0A] = 0/1/2   ┐
[indicator 2]  → state[0B] = 0/1/2   │
[indicator 3]  → state[0C] = 0/1/2   ├→ H_20 → state[20] (sum)
[indicator 4]  → state[0D] = 0/1/2   │   → H_30 → state[22] (decision)
[indicator N]  → state[0A+N-1] = ...  ┘
```

`H_30` 的决策表：

| sum vs threshold | state[22] | 含义 |
|------------------|-----------|------|
| `sum < thresh`   | `0`       | 负向（默认卖）|
| `sum == thresh`  | `1`       | 中性（持）|
| `sum > thresh`   | `2`       | 正向（买）|

threshold 在 `state[21]`，默认由 `state[03]` 提供（约定俗成，不是硬性）。

## 3. 用法示例

**纯 yoyo**（indicator 与决策解耦，**indicator 由调用方提供**）：

```yoyo
; indicators → state[0A..0F]  (6 votes)
30 0A 02   ; vote 0 = 2 (买)
30 0B 02
30 0C 01
30 0D 01
30 0E 00
30 0F 00

41 20      ; call H_20 (collect 7 votes; state[0A..0x10])
; 之后 state[22] 就是最终决策
FF
```

**调用方不限于 trading**——可以是：

- **A/B 路由**：feature flag / canary deployment
- **多源告警**：监控信号 → 升级 / 降级 / 维持
- **多专家系统**：N 个模型的输出 → 信任 / 不信 / 待定
- **容错投票**：3 副本结果 → 接受 / 重试 / 拒绝
- **UI 主题**：3 路偏好 → 暗 / 自动 / 亮

## 4. 为什么是 0/1/2 而不是 -1/0/+1

1. **yoyo state 是 u64**——直接存 -1 需要 `mov_ri` 写负立即数（4 条指令）
2. **加减/比较仍是 cmp_rr**——0/1/2 比 -1/0/+1 在 `H_50 vote_to_count`（循环加）
   实现上**少 1 条 `cmp` 立即数**
3. **0/1/2 在循环中** `state[31]++` 一条指令到位；负数要先符号扩展
4. **如果真要 -1/0/+1 语义**，在 emit 层加 `trit_sign(t) = t - 1` 转换即可

## 5. 与 zhenxungupiao 的关系

`ternary_signal.ty` 的**设计原产地**是 `F:\zhenxungupiao\yoyo\ternary_signal.ty`
（zhenxungupiao 是 2026 年震巽量化研究项目）。本文件是该设计的**纯语言层
拷贝**——保留 handler 5 个、参数约定 `state[0A..10]` 7 票、决策函数 `H_30`，
**移除了所有 trading-specific 的语境**（SMA/RSI/MACD/心理学/玄学等都未带入）。

如要追溯**带 trading 上下文的完整设计**，参见 zhenxungupiao 仓库的：
- `yoyo/lib/indicators.ty` — 7 指标的实现
- `yoyo/lib/aggressive.ty` — 主动买% → trit
- `yoyo/lib/psychology.ty` — 心理学信号 → trit
- `yoyo/docs/THEORY-TERNARY-METAPHYSICS.md` — 平衡三进制与 A 股实证

## 6. 当前状态

- ✅ `projects/ternary_signal.ty` 独立可用，yoyo.js 编译为 100KB PE
- ✅ 5 个 handler 在 yoyo-ide opcode 表中无未定义指令
- ⏳ 文档已就位（`docs/TRIT.md`）
- ⏳ stock_gui.ty 中**仍内联一份**（line 533-586）以保持向后兼容；未来可改成 import 形式
