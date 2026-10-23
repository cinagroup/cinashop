# PHP → TypeScript：完整导航作者控件（2026-10-23）

本批在 `eb1fc26beb4affd9eec5b88b7aa51c3caf0dab1c` 上补齐 Admin 的 `headerSerch`、`tabNav`、`menus`、`pictureCube` 作者控件。PHP 来源固定为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，仅读 immutable Git blob，没有执行 PHP。新审计记录31个 PHP 源 blob/SHA、65处合同锚、完整默认值和逐字段合同；初次 consumer 精读在8bbee，实际本批基线为后续独立 Uni advisory 修正后的eb1fc。

**本批完整导航作者控件已通过本地验收。** Admin185项及完整构建、新原生50项、定向审计62项、纯Worker1712项实际child0（原collectorouter97保留）、旧原生12文件327项均有真实证据。candidate4隐藏Browser以实际outer0完成25检查点和三次真实GUI保存，新定义187项全部通过。该轮仅重试Browser，精确复用candidate2的fresh author-options8及完整unit/runtime strict三个actual/validated0结果；前三轮Browser原outer1仍保留。最终保护、staged secret gate、提交/推送和新head CI由根任务另核，整体迁移goal仍开放；没有合并或部署。

## 作者行为与数据保留

| 组件 | 完整作者范围 |
| --- | --- |
| headerSerch | 三种logo/标题/纯搜索布局，三个纯搜索分支；真实图库、标题链接、提示文字、完整可见热词选择和增删移动、原时长字段、色调与条件颜色、背景、间距和圆角。保留时长持久化，说明现有消费者仍使用3000ms/1000ms节奏。 |
| tabNav | 三种装饰布局、吸顶、完整条目列表、typed微页及分类id/name、条目顺序、当前与非当前对象保留；各条件颜色、双背景、间距与圆角。普通新增遵守header/tab单例及homeComb互斥，导入重复实例不被隐式删除。 |
| menus | 图文/纯图/纯文字，3/4/5列、1至4行、固定或分页，所有导入条目、原槽位隐藏状态、真实图库和完整链接、图片与背景四角、条件分页指示器、色调、双背景与间距。 |
| pictureCube | 全十二布局0..11、明确固定布局裁剪按钮、自定义375逻辑像素画布及4×4绘制格、分数坐标、矩形增删与选择；picList和docPicList同索引图片/链接双槽与旧选中桥同步，真实图库、typed链接、图片间距/圆角和组件间距。 |

完整四族 PHP literal defaults 与 Admin、Worker fixture 已静态逐值相等；新魔方像 PHP mounted 一样初始化两个槽位，导入时不执行整块默认值合并。通用显示、完整列表、已存在未知属性和未选择字段不会因为选中、渲染或切换样式而改写。正文移动按真实 timestamp 和 Uni 的33个渲染名减独立footer后的32个正文名处理；unsupported/footer邻居保持原样，顶部插入也忽略这些独立邻居。

普通新增上限为热词20、tab/menu各100、自定义魔方16个backing槽；这些约束与导入/保存容量分开。重复、超限列表、超过消费者前200原始组件的导入、合法微小几何、空白/指数/分数数值字符串、numConfig0/101、true四角及隐藏条件分支在无关编辑中保留。现有2MiB UTF-8、100000节点、深度64和独立导航媒体20000预算仍适用。JSON可由现有编辑器重排空白；未编辑值按深度相等核验，独立content按字节相等核验，不虚称整份value原始格式完全不变。

## 五个新读取资源与权限

`hot-words`、`link-categories`、`link-targets`、`tab-categories`、`tab-targets` 同时注册在 `/adminapi/dise/author-options/` 与 `/api/admin/dise/author-options/`，共十个GET注册。热词返回全部平台可见id/name，真实种子25条；公开消费者20条限制不截断作者目录。通用选择器复用原FAB全部13类、分页/搜索、owner投影及媒体可读策略。tab仅允许微页和商品分类：微页在count/order/limit前要求is_diy=1，分类走真实可见祖先树，返回正Int32的typed id/name。

