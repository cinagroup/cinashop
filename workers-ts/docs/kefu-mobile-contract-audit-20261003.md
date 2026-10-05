# 客服移动合同独立审计（2026-10-03）

本文件记录 PHP 权威、完整移动闭环验收要求及本阶段仍未验证的边界。审计人员仅拥有本文件和 `test/kefu-mobile-independent-contract.test.ts`，不修改应用源、共享 checklist、旧缓存或旧启动资源。

## 证据范围

- 新文件创建前于 `2026-10-03T12:53:05.9831281Z` / `12:53:06.0792133Z` 分别以 `Test-Path -LiteralPath` 确认上述两路径不存在。
- Root 已报告 incoming baseline `.cache/kefu-mobile-incoming-20261003.json` 实际退出 0：298946 inherited rows，46 历史 build、16543 文件。本文件不重复扫描或替代该证据。
- 初次结论来自编辑前实际源码读取；后续实现状态和测试结果必须另外记录，不把初次缺口静默改为通过。
- HTTP URL 已映射、构建成功、文本匹配和 mock 登录通过，均不单独证明真实移动页面、菜单角色或生产 provider 已完成。

## PHP 权威与入口

| 合同 | 权威文件（相对 `C:/cinagroup/cinashop-php`） | 语义 |
| --- | --- | --- |
| 客服菜单资格 | `app/controller/api/v1/PublicController.php:138,161,194,206` | 绑定用户 UID，客服 `status=1`、`account_status=1`；旧 `/kefu/mobile_list` 转为站点外部 URL |
| 手机经营资格 | 同文件 `:162,198`；`app/services/message/service/StoreServiceServices.php:113` | `customer` 标注“手机订单管理”，旧 work 查询未要求 `status=1`；不能当作门店经理或与客服角色合并 |
| 移动列表路由 | `view/admin/src/router/modules/frameOut.js:34` | `/kefu/mobile_list` → `pages/kefu/mobile/chat_list.vue` |
| 移动聊天路由 | 同文件 `:44` | `/kefu/mobile_chat` → `pages/kefu/mobile/index.vue`；query `toUid`、`is_tourist` |
| 专用 API 路由 | `route/kefu.php` | `/kefuapi/user/*`、`service/*`、`upload` 等要求客服认证 |
| 专用身份 | `app/controller/kefu/AuthController.php`；`app/http/middleware/kefu/KefuAuthTokenMiddleware.php`；`app/services/kefu/LoginServices.php:51,63,84` | Kefu token 类型及当前客服身份，与商城用户/Admin token 隔离 |
| 列表 | `app/controller/kefu/User.php:52`；`app/services/message/service/StoreServiceRecordServices.php:42` | 按当前客服 owner、游客域、nickname、page/limit 查询 |
| 历史 | `app/controller/kefu/Service.php:274`；`app/services/kefu/KefuServices.php:75`；`StoreServiceLogServices.php:227` | peer UID、游客域、upperId 较早历史 |
| 未读/在线/消息 | `app/webscoket/BaseHandler.php:102,179,187,198,284`；`handler/KefuHandler.php:41,87,129` | 当前查看清未读；退出聊天 `to_chat id=0`；旧消息包含图片、商品、订单、退款 |
| 话术与转接 | `app/controller/kefu/Service.php:46,63,85,111,142,165,177,213,253,302`；`app/services/kefu/KefuServices.php:90` | 公共/个人分类与话术，在线有效目标，来源/目标通知 |

当前 `view/kefu-ts` 的真实会话页面是 `src/pages/WorkbenchPage.vue`。`/messages` 的 `InboxPage.vue` 是系统提醒，不是旧 mobile_list/mobile_chat 的替代。Root 本阶段采用 `PUBLIC_KEFU_ORIGIN` 加真实 active Kefu role 的用户中心外链：未配置则隐藏；不新增 Uni 页面，不转交商城 token。旧 customer/work 角色继续保持未完成。

## 完整最小闭环

