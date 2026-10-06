# 个人中心六模块合同复核（2026-10-03）

本批范围是旧 `/admin/setting/pages/home` 整屏及商城 `pages/user/index` 的六模块真实消费。共享模型已建立，其他实现和运行验收由各负责方继续推进；本文不是发布或验收证明，不以编辑页、样式单选器、注册路由或静态源码门禁代替完整功能证据。

入批基线：[migration-next-baseline-product-detail-design-20261003.json](C:/cinagroup/cinashop/.cache/migration-next-baseline-product-detail-design-20261003.json)，原字节 SHA-256 `410b72ea460bf160dbe182a2bc4808b65108a6009387d1d0cf2ce3ef9c650373`，20468 个输入，26 个历史构建目录、7234 个文件，入批差异为空。前批商品详情验收文件及独立证明继续保持原字节。

旧版原字节参考：[附加参考回执](C:/cinagroup/cinashop/.cache/user-center-design-additional-reference-receipt-20261003.json)，SHA-256 `d431b855bd89bc5666c09d68ca077694ff71c598c4219d83ce09ed5c7097aada`，64 个参考，41 个与入批参考核对、23 个新发现；另有 [会员码消费者回执](C:/cinagroup/cinashop/.cache/user-center-design-member-code-reference-receipt-20261003.json)，SHA-256 `db0e27a7e32fd24859ccbdcc7844ff20cd733aac76e6b7f05fca7ac146291832`，2 个新发现。全部另存原字节，旧系统文件未修改。共享模型：[userCenterDesign.ts](C:/cinagroup/cinashop/view/common/userCenterDesign.ts)。模型静态 TypeScript 编译通过，不执行被审源码或测试。

## 旧页面、API 和权限

- [users.vue](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/users.vue:1) 固定模块顺序：会员信息、订单中心、运营统计、广告位、我的服务、商家管理。点击左侧模块切换右侧完整配置；没有整屏模块拖拽或任意模块新增合同。列表内部另有重排。
- [users.vue 保存](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/users.vue:193) 发送 `member` 六模块 JSON、`routine_my_banner=poster.list`、`routine_my_menus=menu.list.concat(merMenu.list)`。新版需一次业务意图原子提交三个 authority，不能只改 `system_dise.value`。
- [旧 API 包装](C:/cinagroup/cinashop-php/view/admin/src/api/diy.js:224)：`GET diy/get_member`、`POST diy/member_save`。[旧控制器](C:/cinagroup/cinashop-php/app/controller/admin/v1/diy/Diy.php:559) 读取并保存这三个字段，然后发 `diy.update` 事件。
- [安装菜单](C:/cinagroup/cinashop-php/public/install/crmeb.sql:9619)：页面 ID **1592**，路径 `/admin/setting/pages/home`，`unique_auth=admin-setting-pages-home`，`auth_type=1`。不能与用户自资料页面 `/admin/system/user` 混同。
- [旧 router](C:/cinagroup/cinashop-php/view/admin/src/router/modules/settingPage.js:37) 曾使用较宽的 `admin-setting-pages-devise`。旧接口菜单 ID 1284/1285 的父节点为 657。两者不能给新专用保存授予默认写权限：1592 的精确页面身份只推导新 `.view`，管理权限由新明确的 permission plan 决定。
- 新专用读取、保存和按 actor 查询回执需双 Admin 前缀，旧 `diy/get_member`、`diy/member_save` 兼容入口也应接同一 authority/验证逻辑。读权限与写权限分开；图片和链接选择接口不能因用户拥有 FAB 或宽泛装修权限而自动放开。

## 六模块的可编辑字段

