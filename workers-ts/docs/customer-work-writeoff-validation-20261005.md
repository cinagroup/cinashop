# 普通 customer 核销验证进度（2026-10-05）

本轮代码及本地功能复验已完成；独立物理结果以新主报告和实际proof／执行收据为准，本文未预填物理通过，也不是生产验收记录。旧财务批次的冻结主报告、失败日志和真实独立物理验收保持原文件。本轮所有既有文件先保存原始字节及完整副本，新文件先观察真实不存在；当前累计72个声明owner，before链至`.cache/customer-work-writeoff-before-extension14-20261005/before.json`，其中31个原文件、41个原本不存在的新文件。新增Admin代客报价服务在修复事务内KV读取前保存真实原字节；原71行逐字节保持。该记录不代表测试通过。

| 实际执行 | 结果 | 输入和后续限制 |
| --- | --- | --- |
| 原路由／Uni页面审计，route-audits02 | 两CLI退出0，sourceDrift为空 | Worker2321，Uni125；静态分布不证明业务等价 |
| 成交价格完整测试，price01 | 31／31，退出0，sourceDrift为空 | 真正的不可变成交快照、优惠顺序、分次尾差、次数／数量边界 |
| Uni三个完整runtime CLI，runtime03 | 219／219，退出0，sourceDrift为空，失败／跳过／取消均0 | 原财务入口177项完整重跑，新增42项；绑定修复后的freeze03，1275份实际依赖及完整副本 |
| Uni三个完整runtime CLI，runtime04 | 224／224，退出0，sourceDrift为空，失败／跳过／取消均0 | 全部原219项与新增五个同文档hash／迟到响应／确认中换码／耐久原请求／跨页监听反例；绑定freeze04-attempt02的21源及累计71个owner的真实before |
| Uni原五类型／构建CLI，build05 | 局部类型、完整类型、H5、微信小程序、App均退出0，sourceDrift为空 | 1270实际资源：H5 316／小程序810／App142／sibling .nvue 2；原依赖目录已恢复 |
| Uni原五类型／构建CLI，build06 | 五CLI均退出0，sourceDrift为空 | 绑定当前21源、原完整类型范围；1270实际资源及sibling .nvue 2保留，原依赖目录真实恢复 |
| 核销台账目录完整文件，catalog-writeoff-final02 | 29／29，退出0，本地PG清理通过 | DDL／目录源码未变；后续依赖配置改变，最终验收须重新绑定当前输入 |
| 收银来源台账目录完整文件，catalog-cashier-final02 | 19／19，退出0，本地PG清理通过 | 同上，不计测量或跳过场景 |
| 收银业务完整文件，native-cashierNative-final03 | 17／17，退出0，sourceDrift为空，本地PG清理通过 | 随后加入零元数量退回及空值修复，最终须重跑当前依赖 |
| 收银业务完整文件，native-cashierNative-final04 | 17／17，退出0，sourceDrift为空，本地PG清理通过 | 绑定最新积分订单边界与严格真实促销表／序列权限夹具；后续促销行锁边界改变时须重新绑定 |
| 收银业务完整文件，native-cashierNative-final05 | 17／17，退出0，sourceDrift为空，本地PG清理通过 | 当前真实促销invoker边界下完整创建／现金支付／原paid outbox／相对有效期／会员及游客／零元订单／重放／撤权／锁等待反例重新通过 |
| 核销业务完整文件，native-writeoffNative-final03 | 32／32，退出0，sourceDrift为空，本地PG清理通过 | 包含真实零元次卡两代数量退款后剩余实体的分次核销；后续增加原回执损坏恢复等子场景，等待完整重跑 |
| 扩展核销业务完整文件，native-writeoffNative-final04 | 30通过／2失败，退出1，sourceDrift为空，本地PG清理通过 | 回执价格／快照损坏恢复和真实SQL故障回滚通过；实际促销创建暴露新收银profile缺少明细INSERT，供应商测试误期望分配status 0而成熟完成值为2，修复后须整文件重跑 |
| 扩展核销业务完整文件，native-writeoffNative-final05 | 31通过／1失败，退出1，sourceDrift为空，本地PG清理通过 | 积分订单physical／root与真实HTTP反例、供应商结算均通过；实际促销支付事件消费在成熟账本FOR UPDATE时发生42501，正在补独立invoker行锁边界，不以裸UPDATE或删除锁修复 |
| 扩展核销业务完整文件，native-writeoffNative-final06 | 32／32，退出0，sourceDrift为空，本地PG清理通过 | 当前独立invoker边界允许成熟账本真实FOR UPDATE，同时真实LOGIN直接修改促销行仍被42501拒绝；实际Drizzle生成目录、促销支付、撤权、回执损坏恢复、事务回滚、积分订单及最终结算均通过 |
| 两个完整目录文件，full-catalog61-v2-final01 | 60通过／1失败，退出1，sourceDrift和inventoryDrift为空，本地PG清理通过 | 核销29项全部通过；收银32项中的重载反例因触发器函数不能声明参数而在夹具创建时收到42P13。保留完整失败；改为合法同名整数重载后仍须验证目录不就绪且原子授权被P0001拒绝 |
| 两个完整目录文件，full-catalog61-v3-final01 | 61／61，退出0，零失败／跳过／待办／取消，sourceDrift和inventoryDrift为空，本地PG清理通过 | 仅合法同名整数重载夹具修正，61个原名称及其余八个目录源码保持；重载使inspect.ready=false且实际原子授权被P0001拒绝，FOR UPDATE／直接修改拒绝／owner维护／SET ROLE和继承权限反例全部通过 |
| 成熟核销／手机／有效期11个完整文件，matureWriteoff-final01 | 164／164，退出0，sourceDrift为空，本地PG清理通过 | 保留全部原文件；纯合同检查与真实SQL场景分别识别，不把静态源码断言计为SQL效果 |
| 四个完整成熟场景导出，matureScenarios-final02 | 4／4，退出0，sourceDrift为空，本地PG清理通过 | 原核销、次卡商品、有效期、手机订单四个完整导出；手机场景13／13原断言，真实顶层业务事务、public指纹和私有schema清理均通过；首轮失败保留 |
| 成熟结算四个完整文件，matureSettlement-final01 | 74通过／4失败，退出1，sourceDrift为空，本地PG清理通过 | 四个拼团创建用例缺少真实SQL自提开关；仅补测试配置，原76个expect调用保留，待完整重跑 |
| 成熟结算四个完整文件，matureSettlement-final02 | 78／78，退出0，sourceDrift为空，本地PG清理通过 | 四个真实支付／退款优先的拼团并发场景全部通过；原首轮失败及修前完整输入保留 |
| 成熟下单四文件，matureCheckout-final01 | 超时，退出null／SIGTERM，sourceDrift为空，无完整汇总 | 逐项日志不能作为整文件通过；已单独真实停止其临时PG，status 3／PID不存在／端口ECONNREFUSED，不假称残余fixture为0；后续改为完整文件分组并增加测试宿主预算 |
| 全页面主题宿主，theme01 | 125／125真实SFC解析、模板编译和宿主链通过，customer-work 17页 | sourceDrift为空，stderr为空；不代表浏览器或设备通过 |
| 全页面主题宿主，theme02 | 125／125，customer-work 17页，退出0，sourceDrift为空 | 新共享hash生命周期源码下全部真实SFC解析、模板编译及宿主链通过 |
| 编译语义，semantic03-run01 | 12通过／3失败，退出1，sourceDrift为空 | 原10项全部通过；新增H5断言需按真实共享import及平台条件编译追踪，保留失败后派生新检查；浏览器尚未运行 |
| 编译语义，semantic04-run01 | 13通过／2失败，退出1，sourceDrift为空 | H5及MP/App扫码平台分支已通过；剩余检查器漏解析嵌套组件包装及具名导航API别名，已按真实AST准备fresh05，未删用例 |
| 编译语义，semantic05-run01 | 15／15，退出0，sourceDrift为空，stderr为空 | 全部原十项及新增五项；实际共享组件／路由／导航API的import-export绑定和平台条件分支均通过；浏览器另行执行 |
| 编译语义，semantic06-run01 | 原15／15名称与顺序保留，退出0，sourceDrift为空 | 绑定新build06/current21；三端实际共享导入、导航API及平台分支重新通过 |
| 实际完整浏览器，browser05-run01 | 73／90，17失败，扩展QA0／6，退出1，sourceDrift为空 | 原62组全部通过；新夹具的Uni原生输入定位、raw存储键、角色撤销响应及循环请求基线有误，已保留实际DOM／请求／截图及完整失败收据；浏览器和61051端口已关闭，待完整fresh06重跑 |
| 实际完整浏览器，browser06-run01 | 82／90，8失败，扩展QA5／6，退出1，sourceDrift为空 | 原62组全部通过；保留严格网络分类及所有失败。发现共享经营页面同文档hash换码未重新校验的真实源码问题；扫描夹具另需真实HTTPS。浏览器和58372端口已关闭 |
| 三项浏览器机制诊断，mechanism-diag02 | 退出0，sourceDrift为空，无完整业务通过计数 | 实际HTTPS扫码通过原安全门槛；同页重复参数仍显示旧单、冷启动正确拒绝，确认生命周期缺陷；存储故障真实拦截且0次POST。浏览器和60634端口已关闭 |
| 实际完整浏览器，browser07-run01 | 87／90，3失败，扩展QA5／6，退出1，sourceDrift为空 | 原62全部通过。预注册故障16个、实际触发14个（14／16）、迟到8／8及当前403三项；第79组请求前失败而另两故障未触发，网络总门槛仍失败，未分类／歧义均空。正在修正ASCII请求phase、逐循环UUID基线及核查真实输入框会员条码残留；HTTPS浏览器及56794端口关闭 |
| 撤权输入框实际诊断，role403-diag03 | 退出0，sourceDrift为空，无完整业务通过计数 | 当前真实403后组件绑定立即为空；Uni原生输入受100ms同步延迟影响，150ms及500ms均实际为空且无迟到回写、0次POST；HTTPS浏览器及64326端口关闭。完整90组仍须重跑，诊断不替代业务通过 |
| 实际完整浏览器，browser10-run01 | 功能90／90、扩展QA6／6，严格整体退出1，sourceDrift为空 | 实际受控故障16／16、迟到8／8、当前403三项；两条真实GET context提前取消在进入mock前发生，旧观测未记录request_id／phase，仍计未分类失败，整体不通过。全部原功能断言及严格分类规则保持；HTTPS浏览器及52246端口关闭 |
| 实际完整浏览器，browser11-run01 | 整体退出0，功能90／90、扩展QA6／6，sourceDrift为空 | 实际故障16／16、迟到8／8、当前403三项、全部11类unexpected为空；972条真实API请求在request事件记录身份，提前取消与实际XHR／认证变化唯一绑定。全部541个原断言和严格分类尾段保持，旧10失败不计新信用；HTTPS浏览器及64427端口关闭 |
| 原12个完整普通回归文件，unit-run02 | 322／322，退出0，sourceDrift为空 | 主题宿主旧计数13改为真实17，并明确检查四个新增页；保留所有原祖先／插槽负例；首轮321通过／1失败保留 |
| 原完整Worker runtime，worker-runtime02 | 0项业务测试，21个启动错误，退出1，sourceDrift为空 | Windows workerd发生0xc0000005原生访问异常；与已记录环境阻断相同，不计业务通过，也不根据日志提示推定已查明运行库根因 |
| 原Worker完整类型检查，types01 | 默认4GB发生OOM，失败保留 | 未缩小tsconfig、未跳过文件 |
| 两套原tsconfig完整检查，types02，显式8GB诊断 | 两个退出2，实际类型错误已定位和修复 | 原package脚本现统一8GB预算，等待完整重跑；原包含范围和检查规则保持 |
| 两套原tsconfig完整检查，types06 | 原npm完整入口退出2，unit实际四条类型诊断，runtime因原&&未到达 | 目录夹具for-of未用变量和原生测试空数组类型；未删文件／跳过检查，失败和完整3157／1927文件枚举保留 |
| 两套原tsconfig完整检查，types07 | unit及runtime原脚本均到达并退出0，sourceDrift为空 | 仅测试变量加下划线和string[]类型，原运行逻辑、32及61名称保持；后续Admin报价源码修复需新types08重新绑定 |
| 核销完整原生文件，native-writeoffNative-final07 | 32／32，退出0，sourceDrift为空，本地PG清理通过 | N27仅string[]类型注解，擦除后的JS与原始代码相同；全原文件及实际促销／积分订单／两代零元退回／锁／回执／事务／结算场景重新通过 |
| 两个完整目录文件，full-catalog61-v4-final01 | 61／61，退出0，sourceDrift和inventoryDrift为空，本地PG清理通过 | 仅未用for-of变量加下划线；所有原名称及SQL保持；后续Admin源码改变后需绑定新完整输入 |
| 当前成交价格完整文件，price02 | 31／31，退出0，sourceDrift为空，stderr为空 | 原完整文件与原CLI，raw-only输入；实际execution使用inputs字段，捕获计划的inputsFile字段错误以精确helper绑定的元数据勘误保留，不重写原计划 |
| 当前两条原分布CLI，route-audits05 | 两CLI退出0，sourceDrift和inventoryDrift为空 | 完整1740输入、3真实loader包和170个原不存在候选；2321／1904／890／976与125页／7缺口保持。后续Admin源码改变后需重新绑定 |
| 自提两个完整原文件，checkoutPickup-final01 | 24／24，退出0，sourceDrift为空，本地PG清理通过 | 两文件分别4及20项，原完整合同和真实SQL政策保持；独立输入未包含后续改变的Admin报价服务 |
| 代客流程完整原文件，assistedFlow-final01 | 48通过／1失败，退出1，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 唯一失败为KV读取期间实际pg_stat_activity仍有1条idle in transaction，原期望0。报价前购物车促销投影在RR事务内再次读取首单KV配置；全部49名称和375个共用expect调用保持，不放宽断言 |
| 当前前端证据producer05 | 实际退出0，sourceDrift和inputDrift为空，两份最终前端收据已生成 | 当前21源的runtime224、五CLI构建、语义15、浏览器90／QA6及主题125全部严格绑定；先前producer03／04失败保留，准备和元数据探针不计物理通过 |
| 当前两套原tsconfig完整检查，types08 | unit及runtime原脚本均到达且退出0，sourceDrift为空，stderr为空 | 原listFilesOnly3157／1927范围不变，未增加排除或跳过；绑定Admin修复后的before72 |
| 当前两个完整目录文件，full-catalog61-v5-final01 | 启动阶段退出1，无Tests汇总，零业务断言信用 | 默认沙箱pg_ctl restricted token错误87；原stdout／stderr／输入保留，51765真实status3／PID不存在／socket拒绝，仅资源闭合，不假称剩余fixture为0 |
| 当前两个完整目录文件，full-catalog61-v5-final02 | 61／61，退出0，零失败／跳过／待办／取消，sourceDrift和inventoryDrift为空 | 同原完整CLI在授权的本地临时PG重试通过；真实残余0／停止／status3／PID不存在／63417拒绝连接；失败final01独立保留 |
| 当前代客流程完整原文件，assistedFlow-final02 | 49／49，退出0，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 原唯一KV-in-TX失败反例及全部375个共用expect保持；事务外配置快照修复后真实通过 |
| 当前代客表单完整原文件，assistedForm-final01 | 40／40，退出0，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 原完整权限、图片元数据、表单采集及UUID重放场景保持；expected R2 fault stderr不误记为失败 |
| 当前成熟核销11个完整原文件，matureWriteoff-final02 | 164／164，退出0，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 当前完整输入重跑，区分静态合同检查与真实SQL效果 |
| 当前成熟结算4个完整原文件，matureSettlement-final03 | 78／78，退出0，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 原真实支付、退款及并发场景保持，旧74／78失败与随后旧输入78通过分别保留 |
| 当前4个完整成熟场景导出，matureScenarios-final03 | 4／4，退出0，零跳过／未处理异常，sourceDrift为空，本地PG清理通过 | 手机13个原断言、原真实顶层业务事务、public指纹及临时schema清理均保持 |
| 当前12个完整普通回归文件，unit-run04 | 322／322，退出0，sourceDrift为空 | 原12文件及全部真实正／负例保持；原RAW输入的完整copy路径与字节保留 |
| 当前两条原分布CLI，route-audits06 | 两CLI均退出0，sourceDrift和inventoryDrift为空 | 完整1741输入，真实loader／PHP／Uni目录与原不存在候选均保留；2321／1904／890／976及125页／7缺口不变 |

