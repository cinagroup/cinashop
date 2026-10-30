# 公众号自定义菜单作者与发布迁移（2026-10-27）

本批从已接受的砍价查询基线继续，补齐固定 PHP 版本的公众号自定义菜单编辑与发布流程。整体 PHP → TypeScript 迁移仍进行中。下列数字来自同一冻结源码的最终十项实际门禁。

## 业务合同

固定 PHP ref 为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。活跃入口 `/admin/app/wechat/setting/menus/index`、读取和发布 `app/wechat/menu`，菜单为两层、最多 3 个一级菜单及每组 5 个子菜单，作者字段为 `name/type/key/url/appid/pagepath/sub_button`，动作覆盖 click、view、miniprogram。`id:0` 是原编辑器的临时值，不是新业务 ID。

PHP 先调用微信 menu/create，只有微信明确返回 errcode=0 才写 `cache.key=wechat_menus`。本批保留这一结果语义，并补充远端请求与数据库不能原子提交时的持久记录。删除最后一个本地按钮仍不能发布空菜单；原合同不存在远端清空菜单操作。

原权限种子92为页面查看，507为精确GET，508为精确POST。绑定同时核对id、pid、type、module、controller、action、authType、apiUrl、methods、menuPath及uniqueAuth；access/is_del沿用有效目录过滤。复制路径、漂移种子及泛公众号内容权限不能取得菜单发布能力。独立能力为 `wechat_menu.view/manage`。

## 实现与可操作路径

后台页面保留原 alias，新增 `/content/wechat-menu`。支持选中、增加、确认删除、完整父子菜单编辑、三种动作切换及移动结构预览。切换动作保留本地隐藏字段；发给微信的父菜单只含名称和完整子菜单，叶子只含当前动作需要的字段。小程序同时要求appid、pagepath和旧客户端备用url。

两套后台前缀 `/adminapi` 与 `/api/admin` 均注册：

| 方法 | 后缀 | 语义 |
|---|---|---|
| GET | `/wechat/menu`、`/app/wechat/menu` | 完整本地文档、版本与未决发布 |
| POST | `/wechat/menu` | 明确确认、版本绑定的持久发布 |
| POST | `/app/wechat/menu` | 原 `{button}` 合同；仅已知发布及本地保存成功返回旧式成功 |
| GET | `/wechat/menu/operations/:operationId` | 当前有管理权限的账号读取真实发布记录 |
| POST | `/wechat/menu/operations/:operationId/observe` | 读取微信默认菜单；不合并个性化菜单 |
| POST | `/wechat/menu/operations/:operationId/resolve-missing` | 使用完整原稿核对；仅无受理记录时原子封存为not_dispatched，阻止晚到请求发送 |
| POST | `/wechat/menu/operations/:operationId/confirm-observation` | 对签名观察作明确人工确认，再次读取微信并记录独立的人工匹配结果 |

原POST兼容可接 `X-Menu-Operation` 保持原标识；缺省由服务端生成。未知或已远端接受但未保存本地的结果不会向旧调用方返回可误认成发布成功的200消息。新调用方可读取结构化状态与原操作标识。

## 输入、历史与微信传输边界

共用作者模型按UTF-8字节校验名称16/60字节、点击KEY128字节、网页URL1024字节；点击KEY还明确受成熟回调64个UTF-16字符单位的消费边界约束，不修改成熟回调。完整小程序页面路径另受本项目2048字节预算约束。URL仅接受完整HTTP(S)、不含账号密码或控制字符。无效Unicode、未知字段、未知动作及三层结构均拒绝。

完整本地历史保留原raw及过期信息。过期、损坏或不支持的历史不会变成虚假的空数组；不能完整编辑时显示原文并要求明确整体重建。发布记录保留覆盖前的完整cache文档及元数据。

