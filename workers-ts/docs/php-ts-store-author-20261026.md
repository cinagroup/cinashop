# PHP → TS：提货点完整资料与营业、回收流程

本批接续已验收的用户标签迁移，补齐提货点路由的完整编辑、地区、图片与地图选点。整体 PHP → TS 迁移仍开放；本地验收只覆盖本批实现。

## 原件与范围

固定 PHP ref：`8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。原入口 `/admin/setting/merchant/system_store/list`，真实路由页面 `pages/setting/storeList/index.vue` 使用 `components/systemStore/index.vue`。活跃控件为 name、introduction、phone、address、detailed_address、day_time、image、latlng；latlng 分为经纬度两个值。保留当前 TS 的 valid_range（米）、is_show、is_store，共12个保存字段。原 valid_time 日期控件已注释，不计活跃表单。

PHP 控制器与表单存在混合版本：控制器要求账号/密码/ERP 字段，真实页面却没有相应控件；服务的保存返回形式也与控制器解构不一致。本批按真实活跃表单提供可执行流程，不新增店长凭据或 ERP 权限。既有银行、收款、ERP、数字地区 ID、推荐图、inactive 日期和店员凭据保持。旧 REST 接受完整旧详情里的未变化只读元数据，拒绝改变这些元数据及未知字段。

## 行为合同

- 编辑可以保留未变化的历史坐标、时间、图片、地区及旧状态；新建和显式变更执行新值验证。营业时间按两个 HH:mm:ss 保存，支持跨午夜，不使用 Date/时区转换；只在显式修改时更新 day_start/day_end。坐标允许零、边界和小数，拒绝非有限值及科学计数法。
- 省市区取完整 city_area 1..3 级名称路径，与 system_city 的数字 ID 分离，排除街道。父级、唯一 ID、同父同名等歧义拒绝；天然浅层叶子可确认；修改只写 address 名称串。
- 单一 image 是作者图片槽。当前平台图片元数据、稳定 canonical reference 和修改时共享锁共同确认可用性；原始历史值与可显示预览分离。公共门店实际生产者的既有 image/oblong_image 同样先核验当前素材再签名，不增加 oblong 作者控件。
- 专属 store.manage 只读图库、地区和地图配置不授予通用附件管理。地图仅生成固定腾讯选点 iframe 地址及浏览器公开 KEY。前端验证固定 origin、当前 iframe WindowProxy 和本地会话生命周期，候选单独确认后才更新经纬度，不覆盖地址。真实腾讯租户未联调；浏览器验证使用受控 iframe。
- 显式营业切换按 PHP 联动有效店员的 0/1 状态；普通资料保存中的 is_show 不额外联动。回收前保护该店 status 0/1/5 的订单，回收所有关联有效店员，恢复所有关联已回收店员，符合原件恢复范围。保留既有 TS 回收后停业、恢复仍停业的行为，页面确认明确说明。

## 数据库与恢复

新 `admin_store_operation` 独立九列不可变回执 addon：Admin 仅 SELECT/INSERT，App 无权，UPDATE/DELETE/TRUNCATE 即使维护身份也拒绝。显式 PG16 安装、故障回滚、精确复用和运行时审计；不在 HTTP/启动中安装，不扩大既有业务 DML。

事务按当前 authority barrier → 实时 store.manage（恢复使用 owner 身份）→ ERP advisory try gate `(731745,1)` → store ACCESS EXCLUSIVE NOWAIT → staff SHARE ROW EXCLUSIVE NOWAIT → addon ready → author gate `(731631,1)`。回收额外锁订单表以封住新订单。完整 store/staff/xmin 构成私有 revision，写后全行回读核对，触发器改动其它字段必须回滚。

旧表与已安装 customer-city 扩展的表结构都可执行。只识别完整基础列，或基础列加 business/city_shop_id 二列；半套或未知列拒绝。相同 profile 控制完整 SELECT、参数化 INSERT/RETURNING 与回读，基础表不补装城市配送 DDL，扩展表隐藏元数据不丢失。

浏览器在派发前持久化本账号完整 UUID/payload/hash；回执先核对原 UUID，再考虑目录版本。404 仍表示未知；只有匹配的 committed/not_applied 终态可清除记录。当前登录身份仍有效时，撤销管理权限后 owner 可读取或封存原请求。封存阻止迟到的写入；现代回收/恢复是明确操作，旧 delete URL 保留原切换兼容行为。

真实 Vue SFC/cacheHandlers/native listener 验证覆盖完整12字段、图库、地区、地图错误来源/旧窗口、actor/role/token/route/隐藏 tab/卸载退休、ABA、双确认、多 pending 与回执恢复。父页面保留既有店员与配送员流程。

## 验证与证据

最终结果见下方通过的日志、完整来源证明和输入 SHA 清单。验证均经过共享 serial wrapper，Vitest 单 worker；测试不使用生产库或真实地图 provider。来源层只对24个旧测试的读取导入增加最外层精确可逆映射；历史 proof/helper/doc 字节、旧断言与负例保留。API 清单由实际 AST 重建，不靠过滤构造合格报告。

没有执行生产 addon 安装、提交、推送、PR、合并或部署。上线前仍需由环境维护流程安装此独立 addon，地图浏览器 KEY 与域名配置、真实账号和设备需要环境联调。ADM-001、FE-001及整体迁移不因本切片关闭。

本批最终 3363 项唯一选测通过，其中新增 404 项：35 项受限 SQL 完整作者、15 项实际双前缀 Hono/JWT、45 项支持读取、35 项图片政策、3 项真实公共图片生产者、34 项不可变 addon、57 项实际 Vue/cacheHandlers/native 事件、1 项 PG16 两表结构完整用例、179 项来源证明。旧来源回归2572项，另有邻接运行时231项、既有消费者原生63项、前端回归93项。没有失败、跳过或取消项计入通过数。Admin vue-tsc、Worker严格tsc与Admin Vite生产构建通过。

浏览器使用现有 Playwright/Chrome（Browser plugin not available），入口 `http://127.0.0.1:5214/admin/setting/merchant/system_store/list`，1365×960、375×900、320×900。实际父页面完成编辑12值→完整地区确认→选图→受控iframe候选确认→保存；丢失响应→原回执恢复无重复提交；待处理订单拒绝→明确封存；回收站恢复仍停业；店员tab切换退休/重新读取。7图逐张检查，0warning/0pageerror，唯一console error为刻意模拟丢失响应的ERR_FAILED。页面身份、非空内容、无框架overlay、控制台、截图和交互6项均通过。真实地图provider、真实账号/设备与其它浏览器未验收。

