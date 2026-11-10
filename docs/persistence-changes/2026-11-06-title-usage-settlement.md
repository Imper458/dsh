---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-06-title-usage-settlement

English | [中文](2026-11-06-title-usage-settlement.zh.md)

## Summary

Adds a required session/title-llm-result record correlating each settled title model call with its request sequence, execution status, and optional provider-reported usage.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs without settlement records remain valid and their missing title usage remains unknown. Updated readers recognize the new log-only event without changing model history. Older readers reject the unknown required discriminator before reconstructing a session; this safe refusal permits the same writer version. No committed historical generations or format schemas are changed.

<a id="verification"></a>
## Verification

./node_modules/.bin/vitest run packages/session/session-title-llm/tests/llm.spec.ts: 24 tests passed, including success, failure, cancellation, missing usage, and repeated request attribution. The TypeScript SDK session-title-stability fixture was refreshed and replayed successfully through the dsh SDK profile. The keyless Python SDK title-usage runtime test passed and matched the same settlement payload against the durable Session log.

<a id="dev-note"></a>
## Dev Note

None.
