# 商品保障服务 PHP → TypeScript 增量（2026-10-14）

本批新增 2 条旧保障服务表单 GET 注册，并修正旧前缀下 7 条已有 TS 路径的 DTO、权限、生命周期与审计处理。7 条已有路径中，GET 详情是此前 TS 的扩展，PHP 控制器没有 `read` 方法；不能把它计作已完成的 PHP 控制器合同。整体迁移目标继续保持 active，本报告是本地候选记录，不关闭迁移父 checkbox 或代表生产验收。

## 路径与真实来源

| 方法 | `/adminapi` 下的旧路径 | 本批行为 |
| --- | --- | --- |
| GET | `/product/ensure/create` | 新增 PHP 创建表单 |
| GET | `/product/ensure/:id/edit` | 新增 PHP 已填值编辑表单 |
| GET | `/product/all_ensure` | 修正为启用的平台选项 `{id,name}[]` |
| GET | `/product/ensure` | 修正为旧 `{list,count}`、上海时间和 `product_count` |
| POST | `/product/ensure` | 平台新建，旧成功消息及空数组回执 |
| PUT | `/product/ensure/:id` | 编辑四个业务字段，保留现有状态 |
| PUT | `/product/ensure/set_show/:id/:is_show` | 独立设置 0／1 状态 |
| DELETE | `/product/ensure/:id` | 引用保护、物理删除及旧回执 |
| GET | `/product/ensure/:id` | 保留 TS 详情扩展，数值时间，无 `product_count`；无 PHP `read` 来源 |

现代路径共 14 条：`/adminapi` 下新增 7 条短别名，`/api/admin/product` 下保留 7 条已有路径。两组共享服务，但使用现代投影及写入语义。

| 方法 | `/adminapi` 下的短别名 | `/api/admin/product` 下保留的路径 |
| --- | --- | --- |
| GET | `/all_ensure` | `/all_ensure` |
| GET | `/ensure` | `/ensure` |
| GET | `/ensure/:id` | `/ensure/:id` |
| POST | `/ensure` | `/ensure` |
| PUT | `/ensure/:id` | `/ensure/:id` |
| PUT | `/ensure/set_show/:id/:is_show` | `/ensure/set_show/:id/:is_show` |
| DELETE | `/ensure/:id` | `/ensure/:id` |

PHP authority 为 `cinashop-php/route/admin.php`、`app/controller/admin/v1/product/ensure/StoreProductEnsure.php`、`app/services/product/ensure/StoreProductEnsureServices.php`、`app/dao/product/ensure/StoreProductEnsureDao.php`、`app/model/product/ensure/StoreProductEnsure.php`，以及商品 DAO 的 `getUseEnsureCount()`。表单结构还核对了 `crmeb/services/FormBuilder.php`、`vendor/xaboy/form-builder` 的 Iview factory／组件／验证器、旧 SPA 的 `pages/product/ensure/index.vue`、`components/from/from.vue` 和 Axios request consumer；页面种子来自 `public/install/crmeb.sql`。

## DTO、表单和差异

保障 DTO 保留 `id/type/relation_id/name/image/desc/sort/status/add_time`。旧列表按 `sort DESC,id DESC` 排序，名称筛选保持 ID 或名称匹配；`add_time` 使用命名时区 `Asia/Shanghai`，0 也格式化为 `1970-01-01 08:00:00`。旧选项只有 ID 与名称，按 PHP 的 sort／ID 倒序返回。现代选项保持完整数值 DTO，现代列表保留 `{list,count,page,limit}` 且不额外添加 `product_count`；GET 详情扩展在两个前缀下都保留数值时间。

旧列表的 `product_count` 精确沿用 PHP `FIND_IN_SET` 对商品 `ensure_id` CSV 的语义：全部归属商品都计入，包括已删除商品；重复 token 不重复计同一商品，token 不做空白或数字规范化。它不读取或累加 type-5 关联表。列表数量在同一只读快照内聚合，完整列表 DTO 的数量回显在写锁内再次核对。

