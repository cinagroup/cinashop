# 商品分类页面设置：完整合同与本批边界

本批已承接旧 `/admin/setting/pages/product_category` 管理入口及全部十种真实分类、商品、SKU 与购物车消费。下方保留实施起点和完整旧合同；本批实际结果见[验收记录](admin-product-category-style-validation-20261002.md)，属于本地候选，生产、真机及发布仍开放。

## 冻结的起点

- 上一批同城配置最终 manifest：`audit/admin-city-delivery-settings-acceptance-final-20261002.json`，原始 SHA-256 `0ae8df07327a040ca10956bda11b1384de4baa9322d73a754e79d3fdc1800297`。
- 独立 reader proof：`.cache/city-delivery-settings-independent-verification-final-retry1-20261002.json`，原始 SHA-256 `d3e5d9f0281ef5feac234c3acd40fd20955b118958022804f5881e1b4d2b8f0c`，`passed/errors=[]`。下面列出本批精确 incoming 文件。
- 本批 incoming：`.cache/migration-next-baseline-city-delivery-settings-20261002.json`，原始 SHA-256 `c4943be4df2bfabc8419d71ff5ccf788c10e76f292d35b7ef194e852896fd057`，覆盖 8,394 项输入，已逐一校验上一批 8,335 项冻结输入。15 个历史构建目录及 3,937 个原始文件须保留。
- 最新设置台账为 24 candidate、24 partial、23 missing、5 retired；Checklist 246 已勾选、158 未勾选。本批不预先改变计数。

## 旧配置权威与管理行为

旧 Admin `view/admin/src/pages/setting/devise/goodClass.vue` 通过 `diy/get_product_category` / `diy/save_product_category` 读取并保存 `{product_category_diy:{level,index}}`。`product_category_diy` 是提交包装字段；数据库记录为 `system_dise` 对应的旧 `eb_diy` 单例，`template_name='category' AND type=3`。不能误写 `system_config` 或无关 `product_category_level`。

旧 `app/services/diy/DiyServices.php` 与安装 SQL 的服务器缺省为 `{level:2,index:1}`；Admin 初始 `index=0` 只是请求返回前状态。二级允许索引 0–5，三级允许 0–3；切换层级重置索引为 0。旧单例允许 `status=0/is_show=0`，这些字段不否定分类配置。预览卡片滑动或点击可选择，无自动播放。

旧菜单 1593 的 path/auth 精确为 `/admin/setting/pages/product_category` / `admin-setting-pages-product_category`。本批新页面 `/setting/product-category-style` 与 `product_category_style.view/manage` 分离；旧浏览权限仅映射 view。

本批专用 SQL 读取与 CAS 保存须共享一个权威：GET 不初始化；所有相关候选、版本与完整对象扩展字段纳入校验；重复、规范化别名、错误 type、损坏 JSON 显式诊断，不能静默选择第一行。通用 dise 保存和删除须同时检查请求及现存规范化分类名，防止旁路；目录锁须先于行锁。非秘密配置仍需 actor/operationId/payloadHash 绑定的提交收据，明确区分已知 400/409、未知提交与恢复。

## 十种客户端布局

映射来自旧 `view/uniapp/pages/goods_cate/goods_cate.vue` 及四个 `template/template*.vue`。

| level/index | 模板 | 实际消费与导航 |
|---|---|---|
| 2/0 | T1 | 左一级、右二级分组图片；滚动同步左导航；进入 cid/sid 商品列表 |
| 2/1 | T3 | 左一级、顶部二级；大图商品 |
| 2/2 | T2 | 顶部一级、左二级；横排商品 |
| 2/3 | T2 | 顶部一级、左二级；大图商品 |
| 2/4 | T3 | 左一级、顶部二级；横排商品 |
| 2/5 | T4 | 全宽双列商品；二级筛选抽屉 |
| 3/0 | T1 | 左一级、顶部二级、三级图片；二级更多抽屉；进入 sid/tid 商品列表 |
| 3/1 | T2 | 顶部一级、左二级、顶部三级；大图商品 |
| 3/2 | T2 | 同三层导航；横排商品 |
| 3/3 | T4 | 全宽双列商品；三级分组筛选抽屉 |

T2/T3 六种布局包含单规格数量输入与增减、多规格选择及图片预览、购物车清空与数量修改、失效商品提示、精确金额汇总及去结算。T4 两种布局包含商品购买、购物车入口及“重置／确定”筛选抽屉；不能将 T4 描述成旧有 mini-cart。抽屉选择先为草稿，确认后才加载；每组展开收起、遮罩关闭、隐藏及恢复原生 tabbar 均属于合同。T1 的目录与滚动联动也是实际消费。

全部商品布局须验证分页、排列、筛选重置、空状态和迟到响应。保留首页 `cate_selected`、真正分类 tab 入口、theme、页面生命周期与原生 tabbar；不新增全局 DIY 底栏。

## 商品与购买权威

分类树必须限定于实际平台分类模型，安全投影字段，并明确处理隐藏祖先、孤儿、环和容量。分类列表保留 cid/sid/tid 各自语义及旧 id/cid 参数合同，不能把三级点击全部改成 cid。

普通详情是快速购买的商品/SKU 权威。当前兼容 `/v2/get_attr/:id/:type` 混含成本、结算价等后台数据，不能将其原样用于新消费者；普通详情应补安全规格维度、SKU 图片、严格库存、会员十进制报价与购买门控。`cart_button=0`、预售及自定义表单按其真实详情流程处理，不能分类快捷购买绕过规则。

复用现有普通 cart API、actor 隔离的 cartState、精确 cartPrice 和 preparedProductCart。已知成功加购后导航失败须继续同一个 cart；未知结果不自动重复 POST。不得借用积分 type=4 的购买协议。

## 必要完成证据

完成证据须包含十种实际渲染、二/三级与首页定位、所有商品和 SKU/cart 流程、匿名登录与账号切换、库存夹紧、购物车失效与清空、未知提交及导航恢复；后台包含独立权限、并发 CAS、候选损坏诊断、通用保存/删除旁路、公开同权威读取。仅后台表单、静态树、CSS 预览或通过构建均不足以提升此旧入口状态。

Root 统一执行 Worker 类型、Admin/Uni 类型、原生 PostgreSQL 与真实 HTTP、前端运行时、Admin 和 H5/MP/APP 新输出构建、实际浏览器，再生成不可覆盖的 acceptance 与独立 reader proof。所有修改需先保存原字节，声明 incoming 差异；旧报告、测试产物及构建原字节保留。本批不部署、不改生产 DDL/授权，也不将 provider/真机/发布门槛计为通过。
