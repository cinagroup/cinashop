# 商品单位与用户分组 PHP → TypeScript 增量（2026-10-14）

本批恢复 12 条在本批起点 `6dc28867` 尚未注册的旧 Admin 合同：商品单位 8 条、用户分组 4 条，并让现有 `/adminapi` 与 `/api/admin` 消费者共享实际权限、事务与审计处理器。它是本地候选，不代表整体迁移或生产验收完成。

## 可核实的旧接口

| 方法 | `/adminapi` 下的路径 | 行为 |
| --- | --- | --- |
| GET | `/product/get_all_unit` | 启用且未删除的平台单位选项 |
| GET | `/product/unit` | 名称筛选、排序和分页 |
| GET | `/product/unit/create` | 15 字名称与排序创建表单 |
| POST | `/product/unit` | 创建平台单位 |
| GET | `/product/unit/:id` | 平台单位完整 snake_case 详情 |
| GET | `/product/unit/:id/edit` | 已填值的 PUT 编辑表单 |
| PUT | `/product/unit/:id` | 修改名称与排序 |
| DELETE | `/product/unit/:id` | 引用保护与软删除 |
| GET | `/user/user_group/list` | `{list,count}`，ID 倒序分页 |
| GET | `/user/user_group/add/:id` | 新建／编辑表单，20 字名称 |
| POST | `/user/user_group/save` | 以正文 ID 创建／编辑，旧 `msg` 与空数组回执 |
| DELETE | `/user/user_group/del/:id` | 引用保护、物理删除与旧删除提示 |

商品单位旧源为 `cinashop-php/route/admin.php`、`app/controller/admin/v1/product/StoreProductUnit.php`、`app/services/product/product/StoreProductUnitServices.php`、对应 DAO 与 Validate。分组旧源为同一路由文件及 `app/controller/admin/v1/user/UserGroup.php`、`app/services/user/group/UserGroupServices.php`、`app/dao/user/group/UserGroupDao.php`；安装种子为 `public/install/crmeb.sql`。

注册与 PHP authority 的逐条对照见账本的 `static-delta.json`。静态匹配只证明新增路径，不替代下方实际 HTTP／SQL 行为证明。

## 行为、权限和有意差异

单位继承 ID、type、relation_id、name、sort、status、is_del、add_time，保持排序和软删除语义。名称按 Unicode 字符限制为 15 字；Admin 现有单位输入也收紧至 15。已引用单位允许改排序，拒绝改名或删除；检查全部归属的活跃商品。目录修改与平台、供应商真实商品保存共用 `731611` 事务 advisory lock，明确限制等待时间，不在数据库事务内调用外部提供商。

单位名在旧商品中是自由文本，并非外键。删除先提交时，之后的合法商品仍可保存同名自由文本；本批没有声称阻止这种历史行为。PHP `getAllUnitList()` 把 type／relation_id 条件注释掉，原调用会返回其他归属单位；新管理合同沿用现有 TS 平台目录隔离，仅返回平台项。这是明确的归属隔离差异。PHP 任意改名会使已使用名称脱离目录，本批对此增加引用拒绝，不改写商品。

分组表只含 `id/group_name`。旧列表、表单、保存与删除提示完整恢复；现代两组别名保留 `{list,count,page,limit}`、`{id}` 和删除 `null` 回执，现代名称仍允许数据库既有的 64 字。路径与查询 ID 必须一致，正文和分页拒绝畸形、重复及未知字段。不存在的旧删除仍可重试成功；不存在的编辑明确拒绝，避免 PHP 回退成新建。与 PHP 无引用检查的物理删除不同，新实现保护全部用户引用，包括已删除用户，不改余额、积分或其他账户事实。

分组 CRUD 共用既有 `731621` 目录锁，删除持分组 `FOR UPDATE`；真实分配持 `KEY SHARE`，移动／外部消费者的既有 `SHARE` 也与删除冲突。真实 PG 分别验证分配先持锁时删除超时／提交后拒绝，以及删除先持锁时迟到分配等待／随后拒绝，不产生孤儿分组 ID。业务与 `system_log` 同事务，审计拒绝使全部目录效果回滚。

新处理器复核当前管理员、密码版本、到期时间和权限；写入采用既有管理员权限表 barrier。读取在只读一致快照中执行。真实旧页面种子 `1349`（单位）、`227/263`（分组）按精确 ID／页面／unique_auth／auth_type／空 API 与方法元组恢复读取，两种权限解析器保持一致；页面本身不授予写权限。原分组 API 种子 `261/262/264/265` 另有覆盖。单位测试里的 `1401/1402` 是合成当前 API grant，不能冒充原 PHP 单位 seed。伪造页面或 API 元组有实际拒绝回归。

## 验证与边界

| 最终完整执行 | 结果 |
| --- | --- |
| 普通迁移与权限回归 | 14 文件，257 通过，13 原生条件跳过 |
| 既有测试类型修正回归 | 2 文件，35／35，两个文件与上一行不同 |
| 独立 PostgreSQL 16.14 | 8 文件，67／67，零跳过 |
| 定义去重 | 292 普通＋67 原生－43 重复＝316；13 原生条件跳过全部补验 |
| Worker 完整类型 | 标准 8192 MiB unit 与 runtime 均退出 0 |
| Admin | 完整 vue-tsc 与生产构建均退出 0 |

去重按文件、祖先标题链、测试标题和同名定义序号，未将先前重复执行或安装门禁另加一次。迁移执行冻结3249个Worker／Admin输入；之后只修正两份未被该批运行加载的独立测试类型错误，其35项完整回归单列。所有迁移运行代码、原生／普通已执行文件、helper、脚本、迁移和Admin输入字节保持；最终加入6个Supplier静态输入后交付摘要为3255项，首尾核对一致。范围与SHA完整保留，不把前述执行扩展为全库或所有前端验收。

完整最终结果、命令、文件 SHA、首轮失败、原始报告和清理事实见 [验证账本](../audit/php-ts-unit-group-migration-20261014.json)。本批使用锁文件精确安装的 Node 24.19.0／npm 11.11.0 与本地独立 PostgreSQL 16.14；锁文件未变。

普通 HTTP 使用真实 createApp、JWT、服务与 SQL，测试仅注入容器与本地会话连接；缓存拒绝头允许既有中间件的 `max-age=0`，仍要求 private/no-store。原生包含独立 LOGIN 的 SELECT-only 读取、写表与菜单列权限拒绝、并发、超时、过期、撤权顺序和回滚。外部 fetch 在夹具中禁止。前端用户分组回归为现有 SFC 运行测试；Admin 编译不等于浏览器、设备或正式账号验收。

全局 `audit:routes` 仍因既有 `GET /api/get_script` 与退役 manifest 冲突退出 1。该注册和退役决定均已存在于本批 HEAD；本批没有删除该路由、撤销原决定或放宽审计器来消除失败，因此不提供新的全局覆盖率或总缺口数字。

未提交、推送、部署或操作生产数据库；没有生产 DDL、新业务数据、实际支付／微信／短信／R2 调用。Checklist 的 404／249 完成／155 开放、Audit 的 88／50 完成／38 开放及全部父项保持；全库 CI、真实运行时／角色／设备／数据、发布与旧 PHP 下线继续开放。
