import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { INSTRUCTION_TEXT_MAX, buildInstructionPayload } from "../js/logic.js";

const failures = [];
let passed = 0;
const check = (condition, message) => {
  if (condition) passed += 1;
  else failures.push(message);
};

const id = "11111111-2222-4333-8444-555555555555";
const savedAt = "2026-11-07T13:20:00.000Z";
const payload = buildInstructionPayload({ requestId: id, text: "  段ボールを確認\n在庫だけ  ", savedAt });
check(Object.keys(payload).sort().join(",") === "kind,requestId,savedAt,text", "frontend keys");
check(payload.kind === "instruction" && payload.text === "段ボールを確認\n在庫だけ" && payload.requestId === id, "frontend trims text");
check(!("memoLines" in payload) && !("transactionId" in payload) && !("slackThread" in payload), "frontend is not a memo");
let empty = false;
try { buildInstructionPayload({ requestId: id, text: " \n ", savedAt }); } catch { empty = true; }
check(empty, "frontend rejects blank");
let long = false;
try { buildInstructionPayload({ requestId: id, text: "あ".repeat(INSTRUCTION_TEXT_MAX + 1), savedAt }); } catch { long = true; }
check(long, "frontend rejects over 400");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = fs.readFileSync(path.join(root, "gas/live-getter-with-instruction.gs"), "utf8");
check(!/hooks\.slack\.com|xox[baprs]-/.test(source), "live getter has no embedded secret");
check(source.includes("function sendInstruction(text)") && !source.split("function doPost")[1].includes("sendInstruction("), "doPost does not call sendInstruction");
check(!source.split("function doPost")[1].includes("getData(") && !source.split("function doPost")[1].includes("sendAnswer("), "doPost does not call getData or sendAnswer");
check(!source.split("function doPost")[1].includes("SpreadsheetApp"), "doPost does not touch a sheet");
check(source.includes("up_rid_") && source.includes("up_rate_") && source.includes("【UPSIDERメモ登録依頼】"), "memo path kept");

const store = {};
const sheets = [];
const slack = [];
const calls = { sendInstruction: 0, getData: 0, sendAnswer: 0, resultGet: 0, resultPost: 0 };
let slackCode = 200;
const context = {
  store, sheets, slack, calls,
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty(key) { return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null; },
        setProperty(key, value) { store[key] = String(value); },
        getProperties() { return { ...store }; },
        deleteProperty(key) { delete store[key]; },
      };
    },
  },
  LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
  ContentService: {
    MimeType: { JSON: "application/json", TEXT: "text/plain" },
    createTextOutput(text) { return { setMimeType() { return { getContent: () => text }; } }; },
  },
  UrlFetchApp: {
    fetch(url, init) {
      slack.push({ url, init });
      return { getResponseCode: () => slackCode };
    },
  },
  SpreadsheetApp: { openById(id) { sheets.push(id); throw new Error("sheet"); } },
  Utilities: {
    formatDate(date, timeZone) {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
      }).formatToParts(date);
      const pick = (type) => parts.find((part) => part.type === type).value;
      return `${pick("year")}${pick("month")}${pick("day")}${pick("hour")}`;
    },
  },
  uprHandleResultGet_() { calls.resultGet += 1; return { op: "get" }; },
  uprHandleResultPost_() { calls.resultPost += 1; return { op: "post" }; },
  uprRespond_(body) { return { op: "respond", body }; },
};
vm.createContext(context);
vm.runInContext(source, context);
context.sendInstruction = () => { calls.sendInstruction += 1; };
context.getData = () => { calls.getData += 1; };
context.sendAnswer = () => { calls.sendAnswer += 1; };
store.SLACK_WEBHOOK_URL = "https://example.test/hook";

function post(body) {
  return JSON.parse(context.doPost({ parameter: { payload: JSON.stringify(body) } }).getContent());
}
function memo(requestId) {
  return {
    requestId,
    transactionId: "tx-20261105-1703-amazon-2659",
    slackThread: "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1793865808.053419",
    memoLines: ["用途：工具", "セグメント1：AIハンド", "セグメント2：", "分類：消耗品", "内容：工具"],
    savedAt,
  };
}
const posted = () => slack.map((item) => JSON.parse(item.init.payload).text);
function instructionJson(slackText) {
  check(slackText.startsWith("【モニターからの指示】\n"), `heading ${slackText}`);
  return JSON.parse(slackText.slice("【モニターからの指示】\n".length));
}