| 模块 | 完整编辑字段 | 范围及列表操作 | 默认及兼容 |
|---|---|---|---|
| `member` | `style`、`per_show_type`、`property` | 风格 1～5；信息 0 手机号、1 UID；资产 0～8 无重复；风格1最多5项，其余最多3项；资产控件只在风格1/2/5显示 | PHP 默认风格1、`property=[0,1,2,3,4]`；缺 `per_show_type` 按旧组件默认0只读补值并给出诊断 |
| `order` | `style` | 风格1～3；无隐藏开关、标题或自定义订单状态列表 | 风格1 |
| `orderStatic` | `style`、`is_show` | 风格1～2、显示0/1；真实运营统计还须当前客服订单权限 | 风格1、显示1 |
| `poster` | `is_show`、`list[].name/pic/url` | 显示0/1；最多10；添加、删除、拖拽排序、图片选择、标题和链接选择；建议750×188图片 | 显示1、空列表；没有可保存的 poster `style` 字段 |
| `menu` | `title`、`is_show`、`style`、`list[].name/pic/url` | 风格1～3、显示0/1；最多30；添加、删除、拖拽排序、图标、名称和链接；保存项类型1 | `我的服务`、风格1、显示1、空列表 |
| `merMenu` | `title`、`is_show`、`style`、固定角色项 `name/pic` 与顺序 | 风格1～3、显示0/1；旧实际模板没有添加、删除或链接编辑控件，脚本残留方法不构成功能；保存项类型2；source identity/长度/URL锁内保持 | `商家管理`、风格1、显示1；PHP默认缺整块，按旧前端六模块补空块并诊断；历史列表有界，不创造管理角色 |

依据：[MemberConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/MemberConfig.vue:49)、[OrderConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/OrderConfig.vue:59)、[OrderStaticConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/OrderStaticConfig.vue:10)、[PosterConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/PosterConfig.vue:24)、[MenuConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/MenuConfig.vue:49)、[MerMenuConfig](C:/cinagroup/cinashop-php/view/admin/src/pages/setting/devise/templateConfig/MerMenuConfig.vue:47)。

风格选择在旧 MemberConfig 中会把非1的资产重置为 `[0,1,2]`，并且选择器取消前就可能改原草稿。新版可以采用独立暂存选择、显式确认变更；不能无提示截断已有历史资产、默默修复保存值或把隐藏控件字段删掉。空资产数组和三种空列表是明确值，隐藏模块保留原配置。

旧 `member.is_default/avatar_url` 上传控件整段已注释；`avatar_url` 被旧后台样式预览使用，旧商城五个会员模板实际使用 `userInfo.avatar` 或静态头像。两字段须在 DB 原对象保留，不能称作已经恢复的商城头像配置，也不能把后台预览头像泄露进新公共 DTO。[旧 store](C:/cinagroup/cinashop-php/view/admin/src/store/modules/admin/modules/userTemplateConfig.js:14) 中缺字段回填、素材和菜单分组回填代码已整段注释；不能把注释当正在运行的实现。

## 资产字段与真实样式消费

| ID | 旧商城真实字段 | 行为 |
|---|---|---|
| 0 | `now_money` | 余额入口；余额功能关闭时隐藏资产项 |
| 1 | `couponCount` | 用户优惠券 |
| 2 | `integral` | 积分明细/中心 |
| 3 | `collectProductCount` | 商品收藏 |
| 4 | `collectVideoCount` | 视频收藏，旧链接 `/pages/users/user_goods_collection/index?active=1` |
| 5 | `visit_num` | 浏览足迹 |
| 6 | `brokerage_price` | 推广佣金 |
| 7 | `spread_user_count` | 推广人数 |
| 8 | `spread_order_count` | 推广订单 |

依据：[商城 propertyList](C:/cinagroup/cinashop-php/view/uniapp/utils/propertyList.js:1)。旧后台列表没有 ID4，使用 `collectCount` 和拼错的 `brokerade_price` 等字段；商城实际消费者使用上表，不应照搬后台样本值。ID4 是真实视频收藏，不能当未知编号丢弃。旧商城按照固定 property catalog 顺序输出选中项，不按数组顺序；非推广人隐藏6/7/8。[会员消费者](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/member/index.vue:69) 根据当前用户和开关过滤，客户端设计字段不授予推广资格。

