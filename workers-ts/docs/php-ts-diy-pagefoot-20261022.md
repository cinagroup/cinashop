# DIY页脚与全局底部导航迁移（2026-10-22）

本批从 `802a784fcfd2a9a90817f8e8df5aaa6d6c471dea`（6685个已跟踪文件）继续 API-007，实现实际 `pageFoot`、独立 `/navigation`、五个全局tab页面、私有购物车数量角标及小型Admin页脚编辑器。PHP仅静态读取。没有新增生产端点、DDL、ACL或依赖锁变更；保留已恢复的 `get_script` 和各端旧loader合同。完整迁移父项、生产配置与真机验收继续开放。

**实际隐藏IAB已完成全部29阶段，candidate7外层exit0，1716.346秒。** 最终源码、226份安装输入和H5／Admin双构建字节无漂移，独占fixture清理与PG停止均已确认。本文分别保留旧失败候选、最终补验和未执行范围；本批不代表完整迁移父项结束。

## 实际行为与来源

全局页脚由首页、分类、逛逛、购物车、我的五个实际Page分别接入 `useDiyFooterHost` 和 `DiyGlobalFooter`。Page的 `onShow` 执行真实读取，隐藏、卸载、账号或会话替换撤销旧资格；子组件不安装假Page生命周期。全局来源始终是 `/navigation`，首页 `diy_version/0` 仅用于站点存活确认，不替代导航来源，也不以版本未变化为理由省掉导航读取。

微页面使用原宿主配置的最后一个精确 `pageFoot`，保留其 `isHide` 旧语义并独立于正文200条显示上限；正文选择和嵌套页面继续剥离目标页脚。大写旁观组件不抢占微页的精确匹配。全局 `/navigation` 则保留服务端原有大小写不敏感的首个页脚选择，两者不合并为同一种来源策略。

实际作者字段为 `effectConfig`、`navConfig`、`navStyleConfig.tabVal`、`toneConfig`、`menuList[].name/link/imgList`、颜色、间距及圆角。支持原生／自定义切换、固定／浮动、图文／文字／图标三种样式；选中图为 `imgList[0]`，未选中图为 `[1]`。间距按PHP的 `val*2rpx`，四角顺序为0、1、3、2；浮动背景与固定背景分别读取真实字段。

五个原生tab的十份选中／未选中图片来自实际PHP静态素材，并以新来源绑定核对各自SHA。显示操作通过单个序列化native协调器执行：旧OS回调完成后，协调器按当前owner目标补偿；配置、actor、会话及modal变化不借用旧请求的资格。自定义页脚须等待真实 `hideTabBar` 成功且无pending／error才能展示和点击，失败提供显式重试；分类抽屉、SKU与购物车弹层共用同一modal仲裁。真实微页返回原生tab会使框架重新挂出原生栏，所以Page每次onShow同步撤销旧物理确认，Vue nextTick后再按当前owner重发一次物理同步；physical epoch拒收过渡前回调的确认，保持单个OS调用在途。隐藏／卸载只解除自身ticket的屏障，不复活旧页脚。

图片 `load/error/tap` 闭包捕获发起时的配置、owner、epoch、素材期限和当前可用资格；旧图片错误不能污染同位置的新图片。共享闭站总线撤销已加载首页／微页正文与页脚。非DIY页面重新读取成功时，只有相同站点epoch、owner及代际下的 `version0+navigation` 双成功才能清除旧闭站；旧成功不能覆盖较新的关闭状态。

## 后端公开媒体与入口

只对大小写不敏感的 `pageFoot.menuList[].imgList[0/1]` 实际数组位置规范化和公开签名。继续复用既有平台附件owner、raster、对象key、MIME与删除状态规则。private、merchant、user附件不会获得平台公开票据；链接、名称、preview、第三张图、数字键对象和外站形似asset的URL不取得本站附件权限。Admin原始JSON保存canonical引用，历史signed输入仅在这两个真实槽位还原，公开读取再做fresh owner校验和新票据投影。

