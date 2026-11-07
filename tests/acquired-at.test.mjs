import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ledgerAcquiredAt, normalizeAcquiredAt } from "../js/acquired-at.js";

const failures = [];
let passed = 0;
const check = (condition, message) => {
  if (condition) passed += 1;
  else failures.push(message);
};

check(normalizeAcquiredAt("2026-11-07 13:59 Asia/Tokyo") === "2026-11-07 13:59（日本時間）", "Asia/Tokyo wall clock is kept");
check(normalizeAcquiredAt("2026-11-07 13:59:00 Asia/Tokyo") === "2026-11-07 13:59:00（日本時間）", "seconds kept");
check(normalizeAcquiredAt("2026-11-07 22:06:03 JST") === "2026-11-07 22:06:03（日本時間）", "JST wall clock kept");
check(normalizeAcquiredAt("2026-11-07 22:05:13 JST") === "2026-11-07 22:05:13（日本時間）", "pdf save time stays distinct");
check(normalizeAcquiredAt("2026-11-07 13:59（日本時間）") === "2026-11-07 13:59（日本時間）", "existing Japan label kept");
check(normalizeAcquiredAt("2026-11-07T04:59:00.000Z") === "2026-11-07 13:59（日本時間）", "UTC converts to Japan time");
check(normalizeAcquiredAt("2026-11-07T13:59:00+09:00") === "2026-11-07 13:59（日本時間）", "offset +09:00 stays Japan time");
check(normalizeAcquiredAt("2026-11-07 13:59") === null, "timezone-less clock is not assumed to be Japan");
check(normalizeAcquiredAt("2026-11-07T13:59:00") === null, "naive ISO is not assumed");
check(normalizeAcquiredAt("") === null && normalizeAcquiredAt(null) === null && normalizeAcquiredAt(undefined) === null, "blank is unknown");

const recorded = ledgerAcquiredAt({ asOf: "2026-11-07 13:59 Asia/Tokyo", memoCheck: { asOf: "2026-11-06 19:25 Asia/Tokyo" } });
check(recorded.text === "2026-11-07 13:59（日本時間）" && recorded.source === "asOf", "ledger asOf wins over an older memo scan");
const fallback = ledgerAcquiredAt({ memoCheck: { asOf: "2026-11-07 13:59 Asia/Tokyo" } });
check(fallback.text === "2026-11-07 13:59（日本時間）" && fallback.source === "memoCheck.asOf", "memo scan time is used only when asOf is absent");
check(ledgerAcquiredAt({ asOf: "2026-11-07 13:59" }).text === "未取得", "unzoned asOf is 未取得");
check(ledgerAcquiredAt({}).text === "未取得" && ledgerAcquiredAt(null).text === "未取得", "missing ledger is 未取得");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(fs.readFileSync(path.join(root, "data/ledger.json"), "utf8"));
const shown = ledgerAcquiredAt(ledger);
check(shown.source === "asOf" && shown.text === "2026-11-07 23:30:30（日本時間）", `published asOf ${shown.text}`);
check(normalizeAcquiredAt(ledger.evidencePatrol.lastSuccessfulAcquisitionAt) === "2026-11-07 22:11:16（日本時間）", "pdf time is not the data asOf");
check(!("tokenUsage" in ledger), "token usage is not stored");
const app = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
check(app.includes("最終取得日時") && app.includes("acquired-at.js"), "page shows the acquired time");
check(!app.includes("token-usage") && !app.includes("tokenUsage") && !app.includes("トークン使用量"), "page has no token section");
check(!fs.existsSync(path.join(root, "js/token-usage.js")), "token module removed");
check(!/Date\.now\(/.test(fs.readFileSync(path.join(root, "js/acquired-at.js"), "utf8")), "acquired time does not read the clock");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: acquired at ${passed} checks passed`);
