# 切换账号后的发货订阅通知作者

第48轮基于已按具体 SHA 授权推送并核对的 `a400366b181a2303a452bb906d9acf40a443b883`，接通新产生的实物发货通知作者。真实流程为 A 付款与归属留存 → 当前配置切 B、最新裸绑定 B、全局模板 B → Admin 或受控分配的 Manager 发货 → App 从原付款解析 A 接收人与独立模板 → [既有 Queue attempt/result 协议](routine-subscription-delivery-dispatch.md)发送。旧 A/B pin、空 pin 与历史缺 pin 不改版、不重签、不补归属。

## 两阶段作者与实际身份

`RoutineSubscriptionNoticeRequest` 在业务原事务写入 format2 签名请求，绑定数据库/维护者名称及 OID、真实作者 LOGIN/OID、UUID、eventKey、聚合、原事件时间和封闭配送事实。密钥与 DTO 在首次异步读取前复制；作者只读取目录与实际 SQL 身份，不获得私有付款、归属或订阅策略读权，不选择 A、openid、模板或 token。Admin 显式传入 Env，Supplier 公共履约服务继续传递 Env，Manager 等调用方复用该服务；Kefu 的可选 APP_KEY 类型也显式声明。

整个 Dispatch namespace 尚未安装时保留 legacy pin 作者。任意对象存在但目录不完整、缺签名材料或非有效作者时，记录不可发送的 unavailable2；元数据 SQL 故障在真正嵌套 SAVEPOINT 回滚后也只写 unavailable2，不退回当前账号。已有事件或并发 INSERT 的赢家始终保留原版本、pin、缺失或原签名，只比较配送业务事实，不升级历史事件。guest/fictitious 不进入新签名作者。

新版本 claim 写入前使用轻量 actual-App 身份门：只查 pg_catalog，核对 PG16、实际 backend LOGIN、无继承/成员/拥有物/CREATE、RC/RW、origin/public、5秒事务龄，以及三源普通持久表同维护者 OID；subscription policy 的唯一非 owner 权限须为维护者直接授予当前 App OID 的不可转授 SELECT。该门不读取私有物理行、不调用目录反解器、不要求 Dispatch 就绪，也不代表完整目录/付款/owner/发送批准。hint 之后若锁定行新变为 V2，写 claim 前再次补验；错误 Admin LOGIN 不会改 claim。

App 处理事务在第一个业务行锁之前，于实际 SAVEPOINT 取得八个升序共享 try-only gate，以及 outbox/delivery 的 SHARE ROW EXCLUSIVE NOWAIT，避免随后 SHARE → INSERT 升锁死锁。完整目录、[原付款与精确归属](routine-subscription-delivery-source.md)、NativeApp 排除、家族守恒、同城有效来源、独立最新模板/材料仍在 Mini 的可回滚 fresh 读取中核对。读取故障或争用不使外层事务保持 aborted。

## 签名 staging 与失败恢复

App 从原始付款证明取得 A，从明确 UID/AppID 归属取得接收人，从独立 subscription 最新批准取得 1458/1128 模板。它在同一事务创建 delivery ID 并写入签名 staging intent，绑定请求签名、精确行/事件、来源、当次策略、目标、模板、页面、渲染数据及 SQL 时间。新插入的 unsigned 中间行与 intent UPDATE 必须一并成功；尾部再核对5秒事务龄和批准期限。

staging intent 是认证后的可变投影，不是物理不可变回执，也不证明 POST。解析器先做 descriptor-only JSON 副本：plain 对象/dense 数组、拒绝 getter/toJSON/函数/非 JSON 值/孤立代理项，深度16、节点4096、64KiB，再做封闭 shape、scope、策略与 MAC 核验；不冻结调用者输入。真正不可变的接受意图仍由首次 dispatch attempt 留存，每次 POST 继续经过 phase47 的 fresh 同事务来源与一次性能力。

有效签名请求遇到缺 A owner、缺独立模板、源锁或临时消费端密钥/scope 获取失败，只延后 Mini。既有 outbox FAILED 退避/8次上限继续适用，不重置尝试次数；Queue 确认后的补偿由原 scanner 读取可用事件。短信、公众号、发货上传各按原策略处理，站内信可以先提交。V2 重试保留已提交渠道的原目标/模板/内容及站内信，不因后来的手机号或模板变化重渲染；首次其他渠道渲染使用原事件时间。

在签名材料和 scope 已获取后确认请求无效，才创建空目标/模板的终态 SKIPPED；已提交的 unavailable2、legacy 或 skip 永不在修复配置后升级。已有 staging 可认证地重放，但派发前仍重查最新批准与源事实。撤销、篡改或错误绑定不会获得 attempt；缺 result 的已发 attempt 仍是 sticky UNKNOWN，不换 ID、清次数或人工状态重发。本轮无新表、DDL、grant 或新 provider 传输协议。

## 最终验证

| 最终批次 | 结果 | 整组耗时 |
| --- | --- | --- |
| regression-09 | 新作者19 + 旧Queue13 + 来源10 + 通知45，共87项通过 | 554.04秒 |
| final-10 | 单元198通过/2个既有PG条件跳过，Worker unit/runtime类型通过 | 321.80秒 |