页脚独立20000个字符串媒体槽，原ordinary2500和navigation20000预算保持。先完整收集，超限在任何投影修改、owner查询或HMAC前原子拒绝；owner查询每批最多10000，HMAC每批最多256，全部批次成功后才提交输出。重复canonical引用共享新能力。native证明包含完整42500混合槽，以及真实10000项、20000页脚图槽的Admin保存与读取；它不表示任意完整编辑器metadata负载都可保存。

`/navigation` 改用现有 `parseLegacyDiyJson` 的2MB UTF8入口（2000000字节），去掉旧1MB／2000条的额外截断。显式模板和默认来源仍使用自身原有predicate、降序id和回退顺序；仅原始空字符串或PHP raw `'0'` 触发fallback。损坏／超限的非空导入读取不返回半份页脚，也不借机改选fallback。响应为 `no-store`；此路由没有新增DIY站点中间件，前端独立协调站点关闭。

Admin既有2MB、100000节点、深度64保护不扩大。前端与结构化Admin菜单明确最多10000项，包含无图片项；超额拒绝而非截尾。PHP正常视觉编辑器添加上限为5项；历史导入超过5项保留全部，Admin按10项分页编辑，不宣称PHP原编辑器允许无限新增。

## 私有数量角标

`GET /cart/count` 新增严格显式 `numType=0/1`，可配 `scope=cart` 或缺省scope。`0` 是精确PHP数量总和，`1` 是同一谓词下的行数：仅 `uid/status=1/is_pay=0/is_new=0/is_del=0`，不额外过滤商品、type、活动、staff、store或tourist，也不清理购物车。重复或非法的已知scope／numType拒绝；缺省numType保留两种既有rowcount消费合同。响应为 `private, no-store`，最终聚合必须是非负安全整数。

真实fixture中uid11数量7、显式行数2，旧scoped行数3、旧unscoped行数4；uid22数量4，其余三种行数均1。这些差异用于防止把旧购物车行数误作新角标。游客前端显示0且不发强制鉴权的角标请求，不据此声称放开服务端鉴权。成功的真实购物车写事件使当前owner重新读取角标；迟到结果在隐藏、账号／会话替换后不采用。

## Admin页脚编辑器

只在现有 `DiseList.vue` 增加 `DiyFooterEditor.vue`，复用实际 `SeckillActivityImagePicker` 的附件目录、图库与上传机制，以及原 `dise.view/manage`、`attachment.view/manage` 权限。没有创建通用DIY builder或新授权入口。

可编辑显示模式、浮动、三种样式、主题／作者颜色、双图、内外间距、圆角、名称链接和菜单排序／删除；预览与实际 `/adminapi/dise/save` 保留其它组件、未知字段、第三张图、独立content和不可变元数据。表单、账号、JSON代际替换后，迟到图库／预览／保存回调不能写入新表单；同一保存忙碌期间不重复提交。

已发布行可由操作者显式读取实际公开 `get_diy/{id}` 作为signed预览，完整canonical页脚结构必须与当前Admin行一致。未发布、闭站、错误或失配不替换canonical值、不写JSON；公开读取成功不是Admin权限或发布授权。预览只说明当前菜单页外观，不证明正式路由、主题、safe-area或购物车业务。

## 已完成验证及各自范围