- 风格1：真实头像、昵称、普通会员标志、付费会员标志、手机号/UID、消息未读数、资产，以及会员中心/等级激活、积分商城两张卡片。
- 风格2：不同头部/资产排布和真实普通会员等级折扣卡；风格1/2/5的资产选择真实作用于显示项。
- 风格3：真实头部和 SVIP 卡，无资产区。不要因为 member index 把 `property` 作为额外 prop 传入而声称 style3会消费它。[template3](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/member/template3.vue:40)。
- 风格4：可提现 `userInfo.commissionCount`、立即提现、累计佣金 `commission.brokerage_price`、推荐人数 `commission.number`、推荐单数 `commission.order_num`；无普通资产区。[template4](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/member/template4.vue:47)。
- 风格5：紧凑头部和选中资产，无普通等级/风格4佣金卡。[template5](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/member/template5.vue:69)。

会员头部的编辑/手机号绑定、设置、消息、会员码动作也是实际页面行为。不能用表情符号、固定余额、静态订单数替代真实用户数据；不得复制 PHP 的读取中生成码或等级自动晋升副作用。配置头像与用户自资料头像必须区分。

## 广告、菜单、订单和运营统计的消费

[旧商城 user/index](C:/cinagroup/cinashop-php/view/uniapp/pages/user/index.vue:4) 按六模块顺序渲染。接口分别是 `GET /api/menu/user`、`GET /api/menu/date`、鉴权 `GET /api/user`；当前 Worker 对应已有 [PublicCatalogService.menuUser/menuUserData](C:/cinagroup/cinashop/workers-ts/src/services/product/PublicCatalogService.ts:393) 和 [UserProfileService.personalHome](C:/cinagroup/cinashop/workers-ts/src/services/user/UserProfileService.ts:257)。

- 订单中心始终存在。三种风格有不同图标/排布，五项真实订单计数为未付款、未发货、待收货、待评价、售后/退款，以及查看全部。旧 `status` 参数不能直接当新 `type` 而误映射状态。[orderMenu](C:/cinagroup/cinashop-php/view/uniapp/pages/user/index.vue:100) 和 [计数接线](C:/cinagroup/cinashop-php/view/uniapp/pages/user/index.vue:412)。
- 三种风格展示真实最近未支付订单的图片、等待付款状态和截止时间，倒计时结束重新读取，跳转付款订单列表，不自动执行付款。[order/template1](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/order/template1.vue:43)、[template2](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/order/template2.vue:40)。
- 运营统计只在 `menu/date.order.user_order=true` 且 `orderStatic.is_show=1` 时显示。两风格消费真实支付金额、支付订单数、待发货数，入口必须有真实、鉴权的管理落点。[统计模板](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/order_static/template1.vue:18)。旧 PHP 的 `consignment` 筛选与金额/订单数不同；本批不得顺便改财务口径，应记录当前服务的明确口径和授权条件。
- 广告位需要实际 swiper：显示1且非空列表，自动播放、循环、间隔3000ms、动画500ms、多图才显示指示点，按列表顺序点击真实链接。后台预览以前只展示第一张不能作为客户端已恢复轮播的证据。[poster/index](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/poster/index.vue:9)。
- 两菜单的标题、显示开关、全部项、图片、文字、顺序和三风格分别为四列图标、纵向图文列表、三列大卡。小程序客服项 `routine_contact_type=1` 走真实 `open-type=contact`，值0走现有客服页面；H5/App使用当前客服入口。[menus/template1](C:/cinagroup/cinashop-php/view/uniapp/pages/user/components/menus/template1.vue:18)。
- `storeMenuShow` 的旧实现只在过滤后的 `routine_my_menus` 找到type2时设true，且不会主动复位；新版须根据每次当前角色投影重新计算，退出、隐藏或身份变化立即清除私有数据，不允许旧响应恢复管理项。

当前新 [user/index.vue](C:/cinagroup/cinashop/view/uniapp-ts/src/pages/user/index.vue:1) 入批是固定头部、三项固定订单入口和固定服务列表，只查询核销 operatorProfile；未消费 `diy_data`、广告轮播和真实用户摘要。完成要求是上述实际渲染和动作生效，不能只加入无消费的 DTO 或配置 GET。

