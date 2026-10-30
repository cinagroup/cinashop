# PHP → TS：商品单位原入口与可恢复名称、排序编辑

本批是既有商品单位CRUD迁移的增量。固定PHP原件为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。原 `/admin/product/unitList` 映射独立 `/product/units`，现有商品资料页的活跃单位标签复用同一组件，其他四个标签在选中后读取，原payload与处理器不改。原PHP名称、排序两字段和15条分页保留，名称/排序minWidth100、小屏表格min540及容器横滚；无图片、状态或恢复写入。旧CRUD、三处API包装、平台/Supplier真实商品写入服务均保留。整体迁移、ADM-001、FE-001继续开放。

新增双前缀 `/adminapi`、`/api/admin` 下 `/product/unit/author/{catalog,commit,receipt/:operationId,resolve}`。目录需要live product.view，提交需要product.manage；原数字1349仍仅查看。精确原owner回执与封存可在权限撤回后继续，但核验live身份、realm、凭据和期限，错误owner或相似路由无法恢复。

公开目录仅platform type0/relation0/status1/is_del0，返回精确8列id/type/relation_id/name/sort/status/is_del/add_time；私有源覆盖所有范围/隐藏/已删行的完整8列及xmin，生成opaque revision。20000条/16MiB为明确安全预算，超限拒绝、不截尾；can_create根据私有总数，公开count只计可见项，旧分页API保留。

只允许name、sort。raw名称4096 Unicode码点进入原摘要；新增/变化名称trim后非空、最多15码点，拒C0/C1与未配对surrogate。完全相同的历史varchar50名称可原样保存，包括空白与控制字符，50emoji不被HTML UTF16 maxlength截断。历史signed-smallint排序可保持原值，新变化须0..32767；原生rawSort文本保留临时输入，并明确拒 `-`、`01`、`1e2`、`-0` 或空值，不默送旧数值。全字段不变不执行UPDATE、不改xmin；历史重复名未变化允许，新建/改名与平台未删除（含停用）单位重名则拒绝。

事务先authority barrier/live权限，再成熟ProductUnitLifecycle731611,0、单位表SHARE ROW EXCLUSIVE NOWAIT、addon731626,22、作者731639,1及目标FOR UPDATE NOWAIT。改名/删除检查全部未删除商品unit_name引用，包括外owner；排序不受名称占用影响。软删除仅改is_del、保留其他7列。成熟商品保存继续支持历史free text，目录删除未构造新外键。严格INSERT RETURNING、全范围8列读回、原system_log与不可变回执同一事务，任一错误整体回滚。

9列admin_unit_operation仅Admin SELECT/INSERT、App无权，精确schema/约束/触发器/函数/sole ACL审计，触发器拒UPDATE/DELETE/TRUNCATE。runAdminUnitUpgrade仅显式PG16/current权限画像前后核验，安装中断整体回滚、重复安装幂等；HTTP/启动不执行DDL，不改runtimeBusinessPrivilegePlan。

原UUID/owner/operation/target/revision/payload_hash精确绑定。先读原UUID回执再查当前revision，404保持未知、不自动新POST；用户显式原样重试或resolve封存not_applied，阻止迟到提交。非秘密journal在dispatch前按owner+UUID持久化、逐个恢复和精确移除。真实Vue cacheHandlers/native事件覆盖input/source/route/session/token/role/owner/active ABA，隐藏/卸载使捕获回调退役，迟到结果不清另owner记录。changed仅严格committed发出。

来源层保存41完整前后像、17新增完整文件、12固定PHP全文、1718冻结前驱及33观察不变文件；28旧来源套件只改导入端口，正文断言和负例逐字保留，权限旧case只扩精确Unit恢复family、其余24项不变。API为763 callSites/801 variants；旧759 callSites对应797条calls[]展开记录全部保留，仅加4个Unit包装。来源首版中“759旧call objects”的标签已改为759调用位置及797变体；所有实际逐条核验保留。