新增只读虚拟权限 `dise.author_selection_view`，由 `dise.manage` 推导，不可持久化或委派。`dise.view`、FAB/product/attachment等相邻权限不会获得该范围；该namespace只允许五个精确GET/HEAD，未知子路径与写方法拒绝。原FAB general special仍保留非DIY专题，原产品/FAB/附件策略未放宽。没有生产SQL DDL、数据库GRANT/REVOKE/NOLOGIN、事务锁或deadline策略、依赖与锁文件变更；仅独占测试库动态创建真实ORM表。

当前API报告696callSites/732variants增至699/737，全部registered/executable，unresolved0。1655旧路由记录只平移行号，另有已绑定源SHA和3个旧call行号更新；新增十路由、五call和一个API源。旧完整报告以SHA `920ed25edd6321c32da0a5599fa370cbfda6a0204167e58977e3b1032f023f23` 逐字归档。三处精确source inverse先还原eb1fc字节，再进入原历史链；旧负例和历史hash保留，新增20个source-binding负例/合同测试。新当前报告可从旧对象加明确delta完整重构。

## 验证后的 EOF 空白补充

完整验收后，root首次stage Python outer以exit1停止，其实际`git diff --cached --check`子进程以exit2指出`DiyAuthorLinkPicker.vue:81`唯一额外EOF空行；当时secret scan尚未执行。root仅删除最后`</style>`及其正常LF之后多余的一个0x0A：14138→14137字节，validated SHA `150216d60dcb471f18dfa55f2b4f2a3f45de30ebcd4ea569ff567a080adfceb0`→current SHA `ec6f3d9da2d5e4f3c57569b9fe8374ff72cdf724623c63d98f8d388cccf57d8c`。

reviewer在修改前已保存实际原字节；独立验证原文件严格等于新文件加一个LF，template/script/style完整块逐字相同。重新枚举6097源路径未变，仅该文件这一字节差异，其余6096源逐字等同。因此这里保留全部原始验证区间零漂移/actualpass证据，但**不再声称当前6097源与验收快照全部相等**。这是明确的验证后空白修正，按精确字节inverse复用原验收，不宣称又跑Browser/strict或新增测试；没有新依赖或产物变化。`/tmp/cinashop-navigation-author-picker-cosmetic-EOF-review.json`与current-source manifest记录该边界；最终实际patch/保护/secret gate须在补充后的文档冻结后重新执行。

## 已完成的本地证据

| 验证 | 实际终态与边界 |
| --- | --- |
| Admin完整作者回归与构建 | 185/185、零skip；旧115=17footer+33presentation+31customer+34page-settings，新70=58实际compiled-SFC/Vue+12 installed ElInputNumber SSR；完整vue-tsc/Vite exit0。857源输入和31521定义依赖闭包字节前后零漂移。 |
| 新navigation原生 | 50/50、零skip，两个actual current_schema配置各25项；每配置76表/71序列、71次完成GET，共142GET。所有GET全表/全部序列及KV/R2/queue/IMAGES写入状态精确不变。 |
| 原生保存保护 | 两配置各23个去重完整快照、35条mutation记录；其中包含显式导入setup、成功与拒绝，不能说35次GUI业务保存。成功POST仅目标value/version/update_time变化，独立content/meta/邻居/其他行和序列保持。owner变化、20000/20001媒体预算、UTF-8容量/深度/节点及各12布局都实际覆盖。 |
| 新旧source审计 | 四完整文件62/62，旧42+新20，零skip/pending/todo；完整JSON与原日志逐项通过，源和31521依赖闭包零漂移。 |
| 完整纯Worker | 精确82文件、1712/1712、零fail/skip，Vitest实际child0。原outer97保留：collector误写1713，正确为1697−移出完整FABpermission5+新增binding20=1712。独立逐named-case、verbose/JSON、6096源/31521依赖及driver当前字节复核通过；原outer未改写0，原outer没有执行后续native。 |
| 完整旧原生回归 | 12精确文件327/327、零skip；旧9文件315+FAB PG4+HTTP3+完整permission5。实际runner与outer均0，6096源/31521依赖/driver零漂移，8份原始family setup/read证明逐SHA匹配，remaining0且独立复查pg_ctl3/noPID。 |
| 当前fresh author-options与双strict | candidate2两完整native文件各4项、共8/8、actual/validated0（31.09s），remaining0及pg_ctl3/noPID；完整unit strict0（161.62s）、runtime strict0（95.18s）。同一完整outer后续Browser失败，四child为0/0/0/1，原outer1保留；Browser-only候选3/4明确复用前三步，不重算新测试。6097源/31521依赖及5driver前后零漂移。 |
| 隐藏真实Browser | candidate4实际outer/child0，25/25检查点、1Browser定义通过；159真实GET与55外壳syntheticGET分列，三次GUI POST、0装修JSON textarea编辑、76表/71序列/4完整快照。658产物及6097源/31521依赖闭包保持；0error、3既有弃用warn。 |
| 早期真实后端 | 两完整strict0，七文件36/36=新增author20+旧FAB16，真实app/Admin不同LOGIN与原策略已验证；5153源/7610安装与工具字节零漂移。当前fresh8引用candidate2中真实新child0、两完整文件各4项，不能用失败夹具outer中的8pass替代。 |

