---
kind: upgrade-guide
description: "Administration deployments using split index and price databases must migrate to one SQLite file and configure path."
---

# Merge administration databases

English | [中文](guide.zh.md)

## Change

The optional administration plugin stores its rebuildable index and durable price versions in one schema 3 SQLite database. Its required `path` configuration replaces `indexPath` and `pricePath`; the Web bundle uses `$DSH_HOME/admin/admin.sqlite`. Existing split schema 1/2 files are refused at runtime. Session logs and the administration RPC methods are unchanged.

## Migration

1. Stop the Harness process owning the old databases. Keep both source files as backups and select an output path that does not exist. From the source checkout, run the following command with your actual paths:

   ```sh
   pnpm exec tsx scripts/migrate-admin-database.ts --index "$HOME/.dsh/admin/index.sqlite" --prices "$HOME/.dsh/admin/prices.sqlite" --output "$HOME/.dsh/admin/admin.sqlite"
   ```

2. The command verifies database identities, versions, copied rows, JSON records and SQLite integrity before publishing the output. Failure leaves both sources unchanged and does not publish a partial destination; an existing destination is never overwritten. Keep the service stopped until migration succeeds.
3. For custom administration configuration, replace `indexPath` and `pricePath` with the absolute `path` used for the output. The shipped Web bundle already selects `admin/admin.sqlite`. Fresh deployments need only the new configuration.
4. Restart the Web profile with its administration overlay. Compare conversation, tool, usage and price records with the old instance. Rebuild the index and confirm prices and estimated costs remain available. Back up the unified file with the service stopped or SQLite backup tooling; deleting it removes prices as well as the index.
