# SKU 规格模板 PHP → TypeScript 增量（2026-10-14）

本批新增 5 条旧 Admin 双 `product` 路径，并替换 10 条已有现代路径的 handler，使目录读取、编辑器回显、权限、写入生命周期与审计共用专用服务。整体迁移目标继续保持 active；本报告是已验证的本地候选，不关闭迁移父 checkbox 或代表生产验收。

## 路径与真实来源

| 方法 | `/adminapi` 下新增的旧路径 | 本批行为 |
| --- | --- | --- |
| GET | `/product/product/get_rule` | 旧商品编辑器选项，按条件解析 `rule_value` |
| GET | `/product/product/rule` | 旧 `{list,count}`，保留原始 `rule_value` 与派生属性 |
| POST | `/product/product/rule/:id` | ID 0 新建、正整数编辑，接收完整编辑器回显 |
| GET | `/product/product/rule/:id` | `{info}`，原始字段加 JSON 解码后的 `spec` |
| DELETE | `/product/product/rule/delete/:id` | 单条删除、完整业务与审计核验 |

现代路径共 10 条，均保留此前 URL 并替换 handler，未计作新增旧 PHP 路径。

| 方法 | `/adminapi` 下保留的现代路径 | `/api` 下保留的现代路径 |
| --- | --- | --- |
| GET | `/product/get_rule` | `/admin/product/get_rule` |
| GET | `/product/rule` | `/admin/product/rule` |
| POST | `/product/rule/:id` | `/admin/product/rule/:id` |
| GET | `/product/rule/:id` | `/admin/product/rule/:id` |
| DELETE | `/product/rule/delete/:id` | `/admin/product/rule/delete/:id` |

PHP authority 为 `cinashop-php/route/admin.php`、`app/controller/admin/v1/product/StoreProductRule.php`、`app/services/product/sku/StoreProductRuleServices.php`、对应 `StoreProductRuleDao.php` 与 model。实际消费者核对了旧 SPA 的 `pages/product/productAttr/index.vue`、`addAttr.vue`、商品编辑器、公共删除弹窗、`api/common.js` 和 Axios request 层；权限种子来自 `public/install/crmeb.sql`。专用 `AdminProductRuleService`／controller 替换旧通用 AdminCrud handler，供应商继续使用专用 SupplierProductRuleService 与独立归属目录，共享规格输入规范化和 731612 锁命名空间。

## DTO、完整回显和差异

原始目录字段为 `id/type/relation_id/rule_name/rule_value`，没有时间字段。旧列表按 ID 倒序，仅以名称 LIKE 筛选，不添加 ID 模糊查询，返回 `{list,count}`。原始 `rule_value` 保持数据库字符串；只有该字符串在 PHP 中为真时，才添加逗号连接的 `attr_name` 与每维逗号连接值组成的 `attr_value[]`，不额外添加 `spec`。

旧 `get_rule` 在原始值为真时把 `rule_value` 替换成 JSON 解码结果，并添加相同派生字段；原始 `null`、空字符串和字符串 `"0"` 保留原值，且不出现派生字段。真字符串解码为空数组、空对象、false、0、null 或无效 JSON 时，派生字段为 `attr_name:""`、`attr_value:[""]`，其中无效 JSON 解码为 null。旧详情始终返回原始五字段及 `spec` 解码结果，保留 null、标量和历史结构，不添加列表派生字段。

非空且为真的历史 JSON 若无法安全作为维度使用，例如标量或缺少字符串名称／字符串数组的行，旧列表和选项明确返回 503，详情仍提供解码结果供核对。这是有意保留的运行边界，不把不可用历史结构静默变成可选商品规格。现代投影继续使用已有安全解析：列表保留 `{list,count,page,limit}`、`spec` 与派生字段，选项提供解析数组，详情保留扩展后的 `{info}`；不能把现代投影当作旧 PHP 原始 DTO。

旧 `addAttr.vue` 把详情的完整 `info` 赋给表单并原样提交。保存因此接受合法的 `id/type/relation_id/rule_value/attr_name/attr_value` 只读回显，以及 `rule_name`／`ruleName` 与可编辑 `spec`。路径与正文 ID 必须一致，归属固定平台 0／0；原始值和派生字段在写锁内与现行记录比较，伪造、已变化或未知字段拒绝。原始字符串按字节内容精确比较；选项的数组回显与完整原始 JSON 解码结构比较，忽略对象键插入顺序，保留数组顺序、值及未知键，递归比较限深 8。编辑不会借回显字段改写归属。

