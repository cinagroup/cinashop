# Worker 测试依赖 Vitest 4.1.12（2026-10-22）

父提交 `215021abc04c520cbf56736ccb7f675e61cc6303` 的 GitHub Actions run `39715473782`，Worker shard 1 在 `mocker-security-patch.test.ts` 失败：实际安装4.1.11，已有跨包安全守卫要求4.1.12。该分片643/644文件、12388/12389项通过，正常退出失败；不是网络超时。另一个分片通过。UniApp和Kefu的在线审计网络失败另行记录，不与此混同。

本次将 Worker `vitest` 精确固定为4.1.12，锁文件只改变根开发依赖及八个官方 Vitest／@vitest 包。Vite8.2.1、Cloudflare插件1.1.7、rolldown1.2.3、Drizzle及全部生产依赖保持。Cloudflare插件现有 `^4.1.0` peer 范围允许该补丁版本。Worker入口同时执行两份已有 shared 守卫，覆盖版本、redirect admission、manual mock生成代码与Windows路径归一化；没有降低版本断言或增加重复用例计数。

官方修复包括生成模块URL和export名称的字符串序列化，以及在路径拼接、允许范围判断前规范化反斜杠。原4.1.11仅含更早的redirect修复，仍在两项新advisory的受影响范围：[GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8)、[GHSA-xp26-3454-mjgp](https://github.com/vitest-dev/vitest/security/advisories/GHSA-xp26-3454-mjgp)。这是开发／测试依赖修复，未证明生产Worker存在同等暴露。

## 已完成验证

- 实际 Node24.19.0／npm11.11.0执行 `npm ci` 成功，registry dist SRI、源码锁和安装锁一致。
- 同十项真实守卫在原4.1.11为5通过／5失败，在4.1.12为10/10通过。实际Worker Vitest入口1/1通过；入口与重复执行不叠加独立用例数。
- 直接调用已安装公开插件回调并执行生成的模块，保留普通mock与合法redirect正例；Linux模拟Windows分隔符，不冒称Windows真机文件泄漏复现。
- 所监测生产源码、无关依赖和类型声明字节未变。首轮npm解析扩散到无关版本，被最小差异守卫拒绝；失败候选与最终精确八包锁分开保留。

先前完整Worker／native结果使用4.1.11，不作为本次新安装的完整回归结果。当前完整迁移分片回归另行补验，GitHub使用Node24.14.1，精确新提交CI结果以Actions为准。此提交不合并、不部署。

## 证据身份

- `result.json` SHA256 `a980c33cba4eeff1b41342eae27527960c73bc72835491381ae3c16b60c41053`，本机路径 `/tmp/cinashop-worker-vitest-4112-security/result.json`。
- `handoff.json` SHA256 `5834c0f122745db00e21dda8d36631b3af356e08e5993cc9f7f37bb511243922`，本机路径 `/tmp/cinashop-worker-vitest-4112-security/handoff.json`。
- `lock-diff.json` SHA256 `7034ab844ed9bedb451527a6d985c8c6f9ed8dbfd4ede3de305392baa6ab1d9e`，本机路径 `/tmp/cinashop-worker-vitest-4112-security/lock-diff.json`。
- install4112：exit0，日志SHA256 `c466abdbeee9dbca26ab60bb9b73bfd2d1c7608ff6d50af933dfa167d3ff6122`。
- new4112-security-semantic：exit0，日志SHA256 `da23d7372ae65bbac364e39f1568e8cb39585d97a5630fe15d5e75303e1e83d0`。
- worker-security-wrapper：exit0，日志SHA256 `0d654afeda6b86357bc2f6d9f83e7594b53c567d6faffb3528404177e1d48902`。
