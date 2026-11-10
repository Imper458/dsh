---
kind: upgrade-guide
description: "会话读取方必须识别必需的辅助标题结算事件，才能打开新写入的会话。"
---

# 读取带标题用量记录的会话

[English](guide.md) | 中文

## 变更

模型标题生成会写入必需的 `session/title-llm-result` 事件，包含请求序号、执行状态与可选的已报告用量。不识别此事件的读取方会拒绝新写入的会话。已有会话仍可读取；缺失的历史用量无法从标题文本还原。

## 迁移

1. 在打开新写入的会话前，将共享 Session 存储的全部 Harness 应用与 SDK 运行时升级到识别 `session/title-llm-result` 的版本。不要删除该事件或降级共享存储。
2. 更新自定义 Session 消费方，保留该事件，并通过 `requestSeq` 关联 `session/title-llm-request`。缺少用量表示未报告，不表示零。
3. 生成一个标题后，用更新后的读取方重新打开会话，确认历史没有变化且结算记录保留已报告用量。[持久化确认记录](../../../persistence-changes/2026-11-06-title-usage-settlement.zh.md)记载了读取兼容性与已执行检查。
