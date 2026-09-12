# 2026-09-12 线上测试环境全量发布

用户已明确现有线上站点为测试状态，并要求完整重部署、合并main及清理发布分支。
本次不清库，不调用历史runAll，不删除或伪造用户/订单，不调用真实支付/通知provider。
正式生产验收清单、真实角色/支付/最小权限等仍独立开放，不把测试部署等同正式验收。

## 应用目标

| 应用 | Cloudflare目标 | 地址 |
|---|---|---|
| API | cinashop-api | cinashop-api.cinagroup.workers.dev |
| PC | cinashop-pc | shop.cinaseek.ai |
| Admin | cinashop-admin | cinashop-admin.pages.dev |
| H5 | cinashop-h5 | cinashop-h5.pages.dev |
| Supplier | cinashop-supplier（本次新增） | cinashop-supplier.pages.dev |
| Kefu | cinashop-kefu（本次新增） | cinashop-kefu.pages.dev |

保留已有cinaseek.ai、admin/api/www.cinaseek.ai；旧cinashop-admin-ts项目不替换、不删除。
按各前端目录运行Pages部署，确保相邻functions目录一并编译；不能只上传SPA壳。
API保留现有Secret，使用新Origin白名单和STAFF_NOTICE v3 SQLite类迁移；不更改原有DO数据。

## 数据库范围与已知限制

DB-006、DB-007已在线完成，并通过独立目录和数据指纹复核。
0146–0151全组合第一次调用未返回成功；随后只读复核确认所有目标增量仍缺失，
九表65行规范化SHA-256与执行前一致。发现12笔已付款测试订单引用不存在用户，
阻止0150分佣保护安装；没有自动补造用户或删除订单。

独立核心结构入口只安装0146–0149及0151，不含0150，显式返回excluded字段。
仍保留应用对缺失0150协议的失败关闭检查，相关计价/分佣路径尚不能验收。
运行角色目前仍高权限，正式上线前必须单独处理；本次不盲目更换Hyperdrive凭据。
0135–0145的全库名称/默认值/索引对齐仍未据本次核心结构包验收。

```powershell
# 只读：未知结果后先检查，不能盲目重发写请求
./scripts/run-test-release-schema-production-migration.ps1 -InspectOnly
# 明确范围的核心结构增量，不清理12笔孤儿测试订单
./scripts/run-test-release-core-schema-production-migration.ps1 -Apply -VerifyIdempotence
```

执行器限固定SQL、短事务、NOWAIT锁、每表10,000行上限和整行指纹；失败整组回滚。
HTTP503/断连仍按结果不确定处理，独立只读复核后才决定后续操作。
临时Worker有短期令牌且执行后删除，不挂入正式API。

## 验证与恢复边界

本次验证构建、运行时CI、网页及静态资源、同源API代理、安全负向和CORS。
不以页面HTTP200代替登录、购物、支付/退款端到端验收。
记录部署ID和Git SHA；保留旧Worker/Pages版本。新增DO迁移可能限制直接版本回滚，
未进行回滚演练，不宣称原版本可不经兼容性核对直接回退。Git分支仅在提交已进入main且
线上测试部署检查结束后删除；不清理其它用户分支、测试数据或旧部署。