1. 旧 list/chat URL 有真实路由映射和不同移动模式；登录 redirect 保留合法 peer/游客域；返回列表取消活动查看。菜单和直达页的客户端状态不能充当服务器授权。
2. 两身份域分别支持完整 cursor 分页、服务器 nickname/手机号搜索、清空搜索和重试。身份是 `(kefuUid,toUid,isTourist)`，不能仅用 record ID 或数值 UID。摘要按最新消息更新，乱序旧消息不回退；重复页/事件不生成重复身份。
3. 历史支持首次和 upperId 更早分页、稳定有序合并、去重、终止与重试。A→B、游客→注册同 UID、转接、注销、卸载都使旧成功和旧错误失效。
4. 两域后台持续接收新会话、未读和转接；只有严格 `(uid,isTourist)` 当前聊天计 viewing。列表模式和后台订阅 `toUid=0` 不清未读。仅服务端确认清已读，投递失败不能计 viewing。
5. 实时连接保留当前 token/实例隔离；禁用、撤销、改密、绑定用户失效后 HTTP、心跳及下行均拒绝。在线状态有服务器确认和失败处理；自发消息发送/阅读状态须对应真实证据。
6. 文本、图片和话术可从真实移动页操作。上传后再核 token、peer、游客域及归属；旧上传不能发往新会话。附件使用归属校验稳定引用及签名读取。公共话术只读，个人写操作限当前客服，分类/话术迟到不跨分组。
7. 转接目标是其他有效在线客服；保留幂等 key 重试。提交后来源旧 HTTP/WS 归属立即失效，目标会话正确出现；重复转接和迟到未读不能复活已移出的来源会话。
8. 保留旧 `msn_type=5/6/7` 的可读类型摘要和商品/订单/退款上下文详情；旧表情安全兼容。源码里存在 context API 不等于聊天消息卡片已完成。
9. 扫码/OAuth 保持 Kefu audience、poll token、state/verifier、Cookie 和重放防护。正式 Kefu Origin、全局 CORS、Pages 同源 HTTP/WS proxy、微信 callback 和真实提供方分别验收；Origin/UA 不是加密身份证明。

## 首次审计发现（编辑前）

- 每域仅取 60 条并丢弃 next_cursor；列表搜索仅本地筛选。历史仅取 60 条，没有较早消息操作。
- openSession 未隔离迟到 history/userInfo/labels；先清本地未读。上传捕获旧 session，但发送使用 socket 当前游客域。
- 旧 socket message 监听不检查当前实例。transfer 以 record ID 去重，与普通列表身份不一致。
- Core sessionList join 注册 user 时未限制游客域，游客与注册同 UID 会混用昵称/头像。
- DO deliver/transfer 过滤 socket 当前游客域，另一域通知丢失；mobile back 仅隐藏 chat，仍算 viewing。switchConversation 原先拒绝 id=0。
- DO deliver 原先在 socket.send 前增加 viewing；抛错后 handleChat 仍可能清已读。
- availability 固定初值 true，先本地切换；自己消息固定显示 ✓✓。5/6/7 仅裸 ID 文本；个人话术完整编辑/分类管理交互仍缺。
- 不得把历史 `store_service_record.type=2` 当客服角色证明：PHP `BaseHandler.php:81` 从 handler 参数取得 formType，`Manager.php:103,195` 从 request/frame 的 `form_type` 传入，`BaseHandler.php:214` 写入 saveRecord；旧 mobile 列表模板将 0/1/2/3 显示为 PC/公众号/小程序/H5。TS 新 runtime 使用 senderRole 写 record.type，并不证明迁移历史中的同数值类型具有该角色语义。在线状态应以专用客服身份及 `store_service.online` 为权威，不能用旧来源 type 跨域批量改写 presence。

## 独立验证要求与记录

独立测试不得仅以 source regex 证明行为。计划直接执行实际 `ChatRoomDO` 类的投递方法，用窄 socket/context/service 替身控制同 UID 两域、后台订阅、发送失败及撤销；这证明被执行的方法行为，不冒充真实 Cloudflare hibernation、网络投递或 PG 授权测试。

