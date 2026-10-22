# DIY 商品列表与编辑内容迁移

本批从 `3dfa941de9bba75d8129cd0ee3c2209b05753ddc` 继续 API-007，完整处理 goodList、articleList、news、hotspot、follow、activeParty 六类组件。浏览器沿既有授权在后台执行，不再逐页弹出验收确认。提交保持 draft，精确提交的 GitHub CI 另行核实。

商品与文章提取到独立组件和读取状态，移除 Renderer 的全局 Promise.all 屏障。单块失败、重试、配置修改不阻塞或重读旁观实例；每个 continuation 校验 uid、token、sessionVersion、配置 fingerprint、generation、active 和 dispose，迟到成功、失败、finally 不能污染当前页面。商品四种真实范围保持固定 ID／品牌／分类／标签及 PHP 排序差异，空范围不扩成全库。预览上限100和配置为0都有明确语义。

商品保留六种布局的各自字段矩阵、真实品牌、标签、单位、销量、评分、活动边框与 SVIP 参考价；真实无边框 DTO 为 `activity_frame: []`。瀑布流在卡片自己的组件 scope 测量实际高度，再按较短列分配，避免小程序跨组件 selector 失效。版本化 diy_navigation 采用真实活动 ID／ISO 截止时间和预售优先级。显式普通商品按钮复用成熟 CategorySkuSelection／useCategoryPurchase 和真实 SKU 加购；活动、预售与定制商品仍由各自详情权威处理。

文章三种布局保留实际分类、数量、图片数组、字符串 visit、整数 likes、时间、checkbox、颜色与圆角次序；完整 DTO 校验后才采用。列表不会自动访问会增加 visit 的详情 GET 或点赞接口。文章卡片使用规范文章 ID，不使用旧 URL 字段猜跳转。

news 保留真实 chiild 数据、show、两种样式和滚动配置。水平滚动只消费第一条可见资讯，竖向轮播使用2500ms；More 使用安全配置入口，补齐 PHP 模板遗漏的箭头 handler 和编辑器 textConfig 意图。hotspot 在图片真实 natural width／height 就绪后，按750设计画布换算百分比；非法起点丢弃，溢出的宽高裁切，不移动或扩大命中区。加载失败、owner／配置变更、隐藏、卸载均撤下命中区，重试创建新图片实例。

follow 区分组件二维码与站点关注海报；打开弹层和直接预览不调用 `/wechat/follow`。只有显式海报按钮才读取真实海报接口，其 GET 允许按既有合同生成一个 R2 缓存对象，单独计入资源动作。每个次级 await 前后重核归属，旧响应不再开始文件下载，临时文件恰好释放一次，原生相册操作保持 busy 到 complete，迟到回调不改新弹层。H5 采用实际图片预览／长按；MP 保留 official-account 与显式相册入口。activeParty 按 PHP Admin 持久预览的真实四张卡、10／8／4／20字限制、徽标、链接与间距渲染；PHP UniApp 没有该运行分支，故只称兼容编辑意图。没有 toneConfig 时保留作者色，明确主题配置仍按主题合同。

后台只在明确媒体槽位采用现有平台附件 owner／raster／对象 key／MIME 策略：news 图片、hotspot 底图、follow 头像和二维码、activeParty 前四张图片。保存时规范化本地历史签名，公开输出刷新900秒签名；数据库配置和版本不会被 GET 改写。私有、商户、用户、删除、错误模块／关系的附件不获公开签名；链接、Admin 预览材料、第五张活动图与外部站点路径不会被当作这些公开槽位。小程序／App 的明确本地 `/api/assets/N?...` 显示地址通过 API_BASE 补齐请求域名，H5 同源、static 和外部 URL 保持各自语义；依据 [uni-app 官方路径规则](https://uniapp.dcloud.net.cn/tutorial/page-path.html)，包根路径不能当作网络图片地址。商品主图、边框、标签、文章封面和四类编辑媒体都有三平台真实适配器回归。前端缓存最多复用840秒并留一分钟票据余量；同版本但过期的 schema 重读，离线不继续使用旧签名。已打开页面也有受完整 owner／active／generation 保护的续期计时器，隐藏或卸载取消；编辑组件在动作前再次检查实际期限。

最终本机门禁通过：Worker 56文件1,054项，Worker unit／runtime两份类型检查；native PG16四文件86项；UniApp完整13步含工具链1,879项、三端构建与产物／自动化二维码／i18n检查；实际H5后台Browser 21阶段。新增独立用例188，集中于三份Node运行时136、AST 8、主题AST 1、runner 3、native 26、Browser 1及依赖安全13项；同一用例的候选／重复环境运行不累计。浏览器逐GET比较50表／46序列，业务SQL写0；两个真实Admin API schema保存和两次站点fixture配置有精确变化收据，显式海报只允许新增一个R2缓存对象。构建产物与源在验收期间保持一致。

完整命令、实际用例清单、源 SHA、失败候选、逐请求与配置／资源动作收据、清理结果及下一切片提案见[机器记录](../audit/php-ts-diy-editorial-20261022.json)。PHP 仅静态读取；H5 为实际构建与真实 createApp／JWT／临时 PG16，周边 chrome 和目的地列表有明确合成边界。HTTP loopback使用HTTPS内部Request，关注海报图片仅将已验证归属的完整path／query映射回本地；不证明TLS。既有首页page=1／limit=8商品推荐也走真实API并单独标记，关闭阶段断言禁止编辑组件读取，不宣称既有推荐完全不读；otherOwner阶段核对商品请求真实token22及商品601的cart_num=4。IMAGES 绑定返回固定 JPEG，只证明真实 SQL／R2／签名与显式生成路径，不证明 Cloudflare 图像合成或外部服务。MP／App 构建和 Node 平台适配测试不替代真机。

保留已恢复的 get_script 与 Admin／Supplier／UniApp loader，未改路由、DDL、ACL 或生产配置。本轮验证发现新公开的依赖门禁阻断，四个普通Web前端最小升级官方Vite 6.4.5，UniApp保留DCloud要求的5.4.21并增加精确、可逆补丁，Kefu测试工具升级4.1.12；旧问题实际复现、官方来源／SRI及新版本门禁见[依赖增量说明](../../view/common/dependency-security-20261022.md)。API-007 父项、DATA-008、FE-003J／K及生产身份／素材／支付／发布观察继续开放。本批只提交、推送 draft，不合并或部署。下一完整切片为 swipers／swiperBg／homeComb 与共享 DiyMediaCarousel 的全部真实调用链；该部分只有新鲜静态来源提案，不把局部 helper 差异算作已完成整族。
