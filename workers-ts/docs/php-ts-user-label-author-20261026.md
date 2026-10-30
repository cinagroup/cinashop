# 用户标签与分类 PHP → TypeScript 迁移增量（2026-10-26）

本批实现普通用户标签与分类完整作者，并恢复原页面的企业微信标签目录同步。入口 `/label`、固定 PHP 别名 `/admin/user/label/`；现代五个接口与旧 CRUD、表单、分类和同步适配均在 `/adminapi`、`/api/admin` 两个前缀经过 Admin 身份和实时权限检查。本批只记录本地代码与受控端口验收；整体 PHP→TS 迁移仍开放。

## 固定原件和作者行为

固定 PHP 提交 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，20 份完整原件。路由实际使用 `cate.vue`，不以未使用的 `index.vue` 作活跃合同。原有效标签字段为分类、名称，分类字段为名称、排序；保留现 TS 的颜色、排序、启停三个标签扩展字段，组成五字段编辑器。没有作者图片槽。新增默认当前选中分类，All 不作为真实可编辑分类；标签每页10项，切换分类重置分页，删除末页末项后回退。

标签只允许平台 `type=0,relationId=0`，分类还要求 `ownerId=0,group=0`。全域行仍进入目录版本与引用保护；DTO只返回平台行，平台停用标签与隐藏分类仍可维护，新/变更标签分类须isShow=1。新建或改变名称限定1..20字，排序为非负整数；颜色与启停按当前 TS 合同校验。原样历史值、未变的孤立分类和隐藏元数据保持；新改变分类须为当前可用平台分类。名称冲突规则、分类包含任意域标签/子分类、标签被商品/活动/订单快照引用均在事务内重验。

删除标签同事务清理平台标签关系；存在外域关系则拒绝。CSV 数字用 `Number(token.trim())` 识别原消费者可接受的前导0/科学计数等表达；坏引用证据保守拒绝。订单赠送快照递归核对 `label_id`。写后校验完整 INSERT 值、两张完整业务表与关联清理，触发器改写任何无关字段也回滚。

## 不可变回执、鉴权和并发

实时管理员身份、权限、凭据版本和数据库期限检查；staff/role barrier 后锁 `category,user_label ACCESS EXCLUSIVE NOWAIT`。删除再对关系/活动/订单/商品表持有 `SHARE ROW EXCLUSIVE NOWAIT`。原生 PG16 使用原 `UserSegmentationService.setUserLabels` 实际 SELECT 的锁竞争验证，拒绝以假查询或函数名代替并发证据。

独立九列 `admin_label_operation`，首行使用 command UUID，后续事件各有新 UUID，私有结果内固定 command_id/连续 step。Admin 仅 SELECT/INSERT、App 无权限，UPDATE/DELETE/TRUNCATE 即使维护身份也拒绝；显式维护升级/回滚、精确权限审计和运行就绪检查，不扩大原业务 DML 或添加 definer 能力。

客户端先持久化完整非秘密 UUID/action/hash，再提交；同 UUID 先查原回执，再判断目录是否过期。404/失去响应仍是未知。原操作人可在新登录、manage 被撤销后查回执或封存未发出的操作，避免迟到提交。矛盾终态不能清 journal；本地存储失败、部分持久化、路由/账号/卸载、快速原生输入和 ABA 均有真实 SFC/cacheHandlers/native 监听测试。

## 企业微信目录同步

排队只表示命令已保存，不能表示同步完成。完整目录读取 → export plan → planned → dispatch → confirmed 逐步追加；provider I/O 在 SQL 事务外。dispatch 必须先持久化，然后才尝试一次非幂等创建。网络错误、5xx、坏响应或丢失响应都不能自动重发创建；恢复只读完整远端目录，要求精确请求对应的新字符串 ID 与全部无关目录内容一致，才能记录 confirmed。该证据只证明目标身份出现，不证明 provider 幂等或跨系统因果/原子性；无法证明时保留未知，需要原操作人核对。

所有外发批次结束且本地完整源未变才写入分类 `other` 与标签 `tagId` 映射，并导入远端新增目录。现有名称、颜色、状态、排序等元数据保留；新行有明确默认与完整回读。目录变化、配置/凭据/权限变化不能继续发新批次。未 dispatch 时可以封存 not_applied；已有 confirmed 远端批次后停止使用 stopped 并说明远端变更已发生；dispatch 未知不伪称未应用，也不自动删除远端对象。空分类没有标签时不创建远端空组；100项批次是本地安全预算，不称官方限制。

