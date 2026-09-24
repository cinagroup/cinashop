# Admin marketing 旧路由逐屏代码审计

本批以 `audit/admin-frontend-inventory.json` 为权威导航分母，只审计 `/admin/marketing*` 下 `surface=page` 的 48 条旧业务路由。旧模块另有 4 条导向 `commonForm` 的辅助路由：`store_bargain/setting`、`integral/system_config/:type?/:tab_id?`、`setup_recharge`、`sign_config`。它们在 274 条业务路由之外，不能加进本批分母。

`audit/admin-legacy-marketing-route-parity.json` 由 `scripts/admin-marketing-frontend-parity-audit.ts` 从权威清单和 48 条显式语义结论生成。每条记录保留旧路由、组件、路由权限、新 Admin 页面、Worker API、目标权限、已覆盖行为、剩余缺口及源码证据。生成器要求路径唯一、48 条全部分类、目标页面与 API 已注册、本仓库目标证据文件存在；`test/admin-marketing-frontend-parity.test.ts` 固定路径顺序、状态计数、关键误判边界及 JSON 字节一致性。

旧路由与组件位置来自权威清单中 `marketing.js` 的 SHA-256 `9b1deadb2081e4326af19b4cafbd78afa943e5b99567362c1773a2e8b99e28ed`。旧 `meta.auth` 是逐路由固定的审计结论。旧 PHP 路径仅作来源定位；生成及 CI 不读取或要求相邻的 `cinashop-php` 仓库，只检查本仓库目标证据文件。旧路由快照哈希变化时生成器会要求重新审计。

| 状态 | 屏数 | 判断边界 |
| --- | ---: | --- |
| candidate | 3 | 优惠套餐列表和创建/编辑、用户优惠券领取记录已有本地 Admin 与 Worker 操作面；仍待真实角色和生产流程验收。 |
| partial | 22 | 新页面可承接有意义的部分操作，但旧筛选、字段、导出、发行或渠道闭环尚不完整。 |
| missing | 23 | 无可执行的新 Admin 整屏替代；仅有 Worker API 或前台业务能力不足以提高状态。 |
| retired | 0 | 未发现足以证明旧路由是无效占位页的证据。 |

容易混淆的映射：

- 新 `/coupon` 的 Worker 读写 `store_coupon_issue`，只能部分承接旧发行目录和表单；旧 `store_coupon` 模板屏仍缺。新发行列表未过滤 `is_del`，删除后的软删记录仍可见。
- 新 `/marketing/coupon-records` 用独立 `coupon_record.view` 权限读取 `store_coupon_user` 领取实例，与发行实例列表分开。旧页只读，按状态、领取人和券名筛选，按 ID 倒序每页 15 条并展示 10 列；新页及 GET 合同对齐这些本地行为，列为 candidate。旧 `store_coupon_issue.coupon_type` 在数据迁移时映射至新表 `type`，用于区分金额券和折扣券。真实历史领取记录、受限角色和发布后流程仍待验收。
- 领取记录旧筛选标题写“是否有效”，实际请求 `status`（0/1/2）；新页改为“状态”，并明确支持目标表已有的 3=未支付订单占用中。旧 `is_fail` 用勾/叉图标，新页用有效/失效文字。旧未知领取来源显示空值，新页显示“其他获取方式”；旧零时间显示空白，迁移后的空时间显示“—”；旧跨页空列表返回零总数，新接口保留真实总数。这些显示与分页差异不改变只读领取记录范围。
- 新 `/activity` 汇集秒杀、拼团、砍价、积分商品与优惠套餐。按商品查看的团/砍价参与弹窗不能替代旧跨商品记录与统计。旧秒杀活动目录及 `seckill_data` 内容配置也没有等价 Admin 页面。
- `/activity` 聚合页仍没有分页：砍价固定前 100 条；秒杀、拼团、积分虽传 `limit:100`，但 `BaseDao.ts:162-164` 只在同时传 `page` 时限量，实际无界读取。旧软删行过滤、非砍价编辑保留销量/创建时间与已绑定秒杀时段、三类活动软删除已在本地候选修复；新建秒杀表单仍未选择时段，Worker 默认 `timeId="1"`。完整表单与并发销量变化时的库存/额度边界、真实历史数据和角色仍须验收，partial 不表示整屏已覆盖。
- 新 `/marketing/lottery` 具备活动和中奖记录操作面，但未恢复旧时间状态筛选、中奖记录完整筛选/翻页，并拒绝新建旧微信红包和未明确等级奖品，因此三屏均为 partial。
- 旧营销渠道码映射到跨域 `/content/wechat-qrcode`。目录、编辑和统计均有本地入口；公众号扫码回调尚未启用，三屏仍为 partial。
- 新 `/marketing/user-point` 的独立只读权限、分页积分流水与四项统计可部分承接旧积分日志。旧页只有用户 ID/标题和时间筛选，统计卡在初始化时单独加载；新页增加可选精确类型并按同条件查询统计。旧 Excel 导出尚未恢复，历史流水和受限角色仍待验收，因此保持 partial。积分分类/独立统计、签到奖励、充值配置、促销规则及活动边框/背景仍无整屏替代；签到奖励虽有 Worker 读写 API，仍列 missing。

本批只完成代码级语义映射。当前 11 份逐屏台账合计 **274/274 已审**；其中营销域为 3 条 candidate、22 条 partial、23 条 missing。已审不等于功能已覆盖：跨域真实角色/数据 E2E 及发布验收仍开放，FE-001D 不因本文件关闭。

定向复核命令：在 `workers-ts` 下运行 `node node_modules/vitest/vitest.mjs run test/admin-marketing-frontend-parity.test.ts`。重新生成台账用 `node node_modules/tsx/dist/cli.mjs scripts/admin-marketing-frontend-parity-audit.ts --write`。
