/**
 * 本番未適用。親が getter.gs をこの内容へ置き換えるまでの成果物。
 * このリポジトリからはデプロイしない。
 * doGet と doPost は、op=result・メモ・指示を含むすべての受付を拒否する。
 * 外部の表、保存された設定、外への通信は使わない。
 */
function doGet() {
  return receptionStopped_();
}

function doPost() {
  return receptionStopped_();
}

function receptionStopped_() {
  return ContentService.createTextOutput(JSON.stringify({
    ok: false,
    stopped: true,
    error: "受付を停止しています。連携機能は使用しません。"
  })).setMimeType(ContentService.MimeType.JSON);
}
