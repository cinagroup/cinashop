# 总后台完整运费规则编辑候选

发布追记（2026-09-13 10:31 UTC）：本候选已随 main@37d3308 全量部署至线上测试环境；17项只读检查通过。前置CI页面盘点快照失败及后续审计修正见 `docs/releases/20260913-full-test-redeployment-37d3308.md`。下方保留实现当时的未发布记录；A3k13仍非完整验收。

2026-09-13；FE-003L-A3k13 保持开放，未发布，线上仍是 main@614bf34。

## 改动及合同

实际总后台 `/shipping` 页面从扁平 region_id/region_name 编辑切换为完整省市分组编辑器。支持件数、重量、体积，配送首/续计量与金额、条件包邮、不配送区域、启用状态及排序。所有计量和金额保持十进制字符串，服务端使用既有供应商规则的规范化/权威城市链校验/三表替换逻辑，但保留总后台全局权限范围；不将管理员伪装成供应商。

新增 `GET /adminapi/shipping_template/:id/edit`、`city_list` 及 `/api/admin` 别名。详情以单数据语句返回父项与三张规则表，每类超1000条整批拒绝；组内费率不一致、路径/地区ID不一致、缺失非全国路径会明确拒绝，不选择最后一条或猜测地区。仅原有全国0的空路径投影为 `[0]`；没有修改存储事实。超过100组也不可返回可编辑截断内容。

每次编辑必须提交 `expectedRevision`。服务端用四表完整快照计算 SHA-256 指纹，在持有父模板 `NO KEY UPDATE` 后重读比较；包含父级、地区、包邮、禁配和所有权变化。它不是权限凭证，也不是历史版本日志，不承诺检测完全恢复原样的 ABA 编辑。未携带版本的旧客户端返回“重新打开”，有版本的扁平表单也不能覆写结构化区域或改变其计费类型。既有无分组扁平保存合同仍受版本检查；显式空数组语义保留。

编辑器读取失败不可保存；加载/保存响应按组件代次和登录token隔离。冲突保留用户输入并滚动显示原因，“重新读取”必须确认放弃输入。保存期间冻结payload和控件；网络结果未知时禁止继续重试，提示核对列表。新建请求尚无跨页面持久幂等键，结果未知后的人工核对仍重要。

新建固定平台所有者；编辑保留所有者和创建时间。停用仍检查现存引用；三类规则原子替换。未改变供应商保存的并发策略、历史订单、付款、生产schema、Hyperdrive或密钥。城市权威表的并发维护、其它旧路径修复和全应用最小权限不是本增量结论。

## 验证

先复现两项失败：分组保存成功却丢失包邮/禁配；旧表单无版本也能覆盖。修复后14项专项覆盖四类版本变化、真实父锁等待、全事务回滚、显式清除、无效地区/金额/类型、损坏分组和边界。原有并发测试将“两个旧基线都成功”更新为“第一笔成功、等待后的陈旧基线拒绝”；保留父锁、费率和未改字段断言，非删测试避错。

最终复核补拒绝显式 null ID、status、appoint、sort，不将 null 当默认值而误建模板或更改开关；四个反例在原校验用例中执行，不增加测试项数。最终报告为 final3，前两轮原始报告保留。

最终专用 PostgreSQL 16.15：8文件303项零失败/跳过，包含234项全ORM注册路由/受限LOGIN回归和2项API审计。中间一轮302通过/1项5010ms超时；Vitest timeout包装器只输出 STACK_TRACE_ERROR，核实源码及5秒默认时限后，为包含建库/清库的专项设30秒，SQL/锁上限仍5/2秒。原报告保留，不把多次通过数叠加。Worker双类型、Admin构建通过，既有 vueuse PURE 注释警告保留。

界面路径：真实 `/shipping` → 编辑完整模板 → 修改计量和包邮 → 保存 → SQL核对；再次编辑期间独立更改包邮金额 → 保存冲突 → 输入保留且四表不变 → 重新打开读到新金额；新建时省→市两级选择并保存三类规则。

| QA检查 | 结果 |
| --- | --- |
| 环境 | Playwright 1.62.1/Edge；专项 Browser skill 未提供；沿用现有依赖 |
| URL/非空/无框架覆盖层 | 本机18173页面，1280×900和390×844通过 |
| 数据链 | 本机18174真实Hono/独立PG，UI登录为显式替身，非线上身份 |
| 编辑、新建三类规则 | 两尺寸均真实SQL核对通过 |
| 陈旧表单与输入保留 | 两尺寸通过，失败请求零数据变化 |
| 手机省市弹层与错误可见性 | 边界在视口内，错误滚入视野；旧成功提示在打开编辑器时清理 |
| 控制台 | 最终错误0/警告0 |
| 截图 | 人工检查桌面冲突和手机三类表单，路径见审计JSON |

复跑命令：专用 `TEST_FINANCE_POSTGRES_URL` 下 `npm run test:unit -- test/admin-shipping-grouped.test.ts test/admin-shipping-atomic.test.ts test/admin-shipping-atomic-postgres.test.ts test/shipping-template-quote-postgres.test.ts test/admin-shipping-list.test.ts test/supplier-shipping-template.test.ts test/shipping-lifecycle-route-auth.test.ts test/admin-frontend-api-audit.test.ts`；Worker `npm run typecheck`；Admin `npm run build`。浏览器脚本与SQL服务只保留本机临时目录，不编入应用。验收结束关闭服务并核验临时数据库/schema/角色零残留。

## CI与后续门禁

上一提交 ef4fce3 的 [Actions34749398563](https://github.com/cinagroup/cinashop/actions/runs/34749398563) 最终9个作业成功、2个失败：单元第二分片唯一失败为 Admin API 确定性审计快照过时，汇总相应失败。当前用既有 `audit:admin-api -- --write --summary --strict` 刷新来源哈希/行号和新增路由清单，保留精确相等断言，2项通过。不能因此把旧CI改记成功，也不代替当前精确SHA Linux。

Admin静态调用345处/365变体均可执行，无未注册或未解析；PHP路由1904、TS1656、匹配881、可执行863、原始缺失1023、退役17、可执行缺口1006。新端点没有增加PHP精确匹配分子，不能据此宣称行为全量等价。

仍需自身Linux、真实角色/浏览器和真机、登录身份切换与未知结果浏览器用例、历史损坏规则的受控修复、生产规模及发布验收。清单240完成/164开放/404，A3k13不勾选。详细原始文件、SHA256和范围见 `workers-ts/audit/admin-shipping-grouped-20260913.json`。

技能影响：依据 PostgreSQL 锁顺序约束沿用父先子边界，依据 Workers 最佳实践保持请求内状态、既有Hyperdrive、受限载荷和Web Crypto；依据前端验收技能执行真实渲染/双尺寸/交互复验。已核对最新 Workers types 5.20260911.1 的 digest 签名，不修改项目依赖或兼容日期。[Cloudflare 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
