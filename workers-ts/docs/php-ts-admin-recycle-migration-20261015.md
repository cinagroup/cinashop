# Admin 商品回收与恢复迁移（2026-10-15）

本批从 `26207ea326a7b83a3500e27f1df0ca7984b121ad` 继续推进商品生命周期。此前审核/自动上下架批次已推送且远端 main 独立读回一致；提交前远端 main 已前进至 `a89b1c36a89c78f1100ffecee322cb1955dcd850`；已保存工作、快进并无冲突恢复本批补丁，重新验证整合版本。本批保留此前报告、账本、回执与3495文件 freeze，不修改其历史结论。本批未部署、未执行生产 DDL、未停用 PHP，整体迁移仍未完成。

## 源合同与行为

真实 PHP `DELETE /adminapi/product/product/:id` 是双向切换：当前 is_del=1 则仅恢复 is_del=0，返回“成功恢复商品”；其他值则写 is_del=1/is_show=0，返回“成功移到回收站”。恢复保持原上架标记，不自动上架。旧页面实际通过 `utils/public.js → api/common.js.tableDelApi` 发送 ids=''，即空请求体；两方向共用一个 DELETE。来源与行号见 `audit/recycle-20261015/source-scout.json`。

平台 type0 同步所有直接 pid=id 子商品的 is_del，不按子商品归属、审核、删除或活动标记过滤；不递归孙商品，不改子商品上架/审核字段。门店 type1 在两方向重置 is_verify=0：声明安装 schema/ORM 没有 product_verify_status 列或 getter/config 注入，getStoreInfo 对不存在/删除门店返回空数组。未借用员工权限字段或发明免审核列；外部私有扩展 schema 的未知字段行为不在已证明范围。

明文 `product.delete → DeleteSuccess → changeStatus(id,0)` 将父商品全部购物车状态置0，含原状态0/2以及 paid/deleted/new/activity 行；子商品购物车保持原值。SKU、关系、库存流水、定时时间和订单不由本路径更新。源不存在卡密、审核、归属或当前回收状态准入门槛，后端保留这些行为。源码中物理删除是另一合同，不属于本批。

目标 canonical 响应固定 data=[] 与源中文消息。既有 `/adminapi/product/del/:id`、`/api/admin/product/del/:id` 保持单向回收、data:null/删除成功；已删除 alias 不重复使购物车失效、审计或创建效果。不存在商品沿用源 status400/“商品数据不存在”（旧 target alias 曾可能对零行 UPDATE 返回成功），这是 alias 的显式收紧。canonical 空 query 的旧调用还把明确回滚的409/503转换为HTTP200/status400，让真实旧 Axios 拦截器进入reject；有 expected_is_del 的现代调用保留真实HTTP409/503，未知失败不转为确定拒绝。空体以1KiB流上限验证，拒绝非空体/未知或重复 query；canonical 可选唯一 expected_is_del=0|1，现代页面用它拒绝过时方向，旧空 query 仍保持源切换合同。

## 权限与事务

真实 installer169 DELETE resource 的完整元组授权 product.manage，并隐含 product.view；固定105 POST编辑、620 GET详情元组分别保持 manage/view。仅真实资源 ID/占位符属于这组绑定，不误拦 unit/rule/ensure 的独立路径。伪造 ID、GET+manage、复制种子、错误菜单元组不能经过 opaque/批量/单条 fallback 变成写权限。当前 JWT、中央 Admin 状态/密码/角色历史/level 与最终 live authority 都参与判定。认证之前设置 private/no-store 与 no-cache。

一个有期限事务先取得 authority 屏障，读取完整候选家族（最多10000），按ID升序取全部 bargain exclusive 与 product try fences，之后才取得 product/SKU/cart/relation 四张真实 SHARE ROW EXCLUSIVE NOWAIT 表屏障，再比对完整初读家族。等待 bargain 时不持商品业务行/表锁，使已先锁 cart 的 checkout 参与者可以完成；此处不声称运行了完整 Checkout 下单流程。初读期间新增或改 pid 的子商品导致409而非漏处理。

四表屏障覆盖直接 SQL 与空集合幻读，也会短暂阻止无关商品写入；SKU/relation 虽不更新，运行身份仍须 UPDATE 权限。数字菜单决策 FOR SHARE 还需 system_menus UPDATE，canonical role 不需要额外菜单行锁。其他既有角色引用历史核验权限沿用 authority 实现。完整 RETURNING/回读覆盖父/子全字段、全部关联 SKU/cart/relation、完整审计及本 aggregate 的既有+新增 outbox 集合；最后复查 live authority 与数据库墙钟。没有订单写权限或锁；不把正常独立订单变化当成回收冲突。审计/outbox 多次回读不意味着阻止任意独立 SQL 在最终回读后改写它们。

业务、product_recycle DELETE 审计与专属 product.recycle.effects 意图原子提交。提交后的 Queue dispatch 失败保留已成功业务，后续补偿扫描/重放仅处理效果，避免重跑相对切换。现有 outbox 租约/重试/DEAD 与人工 replay 机制沿用。

## 全域缓存与未证明效果

PHP controller 清理全域 `mc:store_product:tag`、`mc:store_product_attr:tag`，包括子商品、其他商品和所有活动规格。TagSet member 已是物理数据 key，集合物理 key 是 REDIS_PREFIX+CACHE_TAG_PREFIX+CRMEB:+md5(tag)；前缀只加一次。目标专属事件校验 product aggregate/UUID key、exact payload 和 canonical DELETE 审计三字段 action 后，在业务锁之外清理这两个完整集合，不复用库存事件或其通知。

