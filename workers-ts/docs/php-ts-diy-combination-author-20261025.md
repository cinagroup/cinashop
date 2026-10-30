# PHP→TS DIY 拼团作者迁移（2026-10-25）

本批实现 combination 完整作者、真实商品与人数汇总双路只读预览、四种公开布局，以及微信小程序点击后的订阅延续。整个迁移目标继续开放，后续商业作者为 bargain / seckill / liveBroadcast。

## 来源与数据边界

固定 PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，完整前序取自开始本批前的工作区快照，不从 Git HEAD 重建。来源与逐行证据嵌入 `audit/diy-combination-author-php-parity-20261025.json`。

| 原件 | 范围 | SHA256 |
| --- | --- | --- |
| home_pink.vue | 225–700完整48键默认 | `db4fa20f3d051f2afdb75e43a5380beefaebe99e205e331a406a2eb46cb0914a` |
| c_home_pink.vue | 实际内容/样式作者面板 | `4b035d3d75e2b1d2794680ac593e578c46abb455dfe896ec8125cbec1f26d1a2` |
| combination.vue | 四模板、计算样式、双路读取、订阅和实际CSS | `1eb4f919774c56eec1f008396f544cfeb775110a3f36ec93ceb058bca246fc92` |

新建仅替换 timestamp 与三个明确静态图片表达式。完整默认保持48键、原checkbox数字0/1/2/3和默认数量3；导入不合并默认、不修复空白/指数/微小值/超量值，不删除未知、隐藏和备用资料。相同数值或相同checkbox集合不写回；变更仅作用于对应数字编号，未知项、字符串、对象、仍选中的重复项和顺序保持。当前TS有效数量沿既有floor/clamp10000/min10，非法/缺失回退6，与新建默认3区分；1–100是新作者输入范围，不称已证明的PHP LIMIT。

DiseList接入原页面保存，独立 content 和邻居块保留。实际输入、图库、发布媒体读取、异步父v-model回执都绑定完整raw、actor、page、published、选中项和代次；迟到回执与ABA不能恢复旧能力。仅 goodsBntTxtColor 为公开未读的存档颜色；不新增商品选择、商品写权限或活动管理权限。

## 四种实际公开布局

| 布局 | 还原行为 |
| --- | --- |
| 单列0 | 240×240rpx图、名称两行80rpx、勾选1显示人数/已拼份数标签；勾选2金额，3原价；可选144×56rpx去拼团。 |
| 双列1 | 图高324rpx、gap22、名称左内边距10；原人数标签被注释，不显示；2金额、3原价、可选去拼团。 |
| 三列2 | 图高212rpx、gap18、单行名称；84×30人数角标始终显示；2金额、3原价，无按钮。 |
| 横滑3 | 图224×224、左间距20、名称宽222；人数角标始终显示；2金额，原价与按钮均不显示。 |

BaseMoney保留全角￥、千分位和两小数，所有布局24/36/36rpx，只有单列有24rpx“拼团价”前缀。不带预售状态条或闪电。外层/字体/边距乘二；面板四角0/1/3/2、商品图四角0/1/2/3、头部顶角和单列底角0/1分别保留。头部平色渐变用color0/0，自定义按钮用color1→color0。style/title/tone/goodsName/pinkConfig/圆角type按原JS真值，字符串"0"不等于数字0。

头部真实读取 `/api/pink` 的 pink_count 与头像，不把单商品pink_count当人数汇总。头像36rpx圆形、右边距-10，汇总文字26/36、左边距22；标题140×32rpx。原作者154px提示完整存档，实际两张原PNG均140×32。

公开独立Widget/Card/Money/hook复用未改动的真实商业控制器：列表直接数组、活动id与基础productId分开，详情 `/pages/activity/detail?id=活动ID`，更多 `/pages/activity/index?type=combination`。列表与汇总共同成功才采用；错误/空结果/重试沿现TS合同。HomeRenderer将拼团独立委托，剩余通用Commerce仅bargain/liveBroadcast/seckill；原Commerce config/controller/widget/API/data字节保持。

## 双路预览与图片授权

Admin只有显式匿名GET `/api/combination/list?page=1&limit=N`，完整数组校验后再GET `/api/pink`，两者全部通过才返回。每路omit/no-store/Accept/原AbortSignal，坏尾项、重复活动id、非法金额或摘要整批失败，取消后不发第二路。有效数量0的Admin预览无IO；原公开控制器0数量仍可读取人数汇总，此差异明确保留。DTO、头像和签名均不进入装修JSON；Admin卡片和更多只读，不调订阅SDK或购买入口。

只有imgBgConfig.url、imgConfig.url、imgColorConfig.url三个精确槽纳入既有ordinary2500预算和当前归属/type/key/MIME/raster校验，包括隐藏、备用与超量组件。业务商品图、汇总头像、未知metadata、homeComb和其它图片字段不获作者授权。稳定引用保存，图库预览能力绑定完整块+槽+引用，发布读取需完整canonical块匹配。图片到期停用显示和旧tap/load/error；同一已准入账号/完整意图的纯票据续签复用已读列表、摘要及模板资料，不重新请求。初始过期、owner/session/raw/active变化或ABA均不能沿旧准入复活。

三个原PNG各复制到Admin和Uni共六文件：