必须保留首次失败输出，以 fresh 名称记录后续运行。若运行 native PG，应记录新 cluster、ordinary LOGIN 角色、连接身份、stderr、status-3/no-response 和 cleanup；不得复用历史 PG 进程。

独立运行记录（所有文件保留，不覆盖前次）：

| Fresh artifact 前缀（相对仓库） | 实际结果 | 范围 |
| --- | --- | --- |
| `.cache/kefu-mobile-independent-tests-20261003-run01` | exit 0；8/8 passed；0 failed、0 skipped | 执行实际 DO 类的双域投递、后台无查看、客户域隔离、发送失败、跨域转接、strict transfer-out、撤销与非法输入 |
| `.cache/kefu-mobile-independent-tests-20261003-run02` | exit 0；15/15 passed；0 failed、0 skipped | 上述 8 项，加真实 frontend controller 的第二页/服务器搜索、同 UID 切域迟到成功、旧错误、upperId 合并、token 替换、转接后迟到、重复身份归一 |
| `.cache/kefu-mobile-independent-tests-20261003-run03` | exit 0；18/18 passed；0 failed、0 skipped | 新增同 token 新 session revision、移动 UID/游客 query 校验、合法目标保留及外部 redirect 拒绝；token/revision 的迟到验证在 reset 前断言，避免只测 reset |
| `.cache/kefu-mobile-independent-tests-20261003-run04` | exit 1；21/24 passed；3 failed、0 skipped | 实际 DO 在 transfer-out 后仍投递旧持久化消息、旧 transfer-in；实际 controller 在 remove 后接受旧摘要并复活会话。失败 JSON/stdout/stderr 全部保留 |
| `.cache/kefu-mobile-independent-tests-20261003-run05` | exit 0；30/30 passed；0 failed、0 skipped | 归属修复后负例通过；增加 payload 域授权、权威列表允许重新转入、3 个入口方法测试及 4 个实际 Workbench SFC setup/wiring 测试 |
| `.cache/kefu-mobile-independent-tests-20261003-run06` | exit 0；32/32 passed；0 failed、0 skipped | 新增重新转回后的旧 record ID 投递拒绝与旧 transfer-out 不误清当前归属 |
| `.cache/kefu-mobile-independent-tests-20261003-run07` | exit 0；32/32 passed；0 failed、0 skipped；已 superseded | 实际 DO 新增 message_id 的背景帧接入实际 SFC，同秒高/低 ID、旧时间、跨域脱敏摘要；9 关键源前后无漂移。随后发现旧 ID 的 unread badge 仍可能回退，故不作为最终冻结版本 |
| `.cache/kefu-mobile-independent-tests-20261003-run08` | exit 0；32/32 passed；0 failed、0 skipped | 同一 SFC case 增加实际 DO `303/num3 → 302/num2` 后 badge 仍为 3，缺 message_id 的服务端 read acknowledgement 才允许清 0。执行前 FE 已修；没有虚构先失败 |
| `.cache/kefu-mobile-independent-tests-20261003-run09` | exit 0；32/32 passed；0 failed、0 skipped；最终冻结 | 上述所有负例，9 关键源 before/after SHA256 无漂移；绑定 Workbench `0ea2b3ac...` 与独立测试 `2b58ad81...` |

每个前缀分别有 `.json`、`.stdout.log`、`.stderr.log`。首 run 执行时 BE 已落地相关 DO 修正，因此没有虚构“先失败”结果。run02 执行时 controller 尚在接入真实 Workbench SFC；通过仅证明该实际 controller 方法行为，不能替代真实页面接入验收。

