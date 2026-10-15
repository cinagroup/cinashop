# Admin 相对库存调整 PHP → TypeScript 增量（2026-10-15）

本批补齐商品列表库存弹窗使用的两条真实旧接口，并接入库存预警的耐久缓存清理与独立通知通道。本轮交付是 GitHub 源码候选；整体 PHP → TS 迁移仍开放，未部署数据库 DDL、未发布生产服务、未关闭 PHP。源码决定和分阶段独立复核分别见 [source-decisions.json](../audit/stock-20261015/source-decisions.json) 与 [source-independent-review.json](../audit/stock-20261015/source-independent-review.json)。旧批次回执只保留其历史意义，不作为本轮新源码的验证快照。

## 真实旧合同与来源

| 接口 | 本轮行为与权限 |
| --- | --- |
| GET `/adminapi/product/product/attrs/:id` | `product.view`；返回普通 `type=0` SKU 完整字段数组，按 ID 升序 |
| PUT `/adminapi/product/product/saveStocks/:id` | `product.manage`；接收 `attrs:[{unique,pm,stock}]`，按相对入／出库调整，返回 `{stock}` |

来源为 PHP `StoreProduct.getAttrs/saveProductAttrsStock`、`StoreProductAttrValueServices.saveProductAttrsStock`、DAO 的 `getProductAttrValue`、`stockEdit.vue` 及商品列表真实消费。旧弹窗发送所有行，包括零调整；`pm=0` 是有效出库方向。本轮没有把移动端绝对编辑或 Supplier 库存归一化冒充这两条合同。

读取保留普通 SKU 的原始条码、编码、价格字符串及目标退役字段。父商品不存在时仍可返回空数组或孤立 SKU，不新增自动 404。`disk_info` 始终为 null，防止卡密／磁盘信息暴露；私有图片按当前父商品归属与既有发布策略签名，无法证明归属时置空。普通非私有图片原值保留。已有签名链接沿用短期 bearer 权限直至到期；归属变化停止新签发，本批未新增即时撤销协议。

写入保留 PHP 的实际运算规则：

- 存储中相同 `unique` 取 ID 升序最后一行；未知别名跳过，只有未知别名的请求仍更新主商品、预警、审计与效果意图。
- 同一请求重复调整别名时，每次从原始 SKU 值计算，后一次覆盖前一次 SKU 写入；主库存则累加所有已识别请求的净变化，不改成最终 SKU 求和。
- SKU／主库存最低为 0；`sum_stock` 允许负数，不截零。流水记录请求数量，超出可用库存也不缩减；已识别零调整仍更新并记录零流水。
- 流水使用原 SKU 成本、批次共同时间和源默认 `store_id=0`，包括供应商／门店商品。正主库存以数字字符串返回，截零结果为数字 0。

例如库存 10 出库 20：SKU 与主库存截为 0，累计库存可变成 -10，流水仍记录出库 20。这个合同不能替换成禁止超出库存或累计 SKU 连续扣减。

## 目标事务和安全边界

读取在独立 `REPEATABLE READ READ ONLY` 事务中校验中央 Admin、密码版本、完整角色历史、`product.view` 及结束时数据库墙钟到期。写入采用一个短事务：当前 `product.manage` 准入、Admin 权限表屏障、商品／SKU 身份围栏、ERP／商城配置协调锁，以及真实 `system_config SHARE MODE NOWAIT` 表屏障。最后一项同时保护不存在的配置键，覆盖活跃通用配置批次插入；不能只锁现存行或依赖未投产的候选 ERP trigger。

父商品和全部 SKU 按固定顺序 `FOR UPDATE NOWAIT`，反向库存消费者发生冲突时整批 409，不反向等待。事务核对完整商品／SKU 写入回执、全部原有及新增流水、完整 Admin 审计、耐久 outbox 意图，并在审计后回读业务与配置，重新解析权限及检查时钟。语句／锁／事务空闲上限分别为 5／2／5 秒。

显式目标边界包括 canonical 正 ID、非负 int32 相对数量、有限 `pm=0/1`、单批／完整 SKU／既有流水容量 10000、1 MiB 请求体，以及未知字段／查询拒绝。异常 owner tuple、卡密商品制造库存、非零退役调整、活动与退役共享别名的非零调整均拒绝；合法隐藏、回收站、待审核商品和门店／供应商归属不因此被一概拒绝。退役零调整保留完整行。

当前数据库 ERP 开关禁止快捷调整，非法开关／阈值也明确拒绝。预警按源 `ProductStockTips` 计算：任何普通 SKU 库存为 0 则已售罄；主库存不高于阈值或任一普通 SKU 不高于阈值则预警，包含退役普通行。目标在库存事务内同步计算标志，区别于 PHP 队列稍后保存。当前配置使用确定的 `sort/id` 优先级，不宣称未执行 PHP 的重复配置遇行顺序等价。

安装源没有这两个单 ID 库存接口的真实数字权限种子。只使用已有 canonical 能力；复制 tuple、无来源的数字菜单和无关 `attrs/<id>/<type>` 不制造库存写权限。商品列表页面种子 2 仍只授予查看。

