# 商品详情装修：完整旧合同与承接要求

本批承接旧 `/admin/setting/pages/product_detail`，范围包括后台全部配置和它们在普通商品详情中的真实消费。完整实现已经通过本地测试、构建和实际编译浏览器，详情装修入口提升为本地 candidate；整体父开放项、生产、provider 与真机验收保持开放。

起点为 `.cache/migration-next-baseline-product-category-style-retry1-20261002.json`，原始 SHA-256 `e94a931e6dfd9b574416d4754b3b212352c4e6554a8a9e9ef04e671594cf8fa0`。它逐一核验上一批 14,307 项冻结输入，承接 14,337 项输入（2,901 source、180 reference、11,256 raw）；19 个历史构建目录、5,091 个原始文件继续保留。上一批验收为 `audit/product-category-style-acceptance-20261002.json`，原始 SHA-256 `054f8ea568022424720950f0d55981c37cc6c7c6db226f85c45ec5825eb1351e`；其独立 proof `passed/errors=[]`，原始 SHA-256 `4263fc9a6fbf5c33d8dcd53e6dd01a58adb38752c462c9decbb7e91a843641cc`。

## 配置权威与管理入口

旧 `view/admin/src/router/modules/settingPage.js` 定义详情入口，组件为 `newGoods.vue` 与 `template/Product/templateConfig.vue`。安装菜单 1594 的 path/auth 为 `/admin/setting/pages/product_detail` / `admin-setting-pages-product_detail`，type/auth_type/platform_type 为 1，pid 为 656。新页面 `/setting/product-detail-design` 使用独立 `product_detail_design.view/manage`；精确旧菜单只映射 view。

旧 GET `diy/get_product_detail`、POST `diy/save_product_detail` 使用 `{product_detail_diy:完整对象}`，存储为 `system_dise`（旧 `eb_diy`）中 `template_name='product_detail' AND type=3` 的单例。`status=0/is_show=0` 是有效旧记录，不应改作未配置。GET 不创建记录；旧 PHP `DiyServices.php` 使用缺省与已知键交集合并，其他保存扩展不属于公开合同。

新 GET `/config/product-detail-design`、POST `/config/product-detail-design/save`、GET `/config/product-detail-design/receipt/:operationId` 同时注册到 `/adminapi` 与 `/api/admin`。专用 GET 在旧通用 `config/:menuName` 之前，避免路由截获。写入为 `{operationId,revision,value:完整19键}`；规范 payload 为 `{operation:'update',revision,value}`，固定键顺序，operationId 不进入摘要。收据绑定 actor、UUID、payloadHash 和真实提交行，查询使用当前权限。

读写必须共享一个有界、完整的候选校验权威，诊断规范化别名、重复、错误 type、删除、损坏 JSON、重复 JSON 键和丢失精度的数值，禁止选择最低 ID 掩盖异常。保存保留安全的私有扩展及无关行元数据；公开投影只含 19 键，另行提供配置状态。目录锁先于行锁；保存以新鲜候选、版本及完整扩展对象做 CAS，并与 actor 收据在同一事务提交。通用保存与删除同时保护请求名称和现存规范化名称。

明确已回滚的实际 400/409 才提供 `PRODUCT_DETAIL_DESIGN_REJECTED` / `PRODUCT_DETAIL_DESIGN_STALE_VERSION` 证明。其他网络、摘要、actor 或 journal 异常保留不可变未知 intent；真实 404 仅允许显式重试同一 payload/UUID。明确重新读取后可建立新确认，保留用户可编辑草稿，清楚同步只读字段；旧 intent 仍留存。

## 十九个字段及真实消费

