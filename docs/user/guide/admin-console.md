# Inspect conversations and DeepSeek costs

English | [中文](admin-console.zh.md)

The administration panel lets the instance owner inspect recorded conversations and tools, estimate DeepSeek costs, and export statistics. It reads the sessions available to that instance, including stored conversations that have no running Agent.

## Enable the panel from source

After installing dependencies and building the source checkout, start the Web profile with the administration overlay:

```sh
pnpm dsh web --patch apps/cli/config/examples/admin.overlay.yml --port 3081
```

Open the authenticated startup link and select **Administration** in the sidebar. The overlay enables the administration service and its panel together. It stores the rebuildable index and durable prices together in `admin/admin.sqlite` under the Harness home. The database has one process owner; use separate Harness homes for separate instances.

## Read a conversation

Select a conversation to read its chat records, tool calls, and usage. Reading history does not resume an Agent. Truncated chat messages can expand within the configured detail limit. Expand a tool to read its arguments and result; long output is bounded and marked when truncated. Parent and descendant links open the related conversation, and the child-conversation option includes descendants in the selected tool and usage totals without recounting inherited history.

## Configure estimates and export

Open **Costs** and expand **DeepSeek prices**. Enter the exact model identifier, currency, effective time, and prices per million uncached input, cached input, and output tokens. New prices apply prospectively. To fill a historical price gap, select the historical option and explicitly recalculate the matching estimates; price versions are retained.

For a configured official time-of-day price, the table displays peak rates and identifies the half-price off-peak schedule and calendar expiry. Costs use the call start time in Beijing and the verified holiday calendar. Missing token usage remains unknown. Search and Fetch request fees are separate from this token-cost subtotal.

**Export CSV** uses the displayed selection and index revision. If records change before export, refresh the page and retry. Exports contain statistics rather than chat text or raw tool results, and keep currencies separate.

Missing usage and missing prices remain visible. The cost subtotal covers only calls with the required recorded counters and a matching price. Historical title requests without recorded usage, unreported usage, and activity lost before durable settlement cannot be reconstructed as exact costs. Other providers are marked outside DeepSeek pricing coverage. These estimates are not provider invoices.

## Recover an incomplete index

The panel reports indexing progress and failures. **Rebuild index** retries from the Session logs while retaining configured prices. An indexing failure does not stop Agent work. Review the server diagnostic when a rebuild cannot read a Session or open its configured database.

For deployment bounds and query behavior, see the [administration service](../../../packages/session-query/admin/README.md) and [panel reference](../../../packages/client/ui-admin/README.md).