## 商家角色与菜单过滤

[旧 PublicController](C:/cinagroup/cinashop-php/app/controller/api/v1/PublicController.php:158) 的完整过滤不仅有会员/余额/分销，还包括客服、配送、订单管理、核销和发票。

| 旧目标 | 旧条件/处理 | 新实现必须证明 |
|---|---|---|
| `/pages/admin/work/index` | 登录，启用且有效客服，`customer=1` 订单管理能力 | 真正当前角色判定与实际管理页面/列表，不能借商城 token 伪装 Admin 或 Work 登录 |
| `/kefu/mobile_list` | 登录，客服 `status=1/account_status=1`；拼当前 `site_url`，MP改https | 当前真实客服主体和实际客服端落点；地址安全、独立权限，不拼旧任意外链 |
| `/pages/admin/distribution/index` | 登录、当前有效配送员 | 当前匹配的配送角色和真实配送入口/API |
| `/pages/admin/order_cancellation/index` | 登录且客服或有效配送员 | 当前核销角色与真实核销流程；设计字段或type2不成为授权 |
| `/pages/admin/order/index`、`/pages/store_spread/index`、`/pages/admin/store/index` | 旧公共菜单已固定隐藏 | 不为恢复装修而重新开放退役入口；历史存值仍保留诊断 |

会员菜单：普通等级需 `member_func_status`，未激活且开启激活开关改等级激活页；推广需当前推广资格和有效代理任期；代理申请需推广资格、分销/代理/申请开关且普通主体；分销申请需非推广且申请开关；余额需余额开关；发票需发票开关；付费会员需真实 SQL 全局会员开关。区域代理/代理商名称按当前 `division_type` 与有效期变化，过期隐藏。当前 `menuUser` 入批仅覆盖六种 URL，遗漏其余角色/发票过滤，且代理申请还缺旧推广资格条件。

当前 [核销 operatorProfile](C:/cinagroup/cinashop/workers-ts/src/services/order/StoreOrderWriteoffService.ts:222) 已有真实店员/配送者条件和重复身份诊断，可复用规则，不能把旧客服身份自动推导成新 store staff。每个目标 API 必须独立校验当前角色；显示菜单只是投影。身份、开关、素材和配置尽量在同一一致快照读取，明确展示读取后角色可能改变，操作仍在服务端重新授权。

## 三份 authority、历史兼容与原子保存

[DiyServices 默认](C:/cinagroup/cinashop-php/app/services/diy/DiyServices.php:61) 只有五块，缺 `merMenu`；[getMemberData](C:/cinagroup/cinashop-php/app/services/diy/DiyServices.php:443) 另读两个 group 和 `h5_avatar/color_change`，按旧 URL 推导缺失菜单type。`status=0` 是安装个人中心行的正常值，不能要求普通 DIY 首页的启用标志。

[旧 memberSaveData](C:/cinagroup/cinashop-php/app/services/diy/DiyServices.php:493) 先写 member，再分别调用两个 `saveAllData`；[saveAllData](C:/cinagroup/cinashop-php/app/services/system/config/SystemGroupDataServices.php:335) 各自事务内删本组、按fields写 `{type,value}` 包装，sort从列表长度递减、status默认1。旧三个事务并不证明全业务原子性。新增合同要求：

