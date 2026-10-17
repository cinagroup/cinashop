# Supplier 提现申请与原结果恢复

本纵向承接 PHP `POST /supplierapi/finance/supplier_extract/cash` 的供应商提现申请。它只创建待审核申请、预占可提现余额，不触发银行转账。后续 Admin 审核拒绝释放预占，审核通过及登记转账凭证沿现有流程处理。平台用户提现属于另一套账本。

## 申请校验与查看

`GET /supplierapi/finance/supplier_extract/cash` 返回9字段闭合资料：`version,actor_id,supplier_id,revision,available,min_price,max_price,accounts,can_apply`。账号与租户来自当前真实 JWT；查询使用同一次只读 REPEATABLE READ 事务读取当前银行／支付宝／微信资料、配置与全账余额。银行卡保留前导零，不转数字。当前收款资料先去掉两端空白；银行卡要求卡号非空且不为0、开户行非空；支付宝／微信要求账号和二维码同时非空，补齐 PHP 的校验。

`available` 是已结算且未删除的净流水减全部未拒绝的提现申请，最小为零。与新提现记录页一样使用精确小数及 BigInt，不把页面筛选金额当可用余额。非空非法上下限配置明确失败；最小额为零时仍只接受正额；最高额为零时不能申请正额，这与 PHP 的上限比较一致。旧 TS 将最高额零当作无限额的行为不再用于公共申请，历史页文案同步。

新申请页为 `/finance/apply`，只在同时具备 `supplier.finance.view/manage` 时显示提交资料。用户核对申请金额及当前收款账号后明确提交。安全公开二维码保持字面预览；私有二维码复用现有收款设置只读投影，仅在六项收款值与当前申请资料完全一致时，使用对应渠道的授权预览。设置版本不代替申请版本，任一值不符需重新核对申请资料；图片失败或过期不会自动提交申请、重试或借用 Admin 图库。完整媒体合同见[申请与原回执二维码](php-ts-supplier-extract-application-media-20261017.md)。

## 原操作与事务

公共申请 POST 只接受精确5字段：`operation_id,revision,extract_type,money,mark`。操作编号是小写 UUIDv4，金额为规范正额两位小数文本，最多9999999999.99；文字备注可空，去两端空白后最多255个 Unicode 字符，允许 LF、拒绝其它控制字符。当前资料的 HMAC 绑定账号、租户、口令版本、余额、配置及三个渠道的账户投影，不能凭旧页面覆盖新收款资料。

服务端先获取真实账号／供应商／角色／菜单行的授权锁，再获取原 UUID 锁；新申请沿用所有相关供应商结算、退款、Admin 拒绝和旧内部申请共用的 `pg_advisory_xact_lock(supplier_id::bigint)`。写事务使用 READ COMMITTED，取得财务锁后重新读取可用金额及收款依据。申请行和不可变原回执在同一事务保存，最终约束与实际申请投影核对通过后才提交。同一 UUID 的不同正文不能被当作新请求；相同已提交正文返回原结果，不重新预占、插入或消费申请序列。

`request_hash` 是完整规范意图的 SHA256：`version:'supplier-extract-application-intent-v1',operation_id,actor_id,supplier_id,revision,extract_type,money,mark`；对象键递归排序。前后端按相同合同核对，不用浮点金额或新的账户资料重新构造旧意图。

原回执7字段为 `version,operation_id,actor_id,supplier_id,state,request_hash,result`。已提交时 result13字段为 `id,extract_type,extract_price,balance,bank_code,bank_address,alipay_account,wechat,qrcode_url,supplier_mark,status,pay_status,add_time`，全部是提交时的快照，不表示今天的审核／转账状态。合法 Admin 审核、拒绝、凭证登记及两域共享备注更新不会破坏原回执；原金额、归属、申请时间、渠道及收款快照等未开放列仍被核对。原记录读取不重新验证旧 HMAC 与今天的签名密钥、余额或配置。

## 丢失回执、撤权与跨窗口

`GET /supplierapi/finance/supplier_extract/application_operations/:operationId` 只查询原结果，未知时不写数据库。原账号在当前有效 JWT、账号和供应商身份仍成立时，即使财务查看／管理能力已撤销，也可读取自己的原回执；他人或其他租户不能读取该内容。

