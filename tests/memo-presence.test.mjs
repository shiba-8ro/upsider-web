import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UPSIDER_BOT_ID, memoPresence } from "../js/memo-presence.js";

const failures = [];
let passed = 0;
const check = (condition, message) => {
  if (condition) passed += 1;
  else failures.push(message);
};

const completion = (text, extra = {}) => ({ author: "upsider", kind: "message", text, ...extra });

check(memoPresence([completion("メモを追加しました")]) === "メモあり", "plain completion");
check(memoPresence([completion("メモを追加しました。")]) === "メモあり", "completion with period");
check(memoPresence([completion("決済メモを追加しました！")]) === "メモあり", "payment memo completion");
check(memoPresence([completion("登録が終わりました。「決済メモを追加しました！」")]) === "メモあり", "completion inside the bot message");
check(memoPresence([{ bot: true, appName: "UPSIDER", text: "決済メモを追加しました！" }]) === "メモあり", "app name identifies UPSIDER");
check(memoPresence.length === 1, "evidence is not a parameter");
check(memoPresence([completion("決済メモを追加しました！")], { drive: "あり" }) === "メモあり", "extra evidence argument is ignored when present");
check(memoPresence([], { drive: "あり" }) === "未確認", "evidence alone is not a memo");

const fiveLines = [
  "用途：工具",
  "セグメント1：AIハンド",
  "セグメント2：",
  "分類：消耗品",
  "内容：工具",
].join("\n");
check(memoPresence([completion("決済メモを追加しました！")]) === "メモあり", "completion without the five-line body");
check(memoPresence([{ author: "human", text: fiveLines }]) === "未確認", "five-line body from a human is not enough");
check(memoPresence([completion(fiveLines)]) === "未確認", "five-line body from UPSIDER is not enough");

check(memoPresence([{ author: "human", text: "決済メモを追加しました！" }]) === "未確認", "human text is not the app");
check(memoPresence([{ author: "human", kind: "quote", text: "決済メモを追加しました！" }]) === "未確認", "human quote");
check(memoPresence([{ author: "upsider", kind: "quote", quoted: true, text: "メモを追加しました" }]) === "未確認", "quoted completion is not the app's own post");
check(memoPresence([{ author: "upsider", kind: "button", text: "メモを追加しました" }]) === "未確認", "button");
check(memoPresence([completion("準備完了")]) === "未確認", "準備完了");
check(memoPresence([{ author: "upsider", kind: "button", text: "準備完了" }]) === "未確認", "準備完了 button");
check(memoPresence([{ bot: true, appName: "証憑ゲッター", text: "UPSIDERの「決済メモを追加しました！」の返信がありました。" }]) === "未確認", "another bot relaying the phrase");
check(memoPresence([completion("メモを追加しましたか？")]) === "未確認", "question is not completion");
check(memoPresence([completion("メモを追加できませんでした")]) === "未確認", "failure is not completion");
check(memoPresence([]) === "未確認", "empty thread");
check(memoPresence(null) === "未確認", "missing observations");
check(memoPresence([
  { author: "human", kind: "quote", text: "決済メモを追加しました！" },
  completion("メモを追加しました"),
]) === "メモあり", "a real completion still counts beside a human quote");

check(memoPresence([{ botId: UPSIDER_BOT_ID, body: "決済メモを追加しました！:bulb:\n本文は別にあっても判定には不要" }]) === "メモあり", "ledger bot id and body");
check(memoPresence([{ botId: "B0OTHER", body: "決済メモを追加しました！" }]) === "未確認", "other bot id is not UPSIDER");
check(memoPresence([{ botId: UPSIDER_BOT_ID, kind: "button", body: "メモを追加しました" }]) === "未確認", "button with the bot id");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerText = fs.readFileSync(path.join(root, "data/ledger.json"), "utf8");
const ledger = JSON.parse(ledgerText);
check(!ledgerText.includes("slack-bots.com"), "published ledger has no raw slack address");
check(!ledgerText.includes("f99d7404-b1c7-4259-b639-e923ee35ade0"), "published ledger has no card user id");
check(!ledgerText.includes('"raw"'), "published ledger has no raw slack log");
const present = ledger.transactions.filter((tx) => tx.memoPresent === true);
const unconfirmed = ledger.transactions.filter((tx) => tx.memoStatus === "未確認");
const exempt = ledger.transactions.filter((tx) => tx.memoStatus === "不要");
check(present.length === 18, `memo present ${present.length}`);
check(unconfirmed.length === 0, "no unconfirmed memo");
const danballace = ledger.transactions.find((tx) => tx.id === "tx-20261106-1553-danballace-7160");
check(danballace.memoStatus === "あり" && danballace.memoPresent === true, "DANBALLACE 7160 memo confirmed");
check(exempt.length === 1 && exempt[0].status === "返金（メモ・証憑不要）" && exempt[0].memoPresent == null, "refund is exempt");
for (const tx of present) {
  check(tx.memoStatus === "あり" && tx.memoEvidence.length > 0, `evidence for ${tx.id}`);
  const messages = tx.memoEvidence.map((item) => ({ botId: item.botId, body: item.notice }));
  check(memoPresence(messages) === "メモあり", `notice confirms ${tx.id}`);
  check(tx.memoEvidence.every((item) => item.botId === UPSIDER_BOT_ID && item.notice === "決済メモを追加しました！"), `notice text ${tx.id}`);
}
check(memoPresence([]) === "未確認", "empty evidence stays unconfirmed");
const pageSource = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
check(pageSource.includes("memoStatus"), "page shows the stored memo status");
check(!pageSource.includes("memoPresence("), "page does not reclassify memos");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`ok: memo presence ${passed} checks passed`);
