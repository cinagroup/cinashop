# PHP → TypeScript：Admin 本浏览器日志增量（2026-10-25）

本批接续配置分类作者，恢复原 `/admin/system/log` 的前端内存日志，现代入口为 `/system/frontend-log`，菜单名「本浏览器日志」。它与既有 `/system/log` 服务端操作日志是两个功能。仅登录即可进入本地页，不借此授予服务端 `log.view`；原服务端页面、API、Worker 处理器及权限保持原字节。本批不标记 FE-001、ADM-001 或整个 PHP→TS 迁移完成。

## 固定来源与实际行为

PHP 固定 ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。本批主来源文件 `workers-ts/audit/browser-log-source-binding-20261025.json` 固定21份完整原件与19段逐行行为片段；生成时用相邻 PHP 仓库的固定 git blob 重新核对，未运行 PHP。

原 `router/routes.js:45–52` 是 `auth:true` 的本地日志；`libs/system/index.js:196–210` 允许已登录用户，并非服务端操作日志权限。`main.js:162` 实际安装插件；`plugins/error/index.js:16–27` 在 Vue errorHandler 的 nextTick 记录错误，`plugins/request/index.js:24–47,155–196` 记录 HTTP/网络错误。业务 HTTP200/状态400 的拒绝原本不经过 errorLog；原 HTTP错误处理末尾注释了 Promise.reject 的吞错问题不移植，TS 原拒绝链继续保留。

原 Vuex log 数组仅在内存追加，使用浏览器本地时间，旧页面先显示较早记录；有 info/success/warning/error 四等级、总数/错误数和清空。原「查看」仅发通知并打开空控制台组，没有完整 Error 详情UI。`showLog:false` 只默认隐藏顶部快捷入口，不停止记录。原手写 `$log` 字符串/对象接口存在，但定点搜索除注释例子外没有活跃调用；没有原生 window.onerror/unhandledrejection、导出、上传、分页或等级筛选合同。

## 迁移实现与有意收敛

- 安装发生在 Pinia 就绪后、router/app 挂载前。模型属于整个 app；离开查看页仍记录，重新进入保留本会话记录。Vue handler 先捕获会话票据再 nextTick 追加；保留既有 handler 的参数、返回值和原始控制台错误，不捕获查看器自身的 Vue错误以避免递归。
- 通过实际共享 Axios 的 request/response interceptor 观察 HTTP和网络失败。保留原 response/error 身份与 Promise rejection，不发重试、不改原 abort signal；HTTP 4xx与5xx均保持原error等级和错误计数。取消/已abort请求和 HTTP200 的业务拒绝不伪装为 HTTP异常。401导致原认证层清会话时，旧票据失效。HTTP状态及方法只接受固定原始类型和白名单。
- 行只保留固定原始字段：id、毫秒时间、等级、固定摘要、注册页面标题/路径模板、来源、HTTP状态和方法。不保存原 Error、stack、请求/响应体、动态URL、query/hash/业务ID、用户、uuid、token或任意meta。PHP原自由文本 `$log.push` 有意改为固定摘要；任意字符串（包括error字样）仍为info，无效primitive不增加总数，null安全忽略。对象只读own data descriptor的type，不运行message/meta/type getter。新增info/success/warning/error快捷采集方法显式传入type；原PHP的success/warning/error控制台方法是装饰性stub，info快捷方法为新增，不冒称原活跃采集调用。Vue原错误继续转交既有handler或console；HTTP原error/rejection交回调用方，可在原页面提示及开发者工具Network中核对。
- 每标签页最多500条，超限丢弃最早记录并明确计数，保持原追加顺序；时间仍为浏览器本地时间。新增本地等级筛选与每页20条，均不请求后端。详情只解释固定摘要，网络失败明确提示结果可能未确认，不能当作成功或已回滚证明。
- 清空需要显式确认并固定记录水位；确认期间新增行保留。确认后旧异步票据失效。会话内容/权限变化、显式同会话事件、成功重新登录、退出、storage和auth-expired同步退役旧观察；失败登录保留既有会话和记录。普通页面把相同JSON重新填充认证对象不会误清日志。
- viewer代次独立于app记录。卸载关闭详情/确认，但不删除记录或停止生产者；旧行/筛选/分页/清空/关闭回调跨卸载重入、清空、会话ABA都不能影响新页面。app卸载撤销所有监听、观察器、action订阅和interceptor，并恢复仍由本安装拥有的原handler/$log。

没有新增 Worker 路由、SQL、DDL或日志持久化，认证层、原请求层与服务端日志接口/UI未变。现有未知写入恢复journal不读取、不修改；本地记录从不上传。

## 来源证据兼容

新主manifest固定22份修改来源、7份新实现/运行测试、36份前序dated JSON/helper与13份既有来源。17份旧测试只改变精确读取入口，原断言与负例逐行保留。外层仅接受完整当前SHA与字面全文，再恢复完整前序；随后组合既有config_class inverse，旧manifest/helper保持原字节。API报告由实际AST生成器重算并与当前全文逐字一致：709调用点/747路径，全部已注册可执行，未解析/未注册/受控不可用均0；报告仍为 `e00f364f4b64fd6eeb308a171bfdd6a0dcfe1e9ea498f359a4151921da8efec3`。

## 本地验证与边界

