# PHP → TS：优惠券 DIY 作者与五种公开布局（2026-10-25）

本批承接 promotionList，完成 `coupon` 作者及实际公开布局。固定 PHP 基线 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。整个 PHP → TS 迁移仍未完成，商城作者尚余 pointsMall、presale、combination、bargain、seckill、liveBroadcast 六类；既有 FE-001／FE-003、生产、真机与其他父项继续开放。

## 固定来源与完整默认

- `view/admin/src/components/mobilePage/home_coupon.vue:203–380`：完整24键defaultConfig，SHA256 `aec344597c104f7f03772cdf83dc35c912b340964d8dfeb29fa307d06dab793d`。
- `view/admin/src/components/mobileConfig/c_home_coupon.vue:35–115,132–158,190–215`：实际字段与显隐矩阵，SHA256 `561533c066e6d80e15e71bc03bd7fa02e08072e73924f22de6fb78a839500093`。
- `view/uniapp/pages/index/components/coupon.vue:3–141,193–329,340–735`：真实五模板、读取／领取和CSS，SHA256 `5b0c3b430f4a2d7830ac6849b61edc35c140632c8c812d722680fbb4ae895c93`。

新默认保留所有标题组名、颜色default/color、圆角选项和隐藏字段；仅将 `timestamp:this.num` 替为0。完整静态字面量compact JSON SHA256 `4ad457fc9475b96a9c1ab87fc9c87b0b1918cada7740d16e42cd3725dfbfffc6`。完整导入不与默认合并，不在挂载时补字段、改数字拼写或截断。原后台画布中的固定70/50元演示券及style3的四条截断不属于公开合同。

原作者没有选券、分类、品牌、链接或图片字段。旧 Admin coupon.ts 和实际 CouponList／couponIssue 管理流程都不是DIY目录，本批不为装修作者增加发行／模板／领券历史管理权限。风格选择缩略图与后台硬编码newVip02装饰也不是作者媒体槽；本批不复制素材、不增加canonical、Worker签名或Uni媒体续签槽。

## 作者闭环与匿名预览

`DiyCouponEditor.vue` 接入 `DiseList.vue` 实际v-model和原save，支持组件新增、选择、跨普通正文排序、删除、显示、编辑分组、五风格、数量、色调、完整颜色、间距与边距、统一／四角圆角。色调和样式决定实际控件显示：金额色在自定义时出现；按钮色除style2外出现；券背景仅style0/3；模块渐变用于style1，其余模块纯色始终可设。隐藏资料、未知邻居、数值字符串和独立content完整保留。

作者普通新数量为整数1–100；等值事件先保留已有原值，兼容0、微小数、科学计数法、空格和超量导入。公开数量沿用已有TS行为：缺省6（完整新默认5）、非负数floor／clamp10000后最多10；0与微小数的有效数量为0，不发请求。原固定PHP读取 `$config.LIMIT`，但该ref缺少 `config/app.js`，无法证实它的数值；10是保留当前TS兼容策略，不称为原PHP上限。

预览显式调用新的独立 `apiDiyCouponPreview`，仅匿名 `GET /api/v2/coupons?page=1&limit=N`，credentials omit、cache no-store、Accept JSON、原AbortSignal；不加载Admin认证客户端、公开领券控制器或领取流水。全批校验4项count、唯一正整数id、scope type0–3、discount coupon_type1/2、金额、剩余量、领取限制及状态，uid0拒绝伪造已领取资料。坏尾项不产生部分卡片，错误／空结果有明确状态并可重试。DTO不进入装修JSON；只读领取及优惠券中心按钮不导航、不写存储、不发POST。

全部真实输入、颜色选择器、数字、圆角和读按钮都绑定原账号、会话、页面、选中组件、完整JSON及代次。组件、原JSON、页面、会话、禁用或卸载的A→B→A不能复活旧回调；忽略abort的迟到响应仍不能回填。自身v-model回执仅消费一次，下一tick清理；排队／延迟父回写可正常新增，父级拒绝则不能凭空创建预览。普通样式修改仅在实际请求limit不变时保留已读取结果，原文重新导入则失效。

## 五种真实公开布局

共用 `view/common/diyCoupon.ts` 投影实际公开样式，Admin HTML和Uni原生卡片使用同一尺寸／颜色对象。HomeRenderer给coupon独立分支，保留promotion真实列表委托及其余六族Commerce；旧Commerce四模块和现有journal/API原字节未改。

| 风格 | 实际尺寸（rpx）与结构 | 保留的差异 |
| --- | --- | --- |
| 0 弧形券 | 156×156底卡，144×156白色面上移20，76高按钮及弧线 | 固定12间距；主题按钮90deg、自定义180deg |
| 1 竖向卡片 | 204×232白卡，范围名称、136×48圆按钮 | 模块90deg渐变；门槛与金额同色 |
| 2 虚线票券 | 274×150，1rpx实线外框、白色0.9内层、上下16圆缺口、虚线分隔 | 竖向领取；不使用按钮渐变 |
| 3 领券站 | 140×132白卡＋右侧296固定站台、160×48中心按钮 | 仅此风格读取spacing×2；全部返回券保留，无后台demo四条截断；卡片不逐券领取 |
| 4 横向票券 | 228×108，左54位置的11半径radial缺口、56宽竖向按钮 | 主题卡背景0deg、自定义180deg；金额及门槛的inline自定义色覆盖默认CSS |

