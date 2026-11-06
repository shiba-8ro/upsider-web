// 実行結果の照会ロジック（純粋関数＋fetch）。js/result.js として追加する想定。
// 公開ページは GET ?op=result&requestId=<uuid> だけを使う。書き込み（POST op=result）はページからは行わない。

export const RESULT_STATUSES = ["success", "noop", "failed"];

export const RESULT_LABELS = {
  success: "成功",
  noop: "変更なし",
  failed: "失敗",
};

// 依頼の status（localStorage）に使う日本語ラベル
export const TERMINAL_REQUEST_STATUSES = ["成功", "変更なし", "失敗"];
export const WAITING_REQUEST_STATUSES = ["受付済み", "処理中", "確認停止"];

export const POLL = {
  fastIntervalMs: 15_000,        // 受付直後は15秒ごと
  fastAttempts: 20,              // 15秒×20回＝約5分
  slowIntervalMs: 60_000,        // その後は60秒ごと
  maxWaitMs: 30 * 60_000,        // 受付から30分で自動確認を止める（「確認停止」）
  resumeMaxAgeMs: 24 * 60 * 60_000, // 再読み込み時、24時間以内の依頼だけ自動再開
  maxMessageLength: 400,
};

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isRequestId(value) {
  return typeof value === "string" && REQUEST_ID_RE.test(value);
}

export function buildResultUrl(gasUrl, requestId) {
  if (!isRequestId(requestId)) throw new Error("requestId");
  const url = new URL(gasUrl);
  url.search = new URLSearchParams({ op: "result", requestId }).toString();
  url.hash = "";
  return url.toString();
}

export function validateResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const keys = Object.keys(result).sort();
  if (keys.join(",") !== "finishedAt,message,status") return null;
  if (!RESULT_STATUSES.includes(result.status)) return null;
  if (typeof result.finishedAt !== "string" || Number.isNaN(Date.parse(result.finishedAt))) return null;
  if (typeof result.message !== "string") return null;
  const message = result.message.trim();
  if (!message || message.length > POLL.maxMessageLength) return null;
  return { status: result.status, finishedAt: new Date(result.finishedAt).toISOString(), message };
}

// 応答本文を解釈する。requestId が完全一致しない応答は invalid として捨てる。
export function parseResultResponse(text, requestId) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { kind: "invalid" };
  }
  if (!data || typeof data !== "object" || data.ok !== true) return { kind: "invalid" };
  if (typeof data.requestId !== "string" || data.requestId.toLowerCase() !== String(requestId).toLowerCase()) {
    return { kind: "invalid" };
  }
  if (data.state === "pending") return { kind: "pending" };
  if (data.state === "unknown") return { kind: "unknown" };
  if (data.state === "done") {
    const result = validateResult(data.result);
    return result ? { kind: "done", result } : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

export async function fetchResult(gasUrl, requestId, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(buildResultUrl(gasUrl, requestId), {
    method: "GET",
    mode: "cors",
    credentials: "omit",
    redirect: "follow",
    cache: "no-store",
  });
  if (!response.ok) return { kind: "invalid" };
  return parseResultResponse(await response.text(), requestId);
}

// 次の確認までの待ち時間。null なら自動確認を止める。
export function nextPollDelay(attempts, acceptedAt, now = Date.now()) {
  const accepted = Date.parse(acceptedAt);
  if (Number.isNaN(accepted)) return null;
  if (now - accepted >= POLL.maxWaitMs) return null;
  const delay = attempts < POLL.fastAttempts ? POLL.fastIntervalMs : POLL.slowIntervalMs;
  if (now + delay - accepted > POLL.maxWaitMs) return null;
  return delay;
}

export function shouldResumePolling(request, now = Date.now()) {
  if (!request || !WAITING_REQUEST_STATUSES.includes(request.status)) return false;
  if (!isRequestId(request.requestId)) return false;
  const accepted = Date.parse(request.acceptedAt || "");
  if (Number.isNaN(accepted)) return false;
  return now - accepted < POLL.resumeMaxAgeMs;
}

export function requestStatusForResult(status) {
  return RESULT_LABELS[status] || null;
}

export function isTerminalRequest(request) {
  return Boolean(request && TERMINAL_REQUEST_STATUSES.includes(request.status) && request.result);
}

export function formatJst(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  return `${parts}（日本時間）`;
}

// カード上部の状態行（結果のときは成否＋日本時間）。本文 message は別要素に textContent で出す。
export function resultHeadline(result) {
  const label = RESULT_LABELS[result.status];
  const tail = result.status === "failed" ? "実行に失敗しました。" : result.status === "noop" ? "変更はありませんでした。" : "処理済みです。";
  return `${label}：${formatJst(result.finishedAt)}に実行。${tail}`;
}
