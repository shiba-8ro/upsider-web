# 実行結果の取得合意

この照会は停止しています。公開モニターは `op=result` を取りにいきません。本番の受付を止める全文は `gas/live-getter-reception-stopped.gs` で、まだデプロイしていません。以下は停止前の記録です。

公開ページが実行結果を取る方法だけを書く。受付の POST と `config.js` の URL は変えない。結果の書き込み用ソースは、実デプロイが `up_rid_` で依頼IDを管理しているため、このリポジトリには置かない。

照会そのものは、既存の受付URLで実装済みです。2026-11-06 に、公開ページと同じ `fetch`（リダイレクト追従、資格情報なし）で確認しました。応答には `access-control-allow-origin: *` が付きます。

- `requestId=2c8c7bde-ac56-47d4-a921-aba4870d49fb` は `state:"done"`、`result.status:"noop"`、`finishedAt:"2026-11-06T10:13:00.000Z"`。ページの見出しは「変更なし：2026/11/06 19:13（日本時間）に実行。変更はありませんでした。」
- 未登録の UUID は `state:"unknown"`
- 受付があって結果がまだ無い依頼は、同じURLの `state:"pending"`。ページは成否を出さず、受付直後は「受付済み」、照会を始めたら「処理中」と表示する

ページに結果の見本は置きません。出る成否は、この応答の `status` だけです。

## ページが送る照会

受付と同じ URL へ、次の GET だけを送る。

`GET <gasUrl>?op=result&requestId=<uuid>`

- クエリは `op` と `requestId` だけ。キャッシュバスターは付けない
- メソッドは GET。ヘッダー、body、Cookie、資格情報は付けない
- 秘密鍵、Webhook、トークンはページにも `config.js` にも置かない

## ページが受け取る応答

`requestId` が見ている依頼の ID と一致するものだけを使う。HTML、`ok:false`、未知の `state`、余分なキー、未知の `status`、空または400字を超える `message`、日付でない `finishedAt` は捨てて、次の確認へ回す。

| 応答 | ページの扱い |
|---|---|
| `{ok:true, requestId, state:"done", result:{status, finishedAt, message}}` | 成否・日本時間・詳細を保持中の実行依頼欄へ出す |
| `{ok:true, requestId, state:"pending"}` | 処理中のまま。成否は出さない |
| `{ok:true, requestId, state:"unknown"}` | 成否は出さない。受付記録がまだない注記だけ出す |

`result` のキーは `status`、`finishedAt`、`message` だけ。

- `status`: `success`（成功）、`noop`（変更なし）、`failed`（失敗）
- `finishedAt`: ISO 8601。表示は日本時間
- `message`: 前後の空白を除いて1〜400文字。改行は文字として残す。HTML としては解釈しない

ページは、この応答の `status` 以外から成功・変更なし・失敗を作らない。

## 確認の止め方

- 受付直後は15秒ごと、20回まで。その後は60秒ごと
- 受付から30分で自動確認を止め、「結果を再確認」で1回だけ GET する
- タブが隠れている間は問い合わせない
- 成功・変更なし・失敗は保存し、再読み込み後も再GETしない
- 同じメモの受付済み・処理中・確認停止・成功・変更なしは再POSTしない
- 失敗のときだけ新しい `requestId` で受付をやり直す
- 受付 payload は `requestId`、`transactionId`、`slackThread`、`memoLines`（5行）、`savedAt` のまま

`testPollMs`（50〜15000）は、受付URLのホストが `127.0.0.1` か `localhost` のときだけ15秒の代わりに使う。公開の `config.js` には置かない。

## 実デプロイとの差

デプロイ済みの受付は requestId を `up_rid_` で管理している。このリポジトリの `gas/Code.gs` は `UPSIDER_MEMO_REQUEST_IDS` に ID を並べる雛形で、その差は残したままにする。`UPSIDER_MEMO_REQUEST_IDS` に載っている ID だけを結果保存の前提にするソースは、いまの実スクリプトでは動かない。そのため GAS の差し替え用ファイルは置かない。`gas/Code.gs` は編集しない。

照会がまだ実サーバーに無いあいだ、ページは不正応答として処理中のあと確認停止で止まる。成否はサーバーが `done` を返すまで出さない。

## テスト

```sh
npm test
```

- `tests/memo-presence.test.mjs` … メモの有無。UPSIDER アプリ自身の完了通知だけを数え、証憑や5項目本文では決めない。詳細は `docs/memo-presence.md`
- `tests/acquired-at.test.mjs` … 最終取得日時。台帳の `asOf` を日本時間で表示し、タイムゾーンが無い値は未取得。トークン欄は出さない
- `tests/result.test.mjs` … 照会URL、応答の採否、依頼IDの一致、間隔と30分停止、再開判定、GET にヘッダーも body も付けないこと
- `tests/monitor.test.mjs` … 台帳、メモ受付 payload が5項目のままであること、指示は別の `kind=instruction` で送信ボタンのときだけ送ること、模擬サーバー上の成否表示、HTML を文字として出すこと、終了後に再POSTしないこと、失敗だけ新しい依頼IDにすること、localStorage からの復帰、30分超過の確認停止と再確認1回、URL未設定で通信しないこと

どちらも `script.google.com` へは接続しない。
