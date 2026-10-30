# PHP→TS DIY 积分商城作者迁移（2026-10-25）

本批完成 `pointsMall` 的作者编辑、匿名公开商品预览、三种真实公开布局和三个精确图片槽。完整 PHP→TS 迁移仍在推进；`presale / combination / bargain / seckill / liveBroadcast` 五类商业作者以及既有总账中的其它未完成项继续保持开放。本批不改积分兑换、订单、购物车、活动管理权限或数据库结构。

## 固定来源与完整配置

固定 PHP 参照为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。本批独立逐字节读取来源和素材，不以当前 TS 通用商业卡片反推原件：

| 来源 | 权威范围 | SHA256 |
| --- | --- | --- |
| `view/admin/src/components/mobilePage/points_mall.vue` | 132–549 完整44键默认 | `fc9b3b735f38295cc49247470c85fb2d78f131f938dab31bc301a2300b9ffa87` |
| `view/admin/src/components/mobileConfig/c_points_mall.vue` | 40–247字段，334–422控件组合 | `bfff5179e89177007c006bb804c331a3b472afdb6b22a278cc319b2b5adb1676` |
| `view/uniapp/pages/index/components/pointsMall.vue` | 1–68模板、92–196样式、199–221列表与导航、228–371CSS | `b544c1d9543f40d5cf3501cc2234b73aa019ff905a1ceefc037ad8276497f18d` |

新建使用完整44键；只把 `timestamp=this.num` 转为排序值，并把三处已知图片表达式换为双端可服务的静态地址。导入不合默认、不截断未知字段、非当前模式字段或超量配置，不改同值数字的空白、指数、0与微小数字符串。普通新增数量为1–100；当前TS公开列表沿既有上限10。固定PHP树缺少 `config/app.js`，不把10或100声称为已证明的PHP硬上限。

`titleColor / titleNumber / rightBntConfig / goodsNameColor2 / goodsUnitPriceColor2 / bottomBgColor` 是实际作者资料，原公开模板没有读取。编辑器完整保留且明确标为存档，公开标题仍32rpx、#333，更多文字仍固定“更多”。`titleText=2` 为斜体；标题图依据背景模式选择 `imgConfig2 / imgConfig`，不依据商品布局选择。

## 实现与真实消费

- Admin 新增独立 `DiyPointsEditor/Preview/PreviewCard`、完整 defaults/model、匿名 `diyPointsAuthor` 数据边界。DiseList 走现有保存接口，保存时只规范化三个明确作者图片槽。全部控件、图库及延迟请求绑定完整raw、actor、page、published、组件选择与代次；父v-model回执一次消费，拒绝或迟到回执不能获得预览权限。
- 匿名预览只显式 GET `/api/store_integral/list?page=1&limit=1..10`，使用 omit/no-store/Accept/AbortSignal。验证完整直接数组、唯一积分活动ID、基础商品ID、积分/库存、金额与安全图片；坏尾行整批失败。DTO、价格与临时签名不写入装修JSON。有效数量0不发请求。
- 公共纯投影 `view/common/diyPoints.ts` 同时驱动Admin只读和独立Uni `DiyPointsWidget/Card/useDiyPoints`。横滑图224rpx且无商品名；三列图高212、价格在单行名称之前；两列图高324、两行名称在价格之前。背景渐变90/270度、外间距原始rpx、圆角乘二与四角0/1/3/2顺序均独立保留。
- 横滑跟随主题的价格底色与白字、网格跟随主题仍读取作者数字颜色、固定#333的“+”和原公开积分装饰图标分别实现。`bntNumber` 保留原公开裸数值fontSize；浏览器实际计算值单独留档，不伪造“原PHP设计px乘二已证明”的结论。
- 继续复用未修改的旧商业数据与导航控制器，详情传积分活动 `id`，不传基础 `product_id`；更多仍去 `/pages/user/integral`。其余五类商业组件继续旧Renderer分支。Admin预览不包含详情、兑换或购物车动作。
- 图片只有 `imgBgConfig.url / imgConfig.url / imgConfig2.url` 三个精确槽，包括隐藏及非当前模式槽。发布侧沿既有归属、类型、MIME、key/raster校验及ordinary原子预算2500；2501整批失败。未知metadata、业务商品图和固定图标不成为作者授权来源，不做实体解码或递归扩大范围。
- Uni媒体租期硬门禁展示和全部旧原生回调。同一live owner/完整意图获准后的票据到期立即停用UI，纯续签可复用已读feed；首次过期、换owner/raw/active或ABA后不能沿旧准入发新请求。票据更新只刷新native代次，不重新读取feed；真实意图变化使旧响应失效。无window/URL环境以及H5/App/微信回调均运行验证。

## 素材

以下四份原PNG字节各复制到Admin public与Uni static，共8份；没有重新生成或使用后台演示图替换公开装饰图标。

