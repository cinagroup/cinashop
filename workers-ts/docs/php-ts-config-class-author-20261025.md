# PHP → TypeScript：Admin 配置分类作者增量（2026-10-25）

本批接续已验收的 Uni 搜索热词。补齐 `/config/classes` 分类元数据作者，并兼容原 PHP 分类页 `/admin/system/config/system_config_tab/index`。已有十字段 schema、CRUD 和索引继续使用；本批没有新建分类表，也没有恢复通用 `system_config` 键值编辑器。旧分类页里的「配置列表」钻取是更宽的字段/值编辑合同，本批仍不开放。FE-001、ADM-001 与整个 PHP→TS 迁移保持未完成。

## 固定来源与字段

PHP ref `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`；9份全字节原件、11段逐行行为片段与独立人工默认对照，保存在 `workers-ts/audit/config-class-author-source-binding-20261025.json`。生成时重新用固定 git blob 对比 scout 原件。原件证明来源；已接受的实现/测试证据另列，准备材料本身不计完成。

| PHP 作者字段 | 新建默认 | 本批合同 |
| --- | --- | --- |
| is_store | 0 | 总后台0 / 门店后台1，父级同范围；已有子类或配置引用时禁止跨范围迁移 |
| pid | 0 | 完整同范围目录；排除自身、后代和无效祖先；旧 cascader 数组取末项 |
| title | 空串 | 显式保存必填；现代最多255 Unicode码点，不静默截断 |
| eng_title | 空串 | 必填、同范围唯一；旧无intent请求仍先trim再去重 |
| icon | 空串 | 原符号字符串，最多30 Unicode码点；原生输入替代旧图标选择器，不接图库或媒体签名 |
| type | 0 | 原选项0系统 / 3其它，旧历史值可原样保留 |
| status | 1 | 原表单显示1 / 隐藏2；列表开关显示1 / 隐藏0；不在挂载时相互转换 |
| sort | 0 | 非负31位整数；读取仍按sort DESC / id ASC |

已有 `info` 是第九个持久值、并非PHP作者控件。新增时固定0，编辑时原样携带、服务端核对并禁止修改。当前历史 status/type 不在原选项时明确显示并保留，只有用户选择才改变。

原生 Element Plus 八字段表单有意替代 form-create；图标使用符号输入。新页面从完整flat目录在本机筛选、排序树序/折叠与每页20项展示，筛选按名称包含匹配，不把本页缺父的行伪造为有效根。旧 REST 列表仍复用原SQL筛选、分页后构树和匹配行count，保持独立用途。

## 读取与图结构

新增 `GET /adminapi/config_class/catalog` 返回十字段flat list、精确count和64hex全目录revision，包含两个后台范围。最多5000行，查询5001探测超限后明确503；没有分页截断或隐式排除历史行。revision包含xmin，防止值改回原样的跨事务ABA。前端对整批行、唯一ID、count、revision严格验证；任何不可支持行让整批显式失败，写入暂停。

图结构缺父、跨范围、循环保留行和诊断，可在新原生表单修复。完整祖先判定用迭代memo，每行只求解一次；显示路径只保留最近四个祖先和省略提示，缩进最多六层，但目录和可选有效父级不丢行。候选父级来自完整目录，排除自己、后代及所有坏祖先链。旧form-create兼容接口对坏图或超过128层明确503，防止递归溢出或返回假完整表单；新flat目录仍可读取5000层的完整数据。

同时注册 metadata detail/receipt 与精确 `/setting/config_class`、`/create`、`/:id/edit` 原接口；`/adminapi` 和 `/api/admin` 两个现有前缀的旧六个CRUD处理器统一委托同一个新服务。状态写只使用PUT。既有 SystemMetadataService 文件字节未变，原表单能力继续保留；其旧分类写函数已无路由调用。

## 写入、权限和回执恢复

所有分类写在同一事务中：既有Admin权限写屏障、live realm/密码/角色历史及 config.manage、全目录advisory namespace731622、分类与配置引用表fence、业务验证、完整回读与专用system_log审计。事务结束前复核数据库时钟、会话与live权限；任何触发器改info/邻行、审计失败、撤权或到期都回滚。读取在只读重复读事务内复用既有live config.view/角色历史授权，并复核数据库时钟；不读取配置值或执行媒体/外部请求。