Lua 先核验两个集合类型和合计10000成员上限，再核验全部成员属于对应物理商品命名空间且单 key≤2048字节，之后才分256项删除成员及两个集合。Lua错误不会回滚先前写入，因此不能边验证边删除。没有 KEYS/SCAN/flush；异常类型、污染 member、超限、缺 provider 或无效 provider 回执使效果失败并可重试。Redis缺配置即使非生产也不算清理成功。当前 TS 组装商品详情直接读库，不使用这套组装缓存。

部署者必须让 Upstash binding 指向待清理的旧 Redis 数据域，并核实 REDIS_PREFIX/CACHE_TAG_PREFIX（默认空）的实际值。此环境没有真实 Redis/Valkey/Lua 引擎；provider spy 只证明脚本/物理 key 调用和失败处理，未证明真实 Lua 执行边界或生产 Redis 清理成功。文件缓存 driver 的清理也未验证。

DeleteSuccess 随后触发 get.config，但其 AutoConfig listener 是 Swoole Loader 密文。旧客户端 ADMIN_NEW_PUSH 与 STORE_STOCK 可见，不足以证明删除会发其中任何帧。未冒充库存或提现通知，也未宣称复原该密文内部配置/缓存/WS效果；这部分全局迁移证据仍开放。

专属事件白名单升级为独立外部0177/embedded0182：仅从已知旧 CHECK 扩展一个事件，检查普通持久表/RLS/继承/事件触发器漂移、NOWAIT 维护锁及10000行预算，保留更低超时和约束注释；幂等不替换 OID。未知定义不自动修复，无业务 DML/自动权限授予。HTTP/Queue 不执行升级 DDL。

## 现代页面与验证

商品各状态列表均可回收，回收站提供恢复入口；提交前展示父购物车、子商品与门店审核影响。成功重读列表和计数。组件按路由/身份/商品/上下文丢弃旧响应；库存推送不打断已打开的回收弹窗。

API 持久化 owner/product/run 标记，不保存商品内容或凭据；同 owner/product Web Lock 覆盖请求，短 marker mutex 仅覆盖同步存储操作。发出 Axios 前重新核对身份、session 与 bearer。未知结果阻止重发，之后的真正商品列表读取与人工核对才允许新决定；写期间或写前开始的读取不能事后成为恢复证据。旧浏览器缺 Web Locks 时只有单标签 pending 和持久标记保障，未宣称同等跨标签并发保证。

最终门禁、测试计数、source freeze 和复核结论由本批账本记录；初轮失败保留。初轮渲染fixture误用了Node原生LockManager，显式浏览器宿主修正后复核通过；首次原生DDL测试未考虑fixture不自动创建CHECK，补齐前置定义后复核通过；首次workerd有8项通过但2个未捕获TCP错误，源于漏mock通用Queue分支的通知投递SQL后续扫描，补上该边界mock后重新验收，未把该轮计作通过。重型验证全部通过共享串行锁、Vitest单 worker、Worker tsc8192MiB。浏览器使用已安装连接能力的 CUA 与真实 Vue/ElementPlus/Axios，API为仅回环合成 fixture，未声称浏览器→真实数据库或生产端到端。

整合版本最终普通11文件83项、原生PG16四文件28项通过。两类重复执行17个定义，所以普通/原生合计94个不同定义；workerd另三文件8项通过（1项新回收Queue分发、7项既有调度回归），SQL service和通用投递SQL后续扫描均mock，不声称workerd连接真实PG。首次修复后的窄前端两文件9项与最终完整普通回归重叠，不加算覆盖数。Admin类型检查最后发现废弃删除确认框遗留的未使用ElMessageBox导入；仅删该导入后，三套商品页面23项再次通过（与83项重叠），后端/Worker源码保持已验收字节；精确替换与前后SHA见unused-import-repair.json。暂存检查另只删除新前端测试文件末尾多余的两个LF，字节等价证明在eof-normalization.json，未为末尾空白重复重型测试。

| 最终门禁 | 结果 |
| --- | --- |
| 普通回归 / 原生PG16 | 83通过 / 28通过；原生集群停止、剩余fixture数据库0 |
| workerd真实Queue路由/ack/retry，mock SQL | 8通过，无未捕获错误 |
| Worker完整普通 / runtime tsc | 均8192MiB、exit0 |
| Admin vue-tsc / Vite构建 | 均exit0；构建有两条既有Vueuse PURE注释位置提示 |
| 源码freeze | 3547输入，最终digest `6e7e8f4c01f49d87e8264328e09a46e0a7b0ccbc3432d457bd500ef39164474b`；不含完整构建输入图/安装依赖字节/环境值 |
| 源消费输入 | 25个明确PHP/旧JS源码文件单独固定SHA；旧拦截器与tableDelApi实际编译执行 |

独立审查发现并修复了旧端错误消费问题；交叉审查发现并修复了库存推送关闭回收弹窗问题。远端整合窄复核确认3个重叠文件的远端新增41行完整保留，本批只叠加自己的路由/缓存头/测试选择。

浏览器走过桌面1280×720确认与提交后500、禁止重发，之后回收站读取、手机390×844人工核对及恢复、恢复后仓库未上架和计数刷新。初始完整链与最终独立标签控制台均无warn/error，窄屏弹窗文字和按钮可见。临时API随后退出143，后续reload显示读取失败；该状态留证，重启fixture后用独立新标签在最终UI源码重做回收/恢复及仓库未上架确认，不隐藏临时服务中断。原始脚本/截图留 `/tmp/cinashop-recycle-qa`，只在账本保存引用与散列；viewport 已恢复，临时服务与标签在验收后清理。

全局404项清单/88项审计清单在本批保持不变。未将局部商品生命周期进展升级为全局完成，未顺便消除 get_script 的注册/退役冲突。
