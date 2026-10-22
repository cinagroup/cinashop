# DIY轮播与组合首页迁移

本批从 `fde37c21ee540ee2764101ae1b389e1b332d6aaa` 继续API-007，处理swipers、swiperBg、homeComb、共享DiyMediaCarousel及首页／微页面的全部真实调用链。浏览器按用户授权在后台执行，不逐页弹出确认；只提交推送draft，不合并部署。整项PHP到TS迁移继续开放。

三族分别读取真实持久字段：旧swipers使用`info[1].title`，只对缺失／空值／已知“链接”提示兼容编辑器value，明确非法title不能借用其他字段；swiperBg使用`info[0].value`，homeComb使用`info[1].value`。保留全部有效历史轮播记录，不再把超过十／二十张的内容静默截断。旧轮播2500ms、自然高度加10、静态堆叠／轮播、圆点／条形及间距；背景轮播3000ms、实际宽高比、三布局、四指示器、半高背景、预览边距、位置／作者色／圆角；组合首页320rpx、3000ms、当前图片派生模糊背景、logo、热词节奏、搜索提示和滚动吸顶都有独立消费。Admin保存但旧PHP前台遗漏的分角圆角／背景图间距按明确编辑意图处理。

homeComb分类展开、选中微页和选中分类保持原地切换。微页复用既有schema版本／缓存／站点开放与owner authority，不抢原页面标题；选中body剥离homeComb、headerSerch和pageFoot。根首页保持外层原生页脚语义，微页面保留最初宿主页脚，切换微页／分类／首页0不收养目标页脚。该归属修复不代表pageFoot的全部样式已完成。正常PHP Admin只允许一个home_comb，与搜索／导航头互斥且置顶；两个导入homeComb仅用于既有TS多实例压力验收，不宣称编辑器可建立该配置。

分类使用真实树证明cid／sid／tid范围，选择首个子类，十条分页、切子类、失败单独重试、重复页拒绝和当前卡片scope的实际高度瀑布流均有归属保护；缺失分类不会扩为全库。活动跳转读取真实版本化活动ID与期限，保留既有详情权威，不在此自动加购。两个页面只在可见时消费onPageScroll和onReachBottom；隐藏／卸载／owner、token、session、配置变化都会撤销旧成功／失败／finally、图片回调、测量和用户动作。

后端只公开三族`swiperConfig.list[].img`和homeComb的`logoConfig.url`。模糊背景来自当前图片，分类文字／链接／作者色不会获得附件签名。沿用平台owner、raster、对象key、MIME及canonical保存规则；公开GET刷新900秒票据但不改schema／版本。有效媒体容量2500，正常200个homeComb×11槽位2200有实测，2501在保存／读取前完整拒绝，避免半份签名。前端在最早媒体期限前一分钟且最多840秒续期；同版本过期配置重读、离线不复用过期票据，已打开页面也续期。只有明确媒体槽位的票据变化从作者fingerprint剥离，真实图片ID、链接、顺序和配置变化仍清空旧选择。

本机功能、类型与构建验证通过：Worker57文件1061项与unit／runtime两份类型检查；native PG16两文件53项（新增27、原编辑族26）；UniApp13项门禁中12项本地检查通过，含工具链1987项、H5／微信小程序／App构建及产物、二维码、i18n和公共安全检查；在线npm审计三次网络超时，当前保持未通过。新增独立用例143＝Node108＋AST4＋native27＋Browser1＋runner3；Node已含在1987内，Browser30检查点属于一个用例，候选／重复执行不叠加。源在每次执行前后匹配；后续只改测试／CLI白名单的部分使用明确补验链，历史失败／修复候选单独留存。

真实H5后台Browser在375内容宽度完成30检查点：七实例全部图片自然加载、旧title与背景info0的不同链接、实际轮播、搜索编码输入、吸顶、展开分类、原地微页／首页0／分类、首读503与独立重试、13条分页、子类切换、owner22真实cart_num4、两页面保留宿主页脚、实际Admin schema更新、站点关闭／重试／重开。每次采用的轮播／分类GET比较真实createApp／JWT／owned PG16全部50表和46序列，SQL业务写0、R2／Queue／IMAGES／外部provider写0。fixture目录插入／sort及两次初始真实Admin-controller保存是单独setup；运行时两次schema保存和站点关闭／打开有四份精确配置变化。该Admin测试host证明实际parser／controller／事务，不替代生产Admin身份／ACL验收。

目的地文章列表、周边chrome及缺表的热词chrome明确合成；既有首页page1／limit8推荐走真实API并单列。搜索仅证明编码后的searchVal路由与输入，真实keyword-only产品请求保留缺少owned user_search的错误，不伪造成功产品、不声称搜索结果／历史持久化通过，也不把生产搜索GET称只读。HTTP loopback的内部HTTPS Request不证明TLS；媒体长时续期另有实际controller／adapter假时钟证明。PHP仅静态读取；MP／App编译及真实Node平台适配不替代真机、生产数据／身份／素材／支付／ACL或发布观察。

类型证据为原unit／runtime双全量通过，加最终变动runner／Browser模块的原严格配置补验和1460个runtime项目输入不变证明，不冒称重新执行双全量。

Browser验证真实自动轮播；当前IAB不支持触摸手势注入，手动滑动不计通过。控制台仅有框架既有的vue-router弃用警告，没有应用错误。

完整命令、执行用例、SHA、独立审查、逐请求／配置动作、失败候选、清理与下一族静态提案见[机器记录](../audit/php-ts-diy-carousel-20261022.json)。当前可用Browser连接为IAB；未从IAB推断独立Chrome／Edge扩展安装状态。保留已恢复get_script和Admin／Supplier／UniApp loader；本批未改DDL、ACL、生产路由或锁文件。API-007父项、DATA-008及FE-003J／K继续开放。下一完整候选为headerSerch／tabNav／menus／pictureCube，当前只有新鲜静态来源提案，尚未实施或验收。