| 检查 | 实际结果和范围 |
| --- | --- |
| Worker后端首轮四文件 | 54/54：新增页脚业务35、原native准入5、已有PC9和公开目录5 |
| 新页脚native PG16 | 48/48；50表、46序列和资源完整快照；明确setup与GET零写分开 |
| 四文件native交叉回归 | 147/147＝页脚48＋导航46＋轮播27＋原编辑族26；页脚48不重复累计 |
| 早期后端strict | 原strict flags的新增测试／import闭包，97.802秒成功；不是两份完整类型检查 |
| Admin独立检查 | 17/17及原完整Admin strict通过；root后续Admin strict＋生产构建也通过 |
| 既有user-center收尾 | 完整43/43；请求fixture按真实URL区分，旧路由期待修正，不改生产行为 |
| UniApp首轮18文件 | 792项中786通过、6失败均在carousel-content兼容测试；原失败保留 |
| carousel完整文件复验 | 64/64；其它原通过文件由精确输入身份保留，不冒称一次792全绿执行 |
| 最终cart safe-area补验 | Uni strict、原cart10/10、H5／MP／App构建、产物和运行时i18n全部通过 |
| Worker完整类型 | 首轮完整unit及runtime两份strict均通过；readiness／根alias各次完整unit通过，最终物理修复后完整unit186.516秒通过，source／installed零漂移；runtime按既有实际运行输入身份保留，并非本轮重跑 |
| Worker广回归 | 62个实际文件、1136/1136、零pending／todo；最终cart模板和后置readiness守卫的范围另列 |
| 后置Browser桥守卫 | 完整runner36/36；含精确模式准入、真实hashchange／readyState／sameURL reload、精确cache清理与根alias正反语义，原负向守卫保留；完整unit187.012秒通过 |
| 最终native物理状态补验 | 页脚Node48（原43＋新增5）；footer／category／cart／user四完整文件120/120；4个消费AST文件50/50；Uni strict、H5／MP／App构建、产物及i18n全部通过，source零漂移 |
| 实际隐藏IAB Browser | 29/29检查点组成1个Vitest用例，内层通过、外层exit0；1716.346秒，73表68序列，source／installed／双产物无漂移，fixture清理及owned PG停止成功 |

首轮Worker62实际1127/1135、8失败，原始JSON／日志保留。修复当前Admin inventory、category共享native接线AST、导航runner可执行OR链及旧统计／manifest来源绑定后，完整unit与62文件1136项通过。历史审计不覆盖；新增精确inverse绑定重建App、PublicController及原manifest，十个native素材单独核对PHP来源。当前Admin API inventory仍是696调用点／732变体、732已注册可执行、unknown0；新增公开预览fetch在Admin私有路由inventory范围外，不能虚增授权或route数量。

最终cart模板只增加自定义页脚下的 `paddingBottom=20rpx`；没有自定义高度时保留 `calc(20rpx + env(safe-area-inset-bottom))`，避免safe-area被页脚与checkout重复占用。删除该单一表达式可逐字重建Worker1136检查时的cart源SHA，script和其它模板字节不变。其最终strict、cart10和三端构建／产物／i18n重跑，不把旧Worker1136称作最终整个SFC字节上的重跑；其实际H5分类弹层与checkout几何已由最终Browser验证；非零safe-area真机未验。

已验证的新增独立逻辑为186＝native48＋页脚unit35＋完整runner36＋Uni页脚48＋Admin17＋manifest来源1＋Browser1。Uni页脚48包含原43及本次物理状态修复新增5项；消费AST只在已有case内补3个mutant，没有新增独立case。29个Browser检查点仅计1个Vitest用例；旧Worker1136、focused120、消费AST50、既有user43／carousel64／cart10和重复native／广回归不再累计。

本地实际Node为24.19.0／npm11.11.0；截至首次提交的这些收据没有执行全量UniApp `test:toolchain` 或本轮完整安全／在线npm审计，也没有预报GitHub结果。早期后端scoped类型检查有一次外层143中断，明确不计成功，随后独占的新候选97.802秒通过。Admin两次初始失败与Worker原失败均保留原收据，不用当前绿灯覆盖。

## Browser桥、真实setup及候选

桥使用实际构建UniApp H5与Admin、真实 `createApp`、JWT、密码与role校验以及独占PG16。仅数据库会话接线指向测试库；初始本地认证会话是明确setup，不是登录UI验收。原native50表／46序列保持；为实际Admin、购物车和用户读取维护23张已有ORM依赖表，Browser完整动态范围为73表／68序列。每个API记录全表、全序列和R2／Queue／图片处理资源前后，不能把Browser写成仍仅50／46。

