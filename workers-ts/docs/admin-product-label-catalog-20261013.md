# 平台商品标签与标签分组完整工作流（2026-10-13，本地候选）

本批补齐平台商品标签和标签分组的 15 条已核实 PHP 业务合同，并提供 `/label/products` 管理页面。分组、文字／图片样式、排序、启停、商城展示、单项及批量删除使用同一受约束服务。原 `/label` 用户标签页面保留。新候选未发布；本文不关闭 ADM-003、FE-001 或整体迁移父项。

## 已核实旧合同

所有路径前缀为 `/adminapi/product`。

| 方法／路径 | 行为 |
| --- | --- |
| GET `label_cate` | 平台 group=2 分类分页，含 `product_label`；名称搜索覆盖分类 id/name 和组内标签 id/name |
| GET `label_cate/create` | 名称、排序新增表单；POST `product/label_cate` |
| POST `label_cate` | 新建分组，平台归属及 group=2 由服务器确定 |
| GET `label_cate/:id/edit` | 读取真实同归属分组的编辑表单 |
| PUT `label_cate/:id` | 修改名称／排序，同范围重名排除本人 |
| DELETE `label_cate/:id` | 默认 id=1 禁删；有任何关联标签时禁删；不隐式重分组 |
| GET `label` | 完整 snake_case 标签分页，支持 `label_cate`，零／空为全部 |
| GET `product_label` | 分类父节点＋标签 children 的选择树 |
| GET `all_label` | 平台 `{id,label_name}[]` 选择目录 |
| GET `label/form` | 标签分组选项和名称表单，POST `product/label/0` |
| POST `label/:id` | 0 新建／其他编辑；完整分组、名称、样式、颜色、图标、显示、启停、排序字段 |
| PUT `label/set_status/:id/:status` | 独立启停开关 |
| PUT `label/set_show/:id/:show` | 独立商城展示开关 |
| DELETE `label/:id` | 删除单标签；id 1..5 且属于分组 1 时默认项禁删 |
| PUT `label/dels` | 明确选中或有界筛选删除；默认 id 1..5 保留；引用冲突整批回滚 |

源码依据为 `cinashop-php/route/admin.php:1472-1473,1610-1630`；`app/controller/admin/v1/product/label/StoreProductLabelCate.php:39,57,66,92,102,125` 和 `StoreProductLabel.php:37,49,61,72,127,143,160,180,213`；对应 `StoreProductLabelCateServices`、`StoreProductLabelServices`、`CategoryDao` 和标签 model。旧页面 `view/admin/src/pages/product/label/index.vue` 及 `router/modules/product.js:93-97` 指向 `/admin/product/label` 与 `admin-storeProduct-label`；菜单数字绑定以本轮主报告的实际 install SQL 核对为准，不猜测编号。

资源额外声明 GET `label_cate/:id`，具体控制器与 AuthController 没有 `read`，底层 BaseController 和部分 helper 为 Swoole Loader 密文，继承行为仍未决。本批不据静态缺方法填 retired，也不将新候选详情行为计为已恢复的原 PHP 执行。

旧第一方页面 `index.vue:332-341,390` 的完整表单始终含 `id`，`api/product.js:682-685` 同时以该值拼保存 URL 并原样提交。旧 POST 保存入口接受可选正文 `id`（新增为 0），先严格校验它与路径 ID 数值一致，再移除该字段送入既有严格业务解析器；冲突、非法 ID 或正文 0 替代已有路径均拒绝。正文不能覆盖 URL，也不放宽其他写入入口或归属字段。注册 HTTP 验证使用含 ID 的完整旧新增／编辑正文，并核验不一致请求没有新增、覆盖或审计副作用。

## 归属、权限和事务

所有管理读写限定标签 `type=0,relation_id=0`，分组还要求 `owner_id=0,group=2`。未知、外域、其他元数据 group 的 ID 均拒绝；客户端不能提交归属。历史未分组标签可以读取，修复时必须选择真实平台分组，不自动改历史资料。

管理读为 `label.view`，写为 `label.manage`；商品选择树／全部选项采用专属 route-only 选择许可，可由已有商品查看或标签查看能力、合法的旧 numeric 选择 API 元数据推导，不能作为可存储角色字符串授予。编辑表单仍要求标签查看权限。现代 `/product_label/list,save,del/:id` 三条简化路径委托同一新服务，避免绕过分组、默认项、归属或引用检查。

只读在有超时边界的 `REPEATABLE READ, READ ONLY` 快照里重验真实账号、原密码摘要、到期时间及当前角色；计数、列表、分组和图片 metadata 属于同一次快照。写入复用既有 Admin authority 的 staff table barrier，并用 `resolveRoleAssignment(...,true)` 锁住当前授予能力的 numeric 菜单；菜单仅需要既有 `UPDATE(id)` 行锁能力，不授予 `api_url` 等语义改写权限。候选不安装能力、不在请求中执行 DDL，也不在权限不足时退化为无锁路径。