新原生50轮仅执行native，不声称它也在最终种子/audit源上重新跑完整strict。实际Node v24.19.0、npm11.11.0、PostgreSQL16.14。新原生5164源/7610安装与工具字节前后零漂移，remaining0；独立pg_ctl status3、无postmaster.pid。完整旧native12本轮真实327/327=旧9文件315+FABcatalog PG4+HTTP3+permission5，逐文件5/4/3已按原始named日志核对；outer0、全部源/依赖/driver无漂移。原收据source_scope文字沿用了media-reference叶名，保留原文；实际driver明确只排除本批navigation新result leaf，docs不在消费清单。原presentation收据存每GET状态hash及最终全快照，源中全SQL/序列/资源断言不变；不冒称其原始收据另存每GET完整快照。

新增定义总187，机器审计逐一列出唯一(file,name)：author20+navigation native50+runner26+source-binding20+Admin70+Browser1。当前187个定义均已有实际通过，Browser1由candidate4的25检查点/3保存终态提供证据。旧用例、候选重跑、同一Browser的25检查点和随后fresh8不重复累计。

## 失败与独立审查

原失败日志均保留。早期Admin runtime为4pass/46fail，loader不能执行compiled-SFC的non-null语法；完整Admin候选1旧footer14pass/3fail，loader误将新增.vue导入解析为.vue.ts。候选2旧115全过而新70为68pass/2fail，后续将mock v-model更新按实际tick传播，并在child真实reactive props即时撤权与卸载后验证lease；最终候选3才记185通过。

新Worker/native候选1完整unit strict2，误用不存在的f.privateImage；修成实际f.image。候选2完整unit/runtime均0，native child1，34pass和50skip；新夹具私有条码20字符超过真实varchar15，两个schema的beforeAll均失败。只把新种子 `AUTHOR-CATALOG-84031` 改为 `AUTHOR84031`，不改schema/生产逻辑/旧assert。修后真实50/50另有新收据。154个静态值、17个动态表达式的ORM列审查及原失败证据保留。

首次广回归1683pass/11fail/3skip，11个旧源指纹需要明确新source increment，3个FAB SQL定义须放原生；后续保留全部历史hash/负例并加精确inverse。第二次广回归实际1712全过，但collector1713预期导致outer97；只读恢复接受已完成child，不重写outer或冒称未执行native。focused首次仅guard把当前新console当旧receipt，零测试执行；修为精确排除当前console并用shell noclobber保护旧文件，第二轮才记62全过。

独立Frontend reviewer没有编写root的production Vue源或主runtime；其编写后端、新夹具和独立SSR文件的身份也在审计声明。九项发现均在最终绑定源码修正：明确固定魔方trim、导入合法数值不被真实number控件即时规范化、picker关闭/epoch/kind失效、正文及顶部顺序排除footer/unsupported、Number/true-radius与consumer一致、自定义坐标统一px、居中搜索/圆圈预览、preview lease与媒体/timer/unmount guards。静态结论不替代真实Browser。

