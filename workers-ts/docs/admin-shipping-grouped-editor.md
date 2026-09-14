# 总后台完整运费规则编辑候选

## 商品域运费选项权限（2026-09-14，未部署）

PHP `route/supplier.php:191`、`StoreProduct.php:get_template` 与
`ShippingTemplatesDao.php:getTemp` 证明选模板属于商品域，返回所属供应商的
id/name数组、sort DESC/id DESC。此前TS选择器借用运费管理list/edit，造成仅有
product.view/manage的子账号无法选择。此增量不向商品角色补发shipping权限：

- GET `/supplierapi/product/product/shipping-template-options`：分页及搜索，复用已有
  单SQL页面/总数快照，limit最多100，返回`{data:[{id,name,type}],count}`。
- GET 同路径`/:id`：正整数ID、单行元数据回读，不读取规则、回执或编辑revision。
- 两端点使用现有真实supplier认证和商品查看权限；归属取实时数据库身份，忽略客户端
  owner/relation/supplier字段；无认证和权限失败也no-store。商品读不授予shipping
  list/edit/save/delete/receipt能力，旧运费管理端点及数据库授权均不改。
- 前端选择器改用上述两端点。ID回读验证响应ID与请求一致；管理入口按shipping.view
  隐藏；分页状态泛型化但仍保留原运费列表完整行类型、迟到隔离和显式重试。

这是明确的新分页契约，**不是**PHP `get_template` 无参数全数组的别名。旧精确路径
和三个旧第一方调用者的完整迁移仍开放，不用静默截断或新接口数量宣称旧合同完成。
已删除项不可选择沿用当前TS退役协议；未改变status=0模板可读规则。

### 验证与限制

`supplier-product-shipping-options.test.ts` 使用真实注册路由、JWT、DB角色判定和
随机PG16库，每请求独立受限LOGIN，仅四表SELECT、schema USAGE/database CONNECT。
没有规则表/回执权限、DML或sequence USAGE。新增24项覆盖两种商品权限下125条
全页遍历、排序、搜索、空页总数、最小字段、外租户/平台/门店/退役/不存在一致拒绝、
非法参数、shipping域拒绝、无产品权限/无token拒绝、角色停用和同JWT改归属。
旧实现8过/16失败；新增实现24全过。Redis令牌桶为替身，非线上身份验收。

最终六文件113项零失败/跳过：新增24、selection22、pagination22、session31、
template7、list7。另四文件22项路由解析、Admin API精确盘点、Supplier RBAC与规格
前端合同通过。`npm run typecheck`双配置、Supplier `npm run build`通过；既有VueUse
PURE注释和大chunk警告未处理。最初误用不存在的tsconfig.unit.json返回TS5058，
随后改用仓库正式脚本通过；首轮会话文件名误写导致仅75项，不作为最终113项证据。

本机临时原始报告（不含生产数据）：
- `cinashop-product-shipping-options-red-20260914.json` SHA256
  `5e80ef45859ca565c671efcbabf90b1588657078bef3a31ba4b10b642cf3fc1e`。
- `cinashop-product-shipping-options-final-20260914.json` SHA256
  `8ecd05dbb5a61baaf2b3c0ea83f81cff5fb207e73985691fafa0a363af3db92c`。

Browser插件实测`http://127.0.0.1:5396/products/71/edit`，1280×720，最终构建
ProductForm-CydQBTzS.js。账号只含product.view/manage，导航无运费管理、表单管理
按钮0个；#201正确回显，第7/7页选择#202、搜索#201后取消仍#202；503明确错误且
保留#202，恢复后重试搜索成功。外供应商搜索首次观察仍加载中未记通过，另开页等待
“暂无匹配模板”后确认0条。页面身份/非空/无框架遮罩/截图/交互通过，console warn/error
为空。注册路由记录13次请求（含最初过期测试token），业务写0、shipping编辑域请求0；
metadata仅id/name/type，129模板（125所属+3外属+1默认）、序列10000，回执SELECT/INSERT
均false。未点击商品保存；商品/分类/规格读取仍合成夹具，Node宿主，Redis/登录签发替身。
商品列表和退出端点未在夹具实现，其请求失败提示不当作生产缺陷。

临时夹具`cinashop-product-shipping-permission-browser-20260914.ts` SHA256
`e77c1d8db4a163a9ab93b0daf6dbf4e00e4a439ce96d7d2dc4b408f8784dcedd`。
结束后正常stop、进程exit0；独立psql核验本次库
`cinashop_kefu_runner_570e23f515514311ba6571d8df5f9e90`及角色
`cinashop_runtime_bc6f9ab41100401c9869737ed9940ac6`均0残留。

上一ac5131d CI34809884563已completed/success，本增量自身CI待验证。未部署、未改
线上权限或数据，线上仍9fb7d27且回执表未安装；协调发布要求保持。手机viewport、
真机/真实角色、整商品保存会话保护/未知结果、旧全数组接口和完整容量门禁继续开放。
上一浏览器轮次观察到线上商品图片加载失败，另列待查，不由本权限修复解决。
A3k13、SUP-004及240勾选/164开放/404总项保持。

## 商品运费选择器超过100条的可达性（2026-09-14，未部署）

对照PHP `product/productEdit/index.vue` 的 `productGetTemplate` 与 temp_id 选择，
以及 `api/product.js` 的 `product/product/get_template`：当前TS ProductForm只请求
page1/limit100并对本地选项搜索。插件以125个所属模板复现旧构建：仅100个option，
商品temp_id=201不在第一页时只回显数字201，搜索“分页测试-01”显示No matching data。

