---
kind: upgrade-guide
description: "Session readers must recognize the required auxiliary title settlement event before opening newly written sessions."
---

# Read sessions with title usage records

English | [中文](guide.zh.md)

## Change

Model-backed title generation writes a required `session/title-llm-result` event containing the request sequence, execution status, and optional reported usage. Readers that do not recognize this event refuse newly written sessions. Existing sessions remain readable; absent historical usage cannot be reconstructed from the title text.

## Migration

1. Upgrade every Harness application and SDK runtime that shares the Session store to a version recognizing `session/title-llm-result` before allowing it to open newly written sessions. Do not remove the event or downgrade the shared store.
2. Update custom Session consumers to retain the event and correlate `requestSeq` with `session/title-llm-request`. Treat missing usage as unreported rather than zero.
3. Generate a title, reopen the Session with the updated reader, and verify that its history is unchanged and the settlement retains the reported usage. The [persistence acknowledgement](../../../persistence-changes/2026-11-06-title-usage-settlement.md) records reader compatibility and executed checks.