新正文要求 1～3 个不重名维度，每维 1～50 个不重复规格值；模板名和维度名最多 32 个 Unicode 码点，值最多 64 个。字段别名可使用，但冲突别名、未知维度字段、控制字符和孤立代理字符拒绝。旧 UI 的模板名 20、规格输入 30 字符提示不替代 API 约束。PHP controller 的 `if (!$rule_name)` 对字符串 `"0"` 的拒绝在旧接口保留；现代接口仍允许该合法名称。正文上限 64 KiB；查询仅接受唯一的 `rule_name/page/limit`，分页最多 100 条，ID 和偏移有整数边界。完整选项最多 2000 条，超限明确拒绝，不静默截断。

旧删除弹窗配置含 `ids:''`，实际 `tableDelApi` 把 `data.ids` 交给 Axios，因此最终 HTTP 正文是空字符串。旧 DELETE 接受真实空正文，并额外兼容唯一字段为 `{ids:''}` 的对象；非空 IDs、其他字段、`{}`、null 或畸形 JSON 拒绝。现代 DELETE 只接受空正文。这项兼容不能误写为旧 Axios 实际发送了对象。

旧保存／删除消息分别为 `保存成功!`、`删除成功!`，当前 TS 回执省略 `data`；现代保存返回 `{id}`，删除返回 `null`。可读的 `crmeb/utils/Json.php` 使用默认 null data，并在 `make()` 中省略 null，controller 仅传消息字符串。继承的 `crmeb/basic/BaseController.php` 是 Swoole Loader 编码内容，尚未执行其转发逻辑；省略字段依据可读 JSON 默认，不能宣称已验证完整 PHP 运行时 envelope。

## 锁、归属、权限与审计

保存和删除共用 `731612` 事务 advisory fence，平台作用域键为 0，供应商为各自 relation ID；编辑／删除同时持当前目录行 `FOR UPDATE`。重复名称检查、只读回显比较、DML 和完整 `RETURNING`／业务回读在同一事务内执行。Admin 读取与写入均限制平台 `type=0,relation_id=0`，供应商目录按归属隔离，畸形或外部归属行不暴露或越权更新。PHP 详情及部分按 ID 写入缺少该归属条件，TS 的隔离是明确保护差异。

规格模板不是商品绑定外键。真实商品编辑器选择模板后复制维度，真实 `ProductAssociationService` 保存独立 SKU 快照；模板编辑或删除不重写已存商品的规格、SKU 标识、价格、库存或销量。目录 fence 证明保存／删除的提交线性顺序，不应冒充不存在的商品目录 SHARE 绑定。产品保存仍按当前商品 SKU 规则校验复制内容。 现代商品编辑器已有的 500 条规则候选与 200 个 SKU 组合界限继续保留；本批不宣称商品编辑器加载全部 2000 条目录选项，或任意模板组合都可套用。

Admin GET 在 `REPEATABLE READ, READ ONLY` 中复核当前平台管理员、密码版本、全部角色引用历史和 `product.view`，不写日志。写入采用现有权限表 barrier，复核当前 `product.manage`；末尾再次验证完整管理员与权限，并以数据库 `clock_timestamp()` 检查到期。SQL 限时 5 秒、锁等待限时 2 秒，事务内无外部提供商请求，响应使用 private／no-store。

目录与 `system_log` 同事务。core 校验完整业务返回行及回读，Admin 保存先捕获完整行，再写并核对完整审计返回和日志回读，最后比对审计后的业务行；删除在审计后确认任何归属的同 ID 行均不存在。跳过或改写业务 DML、审计拒绝／跳过／改写、审计触发器修改目录或删除后跨归属重建记录，均须回滚业务和日志。只校验写入前或审计前的效果不足以证明最终提交状态。 独立复核另复现了原审计遗漏 storeId／merchantId／adminName／ip 时，触发器可让三种写入提交错误归属日志；本批显式保留平台店铺与商户 ID 为 0、名称与 IP 为空字符串，并核对当前 schema 的全部 11 个非 ID 字段及正数 ID。普通与最小权限原生用例各执行 24 次 BEFORE／AFTER 改写，确认目录与日志回滚；原生序列探针证明触发器抵达。此处验证日志完整性，不宣称已记录真实名称或客户端 IP。

页面种子 `99` 仅以精确的 ID、`type=1`、`auth_type=1`、`menu_path=/admin/product/product_attr`、`unique_auth=product-product-attr`、空 API／methods 及启用访问元组授予 `product.view`。单条与批量 SQL 解析器保持一致；复制或改写该元组不能取得权限。种子 `580` 的 `/admin*` 通配挂接没有已证明的目录授权，本批不授予读取或写入，改写其 tuple 也不绕过拒绝。真实 DELETE API 种子 `197` 的 `api_url` 为 `product/product/rule/delete`，没有 `/<id>`；路径注册的参数和原始权限种子需分别记录，不能为满足预期改写来源。

## 独立复核修复

