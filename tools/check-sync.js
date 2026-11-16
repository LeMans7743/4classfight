// 檢查前端 (index.html) 與伺服器 (server.js) 的角色招式、遊戲設定、COM 難度數值是否一致。
// 用法：npm run check   (不一致時列出差異並以非 0 結束)
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const srv = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function grab(src, startMarker, endMarker) {
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error("missing " + startMarker);
  const b = src.indexOf(endMarker, a);
  return src.slice(a + startMarker.length - 1, b + endMarker.length - 1);
}
const evalExpr = (text, extra = {}) => new Function(...Object.keys(extra), "return " + text)(...Object.values(extra));

const clientRoster = evalExpr(grab(html, "const CHARACTER_ROSTER = [", "\n    ];"), { createCharacterSpec: (s) => s });
const serverSpecs = evalExpr(grab(srv, "const CHARACTER_SPECS = [", "\n];"));
const clientCfg = evalExpr(grab(html, "const CONFIG = {", "\n    };"));
const serverCfg = evalExpr(grab(srv, "const GAME_CONFIG = {", "\n};"));
const clientCom = evalExpr(grab(html, "const COM_DIFFICULTIES = {", "\n    };"));
const serverCom = evalExpr(grab(srv, "const COM_DIFFICULTIES = {", "\n};"));

const VISUAL_ONLY = new Set(["style", "slashColor", "castSfx", "ultSfx"]);
const diffs = [];
function cmp(path, a, b) {
  const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
  for (const k of keys) {
    if (VISUAL_ONLY.has(k)) continue;
    const av = a ? a[k] : undefined, bv = b ? b[k] : undefined;
    if (typeof av === "function" || typeof bv === "function") continue;
    if (av && bv && typeof av === "object" && typeof bv === "object") cmp(path + "." + k, av, bv);
    else if (av !== bv) diffs.push(`${path}.${k}: client=${JSON.stringify(av)} server=${JSON.stringify(bv)}`);
  }
}
if (clientRoster.length !== serverSpecs.length) diffs.push(`roster length client=${clientRoster.length} server=${serverSpecs.length}`);
clientRoster.forEach((c, i) => {
  const s = serverSpecs[i] || {};
  const pick = (o) => ({ id: o.id, name: o.name, maxHp: o.maxHp, speedMult: o.speedMult, ultTitle: o.ultTitle, attacks: o.attacks });
  cmp(c.id, pick(c), pick(s));
});
const sharedCfg = Object.fromEntries(Object.keys(serverCfg).map((k) => [k, clientCfg[k]]));
cmp("CONFIG", sharedCfg, serverCfg);
for (const k of Object.keys(serverCom)) {
  const c = { ...clientCom[k] }; delete c.id; delete c.label;
  cmp("COM." + k, c, serverCom[k]);
}
console.log(diffs.length ? diffs.join("\n") : "IN SYNC");
process.exit(diffs.length ? 1 : 0);
