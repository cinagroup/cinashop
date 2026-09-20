# Minimal native startup diagnostic: no application imports, bindings or sockets.
using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "startup", worker = (
      compatibilityDate = "2026-08-09",
      modules = [(name = "main.js", esModule = "export default { test() { if (1 + 1 !== 2) throw new Error('startup probe'); } };")]
    )),
    (name = "internet", network = (allow = []))
  ]
);
