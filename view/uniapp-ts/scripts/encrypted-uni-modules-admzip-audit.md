# Encrypted `uni_modules` ZIP boundary audit

Scope: the locked `@dcloudio/uni-cli-shared` `3.0.0-4020920240930001` and its `adm-zip` `0.5.18` dependency in this repository's UniApp build. This audit does not enable UniApp X, cloud compilation, or a paid plug-in.

## Current reachability

The actual DCloud plug-in calls `checkEncryptUniModules` only when `UNI_APP_X === 'true'` and the compile target is not `uni_modules`. The helper discovers plug-ins under `src/uni_modules/<id>/encrypt` without `utssdk`; it returns before cloud upload when that set is empty, and also returns without downloading when HBuilderX plug-ins are unavailable. Only the later cloud download branch calls `new AdmZip(downloadFile).extractAllTo(cacheDir, true)`.

This repository currently has no `src/uni_modules` directory. The real DCloud discovery helper returns `{}` for this source tree. The test also invokes the real DCloud Vite plug-in with a stubbed cloud helper: ordinary UniApp mode does not call it; a synthetic UniApp X mode does. No provider helper, HBuilderX login, download, or remote ZIP is invoked by the test. The present project path is **unreachable**.

## Isolated dependency behavior

`npm run test:admzip` constructs raw ZIP entries by replacing both local and central header names after archive creation. This prevents `addFile` from silently normalizing the adversarial names before extraction. Every destination is inside a disposable local test root. `../`, backslash traversal, nested traversal, and a drive-qualified absolute name did not write outside the extraction cache; the drive-qualified name can instead reject extraction on Windows. ZIP metadata marking a symlink extracted as an ordinary file. These are **observed protections for these inputs**, not a proof about every possible ZIP representation.

A separately created directory link already inside the cache was followed by `extractAllTo`, writing to a sibling directory inside the same disposable test root. That cache link is a **separate trust boundary**; the current repository does not reach the cloud download branch and the test does not establish an attacker-controlled cache link in deployment. If an encrypted module or UniApp X build is introduced, review cache ownership and extraction into a fresh, link-free staging directory before enabling the cloud flow. The CI test intentionally fails as soon as DCloud discovery finds an encrypted module or the audited package versions change.

Linux CI runs this audit alongside UniApp typecheck, the full toolchain suite, H5/MP/App resource builds, artifact checks, and the independent runtime Intlify audit. The parent TEST-004D3 also covers other dependency chains and remains open. This scoped audit does not change the lockfile, deployment, or checklist count.