| TS文件 | 原件 | SHA256 |
| --- | --- | --- |
| combination-bg.png | public/statics/images/pinkBg.png，710×96 | `6b95e30b67fb853f57b49872dc754d537fbd19cdcc6cb4261ccbebcfa86804bf` |
| combination-title.png | view/admin/src/assets/images/pink02.png，140×32 | `dad8f41d98720a8964d1a21a280dfa020e8859f0f324a3377799a0910d646b20` |
| combination-title-alt.png | view/admin/src/assets/images/pink01.png，140×32 | `436293d064821e2675d2329ff2f8d35ee6420849ffaaa5e412809082f91213d3` |

## 微信订阅延续

原PHP首页/专题预读模板配置，点击商品才调用openPinkSubscribe，使用pink_true、pink_status真实provider ID；SDK成功（含拒绝/封禁/过滤）及fail都继续导航，无订单、发消息或订阅结果写入。现有Workers `/api/wechat/teml_ids` 已提供只读映射，3098/3353管理短号不能传SDK。

新适配器仅MP-WEIXIN在有效上下文提前匿名读取这两个ID，保存在对应活跃上下文内存，不持久化。真实tap同步调用uni.requestSubscribeMessage，避免点击后等待网络丢失手势；每次SDK调用只结算一次，等待期间重复tap不重复调SDK。成功/拒绝/ban/filter/fail均按原意继续既有活动ID详情；H5/App直接导航，不读模板、不调SDK；更多不调SDK，挂载不弹授权。

旧回调受完整配置、账号/session、页面active、原生epoch、媒体deadline、原卡片对象与unmount守卫。无回调不新增超时，切换上下文可结束旧等待。缺失/非法ID、缺SDK、SDK同步抛错时直接进入详情，这是对原异常路径可能停住/抛错的明确健壮性改进，不冒称异常逐字等价；没有假成功提示、后端template创建/send或journal写入。

[2026-10-25实时读取的微信官方文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)核对了点击限制、模板参数及success/fail回调。原生行为用真实组件与可控SDK回调模拟，构建并不等于微信设备端到端验证。

## 验证与浏览器QA

去重 **1,976项** 测试通过，本批新增独立 **422项**。重复SFC/媒体/类型/构建不重复计数。

| 范围 | 新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 125（model27/data24/实际SFC74） | 380 | 505 |
| Uni | 179（真实Widget/Card/Money、三平台事件/SDK回调） | 455 | 634 |
| Worker | 118（media26/source与parity92） | 719 | 837 |

Admin/Uni/Worker严格类型及Admin/H5/微信/App生产构建通过。Worker21文件单worker含旧来源链、API清单和商业/媒体危险负例。专用三端测试入口与CI两条原命令链均追加。

source SHA `2c65f2efaf3cc9d605209e151615d6c7930c918992ac6f4e77ec9887ab0798e9`，parity `10bfa7317c987f875320d656b7da70d5f06774a5efaf76834dd0277c4c2bce45`。24 modified完整前序精确逆变换、19 full-add、6PNG；27份旧dated/helper/fixture字节及旧负例保留，14份已捕获旧源起止字节相同。旧四份Uni Renderer正例增加独立拼团及剩余三Commerce检查。

完整API前序4be3effb39a421e94b480688dfed6ec41780a5b2d0e0668fb119635f3174282d逐字归档，当前 `6a6bf25fbfc13584cf4c9fb5672a7d5750575f63beeb353c22765573ddc74990`。仍703调用点/741路径变体全部注册可执行；只改DiseList hash和三个旧call各+3行。新匿名fetch与原生模板读取另外列明，不虚增Axios覆盖。

最终54源/证据在最后Worker合同运行前冻结，结束逐字节检查无漂移；不声称更早验证均从此时开始。原总账完整前缀和88/405条含checkbox文本行保持，只追加本批事实。

实际Admin普通level1（dise.manage/view+attachment.view）完成2次GUI夹具保存、30业务请求、0错误/0警告；四种布局均3商品，列表与汇总共同读取，三图库槽稳定保存、已发布整块匹配授权、错误/空结果/重试均通过。手机预览224px容器等比缩放，无水平溢出；三条金额bbox处于各自内容范围内，人工截图确认清晰无竖排。

实际H5展示四组件12卡，真实人数73/头像、标签/角标、千分位、刷新、活动ID详情和更多导航通过，共37个GET、0错误、仅下述1条既有依赖警告。H5无/wechat/teml_ids请求、无journal写入；导航传活动id17而非基础productId1017。全部API本地拦截；详情故意不可用，不声称完整购买验证。

Browser插件不可用，采用现有Playwright和Google Chrome，单renderer/128MiB JS、浏览器Node192MiB。目标流程：Admin /content/dise → 添加拼团/读取双路资料/切换布局/图库/保存 → H5 /#/pages/index/index 消费保存结果/刷新/活动ID与更多导航。Admin1365×1000、390×844；H5390×844、1100×1100。全部API在本地拦截，不访问外部账号或数据库。页面身份、非空、无错误overlay、console、四布局几何、只读动作、窄屏、错误/空结果/重试与截图逐项核对。

唯一允许的H5警告是既有 `[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly.`，来源为未修改的view/uniapp-ts/node_modules/@dcloudio/uni-h5/node_modules/vue-router/dist/vue-router.esm-bundler.js:1。真实详情读取刻意返回本地不可用，验收止于正确活动ID导航，不声称购买流程验证。

内存密集测试/类型/构建及使用TS parser的审计统一经过共享validate-serial.sh，Vitest单worker、Node单test-concurrency。完整前序、日志、失败尝试与截图位于/tmp/cinashop-combination-author。没有真实PG/R2、微信设备/SDK端到端、生产购买或远端精确提交CI证据；未执行commit/push/PR/merge/deploy。
