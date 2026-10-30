# 平台搜索热词完整作者增量（2026-10-27 本地验收）

保留成熟热词CRUD、公开top20过滤/排序和搜索副作用；新增原 `/admin/product/hotWords`、独立作者与聚合入口，六列15/page、名称或ID literal搜索。八值为名称、三种颜色、图标、排序、高级设置、显示；默认高级设置0只影响作者控件，不增加公开is_search/is_hot过滤。
现代名称1..15 Unicode；128Unicode历史名称、非法原色/HTTP图标、signed排序和未知flags同值保留，安全预览不回写原稿。唯一可选图标槽复用现有平台raster附件；Admin未授权canonical空预览且新写拒绝。公开validcanonical签名，未授权canonical保留原成熟unsigned业务URL且不授新权限；Uni仅精确signed-relative形状补API_BASE，普通relative/HTTPS原字符串与source lease不变。
全部14列+xmin、全scope20000/16MiB私有CAS，输出平台0/0未删除完整目录；改删保留隐藏字段，删除仅is_del1/is_show0/is_hot0。authority→成熟731614,0→表SRE NOWAIT→addon731653,0→作者731653,-1→目标UPDATE NOWAIT；元数据SHARE/审计与延迟constraint后再核验，触发器篡改全事务回滚。独立immutable9列receipt仅Admin SELECT/INSERT，App无权，显式维护不在请求中DDL。
每owner多UUID非秘密journal、dispatch前持久化；未知404保持原意图，仅原UUID重试/读取/显式封存，撤权有效owner可恢复。原始payload16KiB/HTTP32KiB；safe preview/签名不入保存JSON，图库/高级分支/owner/route/source/active/session/ABA/unmount旧native事件退休。
本次唯一选测5156，新增476。常规后台选中275，271真实通过（新163/旧108），唯一4个PG条件HTTP用例在独立native-http真实4/4通过后仅计一次；任何skip均未记作pass。前端588（Admin406/Uni182，新103），PG16合计9（新1/旧8），来源4288（新209/旧4079）。13项runtime均在当前完整源新鲜执行，12原driver未改并加独立HTTP补验；来源与GUI随后同freeze执行。早先失败/诊断通过不复用或重复计数。
两Worker类型、Admin/Uni类型、Admin与H5/MP/App构建通过；三个Uni stage完整生成集合另存raw artifacts，不纳入受控源码baseline。实际AST783 callSites/821 variants，旧777/815完整调用对象逐项保留，新增6wrapper，无退休/注册缺口。
GUI为受控本机HTTP/通知/图片端口，独立于真实SQL/ACL/provider证据；1365/375/320十图逐张视觉复核，八次commit含历史原稿、图标选择/清除、show/hide、15emoji创建丢ACK仅GET回执、不重复POST及softdelete。20+1图库真实本地PNG解码；移动内部滚动/固定footer；唯一ERR_FAILED为受控丢ACK，0warning/pageerror，5222与两PGcluster均停止/fixture0。
最初beforeAll内builtin拼写、一次重复提示夹具和unused import类型失败全文、完整源快照及修复均保存；最终13门全部重新执行。旧Unit父两fixture仅1个words URL和transport（3case另2正文不变），旧PublicController接线断言仅换facade并新增仍调用成熟producer的精确见证，原5case目的保留；权限case仅增加4恢复路径。32旧source suites正文/negative原字节，1730前驱证据冻结。
真实before7973来自已接受Parameter缓存；两本完整账本按Parameter publication→实际Parameter validation映射，再由不可变Parameter/Rule内桥逐层恢复，绝不裁剪或伪造前像。source proof `9db55d738908e60ec9f3850133470d5af79807465b46e443b44f92b84053c3d7`，helper `87d709889d72cc99c55e8a4fbbc799183a8f12fba8f143239077d410b08e1eef`。
全部输入、源码、Admin dist、Uni生成副本及原始日志/截图/失败证据实物逐SHA归档 `.cache/migration-evidence/hotword-author-20261027/`；文档和两账本append-only/CAS并异常回滚，accepted receipt最后发布。仅本地增量，整体PHP→TS/ADM-001/FE-001仍开放；未生产安装addon、真实账号/provider/R2集成、远端CI、Git发布或部署。
