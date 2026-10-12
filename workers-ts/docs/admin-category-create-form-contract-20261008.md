# 旧 Admin 附件分类创建表单 GET 合同

本轮核对旧 `GET /adminapi/file/category/create` 及对应 `/api/admin/file/category/create` 别名，承接 query 中的父分类和文件类型，返回旧弹窗可消费的创建表单 DTO。表单提交目标使用固定相对 action `file/category`，两种 API base 下的 POST 共用原创建 handler；新增别名不扩大读者的写权限。已有 `/file/category/create/:parentId` helper 路径是另一种调用形状。本轮不因补齐表单 GET 而宣称旧编辑、附件选择器、整个视频上传、保存、删除或发布工作流完成。

旧源实际根为 **`C:\cinagroup\cinashop-php`**，以下证据均为本机只读核对的具体文件、行号和完整文件 SHA-256。真正的旧控制器在 `app/controller/admin/v1/system/attachment/SystemAttachmentCategory.php`，不是缺少 `attachment` 目录的相对路径。本轮未执行 PHP 或 opaque helper。

## 真实旧消费者

`view/admin/src/api/uploadPictures.js:27–32` 的 `createApi` 发出 GET `file/category/create`，将整个参数对象放在 query。`view/admin/src/components/uploadPictures/index.vue:788–793` 传 `{id:treeId,file_type:uploadName.file_type}`；表单提交成功后重新获取分类树。

| 参数 | 真实来源及语义 |
| --- | --- |
| `id` | 表单父分类 ID，不是待编辑分类 ID。`treeId` 初始值是 0（287）；`add()` 重置为 0（743–746）；切换图片/视频 tab 重置为 0（393–397）；节点缺 ID 时归 0（646、659）。新增菜单只对根节点提供（412–426）。 |
| `file_type` | 旧组件以字符串保存类型，初始值 `'1'`（284），mounted 从 `fileType` prop 或 `'1'` 初始化（320）；图片、视频 tab 分别使用 1、2。新合同接受对应 query 值 `'1'`、`'2'`。 |

素材中心另一真实消费者 `view/admin/src/pages/system/file/index.vue:974–979` 使用相同 query。这里 `append()` 在 810 行直接赋 `data.id`，虚拟根节点的 ID 是空字符串（861），因此空 `id` 是真实兼容输入。新接口将缺省或空 `id` 归一化为 0，并将合法 ID 转为整数；旧 PHP 表单也在 service:119 把 pid 显式转为整数。不能把任意非法 ID 通过 `Number(value) || 0` 悄悄变成根级，或将非法文件类型变成图片类型。

新 parser 仅接受 `id`、`file_type` 两个 query 键；拒绝重复、未知参数。ID 除缺省、空和 `'0'` 外，必须是无前导零的十进制正整数，最大 2147483647；文件类型缺省为 1，仅接受 `'1'`、`'2'`。path-param helper 若同时收到 query ID，二者必须一致。上述实现约束已只读互核，并由本轮修正后的 22 个实际业务测试覆盖其接纳和拒绝边界。

`route/admin.php:693–702` 以附件分类 resource 注册 create 等动作。旧控制器 `SystemAttachmentCategory.php:57–62` 把 `$id`、平台 `type=1`、`relation_id=0` 和 `file_type` 交给创建表单服务。虽然这里调用的方法名为 `postMore`，实际 `app/Request.php:59–77,132–134` 经 `more` 读取 `param`，不是仅从 POST body 读取；不能因方法名而断言旧 GET query 的文件类型被忽略。

## 弹窗消费的 DTO 与规则

旧请求层先解开成功业务信封；`modalForm.js:50` 消费业务 `data`。以下是由可见服务调用、表单规则生成器和 Vue 消费者共同确认的语义形状，不是完整 PHP 运行响应的逐字节快照。

| 字段 | 已核实语义 |
| --- | --- |
| `title` | 服务 `SystemAttachmentCategoryServices.php:87` 传“添加分类”。 |
| `method` | 同行显式传 `POST`。弹窗 `modalForm.js:98` 将它转小写后选择请求方法。 |
| `action` | 同行调用 `Url::buildUrl('/file/category')`；是创建分类的提交目标。完整运行时 URL 字节和 helper 附加字段没有从 opaque 函数体还原。新实现应返回受控的本系统分类写端点，不能使用客户端提供的外部 action。 |
| `rules` | 顺序为 `file_type`、`pid`、`name` 三条规则；弹窗不转换它们，直接作为 form-create 的 `rule` prop（127–130）。 |
| `config` | 弹窗在 71–91 行重建 config，再设置 onSubmit、submit/reset 按钮等（93–117），作为 form-create 的 `option` prop。不能据此要求服务器复制未核实的旧 config 全量字节。 |

