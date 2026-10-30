# PHP → TypeScript：Admin 异常页目的地增量（2026-10-25）

本批接续本浏览器日志，恢复公开的403/404/500/浏览器兼容提示页及原旧地址。未知链接现在保留原地址并显示404，不再伪装成控制台成功画面。原已知路由、登录策略、各业务页权限提示及Worker ACL继续生效；本批没有重写全站路由RBAC，不把恢复403目的地说成已恢复原PHP的全部权限拒绝跳转。FE-001、ADM-001与整个迁移仍未完成。

## 来源与真实入口

固定PHP ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。主来源文件 `workers-ts/audit/error-pages-source-binding-20261025.json` 固定11份PHP全字节原件、14段逐行片段；生成时重新用相邻PHP仓库的固定git blob核对。其余静态侦察见临时source-manifest/line-evidence及php-review，不计运行完成。

原 `router/routes.js:205–248` 将这组记录放在frameIn/frameOut之外，没有meta.auth；原guard `router/index.js:52–84` 仅对matched含auth的记录校验，因此异常页本身公开。三个精确旧地址 `/admin/403`、`/admin/500`、`/admin/other` 和最后的 `/admin/*`（404）均为真实入口。原没有显式 `/admin/404`，它由catchall接住；现代显式 `/404` 及 `/admin/404` alias 是现在清晰注册的入口。

| 种类 | 现代 / 旧入口 | 保留的画面含义 |
| --- | --- | --- |
| 403 | /403 / /admin/403 | 抱歉，你无权访问该页面 |
| 404 | /404 / /admin/404，及未匹配路径 | 抱歉，你访问的页面不存在 |
| 500 | /500 / /admin/500 | 抱歉，服务器出错了 |
| other | /other / /admin/other | 保留403数值及“请使用 chrome / Microsoft Edge 等非IE浏览器打开”原提示 |

原四页均使用iViewPro Exception和本地locale的“返回首页”，并绑定Vuex menus.indexPath。新组件使用原生语义main/section/h1/button及本地CSS，不引入旧minified UI库或外域插画。现代title可读，other标题为浏览器兼容提示。公开静态页没有后台菜单、用户数据或诊断请求；不显示原路径、query/hash、错误文本/stack，不解释redirect/next参数。未知URL及旧alias的地址本身不重定向；记录选择与显示固定内容分开。

原403活跃producer是旧meta.auth权限guard；当前TS已知业务页/后端权限模型不同，本批只恢复可直接到达的403目的地。原500/other没有核实到自动literal caller；原request对HTTP403/404/500记录/拒绝但不跳异常页。因此本批不接router.onError/window.onerror/unhandledrejection，不劫持HTTP或业务错误，也不替换刚迁移的Vue错误观察器。静态SPA500/404画面不声称其HTML网络响应改成HTTP500/404；托管与网关状态码不是本批改动。

## 返回首页及生命周期

原menus getter优先首菜单首子链，空菜单回 `/admin/home`。它会把truthy的空children继续递归并访问不存在的行，深链/循环也无保护；不能把这个缺陷复制到现代Worker普遍返回children:[]的flat菜单。

新纯选择器按菜单顺序优先深入实际子项，空children作为叶子；首分支无安全目标时继续兄弟，必要时使用父项。候选只接受精确注册的、有名字的内部固定页面；排除query/hash、外链、双斜杠、编码路径、控制字符、需参数模板、未注册地址、redirect记录、login和异常页循环，alias使用注册记录的canonical路径。path/children/menus只读取own data descriptor；不调用这些字段的getter或字符串转换，不修改原数据。使用显式栈、对象身份去重和4096次pop/每组2048子项的遍历边界；这是有意的安全收敛，不声称原PHP会跳过坏菜单或有这些限额。

当前可见返回按钮每次点击fresh读取已存token和session，不缓存旧账号的菜单目标；不写/清理token/session、不刷新权限、不调用后台。无token去login，有token但无可用菜单沿用当前根/登录的dashboard fallback。该fallback不保证受限账号拥有dashboard数据权限，后台ACL仍是权威；本批不改既有token判定或损坏session归一化行为。

route.fullPath同步单调代次和卸载状态使旧native按钮回调在离开、query/hash变化、A→B→A或卸载后失效。当前通用返回动作按最新会话选择目标，不宣称同页账号变化时自定义取消VueRouter的pending导航。pending期间阻止重复点击；throw/aborted导航显示固定失败文案并可重试，旧异步结果不能清除新页面的pending或提示。普通导航与已知业务页仍由真实VueRouter及既有guard处理。

## 证据层与验证

