# 手机经营用户管理合同审计（2026-10-04）

旧 /pages/admin/user/list 与 /pages/admin/user/index 的八个真实函数由 /pages/customer-work/users 和 /pages/customer-work/userDetail 承接；七种写入使用独立UserJWT合同。两个旧入口为partial replacement，完整手机角色、FE-003E及menuRoleGates不据此关闭。

## 原函数与独立接口

以下路径均有 /api 前缀，普通当前用户与唯一启用customer=1服务授权。

| 旧函数 | 新合同 | 范围 |
| --- | --- | --- |
| getUserList | GET /mobile/work/users | nickname／手机／UID literal搜索、group／level／labels／会员marker，UID降序一致分页 |
| getUserInfo | GET /mobile/work/users/:uid | 真UID详情、账户／level／平台关系版本、原根订单数及physical成交值 |
| getGroupList | GET /mobile/work/users/groups | 全局完整分组 |
| getUserLabel | GET /mobile/work/users/labels | 完整平台标签目录 |
| getLevelList | GET /mobile/work/users/levels | 全局等级 |
| getUserCoupon | GET /mobile/work/users/:uid/coupons | 精确用户真实钱包与发券来源，显式模式下候选GET coupon-grants |
| postUserUpdate | POST replace-level／replace-group／replace-labels／grant-coupons／adjust-membership | 旧public type1等级／2会员／3优惠券／4组／5标签，映射五个显式kind |
| postUserUpdateOther | POST adjust-money／adjust-integral | 成熟方向、正金额／整数、减法clamp及实际ledger |

写路径均为 /mobile/work/users/ 后的显式kind短横线；另GET operations/:key及POST operations/:key/abandon查询原结果／终态放弃。实际16条route新增：7读、7写、2恢复，不能冒计旧Admin权限合同。

## 身份、读取与参数

有效普通用户及唯一当前customer=1服务决定全站手机管理；聊天status、店长、配送、核销、AdminJWT不是替代身份。所有经营响应private/no-store；当前普通actor必须活跃，status=0目标仍可管理，删除目标详情只读。高级旧server-only过滤未由这两个旧页调用，不宣称本批完成其全部参数。

两个route共同严格resolver拒绝重复／未知／歧义参数；uid只接受正canonical INT32，不借订单id、商品id命名空间。keyword／label_id仅旧别名，canonical与alias同时出现也拒绝；group/level0表示无筛选，label_id0为空，labels升序去重最多100，完整CSV不误套512字节上限。搜索按Unicode码点最多100，SQL对%／_作literal，不以JS UTF16长度误拒合法字符。

读取保留全局目录，不套写目标上限；平台标签替换只改平台关系，非平台标签保留。列表count／rows同RR快照与真实offset／返回行数决定has_more。isMember历史marker与active会员有效期分列。实际Shanghai生日可为合法pre-1970负INT4 epoch，仅生日字段放宽；其他时间仍按各自合同。订单COUNT只原paid根pid0/-1，成交SUM按pid>=0／refund0或3／未删除physical行，任意合法SUM整数位不误套单行numeric(12,2)上限。损坏财务字段返回nullable＋diagnostics，只禁依赖该字段的写入。

优惠券issue_id、template cid、真实wallet PK各自不同；send_issue候选、库存、xmin／完整行版本、有效窗口与count同实际成熟定义。naive timestamp与epoch比较固定UTC，不受数据库session timezone影响；合法负price仅诊断，不猜造钱轴。非法枚举／负count／半NULL窗口明确不可选，不伪造库存或钱包。

## 七类成熟事务、效果与恢复

独立版本customer-work-user-read-v1／operation-v1。完整body仅version／scope_key／targets／expected_catalog_revision／payload，目标升序唯一1..100；等级／会员／余额／积分只单目标，分组／标签／优惠券可100目标，超限保留草稿并要求分批，不截断。

调用方原TX共享成熟核心，Admin真实replay／audit callback维持原授权域；customer使用真实actor_uid/service_id的只追加独立账本，不伪造system_log.adminId。整套目标／账户锁、完整目录fence、真实catalog/target/relationship revision、issue stock CAS、七个core私有expected effect与同事务最终实际行回读先于receipt。等级no-op核原level/exp/status与全部history；会员必须有真实other_order PK及按真实oid唯一完整五列status，schema没有status.id。money/integral回读真实账户和ledger，合法changed0 ledger0，会员changed0仍有真实trace。finance正两位小数字符串／正整数及成熟减法clamp保留。

目录受限NOLOGIN lock-owner对user_group／user_label／system_user_level／category固定顺序TABLE SHARE NOWAIT＋行FOR SHARE；runtime对四张目录表仅SELECT、对目录函数显式EXECUTE；user_label_relation仅SELECT/INSERT/DELETE，操作账本仅SELECT/INSERT，没有关系表UPDATE grant。普通target lock合作成熟writers；CAS及完整前后关系拓扑拒绝已观察到的phantom/xmin ABA，但非合作rawSQL最后回读→commit间隙仍开放，不宣称全数据库串行化。

UUID4、actor/service/scope/kind/version、canonical完整body及SHA先严格耐久保存并读回；独立pending storage customer_work_user_pending_v1；created_at为秒。原编号／原body重试或放弃，未知结果不换编号盲写。收据仅版本／真实身份／原UUID/hash／kind／user_ids／outcome/evidence，不含用户姓名、余额或amount。terminal service0先清PII，仍有效原账号才能取最小本人终态；资格撤销／UID-token-session ABA／hide-unload都失效旧视图、PII、草稿、目录和modal。

## 显式维护与开放合同

customer_user_operation_request为12列／9约束／两个immutable纯targets和exact-intent验证函数，PG16真实结构指纹c351fdc02633264135d6cfbfab187587516a79f05ddf374c11bd6bcc8ee42e6a。运行账本仅SELECT/INSERT；所有函数定义、owner与角色可达性、列／table ACL／grant option、policy／FK／序列／schema权限一起校验，意图JSON额外字段拒绝。目录维护namespace731655与请求锁731656独立；安装仅明确owner维护，PG16/RW/RC/origin验证，没有API启动DDL／自动grant或permission repair。

两条旧用户别名仍partial；完整17管理＋5代客旧页／43个admin.js及辅助合同、个人中心25/26、menuRoleGates=false仍开放。Checklist **246完成／158开放／404总项**原标题与勾选保持。下一阶段依次承接订单调价／线下支付／退款处理、独立扫码／分次核销、代客购物车到下单／支付／记录，并补齐完整角色及生产commissioning；非合作关系rawSQL最终回读→提交间隙、provider／设备／Linux/Hyperdrive／容量／发布仍开放。成熟free system会员订单pay_type='admin'是既有业务渠道，不代表Admin认证或provider支付。H5受控HTTP交互、普通LOGIN实际SQL、三端编译及只读物理验收分层记录；本地结果不替代生产角色安装、provider或真机。

[实际验证](customer-work-user-validation-20261004.md)、[路由合同](../audit/route-distribution-customer-work-user-followup-20261004.json)、[Uni合同](../audit/uniapp-frontend-parity-customer-work-user-followup-20261004.json)。