编辑接受旧列表的字符串日期及 `product_count`，也接受既有详情扩展的数值日期。正文 ID 必须与路径一致，type、relation ID、创建时间和数量都是只读回显；未知字段、伪造身份、已变化的数量或时间拒绝。旧编辑省略 status 时保留原状态；明确回显 status 也只能与现值一致。现代写入可显式修改 0／1 状态，省略时仍保留现值，不把已停用记录意外恢复为启用。旧创建、编辑、状态、删除分别保留 `添加保障服务成功!`、`修改成功!`、`设置成功`、`删除成功!` 及空数组回执；现代创建／编辑返回 `{id}`，状态／删除返回 `null`。

表单保持四个规则：保障服务条款、内容描述、图标、排序。名称控件 maxlength 为 100；描述在表单上 required；图标为单选 frameImage，提示 100 × 100，使用 `fodder=image` 图片 widget、`ios-add`、960 × 505 弹窗及 footer-hide；排序控件范围为 0～99999。动作采用相对 `product/ensure` 或 `product/ensure/:id`，POST／PUT 方法与旧 Axios 的 `/adminapi` baseURL 拼接规则一致。

表单提示和 API 约束分别保留：API 的 name／image／desc 最多 255 个 Unicode 码点，排序允许非负 32 位整数；旧服务器仅要求名称和图标，所以旧 API 允许空描述，不能把表单 required 误当作原 PHP 服务端校验。正文有 64 KiB 上限；重复或未知查询参数、畸形 ID、分页越界及其他字段明确拒绝。分页最多 100 条，完整选项最多读取 2000 条，超限明确拒绝，避免静默截断。

PHP 全部选项曾注释掉 type／relation 条件，部分写入与重复检查也未按归属隔离。TS 的 Admin 固定平台 `type=0,relation_id=0`，供应商选项仅提供平台和自己的保障；写入和重复名称校验按各自目录隔离。这是明确的归属保护差异。删除还检查全部商品 CSV 与 type-5 关联引用，包括历史或已删除商品引用，不沿用 PHP 无引用保护的删除行为。

## 锁、权限与审计

新建、编辑、设置状态与删除共用 `731614` 事务 advisory fence，平台作用域键为 0，供应商作用域键为其 relation ID。修改／删除持保障行 `FOR UPDATE`；每次 DML 检查完整返回行和业务回读。真实 `ProductAssociationService` 保存持保障行 `FOR SHARE`，与停用／修改／删除互斥；并发证据应来自真实商品保存路径，而不是将两个 Admin 写入越过权限表 barrier 当作目录 fence 证明。

停用不改写已有商品引用。新商品或新加入的绑定不能使用已停用保障；已有商品的原 CSV／type-5 历史绑定可以在后续编辑中保留，并继续接受归属校验。删除先提交时，迟到商品绑定等待后因目录不存在而拒绝；真实商品先持 SHARE 时，目录修改等待其提交，再按最新引用或状态处理。独立 PostgreSQL 的实际锁等待、提交和拒绝回执已覆盖上述时序。

Admin 读取在 `REPEATABLE READ, READ ONLY` 中复核当前平台管理员、密码版本、完整角色引用历史和 `product.view`。写入采用现有权限表 barrier，复核当前 `product.manage`；末尾再次核对完整管理员及权限，并以数据库 `clock_timestamp()` 检查到期。SQL 限时 5 秒、锁等待限时 2 秒，事务内无外部提供商调用。

目录写入与 `system_log` 同事务，审计返回字段和日志回读须完全一致。创建／编辑／状态在审计后再次比对完整保障行，删除在审计后再次确认任何归属的同 ID 行都不存在。跳过或改写 DML、审计拒绝、审计触发器改写记录或在删除后重建记录，均应回滚目录和日志；当前证据不能仅凭前置 core 回读而宣称事务最终效果完整。

