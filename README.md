# UPSIDERモニター

AIハンド決済用カードのUPSIDERチェック結果を表示する静的サイトです。依存ライブラリはなく、GitHub Pages のルートにそのまま置けます。

公開URL: https://shiba-8ro.github.io/upsider-web/

GitHub Pages は `main` ブランチのルートを公開します。`main` へマージすると、同じURLの表示がこのモニターに置き換わります。

## 入っているもの

- 全17取引の一覧、ステータスフィルタ、件数と金額の集計
- 要対応8件の詳細、Slackスレッド（新しいタブ）、Drive証憑、参照用の注文画像
- メモ5欄と「クリップボードにコピー」（成功表示は2秒で消えます）
- 「AIがメモを追加する」は、取引ID・Slackスレッド・編集中の5行メモ（用途、セグメント1、セグメント2、分類、内容）を1件の実行依頼にします。`config.js` の受付URLが空のときは送信せず、未実行のままブラウザ内に保持します。URLがあるときは Google Apps Script の受付APIへ `text/plain` で送り、カードに送信中・受付済み・エラーを出します。受付後の処理と Slack 上の完了確認は証憑ゲッターロボ側です

正本データは `data/ledger.json` です。`assets/17600.jpg` と `assets/2659.jpg` は抽出元のJPEGが破損しているため、再生成せず破損のまま表示します。

## 受付API

1. `config.example.js` を `config.js` にコピーする。`config.js` は git の無視対象です。
2. `gasUrl` に、自分がデプロイした GAS ウェブアプリの `/exec` URL を書く。空のままなら送信しません。
3. Webhook やトークンは書かない。`SLACK_WEBHOOK_URL` は GAS のスクリプトプロパティだけに置く。
4. `gas/Code.gs` だけを、既存の `postSlack_` がある GAS プロジェクトへ追加する。進捗シートは読み書きしません。ウェブアプリはブラウザから POST できるデプロイにし、ページはプリフライトが要らない `text/plain` で送ります。

送信本文は `requestId`、`transactionId`、`slackThread`、改行付き5行の `memo` だけです。金額と利用先は送りません。Slack スレッドはチャンネル `C0BG07UF1EY` で、取引一覧のURLと一致するものだけ送ります。再試行は同じ `requestId` を使い、受付済みの同じメモは再送しません。

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