本轮首次来源回归3493项中3491通过、2失败：新Unit断言误把PHP父path与child path声明当成一段完整alias字串；现按真实路由结构合成并核验实际组件。旧Staff的真实AST清单断言首跑6095ms超过安装Vitest默认5000ms，原套件在同一原正文/默认超时下单独复验177项全过（该断言3385ms），保留原结果，完整来源回归仅将外部限时调整为15000ms，不改旧断言或负例。177项属于最终来源集合，计数不额外增加。只重绑Unit本批新suite、新proof和helper的PROOF_SHA；原41前后像、另16新增、1718冻结和33观察字节不变。由于新suite为TypeScript，Worker主类型检查重新执行；运行时配置明确排除test/*.test.ts，原运行时/Admin类型、前端/SQL/native及构建的输入代码不变，复用原通过收据，之后重跑29来源套件并首次运行GUI。首次失败的JSON、日志、新层三个源码原件和原恢复清单均保留。

首次浏览器在375px刚打开编辑框时视口断言失败，保存了原脚本、失败结果、8图及失败截图共14件；失败截图禁用动画后框体本已在视口内。夹具改为等待实际有限modal-fade-in/dialog-fade-in结束，复验记录375/320下y约0.42移至16px，之后严格边界通过；这一阶段未改生产CSS。随后自动11图全过，逐张检查仍发现桌面长50emoji名称挤压“状态／启用”形成逐字换行。仅加第4列white-space:nowrap，原组件template/script精确不变；新proof只重绑该full_addition、helper仅PROOF_SHA变化，7591输入只更新这三行，原41逆像/另16新增/1718前驱/33观察不动。

第一次11图与完整10步成功收据、四源版本及原freeze在before-status-nowrap完整保留。最终只重跑Vite、29来源套件和三宽度GUI，七项非渲染门禁逐对象复用；不声称重新执行全部10步，也不把首次3491通过、177诊断或重复GUI加为新用例。原source-first-failure的a29 freeze→route修正6a41仅三文件，再至最终CSS freeze仅三文件，合计相对首freeze只四文件改变；两阶段原收据各自固定，不重造旧7200 before。

本次恢复环境实际重新运行唯一选测3744项（新增391）：行为251=SQL/Hono/addon117+旧接口/权限41+实际Vue原生事件84+独立PG16原生9（新1/旧8）；来源3493=旧3304+新189。无失败/跳过/取消计入通过。Worker两套tsc、Admin vue-tsc、Vite构建通过。全部Node/TS/浏览器经共享serial wrapper、Vitest单worker。

首次来源3491/3493与原Staff177独立诊断均保留，177不另计。路由断言修复只改新Suite/proof/helper三文件并重跑Worker主类型及完整来源。首次GUI动画测量失败14件保留；等待有限动画的夹具修正后GUI自动通过，但逐图发现桌面状态列竖排，已保存完整中间10门禁/11图及accepted:false复核。最终仅追加状态列nowrap CSS（template/script字节不变），从6a41中间冻结到最终冻结再改Vue/proof/helper三文件；相对a29恢复初始冻结共四文件。原六项非渲染门禁与路由修复后的Worker主类型，共七项按原收据完整复用，最终只重跑Vite、29来源3493、GUI11图；未伪称CSS之后又重新运行全部十项。所有重复尝试和诊断都不增加唯一通过计数。

PG16独立current Admin/App LOGIN执行实际平台ProductAssociationService与SupplierProductManagementService，双向竞争、引用拒改名/拒删及目录先删后商品free-text保存符合原合同；显式addon安装中断原子回滚、幂等、sole ACL/不可变性、owner撤权恢复/封存与旧8原生回归通过。fixture0，端口37135/5218停止，原生postmaster消失。

GUI使用现有Playwright/Chrome（Browser plugin not available），http://127.0.0.1:5218/admin/product/unitList，1365×960/375×900/320×900。原alias/title/menu、15条分页、50emoji历史名、历史负排序与非法rawSort不提交、名称/排序编辑、新15emoji创建丢ACK原回执恢复且不重复POST、占用删除404unknown/显式封存、只读、小屏真实横滚到操作后编辑共11图逐张检查；身份/非空/无框架overlay/控制台/截图/真实交互六项通过，0warning/pageerror，唯一ERR_FAILED为主动丢ACK。完整实际dist成员及hash在浏览器前后一致。

当前恢复源码快照7591份，SHA256 24f923dc90148db56de89c8b17584ddae07f4ad38a62dca63ae8699f09a6cec2；来源proof SHA256 d51dd1d86b7462d3d5a0978fa1f4c81e8c8902c97ecfb61a6f85609a8b3763c0，helper单独固定。API763调用/801变体，旧759调用对应797条展开记录逐对象保留。最终接受清单绑定当前源码、文档及全部构建产物，不冒称遗失的7200份原before已恢复。验收/tmp/cinashop-unit-author-recovery/accepted-validation-result.json。

环境切换令原/tmp验证日志、截图、完整7200份before清单及原最终进程不可访问。当前Unit proof/helper、Group proof/helper/doc与先前记录hash一致，41修改/17新增/1718冻结/33观察文件全部逐hash核对。没有重造丢失的原before，也不声称原临时收据仍可审计。本次从当前真实源码另建恢复快照，重新运行所有选测、类型、构建及GUI，以新收据支持本批验收。前驱来源JSON内的完整前后像及PHP全文仍可核验，原Group文档字节保持。

下一候选商品保障已只读准备57份完整来源（15 PHP/原素材、42当前TS/既有回归/文档），位于本地证据缓存的 `run/next-ensure-scout/`。原九列列表、四控件/单图片图库、独立状态与物理删除/全CSV和type5引用边界均已列明；旧成熟CRUD不重计。没有实现或执行此候选验证，准备不算迁移完成。

浏览器API为受控夹具；实际SQL/Hono/JWT与独立PG16 LOGIN另有执行证据。本轮原始恢复收据、日志与截图将在现有本地缓存 `.cache/migration-evidence/unit-author-recovery-20261026/` 保存一份校验副本，避免再次依赖临时目录；缓存不是新的运行或测试计数。

未执行生产addon安装、真实账号/R2联调、远端CI、commit/push/PR/merge/deploy。