| 字段 | PHP 缺省 | 完整消费与边界 |
|---|---|---|
| navList | [0,1,2,3,4] | 首页、搜索、购物车、收藏、我的；空数组合法，旧页仅提醒 |
| openShare | 1 | 顶部分享入口及 H5、MP、APP 分享流程 |
| pictureConfig | 0 | 0 固定方图、1 自适应真实图片高度 |
| swiperDot | 1 | 实际轮播指示器 |
| showPrice | [0,1] | 0 等级价、1 SVIP 价；旧 Admin 无编辑控件但原样保存；影响显示，不授权交易价格 |
| isOpen | [0,1,2] | 0 划线价、1 销量、2 库存；历史 3/4/5 原顺序保留 |
| showSvip | 1 | 真实付费会员卡和会员入口 |
| showRank | 1 | 真实排行榜与对应商品排名入口，不伪造名次 |
| showService | [0,1,2,3] | 0 营销、1 SKU 入口、2 服务保障、3 参数；隐藏入口不能破坏合法购买所需 SKU |
| showReply | 1 | 真实商品评论、总数和好评统计 |
| replyNum | 3 | 评论数量 1–10，实际查询限制 |
| showMatch | 1 | 真实商品关联套餐 |
| matchNum | 3 | 套餐数量 1–10，实际查询限制 |
| showRecommend | 1 | 真实推荐商品；数量不超过 6 为网格，超过为双行横向布局 |
| recommendNum | 12 | 推荐数量 1–24，实际查询限制 |
| menuList | [0,1,2] | 首页、分享、客服、收藏、购物车，最多 3 项，空数组合法 |
| showCart | 1 | 仅控制加入购物车按钮；不能否定有效立即购买 |
| showCommunity | 1 | 真实当前商品关联种草内容与对应入口 |
| communityNum | 3 | 关联内容数量 1–10，不能替换成无关通用动态流 |

完整保存 19 键；后台有 18 个可编辑字段和只读 `showPrice`。预览是九个真实模块，顺序为商品信息、SVIP、排行、服务/参数、评论、种草、套餐、推荐、底栏（旧序号 0、1、2、3、4、8、5、6、7）。隐藏模块仍可选择并编辑。

旧 CheckboxGroup 操作完整 model 数组，只增删当前 label。安装值 `isOpen=[3,4,5,1,2,0]` 因而有效；未显示的 3/4/5 不能被排序、去重或重建可见集合删除。新的验证器接受互异 0–5，明确拒绝范围外的异常。其他选择范围分别为 navList 0–4、showPrice 0–1、showService 0–3、menuList 0–4（上限 3）。十个开关为严格 0/1。

## 商品、活动与交易边界

旧 `StoreProductServices.php` 使用 showPrice 控制详情显示的等级/SVIP 价格，再结合会员资格与系统规则取有效价格；空数组隐藏会员价。新布局不能改变既有 SKU 交易报价权威。已有普通详情安全 SKU、库存、会员十进制报价、cart_button、预售和自定义表单门控继续生效，不能为装修新增通用按钮绕过特殊流程。

旧普通详情 `StoreProductServices.php:1918`、购物车 `StoreCartServices.php:402` 先将 `custom_form` 清空，只通过 `system_form_id` 读取系统表单；订单确认 `StoreOrderServices.php:1672` 同样只使用第一购物车商品的 `system_form_id`。因此有残留数据库 `customForm` 而无有效表单 ID 并不代表一个旧可填写表单。普通购买复用当前真实 ID 对应的表单与虚拟/次卡订单确认；残留内容保持私有，不新增交易字段或将它描述成已迁移表单。分类快捷购买对残留内容的更严门控继续保留。

媒体、视频、详情正文、服务保障、参数、品牌、标签及排行来自真实数据库安全投影；只允许合规资产及已发布归属。签名与外部 I/O 在 SQL 事务之后执行。正文须安全清洗，不能直接渲染未经处理的 HTML。

`product_video_status` 是独立系统配置，不是第二十个 DIY 键。旧普通详情使用商品自身 videoOpen；首页 promotionList 的同名 prop 没有实际消费，不能据此给普通详情新增全局视频关闭规则。视频隐藏、页面退出与账号切换须暂停播放并阻止迟到回调。

