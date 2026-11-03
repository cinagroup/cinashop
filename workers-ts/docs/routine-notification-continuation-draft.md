# 订阅通知历史续办维护草案

这是维护只读诊断，尚不是 AppID 切换 manifest、单次 permit 或发送准入。旧用户、UID、权益、旧单、付款和现有跨 AppID 屏障保持；全部 activation／permit／switch／subscription-send 标志始终 false。

## 同一物理快照

`collectRoutineNotificationContinuationDraft` 复用完整数据库 inventory 的单连接、先锁表后 REPEATABLE READ READ ONLY 流。在事务结束前同时完成身份、原付款及通知分类，将三个分类摘要和原始 inventory sourceDigest 合并认证。旧 account／identity／inventory API 返回形状保持。

通知分类只解释 public 中四个物理 heap 根 `store_order_outbox`、`order_notification_delivery`、`routine_subscribe_attempt`、`routine_subscribe_result`，并引用 `routine_subscription_account_policy`、`routine_original_payment_evidence` 两个真实历史根。严格核列名、内建类型、实际关系身份；继承子表、其他 schema 和其余关系仍完整计数、指纹并列为未分类，不能由这六个命名来源声称覆盖全库业务。

期望 scope 来自实际数据库名／OID 及 subscription policy 表实际 owner 名／OID，不使用诊断连接的 current_user、attempt 表 owner 或 payload 自称的 scope。APP_KEY 只在本地验证持久 HMAC，不作为 SQL 权限，也不发往 SQL。显式缺少 policy 来源保留 scope_unavailable；不推断旧账号归属。

## 已保存的历史与当前状态分开

共享纯 codec 认证既有发货 request2、退款拒绝 request3、成团 request4、staging intent、attempt 和 result。原签名域、字段顺序、异常和历史时间规则保持；policy 在捕获／attempt 时有效，不因当前过期、撤销或旧角色停止 LOGIN 而抹掉当时的签名／回执。actor 只输出 keyed 摘要和当前角色存在／改名／LOGIN 状态，当前角色观察不是业务权限证明。原 runtime attempt parser／SQL history 仍强制匹配真实当前 actor；request2／3／4 和 intent 保留原有历史解析规则。原 SQL／fresh admission／凭据／token／WeakMap 单次能力和 provider 调用留在原服务。

分类核对签名请求与物理 outbox 的业务字段、事件和时间，staging 与请求签名、订单／买家、模板标记，以及 delivery 的目标、模板、时间、URL 和渲染数据。当前投影漂移单独报告；不能用可变 ledger 的 SENT 推导真实 POST。PHP 的 fictitious 发货仅有 SMS／站内信，真实 producer 没有订阅请求；该无请求分支标为 outside_subscription_contract，不能为了对齐标记而开放新的 Routine 路径。

同一 delivery／语义 source key 的整个历史最多五次；核 ordinal、previousAttemptId、event、request、intentDigest，前次必须有明确可重试拒绝才允许下一次。末次没有 result 为 UNKNOWN，不重试、不升级成功；重复、孤立、错绑或坏签名分别保留。已验证 code0 的历史 accepted 状态与当前 delivery 投影独立。policy 引用要求同快照中精确保存的原 journal 和完整 accountId 链；原付款引用要求真实已认证原证及相同 AppID、根订单、买家和签名。

输出只有计数、固定标签、目录元数据和 keyed 摘要；不输出原 AppID／openid／买家 UID／手机号／签名／密钥／模板正文。outbox、delivery、attempt、result 的 keyed ID 摘要可闭合连接；原证和 policy 的 recordDigest 使用既有付款分类域和同一精确 numeric-token 解析，可与 payments 分类对应。原始物理指纹仍使用服务器完整 JSON 字节及 xmin／ctid，分类后的 JSON 视图不是原始行摘要的替代品。

## 压缩 JSON 的读取预算

原七个有界 JSONB CHECK 证明保留，并对实际 attempt／result 两个既有 payload CHECK 核完整定义、OID、NOT NULL、验证状态和内建依赖，分别使用 64KiB／32KiB 文本上限；没有新增或放宽 DDL、storage、grants。

mutable outbox／delivery 没有同类 CHECK。新例外仅用于实际 PostgreSQL **16.14／160014**、两个命名 public heap 的 `payload jsonb`，只接受 pglz。先以物理大小 ≤32768 门控，再用明确的内建 `jsonb_set_lax(...,NULL,false,'return_target')` 取得同一值的实际解压后大小；实际二进制 ≤32768 才进入原 numeric-leaf 预算，最终整行仍须满足 262144 字节预算。二进制上限是必要条件，不保证达到该上限的整行一定可接收；整行开销可能更早拒绝。

固定 PG16.14 源码的有效 pglz 流每三字节 tag 最多展开 273 字节。保守中间界 `8+92*physical` 在物理门限下小于 3MiB；嵌套 CASE 保持预算计算顺序。未知算法、其他版本的压缩值、其他列／关系继续拒绝；NULL、数组和 scalar 保持原始历史，不借 object-only 转换改变值。numeric 的十进制展开另行计入，不能只用二进制大小承诺文本安全。I/O 明确调用 pg_catalog 内建函数，避免 JSONB→text 自定义 cast 隐藏执行。

此界假设有效 PostgreSQL 存储，不是对损坏 TOAST raw-size header 的后端内存配额，也不是完整 DDL／业务 writer fence；不能抵御受信任 superuser 修改内建函数。容量、布局、超时或不支持来源导致整个操作失败，不返回成功前缀。

## 独立 CLI

```sh
node --import tsx scripts/routine-notification-continuation-cli.ts DATABASE MAINTENANCE
```

只读取独立 `ROUTINE_NOTIFICATION_DRAFT_DATABASE_URL`、`ROUTINE_NOTIFICATION_DRAFT_FINGERPRINT_KEY`、`ROUTINE_NOTIFICATION_DRAFT_AUTHENTICATOR`。不回退 runtime、account、identity 或 inventory 变量；两个 key 必须不同。URL 目标必须与参数相同，无 query／fragment；max1、prepare false、默认只读和有限连接／语句期限保持，非回环连接要求 verify-full。输入或 collector 失败只输出固定脱敏错误，不输出 SQL／参数或成功前缀。完整报告写出后的连接关闭失败另报固定错误并 exit1，不能承诺撤回已经写出的完整 JSON。

原生成功路径通过 collector API 验证；独立 CLI 的前置拒绝不能冒充真实远程 TLS 或维护执行证明。实际验收和已知失败见[第60轮迁移记录](php-ts-wechat-routine-20261029.md)。

## 仍未闭合

当前业务新鲜准入、credentials／catalog commissioning、外部 Queue／provider 当前状态、其他通知 realm、全部维护来源、完整 manifest／单次 permit／原子切换和回执恢复尚未由本诊断完成。用户的旧库不上传询问未选定新云端供应架构；旧 PHP 完整固定版本留本地，上传不重试。此实现不等于整体 PHP→TS 迁移完成，也未部署。
