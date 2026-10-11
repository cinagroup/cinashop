# 旧 Admin 附件分类编辑表单 GET 合同

本轮承接真实旧消费者的 `GET file/category/{id}/edit`，返回 form-create 可消费的编辑表单；两个完整入口为 `/adminapi/file/category/:id/edit`、`/api/admin/file/category/:id/edit`。表单使用固定相对 action `file/category/{id}` 和 `PUT`，对应两个 API base 下同一受保护的分类更新 handler。本轮不改供应商表单，也不将编辑表单 GET 的补齐记作整个素材、视频、删除、未知写结果恢复或发布工作流完成。

旧源实际根为 `C:\cinagroup\cinashop-php`。本文核对可见 PHP、旧 Vue 消费者和新 Worker 服务；没有执行 PHP、opaque helper、测试、PG 或 provider 操作。验证状态见文末，未返回的检查不预填通过。

## 真实旧调用与编辑对象

`view/admin/src/api/uploadPictures.js:39–44` 的 `categoryEditApi(id,data)` 发出 GET `file/category/${id}/edit`，并将 data 放入 query。两个真实消费者均传 `{file_type:this.uploadName.file_type}`：

| 消费者 | 活跃入口 | 成功后的行为 |
| --- | --- | --- |
| `view/admin/src/components/uploadPictures/index.vue:428–440,692–695` | 对任何有 `data.id` 的树节点显示“编辑分类”，调用 `editPic` → `$modalForm(categoryEditApi(...))`。 | 弹窗提交成功后 `getList()` 重读分类树。 |
| `view/admin/src/pages/system/file/index.vue:531–546,628–635,845–848` | 有 ID 的节点显示“编辑”，Dropdown 的 `name=2` 分支实际调用 `editPic`。旁边注释的 click 回调不否定这条活跃事件链。 | 同样重新获取分类树。 |

编辑入口既适用于根分类，也适用于子分类。上一批 CREATE 为“选中的父分类只能是根选项”的限制不能套在 EDIT 的目标分类 ID 上。虚拟“全部图片/全部视频”根没有 ID，不显示编辑项；编辑目标不能把缺省、空值或 0 归一化为创建根。

`route/admin.php:693–702` 以附件分类 resource 注册 edit/update。真正的控制器是 `app/controller/admin/v1/system/attachment/SystemAttachmentCategory.php`；`:90–92` 的 `edit($id)` 只调用 `editForm($id)`，没有把客户端的 file_type query 传下去。服务 `SystemAttachmentCategoryServices.php:101–104` 直接 `dao->get($id)`，以默认 `type=1/relationId=0/file_type=1` 生成编辑表单。这意味着旧视频编辑 query 被可见 PHP 路径忽略，目标读取本身也没有显式作用域条件；这些是新合同明确修正的旧缺陷，不能当成安全兼容行为照搬。

## DTO 与旧弹窗的消费形状

旧服务 `SystemAttachmentCategoryServices.php:104` 调用 `create_form('编辑分类', ..., Url::buildUrl('/file/category/' . $id), 'PUT')`。可确认标题、方法、提交目标的语义，以及生成规则；不能据此声称已经知道 opaque helper 的完整运行时响应字节。

`view/admin/src/utils/modalForm.js:50` 消费业务 data，`:72–91` 重建 config，`:98` 直接执行 `request[data.method.toLowerCase()](data.action,formData)`，`:127–130` 将 rules 直接作为 form-create 的 rule prop、将 config 作为 option prop。编辑 DTO 必须保留真实保存值，不能只返回规则名称或创建时的空草稿。

| 新 DTO 字段 | 合同 |
| --- | --- |
| `title` | 固定“编辑分类”。 |
| `method` | 固定 `PUT`。 |
| `action` | 固定相对 `file/category/{已验证整数ID}`，不接受客户端 URL、origin 或 action。 |
| `rules[0]` | `{type:'hidden',field:'file_type',value:保存的1或2}`。 |
| `rules[1]` | `type:'select'`、`field:'pid'`、标题“上级分类”、真实保存的 pid、`props.filterable:true`；options 为 `{value:number,label:string}` 数组。 |
| `rules[2]` | `type:'input'`、`field:'name'`、标题“分类名称”、保存的名称原样返回、`props.maxlength:20`。 |

