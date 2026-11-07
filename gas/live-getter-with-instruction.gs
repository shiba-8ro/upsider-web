const SHEET_ID = '1ft447yF8G_aJL5zoApz-e4CnkVcIS3BpVTsFtfnMU2Q';
const TAB = 'モニター';

function doGet(e) {
  const params = (e && e.parameter) || {};
  if (params.op === "result") return uprHandleResultGet_(params);
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('証憑ゲッターロボ 進捗モニター')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function getData() {
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB);
  const head = sh.getRange('B3:G3').getDisplayValues()[0];
  const q = sh.getRange('I3:N3').getDisplayValues()[0];
  const done = Number(head[0]) || 0, total = Number(head[1]) || 0;
  const last = sh.getLastRow();
  let logs = [];
  if (last >= 6) {
    const n = Math.min(200, last - 5);
    logs = sh.getRange(6, 1, n, 3).getDisplayValues()
      .filter(r => r.join('') !== '')
      .map(r => ({ t: r[0], p: r[1], m: r[2] }));
  }
  return { done, total, ratio: total ? done / total : 0,
           phase: head[4], updated: head[5], logs,
           question: { text: q[0], options: [q[1], q[2], q[3]].filter(Boolean), status: q[4], id: q[5] }, now: new Date().toISOString() };
}

function postSlack_(text) {
  const url = PropertiesService.getScriptProperties().getProperty('SLACK_WEBHOOK_URL');
  if (!url) throw new Error('SLACK_WEBHOOK_URL が未設定です');
  const res = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json',
    payload: JSON.stringify({ text: text }), muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Slack送信失敗: ' + res.getResponseCode());
}

// 選択肢への回答をSlackへ送る
function sendAnswer(id, answer) {
  answer = String(answer || '').trim();
  if (!answer) throw new Error('回答が空です');
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB);
  const q = sh.getRange('I3:N3').getDisplayValues()[0];
  if (q[5] !== String(id) || q[4] !== 'open') throw new Error('この質問はもう締め切られています');
  postSlack_('【選択肢への回答】\n質問ID: ' + id + '\n質問: ' + q[0] + '\n回答: ' + answer);
  sh.getRange('M3').setValue('answered');
  sh.insertRowBefore(6);
  sh.getRange(6, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'), '回答送信', answer.slice(0, 200)]]);
  return 'ok';
}

// 指示をSlack（#証憑ゲッターロボ）へ送る
function sendInstruction(text) {
  text = String(text || '').trim();
  if (!text) throw new Error('指示が空です');
  postSlack_('【モニターからの指示】\n' + text);
  const sh = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB);
  sh.insertRowBefore(6);
  sh.getRange(6, 1, 1, 3).setValues([[Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'), '指示送信', text.slice(0, 200)]]);
  return 'ok';
}

// ===== UPSIDERモニター受付 (doPostのみ追加) =====
const UP_THREAD_RE_ = /^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/;
const UP_UUID_RE_ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UP_TX_RE_ = /^tx-[A-Za-z0-9_-]{1,64}$/;
const UP_LABELS_ = ['用途', 'セグメント1', 'セグメント2', '分類', '内容'];
const UP_MAX_PER_HOUR_ = 30;
function upJson_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function upValidate_(p) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('payloadが不正です');
      if (Object.keys(p).sort().join(',') !== 'memoLines,requestId,savedAt,slackThread,transactionId') throw new Error('項目が不正です');
        if (typeof p.requestId !== 'string' || !UP_UUID_RE_.test(p.requestId)) throw new Error('requestIdが不正です');
          if (typeof p.slackThread !== 'string' || p.slackThread.length > 200 || !UP_THREAD_RE_.test(p.slackThread)) throw new Error('slackThreadが不正です');
          if (typeof p.savedAt !== 'string' || p.savedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(p.savedAt) || isNaN(new Date(p.savedAt).getTime())) throw new Error('savedAtが不正です');
          if (!Array.isArray(p.memoLines) || p.memoLines.length !== 5) throw new Error('memoLinesは5行必須です');
          if (typeof p.transactionId !== 'string' || !UP_TX_RE_.test(p.transactionId)) throw new Error('transactionIdが不正です');
          p.memoLines.forEach(function (l, i) { if (typeof l !== 'string' || l.length > 300) throw new Error('memoLinesの長さが不正です'); if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(l)) throw new Error('制御文字は使えません'); const m = l.match(/^(用途|セグメント1|セグメント2|分類|内容)[:：]\s*(.+)$/); if (i === 2 ? l.indexOf('セグメント2：') !== 0 : (!m || m[1] !== UP_LABELS_[i])) throw new Error('memoLinesの形式が不正です: ' + (i + 1) + '行目'); });
}

