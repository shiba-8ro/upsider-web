import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOKEN_FIELDS, currentTokenUpdate, tokenCountText } from "../js/token-usage.js";

const failures = [];
let passed = 0;
const check = (condition, message) => {
  if (condition) passed += 1;
  else failures.push(message);
};

for (const missing of [null, undefined, "", "0", 1.5, -1, Number.NaN]) {
  check(tokenCountText(missing) === "取得不可", `missing ${JSON.stringify(missing)} is 取得不可`);
}
check(tokenCountText(0) === "0", "explicit zero stays zero");
check(tokenCountText(12) === "12", "measured integer stays");
const partial = { input: 3, output: 4, total: null, cacheRead: null, cacheWrite: null };
check(tokenCountText(partial.input) === "3" && tokenCountText(partial.output) === "4", "measured parts stay");
check(tokenCountText(partial.total) === "取得不可", "total is not derived from input plus output");
check(TOKEN_FIELDS.map(([key]) => key).join(",") === "input,output,total,cacheRead,cacheWrite", "field order");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(fs.readFileSync(path.join(root, "data/ledger.json"), "utf8"));
const usage = ledger.tokenUsage;
const update = currentTokenUpdate(usage);
check(usage.history.includes("0埋めはしていない"), "history refuses zero fill");
check(usage.updates.length === 1, "only the update that was recorded");
check(update.asOf === ledger.asOf, "token row matches this ledger update");
check(update.scope.includes("週次使用率") && update.scope.includes("推定差分はトークンに換算していない"), "scope excludes weekly rate and estimates");
check(update.source.includes("週次の割合のみ") && update.source.includes("実行結果の照会"), "source names the missing measurements");
for (const [key] of TOKEN_FIELDS) {
  check(update[key] === null, `${key} is null, not a fabricated number`);
  check(tokenCountText(update[key]) === "取得不可", `${key} displays 取得不可`);
}
check(!Object.values(update).some((value) => value === 0), "this update is not zero-filled");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: token usage ${passed} checks passed`);