上述三条顺序与 PHP `SystemAttachmentCategoryServices.php:118–120` 一致。`vendor/xaboy/form-builder/src/UI/Iview/Components/Select.php:42–46`、`Input.php:57–64` 和 `Rule/PropsRule.php:120–122` 证明 filterable/maxlength 位于 props；`Rule/OptionsRule.php:105–107` 证明 options 是规则顶层字段。新服务不添加未经证实必需的 info/config。旧弹窗本身会重建 config；这不代表所有旧 helper 附加字段都已迁移。

保存的名称不截断、不清空。表单显示层的 20 字上限不改变现有分类 PUT 服务的 50 字服务端上限，也不能仅凭 GET 声称历史超过 20 字名称的真实浏览器编辑交互已经验收。服务端仍须独立检验名称和父引用。

## 新 parser、作用域和父分类选项

新 `workers-ts/src/services/admin/AdminAttachmentCategoryEditFormService.ts:21–30` 只接纳一个可选 file_type query；未知键、重复键和空/非法类型均拒绝。path ID 必须为无前导零的十进制正整数，最大 2147483647；0、空、负数、指数、空白、超界等输入不能悄悄变成创建请求。

错误码须区分业务信封与 HTTP：`utils/errors.ts:19–53` 的普通 Validate/NotFound 为 `body.status=400/404`，沿 PHP 兼容 HTTP200 信封；`:72–79` 的 HttpApiException 则同时带真实 HTTP 状态。历史类型/父关系409和容量503使用后者。全局 `middleware/error.ts:18–27` 分别处理这两类；不能把原生测试对 PUT 的业务404断言表述成整个主应用 mounted HTTP404 已验证。

目标按 ID 和平台 `type=1/relation_id=0` 同时读取（`:47–50`）。同平台目标可以是根或子分类；不存在、供应商和其它 relation 的目标均为 404。保存的 fileType 是权威来源：仅 1、2 有效，历史其它类型为 409；省略 query 时使用保存类型，显式 query 与保存类型不符为 400，不跨类型读取或改写。

父选项查询与目标读取在同一快照中（`:54–61`）：只含同平台、同保存类型、`pid=0` 的根分类，按 ID 升序，剔除目标本身。首项固定 `{value:0,label:'所有分类'}`，其余标签为保存名称。最多 10000 个可选真实根，以 `LIMIT 10001` 识别超限并返回 503，不截断成完整成功。PHP 原 `getCateList:129–136` 也是根级 options，但没有明确排序、上限或剔除自身。

保存的 pid 为 0 时正常显示根级；非零 pid 必须真实出现在上述候选中。深层、孤儿、跨 scope、跨类型、自指或其它不可显示的历史父引用明确返回 409，不把默认值重设为 0、不偷偷移到别的父分类。这是显式安全差异。对根/子目标提供编辑不等于允许运行中的父分类随意变动，更不等于修复所有历史损坏目录。

`AdminAttachmentCategoryEditFormService.ts:40–46` 先验证 actor，再在 `REPEATABLE READ, READ ONLY` 事务中设置 statement/lock/idle 超时，并复用创建表单的实时授权边界；返回前再次验证 token 有效期。`AdminAttachmentCategoryCreateFormService.ts:39–58` 在快照内核对管理员平台身份、启用/删除状态、level、凭据版本和实时角色的 `attachment.view`。导出复用函数不改变 CREATE 的 parser、DTO 或行为。源码证明设计边界；本批实际 LOGIN/事务与并发结果见验证节。

## 相对 action 与权限边界

旧 `view/admin/src/setting.js:14,31` 缺省 API base 为当前 origin 加 `/adminapi`，也可使用外部构建配置；`plugins/request/index.js:54,94` 设定该 base，弹窗直接使用 action。上一批 CREATE 审查已经发现以 `/adminapi/...` 开头的 action 会被 Axios 当作相对路径追加，产生双前缀。

