# 微信二维码与海报迁移 — 2026-10-13

本批迁移旧 `get_qrcode/:type/:id` 的十种类型、推广海报前端工作流和 `wechat/follow` 关注海报。目标是可生成、可下载、可扫码落地并按当前数据库权限读取的完整业务模块。整仓 PHP→TS 迁移仍在进行；本文件不关闭其他迁移缺口。

## 状态

源实现已落盘，主协调任务已统一注册以下五条路由。实际 `createApp`、真实 UserJWT 与 SQL fixture 的 HTTP 回归 9/9 通过；本轮分享/扫码冻结副本的普通 13 文件 167 项及 Worker 单元、runtime 两组类型检查已通过。主线继续新增员工邀请等源码，本轮结果不覆盖这些后续新增项。未部署、未调用真实微信业务 provider，也未进行真实设备验收。

| 合同 | 实现范围 |
| --- | --- |
| `GET /api/get_qrcode/:type/:id` | -1 分销，0 商品，1 秒杀，2 砍价，3 拼团，4 积分，6 预售，7 新人，90 本人会员码，91 本人订单码；保留 `{routineUrl,wechatUrl,site_name,nickname}` |
| `GET /api/share/code/image/:token/:channel` | 短时签名 raster 图片；先核验参数/签名，后限流、读取和复核业务对象 |
| `GET /api/share/scene/:token` | 解析不透明分享标识并核对当前分享对象；私人目标仅本人或真实已有经营读取身份可以解码；返回当前核验的 `h5_origin` 供原生扫码核对来源 |
| 微信订阅/扫码回调 | 签名场景导向真实 landing；临时/永久场景重新核对当前对象，不从事件直接暴露私人业务码 |
| `GET /api/wechat/follow` | 保留 `{path}`，生成可下载 JPEG 关注海报 |
| `GET /api/wechat/follow/image/:revision` | 15 分钟签名图片地址，读取时重新核对配置、附件归属和源字节 |
| UniApp 推广页/分享消费者 | 模板选择、真实头像昵称、生成、预览、保存、失败重试；账号/会话变化与页面隐藏后清理迟到结果 |
| `GET /api/user/spread_info` | 保留推广页资料，当前本人头像或平台头像、平台模板生成新签名附件引用；真实只读快照后复核当前账号和媒体 |
| `GET /api/user/routine_code` | 保留 `{url}` 绝对下载地址；独立永久小程序目标、短时签名图片下载与当前账号/配置核验 |
| `pages/share/landing` | 小程序 `scene=q=<24hex>` 与 H5 `q` 落地；登录后的推荐关系处理、私有码进入已有查询工作台 |

新通用分享事件使用已签名的 `ls:` 场景与匹配 ticket，由已有回调 ledger 处理推荐关系和落地消息。新 cache 域不写旧 `qrcode.scan`，也不纳入微信公众号渠道报表。已检查现有渠道运营消费者：列表使用 `wechat_qrcode.scan/follow`，统计使用 `wechat_qrcode_record`；其成熟渠道投影路径保持原实现。新分享事件不能冒充渠道统计。

## 关注海报

`WechatFollowBackground.ts` 保存旧 PHP `public/statics/qrcode/follow.png` 的原始字节，沿用现有项目许可。图片 31,828 字节、500×720；SHA-256 为 `a7b8bbfa8d35939d4042be2086113d293775dad60b208347371dc17b560a52c1`。Cloudflare Images 将二维码拉伸到 344×344，放置于 `(76,76)`，输出 JPEG。这对应旧 Canvas 的位置和尺寸。

配置从平台 `system_config` 的 `wechat_qrcode` 读取，按 `sort DESC,id DESC` 选取，保留旧服务读取隐藏配置的行为。多查询读取使用限时 `REPEATABLE READ, READ ONLY`；网络、R2 和 Images 操作均在事务外。

新附件引用 `/api/assets/:id` 必须属于真实平台附件：`type=1,relation_id=0,module_type=1,file_type=1,image_type=8`，canonical 路径与 `attachments/admin/1/` key、扩展名/MIME 一致。不会把任意用户、客服或供应商附件当作公共关注图。

旧相对 `uploads/…` 由明确的 `PUBLIC_H5_ORIGIN` 解析。旧图片域名/CDN 可通过 `WECHAT_FOLLOW_IMAGE_ORIGINS` 指定逗号分隔的 HTTPS origin；显式媒体 origin 可读取其 raster 对象路径。配置不接受重定向、凭据、查询参数、IP/本地 origin、SVG 或任意请求参数提供的 URL。迁移已带签名查询的旧 CDN 引用时，需要先提供可公开读取的固定 raster 图片或平台附件。本批未修改生产配置。

