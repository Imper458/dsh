---
description: "Owner administration panel for conversation history, tool calls and estimated DeepSeek costs."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-admin

English | [中文](README.zh.md)

## Summary

This optional Web panel gives the current service owner a conversation table, readable conversation history, tool-call details, and DeepSeek usage and cost estimates. It consumes the [administration service](../../session-query/admin/README.md) through authenticated Remote methods. Opening a record does not resume its Agent.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount this Client plugin with the administration service. The Administration sidebar entry opens the conversation table; Overview, Tool calls, and Costs share the active filters. Search, model, status and inclusive Beijing calendar dates filter the server query. Conversations and Tool calls initially show all dates; Overview and Costs initially cover the latest seven Beijing calendar days. Explicitly applied or cleared filters remain selected across tabs. Opening a conversation shows its history independently of the list's filters, with separate chat, tools and usage tabs, a parent link and paginated descendant links. Child-conversation totals require the explicit include-children option.

The table exports CSV from its displayed filters and index revision. If the index or prices change before export, the page requests a refresh instead of exporting a different revision. Missing usage or prices remain visibly unavailable. Price configuration accepts all three DeepSeek token rates; historical repricing is a separate, explicitly selected operation. Cost estimates are not provider invoices.

A failed refresh retains the last successful records beside a retry notice. Index progress and partial failures remain visible, and Rebuild index requests recovery. Tool arguments and results load only when expanded. Truncated chat messages support a single-message expansion within the server detail limit; any remaining truncation stays visible. Long tables scroll within the page, and long record content remains selectable and scrollable.

| Client configuration | Default | Purpose |
|---|---:|---|
| `refreshIntervalMs` | `10000` | Refresh delay while the page holds its query resource |
| `pageSize` | `50` | Rows per page, from 1 through 100 |
| `initialDays` | `7` | Initial Beijing-calendar date range for Overview and Costs |

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin mounts the generated administration Remote contribution before registering its global main panel and sidebar entry. Query records belong to Client Resources; the declared view store holds only navigation, filters and pagination. Each table and its summary read the same observed index revision. Page release aborts its refresh timer and prevents dependent reads after a pending request settles.

A passive Session follow stream observes committed conversation activity without activating the Agent. Activity beyond the indexed watermark appears as pending indexing; the next resource refresh supplies indexed records. The UI is removed before its Remote methods during plugin disposal. English and Chinese dictionaries are registered together; other languages use the locale service's English fallback.

<a id="model-experience"></a>
## Model Experience

None, as administration reads stored records and configures estimated prices without adding model tools, prompts, or conversation inputs.

#### KV Cache effect

None. Viewing and exporting records send no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Access covers the current service owner's records, not a multi-tenant account system.
- Totals follow the administration index; pending work is not a settled usage record. Daily charts, calendar filters, timestamps and price activation dates use Beijing time (UTC+8).
- The main-panel selection and filters are transient and have no dedicated bookmarkable URL.
- Tool details display recorded content, which can include sensitive values; the conversation user-text masking plugin does not sanitize these records.

<a id="dev-note"></a>
### Dev Note

None.
