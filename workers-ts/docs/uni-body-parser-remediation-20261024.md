# UniApp body-parser依赖门禁修复（2026-10-24）

PR163 的 e8c76fe745400e7bda381c9cc0c3029021084f4e 在 [UniApp CI](https://github.com/cinagroup/cinashop/actions/runs/40058660438/job/120767225809) 拒绝新的 source1243073。官方 [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) / CVE-2026-111181 指向压缩正文结束后尾部字节造成的进程崩溃，1.x修复版本为1.20.9。

固定Node24.19/npm11.11的真实resolver只改变两个锁节点：body-parser1.20.6→1.20.9，并为其~6.16.0范围安装独立qs6.16.1。Express4.22.2及其root qs6.15.3保持原锁；没有新增override或直接依赖。官方元数据/SRI匹配，干净npm ci成功。初始计划预测qs6.16.0的断言失败原样保存，实际6.16.1经官方核实后使用；没有手写锁回到预测版本。

完整官方修复前后原始npm报告在[机器审计](../audit/uni-body-parser-remediation-20261024.json)中。新基线为50个包条目（9low/11moderate/30high）、26个直接source对象/25个不同URL、8个scope定义/7个活跃scope，14个禁止重现来源。仅body-parser退出已接受的forward图；其余严重性、节点、直接元组和forward边全相同。3个旧条目及qs的reverse effects漂移完整另列，原门禁已将其区别于授权图；门禁实现没有改变。source1243073只记patched，重现仍拒绝，未放入允许清单。Express自身qs的两项moderate保留审查，普通H5继续禁用SSR；这些图计数不是独立漏洞数或完整安全承诺。

旧51基线完整30922字节归档，SHA5b82bc7222590c0904d7091981640bf559aa6dc625df27ef4eb545493d7eebc2，并固定LF。原77→51/52问题/26消失/6严重性变化的历史测试绑定该不可变旧图；既有历史审计不改写。旧全部否定场景保留，新增当前graph/source精确保持、新high重现、body-parser回退、错误qs版本及额外脆弱嵌套node负例。

真实createRequire证明body-parser拥有nested qs6.16.1，而Express仍解析root6.15.3。新增13个独立child HTTP定义：JSON/urlencoded×gzip/deflate的正常/延迟尾部raw消费者/延迟尾部无其他消费者，以及不支持charset。每次body小于2KB，临时loopback端口、有child与socket时限，核完整原始SHA/长度、请求完成、100ms后health204；不在旧版运行崩溃PoC，不装uncaught处理器掩盖错误，原SSR/defer/cache/query/trust断言保持。

本轮13个真实Uni CI步骤全部exit0，完整类型、工具链测试、D3 offline/live、三个构建与公共toolchain检查通过。Node测试明确单并发，重型命令只用一层共享锁。

```text
test:toolchain: ℹ tests 2406; ℹ pass 2406; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 851903.04031
test:admzip: ℹ tests 6; ℹ pass 6; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 331.397562
test:express-qs: ℹ tests 20; ℹ pass 20; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 4362.375213
test:jest-jsdom-once: ℹ tests 4; ℹ pass 4; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 1255.240201
test:d3-advisories: ℹ tests 34; ℹ pass 34; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 4586.311688
test:build-artifacts: ℹ tests 4; ℹ pass 4; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 106.4865
test:automator-qr: ℹ tests 5; ℹ pass 5; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 618.222252
test:runtime-i18n: ℹ tests 13; ℹ pass 13; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 70177.058075
shared-toolchain-security: ℹ tests 14; ℹ pass 14; ℹ fail 0; ℹ cancelled 0; ℹ skipped 0; ℹ todo 0; ℹ duration_ms 621.438225
```

首轮把--test-concurrency放进NODE_OPTIONS而被Node拒绝，typecheck实际exit9；下一轮人工collector600秒上限在1550个pass标记后提前终止，未取得完整toolchain终态。两次失败原收据保留。最终不再增加该总时限，仍保留各原测试自身时限。干净安装后首个typecheck仅重建生成Vue声明31532→31533，那个失败区间不宣称安装定义零漂移；最终全链与随后Browser各自有完整源/安装定义零漂移闭包。

最终后台IAB2真实复验microH5/finished两个只读检查点，当前依赖、新构建和新全源闭包，0GUI保存/0业务POST。旧归档三次GUI保存只作为精确两行25列fixture seed的历史来源；本次不重计旧25阶段/3次保存，也不声称新旧全数据库、时间或随机票据相同。真实PG16/Worker/R2在本次全部GET前后核76表/71序列/资源无写入，其他chrome响应仍明确synthetic。临时库清零、PG status3/noPID，server关闭。普通MP/App仅构建验证，不冒称真机/生产。

独立审查覆盖Root编写的锁/基线/新增D3部分和原树保护；审查者自己编写的历史绑定与parser测试由Root读diff，未冒称独立自审。统计脚本兼容及三端loader、所有业务页面源、生产schema/ACL与其他五锁保持。整体迁移及17个剩余作者正文族继续开放；本轮仅draft PR，不合并或部署。新head远端CI在推送后另核，本地通过不等同远端全绿。

浏览器首轮before-ready因旧锁rawSHA比较停止，0页面阶段，原child/outer1及PG清理完整保留。随后仅在Worker Browser harness/新固定fixture增加显式opt-in两node转换，旧全部断言逐字保留；当前锁逐字逆向重构旧426733bytes，历史expected仅那一行旧SHA转新SHA，其他源码及659产物仍全部比较。该两测试路径位于完整Uni验证之后：其余6148源及31533安装定义保持，新的Worker-unit/Browser-config strict与实际Browser重验通过；分别记录Uni6149源与Browser6150源，不能称两轮整树相等。本轮9个测试命令共2506条具名pass，保留重复名字/重复安全套件，不是2506个新增独立定义；新增独立定义为13解析器+1历史归档+5 D3=19。当前Browser控制台0error、1条既有VueRouter直接esm导入弃用警告，截图与终态/关tab证据在机器审计。