installed ElementPlus SSR通过真实compiled SFC捕获的控件props和实际parent handler，负例确实证明旧min.001会emit，合法tiny/字符串/num0/101/true-radius不emit且JSON不变。SSR只证明setup/immediate watcher，不宣称客户端mounted、blur或wheel；客户端选中导入不自动改写另由candidate4的microNoop及无关字段真实保存验收。


隐藏Browser的三个真实失败保持原收据和各自outer1：candidate1仅过admin，切换iframe/session时实际Node stream aborted，0次业务保存；当时随后CSS预载失败不足以证明产物缺失。修复仅涉及本批新Browser harness和新增transport helper：只在真实读取处生成私有且绑定同一request的abort标记，业务/断言异常即使断连仍失败，响应断连仅跳过交付。完整25checkpoint、GET与POST保护断言按精确inverse保持。真实Node IncomingMessage/ServerResponse/Socket诊断8/8通过，最初锁文件readonly导致0测试的日志也保留；这8项诊断不新增迁移定义，总数仍187。

candidate2仅过admin，root在浏览tab目标后留在不含图库按钮的tabNav组件，立即提交minimal；五个真实最小作者GET均200，但imageButtons.length=0正确触发断言。0次GUI保存，属于root操作次序错误；没有因此改源或断言。该轮fresh native8与两完整strict是上述当前实际证据。

candidate3已过13阶段，包括真实rootSaved一次业务保存和rootH5；该POST只允许目标system_dise.1的value/version/update_time变化。menuSecond失败时第二页left43.884914/right419.084927，两个page宽仍375.200012、文档scrollWidth375。installed Uni原生swiper的500ms二次位移模型精确对应约329ms中间帧；后来真实CUA只读最终DOM为page1 left0/right375.200012、page0 right0，确认稳定布局满足原376px边界。这是失败诊断，不将原checkpoint或outer1改为通过。前3轮均source/installed/driver零漂移、658产物不变、finally fixture cleanup完成，独占PG均pg_ctl3且无postmaster.pid。

candidate4源码和所有断言冻结；新的Browser-only driver只增加candidate3原outer1/零漂移/当前输入等同守卫，launcher只替实际driver路径，candidate2前三步actual/validated0、原driver/log SHA、6097源/31521依赖final==newbefore和原25/3POST/全GET/cleanup守卫保持。该轮先正常等待cinatoken共享锁，取得锁后真实Browser执行725.63s、Vitest1文件/1定义通过，outer0。root将dotclick与checkpoint拆为两次工具调用，并实际读取内层page1稳定几何后提交原断言；最终menuSecond left0/right375.200012。没有改生产布局或放宽376px边界。

旧验证的复用边界按逐SHA证据说明：在EOF补充前的终态复核中，1712纯Worker、327旧native、62focused原6096源与当时6097源只有新Browser harness修改和transport helper新增，所消费的production/frontend/test/helper/runner均未变；native50相对其5164源有同样两项差异。EOF补充后当前源另有picker末尾一LF差异，template/script/style块仍逐字相同，不能继续把旧两项差异清单当作补充后全部差异。Admin857与Uni/common691输入及31521安装依赖闭包保持，382H5+276Admin共658真实产物按后续Browser清单相同。不能把这些分scope相同说成旧完整source snapshot全等，也不能抹掉原1712 collectorouter97、旧Uni原outer1及initial full snapshot缺口。完整复用review与本次对candidate2全部6097/31521已记录路径逐字再核在机器审计列出；candidate4取得锁后真实枚举及终态独立复查确认当时完整路径集合和字节相同；后续当前输入另以一字节EOF补充限定，不能把历史相等外推为补充后的全源相等。

## 隐藏Browser实际通过

candidate4在真实built Admin/H5、createApp/ORM/owned PG16中完成25个checkpoint：五个真实GET资源、完整13类链接、25热词、真实图库、typed微页/分类、最小作者/只读权限、关闭与late图库失效、菜单第二页和十二种Admin魔方预览。所有checkpoint累计装修JSON textarea编辑0、JS/console error0。

恰三次真实GUI保存：root四族/fixed1明确trim至两图；root custom11分数画布和媒体/链接双槽；micro选中导入tinyw.0005、数值字符串、num0/101/true-radius不自动改写，随后仅修改无关菜单标题。每次真实POST后均有匿名get_diy与实际H5消费。三次全量快照逐值重建确认仅目标system_dise的value/version/update_time变化；独立content、全部metadata/邻居、其他行及全部序列保持。

