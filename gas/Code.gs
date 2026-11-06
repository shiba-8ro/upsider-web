/**
 * UPSIDERモニターの受付雛形。この1ファイルだけを、postSlack_ がある既存GASへ追加する。
 * postSlack_ はスクリプトプロパティ SLACK_WEBHOOK_URL だけを使う既存関数を呼ぶ想定。
 * このファイルに Webhook やトークンは書かない。進捗シートは読み書きしない。
 * 依頼の実行と、Slack上での完了確認はここでは行わない。
 */
var MEMO_CHANNEL_ID_ = "C0BG07UF1EY";

function doPost(e) {
  try {
    var data = parseUpsiderMemo_(e);
    if (seenRequest_(data.requestId)) {
      return respond_({ ok: true, requestId: data.requestId, duplicate: true });
    }
    postSlack_(buildUpsiderMemoMessage_(data));
    rememberRequest_(data.requestId);
    return respond_({ ok: true, requestId: data.requestId });
  } catch (error) {
    return respond_({ ok: false, error: String(error && error.message ? error.message : error) });
  }
}

function parseUpsiderMemo_(e) {
  var data = readJson_(e);
  var allowed = { requestId: true, transactionId: true, slackThread: true, memo: true };
  var keys = Object.keys(data);
  for (var i = 0; i < keys.length; i += 1) {
    if (!allowed[keys[i]]) throw new Error("unexpected field");
  }
  if (!data.requestId || !data.transactionId || !data.slackThread || typeof data.memo !== "string") {
    throw new Error("missing field");
  }
  if (!isMemoChannel_(data.slackThread)) throw new Error("slack channel");
  var lines = data.memo.split("\n");
  if (lines.length !== 5) throw new Error("memo lines");
  if (lines[0].indexOf("用途：") !== 0) throw new Error("memo purpose");
  if (lines[1].indexOf("セグメント1：") !== 0) throw new Error("memo seg1");
  if (lines[2].indexOf("セグメント2：") !== 0) throw new Error("memo seg2");
  if (lines[3].indexOf("分類：") !== 0) throw new Error("memo category");
  if (lines[4].indexOf("内容：") !== 0) throw new Error("memo content");
  return data;
}

function readJson_(e) {
  var parameter = e && e.parameter;
  if (parameter && parameter.payload) return JSON.parse(parameter.payload);
  var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : "";
  if (!raw) throw new Error("empty body");
  return JSON.parse(raw);
}

function buildUpsiderMemoMessage_(data) {
  return [
    "【UPSIDERメモ登録依頼】",
    "requestId: " + data.requestId,
    "取引ID: " + data.transactionId,
    "Slackスレッド: " + data.slackThread,
    data.memo,
  ].join("\n");
}

function isMemoChannel_(url) {
  var value = String(url);
  var marker = "/" + MEMO_CHANNEL_ID_ + "/thread/" + MEMO_CHANNEL_ID_ + "-";
  return value.indexOf("https://app.slack.com/client/") === 0 && value.indexOf(marker) !== -1;
}

function seenRequest_(requestId) {
  return CacheService.getScriptCache().get(cacheKey_(requestId)) !== null;
}

function rememberRequest_(requestId) {
  CacheService.getScriptCache().put(cacheKey_(requestId), "1", 21600);
}

function cacheKey_(requestId) {
  return "upsider-memo:" + requestId;
}

function respond_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.TEXT);
}
