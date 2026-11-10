---
description: "Owner-only conversation, tool and DeepSeek estimated-cost administration for one Harness instance."
kind: "package-reference"
---

# @deepseek-ai/dsh-admin

English | [中文](README.zh.md)

## Summary

This optional Host plugin serves the `admin` Remote namespace for an instance owner. It indexes local conversations and tool executions, estimates DeepSeek costs from recorded usage and administrator-entered prices, and exports matching CSV rows. It does not collect money or supply provider billing statements. Journal reads use prepared observations without starting cold agents.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this service alongside `sessionQuery`, `sessionProjections`, `sessions`, and `sessionPersistence`. The optional [administration UI](../../client/ui-admin/README.md) owns the browser entry. Every Remote operation checks the invocation's owner principal, including detail reads, prices, rebuilds and exports; trusted query infrastructure does not provide this authorization itself.

| Configuration | Meaning | Default |
|---|---|---|
| `path` | Dedicated absolute SQLite path for metadata and durable price versions | Required |
| `refreshIntervalMs` | Background corpus reconciliation interval | `5000` |
| `pageSizeMax` | Maximum rows per interactive page | `100` |
| `detailBytesMax` | Maximum serialized detail response bytes | `65536` |
| `exportRowsMax` | Maximum CSV rows | `10000` |
| `exportBytesMax` | Maximum UTF-8 CSV bytes | `16777216` |

Conversation lists sort by latest activity; date filters select creation time. Usage and tool date filters select call start time. All time intervals include their start and exclude their end. Text filtering matches conversation title, workspace or id literally. Model and lifecycle filters, plus an optional parent and its descendants, apply to indexed metadata. Daily usage groups use Asia/Shanghai dates. Overview conversation counts use the distinct conversations with matching model calls, including conversations created before the selected date range.

Prices cover the official `deepseek-official` and `deepseek-account` routes. Each model version records its currency, effective time and three decimal rates per million tokens: uncached input, cached input and output. A version applies until the next version of that model. `addPrice` accepts future dates; `repriceHistory` explicitly adds a historical version. Neither operation overwrites another version. Estimates reflect the selected immutable price history, and currencies are never merged.

A missing usage bucket, absent price or unsupported route is reported separately instead of priced at zero. Context-pressure estimates are never used as provider usage. Reasoning tokens are already part of output. Nonzero cache-write usage is unsupported by this three-rate DeepSeek calculator. A fork's inherited prefix is excluded from costs and tool counts; reading its transcript can still show inherited messages.

Every page identifies its index and price revision. Detail reads and CSV exports refuse a stale selected revision instead of mixing observations; refresh the page and retry. Exports carry revision and indexing-time columns and neutralize spreadsheet formulas in text cells. Oversized exports require narrower filters. Tool detail and raw-event payloads are bounded and report truncation; event pages can select readable user and assistant messages without duplicating raw payloads. A single-event read can expand a truncated message up to the configured detail limit.

`indexStatus` exposes readiness, progress and failed-session counts. Source failures keep the last indexed values visibly stale; repair the source and rebuild. A rebuild clears only derived tables, leaving price versions intact. Back up the complete database at `path` with the service stopped or SQLite backup tooling; deleting the file also deletes prices. Foreign databases and unsupported schema versions are refused without resetting them.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation ownership</summary>

A private host-only Session projection owns call metadata and lifecycle state. The indexer reads its state at an exact live or prepared observation cut through `sessionQuery.observeState`; no administration ledger is added to ordinary client Session payloads. It skips unchanged durable revisions and live cursors, reconciles removed sessions, and publishes each Session's rows transactionally. Live journal events only schedule background work; they do not wait for database writes. Unloading stops scheduling, joins indexing and closes the database.

The projection keeps one metadata record per model or tool call because paginated audit queries need those identities; arguments, results and transcript bodies remain in the journal. Model retries own distinct attempts. Final assistant usage replaces the corresponding attempt sample. Summary calls use `compaction/summary`; title settlements update their recorded request. Nested Code Mode tools are marked separately from their outer calls, so their summed durations must not be interpreted as wall-clock time.

</details>

An optional `deepseekSchedule` on a price version treats its rates as peak rates: Beijing Monday–Friday 09:00–12:00 and 14:00–18:00, excluding the supplied holiday dates. All other times cost half, including weekends that are compensating workdays. `validUntil` bounds the verified calendar; later calls report missing prices until a new version is configured. Call start time selects the band. The three recorded token counters are disjoint and are charged once each. The [official pricing page](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) owns the rates and schedule; updates require a new price version.

<a id="model-experience"></a>
## Model Experience

None, as this service reads stored records and adds no model prompt, tool schema, model call or model-visible result.

#### KV Cache effect

None. Indexing and price changes do not alter model requests or conversation history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Only records available to the current instance are covered; external providers' unrecorded child calls and provider invoices are outside the index.
- Historical title requests without usage settlements, missing usage on failed attempts, unsuccessful compactions without a summary record and process loss before settlement cannot be priced reliably.
- A cold observation validates its complete source journal. The first backfill and detail reads of uncached large histories can therefore be expensive; normal lists read the SQLite index.
- Projection metadata and derived rows grow with executed calls. Updates replace one Session's derived rows; this is a single-instance internal console, not a distributed analytics service.
- Dates use Asia/Shanghai for daily aggregation. Estimated costs are decimal-rate calculations, not a payment ledger; no exchange-rate conversion is performed.

<a id="dev-note"></a>
### Dev Note

None.
