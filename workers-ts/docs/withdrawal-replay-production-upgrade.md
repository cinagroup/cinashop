# DB-006 提现重放增量发布

只处理 `public.user_extract` 的外部0130合同：新增非空、默认空字符串的
`request_key varchar(96)`／`request_hash varchar(64)`，将 `wechat` 扩到64，
并创建 `(uid, request_key) WHERE request_key<>''` 唯一索引。不执行提现、扣款、
provider调用、角色授权或其它历史迁移；DB-007与0150/0151仍独立验收。

## 显式运行

已获准的生产维护窗口，在 PowerShell7 的 workers-ts 目录运行：

```powershell
./scripts/run-withdrawal-replay-production-migration.ps1 -Apply -VerifyIdempotence
```

默认不执行，必须有 `-Apply`；通过现有安全环境注入Cloudflare凭据，不要放进命令参数或仓库。
脚本部署随机命名、10分钟令牌有效的独立维护Worker，先验证匿名403、错误方法405、
缺少显式操作400，再读取独立只读preflight。主Worker及Pages不被替换。
只有 `POST /migrate/0130` 且操作头完全匹配才会调用固定执行器；不接受SQL/schema/其它迁移号。

## 事务保护和数据不变量

- 对象必须是永久普通表，无继承／分区或RLS，`id`为单列integer主键、`uid`为integer。
- 拒绝启用的事件触发器；拒绝已有重放列或同名索引的类型／默认值／空值／定义漂移。
- `wechat`只允许正长度且不超过64的varchar，绝不自动缩窄现有更宽列。
- 独立READ COMMITTED事务，语句／锁／空闲事务限于5／1／5秒（保留更严格设置）。
  对此确切表取ACCESS EXCLUSIVE NOWAIT锁，已有占锁立即退出，不排队拖住业务；锁后重验目录。
- 此短窗口执行器最多处理10,000行，超过即在DDL前拒绝，需要重新评估维护容量。
  这是维护保护，不限制业务容量，也不对超限目标做部分迁移。
- 持锁比较整行规范化JSON的SHA-256汇总和行数；仅将原来不存在的新列按预期空字符串规范化。
  已有重放键也参与指纹，不忽略现存值；不输出业务行。前后不同则事务回滚。
- 完成后重验精确目录。另一个GET事务再次核对；可选第二次POST仅在首次成功及独立复核成功后执行，
  必须返回 `applied=false`，无DDL，且指纹不变。这不是对未知结果的自动重试。

## 失败与回滚

退出2或HTTP503不代表一定回滚：连接可能在COMMIT后中断。必须先独立只读检查目录和结果，
不能盲目重试或宣称失败请求没有落库。事务内失败（包括索引唯一性冲突）会整体回滚。
应用代码回滚时保留兼容的新增字段／索引与扩宽类型，不自动DROP已可能承载幂等记录的列。

`finally`删除本次随机维护Worker并核实控制面404，包括不确定部署结果；清理未确认须处理确切目标。
保护不涵盖另一个特权管理员的越权操作，必须协调维护窗口和权限变更。

PostgreSQL依据：[ALTER TABLE锁及重写语义](https://www.postgresql.org/docs/16/sql-altertable.html)、
[内置SHA-256](https://www.postgresql.org/docs/16/functions-binarystring.html)。