本批通过 **1787 项唯一测试**，其中新增 **393 项**：纯状态100、实际安装的Vue/Pinia/Axios61、实际BrowserLog SFC22、新来源合同210；既有相关回归1394。失败尝试和重复复验不重复计数。SFC使用真实compiler-dom的cacheHandlers:true；普通交互走真实emit，旧回调负例捕获实际VNode listener。运行时使用真实认证store、API及Axios interceptor，只替换平台/transport/Element端口；Vue实际组件抛错、原error/response身份与取消信号、迟到401/旧会话/clear/卸载及ABA均有运行断言。另按固定PHP补验HTTP400/403/404/408/500/503都维持error与错误计数；字符串等级字样不改变原info、无效输入不增加总数。

Admin严格vue-tsc与Worker严格tsc通过，Admin Vite生产构建通过。共享串行锁内执行，Node test并发1、Vitest单worker且无文件并行；未并发启动其它检查。Vite保留已有VueUse PURE注释提示与大chunk体积信息，未引入新依赖。

实际built Admin验收地址：`http://127.0.0.1:5203/admin/system/log?token=DO_NOT_RECORD_QUERY#DO_NOT_RECORD_HASH`，旧URL匹配现代日志页，地址本身不重定向；日志仅记录canonical路径模板，后续菜单导航至`/system/frontend-log`。1365×960、375×900、320×900；Browser plugin not available，使用已安装Playwright/Chrome、单renderer、隔离本地认证与HTTP夹具。初始真实待办GET503产生安全摘要；四等级/计数/顺序、筛选、HTTP及网络详情、无log.view仍可看本地页、原服务端页无权不读、跨LogList往返同内容认证重填不丢行、实际Pinia同payload成功登录清空/失败503保留、push('error')维持info且push(7)忽略、授权后原server log GET仍显示、HTTP503和HTTP400都计错误、网络中断追加而HTTP200/业务404不追加、505→500容量/5条舍弃、20条分页、取消清空/水位保留新行、storage清空打开弹窗、刷新清内存均通过。浏览器Vue生产者通过真实已安装errorHandler调用；实际组件throw由运行套件覆盖，不把GUI hook调用冒称组件崩溃。

375/320真实Element列表、详情、清空确认及取消/关闭均操作通过；11张最终截图逐张查看。窄屏列表边界74–365 /74–310；两个弹窗实际面板边界12–363 /12–308，scrollWidth=clientWidth。320宽标题/路由正常换行，分页位于记录之后。页面身份、非空、无框架overlay、截图和交互六类QA通过；0 pageerror、0 warning、0未解释console error。6条预期console error分别为3个503（待办GET、失败登录POST、服务端日志GET）、1个服务端日志GET400、1次网络中断、1次明确注入的原始Vue TypeError，与响应/requestfailed逐条匹配。34次本地API请求，唯一两个POST均为明确登录验收；日志自身筛选/详情/清空不发请求且不写storage，只保留原admin_token/admin_session两键。既有待办轮询单独识别，不计作日志新增I/O。

命令与执行收据：`run-narrow.py` 调用Node --test、Vitest、实际API AST与vue-tsc；`run-final.py` 执行Worker tsc、Vite build和实际Chrome。均通过 `/home/cina/cinagroup/tools/validate-serial.sh`。最终来源SHA `89328bcd0d6d8492613bb66c28dd799dad92ad703683989d11c9286d2c7a9f16`；81份窄检查输入前后相同，最终3999份源码/检查脚本输入原值，构建后加入dist字节绑定，4300份完整最终输入前后无漂移。全部36份前序dated/helper与13份既有来源保持固定原值。

失败与修正完整保留：初轮4步本身通过，但CSS在冻结后改动被源漂移门拒绝，归档first-narrow-source-drift；重冻通过后跨页复核发现同内容认证重填误清日志，改为内容观察并加成功login action边界，追加3项实际Pinia回归，旧结果归档pre-auth-resync-review。首轮GUI因Element隐藏输入被placeholder遮挡停下；first-browser-attempt保留失败截图、日志、全源冻结与已通过的types/build。只改临时脚本点击真实wrapper后整链通过，first-passing-browser保留当时11图；继而收紧实际.el-dialog面板测量并等待原页面toast结束。最终PHP计数复核发现4xx被降为warning、等级字样字符串被误当type、无效primitive被记info，已恢复PHP原计数，添加2项实际输入回归并在GUI加真实HTTP400和push输入断言；pre-http-severity-review保留此前完整阶段但不作为最终验收，http-severity-only-check保留中间复验。此后重新冻结并通过全部最终测试、来源、API、双类型、生产构建和GUI。一次排队命令用不存在的python，在取得锁前仅停止本会话两个队列进程改用python3，无结果计入。

正式主manifest与本报告在仓库，执行材料位于 `/tmp/cinashop-browser-log-author/`：`narrow-result.json`、`source-regressions.json`、`final-result.json`、`browser-result.json`、`final-source-initial.json`、`final-source-before.json`/`after.json`、`old-read-port-review.json`、`static-review.json`、`final-parity-review.json`、`screenshot-review.json`及`accepted-validation-result.json`。下一候选404异常页仅完成固定PHP与当前TS静态侦察，未实现或计入本批完成量。

本地来源、类型和隔离夹具不能替代真实账号、真实移动设备、其它浏览器、远端CI或生产发布验收。本批未commit/push/PR/merge/deploy，未操作生产数据库或发送外部通知。整体迁移继续进行。
