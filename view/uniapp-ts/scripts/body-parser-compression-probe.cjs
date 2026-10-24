"use strict";

// Isolated, bounded HTTP regression for the official 1.x fix:
// https://github.com/expressjs/body-parser/commit/1260c3845f54502a05a87594f09a334786bb34d7
// No exception/rejection handler is installed to mask a decoder process crash.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const http = require("node:http");
const { Writable } = require("node:stream");
const { gzipSync, deflateSync } = require("node:zlib");

async function probe() {
  const [kind, encoding, mode, consumer] = process.argv.slice(2);
  assert.ok(["json", "urlencoded"].includes(kind));
  assert.ok(["gzip", "deflate"].includes(encoding));
  assert.ok(["normal", "trailing", "charset"].includes(mode));
  assert.ok(["raw", "none"].includes(consumer));
  assert.ok(consumer === "raw" || mode === "trailing");
  if (mode === "charset") assert.deepEqual([kind, encoding, consumer], ["json", "gzip", "raw"]);

  // Refuse to run the request probe against the old vulnerable installation.
  // The parent needs a fresh locked install; no old-version crash PoC is run.
  assert.equal(require("body-parser/package.json").version, "1.20.9");
  const bodyParser = require("body-parser");
  const payload = Buffer.from(kind === "json" ? '{"a":1,"item":{"id":"42"},"word":"safe"}' : "a=1&item%5Bid%5D=42&word=safe");
  const expectedBody = { a: kind === "json" ? 1 : "1", item: { id: "42" }, word: "safe" };
  const compressed = (encoding === "gzip" ? gzipSync : deflateSync)(payload);
  const first = mode === "normal" ? compressed : Buffer.concat([compressed, Buffer.from([0])]);
  const tail = mode === "normal" ? Buffer.alloc(0) : Buffer.alloc(128, 0x58);
  const wire = Buffer.concat([first, tail]);
  assert.ok(payload.length < 1024 && wire.length < 2048);
  const expectedRaw = createHash("sha256").update(wire).digest("hex");
  const events = [];
  let verifyCalls = 0, tailSent = mode !== "trailing", client, healthClient, timer;
  const delayed = new Set(), sockets = new Set();
  let resolveServer, rejectServer;
  const serverResult = new Promise((yes, no) => { resolveServer = yes; rejectServer = no; });
  serverResult.catch(() => {});
  const verify = (_req, _res, buffer) => { verifyCalls++; assert.deepEqual(buffer, payload); };
  const parser = kind === "json" ? bodyParser.json({ limit: 1024, verify })
    : bodyParser.urlencoded({ extended: true, limit: 1024, parameterLimit: 8, verify });

  const server = http.createServer((req, res) => {
    res.once("error", rejectServer);
    void (async () => {
      assert.equal(req.socket.remoteAddress, "127.0.0.1");
      if (req.method === "GET" && req.url === "/health") { res.writeHead(204); res.end(); return; }
      assert.equal(req.method, "POST"); assert.equal(req.url, "/parse");
      assert.equal(Number(req.headers["content-length"]), wire.length);
      let ended = false, rawBytes = 0;
      const end = new Promise((yes, no) => {
        req.once("end", () => { ended = true; events.push("request-end"); yes(); });
        req.once("aborted", () => no(Error("Owned request aborted"))); req.once("error", no);
      });
      end.catch(() => {});
      const rawHash = createHash("sha256");
      let rawFinished = Promise.resolve();
      if (consumer === "raw") {
        const sink = new Writable({ write(chunk, _encoding, done) { rawHash.update(chunk); rawBytes += chunk.length; done(); } });
        rawFinished = new Promise((yes, no) => { sink.once("finish", () => { events.push("raw-finish"); yes(); }); sink.once("error", no); });
        rawFinished.catch(() => {}); req.pipe(sink);
      }
      // In the no-consumer variant, no data listener/pipe is added here: merely
      // waiting for end cannot resume a paused source and hide a missing drain.
      let parsedBeforeTail = false;
      const parseError = await new Promise((yes, no) => {
        parser(req, res, error => {
          try {
            events.push("parser-callback");
            if (mode === "trailing") {
              assert.ifError(error); assert.equal(ended, false); assert.equal(req.complete, false); assert.equal(tailSent, false);
              parsedBeforeTail = true;
              const later = setTimeout(() => {
                delayed.delete(later); tailSent = true; events.push("send-tail"); client.end(tail);
              }, 20);
              delayed.add(later);
            }
            yes(error);
          } catch (error) { no(error); }
        });
      });
      if (mode === "charset") {
        assert.equal(parseError?.status, 415); assert.equal(parseError?.type, "charset.unsupported");
        assert.equal(parseError?.charset, "utf-999"); assert.equal(verifyCalls, 0);
      } else { assert.ifError(parseError); assert.deepEqual(req.body, expectedBody); assert.equal(verifyCalls, 1); }
      await Promise.all([end, rawFinished]);
      assert.equal(ended, true); assert.equal(req.complete, true);
      const digest = consumer === "raw" ? rawHash.digest("hex") : null;
      if (consumer === "raw") { assert.equal(digest, expectedRaw); assert.equal(rawBytes, wire.length); }
      const result = { body: mode === "charset" ? null : req.body, errorType: parseError?.type ?? null,
        requestEnded: ended, requestComplete: req.complete, parsedBeforeTail, rawConsumer: consumer === "raw",
        rawSha256: digest, rawBytes: consumer === "raw" ? rawBytes : null, verifyCalls };
      res.setHeader("Content-Type", "application/json"); res.writeHead(mode === "charset" ? 415 : 200); res.end(JSON.stringify(result));
      resolveServer(result);
    })().catch(error => { rejectServer(error); res.destroy(error); });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.once("error", rejectServer);
  const deadline = new Promise((_yes, no) => { timer = setTimeout(() => no(Error("Bounded parser probe exceeded 6500ms")), 6500); });

  try {
    await new Promise((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const port = server.address().port;
    assert.equal(server.address().address, "127.0.0.1"); assert.ok(Number.isInteger(port) && port > 0);
    const response = new Promise((yes, no) => {
      client = http.request({ host: "127.0.0.1", port, method: "POST", path: "/parse", agent: false,
        headers: { "Content-Type": kind === "json" ? "application/json" + (mode === "charset" ? "; charset=utf-999" : "") : "application/x-www-form-urlencoded",
          "Content-Encoding": encoding, "Content-Length": wire.length, Connection: "close" } }, res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => { size += chunk.length; if (size >= 2048) { res.destroy(Error("Probe response exceeds bound")); return; } chunks.push(chunk); });
        res.once("error", no); res.once("end", () => {
          try { events.push("response-end"); assert.equal(res.statusCode, mode === "charset" ? 415 : 200); yes(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (error) { no(error); }
        });
      });
      client.once("error", no); client.setTimeout(3000, () => client.destroy(Error("Owned parser request timed out")));
      events.push("send-first"); if (mode === "trailing") client.write(first); else client.end(wire);
    });
    const [received, actual] = await Promise.race([Promise.all([response, serverResult]), deadline]);
    assert.deepEqual(received, actual);
    if (mode === "trailing") {
      assert.equal(actual.parsedBeforeTail, true); assert.equal(tailSent, true);
      assert.ok(events.indexOf("parser-callback") < events.indexOf("send-tail") && events.indexOf("send-tail") < events.indexOf("request-end"));
    }
    await new Promise(yes => setTimeout(yes, 100));
    const health = new Promise((yes, no) => {
      healthClient = http.get({ host: "127.0.0.1", port, path: "/health", agent: false }, res => {
        res.resume(); res.once("error", no); res.once("end", () => { try { assert.equal(res.statusCode, 204); events.push("health-end"); yes(204); } catch (error) { no(error); } });
      });
      healthClient.once("error", no); healthClient.setTimeout(3000, () => healthClient.destroy(Error("Owned health request timed out")));
    });
    assert.equal(await Promise.race([health, deadline]), 204);
    return { kind, encoding, mode, ...actual, decodedBodyBytes: payload.length, requestBodyBytes: wire.length,
      expectedRawSha256: consumer === "raw" ? expectedRaw : null, healthyAfterTrailingDelay: true, healthStatus: 204,
      observationDelayMs: 100, events, parserVersion: "1.20.9", ownedHost: "127.0.0.1", port };
  } finally {
    clearTimeout(timer); for (const later of delayed) clearTimeout(later);
    client?.destroy(); healthClient?.destroy(); for (const socket of sockets) socket.destroy(); server.closeAllConnections();
    if (server.listening) await new Promise((yes, no) => server.close(error => error ? no(error) : yes()));
  }
}

probe().then(result => process.stdout.write(JSON.stringify(result) + "\n"), error => {
  process.stderr.write((error.stack || String(error)) + "\n"); process.exitCode = 1;
});
