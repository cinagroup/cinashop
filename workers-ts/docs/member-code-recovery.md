# FE-003B 会员码链路审计与恢复合同

状态：**整体未恢复、未发布**。`main@b5adcef` 已包含显式分配/读取，以及已登录店员、配送员的会员码查单、选单预览和同事务核销。2026-09-27 候选新增原路径会员码页的本地二维码展示；微信专用二维码发行、扫码真机、付款及正式客户端链路仍开放。本文件按 `C:/cinagroup/cinashop-php` 的旧 PHP 和 UniApp 源码，以及当前 Worker、UniApp、Admin 源码核对。会员码不能以一张只显示二维码的页面验收。

## 旧端的两个码和扫码落点

| 码 | 旧端来源与用途 | 当前状态 |
| --- | --- | --- |
| `user.bar_code` | 旧 `/userinfo` 读取时，若为空，调用 `UserServices::getBarCode()` 生成并写入用户行。旧会员码页又调用 `/userinfo`，显示此码；`get_qrcode/90/0` 的普通 H5 二维码 URL 和小程序 `scene` 指向 `/pages/admin/order_cancellation/index?auth=3&code=<bar_code>`。若 `share_qrcode` 开启且请求来自微信，H5 分支改为公众号临时 Ticket，属于不同扫码协议。旧 `order_verific` 用条码寻找该用户待核销订单，后续另有核销操作。 | Worker 候选代码的鉴权 `POST /api/user/bar_code` 可显式分配/读取；`/userinfo`、`/user` 保持只读。店员、配送员的候选扫码入口已接入现有 UniApp 操作员页，按登录身份查单、预览并核销；旧 URL 的 `auth=3` 不授予权限。生产唯一索引、重复码预检与旧 PHP 写入者协调尚未验收；`/get_qrcode/90/0` 没有实现。 |
| `user/rand_code` | Redis 按 UID 缓存 600 秒的六码。旧收银台余额支付在配置要求验证时读取并删除该码，再比较顾客提交值。旧会员码页与 `/userinfo` 并发请求，两个回调都写 `config.qrc.code`，实际显示有竞态。 | Worker 已能生成和复用十分钟六码，但目前没有对应的收银台余额支付消费合同。它不能代替 `bar_code` 去做订单核销。 |

旧源码锚点：`view/uniapp/pages/users/user_member_code/index.vue` 的 `onLoad`/`getCode`/`getUserInfo`/`activityCodeApi`；`app/controller/api/v1/other/Qrcode.php::getQrcode` 的 `case 90`；`app/services/other/QrcodeServices.php::getRoutineQrcodePath` 的 90 分支；`app/controller/api/admin/order/StoreOrder.php::order_verific`；`app/services/order/cashier/CashierOrderServices.php::paySuccess`；`app/services/user/UserServices.php::getBarCode` 和个人中心读取。

## 当前目标合同的断点

1. `UserProfileService::safeAccount` 投影旧 `bar_code`，但刻意不在 GET 中写用户。Worker 候选代码增加了显式鉴权 `POST /api/user/bar_code` 和全体非空码唯一索引迁移；上线前仍须对生产所有非空码（包括停用/删除用户）只读查重，确认迁移锁/行数预算，并协调仍会写 `bar_code` 的旧 PHP。操作员扫码页已有候选接入，真实客户端与生产身份仍待验收。
2. `/api/admin/order/order_verific` 由 Admin JWT 和 `order.view` 保护，`StoreOrderWriteoffService::legacySummarySearch` 能按唯一活跃用户的 `bar_code` 找最多 20 个候选订单，且仍要校验订单和操作员。这是 **Admin 查询**，不是旧客户 UniApp 的 `auth=3` 扫码落点。
3. 旧 `/api/store/order/writeoff_info/:type` 的 `resolveWriteoffActor` 只接受 `auth=1` 客服与 `auth=2` 配送员，旧 URL 的 `auth=3` 不能作为授权。候选 `/pages/operator/writeoff` 已增加会员码查单、选单预览与核销：Worker 的 `/store|delivery/order/member_lookup`、`member_info`、`member_writeoff` 使用当前登录 UID 和有效店员/配送员目录；旧 12 位订单码仍走原入口。页面能解析旧路径及编码后的 `scene`，但旧发布客户端的实际扫码跳转与当前页面注册关系仍须真机验证。
4. `/adminapi/member_scan` 返回付费会员**激活**码，扫码目标是 `/pages/annex/vip_active/index`。它和用户会员码无关。
5. 旧会员码页在普通 H5（非微信环境）和 App 由 `w-qrcode` 本地绘制裸 `bar_code`；小程序和微信 H5 则分别读取 type=90 的 `routineUrl`、`wechatUrl`。旧 `get_qrcode` 的 URL／小程序导航与公众号临时 Ticket 是独立发行协议。新候选恢复本地裸码展示，操作员在应用内核销页扫描此码；未实现 type=90 图像接口，也未宣称系统相机扫码后自动导航。公众号 Ticket、裸 `bar_code` 和可导航 URL 仍分别验收。