改为独立 `ShippingTemplatePicker.vue`：复用已验证的分页状态，每页20条，提供服务端
搜索、前后页、键盘跳页、明确选择/取消。`shippingTemplateSelection.ts` 按当前ID
读取详情，仅用于名称/计费标签回显，不扫描全量、不依赖搜索结果页；读取失败保留ID
并提供重读，晚到旧ID响应不覆盖新ID/清空状态。组件使用挂载会话signal、失效清私有
展示并关闭弹窗，卸载取消请求。浏览页面/失败/取消不emit新值，只明确选择或清除才
更新商品表单。ProductForm不再把运费列表放进基础资料初始化的Promise.all。

实际插件证据（同标签重新加载新构建，1280×720）：

- `http://127.0.0.1:5396/products/71/edit` 原201正确回显名称/计费；首屏125条/7页。
- 键盘跳第7页显示205..201，选择202回填名称及ID；搜索原201可找到，取消后仍是202。
- 503列表失败不改绑定201；首次失败出现“暂无匹配模板”的UI缺陷由插件发现，已隐藏错误时空态/总数并复测falseEmpty=0；恢复后点重试显示125条/第一页。
- 搜索另一个供应商的3个模板返回总0，取消仍保留201。页面身份、非空、无框架遮罩、控制台error/warn空和末页/失败截图通过。
- 运费五表和序列前后完全相同，业务调用无非GET。未点击商品保存或审核。

新增21项回归：按ID独立回显、125条分页、3种标签、旧成功/失败迟到、清空、重试、
会话失效、非法ID/响应以及组件接线和失败空态。联合分页22、会话31、既有模板7，
最终81/81、0失败/跳过；Supplier vue-tsc+Vite完整构建、Worker单元类型通过。
旧100条静态合同替换为新组件接线及禁止固定100条，不删除原作用域/删除等断言。
最终临时报告 `cinashop-product-shipping-picker-final-20260914.json` SHA256
`a0e1693c29d875cc19b61fcd6d4341d11fe97437f790efd6202cd19b78440972`。

隔离夹具 `cinashop-product-shipping-picker-browser-20260914.ts` SHA256
`b979ad95c10674a76cc93b88e876b4d7d6b739fbcd8317ba91c5d80fec3fc1a8`；保留旧运费夹具未改。
运费读取仍是真实PG16.15/注册路由/受限LOGIN，商品71、分类和规格读取是显式合成响应，
登录签发/Redis仍为替身，不能据此声明商品保存/真实身份/Cloudflare端到端验收通过。
库 `cinashop_kefu_runner_3f9481d591f2496ea37e4b7295f4e306` 与角色
`cinashop_runtime_0a633f7552c843429725fe28d3242816` 的独立清理检查均0残留。
服务favicon缺失、构建旧大包/第三方注释警告保留，手机本轮未重测；遵照前端测试技能
实际使用指定浏览器，未用外部Playwright替代，也未把桌面截图当响应式通过。

