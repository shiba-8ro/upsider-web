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

export const SLACK_CHANNEL_ID = "C0BG07UF1EY";

export const REQUEST_STATUSES = ["未実行", "送信中", "受付済み", "エラー"];

const REQUEST_KEYS = [
  "transactionId",
  "slackThread",
  "memoLines",
  "savedAt",
  "updatedAt",
  "status",
  "requestId",
  "errorMessage",
];

const PAYLOAD_KEYS = ["requestId", "transactionId", "slackThread", "memoLines", "savedAt"];

export const SLACK_THREAD_PATTERN = /^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/;

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

export function buildExecutionRequest({ transactionId, slackThread, memo, savedAt, updatedAt = savedAt }) {
  return {
    transactionId,
    slackThread,
    memoLines: formatMemoText(memo).split("\n"),
    savedAt,
    updatedAt,
    status: "未実行",
    requestId: null,
    errorMessage: "",
  };
}

export function isExecutionRequest(id, request) {
  return migrateExecutionRequest(id, request) !== null;
}

export function migrateExecutionRequest(id, request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  if (Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))) return null;
  if (request.transactionId !== id) return null;
  if (typeof request.slackThread !== "string" || !request.slackThread.startsWith("https://app.slack.com/")) return null;
  if (!Array.isArray(request.memoLines) || request.memoLines.length !== 5) return null;
  if (!request.memoLines.every((line) => typeof line === "string")) return null;
  if (!REQUEST_STATUSES.includes(request.status)) return null;
  if (typeof request.savedAt !== "string" || Number.isNaN(Date.parse(request.savedAt))) return null;
  if (request.updatedAt !== undefined && (typeof request.updatedAt !== "string" || Number.isNaN(Date.parse(request.updatedAt)))) {
    return null;
  }
  if (request.requestId !== undefined && request.requestId !== null && typeof request.requestId !== "string") return null;
  if (request.errorMessage !== undefined && typeof request.errorMessage !== "string") return null;
  const migrated = {
    transactionId: request.transactionId,
    slackThread: request.slackThread,
    memoLines: request.memoLines.slice(),
    savedAt: request.savedAt,
    updatedAt: request.updatedAt || request.savedAt,
    status: request.status,
    requestId: request.requestId || null,
    errorMessage: request.errorMessage || "",
  };
  if (migrated.status === "送信中") {
    migrated.status = "エラー";
    migrated.errorMessage = migrated.errorMessage || "送信結果が残っていません。同じ依頼IDで再試行できます。";
  }
  return migrated;
}

export function loadStoredRequests(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || (parsed.version !== 1 && parsed.version !== 2)) return {};
  if (typeof parsed.requests !== "object" || parsed.requests === null || Array.isArray(parsed.requests)) return {};
  const requests = {};
  for (const [id, request] of Object.entries(parsed.requests)) {
    const migrated = migrateExecutionRequest(id, request);
    if (migrated) requests[id] = migrated;
  }
  return requests;
}

export function slackChannelId(url) {
  return SLACK_THREAD_PATTERN.test(url) ? SLACK_CHANNEL_ID : "";
}

export function isAllowedSlackThread(url, transactions, transactionId) {
  const tx = transactions.find((row) => row.id === transactionId);
  if (!tx || url !== tx.slack) return false;
  return SLACK_THREAD_PATTERN.test(url);
}

export function normalizeGasUrl(value) {
  if (typeof value !== "string") return "";
  const gasUrl = value.trim();
  if (!gasUrl) return "";
  try {
    const parsed = new URL(gasUrl);
    const localhost = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
    if (parsed.protocol === "https:") return parsed.toString();
    if (parsed.protocol === "http:" && localhost) return parsed.toString();
    return "";
  } catch {
    return "";
  }
}

export function createRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

export function resolveRequestId(previous, memoLines, createId = createRequestId) {
  const sameMemo = Boolean(
    previous
    && previous.requestId
    && previous.memoLines.join("\n") === memoLines.join("\n"),
  );
  if (sameMemo && previous.status !== "未実行") return previous.requestId;
  return createId();
}

export function buildGasPayload(request) {
  const payload = {
    requestId: request.requestId,
    transactionId: request.transactionId,
    slackThread: request.slackThread,
    memoLines: request.memoLines.slice(),
    savedAt: request.savedAt,
  };
  const keys = Object.keys(payload);
  if (keys.length !== PAYLOAD_KEYS.length || PAYLOAD_KEYS.some((key) => !keys.includes(key))) {
    throw new Error("payload keys");
  }
  if (!Array.isArray(payload.memoLines) || payload.memoLines.length !== 5) throw new Error("memo lines");
  if (payload.memoLines.some((line) => typeof line !== "string")) throw new Error("memo lines");
  if (typeof payload.savedAt !== "string" || Number.isNaN(Date.parse(payload.savedAt))) throw new Error("savedAt");
  return payload;
}

export function encodeGasBody(payload) {
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

export async function postGasPayload(gasUrl, payload, fetchImpl = globalThis.fetch) {
  if (!normalizeGasUrl(gasUrl)) throw new Error("unconfigured");
  const response = await fetchImpl(gasUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: encodeGasBody(payload),
    mode: "cors",
    credentials: "omit",
    redirect: "follow",
    cache: "no-store",
  });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!response.ok || !data || data.ok !== true) throw new Error("abnormal-response");
  if (typeof data.requestId === "string" && data.requestId !== payload.requestId) {
    throw new Error("request-id-mismatch");
  }
  return data;
}

export function requestStateText(request, configured) {
  if (!request) return "";
  if (request.status === "送信中") return "送信中。受付APIへ実行依頼を送っています。";
  if (request.status === "受付済み") return "受付済み。証憑ゲッターロボへ受け渡しました。処理状況の問い合わせはこのページでは行いません。";
  if (request.status === "エラー") return "エラー。受付APIの応答を確認できませんでした。同じ依頼IDで再試行できます。";
  if (!configured) return "未実行。受付URLが未設定のため、実行は行われていません。";
  return "未実行。実行は行われていません。";
}
