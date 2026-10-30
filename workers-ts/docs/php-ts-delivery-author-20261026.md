# PHP → TS：平台配送员完整编辑与可恢复操作

本批接续核销员迁移，补齐平台配送员的真实选人、头像图库、五个持久值、原入口及双Admin前缀兼容。整体PHP→TS迁移、ADM-001与FE-001仍开放。

固定PHP原件为8ed2a5b139f9170dd11b0dff91803f2fd59e40a5。原入口/admin/setting/delivery_service/index现映射独立/order/delivery-people，使用order.view/order.manage，并保留门店页配送员标签。原PHP创建image为商城用户选择结果，编辑avatar从图库选取；UID、avatar、nickname、phone、status五个持久值完整支持。编辑UID固定；创建先规范化image.uid/image.image和隐藏uid/avatar，冲突拒绝，再复验实际选中用户。当前TS原先校验旧UID后可写入新UID的HTTP入口已替换；原StoreOperationsService保存帮助函数无HTTP调用，成熟旧服务字节保留。

创建昵称或手机号为空时仅使用已锁定当前用户真实资料，并再次校验；新增或变化手机号沿用当前TS合法11位大陆手机号要求。未变化的历史非法电话/状态/头像原值可作资料维护；新/变化状态严格0/1。原PHP硬删除不切回，沿用现TS is_del1/status0软删除，保留已指派订单、历史配送快照、资金和其它type/relation。启用复验status1/isDel0/deleteTimeNULL用户和平台重复身份/电话；禁用或删除允许清理悬挂身份。新建与增权拒绝重复未删平台UID/电话；既有重复只允许不增加权限的维护。

现代选人DTO限定uid/nickname/phone/raw avatar/safe preview/selection，page与limit严格且count/list同一RR RO事务；order.manage专属，不授予通用user/attachment管理。选择戳含uid、昵称、手机号、头像、status/isDel/deleteTime/xmin，提交仍实时锁并复验，不能作为授权票据。现代搜索仅精确UID或字面昵称；旧候选接口保留排除已有未删平台身份，同一SQL count/list分页，门店和供应商身份不混入。图库同平台raster元数据及用户附件type3/module3/uid归属校验，单独FOR SHARE NOWAIT；原值与安全预览分离，票据不持久化。user.avatar256和delivery.avatar250不截断，超长需另选图。

作者事务：实时authority barrier → order.manage（原owner恢复仅需有效登录）→ 原try gate(8214002,0) → delivery_service SHARE ROW EXCLUSIVE NOWAIT → addon readiness → author gate(731633,1)。与现有requireDeliveryScope实际SHARE身份栅栏兼容，不改变它的调用或锁顺序。全部scope的完整十列+xmin及关联用户最小事实/xmin参与revision；20000条完整历史和16MiB私有源上限明确拒绝截断。全scope写后回读和受保护用户/xmin回读防止隐藏字段或旁路触发器篡改。

独立九列admin_delivery_operation仅Admin SELECT/INSERT，App无权，维护身份亦不能UPDATE/DELETE/TRUNCATE；显式PG16维护入口runAdminDeliveryUpgrade验证原current运行权限、精确目录和sole grants，安装与授权同事务回滚，重复调用只核验。维护gate(731626,20)。HTTP和启动不安装DDL，业务DML权限计划不扩展。

浏览器先保存本owner完整非秘密UUID/action/hash再提交；先检查旧UUID回执，再比较过期revision。404仍未知，支持原样重试、读取回执和显式resolve封存；not_applied阻止迟到写。权限撤回后仍允许有效owner恢复。实际SFC/cacheHandlers/native事件覆盖连续输入、source/owner/token/route/tab/卸载退休、选图选人旧回调、UUID双击、丢响应、矛盾回执和journal留存。

旧GET状态路由保留并明确order.manage；HEAD不能修改状态。旧PUT状态和DELETE删除保持；订单指派、移动管理delivery/gain与delivery/keep等同前缀成熟路由独立保留。旧列表使用有界LIKE匹配，兼容%/_及SQL反斜杠escape，避免把用户通配拼成回溯正则。

本地唯一选测3598项通过，新增408：新后台193、实际Vue25、原生新作者1、来源189。本批后台与相邻运行时247、完整来源3117（含2928旧断言）、前端128（含103旧例）、移动端39、原生3文件67；没有失败/跳过/取消计入通过。Admin vue-tsc、Worker两套严格tsc及Vite构建通过，全部重验证使用共享serial wrapper、单Vitest worker。

独立PG16 LOGIN验证显式addon安装中途异常全回滚、重复安装精确复用、sole ACL和不可变回执、原UUID重放/封存、真实requireDeliveryScope在当前用户和delivery_service SHARE锁之后暂停，三个新作者新增/停用/删除均409且无数据改变；旧事务随后继续其受控订单INSERT。此受控INSERT证明身份锁兼容，不冒充完整订单API。原配送工作台读取及送达核销全套原生回归同时通过。旧App配送scope/读写核销代码保持原字节。fixture0，所有本批数据库和浏览器端口已停止。

来源proof `workers-ts/audit/delivery-author-source-binding-20261026.json` SHA256 `4693ddbd1f6231f53d0699729a372afae2a742d5222a338930e64d104c73dbf9`，41完整前后像/22新增/10固定PHP全文/1712冻结前驱/36观察不变/26 import-only旧reader与builder。原748调用对象逐项保留，实际AST755calls/793variants零缺口。最终运行输入清单在/tmp/cinashop-delivery-author/final-validation-input-manifest.json，验收输出为accepted-validation-result.json与accepted-input-manifest.json。

浏览器流程：原alias→固定UID编辑→图库→确认→丢响应回执恢复→真实用户DTO新增→筛选及375/320窄屏编辑/选人。1365×960/375×900/320×900独立入口9图及父页配送标签1图，共10图逐张查看，页面身份、非空、框架overlay、控制台、截图、交互六项通过，0warning/pageerror，仅刻意ERR_FAILED。Browser plugin not available，采用已安装Playwright/Chrome，http://127.0.0.1:5216/admin/setting/delivery_service/index。

验证期间修复：旧列表用户通配正则回溯风险改有界LIKE；原菜单720精确page/auth_type/auth/空API-method tuple只授order.view，双前缀真实数字角色正负例验证；两处新代码窄类型错误已修。26旧来源套件正文及原危险负例保留；两条旧runtime泛化目录断言在精确before快照确认同样失败后，维护为显式owner/profile接口清单和各组真实GET（单一POST-only组显式manage）witness，普通API仍强制权限登记，未改生产授权。移动端另两旧fixture在独立late pre-test-maintenance快照确认39/37/2后维护：原104/配送108完整注册名单从已冻结dated JSON校验SHA取得，验证四配送新增及当前后续页兼容；旧staff预览使用真实API与双资格DTO，确保确已进入确认后切角色的旧确认不得派发。其余37case与mobile生产代码保留，未伪造原pages.json字节或turn-start前像。浏览器为受控接口；SQL/Hono和独立PG16 LOGIN为另行执行的证据，不冒充生产帐号、真实R2或完整业务供应商联调。

下一批仅只读准备商城用户分组的原入口与可恢复作者：已有CRUD/权限/引用保护保留，补/admin/user/group alias、原UUID恢复，并统一现代名称64个Unicode字符的前后端计数。34份完整来源与固定Git blob在/tmp/cinashop-delivery-author/next-scout，不计本批实现或验收；文档账本为本批验收前的上下文快照。

未执行生产addon安装、远端CI、commit/push/PR/merge/deploy。
