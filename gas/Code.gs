/**
 * UPSIDERモニターの受付雛形。実機と同じく e.parameter.payload の JSON を受ける。
 * postSlack_ はスクリプトプロパティ SLACK_WEBHOOK_URL だけを使う既存関数を呼ぶ。
 * このファイルに Webhook やトークンは書かない。進捗シートは読み書きしない。
 * 依頼の実行と、Slack上での完了確認はここでは行わない。
 */
var SLACK_THREAD_RE_ = /^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/;
var PROP_IDS_ = "UPSIDER_MEMO_REQUEST_IDS";
var PROP_RATE_ = "UPSIDER_MEMO_RATE";
var MAX_IDS_ = 200;
var RATE_LIMIT_ = 30;
var RATE_WINDOW_MS_ = 60 * 60 * 1000;

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (error) {
    return respond_({ ok: false, error: "lock" });
  }
  try {
    if (!(e && e.parameter && e.parameter.payload)) throw new Error("missing payload");
    var raw = JSON.parse(e.parameter.payload);
    var props = PropertiesService.getScriptProperties();
    if (raw && raw.kind === "instruction") {
      return respond_(deliver_(props, parseInstruction_(raw), buildInstructionMessage_));
    }
    if (raw && Object.prototype.hasOwnProperty.call(raw, "kind")) throw new Error("unexpected field");
    return respond_(deliver_(props, parseUpsiderMemo_(e), buildUpsiderMemoMessage_));
  } catch (error) {
    return respond_({ ok: false, error: String(error && error.message ? error.message : error) });
  } finally {
    lock.releaseLock();
  }
}

function parseUpsiderMemo_(e) {
  if (!(e && e.parameter && e.parameter.payload)) throw new Error("missing payload");
  var data = JSON.parse(e.parameter.payload);
  var allowed = { requestId: true, transactionId: true, slackThread: true, memoLines: true, savedAt: true };
  var keys = Object.keys(data);
  if (keys.length !== 5) throw new Error("unexpected field");
  for (var i = 0; i < keys.length; i += 1) {
    if (!allowed[keys[i]]) throw new Error("unexpected field");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) {
    throw new Error("requestId");
  }
  if (!/^tx-[A-Za-z0-9-]+$/.test(data.transactionId)) throw new Error("transactionId");
  if (!SLACK_THREAD_RE_.test(data.slackThread)) throw new Error("slack thread");
  if (!Array.isArray(data.memoLines) || data.memoLines.length !== 5) throw new Error("memo lines");
  var labels = ["用途：", "セグメント1：", "セグメント2：", "分類：", "内容："];
  for (var line = 0; line < labels.length; line += 1) {
    if (typeof data.memoLines[line] !== "string" || data.memoLines[line].indexOf(labels[line]) !== 0) {
      throw new Error("memo line");
    }
  }
  if (typeof data.savedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.savedAt)) {
    throw new Error("savedAt");
  }
  return data;
}

function parseInstruction_(data) {
  var allowed = { kind: true, requestId: true, text: true, savedAt: true };
  var keys = Object.keys(data);
  if (keys.length !== 4) throw new Error("unexpected field");
  for (var i = 0; i < keys.length; i += 1) {
    if (!allowed[keys[i]]) throw new Error("unexpected field");
  }
  if (data.kind !== "instruction") throw new Error("kind");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.requestId)) {
    throw new Error("requestId");
  }
  if (typeof data.text !== "string") throw new Error("text");
  var text = data.text.trim();
  if (!text) throw new Error("empty");
  if (text.length > 400) throw new Error("text length");
  if (typeof data.savedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(data.savedAt)) {
    throw new Error("savedAt");
  }
  return { kind: "instruction", requestId: data.requestId, text: text, savedAt: data.savedAt };
}

function buildInstructionMessage_(data) {
  return "【モニターからの指示】\n" + data.text;
}

function deliver_(props, data, buildMessage) {
  var ids = readIds_(props);
  if (ids.indexOf(data.requestId) !== -1) {
    return { ok: true, requestId: data.requestId, duplicate: true };
  }
  if (rateCount_(props) >= RATE_LIMIT_) return { ok: false, error: "rate" };
  postSlack_(buildMessage(data));
  ids.push(data.requestId);
  if (ids.length > MAX_IDS_) ids = ids.slice(ids.length - MAX_IDS_);
  props.setProperty(PROP_IDS_, JSON.stringify(ids));
  incrementRate_(props);
  return { ok: true, requestId: data.requestId };
}

function buildUpsiderMemoMessage_(data) {
  return [
    "【UPSIDERメモ登録依頼】",
    "requestId: " + data.requestId,
    "取引ID: " + data.transactionId,
    "Slackスレッド: " + data.slackThread,
    "savedAt: " + data.savedAt,
    data.memoLines.join("\n"),
  ].join("\n");
}

function readIds_(props) {
  var raw = props.getProperty(PROP_IDS_);
  if (!raw) return [];
  try {
    var ids = JSON.parse(raw);
    return Array.isArray(ids) ? ids.filter(function (id) { return typeof id === "string"; }) : [];
  } catch (error) {
    return [];
  }
}

function readRate_(props) {
  var now = Date.now();
  var raw = props.getProperty(PROP_RATE_);
  var rate = { start: now, count: 0 };
  if (!raw) return rate;
  try {
    var parsed = JSON.parse(raw);
    if (typeof parsed.start === "number" && typeof parsed.count === "number" && now - parsed.start < RATE_WINDOW_MS_) {
      return parsed;
    }
  } catch (error) {
    return rate;
  }
  return rate;
}

function rateCount_(props) {
  return readRate_(props).count;
}

function incrementRate_(props) {
  var rate = readRate_(props);
  rate.count += 1;
  props.setProperty(PROP_RATE_, JSON.stringify(rate));
}

function respond_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.TEXT);
}