本批 EDIT 延续固定相对 action，两个正确目标如下；本批 PGlite/Hono 已验证两个 base 对应的受保护 PUT。独立 Axios 计算与真实旧浏览器交互的证据范围仍须分别说明，不能混同。

| API base | DTO action | 对应 PUT URI |
| --- | --- | --- |
| `origin/adminapi` | `file/category/123` | `origin/adminapi/file/category/123` |
| `origin/api/admin` | `file/category/123` | `origin/api/admin/file/category/123` |

`workers-ts/src/routes/adminapi.ts:313–314` 和 `routes/v1/index.ts:2327–2328` 的 GET/PUT 入口均经过 `adminAuth`，共用 `AttachmentController.adminCategoryEditForm/adminCategoryUpdate`。控制器 `AttachmentController.ts:331–342` 为 Admin GET 设置 `private,no-store` 和 `Pragma:no-cache`，PUT 继续复用原平台分类服务。供应商编辑仍走旧供应商 helper（`:339`），本批不声称修正其合同。

`AdminPermissionService.ts:298–305` 将两个 API 前缀归一化；附件组 `:143–147` 匹配 `file/category`，`:435–436` 要求 GET/HEAD 为 view、PUT 为 manage。只读者可以获取编辑表单，但不能因此更新；新增 v1 alias 不扩 grant。新 GET 不写数据库，也不代表提交后的分类必然仍存在。

现有 `AttachmentService.ts:1180–1228` 在更新时取得 scope advisory transaction lock，同类型分类集 `FOR UPDATE`，重新检查目标、重复名称、父存在、自指和祖先循环；更新只设置 name/pid，不切换保存文件类型。GET 不替代这一提交时校验。旧 PHP controller `:112–115` 对“有下级且修改上级”另有显式限制；本轮没有声称改动或补齐该限制，现有现代写协议保持原样。取得表单后变化的安全拒绝，PGlite 与原生测试各自覆盖的范围见验证节。

## 原始旧源字节证据

下列路径均相对 `C:\cinagroup\cinashop-php`。哈希是本轮完整文件实际字节 SHA-256，不是 Git blob ID 或测试凭据。行号指向本文具体消费与生成位置，没有复制完整旧文件。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `route/admin.php:693` | 183912 | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| `view/admin/src/api/uploadPictures.js:39` | 2532 | `9c1d7fc6b32d69261552faf52caddd8dbf0b08fbedde7e896d193e32ee3b4485` |
| `view/admin/src/components/uploadPictures/index.vue:428,692` | 32870 | `a2cdf6a665995b69ab03ec1767f758df36c3931fb1c9f6368c34a385ffec5036` |
| `view/admin/src/pages/system/file/index.vue:531,628,845` | 39580 | `578de8978ea974e70b78aec47b7c8ffbe9162e02b512154bd55fb3157a116211` |
| `view/admin/src/utils/modalForm.js:50,98,127` | 5245 | `9a874601934c710bb106857c17f1b6e78a38173efd810b3e58e7f3b817ab94b5` |
| `view/admin/src/setting.js:14` | 4715 | `4523d74b4a297ca11a218c4eadabde154ebda08bf13f35073bde5292073f0cd9` |
| `view/admin/src/plugins/request/index.js:54` | 6699 | `9dd5ce11bee5aaf3c43c0ca7215993866e1fac85cd444024f37dc576d08644d5` |
| `app/controller/admin/v1/system/attachment/SystemAttachmentCategory.php:90` | 3697 | `69e5b2c21a10d7426d07c3a5c1e318549328b2164ca778896fbbb1e0e8ac8548` |
| `app/services/system/attachment/SystemAttachmentCategoryServices.php:101` | 6317 | `1d6fc67e988964406fcfcea7714ca76737acc66f4f42862eb30d87813778ba71` |
| `app/dao/system/attachment/SystemAttachmentCategoryDao.php:44` | 2065 | `68d6eb817129b6ef4dada3a3e2ebf594cc31754832c43ac7683cb0f57aa2b294` |
| `app/model/system/attachment/SystemAttachmentCategory.php:55` | 2645 | `7c62185d29ea86a015699bb5df7f24a904f41eee3377671c84054c47ab1fa3fa` |
| `vendor/xaboy/form-builder/src/UI/Iview/Components/Select.php:42` | 2342 | `0cede98105d52d89238297864f6795fb5549d835c9eabc948930a5820f599f6a` |
| `vendor/xaboy/form-builder/src/UI/Iview/Components/Input.php:57` | 2905 | `3353e56a5a323aafd68349dc54de1ebc7d4fd411e2e2533ab10f750fd6c0d98f` |
| `vendor/xaboy/form-builder/src/Rule/PropsRule.php:120` | 2450 | `695214a2c8e5e71ad83ce7c6214fe612debf37cbdabc4d918fd19de2361543d5` |
| `vendor/xaboy/form-builder/src/Rule/OptionsRule.php:105` | 2151 | `f735d9c765943d943797431d9f559807fc5342c83adf351abf102220f967f1e6` |
| `app/helpers.php:1`（opaque） | 105440 | `5ed1ad26409bc86839701855d620c3855f34163d76bd88be2243031f98f5d8a5` |