两批各8574份输入运行中及补文档前均一致；所选最终285次成功/2跳过不累计重复运行。单层共享串行锁、Vitest单worker/不并行文件、Node24.14.1/npm11.11.0/自有PG16.14、既有内存限制、每命令600秒/整组1200秒保持；四个最终 PG 均 remaining0/STOPPED。32项新纯单元仅证明 request/intent codec，包含调用者快照、getter/原型/序列化/预算反例，不作真实 SQL 准入证据。

19项新原生用例复用真实 checkout、默认 RSA/AES A 回调、App paid、code2Session 归属、Admin 发货与受控分配 Manager 导出的实际路由。正例在付款后、发货前切 B，覆盖 Admin express/send 与金融 store0 的 Manager 整单 express；payer≠A owner，最新裸 B 与全局 B 模板均不能替代 A。Admin/Manager 对付款证据、归属、subscription policy 三表没有 SELECT。错误实际 LOGIN、Dispatch 额外索引漂移、缺 owner/模板、撤销、MAC/scope/event/delivery 篡改、真实源锁和晚 intent UPDATE 触发器故障、重放和 UNKNOWN 均有边界用例。

手机号连续性、用户/地址/库存/配送员和模板是明确 fixture 输入；微信 HTTP、缓存、Queue 为受控本机传输。历史缺 pin、MAC 有效的错误绑定、故障索引/触发器是明确负例 SQL，不作成功业务作者；缺 writer Env 的最后一例仅证明实际 LOGIN 作者边界，该订单并未发货。不是 createApp、浏览器、真实 SMS/微信接受或订阅同意证明。

失败记录均保留：final-01 的188通过/2失败/2跳过是 mock hook 返回函数被 Vitest 当 cleanup；author-03 为15通过/2失败，一项快照取在 staging 前，一项揭示完整 claim 目录反解器在来源锁之前阻断其他渠道，随后以轻量身份门和真实 savepoint 修正；native-05 为安装准备失败、13未执行，延后安装后漏传已安装 city reader 的完整 peer 声明，修正 fixture 声明且未放宽安装器；compat-07 来源10通过、通知44通过/1失败，修正新 guard 对 legacy SMS 无 payload 调用的兼容。修正后统一以 regression-09/final-10 的最终字节重验；中间通过批次不计最终总数。

原日志、冻结/失败、交叉复核及提交字节/秘密扫描记录在本机 `.cache/php-ts-phase48-validation/`。4个主流程源由复核者独立交叉读；另2源/3测试由其编写、主流程另读，剩余7文件作窄 diff 核对，不称16文件全独立审计或独立重跑。文档在全部验证终态后补。

父提交 [a400366b 的 CI](https://github.com/cinagroup/cinashop/actions/runs/41423671523) 末次快照为10成功、Worker两分片仍运行，不称全绿色，也不替代新提交 CI。split/city、其他角色入口及容量未单独动态重证，退款拒绝/成团等作者、非微信单原账号发送、完整归属 manifest/单次许可/原子切换与整体 PHP→TS 迁移仍待完成。未做生产DDL/Env切换、部署、真实微信或 Workerd/Hyperdrive 环境验收；旧用户/UID/权益/订单/付款保持，未知不猜归属，跨 AppID 屏障和 runtime_ready=false 保留。新提交推送需具体 SHA 授权。

## 第49轮后继：退款拒绝1451

后继已接通[退款拒绝通知作者与Queue](routine-subscription-refusal-notice.md)：独立request3／staging3域绑定原申请和拒绝决定，真实Admin／Financial普通未拆单正例经A付款后切B，再由App解析原A owner及独立1451模板。发货format2、旧签名及历史事件保持原合同。Financial完整payload核对保留原版本，缺必需事件继续返回原回滚拒绝回执。

第49轮最终图新原生16＋Financial71、单元264／既有2跳过及两套类型通过；本轮旧发货兼容87是在其后唯一helper错误类型修复前通过，未冒称最终字节重跑或重复计数。来源/签名/UNKNOWN与其他渠道隔离边界见后继文档；其他作者、拆单、成团及整体迁移继续待办。


## 第50轮后继：多买家原账号成团3098

后继已接通[自然／虚拟成团通知与Queue](routine-subscription-pink-notice.md)：完整成员快照与每位目标使用独立request4／staging4，按每位买家自己的原付款、AppID+UID归属及独立3098批准发送，不把整团合为付款家族。真实A/C在当前B下分别发送，虚拟成员无目标，历史pin／缺失／赢家不升级，UNKNOWN保持。发货2／拒绝3 codec及MAC域不改。

最终图63项PG16（含新13和旧通知／退款／拼团兼容）、212项单元零跳过、两套Worker类型通过；另恢复父CI暴露的原退款拒绝ValidateException文案并由customer原生重证。旧虚拟超时41例准备失败另行保留，精确d837代表例同错；父d837远端CI已终态失败，不能以本轮定向成功阶段冒称全绿。容量／拆单的动态证明、其他事件／角色、非微信及完整归属切换与整体迁移继续待办；验证边界与失败记录见后继文档。
