# PHP → TS：商品选项卡 DIY 作者与公开委托（2026-10-25）

本批承接 community，补齐 `promotionList` 作者及实际公开消费路径。固定 PHP 基线为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。整个 PHP → TS 迁移仍未完成；DIY 商城作者还剩 coupon、pointsMall、presale、combination、bargain、seckill、liveBroadcast 七类，父级 FE-001／FE-003、生产及真机验收继续开放。

## 原件与完整默认

- `view/admin/src/components/mobilePage/home_product.vue:133–426`：完整 defaultConfig，共30个顶层键及全部嵌套字段。原件 SHA256 `c6e6a1525a6e8a6640ba5458ff1bc2a8eb6c2bb9f09d392b77de3735c58debf3`。新默认仅替换 `this.num`，没有图片 require；静态默认紧凑字面量 SHA256 为 `56836da289757873d8b7d95ebf3ff65df4c445980d0646434a2804178352be90`。
- `view/admin/src/components/mobileConfig/c_home_product.vue` 与 `mobileConfigRight/c_promotion.vue:27–138,201,269–374`：实际外层控件、四类来源、图片与材料选择。后者原件 SHA256 `96a9ee32103ce253cd9dc7f18d4ffdde9bc8193b32dc53ab6fb19904bad65dec`。
- `view/uniapp/pages/index/components/promotionList.vue:5–30,196–267,279–345,420–675`：五种导航样式以及委托 `goodList` 的实际模板、watcher和创建过程。SHA256 `fcbdb487dcb34cc5650101daca593165c748332e1c91a5536a3d3d530f39ee71`。
- `view/uniapp/pages/index/components/goodList.vue:627–645`：真正的商品请求。SHA256 `8d321aefec7d26ee00f0e8e6f1b3ed58f77b4e8f6552095cefdae8bdaa4b69bf`。promotion 原件中引用已注释 import 的 `getGroomList` 死方法不是消费依据。

PHP完整原文、关键行、完整默认和实现文件哈希存于本批 parity 审计；没有生成替代视觉素材。

## 作者行为与保存

`DiseList.vue` 接入新 `DiyPromotionEditor.vue` 的实际 v-model 与原 save。组件和选项卡均支持添加、选择、排序、删除；编辑显示、标题／简介、四类商品来源、材料范围、数量、来源排序、图片、五种导航样式、置顶、按钮、主题／自定义色调、颜色、边距和背景圆角元数据。指定商品与商品标签的材料／ID成对修改，未知材料字段在无关编辑中保留；真实目录仅提交明确的 kind/id/name，不把目录预览图、价格或公开商品 DTO 存入配置。`content` 继续独立保存。

新增选项卡使用完整初始默认，不延续 PHP copy-last／localStorage 中上一项的商品、图片和范围。原 PHP未证明限制选项卡数量，`goodsList.max=20`也不是本批擅自执行的硬上限：13项及超量材料的完整导入仍可查看、删除和排序，作者不会截断。公开消费者只展示前12个原始选项卡。普通新增选择沿用当前TS列表100项边界，整个JSON仍遵循2MB／10万节点／64层完整校验，失败不做局部提交。

数值字符串、零、微小数与完整导入值在挂载／等值事件中保持原拼写；真正用户输入才应用现有数量规则。导入来源0按原Uni有效分类3消费但不主动回写0；坏字符串、null、空串、对象、数组、布尔来源明确无效，不从保留的分类范围意外发出商品读取。

目录复用已有 `dise.manage` 只读作者 API：`/dise/author-options/list-products`、`list-brands`、`tab-targets?kind=product_category`、`list-labels`。支持品牌父子级，不要求宽泛商品管理权限。商品预览必须显式匿名 `GET /api/products`，使用 omit/no-store、Accept和原AbortSignal，不携带后台凭证。图库要求已有素材查看能力，保存稳定 `/api/assets/:id`，仅完整匹配当前公开配置的已发布GET可授予图片预览。

全部实际普通控件事件、图库／目录选择、公开响应绑定原账号、会话、页面、组件、选项卡、JSON和代次；A→B→A不能复活旧回调。一个v-model回执只消费一次，不能将后续外部相同JSON误认为自身写入。新组件的默认选项卡在真实Vue排队或延迟父级回写后自动选中；同分组的普通样式修改保留材料选择位置和相同查询的公开商品结果。读按钮与只读预览不会访问详情、规格、购物车、订单或浏览计数。

## 真实公开委托与视觉

HomeRenderer 将 promotion 单独交给 `DiyPromotionWidget`，由共用纯投影构造固定双列 `goodList`，实际挂载原 `DiyListWidget`／`DiyListProductCard`／列表读适配器和购买控制器。其余七族Commerce分支保持原实现；旧Commerce四模块原字节保留，兼容直接调用测试仍通过。

固定商品按所选ID顺序消费，并按原实际请求忽略保留排序；品牌、分类、标签使用对应范围与排序。当前TS继续显式发送page=1和受100限制的limit（PHP固定ID分支没有分页参数），不因此宣称请求字节完全等同PHP。卡片固定原双列、图片圆角8设计px、六项信息、正常标题字重和既有主题商品价格，选项卡色调不会改变商品资料。切换分组会卸载原子列表；即使两组商品ID相同，旧卡片点击／测量或异步购买回调也不能作用于新分组。

五种导航分别为标题＋简介、下划线、底部圆弧、胶囊、圆图＋标题。实际原模板中的选中颜色、渐变、字体和尺寸用于共用Admin／Uni样式投影：样式二文字固定#282828，样式四／五选中文字白色，自定义强调色用于样式一／三。`textColor`、`textColor3`、`decorateColor2`和背景fillet在原活跃公开模板没有有效使用，作者明确作为元数据保留。上下边距、左右边距、背景和页面上间距只应用于导航容器；委托商品列表自己的垂直间距为0。

