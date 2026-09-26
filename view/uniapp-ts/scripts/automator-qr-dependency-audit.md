# Weixin automator QR dependency boundary

Scope: the locked DCloud `3.0.0-4020920240930001` CLI/automator pair, `jimp` `0.10.3`, `@jimp/jpeg` `0.10.3`, `jpeg-js` `0.3.7`, and the `@jimp/core` `0.10.3` dependency on `phin` `2.9.3`. `load-bmfont` also installs `phin` `3.7.1`. This audit does not change those packages.

## Current reachability

The optional `@dcloudio/uni-automator` `Program.remote()` calls the Weixin `Tool.enableRemoteDebug` adapter. Only when Weixin DevTools returns a nonempty base64 QR image does that adapter pass a `Buffer` to `jimp.read`, then pass its bitmap to `qrcode-reader`. JPEG input reaches `@jimp/jpeg` and `jpeg-js`; PNG input uses Jimp's PNG decoder. The decoded URL is printed as a terminal QR by `qrcode-terminal`; the adapter does not fetch that URL.

The current application and test scripts do not call `Program.remote()` or import the automator API. Ordinary `uni build` does not set the automator WebSocket endpoint without automation host/port options. The real H5/Weixin/App CLI runtime graph audit and built resource scan find no Node-only automator QR modules. App resources still include DCloud's copied `__uniappautomator.js`; its presence alone does not invoke the Node image decoder. This is a **developer-tool-only, opt-in path** in the current project, not an observed business or device runtime path. The exact installed modules are still present in `node_modules`.

`@jimp/core/dist/request.js` calls `phin` for URL image input. This adapter passes bytes in a `Buffer`, so it uses Jimp's buffer decode branch and does not call that URL loader. The in-memory PNG/JPEG test blocks Node HTTP/HTTPS requests while invoking the actual adapter. It proves no request in those two cases, not that all Jimp APIs are network-free.

## Known malformed-image failure

The locked Weixin adapter wraps an `await jimp.read(...)` in an `async` Promise executor. A malformed QR image rejects that inner async function without settling the outer Promise. With Node `24.14.1`, the isolated reproduction exits `1` on an unhandled rejection. A caller's `.catch()` does not contain this failure. No current first-party caller can validate the Weixin DevTools response before it reaches the adapter. A DCloud-compatible package upgrade or a carefully maintained upstream adapter fix is required before enabling this remote-debug path with untrusted image data. The green CI test deliberately does not enshrine the crash as expected behavior.

From `view/uniapp-ts`, reproduce the failure without network or credentials:

```sh
node -e 'const a=require("@dcloudio/uni-mp-weixin/lib/uni.automator.js").adapter["Tool.enableRemoteDebug"]; a.reflect(async()=>({qrCode:Buffer.from("invalid image").toString("base64")}),{}).catch(console.error)'
```

Run `npm run build:h5 && npm run build:mp-weixin && npm run build:app && npm run test:automator-qr && npm run test:runtime-i18n` for the scoped guard. CI runs it after `npm ci`, the existing toolchain and encrypted-module audit, and before completing the runtime graph gate. Adding an automator consumer, changing locked versions or the adapter entrypoint, or bundling this Node-only chain fails the corresponding guard and requires a fresh review. A green audit means only that the **current source and these build targets** keep this optional path out of app runtime; it does not fix the locked decoder or assess HBuilderX, native baselines, other mini-program targets, or future remote-debug usage. TEST-004D3 remains open for its other dependency chains.
