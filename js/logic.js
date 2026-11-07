import {
  RESULT_LABELS,
  TERMINAL_REQUEST_STATUSES,
  formatJst,
  isRequestId,
  resultHeadline,
  validateResult,
} from "./result.js";

export * from "./result.js";

export const FILTERS = [
  "すべて",
  "登録完了",
  "返金（メモ・証憑不要）",
  "メモなし",
  "証憑なし",
  "証憑保存済・Slack未添付",
  "メモ・証憑なし",
  "証憑不一致",
];

export const COPY_SUCCESS_MS = 2000;

export const STORAGE_KEY = "upsider-monitor.execution-requests.v1";

export const SLACK_CHANNEL_ID = "C0BG07UF1EY";

export const REQUEST_STATUSES = ["未実行", "送信中", "受付済み", "処理中", "確認停止", "成功", "変更なし", "失敗", "エラー"];

export const STORAGE_VERSION = 3;

const REQUEST_KEYS = [
  "transactionId",
  "slackThread",
  "memoLines",
  "savedAt",
  "updatedAt",
  "status",
  "requestId",
  "errorMessage",
  "acceptedAt",
  "pollAttempts",
  "lastCheckedAt",
  "result",
];

const PAYLOAD_KEYS = ["requestId", "transactionId", "slackThread", "memoLines", "savedAt"];
const INSTRUCTION_KEYS = ["kind", "requestId", "text", "savedAt"];

export const INSTRUCTION_TEXT_MAX = 400;

export const SLACK_THREAD_PATTERN = /^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/;

export function statusTone(status) {
  if (status === "登録完了") return "success";
  if (status === "メモなし" || status === "証憑なし" || status === "証憑保存済・Slack未添付") return "warning";
  if (status === "メモ・証憑なし" || status === "証憑不一致") return "danger";
  return "neutral";
}

export function countOf(transactions, status) {
  return transactions.filter((tx) => tx.status === status).length;
}

const SHARE_RESTRICTION_ERROR = "mcp_externally_shared_channel_restricted";

export function needsAction(tx) {
  return tx.status !== "登録完了" && tx.status !== "返金（メモ・証憑不要）";
}

export function actionSummary(transactions) {
  const rows = Array.isArray(transactions) ? transactions : [];
  return {
    action: rows.filter(needsAction).length,
    refund: rows.filter((tx) => tx.status === "返金（メモ・証憑不要）").length,
    done: rows.filter((tx) => tx.status === "登録完了").length,
  };
}

export function attachmentResultView(ledger) {
  const summary = ledger && ledger.slackReceiptAttachment;
  if (!summary || typeof summary.attached !== "number" || typeof summary.blocked !== "number") return null;
  if (summary.error !== SHARE_RESTRICTION_ERROR) return null;
  const rows = (ledger.transactions || []).filter((tx) => (
    tx.status === "証憑保存済・Slack未添付"
    && tx.slackAttachmentError === SHARE_RESTRICTION_ERROR
  ));
  return {
    succeeded: summary.attached,
    incomplete: summary.blocked,
    checkedAt: typeof summary.checkedAt === "string" ? summary.checkedAt : "",
    rows,
  };
}

