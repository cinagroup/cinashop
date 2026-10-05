# 普通 customer 手机订单财务验证（2026-10-05）

本地代码和分层测试已验证，未发布、未应用生产DDL或授权。最终递归 raw/LF、全部历史输入与产物及清理的完整验收，以后续独立最终 proof 收据为准；本文不预写其通过、hash总量或端口数量。

历史退款原因／说明和备注按原长度合同读取TAB/LF/CR，保留原字节并局部换行显示；其它控制字符、孤立代理项及所有新写入和电话／快递标识仍受原严格校验。普通 UserJWT 当前唯一有效 customer 服务记录承接订单调价、线下收款、退款申请、同意退货、拒绝退款、资金退款和退款备注七类。四个既有订单/售后页追加操作，一个新主动退款页承接旧入口；旧手机角色及别名继续部分替换。

当前 Worker 唯一 991 项：金融主文件 70、五组21个完整成熟 SQL 文件 583、独立目录 16、12个完整普通回归文件 322。各值从真实 stdout 计数，失败、跳过及旧执行不计入。Uni runtime 177 项、原标准窄类型与完整类型及 H5/微信/App 五 CLI 全部退出0；三平台 1237 文件包含 sibling .nvue；121真实主题宿主／13个customer-work页，10编译语义、62实际编译浏览器组与单列QA6通过。两套原标准 Worker 类型使用显式最终计划绑定的实际完整执行。

| 原生完整组 | 文件 | 通过项 | 证据 |
| --- | ---: | ---: | --- |
| customer | 1 | 70 | [真实执行](../../.cache/customer-work-financial-native-customer-run10-20261005/execution.json) |
| core | 6 | 247 | [真实执行](../../.cache/customer-work-financial-mature-core-run05-20261005/execution.json) |
| authority | 6 | 101 | [真实执行](../../.cache/customer-work-financial-mature-authority-run03-20261005/execution.json) |
| quota-presale | 5 | 170 | [真实执行](../../.cache/customer-work-financial-mature-quota-presale-run04-20261005/execution.json) |
| paid-identity | 2 | 17 | [真实执行](../../.cache/customer-work-financial-mature-paid-identity-run03-20261005/execution.json) |
| pricing-scope | 2 | 48 | [真实执行](../../.cache/customer-work-financial-mature-pricing-scope-run03-20261005/execution.json) |

原两条 CLI 实际输出：Worker 2309／旧 PHP 1904，旧 URL 可执行精确匹配 890／可行动缺口 976，有效覆盖 47.2%。Uni 121实际页；151旧逻辑路由为28直连／116兼容／7缺口，兼容62候选／54部分。

63个声明 owner 为 Root25／Backend19／Frontend19；37份真实原有源码/文档副本与26个原始缺失均由显式最新原始 before 收据核定。最终38个 BE/FE源和19个Root源按本轮实际冻结及最终主执行输入核对；原始标题、404项复选行和历史正文保留。[最终后端 producer](../../.cache/customer-work-financial-backend-producer01-20261005.json)、[最终前端 producer](../../.cache/customer-work-financial-fe-producer02-20261005.json)、[金融主执行](../../.cache/customer-work-financial-native-customer-run10-20261005/execution.json)、[原始63-owner独立审查](../../.cache/customer-work-financial-owner-baseline63-independent-20261005.json)、[实际路由分布](../audit/route-distribution-customer-work-financial-followup-20261005.json)、[实际Uni分布](../audit/uniapp-frontend-parity-customer-work-financial-followup-20261005.json)。

原失败和被替代尝试保留原字节，以下记录均为历史，不增加当前通过数。仅准备、未启动的 browser02 不计失败或清理。