const accepted = post({ kind: "instruction", requestId: id, text: "  段ボールを確認\n在庫だけ  ", savedAt });
check(accepted.ok === true && accepted.duplicate === false && accepted.requestId === id && accepted.transactionId === undefined, `accept ${JSON.stringify(accepted)}`);
const first = instructionJson(posted()[0]);
check(first.kind === "instruction" && first.requestId === id && first.text === "段ボールを確認\n在庫だけ" && first.savedAt === savedAt, `slack json ${JSON.stringify(first)}`);
check(slack[0].init.contentType === "application/json" && JSON.parse(slack[0].init.payload).text === posted()[0], "webhook envelope stays text");
check(!posted()[0].includes("【UPSIDERメモ登録依頼】"), "instruction is not a memo heading");
check(sheets.length === 0 && calls.sendInstruction === 0 && calls.getData === 0 && calls.sendAnswer === 0, "instruction path does not touch the sheet or old functions");

const duplicate = post({ kind: "instruction", requestId: id, text: "段ボールを確認", savedAt });
check(duplicate.duplicate === true && posted().length === 1, "duplicate requestId is not posted again");

const again = post({ kind: "instruction", requestId: "22222222-3333-4444-8555-666666666666", text: "別の指示", savedAt });
const second = instructionJson(posted().at(-1));
check(again.ok === true && second.kind === "instruction" && second.text === "別の指示" && second.requestId === "22222222-3333-4444-8555-666666666666", "second instruction");

const memoResult = post(memo("33333333-4444-4555-8666-777777777777"));
check(memoResult.ok === true && memoResult.transactionId === "tx-20261105-1703-amazon-2659", "memo still accepted");
check(posted().at(-1).startsWith("【UPSIDERメモ登録依頼】\n"), "memo heading unchanged");
check(sheets.length === 0, "memo path in doPost does not open the sheet");

for (const bad of [
  { kind: "instruction", requestId: id, text: "   ", savedAt },
  { kind: "instruction", requestId: id, text: "あ".repeat(401), savedAt },
  { kind: "instruction", requestId: id, text: "指示", savedAt, memoLines: ["用途：x"] },
  { kind: "note", requestId: id, text: "指示", savedAt },
  "not-json",
]) {
  const before = posted().length;
  const response = typeof bad === "string"
    ? JSON.parse(context.doPost({ parameter: { payload: bad } }).getContent())
    : post(bad);
  check(response.ok === false && posted().length === before, `rejected ${JSON.stringify(response).slice(0, 80)}`);
}

slackCode = 500;
const beforeFail = Object.keys(store).filter((key) => key.startsWith("up_rid_")).length;
const failed = post({ kind: "instruction", requestId: "44444444-5555-4666-8777-888888888888", text: "失敗する指示", savedAt });
check(failed.ok === false && String(failed.error).includes("Slack"), `slack failure ${JSON.stringify(failed)}`);
check(Object.keys(store).filter((key) => key.startsWith("up_rid_")).length === beforeFail, "failed slack does not consume requestId");
slackCode = 200;
const retried = post({ kind: "instruction", requestId: "44444444-5555-4666-8777-888888888888", text: "失敗する指示", savedAt });
check(retried.ok === true && retried.duplicate === false, "same requestId can be sent after slack failure");

const hour = Object.keys(store).find((key) => key.startsWith("up_rate_"));
store[hour] = "30";
const limited = post({ kind: "instruction", requestId: "55555555-6666-4777-8888-999999999999", text: "上限", savedAt });
check(limited.ok === false && String(limited.error).includes("多すぎます"), `rate ${JSON.stringify(limited)}`);
const memoLimited = post(memo("66666666-7777-4888-8999-aaaaaaaaaaaa"));
check(memoLimited.ok === false, "instruction and memo share the hourly cap");

const result = context.doPost({ parameter: { op: "result", payload: "{}" } });
check(result.op === "post" && calls.resultPost === 1 && calls.resultGet === 0, "result op stays on the result handler");
check(sheets.length === 0 && calls.sendInstruction === 0, "no sheet access across the mock");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: instruction ${passed} checks passed`);
