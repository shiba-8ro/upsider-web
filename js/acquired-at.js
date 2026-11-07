// 台帳に記録された取得日時だけを日本時間のラベルで出す。
// ページを開いた時刻や、ビルドした時刻は使わない。

const JST_WALL = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?(?: Asia\/Tokyo|（日本時間）)$/;

export function ledgerAcquiredAt(ledger) {
  const asOf = normalizeAcquiredAt(ledger && ledger.asOf);
  if (asOf) return { text: asOf, source: "asOf" };
  const memoAsOf = normalizeAcquiredAt(ledger && ledger.memoCheck && ledger.memoCheck.asOf);
  if (memoAsOf) return { text: memoAsOf, source: "memoCheck.asOf" };
  return { text: "未取得", source: null };
}

export function normalizeAcquiredAt(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const wall = JST_WALL.exec(trimmed);
  if (wall) return `${wall[1]} ${wall[2]}（日本時間）`;
  if (!/(?:Z|[+-]\d{2}:?\d{2}|Asia\/Tokyo)/i.test(trimmed)) return null;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(parsed));
  const pick = (type) => parts.find((part) => part.type === type).value;
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}（日本時間）`;
}
