# 平台SKU规格模板完整作者增量（2026-10-26 本地验收）

保留成熟平台/Supplier规格模板CRUD、真实商品复制SKU与旧API；新增原 `/admin/product/product_attr`、独立 `/product/rules` 和聚合SKU标签复用的完整作者。
五列目录、10/page与名称literal搜索，无媒体/状态/排序/软删除作者；模板物理删不修改商品已复制的规格、价格、库存与unique。
既有行默认preserve：数据库NULL、损坏/未知/溢出JSON及格式原串不因查看/改名重写；仅明确replace才整批校验并序列化1–3维/1–50值。沿现TS32/32/64 Unicode，而非把PHP旧UI20/30上限强加给成熟API。
动作完整原稿48KiB、HTTP64KiB；每owner多UUID持久记录，dispatch前保存、原UUID先验回执、missing404保持未知，支持同UUIDretry/receipt/显式封存及撤权后owner恢复。
完整五列+xmin全scope源CAS与20000/16MiB容量显式拒绝；authority→成熟731612,0→Rule表SRE NOWAIT→独立addon731648,0→作者731648,1。全量回读/审计/延迟约束失败原子回滚。
维度/值独立稳定ID、结构/输入/来源/session/route/active代次；真实Vue cacheHandlers原生事件与旧回调重放覆盖。保留Unit/Ensure child/API/state/common及共享request原字节。

最终唯一选测4364（新增364）：后台216（新102/旧114），前端232（新Rule66、旧Unit84/Ensure82），原生PG16 41（新1/旧40），来源3875（新195/旧3680）。
8项runtime、31来源与GUI共10门禁均有exit0/原始日志/完整输入。首次来源3872/3874失败后，仅修复旧API来源套件的最后一个import读端口、新Rule来源套件增加1条完整ledger-publication桥负例和其import；原业务/前端/控制器/迁移/成熟core/Supplier源码均未变。7项未执行这两个source-test模块的既有成功runtime收据逐项原样保留，Worker主类型已用两精确after文件重跑；31来源与GUI须在最终完整快照执行。每个保留gate只容许这两条完整before/after哈希和明确后置API报告/newproof/helper，禁止宽泛test路径或其它漂移。
两Worker类型、Admin类型、Vite、真实API773 callSites/811 variants均通过；原769 callSites的807变体逐对象保留，精确新增四Rule wrapper，0退休/注册缺口。
PG16四套均无skip、fixture0且cluster停止；真实成熟core/Supplier写入竞争、权限与回执addon安装/中断回滚、模板物理删后copied商品再保存属于独立原生证据。
GUI为controlled HTTP/notification ports，本机现有Chrome/Playwright fallback，不代替SQL/provider或产品copy数据证明。1365/375/320十图逐张复核、移动对话框内部滚动/固定footer实测；五committed变更加一个显式封存controlled conflict；唯一ERR_FAILED为create已提交丢ACK，只GET原UUID不重复POST。
整个dist与源码实际字节双向冻结；5220服务停止。全部失败/中间试跑与候选资料原样存档不重复计数；最初215/216旧权限目录失败与首次来源3872/3874失败原始JSON/日志/输入均保留。完整前驱发布桥只把已接受Ensure的两本完整ledger还原到真实Unit accepted cache中匹配Ensure before/observed的原字节；没有裁剪、重造或更改旧Ensure proof/helper/断言。
旧Unit父回归只维护实际Rule URL及transport；原84为旧回归。旧权限套件精确新增四Rule恢复路由import/contract，原断言保留。30旧来源套件仅import读端口变化，1724旧证据保持原字节。

来源 `workers-ts/audit/product-rule-author-source-binding-20261026.json` SHA256 `392bc3bcf6f9598b2a6651c8454a92d349ee07dda5a3025fb253f55d3d5985c1`，helper `5bbe23c9daff2ef7c827deae3123ce7824201e285fcb731f5ef421df063682d9`；真before7929来自已接受Ensure cache，完整当前源码/生成dist及本轮全部原始证据实物缓存 `.cache/migration-evidence/rule-author-20261026/`。
文档/两账本/完整输入manifest预检、原前缀append-only/逐替换CAS/异常不覆盖他方后写入，最终accepted receipt最后发布。不是下一候选或整体PHP→TS完成；ADM-001/FE-001继续开放。
未生产安装addon、真实账号/provider、远端CI或commit/push/PR/merge/deploy；没有新图片素材授权。
