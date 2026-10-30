# PHP → TS：商城用户分组旧入口与可恢复编辑

本批是现有用户分组迁移的增量。原业务CRUD、权限登记、全用户引用拒删与用户分配锁已在20261014迁移，本批不将这些既有能力算作新实现。整体PHP→TS、ADM-001和FE-001继续开放。

固定PHP原件为8ed2a5b139f9170dd11b0dff91803f2fd59e40a5。原页面/admin/user/group现在映射/user/groups并保持菜单选中。原PHP活跃表单只有group_name和隐藏编辑ID，分页10条；旧icons slot没有实际column或写入字段，本批没有增加图片、排序、状态、层级或企微功能。原四条/user/user_group/*与当前三条/user_group/*接口保留，三处旧调用对象和旧服务原字节不变；userGroups.ts仅将名称校验helper改为Unicode码点计数。原表单20字符与现代64字符仍是明确区别，不能把20误称为原PHP服务端限制。

新/user/group/author的catalog、commit、receipt/:operationId和resolve在/adminapi及/api/admin注册。目录user.view，commit user.manage，原数字227/263页面仍仅授查看，真实265 POST权限独立；恢复只豁免精确GET/HEAD receipt和POST resolve，服务重复验证live owner、realm、状态、凭据和期限。相似前缀、错误method、另一owner不能恢复。

唯一作者字段group_name：原串进入规范摘要，最多4096个Unicode码点；新增/变化值trim后非空、最多64个码点，拒C0/C1与未配对surrogate。完全相同的历史值可原样保存，包括空名称、空白或旧控制字符。64个emoji按64计数，输入不再受HTML UTF16 maxlength误伤。新API的raw预算不改变旧API合同，数据库varchar64不截断。相同历史名称不执行无必要UPDATE，不改变xmin。

完整目录读取两个真实列和每行xmin，包含全部分组，用SHA256私有revision识别其它行与ABA变化；公开只投影id/group_name。新作者20000条/16MiB是明确读取安全预算，不冒称PHP业务上限，不截断或伪造分页；达到20000仍可维护现有项，超限明确不可用。原分页API保留。当前UI完整目录按名称作不区分大小写的字面筛选、每页10条；65字符搜索不再静默使用旧关键词，超过4096保留输入并明确报错。

写事务先authority barrier及live user.manage，再原731621,0 gate、user_group SHARE ROW EXCLUSIVE NOWAIT、addon readiness、731638,1作者gate。实际目标FOR UPDATE NOWAIT与成熟assignGroup KEY SHARE竞争，删除检查所有user.group_id引用（含软删除用户）。保留UserSegmentationService和普通用户分配代码原字节，不扩展App或Admin的用户DML。写后核验完整两列目录，并在同事务写原user_group_catalog审计与不可变回执，任一错误全部回滚。

独立九列admin_group_operation只授Admin SELECT/INSERT、App无权；不可变触发器拒UPDATE/DELETE/TRUNCATE，包括维护连接。显式PG16 runAdminGroupUpgrade以731626,21门禁核验原current权限画像、精确表/函数/约束/触发器/sole ACL，中途错误整体回滚，重复调用只核验；HTTP和启动不执行安装DDL，不改变runtimeBusinessPrivilegePlan。

原owner完整非秘密UUID/action/hash在dispatch前持久化，回执精确匹配owner、UUID、操作、目标、摘要、revision与终态计数。先查询已存在的同UUID，再检查目录revision；missing404保持未知，不自动新POST。原样重试复用原命令；resolve写not_applied封存迟到提交。管理或查看权限撤回后，有效原owner仍能读取或封存。journal按owner+UUID逐条恢复、精确移除；role/token/session/route/storage/unmount以及输入和确认ABA使旧原生回调退役，迟到响应不清除另一个owner的journal。

原admin-user-groups-frontend五项测试原先只编译setup并调用旧页面成员；本轮保留五原title与行为目的，适配当前真实SFC/cacheHandlers:true/native模板事件和新协议。保留列表/名称格式负例、只读搜索分页不写、创建编辑与占用删除、无权不读与末页调整、迟到读取与会话替换；这些五项不算新增。权限目录旧case仅增加明确Group恢复family，其余24项原样；27旧源码套件正文和危险负例原字节保留。移动端39测试及生产代码本轮原字节不变，上一批的late-before证据只保留在旧Delivery proof中。

逐图检查首次自动浏览器结果后发现320/375px的名称列被挤为逐字竖排；固定PHP名称列minWidth600。最终CSS恢复名称列至少600px、表格至少800px，由表格容器横向滚动；浏览器重验会真实滚到操作列并编辑，弹窗和保存按钮保持在视口内。模板和脚本与首次全通过版本字节一致，前五项逻辑/类型门禁继续采用原通过收据；CSS与来源摘要更新后重新构建、运行全部3304源码断言和浏览器，旧截图/全通过结果及源码完整保留在before-responsive。

对回执表额外触发器的拒写测试实际由精确readiness在业务写入前拦截；该项只作为未审核addon拒写证据，不作为已执行group/audit之后的回执插入回滚证据。写后数据和普通审计失败回滚由独立用例验证。

本地唯一选测3520项通过，新增347。实际运行回归216项（后台与相邻149、实际原生事件前端60、独立PG16两文件7），完整源码断言3304（含3117旧断言、新187）。维护的旧frontend5已在最终状态单独复跑、按测试身份去重，仍只计原149中的五项；没有失败/跳过/取消计入通过。Admin vue-tsc、Worker两套tsc及Vite构建通过，所有Node/TS/浏览器验证经共享serial wrapper、Vitest单worker。

原生PG16使用真实独立Admin/App LOGIN，显式addon安装grant后人为中断确认表/函数/ACL整体回滚；精确重复安装、sole权限与不可变性核验通过。真实assignGroup在外层事务持KEY SHARE后暂停，新作者删除409且无改变，提交后引用拒删；反向在新作者原审计内暂停，真实assignGroup确实阻塞，作者提交删除后分配返回不存在且用户资金/积分/组别不变。原六项用户分组原生回归亦全过。fixture0，39701和5217监听已消失，数据库与浏览器服务已停止。

浏览器使用现有Playwright/Chrome，原因Browser plugin not available；http://127.0.0.1:5217/admin/user/group，1365×960、375×900、320×900。原alias与菜单选中、10条分页、64emoji历史原样保存、编辑、创建丢ACK原回执恢复、占用删除与404未知/显式封存、只读会话、窄屏编辑共10图逐张查看。身份、非空、无框架overlay、控制台、截图、真实交互六项通过，0warning/pageerror，仅刻意ERR_FAILED。

来源proof `workers-ts/audit/user-group-author-source-binding-20261026.json` SHA256 `3e4a3ec3fc684dc585d552247a0f5150302b7c38ce507fdd770c3de0bf64d777`，42完整前后像/16新增/11固定PHP全文/1715冻结前驱/28观察不变/27 import-only旧来源套件。API759calls/797variants零缺口，旧755调用对象及三旧userGroups包装逐对象保留。turn-start7181完整前像与其SHA保留；其中311份旧dist是生成物，仅从本批源码冻结校验排除，最终清单以本次构建的新dist成员代替，不伪称旧hash chunks仍存在。源码冻结输入6888份。首次最终类型检查仅因HTTP测试多余import报TS6133中断；删除该未使用import后重新绑定来源与冻结清单，再运行最终门禁，保留首次失败日志。验收/tmp/cinashop-group-author/accepted-validation-result.json，最终全输入accepted-input-manifest.json。

第一次最终自动流程八步全部通过后，逐张查看十图仍发现320/375宽度下名称列逐字竖排；自动通过未视为视觉验收。随后按固定PHP名称列minWidth600，仅修改表格min-width800/名称列min-width600的CSS，template/script原字节不变；来源helper仅刷新PROOF_SHA文本，proof重新绑定。`responsive-validate.py`只重跑Vite构建、28套来源3304断言和真实浏览器三项，最终八项收据中的前五项（60前端、旧frontend5、Worker两套类型及Admin类型）明确复用未受影响的首轮成功检查，没有声称第二次全跑八步，也未重复计数。首轮八步日志、十图、浏览器/来源报告及CSS修复前源码全文均保留在before-responsive，其原JSON字节不改、路径映射只用于历史解释。

首次83例SQL门禁中的两个失败来自测试默认actor101与请求owner100不一致，已修正所有相关正负例使用真实owner100，复跑149全过。另发现无maxlength的搜索输入超过64时模型静默忽略，已修为接收原输入、4096预算内查询/超出明确报错，并补实际原生事件回归，最终60全过。未以改变生产权限或删除危险负例掩盖夹具问题。

浏览器API为受控夹具；实际SQL、双前缀Hono/JWT和独立PG16 LOGIN为单独执行的证据。未执行真实账号/R2联调、生产addon安装、远端CI、commit/push/PR/merge/deploy。

验证过程另清理HTTP测试的一处未使用导入；失败类型日志保留，源码新层重发布后重新冻结并重跑类型与后续门禁。

下一批仅只读准备商品单位原入口与可恢复双字段编辑：现有CRUD、1349精确只读、平台隔离、全live商品引用保护及731611真实平台/Supplier保存锁保留。40份完整来源（12PHP/18TS/7旧回归/3验收前上下文）在/tmp/cinashop-group-author/next-scout，manifest SHA256 cd794beae17ed6fefe65bb0e4effcde66a462db7727866ad89546f5cc0292fdc；未实施、未测试、不计本批验收。