run04 失败 JSON SHA256：`999c6e3da076d2d4a1e4188aa7c90c0ff872ebdd80e2e16cb73a060ff0e96bdb`。实际测试退出 1 后，后置 PowerShell hash 输出因数组组合格式报错；同一问题也使前置 guard 没有逐一检查三个真实输出路径，因此 run04 无有效逐文件 before receipt，不能补造。本名为首次选用且未重跑；另一次只读调用重新读取并 hash 三个已存在输出，未覆盖或替换失败结果。run05/run06 已改为逐 suffix 真正检查三条路径不存在后再执行。run06 JSON SHA256：`8262c6f0f202a0d7b94d2d17c104aad3c59d00a39b53d607349f163ffda6f3fd`。

## After 独立复核

- 实际 `ChatRoomDO.deliver` 与 `deliverTransfer` 现在调用 `KefuRealtimeService.canDeliverConversation`，按通知 payload 的 peer UID、游客域及 exact record ID 校验当前归属；不借用 socket 当前查看域。转接后失效事件丢弃而不关闭仍有效的客服 token；迟到 transfer-out 在身份已重新归属回来时也丢弃。窄 fixture 控制该服务返回的当前 assignment；真实 SQL/ordinary LOGIN 证据必须引用 BE 的独立 native 测试，不能以本方法测试替代。
- 实际 `conversations.remove` 记录复合身份移出标记，迟到 unread/transfer-in 摘要不能重新插入；只有当前 token 的 ownership-scoped server list 可以恢复合法的新归属。实际 Workbench transfer-in 被标记拒绝后重新请求服务器确认。独立 SFC 测试执行真实编译后 setup、Vue 响应式、controller、session epoch 和 realtime client；仅 API 响应、router、lifecycle 注册和 browser socket transport 为受控替身。
- 4 个实际 SFC 测试分别证明：history 尚在等待时保留 server unread，收到服务端 0 才清；transfer-out 后旧 unread/transfer-in 不复活；同 UID 切游客域后迟到 upload 不发送；同秒低消息 ID 不回退摘要。最后一项直接将实际 DO `mssage_num` 输出交给实际 SFC handler，同秒 `301→303→302` 与较早时间 300 都保持最新摘要及 badge；跨域 message 为空并显示真实类型安全摘要。带 message_id 的旧 snapshot 整帧拒绝必须发生在 badge 写入前，不能仅保护 preview；无 message_id 的服务端 read acknowledgement 继续兼容。该执行方式没有渲染 template/DOM，不能称为浏览器渲染或原生 WebSocket 证明。
- `UserCenterPublicReadService` 以绑定有效 user 与 active `store_service(uid,status=1,account_status=1,is_del=0)` 给出独立 `capabilities.kefu`；Root 的普通 PG/Hono fixtures 覆盖三种 placement、`customer` 与客服角色分开、角色撤销、读事务一致性及实际服务方法。Uni 根据返回能力显示 merMenu 和 fallback 外部链接，打开链接不拼接商城 token；`noopener,noreferrer` 用于 H5，其他端使用已有外部 webview。
- 配置激活层严格要求 `PUBLIC_KEFU_ORIGIN` 为 canonical HTTPS Origin 且出现在 Kefu 和全局两个 allowlist，未配置不能借 auth/API Origin 回退。只读发现的非 canonical raw 配置加 app 绝对旧菜单目标组合已反馈 Root；现实际 after 的识别层以解析 raw Origin 做仅过滤的识别，激活层仍不允许它成为 destination/fallback。独立既有入口方法 case 补入 `/`、`/login` 非 canonical 组合断言；后续 final run 绑定修复源。
- 已删除客户与封禁客户不能混同。当前 `KefuCoreService.userInfo` 已明确过滤客户 `is_del=0`、`delete_time IS NULL`；PHP `UserServices.php:123` 的 getUserInfo 直接 dao.get，User 模型启用 SoftDelete，未按 status 剥夺授权客服查看历史。未加 `status=1` 不是凭据撤销漏验。实际 after 中 userInfo/labels/group 现在使用同一事务、与转接一致的 transfer→chat 锁及客户软删行锁，userInfo 还内含当前 grant EXISTS；spread nickname 也过滤软删。Product 私有购买/浏览的实际 SQL 已内含 owner EXISTS，防止 transfer-between-reads。随后复核确认客户软删但 owner record 仍保留时的私有行为缺口；BE 已补私有 WHERE 的 user `is_del=0/delete_time IS NULL`，正在以真实客户两种软删矩阵运行 native case。显式 store_name 搜索的公开 catalog 语义保持，不泄漏该客户购买/浏览历史。

