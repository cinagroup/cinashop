# Uni 搜索热词 PHP→TS 增量

本批范围是现有搜索页的热词三色/图标消费、严格请求适配、本机历史校验、商品名称字段和页面/native 生命周期。整体 PHP→TS 迁移保持开放；本批不能关闭完整搜索页或 FE-003 总项。

固定 PHP 来源 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。11份原始文件及16个行为片段的 SHA/完整内容绑定在 `workers-ts/audit/uni-search-hotwords-source-binding-20261025.json`。热词文字、背景、可选1px边框；图标24×24rpx、圆角4rpx、右间距8rpx；空样式沿用#666/#f5f5f5与无边框。完整历史名称最多128 Unicode字符展示，点击不截断名称，并按Worker既有trim规则准入查询；查询沿用 Worker <=255 UTF16单位，不再静默slice100。128emoji词可完整显示，点击因256单位明确拒绝，不截断成另一搜索词。

`view/common/searchHotwords.ts` 一次校验完整最多20条热词；坏尾、稀疏项、重复ID、name/keyword冲突、危险颜色拒绝整批。颜色按当前producer安全子集验证；业务图标采用不依赖window/URL global的保守展示校验，可疑路径或加载失败仅隐藏图标、保留文字。没有新增附件签名、作者素材槽、图库或公开发布权限。稳定私有`/api/assets/N`不等于公开可读，失效ticket也不自动续签。

本批57项真实MemoryPostgres/Hono动态用例覆盖公开热词GET；另10项既有product-words/UserBehavior用例覆盖schema、纯函数和源码合同。商品后端写入源码保持冻结，前端身份与请求参数经真实请求层验证；商品搜索历史的动态SQL实写验证仍属后续范围。

热词 GET `/search/hot_keyword` 明确noAuth，与固定PHP store.js合同对齐；410000类热词错误不会清shopper或跳登录。商品搜索复用当前`apiCategoryProducts`/严格DTO，并补密集数组与20项检查，以`store_name`和固定两位price显示。`/products` 保留可选shopper身份和当前价格/可见性语义，保留服务端搜索缓存与历史写入（包括guest uid0）。已发送旧GET可能已经写历史；丢弃迟到回执不代表取消请求或回滚服务器写入。

页面onLoad只接收keyword/searchVal；onShow先读合法本机历史再仅一次提交初始词，避免旧挂载顺序覆盖历史。onHide退役请求和动作、清结果并保留输入草稿；再次onShow仅刷新热词和本机历史，不自动重发商品GET。完整uid/token/sessionVersion和单调context/generation/interaction隔离换号、同token重登录、隐藏/恢复/卸载、query ABA。loop-local冻结来源函数拒绝旧tag/refresh/confirm/clear/result/image error转调新资料；同DTO对象更换name/icon/id也失效。仍在屏幕的同一input保留身份与实时输入listener，不每次按键重挂、丢焦点；离开页面/会话后旧input失效。

本机历史沿用`h5_search_history`，最多10项、提交去重前置、显式清空。它仍是浏览器本机共享缓存，不冒充PHP用户服务端历史。JSON坏值/合法JSON错误形状/过长列表/非字符串不能进入filter或静默覆盖持久字节；用户显式清空后可正常保存。热词刷新和失败/空状态、商品搜索中/失败/空结果明确区分并可重试。

明确保留的现TS差异：商品结果继续内联，未恢复PHP跳转商品列表；原TS基础tag布局保留并增加窄屏长词换行，未声明整页像素一致。现TS平台(type0/relation0)目录隔离保留，虽固定PHP查询不同。不恢复服务端历史UI、三个排行/推荐卡、联想/模糊HTML高亮；这些仍在完整迁移范围内。

本批验证通过 **3832 项唯一测试**，其中新增 **374 项**：Uni 完整工具链 2587（含新增数据82/实际SFC82）；Worker source/旧证据链 1178（含新增source153），真实目录及原作者/历史合同 67（含新增catalog57）。重复定向/失败尝试不重复计数。Uni/Worker两项严格类型检查与H5、MP-WEIXIN、App三构建通过。全部重型验证经过共享serial wrapper，单worker/单文件并发。新测试进入现有test:toolchain，既有Linux CI调用已覆盖，无需改CI；Worker新文件由现Vitest test glob发现。18份修改源完整前后逆向、6份新增源、45份冻结证据/helper/CI，以及观察业务源码被绑定；旧15套件仅加精确外层inverse，旧断言/危险负例/日期证据不改，Admin API报告hash保持原值。

本地H5使用实际三端构建产物中的H5和本地API fixture，Chrome/既有Playwright；Browser plugin not available。GUI不代表真实shopper账号、MP/App真机或私有附件业务发布授权，Worker真实SQL另测。未commit/push/PR/merge/deploy；整体迁移继续。

实际H5：320/375/390px与1100px，6张截图；完整长词不溢出、三色/无边框、24rpx图标、坏图保留文字；初始路由仅一次搜索且先有原历史，当前标签/输入节点稳定/商品空与失败重试/热词失败与空及刷新/清空/详情URL/重载通过。记录 21 个本地API GET，0 page/console error，2次既有Vue Router弃用warning（完整原句见回执）。仅5个products GET，恢复页面不会自动增加商品搜索。

证据主SHA `b1de5a72518df149aef05448139951153cf0ea60f2776df1e49dac6d4c0824d2`；最终关联验证的89份repo源/证据及3份验证脚本共92份无漂移（阶段冻结与仅Worker测试解码修正的差异收据保留，前端已通过阶段未变）；旧36份dated/helper、直播main/parity和Admin API报告保持已接受值。共享锁、单worker/无文件并行、独立每步exit回执已保存。

失败记录保留：首次384MiB Uni类型检查在过低的有界堆上退出134（未计通过），改用1024MiB串行后通过；一次真实类型错误是input事件窄类型，已改unknown并受控读取detail.value后通过；首次旧证据回归因遗漏15 wrapper源码inverse失败90项，补入新exact增量后全部通过，旧断言和历史证据未改变。npm入口不可用的启动失败未计测试，随后执行package scripts相同的现有Node入口；窄input类型诊断以工具输出收据另存，原日志曾复用。Worker严格检查还发现新source证据测试把字节数组当作Buffer传编码参数，改TextDecoder并按本地Cloudflare声明补齐fatal/ignoreBOM后重跑相关1178项及Worker类型；该修正仅影响Worker证据测试，前端源码未变，因此保留已通过2587项，未重复计数。阶段快照/差异与原诊断保存在worker-test-typing-failure和worker-textdecoder-options-failure。原失败日志/JSON在/tmp/cinashop-search-hotwords/first-source-regression-failure及typecheck-uni-384MiB-failed.log保留。

执行回执：`/tmp/cinashop-search-hotwords/validation-result.json`、`accepted-validation-result.json`、`worker-source-regressions.json`、`worker-catalog.json`、`uni-toolchain.log`、`browser-result.json`、`compatibility-diff-review.json`、`validation-source-before.json`与`validation-source-after.json`。源码证据和本报告保存在repo；临时验证产物不宣称远程CI/部署。
