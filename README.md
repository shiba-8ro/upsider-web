# UPSIDERモニター

AIハンド決済用カードのUPSIDERチェック結果を表示する静的サイトです。依存ライブラリはなく、GitHub Pages のルートにそのまま置けます。

公開URL: https://shiba-8ro.github.io/upsider-web/

GitHub Pages は `main` ブランチのルートを公開します。`main` へマージすると、同じURLの表示がこのモニターに置き換わります。

## 入っているもの

- 全19取引の一覧、ステータスフィルタ、件数と金額の集計
- 要対応5件の詳細、Slackスレッド（新しいタブ）、Drive証憑、参照用の注文画像
- メモ5欄と「クリップボードにコピー」（成功表示は2秒で消えます）
- 「AIがメモを追加する」は、取引ID・Slackスレッド・編集中の5行メモ（用途、セグメント1、セグメント2、分類、内容）を1件の実行依頼にします。`config.js` の受付URLが空のときは送信せず、未実行のままブラウザ内に保持します。URLがあるときは `application/x-www-form-urlencoded` の `payload` に JSON を入れて受付APIへ送り、カードに送信中・処理中・確認停止・成功・変更なし・失敗・エラーを出します。受付後の実行そのものは証憑ゲッターロボ側です。このページは依頼IDだけで実行結果を照会し、保持中の実行依頼欄に成否・日本時間・詳細を表示します

正本データは `data/ledger.json` です。`assets/17600.jpg` と `assets/2659.jpg` は抽出元のJPEGが破損しているため、再生成せず破損のまま表示します。

## 受付API

公開サイトが読むのは `config.js` です。ここには秘密ではない受付URLだけを書いてリポジトリに含めます。GitHub Pages は gitignore でファイルを落とさないので、公開するURLは `config.js` にコミットします。

`config.example.js` は形だけの見本です。`gasUrl` は空で、サイトはこちらを読みません。空のURLでは送信せず、未実行のままにします。

Webhook やトークンはどちらにも書きません。`SLACK_WEBHOOK_URL` は GAS のスクリプトプロパティだけに置きます。

`gas/Code.gs` は既存の `postSlack_` があるプロジェクトへ足す雛形です。進捗シートは読み書きしません。受付は `e.parameter.payload` の JSON です。項目は `requestId`、`transactionId`、`slackThread`、5行の `memoLines`、`savedAt` です。金額と利用先は送りません。ブラウザは `application/x-www-form-urlencoded` の `payload` にその JSON を入れ、`text/plain` では送りません。

Slack スレッドは `https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-` に10桁、小数、6桁が続くものだけです。取引一覧のURLと一致しないものは送りません。受付の再試行は同じ `requestId` を使います。受付済み・処理中・確認停止・成功・変更なしの同じメモは再送しません。失敗のときだけ新しい `requestId` で送り直します。雛形の重複排除は PropertiesService に requestId を200件まで保持し、LockService と1時間30件の総量制限を使います。

受付後、ページは同じ受付URLへ `GET ?op=result&requestId=<uuid>` を送ります。パラメータはこの2つだけです。秘密鍵やトークンは付けません。15秒間隔で20回、その後は60秒間隔、受付から30分で自動確認を止めます。「結果を再確認」はそのとき1回だけ照会します。タブを隠している間は問い合わせません。終了した依頼は localStorage から復帰し、結果があるものは自動では再POSTしません。

表示に使うのは、`requestId` が一致するサーバー応答だけです。`state:"done"` の `result.status` が `success` / `noop` / `failed` のときだけ、成功・変更なし・失敗と日本時間、`message` を出します。`message` は textContent で出します。`pending` と不正な応答では成否を出しません。`unknown` のときは記録がまだない注記だけです。成功などの文言をページ側で固定しません。色は成功と変更なしが薄緑、失敗が赤、処理中と確認停止が青系です。

`gas/Code.gs` はこの照会をまだ実装しません。デプロイ済みの受付は requestId を `up_rid_` で管理しており、リポジトリの雛形（`UPSIDER_MEMO_REQUEST_IDS`）とは差があります。その統合は別作業です。ページが期待する応答と、テストの範囲は `docs/result-retrieval.md` にあります。

GitHub Actions などの自動デプロイは使いません。`main` への反映は手作業です。GAS のデプロイもこのリポジトリからは行いません。

## ローカル確認

```sh
python3 -m http.server 4173
```

ブラウザで http://127.0.0.1:4173/ を開きます。

## テスト

```sh
npm install
npm test
```

`npm test` は `tests/result.test.mjs` と `tests/monitor.test.mjs` です。前者は照会URL、応答の検証、依頼IDの一致、15秒から60秒、30分停止を見ます。後者は台帳と、ローカルの模擬受付での結果表示・再投稿防止・失敗時の新しい依頼ID・localStorage からの復帰・確認停止を見ます。模擬の `testPollMs` は `127.0.0.1` と `localhost` のときだけ使います。公開の `config.js` には書きません。テストは本番の受付URLへ接続しません。