原760px装修弹窗改为`min(760px, calc(100vw - 24px))`，在小视口中保持完整控件可达。Uni导航采用组件内sticky，叠加已测头部与Uni宿主顶栏偏移；普通非置顶导航top=0保持正常文档流。浏览器截图发现的非置顶44px偏移／覆盖商品问题已经修复，并在H5、App、MP实际编译模板各补回归。没有据此声称所有多头部组合或真机滚动均已验收。

## 媒体与权限边界

作者、Worker和Uni统一只识别 `tabConfig.list[*].image`；隐藏、非图片风格和前12项以外的所有图片同样受校验。`goodsList`、`productList`、品牌／分类／标签材料、DTO或未知字段中的相似URL不获得作者媒体能力。JSON不进行HTML实体解码。

Worker复用当前平台附件归属、类型、key、MIME与光栅格式校验；普通素材预算仍2500，2501在SQL、签名前原子拒绝，独立预算保持。没有新增业务路由、生产DDL、数据库GRANT或ACL。Uni将这些槽纳入页面截止时间、意图指纹和续签；仅票据更新保留当前分组且不重复读商品，过期／owner变化／卸载后的原生图片load/error和点击全部失效。MP/App包内静态图片保留本地路径，不需要浏览器window或URL全局。

## 审计与最终验证

本批 source-binding 先精确逆转16个修改源，再验证旧community／editorial／follow／state等历史证据；13个新实现／测试全文另行固定。旧dated报告和helper原字节保持。旧Home迁移断言现在核验promotion独立分支→控制器→goodList投影，同时精确保留七族Commerce集合、原路由和危险渲染否定断言；原完整测试作为本批before快照可逆恢复。

API原全量报告逐字归档，当前Axios清单仍703调用点／741已注册可执行变体，只有DiseList源hash与三处旧调用行号各增加3行。显式匿名fetch读取复用现有公开API，不以Axios计数不变声称没有新增读取。主证据 SHA256 `fd3f186922cad714f642ec7b0dfc7a28ed96b5791f2cdab934d95ff697bd9b6b`；parity SHA256 `2aa9f63d0e2b2ea4e9f28586f751191488081d302ee609eb9bab17c66815104a`。

定向唯一用例772项通过：Admin196（新模型30＋实际SFC54、相邻112），Uni192（新实际委托／原生事件52、相邻140），Worker384（13文件，其中新媒体27＋新source-binding77）。本批新增独立240项，重复执行不重复累计；接受用例零失败／跳过。Admin／Uni／Worker严格类型及Admin、H5、MP-WEIXIN、App生产构建通过。所有编译器、Vitest和含TS编译器的Node测试均经共享serial wrapper，Vitest单worker、Node test-concurrency=1。构建器既有警告与相邻旧测试的EventTarget监听数warning保留；最终真实浏览器健康另行核验。

真实Admin生产产物以本地拦截API／素材验收：空页面新增后直接编辑默认分组，指定商品17/18选中并重排为18/17，品牌父20→子21、分类29、标签37，五种样式、图库71、保存、重新读取已发布图片、添加独立第二组件并再保存、错误／空结果／重试。最终两次GUI夹具保存、27次业务请求，0 error／warning；1365×1000与390×844页面身份、非空、无覆盖层、作者区域无横向溢出和截图通过。JSON只包含稳定图片引用与材料ID，不包含签名、公开价格／商品资料，独立旧content保留。

实际Uni H5消费上述最终保存结果：首组忽略作者tabCur从第一选项卡开始，依次切换品牌／分类／标签，不影响第二独立商品；刷新只增加当前列表GET。样式五与样式四在真实浏览器显示，全部五样式另由真实编译模板和Admin GUI覆盖，不虚称五次H5浏览器布局验收。移动390×844、桌面1100×900的页面身份、非空、无覆盖层、sticky顶栏44px和非置顶导航不覆盖卡片的几何断言及截图通过。20次业务请求全部GET、0 error；唯一warning为现有Uni嵌套vue-router直接分发文件导入弃用，精确记录并核对来源，没有忽略其他警告。

Browser插件不可用，采用现有Playwright与Chrome、单renderer、受限JS heap；未安装依赖。浏览器只有本地夹具，无外部流量／真实数据库写入。MP/App仅构建及原生事件模拟，不代表真机、微信SDK、真实PostgreSQL/R2、线上端到端或精确头远端CI。本批未提交、推送、合并或部署。

初轮测试失败日志、最后一次浏览器失败收据和早期源码快照保留；浏览器调试过程的其它尝试仅有会话工具输出，未补造完整逐轮日志。已处理的问题包括：模型身份／测试宿主时序断言修正、旧Worker通用商城断言、真实新增默认未选中、样式旧回调遗漏、H5非置顶偏移，以及浏览器控件定位／夹具参数／保存结构断言失误。最终按受影响范围重验，接受收据单独保存，不将失败检查计作通过。34个本批源码／证据文件最终冻结检查独立记录；最初快照和修复前快照同样保留，最终快照不冒称覆盖所有早期尝试。

机器收据位于 `/tmp/cinashop-promotion-author/accepted-validation-result.json`，包括唯一计数、分阶段退出码、源码漂移和台账前缀／复选行证明；原始测试日志、Worker逐文件JSON和两个浏览器JSON在同目录。Admin新增 `test:diy-promotion`，Uni／Worker新增 `test:diy-promotion-author`；CI追加测试命令并保留旧链。下一族coupon只读来源准备不计作作者迁移完成。