平台标签目录写入再持统一 scope advisory fence，创建／修改／移动／删除共用类别与标签行锁；同分组重名检查与更新在同一事务。完整返回值和实际归属逐字段检查，数据库静默重写或跳过操作不能假报成功；标签业务与审计同时提交，缺少审计回执则回滚。审计按真实业务路由记录 POST／PUT／DELETE，不把更新或删除记录成新增请求。

删除检查三种引用：当前 `store_product_relation(type=3)`、未删除商品的旧 `store_label_id`、导入历史 `store_product_label_auxiliary`。辅助表只作为不可破坏的历史引用事实阻止删除，不用于活动关联读取或双写。旧 CSV 的前后空白、十进制前导零和正号被识别（`010`、`+10` 都引用 id=10）；尾部分隔符或其他空段跳过。已解析十进制整数仅在等于待删 ID 时阻止删除，`0`、负数、超出标签 ID 范围或无关十进制 ID 不构成有效引用。历史非规范的非空 token（如 `0x0a`、`1e1`）使标签删除 fail-closed，需先按商品实际关联整理历史资料，不能丢弃异常段放行。当前商品创建的标签 `FOR SHARE` 与删除 `FOR UPDATE` 仍使用同一行锁协议。历史导入／维护必须协调现有 runtime，不把该应用协议宣称为所有任意 SQL 的数据库约束。

## 图片标签

文字样式完整保存文字／背景／边框颜色；图片样式必须提供受支持图片引用。后台票据、外链短签名、非 HTTPS URL、控制字符及未知样式拒绝。R2 输入统一成 `/api/assets/:id` 长期引用，在事务中按平台 attachment owner、模块、图片 MIME／扩展名等已有公共商品媒体政策核验并持 SHARE 锁；写入不持久化预览签名。

`ProductLabelAssetPolicy.resolveProductLabelIcons()` 复用 `publicProductPictures` 后按响应即时签名，管理 DTO 的 `icon_preview` 与公开商品 badge 都使用这个能力；持久 `icon` 保留长期引用。原有公开商品目录的两处 badge 读取由主进程接入并独立测试。不存在、已删除或归属不符的附件不会获得签名；此代码证据不等于真实 R2 提供商或线上媒体验收。

旧 Vue 页面只消费 `icon`，没有消费新增的 `icon_preview`；新 Vue 页面使用 `icon_preview` 展示授权图片，并继续提交、保存 canonical 长期 `icon`。旧端 R2 图片显示尚未完成真实端到端验证，不能从本批新页面及公共 badge 验证推导旧端已可预览，也不把临时签名改存到 `icon` 来掩盖该保留项。

## 前端和容量边界

页面提供分组侧栏／搜索／分页及完整新增编辑表单，显示默认项和未分组历史项；两个开关各自提交。批量操作最多选择 50 个当前页标签，默认项保留；引用冲突保留选中和草稿。分组／分页变化清除旧选择，会话变化清除旧资料、弹窗和草稿。同页或跨标签页会话更新都撤销旧请求；服务端明确拒绝权限或登录时立即清空弹窗／草稿／选择并锁定该会话的后续写入，重复刷新相同缓存权限不会解除，须更新身份或角色快照。原请求结果未知时冻结原内容，核对当前服务器事实或重试同一操作；完整核对通过前不变更编号或输入再写。

每页最多 100、偏移最多 10000；整目录／分组树最多 2000 条；批删最多 50；写入正文在读取流时限为 16 KiB 并拒绝无效 UTF-8。超过容量明确失败，不静默截断。`all=1` 仅接受已审查的分类筛选，超过批量上限要求缩小范围；不执行客户端任意谓词或整库无界删除。分类没有原独立 status 合同，本批不创造一个来充数。

## 验证和保留项

当前冻结源码复验：专属普通业务 10／10、真实注册 HTTP 4／4、PG16 独立 LOGIN 5／5、前端状态／真实编译 Vue setup 11／11，共 30／30 通过。Worker unit／runtime TypeScript 检查均退出 0；两端按锁文件实际 Vue 3.5.42 运行的 vue-tsc 和生产构建均退出 0，11 个前端用例也按锁定依赖复验通过。权限 6 和公开图标 2 个专属用例由主报告另行记账，不混入此 30 个计数。详细收据与冻结哈希由 `parallel-product-catalog-migration-20261013.md` 汇总。

普通和 HTTP 使用实际 SQL；HTTP 仅替换连接 factory 为自有夹具，保留真实 JWT、角色、注册路由、控制器及 SQL，不能据此声称独立实际 Hyperdrive。原生证明覆盖真实 SQL 权限、numeric 菜单行锁、并发创建、标签引用 SHARE／UPDATE 竞争、分组删除保护和原子批次。前端测试含真实编译 SFC 的 API／表单／会话事件。主进程按 frontend-testing-debugging 技能以 Playwright 验证桌面 1440×1000、手机 390×844 及服务端撤权，共 9 个流程全部通过，控制台错误为 0；Browser 插件／browser skill未列出，使用已有 Playwright，浏览器 API 为显式合成边界。

真实生产历史数据、最小权限安装状态、R2／Hyperdrive、受限角色完整页面 E2E、维护协调、容量和发布仍开放。没有执行生产 DDL、提交、推送或部署；未修改先前已冻结批次、迁移 checklist 或旧审计结论。
