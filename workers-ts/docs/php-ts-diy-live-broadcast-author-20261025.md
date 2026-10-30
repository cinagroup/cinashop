# DIY 小程序直播作者 PHP→TS（本批已验收，整体迁移继续）

本批接续已验收 seckill，迁移 liveBroadcast 完整作者。本批组件、真实目录、类型、四端构建、实际后台/H5浏览器及完整回归均通过。直播作者子范围已验收，整体 PHP→TS 迁移保持开放。

固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5` 的来源为 `wechat_live.vue`、`c_wechat_live.vue` 和实际公开 `liveBroadcast.vue`。完整 21 键默认仅将 `this.num` 替换为 `0`，compact JSON SHA `6664a484f43f723e3901d5b2439ecddb883d2fcb28d2f439ebf1fe27b0d6d829`。13 配置组共 25 个真实可编辑值，含两个类型敏感 checkbox、五个间距、统一和独立四角、三个背景色值，另保留全局 isHide。

新增独立 Admin 编辑器、只读预览及实际卡片，Uni Widget/Card/controller/API 和共享严格 DTO/四布局投影。HomeRenderer 的八个营销/直播家族均选择独立入口；旧通用 Commerce 注册集为空，旧 Widget/controller/config/API/data 保留。DiseList 只增加 import 和编辑器两行，无直播图片 canonicalizer。

导入数据不合并默认、不重写数值拼写、未知/隐藏/备用/超量字段、checkbox 字符串 ID、顺序或重复项。普通新数量 1–100；公开沿用 floor/clamp10000/min50/fallback10，零和微小值不发请求。完整元数据验证后原子写入。父回执匹配完整原 raw、actor/editor/page/published/revision/context，消费一次并在 nextTick 到期；异步替换、会话、ABA 和卸载使旧控件及迟到目录结果失效。

真实四布局：完整封面 400rpx；封面商品 332×236rpx 和 96rpx 商品；横滑 280×200rpx；首张 670rpx 大图及后续无封面紧凑卡。真实状态 101/102/103 使用原固定配色、预告时间，不添加不存在的状态颜色控件。Admin 375px 上限画布用 cqw 等比投影。

明确差异：保留现 TS 的真实商品价格和无固定“+5”行为，不恢复原 PHP 的字面量价格及假角标；长金额在原 96rpx 价格条内缩小字号，金额完整。图片四角显式修正为自身组 0/1/3/2，对应作者命名与 CSS 顺序；PHP 曾交叉读取背景第四角，旧通用 TS 曾使用自身 0/1/2/3。圆角模式恢复 PHP truthy string0，旧通用 TS string0 曾采用统一模式。上述修正完整记录，不声称旧实现像素或全部行为一致。

组件没有可编辑图片槽。房间封面、主播头像和商品图均为只读目录 DTO，不能取得图库、签名或素材授权，不保存至装修 JSON。原 Worker/Uni 媒体政策及原字体字节保留。原生图片/动作绑定局部不可变 descriptor，卡片以 native epoch 退役；新增测试使用安装的 Vue compiler `cacheHandlers:true`。

公开目录仅单次匿名 GET `/api/wechat/live?page=1&limit=N`，Admin fetch 不附带凭据，Uni 明确 noAuth。继续现有本地四表 producer：房间可见且未删、sortDESC/idDESC/phoneASC；主播最小可见未删 ID；商品原始本地关系保留重复关系及隐藏/删除商品语义。105/106→101、104/107→103。业务图片原字段不做附件查找/签名/续期，无 provider/KV/R2/Queue/数据库写入。严格消费端整批拒绝重复 ID、remote0、未知状态和超过 100 商品，不借本批改数据库、过滤或去重 producer。

客户端只在 MP-WEIXIN 展示和读取，H5/App 不展示、不请求。导航使用 remote room_id 与安全 uid/0 pid，不调用 SDK、登录、订阅、购买或 journal。现 manifest 未注册直播播放器插件；模板运行和微信构建不证明真实设备、租户授权或播放可用。

去重 **3,394 项** 全部通过，本批新增独立 **413 项**；先行目录、来源试跑与最终回归不重复累计。

| 范围 | 新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 145（模型/数据38、实际SFC107） | 771 | 916 |
| Uni | 120（实际Widget/Card、cacheHandlers:true） | 959 | 1079 |
| Worker | 148（目录49、来源/parity99） | 1251 | 1399 |

三端严格类型、Admin/H5/微信/App生产构建均通过；32文件单worker Worker回归保持全旧来源、媒体政策、目录和API合同。完整28modified/19full-add/0新素材资产；36旧dated/helper/fixture字节保持、73旧生产/服务/媒体/manifest来源保持。31固定PHP文本原件和34片段绑定，不把静态证明充作实际运行。

source `5851245158af821c0ec139aceb66b20494770a319cd20e0b079dff0cb8acece7`；parity `d63d5377d339cfc1f1c3108f43d13f6cc2aa751c8946e70bbf901fd9363c35a1`。实际TS parser API `15567ac85dbc1e6769cf116d8fc5ebb98752906dd5fc7d19c05775541e7b40f8`，仍703/741全注册可执行；只改DiseList sourcehash与三个旧调用行号各+2，旧路由/调用语义保持，旧dated证据/helper/危险负例内容保留；Renderer正例按新入口精确更新并可逆恢复。三端新专用命令、两条CI链只追加。最终53源码/证据在最后Worker合同前冻结、之后逐字节无漂移；较早成功步骤有独立时间收据，不谎称从冻结时点起运行。

首次Worker严格类型TS6133指出新增catalog夹具未用eq导入；仅删除该导入，无断言/用例/生产改动。失败日志、原core步骤/来源JSON完整保留于first-worker-types-attempt。之后重新封存当前来源、运行当前source/type与最终32文件完整Worker合同，重复运行不重复计数。

一次来源复查只有旧API确定性重算在6.579s后报STACK_TRACE_ERROR（另241断言通过）；原5s设置、源码和断言均未改，同字节续跑1.921s与较早1.676s通过。安装Vitest的timeout包装会复制该stack，故推定超时，但原JSON未保留cause消息，不声称已确定系统根因。原失败收据source-timeout-attempt保留，最终完整Worker合同仍须通过，重复运行不增计数。

首次浏览器脚本直接uncheck ElementPlus隐藏原生checkbox超时，页面0错误0警告；仅临时脚本改为点击可见label并断言实际checked状态、先blur最后数字控件。没有force点击、删除断言、生产改动或重跑不变构建。first-browser-attempt保存原日志/脚本/失败截图；最终同业务流程完整重跑通过。

长相邻回归首次工具session25718外部SIGTERM143结束，无最终汇总，主runner及task子runner不存在且共享锁已释放。partial正例不计通过，也不归因成断言失败或确定OOM。原片段/状态保留interrupted-remaining-attempt；立即后台监督仍使用同一serial wrapper/Node并发1/Vitest单worker完整重跑，不创建调度或绕锁，最终supervisor退出0与完整汇总共同验收。

新增Uni测试有1条resolveComponent必须在render/setup调用的harness警告；其独立compiled Renderer VNode断言在组件上下文外调用自递归Renderer，实际Widget/Card host mount使用warn/error捕获且断言干净。实际生产浏览器日志另列，不以harness警告宣称生产故障，也不将其静默删去。

实际生产Admin普通level1（仅dise.manage/view，无attachment grant）在1365×1000与390×844完成四布局/三色/四角/checkbox/错误空重试，以及2次真实GUI保存，15个本地业务请求，0错误/0警告。三类目录图片真实load，真实长金额文字bbox在原价格条内；375px上限与224px窄画布几何不溢出。保存21键完整默认和四独立组件，DTO不进JSON、独立content不覆盖、图库/asset请求0。

实际生产H5在390×844与1100×1100读取含四直播布局的DIY页，普通标题作为页面非空标识，刷新后仍0直播widget/0直播GET，26业务GET，0错误；仅既有Vue Router direct-dist warning共2次加载事件。H5不编造不可用播放器。全部API本地拦截，无真实数据库写入、租户/微信设备或插件播放验收。截图人工复核。极端10位金额在224px缩小Admin预览中计算字号约2.966px，本批仅证实完整金额不溢出，不声称该极端缩略价格可读或真实MP设备排版验收；合成MP native回调和微信/App构建证明代码路径，不证明真实播放可用。

来源、精确逆变换、运行日志和截图位于 `/tmp/cinashop-live-broadcast-author/`。旧 dated/helper/fixture 不改写；旧正向 Renderer 断言与来源/report 外层适配单独绑定。API 清单由实际 TS parser 再生成后核对，不能手填计数。

未 commit/push/PR/merge/deploy。剩余父项继续推进，当前文档不表示整体迁移完成。