精确 PHP 页面种子 `1382` 以 ID、`type=1`、`auth_type=1`、`menu_path=/admin/product/ensure`、`unique_auth=admin-storeProduct-ensure`、空 API 与 methods 元组授予读取，两种权限解析器保持一致，不由页面授予写权限。邻近种子 `1383` 的 `/admin/product/ensure/create` 在旧 SPA 实际错连 Specs 编辑器；本批不据 URL 或中文名称猜测保障服务权限，不授予它目录读取、表单或写入能力。

## Vue3 与单位表单消费者修复

Vue3 保障服务列表、新建／编辑、状态与删除改用 `/adminapi` 的短现代别名，保持既有数值时间、分页、ID 回执及显式状态编辑能力；不让现代页面误消费旧 PHP 的空数组或只读 status 合同。该接线改动不等于完整浏览器或正式账号验收。

本批也修正先前单位表单的 action consumer 问题：旧弹窗把返回 action 原样交给 Axios，`/adminapi` baseURL 会自行拼接。单位表单动作应为相对 `product/unit` 或 `product/unit/:id`，此前包含 `/adminapi` 的动作会产生重复前缀。此处只修正实际消费者的提交目标，单位读写规则和既有业务范围不因此扩张；测试从真实接口取得表单，把 action 交给实际 Axios，再向完整 App 提交创建与编辑并验证 SQL 和审计。

## 验证状态与交付边界

最终完整命令、类型与构建已验证；仅汇总最终成功定义，不重复累计初轮、修正和预冻结执行。初轮普通 43 通过／1 夹具 SQL 失败，初轮 HTTP 24 通过／2 测试预期失败的原始报告完整保留；修正保留审计断言，并增加现代空描述拒绝与四条完整编辑规则验证。

| 范围 | 最终结果 |
| --- | --- |
| 普通合同、实际 HTTP、单位表单 consumer 与关联回归 | 18 完整文件，131 通过，39 原生条件跳过 |
| 独立 PostgreSQL 16.14 LOGIN、目录 fence、真实商品 SHARE、停用与历史绑定 | 11 完整文件，108 通过，零跳过 |
| 测试定义去重与原生补验 | 131＋108－69 重合＝170；39 条条件项全部补验 |
| Worker 完整 unit／runtime 类型检查 | 按包脚本的 8192 MiB 参数直接执行两套 tsc，均退出 0 |
| Admin 完整类型与生产构建 | 按包脚本顺序执行 vue-tsc -b 与 vite build，均退出 0 |

3268 个 Worker／Admin 迁移输入的最终前后 SHA 保持 `a02d8d0cc97ddc249cf8a3a0267164ce4f67e1d162466a13d62530e0c3857a03`；早期快照命令目录错误修正后，普通完整命令另行重跑，未把预冻结结果替代最终验证。两个独立原生集群夹具均为 0，并以 pg_ctl 退出 3 独立确认停止。最终命令、原始报告、失败与修正、输入摘要和清理事实见 [验证账本](../audit/php-ts-ensure-migration-20261014.json)。普通 HTTP 采用真实应用、JWT、服务与 SQL，注入夹具容器与本地会话；Vue 消费路径编译实际 API 与请求层，只替换测试 token 获取，使用实际 Axios adapter 桥接本地完整 App，外部 fetch 禁止。这证明请求合同，Admin 编译与该消费测试不替代完整浏览器或正式账号验收。

独立只读复核再次核对原始计数、33 份既有回执、3268 项当前输入哈希、11 份 PHP 源、类型／构建退出码、实际消费者和集群停止状态，未发现实质不实字段；复核回执已另行保存。

全局路由审计继续因 HEAD 已有 `/api/get_script` 注册与退役决定冲突退出 1，本批未更改该裁决或放宽审计器，不提供新的全局覆盖率。Checklist 保持 404／249 完成／155 开放，Audit 保持 88／50 完成／38 开放，全部复选行及父项不变。

本批没有提交、推送、部署或操作生产数据库，没有生产 DDL 或实际支付、微信、短信、R2 等提供商调用。整体迁移目标、迁移父 checkbox、全库 CI、真实运行时／设备／数据验证、生产发布与旧 PHP 下线继续开放；不以这批局部候选宣称整体完成。
