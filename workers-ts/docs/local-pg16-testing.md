# Windows 本机 PostgreSQL 16 隔离验证

真实多连接测试不能由默认的单后端 PGlite 代替。GitHub Actions 无法运行时，可使用独立的本机 PostgreSQL 16；本机结果不替代 Linux/workerd、完整 CI、真实角色或生产发布验收。

## 边界

- 只使用专用的 `finance_test` 角色和 `cinashop_finance_test` 数据库，监听 `127.0.0.1`。不要使用生产数据库、Hyperdrive、SSH 隧道或 `DATABASE_URL`。
- 现有测试会核验 URL、数据库、角色及 PostgreSQL 主版本 16；多连接测试还核验随机 schema、四个不同且不重连的后端 PID，用 `pg_blocking_pids` 证明等待关系。
- 测试需要建库及 DDL 权限。仅在全新、可丢弃的本机集群中授予这些权限，不调整生产角色。
- 每个夹具只清理自身随机 schema/数据库；外部/内嵌完整迁移只允许执行在夹具创建的数据库。不能在控制库或生产库手工执行 `runAll`。
- 版本、平台、测试范围、失败和跳过须分别记录。Windows PG16.15 通过不代表 CI 的 Linux PG16.14 已通过。

## 准备与启动

从 [PostgreSQL 官方 Windows 下载页](https://www.postgresql.org/download/windows/)指向的 [EDB 二进制下载页](https://www.enterprisedb.com/download-postgresql-binaries)取得 **16.x 的 Windows x86-64 ZIP**，解压至独立目录。无需运行安装器、安装 pgAdmin、注册系统服务或修改全局 PATH。记录来源和下载文件 SHA256；自行计算的摘要用于追踪，不是独立的供应商签名验证。

在 PowerShell 中替换二进制路径，确认版本为 16，再创建新的数据目录。`-W` 交互设置仅用于本机测试的密码：

```powershell
$pgBin = 'C:\path\to\pgsql\bin'
& "$pgBin\postgres.exe" --version
$pgData = Join-Path ([IO.Path]::GetTempPath()) ('cinashop-pg16-data-' + [guid]::NewGuid().ToString('N'))
& "$pgBin\initdb.exe" -D $pgData -U finance_test -A scram-sha-256 -W --encoding=UTF8 --locale=C
if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }
$pgData
& "$pgBin\postgres.exe" -D $pgData -h 127.0.0.1 -p 55432 -c timezone=UTC -c log_timezone=UTC
```

保留此终端。启动日志必须确认仅监听 `127.0.0.1:55432` 且 ready；端口冲突应换一个未占用的本机端口，不停止其它服务。若 Windows 的 `pg_ctl start` 包装启动失败，先用 `pg_ctl status` 和进程/端口确认没有运行中的实例，再尝试上面的前台启动，不按超时猜测服务已停止。

## 执行测试

在另一个 PowerShell 终端中设置相同 `$pgBin`，先用 `createdb` 创建控制库（输入刚设置的测试密码），再核验身份：

```powershell
& "$pgBin\createdb.exe" -h 127.0.0.1 -p 55432 -U finance_test -W cinashop_finance_test
& "$pgBin\psql.exe" -h 127.0.0.1 -p 55432 -U finance_test -d cinashop_finance_test -W -X -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user, current_setting('server_version_num'), current_setting('listen_addresses'), current_setting('TimeZone');"
```

在 `workers-ts` 目录，为**当前进程**设置专用测试 URL，替换密码占位符（特殊字符必须 URL 编码），不要写入用户级环境或提交凭据：

```powershell
$env:TEST_FINANCE_POSTGRES_URL = 'postgresql://finance_test:<URL_ENCODED_TEST_PASSWORD>@127.0.0.1:55432/cinashop_finance_test'
npm run test:unit -- test/bargain test/pc-bargain-purchase.test.ts test/api006-activity-compatibility-migration.test.ts --silent=passed-only
npm run audit:orm
```

第一条是砍价范围，不是全仓库。第二条比较九条完整建库/升级路径及独立表元数据夹具，包含原始目录、升级/回滚和清理门禁。全仓库测试可另执行 `npm run test:unit`；不得把过滤测试或跳过项算成全量通过。测试 JSON 可用 Vitest `--reporter=json --outputFile.json=<绝对临时路径>` 保存。

## 清理核验与停止

测试结束后检查控制库 `public` 无业务表、`finance_test_*` schema 为零；`pg_database` 应仅剩 `postgres/template0/template1/cinashop_finance_test`。如有残留，先查明准确所有权、活动连接和失败原因，不用通配删除或 `DROP DATABASE ... FORCE` 掩盖清理失败。

通过**本次记录的准确数据目录**优雅停止临时实例：

```powershell
& "$pgBin\pg_ctl.exe" -D $pgData status
& "$pgBin\pg_ctl.exe" -D $pgData -m fast -w -t 20 stop
& "$pgBin\pg_ctl.exe" -D $pgData status
Remove-Item Env:TEST_FINANCE_POSTGRES_URL -ErrorAction SilentlyContinue
```

确认对应进程和监听端口已消失。默认保留已停止的数据目录、二进制和报告便于复核，不进行递归删除；下次使用前再次核验实例身份与空控制库。
