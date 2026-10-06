# 手机经营用户管理验证（2026-10-04）

两个真实页面承接旧手机用户管理的八个函数、七类独立写入，本地验证完成，未发布。完整customer角色仍partial；没有生产DDL／授权、提交、推送或部署。所有当前before／absence、失败与被替代执行、真实原始副本和三端产物纳入新验收增量，最终物理核验以独立收据实际结果为准。

## Checklist与路由合同分布

实际Worker **2297／PHP1904**，本批新增16条独立UserJWT合同；旧URL可执行890／可行动缺口976，有效覆盖47.2%。API1236／ADMIN786／SUPPLIER164／KEFU70／OUT41／ERP0；Admin908缺口约93%。Uni **120页**；151旧逻辑为28直连／116兼容／7缺口，兼容62候选／54部分。

| 面 | Worker路由 | 可行动旧URL缺口 |
| --- | ---: | ---: |
| api | 1236 | 11 |
| admin | 786 | 908 |
| supplier | 164 | 49 |
| kefu | 70 | 0 |
| out | 41 | 0 |
| erp | 0 | 8 |

两条旧用户别名仍partial；完整17管理＋5代客旧页／43个admin.js及辅助合同、个人中心25/26、menuRoleGates=false仍开放。Checklist **246完成／158开放／404总项**原标题与勾选保持。下一阶段依次承接订单调价／线下支付／退款处理、独立扫码／分次核销、代客购物车到下单／支付／记录，并补齐完整角色及生产commissioning；非合作关系rawSQL最终回读→提交间隙、provider／设备／Linux/Hyperdrive／容量／发布仍开放。独立普通UserJWT新增接口不作为旧AdminJWT权限合同等价计分，URL数量也不等同未完成页面数量。

## 当前输入的实际验证

当前唯一Worker **211项**（93真实SQL：64用户＋22读链＋7成熟Admin域，另10目录并发＋108回归）、Uni **126项**（78原读／履约／商品＋48用户）、两套原标准Worker及Uni完整类型均通过。三平台 **1217文件**（H5 306／小程序 772／App 137／sibling .nvue 2）、120真实页主题宿主、6编译语义、37浏览器组及单列QA6通过；旧通过不计为本轮，原失败与原字节均保留。最终递归物理核验以独立执行收据实际结果为准。

93项原生PostgreSQL分64个普通LOGIN用户管理用例、22个保留读链、7个成熟Admin域事务回归；后者是维护fixture与明确Admin域actor，不是customer权限或AdminLOGIN／HTTP授权见证。另10个PG16目录、安装和两独立LOGIN／PID的并发fence用例，108个保留Worker回归含完整原Admin用户迁移7项。所有当前执行exit0、无skip且sourceDrift为空；前批215／78及本批被替代成功仅保留历史。

Uni126项实际执行为78原消费者＋48用户合同，原范围未收缩。完整Uni类型及H5／MP-WEIXIN／App四个标准检查真实退出0；App sibling .nvue两资源单列。临时依赖恢复原普通空目录、原锁文件与真实依赖字节。120个真实SFC均fresh parse／template compile并验证实际ThemePage默认slot宿主。

三端六个编译语义检查覆盖12个customer-work真实页和scoped API导入；当前H5浏览器37组顺序覆盖原商品20组＋用户17组，QA6单列。真实编译页使用受控synthetic HTTP，桌面／手机宽度、四个页面、七种操作、100目标边界、完整目录／隐藏选择、会员永久限制、中文提示、原UUID恢复、角色撤销和账号token/session ABA实际交互。六个精确预期丢响应、两个原有ABA取消及实际同步身份切换中的context取消分别绑定原request／实际same-XHR send-abort／UUID／hash和真实compiled auth module。受控harness额外X-QA-XHR-Observation仅用于原XHR frame与唯一实际请求ID配对，不参与身份或业务协议，不修改生产源码或body。真实dispatch时Pinia快照与中间sessionVersion→token→uid顺序保留，延迟route-time观察仅为诊断；missing／duplicate／wrong frame及console多候选fail-closed，没有URL宽泛错误白名单。截图来自当前实际H5，移动宽度／输入焦点不代替OS键盘或真机。

## 真实失败与修正

实际失败与只读审查发现的修正均保留：restricted token在PG启动前实际失败、native fixture误把Admin replay当customer grant、other_order_status实际没有id、普通关系表SELECT/I/D不允许FOR UPDATE、level no-op与完整membership status回读、request created_at秒／毫秒、append-only money journal不能UPDATE、日历生日1960合法负epoch、列表offset／rows语义及前端类型收窄。当前四处优惠券naive timestamp条件显式按UTC转换，实际两个不同LOGIN分别SET TIME ZONE UTC／Asia/Shanghai后读取候选／用户有效券数一致。

共享成熟Admin服务的unused import在完整标准类型真实exit2后仅删闲置导入，随后完整类型及最新93／108重验。中文显示lookup首次对toString／__proto__返回继承属性的实际失败见证保留；Object.hasOwn修正后同一SSR testcase增加未知码断言，wire合同未改变。原生money UPDATE／DELETE始终禁止，腐败见证改实际账户结果后验证整笔回滚，没有为测试扩大权限。

首两次浏览器实际23/37及32/37，第三、四次虽37交互组通过，仍因额外优惠券请求取消而真实exit1，均不计当前通过；原日志、pixels、端口和helpers保留。前两次按真实Uni内部input／uni-button／Picker按钮、金额规范化、model稳定及unknown modal关闭手势修正harness；一次helper生成syntax失败在浏览器启动前、业务0，也保留。第四次进一步核出真实CouponDialog watcher返回新array，使相同targetIds父级busy/receipt重绘误清搜索／分页并重读；实际SFC失败见证显示keyword清空、rows2变1、reads3变4。FE07改四scalar getters，同一126-case实组件回归及独立修前后见证确认相同目标保搜索／rows／reads，真实目标或mode变化才reload、hide清理；新fullUni tag保留旧1217产物并重新验收当前编译页，不扩大取消白名单。

原fixture集群以真实pg_ctl status3／目录可读／PID不存在／loopback拒绝／remaining0及stopped日志复核；初次另一身份status4原样保留，独立原合法上下文status3另有原收据，不修改ACL或把4解释为已停止。全部实际浏览器监听端口与postgres／workerd进程完成只读关闭检查，诊断data保留。

继承产品封存445506条哈希任务、76个历史构建目录／22296文件的完整原始输入由入批新鲜物理验证支持；本轮50个唯一owner是Root19＋BE9＋FE22，18原有／32原absence，44代码与6文档审计。目录迁移与原生test只记Root一次，不重复计owner或通过项。

[合同审计](customer-work-user-contract-audit-20261004.md)、[新验收](../audit/customer-work-users-acceptance-final-20261004.json)、[独立物理核验](../../.cache/customer-work-users-independent-verification-final-20261004.json)、[路由分布](../audit/route-distribution-customer-work-user-followup-20261004.json)、[Uni合同](../audit/uniapp-frontend-parity-customer-work-user-followup-20261004.json)。
