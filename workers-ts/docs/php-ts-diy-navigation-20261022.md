# DIY导航组件迁移（2026-10-22）

本批在独立Worker依赖修复提交 `129fea7b66a6ec46bb7feb8c5f837b6c55bc1ec2` 上继续 API-007，按实际PHP持久字段实现 `headerSerch`、`tabNav`、`menus`、`pictureCube`，贯通首页、微页面、真实分类及公开受管图片。PHP来源只作静态读取；完整迁移父项继续开放。

## 行为

- 搜索头保留三种作者布局、三种搜索样式、logo／标题链接／真实热词节奏，按当前实例实测高度占位；搜索打开原注册页，不将展示热词自动作为查询词。
- 顶部导航读取真实 `tabListConfig.list`，保留三种选择样式、每实例滚动定位和测量后的吸顶位置；typed微页／分类／首页0选择复用实际树范围、十条分页、503独立重试和原宿主页脚归属。
- 菜单保留3／4／5列、1..4行、固定／分页、图片／文字三种模式及完整作者列表。隐藏条目占原分页位置，后页高度按所有真实页测量且不低于配置基线，避免首个全隐藏页裁切后页；第100项保留且可导航。
- 图片魔方实现0..11十二种布局、自然比例与自定义有限矩形、间距和PHP圆角次序。自然0／1／2／10由内层图片固定高度、外层自动加实际边框；固定拼图／自定义保留显式矩形。加载、失败、重试和链接回调都经过当前owner／配置／epoch／active／期限保护。
- 三端共用纯配置与实例状态，回调捕获旧实例lease，配置／账号／会话／页面隐藏后不借用新实例。仅签名票据刷新保留菜单页码，真正作者变更重置；真实tabNav六字标题与homeComb四字标题分别保持。

## 媒体与容量

只处理 `headerSerch.logoConfig.url`、`menus.menuConfig.list[].img`、`pictureCube.picStyle.picList[].image` 和精确11或字符串11时的 `docPicList[].img`；链接、picker预览、邻接字段不签名。继续共用实际平台owner、raster、MIME、对象路径与期限规则，900秒能力只进入公开投影，Admin保存还原canonical引用。

导航独立20000槽位，原编辑／轮播2500槽位合同保留；先收集完整槽位，超限原子拒绝。每批owner检查不超过10000，HMAC每批不超过256；所有批成功后才提交投影字段，重复canonical素材共享一个新票据。实际257个 `AttachmentService.uploadImage` 上传单列setup收据，验证第二批成功和最终真实PNG；另以明确synthetic第257次签名故障验证无半份输出。

原Admin2MB／100000节点／64深度界限保留。紧凑200×100图片列表可实际Admin保存；带完整标签metadata的同规模列表超过100000节点仍拒绝，导入公开读取完整签名。22500混合容量策略样本含201组件，不宣称实际UI允许201组件。

## 验证

| 检查 | 实际结果 |
| --- | --- |
| UniApp完整工具链 | 2192/2192，新增独立Node用例205 |
| 前端最终六门禁 | strict类型、H5／MP／App构建、产物、运行时i18n通过 |
| 同批完整13门禁 | 分批通过；六个安全／依赖门禁采用字节相同输入的本批成功收据 |
| Worker 4.1.12回归 | 59文件／1079项，全通过；原完整unit／runtime两份strict类型重跑通过 |
| native PostgreSQL16 | 73/73，包含新增导航46与已有轮播27；真实257上传setup及清理通过 |
| 实际H5后台Browser | 内层1项通过／31检查点；50表、46序列，152条GET跟踪（105真实、47明确synthetic） |

新增独立用例270＝Node205＋Worker AST／runner18＋native46＋Browser1。31检查点组成一个Browser用例。未计入既有安全十项或重复运行。

最终Browser的1899份源与369份H5产物在用例内前后相同，当前逐SHA复核一致；新安装广回归留下的226份依赖指纹也与Browser结束后的当前安装相同。8次双schema头部配置保存＋关闭／开启2次明确记账；采用GET的业务SQL／R2／Queue写与provider调用均0。临时PG16.14真实status3、无postmaster.pid，fixture清理完成。

Browser外层exec返回143，正常launcher结果未写出，原因未知；不声称外层或runner进程exit0。内层真实Vitest日志记录1pass、1128.05秒，原始31阶段evidence／partial、四项cleanup及remaining0／stopped日志完整；由root和独立审查逐份复核并生成明确标注143的恢复收据，没有重跑或降低功能断言。安装226指纹来源是紧邻前置广回归，不伪造为丢失的launcher初始内存快照。

同批真实在线npm审计成功；原始报告的82个受影响依赖条目、28个直接advisory对象、27个不同URL与8条已审链分别保留，不当作82个独立漏洞。父轮播批次的网络失败收据独立保留，未借用旧绿灯。当前本地Node24.19.0／npm11.11.0，GitHub用Node24.14.1；新提交CI待GitHub实际结果。

重复候选、同一用例跨环境与31个Browser检查点不累计成新增测试。类型失败、SSR测试根props绑定错误、浮点断言候选保留原始失败收据；SSR边界测试修复真实root props，并明确其嵌套组件stub不替代实际Browser。独立前端审查发现NAV-R1，root再发现、独立审查确认NAV-R2；两项修复后重验。root独立复核后端并补要求跨HMAC批次的真实正例与故障原子性证明。

实际Browser候选保留两项产品负例及其修复映射，未下调原断言：

