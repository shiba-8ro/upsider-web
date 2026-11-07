import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const failures = [];
let passed = 0;
const check = (condition, message) => {
  if (condition) passed += 1;
  else failures.push(message);
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "gas/live-getter-reception-stopped.gs"), "utf8");
check(source.includes("本番未適用"), "stopped file says it is not deployed");
check(!/SpreadsheetApp|PropertiesService|UrlFetchApp|LockService|CacheService|HtmlService|SLACK_WEBHOOK|hooks\.slack|SHEET_ID/.test(source), "stopped file has no sheet, secret, or fetch");

const context = {
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput(body) {
      const output = { body };
      output.setMimeType = () => output;
      return output;
    },
  },
};
vm.createContext(context);
vm.runInContext(source, context);
for (const entry of [context.doGet(), context.doPost({ parameter: { op: "result" } }), context.doPost({ parameter: { payload: "{\"kind\":\"instruction\"}" } })]) {
  const body = JSON.parse(entry.body);
  check(body.ok === false && body.stopped === true && body.error.includes("受付を停止しています"), JSON.stringify(body));
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: reception stopped ${passed} checks passed`);