`view/admin/src/main.js:100,121,140` 登记 `@form-create/iview` 与 `$modalForm`；`view/admin/package.json:12` 指定 `@form-create/iview` 版本范围 `^1.0.14`。与这条真实渲染链匹配的规则如下：

| field | type / value | 组件规则 |
| --- | --- | --- |
| `file_type` | `hidden` / 数字 1 或 2 | PHP service:118 使用隐藏字段；必须保留当前请求类型供后续提交。 |
| `pid` | `select` / 数字父分类 ID，根级为 0 | service:119 的标题“上级分类”；`options` 为 `{label,value}` 数组；`props.filterable=true`。 |
| `name` | `input` / 空字符串 | service:120 的标题“分类名称”；`props.maxlength=20`。 |

`vendor/xaboy/form-builder/src/UI/Iview/Components/Select.php:42–46` 与 `Input.php:57–64` 将 filterable、maxlength 定义为组件 props。`Rule/PropsRule.php:120–122` 实际序列化为 `props` 对象；`Rule/OptionsRule.php:105–107` 序列化顶层 `options`。所以把 maxlength 放在规则顶层，或把 pid 改成没有 options 的 number，不等价于旧 form-create 合同。旧规则没有可见的 required 校验调用；后续分类写端点仍必须独立验证名称和父分类，不能把表单外观当成服务端写权限或校验。

## 分类选项、作用域与旧边界

PHP `SystemAttachmentCategoryServices.php:119,129–136` 查询 `pid=0/type=1/relation_id=0/file_type=当前类型` 的根分类。首项固定为 `{value:0,label:'所有分类'}`，后续每项是分类名称和 ID；没有分类时仍有首项。DAO `SystemAttachmentCategoryDao.php:48–50` 没有显式排序。模型 `SystemAttachmentCategory.php:55–57,65–67,75–81,89–95` 对 pid、平台 type、relation_id 和 file_type 应用查询条件；relation_id 为 0 仍执行等值过滤。

两页的实际菜单均只对 `data.pid==0` 提供新增：组件 Vue:412–426、素材页 Vue:512–529；素材页 628–632 的菜单事件才调用 `append`。全部 `getFrom` 调用仅来自 `append` 和先清零的 `add`；两页顶栏的新增按钮均已注释（60、50）。未发现“先选中 child 再由顶栏直接使用该 treeId 新建”的活跃调用。不能仅因泛用 `append` 函数没有自身 pid guard，就声称 child 新建可由现有 UI 到达。

旧 PHP 服务仍未验证任意传入 pid 是否出现在 root options 中，这是服务边界缺口。本批新 GET 对非零父 ID 要求它属于同平台、同文件类型的根级选项；不存在、child、供应商、其它关系和另一类型 ID 均以 404 拒绝，不返回不可显示的默认选择。该限制是显式兼容修正。选项按 ID 升序；最多 10000 个真实根分类，以 `LIMIT 10001` 识别超限并返回 503，不截断为完整成功。没有分类时仍保留“所有分类”首项。

## 现有现代 helper 的复用范围

本轮修改前只读核对的 `workers-ts/src/controllers/system/AttachmentController.ts:208–226` 已有统一 `title/method/action/rules/info` DTO 与平台/供应商 scope 分支，可作为结构基础。但其 pid 为 `number`、名称长度是顶层 `maxlength:50`，没有下拉选项；这三处不能直接称为旧弹窗兼容。`pid`、`file_type` 还采用数字宽松回退，新 query parser 不应继承非法值吞掉的行为。旧 path-param helper、编辑与供应商合同应各自保留并分别验收，不能让新 Admin query GET 意外扩展它们的能力。