真实 AST 清单741调用点/779变体，全部registered/executable，0未解析、未注册或受控不可用；原733调用对象全部保留，新增8个typed wrapper。来源证明 `workers-ts/audit/store-author-source-binding-20261026.json`，SHA256 `3f8470a2e741b2517959ec2be81eeaa9af808f048a1fdc6f12800e6ed8ea0c9f`：38完整修改前后像、22新增源、12固定PHP全文、1706历史证据原字节、25关键实现不变、24旧测试仅import适配。最终执行输入清单 `/tmp/cinashop-store-author/final-validation-input-manifest.json`，最终验收回执及输入SHA清单在 `/tmp/cinashop-store-author/accepted-validation-result.json` 与 `accepted-input-manifest.json`。临时数据库fixture0、集群和浏览器服务均停止后才验收。

复验中发现并修复：Hono规范化小写占位符导致旧营业切换权限拒绝；旧库无城市配送两列导致完整SELECT失败（生产代码现显式支持base/current，不在首个native阶段补DDL）；新HTTP测试按既有JSON业务码判断错误；native夹具订单号长度及新来源测试未用函数修正。浏览器临时脚本限定可见门店行、为受控iframe声明UTF-8，原组件无需因此变更。砍价自提24项回归使用原有PG16专用执行器，未以缺少原生定价能力的内存数据库结果冒充通过。旧断言与危险负例保留。

下一候选为核销员选人/头像拾取与完整作者，仅完成20份固定PHP/当前TS来源静态侦察 `/tmp/cinashop-store-author/next-scout/next-scout.md`，不计实现。现有店员七字段CRUD、真实用户/门店核验、去重与事务已存在，后续补齐用户选择、头像图库、原alias和owner回执；不照搬原controller创建时两个UID来源错序的缺陷。