- NAV-R4：候选2在375内容区首次home检查发现菜单822的34个分页指示点被挤成约2.425px，原20rpx按该实际H5样式单位应为10.4px。PHP点容器通过 `acea-row` 继承 `flex-wrap:wrap`，TS遗漏；仅为 `DiyNavigationCanvas.vue` 的点容器补换行。点宽、高、颜色、数量和真实分页检查均保留。
- NAV-R5：候选3已采纳前六阶段，真实搜索点击却失败；目标中心y约31.19落在0..44px的原生H5标题栏之下。PHP首页和微页配置custom标题栏，而当前TS保留默认原生标题栏。仅为 `DiyNavigationWidget.vue` 的固定搜索头和固定tab增加H5条件CSS `translateY(var(--window-top,0px))`；内部headerTop堆叠、占位高度、脚本、模板及MP／App逻辑均保持。Browser增加实际原生标题栏高度和搜索／标题中心 `elementFromPoint` 命中检查，仍要求不force的真实点击。

2192项Node工具链成功输入与最终两个SFC的script／template逐字相同；后续只增加菜单点换行和H5窗口偏移CSS。旧收据保留为脚本／模板合同证明，不冒称两个完整SFC的SHA未变。最终六门禁（strict前端类型、H5／MP／App构建、产物检查、运行时i18n）重新通过；H5编译CSS存在窗口偏移，实际MP／App组件CSS中不存在该规则。六门禁所在外层批次随后因临时类型适配器缺少typeRoots而exit2，该失败保留，不能将外层伪称成功。

Worker原完整类型与回归收据单列保留；随后发现Worker仍锁Vitest4.1.11的真实CI问题，独立提交升级八包到4.1.12。最终安装重新执行原完整unit／runtime两份strict类型、59文件Worker回归及73项native；其结果以本节最终收据为准，不借用旧安装结果。该升级未改前端依赖或构建产物。

## 验收范围

Browser使用实际构建H5、createApp／JWT和独占PG16；正常每份schema恰好一个搜索头、一个tabNav，六种菜单与十二种魔方为允许重复的组件。多header／tabNav只在导入兼容／实例隔离测试，不能当作PHP正常编辑器配置。

正常Browser保存显式让搜索头、tab时间戳在前，正文titles时间戳820；PHP和TS都按时间戳排序，因此不能仅重排JSON数组伪称正常作者顺序。实际Admin持久化顺序逐schema断言。

桌面IAB采用375内容宽度，owned bridge在实际构建index响应中仅加入 `html{scrollbar-width:none!important}`，隐藏桌面原生滚动条；实际业务JS／CSS及磁盘构建HTML保持原字节，响应HTML的raw／served哈希和精确增补分别记录。该视口控制不改overflow或滚动根，实际window滚动／页面hook与吸顶均验收；不证明生产classic滚动条显隐、拖条、滚动锁或移动真机。之前强制html overflow-y造成body独立滚动、gutter单独未保持短页client宽等夹具失败全部保留，未增加body scroll补偿或模拟页面hooks。

错误页缩短会使真实滚动位置夹在94.4px；在failed检查点前用真实滚轮回到0，再执行独立重试，保留逐字widget比较。12分钟手动验收候选未完成31阶段而失败，导航专用操作窗改为30分钟、test31分钟、外层40分钟，其他任务时限及功能断言保持。

每个采用的真实导航／分类GET核对50表、46序列和R2／IMAGES／Queue前后；目录fixture准备、两次初始Admin保存、四轮双schema头部配置（8次保存）与站点关闭／恢复（2次）分别记账。真实分类701、子类751／752，13+2商品、十条分页、活动1701和owner22的商品601投影cart_num=4均由实际API读取。原首页page1／limit8推荐真实读取另列。

搜索只验注册路由及手动文本输入，不提交、不宣称商品结果／历史持久化或搜索GET只读。周边chrome、注册文章目的地列表、夹具缺表的热词chrome明确标synthetic；其成功不替代业务DTO。Node假时钟验证长时间续期，Browser验证真实Admin版本变更后的新票据。HTTP loopback内部HTTPS Request桥接不证明TLS，fixture Admin host不证明生产Admin身份／ACL；小程序／App编译不替代真机，IAB不支持触摸注入，不宣称手势滑动。没有生产／第三方provider／PHP执行／合并／部署。

按用户授权后台Browser验收，不逐页弹确认；当前实际连接IAB，不据此断言独立Chrome／Edge扩展在线。保留已恢复get_script及Admin／Supplier／UniApp loader。历史账本前缀及复选框保持，API-007父项、DATA-008、FE-003J／K及生产／真机／发布继续开放。

下一完整候选为pageFoot与全局navigation：实际五tab页面、双态图片、选中／浮动样式、显示开关、owner私有角标、canonical素材和小型真实Admin操作面。只读勘察23份PHP／38份TS与11缺口，尚未实施或验收；不把当前宿主页脚归属修复当作完整pageFoot迁移。

另记录一个独立后续边界：现有 `DiyMediaCarousel.vue` 的homeComb固定搜索头仍为H5 `top:0`，静态调用链表明它在默认原生标题栏下有同类偏移风险。本批NAV-R5只修导航Widget，没有改homeComb，也没有重新运行该族完整Browser30，不能把本批变更表述为所有DIY固定头已修复；该项需另行实现及完整该族验收。

## 可复核记录

[机器记录](../audit/php-ts-diy-navigation-20261022.json)保存实际用例名、PHP与TS来源SHA、构建／安装输入、失败候选、真实GET／配置账目和独立审查。实际暂存差异使用固定Gitleaks8.29.0扫描，扫描与提交差异哈希在发布收据中核对。该文档不预报尚未执行的GitHub检查结果。
