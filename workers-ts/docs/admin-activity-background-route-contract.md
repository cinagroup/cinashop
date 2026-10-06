# 活动背景旧屏与商品消费合同（2026-09-30，本地候选）

旧 `/admin/marketing/activity_background` 与 `/admin/marketing/activity_background/create/:id?` 两屏由新 `/marketing/activity-background` 列表及 `/marketing/activity-background/create/:id?` 创建/编辑页承接，由 missing 升为本地 candidate。旧页面、Controller 和服务参考位于相邻 `cinashop-php` 目录；旧路由和菜单快照仍是合同来源。候选表示本地可审阅、已验证的实现，发布验收继续开放。

背景固定使用 `store_promotions` 的 `promotions_type=6,type=1,store_id=0,pid=0,is_del=0` 平台根活动。边框和背景共用 `AdminActivityFrameService` 的内部实现，背景薄类只覆盖固定服务器配置，请求无法选择促销类型。类型、日志 `activity_background`、UUID路径及 advisory lock 命名空间与边框分开；背景详情或写入不能读取或修改 type5、门店根活动、派生记录或已删根活动。

| 方法 | 相对路径 | 行为 |
| --- | --- | --- |
| GET | `/marketing/activity-background` | 名称/ID、阶段、活动重叠时间、创建时间、默认15条分页、参与商品数 |
| GET | `/marketing/activity-background/:id` | 完整范围、选中实体及材料 revision |
| GET | `/marketing/activity-background/products`、`/brands`、`/labels` | 搜索、分页选项 |
| POST | `/marketing/activity-background` | 新建平台 type6 根活动 |
| PUT | `/marketing/activity-background/:id` | 保留 ID 的编辑 |
| PATCH | `/marketing/activity-background/:id/status` | 启停 |
| DELETE | `/marketing/activity-background/:id` | 根活动及同类型派生子记录软删除 |

九项接口各注册 `/adminapi` 与 `/api/admin`。GET 要求独立 `activity_background.view`，写入要求 `activity_background.manage`；通用活动或边框授权不代授。旧数字菜单1542只在列表路径及 `admin-marketing-activity_background` 成对匹配时获得查看，1546只在创建路径及 `marketing-activity_background-create` 匹配时获得管理（管理能力包含查看）。旧 `GET set_status` 仍推断为管理。旧列表新增按钮误借秒杀权限，新页按背景权限控制。

表单恢复名称、背景图、上海起止时间、开关、排序和全部/指定商品/品牌/标签范围。图片建议750×152，接受 HTTPS 或站内绝对路径，复用附件图库（另需图库查看权限）。商品选项、保存校验与计数统一使用上架、未删、审核通过的 `pid=0` 父商品，公共消费将子商品归到父商品 ID。旧 PHP 选项限定父商品，但保存只检查上架和未删、全量计数未限定父商品；新审核及父商品口径是明确收紧。跨页选择在确认后采用，取消不改变原范围；详情实体缺失或身份不完整时拒绝编辑，防止静默截断。

type3排除商品是旧UI没有的受控扩展；关系写 `is_all=1`，参与数按真实可展示父商品扣除排除集合。旧服务写排除关系未标该字段且列表固定显示0，不能以错误语义衡量等价。新时间段必须完整有效，结束不早于开始且保存时未过期；阶段时间边界明确包含开始和结束，空分页仍返回真实总数。

写入以管理员、UUID、操作、目标、载荷摘要做事务内幂等，并通过详情revision拒绝并发覆盖。未知写结果在当前页面阻止再次保存，需读列表人工核对；没有跨刷新持久回执，不宣称人工核对能够证明原请求成功。切换账号、移除权限、卸载或取消会废弃迟到响应。

旧删除按 `id|pid` 软删除根和派生记录。本批同时修正边框共用实现：锁住根活动及固定同类型 `pid=rootId` 子行后软删除，包含门店派生行，保留辅助范围与历史数据。异促销类型子记录保留，属于避免跨资源误写的收紧；不递归删除孙记录，与旧一层pid行为一致。

前台已有普通列表、推荐和详情的 `activity_background: {id,name,image}` 消费；本批数据库测试验证 Admin 创建/编辑的 type6 活动真正进入该槽位，排除范围及父商品身份均被遵守。边框及背景的辅助行必须与主活动范围类型一致，指定商品、排除商品、品牌和标签四种范围均验证错位辅助行被忽略、正确辅助行生效，后台参与数与公开消费者采用相同口径；type1–4价格促销保持原合同。商品详情即使 DIY 关闭营销信息也读取背景6；type6从返回的 `promotions` 数组分出，显式type5仍保持边框旧形状。三种卡片槽位可并存，目录按当前商品页面匹配，前批超过200活动的回归继续通过。

本机专项10文件72通过、2个原生并发用例在PGlite跳过；隔离 PostgreSQL16 背景12/12、真实双前缀HTTP2/2、边框7/7通过，夹具0剩余且实例停机。真实 `createApp` HTTP 用例经过JWT、数字菜单角色及实际路由，明确检查登录410000与权限400011拒绝，并覆盖九项接口及幂等、版本化写入和跨类型隔离。两页前端API运行时7/7、Admin类型与生产构建、Worker双类型和严格API审计通过。合成API浏览器在1440×1000及390×844检查身份、内容、无框架覆盖、控制台、截图和实际操作，覆盖编辑、跨页选择/取消、版本化保存、启停确认、只读角色、权限撤销与未知保存禁重提。窄屏日期由截断单行改为完整分行显示；最终合成浏览器中的网络失败只来自刻意中断的未知保存用例。

最新营销48屏25候选/12部分/11缺失，全Admin274屏77/111/79/7；Worker1978、新Admin91业务页、499调用点/523变体全部可执行。旧PHP精确匹配仍903、可执行882、受控不可用21，可行动旧URL缺口984，有效覆盖46.7%；没有旧动态URL别名。Checklist246勾选/158开放/404总项，真实角色、生产素材/数据规模、真实商品渲染、完整Linux CI及发布验收继续开放。代码未提交、推送或部署。数字与验证范围见[本批验收](../audit/admin-activity-background-acceptance-20260930.json)。
