# 商品详情装修本地验证（2026-10-02）

十九键保存、十八项编辑、九模块预览及普通/活动商品实际消费已经完成本地候选。后台入口 `/setting/product-detail-design` 对应旧 `/admin/setting/pages/product_detail`；完整合同见 [product-detail-design-contract-review-20261002.md](product-detail-design-contract-review-20261002.md)。本批未提交、推送、部署或执行生产 DDL/grant。

## 实际终端库存

| 接受证据 | 唯一通过数 | 证明范围 |
| --- | ---: | --- |
| 原生 PostgreSQL/Vitest 库存 | 296 | 255 用例主体真实 SQL/HTTP，41 纯输入/协议；23 文件 |
| Root 纯回归 | 17 | 原分类覆盖 9、商品分享协议 8 |
| Admin 实际 Vue/控制器运行时 | 29 | 完整 model、actor/intent、回执、CAS 与恢复 |
| Uniapp 实际运行时 | 75 | 25 新详情、31 原普通详情、19 原分类 |
| 原海报与主题宿主额外回归 | 3 | 与上述 75 用例不重叠 |
| 源合同 gate 与有意义 mutants | 211 | 22 合同轴；注释、空接线与假 wrapper 不算消费 |
| 实际构建产物检查 | 5 | Admin/H5/MP/APP 页、平台条件、输入绑定 |
| 日期审计报告回归 | 24 | Admin 调用/页库存及 Uniapp 合同 |
| **合计** | **660** | **255 SQL/HTTP、405 其余；重复不累计** |

原生完整库存 `.cache/product-detail-design-native-case-inventory-20261002.json` 使用 AST declaration ordinal 和真实 literal 参数区分秒杀/拼团中四个同显示标签的参数用例，296 独立用例有 292 个不同终端标签。468 个原始 pass 观察包含 172 重复，21 个原失败、34 个定向未选中和 1 个 preflight 失败原样保留；最终 296 项均有接受日志，未匹配和错误为 0。旧 165 项精确复用前批 136 SQL/29 pure 分类；新 131 项按主体核清 119 SQL/12 pure，仅 beforeEach 初始化不算主体 SQL。

接受的原生日志为 category-native-regression-initial、native-regression-initial/retry1、design-native-selection1、product-share-native-final2、selection-finance-retry1/retry2/retry3；具体文件、原始哈希和每个用例证据均在库存中。旧金融断言保留，新增只读表 fixture 与事务观测区分原金融查询和装修投影；预售二十张安全图库与主图回退已真实回归。

Worker unit/runtime、Admin、Uniapp 四套类型通过，Admin 与 H5/MP-WEIXIN/APP 四处构建通过。命令和真实 exit/elapsed/cwd 见相应 metadata：`.cache/product-detail-design-worker-type-final5-20261002.metadata.json`、`worker-runtime-type-final1`、`admin-type-initial`、`uniapp-type-final3`。Root 使用 Node24.14.1、已存在依赖及 PG16.15；Uniapp 借用既有依赖 Junction 后恢复普通目录，锁文件 SHA `71305e06778746ccb3f402588e086cbe14b3bfbadcb7a45a5010322165977240` 保持，未安装依赖。

## 真实编译浏览器

| 实际应用 | 通过组数 | 最终资源与证据 |
| --- | ---: | --- |
| 商品详情后台 | 18/18 | Admin initial 独立 build；admin-browser retry1 |
| 普通商品详情 | 38/38 | Uniapp final3 H5；uniapp-browser retry3 |
| 原商品分类回归 | 31/31 | 相同 Admin initial / Uniapp final3 H5；category-browser final3 |
| **合计** | **87/87** | **实际 Chrome，1440×1000 和 390×844** |

| 六项基础检查 | 结果 |
| --- | --- |
| 应用身份、页面和资源 | 通过，served JS 原字节绑定接受 dist |
| 真实内容与布局 | 通过，19 键/模块、交易与显示价分别检查 |
| 桌面/手机及遮罩 | 通过，新详情面板、SKU、分享、分页实际点击 |
| console、页面与 rejection | 意外为 0，保留有界原 SDK 警告 |
| 截图与视觉核查 | 4 后台、11 普通详情、16 分类截图，已查看代表图 |
| 交互与故障恢复 | 通过，未知加购、换号、刷新、领券/导航失败及真实重试 |

实际 Playwright/Chrome helper 的 raw hash、served JS、PNG、严格错误数组及 HTTP proof 在冻结验收中。18 后台保存 6 个故意 HTTP 故障，38 普通详情保存 5 个，31 分类保存 8 个；都用真实 request/response/console 的 URL/status/时间严格配对，不按字符串大范围忽略。普通详情 42 条、分类 25 条原 SDK 警告绑定固定原脚本；其余错误与警告为 0。普通详情真实触发四次 SDK script load，用固定 SDK 响应证明加载器，不硬塞空 `wx`。

