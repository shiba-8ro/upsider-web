// 1更新の実測トークンを表示用に整形する。欠測を0にしない。合計も入力と出力から作らない。

export const TOKEN_FIELDS = [
  ["input", "入力"],
  ["output", "出力"],
  ["total", "合計"],
  ["cacheRead", "cache読取"],
  ["cacheWrite", "cache書込"],
];

export function tokenCountText(value) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return "取得不可";
  return String(value);
}

export function currentTokenUpdate(tokenUsage) {
  const updates = tokenUsage && Array.isArray(tokenUsage.updates) ? tokenUsage.updates : [];
  return updates[0] || null;
}
