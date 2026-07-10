# yoyo-ide (保留为参考资料)

原始的 JavaScript 实现。**不再作为构建目标**——yoyo 项目的 Rust 实现现在是主编译器。

## 保留的文件

- \src/yoyo.js\ (162 行) — M0 种子编译器（信任锚点）
- \projects/yoyo-blob.ty\ (17,130 行) — YOYO 编译器自己的源码
- \projects/ternary_signal.ty\ — 三进制决策示例
- \projects/test-*.ty\ — 测试用例

## 用途

**只供查阅**。不参与构建，不参与 DDC 验证。

如果要看 yoyo 的当前实现，请看：
- \F:\yoyo\src\ — Rust 实现
- \F:\yoyo\docs\ — 架构文档

## 缺失的 .js 文件

以下文件**未保留**（yoyo 项目不需要它们）：
- yoyo-gen.js (91 KB) — JS 生成器
- pe-builder.js, elf-builder.js — 模板
- encode-x64.js — x64 编码参考
- backends/*.js — 平台后端

如果需要这些，从 \F:\yoyo-ide-backup-20260705\ 找。
