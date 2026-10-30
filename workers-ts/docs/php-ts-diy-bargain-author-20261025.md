# PHP→TS DIY 砍价作者迁移（本批已验收，整体迁移继续）

本批完成 bargain 作者、原四种公开布局、三图片槽及小程序单模板订阅延续，并修正真实公开列表的来源差异。实际组件、SQL/Controller、严格类型、四端构建、真实Admin/H5浏览器与最终来源合同均已通过。仅本批砍价作者闭环验收；整个PHP→TS迁移目标仍开放，下一商业作者为seckill和liveBroadcast。

## 固定来源与完整编辑

PHP固定参照 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。实际源为home_bargain.vue:194–709完整51键默认、c_home_bargain.vue作者面板、bargain.vue四模板/计算/CSS及父首页/专题订阅后的导航。逐行证据与完整新源在 `audit/diy-bargain-author-php-parity-20261025.json`。

| 原件 | SHA256 |
| --- | --- |
| view/admin/src/components/mobilePage/home_bargain.vue | `b9a9e451c288d37aee44fd4b0033c4b918d070a6b8fa4048cc95f481e090cc7a` |
| view/admin/src/components/mobileConfig/c_home_bargain.vue | `c276d5f8ac928dc0d5a91ff98d8b3417c9a2efcd3b1b25af17c27bd1f0f74c54` |
| view/uniapp/pages/index/components/bargain.vue | `06354d0788d0e4bb49b1a27fb75b1c1555b50c5964111ef9ec1dafce6666b945` |

新建只替换timestamp和三处明确图片表达式。默认数量3、四项数字checkbox0/1/2/3分别名称/参与人数/价格/划线价；完整字面值compact SHA `6af7de586515514fc8e97fd8d624aa73f3e35b88a02ab01aeecdfd08647cd117`。导入不合并默认、不修复原始空白/指数/0/tiny/超量值，保留未知、隐藏、备用项及checkbox顺序/重复/字符串/对象。同数值或同集合事件不写回，窄setter先校验整个候选，后原子提交。

全部真实颜色、间距、圆角、标题/提示/更多文字及分组可编辑。单列joinNumColor和横滑joinNumColor2/joinBgColor分别接线，不沿原面板部分分支字段错配重命名或覆盖资料。goodsBntTxtColor完整存档，原公开按钮仍白字。完整父v-model回执、页面/发布状态、actor、选中项、raw、代次和图库能力约束与既有编辑器一致。正文邻居和独立content原样保存，不造商品ID选择或activity.manage授权。

当前TS有效数量仍floor/clamp10000/min10、非法/缺失fallback6；新建默认3。新数量输入1–100、同值导入不修复。固定PHP缺LIMIT配置数值，不称10/100为原PHP上限。

## 真实四布局

| 布局 | 行为 |
| --- | --- |
| 单列0 | 280×280rpx图、内容高280/pl20、两行名称高80；check1显示火焰20与24rpx参与人数、上间距26；价格无前缀；check3原价，可选144×56“参与砍价”。 |
| 双列1 | 图高324、gap22、名称两行，无拼团额外pl10；不显示参与人数；check2价格/check3原价，可选按钮。 |
| 三列2 | 图高212、gap18、名称单行；只有本布局使用22rpx“低至”前缀；无参与人数和按钮。 |
| 横滑3 | 图224、左间距20、名称宽222/下间距10；成功标签跟随check0名称而非check1；无原价、按钮或低至前缀。 |

所有金额取活动起价price，min_price另为业务底价，不偷偷替换展示金额；原三列“低至”文案按源保留。BaseMoney全角￥、两小数/千分位、24/36/36rpx和字重500分别实现。外层/文字/边距×2，面板四角0/1/3/2、图片0/1/2/3、头部及单列底角0/1；头部渐变color0/0、自定义按钮色1→0。JS真值字符串"0"与数字0保持原消费者差异。

单列参与人数用主题或joinNumColor。横滑成功标签默认270deg theme→gradient、白字；自定义才用90deg joinBgColor0→1和joinNumColor2。标题图140×32rpx，原两图实际140×32，提示字段亦140，完整保留。

Admin-only cqw预览375px封顶，窄容器统一缩放原rpx并隔离表单行高；Uni仍原rpx。独立Widget/Card/Money/hook复用原商业读取和登录/详情导航控制器，HomeRenderer只剥离bargain，剩余通用Commerce为seckill/liveBroadcast。既有通用Commerce模块和已验收拼团实现保持字节不变。

## 公开列表来源修正

固定PHP StoreBargainDao150–162要求基础商品is_del0、非NULL闭区间start<=now<=stop及sort DESC,id DESC；model153–155把基础商品ot_price绑定到活动结果。此前TS允许NULL时间、只按sort排序、未排除已删基础商品，且把活动起价当作划线价。