function upValidateInstruction_(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('payloadが不正です');
  if (Object.keys(p).sort().join(',') !== 'kind,requestId,savedAt,text') throw new Error('項目が不正です');
  if (p.kind !== 'instruction') throw new Error('kindが不正です');
  if (typeof p.requestId !== 'string' || !UP_UUID_RE_.test(p.requestId)) throw new Error('requestIdが不正です');
  if (typeof p.savedAt !== 'string' || p.savedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(p.savedAt) || isNaN(new Date(p.savedAt).getTime())) throw new Error('savedAtが不正です');
  if (typeof p.text !== 'string') throw new Error('textが不正です');
  const text = p.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!text) throw new Error('指示が空です');
  if (text.length > 400) throw new Error('指示が長すぎます');
  if (/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/.test(text)) throw new Error('制御文字は使えません');
  p.text = text;
}

function doPost(e) {
  const params = (e && e.parameter) || {};
  if (params.op !== undefined) {
    if (params.op === "result") return uprHandleResultPost_(params);
    return uprRespond_({ ok: false, error: "op" });
  }
  let p;
  try { const raw = e && e.parameter && e.parameter.payload; if (typeof raw !== 'string' || raw.length > 4000) throw new Error('payloadがありません'); try { p = JSON.parse(raw); } catch (x) { throw new Error('JSONが不正です'); } if (p && p.kind === 'instruction') upValidateInstruction_(p); else upValidate_(p); } catch (err) { return upJson_({ ok: false, error: String(err.message || err) }); }
  const lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (x) { return upJson_({ ok: false, error: '混雑しています。再試行してください' }); }
  try {
    const props = PropertiesService.getScriptProperties();
    const key = 'up_rid_' + p.requestId;
    if (props.getProperty(key)) return upJson_({ ok: true, requestId: p.requestId, duplicate: true });
    const hour = 'up_rate_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMddHH');
    const cnt = Number(props.getProperty(hour)) || 0;
    if (cnt >= UP_MAX_PER_HOUR_) return upJson_({ ok: false, error: 'リクエストが多すぎます。しばらくしてから再試行してください' });
    const all = props.getProperties();
    const rids = Object.keys(all).filter(function (k) { return k.indexOf('up_rid_') === 0; });
    if (rids.length > 300) { rids.sort(function (a, b) { return Number(all[a]) - Number(all[b]); }); rids.slice(0, rids.length - 200).forEach(function (k) { props.deleteProperty(k); }); }
    Object.keys(all).forEach(function (k) { if (k.indexOf('up_rate_') === 0 && k !== hour) props.deleteProperty(k); });
    const upSlackText = (p.kind === 'instruction')
      ? ('【モニターからの指示】\n' + JSON.stringify({ kind: 'instruction', requestId: p.requestId, text: p.text, savedAt: p.savedAt }))
      : ('【UPSIDERメモ登録依頼】\n' + JSON.stringify(p));
    try { postSlack_(upSlackText); } catch (x) { return upJson_({ ok: false, error: 'Slack送信に失敗しました' }); }
    props.setProperty(key, String(Date.now()));
    props.setProperty(hour, String(cnt + 1));
    return upJson_({ ok: true, requestId: p.requestId, transactionId: p.transactionId, duplicate: false });
  } finally { lock.releaseLock(); }
}