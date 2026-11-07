# UPSIDERモニター

AIハンド決済用カードのUPSIDERチェック結果を表示する静的サイトです。依存ライブラリはなく、GitHub Pages のルートにそのまま置けます。

公開URL: https://shiba-8ro.github.io/upsider-web/

GitHub Pages は `main` ブランチのルートを公開します。`main` へマージすると、同じURLの表示がこのモニターに置き換わります。

## 入っているもの

- 全19取引の一覧、ステータスフィルタ、件数と金額の集計
- 要対応の詳細、Slackスレッド（新しいタブ）、Drive証憑、参照用の注文画像
- メモ5欄と「クリップボードにコピー」（成功表示は2秒で消えます）
- 「AIがメモを追加する」は、取引ID・Slackスレッド・編集中の5行メモ（用途、セグメント1、セグメント2、分類、内容）を1件の実行依頼にします。`config.js` の受付URLが空のときは送信せず、未実行のままブラウザ内に保持します。URLがあるときは `application/x-www-form-urlencoded` の `payload` に JSON を入れて受付APIへ送り、カードに送信中・処理中・確認停止・成功・変更なし・失敗・エラーを出します。受付後の実行そのものは証憑ゲッターロボ側です。このページは依頼IDだけで実行結果を照会し、保持中の実行依頼欄に成否・日本時間・詳細を表示します

正本データは `data/ledger.json` です。`assets/17600.jpg` と `assets/2659.jpg` は抽出元のJPEGが破損しているため、再生成せず破損のまま表示します。

## メモの有無

メモありにするのは、その取引の Slack スレッドで、UPSIDER アプリ自身が「メモを追加しました」または「決済メモを追加しました！」に相当する完了通知を出したときだけです。5項目のメモ本文が別に揃っていることは要りません。人間の引用、ボタン、「準備完了」は数えません。証憑の有無は別で、この判定には使いません。

細則は `docs/memo-presence.md`、判定そのものは `js/memo-presence.js` です。2026-11-07 13:59 の再走査では、完了通知があった17件をメモあり、通知が無かった DANBALLACE ¥7,160 を未確認、返金1件を対象外にしています。証憑の状態は変えていません。公開する `data/ledger.json` から、生の Slack ログとカード利用者IDは除いています。

## 最終取得日時

画面上部の「最終取得日時」は、台帳 `data/ledger.json` の `asOf` です。これはデータを取得して確認した時刻で、ページを開いた時刻やデプロイ時刻ではありません。証憑PDFをDriveへ保存した時刻は別欄です。`Asia/Tokyo`、`JST`、または協定世界時のオフセット付きの値は、記録された時刻のまま「（日本時間）」を付けます。秒がある値は秒まで残します。タイムゾーンの無い値は日本時間とみなさず「未取得」です。`asOf` が読めないときだけ、メモ再走査の `memoCheck.asOf` を同じ規則で使います。

「証憑保存済・Slack未添付」は、正式領収証をDriveへ保存したがSlackにはまだ添付していない状態です。登録完了にはしません。

上部の「指示」は4行の入力欄です。送信は「指示を送る」を押したときだけで、Enter や入力の途中では送りません。送る JSON は `kind` が `instruction` の別依頼で、メモ5行には混ぜません。本文フィールドは `text` です。暫定で400字までで、超えた文は切らずに送れない旨を出します。受付に成功しても作業完了ではありません。詳しくは `docs/instruction-forwarding.md` です。

## 受付API

公開サイトが読むのは `config.js` です。ここには秘密ではない受付URLだけを書いてリポジトリに含めます。GitHub Pages は gitignore でファイルを落とさないので、公開するURLは `config.js` にコミットします。

`config.example.js` は形だけの見本です。`gasUrl` は空で、サイトはこちらを読みません。空のURLでは送信せず、未実行のままにします。

Webhook やトークンはどちらにも書きません。`SLACK_WEBHOOK_URL` は GAS のスクリプトプロパティだけに置きます。

`gas/Code.gs` は既存の `postSlack_` があるプロジェクトへ足す雛形です。進捗シートは読み書きしません。受付は `e.parameter.payload` の JSON です。項目は `requestId`、`transactionId`、`slackThread`、5行の `memoLines`、`savedAt` です。金額と利用先は送りません。ブラウザは `application/x-www-form-urlencoded` の `payload` にその JSON を入れ、`text/plain` では送りません。

Slack スレッドは `https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-` に10桁、小数、6桁が続くものだけです。取引一覧のURLと一致しないものは送りません。受付の再試行は同じ `requestId` を使います。受付済み・処理中・確認停止・成功・変更なしの同じメモは再送しません。失敗のときだけ新しい `requestId` で送り直します。雛形の重複排除は PropertiesService に requestId を200件まで保持し、LockService と1時間30件の総量制限を使います。

受付後、ページは同じ受付URLへ `GET ?op=result&requestId=<uuid>` を送ります。パラメータはこの2つだけです。秘密鍵やトークンは付けません。15秒間隔で20回、その後は60秒間隔、受付から30分で自動確認を止めます。「結果を再確認」はそのとき1回だけ照会します。タブを隠している間は問い合わせません。終了した依頼は localStorage から復帰し、結果があるものは自動では再POSTしません。

表示に使うのは、`requestId` が一致するサーバー応答だけです。受付直後の表示は「受付済み」、照会を始めたあとは「処理中」です。`state:"done"` の `result.status` が `success` / `noop` / `failed` のときだけ、成功・変更なし・失敗と日本時間、`message` を出します。`message` は textContent で出します。`pending` と不正な応答では成否を出しません。`unknown` のときは記録がまだない注記だけです。成功などの文言をページ側で固定しません。色は成功と変更なしが薄緑、失敗が赤、処理中と確認停止が青系です。

デプロイ済みの同じ受付URLは、この照会を返します。未登録の UUID は `state:"unknown"`、結果がまだ無い受付は `state:"pending"`、終わった依頼は `state:"done"` です。`gas/Code.gs` はリポジトリ上の受付雛形のままで、実デプロイの `up_rid_` 管理とは別に置いてあります。ページが期待する応答と、テストの範囲は `docs/result-retrieval.md` にあります。

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

`npm test` は `tests/memo-presence.test.mjs`、`tests/acquired-at.test.mjs`、`tests/result.test.mjs`、`tests/monitor.test.mjs` です。最初はメモの有無（UPSIDER アプリ自身の完了通知だけを数え、5項目本文・人間の引用・ボタン・準備完了・証憑では決めないこと）を見ます。次は最終取得日時を日本時間と表示し、タイムゾーンが無い値を未取得にすること、トークン欄が無いことを見ます。その次は照会URL、応答の検証、依頼IDの一致、15秒から60秒、30分停止を見ます。最後は台帳と、ローカルの模擬受付での結果表示・再投稿防止・失敗時の新しい依頼ID・localStorage からの復帰・確認停止を見ます。模擬の `testPollMs` は `127.0.0.1` と `localhost` のときだけ使います。公開の `config.js` には書きません。テストは本番の受付URLへ接続しません。