setup单列实际Admin／role、一次平台图片上传、真实SKU、既有cart的attrUnique，以及分类布局与两个子分类。分类布局真正来自唯一 `system_dise` 的 `category/type3/is_del0` 行，使用2／2 top-products；701下增加751／752真实平台节点。原601／611商品关系及所有cart数量和标志保留。分类setup完整snapshot仅允许新增这三行且序列、资源不变；真实API须返回configured布局、两个子类和cid701下精确601／611两商品，不能合成业务DTO。

仅与本批业务无关的site／share／广告／主题／Admin通知chrome明确标记synthetic；footer、素材、购物车、DIY、分类、Admin保存全部走真实API。场景配置、站点关开另记显式配置；真实业务写只允许实际Admin编辑row1的value／version／updateTime和一次实际cart9101数量3→4，其它请求须完整snapshot不变。购物车写后真实uid11角标应从7到8，uid22仍4。

实际29阶段包括五globaltab、微页最后footer超过200条、五份selected／unselected实际natural pixels、custom时原生栏隐藏、原生分类→首页实际点击、微页实际菜单返回root、四tab各自新version0＋navigation、category抽屉／购物车弹层、checkout尺寸、三样式／浮动、owner22／guest、真实Admin typed editor＋图库＋保存往返及闭站／重试／恢复。观察控制面不能替代应用实际点击。Browser不等待840秒自然续期；Node假时钟证明定时合同，Browser已验证实际新票据读取与真实图片natural dimensions；不把显式cache清理后的重读当作自然840秒等待。

实际owned入口为 `http://127.0.0.1:40779/`，ready明确给出 `url`。随机control前缀仅是HTTP API，不能当页面路径；未知静态路径继续拒绝。构建HTML响应仅附加明确的 `html{scrollbar-width:none!important}` 测试视口控制，raw／served HTML哈希分列，实际磁盘HTML和业务JS／CSS不变；不改overflow或滚动根，不证明生产classic scrollbar行为。截图仅采用root实际CUA回执，不预称本地截图文件。

已保留的实际候选：

- candidate1：错误把control前缀当页面，未采纳home；未知静态路径被正确拒绝。exit1、380.977秒，fixture与集群清理完成，源／安装／产物无漂移。
- candidate2：采纳home与category后，真实目录只有701、布局缺失且无“更多”按钮；categoryDrawer正式断言失败。exit1、1624.689秒，清理完成。随后只修owned类别setup，生产代码和断言未放宽。
- candidate3：真实采纳前10阶段到user；微页五图实际160×90、badge8及路由正确，但正式 `loaded=false` 失败。exit1、474.092秒，M3DCtC停止、fixture清理完成，源／安装／产物无漂移。不能把这些微页观察替代整轮成功。
- candidate4：采纳11阶段到micro；完整reload复用合法持久cache，`microFresh`要求的真实 `get_diy/2` 新读取没有发生。exit1、1048.259秒，清理成功且源／安装／产物无漂移；这是测试新票据场景的cache前提错误，随后只在桥的reload控制清理精确 `cinashop_diy_page_v1_` 键再真实reload，保留fresh API断言。
- candidate5：采纳12阶段到microFresh；真实微首页点击返回H5第一tab的精确 `#/` 根alias，原桥就绪判断不接受它。exit1、920.506秒，清理成功且零漂移。修桥仅接受owned `/__h5#/`，服务端仅把该精确hash映射 `/pages/index/index`，保留rawhref；非根、外站和其它路径仍拒绝。
- candidate6：采纳12阶段后，真实微页返回首页时自定义页脚和原生tabbar同时出现。exit1、545.486秒，AKk80f清理并停止、零漂移。这是实际产品缺陷：框架重新显示nativebar，协调器却复用旧hidden确认。修复Page onShow物理epoch／post-flush重同步及迟到回调资格，未放宽custom时native必须不可见的Browser断言。
- candidate7：先由root实际执行micro→微首页早期smoke确认native wrapper隐藏，再重新执行完整29正式阶段；全部通过，外层exit0、1716.346秒。原生分类→首页也采用真实点击；73表68序列和资源逐请求核对，kBSAER实际停止且remaining0。

