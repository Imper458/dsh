---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-06-title-usage-settlement

[English](2026-11-06-title-usage-settlement.md) | 中文

## 概述

新增必需的 session/title-llm-result 记录，通过请求序号关联已结算标题模型调用的执行状态与可选的提供方已报告用量。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-06-title-usage-settlement
baseline: false
changes:
  - root: "event:session/title-llm-result"
    previous: null
    after: "937ea3fa9ed4eeaa35950c25abb4e837332b669bd31fe82036551336d5e99778"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

没有结算记录的已有日志仍然有效，缺失的标题用量保持未知。更新后的读取方识别这一仅日志事件，不改变模型历史。旧读取方在重建会话前拒绝未知的必需事件判别符；这种安全拒绝允许保持写入版本不变。未修改已提交的历史代次或格式 schema。

<a id="verification"></a>
## 验证

./node_modules/.bin/vitest run packages/session/session-title-llm/tests/llm.spec.ts：24 个测试通过，覆盖成功、失败、取消、缺少用量和重复请求归属。TypeScript SDK 的 session-title-stability 录制场景已通过 dsh SDK profile 刷新并成功回放。 无需密钥的 Python SDK 标题用量运行时测试通过，并验证同一结算载荷与持久化 Session 日志一致。

<a id="dev-note"></a>
## 开发备注

无。