`workers-ts/src/services/system/AttachmentService.ts:1138–1166` 的 `listCategories` 已按 scope type、relation_id、file_type 过滤，正常 root 查询可提供选项来源。`categoryDetail:1169–1177` 只按 type/relation_id 检查，不含 file_type；因此不能仅用它证明某个请求父分类也属于当前图片或视频类型。已有 `saveCategory:1180–1228` 有作用域锁、同类型分类集、父引用和循环验证，表单 GET 不替代这些写入保护。

现代 Admin `view/admin-ts/src/api/attachment.ts:90,101` 当前直接获取图片分类和 POST 创建，使用 `file_type=1`，不经过旧 modalForm。这条现代消费者不证明旧 form-create 的图片/视频表单渲染与后续提交已完成。

本轮新增 `AdminAttachmentCategoryCreateFormService.ts:26–36,66–90` 已只读互核上述 parser、根级作用域和 DTO；身份、角色权限和分类选项在有本地超时的 `REPEATABLE READ, READ ONLY` 事务中读取，按实时管理员状态、凭据版本和 `attachment.view` 重新授权。`AttachmentController.ts:321–327` 为 Admin create helper 使用该服务，并设置私有禁止缓存头；供应商和编辑仍使用原 helper。最终 action 修正为固定相对路径 `file/category`，并为 `/api/admin/file/category` 注册与 `/adminapi/file/category` 相同的受保护 POST handler。最终源码已静态互核，业务第三次执行结果见验证节。表单展示的 20 字限制不改变现有 POST 服务的 50 字上限。

## 真实客户端 URI 拼接与修正

旧 `view/admin/src/setting.js:14,31` 的 baseURL 缺省为 `${location.origin}/adminapi`，可由构建环境 `VUE_APP_API_URL` 覆盖；本轮读取的前端根目录没有 `.env*` 文件，`setting.env.js` 与 `vue.config.js` 未覆盖该变量，这不证明过去的构建环境没有外部设置。请求插件 `src/plugins/request/index.js:54,94` 设置并恢复这一 API base，旧弹窗 `modalForm.js:98` 直接将 `data.action` 交给 Axios，没有去掉 API 前缀。

当前 Admin 已安装 Axios 1.20.0：`lib/helpers/isAbsoluteURL.js` 只把 scheme:// 或 // 开头识别为绝对 URL；`lib/core/buildFullPath.js` 对其它 URL 组合 base；`lib/helpers/combineURLs.js` 去掉 base 尾斜杠与 action 前斜杠再拼接。所以一个 `/` 开头的 `/adminapi/file/category` 仍会被拼接，而不是绕过 base。前版固定 canonical action 会产生以下错误 URI：

| API base 的路径 | 旧错误 action `/adminapi/file/category` | 修正 action `file/category` |
| --- | --- | --- |
| `/adminapi` | `/adminapi/adminapi/file/category` | `/adminapi/file/category` |
| `/api/admin` | `/api/admin/adminapi/file/category` | `/api/admin/file/category` |

这是本轮真实消费者审查发现的缺陷；把错误 action 当字符串断言通过，不证明弹窗最终能提交。最终采用固定相对 action，保留配置的 API origin/base，并给第二个正确 POST URI 注册同一服务端处理器。两种 POST 都必须经过 `adminAuth` 与原 `attachment.manage` 写授权；`attachment.view` 只读表单不得提交，新 alias 不引入新写能力。修正后的独立 Axios.getUri 与双 base Hono HTTP 结果均已返回，具体范围见验证节。

最终别名守卫已只读核对：`routes/adminapi.ts:312` 与 `routes/v1/index.ts:2326` 均登记 `adminAuth, AttachmentController.adminCategorySave`。`AdminPermissionService.ts:298–305` 对两个 API 前缀采用相同归一化，`:143–147` 的素材权限组匹配 `file/category`，`:435–436` 为 POST 要求 manage。两个入口共用 `AttachmentController.ts:194–199,332` 的平台 scope 和原创建服务，不接受客户端任意 origin/action，也没有 trustedOrigin 派生。

旧 `package-lock.json:4607–4611` 锁定 Axios 0.18.1，但旧源自身的 `view/admin/node_modules/axios` 不存在。本轮已装 Axios 的静态与后续运行证据不能冒称为旧 0.18.1 包的实际执行。可见 PHP `think/Route.php:893–895` 返回 UrlBuild，`think/route/Url.php:45,126–129` 默认不加 domain，`:205–211` 直接解析以 `/` 开头的路径，`:474` 组装 root-relative 路径；builder 本身不默认变成绝对 HTTP URL。opaque `create_form` 是否再变换 action 仍未知。

