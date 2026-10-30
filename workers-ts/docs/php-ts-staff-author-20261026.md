# PHP → TS：核销员选人、头像与七字段完整写入

本批接续已验收提货点迁移，补齐核销员完整编辑与可恢复请求。整体PHP→TS迁移、ADM-001和FE-001仍开放；这里只验收本批本地实现。

## 固定原件与行为

PHP固定ref为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`。原入口 `/admin/setting/merchant/system_store_staff/index` 路由到clerkList，原6个活跃控件对应uid、avatar、store_id、staff_name、phone、verify_status、status共7个持久值。创建image是商城用户选择结果，编辑image是头像字符串；原控制器先验证隐藏uid、后覆盖image.uid的错序不照搬。现代旧别名直接激活父页核销员标签；原双Admin前缀list/create/edit/save/status/delete保持可执行。旧表单image对象先规范化，冲突UID/头像拒绝；store_id=0继续表示全部提货点，旧REST布尔开关转换为数值，现代接口仍严格0/1。

现有TS原本已有真实CRUD，本批替换其平台控制器写入入口，保留成熟StoreOperationsService、配送页/工作台、核销执行与门店管理消费者。当前TS的编辑换关联用户能力保留，且独立复验所选新用户。密码、account、roles、管理员/店长/收银等标记、登录资料均完整保留；没有新增这些字段的编辑器。电话按原非空且最多15字合同处理，不强制大陆手机号。未变化的历史字段可留原值；新/变化开关仅0/1。

创建或换UID需要真实用户目录选择戳；用户目录只返回uid/nickname/raw avatar/safe preview/selection，在store.manage专属只读事务中完成SQL count/list分页，page最大2147483647、limit最多100，不给通用用户或附件管理授权，不返回账号/电话/密码。选择戳涵盖当前状态、删除状态与xmin，它是快照证据，不是授权票据；事务内仍锁并验证真实用户。启用时要求用户有效且提货点未删除；停用/软删除可清理悬挂身份。重复有效身份拒绝新建、关联变更或新授权；历史重复仅可作不增权的资料维护。

头像只有一个持久槽。平台图库和稳定HTTPS/站内地址保留当前TS能力；规范附件必须匹配当前平台raster元数据，所选用户附件另须type3/module3/uid所属及真实当前user.avatar完全匹配。改变附件时FOR SHARE NOWAIT。原用户历史头像可保留，安全显示与原值分离，预览签名不写入，禁止任意实体解码。user.avatar256与staff.avatar255明确拒绝截断，页面要求另选可保存头像；选择用户不改用户资料。

删除保留当前TS软删除合同：is_del1/status0/verify_status0/notify0，保留历史凭据与角色。原PHP硬删除不切回。完整历史店员最多20000、提货点5000、私有源16MiB；超量明确拒绝、不截断。can_create按包含已删历史的完整数量计算，达到容量后仍可维护现有记录。

## 事务、回执与表结构

实时authority barrier → store.manage（owner恢复只需仍有效身份）→ ERP try gate(731745,1) → 原staff try gate(8214001,0) → store SHARE ROW EXCLUSIVE NOWAIT → staff ACCESS EXCLUSIVE NOWAIT → addon readiness → author gate(731632,1)。旧消费者真实SELECT已持有AccessShare时新写即时拒绝；不改变旧锁、核销或订单代码。选中的用户与图片单独FOR SHARE NOWAIT防止检查后变化。

完整staff已知列、全部store的to_jsonb/xmin和关联用户最小事实/xmin生成私有revision；未知staff列拒绝。store基础版与可选城市配送列均只读保留，不安装其它DDL。显式完整新建默认、全staff回读、全store回读与受保护user/xmin回读共同防止触发器篡改隐藏字段。

独立九列不可变 `admin_staff_operation`：Admin仅SELECT/INSERT，App无权，维护身份也不能UPDATE/DELETE/TRUNCATE。显式PG16维护入口 `runAdminStaffUpgrade` 校验原current运行权限与精确目录，安装/授权同事务、失败回滚、重复调用只核验复用；共享维护gate(731626,19)。HTTP和启动不安装DDL，不扩大业务DML。

现代浏览器先保存本owner完整非秘密UUID/action/hash再派发；原UUID先于过期目录比较。404仍未知，只能原样重试、读取回执或明确resolve封存；not_applied封存阻止迟到写。撤管理权限后仍可在有效登录身份下恢复原请求。矛盾/非终态回执不会清除journal。真实Vue/cacheHandlers和native事件覆盖owner/token/角色/路由/tab/卸载/source/input ABA、选人/图库旧回调退休、连续输入、多旧journal逐一恢复及容量边界。

## 本地验收

最终3393项唯一选测通过，新增398：受限SQL/HTTP/支持/头像/addon174、实际Vue46、原生新作者1、来源177。完整来源2928（含2751旧断言），相邻运行时177中扣除重复49+14后独立114，原生4文件45，旧前端86；没有失败/跳过/取消计入通过。Admin vue-tsc、Worker两套严格tsc和Vite构建均通过。所有重验证走共享serial wrapper，Vitest单worker。

PG16.14独立LOGIN验证包含安装中途故障回滚、精确ACL/维护gate/漂移、七字段写入和原UUID重放、真实旧readStoreManagerIdentities的joined staff SELECT后暂停并继续受控订单INSERT、新作者状态/删除短拒绝、未关联新用户行与新头像元数据竞争、隐藏凭据触发器回滚。受控订单INSERT证明目录锁的并发关系，不冒充整条订单API验收；旧管理读取、核销读取和提货点完整作者另有原生回归。临时fixture0，所有本批数据库和浏览器端口停止后验收。

实际AST结果748calls/786variants全部registered/executable，0缺口；741旧calls逐项保留，新增7个typed wrapper。来源 `workers-ts/audit/staff-author-source-binding-20261026.json` SHA256 `01f3910b4b07c4c3c52714b839eca3953fda555e660b3e32163b049aa3f7283f`，38完整前后像/21新增/8固定PHP全文/1709旧证据原字节/26成熟实现不变；25旧source套件只改导入，正文和危险负例不变。最终输入冻结6474文件，清单 `/tmp/cinashop-staff-author/final-validation-input-manifest.json` SHA256 `d2222d3813999c7c7303cb10243c3a75ac49b8c36d0f58afa5940e706ae1cfa1`；验收和最终输入清单在本目录accepted-validation-result.json、accepted-input-manifest.json。

Browser plugin not available，使用已安装Playwright/Chrome，受控本地接口 `http://127.0.0.1:5215/admin/setting/merchant/system_store_staff/index`，1365×960/375×900/320×900。实际父页旧alias→七值编辑→真实选人DTO→图库→确认保存→丢回包原回执恢复→拒绝后封存→过滤与窄屏弹窗，9张截图逐张查看。页面身份、非空、无框架overlay、控制台、截图与交互6项通过，0warning/pageerror，仅刻意ERR_FAILED。GUI使用受控接口；真实SQL/Hono/PG16是独立执行证据，未作生产账号/设备或真实R2联调。

已解决的新验证失败包括：越界payload原先在测试hash构造时就被拦截，现独立构造并实际调用接口；native两次受控订单unique默认空冲突及持排他锁期间全库快照的夹具问题；来源说明大小写及漏掉双引号旧builder导入；旧source CLI过滤路径修正为真实test/路径。旧断言/权限/消费者均未为过测放宽。类型检查未用导入已移除，最终单独复验两套配置。

没有生产addon安装、远端CI、commit/push/PR/merge/deploy。下一平台配送员仅25份完整来源静态准备 `/tmp/cinashop-staff-author/next-scout/next-scout.md`，已记录选人/图库/原alias和旧UID复核缺口，不计实现或测试验收。
