# 总后台运费模板列表：有界一致读取

2026-09-13，FE-003L-A3k13 局部候选，尚未发布。完整分组规则编辑、旧表单覆盖冲突及真实业务验收继续开放。

## 合同与实现

实际 `/adminapi/shipping_template/list` 及兼容别名调用同一列表服务。仅接受 `limit`（1–50，默认20）、`cursor`（sort:id）及 `name`（最多255字符的字面、不区分大小写包含搜索）。重复、未知和越界参数拒绝；`%`/`_` 不作通配符。全局管理员原有可见性不变，不暗改为仅 owner_type=0。

一条数据 SQL 同时读取按 sort/id 倒序的当页模板、仅属当页的区域规则、筛选总数和下一页标记。最多读取51个父候选、返回50个父项；区域读取1001条探测，超过1000则整页拒绝并提示降低页大小，绝不返回可被编辑保存的不完整规则。decimal 仍为字符串。单模板本身超过1000条也会拒绝，降低页大小不能解决这种情况。

事务内 statement/lock/idle 上限为5/2/5秒，保留现有更严设置；无父行锁。保证的是一个请求的数据语句快照，不保证跨页请求期间排序/集合不变。精确总数仍可能扫描全过滤集，本改动不是生产容量或 O(1) 查询证明，未增加或线上安装索引。

PostgreSQL READ COMMITTED 每条语句取得快照，前后两个 SELECT 可以看见不同提交；原实现正有此问题。[PostgreSQL 16 事务隔离说明](https://www.postgresql.org/docs/16/transaction-iso.html)。

管理端接入游标上一页/下一页、搜索、每页1/5/10/20/50条。载入时清空旧数据，错误显示同页重试，迟到请求由 generation/token 隔离；拒绝缺失分页元数据的旧响应。保存/删除后从当前已应用筛选的首页重读。手机禁用遮挡模板名称的固定操作列，提供横向滑动提示；未改写编辑弹窗合同。

## 验证与边界

- 真实专用 PostgreSQL 16.15 首轮2项均失败：limit=1却返回3项；阻塞读取期间另一连接提交后，旧父模板与新价格9.00混读。修复后同一请求保持旧价格6.00，后续请求读9.00。竞争以独立连接和 pg_blocking_pids 确認锁等待，不以固定延迟充当证据。
- 最终两次回归：列表/原子写3文件38项，注册路由/供应商2文件237项，共5文件275项零失败/跳过，不把红测和早期绿测重复相加。新列表5项使用实际Hono控制器和夹具认证，不冒充正式路由权限/真实账号验收。
- Worker双类型及 Admin `npm run build` 通过。构建仍报告 vueuse PURE 注释位置警告。
- 依前端验收技能使用现有 Playwright 1.62.1 / Edge：当前没有专项 Browser skill；访问 `http://127.0.0.1:18173/shipping`，1280×900、390×844。真实Vue页面，HTTP/通知socket为隔离替身，无线上业务写入。原始报告、脚本和截图保留仓库外，路径与哈希见审计JSON。

| 界面检查 | 结果 |
| --- | --- |
| 页面URL/标题、非空、无框架覆盖层 | 两尺寸通过 |
| 控制台错误/警告 | 最终均0 |
| 下一页→上一页、每页数量、搜索 | 两尺寸通过 |
| 慢搜索→快搜索→旧响应释放 | 保留新结果 |
| 失败→清空列表→同页重试 | 通过 |
| 缺分页元数据→明确拒绝→重试 | 通过 |
| 截图人工查看、页面根宽度 | 两尺寸无根横向溢出；手机表格内部横向滚动 |

前两次工具问题分别为 Windows ESM路径、未模拟通知socket；另一轮页面选择器点击被ElementPlus占位层拦截，调整测试目标后通过。这些不记作应用断言回归。手机固定列实际遮挡问题已修复并复验。没有验证编辑保存、真实token切换、其它浏览器、设备及线上数据库业务链。

测试后只读确认专用本机PG无约定前缀临时数据库/schema/角色残留，保留服务器；未修改线上数据、权限、schema或部署。

复跑：配置专用 `TEST_FINANCE_POSTGRES_URL` 后，在 workers-ts 执行 `npm run test:unit -- test/admin-shipping-list.test.ts test/admin-shipping-atomic.test.ts test/admin-shipping-atomic-postgres.test.ts`，再执行 `npm run test:unit -- test/shipping-lifecycle-route-auth.test.ts test/supplier-shipping-template.test.ts`；`npm run typecheck`；在 view/admin-ts 执行 `npm run build`。不要使用生产数据库执行这些建库/修改夹具测试。

证据：`workers-ts/audit/admin-shipping-list-20260913.json`。A3k13保持开放，清单240勾选／164开放／404项。
