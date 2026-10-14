# 商品参数模板 PHP → TypeScript 增量（2026-10-14）

本批恢复 5 条旧 Admin 商品参数模板接口，并让已有 `/adminapi` 与 `/api/admin` 的 10 条现代别名共享当前权限、目录生命周期与事务审计。实现是本地候选，整体 PHP → TypeScript 迁移目标继续保持 active；本报告不关闭迁移父项或代表生产验收完成。

## 可核实的接口与旧来源

| 方法 | 旧 `/adminapi` 下的路径 | 行为 |
| --- | --- | --- |
| GET | `/product/all_specs` | 平台模板选项及启用子参数，父项仅 `id/name/specs` |
| GET | `/product/specs` | ID 或名称筛选、排序、分页，旧 `{list,count}` |
| GET | `/product/specs/:id` | 完整父 DTO 与所有本归属子参数 |
| POST | `/product/specs/:id` | ID 为 0 时新建，正整数时编辑，替换子参数 |
| DELETE | `/product/specs/:id` | 商品引用保护、删除父子行，旧空数组回执 |

现代别名分别挂在 `/adminapi` 与 `/api/admin`，每个前缀有以下 5 条，共 10 条：

| 方法 | 前缀下的路径 | 保留的现代回执 |
| --- | --- | --- |
| GET | `/all_specs` | 子参数时间为数值 |
| GET | `/specs` | `{list,count,page,limit}`，列表包含子参数 |
| GET | `/specs/:id` | 父子时间均为数值的完整 DTO |
| POST | `/specs/:id` | `{id}`，提示 `保存成功` |
| DELETE | `/specs/:id` | `null`，提示 `删除成功` |

真实 PHP authority 为 `cinashop-php/route/admin.php`、`app/controller/admin/v1/product/specs/StoreProductSpecs.php`、`app/services/product/specs/StoreProductSpecsTemplateServices.php`、`StoreProductSpecsServices.php`、`app/dao/other/CategoryDao.php`、`app/dao/product/specs/StoreProductSpecsDao.php`，以及 `app/model/other/Category.php` 与 `app/model/product/specs/StoreProductSpecs.php`。供应商选项来源还包括 `route/supplier.php`；页面权限种子来自 `public/install/crmeb.sql`。静态路由匹配只证明注册，不替代实际 HTTP、SQL 与并发行为证据。

## 合同与明确差异

父 DTO 保留 `id/pid/type/relation_id/owner_id/name/sort/group/other/is_show/add_time/integral_min/integral_max`；详情另有 `specs`。子 DTO 保留 `id/type/relation_id/temp_id/name/value/sort/status/add_time`。父列表按 `sort DESC,id DESC` 排序，名称筛选保持 PHP 的 ID 或名称匹配。旧父列表不加载子行，因此不受无关子参数总量影响。

| 时间字段 | 旧合同 | 现代合同 |
| --- | --- | --- |
| 列表父 `add_time` | `Asia/Shanghai` 的 `YYYY-MM-DD HH:mm:ss`；0 为 `''` | 数值秒数 |
| 详情父 `add_time` | 数值秒数，PHP 父模型无该时间访问器 | 数值秒数 |
| 选项与详情子 `add_time` | 上海字符串；0 为 `1970-01-01 08:00:00` | 数值秒数 |

时间使用命名时区，保留上海历史夏令时。完整旧详情可以原样回显再编辑名称、排序与参数值；只读父字段、子行身份、归属与创建时间在生命周期锁内逐项核对。正文 ID 必须与路径一致，旧子 ID 必须属于当前模板且不能重复；未知字段、伪造归属、失效回显和错误分页明确拒绝。正文上限为 64 KiB，重复或未知查询参数拒绝。

编辑沿用 PHP 的子行整体重建语义：删除旧子行，重新生成子 ID 与创建时间，不将详情中的旧 ID 当作新记录 ID。与 PHP `checkSpecsData()` 忽略 `status` 后使用数据库默认状态不同，TS 保留明确提交的 0／1 状态，完整 DTO 回显不会把隐藏子参数重新启用；这是沿用现代接口既有能力的明确差异。旧新建、编辑、删除分别返回 `保存成功`、`编辑成功`、`删除成功`，`data` 均为空数组。

PHP 的 `getAllSpecs()` 注释掉 type／relation 条件，详情也未完整限制归属。TS 的平台模板固定为 `type=0,relation_id=0,owner_id=0,group=3`；供应商读取可用平台模板和自己的模板，不读其他供应商、门店或其他 owner 的目录。子参数的 type／relation 必须与父模板一致；污染子行不回显。写入发现同一模板下有跨归属子行时拒绝全部修改，保留污染数据供核对，不删除他人行或新增孤儿行。

整批选项最多读取 2000 个模板；详情和需要子参数的读取最多加载 2000 个子行，超限明确拒绝，不截断后当作完整结果。单次写入最多 100 个子参数，名称与值最多 255 个 Unicode 字符，分页最多 100 条。历史大模板可读取和检查，但超过写入容量的完整详情需先整理为合法数量；本批不宣称无限容量兼容。

