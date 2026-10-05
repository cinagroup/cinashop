# 满送公开整单退款入口

2026-09-30，本地部分承接，未发布。本增量在[满送管理与订单消费者](admin-full-gift-route-contract.md)之后接通客户及 Admin 的整单售后；广义实体拆单仍不对公开入口开放。最终专项结果见[本批验收](../audit/admin-full-gift-refund-entry-acceptance-20260930.json)，旧满送验收保留为前批证据。

## 入口与准入

既有客户 `POST /api/order/refund/apply/:id`（订单号或所属订单 ID）及 `POST /api/order/refund/verify`，通过 `StoreOrderRefundService.applyRefund` 调用固定的 `applyOrderRefundFromPublicEntry`。Admin 两前缀 `/adminapi/refund/creation` 与 `/api/admin/refund/creation` 的 quote/create/execute/receipt/abandon 保持原身份、请求键和回执合同，由管理权限及当前 actor 的 SQL 核验授权。没有新增路由，也不接受客户端或配置中的执行版本开关。

只接受严格 `order-promotion-gifts-v1` 来源、`pid=0/type=0/status=0/paid=1` 的原始未发货普通订单。客户类型为 1；Admin 为经过授权的 4。全额实付必须大于零，支付方式必须是余额、微信或支付宝；最多 100 行，所有购买与赠品行均须选择其全部数量。任何部分数量、少退金额、已发货、拆单、退货验收、零款或仅剩赠品的流程继续拒绝。

入口在订单锁内从存储的来源证据选择 `refund-quantity-materialization-v2`，其他普通订单仍预占 v1。旧 v1 满送申请不能在重放时升级，普通 `applyOrderRefund` 和自动退款保持原合同；更广义 `applyOrderRefundWithMaterialization` 仍是显式服务器候选。客户重复活动申请拒绝；Admin 通过原 actor/key/body 的独立创建、执行回执恢复，已提交申请不会因网络失败被视为回滚。

## 完整付款与固定运行合同

全部赠品 SKU/数量、赠券的订单/活动/层/池及实际券实例、原赠积分流水均须相符。即使只送实物，也必须有精确订单绑定的唯一 `order.paid:{id}` 事件已 COMPLETED。退款事务持订单锁时只读该终态，不反向锁 outbox；付款处理的 outbox→订单锁序保持一致。该检查在报价、创建、渠道入场及本地结算复核，防止退款先完成而迟到的付款任务再发权益。

报价在返回前执行与创建相同的完整原子准入，包括数量、财务行、发票历史和候选目录；创建再次校验实际请求退款金额。`WholeOrderFullGiftRefundCatalog` 复核原有 8 个退款/发票组件的 PG16 固定指纹、安全 ACL、共同维护 owner 和当前连接所需权限。缺失、禁用触发器、索引变化、PUBLIC 授权或缺少回执 append 权限均拒绝；业务入口不安装 DDL、补授权或回退 v1。

整单结算保留原订单与 cart ID，不新增履约子单。原子 finalizer 完成余额/库存、赠积分回收、订单状态和不可变 whole receipt；回执失败时本地业务全部回滚。按旧 PHP 保留已付赠券、标签与已付活动池，不把付后权益当作未付预留取消归还。取消或拒绝申请只释放其数量预占，无须先满足付款执行准入。

微信/支付宝沿既有持久退款请求、回调与恢复流程；渠道 SUCCESS 和本地失败是可恢复状态，重试使用原退款标识，已知成功不重复请求。模拟渠道结果只能证明本地协议，不能替代真实付款渠道验收。

## 验证边界与台账

专项包含真实客户 controller/native SQL、Admin JWT/角色/controller、独立 app/Admin 数据库 LOGIN，以及实际钱包付款和付款 outbox。客户 HTTP 身份为有限 UID fixture；独立 LOGIN 测试是本机合成角色。目录/权限故障由夹具 owner 明确注入，业务调用前后验证没有修复；数据库夹具清零并停机。最终数字、失败修正与源码摘要见验收 JSON。

最终满送 HTTP 完整32/32、独立 LOGIN 3/3、其余七个完整原生文件134/134通过，共169个唯一原生用例，分批验证而非一次169/169。此前合并批为165通过/1失败，唯一空赠券值断言修正后重跑完整HTTP文件；重复尝试不累计。审计五文件27/27、Worker运行时与测试/脚本两套类型检查、564变体严格API审计均通过。

本增量未改前端文件，未重跑浏览器或前端构建；前批 1440×1000、390×844 合成浏览器证据只覆盖满送管理和确认展示。真实售后浏览器、JWT/Redis 全链路、Hyperdrive、Linux CI、生产规模/统计、UniApp 原生构建、渠道和发布验收继续开放。

Worker 2060、新 Admin 99 业务页、564 请求变体以及营销 31候选/14部分/3缺失/0退役保持原数量。满送两屏仍 partial；Checklist 246完成/158开放/404总项。本地代码未提交、推送或部署。
