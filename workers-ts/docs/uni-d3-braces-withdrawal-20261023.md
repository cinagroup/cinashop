# UniApp braces 撤回：2026-10-23

PR160 的 `8bbee7c9cb6f71ff6bf3dd08b2530d7cc735d3e5` 在 [run39998594954](https://github.com/cinagroup/cinashop/actions/runs/39998594954) 的 UniApp D3 门禁失败；原失败不改写。[GitHub 官方](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 在2026-10-23T12:53:02Z撤回该公告。此次只纠正已审查清单，没有修改 gate 实现、依赖、锁、应用源码或生产 schema。

[机器审计](../audit/uni-d3-braces-withdrawal-20261023.json)冻结官方收据、旧图和差异：仅删1240992的独立固定点恰好解释26消失包和25保留图变化；余26 direct tuples、51节点不变；六个Jest从high降到仅余1119438的low，其他严重性不变。新清单51包=9low/12moderate/30high，26 direct objects/25URLs；8定义、7活跃scope。npm图计数不是独立漏洞或应用可利用性计数。公告撤回不等于依赖修复或可选运行方式完整安全。

保留原12个场景，新增3个撤回/图传播/严重性场景。旧77条整个对象可精确逆构造并重现原52个门禁问题，撤回source和全部26消失包重现仍拒绝。所有13个resolved/withdrawn ID、新公告/节点/前向边仍fail closed；旧sprintf-js反例保留。

## 真实本地执行

使用共享串行锁；完整92文件的toolchain仅单worker执行。全部14个实际子进程exit0，Node测试fail/skip/cancel/todo均0：

| 命令 | 测试项 | 子进程exit |
| --- | ---: | ---: |
| D3-offline-and-live | 28 | 0 |
| D3-live | command | 0 |
| Uni-typecheck | command | 0 |
| Uni-complete-toolchain | 2406 | 0 |
| encrypted-zip | 6 | 0 |
| SSR-boundary | 7 | 0 |
| Jest-boundary | 4 | 0 |
| H5-resource-build | command | 0 |
| Weixin-resource-build | command | 0 |
| App-resource-build | command | 0 |
| resource-artifact-check | 4 | 0 |
| automator-QR-boundary | 5 | 0 |
| independent-runtime-graphs | 13 | 0 |
| Uni-common-security | 14 | 0 |

原收尾脚本在以上14个检查全部完成后误调用不存在的`delta`，其outer真实exit1及原始堆栈保留。它未将初始全量snapshot写盘，故不声称原完整区间的source/installed前后已证零漂移。轻量恢复collector只核对原14个START/END、各原始日志与零跳过汇总，不把原outer改成0。实际sidecar在初始D3/typecheck后采样，至末尾仅两处描述文本变化（审计官方描述改为转述、文档验证链接），31521依赖零变化；不能把这个起点倒填为原链起点。

最终另用一次真实新鲜快照执行完整D3相关28项、原始npm报告及live报告，outer0，6070份源文件/31521依赖前后零漂移。重复执行不累计独立新例。Local Node24.19.0/npm11.11.0；CI固定Node24.14.1，环境区别保留。

实际收据：recovered `4aa08fe568d4ce06bcb191c76169523d0784bfb4f6d310fcaf71eae0d5a7ee84`；final-D3 `bf8ae195923d5210109d15d954730c5167f8c019fe329d318dd496fffb805e50`；独立上游review `36627131c2d6641e6a097f1b3f120924948b97f8db4ed64d5abeb25746b163c9`；独立patch review `7b34a309e10b7a5badd0bde33c0066b1dbdacb44d4a420c094bb083cf8338643`。全部原始本地收据保留在`/tmp/cinashop-PR160-braces-*`；GitHub新head结果另核。

## 浏览器与范围

此增量没有UI/应用源变更。先前真实后台IAB的14点、两次Admin可见GUI保存已验收；本次全部2477份Browser捕获输入、31521依赖和重建后的658份实际H5/Admin产物仍逐字节相同，沿用原结果，未冒充新Browser轮次。原视频结束后离页观察、未实际发出无签名私有asset GET的边界不提升。浏览器验收继续后台进行，不逐页请求确认。

三份根账本旧前缀/旧JSON键与历史审计保持；恢复的get_script及三端loader保持。TEST-004D3、完整导航作者编辑器、真机/生产及整体迁移仍开放。仅推送原draft PR160，不合并部署。新head CI在推送后核实，尚不宣称全绿。
