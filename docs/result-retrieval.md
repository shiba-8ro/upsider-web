# 実行結果の取得合意

公開ページが実行結果を取る方法だけを書く。受付の POST と `config.js` の URL は変えない。結果の書き込みと、デプロイ済み GAS への組み込みはここでは行わない。

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

- `tests/result.test.mjs` … 照会URL、応答の採否、依頼IDの一致、間隔と30分停止、再開判定、GET にヘッダーも body も付けないこと
- `tests/monitor.test.mjs` … 台帳、受付 payload が5項目のままであること、模擬サーバー上の成否表示、HTML を文字として出すこと、終了後に再POSTしないこと、失敗だけ新しい依頼IDにすること、localStorage からの復帰、30分超過の確認停止と再確認1回、URL未設定で通信しないこと

どちらも `script.google.com` へは接続しない。