candidate3暴露的是同一iframe的hash变化不会发出新onload，旧shell先置false后无法恢复。本次仅修桥：每次真实load清理旧监听，再给当前Window／Document绑定真实hashchange回调；就绪必须当前document、`readyState=complete`、同源且真实H5／Admin路由，观察时再次复核，服务端loaded=true断言保留。会话setup完成后将目标构成绝对URL；与真实frame当前URL完全相同则真实 `location.reload()`，否则赋值真实 `frame.src`，使首页22／guest能从新应用加载读取setup。没有无条件loaded=true、伪hash事件、应用内部方法或伪点击。原12项准入正反守卫保留，最终完整36项沿实际渲染shell的AST／纯语义跟踪事件、清理、route、readyState、实际sameURL reload、cache键边界、精确root alias和服务端断言；注释中的原代码不能补足断线。同一owned根alias与显式首页URL的会话bootstrap采用真实reload，保证owner22／guest读取新会话。

最终桥补验记录：cachefix完整unit189.966秒及完整runner30/30通过；根alias补验完整unit187.012秒及完整runner36/36通过，源／安装均零漂移。最终物理状态修复又执行完整Worker unit186.516秒、四文件Node120/120、四个消费AST文件50/50、Uni strict、三端构建／产物／i18n；这些是各自精确范围，不冒称重新执行62文件1136或全量Uni工具链。物理修复前新增actual SFC／Page生命周期回归也真实失败，保留原红灯；candidate6是独立真实H5负例。

最终Browser记录 `passed-browser29-current-source`、外层exit0，内层1文件／1用例通过，29检查点齐全；启动器2437份源、harness2428份源、226份安装输入、H5 382份和Admin274份构建字节前后相同。254条trace包含202个真实GET、50个逐条声明的synthetic chrome GET和2个真实POST；所有252个GET的73表68序列完整快照零变化，每条trace的R2／Queue／image资源也无变化。两个真实POST分别是cart9101数量3→4及Admin ID1一次typed保存；8条配置账目分为这两次业务写、4次显式场景Admin配置和站点关闭／打开2次，不能把这些写计为只读。

实际Admin保存将首页标签改为“保存首页”、顶部值9、作者色 `#663399`、selected图选择图库第二张；原始数据库只存canonical `/api/assets/3`，前台标签／颜色／图片真实生效。uid11角标7→8、uid22角标4，guest没有发出cart/count；90次图片观察均实际complete、natural size160×90。真实微页返回根alias仍保留rawhref，custom时native不可见；effect0的native分类／首页有5项真实原生栏并可点击。closed和closedRetry记录真实410010拒绝，随后开站新鲜页面恢复。

最终日志记录 `FINANCE_LOCAL_FIXTURES remaining=0` 和精确kBSAER停止；清理四标志均true，独立只读 `pg_ctl status` 退出3且无postmaster.pid。provider调用0、最终browserErrors空。root CUA启动console只有既有VueRouter弃用警告，实际fullpage截图由CUA emit，未声称本地截图路径；截图、额外smoke和关闭tab32属于root操作回执，本读者没有另跑GUI。

恢复阶段使用开站后新鲜页面，不声称同一closed实例原地恢复；closedRetry本身要求真实当前页点击。H5原生tabbar DOM是真实实现，MP／App只有编译构建，不替代物理OS／safe-area／小程序验收；loopback内部HTTPS Request不证明外部TLS或生产Admin身份。未执行生产写、第三方provider、PHP运行、合并、部署或发布。

## 本地可复核记录

