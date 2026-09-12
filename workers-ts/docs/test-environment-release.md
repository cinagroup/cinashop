# 2026-09-12 线上测试环境全量发布

## 11:14–11:18 UTC 再次全量部署

根据用户再次要求全量重新部署，从已通过 CI 的 `main@214dfb2` 重新构建 API 和五端。
应用代码与之前发布源 `97b2a13` 一致；本次未将后续审计候选或未提交权限预检接入运行时。
Worker 新版本 `89dfbd1e-775a-4227-9548-039bc3cac268` 已占流量 100%，
五个 Pages 控制面均确认新部署成功、main/production 和源 SHA 正确，Functions 同时上传。
17 项只读检查通过，五端入口 JavaScript 的线上/本地 SHA-256 一致。
没有执行清库、数据库迁移、凭据更换或真实 provider 写入；既有数据库验收缺口仍开放。
两个未提交权限审计文件和候选审计分支均保留，未作清理；Pages 显式标记 commit-dirty。
详见 `audit/full-test-redeployment-20260912.json`，可用
`node audit/probe-full-test-redeploy.mjs` 在保留对应本地构建产物时复核。
下文为较早的全量发布与数据库增量历史，不代表最新流量版本。

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

### 本次实际结果（2026-09-12）

源提交 `97b2a13feee089eaa550aa5579671c7be1fa7448` 已完成 API 与五端全量部署。
API 版本 `42e39c18-08b8-44c1-8518-5421c6307ea9` 占流量 100%；
五个 Pages 均为 main/production，控制面 SHA 与上述提交一致，Functions 已编译上传。
全部首页及入口脚本 HTTP 200，健康 ok=true，商城商品列表及五端公开初始化 JSON 正常；
Admin/Supplier/Kefu 受保护接口匿名返回 JSON status=410000，而不是 HTML 壳。
商城 CORS 精确允许 shop.cinaseek.ai，不信任根域名或把后台域名加入商城安全域。
内置浏览器首页→商品列表导航及内容正常，未见框架错误覆盖层，采集error/warn为空；
既有测试商品图片仍不可达并显示失败占位，未修改素材。未测试登录或交易链路。
Actions34685058465的运行时、PG16、五端构建与密钥扫描通过；记录时两单元分片仍运行。
本次测试发布不等待全部正式验收项，但不把未完成CI写成成功。

核心结构增量已成功完成，独立目录及第二次 applied=false 复核通过，65行指纹不变；
临时 Worker 控制面和公开端点均已确认删除（404）。0150及12笔孤儿测试订单均未改变。
详见 audit/test-release-core-schema-production-20260912.json 和
audit/full-test-deployment-20260912.json。历史“未发布”描述不是当前流量状态。

本次验证构建、运行时CI、网页及静态资源、同源API代理、安全负向和CORS。
不以页面HTTP200代替登录、购物、支付/退款端到端验收。
记录部署ID和Git SHA；保留旧Worker/Pages版本。新增DO迁移可能限制直接版本回滚，
未进行回滚演练，不宣称原版本可不经兼容性核对直接回退。Git分支仅在提交已进入main且
线上测试部署检查结束后删除；不清理其它用户分支、测试数据或旧部署。