独立类型检查输出也保留真实失败：`.cache/kefu-mobile-independent-types-20261003-run01` 全项目 4GB Node tsc 实际 exit 134（heap OOM），不是类型通过；run02 的 owned-test-root Compiler API 实际 exit 1，由于未包含全局 `worker-configuration.d.ts` 导致 WorkerBindings/Env 诊断，不能替代项目类型检查。Root 要求停止并行 TS 资源后未再启动类型重跑；最终全项目类型结果只引用 BE/Root 的实际 full-unit 外部证据。

独立最终 run09 的实际结果：32 passed、0 failed、0 skipped、exit 0。JSON SHA256 为 `22cb1b6c38f0aca1f0b76ebb8a93388495e40281d1468e409bffd2c46f01da78`，13809 bytes；stdout SHA256 为 `a9de1bb76e2c3ce6b0e52a65efeef800ed49743196ccaf8f581d38d53a815cb8`，102 bytes；stderr 为 0 bytes。9 源前后 hash 检查来自实际执行 transcript `5b41eb`，mismatches 为 `[]`。独立最终 test SHA256 为 `2b58ad81c3b4ad3a334a6defb283b298ea7ec961059b120397e7b033d2e0cd3c`；FE 第二次冻结 Workbench 为 `0ea2b3acbe7ceeefe0d56d5d1fba147705cc86ed9cb64ce8884f448a7a099def`。

Root/BE/FE 的普通 LOGIN PG/Hono、全项目类型、浏览器/移动版构建和 production provider 证据分层引用各自 producer；不能由本 32 方法测试代替。本审计未启动 PostgreSQL、旧资源或部署提供方。

外部 producer 最终 pin（本审计实际读取文件并核 hash；下面执行结果来自其拥有者，不冒充本审计亲自运行）：

- BE：`.cache/kefu-mobile-backend-producer-final2-20261003.json`，SHA256 `b168ce774445d73734c687b7710f0d4d0ebcc97fffebb2bda9ab12d9d30c79a8`，13061748 bytes；23 项普通 LOGIN PG/Hono、35 项 retained 与 final full-unit/full-runtime 类型均 actual exit 0。native/retained 的输入捕获中，晚变更的独立 test `2b58ad81...` 为未执行外部测试输入，已显式记录；业务源保持稳定，最后 full types 覆盖当前独立 test，不把晚 test 编辑说成 native 中被执行。
- BE cleanup：`.cache/kefu-mobile-backend-cleanup-final2-20261003.json`，SHA256 `d2edbfe826e6c655a2eacb5f32e4795919946a444aa555cdcda4327df5bc74c8`，1915 bytes；6 个 fresh owned cluster 的实际 pg_ctl status 为 3，remaining 0。该记录由 BE 运行，本审计只 hash 绑定。
- FE：`.cache/kefu-mobile-fe-final2-producer-20261003.json`，SHA256 `44a6777bf6844b4103a64c3385419abc86bb0efb2eacaaa301f75e9fa435b6f6`，1129123 bytes；type、30 单元、11 实际 SFC setup case、fresh build、真实浏览器 8 groups/7 checks/0 console errors 由 FE 执行。独立 run09 已绑定其中 Workbench 的准确最终字节。

原生 workerd 的新协议测试启动时 access violation、0 tests 的失败仍保留；不能由方法/SFC/PG 成功转换为该原生协议运行成功。正式 Origin、角色生产样本、真实微信提供方和发布验收继续未完成。

生产角色样本、正式 Origin、真实微信提供方及发布验收继续开放；`menuRoleGates=false` 与旧 work/customer 覆盖不能因为本次移动会话合同通过而改成完成。
