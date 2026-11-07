# 指示の転送

この手順は停止しています。公開モニターは受付URLへ送りません。本番へ適用する停止版は `gas/live-getter-reception-stopped.gs` で、まだデプロイしていません。以下は停止前の記録です。

公開ページの「指示を送る」は、メモ登録とは別の payload を既存の受付 URL へ POST します。入力や Enter では送りません。受付に成功しても作業完了ではありません。本文は受信後、このチャットで確認してから実行します。

`gas/Code.gs` は雛形です。本番に入れる全文は `gas/live-getter-with-instruction.gs` で、現行 `getter.gs` に `kind=instruction` だけを足したものです。`result.gs` は変えていません。

## フロントが送る payload

`application/x-www-form-urlencoded` の `payload` に、次の JSON だけを入れます。

```json
{
  "kind": "instruction",
  "requestId": "11111111-2222-4333-8444-555555555555",
  "text": "段ボールを確認",
  "savedAt": "2026-11-07T13:20:00.000Z"
}
```

- `kind` は `instruction` のみ
- `requestId` は UUID
- `text` は前後の空白を除いて1〜400字。改行は残せます
- `savedAt` は UTC の ISO 時刻
- `transactionId`、`slackThread`、`memoLines` は付けません

## Slack に渡す JSON

既存の `postSlack_` が送る形のままです。Webhook の外側は `{ "text": "..." }` で、URL はスクリプトプロパティ `SLACK_WEBHOOK_URL` だけを読み、ソースには書きません。

`text` の中身は、メモ受付と同じく見出しの次の行に payload の JSON です。本文のフィールド名は `text` です。

```json
{
  "text": "【モニターからの指示】\n{\"kind\":\"instruction\",\"requestId\":\"11111111-2222-4333-8444-555555555555\",\"text\":\"段ボールを確認\",\"savedAt\":\"2026-11-07T13:20:00.000Z\"}"
}
```

受信側は見出し `【モニターからの指示】` の後の JSON から `kind`、`requestId`、`text`、`savedAt` を検証します。`text` が指示本文、`savedAt` が時刻です。旧 `sendInstruction(text)` は呼びません。シートへの読み書きもありません。

`text` は暫定で400字までです。超えた文は切らず、ページ上で送れない旨を出して拒否します。

メモ受付の見出し `【UPSIDERメモ登録依頼】` と JSON 本文は、これまでどおりです。

## 本番 doPost の差分

検証と投稿文の分岐だけを、既存の `up_rid_` / `up_rate_` のロックの前に足します。重複、1時間30件、古いプロパティの整理、Slack 失敗時に `up_rid_` を書かない順序はメモ受付と同じです。`op=result` は従来の結果関数へ渡します。`getData`、`sendAnswer`、`sendInstruction` は起動しません。