## 生命周期、权限和审计

新建、编辑与删除共用 `731613` 事务 advisory lock，平台作用域键为 0，供应商作用域键为其 relation ID。修改／删除持父行 `FOR UPDATE`，子行修改核对完整删除和插入回执，并回读全部父子字段。真实商品保存持模板及有效本归属子行 `FOR SHARE`；这些 SQL 锁与模板修改／删除冲突。删除检查活跃商品的直接 `specs_id` 和既有 type-6 参数关联，拒绝仍在使用的模板。模板目录变更不改写商品已经保存的独立参数快照。

Admin 读取采用 `REPEATABLE READ, READ ONLY`，复核当前平台管理员范围、启用状态、密码版本、完整角色引用历史及 `product.view`。写入采用现有管理员权限表 barrier，要求当前 `product.manage`；结束前再次复核完整管理员和角色权限，并以数据库 `clock_timestamp()` 检查严格到期。SQL 限时 5 秒、锁等待限时 2 秒，事务内不调用外部提供商。

父子目录写入与 `system_log` 在同一事务；审计有精确返回字段和回读校验。保存还在审计前后比对父行和按 ID 排序的全部子行，子回读最多取 101 行以识别超过 100 的异常；删除在审计后再次确认所有归属的同 ID 父行与同 temp ID 子行都不存在。审计触发器改写父子内容或在删除后重建父子行，使目录效果和日志一起回滚，避免 core 回读后仍被审计副作用改写。

真实页面读取种子 `1381` 只按精确 ID、`type=1`、`auth_type=1`、`menu_path=/admin/product/specs`、`unique_auth=admin-storeProduct-specs`、空 API 与 methods 元组恢复 `product.view`，两个权限解析器保持一致。该页面种子不授予写权限。种子 `1383` 实际属于 `/admin/product/ensure/create`，不能因中文名称误判为参数模板写权限；测试里的 `1501/1502` 为合成 API grant，不冒充 PHP 原始种子。

## 验证状态与交付边界

最终持久回执验证如下；只计完整最终命令，不重复累加先前执行：

| 验证范围 | 结果 |
| --- | --- |
| 普通合同、HTTP 与关联回归 | 14 个完整文件，98 通过、25 原生条件跳过 |
| 独立 PostgreSQL 16.14 与实际 LOGIN／锁 | 6 个完整文件，52 通过、零跳过 |
| 按测试定义去重 | 98＋52－27 重合＝123；25 条原生条件项全部补验 |
| Worker 完整 unit／runtime 类型检查 | 按包脚本的 8192 MiB 参数直接执行两套 tsc，均退出 0 |
| Admin 完整类型与生产构建 | 按包脚本顺序执行 vue-tsc -b 与 vite build，均退出 0 |

运行代码、测试、helper、脚本、迁移与 Admin 输入共 3262 项，前后 SHA 摘要保持 `01a043d35437081d1422f4f7cdceb0df38637cf600f1c04e75b54de9a27d5a25`，同一摘要也与临时目录丢失前的执行一致。工具会话变化造成旧 `/tmp` 原始回执不可取回，旧类型检查终态未观察到；本次重新下载并固定校验官方 PostgreSQL 16.14、重建隔离工具，完整重跑两组测试、类型和构建，把新回执保存在工作区。丢失前观察与恢复时错误日志路径的未执行命令另列，不冒充当前成功或累计测试数。

最终命令、结果、输入 SHA、原始报告及清理事实见 [验证账本](../audit/php-ts-specs-migration-20261014.json)。普通 HTTP 使用真实应用、JWT、服务与 SQL，注入只限测试容器及本地会话；外部 fetch 在夹具中禁止。原生覆盖独立 LOGIN 读写权限、生命周期和真实商品 SHARE 顺序、撤权、菜单行锁、过期与回滚；生命周期双向保存／删除测试使用业务核心与 Admin 写入，共用 731613，不宣称两个 Admin 写入同时越过权限 barrier。新集群残留夹具为 0，另以 pg_ctl 退出 3 独立确认停止。Admin 编译不等于浏览器、设备或正式账号验收，供应商商品参数绑定也不属于本批完成范围。

全局 `audit:routes` 仍因 HEAD 已有 `/api/get_script` 注册与退役决定冲突退出 1。原退役裁决与后来恢复实现需单独闭环，本批不修改审计器或退役决定来消除失败，不提供新的全局覆盖率。Checklist 保持 404／249 完成／155 开放，Audit 保持 88／50 完成／38 开放，全部复选行和父项保持。

本批没有提交、推送、部署或操作生产数据库，没有生产 DDL 或支付、微信、短信、R2 等实际提供商调用。整体迁移目标、Checklist／Audit 的父 checkbox、全库 CI、真实运行时／设备／数据验证、正式发布与旧 PHP 下线继续开放；不借本批局部候选或先前观察结果宣称全局迁移完成。
