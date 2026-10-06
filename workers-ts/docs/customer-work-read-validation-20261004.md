# 手机经营读链验证（2026-10-04）

本批承接旧 `work/customer` 的七个手机经营读页，完整角色合同仍为 **partial，未发布**。页面包含工作台、统计、订单、订单详情、退款、退款详情和物流；商品与用户管理、发货／备注、改价／线下付款、退款写入及代客整链留在后续阶段。个人中心仍 **25/26 partial、menuRoleGates=false**，不据七个读页关闭完整手机经营工作台或发布父项。

## 身份和数据范围

旧 PHP `customer=1` 字段表示“手机订单管理”。当前用户必须有效，且只有一份未删除、账号启用的客服记录拥有 `customer=1`；`status` 是独立聊天开关，`status=0` 的手机经营身份有效。客服聊天、店长、门店核销、配送员或 AdminJWT 自身均不授予该全站权限。新接口位于 `/mobile/work/*`，使用 UserJWT 和 App 数据库读取；既有 `/admin/*` 的认证和数据库边界保留。

个人中心在同一只读可重复读快照中判定 `work`，在发布响应前再读取当前资格。菜单位置和旧 `type` 字段不授予权限，广告、个人菜单和商家菜单按真实目标过滤；客户端也严格验证布尔角色、匿名权限和实际点击。`work` 不扩大现有店长专用 `order.user_order` 统计。

销售、订单总量、趋势和按日数据采用全站履约订单。旧 PHP Model 的整数 `pid=0` 搜索实际转换为 `pid>=0`，包括正子履约订单并排除 `-1` 支付头；不能以控制器中的字面参数或旧 AdminStatistic 的硬 `pid=0` SQL声称等价。旧待核销计数省略pid；本批六卡统一排除负支付头是明确修正，不宣称该卡完全等价。状态计数和工作台待发货徽标另限制 `store_id=0/supplier_id=0`，退款徽标和商品库存为全站范围，浏览量为全站商品浏览。各响应携带明确的 `metric_scopes`，页面逐区显示范围。

旧 `getFrontTime` 的定义未在可读 PHP 树中找到，当前上海时区半开区间、等时长前期和完整日期分组明确作为修正，不伪称逐秒复刻旧缺失实现。旧警戒库存条件是 `is_police=1 && stock>0`，不添加已被旧代码注释的阈值条件。

## 实际路由合同

七个目标页通过 `CustomerWorkShell → ThemePage` 承载；共享纯解析器同时供服务端菜单和真实客户端使用。

| 旧页面 | 当前目标 | 参数 |
| --- | --- | --- |
| admin/work/index | customer-work/index | 无 |
| admin/order/index | customer-work/statistics | type=1/7/30 |
| admin/orderList/index | customer-work/orders | types→status，业务选择器及搜索 |
| admin/orderDetail/index | customer-work/orderDetail | id→orderId，业务订单号 |
| admin/refundOrderList/index | customer-work/refunds | refundTypes、apply_type、order_id、time |
| admin/refundOrderDetail/index | customer-work/refundDetail | id→refundOrderId，退款业务单号字符串 |
| admin/logistics/index | customer-work/logistics | orderId，type=refund 仅退款物流 |

原始重复参数、冲突别名、未知参数、无效日期或缺失详情标识拒绝。经营读页只连本批真实读目标；旧发货／退款写页仍按既有合同保留，未用商家授权替代全站手机经营身份。

## 证据状态

入批实际读取并核对 419056 条逻辑引用、356334 个唯一 raw/LF 哈希任务，读取 11561078131 字节，零不匹配；60 个历史目录和17742个构建文件保留。根、后端、前端和独立审计各自保存修前字节或真实新文件不存在的观察，继承客服增量 master 与更早配送 master；不重新复制大体积历史哈希语料。

最终Worker唯一 **143项**通过：后端普通LOGIN22、个人中心当前SQL/HTTP23、门店边界明确选择1，共46原生SQL；独立真实服务／七页方法60及主题宿主37，共97其它运行时与源码合同。门店文件其余34项未选择，不计本批通过或本批待执行失败。后端10实际reader DTO进入真实前端守卫，独立60项不替代SQL。Uni用户中心43及经营页面15，共58实际运行时通过。115页真实主题宿主、完整Uni类型、H5／MP-WEIXIN／APP三平台均通过。最终编译浏览器20组、单列QA6通过；浏览器与服务器已关闭，4个Root与5个Backend本批PG集群均实际status3、端口关闭、测试数据库及角色remaining0。

浏览器真实发现统计选择器刷新时卸载原生picker宿主，修复仅保留picker宿主并仍即时清空敏感summary。已重新冻结源、独立60项、页面15项、主题37项、完整类型、三平台构建及编译浏览器；旧两次浏览器失败及其他失败／被替代通过原样保留。两套三平台产物各1120文件，只有final2作为当前编译证明，不将两轮相加为测试通过数。

Worker完整unit及runtime类型检查以8GB堆顺序实际退出0，输入未漂移、stdout/stderr为空。两者的完整源输入及原始副本与本批所有日志／源输入／前后副本由[冻结验收](../audit/customer-work-read-acceptance-final3-20261004.json)严格绑定；每次失败和未选择项保持自己的执行状态。

旧订单详情中的 give_coupon/give_integral、virtual_info、优惠券与积分折扣及 expanded promotions_detail 尚未完整展示，保留为后续商品与财务阶段扩展字段，不据核心详情投影声称整页等价。

## 剩余阶段

1. 履约操作：备注、手动／虚拟／拆单发货、电子面单和恢复收据。
2. 商品及用户管理：SKU、标签／分组／等级、优惠券与相应读写权限。
3. 财务及代客：改价、线下付款、退款财务状态、余额／积分、选客到支付整链。
4. 独立核销及正式验收：当前核销角色、真实生产资格／配置、provider、设备、Linux／Hyperdrive、容量和发布。

本批全站一致性摘要和物流 provider 边界须以本地执行及容量证据评估；本地隔离普通 LOGIN 不代表生产角色授权已应用。本批不提交、推送或部署。

首份冻结验收实际退出1：47份当前源拥有者与419056条继承引用／356334个唯一历史任务的期待结构、60个历史输出目录／17742文件集合已核对，但新清单只纳六个平台目录的2236文件，漏了两套App各2个`.nvue`附属文件。完整历史哈希及当前checks尚未执行，不算通过。原master／reader／失败proof及日志保持原字节；Final2仅补两份附属目录，八个新目录共2240文件，仍只有final2的三平台与其App附属物作为当前编译证明。

第二份冻结验收实际退出1：八个新目录2240文件及六个当前检查已核对，但验收reader将FE默认Node spec报告误按TAP读取。FE实际退出0且15项全通过；原日志未改。该reader格式失败及master／proof／日志保持原字节，尚未执行完整继承哈希，不计整体验收通过；Final3仅严格兼容原始TAP和spec计数并更新验收引用，不改变业务源、构建产物或独立用例数。