满5000项时只禁用新建，现有分类仍可编辑、删除和切换状态；服务端对已知满容量拒绝返回绑定的409未应用证明，已成功UUID在满目录下仍先重放原回执。

新UI写入使用UUID v4、expected_revision及固定顺序canonical摘要；request_id不进入payload_hash。同一UUID的同actor同操作同摘要重放返回原已验证回执，重用为其它操作/载荷/账号则拒绝；删除后仍可重放删除回执。旧无intent调用保持 `{id}` / null 结果，文本trim、UTF16旧限额、非字符串icon空串及旧数值fallback/Number拼写保持兼容；readonly info、角色/范围/引用与控制字符保护收紧。现代intent仍使用完整九值与严格字段/路径，旧status路径也只允许规范0/1，不扩大非规范URL写入。

未知结果先在本机保存原intent再发送，持久记录不含token或配置值。每actor+UUID使用独立localStorage键，避免同账号多标签页覆盖/删除另一条未确认请求；恢复时逐条核对原回执。成功只删除完全匹配的那一条，再恢复下一条；异常/损坏的记录不会静默删除。回执缺失保留原HTTP200/业务状态404合同，仅开放用户主动原样重试，不自动生成新UUID。服务端仅在已完成canonical、live授权和业务拒绝且事务确认回滚后，返回严格绑定 `CONFIG_CLASS_NOT_APPLIED` 的HTTP400/409证明；网络/SQL/commit/rollback未知、权限失败、一般400/404/409均不能释放原请求。

前端以owner/session/view/editor/draft单调代次保护请求与原生控件：同token/同uid替换、权限变化、A→B→A、筛选/分页/折叠、编辑器关闭重开、草稿改回原值和卸载都不能复用旧提交。每次输入保留同一挂载节点及稳定field key；表单setter只绑定本编辑器，保存还绑定草稿revision。上下文变化会abort真实Axios请求，阻止晚401对同token替换会话清登录，也阻止旧成功/错误/finally修改新状态。读取下一条本机journal摘要后的每条continuation也重新检查会话。开始新编辑、意图或原样重试时清除上一笔完成提示，避免在新未确认请求中显示旧的成功状态。

## 验证与边界

本批通过 **1739 项唯一测试**，其中新增 **558 项**：前端数据/模型132、实际Vue SFC126；真实Hono/JWT/PGlite SQL87；新来源/合同213，以及既有相关回归1181。失败尝试和重复复验不重复计数。Admin严格vue-tsc与Worker严格tsc通过，Admin生产Vite构建通过。本地Hono/JWT/PGlite是真实业务SQL和回滚证据；不是原生独立数据库会话、运行角色权限或生产锁竞争验收。实际Vue套件编译真实页面、API、Axios interceptor与model，cacheHandlers:true；只替换认证存储、HTTP transport和Element控件端口，普通输入走真实emit，旧listener测试仍回放捕获的实际父VNode回调。

当前Admin API清单由原AST生成器重算为709调用点 / 747路径变体，全部已注册可执行，未注册/未解析/受控不可用为0。此前703/741仍作为完整前序固定在本批增量中。旧dated JSON和helper不改；16旧测试只增加精确外层文件读取/实际报告变换，旧断言和全部负例继续执行。新逆变换使用literal函数替换，避免旧源码中的 `$&`、`$`特殊替换符破坏全文前序。新API报告、全部路由行位移与元数据逐字校验后，才让旧合同恢复其历史视图。

执行产物位于 `/tmp/cinashop-config-class-author/`；正式来源主manifest与本报告在仓库。没有commit/push/PR/merge/deploy，也没有改写生产数据库或发送外部通知。真实账号/真机、原生独立会话权限/锁竞争和正式发布仍未验收；通用配置值作者保持停用。


