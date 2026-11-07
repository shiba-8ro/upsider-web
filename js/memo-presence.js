// 取引スレッドの観測からメモの有無だけを決める。証憑は引数に取らない。
// 完了通知が無いときは「未確認」であり、メモなしとは断定しない。

const COMPLETION = /メモを追加しました(?!か)/;

export const UPSIDER_BOT_ID = "B0BGJARRAH3";

export function memoPresence(messages) {
  const present = Array.isArray(messages) && messages.some(isUpsiderCompletion);
  return present ? "メモあり" : "未確認";
}

export function memoTone(status) {
  if (status === "あり" || status === "メモあり") return "success";
  if (status === "未確認") return "warning";
  return "neutral";
}

function isUpsiderCompletion(message) {
  if (!message || typeof message !== "object") return false;
  if (message.kind === "button" || message.kind === "quote" || message.quoted === true) return false;
  if (!isUpsiderApp(message)) return false;
  return COMPLETION.test(messageText(message));
}

function messageText(message) {
  return String(message.text ?? message.body ?? message.notice ?? "");
}

function isUpsiderApp(message) {
  if (message.author === "upsider") return true;
  if (message.botId === UPSIDER_BOT_ID) return true;
  return message.bot === true
    && typeof message.appName === "string"
    && message.appName.trim().toLowerCase() === "upsider";
}
