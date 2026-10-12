# 独立门店运行连接

门店接口在完成用户认证和路由授权后选择 `HYPERDRIVE_MANAGER`，固定数据库角色为
`cinashop_manager_v1`。运行请求不会回退到 App、Admin 或维护连接，也不会自行补表或授权。
认证过的门店操作继续在事务中检查当前员工、门店和订单归属。

固定权限计划、角色无关的目录前置检查和独立 LOGIN 审计分别位于
`managerRuntimePrivilegePlan.ts`、`auditManagerRuntimePrivileges.ts` 和
`provisionManagerRuntime.ts`。当前与旧线上目录只有两个明确配置：完整配置，以及缺少
赠券退款凭据表的旧配置。后者仍拒绝带版本赠券意图的退款。三个尚未注册到主迁移链的
模型列只在已声明的固定可选集合内；缺少其他必需列或出现未知列均拒绝供应。

先保存 App/Admin 实际独立 LOGIN 的只读失败集合摘要，再依次执行以下固定步骤。
所有脚本默认 `Plan`，证据目录必须是授权的本地绝对路径。

1. `scripts/bootstrap-production-manager-core.ps1 -Mode Inspect` 确认两协议同时缺失、
   固定 scope owner 缺席，以及既有计价和退款协议有效。`-Mode Apply` 原子创建空操作台账
   与两个 scope 函数，随后用独立只读请求确认 canonical 状态。
2. `scripts/bootstrap-production-manager-capabilities.ps1 -Mode Inspect` 确认完整必需目录，
   再用 `-Mode Apply` 安装三个固定函数。锁表函数使用独立 NOLOGIN owner；促销删除函数
   复用完整 manual 协议的同一个 owner，或在协议缺失时创建固定单用途 owner。
   不添加第二个 DELETE 获权者，不安装缺失的 customer 功能。
3. `scripts/provision-production-manager-runtime.ps1 -Mode Apply -PrivateRoot ...` 保留
   DPAPI 加密凭据和持久阶段日志，在同一事务内创建 NOLOGIN、最小授权、审计，再设为
   SCRAM LOGIN。既有同名角色拒绝改动。随后创建固定 VPC Hyperdrive、核对配置，并通过
   真实 Manager 连接检查 current user、session user、backend role 和权限。
4. 完成六端同源提交发布，添加核验后的 Manager Hyperdrive ID，保存控制面版本和
   只读发布检查。再次采集 App/Admin 完整失败集合摘要，确认没有新增权限回归。

两个 bootstrap 的 canonical 重复执行只返回 `applied=false`。安装响应丢失时先重新
只读检查原对象，不能把超时当成回滚或成功。角色与 Hyperdrive 供应只使用原加密目录
`-Mode Resume -ResumeDirectory ...` 核对已尝试阶段；不生成新密码或重建同名资源。
临时维护 Worker 在脚本 finally 删除，并用控制面 404 独立确认。

这些步骤不修改旧对象定义或已有主体授权，不清理业务数据。保留旧部署、已有连接、
加密恢复凭据和原始验证日志。门店连接可用不代表 App/Admin 的既有业务迁移门禁已完成。