## 耐久效果、通知和前端恢复

库存、审计及 `product.stock.effects:<productId>:<uuid>` 意图同事务提交。效果沿用现有 Queue 的认领、租约、FAILED 和扫描重试；仅效果重试，不重复相对库存调整。提交后 Queue 派发失败不把已提交库存伪报为失败。缓存只删除明确的 `product_info` 兼容键和普通 SKU `attr/attr_value/attr_sku` 键，配置了 Redis 时错误进入重试；不宣称迁移了完整 PHP cache tag 或不存在的 TS 详情缓存。

新增目标专属 GET `/adminapi/product/stock/notifications/socket`，与两条旧接口分别计数。`product_stock` 使用独立 `staff-stock:admin:<id>` 分区、`product.view` 和 0 至 9 的有效 Admin 层级；默认提现分区与 `extract.view`、严格旧帧解析继续独立。连接、心跳和发送都重新校验当前权限，跨作用域事件拒绝；库存帧仅带商品 ID。Queue／Redis／DO 测试使用明确本地端口或替身，未证明真实 provider 投递。

现代弹窗保留逐行／批量相对数量和全部零行提交。会话、商品或目录上下文变化后，旧读取和旧写入结果不能重开弹窗或作用于新会话。请求进行中禁止重复点击和人工确认；未知传输结果持久保存仅含 owner／商品／随机运行 ID 的标记，重新读取并人工核对后才开始新调整，绝不自动重放原数量。Web Locks 在支持的浏览器中按 owner／商品保护请求，短全局锁保护标记数组；旧浏览器后备仅保护当前标签页。等待锁后、修改标记时和 Axios 实际序列化前再次核对 token／会话，未发送的旧身份请求清理自己的标记。

独立审查发现并修复了弹窗首次打开被错误关闭、进行中请求被人工确认、缺失配置键的并发插入，以及库存通知 Admin 层级不一致。实际浏览器另发现 Element Plus 数字输入在恢复可编辑后保留旧 `aria-disabled`；弹窗在有效 disabled 状态变化时重建输入组件以恢复可访问状态。Browser 插件已实际重跑桌面未知结果 → 新读取 → 人工确认 → 填写新数量，最终 DOM 为 `value=2, disabled=false, aria-disabled=false`。

## 本轮限定验证与待完成门禁

| 事实 | 当前结果 |
| --- | --- |
| 8 个完整普通测试文件 | 65 通过、4 条件跳过、0 失败；[普通结果](../audit/stock-20261015/stock-ordinary-pass.json) |
| ARIA 修复后前端复跑 | 2 个完整文件 27 通过；均与普通矩阵重叠，不重复计数 |
| 4 个完整 PG16 原生文件 | 26 通过、0 跳过／失败；[终态回执](../audit/stock-20261015/stock-native-pass-status.json) |
| 条件定义补验 | 普通模式的 4 条均已原生执行；普通／原生有重叠，不将两次通过数相加 |
| 原生资源清理 | 自有夹具 remaining=0，集群停止；首轮失败与修正后终态分别保留 |
| 最终当前源码类型／构建 | Worker unit／runtime 两套 8192 MiB 类型检查、Admin／Kefu 类型与生产构建全部 exit 0 |
| Workers／DO 运行时终验 | 2 个完整文件 10 通过；真实 workerd 库存与提现分区隔离、稳定重试 revision 和既有代理回归通过 |
| Browser 插件实际双视口／恢复流程终验 | 实际桌面恢复链通过；最终 1280×850／390×844 布局及手机横向滚动已检查，移动端未单独重跑整条恢复链 |

原生验证包含真实通用配置写入的双连接表锁冲突、SELECT-only LOGIN 成功读取及 DML／审计 INSERT／序列的 42501 拒绝，以及 0175 前置 CHECK → 精确升级 → 重放无业务改动／保留注释 → 漂移拒绝。首轮原生 25 通过、1 夹具失败源于把 PostgreSQL 约束展示文本重新当作 DDL；已改用真实前置 `CHECK(event_type IN (...))`，严格生产漂移检查和断言未放宽，复跑 26／26 通过。初轮失败与中间类型错误回执保留。

重型验证由根代理通过共享串行 wrapper 执行，Vitest 单 worker。当前证据来自本地合成身份、实际 App／JWT／SQL、隔离 PG16 和明确 provider／R2 替身；没有执行 PHP 解释器、编码 BaseController 或完整线上 PHP 序列化，也不等于生产数据库、Cloudflare、Redis、Queue 或真实账号验收。全局迁移清单不因本批勾选完成；未部署外部 0175／嵌入 0180 候选 DDL，未关闭 PHP。

当前声明输入冻结覆盖 3478 个文件，包含本批影响的 `view/common` 与 Kefu 消费端，摘要为 `5dc796c85f8a53ba57f4e0d8b49dd8f6ecba4474c997575b6fa4a5a6f559594d`；环境值和已安装依赖字节不在该声明范围。完整验证绑定见 [本轮账本](../audit/php-ts-admin-stock-migration-20261015.json)。截图／原始日志留在本地，Git 中的回执明确记录其路径、摘要与可移植性边界。