仍须推进：PHP get_template精确路由及商品-only角色选择权的完整合同，整个ProductForm
（而非仅新选择器）的会话/未知保存保护，真实商品保存与报价链、真机和发布验收。
本轮没有新增服务端路由、放宽shipping权限或改动商品写入合同。e72af20的
[CI34808890823](https://github.com/cinagroup/cinashop/actions/runs/34808890823)仍运行，
新增选择器自身CI尚未执行；不并发重启同分支CI。A3k13/SUP-004及240／164／404保持开放。

## Supplier列表单语句快照（2026-09-14，d985238之后、未部署）

`SupplierShippingTemplateService.list` 原先并行发出页面 SELECT 和 COUNT SELECT。
独立 PostgreSQL 连接的受控交错复现四项红测：读取旧模板期间另一连接提交新增，
响应旧行但 count=2；退役、转给其他供应商、改名移出筛选分别响应旧行但 count=0。
使用仅在随机测试库存在的阻塞视图，明确观察 `pg_blocking_pids` 的 reader/holder
后才让 writer 提交，没有以定时 sleep、模拟结果或单连接伪并发代替证明。

现在使用 typed Drizzle 子查询，将总数与有界页面 LEFT JOIN 成一条 SELECT，
两部分共享同一语句快照；从总数聚合出发，空页/超末页返回空数组但不丢总数。
仍为 owner_type=2、当前 relation_id、is_del=0，保留停用模板可读、默认15/最大100、
页码最大1000000、sort DESC/id DESC、原 ILIKE 通配符语义和上海时间/PHP标签。
没有添加事务/业务锁、数据库DDL、索引、权限或网络连接；仍用现有 Hyperdrive 绑定。
这是**一次响应内部一致性**，不是多次翻页之间冻结全量结果：OFFSET跨请求漂移、
大偏移成本、全量COUNT容量验证仍未完成，不因此关闭A3k13。

验证证据：

- `supplier-shipping-list.test.ts` 新增7项：3项完整分页/作用域/格式/筛选合同，4项真实独立连接交错。旧实现7项中4失败/3通过，修复后7/7通过。
- 最终5文件607/607、0失败/跳过：新增列表7、分页状态22、Supplier详情版本22、既有模板合同7、完整注册路由鉴权549（含maintenance/受限LOGIN）。`npm run typecheck` 两套类型检查成功；测试配置与时限未变。
- 红测报告（临时目录）`cinashop-supplier-list-snapshot-red-20260914.json` SHA256 `d6eeca584be083a0d7871b34392ee7fcd389ec2c8af208ed12fd6003c5d1f0ec`；最终 `cinashop-supplier-list-snapshot-final-20260914.json` SHA256 `bb61118b8f9087e663507e2f01f0c1e9f1d0c5177e34b3e89f47a6a3da5c9467`。
- 浏览器插件实际加载 `http://127.0.0.1:5396/shipping-templates`：1280×720，经新后端真实注册路由/PG16.15受限LOGIN，45条列表依次进入2/3页，末页5条及总45；搜索不存在显示总0、空列表。页面身份/非空/无框架遮罩、末页截图和error/warn空通过。首次空搜索仍加载时误关闭标签，未当通过，重新打开并再次查询，AX明确显示空状态后才结束。没有本轮UI修改，无需重建未变前端。
- 浏览器随机库 `cinashop_kefu_runner_4df3563ed31541f385690d2fdae6a11b`、角色 `cinashop_runtime_126ba1ecec5d40af815f7f1937e6d307`，current_user=session_user且五项高权限false；结束后独立psql确认两者及finance_fixture随机库均0残留。合成登录签发/Redis替身、Node宿主及favicon缺失边界保持；手机/真实账号/Cloudflare端到端未在本轮通过。

按PG技能选择单语句快照且不新增锁，按Workers技能核对官方文档、最新类型
5.20260914.1及现有绑定配置，按前端测试技能使用指定插件而非外部Playwright。
隔离性依据：[PostgreSQL 16 Read Committed](https://www.postgresql.org/docs/16/transaction-iso.html#XACT-READ-COMMITTED)。
上一候选d985238的[CI34807854636](https://github.com/cinagroup/cinashop/actions/runs/34807854636)
已completed/success；不得把它算作本增量自身CI。未部署/合并main，线上仍9fb7d27，
新回执表和协调发布门禁仍未完成。Checklist保持240／164／404。

## Supplier列表分页缺口修复（2026-09-14，未部署候选）

对照旧PHP `view/supplier/src/pages/product/shippingTemplates/index.vue` 的Page组件及
pageChange/nameSearch，以及ShippingTemplatesDao的sort DESC,id DESC/page/limit合同：
新Supplier接口已有分页，但页面一直固定page1/limit20，只有总数，没有翻页入口。
浏览器在8323bd5实际构建复现：共45条，只显示245..226的20条，无“下一页”按钮，
剩余25条不能通过列表访问。此项是功能缺口，不把此前少量样本冒烟当分页验收。

现在新增上一页/下一页、页码跳转、10/20/50/100条选择，搜索明确回第一页。实际Vue
列表状态抽到shippingTemplateList：成功后一起提交rows/count/page/name/limit，失败
保留原显示及原页码，明确错误并重试失败查询；未提交搜索词不混入翻页。沿用挂载会话
signal和最新请求代次，旧成功/错误不覆盖新查询，账号失效/卸载清空私有数据。
保存/删除后按已成功查询刷新，不擅自套用草稿搜索词；末页因删除消失时最多回读一次
新的末页，持续变化则保留旧页提示重试。没有变更业务写入、数据库DDL或权限。
开发preview分支也按过滤、排序和切片返回；不是生产分页证明。后端当前列表/总数仍是
两个查询，OFFSET成本与并发分页漂移未在本轮改造，不宣称单MVCC快照或容量门禁完成。

实际浏览器插件环境：127.0.0.1:5396/shipping-templates，真实构建/注册路由/受限LOGIN
PG16.15，合成登录签发和Redis替身、Node宿主。临时库
`cinashop_kefu_runner_719aa4c4c1804f6a9b67ef875ab6afd1`，角色
`cinashop_runtime_2444b3055e364dfba56dd380eaebd6d5`，current_user=session_user且五项
高权限false。数据为45个所属20模板、3个所属40模板和默认模板1，无业务历史数据。

| 插件实际操作 | 结果 |
| --- | --- |
| 同标签重载新构建，依次翻第2/3页 | 返回225..206及205..201，三页覆盖45条，末页下一页禁用；1280×720截图确认 |
| 第3页返回上页时注入列表传输503，再恢复响应点重试列表 | 失败保留第3页5条/总45，重试进入第2页；不是清空数据或把旧行标成新页 |
| 每页20→10，键盘直接跳5，再搜索精确名称 | 页大小切换回第1/5页，键盘跳第5页成功；搜索回第1/1页并显示单条 |
| 挂起02查询的真实PG结果，先完成03查询，再释放旧响应 | 页面仍是03/总1；旧响应未回填 |
| 搜索“其他供应商” | 总0，不出现另外3条模板；清空并查询后恢复45条 |

两实际页面URL/标题正确、非空、无框架遮罩，error/warn控制台均空。传输失败在页面
显示Axios原始503文本及中文保留说明，服务日志仍有favicon缺失，不宣称错误文案全中文。
插件fill空字符串和数字字段未可靠触发本次输入事件，改用真实键盘全选/退格/数字/Tab后
验证清空与跳页，未把未触发事件记为通过。没有使用外部Playwright替代用户指定插件。

**本轮手机验证未通过验证门禁**：浏览器viewport设置没有把目标截图从1280px改为390px；
插件内标签级模拟调用长时间后返回，但截图缩放异常，不能用于响应式结论。已清除模拟
及viewport override，临时标签关闭。代码包含换行布局，构建通过不等于390px已验收；
真实手机/窄屏分页及删除末页的完整UI循环仍开放（末页修正已有运行时单元测试）。

分页新增22项实际Vue状态/绑定回归；先四文件132项通过，再联合真实PG路由、Admin
原子/分组/列表、Supplier会话和持久意图，共8文件727/727、零失败/跳过。最终报告
Temp/cinashop-supplier-pagination-final-20260914.json SHA256
`d56f7dea8456f7cadad07d2b08c97e05b281df76abe38ed3549835cb38b1ebe6`。
Supplier完整vue-tsc/Vite构建、Worker单元/运行时双类型通过，保留既有PURE注释和大包警告，没有升级依赖。
浏览器所有业务请求均GET，49父模板/0规则/0回执及序列10000前后相同；服务退出0，
独立psql精确库/角色均0残留，仅清理本次可重建夹具。临时测试器
cinashop-shipping-pg-browser-20260914.ts SHA256
`4150a9b2cb4c4babcb179fc9423d4cef4da283f6b0b45927b1221b66ed43b2fd`。
前端技能驱动真实插件与失败门禁记录，PG技能驱动受限身份和独立清理核验。

上一候选a064815的CI34804509771已completed/failure：14项Admin测试失败导致分片2和
汇总失败，其余9作业成功。两处旧夹具缺新增X-Shipping-Creation-Scope；本机真实PG
两个原文件40项26通过/14失败精确复现，补齐匹配其合成admin7的头，保留全部旧断言，
另增缺头零写入验证。夹具统一business400映射与生产HTTP412分开记录；549项真实注册
路由继续验证412。红报告Temp/cinashop-shipping-scope-fixture-red-20260914.json SHA256
`901fa3a3d3f7e0c02e23e85a08fc0aa1d5f09c8b11bffb22b9a276c83342afa5`。
不通过移除身份检查、放宽超时或重跑旧SHA冒充修复。新的候选CI仍待执行和终态。
线上/main仍9fb7d27，回执表未在线安装，协调发布门禁及A3k13/240完成164开放404总项不变。

## Supplier 挂载会话和未知写入回执（2026-09-13，本地候选，未部署）

对应 A3k13/FE-004：抽取 `supplierSession`，同标签登录/退出、账号/权限 storage 事件和
操作前原始存储快照比较都会使挂载范围永久失效；A→B→A 不复活旧范围。Axios 在调用时固定令牌，
异步调度前可被运费页 signal 取消；请求自己的会话范围用于判断迟到业务失效/HTTP401是否仍可清登录态。
登录结果在应用前核对同次尝试与会话；退出先捕获旧令牌撤销请求，再立即清本机，不等网络且不在完成后清新身份。
Pinia 同步三项存储，格式损坏的权限快照返回空列表；退出回执异常不宣称服务器已撤销。
共享请求层改动不等于所有 Supplier 页面都已采用挂载范围。

运费页的列表、城市、详情、保存、删除都携带取消信号，列表另有最新请求代次。
身份变化时清空旧私有数据、直接卸载编辑框并关闭本页确认框，确认返回后仍核对会话。
只读权限可以查看，不可编辑/新建/删除；默认 ID1 禁删和原版本冲突/显式重读合同保持。
保存回执要求正整数范围1..2147483647，编辑必须等于目标ID；删除只接受 null。
只有业务400作为明确拒绝；网络、500、缺失/损坏信封及不匹配回执均按结果未知处理，
保留输入、不给成功提示并暂停本页全部写入。查询列表或重新打开另一个模板不会自动解锁。
已经到达服务器的写入不承诺被 AbortController 回滚：浏览器确实验证旧身份已提交但回执迟到，
新会话没有成功提示、数据回填或后续请求。

初始真实依赖测试11项全部失败。最终新增测试文件31项，连同Admin会话、Supplier认证/RBAC、
真实PG模板/注册路由及CI门禁为12文件392项、零失败/跳过。
报告 `C:/Users/cina/AppData/Local/Temp/cinashop-supplier-session-final-20260913.json`，
SHA256 `29043dfdeea8209ae60c32b22a6faedc63e21e765b7537138772d605b311c945`。
中间386通过/2失败源于本机 MigrationService 混合换行；证明两份外部/内嵌SQL仅CRLF不同后统一本机换行，
Git内容无差异，不修改SQL或放宽断言。Worker双类型、Supplier生产构建通过；PURE与大chunk既有警告保留。
两个Linux单元分片显式安装Supplier锁定依赖，不依赖其它构建作业的文件系统。

前端技能驱动真实交互与双尺寸QA。专用browser技能未提供，使用已安装Playwright 1.62.1/Edge。
URL `http://127.0.0.1:18177/shipping-templates`，真实控制器/隔离本机PG在18176，UI认证为替身。
1280×900、390×844各10个场景全部通过：正常编辑/删除，已提交创建/删除后损坏回执，迟到详情/保存，
删除/重新读取确认中换身份，只读权限，实际Router卸载，以及另一真实标签触发storage事件。
数据库检查未知创建只有一行、仅一次POST，未知删除已软删且仅一次DELETE；之后查询/重开不解除写入暂停。
原有Admin改名→Supplier冲突→取消/失败/成功重读→保存，以及迟到读不覆盖新建、缺版本拒绝也在两尺寸复验通过。
URL/非空/无框架覆盖层/控制台错误及警告/视口宽度/底部按钮边界全部通过。

临时证据目录 `C:/Users/cina/AppData/Local/Temp/cinashop-supplier-session-qa-20260913/`：
`verify-final3.mjs` / `result-final3.json`（SHA256 `79a250ba4ffe720d5ac0e543404e2486d9c62de96c5761bcd1c0f9d0069ea1f8`），
`verify-snapshot-regression.mjs` / `result-snapshot-regression.json`。
稳定截图 `unknown-create-stable-1280.png`、`unknown-create-stable-390.png` 已人工检查。
原始失败报告保留：软删除误断言物理消失、重复alert定位、Vite扩展名导入第二Router实例为夹具问题；
弹窗过渡残留经界面修改为立即卸载，复验通过。没有删测试或更改超时来取得通过。

仍开放：新建没有跨刷新/跨页面持久幂等键，当前页面暂停不是全局重复写入保证；需要持久意图、
服务端去重及人工结果恢复协议。其它Supplier页面、完整真实登录/角色/真机、损坏规则修复、规模和发布未验。
不关闭A3k13或完整Supplier迁移。此前7dc52ed六端已测试部署，候选与main CI均成功；不代表本候选已通过Linux或上线。

## 供应商四表快照与旧表单覆盖保护（2026-09-13，本地候选）

之前供应商详情分四次查询，保存虽然锁父项却没有版本基线；独立连接测试还将“等待Admin保存后用旧Supplier表单完整覆盖”当作成功。现在共享原有原始快照和 `shipping-v1` SHA-256 算法至 `services/product/ShippingTemplateRevision.ts`，Admin旧导出保留兼容，不新增DDL、版本列或循环依赖。Supplier详情在同一SQL读取所属模板和三类规则；每表1000条、分组100组上限整批拒绝。复用严格分组校验，不再默默取同组最后费率或忽略路径/地区ID矛盾；仅兼容全国0的空路径投影，不修复原始坏数据。

Supplier编辑必须提交 `expectedRevision`，新建不要求。身份/权限仍在注册路由先执行，供应商归属仍从服务端取得；缺失/非法版本明确拒绝。沿用供应商advisory→父模板FOR UPDATE→规则表顺序，添加READ COMMITTED要求、statement/lock/idle局部上限5/2/5秒，已有更短时限不放宽。父锁之后新语句复核完整快照，再更新父项与三表；Supplier原有更新时间语义保留。锁拒绝转为无SQL细节的可理解错误，事务回滚；这些是单语句/锁/空闲上限，不是总事务截止时间。

前端显式提交读取版本，冲突后保留全部输入并禁用保存；重新读取先确认放弃本地输入，取消不发请求，失败不替换旧表单或解除冲突，成功读取后才可重新保存。编辑读取按代次隔离，新建/组件卸载使旧读取失效，保存期间冻结控件与提交副本。详情缺版本拒绝打开可保存表单。开发preview模式也返回自身本地指纹并拒绝旧版本，但不是生产权限或并发证明。

验证过程保留失败：初始17项测试3通过/14失败，其中13项为版本/读取/锁错误缺口，1项是测试误用旧扁平表单更换结构化地区，被原保护正确拒绝，改为真实允许的Admin改名载荷。初始报告位于临时目录 `cinashop-supplier-snapshot-red-20260913.json`，SHA256 `80e04b4344b5ea0bfd664d162be419e12776baf8bcc7f0dad4552c9002768a93`。既有跨写入方并发测试改为等待后的旧Supplier表单拒绝，并继续核对父项、费率及保留子表；不是去掉锁等待测试。

最终专用本机PG16.15回归13文件447项零失败/跳过，报告 `C:/Users/cina/AppData/Local/Temp/cinashop-supplier-snapshot-final-20260913.json`，SHA256 `042df4fc27ec20e1cb39f0d549593be31da00af08b9677a43f6ba426fb7ce105`。包含维护身份及受限LOGIN的真实JWT/数据库角色/两种Admin别名↔Supplier注册路由；独立连接证明单MVCC四表快照、父锁/advisory等待后版本复核、所有权变化拒绝、同时两份Supplier表单仅一份成功、严格时限保留及拒绝REPEATABLE READ。还覆盖原有Admin分组/扁平/列表/会话、报价、退役和静态前端/Pages合同。Worker双类型和Supplier构建通过，未修改依赖。

浏览器目标：`http://127.0.0.1:18175/shipping-templates`→编辑→独立Admin提交→Supplier保存冲突→保留输入→取消/失败/成功重新读取→新版本保存及SQL核对。Playwright/Edge在1280×900、390×844通过；Browser插件指定的browser技能缺失，沿用已安装Playwright。真实本机18174控制器和隔离PG，UI身份为替身，不能外推真实登录。页面身份/非空/无框架覆盖层/控制台错误及警告均通过；迟到详情不覆盖新建、无版本响应拒绝、新建不携带旧版本、刷新持久结果及默认模板保留均通过。

首次手机截图发现冲突提示将底部操作区挤出首屏，已改为视口限高的flex弹窗和内部滚动；同一流程加底部按钮视口边界断言后复测通过，不通过隐藏整页溢出掩盖。原图及最终图均保留于 `C:/Users/cina/AppData/Local/Temp/cinashop-supplier-snapshot-qa-20260913/`；`result-fixed.json` SHA256 `91d97f69f4a83081fb8f372b70a83e62ab7c1d0fd7d55a6deaef5fce5a3c4105`，脚本 `verify-fixed.mjs`，截图 `conflict-fixed-1280.png`、`conflict-fixed-390.png` 等。预览API读/改/旧版本拒绝另由 `verify-preview.mjs` 验证。

本机 `npm run test:runtime` 在任何测试执行前发生Windows workerd原生访问冲突 `0xc0000005` / `ERR_RUNTIME_FAILURE`，11个启动错误、测试0执行，工具输出保留；工具提示可能与VC++运行库有关，但未确定根因，不重跑碰绿、不自动安装运行库。必须另以精确候选Linux CI验证，不能把447项Node/PG回归算作workerd通过。上一发布c4489c1的候选/main CI均已成功，仅适用于该旧SHA。

技能影响：Workers技能要求当前Web Crypto定义及运行时检查；PostgreSQL技能约束锁顺序、短事务与局部时限；前端技能要求双尺寸实际交互和截图复验，驱动修复手机弹窗。最新types 5.20260911.1仅作参考，不升级依赖或兼容日期。此版本指纹不是授权或持久幂等凭证，不能检测完全恢复原样的ABA；直接SQL仍必须遵守父锁协议。Supplier跨账号会话失效、未知结果/回执与创建持久幂等、城市并发维护、坏数据受控修复及完整生产容量/真实角色/真机门禁未完成。A3k13不关闭，清单240/164/404不变；本轮不部署、不改线上数据。

## 会话与回执边界补全（2026-09-13，待发布候选）

运费列表、编辑和删除现使用挂载期间的会话作用域：同页登录/会话变化、退出、跨标签 localStorage 事件及真实组件卸载都会终止旧作用域。
失效不可因 A→B→A 恢复；每次操作前再核对 token 和权限会话快照，所有运费请求携带同一个 AbortSignal。
旧列表和编辑器立即清除，删除确认关闭；确认后的 DELETE 和迟到成功提示也需通过作用域检查。
已发出的请求可能已在服务端提交，取消浏览器请求不能回滚数据库，页面明确要求重新进入后核对。

保存仅接受正整数 ID 回执，编辑 ID 必须与提交相同；删除只接受 `data:null`。
统一请求层保留原业务 status，运费写操作只把明确 status 400 视作可更正后重试的业务拒绝；网络错误、不完整/错 ID 回执、不明信封和其它状态均按结果未知处理。
未知保存保留输入并禁止重试，未知删除保留目标 ID 并禁止再次删除，即使刷新列表也不自动解除。
正常删除、完整省市规则编辑/新建、业务版本冲突恢复均保持可用。

持久回归 `test/admin-shipping-session.test.ts` 通过 esbuild 在内存打包实际 Admin auth/Axios/shipping API，21项包含调度前取消、会话变更、跨标签事件、匿名、销毁监听、旧账号认证失败和回执校验；不是复制业务实现的替身状态机。
关联回归最终11文件353项通过、零失败/跳过，使用专用PG16.15、`--maxWorkers=3`；双类型和Admin构建通过，API盘点345调用/365变体保持全注册可执行。
首次关联回归352通过/1失败为列表夹具含建库清理的5018ms超时；构建结束后降低测试进程并发重跑，未改测试时限或断言，原报告保留。

依据前端测试技能在 `http://127.0.0.1:18173/shipping` 用既有 Playwright1.62.1/Edge 验证1280×900、390×844。
专用 Browser skill 未提供，因此使用已有Playwright依赖；页面同源API转到18174真实Hono/随机数据库，UI账号为显式替身，不宣称真实登录浏览器验收。
22项边界流程通过：新建/编辑提交后丢失或损坏回执只发一笔、身份变化清旧表单、待加载/保存响应失效、切换账号/离开路由时删除确认失效、正常删除与删除后丢失回执。
另复跑此前三类完整规则新建/编辑/冲突脚本，两尺寸SQL断言通过。页面身份、非空、无框架覆盖层和水平溢出均检查；正常流程无控制台错误/警告；六个网络故障场景各有一条预期 `net::ERR_FAILED`，其它错误及警告为零。
人工查看桌面身份失效与手机未知新建提示截图；手机图为滚动到错误提示后的状态。

原始证据只保留本机 `C:/Users/cina/AppData/Local/Temp/cinashop-shipping-session-20260913/`，不打包进应用：

| 文件 | SHA-256 | 范围 |
| --- | --- | --- |
| red2.json | 9c777474db759bff449de2578eff05610e41a3ea46a55415fb58361c8140c073 | 首轮有效账号切换删除及错误回执反例；其中离开路由用例最初导入了未挂载router，不能作为真实卸载的反例 |
| regression.json | 58f92e404bc4a08fc6a0d268768658ad7989b286fd802d969f3ab529439ae406 | 352通过/1超时原记录 |
| regression2.json | 8b76d44b7948684438aa4ef57fdf5d595a2f2181cc978161a1eff39dbf3d5b13 | 最终353通过 |
| green3.json | 9ba214e1b64dfcc19f3566e1b4844e548c7837929d128dfd49c432eeaab790e3 | 最终22浏览器边界流程，真实已挂载router离开 |
| positive.json | cfd7d0043e8fdc53a07bd563523ca1a446a7c7131bfdeeeb721db2d438d4bf0a | 原完整规则操作两尺寸复验 |

测试器初次按钮使用中文而实际为OK，随后又误点正在关闭的弹层；均已按实际DOM/动画修正。
卸载最终使用页面已挂载router进入操作日志页，不再用新导入router只修改地址；早期控制台报错来自控制台页的非本任务响应替身，最终换到合同匹配的日志页验证，没有修改控制台业务代码。
专项服务已关闭，专用PG随机数据库/schema/角色均为0残留；旧开发服务器保留。

发布主线的 ce8739d / Actions34752548223 已11/11成功；本轮会话修正仍需自身Linux CI和部署，线上没有自动重发。
真实账号/跨浏览器和真机、权限变更完整链、跨页面持久新建幂等、其它管理页面、损坏规则受控修复及生产规模验收仍未完成。
A3k13及父项继续开放，240完成／164开放／404总项不变。

## 原分组编辑实现记录

## 默认模板禁删与 CI 依赖修正（2026-09-13，未部署候选）

PHP 总后台及供应商 `ShippingTemplates.php::delete()` 均明确拒绝 ID 1；旧后台列表也隐藏该删除操作。
共同 `retireShippingTemplate` 现对保留 ID 1 在事务前返回“默认模板不能删除”，与是否有引用、状态、所有者或记录是否存在无关。
认证及 manage 权限仍先由路由执行，普通模板的所属方、引用检查、行锁顺序、回滚和幂等退役保持原样。
不重建/修复缺失默认项、不自动重绑商品、不修改订单，也不推导 PHP 未规定的额外停用限制。
两端列表标识默认模板并隐藏删除，方法入口也阻止 ID 1；默认模板仍可正常编辑。

在正式协议已安装的完整隔离 ORM 上，Admin 两个别名与 Supplier 注册路由分别用维护身份及真实受限 LOGIN 验证：
有 manage 权限仍不能删除 ID 1；匿名/只读权限仍先拒绝；默认完整分组编辑可成功。
无协议服务测试覆盖 ID 1 的无引用、停用、已删、缺失状态及规则/订单不变。Supplier 异常 ID1 归属样本只在本机隔离库设置，
不声称正常供应商能看到平台默认模板。

原错误用例“解除引用后允许删除 ID1”已改成“ID1仍拒绝，普通ID10可幂等删除”，没有删掉普通退役断言。
首轮定向报告19失败/281筛选排除中，15项是缺失默认禁删合同，另4项是正向分组测试误用了附带伪造字段的旧助手。
修正服务后中间结果296通过/4失败；改成真实分组编辑器载荷后，完整11文件411项通过、零失败/跳过。
另4项工作流/分片断言通过；Worker双类型及Admin/Supplier构建通过，依赖版本/配置不变。

原始证据保留在 `C:/Users/cina/AppData/Local/Temp/`：

| 文件 | SHA-256 |
| --- | --- |
| cinashop-default-template-red-20260913.json | c9db12e9e374e5c53d3b091746ca9b07800625171073a8ea8c34a74b0483c030 |
| cinashop-default-template-green-20260913.json（中间296/300） | b79a3a5e05351ac460f7ddb1fa4325b8e265b3e715385bc742856c933b520b24 |
| cinashop-default-template-regression-20260913.json（最终411/411） | 29960cb53d7209871696747ea8032651ba69f57589785a909922137593335170 |
| cinashop-default-template-qa-20260913/result-stable.json | 52367a21727ccebe696b27caf21329eaebeea89293242d8fd1598fa605362a33 |

浏览器实际路径：Admin `127.0.0.1:18173/shipping`、Supplier `127.0.0.1:18175/shipping-templates`，
Edge/Playwright 1.62.1，1280×900及390×844；专项 browser skill 未提供，按前端技能使用已有 Playwright。
两端四次流程均核实页面身份/非空/无覆盖层、默认无删除按钮、直接DELETE被拒且SQL不变、编辑保存、普通删除取消无写入、
确认删除及刷新后状态、默认父项和规则不变；控制台错误0/警告0，页面无横向溢出，宽表内部仍需横滑。
截图和脚本均在上述QA临时目录；首次截图遇到过渡动画，保留原件，再等有限动画结束生成 `*-stable-*` 证据并人工检查。
UI会话是本机显式替身，真实JWT/角色由前述注册路由测试覆盖，非线上真实角色/真机验收。已关闭本轮SQL服务及Supplier验证进程，
确认随机数据库/角色/schema均为0；原Admin验证服务器和长期PG服务保留。

已发布 `2b6469d` 的候选 Actions34753660067 和 main Actions34754263804 最终均9作业成功/2失败。
第一分片2752项执行通过，但 `admin-shipping-session.test.ts` 在 beforeAll 打包失败 `Could not resolve "axios"`，21项未执行。
独立前端构建作业不共享 node_modules。现两个单元分片都执行 `npm ci --prefix ../view/admin-ts`，并保持精确分片/零跳过门禁。
没有删除测试、mock Axios、依赖本机目录、改变时限或重跑旧任务。
干净临时树 `cinashop-default-ci-clean-3a09bc4658e24f71ab65ae55a6230c6b` 复现同样21项无法加载；按Admin锁文件安装后原21项通过。
before/after报告SHA256分别为 `5a65f74b72fcc3988a754a8bdd488a6fc2bee11833813255e4023e4e8f56022e` /
`0834b24e9f5ffe7b98aff254b53edaf66e752dec0ac619dbc4e0ce3b14017901`。
临时树只复用Worker工具依赖，Admin依赖从不存在到锁定安装；缺少临时package.json产生CJS配置提示，不是线上构建失败。
当前候选仍需自身Linux终态；线上版本和数据库保持不变，A3k13不勾选。

技能影响：Workers技能要求沿用明确领域错误及请求内状态，保持现有Hyperdrive/事务边界；前端技能要求真实双尺寸渲染与交互/截图复验。

## 原分组编辑历史记录

发布追记（2026-09-13 10:31 UTC）：本候选已随 main@37d3308 全量部署至线上测试环境；17项只读检查通过。前置CI页面盘点快照失败及后续审计修正见 `docs/releases/20260913-full-test-redeployment-37d3308.md`。下方保留实现当时的未发布记录；A3k13仍非完整验收。

2026-09-13；FE-003L-A3k13 保持开放，未发布，线上仍是 main@614bf34。

## 改动及合同

实际总后台 `/shipping` 页面从扁平 region_id/region_name 编辑切换为完整省市分组编辑器。支持件数、重量、体积，配送首/续计量与金额、条件包邮、不配送区域、启用状态及排序。所有计量和金额保持十进制字符串，服务端使用既有供应商规则的规范化/权威城市链校验/三表替换逻辑，但保留总后台全局权限范围；不将管理员伪装成供应商。

新增 `GET /adminapi/shipping_template/:id/edit`、`city_list` 及 `/api/admin` 别名。详情以单数据语句返回父项与三张规则表，每类超1000条整批拒绝；组内费率不一致、路径/地区ID不一致、缺失非全国路径会明确拒绝，不选择最后一条或猜测地区。仅原有全国0的空路径投影为 `[0]`；没有修改存储事实。超过100组也不可返回可编辑截断内容。

每次编辑必须提交 `expectedRevision`。服务端用四表完整快照计算 SHA-256 指纹，在持有父模板 `NO KEY UPDATE` 后重读比较；包含父级、地区、包邮、禁配和所有权变化。它不是权限凭证，也不是历史版本日志，不承诺检测完全恢复原样的 ABA 编辑。未携带版本的旧客户端返回“重新打开”，有版本的扁平表单也不能覆写结构化区域或改变其计费类型。既有无分组扁平保存合同仍受版本检查；显式空数组语义保留。

编辑器读取失败不可保存；加载/保存响应按组件代次和登录token隔离。冲突保留用户输入并滚动显示原因，“重新读取”必须确认放弃输入。保存期间冻结payload和控件；网络结果未知时禁止继续重试，提示核对列表。新建请求尚无跨页面持久幂等键，结果未知后的人工核对仍重要。

新建固定平台所有者；编辑保留所有者和创建时间。停用仍检查现存引用；三类规则原子替换。未改变供应商保存的并发策略、历史订单、付款、生产schema、Hyperdrive或密钥。城市权威表的并发维护、其它旧路径修复和全应用最小权限不是本增量结论。

## 验证

先复现两项失败：分组保存成功却丢失包邮/禁配；旧表单无版本也能覆盖。修复后14项专项覆盖四类版本变化、真实父锁等待、全事务回滚、显式清除、无效地区/金额/类型、损坏分组和边界。原有并发测试将“两个旧基线都成功”更新为“第一笔成功、等待后的陈旧基线拒绝”；保留父锁、费率和未改字段断言，非删测试避错。

最终复核补拒绝显式 null ID、status、appoint、sort，不将 null 当默认值而误建模板或更改开关；四个反例在原校验用例中执行，不增加测试项数。最终报告为 final3，前两轮原始报告保留。

最终专用 PostgreSQL 16.15：8文件303项零失败/跳过，包含234项全ORM注册路由/受限LOGIN回归和2项API审计。中间一轮302通过/1项5010ms超时；Vitest timeout包装器只输出 STACK_TRACE_ERROR，核实源码及5秒默认时限后，为包含建库/清库的专项设30秒，SQL/锁上限仍5/2秒。原报告保留，不把多次通过数叠加。Worker双类型、Admin构建通过，既有 vueuse PURE 注释警告保留。

界面路径：真实 `/shipping` → 编辑完整模板 → 修改计量和包邮 → 保存 → SQL核对；再次编辑期间独立更改包邮金额 → 保存冲突 → 输入保留且四表不变 → 重新打开读到新金额；新建时省→市两级选择并保存三类规则。

| QA检查 | 结果 |
| --- | --- |
| 环境 | Playwright 1.62.1/Edge；专项 Browser skill 未提供；沿用现有依赖 |
| URL/非空/无框架覆盖层 | 本机18173页面，1280×900和390×844通过 |
| 数据链 | 本机18174真实Hono/独立PG，UI登录为显式替身，非线上身份 |
| 编辑、新建三类规则 | 两尺寸均真实SQL核对通过 |
| 陈旧表单与输入保留 | 两尺寸通过，失败请求零数据变化 |
| 手机省市弹层与错误可见性 | 边界在视口内，错误滚入视野；旧成功提示在打开编辑器时清理 |
| 控制台 | 最终错误0/警告0 |
| 截图 | 人工检查桌面冲突和手机三类表单，路径见审计JSON |

复跑命令：专用 `TEST_FINANCE_POSTGRES_URL` 下 `npm run test:unit -- test/admin-shipping-grouped.test.ts test/admin-shipping-atomic.test.ts test/admin-shipping-atomic-postgres.test.ts test/shipping-template-quote-postgres.test.ts test/admin-shipping-list.test.ts test/supplier-shipping-template.test.ts test/shipping-lifecycle-route-auth.test.ts test/admin-frontend-api-audit.test.ts`；Worker `npm run typecheck`；Admin `npm run build`。浏览器脚本与SQL服务只保留本机临时目录，不编入应用。验收结束关闭服务并核验临时数据库/schema/角色零残留。

## CI与后续门禁

上一提交 ef4fce3 的 [Actions34749398563](https://github.com/cinagroup/cinashop/actions/runs/34749398563) 最终9个作业成功、2个失败：单元第二分片唯一失败为 Admin API 确定性审计快照过时，汇总相应失败。当前用既有 `audit:admin-api -- --write --summary --strict` 刷新来源哈希/行号和新增路由清单，保留精确相等断言，2项通过。不能因此把旧CI改记成功，也不代替当前精确SHA Linux。

Admin静态调用345处/365变体均可执行，无未注册或未解析；PHP路由1904、TS1656、匹配881、可执行863、原始缺失1023、退役17、可执行缺口1006。新端点没有增加PHP精确匹配分子，不能据此宣称行为全量等价。

仍需自身Linux、真实角色/浏览器和真机、登录身份切换与未知结果浏览器用例、历史损坏规则的受控修复、生产规模及发布验收。清单240完成/164开放/404，A3k13不勾选。详细原始文件、SHA256和范围见 `workers-ts/audit/admin-shipping-grouped-20260913.json`。

技能影响：依据 PostgreSQL 锁顺序约束沿用父先子边界，依据 Workers 最佳实践保持请求内状态、既有Hyperdrive、受限载荷和Web Crypto；依据前端验收技能执行真实渲染/双尺寸/交互复验。已核对最新 Workers types 5.20260911.1 的 digest 签名，不修改项目依赖或兼容日期。[Cloudflare 官方最佳实践](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)。
