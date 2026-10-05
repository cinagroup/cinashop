# 个人中心六模块验证（2026-10-03，本地部分完成，未发布）

旧 `/admin/setting/pages/home` 已接独立 `/setting/user-center-design`。会员头部、订单、运营统计、广告轮播、服务菜单和商家菜单六模块可完整编辑、保存和预览；五种会员风格、九项真实资产、三种订单风格、两种统计风格及三种菜单风格接入实际客户端。历史 ID4 视频收藏恢复真实列表、分页、取消和安全视频入口；会员码显示当前账号真实六位码、本地 QR、实际到期时间及默认隐藏余额。

后台与公开端共同读取 `member,type3`、`routine_my_banner` 和 `routine_my_menus`。只读快照不初始化，显式空列表有效；保存用完整集合 revision、独立 view/manage、actor/UUID 回执及同一事务。三份共享数据不一致时清楚诊断并显式确认，额外旧共享项停用且原值保留。商家项只能改名称、图片和顺序，固定 URL 与角色身份不能被编辑赋权。两次公开读取同时核对 actor、revision 和 `consistency_key`，配置或角色改变时拒绝拼接旧资料。未知写回执按原账号保留完整意图，只有原回执或匹配的写前证明解除，不自动重发。

整屏保持 **partial**：26 项连接门控中 24 真，旧商家订单管理/发货等实际操作与工作台、客服、配送角色目标仍未完整迁入。核销不替代这些功能。旧微信会员码 provider 分支、原生客服、外部小程序、真机/扫描/支付渠道、生产授权与 Hyperdrive、规模与发布继续开放。现有库没有通用 group CRUD；本批保护实际三个固定 namespace 写入器及通用 DIY，直接高权限 alias 导入维护仍须停写或使用同一协议。

日期快照 `user-center-design-followup-20261003`：Worker **2206**，旧 PHP **1904** 条路径，**890** 可执行精确匹配、**976** 可行动 URL 缺口，有效覆盖 **47.2%**。Admin **112 业务页、598 调用点／629 变体**全部注册且可执行。设置 76 屏 **26 候选／25 部分／20 缺失／5 退役**；全 Admin 274 屏 **92／115／59／8**。本批个人中心 missing→partial，既有完整候选逐项保留。Uniapp **98 实际页**，151 旧路由 **28 直接、101 兼容、22 缺口**；兼容 62 候选／39 部分。Checklist **246／158／404** 保持。

| 路由文件面 | 旧 PHP | 新 Worker | 旧路径可执行匹配 | 未注册且未退役 |
| --- | ---: | ---: | ---: | ---: |
| API（含 Admin 兼容别名） | 457 | 1145 | 438 | 11 |
| Admin 主文件 | 1153 | 786 | 230 | 908 |
| 供应商 | 182 | 164 | 121 | 49 |
| 客服 | 63 | 70 | 60 | 0 |
| 对外接口 | 41 | 41 | 41 | 0 |
| ERP | 8 | 0 | 0 | 8 |
| **合计** | **1904** | **2206** | **890** | **976** |

## 实际验证与证据边界

当前输入的 Admin 运行时 **32/32**、Uni 运行时 **48/48**、源与 mutant 三套 **295/295** 通过。Worker 去重 482 项通过：30 项新增真实 PostgreSQL/SQL-Hono HTTP、30 项既有装修回归、163 项真实金融 SQL，另 259 项协议/单元/嵌入 SQL；20 项线下收银 workerd HTTP 在进入业务断言前被环境阻断，不计通过。 四套类型检查及 Admin/H5/MP-WEIXIN/APP 四处独立资源构建通过。最终实际编译浏览器 **48/48 组**（Admin 22、Uni 26），桌面 1440×1000、手机 390×844；意外 console、页面异常、rejection、HTTP、请求和未归因警告均为 0。故意故障及 SDK 警告按实际请求/编译文件严格配对。失败、重复、初始化诊断和过时输入保留，不计最终通过。

受影响的旧线下收银 HTTP fixture 已按真实已审阅 0176 安装流程修复 owner/catalog 就绪缺口，发布审计与收银权限条件保持。随后两次独立尝试（包括 workerd/postgres 全部退出后的完全串行重试）均在 Miniflare getKVNamespace 阶段遭 Windows workerd 0xc0000005 启动崩溃；20 项业务断言未执行，明确保留为环境阻断。10 个本批 PostgreSQL 集群已核实 pg_ctl status3、端口拒绝、fixture remaining0，workerd/postgres 进程为 0；诊断 data 与配置/日志保留。会员码期限场景使用确定性 provider 存储配合真实 SQL 当前账号，未冒称 live Redis/provider 集成。

浏览器为实际新 dist 上的受控 HTTP 场景，不能证明 SQL、真实支付或 provider；真实 PostgreSQL、JWT 与 HTTP 合同另有终端回执。仅复用已安装依赖；没有 Browser 插件，因此按 frontend-testing-debugging 使用已有 Playwright 1.62.1 与 Chrome。安装或启用 Browser 插件可让后续交互审查直接在应用浏览器中进行。

| 六项页面检查 | 实际结果 |
| --- | --- |
| 首屏清晰、身份资料与主操作可见 | 桌面和手机通过 |
| 主要用户流程能完成 | 六模块、选择/保存、收藏及付款码通过 |
| 控制台错误和未处理异常 | 未预期 0 |
| 资源、HTTP 和外部请求 | 未归因 0；受控故障保留 |
| 响应式布局与可见操作 | 390×844 无横向溢出 |
| 空态、错误、恢复和账号切换 | 实际交互通过 |

## 冻结与保留

入批 20468 条 source/reference/raw 摘要逐项分类，所有既有修改有原始 before 字节。26 个历史构建目录、7234 份文件原样保留；新产物独立输出，旧失败与过时产物完整保留。producer 源冻结、完整预构建输入、终端日志、编译 JS 和截图都按 raw SHA-256 绑定；独立 reader 核对每条入批分类、文件与目录库存、实际测试/构建/浏览器日志以及自有端口。

本批没有提交、推送、部署或修改生产 DDL/grants。完整迁移、旧管理操作和 provider 验收仍按开放项推进。

详见[合同](user-center-design-contract-review-20261003.md)、[验证](admin-user-center-design-validation-20261003.md)、[日期分布](../audit/route-distribution-user-center-design-followup-20261003.json)、[设置台账](../audit/admin-legacy-setting-route-parity-user-center-design-followup-20261003.json)及[冻结验收](../audit/user-center-design-acceptance-20261003.json)。
