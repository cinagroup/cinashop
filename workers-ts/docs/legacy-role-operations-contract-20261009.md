# 旧角色独立启停、物理删除与完整引用历史

本批在独立本地私有候选承接 `d3737087d01f9ac9930eeea6170336be97c85a1d`，并在该候选中正常合并精确公开 main `2e1bda25b5e2c2b0843dced4debe7ce7235c9640`；保留优惠券 overlay、Supplier 精确选中、UniApp 待确认订单及 parser 7.1.6 修复。本批尚未合并回公开 main，原冻结 d373 候选保持不变。旧角色的 `PUT setting/role/set_status/:id/:status` 和 `DELETE setting/role/:id` 分别由专用确认协议承接；同 handler 的 `/api/admin` 别名及三个预览、回执、封存端点不另算旧合同。原角色 POST 保存、现代 `role-delete` 软删除和旧管理员 DELETE 软删除的操作域保持独立。

## 原始合同和当前用户入口

真实 PHP `route/admin.php` 的两条角色声明分别在 1762、1764 行。角色 DELETE 通过旧 BaseServices/BaseDao/Model 的 `where(id)->delete` 物理删行，不清理管理员 `roles` CSV。原 Vue 页面把 `ids:''` 传给 `tableDelApi`；该函数实际上发送 `data.ids`，因此是空 body。当前 DELETE 接受 empty/absent body，并额外有限兼容精确 `{ids:''}`；目标只来自严格正 int32 路径。状态只接受路径数字 0/1，两个动作都拒绝查询参数和其它业务 body。

新的 Admin `/system/legacy-roles` 页面列出当前账号下一层平台角色；本候选支持当前actor层级0～9、目标角色1～10、平台type0/1和relation_id0，拒绝本人正在使用的目标角色。启停、删除分别要求 `system.legacy_role_status`、`system.legacy_role_delete`，两者只覆盖列表读取，互不授予，也不由旧表单保存能力隐式获得。329/330 数字菜单必须匹配真实 protected metadata tuple 和 PUT/DELETE 方法。预览 admission 不是可持久授予的能力，服务仍按具体操作复核权限。

页面先显示完整 before/after、全部启用及历史引用账号、当前有效权限是否变化，再要求明确勾选确认。提交前不修改显示状态；七字段待确认记录按 actor 隔离，Web Locks 与页面 generation 防止同屏/跨页重复提交和迟到响应覆盖。5xx、连接异常和刷新后查不到回执保持 unknown；只有匹配原操作的 committed 或永久 not_applied 结果可以清除待确认状态。旧 Vue 尚未增加这四个确认头及恢复交互，不能把旧裸请求的受控拒绝当作完整旧客户端验收。

## 历史引用与生效权限

正常被引用角色可以在核对完整影响后启停或真实物理删除。执行只改变目标 role：启停 UPDATE 仅写 status；删除 DELETE RETURNING 核对原七列及真实缺行。管理员全行和原 CSV 保留，不级联删除账号，不用 status=-1 替代物理删除。

物理删除的 committed 数据库回执严格包含 `{id,deleted:true,deleted_role:{id,type,relation_id,role_name,rules,level,status}}`。返回客户端的 result 只包含 `{id,deleted:true}`。原始七列快照用于说明历史引用，不导入有效权限，也不成为可委派身份。

完整引用 helper 先查询所有真实 ID，再分类真实停用行、现代软删行和具备专用不可变 v3 committed 回执的物理缺行。未解释的 missing、foreign、畸形 CSV 或空段都拒绝，不能靠权限解析器忽略它们。已有真实行不能冒充已删除；重新出现的外域行也不能借旧回执放行。删除快照必须与原引用层级一致；旧角色/旧staff下一层级业务另严格核对真实角色level，现代既有真实角色level语义保持，不对其扩大下一层级限制。

现代写入、旧角色表单和旧管理员工作流实时复核这一完整历史后，只使用仍启用的真实角色授予能力。旧管理员编辑表单可用删除快照显示原角色名称和禁用选项，操作者须明确移除该 ID、保留可委派的真实角色；不能重新分配已删除身份。共同 parser 不再过滤空 CSV 段。没有剩余 writer grant 的账号不能从历史快照恢复写权限。

## 事务、回执与显式维护增量

完整 actor、目标、引用账号、相关角色和菜单纳入 HMAC revision。双业务表 SHARE ROW EXCLUSIVE 屏障和菜单 SHARE 锁先于决定读取，保持到真实 COMMIT；新增引用、撤权和菜单变化不能漏过预览范围。行数上限外还对完整集合逐个做 SQL 4MiB 字节预算，超限503，不截断影响或签名范围。目标 DML 和不可变回执在同一事务；异常触发器、CSV 级联、回执冲突和结果改写都必须回滚。

新增 v3 在精确已 commissioning 的 v2 profiles 上，仅替换 `aao_operation_ck` 与 `aao_state_ck` 并为现有 Admin LOGIN 增加 `DELETE public.system_role`。App 不增加 DELETE 或 receipt SELECT。全部原六类回执形状、不可变触发器、函数、表、业务行和其它 ACL 保持；schema 漂移、提前 grant 或 v3 缺 grant 都拒绝，不自动修复。维护 runner 只允许显式 PG16 owner transaction，运行时、启动和 HTTP business handler 不调用安装器。