## 可实施的完整替代合同

1. **分配与读取：** 主线 Worker `POST /api/user/bar_code` 显式鉴权并锁住当前 UID；旧有效 `bar_code` 保持不变。上线前对所有历史非空码只读查重并制定重复值修复方案，与旧 PHP 写入者协调唯一索引的部署顺序。分配由数据库唯一约束保证不重复，冲突重试；`userinfo` GET 不隐式写入。停用/删除账户及重复、无效旧码失败关闭。用户候选页仅在本人点击显示时调用此 POST，不请求十分钟付款码。
2. **明确扫码身份：** 候选店员/配送员扫码页解析用户码，由 Worker 根据登录的操作员身份决定可见订单，不采信 URL 里的 `auth`。扫码只返回授权订单的最少摘要；选中订单后重新校验当前操作员、用户码与订单归属。写入复用现有订单锁、商品行锁、剩余次数/售后门禁和审计；查询不会直接核销，过期摘要不能直接提交。
3. **一码一落点：** 本地裸码由已登录操作员在核销页内扫描／查询，不能被当成可导航 URL。微信专用二维码仍须指向真实注册的扫码落点：小程序 `scene` 需要准确编码、长度校验和实际发布的 AppID/页面路径；H5 只允许配置的站点来源。裸用户码、带 `auth=3` 的旧 URL 或未经验证的 `scene` 均不授权核销。若保留静态旧码兼容，要明确撤销/轮换、限流和旧客户端退役策略；更安全的新码可采用短期服务端令牌，但要与旧 `bar_code` 兼容窗口分开记录。
4. **付款码独立：** 若会员码页继续展示 `rand_code`，收银台余额支付必须提供同一 UID、订单与金额绑定的原子一次性消费/失败结果合同，并验证重放、并发和结果不明。现有生成接口单独存在，不能作为已经实现扫码支付的证据。
5. **页面生命周期：** 仅已登录本人能取码；隐藏、卸载、登出、会话更新立即清除码与二维码；迟到响应不可恢复旧账号内容。对二维码生成失败、条码缺失/重复、无权限操作员、无待核销订单给出明确状态。余额、券、积分、等级展示各用其权威只读接口，且不能暗示扫码即支付。

## 验收门禁

- Worker 原生 PostgreSQL：空码首次分配、并发两用户冲突、旧码保持、停用/删除/重复码拒绝；不同店员/门店/配送员不能越权查询或核销，零单、多单、退款/拆单/过期/已核销、并发重复操作全部按当前事务合同收敛。
- UniApp H5、MP-WEIXIN、APP-PLUS：会员码展示文本与扫码内容一致；裸码由实际注册的操作员页面内扫码查单，登录及身份切换清除私有内容。微信专用码的导航／`scene`、扫码相机与旧发布客户端原位升级需要真机和已发布渠道验收。
- Admin：真实 Admin 权限扫描既存条码可读、无 `order.view` 不可读；扫码只查询，确认核销仍走受保护写操作。真实用户、操作员、配置、数据库运行身份及正式发布均需再验。

## 2026-09-27 会员码展示候选

- 原 `/pages/users/user_member_code/index` 直接注册，个人中心提供入口；页面不在加载时分配码，只有本人点击“显示会员核销码”后读取鉴权 POST 的稳定 `bar_code`。无 `rand_code` 请求。
- 文本和二维码保留同一裸码，拒绝 12 位订单码、URL／参数歧义、空白和无效响应；历史中文内容以 UTF-8 编码。页面隐藏、卸载、登出或会话更新立即移除码和画布；迟到请求与绘图回调不能恢复旧内容，绘图失败／超时允许显式重试。
- 采用已有 QR 依赖，四模块白色静区、整数像素模块，画布绘制尺寸和 CSS 尺寸相同。实页测试曾发现 CSS 256px 与绘图 264px 的裁切，最终修正为按整数模块向下取整：16 位数字码 231×231、32 字符中文码 245×245。
- 最终运行时 19/19、类型检查和路由审计 18/18 通过。隔离合成 H5 在 1280×900 与 320×844 直接读取实际 canvas 像素：两组矩阵均无错位，并用独立解码器还原原字符串；隐藏和无效响应均移除私有码，无横向溢出／应用错误。仅保留既有 Vue Router 导入警告；像素读取警告来自 QA 检查。
- 目标页 94、原路径直达 29、兼容规则 100、剩余路由缺口 22，旧端 151 路由仍唯一归档。最终 H5、MP-WEIXIN、APP-PLUS 构建及三端产物检查 3/3 通过；候选精确头 Linux CI 以 PR 的最终验证记录为准。

主线已包含显式会员码分配/读取、数据库唯一索引，以及登录店员/配送员按会员码查单、预览、核销的本地实现；本批增加本人展示候选。生产迁移与旧 PHP 写入者、微信专用二维码发行、真实 H5/微信小程序/App 扫码、已发布旧客户端原位升级、生产角色和数据、独立的付款码链路仍需分别验收；FE-003B 和 247／157／404 保持开放／不变。