1. 专用读事务只读，默认和兼容投影不初始化 SQL/KV；缺单字段、缺merMenu、旧pic单张数组、旧字符串type等分别给诊断。坏 JSON、重复键、类型错、过深、归一化同名重复、错误模板身份、超量数据必须明确阻止覆盖，不用空配置掩盖。
2. revision绑定 member原字节/身份/xmin/版本、两个group的身份/fields及全部相关数据行（含隐藏行）。仅比长度不足以诊断两个等长却不同内容的列表；明确报告值、顺序和字段分歧。已有规范化列表优先消费，只有缺列表可从真实group回填且诊断，不能把显式空列表当缺失。
3. 请求严格完整六模块，`{operationId,revision,value}`；UUID位于payload摘要之外。列表项携带server生成sourceId，poster/menu新项允许null，旧source不可复用或重复；merMenu固定集合长度/type/URL/source在锁内验证，只改name/pic/order。
4. 同一事务、同一固定锁顺序对整个collection做CAS，写member及两个group，写actor绑定systemLog回执；中间任一步失败全部回滚，不改别的group。兼容包装保留每个未编辑字段、字段定义及已有隐藏行，不全表重建或覆盖无关组。
5. 根、模块、列表项的未知扩展及 `avatar_url/is_default` 留server原对象，sourceId将旧项关联回原对象，再只覆盖允许编辑字段。不能让client复制任意opaque、把sourceId持久化公开或回写签名后的临时pic。删除普通项是显式用户动作，不能用规范化删坏项代替。
6. 幂等日志先于CAS检查。相同 actor/operationId/payload复用真实回执；不同actor或不同payload冲突。回执查询按当前actor，不能泄露他人写意图。只有绑定UUID和摘要的400/409拒绝证明允许解除未知锁，普通timeout/5xx仍未知；明确404只允许原UUID/原revision/原完整payload人工重试。
7. 后台 pending含完整深冻结的六模块、原摘要、当前actor；隐藏/身份变化和迟到响应不能覆盖新身份。错误读取不替换既有草稿，未知操作不生成新UUID、新payload或自动重试。冲突后显式重读并确认后才能新意图保存。
8. 通用 DIY 接口保护 `member` 及归一化别名、type错身份，其他已完成主题/分类/商品详情/FAB保护保留。实际 registered route 没有通用 `system_group/system_group_data` CRUD，不能把不存在的入口记成新增防护。当前三个其他写服务分别锁定 `pc_home_banner`、`sign_day_num`、`user_recharge_quota` 固定 namespace；本批验证它们不能改写个人中心两组，专用个人中心保存是这两组唯一 runtime 写入口。

现有 group schema 有精确 `config_name` 唯一索引，仍需识别大小写/空白别名冲突；groupData没有公开JSON字段schema强约束，服务负责完整验证。不新增生产DDL、权限授予或迁移导入来掩盖导入坏值。

最终服务的源锁合同：事务先取个人中心 advisory lock，再取 DIY catalog mutation 锁；按真实 ID 顺序对归一化名称匹配 `routine_my_banner/routine_my_menus` 的现有 group 行取共享锁，并校验唯一精确身份及完整 collection revision，之后按固定名称创建缺失组或更新受控数据。上述协议覆盖 cooperating runtime 写服务；大小写/空白 alias 的直接高权限维护和导入必须停写或采用同一锁/CAS协议，不能把行锁说明成对任意 DBA 写入的全局防护。[最终保存服务](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminUserCenterDesignService.ts:24)。

## 素材、链接和公共 DTO

广告/图标需要真正素材选择，不只一个URL文本框。复用平台 `system_attachment` 的当前归属/状态/MIME规则、canonical `/api/assets/:id` 与签名预览；锁内按升序锁真实附件，签名在SQL事务外。拒绝供应商/门店私有素材、删除图片、未授权附件及危险/未知媒体；不把后台原对象公开。

链接选择需旧 linkaddress 的基础/个人/分销/营销、商品/分类/活动、文章、专题及安全外部链接，实际 SQL 和当前注册页决定可选。可复用 [AdminFabLinkCatalogService](C:/cinagroup/cinashop/workers-ts/src/services/admin/AdminFabLinkCatalogService.ts:154) 的真实读取，但专用权限独立。`path@APPID=` 必须准确分离目标小程序，只在MP真实调用；H5/App清楚显示不支持。未迁旧URL只允许绑定原source原值保留并显示partial，公共端不执行无注册页面，新增/改目标必须有真实落点。不要将 `'#'` 当有功能的链接。