微信客户端刷新可能有延迟。接口规则、适用账号范围与小程序关联要求以本次读取的[创建菜单官方文档](https://developers.weixin.qq.com/doc/service/api/custommenu/api_createcustommenu.html)、[查询菜单官方文档](https://developers.weixin.qq.com/doc/service/api/custommenu/api_getmenu.html)、[access_token官方文档](https://developers.weixin.qq.com/doc/service/api/base/api_getaccesstoken.html)为依据，原文证据及SHA位于本批受控WORK归档。

新provider使用独立的当前数据库凭据快照及私有token请求，固定 api.weixin.qq.com 的token/menu-create/menu-get三个端点，10秒总期限、64KiB响应上限、严格UTF-8、禁止重定向。每个已受理UUID最多发出一次菜单POST；不会在未知响应或失效token后自动重发POST。读取失败不伪造空菜单，46003也不推断为空。原凭据、token、provider原始错误文本不会进入响应、回执或日志。

## 发布记录、权限与恢复

`admin_wechat_menu_operation` 是独立显式维护安装的addon。基础185步/283表保持固定；addon额外一表、两个索引、无序列、无外键级联，immutable触发器拒绝UPDATE/DELETE/TRUNCATE。App没有该表权限；Admin仅有SELECT/INSERT，无新SECURITY DEFINER能力。

`runAdminWechatMenuUpgrade` 只在明确的维护连接、PG16、已准确commission的当前全店App/Admin profile下安装，并在同一事务检查目录与最小ACL；现存漂移会被拒绝，HTTP与启动路径不安装DDL。生产环境尚未执行此升级。

phase0先持久化受理，phase1记录已知结局。两阶段使用独立HMAC域，绑定操作UUID、账号、原文、请求、时间与完整阶段事实；复制phase0无法伪造accepted终态。短事务重新校验当前账号、角色历史、权限、登录版本和配置；短表屏障保护配置与cache的缺失键。缓存目录出现RLS、规则、继承或额外用户触发器时拒绝发布。缓存和操作写入都执行RETURNING、即时约束检查与完整回读。所有网络请求均在SQL事务之外。

| 状态 | 事实 |
|---|---|
| accepted | 微信明确接受，且本地菜单与终态在同一SQL事务保存并回读成功 |
| accepted_unstored | 微信明确接受，但账号配置或本地菜单已变化，保留本地内容 |
| rejected | 微信在成功HTTP响应中给出明确非零错误码 |
| not_dispatched | 发布POST前已失败，安全边界可确认未发出 |
| unknown | 无持久终态；不能据此重发或声称未发布 |
| observed_match | 明确人工核对后，新读取的默认菜单与原内容匹配；不证明原POST的归属或成功 |

同一UUID重放只读取已受理记录，不再次发出POST；变更原菜单或提交新读取版本却复用同一UUID会被拒绝；原正文重放始终只读取其原发布记录。未知记录阻止该公众号新建发布。浏览器在发出提交前保存按账号隔离的原操作，存储失败不发出发布。读取不到回执仍保留未知，可明确选择用原UUID及原内容继续；服务端持久受理决定是否已有一次发送。受理前版本过期409等情况可选择明确核对并封存未受理请求：服务端用与发布相同的权限屏障，在同一事务确认无记录、保存完整原稿与原版本、追加not_dispatched封存事实。晚到的同UUID发布只能读回该结果。已有受理记录时封存入口只读取原状态，不能撤回未知的远端请求，也不会因404直接丢弃本地记录。

线上观察与人工确认分开。只有完整匹配、签名未变、再次远端读取仍匹配、原请求开始至少30秒且当前账号/权限/cache均未变化时，人工确认才保存本地并封存为observed_match，不重发菜单。30秒为本地防并行核对窗口，不是微信提供的完成证明；观察不匹配或凭据变化仍需人工处理。HMAC使用现有APP_KEY；轮换该密钥前需安排历史记录的验证与维护，不能直接重新签署既有事实。

界面所有事件与异步响应绑定当前会话、持久登录态、权限、路由和页面生命周期。原事件描述符在账号/权限/路由ABA变化、重新选择菜单及新观察后均失效。顶层操作使用局部渲染描述符，避免Vue缓存事件包装器追随新会话状态；普通输入保留同一节点快速连续输入。

## 验收与来源保留

最终实际通过：后端 120、真实 Vue 原生事件 66、独立 PG16 2、来源 5074，合计 5262 个唯一用例，其中新增 343。前两轮未接受尝试不计入这些数字，也未复用其结果。第三轮同源运行的六项已完成检查保留有效；被外层中断的构建没有通过收据、不计数，随后仅在逐字相同输入上续跑构建与API清单。来源包含完整保留的 36 套 4877 个旧用例身份。Worker 两套类型、Admin 类型、Vite、实际 AST API 清单均通过；801 callSites / 839 pathVariants，原 833 个完整变体对象保留。

桌面1365、375及320的十张截图逐张视觉复核，六项 QA、真实交互、整套 dist 与源码前后哈希均通过。浏览器使用已安装 Playwright/Chrome 与本地受控 HTTP，不是向真实公众号发布的证据；生产 SQL 权限与业务行为由独立 PG16/Hono 用例承担。自有数据库 fixture 清零，PostgreSQL 进程、socket 和浏览器端口均停止。

原始最终及诊断收据、完整固定 PHP 原件、所有当前运行输入和构建产物归档于 `/home/cina/cinagroup/cinashop/.cache/migration-evidence/admin-wechat-menu-author-20261027`；完整接受清单和回执以该缓存的 `run/accepted-input-manifest.json`、`run/accepted-validation-result.json` 为准。来源 proof SHA256 `023de998579c5f44e534eda8dcfe4d4eb2088e50ee7214b0304cdf2a5d7a3088`，helper SHA256 `7fe34e23ea6859d39722b9f41e7522c545a2376b4231d00a1e09cffe49bd7e75`。接受过程保留8057前驱输入实物和1742冻结证据，台账只追加，不改原复选框。

已保留诊断记录：初次Worker类型检查发现导入路径和TextDecoder选项问题；初次Admin命令使用不存在的配置路径，已改为仓库实际配置；首次前端运行50通过/10失败，暴露缓存事件包装器导致的真实旧回调问题，修复后的诊断60/60通过；第一轮独立PG16两项通过后仍补充阶段签名、缓存触发器、缺失角色和真实旧数字权限账号场景，最终统一重跑。

本批不会更改成熟二维码/token缓存、分享provider策略、点击回复及公众号回调、普通配置缓存、既有全店基础权限计划、请求/登录存储适配器。1742份前驱证据保持原SHA，36套旧来源测试仅换导入适配器，保留全部4877个旧测试身份和原断言/负例正文。8057个前驱输入、两代327/321个Admin产物读取视图及8057/8033两个历史inventory端口均独立绑定真实物理缓存。

## 未执行的上线动作

未连接真实公众号发布菜单，未执行生产DDL，未提交或推送Git，也未部署。真实账号发布应在审阅菜单内容、维护升级及部署后的独立上线步骤执行。后续PHP→TS迁移仍继续。

浏览器初轮自动交互与六项QA通过，但逐张视觉复核发现三张移动截图滚动位置未覆盖对应编辑/预览/待核对面板；完整原轮保留在browser-diagnostic-01，不作为最终视觉证据。仅调整浏览器取景定位，在同一源码与整套dist上重新执行完整流程并复核新十图；没有借此更改业务输入或复用旧截图。


未受理原请求可以明确核对封存：仅服务端确认记录不存在时，为完整原稿和原UUID写入未发出终态，阻止迟到请求发送；已受理的未知请求不能取消。受理前409、回执404均不会只由浏览器清除原记录。新增原生事件验证封存、取消、旧回调与晚回执。

最终运行前另保留一次被源码漂移检查明确拒绝的尝试：该次后端、前端与原生数据库阶段虽通过，但随后补强同UUID必须绑定原提交revision，完整失败驱动和源码实物已归档；这些阶段不复用、不计入最终通过。第二次尝试实际后端、前端和原生数据库通过，Worker主类型以2退出（新夹具联合类型TS2339）；完整输出保留为superseded attempt02。其间新增未受理原请求安全封存且修复类型，因此原输入已失效，全部重新执行，不复用该轮阶段。最终八项runtime都实际检查修复后的同一快照：前六项完成后，外层工具在Vite阶段以143中断且没有构建结果；保存完整原驱动、六项收据、输入、原文镜像与部分产物，再逐项核对六个原log/输入SHA，只续跑未完成的Vite和API原argv。六项收据逐字保留，未把中断的构建计为通过，也未声称八项来自同一个不间断进程。最后独立执行来源与浏览器门禁。