| 历史执行 | 实际状态 | 实际计数或边界 | 证据 |
| --- | --- | --- | --- |
| mature-authority run01 | 历史通过，已被最终输入替代；exit 0 | 101通过／0失败／0跳过，共101项 | [原收据](../../.cache/customer-work-financial-mature-authority-run01-20261005/execution.json) |
| mature-authority run02 | 历史通过，已被最终输入替代；exit 0 | 101通过／0失败／0跳过，共101项 | [原收据](../../.cache/customer-work-financial-mature-authority-run02-20261005/execution.json) |
| mature-core run01 | 失败或未验收；exit 1 | 228通过／19失败／0跳过，共247项 | [原收据](../../.cache/customer-work-financial-mature-core-run01-20261005/execution.json) |
| mature-core run02 | 失败或未验收；exit 1 | 229通过／18失败／0跳过，共247项 | [原收据](../../.cache/customer-work-financial-mature-core-run02-20261005/execution.json) |
| mature-core run03 | 历史通过，已被最终输入替代；exit 0 | 247通过／0失败／0跳过，共247项 | [原收据](../../.cache/customer-work-financial-mature-core-run03-20261005/execution.json) |
| mature-core run04 | 历史通过，已被最终输入替代；exit 0 | 247通过／0失败／0跳过，共247项 | [原收据](../../.cache/customer-work-financial-mature-core-run04-20261005/execution.json) |
| mature-paid-identity run01 | 失败或未验收；exit 1 | 7通过／10失败／0跳过，共17项 | [原收据](../../.cache/customer-work-financial-mature-paid-identity-run01-20261005/execution.json) |
| mature-paid-identity run02 | 历史通过，已被最终输入替代；exit 0 | 17通过／0失败／0跳过，共17项 | [原收据](../../.cache/customer-work-financial-mature-paid-identity-run02-20261005/execution.json) |
| mature-pricing-scope run01 | 失败或未验收；exit 1 | 46通过／2失败／0跳过，共48项 | [原收据](../../.cache/customer-work-financial-mature-pricing-scope-run01-20261005/execution.json) |
| mature-pricing-scope run02 | 历史通过，已被最终输入替代；exit 0 | 48通过／0失败／0跳过，共48项 | [原收据](../../.cache/customer-work-financial-mature-pricing-scope-run02-20261005/execution.json) |
| mature-quota-presale run01 | 失败或未验收；exit 1 | 166通过／4失败／0跳过，共170项 | [原收据](../../.cache/customer-work-financial-mature-quota-presale-run01-20261005/execution.json) |
| mature-quota-presale run02 | 历史通过，已被最终输入替代；exit 0 | 170通过／0失败／0跳过，共170项 | [原收据](../../.cache/customer-work-financial-mature-quota-presale-run02-20261005/execution.json) |
| mature-quota-presale run03 | 历史通过，已被最终输入替代；exit 0 | 170通过／0失败／0跳过，共170项 | [原收据](../../.cache/customer-work-financial-mature-quota-presale-run03-20261005/execution.json) |
| 金融 main01 | 失败或未验收；exit 1 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-native-customer-run01-20261005/execution.json) |
| 金融 main02 | 失败或未验收；exit 1 | 0通过／0失败／46跳过，共46项 | [原收据](../../.cache/customer-work-financial-native-customer-run02-20261005/execution.json) |
| 金融 main03 | 失败或未验收；exit 1 | 10通过／55失败／0跳过，共65项 | [原收据](../../.cache/customer-work-financial-native-customer-run03-20261005/execution.json) |
| 金融 main04 | 失败或未验收；exit 1 | 63通过／5失败／0跳过，共68项 | [原收据](../../.cache/customer-work-financial-native-customer-run04-20261005/execution.json) |
| 金融 main05 | 失败或未验收；exit 1 | 67通过／1失败／0跳过，共68项 | [原收据](../../.cache/customer-work-financial-native-customer-run05-20261005/execution.json) |
| 金融 main06 | 历史通过，已被最终输入替代；exit 0 | 70通过／0失败／0跳过，共70项 | [原收据](../../.cache/customer-work-financial-native-customer-run06-20261005/execution.json) |
| 金融 main07 | 失败或未验收；exit 1 | 0通过／0失败／70跳过，共70项 | [原收据](../../.cache/customer-work-financial-native-customer-run07-20261005/execution.json) |
| 金融 main08 | 历史通过，已被最终输入替代；exit 0 | 70通过／0失败／0跳过，共70项 | [原收据](../../.cache/customer-work-financial-native-customer-run08-20261005/execution.json) |
| 金融 main09 | 历史通过，已被最终输入替代；exit 0 | 70通过／0失败／0跳过，共70项 | [原收据](../../.cache/customer-work-financial-native-customer-run09-20261005/execution.json) |
| Worker runtime types02 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-runtime-run02-20261005.execution.json) |
| Worker runtime types03 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-runtime-run03-20261005.execution.json) |
| Worker runtime types04 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-runtime-run04-20261005.execution.json) |
| Worker unit types01 | 失败或未验收；exit 2 | 8个真实 TypeScript 诊断 | [原收据](../../.cache/customer-work-financial-types-unit-run01-20261005.execution.json) |
| Worker unit types02 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-unit-run02-20261005.execution.json) |
| Worker unit types03 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-unit-run03-20261005.execution.json) |
| Worker unit types04 | 历史通过，已被最终输入替代；exit 0 | 未产生明确完整业务汇总 | [原收据](../../.cache/customer-work-financial-types-unit-run04-20261005.execution.json) |
| FE runtime01 | 失败或未验收；exit 0 | {"tests":null,"pass":null,"fail":null,"skipped":null,"cancelled":null} | [原收据](../../.cache/customer-work-financial-runtime01-20261005/execution.json) |
| FE build01 | 失败或未验收；exit 未记录 | 原标准窄配置未通过；不能计为当前通过 | [原收据](../../.cache/customer-work-financial-fe-build01-20261005/result.json) |
| FE runtime03 | 失败或未验收；exit 1 | {"tests":174,"pass":173,"fail":1,"skipped":0,"cancelled":0} | [原收据](../../.cache/customer-work-financial-runtime03-20261005/execution.json) |
| FE browser01 | 失败或未验收；exit 1 | {"groups":60,"pass":47,"failed":["financial order list zero price immutable target and busy scalar draft preservation","financial offline cash confirmation uses actual native checkbox and exact empty payload","financial balance receipt with current UNKNOWN settlement cannot acknowledge or claim funds","financial provider FAILED CLOSED ABNORMAL retain admission and forbid false close or abandon","financial quantity quote invalidation low amount create and distinct durable execute phase","financial before commit transport requires original GET and exact same key body restore","financial no receipt abandonment fences original UUID nested intent and clears qualified PII","financial lost create response reload reads original application receipt without duplicate phase","financial malformed receipt hash and unverified provider SUCCESS preserve key without closing funds","financial role loss original owner minimal receipt and current quote403 clear PII catalog and drafts","financial modal storage replacement stops original recovery POST and hide drops drafts","financial read quote write account ABA use latest compiled auth and same XHR cancellation bindings","financial route conflicts and paired desktop mobile actual native fields extend QA six"],"QA":6,"QApassed":6} | [原收据](../../.cache/customer-work-financial-browser01-20261005-run01/execution.json) |
| FE browser03-20261005-run02 | 历史通过，已被最终输入替代；exit 0 | 60/60浏览器组；QA6/6 | [原收据](../../.cache/customer-work-financial-browser03-20261005-run02/execution.json) |
| FE browser06-20261005-run01 | 失败或未验收；exit 1 | 60/62浏览器组；QA5/6 | [原收据](../../.cache/customer-work-financial-browser06-20261005-run01/execution.json) |
| FE compiledsemantic01-20261005-run01 | 历史通过，已被最终输入替代；exit 0 | 9/9原检查；0产物 | [原收据](../../.cache/customer-work-financial-compiledsemantic01-20261005-run01/execution.json) |
| FE compiledsemantic02-20261005-run01 | 历史通过，已被最终输入替代；exit 0 | 9/9原检查；0产物 | [原收据](../../.cache/customer-work-financial-compiledsemantic02-20261005-run01/execution.json) |
| FE compiledsemantic03-20261005-run01 | 失败或未验收；exit 1 | 9/10原检查；0产物 | [原收据](../../.cache/customer-work-financial-compiledsemantic03-20261005-run01/execution.json) |
| FE fe-build02 | 历史通过，已被最终输入替代；exit 未记录 | 5/5原检查；1236产物 | [原收据](../../.cache/customer-work-financial-fe-build02-20261005/result.json) |
| FE fe-build03 | 历史通过，已被最终输入替代；exit 未记录 | 5/5原检查；1236产物 | [原收据](../../.cache/customer-work-financial-fe-build03-20261005/result.json) |
| FE runtime02 | 历史通过，已被最终输入替代；exit 0 | {"tests":169,"pass":169,"fail":0,"skipped":0,"cancelled":0} | [原收据](../../.cache/customer-work-financial-runtime02-20261005/execution.json) |
| FE runtime04 | 历史通过，已被最终输入替代；exit 0 | {"tests":174,"pass":174,"fail":0,"skipped":0,"cancelled":0} | [原收据](../../.cache/customer-work-financial-runtime04-20261005/execution.json) |
| FE runtime05 | 失败或未验收；exit 1 | {"tests":177,"pass":176,"fail":1,"skipped":0,"cancelled":0} | [原收据](../../.cache/customer-work-financial-runtime05-20261005/execution.json) |
| FE runtime06 | 失败或未验收；exit 1 | {"tests":177,"pass":176,"fail":1,"skipped":0,"cancelled":0} | [原收据](../../.cache/customer-work-financial-runtime06-20261005/execution.json) |
| FE preparedBrowser04 | 仅准备，未启动；exit 未记录 | 不计业务失败、当前通过或端口关闭信用 | [原收据](../../.cache/customer-work-financial-browser-profile04-prepared-20261005.json) |
| FE preparedBrowser05 | 仅准备，未启动；exit 未记录 | 不计业务失败、当前通过或端口关闭信用 | [原收据](../../.cache/customer-work-financial-browser-profile05-prepared-20261005.json) |
| FE preparedBrowser07 | 仅准备，未启动；exit 未记录 | 不计业务失败、当前通过或端口关闭信用 | [原收据](../../.cache/customer-work-financial-browser-profile07-prepared-20261005.json) |

创建申请和执行资金是两个明确持久步骤，各有原UUID和完整意图。GET状态只读SQL；显式同原UUID执行POST仅查询并协调已接纳的原渠道请求。当前403清空私密域，迟到ABA及同身份reload旧回调不能影响新域。浏览器为实际编译H5与受控HTTP，微信/App为编译验证，不代表真实渠道或设备。

独立普通 customer 扫码、分次核销与核销记录；五个代客页的购物车、下单、支付与记录；完整手机角色、个人中心25/26及 menuRoleGates=false；生产模式与授权、真实 provider/设备、Linux/Hyperdrive、容量和发布仍开放。店长、配送、客服等独立资格不能推导全站 customer。

Checklist维持 **404总项／246完成／158开放**，原标题与复选行不变。