| TS文件名 | 原件 | SHA256 |
| --- | --- | --- |
| `points-bg.png` | `public/statics/images/pointsBg.png`，710×96 | `f091108145214600a2ce57a7837147675b0bb590848088f5fb7d84d43fbdbd7f` |
| `points-title.png` | `view/admin/src/assets/images/points01.png`，176×32 | `c010c32a90caaa85a5603acb8e2711f8628c2bc0486ec130658aa1b58cb5aa2a` |
| `points-title-alt.png` | `view/admin/src/assets/images/points02.png`，176×32 | `f762f3bf6d887ead5283f94327693f76afd71c9cd662ee3c5e73f79b8e660ddd` |
| `points-icon.png` | `public/statics/images/newVip3.png`，53×53 | `878811dad1f6760dd07500fa94f95f1dc9bb632ba5680c43e7797038c24b485d` |

## 证据和验证

去重共 **1,191项** 定向测试通过，其中本批新增独立测试 **278项**。早期重复媒体26项和类型检查不重复计数。

| 范围 | 本批新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 79（model21、data17、真实SFC41） | 188 | 267 |
| Uni | 79（真实Widget/Card/native lease） | 256 | 335 |
| Worker | 120（媒体26、source/parity94） | 469 | 589 |

Admin/Uni/Worker严格类型检查、Admin/H5/MP-Weixin/App生产构建均通过。Worker为17文件单worker运行，包含完整API审计、既有来源绑定、相邻商业组件与媒体负例。新建三端专用测试命令并追加原CI两条前端链的末尾；所有原命令保留。

新来源绑定SHA `cedec475e804f04130567dbf77cf860b8f2eef14847465f629e45f13e7952e7b`，PHP parity SHA `bb7086d358c0d4b8177abd3bb72ef21627381c2edf521f80fb3b96c9ad6eaea2`；严格记录20份完整修改前后源码、15份完整新增源及8份PNG。21份旧dated证明/历史fixture/helper原字节不变；兼容层只从外层逐项剥离本批精确增量，原负例不删。旧promotion/coupon Renderer正例仅追加独立points分支与剩余五Commerce断言，完整before可逆。

API完整旧报告归档SHA `844e662e047c8eaa3786741267ed6b63dd73eb779a1440aa4a7ab684af7a91cc`；当前SHA `1989a3acb92e8186572b1e3a05a52c32f392432ab5c37eaef7a3066ec71a28f1`。703个调用点、741路径变体全部仍注册且可执行；只有DiseList source hash与3个原调用行号各+3，没有新Axios调用、路由或管理权限。

最终48文件来源冻结在新运行/类型/浏览器/原生构建检查之后、最后Worker合同运行之前；合同结束逐字节复核无漂移，不声称更早检查都在此冻结之前。通用Commerce四模块、旧数据投影、Promotion作者模型和旧共享runtime helper均与本批开始的完整父快照相同。两份总账只追加本批说明，旧完整前缀与88/405条含checkbox文本行均逐字节保留。

H5 390px视口下裸数值fontSize未形成有效inline CSS，原24rpx回退实际计算为12.48px，三布局一致，证据存于 `public-browser-result.json.bareFontSize`。

浏览器入口为Admin `/content/dise` 和H5 `/#/pages/index/index`。Browser插件在本会话不可用，按已读前端测试技能回退现有Playwright与 `/usr/bin/google-chrome`；Chrome限制单renderer/128MiB JS，浏览器Node限制192MiB。Admin视口1365×1000、390×844，H5视口390×844、1100×1100；实际页面标题、非空、无Vite overlay、布局尺寸、图片、刷新、只读按钮及导航均检查并人工查看截图。

Admin普通level1仅 `dise.manage/dise.view/attachment.view`，实际2次GUI保存、22次业务请求，0错误/0警告；三个组件布局最终 `[2,0,1]`，每个3张真实形状本地商品卡。三图库槽写稳定引用，公开已发布完整配置匹配才能临时预览；错误、空列表、重试、窄屏无水平溢出均通过。所有API由本地拦截，不写外部数据库。

H5实际3组件9卡、刷新及独立导航检查共26次GET，0错误。详情到 `/pages/activity/integralDetail?id=17`，基础商品ID117未进入目的地；更多到 `/pages/user/integral`，无写请求、无领券journal。详情业务刻意返回本地不可用，验证边界止于真实导航，不声称详情/兑换端到端验收。首轮脚本未覆盖既有默认API域，导致本地阻断；补齐本地拦截并独立重新进入首页复核更多后通过，生产未因此改动，失败记录保留。

唯一H5警告为 `[vue-router]: importing from 'vue-router/dist/vue-router.esm-bundler.js' is deprecated. Use 'vue-router' directly.`，来自未修改的 `view/uniapp-ts/node_modules/@dcloudio/uni-h5/node_modules/vue-router/dist/vue-router.esm-bundler.js:1`。其它警告或错误不被忽略。

临时验收资料在 `/tmp/cinashop-points-author/`：原始before、逐项日志、browser-result/public-browser-result、截图、精确来源和总账前缀校验收据。全部内存密集编译/测试遵循 `/home/cina/cinagroup/tools/validate-serial.sh`；Vitest单worker、Node单test-concurrency。首次尝试npm因环境PATH不提供npm退出127，随后直接运行项目已安装CLI成功；这不是生产失败或跳过检查。

没有真实PG/R2、外部集成、微信SDK或设备端E2E；MP/App证据是生产构建和真实Vue原生事件模拟。未执行远端精确提交CI、commit、push、PR、merge或部署。