新共享H5 hash监听已冻结：同页参数变化清空旧页面数据、重新校验完整原参数，并使旧请求失效；跨页不操作新页面请求，卸载时移除监听；已落盘的原UUID及完整意图保持。当前21源的runtime224、原五类型／构建、主题125、语义15和浏览器90／QA6已实际通过并生成前端收据。新发现的代客报价问题只修改Admin报价服务：原事务外配置加载捕获真实KV命中与成功SQL回填值，事务内购物车投影复用同一只读内存快照，未知配置和写入拒绝，商品／账户／地址继续在原RR快照中读取。共用测试整字节未改，375个expect调用保持；原49失败已封存后才修复。当前所有上述原完整功能CLI已实际通过；独立物理结果以新收据为准，Windows workerd环境门槛保持开放。结果只从实际stdout及退出收据计数，不预填计划数量。

首轮目录校验、收银业务、类型和路由审计的真实失败与修复前输入均保留在`.cache`。原财务919221物理任务的通过属于旧批次；本轮改动源不能重新指向旧live-source通过。后续独立读器需重建旧图并把改动owner的原任务指向真实before副本，再对本轮完整输入和新产物实际读取、哈希及检查清理状态。

未执行生产DDL、授权、发布、提交或推送。完整手机经营角色和五个代客页、个人中心25/26及menuRoleGates=false、普通现金退款、游客退款、真实provider／设备、Linux／Hyperdrive、容量和发布保持开放。Checklist404总项／246完成／158开放的复选行保持。

当前72个owner按来源分为Root37（原owner root32＋catalog4＋独立合同审计1）、BE14和FE21；每个after均由实际producer捕获原始／LF字节及完整副本。FE的原运行before71保持，其后新增Admin before72不倒写旧执行。最终3个producer分别绑定20个唯一当前check及6份profile，仍由独立读器重新读取原919221任务、历史完整输入和本轮新产物；原期待索引不修改，历史信用为0。最终主报告为[本轮不可变报告](../audit/customer-work-writeoff-acceptance-final01-20261005.json)，物理结果为[实际proof](../audit/customer-work-writeoff-acceptance-final01-20261005.proof.json)，以其真实生成的内容为准。