旧普通商品及预售参数在 showService 不含 3 时清空；积分、秒杀、新人、拼团服务恰为包含 3 时清空。保留这个已有差异。实际秒杀、拼团与预售页面调用 `view=skus` / `view=presale`，因此专用 SKU 读取器也在同一个只读 REPEATABLE READ 快照读取十九键、保障、参数、正文和真实评价，退出事务后签名素材；不能只补未被这些页面调用的旧详情接口。预售图库沿用原有二十张有界安全解析及主图回退，损坏的可选图片不使合法 SKU 失效。积分旧页没有评价模块，继续保留；砍价没有同一完整装修合同，使用它的独立流程。PC 调用共享普通详情和推荐接口，不将 PC UI 记作完整 DIY 页面。

优惠、营销和套餐来自实际 API，领取券使用真实身份及错误恢复。普通购物车没有 operationId/收据端点，未知提交必须保留 actor 购买 ledger，跨配置重读、页面隐藏、产品/购物车刷新也不自动 POST；已成功加入后领券或导航失败继续同一个 cart。

分享保留 productId/referrer 归属，MP 好友/朋友圈、H5 微信/二维码、APP 平台分享与真实画布海报。SDK、图片及海报异步回调检查 actor、页面 generation 和可见性；普通海报不能沿用积分文字或积分价格。服务端平台码、真实 SDK/真机和发布验收分别记录，不能用浏览器桩视为供应商通过。

认证 `GET /api/product/code/:id` 只接受单一 `user_type=wechat|routine`，用户 ID 来自当前 JWT。生成前在有界只读快照重查账号、商品可见性和图片归属；provider 请求在事务结束后执行，不写平台二维码表，也不扩大 App 角色权限。普通网址绑定配置的规范 HTTPS `PUBLIC_H5_ORIGIN`，不信任请求 Host 或数据库站点 URL。小程序码指向当前 `pages/goods/detail`，scene 同时带商品和真实当前推荐人；旧 PC 小程序方法保留原路径。

公众号临时码使用有过期时间的 HMAC 商品 scene；关注/扫码回调验签并重查当前商品、推荐人及素材，返回同一当前详情链接的 news。provider 仅使用固定 HTTPS 微信地址，限十秒、禁止重定向，JSON 和 PNG/JPEG 响应分别限制大小并核对图片头；错误统一返回 503，不展示凭据或供应商原始诊断。旧永久二维码队列与可用类型保持原合同。本次官方文档页面未能读取，协议依据已捕获的旧 PHP 与既有提供商服务实现；真实微信账号、小程序发布路径、设备和供应商链仍需独立验收。

## 完成证据

Root 已统一执行 Worker unit/runtime 类型、Admin/Uni 类型、真实 PostgreSQL/HTTP、前端运行时、Admin 和 H5/MP/APP 新目录构建，以及真实编译应用的桌面/手机浏览器。唯一用例 **660 项通过**，其中 255 项真实 SQL/HTTP、405 项纯协议/实际运行时/源与产物检查；296 项原生用例按 AST 参数展开和用例主体 SQL 核清。浏览器 **87/87 组**，18 项详情后台、38 项普通详情、31 项原分类回归，未预期错误为 0。

最终浏览器覆盖真实字段开关与数量、模块空/错误/重试、媒体、分页、SKU、匿名和换号、未知购买、领券/导航恢复；SQL/HTTP 证明精确权限、CAS、通用旁路、公开同权威读取、私有扩展与金融不变量。实测并修复 UniApp 初始化空 `window.wx` 被误认作可用 SDK、种草页误占 Home 首项两个真实问题。实际 SDK 加载器核对五个必需函数与可选函数形状；Home 恢复 `pages/index/index` 为第一项。19 旧构建、5091 原文件和全部失败原字节保留，13 个自有 PG 停机清理而保留配置日志。

每个既有源修改有 first raw，14337 条入批摘要逐项分类；冻结验收采用独立 reader，只读核对 source/raw/reference、完整构建目录、实际终端与浏览器证据及自有端口，不执行测试或 writer。详见[验证](admin-product-detail-design-validation-20261002.md)及[冻结验收](../audit/product-detail-design-acceptance-final-retry3-20261002.json)。仅表单、静态预览、源代码 gate 或构建通过不足以提升旧入口；生产、供应商、真机、发布和未完成父项继续开放。
