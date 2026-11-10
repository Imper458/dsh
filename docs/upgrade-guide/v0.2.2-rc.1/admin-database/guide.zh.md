---
kind: upgrade-guide
description: "使用独立索引库和价格库的管理后台部署必须迁移到一个 SQLite 文件，并配置 path。"
---

# 合并管理后台数据库

[English](guide.md) | 中文

## 变更

可选的管理后台插件将可重建索引和持久化价格版本保存在同一个 schema 3 SQLite 数据库中。必填配置 `path` 替代 `indexPath` 和 `pricePath`；Web bundle 使用 `$DSH_HOME/admin/admin.sqlite`。运行时拒绝直接打开原有的 schema 1/2 分库文件。会话日志和管理后台 RPC 方法保持不变。

## 迁移

1. 停止拥有旧数据库的 Harness 进程。保留两个源文件作为备份，并选择尚不存在的输出路径。在源码目录中使用实际路径运行以下命令：

   ```sh
   pnpm exec tsx scripts/migrate-admin-database.ts --index "$HOME/.dsh/admin/index.sqlite" --prices "$HOME/.dsh/admin/prices.sqlite" --output "$HOME/.dsh/admin/admin.sqlite"
   ```

2. 命令在发布输出文件前验证数据库身份、版本、复制后的各行、JSON 记录和 SQLite 完整性。失败时两个源文件保持不变，不发布不完整的目标库；已有目标文件不会被覆盖。在迁移成功前保持服务停止。
3. 自定义管理后台配置应将 `indexPath` 和 `pricePath` 替换为输出文件的绝对 `path`。随附 Web bundle 已选择 `admin/admin.sqlite`。全新部署只需使用新配置。
4. 使用管理后台覆盖配置重新启动 Web profile。核对会话、工具、用量和价格记录与原实例一致。重建索引，确认价格和估算成本仍然可用。在服务停止后或使用 SQLite 备份工具备份合并后的文件；删除文件会同时删除价格和索引。
