# Admin 供应商提现屏合同

旧屏 `/admin/supplier/cash/index` 管理 `supplier_extract`，对应新 Admin `/finance/supplier-extract`。旧页面与 PHP 控制器分别见 `cinashop-php/view/admin/src/pages/supplier/cash/index.vue`、`cinashop-php/app/controller/admin/v1/supplier/SupplierExtract.php`；它与平台用户提现 `/extract` 是不同账本。

## 查看和筛选

`GET /adminapi/supplier/extract/suppliers` 返回未软删的供应商选项，含停用供应商；旧历史提现列表不能因为供应商后来被软删而消失。`GET /adminapi/supplier/extract/list` 按提现 ID 倒序，默认每页 15 条，支持供应商 ID、上海申请时间、审核状态、转账状态、收款方式和关键词。`supplier_id` 留空表示全部，明确的 `0` 不扩大为全部。后台可读权限是 `supplier_extract.view`，包括旧菜单 1578 的精确路径和 `admin-supplier-cash-index` 授权；该菜单不授予管理权。

旧 PHP 创建提现时未写 `supplier_extract.balance`，历史默认零值不是可信的申请后余额，故页面不展示该列为财务结论。接口保留原字段供现有调用方兼容。

统计卡分别显示待审核、待转账、累计已转账及可提现金额。前三项遵循旧 `SupplierExtractServices::index` 的筛选口径；可提现金额不随列表日期、审核状态或转账状态变化，按已结算且未删除的供应商净流水（收入减支出），再减所有未拒绝的提现申请，最小为零。旧 PHP 在全部供应商场景把 `supplier_id=0` 传入已提现金额搜索，可能漏减已有提现；新汇总修正这项缺陷。列表和卡的同次读取应使用一致的数据库快照。

## 审核、转账和共享备注

`POST /adminapi/supplier/extract/verify/:id` 审核待审申请，并兼容旧 UI 的 `type=2` 拒绝值；`POST /adminapi/supplier/extract/save_transfer/:id` 只对已通过且未转账申请登记实际转账说明和可选凭证图片。旧表单的说明必填且最多 30 字，图片可空。两步均需 `supplier_extract.manage`；登记不发起资金划转。条件更新防止重复审核或转账。

`POST /adminapi/supplier/extract/mark/:id` 同样需管理权，提交 `{mark, expected_supplier_mark}`，将非空且最多 200 字的备注写入 `supplier_extract.supplier_mark`，并在原值变化时返回 409。旧后台与供应商端均读写这一列；`supplier_extract.mark` 不能用于替代此屏的共享备注。新 Admin 在冲突后刷新当前行供管理员重新确认。旧 Admin 只提交 `mark` 的请求需升级后才能调用此路由。供应商端仍可在管理员成功提交后再次修改共享备注，Admin CAS 只防止提交时覆盖已先发生的变更。旧动态转账表单由新页面原生弹窗承接，不将旧 `GET /supplier/extract/transfer/:id` 视为已精确迁移。

## 验收边界

本合同只声明本机代码级候选。真实供应商财务历史、实际转账、受限角色浏览器、生产规模、完整 Linux CI 和发布后验收仍开放；不因新路径可用而提高旧 PHP 精确路径匹配数。
