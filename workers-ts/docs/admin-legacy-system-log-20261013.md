# PHP 后台系统操作日志旧读合同（2026-10-13）

本批新增 `GET /adminapi/system/log` 和 `GET /adminapi/system/log/search_admin` 两条旧 URL。前者返回 `{ list, count }`，后者返回 `{ info: [{ id, real_name }] }`。现代 `/log/list` 和 `/log/admin-options` 继续使用原合同。新候选尚未发布，不关闭 ADM-001、FE-001D 或任何迁移父项。

## 原合同依据

- `cinashop-php/route/admin.php:2114`、`:2116` 注册两条 GET。
- `app/controller/admin/v1/system/log/SystemLog.php:46` 的 `index()` 收取 `pages`、`path`、`ip`、`admin_id`，将 `data` 改名为 `time`；`:59` 的 `search_admin()` 仅投影管理员 `id,real_name`。
- `app/services/system/log/SystemLogServices.php:79` 的 `getLogList()` 返回 `list,count`；未指定管理员时使用当前管理员 level 范围。`app/dao/system/admin/SystemAdminDao.php:92`、`:106` 的两个目录方法均为 `level >= 当前 level`。
- `app/dao/system/log/SystemLogDao.php:53` 按 `add_time DESC` 排序。新实现以 `id DESC` 作为同秒稳定排序次键。
- `app/model/system/log/SystemLog.php` 的搜索器在 `page`、`path`、`ip` 上做包含查询，`admin_id` 为 ID 条件。
- 实际旧屏幕为 `/admin/system/maintain/system_log/index`，组件是 `view/admin/src/pages/system/maintain/systemLog/index.vue`，权限为 `system-maintain-system-log`。`/admin/system/log` 是浏览器 Vuex 前端事件页，本批不覆盖它。

列表只返回旧页面所需及旧日志固有字段：`id,store_id,admin_id,admin_name,path,page,method,ip,type,add_time`。不返回现代内部 `action`、`merchant_id`，不返回管理员账号、密码或角色资料。`add_time` 保留秒级数字，由旧页格式化。

## 筛选和边界

保留旧页面实际发送的 `page,limit,pages,path,ip,admin_id,data`；空文本条件和空／零 `admin_id` 表示不增加相应筛选。文本搜索将 `%`、`_` 和反斜线视为文本，避免输入字符扩大扫描范围。每页最多 100 行，偏移最多 20000；管理员搜索条件最多 1000 行。未知、重复、畸形及超限参数拒绝，超限目录不会静默截断。双端非零日期的原始结束秒早于开始秒时明确拒绝；不复制 PHP 对逆序输入先增加一天而偶然得到一秒或部分范围的行为。

旧 DatePicker 明确使用 `format="yyyy/MM/dd"`，`onchangeTime()` 将日期数组用 `-` 连接。自定义日期支持 `yyyy/MM/dd-yyyy/MM/dd`、单端日期及显式 `HH:mm[:ss]`。日期按 `Asia/Shanghai` 解释。双端区间为 PHP 的包含端点 `BETWEEN`：结束为午夜时先增加 86400 秒，故日期区间也包含次日零点这一秒；普通显式结束时间包含该秒。只有结束端时，无论是否带时间均先增加 86400 秒，然后使用严格小于。保留 `today,yesterday,week,month,year,last week,last month,last year,quarter,lately7,lately30` 的时间筛选。

`crmeb/traits/ModelTrait.php:78-89` 明确规定开始与结束相等时将结束时间增加 86400 秒。本批保留这个已有兼容行为：显式 `10:00:00-10:00:00` 也覆盖其后 24 小时。实际旧页发送日期；同秒显式时间不会被解释成单秒查询。该行为有独立期望断言。

同文件的 `quarter` 通过 `getMonth()` 得到季度首日和末日日期，再以包含端点 `BETWEEN` 查询；结束实际为季度末日零点，包含该秒而不包括末日其余时刻。新实现精确保留这个旧边界。`strtotime` 得到的 epoch 零值沿用 PHP 的假值判定，视为未提供对应端点。内部 SQL 统一以半开结束界表达上述旧语义，不将它们改成完整末日或排除次日零点；对应断言覆盖午夜、相等端点、显式单结束端、epoch 零值和第四季度跨年。

历史日期使用命名时区 `Asia/Shanghai`，包含 1986–1991 年的夏令时；不以固定 UTC+8 解释历史墙上时间。例如 `1990/07/01 00:00:00` 为 Unix 秒 `646758000`。转换以一个复用的 `Intl.DateTimeFormat` 在名义 UTC 的前后两天固定采样五个 offset，再要求候选年月日时分秒精确回转且唯一，计算量有界。输入限定 1970–2038 年，并维持日志 signed int32 秒范围（上限本地 `2038/01/19 11:14:07`）。此逆转换证明只适用于该时区和日期范围，不推广到任意时区。