此前 staff/newcomer 发布授权不包含该新增 DELETE ACL。该升级尚未在生产执行，旧 d373 维护模板仍只承接其原 v1/v2 范围，本批 v3 生产适配工具尚未准备。已核验 SQL 计划仅适用于精确已commissioning的v2，不能作为空表/v1生产库的完整安装入口。本批公开推送、当前提交完整 CI、合并、生产适配工具、真实账号/规模/Hyperdrive 和发布验收仍须独立完成。

## 本地验证状态

本批共554个唯一测试实际通过：Worker相关372＋上游64、真实PG16 34、Admin SFC 43、UniApp Node 41；另有36项浏览器检查，不并入测试case总数。以下为分别执行、输入核对后的结果，不表示554项在同一个命令内重跑。完整原始退出、日志、case列表、当前输入核验及失败历史见[本批验证账本](../audit/legacy-role-operations-validation-20261009.json)。

16 文件 372 项相关回归实际通过，包含本批业务43、完整旧消费者历史11、细权限11和既有共享写入、staff、目录、恢复、路由/调用审计及 runner 合同。整合后逐输入核对：31 项字节完全一致，仅 Controller 与删除证明 helper 各去掉末尾空行；原字节由当前正文加精确旧换行后重新得到相同 SHA256，不把未执行的检查记为通过。新上游行为另在独立真实测试中验证。

整合后的 PG16 四文件34项实际通过、零跳过：专用角色操作1个完整case、升级5个case、优惠券8项、Supplier20项。角色case内含完整v3 commissioning、两个真实LOGIN、两base正常启停/物理删除、三个peer锁、七trigger回滚及实际COMMIT后丢失响应恢复；内部phase只计一个case。完整283表profile案例证明只增加Admin角色DELETE、两CHECK及异常整事务回滚，不扩大App权限。最终独有集群 `finance-postgres-19ITta` fixtures0、自停，独立 `pg_ctl` 实际退出3且无postmaster PID；各次data/log保留，未执行删除。

最终角色20＋旧staff23共43项实际SFC/Axios测试、Admin完整类型和构建均退出0。桌面/手机各18项、共36项浏览器夹具检查与32张截图通过，80个实际CSS/JS响应与本次265个产物SHA/大小匹配；8个输入与全产物前后稳定。新增旧staff场景验证已删除ID保留且禁选、移除前拒绝预览、主动移除后七字段PUT的roles为[7]。pageErrors/外部请求0，四条console error对应两viewport故意500及丢失响应；浏览器和5188测试服务关闭。该网络夹具不充作生产后端、网页登录或真实Hyperdrive验证。

上游四文件64项与34项原生分开实际执行，文件和case不与372项重复。最终Worker完整单元类型unit-types05、运行时类型runtime-types02实际0；两原CLI审计02实际0，完整正文与已保存路由/调用快照一致，仅忽略generatedAt。API构建dry-run实际0，未上传。

UniApp完整491源码、786已安装manifest及1586个选定关键文件前后稳定；本批候选使用自己的物理node_modules，Vue3.4.21与五个消费者实际parser7.1.6。Node实际41项由checkout 38（含有限参数展开）＋parser3组成，逐case源码位置与TAP/JUnit名称、顺序一致；最终tests02、types01及相同原minifier的fresh h502构建实际child/capture均0。H5 320文件、2,397,359字节全部重新读回核验SHA/大小。本批未执行微信/App构建，不以H5替代其它平台验收。

首次native失败为本地夹具姓名22字符超过varchar16，仅缩短夹具值后完整重跑通过；初次unit CLI参数不被当前Vitest支持，未执行断言。首次完整Worker单元类型只报两个既有跨前端测试缺Vue，已核对lock后借用Kefu/UniApp依赖。整合时曾核对另一物理UniApp安装的最新lock和五个消费者实际7.1.6，但该外部checkout随后整体消失；unit-types04实际TS2307保留，不以当时借用证据代表最终安装。只摘本次失效junction后，在本次候选物理目录按精确lock执行npm ci，786包/实际0，package与lock未变、旧冻结安装校验未变；受影响检查使用这一独立安装重新执行。首次完整回归的四项失败经恢复期权限精确12列表及历史拒绝顺序修正后实际372全通过；浏览器attempt04仅双命中locator失败，限定到可见toast后attempt05完整通过。UniApp tests01实际41项通过但外部采集器旧预期错误写成29而退出1；只修采集器的有限case展开清单并保留旧证据，fresh tests02实际通过。h501实际退出1：terser5.49.2本已声明、锁定、安装并能正确resolve，Vite在沙箱内native realpath遭EPERM后误报缺包；同Node/同文件只读权限对照及同源码、依赖、参数的受控本地h502实际0，无产品源码、lock、依赖或minifier修改。原始失败、被替代记录和停止证明均保留。

Checklist 保持404总项/249完成/155开放，所有复选行及复合父项不因两条注册或夹具验收自动勾选。完整旧角色创建/编辑未知结果恢复、旧可配置密码和生产端到端仍开放。详细后端合同见 [后端说明](legacy-role-operation-backend-contract-20261009.md)。