原回执的二维码使用独立 `GET .../application_operations/:operationId/media?request_hash=...`，只委托该原操作提交时的 QR，不给回执或结果追加临时签名。服务核对同一原账号／供应商、实际已提交操作、摘要、原结果与实际申请不可变列，并重新验证实际附件归属。其闭合八字段媒体投影与四字段 preview 允许原账号在财务能力撤销后继续恢复；不读取今天的设置或后来转账凭证。300秒私有票据到期前仍为 bearer capability；失效或不存在的附件显示不可用，原回执内容保持。媒体读取失败不恢复已正常清除的本机日志、不发起申请或封存。

`POST .../application_operations/:operationId/resolve` 只接受空JSON对象，显式核对并封存原请求。它与申请使用同一个 UUID 锁：已提交则读取原结果；尚无原记录则原子写入 `not_applied` 墓碑，此 UUID 以后不能申请。原事务仍持锁时返回冲突，保留原记录，不能把查询不到、超时或浏览器取消当成未执行证明。

前端在任何财务 POST 前，先使用 Web Locks 原子保留当前账号与供应商的本机原申请记录。该记录持久保存 UUID、请求摘要、金额、渠道与归属，不保存账户、原备注、登录令牌。两个窗口不能同时覆盖同一待核对记录；存储不可读、写入失败、记录损坏或缺少 Web Locks 时阻止提交。原记录存在时，新页面、刷新与另一个窗口都先处理原结果。仅验证过的提交回执或 `not_applied` 终态能清除原记录；清除时再次核对 UUID，不能误删另一条记录。

页面通过 `/finance/application-result` 提供不依赖财务能力的恢复入口。页面／路由／会话／权限改变后会清空敏感资料，忽略迟到响应。原 POST 发出后即使响应丢失，也保留原 UUID，不自动换键或重发。用户可查询原结果或明确核对并封存；封存确认不发起转账。

## 独立安装与运行权限

`src/migrations/maintenance/0197_supplier_extract_application.sql` 和 `src/migrations/supplierExtractApplication.ts` 是独立附加目录。它不加入旧共享 ORM 或默认全店 bootstrap；HTTP、启动和查询路径均不执行 DDL／GRANT。由维护方在明确的 PG16 READ COMMITTED 维护事务中调用 `installSupplierExtractApplication`；已有未知、部分或漂移目录拒绝，不自动修补或重新授予丢失权限。

目录使用全局 UUID 主键、申请 ID 唯一外键和只追加触发器；字段、索引、约束、实际触发器、函数原文／属性和 ACL 均由运行准备检查核对。即使表维护者也不能通过普通 UPDATE／DELETE／TRUNCATE 改写原回执。运行时必须是独立、非维护者的受限 LOGIN；纯查询只需原业务七表及原操作 SELECT。联合申请运行者另需申请 INSERT、其序列 USAGE、原操作 SELECT／INSERT和四项授权表的 `UPDATE(id)` 行锁资格；这些授权列不会被业务修改。恢复封存目前在同一联合运行者中执行，不能把只读查询角色称为可写封存角色。

实际生产维护、运行身份授予、部署及真实银行验证均须另行完成。本批只在新建的本机 PG16 夹具执行安装和权限验证，不修改旧0194／0195／0196或既有运行profiles。

## 旧调用方与回退

旧的无 UUID／版本 POST 在公共路由明确拒绝，不能回退为无键写入。新的页面与公共端必须协调发布；旧内部财务方法仍用于原有服务器财务链兼容，未被新公共路由暴露为旁路。

已在升级前发出的无键请求没有新的原操作回执。拒绝旧格式、404／400、丢失响应或新 UUID 查不到，均不能证明该旧调用未执行，须核对实际提现历史、原时间／金额／账号及财务记录后再决定下一步。新 UUID 的封存也不能替代旧调用的核对。回滚页面版本时不得删除新操作目录或将存在的待核对记录当作未提交，须保留新恢复入口与只读能力，先处理原请求；不要为恢复可用性自动重开无键财务写入。