export function shareRestrictionRemark(tx) {
  if (!tx || tx.slackAttachmentError !== SHARE_RESTRICTION_ERROR || tx.status !== "証憑保存済・Slack未添付") return "";
  return "添付試行済み・共有制限で未添付。連携経由の添付が共有制限で拒否された。";
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
    acceptedAt: null,
    pollAttempts: 0,
    lastCheckedAt: null,
    result: null,
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
  if (!isOptionalIso(request.acceptedAt) || !isOptionalIso(request.lastCheckedAt)) return null;
  if (request.pollAttempts !== undefined && (!Number.isInteger(request.pollAttempts) || request.pollAttempts < 0)) return null;
  const result = request.result === undefined || request.result === null ? null : validateResult(request.result);
  if (request.result !== undefined && request.result !== null && !result) return null;
  const migrated = {
    transactionId: request.transactionId,
    slackThread: request.slackThread,
    memoLines: request.memoLines.slice(),
    savedAt: request.savedAt,
    updatedAt: request.updatedAt || request.savedAt,
    status: request.status,
    requestId: request.requestId || null,
    errorMessage: request.errorMessage || "",
    acceptedAt: request.acceptedAt || null,
    pollAttempts: request.pollAttempts || 0,
    lastCheckedAt: request.lastCheckedAt || null,
    result,
  };
  if (migrated.status === "送信中") {
    migrated.status = "エラー";
    migrated.errorMessage = migrated.errorMessage || "送信結果が残っていません。同じ依頼IDで再試行できます。";
  }
  // v2 までの「受付済み」は受付時刻を持たない。最終更新を受付時刻とみなし、結果の確認対象にする。
  if (migrated.status === "受付済み" && !migrated.acceptedAt) migrated.acceptedAt = migrated.updatedAt;
  // 結果のない終了状態はありえないので、結果待ちに戻す（表示は確認後まで出さない）。
  if (TERMINAL_REQUEST_STATUSES.includes(migrated.status) && !migrated.result) {
    migrated.status = migrated.acceptedAt ? "処理中" : "エラー";
  }
  if (!TERMINAL_REQUEST_STATUSES.includes(migrated.status)) migrated.result = null;
  if (migrated.result && RESULT_LABELS[migrated.result.status] !== migrated.status) return null;
  return migrated;
}

export function loadStoredRequests(raw) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || ![1, 2, STORAGE_VERSION].includes(parsed.version)) return {};
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
  // 失敗した依頼を同じメモでもう一度押したときは、新しい依頼として新しいIDを振る（GASは同じIDを重複として捨てるため）。
  if (sameMemo && previous.status !== "未実行" && previous.status !== "失敗") return previous.requestId;
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

export function buildInstructionPayload({ requestId, text, savedAt }) {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body) throw new Error("empty");
  if (body.length > INSTRUCTION_TEXT_MAX) throw new Error("text length");
  if (!isRequestId(requestId)) throw new Error("requestId");
  if (typeof savedAt !== "string" || Number.isNaN(Date.parse(savedAt))) throw new Error("savedAt");
  const payload = { kind: "instruction", requestId, text: body, savedAt };
  const keys = Object.keys(payload);
  if (keys.length !== INSTRUCTION_KEYS.length || INSTRUCTION_KEYS.some((key) => !keys.includes(key))) {
    throw new Error("payload keys");
  }
  if ("memoLines" in payload || "transactionId" in payload || "slackThread" in payload) {
    throw new Error("memo fields");
  }
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
  if (!response.ok || !data || data.ok !== true) {
    const error = new Error(data && data.ok === false ? "rejected" : "abnormal-response");
    error.serverError = data && typeof data.error === "string" ? data.error : "";
    error.httpStatus = response.status;
    throw error;
  }
  if (typeof data.requestId === "string" && data.requestId !== payload.requestId) {
    const error = new Error("request-id-mismatch");
    error.serverError = "";
    error.httpStatus = response.status;
    throw error;
  }
  return data;
}

export function requestStateText(request, configured) {
  if (!request) return "";
  if (request.status === "送信中") return "送信中。受付APIへ実行依頼を送っています。";
  if (request.status === "受付済み") return "受付済み。証憑ゲッターロボへ受け渡しました。実行結果を確認します。";
  if (request.status === "処理中") return "処理中。証憑ゲッターロボの実行結果を確認しています。";
  if (request.status === "確認停止") return "結果待ち。実行結果がまだ届いていないため、自動確認を停止しました。「結果を再確認」で確認できます。";
  if (TERMINAL_REQUEST_STATUSES.includes(request.status) && request.result) return resultHeadline(request.result);
  if (request.status === "エラー") return "エラー。受付APIの応答を確認できませんでした。同じ依頼IDで再試行できます。";
  if (!configured) return "未実行。受付URLが未設定のため、実行は行われていません。";
  return "未実行。実行は行われていません。";
}

function isOptionalIso(value) {
  if (value === undefined || value === null) return true;
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function resultCheckedText(request) {
  if (!request || !request.lastCheckedAt) return "";
  return `最終確認: ${formatJst(request.lastCheckedAt)}`;
}