模块颜色与外层背景不因theme模式丢失；外边距设计px×2rpx，背景四角按原 `[0,1,3,2]` 输出。style0/1/2/4间距固定12rpx，只有style3使用可编辑spacing。金额继续采用既有TS规范两位字符串、折扣除10与Number门槛判断，不改后端金额／scope协议。原类型字段与数据库历史列含义不同，沿用既有公开DTO适配，不直接套管理接口。

## 公开领取与旧事件保护

新 `useDiyCoupon` 仅给公开端组合现有 `useDiyCommerceWidget`，保留真实读券、登录跳转、领取、持久unknown intent、pending去重、acknowledged／owned核对、服务器明确回滚后的显式重试和钱包入口。Admin从不挂载此控制器。原API `/api/coupon/receive` 和后台uid绑定校验没有改动，也没有新增业务路由、DDL、GRANT、ACL或依赖。

每个原生卡片tap和刷新／站台／只读核对／钱包按钮绑定原始完整块、actor/sessionVersion、响应代次与实际返回行身份。账号／JSON／active的ABA、同id重读、隐藏和卸载都会使原事件失效。领取已发送后，原账号的恢复流水仍可落定，但不会回填新组件或为新owner发新领取。两实例只共享已有actor/issue流水，不能重复发同一pending领取。

静态复核发现事件代次最初是普通let，computed按钮可能缓存初次加载前的过期许可；已改为响应式ref并追踪实际读取状态，新增真实初次加载后刷新与站台回归。原native button的直接函数绑定不会通过emit重新选择最新父handler。

## 审计与验证

coupon独立source-binding含15处修改的精确逆变换与14个新实现／测试的全文固定；先剥本批，再验证promotion及更早证据。旧18份dated proof／helper完整字节保持；旧八套绑定和Home测试只在当前读取入口追加精确层，原危险渲染／路由负例保留，原完整测试可逆恢复。没有改旧helper的hash来放过新源。

API前序报告完整归档，SHA256 `f526b393bdbdc2fb80304a49cfe5d45bec11a79eeaef80a71e01cb8100235162`。当前Axios清单仍703调用点／741注册且可执行变体，仅DiseList源hash与三处既有call line各+2；匿名fetch复用已注册公开GET，不以Axios计数不变声称没有新增读取。主证据SHA256 `5c3f700a231dc7840bf65d66dc857b3e7c611a48e8be311e8b735fd96e8bcbbc`；parity SHA256 `ed67ffe4e40c8f59b6f95d1f113a7b2120abe85feff690dd3e01f38110391c6e`。

最终定向唯一861项通过：Admin188（本批模型15＋匿名适配器18＋实际SFC38，相邻promotion/community117），Uni204（新真实模板／领取控制器64，相邻140），Worker469（15文件，含新source-binding78和既有V2优惠券7）。本批新增独立213项；重跑不重复计数，接受用例零失败／跳过。Admin／Uni／Worker严格类型及Admin、H5、MP-WEIXIN、App生产构建通过。所有编译器、Vitest和使用TS编译器的Node测试经共享serial wrapper，Vitest单worker、Node test-concurrency=1。最终47个本批／明确未改源与证据文件在合同、相邻回归、MP/App及Worker类型验收区间无漂移；快照不冒称覆盖更早的全部调试尝试。

实际Admin生产产物浏览器以只有dise.view/manage的普通作者进行：空页新增、显式读取真实形状匿名券、五种风格逐个量尺寸、确认只读按钮、设置自定义颜色、保存、重新打开并增加其余四布局、再次保存、错误／空结果／重试。最终两次GUI夹具保存、16次业务请求，0 error／warning，装修JSON只含配置而无公开券DTO或价格资料，独立content保留。1365×1000和390×844页面身份、非空、无框架覆盖层、作者区完整落入视口及无内部横向溢出、截图通过。

实际Uni H5消费这五块最终保存结果，每块5券，共25卡，全部五布局的实际宽高/rpx比、折扣、范围、缺口和仅领券站入口均核验；刷新仅当前块新增一次GET，其他块独立。过期券输出 `UNI-BUTTON disabled="true"`，可领取券没有disabled属性；强制点击过期券也不导航／POST，游客无领取流水。最终20次业务GET，0 error；现有Uni内置vue-router分发文件直接导入弃用warning一条，精确核对并保留。移动390×844和桌面1100×1100截图已检查。初轮用Playwright isDisabled检查Uni自定义元素返回false，原失败收据保留；最终按真实属性、文案和点击行为核验，未修改生产源以迎合测试。

浏览器使用已有Playwright／Chrome（Browser plugin not available）、单renderer和受限JS heap；API全为本地拦截数据，没有外部流量或真实数据库写入。MP/App只有编译和原生事件模拟；真实PostgreSQL/R2、真机／微信SDK、部署后线上端到端及精确头远端CI未验收。本批未提交、推送、合并或部署。原台账字节前缀和88／405条复选记录保留。

机器收据 `/tmp/cinashop-coupon-author/accepted-validation-result.json`；原始分阶段日志、Worker逐文件JSON、源码冻结前后、台账前缀证明和两个浏览器JSON同目录。三个package命令为Admin `test:diy-coupon`、Uni／Worker `test:diy-coupon-author`，CI只追加对应命令。下一族pointsMall已在临时目录固定44键默认、三图片槽、三布局和真实读写边界；只读准备不计作迁移完成。
