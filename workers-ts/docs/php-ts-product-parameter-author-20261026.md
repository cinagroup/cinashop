# 平台商品参数模板完整作者增量（2026-10-26 本地验收）

保留原已迁移参数模板CRUD、ProductMetadata核心、平台商品与Supplier自由参数/复制消费者；新增原 `/admin/product/specs`、独立 `/product/parameters` 和聚合参数标签完整作者，五列15/page及名称literal搜索。
私有category全部13列和store_product_specs全部9列加xmin，全scope每表20000/合计16MiB显式拒绝；公开仅platform0/0/owner0/group3，2000父/每父2000子/全部20000子完整读取，绝不截断或曝光foreign子行。
既有行默认preserve，仅更新父名称/排序，不echo/重建任何孩子；显式replace才整批重建0至100子行，允许重复参数名和刻意空数组，2000历史完整稿先保留直到明确整理。父历史空名称/负sort可同值保留；新/改父名与新子名/值沿成熟255Unicode及内部LF/CR/TAB/C1规则，仅拒NUL/unpaired。
原始payload384KiB、HTTP512KiB；textareas不设UTF16maxlength，原始sort输入不静默归一。每owner多UUID非秘密journal、dispatch前持久化、原UUID先验回执与显式封存；missing404保持未知，撤销product权限后有效owner仍可读取/封存自己的原操作。
锁序authority→成熟731613,0→category/specs SRE NOWAIT→addon共享731652,0→作者731652,-1→目标parent UPDATE NOWAIT。正uid/productId key不充当作者锁。物理删除仍拒任何live specs_id或任何type6引用；替换模板不会回写商品已复制参数/关系，历史商品普通保存和Supplier自由五字段/负sort/重复/模板0合同不缩减。
全部私有父子行、审计与延迟约束完整回读/事务回滚；独立immutable9列回执只给Admin SELECT/INSERT，App无权；安装显式维护，不在请求中DDL。
本次真实唯一选测4784（新增404）：后台314（新110/旧204），前端321（新Parameter89/旧232），PG16原生70（新1/旧69），来源4079（新204/旧3875）。失败、初试、skip和准备不重复计通过。
全部8项runtime新鲜执行，无前批七门复用/类型擦除/测试源码漂移例外；仅API报告和新proof/helper为明确后置输出。两Worker类型、Admin类型、Vite、实际AST API777 callSites/815 variants均通过；旧773 callSites的811完整变体逐对象保留，精确新增4个Parameter wrapper，无退休/注册缺口。
三套真实PG16全部case通过、fixture0且cluster停止；覆盖current App/Admin独立LOGIN、Rule addon并存、Parameter grant中断回滚、成熟core/Supplier双向竞争、真实ProductAssociation SHARE与删除先后次序、历史快照/type6和旧普通save。
GUI为本机controlled HTTP/通知port证据，不冒称真实SQL、地图、provider或复制商品验收。1365/375/320十图逐张视觉复核，移动弹窗内部滚动/固定footer/列表横滚；零子行和2000子行preserve、明确replace多行/C1/255Unicode、原始sort拒绝、五committed变更及一个受控占用拒绝封存。create已提交丢ACK仅GET原UUID恢复且无重复POST；唯一ERR_FAILED为该受控丢ACK，0warning/pageerror。源码与整dist双向实物哈希，5221服务已停止。
首次前端321通过、后台107/110的三处复制夹具错误完整保留，已修fixtures并全部新鲜重跑；没有为修正-0夹具虚构失败。512*1524→512*1024两处journal常量的321通过原组件前像/修复后像亦完整保存。旧Unit两文件仅1个实际Parameter URL及transport维护（3原case中另2原字节），旧权限case仅补4个精确owner恢复路由；31旧source suite正文/负例原字节，1727旧证据冻结。
真before7951来自已接受Rule cache；两本账本完整映射Rule accepted publication→实际Rule validation的Ensure accepted全文，再由immutable Rule桥映射preEnsure Unit accepted，不裁剪/伪造前像、不改Rule旧修复元数据。
来源 `workers-ts/audit/product-parameter-author-source-binding-20261026.json` SHA256 `b4793a4cc6d673ad3603c3f8d8ce366e88e9816c501b8d7fed04e5f819720b74`，helper `717a0857470bcec9954e93902fcf46070e8fd1adbe7063163a10b9430d1d3667`。所有实际输入、源码、dist、日志、截图、失败及修复原件完整缓存 `.cache/migration-evidence/parameter-author-20261026/`，逐SHA核对。文档/两账本append-only/CAS异常回滚，accepted receipt最后发布。
仅本地完整增量；整体PHP→TS及ADM-001/FE-001仍开放。未生产安装addon、真实账号/provider/R2、远端CI、commit/push/PR/merge/deploy。
