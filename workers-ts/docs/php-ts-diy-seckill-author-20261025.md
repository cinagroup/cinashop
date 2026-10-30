# PHP→TS DIY 秒杀作者迁移（本批已验收，整体迁移继续）

本批完成seckill完整作者、四种真实公开布局、分段倒计时、三个作者图片槽及两个窄公开目录修正，组件/SQL/类型/四端构建/真实Admin与H5浏览器和最终合同均通过。本批秒杀作者闭环验收，整体PHP→TS迁移仍开放，liveBroadcast及其它父项继续推进。

## 固定来源与完整作者

固定PHP `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，原home_seckill.vue229–792完整53键默认；c_home_seckill作者49控件和公开seckill.vue457行、countDown、BaseMoney、easy-loadimage及父活动目录来源均完整固定。

| 原件 | SHA256 |
| --- | --- |
| view/admin/src/components/mobilePage/home_seckill.vue | `0257cf8fe9919e1554be25826d06d87d4d91706b80be45401c84998ee5beffa8` |
| view/admin/src/components/mobileConfig/c_home_seckill.vue | `0e2cd44807494ee09f6ef02803016636840509e1372a80fd0cfbabc870543426` |
| view/uniapp/pages/index/components/seckill.vue | `0c8fac4a1cb339a5298f37b8f3bf57426536b9702f785552010fc2055a781576` |

新建只替换timestamp和三项明确图片引用，53键完整字面值compact SHA `1585380fd914c59c16da9de5ad7c978006dfaaead80ff6013b01ff6ccf0daa20`。默认数量3，数字checkbox0/1/2/3对应名称/进度/价格/划线价。导入不合并默认、不剪裁超量，不修复0/tiny/指数/空白/数值字符串或typed集合的未知/重复/原顺序；同数字/同集合事件为noop。窄setter验证完整候选后原子写入，父v-model完整回执、actor/page/选中项/raw/代次与图库能力沿既有作者边界。

26项真实颜色均可编辑；seckillPriceColor2、progressTxtColor、goodsBntTxtColor及numberBgColor两套的第二色为存档，原公开组件没有这些效果，不扩成新公开行为。完整未知/隐藏/备用及独立content不变。普通新数量1–100；当前TS公开floor/clamp10000/min10，缺失/非法fallback6。固定PHP只读取未包含的LIMIT配置，不把10或100称作原PHP上限。

## 四布局与计时

| 布局 | 真正公开差异 |
| --- | --- |
| 单列0 | 图240×240、内容高240、名称80/28/40；进度始终存在，无checkbox1gate。track240×24、lightning28×28，100%端点原式107px；售价前缀“秒杀价”24，BaseMoney24/36/36；可选144×56“去抢购”。 |
| 双列1 | 图高324/gap22、名称两行28/40/上16、价格区上10；无进度，可选按钮，划线价check3。 |
| 三列2 | 图高212/gap18、名称26单行；150×44主题45deg渐变价格条，即使check2关闭仍有条和shandian装饰；售价白字，不消费演示seckillPriceColor2，无抢购按钮。 |
| 横滑3 | 图224、左20、名称宽222、价格区上16；check3仍显示旧价；可选66×40“抢”及原shandian边缘装饰。 |

模块和图片四角均0/1/3/2，头部0/1、单列底角0/1；纯色头部color0/0，主题按钮gradient→theme、自定义色1→0，进度主题45deg gradient→theme/custom90deg色0→1。真实父activity_image覆盖每个布局的商品图，基础图片load成功后才显示，base/overlay错误和旧native事件单独失效。固定两张标题PNG实际154×32（原提示同尺寸），公开头部仍140×32。

倒计时明确为HH / : / MM / : / SS五段，只有数字块有背景，padding0/8、圆角4、字号24、行高40；冒号颜色等于数字背景色，两套style字段独立。isDay=false时小时可超过24，归零不自动切时段或发新列表（原DIY未监听endTime）。计时器由当前读取代次拥有，卸载/账号/raw/active/重读停止旧计时器。Admin375px封顶/cqw等比及normal行高；原107px只在Admin预览换成214rpx随容器缩放，公开原生保留107px。

新增可读性规则：金额保持一行；三列超138rpx保守估宽预算的长金额等比收小符号/整数/小数字号，短金额和其它布局仍24/36/36，150×44条与完整业务金额均不变。该适配及checkbox窄屏换行均不是原PHP规则；现字体fallback不声称旧字体像素一致，真实浏览器以价格条内金额bbox验收。

原PHP旧价computed返回裸字符串却绑定数组style，本批未运行旧Vue验证其实际颜色。TS保持已有显式goodsPriceColor投影，不能据静态原式声称旧runtime支持自定义颜色。金额保持当前规范化两位/千分位/全角￥，不改购买金额。

## 匿名读取、导航及已迁移排期

原DIY先index→server seckillTimeIndex→选定slot list，无时段切换UI、SDK/模板GET或点击登录gate。新Admin显式匿名二读，omit/no-store/Accept/同AbortSignal，在每个await后复核取消；完整≤1000slot/索引及商品全尾验证，不静默截断、过滤或改选其它时段。Admin有效数量0无IO，index=-1不发list，DTO/price/业务图片/签名不保存。

独立Uni API/feed用原匿名两GET，在index返回后先核对owner/完整去票据authored intent/active/代次，再决定是否发list；列表返回再核对。没有订阅、后台picker、商品/slot新metadata或写接口。卡片guest直接到canonical seckillDetail的child活动ID，更多到activity index；卡片内按钮仅装饰并冒泡同一入口。

原PHP childID+time_id曾真正参与旧详情读取。当前已迁移canonical详情只读childID并重新加载即时排期/SKU授权，本批保持该已有购买合同，不声称附加被忽略的time_id恢复旧语义，也不扩大修改购买系统。上海时区、[start,end)、24:00、同start按idASC、child/parent/slot交集、NULL legacy、无效/缺失slot关闭和购买时重验均保留；不退回PHP宽松目录规则。

## 两个窄producer修正与素材权限

StoreSeckillDao.getByTimeId仅增加基础store_product innerJoin/isDel0，在LIMIT/OFFSET前过滤缺失或已删基础商品；仍平铺完整活动列、原sortDESC/idDESC和完整SeckillScheduleQuery。没有新增基础isShow/isVerify/stock/quota门槛，getById及其它DAO不变。

ActivityService.seckillList按本页唯一正父ID批量读取storeActivity.image，经过现publicSeckillTimePictures→renderSeckillTimePictures业务安全投影，再按父ID关联；activityId0为空图，不抓取外部URL。业务图片政策原字节未修改，不把activity_image加入DIY作者授权；bargain原修正、其它service方法、购物车/订单/库存/并发系统不变。

仅imgBgConfig.url/imgConfig.url/imgColorConfig.url三个作者槽纳入ordinary2500及现current平台归属/type/MIME/key/raster，包含隐藏/备用/超量组件；业务图、unknown、lightning/shandian不扩权。完整block+slot+ref临时图库cap与已发布canonical整块匹配；首次过期不读feed，票据同意图/同owner准入续签复用index/list，旧owner/raw/active/ABA/nativeepoch/expiry/unmount回调不跳转/更新新资料。

三个作者原PNG和两个公开静态装饰双端共10份原字节保留，来源/尺寸/SHA在parity.assets，装饰行明确author_slot=false。业务图片/倒计时/读取结果不进入作者JSON。

新真实内存Postgres/Hono套件覆盖11表/序列快照、父图关联/安全/签名、删除base/分页/排序、排期边界、getById及重复GET无写；旧activity-list兼容mock增加本页父读取，两个旧SQL夹具只补真实base，不删旧expect/负例。内存SQL证明不代替native PG16锁、多连接或外部服务验收。

## 运行证据与浏览器

去重 **2,981项** 测试通过，本批新增独立 **473项**；早期重复目录、媒体和来源运行不重复计数。

| 范围 | 新增 | 相邻/既有 | 唯一合计 |
| --- | ---: | ---: | ---: |
| Admin | 140（model28/data22/实际SFC90） | 631 | 771 |
| Uni | 142（真实Widget/Card/Money、三平台native/lease/两读/倒计时） | 817 | 959 |
| Worker | 191（media26/catalog51/source与parity114） | 1060 | 1251 |

Admin/Uni/Worker严格类型、Admin/H5/微信/App生产构建均通过。Worker30文件单worker含旧来源/媒体合同、精确API清单、真实内存SQL/Controller和两份旧目录/商品图回归。33 modified完整前序逆变换、21 full-add、10原PNG、33旧dated/helper/fixture及原危险负例、43 unchanged来源均核对；三端专用命令和两条CI原命令链只追加。

source `d4597335e250a2ef408f13da19bbc9de0c20a7e3fc4f639feac29fb0552e7be8`；parity `634203d09f520c35a49cec6e97a9e58281a5813734ba2dce0a53aee0aa0f3f1b`。API实际TS parser再生成 `cc24230caab91c9a80c8ee4eba659767f28b7f1533d6bf1e3a42976abfdec16b`，仍703/741全注册可执行，仅DiseList hash和三个旧调用行号各+3。匿名fetch/原生GET由独立数据套件证明，不虚增Axios覆盖。最终69源码/证据在最后Worker合同前冻结，完成后逐字节无漂移；不声称较早运行均从该时点开始。原总账完整前缀和88/405条checkbox文本行均保留，仅追加本批事实。

首轮来源运行已执行242例全过，但旧拼团suite因新增外层wrapper括号使sha未定义而未加载，其0例不能计通过。仅修测试adapter的关闭位置，全部旧断言/负例和生产代码保持；失败JSON/日志与首2个已成功运行步骤完整归档。续跑只补失败来源及尚未启动的类型/构建，最终30文件全部通过，运行不重复累计。

Worker首次严格类型检查指出新媒体夹具仍引用已移除的砍价fire字段。改为显式断言实际activity_image/lightning/shandian均保持不变且无作者权限，不加any、不删用例、不改生产。原TS2339收据归档，随后来源合同和严格类型重跑，最终媒体26例以当前源在完整Worker运行中的结果计一次。

安装的compileTemplate默认cacheHandlers:true，原生member事件缓存会动态读取当前props。本批秒杀图片和更多/刷新按钮改为局部render descriptor，卡片以native epoch退役，Admin预览卸载关闭回调；只改新增秒杀实现。两个新增runtime套件显式启用生产缓存，原87/142项完整保留，并补Admin真实img回调的换源/同ID换对象/卸载回归；两套件以生产缓存选项重跑通过，随后重跑两前端严格类型和Admin/H5构建。早期缓存选项较弱的重复运行不增加唯一计数，不据此泛化其它作者或宣称设备E2E。

真实手机首轮在224px编辑区测得checks宽241.796875/scrollWidth242，原几何断言阻止验收；截图同时显示三列分段大金额换行。仅本批checkbox容器/文字允许自然换行，金额显式nowrap保持同一行，150×44条与24/36/36字号均不变。固定PHP没有显式nowrap，此为明确的可读性修复；保留现字体fallback，不声称旧字体像素一致。当前90/142 runtime、两前端类型及Admin/H5构建重新通过，再用未放宽的224px几何和实际金额bbox验收浏览器。原失败与诊断截图均保留，早期运行不重复计数。

上述DOM检查曾通过但人工截图发现三列长金额伸出150rpx红条后白字落白底，故明确门槛在source-seal前拒绝封存。新增seckillMoneyTypography仅对三列超预算长金额按138rpx保守字宽预算等比收小三段字号；短7.00和其它布局仍24/36/36，完整金额与150×44条不变。这是新增可读性修复，原PHP没有此规则。142例保留并增加实际长短Money行为断言，不用估算公式镜像测试代替真实bbox。最终90/142 runtime、两前端类型和Admin/H5构建及两真实浏览器重新通过；金额bbox须在红条内且整数/小数同一行。MP/App构建开始晚于17份当前生产源快照且完成后字节一致，复用该实际构建，不重复跑相邻或原生构建。旧通过DOM/问题截图和拒绝封存日志保留，不重复计数。

实际Admin普通level1（dise.manage/view+attachment.view）完成2次GUI保存、31业务请求、0错误/0警告；server index1选slot4、四布局各3商品、完整53键保存、2项真实颜色GUI修改（全部26颜色由SFC覆盖）、三图库槽稳定保存、已发布整块匹配、错误/空结果/重试均通过。390px手机224px预览等比，无横向溢出或金额竖排。

实际H5四组件12卡，真实base load后的父图叠层、三段数字与两冒号、单列始终进度、三列价格条、横滑旧价、刷新、guest活动ID17直达详情及更多均通过。39个业务GET，0错误；仅1类既有Vue Router warning，完整保留1条页面载入事件。H5无wechat/teml_ids、无journal写入，业务ID不是base product1017。Admin手机与公开四布局5张截图经人工核对。全部API本地拦截，详情刻意不可用，不声明完整购买、真实账号或微信插件可用性。

所有测试/TS parser/类型/构建经共享validate-serial.sh串行，Vitest单worker、Node单test-concurrency。首轮Admin SFC79/87：8个失败来自测试沿用不存在的砍价提示输入捕获，已删除该旧夹具捕获，所有秒杀真实26色及实际文字/controls仍完整覆盖；生产未为夹具增加输入。原失败日志留存，复验87/87通过且不重复计数。

Browser插件不可用，沿用现Playwright/Chrome、Node192MiB、单renderer/128MiB。验收路径为Admin /content/dise→53字段作者/显式index与server默认list/四布局/图库/保存/错误与重试→真实H5消费保存JSON/业务叠图/分段倒计时/刷新/guest活动ID详情/更多。桌面与390px已核对身份、非空、无框架overlay、console、截图、几何与实际交互。所有API本地拦截，不声明生产/真实账号购买E2E；微信/App构建不代替设备。既有H5 Vue Router直接dist导入弃用warning单独记录，其它错误/警告不可忽略。

Admin/H5/微信/App构建通过；未进行native PG16、真实R2、微信设备、生产购买或远端exact-head CI。未commit/push/PR/merge/deploy，整体迁移保持开放。