当前StoreBargainDao.list保留完整平铺活动列，只innerJoin增加基础otPrice并修正上述过滤/排序；getById及其它DAO不变。ActivityService仅将ot_price改读item.otPrice。仍展示活动price和独立min_price、按真实type1发起者自助记录聚合people、活动ID和productId分开；不增加原PHP没有的基础isShow/isVerify/stock/quota过滤。没有开始/助力/购物车/订单或其它写入改变。

新增真实SQL/Controller回归使用financeMemoryPostgres九表及序列快照，覆盖旧价0/99.90、基础商品删除、活动/基础状态、NULL与±1ms闭区间、sort/id、分页、发起人数、actor、无写入及getById保留。旧mock仅补真实DAO新增otPrice:'20.00'，不加生产fallback。既有DIY商业PG夹具补明确有效日期，原价断言读基础商品真实30；这两处夹具改动有完整前序逆变换，但未运行native PG16前不得把它们称作PG16验收。

Admin显式匿名单GET `/api/bargain/list?page=1&limit=N`，整批验证id/product_id/title/image、price/ot_price、people/sales/stock及重复/坏尾项。omit/no-store/Accept/原signal，取消不采用，0有效数量无IO。DTO、价格、providerID与签名不持久化；只读卡片和按钮不调用SDK、详情或参与接口。

## 媒体与原字形

仅imgBgConfig.url、imgConfig.url、imgColorConfig.url三个精确槽，包括隐藏/备用/超量组件，纳入既有ordinary2500和current归属/type/MIME/key/raster校验。图库预览能力绑定完整块+槽+稳定引用；已发布读取需完整canonical块匹配。业务商品图、未知image/url、火焰和字体不获得作者素材权限，不递归、不实体解码、不放宽容量。

三槽deadline约束展示及每个原生load/error/tap/SDK续行。已准入同owner/完整意图的纯票据续签可复用feed/provider资料；首次过期、owner/session/raw/active/ABA不能沿旧准入复活。三个原PNG双端六副本：

| 文件 | 固定原件及尺寸 | SHA256 |
| --- | --- | --- |
| bargain-bg.png | public/statics/images/bargainBg.png，710×96 | `26006d4b73f24ebde7437dc73ab80bb583c20882d8d956a68f034238521a2c76` |
| bargain-title.png | view/admin/src/assets/images/bargain02.png，140×32 | `7f0205406a3785e52bf75374f9f655d33fffbd6c06c9b758af63bb59782f2aea` |
| bargain-title-alt.png | view/admin/src/assets/images/bargain01.png，140×32 | `45299a139ab0a3dad07d69d0f5403d41b5fedcb8782c097f425984cb8f519509` |