## Opaque helper 的证据界限

`composer.json:65–66` 将 `app/helpers.php` 登记为自动加载文件。其实际 105440 字节已散列，文件头要求 `swoole_loader`，后续为 loader 载荷；本轮未解码或运行它。因而可以核对文件字节 pin、服务对 `create_form` 的调用、可见 form-builder rule 的生成方法以及旧 Vue 的消费字段，但不能声称已阅读 `create_form` 完整函数体、全部 helper 附加字段或旧运行 DTO 的完整逐字节结果。

## 旧源完整字节证据

下表路径均相对 `C:\cinagroup\cinashop-php`。SHA-256 是本轮读取时的完整文件实际字节哈希，不是 Git blob ID，也不是测试成功凭据。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `route/admin.php:693` | 183912 | `8350eca9e328ed615cea117089589274d7e262324b979af588a714415f522652` |
| `view/admin/src/api/uploadPictures.js:27` | 2532 | `9c1d7fc6b32d69261552faf52caddd8dbf0b08fbedde7e896d193e32ee3b4485` |
| `view/admin/src/components/uploadPictures/index.vue:788` | 32870 | `a2cdf6a665995b69ab03ec1767f758df36c3931fb1c9f6368c34a385ffec5036` |
| `view/admin/src/pages/system/file/index.vue:974` | 39580 | `578de8978ea974e70b78aec47b7c8ffbe9162e02b512154bd55fb3157a116211` |
| `view/admin/src/utils/modalForm.js:50` | 5245 | `9a874601934c710bb106857c17f1b6e78a38173efd810b3e58e7f3b817ab94b5` |
| `view/admin/src/setting.js:14` | 4715 | `4523d74b4a297ca11a218c4eadabde154ebda08bf13f35073bde5292073f0cd9` |
| `view/admin/src/setting.env.js:14` | 1466 | `2d6da273ec33dc0da223ccf3ae3d88b91238d6b9b1e9ec5cdd238d6832136d50` |
| `view/admin/vue.config.js:1` | 4409 | `77001df6976c8e284fb48f9220147c1dd128cd37ef97da8f5fac5328d044c3ef` |
| `view/admin/src/plugins/request/index.js:54` | 6699 | `9dd5ce11bee5aaf3c43c0ca7215993866e1fac85cd444024f37dc576d08644d5` |
| `view/admin/package-lock.json:4607` | 1492713 | `96eaeedda26295179e68f89f81891069591f378735ad1fcaa4ba3a13457a2ec8` |
| `view/admin/src/main.js:100` | 9905 | `a8346e337c659f5ee93738513e1d114d74eb2635130c02c0768e04aaa072cd7c` |
| `view/admin/package.json:12` | 2365 | `cb985fbc3b354211a16b2d90182d731b5f2ad2b4aad1901313135ab7832d07b7` |
| `app/controller/admin/v1/system/attachment/SystemAttachmentCategory.php:57` | 3697 | `69e5b2c21a10d7426d07c3a5c1e318549328b2164ca778896fbbb1e0e8ac8548` |
| `app/services/system/attachment/SystemAttachmentCategoryServices.php:85` | 6317 | `1d6fc67e988964406fcfcea7714ca76737acc66f4f42862eb30d87813778ba71` |
| `app/dao/system/attachment/SystemAttachmentCategoryDao.php:48` | 2065 | `68d6eb817129b6ef4dada3a3e2ebf594cc31754832c43ac7683cb0f57aa2b294` |
| `app/model/system/attachment/SystemAttachmentCategory.php:55` | 2645 | `7c62185d29ea86a015699bb5df7f24a904f41eee3377671c84054c47ab1fa3fa` |
| `app/Request.php:59` | 6158 | `b24ea2b61d05f877896390596cdfd3116b0631ca223c6d220b79273ca7405bdb` |
| `app/helpers.php:1`（opaque） | 105440 | `5ed1ad26409bc86839701855d620c3855f34163d76bd88be2243031f98f5d8a5` |
| `composer.json:65` | 2095 | `2651664ff3cb15ac5968ffbc1a1f5b29c6a4b3c17e8a0c9d923788cf2629277f` |
| `vendor/xaboy/form-builder/src/UI/Iview/Components/Input.php:57` | 2905 | `3353e56a5a323aafd68349dc54de1ebc7d4fd411e2e2533ab10f750fd6c0d98f` |
| `vendor/xaboy/form-builder/src/UI/Iview/Components/Select.php:42` | 2342 | `0cede98105d52d89238297864f6795fb5549d835c9eabc948930a5820f599f6a` |
| `vendor/xaboy/form-builder/src/Driver/FormOptionsComponent.php:23` | 615 | `356eb765212f3668ecbc1142136e08c5bec2b86c3d8a7bf775a83c59bb2f15a1` |
| `vendor/xaboy/form-builder/src/Rule/OptionsRule.php:105` | 2151 | `f735d9c765943d943797431d9f559807fc5342c83adf351abf102220f967f1e6` |
| `vendor/xaboy/form-builder/src/Rule/PropsRule.php:120` | 2450 | `695214a2c8e5e71ad83ce7c6214fe612debf37cbdabc4d918fd19de2361543d5` |
| `vendor/topthink/framework/src/think/Route.php:893` | 23803 | `ed31ef354c42376334b0d9ddbba5b4e21fadde837fbd34780fc2c33f5b76ae62` |
| `vendor/topthink/framework/src/think/route/Url.php:126` | 14806 | `f07268c484df517749e6745010a30948dede4345a66e522aa088f6cbf9f8dfa1` |

