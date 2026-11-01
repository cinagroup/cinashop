# 原账号退款代次后的商品发货

状态：本机定向验收通过；未部署，不能作为全局启用证明。

实际业务作者仍是履约服务。成功退款只证明哪些商品分区已经退出履约，不创建发货事件。路径为真实 Admin 快递下单 → 原账号付款回调及原付款证据 → Financial 数量退款请求 → 签名查单 SUCCESS 与同事务实体拆分 → Admin 余单实际发货 → delivery outbox → opaque Queue → App 首次发货上传。维护 SQL 不补 paid、退款成功、发货事件或首上传证据。

## 退款代次与原付款

`RoutineShippingRefundGeneration.ts` 在调用者已锁定完整付款家族和商品行之后只读验证代次。它不调用退款完成器、不写财务/退款/实体行、不取得退款或结算互斥锁、不授予运行权限。

- 原付款根的 UID、订单号、交易号和全额仍是支付身份。退款余单价不能替换原始付款额；完整物理叶的价款继续与付款根守恒。
- 读取完整、正式安装的退款只读协议，以及物化/履约分支的不可变目录合同。存在代次、退款退休状态或部分安装但证据不全时拒绝，不能当作无代次旧单。
- 逐一校验退款申请指纹、物化回执、源行与商品行分区、连续退款前驱、履约分支与当前叶归属。正金额退款投影必须对应真实归档账号派发及经生产验签器保存的 SUCCESS；单独完成状态、金额或标记均不足。已有合法零现金数量物化记录仅按申请时档案的纯积分条件（type4、现金价0、积分正数），结合当前实体现金价0和完整分区证明读取，且必须没有退款 payment；不伪造提供方 SUCCESS，本轮没有这类正向运行证明。普通正价微信商品的零金额申请仍由原 Financial 规则拒绝。
- 只有证明完成的 selected/whole 分区可以退出包裹集合。活跃叶仍需真实履约 outbox；没有活跃包裹的全退付款不能因此上传空包裹。
- 缺少物理行、可变退款/付款行或原付款证据、未知历史归属、未完成退款及不完整代次均拒绝。没有历史修复、归属猜测或自动回填。

## 回执与锁顺序

商品退款代次使用 dispatch `format:3`，保存完整有序的 refund/branch 引用、active/retired 物理 ID 和独立 HMAC 代次摘要。既有 format1 与 format2 解码函数及其验签字节保持。使用同一个原商品付款的 `payment-source` key；新格式不能创建另一个付款来源规避旧 UNKNOWN、失败或成功回执。

首次提交在既有付款来源边界内检查全部派发历史。同一已证明代次仅可按既有规则扩包：旧部分上传有真实成功回执、前次包裹逐项不变、新包裹增加且 upload_time 严格递增。不同代次或 format1→format3 不被解释为扩包/更正授权。无结果的旧派发继续占据原边界；不会被新版本或 Queue 重放覆盖。

锁顺序保持物理家族 → 自身 delivery → 事件/商品行 → 退款代次只读证据 → 原付款/独立 NativeApp 反证 → 原付款来源边界。正式维护 gate 与业务行使用已有 try/NOWAIT 规则；不从 root 方向调用退款写者的 refund → root 锁链。token、承运商列表与 POST 在事务外执行；POST 前重新验证物理/代次状态和归档账号批准。结果与 SENT 同事务提交，可能已发出的丢失结果仍是 UNKNOWN。

## 固定 PHP 完成规则

对照 PHP commit `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`：

| 来源 | 事实 |
| --- | --- |
| `StoreOrderRefundServices.php:698–747`，blob `c2ae4f3de7b62097fdd0480556656430e7e2676a` | 数量退款实体拆分，选中叶标记退款完成，余单继续存在。 |
| `OrderShipping.php:25–47,85–116`，blob `51eb218735bd2d70c45a3e5f215f8d7d46a2e612` | 子单发货 mode2，使用原付款交易与根订单路径。 |
| `StoreOrderDao.php:1100–1103`，blob `c6c0ddf23eb662e1373eb5a2dcfa96a32fa4504c` | 完成判断仍计所有其他 status0 子单，没有排除已退款子单。 |

因此已退款的 status0 子单仍让 `is_all_delivered=false`，即使所有活跃余单已发货。本实现保留这一可观察规则；不能称为“全部履约完成”。若以后要忽略已退款子单、结束永久 partial、接纳已完成上传后的物流更正，须有另外明确的产品/提供方规则。

## 验收边界

原生用例在 `test/routine-refund-shipping-native.test.ts`，使用自有本机 PG16、实际独立 LOGIN、生产 Admin/Financial/App 与 Node RSA/AES。provider、Queue、KV 是受控传输。9 项新原生用例通过：首次余单发货、连续退款、退款后真实履约分支与扩包、丢失 POST、旧 format1 UNKNOWN、防并发改动、PROCESSING、缺失 durable SUCCESS，以及实际 Financial 正价商品零金额申请被拒绝且订单/商品/退款/付款/物化/余额不变（拒绝操作回执仍留存）。同一最终候选还有既有 express12、自提10、虚拟发货13，共44项原生，74项单元、Worker unit/runtime 两套及 Admin 类型检查通过。最终顺序验证 1350.67 秒、8 个输入运行期间未变化，3个自有cluster均 remaining=0 后 STOPPED；证据在 `.cache/php-ts-phase36-validation/`。

没有生产 DDL、部署、真实微信、Browser、Workerd/Hyperdrive 或负载验收。本轮没有新的 rendered UI。保留用户、UID、权益、旧单及付款；跨 AppID 屏障、`runtime_ready=false`、完整迁移及既有 CI 缺口保持未完成。

没有专门运行64/201容量、整退兄弟分区、历史soft-delete、format3完成更新失败回滚、清空当前配置或纯积分零款正向路径；不得用其他格式/元数据测试代称这些分支。首轮8通过/1失败的失败来自正价零退款申请被真实作者拒绝，测试改为保留该规则；随后零读取条件收紧到成熟纯积分档案，中止的final03不计作最终验证。helper为作者自审及root复核；Dispatch/实际九案有交叉作者只读审查，不称独立安全审计。
