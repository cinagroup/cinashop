# 普通商品取消夹具与计价锁回归 V13

845 完整 CI 的唯一业务失败发生在取消用例的 checkout 建数阶段，尚未进入数量破坏或取消断言。这里只在原 unpaid mixed-order 文件的 checkout(r) 夹具增加维护连接的兼容 SHARE 锁；真实独立受限 LOGIN 仍调用原 production NOWAIT 锁函数并重读计价来源。精确函数调用被观察且原对象与 PG 返回值保持传递，维护锁在所有订单读取、证据破坏和取消断言之前提交。未增加权限、重试或原超时，未证明原失败的真实锁持有者。

本轮基于 845b33e7f8a2ca3f25fa1220e904a2e93c188596 的冻结候选通过两套完整类型检查及四个原生完整文件：81 用例通过，0 失败、0 跳过。各文件：test/unpaid-mixed-order-cancellation-postgres.test.ts 22；test/checkout-pricing-service-runtime.test.ts 15；test/refund-runtime-permissions.test.ts 10；test/purchase-cancellation-evidence-postgres.test.ts 34。原 600s runner、3000ms/30000ms 受限连接与 45000ms case/hook 预算保持；实际 Vitest Duration 588.69s。PostgreSQL 16.15 (160015) 私有端口 56783，fixtures=0、runnerStopped、独立 pg_ctl status=3。

完整源码 3889（Workers 2840）+14 辅助原始输入，原工具 43992+正常 postinstall Worker 7639 文件、15 安装输入、4物理根/1037别名/4复制文件、17额外固定工具，全部前后与 final AND 核验通过。源码 manifest SHA 36894ef217c0b4707efb7c5aa95e011429cfb0692d4dbdca25b19a2460f58657；tool seal SHA 063bdc49a1eb715e5d9b8439a003ce92cb1b1bffbe765822e14f822ac15ae080。独立 ignored 原始归档 42 文件/2337826 字节，完整原 C 快照及物理工具继续保留。

原 845 CI run38365030240 仍为 failure：11 jobs 中 9成功/2失败，973文件/16162用例/1失败。原全部日志 97593951 字节、API 与官方 artifact ZIP 已保存；487+486 文件原始 JSON 的独立无重叠覆盖核验不改变失败结论。真实错误为 ValidateException 计价配置更新提示（应用 code400）；原 raw 未记录 PgError code，源码55P03映射只作为推论，未伪造数据库错误码或锁来源。

修正 V12 JSON 中 Browser 的历史摘要：工具版本13、实际2个 viewport（desktop 1280×900 与 mobile 390×844，各7动作）、Chromium154.0.8037.98。错误旧 JSON 完整留在 ignored before 归档。旧 C8 浏览器与 V12 251 用例仅为原范围历史；本轮未复跑 UI、完整 CI 或原五文件111用例。

生产能力仍未 commissioned 且 closed；16条内部路由、原 UUID/永久放弃协议、manual SQL/pins/startup 均未改。无生产DDL、部署、提交或推送。后续新提交及完整CI由主线程执行。
