# 发货设置完整页面合同（2026-10-01，本地候选）

旧入口 `/admin/setting/distribution/deliver` 的完整范围来自 `SystemConfigServices::deliverFormBuild()`，不是运费模板列表：四个固定配置键及自提开启时的默认提货点资料。新入口 `/setting/shipping` 使用独立 `shipping_settings.view/manage`；旧菜单1359的精确 `setting-distribution-deliver` 与路径组合只授查看。通用配置或门店权限不代授这项管理权限。

## 数据与实际消费

`whole_free_shipping`、`offline_postage`、`store_self_mention` 严格为数字0/1；`store_free_postage` 是0至99999999.99的十进制金额字符串，最多两位小数，保存规范为两位小数。关闭包邮保留金额。配置赢家限定 `is_store=0`，按sort DESC/id DESC，status为旧字段可见性，不是业务开关。GET不创建缺失键，不把异常值展示成真实默认值。

自提开启时保存名称、11位中国大陆手机号、真实city_area省市区及可选街道ID、详细地址、两段营业时间和经纬度。地区名称从数据库父链生成；经纬度为明确手工数值，未接地图定位provider。默认提货点保留旧“最大ID未删除行”规则，包括隐藏或非自提行；启用时将这一行设为可见、自提，其余银行等字段保留。无行才首次新增。关闭自提不改提货点，也不删除既有订单的履约资料。

普通及各活动邮费沿既有SQL权威计价：满额门槛比较折后商品款，在券与积分抵扣之前；零门槛支持全场包邮，线下支付包邮先于会员邮费折扣。所有 `shippingType=2` 报价与建单核对同SQL快照的 `store_func_status` 和 `store_self_mention`（缺失分别默认1/0），同时确认所选门店可见、未删除且为自提门店。确认指纹绑定提货点联系方式、地址、营业时间和坐标；建单共享锁保护门店，并在既有配置保护后重读同语义投影。已完成订单的原请求重放不重新授权或改变既有履约。

客户端配送建议及v2自提状态使用同SQL权威。附近门店目录保持原有单独语义，自提开关关闭不等于隐藏所有附近门店。

## 受控接口与事务

双Admin前缀各四项：GET/POST `/config/shipping`、GET `/config/shipping/cities?pid=`、GET `/config/shipping/receipts/:requestId`。固定8KiB UTF-8请求上限、重复JSON键/未知字段/重复查询参数拒绝，响应private,no-store。地区读取只返回父ID下的有界子项。

GET为REPEATABLE READ只读快照。版本包含四配置赢家完整元数据/xmin及默认提货点完整元数据/xmin；HTTP仅返回公开编辑字段，不返回门店银行等隐藏信息。写入为有界READ COMMITTED事务，固定 `system_config` → `system_store` 表锁顺序覆盖缺失键、重复赢家INSERT和默认行切换；地区行按ID共享锁并核对父链。四键、提货点回读和system_log回执同一事务，任一失败全量回滚。

UUID与规范body摘要、管理员绑定。重复原请求只回原回执；异管理员/异body冲突拒绝。只读回执真正不存在时使用HTTP404；重复或损坏日志不能伪装成不存在。浏览器按会话保存冻结UUID/body/hash，未知提交冻结新写入，刷新先查回执，只有真实HTTP404才允许显式重试原请求。配置缓存删除失败不改变已经提交的SQL成功结果。

仅版本CAS在任何业务DML前失败且事务回滚成功，返回真正HTTP409和 `SHIPPING_SETTINGS_STALE_VERSION`，证明中的UUID/hash必须精确匹配本次冻结请求。页面据此清除当次待确认状态，提示本次未保存并重新读取，允许重新编辑/确认；已成功原UUID仍优先返回成功回执。通用400、HTTP200的409信封、损坏回执或错误UUID/hash均不能作为此证明。回滚自身失败不会被标记成确定拒绝。

现有独立Admin运行权限足够，未新增DDL、数据库能力、角色或生产授权。Admin需要system_config/system_store现有DML、system_log SELECT/INSERT及序列USAGE；city_area和应用system_store共享锁使用既有UPDATE(id)及固定禁止实际写入保护。原生切片验证与完整运行权限回归的证明范围分别记录，切片不冒充完整commissioning。

## 验收边界

本批结果、日志、冻结源码摘要、桌面/390px浏览器及修复尝试集中在 `audit/admin-shipping-settings-acceptance-20261001.json`。本地合成认证/API及临时原生PostgreSQL证明不替代生产角色、Hyperdrive、真实渠道、地图定位、真机或生产规模锁争用验收。本批未提交、推送或发布。

最终后端10文件四组101项均通过（94项真实原生数据库、7项纯输入），包含完整后台保存到实际订单消费、原20项计价及16项砍价边界；审计39项、前端14项及桌面/390px浏览器21组通过。双Worker/Admin类型与最终构建通过，服务JS摘要与本地dist一致。临时PG清零停机，独立status3核对后删除仅自有data；预览和浏览器停止。此前路由顺序、地区根节点和夹具问题及截图动画尝试保留，复跑不累计。

设置台账只将旧发货设置这一屏missing→candidate；同城配送配置/记录、动态第三方配置、系统安全设置等仍开放。Checklist的FE-001D4与FE-003L-A3k11d等父项保留，不能因一屏或本地验证完成勾选正式验收。