读取限制为 8 秒和 3 MiB，并校验实际流字节、magic、图片尺寸和像素数量。生成物写入私有 R2 `generated/wechat-follow/v1/<revision>.jpg`，不创建 SQL 附件、不修改配置。配置或附件在 Images 操作期间变化，结果不会保存。签名下载重新取源字节；同一附件内容被替换会使旧地址失效。响应为 `private,no-store`，公开入口还有每来源和全局 Durable Object 预算。

## 验证边界

开发阶段关注海报定向 suite：19/19 通过，含真实 PGlite SQL、原背景摘要、几何合同、附件隔离、签名与失效、配置竞态、超限/不合法图片、来源限制、限流拒绝和 stalled stream 取消。

此阶段 Images/R2 是合成绑定；几何合同测试不证明真实 Cloudflare Images 的渲染像素，也不证明生产配置已具备来源、权限或额度。微信 provider 使用受控本地响应，不发送真实业务请求。原生 PostgreSQL、全编译输入冻结和真实页面的最终结果将在本文件追加，不以开发阶段通过代替最终验收。

前一物理候选的原生 PostgreSQL suite 为 5 文件 48/48：私人扫码普通 35、私人原生 3、通用分享原生 3、关注海报原生 2、成熟商品分享回归 5。专属 PostgreSQL 16.15 实例的测试数据库和角色已清理，服务已停止。该候选随后新增了 scene 来源字段、海报资料媒体读取及原生工作台扫码解码；48 项结果保留为历史候选证据，不能代替新增输入的最终验收。

扩展原生阶段实际 8 文件 105/105、exit 0，耗时 85.09 秒：上述 48 项加海报资料普通 46、海报资料原生 2、实际注册 HTTP 9。2914 个本机物理输入前后摘要相同，33 个直接输入与源文件相符。独立 PostgreSQL 16.15 测试数据库、角色剩余为零；停止后独立 `pg_ctl status` 为 3、输出 no server。该阶段早于下述读取兼容修改，不能借其结果覆盖新修改。原始证据见 `audit/legacy-share-final-native-01a1332d-20261013/native-eight-summary.json`。

### 已有会员码读取兼容

本批为客户显式 `member-barcode` 和配送的非 12 位码读取补齐成熟会员码允许的空格、`#`、反斜杠、`?`、`&`、`/`。仍按数据库实际 `barCode` 精确查询，复核当前经营身份、scope 和配送分配。客户原有显式 ASCII 会员码（包括 12 位值）保持可读；自动命名空间的 ASCII 与碰撞拒绝、订单及实际核销写入的 12 位码合同保持原实现。90 类型二维码自身沿用成熟生成规则，不发出 12 位会员码或字面值 `undefined`。

新增真实有限权限 LOGIN 的客户、配送只读 case，连同已有客户 N04 命名空间碰撞回归，实际 3/3 通过，70 项非选定测试跳过，exit 0，耗时 21.91 秒。2977 个本机物理输入前后摘要相同，21 个直接源输入相符。case 只更新 fixture 会员码；读取前后账户、订单、购物车和金融账本无变化，特殊会员码不能进入严格的金融写入意图。数据库、角色清理为零，独立停止检查通过。该结果不声称运行完整金融套件。证据见 `audit/legacy-share-read-compat-01a1332d-20261013/read-compat-native-summary.json`。

上述 Native3 保留为早期读取兼容候选。后续实际 PostgreSQL 工作台 DTO 暴露了配送 context 与 writeoff info/records 使用不同快照标识的问题；页面按已有标识比较规则拒绝真实查询结果。`DeliveryOrderWriteoffService.read` 现使用已有 `deliveryReadConsistencyKey`，在真实只读事务内与工作台保持同一读取合同。当前 source guard 已核对服务和测试字节；新增 context case、客户/配送会员码 case 和原有客户 N04 实际 4/4 通过，70 项其他测试跳过。2982 个本机输入前后摘要相同，实际两个配送 scope 的六次读取事务保持只读，辅助表与金融账本无 DML。独立实例数据库、角色清理为零，停止检查通过。证据见 `audit/delivery-shared-read-key-01a1332d-20261013/`。这不是完整金融套件验收。

