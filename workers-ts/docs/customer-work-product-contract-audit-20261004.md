# 手机经营商品/SKU合同审计（2026-10-04）

本批承接旧 goods/index 与 goods/specs 两页所调用的全部七个商品函数，新增两个真实 customer-work 页面与九条独立 UserJWT 接口。当前为本地验证完成、未发布的商品功能增量；完整手机角色和旧页面别名仍 partial，不关闭 FE-003E 或个人中心 menuRoleGates。

## 旧函数与新接口

以下路径均在 /api 前缀下。旧 AdminJWT URL 的权限合同不作为这些独立接口的等价计分。

| 旧 admin.js 函数 | 新路径 | 承接合同 |
| --- | --- | --- |
| adminProductList | GET /mobile/work/products | 全部／上架1／下架2／售罄4／警戒5，分页、真实ID／名称／条码搜索 |
| productSetShow | POST /mobile/work/products/show | 原商品、购物车与分类关联状态在同一事务更新 |
| getCategory | GET /mobile/work/products/categories | 当前可见平台分类树，真实父子身份 |
| getProductLabel | GET /mobile/work/products/labels | 当前可见平台分组及标签，不借门店或供应商标签身份 |
| postBatchProcess | POST /mobile/work/products/batch | 旧手机页面使用的分类／标签替换；分类非空，标签可清空 |
| getGetAttrs | GET /mobile/work/products/:id/skus | 全部未退休基础规格，真实数字商品ID与不透明unique |
| postUpdateAttrs | POST /mobile/work/products/:id/skus | 四项绝对值、单规格与多规格部分／批量修改 |

另有 GET /mobile/work/products/operations/:key 与 POST /mobile/work/products/operations/:key/abandon，读取本人原结果或确定原操作放弃。所有经营响应 private/no-store，重复查询参数、未知字段、歧义旧 id/productId 或 store_name/keyword 别名、非canonical正ID均拒绝。

## 身份、范围与真实字段

当前有效真实用户、UserJWT／密码时期／有效期与唯一 customer=1 服务记录决定全站商品经营资格。聊天、店长、配送、核销、AdminJWT 及虚构 adminId 均不能替代。商品范围保持全站，不附加隐藏 pid／门店／供应商限制；分类和标签候选收紧为可见平台目录，这是明确的合同修正。

product.type 0/1/2 是平台／门店／供应商归属；product.product_type 0..4 是普通／卡密／优惠券／虚拟／次卡；SKU.type 0 是基础规格，活动规格中的 product_id 是活动命名空间，不能因数字碰撞当作商品规格。列表库存采用基础规格真实 SUM，销量用 product.sales，不加入 ficti。

读取不套用写入数量上限：501规格、5001分类、超过20层目录、1001标签组或子项、既有51个标签、2423字的合法拼接分类名称均有真实SQL与实际客户端 guard 见证。分类验证与展平使用迭代和唯一ID防循环，搜索保留隐藏已选项，深层只限制视觉缩进。源 varchar/char 按PostgreSQL Unicode码点长度读取；写协议的实际长度、正ID、库存、金额与精确字段约束保留。

同一只读RR快照内将图片按最多10000项保序分块交给成熟 owner/attachment 策略；不截断结果，不借身份或签名未知门店上传图。门店合法静态目录图仍可读取。卡密库存有真实 diskInfo 才按成熟规则允许快捷改库存；自动管理卡密只读库存但仍可改价格，隐藏卡密内容不返回客户端。

## 写入、复核与未知结果

最多100个升序唯一商品目标、每次最多500个实际修改的SKU、替换最多50个关联，分类CSV仍最多64字符。空输入表示不改，零值表示实际写零；超限草稿保留并明确要求分批，不静默截断。未选规格、销量、真实 sumStock 策略、库存差额流水及主表 SUM/MAX 汇总保留。

共享成熟核心接受调用方原事务和真实审计回调，原 Admin batch1..9／审计／结账反序与回滚合同均经过复验。customer 使用真实 actor_uid/service_id 的只追加独立操作账本，不伪造 system_log.adminId 或不存在的库存流水列。

写前绑定独立 product-read-v1、完整商品／全部基础规格（含退休）／关联与 xmin、全目录版本。排序商品 advisory/row 锁、真实账户事务锁、受限目录 definer fence、CAS、成熟写入和最终效果回读均在原事务中。已观察到的授权后规格／关联phantom及值恢复的xmin ABA被拒绝；正常商品关联、退休、供应商与导入写入器合作使用商品锁。这里没有全局SKU表锁或触发器，不能把最终回读后的非合作 rawSQL→提交间隙描述为全部数据库写入已序列化。

原UUID、canonical完整原意图和摘要先耐久保存。Vue响应式对象在API边界产生规范JSON副本，保留原编号和原哈希；丢响应不等于失败，不自动改意图或换编号重写。当前资格撤销后清空经营数据，仅以仍有效原账号读取最小本人收据；service_id=0只允许原操作的终态恢复。

## 显式安装与未完成边界

customer_product_operation_request 为12列／9约束／1纯targets验证函数，PG16实际完整结构指纹为 8121383d89ec977176a8ca8c628d737f105c47b4c0dbbf56a93ae0a545d2121b。账本仅SELECT/INSERT；目录锁函数使用独立受限NOLOGIN owner，运行账号对三张目录表仅SELECT和明确EXECUTE。完整目录、函数、policy、入站FK、列/table ACL、角色可达性、双向owner成员关系、序列与schema/parameter权力共同复核。

安装只能由明确owner维护执行，PG16/RW/RC/origin与既有结构共同检查；没有启动DDL、运行时自动授权或目录修复。完整17管理＋5代客旧页、43个admin.js函数和辅助合同仍开放。下一批为用户列表／详情、分组／平台标签／等级／优惠券／会员时长／余额／积分；财务、余额积分、SVIP、代客支付、独立核销、生产角色、provider、真机、Linux/Hyperdrive、容量与发布继续开放。

[本批验证](customer-work-product-validation-20261004.md)、[路由分布](../audit/route-distribution-customer-work-product-followup-20261004.json)、[Uni合同](../audit/uniapp-frontend-parity-customer-work-product-followup-20261004.json)。旧源码合同由原next-management分析和FE blueprint真实原始副本支持；独立源审与每次失败的实际字节保存在本批验收增量中。
