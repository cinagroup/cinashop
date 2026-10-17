# Supplier 历史提现媒体合同

`/finance/extracts` 的申请明细可以读取申请时的私有收款二维码和 Admin 登记的私有转账凭证。原历史列表、22字段记录、备注写入和提现／转账业务方法保持。图片读取不会创建申请、记账、改设置或登记转账。

## 历史归属与披露

唯一入口为 `GET /supplierapi/finance/supplier_extract/:id/media?revision=...`。路径 ID 是提现 ID，查询必须恰好一个64位小写 revision；不接受附件 ID、其他租户或任意图片引用。服务先按当前 JWT、口令版本和 finance.view 核对身份，再读取当前供应商的实际提现行。revision 必须等于该行 xmin 派生的历史列表版本，备注、审核、转账登记或同值 ABA 后旧版本均409，需要重新查询列表。

提现行是历史披露来源，不从当前收款设置推断，也不要求旧记录有后来新增的0197原申请UUID。二维码只使用该行 `qrcode_url`，仅支付宝／微信渠道，附件须属于本供应商且为 type4、module1、file1、image_type8 的实际图片。转账凭证只使用该行 `voucher_image`；必须已审核、已登记转账、有登记时间和真实 Admin 身份。历史 Admin 被禁用或软删除不抹除已登记的凭证；Supplier 类型账号或缺失 Admin 不构成私有凭证披露来源。

Admin 素材库是共享 type1／relation_id0／module1，不具备逐上传人归属，不能根据 `admin_id` 虚构图片上传者。此处只委托该笔提现明确登记的正确 Admin 图片，不向 Supplier 开放 Admin 素材目录。二维码与凭证分别验证，即使两个字段写了相同 ID，也不能互借另一种媒体的授权。对象键命名空间、原始 canonical 路径和实际图片类型同时核对。

## 投影与只读边界

响应闭合七字段：version、actor_id、supplier_id、id、revision、previews、bounded。previews 恰好 qrcode／voucher 两项，每项闭合 reference、status、src、expires_at。reference 保留原历史字面值；不可用项为 `src=''` 和 `expires_at=null`。

私有旧引用仅支持真实 `/api/assets/:id`、`/kefuapi/assets/:id` 及其精确 expires／signature 双参数旧票据。旧票据不构成授权，过期票据在重新核对行与附件归属后才能签发新的规范 `/api/assets/:id` 链接。绝对私有URL、编码别名、重复参数、额外参数和错误票据格式不会转为公共图片或新签名。安全公开 HTTPS／站内引用保持原字面值；不安全历史值显示占位。私有签名有效300秒，沿用已有真实附件读取端点；签发后的短期持有者链接在到期前仍是 bearer capability，不能宣称撤权后立即失效。

整个业务读取在真实 REPEATABLE READ、READ ONLY 事务内完成，权限与历史行／附件事实使用同一快照；后续请求反映已经提交的授权或附件归属变化。独立受限 LOGIN 只需 auth四表、supplier_extract 和 system_attachment 六表 SELECT，不需要图库权限、DML、序列或维护能力。HTTP不执行DDL或GRANT，缺必要读取权限预检503。图片元数据投影不预先读取R2字节，实际图片缺失或加载失败仍由界面占位处理。

## 界面生命周期

只在打开私有图片明细后读取该行版本的投影；公开旧图片保持原行为。前端核对完整闭合响应、当前 actor／supplier／提现 ID、原记录版本、两个原始引用和签名到期时间。切换明细、筛选、页码、路由、真实会话 A→B→A、权限变化、列表刷新和卸载均清除旧投影并取消请求，忽略取消的迟到结果也不能回灌。Axios 排队中的读取同样取消。浏览器存储失效时清除敏感历史资料。

到期计时器只隐藏图片，不自动访问接口；用户可显式“重新核对明细图片”。版本冲突提示重新查询提现记录。图片错误按 qrcode／voucher 分开记录，不因一个原始引用相同就混用投影或同时替换另一张图。

## 验收与限制

精确命令、原始结果、不同测试身份、PG夹具清理、浏览器与保护文件证据记录于 `audit/php-ts-supplier-extract-media-20261017.json`。浏览器使用生产构建、实际App/JWT与独立纯SELECT LOGIN，读取旧UUID为空的提现2／3及实际签名PNG。控制夹具调用既有 Admin transfer 只登记提现2的五项凭证元数据，验证旧版本409、刷新后新凭证可见，以及扣留媒体回复遇到跨窗口会话ABA不会恢复旧图片；不提交新提现、不上传图片、不执行银行转账。

本批不改变成熟财务方法、现有0194—0197迁移、运行角色 profiles 或用户选定的 `/api/get_script` PHP兼容行为。原申请回执页的独立媒体展示、真实支付／税务provider和生产发布门禁仍需各自验证，整体迁移 goal active。
