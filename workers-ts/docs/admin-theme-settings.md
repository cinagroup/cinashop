# 主题风格完整合同

旧 `/admin/setting/theme_style` 是六套固定配色的单选页面，保存一个方案编号，不是六个自由编辑的色值。编号依次为天空蓝、生鲜绿、热情红、魅力粉、活力橙、高端金。旧页面同时有各方案的本地预览图和保存按钮：`C:/cinagroup/cinashop-php/view/admin/src/pages/setting/themeStyle/index.vue:21`、`:63`、`:99`。

每套方案有 `theme/priceColor/minorColor/minorColorT/bntColor/gradient` 六个客户端 token。主题色与价格色并非始终相同：蓝色方案主题为 `#1DB0FC`、价格为 `#FD502F`，绿色为 `#42CA4D`、`#FF7600`，金色为 `#E0A558`、`#DA8C18`。完整固定值在旧 `C:/cinagroup/cinashop-php/view/uniapp/App.vue:250`。本批客户端实现需要消费全部六方案、页面宿主和 DIY 跟随主题行为；后端文件存在或仅 Admin 保存成功不能证明整屏已完成。

## 存储权威与读取

权威记录是 `system_dise`（旧 `eb_diy`）的 `template_name='color_change' AND type=3`，`value` 为单字符 `'1'..'6'`。不写 `system_config.color_change`，不以安装种子 ID 寻址，也不把表级 `status/is_show` 当主题开关。旧安装种子值为 `'1'`、两个表级开关均为 `0`：`C:/cinagroup/cinashop-php/public/install/crmeb.sql:848`。旧 Admin 缺失或读取值为 `0` 时显示红色方案 `3`；这是 UI 回退，不能声称数据库已经配置为红色。

旧保存只改 `value/update_time`，发布 `diy.update` 并更新缓存，缺少模板则拒绝：`C:/cinagroup/cinashop-php/app/controller/admin/v1/diy/Diy.php:509`。旧读取缓存按模板名及类型查询，不定义重复记录的安全优先级：`C:/cinagroup/cinashop-php/app/services/diy/DiyServices.php:406`。

新共同读取为 `src/services/content/ThemeReadService.ts`。候选查询纳入名称归一化后相同的行，包括错误类型、已删除行和别名；SQL `btrim` 与通用写保护共享 ECMAScript trim 字符集合，因此 tab、NBSP 等不会被一端认作主题、另一端当作缺失。最多读取三条候选：两条已经足够确认歧义并永久禁止该请求自动覆盖，不要求无界读取。值只读取前 64 个字符及完整字节长度，公开响应不返回原始损坏文本。版本包含候选身份、值与 PostgreSQL `xmin`，其他列变化也会使 CAS 失效。

`GET /setting/theme-style` 返回：

```ts
{ revision: string, status: 1|2|3|4|5|6|null,
  configured: boolean, editable: boolean, issues: string[] }
```

`configured` 与 `status !== null` 等价。正常记录返回真实值；缺失返回 `theme_missing`，允许用户显式首次保存初始化；唯一正确、未删除身份但值损坏返回 `theme_status_invalid`，允许显式选择有效方案修复。重复返回 `theme_duplicate`，别名、错误类型、删除标记或非法 ID 返回 `theme_identity_invalid`，这些情况不可自动写入。GET 永不补行。删除记录仍占据持久化主题身份，不能把软删除误当作可重新初始化的空白安装。

现有公开 `GET /api/v2/diy/color_change/color_change` 保留 `{status,navigation,product_category_level}`，增加 `theme_issues`。主题值缺失或异常时 `status=0`，客户端可用红色 `3` 显示回退，但不得伪造已配置状态。仅 `color_change` 名称采用共同主题权威；其他模板名称保留原公开读取合同。签到配置预览也使用相同读取，正常返回 `theme`，异常为 `null` 并带 `theme_issue`。主题本身直接读 SQL，既有导航和分类选项仍经过原 `SystemConfigService` 缓存。

主题不是 `/api/site_config` 字段。旧网站配置只返回备案号（`C:/cinagroup/cinashop-php/app/controller/api/v1/PublicController.php:124`）；主题来自 v2 独立入口（`C:/cinagroup/cinashop-php/app/controller/api/v2/PublicController.php:127`）。新主题读取不调用媒体存储、第三方 provider 或部署 API。

## 保存、版本与回执

两套 Admin 前缀 `/adminapi` 和 `/api/admin` 各注册三个接口：`GET /setting/theme-style`、`POST /setting/theme-style`、`GET /setting/theme-style/request/:requestId`。不自动注册旧无版本 PUT 保存入口。

POST 严格 body 为 `{request_id,revision,status}`：规范 UUID、64 位小写 SHA-256 版本、数字整数 `1..6`。不接受未知字段、重复解码 JSON key 或查询参数；请求体上限 4 KiB。固定 canonical 顺序为 `{operation:'update',revision,status}`，请求 UUID 不进入 payload hash。