- `/tmp/cinashop-diy-footer-doc-facts.json`：冻结时的67路径清单、合同、原收据SHA及已知后置范围；其统计时间早于最终桥36项及物理状态5项，按本节后续补验更新，不能偷换旧记录。
- `/tmp/cinashop-diy-footer-backend-handoff.json`：后端unit、native48／147、257真实上传setup、scoped strict及独占PG停止证据。
- `/tmp/cinashop-diy-footer-admin-handoff.json`：Admin17、strict、失败候选及编辑器边界；root后续构建在front候选另列。
- `/tmp/cinashop-footer-front-candidate1.json`、`candidate2.json`、`candidate3.json`：原792负例、carousel64／Admin／构建复验和最后cart safe-area补验的各自输入。
- `/tmp/cinashop-footer-worker-candidate1.json`、`candidate2.json`：原两完整类型、8个旧guard失败与修复后62文件1136项，不覆盖历史。
- `/tmp/cinashop-diy-footer-browser-candidate1-result.json`至`candidate6-result.json`及各自目录：原Browser失败、partial与清理；旧失败的wrapper completed_stages可能为空，已采纳阶段以各自原始partial记录为准。
- `/tmp/cinashop-diy-footer-cachefix-prebrowser5.json`、`/tmp/cinashop-diy-footer-aliasfix-prebrowser6.json`：最终桥各次完整unit与runner补验。
- `/tmp/cinashop-diy-footer-physical-final.json`、`/tmp/cinashop-diy-footer-physical-fullunit-final.json`、`/tmp/cinashop-diy-footer-physical-handoff.json`：真实Node负例、最终120／50及构建／完整unit，各步原始日志SHA和输入。
- `/tmp/cinashop-diy-footer-browser-candidate7-result.json`及同名目录：真实全29终态、完整evidence／cleanup／日志及双产物身份。
- `/tmp/cinashop-diy-footer-browser-passed-handoff.json`：终态独立只读核对、精确trace／配置／资源／清理统计和当前哈希绑定。
- `/tmp/cinashop-diy-footer-browser-category-setup-correction.json`、`/tmp/cinashop-diy-footer-browser-readiness-sameurl-correction.json`：夹具修复来源、当时SHA与历史检查边界；后续真实补验和终态另列，不改写原收据。

最终repo机器审计及三账本追加由root根据实际终态汇编；本文不替代实际暂存扫描、提交或线上CI结果。保留既有账本前缀及未完成父项；本批页脚闭合不等于全仓PHP→TS迁移完毕。

## 首次GitHub CI失败与完整UniApp复验

草稿PR #156首次提交 `91e6b8801f600010fbbcd1a162c6bdcc1c91c351` 的GitHub运行39826378280中，UniApp实际2258项为2254通过、4失败，零跳过。原始失败记录保留：三个既有社区测试把独立全局页脚的公开读取也算作社区业务I/O；失败不能改记为通过。

仅修改 `community-availability-runtime.test.cjs`、`community-main-feed-runtime.test.cjs`、`community-publish-entry-runtime.test.cjs`：对每条实际请求，例外精确限制为 `/api/diy/diy_version/0` 或 `/api/navigation` 且data为空对象；fresh guest只另外排除原本预期的精确 `/api/community/config`。其它社区、referral、账号、私有购物车和未知请求仍使原断言失败；未隐藏请求、减少用例或修改生产代码。既有r.calls只记录url／data，GET身份由被冻结的实际http.get调用链证明，不能把这三个断言描述为独立记录并检查HTTP method。

同一独占serial wrapper中，先执行三个完整文件98/98（40.389秒），再执行实际package脚本列出的全部89文件2258/2258（859.35秒）；使用Node24.19.0及 `--test-concurrency=1`，零失败、cancelled、skipped或todo。4480份源、226份安装输入、1851份构建产物的前后漂移均为空；相对最终Browser，仅这三个测试文件有差异，产品源、依赖和实际产物精确保留。本次没有重复Browser／构建／类型检查，也不增加独立用例，批次总数仍186。

可复核记录：`/tmp/cinashop-footer-ci-first-head-failure.json`、`/tmp/cinashop-footer-ci-community-final.json`、`/tmp/cinashop-footer-ci-community-handoff.json`。全量工具链日志SHA256为 `78bc7dcb6b425943f0af3c9f800090e2e831015344dad3fb07398353bae9184b`；三个完整文件日志SHA256为 `b05d2fe7ae4b2d21fc35e4787c3b89d740926132aceb96e9b08a100c8aa9cfe7`。当前补提交的线上CI须按推送后的精确head另查，本文不预报绿灯；首次CI失败及旧父CI成功分别保留。