动态库存为76表、71序列，共4份去重完整快照，按实际stableDiyState函数独立复算每个SHA。159次真实GET=48次真实只读预检+111次真实GUI GET；另有55次明确synthetic的branding/share/advert/theme/new_push外壳GET，不能混作真实业务读取。全部GET的完整SQL/序列快照及KV/R2/queue/IMAGES写入资源前后精确不变，三次POST资源也零写。绝对计数中的4次R2put和40次KVput来自setup/cache warm，与测量阶段分列。

真实Browser本轮只保存和消费fixed1/custom11/micro11；十二种布局在Admin实际预览，全部十二H5合同另由runtime/native覆盖，不能称本轮十二H5布局逐一保存。三张root/custom/micro H5截图已分别实际查看；H5 document宽与scrollWidth均375。控制台保留3条既有vue-router import-path弃用warn、0error，不称warning0。

在candidate4终态独立复核时，candidate2 actual fresh8/unit/runtime的完整6097源/31521安装after与candidate4 before/after/当时current重新枚举完全相等；随后发生上文明确的一字节EOF补充，当前全6097源不再完全相等。658真实产物=382H5+276Admin的路径/大小/SHA在该验证区间与终态复查相同，五driver及原logs/receipts逐SHA复核。实际finally server/database/timer/fetch/FixedLengthStream清理键均true，remaining0；独占PGsCk3HU独立再次pg_ctl3、无postmaster.pid，owned runner与launcher PID均已退出。不是重跑新app源或strict，不重复累计定义。

Browser使用独占maintenance SQL DI；生产app/Admin不同LOGIN ACL另由native证明。late图库为真实HTTP完成后暂缓、子/父dialog关闭后释放，不把取消宣称为abort-ignoring应用回调。外层observer只导航真实session、记录可信事件和DOM、门控transport，不调用业务方法、不修改装修JSON、不dispatch合成业务事件、不造成功DTO。浏览器后台执行，无逐页确认；不声称独立Chrome/Edge扩展、MP/App真机或生产部署通过。

初步保护证明6784旧tracked中6770逐字不变、14解释变更、零删除/mode/staged变化；其他1380历史Worker审计、201SQL、576migration/model/schema/grant源、6锁文件及root3旧正文/checkbox/JSON保持原值。此证明发生在本新doc/audit及root三账本append之前，不能当作最终保护。root已实际append三账本，旧正文/checkbox/JSON值的最终检查将在文档冻结后的外部gate执行。用户选择的 `/api/get_script` 恢复合同、共享loader和Admin/Supplier/UniApp入口保留。其它迁移父项仍开放，未合并、未部署。

父草稿PR160精确eb1fc head的 [Actions40005943304](https://github.com/cinagroup/cinashop/actions/runs/40005943304) 已通过GitHub实际REST run和完整11项job核实为completed/success（updated2026-10-23T20:24:05Z）；仍open/draft、未merge。此为父head结果，不代表本新导航分支推送后的CI。candidate2、candidate3原Browser/outer1均保留；candidate4真实Browserouter0及其验证区间完整输入等同链已独立核验；后续一字节EOF差异由独立补充明确记录。此本地结果不代替新分支commit推送后的精确head CI。

机器证据：[php-ts-diy-navigation-author-20261023.json](../audit/php-ts-diy-navigation-author-20261023.json)。最终独立执行复核在 `/tmp/cinashop-navigation-author-candidate4-terminal-independent-review.json`，全快照复算另有独立记录。

外部最终gate仍待文档冻结后真实执行：`/tmp/cinashop-navigation-author-final-protection-review.json`（完整manifest为同前缀`final-protection-manifest.json`）与 `/tmp/cinashop-navigation-author-final-secret-scan.json`。这里仅给expected receipt路径，不预填通过，也不嵌入会与本audit/doc输入形成自循环的最终proof SHA。root随后负责staged patch检查、commit/push及新head Actions；本批本地验收通过不关闭整体迁移父项。