修复了两个实际编译发现的问题：空 `window.wx={}` 不具备五个 SDK 函数，必须真正加载；新增种草页不能成为首页，`pages/index/index` 恢复 manifest 第一项。原分类后台手机轮播预览字幕局部重叠是前批既有视觉边界，未把历史画面描述成全部完美。当前 Browser 插件未安装，因此使用既有 Playwright 和 Chrome；建议安装插件供后续直接浏览器复核。

## 构建与原始保留

接受目录为 `.cache/product-detail-design-builds-20261002/admin/initial` 和 `uniapp/final3/{h5,mp-weixin,app}`。Admin 构建前采集 535 输入（534 text、1 binary），按实际 Admin/common 范围绑定；Uniapp final3 构建前采集 539 输入（538 text、1 binary），按实际 Uniapp/common 范围绑定。输入时间早于真实构建开始，当前原字节与捕获副本匹配。Uniapp final2 的旧尝试和所有类型/浏览器失败仍保留，最终证明使用 final3。

入批基线 `.cache/migration-next-baseline-product-category-style-retry1-20261002.json` 包含 14337 条摘要（2901 source、180 reference、11256 raw）。每条实际变化必须由 owned source 和与入批相等的 first-before 解释，reference/raw 原证据保持。19 个旧构建完整目录、5091 个文件保留，防止只验证旧文件而遗漏新混入文件。

13 个本批 PG 的 `pg_ctl status=3`、无 listener、data 正确归属和配置捕获字节已逐项核实，随后仅删除 data；日志与配置保留于 `.cache/product-detail-design-postgres-cleanup-final1-20261002.json` 的证明链。浏览器/PG 本批 23 个端口以及前批 18 个端口由独立 reader 查询。冻结验收 [product-detail-design-acceptance-final-retry3-20261002.json](../audit/product-detail-design-acceptance-final-retry3-20261002.json)，独立只读结果 `.cache/product-detail-design-independent-verification-final-retry3-20261002.json`；reader 不执行 writer、测试、审计或浏览器 producer。

首次完整 reader 发现部分旧构建文件虽在完整目录清单中，但缺少 raw 摘要组索引，停在 `fab-builds-20261001/uniapp/h5/assets/address-CCMgfSru.css`。首次 manifest、reader、失败 proof 与当前源副本原字节保留；retry1 新文件将全部 5091 旧构建文件显式加入 raw 组后重新独立读回。这是验收封装修复，产品源、接受测试和构建不变，也不累计新的通过用例。

完整 retry1 已核过 5091 旧文件、1200 新文件、1155 个实际范围构建输入，随后发现 gate 使用的既有 `view/pc-ts/src/api/product.ts` 尚不在摘要组。72 个 gate 输入中仅此一项缺少登记；其检查前后 raw/LF 摘要一致。retry2 补上这份只读源的摘要和原字节副本，保留前两次所有文件，再执行完整独立核验；PC 文件没有改动。

完整 retry2 已独立确认全部 660 个唯一用例和 87 组浏览器及其 87 份 served JS，随后报告核对发现本批新日期审计 JSON 尚未加入 raw 组。retry3 显式绑定全部日期报告、聚合器引用的各台账和前三份验收快照；失败记录原样保留，产品源、实际构建及通过数不改变。

## 路由分布与剩余边界

Worker2194；PHP1904 中911匹配、890可执行、21受控不可用，993未匹配中17退役，余976可行动，有效覆盖47.2%。Admin111业务页/592调用/623变体全部可执行；设置76屏26candidate/24partial/21missing/5retired，全Admin274屏92/114/60/8。Uniapp97当前页/151旧路由仍28direct/100rule/23gap，rule中62candidate/38partial。日期报告单独保留，原报告不覆盖。Checklist246勾选/158开放/404总项保持。

浏览器是实际编译资源上的合成 API/SDK，真实 SQL/JWT/HTTP 分开证明；不能等同真实支付、微信账号、provider、设备或生产。完整购物车既有六键促销 KV 故障会拒绝，不能悄悄忽略。PC 共享 API 已消费但 PC UI 全部装修、砍价独立流程、生产权限/Hyperdrive/规模/正式发布及 158 个整体开放项继续推进。

只读后续合同审计建议下一批承接完整个人中心：旧后台 `cinashop-php/view/admin/src/pages/setting/devise/users.vue` 六模块（会员信息、订单中心、订单统计、广告位、个人菜单、商户菜单）有预览与整体保存，旧客户端逐模块消费，而新 `view/uniapp-ts/src/pages/user/index.vue` 仍是固定布局。现有 `PublicCatalogService.menuUser` 已读 member/type3、菜单和广告，适合补专用管理、原子保存和真实消费；本批未把这块记作完成。其后是开屏广告完整轮播、客服人员 CRUD/记录筛选及店铺/专题视觉编辑。Uni23项含16旧移动管理跨端替代，不能全部当作缺少顾客页面；976也不能当作未完成页面数量。