Admin snapshot：完整value含sourceId、revision、configured、editable、issues字符串数组和按三列表精准对应的imagePreviews；图片canonical参考和签名预览分离。公共 `diy_data` 只六模块允许字段，去sourceId与所有opaque，`pic`替换当前安全签名预览，另外 `user_center_design_state={revision,configured,issues}`。角色过滤后的列表和预览必须保持一对一顺序；数量不匹配明确失败，不能错配图片。客户端用严格公共guard，坏DTO显示错误/重试，不能偷偷换默认。

实际两个公开读取均返回 `actor_uid/consistency_key`；`menu/user` 返回上述 `user_center_design_state`，`menu/date` 返回 `design_revision`。Uni 先验证当前 actor 和严格 menu DTO，再要求 date 的 actor、设计 revision 和 consistency key 与 menu 一致；任一不符明确错误并重读，不能把不同配置或角色快照拼成一次页面响应。[公开投影](C:/cinagroup/cinashop/workers-ts/src/services/content/UserCenterPublicReadService.ts:104)、[客户端两读检查](C:/cinagroup/cinashop/view/uniapp-ts/src/utils/userCenter.ts:61)。此 fence 绑定一致性摘要，不把顺序发出的两次 HTTP 请求描述为一个跨请求数据库事务；操作接口仍独立重新授权。

共享模型的限制是传输形状和字节/字符上界，不替代服务端SQL的素材归属、实际链接、角色集合或CAS检查。新增name/title最长100字符、canonical pic255、url2048，poster10/menu30/merMenu30；公共签名图片允许8192字符，严格HTTP(S)/根路径、禁止credentials/协议相对地址/控制字符/反斜线，并逐层拒绝编码后危险路径，不依赖MP的URL全局。merMenu30只为历史有界读，不能当新增或删改角色集合的授权。旧PHP不严格验证这些上界，超范围历史须诊断和人工修复，不截断后自动保存。

## 无 provider 的本地完成证据与开放边界

本批可用真实编译H5+本地API场景验证全部六模块编辑/预览/保存、三份数据同事务/回滚/未知恢复、五种会员风格及九资产、三订单风格/真实计数/未支付倒计时、两统计风格/角色门禁、十图广告轮播/排序/导航、两菜单三风格/已授权管理动作、真实商品和视频收藏列表/分页/取消收藏/已删除对象状态、登入登出与旧响应隔离。还须 Admin/Uni 类型检查、H5/MP/App产物实际引用新consumer和模块，不把只含字符串的bundle当执行证明。浏览器必须检查桌面/手机、实际截图、控制台/页面异常/资源失败和真实交互。

入批 [collect.vue](C:/cinagroup/cinashop/view/uniapp-ts/src/pages/user/collect.vue:54) 永远 `category=product`，不读 `active=1`，故仅已有旧路由映射不能证明ID4完成；Worker [UserCollectCompatibilityService](C:/cinagroup/cinashop/workers-ts/src/services/user/UserCollectCompatibilityService.ts:23) 已有video列表分支和原关联顺序，真实前端恢复应接视频消费，不误用community文章ID。

旧头部会员码跳转 `/pages/users/user_member_code/index`，入批新registry无该页。[tapQrCode](C:/cinagroup/cinashop-php/view/uniapp/pages/user/index.vue:349)。会员码旧页普通H5/App能本地QR，但MP/微信H5还依赖 `activityCodeApi(90,0)` 的真实routineUrl/wechatUrl；会员码完整provider行为是独立开放项。不能用等级页或不可点击图标替代会员码并称完整，若本批恢复本地入口须清楚分支实际能力和真实码生命周期，不改财务码/支付授权。

真实微信原生客服、外部小程序、会员码provider、真机、真实身份账号、生产数据与发布保持明确开放。六模块本地候选不能关闭全部API-003或FE/整体迁移父项；Checklist只在完整证据证明对应子合同后调整。保留历史失败日志、旧构建、原快照和未解决目标，不覆盖前批验收或用mock证明生产角色/支付完成。
