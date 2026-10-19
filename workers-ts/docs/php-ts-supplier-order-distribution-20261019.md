# Supplier 已发货包裹配送信息修订

## PHP 实际入口与本批范围

PHP `orderDetails.vue:52–56,829–834` 的“配送信息”在普通详情和具体拆单包裹上可达；`orderList/index.vue:822–837` 调用 GET `distribution/:id` 并挂载通用表单，成功后刷新列表、详情和包裹。`route/supplier.php:374–377` 的 GET/PUT 经实际 Supplier 控制器引用的 CommonOrder trait，进入 `StoreOrderDeliveryServices.php:555–628`。旧实现按既有 express/send/fictitious 通道编辑配送名称、号码或交付备注，更新订单并记 distribution 状态，不重新发货。

TS 新增相同 GET/PUT `/supplierapi/order/distribution/:id` 和实际 Orders 中的编辑弹窗。原 `distribution_info` 是配货单，`express/:id` 是物流查询，`delivery/:id` 是首次履约，均保持原职责。新功能选择实际数值包裹主键，不把拆单根或待发余单当作已发货目标。

允许当前 paid=1、raw status=1、refund_status=0、shipping_type∈{1,3}、未删除且无进行中售后的叶子包裹：physical type0 手填快递、manual type3 虚拟备注，以及 delivery_uid=0、没有受管履约标记的历史手工同城配送。修改同城姓名/中国手机号时不改 delivery_uid。已实名绑定的配送员、电子面单、第三方任务、商家运单回调或既有面单/任务标记保持对应履约权威，GET 返回实际值和只读原因。

PHP business status4 实际包含 raw status1/5。此批明确仅开放 raw1；raw5 的部分核销/配送修订未完成。自动卡密、核销商品、修改履约通道、取消/重签面单和重新分配配送员均未由本接口实现，不能把这批称为完整订单域迁移。

## 写入、权限与结果核对

GET 返回实际配送字段、当前启用快递目录、editable/reason 和64位 HMAC revision。PUT 严格接收 expected_revision、delivery_name、delivery_id、fictitious_content 四字段；无效类型字段必须为空，不能提交 code、UID、租户、状态或金额。快递 code 从当前唯一启用公司名称取得；虚拟备注最多500 Unicode codepoints，允许换行。接口只更新通道对应的有效列，其他历史字段保留。

每次调用独立事务，读取为短 REPEATABLE READ/READ ONLY；写入使用真实 Supplier JWT、当前密码、租户、角色与权限，取得既有结算根锁、父/目标行锁并重复验证。revision 绑定实际行版本、父单、当前权威版本、目录和受管任务版本。父单的买家/门店/供应商关系和支付、删除、退款资格亦参与约束。旧 revision 返回409；无变化返回当前事实且不追加审计。普通修改完整回读目标行、父及其他相关权威，原子追加一条仅含 actor/supplier/channel 的 distribution 日志；备注、电话、运单号不复制到日志。约束延迟执行后再次回读，异常会回滚业务行。

目录 SHARE 锁和配送表 NOWAIT 锁防止合法目录更改和配送回调在写入尾段越过检查；不存在的整组 provider 表兼容旧运行环境，部分 city catalog、不可读或异常结构失败关闭。专属 supplierOrderDistribution 夹具及 Browser 的 writer 是独立 LOGIN：订单仅四个有效列有 UPDATE，另有状态 INSERT/序列权限；auth 四表、目录及配送表有成熟表锁需要的表级 UPDATE。不能把它描述为整体 SELECT-only 或整体仅四列可写。最后的真实 checkout 案例另沿用 refundRuntimeFixture 的成熟独立 LOGIN，它为创建、支付分配、发货持有更宽的订单 INSERT/UPDATE 等权限；不能把这个角色也称作订单四列作者。该案例证明真实生产者到消费者的业务链，专属夹具另证明修订本身的权限边界。本批不向生产运行角色安装权限、DDL 或迁移。

前端保存等待期间阻止重复提交。包裹、详情、路由、会话或权限代次变化即清理并取消旧请求；A→B→A 不接受早先 A 的结果。成功回执校验包裹身份与提交内容，再刷新列表、详情和状态日志。网络、5xx 或无效回执显示结果未知；显式 GET 只显示当前事实，用户核对并点击继续编辑后才恢复保存。此接口没有独立 UUID 历史回执，不声称 GET 可以证明某个原操作提交成功；revision 与 no-op 防止盲重试覆盖更新或重复日志。

## 验证记录

最终执行与源码指纹见同名 `workers-ts/audit/php-ts-supplier-order-distribution-20261019.json`。8个测试文件合计529个不同用例通过，其中108个为本批新增：41个实际编译 SFC、61个实际 App/JWT/独立 PG16、5个 runner 准入及1次生产构建 Browser。计数由最终4文件386个前端/纯回归、2文件81个既有原生回归、新增原生61个及 Browser 1个组成。既有81个来自首轮退出码1的三文件运行：两个成熟文件全部通过；失败的新文件60个通过明确排除，修正夹具后全61个单独重跑且只计一次。

Supplier 的 vue-tsc 与 Vite 构建通过，Worker 完整单元及 runtime-test 两套 TypeScript 检查通过。前端执行期间仅后端 SQL 范围继续收紧，所用前端与 runner 输入均与最终 SHA 一致。Worker 类型执行输入与最终代码仅有原生测试中两个公开固定 UUID 字符串值的差异：逐字反向重建的 SHA 与执行捕获值完全一致，类型、断言和逻辑未改；替换后的最终61例再次完整通过。不得把这两份执行记录的整体 source_unchanged 标记改成 true。

真实 Browser 使用实际 Supplier 生产构建、App、JWT 与专属独立 LOGIN，48次请求中44个 GET 对19表/18序列逐次零写，4个 PUT 顺序仅补正包裹100、具体子包裹202、手工虚拟102和历史手工送货103，各只改有效配送列并追加1条脱敏日志；根单、另一子包裹、其他订单及无关表/序列保持。取消路径完整零写，已绑定配送员104显示只读原因且无保存动作。500个表情输入保留1000个 UTF-16 单位，显示500/500字，随后正常交付备注保存并重新打开回读一致。1200×844与390×844同源 iframe 中弹窗和页脚均在范围内且未遮挡，控制台 warn/error 抽样为空；这是响应布局证据，不是实机仿真。所有 provider 出站调用为0。启动时实际 GET /api/get_script 返回200，保留原 JavaScript 响应。

早期失败如实保留：两处组件断言、测试 Env 类型转换、可选 city 表不存在时的夹具 GRANT 假设、Browser 桥接器错误解析 get_script，以及主动结束的未完成验收。最终源已修正并重验，未放宽产品校验或 TypeScript 配置。源扫描曾把两个公开测试 UUID 误判为通用密钥，换成明确的全零公开夹具值，扫描配置未变。7座自有临时 PG（包括失败运行）均夹具清零、停止且 PID 文件不存在。

本批继续保留用户裁定的已恢复 PHP `get_script` 行为及修订退役审计。生产部署、真实供应商角色、真实承运商/同城服务账号和真实设备验收仍是后续发布门禁，根清单复选项不因本地候选自动勾选。
