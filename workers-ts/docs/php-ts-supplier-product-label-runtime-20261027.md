# Supplier 商品标签：真实 current App LOGIN 写入闭环（2026-10-27）

本轮修复生产装配路径中的权限缺口：`createApp -> containerMiddleware -> createDb(env.HYPERDRIVE)` 使用受限 App LOGIN，既有 Supplier 服务却直接写标签并读历史辅助表，实际 PostgreSQL 16 返回 42501。新增、修改、物理删除现通过一个独立、显式安装的受限能力完成；App 原有表、列和序列权限计划保持原字节。

## 原始合同与实现边界

固定 PHP 来源为 `8ed2a5b139f9170dd11b0dff91803f2fd59e40a5`，完整保存 18 份原文件。注册的 Supplier 入口只支持分组与名称两个作者值 `label_cate/label_name`，名称 1 至 20 个 Unicode 字符；保留现有动态表单、列表、catalog、原商品选择器合同。未新增 Supplier 状态、显示开关、批量编辑或无注册路由的分组作者入口。继续使用既有 TS 实时权限规则，不恢复 PHP 的权限 TODO 短路。

`SupplierProductLabelService` 保留当前操作者、Supplier、密码版本、期限、角色、菜单、归属、完整行修订、分组和重复检查。新增 `SupplierProductLabelWriteCapability.ts` 在等待前固定 actor/完整原行/作者 payload，再调用唯一五参数函数 `public.supplier_product_label_mutate_v1(jsonb,text,integer,jsonb,jsonb)`。更新只写两个作者值，保留其它标签事实；新增使用固定 scope/default；删除继续检查 type3 关系、历史辅助引用和保守的商品 CSV 引用。

SQL 能力独立复核实时操作者与权限，在成熟 Supplier scope 锁后重新读取；锁住目标、分组和权限事实。强制执行延迟约束后，重新核对完整标签、分组、审计、引用和权限事实。异常回滚整笔业务。回执包含完整原始 14 列行和正 audit_id；修改/删除完整行事实比较沿用既有合同，不新增 xmin 修订协议。

## 显式安装与权限

`runSupplierProductLabelUpgrade` 仅支持明确的 PG16 维护连接、已 commissioning 的 exact current App/Admin profiles，以及预先创建的独立空 NOLOGIN owner。安装器不创建角色，不自动修复权限漂移，不在请求中安装。事务内检查对象、owner、ACL、schema/default、隔离级别及触发器环境，最后才授予 App 唯一 EXECUTE；中断完整回滚，精确重放幂等。

NOLOGIN owner 仅持有所需列/表读取、标签两列更新、固定新增列、物理删除及两条序列 USAGE。App 无新增标签表 INSERT/DELETE/业务列 UPDATE、辅助表 SELECT 或标签序列权限，Admin 不获得能力 EXECUTE。共享商城的计价审计只认可独立检验通过的 exact function OID，isolated/customer 范围保持原有边界。

既有 Admin 标签辅助读取审计继续要求唯一 Admin receipt reader 的 SELECT(label_id)。额外仅认可完整能力检验通过的 NOLOGIN owner 同一列读取；未知角色、App 原始读取、额外列/整表读取和能力漂移均使检验失败。真实 Admin/Supplier 作者与商品引用竞争已加入最终本地验收。

## 最终本地验证

最终五门均以同一完整当前源码快照新鲜执行且 exit 0：backend、真实 PostgreSQL 16 native、Worker main/runtime 类型、实际 API inventory；随后35套来源全通过。

实际唯一通过 **4979** 项：backend 262、native 36、source 4681。新增 **195** 项（runtime 7、source 188）；旧来源4493项的完整文件/标题身份与上一轮真实报告逐项相等。旧 HTTP14/native9仅在本轮对应真实执行中各计一次；诊断与中间成功零计入。

原生六文件均逐项通过，fixture remaining=0，独立集群 STOPPED；宿主127.0.0.1拥有端口已拒绝连接，拥有 taskRoot 下无存活 PostgreSQL 进程。API仍789 callSites/827 variants，完整报告字节未变。

前端、Admin/Uni、公开读取、商品选择/绑定和固定运行权限计划作为来源字节边界核对；本轮没有重新运行 GUI、Admin/Uni 类型或构建。此前验收不被冒充为本轮重新执行。

## 来源、失败记录与发布

真实 accepted before 为上一轮商品标签批次 8,023 文件，manifest SHA256 `bb3ed62246c18ebf0702b36f400d8101f247e9f6e73bfa6af397d3ff9a72d1e9`；上一轮 receipt SHA256 `73614e56dc9a02b87dedfec4d44e9698e0cfa7242d5480e7fe5dc8e369487fed`。1,736 份旧证据原字节冻结。34 套旧来源测试只更换 import 读取入口，保留原断言和负例，通过完整物理前后像及出版桥逐层还原。

新 proof SHA256 `9aeaf53960f53c193107c2af22d9c21b50224b00572bc6a2f387dee13aa516e0`；新 helper SHA256 `138091f80a5cd3d850b557f7fe49683fe5cc6567daedfa7da2387fbaa3f7b0ea`。43 份受控完整前后像、7 份完整新增来源、18 份固定 PHP 原文及实际五门输入/日志均绑定；来源证明本身不代表运行或生产验收。

保留 diagnostic01 至 06 全部原始失败与中间成功，均不复用或重复计数。diagnostic01 业务失败被 HTTP pool 清理错误遮蔽，fixture remaining=1 所在自建 cluster 已停止；diagnostic02 清理修复后真实捕获 App 42501；diagnostic03 暴露共享计价审计识别缺口；diagnostic04 的 24 项中间成功不作最终验收；diagnostic05 记录两个新增测试/兼容性问题；diagnostic06 的 30 通过/1 失败记录网络 spy 漏设，原始终态未改写。全部修复均保存完整前后像、diff 和原因。 首次最终五门全通过后，来源回归为 4,680 通过/1 失败：新增逆向替换测试误将 SQL 的 `$$` 当作 JavaScript 替换标记；该整套成功/失败及完整原像保存在 `failed-source-attempt-01`，仅改为回调返回原字节后重新冻结，五门和全部来源均重新执行，原中间成功不复用计数。

最终 accepted 源码、文档与原始证据保存于 `.cache/migration-evidence/supplier-product-label-runtime-20261027`，accepted receipt 最后发布；两本迁移账本仅追加，旧字节前缀和复选状态保持。整体 PHP 到 TS 迁移继续开放。本轮未在生产安装 addon，未使用真实 provider/账号，未执行远端 CI、commit/push/PR/merge/deploy。