已装 Axios 的四个独立输入位于当前隔离工作树 `view/admin-ts/node_modules/axios/`，只读取这些指定文件，未扫描或修改依赖目录：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `package.json`（version 1.20.0） | 6681 | `cc221510be6315b0ebf648d7e4346680e47a828fafcbb9cc141922d2d219761e` |
| `lib/core/buildFullPath.js` | 2899 | `5515e006778b57d3563ce9f42067f74ff95f065a1382ab729878c1cfb14e606c` |
| `lib/helpers/combineURLs.js` | 492 | `f4ae2b221e8ee30fa99432a1419f4a09c0bb8eff41bce71dc428ba787e18717f` |
| `lib/helpers/isAbsoluteURL.js` | 617 | `088d43296f0ffb12f2e85d48375c544b173ba37263ae6abc1a6106fbbc76d469` |

## 验证状态

**本轮有限合同验证已记录。** 本文完成真实旧源与消费者、以及新增服务的 parser/DTO/根级作用域/事务边界只读互核。实际测试由 Root 或后端代理执行，文档作者只读核对其结果文件，没有运行测试、PG 或 provider 操作。汇总收据由 Root 保存到[本轮分类表单验证记录](../audit/admin-category-create-form-validation-20261008.json)，包含实际 raw hashes 与最终 Source inputs。