火焰并非emoji替代。固定PHP iconfont.css:684–686映射U+E69D，其CSS SHA `ffc1328998da5551a19a59813f319dc492080f2841032ea38ccca8987f4334a9`。原CSS引用的[版本化公开WOFF2](https://at.alicdn.com/t/c/font_3861873_7jqd67f0xpw.woff2?t=1726278102731)于2026-10-25读取，40,732字节、SHA `536341c2729401dcc65464bd494401261cf09b2eb05b30e2524aea5577dd2199`，作为唯一DIYBargainFire字体原字节base64打包，不产生运行时CDN请求。字体二进制是该外部URL的本次取回值，不冒称固定Git二进制；原CSS和取回出处独立记录。新增common CSS通过Card外部style引入，原字体不成为作者图片槽。

## 单模板订阅后派发

原MP点击先openBargainSubscribe，再emit changeBarg；父首页727–735与专题529–537此时按登录态去登录或活动ID+spid。原SDK成功（含拒绝/ban/filter）和fail均继续，不启动/助力砍价。原预读在首页/专题准备阶段，缓存bargain_success实际provider ID；2727管理短号不能传SDK。

新MP-WEIXIN适配器有效上下文提前匿名读取既有 `/api/wechat/teml_ids`，tap内同步调用uni.requestSubscribeMessage单ID，防止等待网络丢失手势。success/fail单次settle后交既有guest登录或活动ID+当前uid/spid派发；H5/App和更多不调SDK，挂载不弹授权。等待时防重复tap；旧callback不能跨owner/raw/active/nativeepoch/mediaexpiry/card对象/unmount或ABA，也不能释放新等待。

缺失/坏ID、缺SDK或同步throw直接走现有派发，是对原异常阻断路径的明确健壮性改进；无回调不新增超时。provider只在对应内存上下文，不写储存、journal或发送通知。SDK回调模拟和MP构建不代替微信设备E2E。[微信官方接口文档](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/subscribe-message/wx.requestSubscribeMessage.html)已在本会话核对点击限制与回调契约。

## 运行验证与浏览器QA

去重 **2,454项** 测试通过，本批新增独立 **476项**。早期重复运行、媒体复跑、类型和构建不重复计数。

| 范围 | 新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 126（model27/data18/实际SFC81） | 505 | 631 |
| Uni | 183（真实Widget/Card/Money、三平台事件及单模板回调） | 634 | 817 |
| Worker | 167（media26/catalog31/source与parity110） | 839 | 1006 |

Admin/Uni/Worker严格类型及Admin/H5/微信/App生产构建均通过。Worker25文件单worker覆盖真实内存Postgres SQL/Controller、旧来源链、API清单和商业/媒体危险负例。三端专用测试入口及CI两条原命令链均追加。

source SHA `cfb6680900e15dca0c247ef6e82a44066c0df608ffb6c5154ee3c62cc974d20b`，parity `b8ac7c3ce27fbfb80ec2248144509a399c4dca47267357e48cb1332c321484d5`。31 modified完整前序精确逆变换、21 full-add、6PNG；30份旧dated/helper/fixture字节及原负例保留，20份已捕获旧源起止字节相同。旧Renderer正例明确独立砍价和剩余两Commerce，不替换原夹具。

完整API前序6a6bf25fbfc13584cf4c9fb5672a7d5750575f63beeb353c22765573ddc74990逐字归档，当前 `f95be9b56d2d826f86778aca2f53e0841d2eb50c4ae0455d2fb82dd7b4c3f199`。实际TS parser再生成后仍703调用点/741路径变体全部注册可执行；仅DiseList hash和三个旧call各+3行。新增匿名fetch和provider读取另行证明，不虚增Axios覆盖。

最终63源/证据在最后Worker合同运行前冻结，结束逐字节检查无漂移；不声称早期运行从该时点开始。原总账完整前缀及88/405条含checkbox文本行保持，仅追加本批事实。

首次最终Worker运行1005/1006通过；唯一失败是新来源测试沿用拼团函数名openPinkSubscribe，固定砍价原件实际为openBargainSubscribe。只纠正该断言，生产实现与两个proof均未改变；原失败JSON/日志/冻结完整归档。重新冻结63文件并复跑完整25文件，最终1006/1006通过，首次失败不计成功、不重复累计测试。

实际Admin普通level1（dise.manage/view+attachment.view）完成2次GUI夹具保存、23业务请求、0错误/0警告；四种布局各3商品、三个图库槽稳定保存、已发布完整块匹配、错误/空结果/重试均通过。390px手机中的224px预览容器等比缩放，无水平溢出；三条金额bbox处于各自内容范围，原火焰字体加载和字形经截图确认。

实际H5展示四组件12卡，参与人数/横滑成功标签、三列前缀、千分位、刷新、游客登录、已登录活动ID17+当前spid11及更多入口均通过。51个业务GET、0错误；仅1类既有Vue Router依赖警告，3次页面载入各触发一次，完整保留3条事件。H5无/wechat/teml_ids请求、无journal写入；导航使用活动id17而非基础productId1017。全部API本地拦截，详情故意不可用，不声称完整购买或真实账号验证。Admin手机与公开四布局5张截图已人工核对，无缺图、遮罩、金额竖排或字体替代。

全部内存密集测试、类型、构建及TS parser审计通过共享validate-serial.sh，Vitest单worker、Node单test-concurrency。早期三会话exit143完整保留：仅真实SQL/接口33和Admin类型有成功收据，未完成Uni/未启动项不算通过；续跑独立PID及逐步退出收据仍走同一锁，未停止其他工作树或绕过串行门禁。

Browser插件不可用，使用现有Playwright/Chrome、单renderer/128MiB JS、浏览器Node192MiB。已验收路径：Admin /content/dise → 创建砍价/单GET/四布局/图库/保存/错误空结果重试 → H5首页消费保存JSON/刷新/游客登录/已登录活动ID+spid/更多。桌面与390px，逐项核对身份、非空、无overlay、console、几何、字体、截图和实际交互。所有API在本地拦截，详情刻意不可用，不声称真实购买或账户会话验证。

已知仅允许H5既有Vue Router直接dist导入弃用warning，来源为未修改的view/uniapp-ts/node_modules/@dcloudio/uni-h5/node_modules/vue-router/dist/vue-router.esm-bundler.js:1，其它错误/警告不能忽略。Admin/H5/微信/App生产构建已通过。未执行native PG16、真实R2、微信设备、生产购买或远端精确提交CI；未commit/push/PR/merge/deploy。内存Postgres和模拟SDK证据不代替上述外部验收。
