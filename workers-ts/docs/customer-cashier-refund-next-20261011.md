# 普通客户现金／游客退款下一增量（2026-10-11）

本轮已进入实现与验证准备。当前实施范围为既有普通 UserJWT＋global customer 财务合同下的现金／线下人工返还、会员及真实 UID0 游客、正金额与零金额、实体行报价／申请／拆单、原 UUID 恢复和退款／核销竞争。下方早先“会员零元、本人原创建来源优先”的只读建议已被这个更完整范围替代，不能作为本批完成标准。

正金额现金确认表示经营人已实际返现，后续未知结果须保留原编号与完整正文核对，不能放弃后再起编号。服务器用独立人工返还证明和现金／零金额终态贯通成熟退款核心，游客不创建 user0，不增加余额，不制造支付渠道 SUCCESS。另一个当前合格 customer 可以管理原创建人 101 的订单；原收银记录仍是原创建凭据，退休主单不能作为当前实体退款目标。

新增原生测试文件 `test/customer-work-cash-refund-postgres.test.ts` 使用真实收银／付款／支付事件、实际普通低权限 LOGIN、独立数据库连接等待证据和实际 COMMIT 后丢回复。已编写不等于通过：源码与候选迁移尚未冻结，完整类型／数据库／前端运行及编译浏览器结果将另行取证。

## 早先只读定位（保留历史）

耐久放弃批次之后继续退款迁移。本记录仅定位下一增量，不代表实现、退款验收或旧全局管理合同已完成。

## 已核实的入口与阻断

| 范围 | 实际源码边界 |
| --- | --- |
| PHP 普通移动端管理 | `cinashop-php/route/api.php:751,760,781`：UserJWT＋CustomerMiddleware，POST `admin/order/refund` 及 `admin/order/open/refund/:id`。后者接受 refund_price/type/is_split_order/cart_ids；StoreOrder.php:970 透传真实 order.uid，含 0。 |
| PHP 现金语义 | StoreOrderRefundServices.php:629–685 的渠道分支只有微信／余额／支付宝；现金是人工现金返还后的本地审计和事件，没有 provider SUCCESS。 |
| TS cash 准入 | CustomerWorkFinancialReadService.ts:49–51 不开放 cash 主动退款及正金额现金执行。 |
| TS 深层完成 | StoreOrderRefundService.ts:599–601,1531–1532 和 RefundOrderMaterialization.ts:122–125 要求正金额非余额具备真实渠道成功证明。不能只放开白名单。 |
| TS 游客证明 | CustomerWorkFinancialVerification.ts:52,80 要求真实账户；view/common/customerWorkFinancial.ts:56 把买家 uid 要求为正数，令游客详情财务读取清除整个域。不得创建 user0 或伪造余额效果。 |
| 既有零元能力 | CashierSecondCardOrigin.ts:106–155 和 StoreOrderRefundService.ts:1320 有服务器内部会员零元次卡数量退回能力，尚无 HTTP 入口，明确拒绝 uid0。 |
| 已核销边界 | StoreOrderRefundService.ts:1084–1085,1155–1156 在实际订单／购物行锁内拒绝已核销次卡，不按剩余次数虚构比例退款。 |

## 下一步建议

先接通本人原创建来源可证明的**会员零元次卡数量退回**，复用已有服务器内部能力，从本人收银凭据进入。建立独立明确的报价、申请、零金额数量确认及原 UUID 恢复合同；成功凭据不得命名为余额退款。重新核对真实支付、来源、当前实体代次和未核销数量，旧退休主单凭据不能直接当作当前可退款订单。

随后实现本人真实来源、会员、未核销、无既有退款的整单正金额现金返还。独立现金确认／审计能力须贯通 finalizer 与实体 materializer，不制造渠道 SUCCESS。游客另建 uid0 身份及无账户资金效果核验；原 PHP global customer 授权覆盖其他经营人订单，不能把“本人来源”窄增量计为旧全局现金／游客退款完成。

可复用现有 refund.vue 的真实购物行 PK／数量报价与指纹绑定，CustomerWorkFinancialDialog 的已审查金额确认，以及 useCustomerWorkFinancialOperations 的提交前完整正文／hash持久化、同单待定阻断和原 UUID 恢复。但新零元／现金终态需要专属严格证明，不能套用 BALANCE_SUCCESS。

下一增量必须验证真实低权限 LOGIN 的退款／核销竞争、同单不同编号竞争、提交丢回复、资格丢失后的 owner 查询、错误凭据不能关闭，以及无余额增加／无渠道调用。既有零元两代验证仅覆盖未版本化促销快照，不能借为全部版本化促销退款信用。

本轮定位未改动上述业务源码，未运行新退款测试，未执行生产操作。