- URI 修正前的业务第二次执行已实际退出 0、1 个测试文件、21/21 通过。文档作者已只读复核 `C:\cinagroup\cinashop\.cache\admin-system-implementation-20261008\admin-category-form-business02` 的原始 stdout、空 stderr 和值为 `0` 的 `actual-exit.txt`。stdout 为 4056 字节，SHA-256 `3efa0bc7fbaa2eb176fc5cd77ad1389b38ecd1b1d3f9370e7c6f021690a400ad`；exit 文件为 1 字节，SHA-256 `5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9`。该记录保留但已被修正后版本替代，不能证明相对 action、双 base POST alias 或最终版本通过。首轮业务失败记录也保留，不能追认成功。
- URI 修正后的业务第三次执行已实际退出 0、1 个文件、22/22 通过。文档作者已只读复核 `admin-category-form-business03` 的 stdout 4254 字节、SHA-256 `1bf3aa247809a7aca2eccb02ee9a297b3176f1369f7be1922cf5e4cbf0bbf366`，以及空 stderr、同样 1 字节值为 `0` 的 exit 文件。范围是 PGlite/Hono，包含真实 SQL 的 10000/10001 分类边界，以及修正后相对 action 在两个 API base 的 NodeURL 拼接和 Hono POST：view 读者被拒绝、manage 读者可以创建。该 Worker 业务测试没有执行 Axios，也不是完整旧 Vue/browser E2E。
- Root 的修正后原生第三次执行实际退出 0，PG 16.15 的 3/3 场景通过：真实 SELECT-only LOGIN 表单读，及已返回父分类在 scope 锁等待期间被删除或改变文件类型后，原写服务重新验证并拒绝。原始日志还记录 `FINANCE_LOCAL_FIXTURES remaining=0` 与 owned `finance-postgres-00DLvq` 已停止。协调/建库角色不等同于服务使用的 runtime LOGIN；具体 LOGIN、权限、事务、PID 和等待证明由原生测试断言核对。最终 native test 为 12503 字节，SHA-256 `48de2da31199a3b833c28408090a8147abc4ef1b579972b59aeb72da114cec69`。
- Root 的修正后回归第二次执行实际退出 0，3 个文件共 19/19 通过。当前本批唯一测试合计 22+3+19=44；不加上被替代的 business02 21、native02、regression01。business01 的真实失败和第一轮 native01 白名单失败记录均保留；后者未创建 cluster，不追认任何 PG 成功。
- 独立本机 Axios 1.20.0 `getUri` 已实际计算两种 base：旧 action 均产生双前缀，新 relative action 均得到正确分类 POST URI。原始 `action-uri-evidence.json` 和读取到的生成脚本仅作本地 URI 计算，未发 HTTP；不证明旧 Axios 0.18.1 的实际运行或旧浏览器渲染。
- Root 的 route/API 审核实际退出 0：route 报告为 Worker 2341、可执行匹配 893、仍需行动的缺口 973；前端 API 602 处调用、633 个路径变体均登记可执行。计数不能替代消费者的 DTO、权限或工作流验收，也不能将整个 checklist 记为完成。
- Root 的最终 types02 已闭合：unit/runtime 实际退出均为 0，各 stdout/stderr 均为空；文档作者已只读核对 `types02.execution.json` 与四个原始空日志。Root 另以独立 pg_ctl status 确认 owned `00DLvq` 为退出 3、无运行中的 server。R2、队列与外部调用仅通过测试边界断言未调用，没有实际 provider 操作。构建、真实 form-create 渲染和完整旧客户端端到端提交没有在本节预填通过；URI 修正前的类型或原生结果不能作新版本信用。
- 旧编辑/完整图片与视频工作流、写入未知结果恢复、真实账号、生产和发布仍须独立验收，不借本轮 GET 或上一迭代信用。

上述 Root 外部证据位于 `C:\Users\cina\.codex\visualizations\2026\09\26\01a0db11-74a0-7cc2-b1f9-ee3b8653056a\checklist-route-contracts-20261008\category-create-form`，文档作者已只读核对以下实际文件：

| 证据 | 字节 | SHA-256 |
| --- | ---: | --- |
| `native03.stdout.txt`（3 pass、remaining=0、stopped） | 1003 | `5aab11380f7cff6eecd3b04881f16aafd9494fb3ad5c947ed930213e8311d79b` |
| `regression02.stdout.txt`（19 pass） | 272 | `44a0ff38690b59f93a5c36cee17626b0c3606689dbcb9cc59d6d5976d9907592` |
| `native03.execution.json`、`regression02.execution.json`、`route-final.execution.json`、`api-final.execution.json`（各 `exitCode:0`） | 各 14 | 各 `6041df3e9b345d68be886f995c452395674ea950cd3ca9992c13b64f3aa9cbd0` |
| `check-form-action-uri.mjs` | 1039 | `0d7fa4d60616eaa78515cbf3fb29a1224efe5a2e60653a72db921b0e8cf86365` |
| `action-uri-evidence.json` | 650 | `981a494de9d0c79e6dc2fb045775b3369c698d748b68018061fbd9c85608106c` |
| `route-final.json` | 1300261 | `86ff5eb7d087cc8e55082723db225c9c4dc73f9e7ad16f293ea647cd6aab7129` |
| `api-final.json` | 379508 | `7ff15304e1acbe6e75a9e16cf113b0c2a2f580c793d56c1eee5ad44d8ec08c68` |
| `types02.execution.json`（unit/runtime exit 0） | 57 | `46a652e76b05654a1717664fe183539ce70b290f5b97faab45400d5ed677a73d` |
| `unit-types02.stdout.txt`、`unit-types02.stderr.txt`、`runtime-types02.stdout.txt`、`runtime-types02.stderr.txt` | 各 0 | 各 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