成功回执为 `{operation:'update',id,request_id,payload_hash}`。它按管理员及 UUID 绑定，保存到 `system_log`，与主题 DML 同事务提交。同一已成功请求先回放回执，即便原 CAS 版本已经过期也不重复写。不同 actor、不同 payload、损坏或重复 journal 不能被当成成功，也没有可解除 pending 的确定拒绝证明。

保存先切 READ COMMITTED 并设置 5 秒 statement、2 秒 lock、5 秒 idle 超时，保留更严格的现有设置；随后取得同域 advisory lock `(731719,0)`、核对 journal、取得 `system_dise SHARE ROW EXCLUSIVE` 表锁、重读并比较 CAS，然后执行 DML 与日志。表锁保护缺失初始化与导入插入幻影，不只依赖合作式 advisory。正常记录仅更新 `value/version/update_time`，保留所有其他列，尤其不改变表级 `status/is_show`。缺失时只有明确 POST 才新增模板记录与回执。

只有在事务已完成回滚后，controller 才把两个具体错误类转换为：

- actual HTTP 409、body status 409、`THEME_SETTINGS_STALE_VERSION`：已规范化的请求在业务 DML 前 CAS 不匹配。
- actual HTTP 400、body status 400、`THEME_SETTINGS_REJECTED`：journal 无记录且 CAS 匹配后，业务 DML 前发现目录身份不能安全写。

这两种 proof 的 data 都必须包含 `operation:'update'`、匹配的 `request_id/payload_hash`。裸 400、JSON/UUID 错误、SQL 或权限错误、晚 journal 失败均不能作为释放 pending 的证据。用户重新读取后须显式确认当前方案，并使用新 UUID；不能把未知结果静默改成新请求。

## 授权与通用入口

现代权限独立为 `theme_settings.view/manage`，管理权包含本域读取权，不从 `config/dise` 继承。旧 `1035/1075` 只在 `auth_type=1`、页面路径 `/admin/setting/theme_style` 和 `unique_auth='admin-setting-theme_style'` 同时精确匹配时授予 view；仍须满足菜单 type、access 和未删除条件。旧空鉴权 API `1280/1281` 不自动赋予新 writer，PC 菜单 `1036` 也不能借用此权限。manage 需要现代角色规则显式分配。旧证据见 `C:/cinagroup/cinashop-php/public/install/crmeb.sql:9413`、`:9415`、`:9421`、`:9422`。

通用 `dise/save` 继续保护全部 type 3，并保护归一化名称为 `color_change` 的错误类型行；`dise/del` 同样拒绝该主题身份。相关通用保存、删除改为 READ COMMITTED、同样的有界超时和 SRE 表锁，再取行锁，避免旧 row-first 路径与主题 table-first 形成反向锁序。普通 DIY 页面仍可保存、删除。SRE 会串行这些目录写入；这里不声明生产规模性能，也不声明任意外部 writer 的非合作锁顺序均安全。

使用现有 `system_dise` Admin INSERT/UPDATE、共享 SELECT 和 `system_log` INSERT 权限，没有 HTTP DDL、生产 grant 扩大或角色前推。

## 本地验证边界

本批新测试库存为 32 个独立 case：7 pure、12 管理原生 SQL、9 actual registered HTTP、4 公共/签到原生读取。相应文件是 `test/admin-theme-settings.test.ts`、`test/admin-theme-settings-postgres.test.ts`、`test/admin-theme-settings-http.test.ts`、`test/theme-style-read-postgres.test.ts`。

`test/helpers/themeSettingsFixture.ts` 创建八张真实 ORM 表和独立非 owner PG16 LOGIN，仅授予当前生产 profile 与这些表的实际交集；它不是完整业务 commissioning。原生用例包括六值往返及所有其他列保持、GET 无初始化、首次保存、损坏值修复、Unicode 别名/重复、xmin CAS、actor/UUID 回放、晚 journal 故障回滚、独立 PID 幻影与表锁阻挡、通用 save/delete 同序锁和真实 tx-local 超时。HTTP 用例使用真实 app/JWT/菜单及两个前缀，验证 actual 400/409 proof、未知结果、空鉴权旧 API 与通用绕过拒绝；只替换请求连接装配，不替换业务事务或查询结果，provider fetch 禁止。

截至本文初稿，只完成轻量语法检查，原生 SQL、HTTP、完整类型、构建与浏览器由根代理统一串行执行，本文不提前称通过。推荐保留旧 `v2-public-diy-compatibility-migration.test.ts`、`admin-diy-safety-migration.test.ts`、签到配置、FAB 管理与读取回归。生产上线、正式 MP/native 设备全局主题效果仍须分别验证；浏览器模拟不能替代真机或生产部署证据。最终数字与状态以冻结 manifest 为准。