全命令 HMAC、原凭据指纹和期限先验签再打开独立 Admin SQL 会话，每阶段再校验实时权限及初始 durable stamp/deadline。每次 Queue delivery 最多推进12步，未进展 dispatch 返回未知，重试不会重复创建。过期或耗尽后的 ACK 只终结该次投递，持久化命令仍供 owner 恢复，不能当作同步完成。无 ORDER_QUEUE 时命令也已持久化，可由原页面继续推进。

新增完整目录 POST `{tag_id:[],group_id:[]}` 独立1MiB预算；只有明确 invalid-token 错误可刷新一次 token，非幂等创建的其它不明响应均不重发。现有 C7 targeted corpTagList、strategyTagList 方法和 current authority 保持原字节。官方来源：[企业微信获取企业标签库](https://developer.work.weixin.qq.com/document/path/92117)，实现时归档在临时 evidence 中；本轮没有使用真实企业账号发起变更。

## API 与前序证据

原混合 LabelList 六个完整调用对象明确归档退役，由五个 typed 作者接口替换。其余734旧调用中的728项逐项保持；兼容 product/user-label API 仍注册可执行，成熟商品标签页继续在 `/label/products` 可达。当前实际 AST 清单733调用点/771变体，全 registered/executable，0 unresolved/unregistered/controlledUnavailable。

最外层精确来源适配包裹冻结 Level/Express/权限规则/本人资料及更早证据。23份旧套件只改变导入读取端口，原断言正文及负例不改；首次漏掉双引号 API report 读取导入导致1项失败，修正后完整2571来源回归通过。历史 dated/helper/doc 原值保持。旧provider安全来源断言还发现凭据模块直接引用原始错误文案key；纯corp-tag协议校验已独立，保持原断言、严格ACK检查及错误分类。Worker 类型首轮还发现原生测试一个未使用导入和 Queue 测试缺少当前 MessageBatch.metadata.metrics；两项均仅修正测试夹具类型，保留原业务与序列断言。

来源证明 `workers-ts/audit/user-label-author-source-binding-20261026.json`，SHA256 `9aea23c96f1e70cbfe3d4eae0b334f9e9abe3fff4d7d023da2a827d0eefa4261`：39完整修改前后像、23完整新增、20完整固定PHP、1703冻结历史证据、21既有边界源。新来源适配 helper 由最终全输入 manifest 独立绑定，避免自我摘要循环。

## 本地验收

3935项唯一选测通过，新增454项：本轮受限SQL28、sync SQL11、纯目录计划65、provider34、不可变addon40、HTTP26、Queue32、完整来源188、真实Vue29、原生作者1。完整回归为新后端236、来源2572（含旧2384）、既有相邻/provider/C7/segmentation运行时392、前端657（旧628+新29）、原生78；最后一组包含新作者1与旧customer用户/付款赠标签77。重复执行不重复计数，最终选测无失败/跳过。

Admin vue-tsc、Worker strict tsc、Vite生产构建和实际AST API审计均通过。重验证遵守共享串行锁及单worker/明确堆上限。组合检查被终止后单独重跑Worker取得0退出码；资源锁等待期间未绕过串行要求。Queue首次4项失败来自维护身份和首次Worker加载超时的夹具问题，保留序列/原断言修正后重跑通过。协议模块抽取后新旧provider用例重新验收。

选定native PG16包含独立LOGIN维护/ACL/真实旧消费者竞争，以及既有客户用户完整目录/角色/ABA和付款赠标签回归；不把纯C7 projection测试称为远端current SQL authority或真实企业租户验收。

浏览器使用已安装 Playwright/Chrome，原因 `Browser plugin not available`。生产构建入口 `http://127.0.0.1:5214/admin/user/label/`，1365×960、375×900、320×900；页面身份、非空、无框架遮罩、控制台健康、截图、实际交互六项通过。真实表单五值、分类新增/筛选、引用拒删后封存、刻意丢包后的原回执恢复、queued到原sync阶段完成、窄屏固定操作均验证。7张截图逐张查看，无pageerror/warning；仅受控HTTP400和刻意丢包ERR_FAILED。接口为本地受控响应，不能称真实租户端到端。

原生 PG16.14 作者独立 LOGIN 通过，集群 `.cache/finance-postgres-DUMceC` 已停止，fixtures=0。最终消费者/作者复跑集群 `/home/cina/cinagroup/cinashop/.cache/finance-postgres-HBh8Yd` 同样已停止、fixtures=0。端口5214已关闭。验收回执 `/tmp/cinashop-label-author/accepted-validation-result.json`。

未执行生产 addon 安装、真实企业微信账号/凭据/远端目录和真实 Queue 联调、commit/push/PR/merge/deploy。下一候选仅静态准备，不计本轮实现或验收；原账本前缀字节及复选行保持，父项和整体迁移继续。
