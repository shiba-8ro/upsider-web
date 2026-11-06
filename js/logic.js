export const FILTERS = [
  "すべて",
  "登録完了",
  "返金（メモ・証憑不要）",
  "メモなし",
  "証憑なし",
  "メモ・証憑なし",
  "証憑不一致",
];

export const COPY_SUCCESS_MS = 2000;

export const STORAGE_KEY = "upsider-monitor.execution-requests.v1";

const REQUEST_KEYS = ["transactionId", "slackThread", "memoLines", "savedAt", "status"];

export function statusTone(status) {
  if (status === "登録完了") return "success";
  if (status === "メモなし" || status === "証憑なし") return "warning";
  if (status === "メモ・証憑なし" || status === "証憑不一致") return "danger";
  return "neutral";
}

export function countOf(transactions, status) {
  return transactions.filter((tx) => tx.status === status).length;
}

export function sumOf(transactions, status) {
  const rows = status ? transactions.filter((tx) => tx.status === status) : transactions;
  return rows.reduce((total, tx) => total + tx.amountYen, 0);
}

export function formatYen(amount) {
  const value = Number(amount);
  const body = Math.abs(value).toLocaleString("ja-JP");
  return value < 0 ? `-¥${body}` : `¥${body}`;
}

export function filterTransactions(transactions, filter) {
  if (filter === "すべて") return transactions.slice();
  return transactions.filter((tx) => tx.status === filter);
}

export function initialMemo(content) {
  return {
    purpose: content,
    seg1: "AIハンド",
    seg2: "",
    category: "消耗品",
    content,
  };
}

export function formatMemoText(memo) {
  return [
    `用途：${memo.purpose}`,
    `セグメント1：${memo.seg1}`,
    `セグメント2：${memo.seg2}`,
    `分類：${memo.category}`,
    `内容：${memo.content}`,
  ].join("\n");
}

export function buildExecutionRequest({ transactionId, slackThread, memo, savedAt }) {
  return {
    transactionId,
    slackThread,
    memoLines: formatMemoText(memo).split("\n"),
    savedAt,
    status: "未実行",
  };
}

export function isExecutionRequest(id, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return false;
  const keys = Object.keys(request);
  if (keys.length !== REQUEST_KEYS.length || REQUEST_KEYS.some((key) => !keys.includes(key))) {
    return false;
  }
  if (request.transactionId !== id) return false;
  if (typeof request.slackThread !== "string" || !request.slackThread.startsWith("https://app.slack.com/")) {
    return false;
  }
  if (!Array.isArray(request.memoLines) || request.memoLines.length !== 5) return false;
  if (!request.memoLines.every((line) => typeof line === "string")) return false;
  if (request.status !== "未実行") return false;
  if (typeof request.savedAt !== "string" || Number.isNaN(Date.parse(request.savedAt))) return false;
  return true;
}