只读复核复现了两处可操作问题并由主线程修复：完整 JSON 回显曾受对象键序影响，且模板的 Unicode 码点上限与商品 SKU 的 UTF-16 长度检查不一致。现在完整原始解码比较允许合法键序差异，同时拒绝数组换序、值变化或未知键增减；真实 SKU 维度名称与值按码点检查，其他 SKU 可选字符串维持既有长度语义。 后续核对还发现供应商编辑与套用函数的 UTF-16 边界，本批继续修正专用输入校验与实际 Vue 消费函数；供应商原生 maxlength 属性也需与码点语义一致。该修正已由真实 JWT／SQL 保存、实际挂载规则库提交与 SKU 套用函数验证；规则库三处及商品编辑器一处原生 maxlength 已去除，保留服务端和提交时的码点边界。没有浏览器手工输入或码点计数器证明。

两个原先最小复现已独立重跑：逆序对象键的合法完整选项回显可保存，32 个 emoji 的维度名与 64 个 emoji 的值可进入真实 SKU 输入规范化路径。相应合同覆盖已补充；这两次定点复核不重复累计到最终测试定义数量，也不替代完整冻结后验证。

## 验证状态与交付边界

最终完整命令已成功；仅按最终测试定义去重，不累计初轮、修正或中断执行。

| 范围 | 最终结果 |
| --- | --- |
| 普通合同、实际 HTTP／Axios、既有商品与供应商消费回归 | 27 完整文件，21 有通过用例／6 条件文件；243 通过，69 条件跳过 |
| 独立 PostgreSQL、目录 fence、真实 SKU、业务／审计触发器 | 16 完整文件，185 通过，零跳过 |
| 去重与补验 | 243＋185－116 重合＝312；69 条条件项全部补验 |
| Worker 完整 unit／runtime 类型检查 | 两套包脚本标准 8192 MiB tsc，均退出 0 |
| Admin 完整类型与生产构建 | vue-tsc -b 与 vite build，均退出 0；281 项 Admin 源码、配置和锁文件与构建时完全一致 |
| Supplier 完整类型与生产构建 | vue-tsc -b 与 vite build，均退出 0 |

最终 3330 项 Worker、Admin 和 Supplier 迁移输入前后摘要均为 `97691ada96267688e4b6d69cce4a12b92d0ac7b5428f01fe661bce7ee4c36a89`。六个本任务独立集群均以 pg_ctl 退出 3 确认停止且无 postmaster.pid；成功测试集群夹具为 0，两次工具 host 中断的严格匹配遗留测试数据库已分别离线清理并验证为 0，未读取凭据或启动网络监听。完整命令、退出状态、原始报告、输入摘要与失败／中断历史见 [验证账本](../audit/php-ts-rule-migration-20261014.json)。

冻结清单覆盖声明的迁移源码、配置和锁文件，不是完整 Vite 构建输入图。Admin／Supplier 的 `index.html`、public 静态资源、环境与已安装依赖的文件内容未纳入该清单；281 项 Admin 比较也仅限源码、配置和锁文件。因此摘要不证明全部构建输入的字节冻结，完整类型检查与构建退出 0 则由各自命令回执独立证明。

[独立交付复核](../audit/rule-20261014/delivery-independent-review.json) 已通过上述本地候选证据核验：复核时原有 91 份回执、声明输入与 PHP 来源摘要、测试定义去重及补验、类型与构建回执、真实消费链的局部证据、完整审计字段与回滚、当前集群状态及 checklist 逐行不变；未重跑完整检查或启动数据库，保留本报告的证据边界。

失败与修正历史继续保留：初轮 HTTP 套件因测试依赖的 Axios 包加载失败，不能按已执行普通用例的结果宣称该套件成功；初轮共享静态回归对未变化 HEAD 的 `ProductSpecifications.vue` 使用了已过时函数名、变量名及引号样式断言，修正保留导航断言与 mounted 消费行为检查，没有为消除该失败修改产品行为；初轮 Worker 类型检查发现 Unicode 规范化后遗留的未使用 helper，删除 helper 后仍需两套完整终验。先前静态采集器使用错误 authority key 的命令也保留修正记录。原始失败、修正、输入摘要和最终命令见 [验证账本](../audit/php-ts-rule-migration-20261014.json)。

全局路由审计在 unchanged HEAD 已有 `/api/get_script` 注册与退役决定冲突，本批不放宽审计器或提供新的全局覆盖率。HTTP 使用真实应用、JWT、服务、SQL 与实际 Axios 消费链的本地适配器；该证据及 Admin 编译仍不能替代完整浏览器或正式账号验收。

同一仓库本批没有提交、推送、生产数据库操作或发布；不调用支付、微信、短信、R2 等实际提供商。整体迁移目标、迁移父 checkbox、全库 CI、真实运行时／设备／数据验证、生产发布与旧 PHP 下线继续开放。
