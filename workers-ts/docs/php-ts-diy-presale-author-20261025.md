# PHP→TS DIY 预售作者迁移（2026-10-25）

本批实施 `presale` 完整作者、匿名公开预售商品预览、四种实际公开布局及三个精确作者图片槽。完整迁移目标仍未完成；`combination / bargain / seckill / liveBroadcast` 四类商业作者及总账其它开放项继续推进。本批没有扩大预售购买、订单、商品管理权限或数据库结构。

## 固定权威与完整数据

PHP固定参照 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`；旧工作树与历史绑定不以Git HEAD重建。

| 原件 | 已核定范围 | SHA256 |
| --- | --- | --- |
| `view/admin/src/components/mobilePage/home_presale.vue` | 193–656完整48键默认，293–311原checkbox编号 | `235cc05ffac1136e2424420943ad1206a2597d7c878f11f3916ed07c9c74ba13` |
| `view/admin/src/components/mobileConfig/c_presale.vue` | 实际作者字段及内容/样式组合 | `c55aedd046e1bd87f0c2b4bfa32c52832566f81695ea9029eaf84933226a389b` |
| `view/uniapp/pages/index/components/presale.vue` | 1–143模板、175–322计算、327–347匿名列表/导航、352–391CSS | `7b03688702a51fbd51815528505cbf75317fd37a7283434241d14793f5410c5c` |
| `view/uniapp/components/BaseMoney.vue` | 固定2小数、整数千分位、￥及三段字号/字重 | `152d18c871850d7a98b1bd5fbb0b31167cc2653d9e71d4d8cfaa31ad070dcef9` |
| `view/uniapp/static/css/unocss.css` | 真正grid列数、gap、字重及单位 | `02476cc8672acc825838b249bc1b0e7265d8cfe7954cb59a4b78aa72e5cfd523` |
| `view/uniapp/App.vue` | 全局view border-box | `c8ac053899436bc7ece40b5e72896256316e8074f4bfeead434f83283906be6e` |

另读取并封存 `base.css` 的line1/line2和 `easy-loadimage.vue` 的默认aspectFill，不把仅归档等同于已审阅全部购买流程。新建仅将timestamp表达式变排序值、三处明确图片表达式映射静态URL，其余48键包括分区、name/default/list/color/圆角metadata完整保留。导入不合默认、不截断未知或非当前模式资料，不自动修复数字的空白、指数、0或微小值。

普通新数量为1–100，当前TS消费者仍floor/clamp10000后min10；固定PHP缺失config/app.js，不声称10/100是已证明的PHP LIMIT。有效数量0不发请求。

## 原公开行为与实现

| 布局 | 实际公开条件和几何 |
| --- | --- |
| 0单列 | 240×240rpx图、两行名称、商品间距32rpx。整个68rpx价格/状态条受presaleConfig控制，checkbox2不控制其中价格；只此布局有状态与原闪电装饰。 |
| 1两列 | 图高324rpx、gap22rpx、两行名称。预售价读取checkbox2；原价始终显示；144×56rpx“去预定”仅按钮显示时出现。 |
| 2三列 | 图高212rpx、gap18rpx、单行名称。预售价读取checkbox2、原价读取checkbox3；无预售按钮。 |
| 3横滑 | 图224×224rpx、每项左间距20rpx、名称宽222rpx且单行。预售价读取checkbox2、原价读取checkbox3；无预售按钮。 |

原作者checkbox是0名称/1预售价格/2划线价，公开却读取0/2/3。完整默认仍 `[0,1,2]`，UI操作不把它重写成0/2/3；导入3、字符串、对象、未知项、仍选中的重复项和相对顺序均完整保留。同集合事件不写回。此差异由真实模板矩阵回归约束。

标题/提示/分隔符/更多文字和颜色在本族实际生效。只有 `goodsBntTxtColor` 是作者有控件、原公开未读的存档色；公开按钮白字。header颜色渐变两端均读color0；module才读0/1。外面板圆角0/1/3/2、header顶部0/1、单列底部反用0/1，均按原件保留。边距、字号和圆角均设计px×2rpx，与积分商城原始rpx边距不同。

style/title/tone/goodsName/presaleConfig和圆角type沿原JS真值语义，导入字符串 `"0"` 与数字0保留真实差异；布局及标题字体的数值比较单独投影。BaseMoney三段字号单列26/40/26，其余24/36/36，前缀22、weight500、固定2小数、整数千分位与全角￥分别实现，原价使用¥。状态1未开始/2进行中/3已结束只在单列右条显示。

新增Admin独立Editor/Preview/Card/Money、defaults/model、匿名API，公共纯投影 `view/common/diyPresale.ts` 和Uni独立Widget/Card/Money/hook。DiseList走原保存接口，仅规范化三个作者.url；正文邻居、未知/业务资料及content字段独立保存。所有输入/读请求/图库回调绑定完整raw、actor/page/published/选中组件/代次，父v-model回执一次消费，拒绝/迟到/ABA不得获得新预览能力。

只读Admin预览按750rpx设计画布，375px封顶；窄容器所有rpx等比换算为cqw，显式隔离外层ElForm固定行高。支持科学记数法rpx，不修改Uni原始rpx。实际浏览器发现并修正单列价格竖排与继承32px行高；金额bbox必须完整位于价格条内。初始失败与修复前截图仍保留。

公开继续复用未改动的既有商业读取/导航控制器，真实商品id同时是基础productId，更多去 `/pages/activity/presale`，商品去 `/pages/activity/presaleDetail?id=商品ID`。剩余四族继续原Commerce分支。空/错误状态沿既有TS显式重试合同；没有额外SKU、购买或活动管理请求，Admin按钮只读。

## 匿名接口和媒体

新作者只显式匿名GET `/api/presale/list?page=1&limit=N&time_type=0`，N为1..10整数，omit/no-store/Accept/原AbortSignal。完整 `{list,count}` 校验及唯一正int32商品id、store_name/image、price/ot_price、sales/stock、presale_pay_status0..3；坏尾行整批失败，DTO/价格/临时签名不进入保存JSON。不可把积分商城直接数组或独立product_id合同套入本族。

当前真实后端PublicCatalogService/PresaleCatalogSnapshot沿匿名uid0、账号会员可见性、repeatable-read只读事务以及商品审核/上架/预售筛选；作者不伪造消费账号。权限仅原dise.manage，主动打开图库才要求attachment.view，无product.manage或预售商品写授权。

作者媒体仅imgBgConfig.url、imgConfig.url、imgColorConfig.url，包括隐藏/备用槽；沿原归属、type/MIME/key/current-raster与共享ordinary2500原子预算，2501整批失败。原闪电、商品DTO图及未知metadata不获作者权限，不递归、不实体解码、不放宽预算。三PNG作者素材和一PNG闪电各双端复制原字节，共8份：

| TS文件名 | 固定原件 | SHA256 |
| --- | --- | --- |
| presale-bg.png | public/statics/images/presaleBg.png，710×96 | `13bf2d6bfc6ebbdfe2c7981b61fefa3db1755d8112094f9a0804ece7693d730e` |
| presale-title.png | view/admin/src/assets/images/presale02.png，140×32 | `bcdff400fba8ad7e1436a0874e6c319253c16e566c887ed227a2131ade0db7ac` |
| presale-title-alt.png | view/admin/src/assets/images/presale01.png，140×32 | `d5ef072254794e45c47d6335a09da76e8ea4057c17a87648a8f3de12d52f9237` |
| presale-flash.png | view/uniapp/static/img/presale.png，48×74 | `f03c40e6005d5c820f263c63133146796b19378a0694eba5a998ed3d0652a4c9` |

媒体deadline硬门禁展示与所有原生tap/load/error。有效准入下纯票据更新，包括截止后续签，可复用已读feed；首次过期、owner/session/raw/active变化及ABA都清准入，旧回调/响应不可复活。只有三个精确槽的票据可从完整意图指纹剥离，未知业务值仍进入身份；三平台且无window/URL环境均实际运行。

## 验证与证据

去重共 **1,554项** 定向测试全通过，本批新增独立 **363项**。初始69/70项SFC及早期同26媒体案例、重复类型/构建不重复计数。

| 范围 | 新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 113（model25、data17、最终实际SFC71） | 267 | 380 |
| Uni | 120（真实Widget→Card→Money/native生命周期） | 335 | 455 |
| Worker | 130（媒体26、来源/parity104） | 589 | 719 |

三端严格类型，Admin/H5/微信/App生产构建均通过。最终Worker为19文件单worker，保留API清单、旧来源层、商业兼容和危险负例。三端专用测试命令及原CI两条前端链追加新末尾，原命令不删。

新source SHA `751fb7a9e1a2805e977d328d673f430f916984b19abd2bd7a24fd237dc6b0628`、PHP parity `370a6fe9286dd9dc4e945599db11cf8df744404557abe7224542b5f93899838e`；精确绑定22份完整modified、18份full-add、8原PNG和9份开始/结束字节不变源。24份旧dated/helper/fixture字节不变，兼容只在最外层逐项剥离本批精确增量。旧Promo/Coupon/Points Renderer正例只增加独立presale和剩余四Commerce检查，原负例/事件断言保留。

旧完整API报告1989a3acb92e8186572b1e3a05a52c32f392432ab5c37eaef7a3066ec71a28f1已归档；当前 `4be3effb39a421e94b480688dfed6ec41780a5b2d0e0668fb119635f3174282d`。703调用/741路径变体均注册可执行，只有DiseList hash和3旧call行各+3，无新Axios调用或路由。

最终53文件在最后Worker合同运行前冻结、结束逐字节校验无漂移；这是新运行/类型/浏览器/原生构建验收之后的边界，不声称更早验证均始于此冻结前。总账仅追加，原完整前缀和88/405条含checkbox文本行保持原字节。

实际浏览器是生产Admin `/content/dise` 与生产H5 `/#/pages/index/index`，使用现有Playwright/Chrome回退（本会话Browser插件不可用），单renderer/128MiB JS、浏览器Node192MiB。Admin1365×1000与390×844；H5390×844与1100×1100。标题/非空/无Vite overlay、图片、桌面四布局尺寸、窄屏、checkbox条件、匿名读取、错误/空/重试、保存、刷新及导航均检查，并人工查看截图。

