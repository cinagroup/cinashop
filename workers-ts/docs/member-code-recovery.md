# FE-003B 会员码链路审计与恢复合同

状态：**整体未恢复、未发布**。Worker 候选代码已实现第 1 阶段的显式分配/读取；扫码、付款和客户端链路仍开放。本文件按 `C:/cinagroup/cinashop-php` 的旧 PHP 和 UniApp 源码，以及当前 Worker、UniApp、Admin 源码核对。会员码不能以一张只显示二维码的页面验收。

## 旧端的两个码和扫码落点

| 码 | 旧端来源与用途 | 当前状态 |
| --- | --- | --- |
| `user.bar_code` | 旧 `/userinfo` 读取时，若为空，调用 `UserServices::getBarCode()` 生成并写入用户行。旧会员码页又调用 `/userinfo`，显示此码；`get_qrcode/90/0` 的普通 H5 二维码 URL 和小程序 `scene` 指向 `/pages/admin/order_cancellation/index?auth=3&code=<bar_code>`。若 `share_qrcode` 开启且请求来自微信，H5 分支改为公众号临时 Ticket，属于不同扫码协议。旧 `order_verific` 用条码寻找该用户待核销订单，后续另有核销操作。 | Worker 候选代码的鉴权 `POST /api/user/bar_code` 可显式分配/读取；`/userinfo`、`/user` 保持只读。生产唯一索引、重复码预检与旧 PHP 写入者协调尚未验收；`/get_qrcode/90/0` 没有实现。 |
| `user/rand_code` | Redis 按 UID 缓存 600 秒的六码。旧收银台余额支付在配置要求验证时读取并删除该码，再比较顾客提交值。旧会员码页与 `/userinfo` 并发请求，两个回调都写 `config.qrc.code`，实际显示有竞态。 | Worker 已能生成和复用十分钟六码，但目前没有对应的收银台余额支付消费合同。它不能代替 `bar_code` 去做订单核销。 |

旧源码锚点：`view/uniapp/pages/users/user_member_code/index.vue` 的 `onLoad`/`getCode`/`getUserInfo`/`activityCodeApi`；`app/controller/api/v1/other/Qrcode.php::getQrcode` 的 `case 90`；`app/services/other/QrcodeServices.php::getRoutineQrcodePath` 的 90 分支；`app/controller/api/admin/order/StoreOrder.php::order_verific`；`app/services/order/cashier/CashierOrderServices.php::paySuccess`；`app/services/user/UserServices.php::getBarCode` 和个人中心读取。

## 当前目标合同的断点

1. `UserProfileService::safeAccount` 投影旧 `bar_code`，但刻意不在 GET 中写用户。Worker 候选代码增加了显式鉴权 `POST /api/user/bar_code` 和全体非空码唯一索引迁移；上线前仍须对生产所有非空码（包括停用/删除用户）只读查重，确认迁移锁/行数预算，并协调仍会写 `bar_code` 的旧 PHP。客户端尚未接入，不能把候选接口当作已恢复的扫码身份。
2. `/api/admin/order/order_verific` 由 Admin JWT 和 `order.view` 保护，`StoreOrderWriteoffService::legacySummarySearch` 能按唯一活跃用户的 `bar_code` 找最多 20 个候选订单，且仍要校验订单和操作员。这是 **Admin 查询**，不是旧客户 UniApp 的 `auth=3` 扫码落点。
3. `/api/store/order/writeoff_info/:type` 有按用户条码查单能力，但现有 `resolveWriteoffActor` 仅接受 `auth=1` 客服与 `auth=2` 配送员，不接受旧码里的 `auth=3`；新 `/pages/operator/writeoff` 和 `/store|delivery/order/writeoff_info` 只解析 12 位订单核销码。不能把旧 URL 原样路由到这些页面并假装可用。
4. `/adminapi/member_scan` 返回付费会员**激活**码，扫码目标是 `/pages/annex/vip_active/index`。它和用户会员码无关。
5. 旧 `get_qrcode` 在普通 H5 和小程序使用扫码导航，在特定微信配置下却返回公众号 Ticket。新端既没有 type=90 的图像接口，也没有已注册并具备正确操作员权限的二维码落点；不能把公众号 Ticket、裸 `bar_code` 和可导航 URL 当成同一编码。仅编码裸 `bar_code` 的静态图也无法完成扫码、选择订单与核销。

## 可实施的完整替代合同

1. **分配与读取：** 候选 Worker `POST /api/user/bar_code` 显式鉴权并锁住当前 UID；旧有效 `bar_code` 保持不变。上线前对所有历史非空码只读查重并制定重复值修复方案，与旧 PHP 写入者协调唯一索引的部署顺序。分配由数据库唯一约束保证不重复，冲突重试；`userinfo` GET 不隐式写入。停用/删除账户及重复、无效旧码失败关闭。用户页面仍需只读服务端确认的码，不把十分钟付款码覆盖进去。
2. **明确扫码身份：** 为已注册的店员/配送员扫码页增加用户码解析入口，由 Worker 根据登录的操作员身份决定可见订单，不采信 URL 里的 `auth`。复用 `legacySummarySearch` 的上限和订单资格检查，扫码只返回最少的订单摘要；选中订单后重新校验当前操作员、用户码与订单归属。写入时必须复用现有订单锁、商品行锁、剩余次数/售后门禁和审计；不得把扫码查询变成核销，也不能用已过期的摘要直接提交。
3. **一码一落点：** H5/微信小程序/App 的二维码内容都指向真实注册的扫码落点。小程序 `scene` 需要准确编码、长度校验和实际发布的 AppID/页面路径；H5 只允许配置的站点来源。裸用户码、带 `auth=3` 的旧 URL 或未经验证的 `scene` 均不授权核销。若保留静态旧码兼容，要明确撤销/轮换、限流和旧客户端退役策略；更安全的新码可采用短期服务端令牌，但要与旧 `bar_code` 兼容窗口分开记录。
4. **付款码独立：** 若会员码页继续展示 `rand_code`，收银台余额支付必须提供同一 UID、订单与金额绑定的原子一次性消费/失败结果合同，并验证重放、并发和结果不明。现有生成接口单独存在，不能作为已经实现扫码支付的证据。
5. **页面生命周期：** 仅已登录本人能取码；隐藏、卸载、登出、会话更新立即清除码与二维码；迟到响应不可恢复旧账号内容。对二维码生成失败、条码缺失/重复、无权限操作员、无待核销订单给出明确状态。余额、券、积分、等级展示各用其权威只读接口，且不能暗示扫码即支付。

## 验收门禁

- Worker 原生 PostgreSQL：空码首次分配、并发两用户冲突、旧码保持、停用/删除/重复码拒绝；不同店员/门店/配送员不能越权查询或核销，零单、多单、退款/拆单/过期/已核销、并发重复操作全部按当前事务合同收敛。
- UniApp H5、MP-WEIXIN、APP-PLUS：会员码展示的数字与扫码内容一致，扫码到实际注册的操作员页面，登录及身份切换清除私有内容；微信 `scene`、扫码相机与旧发布客户端原位升级需要真机和已发布渠道验收。
- Admin：真实 Admin 权限扫描既存条码可读、无 `order.view` 不可读；扫码只查询，确认核销仍走受保护写操作。真实用户、操作员、配置、数据库运行身份及正式发布均需再验。

本批候选代码只完成显式会员码分配/读取、数据库唯一索引及私有取码响应的 `private, no-store` / `no-referrer` 头。生产迁移、旧 PHP 写入者、客户端展示、扫码与付款链路仍需分别验收；FE-003B 仍保持开放。
