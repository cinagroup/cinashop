# FE-003B 账号注销边界

状态：**仅完成登录与鉴权的软删除保护；注销流程未恢复、未发布**。

## 旧实现和迁移风险

- 旧 `route/api.php` 注册已登录 `GET cancel/user`。`User::cancelUser` 发出 `user.cancelUser` 事件后返回“注销成功”；`CancelUserServices::cancelUser` 捕获所有异常、只记录日志。调用方可能收到成功，但数据库只完成了部分变更。
- 监听器先解除上下级推广、把当前用户 `integral` 和 `now_money` 清零、解除企微上级，再调用 ThinkPHP `SoftDelete` 的 `destroy`，最后把 `wechat_user` 标记删除并替换身份字段。这些步骤没有共同事务；资金清零也没有在此处写对应资金流水。原样移植会丢失可对账的余额，并留下部分注销状态。
- `app/model/user/User.php` 的软删除列是 `delete_time`，与 `is_del` 分立。目标 `user` 表同样保留两列，活跃手机号唯一索引要求 `is_del=0 AND delete_time IS NULL`。此前 Worker 的登录、UID 鉴权及手机号占用查询只检查 `is_del=0`，与数据库索引和旧删除语义不一致。
- 旧 UniApp `/pages/users/user_cancellation/index` 显示 `user_agreement/cancel`，确认后调用 `cancel/user` 并退出。新端只有注销路由缺口，不能把普通登出当作注销。

旧源码锚点：`app/controller/api/v1/user/User.php::cancelUser`、`app/services/user/CancelUserServices.php::cancelUser`、`app/model/user/User.php::$deleteTime`、`view/uniapp/pages/users/user_cancellation/index.vue`，位于 `C:/cinagroup/cinashop-php`。

## 本地已收口的保护

`UserDao::findForAuth` 和 `findForLogin`、`LoginService` 的密码/短信登录、注册占用、重置密码、当前用户改绑与目标号码占用、`WechatAuthService` 的身份投影与手机号认领，均只把 **`is_del=0 AND delete_time IS NULL`** 的用户视为活跃。鉴权中间件每个请求调用 `findForAuth`，因此旧 token 在软删除提交后不再得到用户身份，即使 Redis bucket 未过期。此处没有调用外部身份或真实数据库。

`test/user-soft-delete-auth.test.ts` 用实际 PostgreSQL SQL 夹具验证：仅设置 `delete_time` 的旧式软删除立即阻断 UID 鉴权与密码登录；单独设置 `is_del` 也阻断；软删除账号不能重置密码或修改/绑定手机；活跃账号可认领软删除账号原号码。夹具无外部连接时在本地 PGlite 运行；它验证查询和事务语义，不构成多连接竞争或正式渠道验收。

## 完整注销前仍需解决

1. 在当前账户、未完成订单、售后、余额/积分/佣金、提现和第三方身份上定义可执行的准入与结算规则；不能先清零资金再宣称注销成功。
2. 在有锁和事务的服务端操作中确定一次性注销结果，原子标记用户两种删除字段，解除必要关系，并留可对账的记录。任何失败必须回滚并返回失败；重复请求应返回相同终态。现有多处直接用户查询仍只检查 `is_del`，注销实现前需逐一审计写入与异步回调。
3. 令牌缓存、扫码会话、微信/Apple 绑定和后台代客引用需按同一注销版本失效或隔离。数据库鉴权保护已生效，但不等于所有异步任务/支付回调已被阻断。
4. 实现取消协议、用户确认、服务端操作、客户端清理与错误恢复，并在原生 PostgreSQL 并发、真实身份、订单/资金样本和 H5/小程序/App 上验收；旧已发布客户端原位升级还需包身份及实际 API 来源证据。

因此 FE-003B 继续开放，复选框不因该保护而增加。
