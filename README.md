# UPSIDERモニター

AIハンド決済用カードのUPSIDERチェック結果を表示する静的サイトです。依存ライブラリはなく、GitHub Pages のルートにそのまま置けます。

公開URL: https://shiba-8ro.github.io/upsider-web/

GitHub Pages は `main` ブランチのルートを公開します。`main` へマージすると、同じURLの表示がこのモニターに置き換わります。

## 入っているもの

- 全19取引の一覧、ステータスフィルタ、件数と金額の集計
- 要対応5件の詳細、Slackスレッド（新しいタブ）、Drive証憑、参照用の注文画像
- メモ5欄と「クリップボードにコピー」（成功表示は2秒で消えます）
- 「AIがメモを追加する」は、取引ID・Slackスレッド・編集中の5行メモ（用途、セグメント1、セグメント2、分類、内容）を1件の実行依頼にします。`config.js` の受付URLが空のときは送信せず、未実行のままブラウザ内に保持します。URLがあるときは `application/x-www-form-urlencoded` の `payload` に JSON を入れて受付APIへ送り、カードに送信中・受付済み・エラーを出します。受付後の処理と Slack 上の完了確認は証憑ゲッターロボ側です

正本データは `data/ledger.json` です。`assets/17600.jpg` と `assets/2659.jpg` は抽出元のJPEGが破損しているため、再生成せず破損のまま表示します。

## 受付API

公開サイトが読むのは `config.js` です。ここには秘密ではない受付URLだけを書いてリポジトリに含めます。GitHub Pages は gitignore でファイルを落とさないので、公開するURLは `config.js` にコミットします。

`config.example.js` は形だけの見本です。`gasUrl` は空で、サイトはこちらを読みません。空のURLでは送信せず、未実行のままにします。

Webhook やトークンはどちらにも書きません。`SLACK_WEBHOOK_URL` は GAS のスクリプトプロパティだけに置きます。

`gas/Code.gs` は既存の `postSlack_` があるプロジェクトへ足す雛形です。進捗シートは読み書きしません。受付は `e.parameter.payload` の JSON です。項目は `requestId`、`transactionId`、`slackThread`、5行の `memoLines`、`savedAt` です。金額と利用先は送りません。ブラウザは `application/x-www-form-urlencoded` の `payload` にその JSON を入れ、`text/plain` では送りません。

Slack スレッドは `https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-` に10桁、小数、6桁が続くものだけです。取引一覧のURLと一致しないものは送りません。再試行は同じ `requestId` を使い、受付済みの同じメモは再送しません。雛形の重複排除は PropertiesService に requestId を200件まで保持し、LockService と1時間30件の総量制限を使います。

GitHub Actions などの自動デプロイは使いません。`main` への反映は手作業です。

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