新manifest固定21份修改来源、4份新增生产/运行测试、38份前序dated JSON/helper与16份既有来源。18份旧测试只调整最外层读取入口，原测试体/断言/负例不变；新外层完整SHA和字面全文逆变换组合error→browser-log→config-class前序，旧helper与manifest保持原字节。API清单由实际AST重算后与现全文相同：709调用点/747路径，全部注册可执行，未解析/未注册/受控不可用均0，SHA `e00f364f4b64fd6eeb308a171bfdd6a0dcfe1e9ea498f359a4151921da8efec3`。没有新Worker路由/SQL/DDL或依赖。

本批通过 **2021 项唯一测试**，新增 **234 项**：42项异常页真实运行合同和192项来源合同；另有前序浏览器日志183项前端及1604项相关来源回归。重复复验不重复计数。42项在实际安装的Vue Router memory history运行原router/guard，仅将生产history适配为memory、DEV=false并将其它懒页面替换为占位；ExceptionPage使用真实compiler-dom/cacheHandlers:true及nativebutton。覆盖四族现代/旧alias的公开合同、已知页面仍登录保护、动态/旧重定向、query/hash保留且不反射、安全首子菜单/空children/坏路径/循环/深链/冻结数据/getter、fresh存储及同token菜单ABA、route/query ABA/卸载旧listener、pending连点/aborted/throw重试及旧finally。真实原Axios对HTTP400/403/404/500保留原error拒绝、HTTP200业务404保留AdminResponseError，均不自动路由异常页。认证storage、Pinia及原request源逐字未变。

Admin严格vue-tsc、Worker严格tsc、Admin生产Vite构建通过。全部通过共享 `/home/cina/cinagroup/tools/validate-serial.sh` 串行执行，Node test并发1、Vitest单worker且无文件并行。保留现有VueUse PURE注释与大chunk构建提示，未加依赖。执行命令见 `run-narrow.py`（Node --test、Vitest、真实API AST、vue-tsc）及 `run-final.py`（Worker tsc、Vite build、Chrome）。

实际built GUI：`http://127.0.0.1:5207`，1365×960、375×900、320×900；Browser plugin not available，使用已安装Playwright/Chrome单renderer的本地隔离夹具。初始未登录未知旧深层URL带编码script/query/redirect/hash，保留404/原地址且固定DOM无反射；键盘Tab焦点及Enter返回原login；四族现代/旧入口公开、独立于AdminLayout，无新增诊断API或存储写；375/320四页文案、按钮均可读且不横向越界；旧detached/routeABA按钮不导航、当前按钮fresh读取新token及首深菜单并保留storage；原服务端日志GET403仍停原页，显式500是独立目的地。14张最终截图逐张查看；页面身份、非空、无框架overlay、控制台、截图与交互六类QA通过。0 pageerror、0 warning、0未解释console error；唯一console error是主动夹具GET403，与原页面错误保持一致。7个本地API请求均GET，来自原main公共品牌/统计脚本启动或AdminLayout/既有server日志；除既有main启动两次公共请求外，静态异常页本身不新增API，互切不发API。静态资源懒加载不作业务API统计。

主来源SHA `f8c903e9d3516cb4d5662e794a37224a2c2b5684712ccdded4d626a151c9ed06`。82份窄检查输入前后一致，4006份完整源码/执行输入中仅临时browser.cjs为修正既有启动请求统计而更改，其余原值；已通过types/build的字节保留，构建后加入dist及最终GUI执行脚本，最终4310份前后无漂移。38份前序dated/helper及16份既有来源原值；18份旧测试导入差异逐行复核，旧测试体及负例保留。本批已知producer边界写明：403完整全站权限自动跳转仍属更宽RBAC工作，500/other没有原自动caller证据；不能把目的地增量当作整体迁移或全局异常管理完成。

首轮GUI把原main公共品牌/统计脚本两次启动请求误算为异常页新增，已保留first-browser-attempt失败及原types/build回执，只改临时脚本统计并重跑GUI；公共品牌模块会复用原Promise，login不重复读取。实际首屏与错误页互切无新增业务读取。

执行材料 `/tmp/cinashop-error-pages-author/`：固定 `source-manifest.json`/`line-evidence.json`、`php-review.md`、`static-review.json`、`old-read-port-review.json`、`narrow-result.json`、`source-regressions.json`、`final-result.json`、`browser-result.json`、`final-source-initial.json`、`final-source-before.json`、`final-source-after.json`、`screenshot-review.json`与`accepted-validation-result.json`。下一候选管理员本人资料仅做来源/现有服务静态侦察，不计本批完成。

本地运行与静态来源不能替代真实账号、真机、其它浏览器、远端CI或生产发布验收。本批无commit/push/PR/merge/deploy、生产数据库写入或外部通知；整个PHP→TS迁移继续。