实际built Admin浏览器：`http://127.0.0.1:5197/admin/system/config/system_config_tab/index`，1365×960、375×900、320×900；Browser plugin not available，使用已安装Playwright/Chrome单renderer的本地隔离夹具。桌面真实八字段表单创建与更新、稳定input节点、父级范围切换、历史info/status/type保留、名称/范围筛选及折叠、列表状态0、删除取消/确认、成功丢回包→只查回执、未应用丢回包→404后同UUID/同载荷重试、整批坏DTO/503恢复，以及375/320窄屏列表和同token只读会话切换均通过。8次写请求中1次为同UUID原样重试，回执恢复不新增POST；记录30个本地API请求。7张截图已逐张查看，桌面和两种窄屏无横向越界。0 pageerror、0 warning、0未解释console error；3条预期错误分别是2次主动丢写回包和1次catalog503，与一个HTTP失败及两个requestfailed逐条对齐；缺失回执遵循HTTP200/业务404原合同，不产生HTTP错误。

最终主来源SHA `6c208914768010f36feee20b1d493aa5150cd2e33ea501c35d375a91c192e922`；最终全量八步均通过且91份输入前后无漂移后，仅临时截图采集增加「所有实际状态标签完成挂载并恢复自然尺寸」等待，再单独串行通过GUI；其余90份源码/证据/执行输入逐字未变，首七步原结果与归档及哈希严格绑定。最终当前91份输入亦逐字核对；34份前序dated JSON/helper与12份既有生产来源保持原值。新全文逆变换与报告外层均只接受已固定的完整当前/前序；16旧测试的导入/生成器端口适配已差异复核，原负例和断言保留。当前API报告SHA `e00f364f4b64fd6eeb308a171bfdd6a0dcfe1e9ea498f359a4151921da8efec3`。 独立语义差异复核保留741条旧调用全文、106份旧frontend source SHA及1673条旧注册的method/path/handler；新增6调用和20条分类metadata路由，既有注册仅移动行位。

失败/修正收据保留：初轮前端34项失败因仅等事件循环而未等待真实WebCrypto，helper改为观测并转发原生digest Promise后通过；Admin初轮1GiB自身堆退出134，采用既有Admin规模的4GiB上限（实际约2GiB RSS）后发现并修复reactive泛型/optional boolean的3处类型诊断；Worker检查发现Node URL与Cloudflare URL类型冲突，按href字串交给fileURLToPath后严格检查通过。旧证据回归16项失败分别来自实际新API报告缺少最外层完整inverse、全文字符串replace的$替换语义和阶段源未重新冻结；仅本批外层改用严格全SHA映射和literal callback，旧helper/dated JSON未改。首次SFC过滤例使用的host快照listener不会随仅emit listener更新重渲染，普通测试输入改走真实native event→Vue emit，专门旧listener负例仍回放实际旧快照。首轮GUI定位器点到Element readonly输入，改点实际select wrapper；后一轮所有业务流程已过，复核发现浏览器夹具把缺失回执错误设为HTTP404；最终改成真实HTTP200/业务404合同，并精确核对1条HTTP503及2条主动网络中断。容量用例也修正同一envelope预期；不改变后端既有响应。GUI首屏「显示」同时命中标签和按钮，临时定位器限到.el-tag后仅复跑GUI；随后逐图复核发现上笔成功提示会残留至新未确认请求，已在新编辑/intent/重试时清除旧提示，真实SFC连续操作与GUI都加回归断言，并重新进行最终全量相关复验。截图关闭过渡动画采样，避免把入场/离场中间帧当作静态布局。复核另补restore摘要await后的会话guard、legacy文本/数值合同、满容量已知拒绝证明及禁新增。失败与pre-capacity验证阶段完整保留，未计作最终通过。

最终执行回执：`/tmp/cinashop-config-class-author/validation-result.json`、`accepted-validation-result.json`、`frontend-all.log`、`worker-catalog.json`、`worker-source-regressions.json`、`browser-result.json`、`compatibility-diff-review.json`、`validation-source-before.json`、`validation-source-after.json`。共享串行锁、Node单test并发/Vitest单worker无文件并行；这些是本地证据，不宣称远端CI或发布。窄屏新增/编辑/恢复弹窗、其它浏览器和真实移动设备不在本轮GUI验收范围。
