# Supplier 收款设置迁移合同

本批沿用 `GET/POST /supplierapi/finance/info`，对应 PHP `system/Supplier.php` 的 `getFinanceInfo`／`setFinanceInfo` 六项设置。新 Supplier 页面 `/finance/accounts` 与财务设置页签共用同一组件；提现申请入口跳转到此设置页。保存只修改当前供应商六个收款字段，不创建提现、不记财务流水、不执行银行支付。允许空值与未填完整的渠道，完整条件在提现申请时核对。

## HTTP 与并发

无查询参数 GET 保持既有 TS 六字段响应，POST 保持严格非空六字段子集更新，不宣称旧调用具备 CAS。现代 `?selection=accounts` GET 返回闭合八字段：version、actor_id、supplier_id、revision、accounts、ready、previews、bounded；POST 精确六项账户与 revision。版本是绑定真实 JWT 身份、供应商、口令版本、supplier 行 xmin 与原六值的 HMAC；任何其他保存，包括同值写入及旧调用 ABA，都会使先前版本失效。银行卡前导零保持，现代银行精确 `0` 归一为空。

当前用户、供应商及实际角色／菜单行在短事务中重新核对并锁定；supplier 首先取得 UPDATE NOWAIT，避免 SHARE 升级死锁，并与既有提现申请的 supplier SHARE 互斥。写入仅更新六列；强制执行延后约束后比较完整 supplier 实际行，不允许触发器悄然修改其他列后返回成功。运行时不创建表、不授予权限；独立最小 LOGIN 必须显式具备所需读取、六列更新及授权行锁权限。设置与素材上传是两个独立事务，选择／上传图片不会自动保存设置。

每项按 PostgreSQL Unicode 字符宽度限制，原始控制字符与孤立代理项先拒绝再 trim；请求体上限16KiB，未知字段／租户参数拒绝，身份失败前已设置 private/no-store。现代提交冲突需重读当前资料；旧接口没有版本保证，部署时应迁移仍在使用旧保存入口的调用方。

## 二维码

保存稳定 HTTPS、站内公开引用或严格 `/api/assets/:id`。新私有图片必须属于当前供应商、图片模块与素材类型；不得保存签名票据、别名或任意外部素材 ID。仍未改变的旧不安全引用可以保留，预览显示不可用，允许用户先更新其他收款字段。

finance.view 只获得当前两个收款二维码的限域预览。私有预览签名与原引用 ID 和到期时间绑定；不因此获得素材库权限。图库需 attachment.view，上传另需 attachment.manage。前端只把 canonicalUrl 放进表单；签名只用于预览，到期或加载失败显示占位。上传沿用实际图片嗅探、受限元数据保存与对象存储路径；本机验收对象字节边界不代表生产 R2 已配置。

## 保存结果与前端会话

用户显式核对后才可保存。重复点击被阻止；未知网络结果锁住再次保存，用户只能手动 GET 当前资料。即使当前值与原填写一致，也明确标注“不是原保存回执”，不能据此证明原调用成功或未执行。没有将设置保存伪装为不可变操作回执。

真实会话、角色、路由及卸载使组件永久失效并清除账号／预览，取消请求且隔离迟到结果。Axios 已排队但尚未派发的 POST 同样受 AbortSignal 约束。图片选择上下文绑定 actor、supplier、版本与渠道，旧弹窗回调不能进入新表单。敏感设置不另存本地 journal。

## 验证与发布边界

精确命令、不同测试身份、真实终端状态、本机 PG16 夹具清理、桌面／移动截图及逐文件证据记录于 `audit/php-ts-supplier-finance-accounts-20261017.json`。浏览器使用 production 构建、实际 App/JWT、独立受限 LOGIN 和合成账户；仅一次设置保存与一次 PNG 上传，丢弃实际提交后的 HTTP 确认后核对当前值，再从提现页面读取新银行快照，整个过程不提交提现。

不改变既有提现原键回执、财务账本、0194—0197迁移、生产权限 profiles 或用户选定的 `/api/get_script` PHP 兼容合同。私有历史凭证媒体、异步支付 provider 链、真实已开票红冲及生产发布门禁仍开放，整体迁移 goal active。