`app/helpers.php` 是 swoole_loader 载荷，create_form 函数体没有从可见源码恢复或运行。本文仅使用已散列文件、可见服务调用、form-builder 序列化与 Vue 消费链；不声称完整 helper 配置、全部附加字段或旧 PHP 运行 DTO 的逐字节等价。

## 验证状态

**本批有限合同验证已完成。** 已完成旧消费者、PHP 可见合同和新服务 parser/DTO/scope/权限边界的只读互核。本文作者没有运行测试或 PG，只读取实际日志与源码。最终业务51、回归19与native02的3项合计73；unit-types02/runtime-types01实际均0。unit-types01真实失败与native01被替代状态如下保留；上一批CREATE的44个测试、类型和审核不作本批EDIT成功信用。Root另保存[本批汇总验证收据](../audit/admin-category-edit-form-validation-20261008.json)，绑定实际raw hashes与最终Source inputs；本文冻结先于该汇总生成，不预填提交、推送、CI或发布。

本批后端代理第一次业务执行已实际退出 0：两个文件 51/51 通过，其中 EDIT 29、CREATE 22 为当前代码的实际回归。本文作者已只读核对 `C:\cinagroup\cinashop\.cache\admin-system-implementation-20261008\admin-category-edit-business01` 的原始 stdout、空 stderr 和值为 0 的 exit 文件。

| 当前业务原始证据 | 字节 | SHA-256 |
| --- | ---: | --- |
| `stdout.raw`（2 files / 51 pass，9.85s） | 9360 | `2dcdbc0306463309dd180da0d9fa4aded071a1344955cdd3d2fccb9794f6ca16` |
| `stderr.raw`（空） | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `actual-exit.txt`（值 0） | 1 | `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9` |

范围是实际 PGlite SQL、Hono/JWT 和本地 fixtures：根/子目标与保存类型、真实名称不截断、严格 query、完整 10000/10001 选项、不可显示父关系、实时身份/权限、RR 只读设置、两个相对 action 的 GET/PUT 和读者拒写、既有写服务在 GET 后重新验证目标/父类型与 scope、供应商和现代 50 字合同回归。它没有启动 native PostgreSQL、调用 provider、执行 Axios 或完整旧 Vue/browser E2E；不能把事务设置 spy 等同于真实 PostgreSQL 的事务或并发证明。

Root 的本批既有素材/路由/API 回归实际退出 0：三个文件 19/19 通过。当前业务和回归为 51+19=70 个已返回测试；不累加上一批或相同 CREATE 的旧执行。Root 的独立本机 Axios 1.20.0 `getUri` 记录验证了两个 EDIT base：旧带 `/adminapi` action 均双前缀，相对 action 均得到正确 `/file/category/12` URI；这是无 HTTP 的本地计算，不是旧 Axios 0.18.1 或真实浏览器渲染。