最终Admin普通level1（dise.manage/view+attachment.view）2次实际GUI保存、23业务请求、0错误/0警告；四独立组件布局[3,0,1,2]，每组件3商品，三图库槽写稳定引用且发布全block匹配才可预览。最终窄屏三条金额bbox全部位于价格条内，科学记数与零/超量完整数据不自动写回。早期仅检查水平溢出的结果不能证明竖排/行高正确，最终以强边界断言和人工截图为准。

H5四组件12卡、刷新、千分位、三状态与导航共28个GET，0错误、1条下述既有依赖警告，无写请求和领券journal。商品目的地为 `/pages/activity/presaleDetail?id=17`，更多为 `/pages/activity/presale`。详情刻意返回本地不可用，验收止于正确导航，不声称真实规格/购买E2E。所有API（含既有默认API域）均本地拦截，没有外部账号/数据库流量。

唯一H5警告为 `[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly.`，来自未修改的 `view/uniapp-ts/node_modules/@dcloudio/uni-h5/node_modules/vue-router/dist/vue-router.esm-bundler.js:1`。其它警告/错误均不得忽略。首次Admin脚本点击Element Plus隐藏input等待超时，随后改点实际可见label；原脚本失败记录保留，未为它修改生产行为。

全部内存密集测试/类型/构建及调用TS parser的API审计通过 `/home/cina/cinagroup/tools/validate-serial.sh`；Vitest单worker、Node单test-concurrency，未绕过其它会话共享锁。临时完整before、日志/JSON、失败收据和截图位于 `/tmp/cinashop-presale-author/`。只读计划原partial已补读BaseMoney/全局CSS/图片默认模式；详情购买、真实PG/R2、设备或微信SDK、外部集成/生产E2E不在此批验收证据内。

未执行远端精确提交CI、commit、push、PR、merge或部署；不把只读准备或本批完成当作整体迁移完成。