日／周／月／年边界使用同一命名时区；滚动 7／30 天按旧 `strtotime('-7 day')`／`strtotime('-30 day')` 保留当地墙上时间减日，再转换成 UTC。历史切换日可能为 23 或 25 小时。自定义区间的旧 `+86400` 特例仍为固定秒数，不改成次日日历边界。春切换不存在的显式时间和秋切换重复的显式时间返回 `ValidateException`，不猜测 PHP 可能选取的时刻；滚动窗口的目标墙上时间遇到同类情况也明确拒绝。旧页面发送日期，正常历史日期仍可读取。原生测试在已有自有 PG16 夹具中对比 `AT TIME ZONE 'Asia/Shanghai'` 的历史／现代端点，作为独立 PostgreSQL tzdata 证据。

## 权限与只读性质

两条旧读合同均要求已有 `log.view`，并接受按当前真实菜单元数据解析得到的旧日志读授权。普通 `system.view` 不授予日志读取。新旧 API 占位符、角色及旧屏幕权限映射由权限服务核对；相邻维护和日志写操作不会由这两条 URL 获得授权。

服务在一个有超时边界的 `REPEATABLE READ, READ ONLY` 事务中重验真实管理员：平台 `admin_type=1`、`relation_id=0`、启用且未删除、合法 level、原密码摘要、有效 token 到期时间及真实角色的 `log.view`。身份、管理员范围、计数和列表均来自同一快照；返回前再次核对 token 到期时间。

`level >= 当前真实 level` 始终约束日志，包括显式 `admin_id`；原 PHP 显式 ID 跳过范围的行为不复制。管理员目录保留已停用／已删平台管理员，便于查其历史日志。供应商、门店及其他关系身份不进入平台目录；有 `store_id` 或 `merchant_id` 归属的日志及私有同城配送意图日志不进入该列表。

原 PHP 控制器构造函数会调用 `deleteLog()` 删除超过 90 天的日志。新 GET 不复制这项破坏性副作用，不插入日志、不清理日志、不发出远端请求，旧 `add_time=1` 样本仍可读取。

## 候选文件与验证

- `src/services/admin/AdminLegacySystemLogService.ts`：独立旧合同和事务内重验。
- `src/controllers/api/v1/AdminLegacySystemLogController.ts`：私有不可缓存响应和认证事实传递。
- `src/routes/adminapi.ts`：真实旧 URL 注册。
- `test/admin-legacy-system-log.test.ts`：完整业务及真实路由注册测试，默认 PGlite；可在独立 PostgreSQL 16 夹具上复验同一完整文件。实际挂载 `adminapiRoutes`，保留真实 JWT／角色授权、控制器和 SQL，仅将 `createAdminDatabaseSession` 连接工厂供应为自有夹具会话，并核对会话关闭、原容器恢复和越权请求不创建会话。该夹具工厂不能证明实际独立 LOGIN 或 Hyperdrive。afterAuth 竞争使用真实认证中间件及最小 Hono 测试路由，不是线上身份竞争证据。
- `test/admin-legacy-system-log-native.test.ts`：两个 PostgreSQL 16 独立 LOGIN 证明；计数后由独立 peer 提交改变和插入，验证原快照保持一致；仅 SELECT 的审计表授权及事务内原本获准的登录列更新被 `25006` 拒绝。

实际执行结果由本轮迁移主报告记录。测试代码及准备过程不计执行通过。真实角色、旧历史数据、生产规模／索引表现、Worker／Hyperdrive、浏览器完整旧屏幕联调及发布仍开放；未执行生产 DDL、提交、推送或部署。

## 本次只读 PHP 来源摘要

| 来源 | SHA-256 |
| --- | --- |
| `route/admin.php` | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| `app/controller/admin/v1/system/log/SystemLog.php` | `31cf7d8e6b4f27f844d1c1a615272b9edc67c3a65697dc0eeca3fbd6d76c6f31` |
| `app/services/system/log/SystemLogServices.php` | `71944fc9e0a5d039f22eb33f6802c0b284f33b3c746e1a5ac294eb502c00ac00` |
| `app/dao/system/log/SystemLogDao.php` | `e3602a40cc8ea6086044b8c9541878281c01b5d2402ea65232414736ffafd628` |
| `app/dao/system/admin/SystemAdminDao.php` | `1456d05c17a35d7f0e8079b4bdcf197e396c25bb8df8f0a0e0c3a2294881c689` |
| `crmeb/traits/ModelTrait.php` | `0b821909ee4b6bcffd51834f7b213e46ad001e64215d73dd27d951637cbb1fe6` |
| `view/admin/src/pages/system/maintain/systemLog/index.vue` | `a3e4677726bf66e79b1d7f79a426117e58ed32e05c57a3ac5efbc13e21884308` |