Root 本批最终原生 native02 实际退出0，PG16.15的一个文件3/3通过，测试耗时8.17s。第一项使用独立的真实SELECT-only LOGIN，在三个GET的真实事务上读取current/session user、PID、isolation与read_only，断言RR/on，并实际拒绝分类DML和login_count写入；四表及分类完整行保持。另两项由不同peer运行真实Hono的adminAuth/controller PUT，独立writer持有准确scope `505610/0` 锁，`pg_blocking_pids` 确认saving PID实际等待；writer提交删除父分类或改变目标relation后，PUT返回业务404，完整分类行仅包含writer的变化。pending在finally中排空后再关闭peers。

这是本地Hono harness执行真实middleware/controller与原生数据库，不是完整主应用mounting或真实浏览器证明；精确源码路由登记另由业务套核对。只读LOGIN的权限证明不延伸到更新fixture使用的协调/写入数据库角色，runner的finance_test建库角色本身为superuser。当前唯一测试为51+19+native02的3=73；native01不重复计数，静态审查不计作测试。

首次native01曾实际退出0、3项通过/10.04s，但因helper类型修正被替代，不作最终字节信用。其原始日志记录owned `finance-postgres-dqeIBc`、loopback port52941、`FINANCE_LOCAL_FIXTURES remaining=0`和STOPPED；Root独立pg_ctl status实际退出3、无运行中的server。首次test15494字节／`fd74b411f0ba9a07301c4fd1e3d6189041c1e215c74fc844e50098dda068af53`的证据保留。runner43328字节／`60bd8332c168a3456921e3b8131a65befddf6e4fff1bc36e072814c1e09f18a1`仅加入本test allowlist，旧创建native文件12503字节／`48de2da31199a3b833c28408090a8147abc4ef1b579972b59aeb72da114cec69`保持。

Root完整unit-types01实际退出2，原始stdout306字节记录TS2345：native test:226将 `Response|Promise<Response>` 传给仅接纳Promise的outcome。runtime-types01实际退出0，stdout/stderr均空。只为putForm加async的6字节修正后，最终test15500字节／SHA-256 `671fd58065dcc85ab95922ed622f410ba668fe3a070ebb70d3d486bd2978b5d6`；业务产品源码、断言和其它测试不改。新unit-types02完整 `tsc --noEmit` 使用8GB堆上限、实际退出0，stdout/stderr均空。最终类型结果是unit02/runtime01两个0；runtime输入未变，没有为凑计数重复执行或抹掉首次类型失败。

最终native02的独立owned cluster为 `finance-postgres-HvnQyy`、loopback port60751，实际日志再次记录remaining0与STOPPED。Root于09:45:48.252Z用该精确data路径独立执行pg_ctl status，实际退出3、无运行中的server。两次原生执行及两份停止记录均保留，不删除或声称归档这些原始data。真实provider、生产、完整浏览器、Linux当前提交CI、push和发布均无本批信用。

Root 的本批 route/API 审核实际退出 0。route 为 PHP1904／Worker2343，精确匹配914中893可执行、21受控不可用，990未匹配减17退役为973可行动缺口，有效可执行覆盖47.3%；Admin905不变。增加两条 v1 别名不让原已登记的 canonical URL 重新计作新覆盖。API为602处调用／633变体，633全注册且可执行，未解析/未注册/受控不可用均0。两个新日期的 audit JSON 是实际完整 raw copies；API本批结果字节恰与上一批相同不等于未运行，本批执行记录独立保存。

上述 Root 外部证据位于 `C:\Users\cina\.codex\visualizations\2026\09\26\01a0db11-74a0-7cc2-b1f9-ee3b8653056a\checklist-route-contracts-20261008\category-edit-form`，本文作者已物理读取：