客户、员工、配送三个扫码页已经支持私人分享目标进入已有查询流程；账户、会话、页面、30 秒时限和一次性转交约束保持有效。未知实体会员条码中的反斜杠保留给成熟解析器；已识别不透明分享链接继续严格校验来源、路径和 namespace。前端正式 runtime 59 项、UniApp 类型检查及 H5/小程序/App 三端构建通过；真实编译 H5 的桌面/移动浏览器检查 26 项通过。另有小程序编译协议 19 项、关闭原生 `URL`/`URLSearchParams` 的真实 scanner SFC 逻辑 14 项和分享消费者逻辑 7 项通过，均为各自独立范围，不重复相加。实际 PostgreSQL DTO 接入真实配送 SFC 的 4 项、8 对查询保留生产者原始 key：历史候选正确被页面拒绝，当前候选展示完整订单/购物车；零金融写入。网络、身份引导和扫码 SDK 传输仍为测试替身。

小程序应用不能据此称为全局 `URL` 无依赖：扫描页 application import graph 的 42 个独立 JS 文件无该全局调用，但 `common/vendor.js` 实际含 11 处由分类、售后、线下收银、积分、秒杀等六处应用 common 源码提升的 `new URL`。本批没有修改这些无关 helpers。证据与源码写回回执见 `audit/legacy-share-scanner-current-01a1332d-20261013/scanner-current-export-summary.json`。65 文件前端冻结范围在执行时前后无漂移；主线后来新增 `pages.json` 注册项，不属于此前构建覆盖范围。

最终独立本机验证覆盖完整 Worker/Functions 物理输入、真实相对类型依赖及本轮 scanner 范围，共 3089 个文件。类型检查与普通回归前后摘要均为 `6f4b9395ca0688f2ce8646c0f22f57cccdef980570e197714aad95ef390b27cb`，无本机漂移，七个当前窄修 Source 输入相符。普通 13 文件 167/167、零失败/跳过；Worker unit 于 UTC 07:52:51、runtime 于 07:54:23 完成，均 exit 0、空诊断，安装版本与 lock 核对。主线活动源码中的 `WechatMiniProgramCodeService` 后来新增员工邀请 imports 和方法；只读比较确认旧方法不变，但新 import 图及当前全仓仍须主线下一轮验证。本轮不借主线其他批次的测试数字。

原始结果、26 个同字节归档文件和执行输入见 `audit/legacy-share-independent-final-01a1332d-20261013/independent-final-summary.json`。归档同时保留首次 unit 缺少本机 Cart 依赖而 exit 2、Admin 输入资格检查提前停止、sandbox Vite realpath EPERM 的历史记录；随后补齐实际已有源码依赖并执行获批本机检查，不把这些历史失败当作业务修复。

Images API 依据本仓安装的 Workers 类型和 [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/) / [draw overlays](https://developers.cloudflare.com/images/optimization/draw-overlays/) 主文档；当前绑定的拉伸选项是 `fit:'squeeze'`。现有微信协议以旧 PHP 和已迁移 provider 的源码合同为依据，本批未取得可读取的当前微信官方文档，不声称完成真实微信发布环境调用验证。

## 个人永久推广码

旧 PHP `user/routine_code` 的 `{url}` 下载合同已单独迁移。主协调明确解除上一批源码冻结后，于 UTC 2026-10-13 09:58:08 按原始源码和已测试候选双重哈希校验写回三个实现文件及一个新测试。未改动主线 Mini 员工邀请方法、共享路由、Auth、runner 或根迁移清单。永久小程序目标与通用临时分销码具有不同索引，缓存到期为零；下载签名仍最多 15 分钟。没有有效 SQL 小程序 AppID 时返回错误，不能以网站码代替小程序码成功响应。

该独立候选普通回归为 16 文件 194/194，包含新增接口的 17 项；同一 17 项另在 PostgreSQL 16.15 实际通过，不能重复计为 211 项。3090 个冻结本机输入前后无漂移，Worker unit/runtime 类型检查均 exit 0；四个实际写回文件与此候选逐字节相同。此前主线 4031 输入和 1130 项结果早于此次写回，不计作新增接口验收。当前全仓后续整合检查、真实微信/设备与生产 ACL 仍须分别验收。

合同、边界与原始记录见 [个人推广码迁移说明](user-routine-code-migration-20261013.md) 和 [实际源码写回及归档摘要](../audit/user-routine-code-01a1332d-20261013/routine-code-final-summary.json)。PHP 推荐绑定的三种模式、旧账号准入、邀请经验及注册推广佣金继续作为独立迁移范围，不由二维码适配器替代。
