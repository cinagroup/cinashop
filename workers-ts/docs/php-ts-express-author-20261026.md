# PHP → TypeScript：快递公司完整管理流程（2026-10-26）

本批完成现有 `/express` 的目录查询分页、条件账号编辑、物流目录同步、显隐、新增和受保护删除，并连接已有电子面单消费者。只验收本切片；父项、整体迁移及生产发布保持开放。

固定 PHP：`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。开工前完整快照6051文件，manifest SHA256 `c59922e9545e23b4467f5430b81b80b33463eeaab1ca116833ee3326943d4cff`。保留上一批平台规则55份验收输入原值后再增量修改；未清理既有dirty tree。

## 实际流程与兼容边界

原活跃页面 `view/admin/src/pages/setting/freight/index.vue` 包含 name/code 搜索、查询、同步、显隐、编辑、page1/limit20。其新增按钮未激活、删除模板被注释；当前TS原有新增/删除继续保留并加强。顺序按PHP恢复为 sort DESC/id DESC。现代完整目录上限5000，搜索兼容 LIKE `%`/`_`，界面分页每页20；超过容量整批拒绝，不能返回一个有效前缀。

保留现代 `/express`，恢复原页面别名 `/admin/setting/freight/express/index`。两个Worker前缀均注册现代catalog/prepare/commit/receipt/resolve及原 `freight/express` list/edit/status/sync/resource适配。原GET同步实际会写，现在明确需要 `express.manage`；读为 `express.view`。原TS list/save/del委托同一服务。旧编辑表单不回显账号，空值表示保留；明确清空只由现代意图完成。新增/变更编码须合法且不重复；已有历史值保持原样时不擅自修复。

| 服务商要求 | 存储字段 | 页面标签 |
| --- | --- | --- |
| partner_id | account | 月结账号 |
| partner_key | key | 月结密码 |
| net | net_name | 网点名称 |
| check_man | courier_name | 揽件员 |
| partner_name | customer_name | 客户名称 |
| is_code | code_name | 业务编码 |

全部六项支持keep/replace/clear，隐藏项不默认为空。status由六个要求及实际非空值统一推导，不接受客户端强置。原PHP后三项表单虽活跃却未持久化、同步新行仅检查前三项，属于本批明确修复的原件缺陷，不能称旧源已完整支持。

## 同步协议

复用现CRMEB HTTPS、Worker Secrets、登录token缓存、10秒超时及禁止重定向策略；新增只读 `v2/expr/express`，没有调用签发或购买接口。原template/issue默认32KiB不变，catalog单独1MiB/5000行。固定PHP证据仅支持 `{status,data:{data:[...]}}`，未定义总数；无元数据只承诺本响应快照，界面明确提示，不能冒称服务商全部目录已同步。若有count/total须匹配，未完成或无法解释的分页元数据、尾部坏行、重复编码、缺六flags、超限、截断与超时整批拒绝。

prepare在数据库事务外读取远端，随后重验现场身份与原目录版本。commit使用同一签名快照，不二次拉取。同步仅更新既有flags和派生status，保留已有name/code/sort/is_show及全部账号；插入缺失编码，不删除远端未返回的本地项。任何冲突或坏资料均事务回滚，没有静默跳过后宣称整批成功。

## 秘密、回执与权限

旧TS列表的整行SELECT曾把六个账号字段序列化；现明确DTO只返回基础值、要求及configured位。详情、旧编辑表单、prepare响应、receipt和浏览器journal不含六原文。替换payload仅留当前页面内存和必要请求体，不落localStorage、日志、Queue或DLQ。原job的明文carrier_config快照和既有表级SELECT ACL保持；本批没有实施数据库加密或列级隔离。

prepare只读，返回APP_KEY HMAC签章，绑定actor、原凭据、UUID、operation、target、目录HMAC版本、期限及payload keyed commitment。浏览器确认前不写journal，确认后先持久化非秘密ticket再commit。目录版本也使用HMAC，避免持久化可离线猜测低熵账号的裸hash。

commit在同一事务完成账号/目录写入、完整回读和不可变回执；原UUID匹配先于版本过时检查，精确重放不重复写。404不是“未应用”。显式resolve与commit共同串行化：已完成返回原回执，否则写terminal not_applied，禁止迟到的同UUID提交。刷新后丢失秘密payload，不伪称可无损重发；同页原草稿只在明确查回执后允许手动原样重试。撤权后仍允许现场身份有效的原owner读回执和封存；新凭据可封存旧签章，不能重放旧凭据提交。同actor多标签UUID记录逐条恢复，不覆盖或删除另一条。

所有写操作前后重验现场管理员凭据、realm、权限、角色历史和期限。catalog/prepare验证实际受限运行连接的回执SELECT/INSERT能力；不能以仅检查表存在冒充write_ready。

## 数据库维护与引用保护

新增独立 `admin_express_operation` 九列不可变addon，无秘密正文、无新目录表或carrier安全定义函数。Admin仅SELECT/INSERT，App无权限；UPDATE/DELETE/TRUNCATE触发器及精确catalog/ACL检查拒绝漂移。运行时不安装、grant或修复。显式PG16维护入口：`workers-ts/src/migrations/runAdminExpressUpgrade.ts` 的 `runAdminExpressUpgrade(db,target)`；须已有精确current运行profiles和明确database/maintenance/app/admin身份。尚未在生产执行。

锁序为staff/role authority → carrier → receipt/引用；create/update/sync/delete使用短ACCESS EXCLUSIVE NOWAIT，显隐用SHARE ROW EXCLUSIVE NOWAIT。网络不占DB锁。删除同时取得config SHARE锁，保护全部状态的waybill job、平台及所有门店/供应商默认快递，并保守拒绝相同编码的发货历史；配置JSON字符串、前导零和Number可识别的数值形式不能漏掉，坏配置拒绝。序列不重置、不复活旧ID。阻断态job存在时，身份、账号和flags变更拒绝；排序仍可修改。隐藏不会取消已准入的任务。Admin/Supplier冻结配置与customer签发前复验的原有差异保持，既有job不重写。

## 验收

全部选定 **3155项唯一测试** 通过：后端/来源2563、既有前端564、新实际Vue27、独立PG16 native1。新增367项（实际SQL/Hono112、provider45、addon32、来源150、Vue27、native1）；重复执行不重复计数。Admin vue-tsc、Worker strict tsc、生产Vite构建均通过。最终CSS长表单修正后重验实际Vue、管理端类型、构建、GUI及22份来源套件；没有因CSS改动重复计入测试总数。

真实Hono/JWT覆盖两前缀、现场撤权、凭据/期限、六位64组合、keep/replace/clear、未知恢复、签章/类型篡改、过时目录、整批同步回滚、全状态job及默认配置/历史保护。PGlite session端口不冒充独立LOGIN；独立PG16.14完成显式commission/重入、真实DDL后中断回滚、受限App/Admin权限、业务原UUID回执/封存、普通消费者先读carrier再插job的竞争与删除拒绝、维护锁竞争及全前后快照。最终临时集群已停止且fixture剩余0。

实际Vue使用安装版本compiler/cacheHandlers和native listeners；覆盖会话/路由/卸载/ABA退休、条件字段、Storage失败、成功后下一笔未知不残留success、多journal及未知回执恢复。浏览器使用已安装Playwright/Chrome（Browser插件不可用），本地built页面 `http://127.0.0.1:5212/admin/setting/freight/express/index`，1365/375/320，8图逐张查看。验证身份、非空、无框架overlay、console、截图与实际交互；0pageerror/0warning，只有受控引用拒绝HTTP400与刻意丢响应ERR_FAILED两条已解释console error。长表单内部滚动，标题/取消/确认保持可见。受控HTTP端口不冒充真实部署或服务商联调。

全API为 **728 calls/766 variants，全部registered/executable，0 unresolved/unregistered/controlledUnavailable**，原723/761逐项保留。完整来源证明：`workers-ts/audit/express-author-source-binding-20261026.json`（SHA256 `049743be929dfeb9ef85d163f2b45d2f1bcadb722fdd8ec0e673e45f73948970`），35份完整修改前/后、16新增、12份完整固定PHP、1697份旧dated/helper原值、13份既有消费者/认证边界原值。21旧测试只适配最外层精确读取端口，原断言及负例保留，旧helper/dated证明不重写。

最终执行回执及输入清单：`/tmp/cinashop-express-author/accepted-validation-result.json`、`accepted-input-manifest.json`。本地真实账号/设备、其它浏览器、服务商当前线上分页合同/凭据、真实签发及生产维护未验收。无commit/push/PR/merge/deploy。下一候选只读准备，不能计作已迁移。