| 当前外部原始证据 | 字节 | SHA-256 |
| --- | ---: | --- |
| `regression01.execution.json`（exit 0） | 596 | `280d6651a27dd14023263741c6478a602079ad302c3d13c3b0ce94200e4a971b` |
| `regression01.stdout.txt`（3 files / 19 pass） | 272 | `63c5e44c583fdf117dab253ed25b281b97830299e20213caef3ce63339d273e8` |
| `regression01.stderr.txt`、`route01.stderr.txt`、`api01.stderr.txt`（空） | 各 0 | 各 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `route01.execution.json`（exit 0） | 398 | `75c3c5abb6e0f8d5beb348e3db9631229c03d376e85fb72321df2cc3ae7efded` |
| `route01.json` | 1301122 | `fa37b3db187af659b0c2d8834de2ba2cfffce34162892bdc1e8222129115f148` |
| `api01.execution.json`（exit 0） | 418 | `011dc36168d4ca03c2d293dfc5d7471751144798cd4200412f7b8530622b6f49` |
| `api01.json` | 379508 | `7ff15304e1acbe6e75a9e16cf113b0c2a2f580c793d56c1eee5ad44d8ec08c68` |
| `check-edit-action-uri.mjs` | 968 | `cab82b3ab1046f5d0c43f63cbdd9570e4374ec3ec04a230f5ad9540cf23b08c9` |
| `action-uri-evidence.json` | 641 | `9ec0bb147f42ec19d159dd70ec847d6a917caa1e09d77155c26fe453a8bff076` |
| `native01.execution.json`（exit 0） | 525 | `4954cfa206b373ea14c4e38214761d8437f84646e989cfb40b4cca4bf0b779bb` |
| `native01.stdout.txt`（PG16.15、3 pass、remaining0、STOPPED） | 1002 | `81d4ffb55722d6a9bb850c71573eb7051e11402d40d380b71ebf574e63dfafbe` |
| `native01.stderr.txt`（空） | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `pg-stopped-status.json`（exit 3、no server running） | 522 | `eeab0356af7e937fcc859e0c2028bd41cb5eb2bbf55bb96a492f1acfb4904012` |
| `unit-types01.execution.json`（exit 2，保留失败） | 416 | `f477388d3e1bfc8fcf4ea4506adeb2e5c8c54df510a6a7b5fa8fdbbcb60a7a07` |
| `unit-types01.stdout.txt`（TS2345） | 306 | `ac5a22236772e1ec77527698716b9cc3863f581bf306c918dd8bea5e7618f708` |
| `runtime-types01.execution.json`（exit 0） | 463 | `2fbb6c120f599696ad3765145d1db1afdbac95c881ad1be5e472f5f01d0b0e0e` |
| `unit-types01.stderr.txt`、`runtime-types01.stdout.txt`、`runtime-types01.stderr.txt`（空） | 各 0 | 各 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `native02.execution.json`（最终exit 0） | 531 | `5a955ef07bac622a6155308f7e831314a4e395183633a8e2f240ac4aee752813` |
| `native02.stdout.txt`（PG16.15、3 pass、remaining0、STOPPED） | 1001 | `179908e7e12679eac661bb2cf0a5b83cb6cdd0fdf12cd346796a45a84c472cef` |
| `native02.stderr.txt`、`unit-types02.stdout.txt`、`unit-types02.stderr.txt`（空） | 各 0 | 各 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `pg-stopped-status02.json`（最终exit 3、no server running） | 522 | `159f298241aad498e11bb93eda0e2fbda68c91d552210982ccae0fab35a30441` |
| `unit-types02.execution.json`（最终exit 0） | 427 | `1e01543758fa033e8cb5b4989f8b8ceb84fb1085ea29c754d717b6b016008e33` |

清单与全局分布已依据 Root 本批实际路由数据更新说明；复选行保持，实际计数仍为404总项／249完成／155开放。`ADM-001`、`ADM-007`、`FE-001` 等复合父项继续开放，不能按注册端点数量或补齐一个表单就勾选整个工作流。真实旧 form-create/browser 交互、供应商、完整视频工作流、生产和发布没有预填通过。
