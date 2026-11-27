import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import {
  FILTERS,
  buildExecutionRequest,
  buildGasPayload,
  NOT_OWNER_STATUS,
  NOT_OWNER_STATUS_20261111,
  isNotOwnerStatus,
  actionSummary,
  needsAction,
  attachmentResultView,
  countOf,
  filterTransactions,
  shareRestrictionRemark,
  formatMemoText,
  formatYen,
  initialMemo,
  loadMemoDrafts,
  MEMO_FIELDS,
  MEMO_STORAGE_KEY,
  memoDefaults,
  memoSeedText,
  isAllowedSlackThread,
  isExecutionRequest,
  loadStoredRequests,
  migrateExecutionRequest,
  normalizeGasUrl,
  postGasPayload,
  resolveRequestId,
  slackChannelId,
  sumOf,
} from "../js/logic.js";

const EVIDENCE_URLS = {
  "tx-20261105-1703-amazon-2659": "https://drive.google.com/file/d/13SNvXcyjMoMFibt_iK6RzcgX9Dwyq47A/view?usp=drivesdk",
  "tx-20261105-2124-amazon-14680": "https://drive.google.com/file/d/1-lZG0HxIKsbPhlvU9ew3WJ5GoWKnjAhi/view?usp=drivesdk",
  "tx-20261105-2312-amazon-9300": "https://drive.google.com/file/d/1VFMPsL4QpbZ7FRdDBjp7rcVM-ftFQCF6/view?usp=drivesdk",
  "tx-20261105-2312-amazon-2117": "https://drive.google.com/file/d/16h4l3SGEsYCLrMz84jTQNJbTYVmOIXZi/view?usp=drivesdk",
  "tx-20261106-0113-amazon-255": "https://drive.google.com/file/d/1k3LODOYl00RGWjzcYuZeFs5shMS3vrya/view?usp=drivesdk",
};

const REFUND_ID = "tx-20261104-0923-danballace-23960";
const NEW_ORDER_ID = "tx-20261106-1553-danballace-7160";
const REFUND_STATUS = "返金（メモ・証憑不要）";

function hasEvidence(tx) {
  return tx.drive === "あり" || tx.drive.startsWith("https://drive.google.com/");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(fs.readFileSync(path.join(root, "data/ledger.json"), "utf8"));
const failures = [];
const gas = { configUrl: "", behavior: "ok", hits: [], gets: [], results: {}, interactionDetail: false };

function check(condition, message) {
  if (!condition) failures.push(message);
}

function startServer() {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jpg": "image/jpeg",
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/config.js") {
      const source = `window.UPSIDER_CONFIG = { gasUrl: ${JSON.stringify(gas.configUrl)}, testPollMs: 150 };\n`;
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(source);
      return;
    }
    if (pathname === "/mock-gas") {
      if (req.method === "GET") {
        const params = [...url.searchParams.keys()];
        const requestId = url.searchParams.get("requestId");
        const queue = gas.results[requestId];
        // テストが脚本を入れる前の確認は pending を返して数えない。脚本の件数と競合させない。
        if (!queue) {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, requestId, state: "pending" }));
          return;
        }
        gas.gets.push({ params, requestId });
        const next = queue.length > 1 ? queue.shift() : queue[0] || { state: "pending" };
        const body = next.raw !== undefined
          ? next.raw
          : JSON.stringify({ ok: true, requestId: next.requestId || requestId, ...next });
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(body);
        return;
      }
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        gas.hits.push({
          method: req.method,
          contentType: req.headers["content-type"] || "",
          headers: req.headers,
          body,
        });
        if (gas.behavior === "500") {
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          res.end("error");
          return;
        }
        if (gas.behavior === "html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<html>bad</html>");
          return;
        }
        if (gas.behavior === "reject") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(JSON.stringify(gas.rejectError ? { ok: false, error: gas.rejectError } : { ok: false }));
          return;
        }
        if (gas.behavior === "mismatch") {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(JSON.stringify({ ok: true, requestId: "other-id" }));
          return;
        }
        let requestId = "";
        try {
          requestId = JSON.parse(new URLSearchParams(body).get("payload")).requestId;
        } catch {
          requestId = "";
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, requestId }));
      });
      return;
    }
    if (pathname === "/data/ledger.json" && gas.interactionDetail) {
      const published = JSON.parse(fs.readFileSync(path.join(root, "data/ledger.json"), "utf8"));
      const tx = published.transactions.find((row) => row.id === NEW_ORDER_ID);
      tx.detailSection = true;
      published.details = [{
        transactionId: NEW_ORDER_ID,
        heading: "11/06 15:53 · DANBALLACE · ¥7,160",
        intro: "メモ操作の確認用。公開台帳の要対応詳細ではない。",
        properties: [
          { label: "利用先", value: "DANBALLACE" },
          { label: "金額", value: "¥7,160" },
          { label: "内容", value: tx.content },
          { label: "ステータス", value: tx.status },
          { label: "メモ", value: "あり" },
          { label: "Slackスレッド", value: tx.slack, kind: "slack" },
          { label: "Drive証憑", value: "なし" },
        ],
        image: null,
      }];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(published));
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function assertLedger() {
  check(ledger.transactions.length === 67, "ledger has 67 transactions");
  check(ledger.asOf === "2026-11-27T09:35:00+09:00", "asOf");
  check(ledger.dataAcquiredAt === "2026-11-27T09:35:00+09:00", "data acquired at");
  check(ledger.previousDataAcquiredAt === "2026-11-26T09:25:00+09:00", "previous acquisition kept");
  check(ledger.earlierDataAcquiredAt === "2026-11-25T15:30:00+09:00", "earlier acquisition kept");
  check(ledger.dataAcquiredAtLabel.includes("ブラウザで#bo_upsiderを読み取り確認した時刻（2026-11-27 09:35 JST）") && ledger.dataAcquiredAtLabel.includes("画面を更新した時刻やページを開いた時刻ではない") && ledger.dataAcquiredAtLabel.includes("領収証PDF1件と適格請求書PDF1件を本文なしで添付し、UPSIDER「領収証を添付しました」を確認した。メモ登録はしていない。") && !ledger.dataAcquiredAtLabel.includes("領収書PDF6件"), "acquisition label");
  check(ledger.lead.startsWith("最新データ確認 2026-11-27 09:35 JST"), "lead check time");
  check(ledger.lead.includes("ブラウザで#bo_upsiderを読んだ時刻") && ledger.lead.includes("メモ作成は行っていない"), "lead is the slack read time");
  check(ledger.lead.includes("登録完了22件"), "lead registered count");
  check(ledger.lead.includes("要処理39件"), "lead action count");
  check(ledger.lead.includes("台帳67件"), "lead ledger count");
  check(ledger.lead.includes("除外6件（返金2件、本人以外の課金4件）"), "lead exclusion");
  check(ledger.lead.includes("09:25以降、AIハンド決済用（柴田 善広）の新規カードは検索で見つからなかった") && ledger.lead.includes("南里さん決済用4件・SaaS決済用2件で対象外") && ledger.lead.includes("Slack検索で「決済メモを追加しました！」は0件") && ledger.lead.includes("チャンネル表示が11/21以降を読み込まなかったため、既存スレッドの返信は全件を開いて確認できておらず未確認") && ledger.lead.includes("2026-11-27 09:33 JST") && ledger.lead.includes("09:33にUPSIDER「領収証を添付しました」") && ledger.lead.includes("投稿者UPSIDER、事業者名 株式会社ＭｏｎｏｔａＲＯ") && ledger.lead.includes("メモ・証憑なしからメモなし") && ledger.lead.includes("20261125_27779JPY_モノタロウ_領収証.pdf") && ledger.lead.includes("領収証No.B8640408") && ledger.lead.includes("T6140001054380") && ledger.lead.includes("納入済（11/26納品書受領）") && ledger.lead.includes("2026-11-27 09:32 JST") && ledger.lead.includes("09:32にUPSIDER「領収証を添付しました」") && ledger.lead.includes("20261125_6741JPY_Amazon_適格請求書.pdf") && ledger.lead.includes("株式会社ユーグリーン・ジャパン") && ledger.lead.includes("T7010901052842") && ledger.lead.includes("納入済（11/26配達完了）") && ledger.lead.includes("メモ初期値は変えていない") && ledger.lead.includes("注文134323400043") && ledger.lead.includes("注文503-5003530-6750248") && ledger.lead.includes("注文EC261126-005510194") && ledger.lead.includes("ゆうパック144947082545") && ledger.lead.includes("注文249-5533807-4183815") && ledger.lead.includes("出荷済（11/27発送）・納入待ち") && ledger.lead.includes("ステータス・Driveを変えていない") && ledger.lead.includes("メモ登録はしていない") && ledger.lead.includes("確認決済（¥0）3件") && ledger.lead.includes("メモなし23件") && ledger.lead.includes("証憑なし1件") && ledger.lead.includes("証憑保存済・Slack未添付0件") && ledger.lead.includes("メモ・証憑なし12件") && ledger.lead.includes("要処理39件（¥0確認決済3件を含む）") && ledger.lead.includes("メモあり24件") && !ledger.lead.includes("新規の対象取引は1件") && !ledger.lead.includes("3b095d66-6f9f") && !ledger.lead.includes("410abe0e-6a95"), "lead records two receipts and no new in-scope card");
  check(!ledger.lead.includes("本決済¥2,399はSlack未着"), "lead does not describe the settled amazon charge as unarrived");
  check(ledger.lead.includes("メモあり24件"), "lead memo counts");
  check(!("tokenUsage" in ledger), "token usage is not stored");
  check(JSON.stringify(ledger.callouts.map((item) => item.lead)) === JSON.stringify([
    "運用メモ",
    "今回のチェック（11/27 09:35）",
    "前回のチェック（11/26 09:25）",
    "前回のチェック（11/25 15:30）",
    "前回のチェック（11/25 09:11）",
    "前回のチェック（11/24 09:15）",
    "前回のチェック（11/23 09:24）",
    "前回のチェック（11/22 09:14）",
    "前回のチェック（11/21 09:13）",
    "前回のチェック（11/20 09:20）",
    "前回のチェック（11/19 09:20）",
    "前回のチェック（11/18 13:40）",
    "前回のチェック（11/18 09:12）",
    "前回のチェック（11/17 18:09）",
    "前回のチェック（11/17 09:18）",
    "前回のチェック（11/16 16:30）",
    "前回のチェック（11/16 09:16）",
    "前回のチェック（11/16 00:02）",
    "前回のチェック（11/15 22:45）",
    "前回のチェック（11/14 09:20）",
    "前回のチェック（11/13 19:30）",
    "前回のチェック（11/13 09:21）",
    "前回のチェック（11/12 09:20）",
    "前回のチェック（11/11 18:47）",
    "前回のチェック（11/11 09:34）",
    "前回のチェック（11/10 13:40）",
    "前回のチェック（11/10 09:06）",
    "前回のチェック（11/09 22:55）",
    "前回のチェック（11/09 22:25）",
    "前回のチェック（11/09 16:25）",
    "前回のチェック（11/09 15:59）",
    "前回のチェック（11/09 15:31）",
    "前回のチェック（11/09 09:26）",
    "前回のチェック（11/08 AM9）",
    "前回のチェック（11/06 19:25）",
    "前回のチェック（11/07 AM9）",
    "メモ判定ルール更新・1回再走査",
    "過去の取得経路の記録（解消済）",
    "ミスミ領収書取得成功",
    "過去のSlack添付（11/07・共有制限で停止）",
  ]), `callout titles ${ledger.callouts.map((item) => item.lead).join(" / ")}`);
  const check1340 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/18 13:40）");
  check(check1340?.lead === "前回のチェック（11/18 13:40）" && check1340.tone === "info" && check1340.body.includes("臨時巡回") && check1340.body.includes("2026-11-18 13:36〜13:40 JST") && check1340.body.includes("20261114_3267JPY_ミスミ_領収書・ご注文明細書.pdf") && check1340.body.includes("T9010601030898") && check1340.body.includes("AB25764G15") && check1340.body.includes("伝票157126") && check1340.body.includes("1794597997.191909") && check1340.body.includes("14_TTkidrivNihVuK-XlJ3AYKZ2SdGRDw") && check1340.body.includes("20261116_8965JPY_モノタロウ_領収証.pdf") && check1340.body.includes("B8577710") && check1340.body.includes("134323400039") && check1340.body.includes("消費税¥815") && check1340.body.includes("発行11/18") && check1340.body.includes("1794828450.137609") && check1340.body.includes("1FY1uyx71ydI4TL_i742Y21xmUFuG5xwj") && check1340.body.includes("20261116_2109JPY_モノタロウ_領収証.pdf") && check1340.body.includes("B8577714") && check1340.body.includes("134323400040") && check1340.body.includes("消費税¥192") && check1340.body.includes("1794828652.010539") && check1340.body.includes("1C9fkIqkyZusE-U80UvHXNBP-Qwrap2z8") && check1340.body.includes("本文なし") && check1340.body.includes("領収証を添付しました") && check1340.body.includes("メモ・証憑なしからメモなし") && check1340.body.includes("3/3点出荷済") && check1340.body.includes("664365576162") && check1340.body.includes("504504937856") && check1340.body.includes("返信0件のまま") && check1340.body.includes("出荷11/18予定") && check1340.body.includes("出荷11/19予定") && check1340.body.includes("RUNPOD.IO ¥8,157") && check1340.body.includes("DP4*RAKSUL ¥7,805") && check1340.body.includes("行は追加しない") && check1340.body.includes("メモなし11件") && check1340.body.includes("メモ・証憑なし7件") && check1340.body.includes("要処理22件") && check1340.body.includes("メモ作成は行っていない") && !check1340.body.includes("シバタさんの手動作業として残す"), "afternoon patrol attached three receipts");
  const check0920 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/19 09:20）");
  check(check0920?.lead === "前回のチェック（11/19 09:20）" && check0920.tone === "info" && check0920.body.includes("2026-11-19 09:20 JST") && check0920.body.includes("3b095d66-3f9f-4533-a0f7-b8cc2d78b8b4") && check0920.body.includes("410abe0e-c611-469b-a370-6d0218586a7b") && check0920.body.includes("f1e71f7a-6703-49a0-beca-c4d2aecff099") && check0920.body.includes("1795004853.355139") && check0920.body.includes("1795007515.663979") && check0920.body.includes("1795008891.260349") && check0920.body.includes("TX-20261118-MSM-001") && check0920.body.includes("TX-20261118-TRG-001") && check0920.body.includes("TX-20261118-MSM-002") && check0920.body.includes("AB25793G31") && check0920.body.includes("EC261118-003952982") && check0920.body.includes("AB257941F8") && check0920.body.includes("YUBI-GLOVE") && check0920.body.includes("YUBI_PRODUCT") && check0920.body.includes("T9122001004975") && check0920.body.includes("C-AJKTNA5-70") && check0920.body.includes("C0002F110030012003") && check0920.body.includes("GUTBS-A7-E20-M3-F4.5-L12") && check0920.body.includes("GUTBRY3-3.5-6") && check0920.body.includes("134323400041-01") && check0920.body.includes("0417678150805") && check0920.body.includes("ANTHROPIC* CLAUDE SUB ¥35,892") && check0920.body.includes("南里 勇気") && check0920.body.includes("HANABI AI INC. ¥16,314") && check0920.body.includes("行は追加しない") && check0920.body.includes("メモ・証憑なし10件") && check0920.body.includes("要処理25件") && check0920.body.includes("証憑の新規添付はなし") && check0920.body.includes("メモ作成は行っていない") && !check0920.body.includes("3b095d66-6f9f") && !check0920.body.includes("410abe0e-6a95"), "morning check added three cards");
  const check0912 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/18 09:12）");
  check(check0912?.lead === "前回のチェック（11/18 09:12）" && check0912.tone === "info" && check0912.body.includes("2026-11-18 09:12 JST") && check0912.body.includes("20261113_20900JPY_ウィルコ_適格請求書.pdf") && check0912.body.includes("09:11 JST") && check0912.body.includes("T5020001036961") && check0912.body.includes("20261115_2198JPY_モノタロウ_領収証.pdf") && check0912.body.includes("20261116_1868JPY_モノタロウ_領収証.pdf") && check0912.body.includes("20261115_49704JPY_Amazon_適格請求書.pdf") && check0912.body.includes("T3040001028447") && check0912.body.includes("20261114_5003JPY_Amazon_適格請求書.pdf") && check0912.body.includes("本文なし") && check0912.body.includes("領収証を添付しました") && check0912.body.includes("メモなし") && check0912.body.includes("1794907398.336749") && check0912.body.includes("134323400041") && check0912.body.includes("203116497") && check0912.body.includes("TX-20261117-MNT-001") && check0912.body.includes("消費税¥999") && check0912.body.includes("664365576162") && check0912.body.includes("504504937856") && check0912.body.includes("1794907870.190879") && check0912.body.includes("AB257842A7") && check0912.body.includes("TX-20261117-MSM-001") && check0912.body.includes("LEAP_DEV") && check0912.body.includes("消費税¥716") && check0912.body.includes("VERCEL INC. ¥3,595") && check0912.body.includes("USD 22.00") && check0912.body.includes("SHEIN.COM ¥21,461") && check0912.body.includes("GITHUB, INC. ¥598") && check0912.body.includes("RUNPOD.IO ¥8,171") && check0912.body.includes("メモあり・証憑なしのまま") && check0912.body.includes("要処理22件") && !check0912.body.includes("シバタさんの手動作業として残す"), "morning check attached five receipts and added two cards");
  const check1809 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/17 18:09）");
  check(check1809?.tone === "info" && check1809.body.includes("臨時巡回") && check1809.body.includes("2026-11-17 18:09 JST") && check1809.body.includes("新しい決済メモ完了通知・領収証添付通知はなし") && check1809.body.includes("Amazon ¥5,003・¥49,704、ウィルコ ¥20,900、MonotaRO ¥2,198・¥1,868") && check1809.body.includes("証憑保存済・Slack未添付") && check1809.body.includes("Slack未添付・メモ未登録") && check1809.body.includes("AIハンド決済用の新規カードはなし") && check1809.body.includes("出荷状況（MonotaRO ¥17,151・¥8,965・¥2,109、ミスミ ¥3,267）") && check1809.body.includes("SHEIN.COM ¥21,461") && check1809.body.includes("吉野 哲仁") && check1809.body.includes("GITHUB, INC. ¥598") && check1809.body.includes("USD 3.66") && check1809.body.includes("RUNPOD.IO ¥8,171") && check1809.body.includes("USD 50.00") && check1809.body.includes("JLCPCB ¥25,017は証憑台帳未登録・金額照合未確認のまま") && check1809.body.includes("シバタさんの手動作業として残す"), "ad-hoc patrol saved five receipts and updated shipments");
  const check1530 = ledger.callouts[3];
  const check1125 = ledger.callouts[4];
  const check0926 = ledger.callouts[2];
  const check0935 = ledger.callouts[1];
  check(check0935?.lead === "今回のチェック（11/27 09:35）" && check0935.tone === "info" && check0935.body.includes("2026-11-27 09:28〜09:40 JST") && check0935.body.includes("新規の対象取引はなし") && check0935.body.includes("柴田 善広") && check0935.body.includes("南里さん決済用4件") && check0935.body.includes("SaaS決済用2件") && check0935.body.includes("Slack検索で「決済メモを追加しました！」は0件") && check0935.body.includes("チャンネル表示が11/21以降を読み込まなかった") && check0935.body.includes("未確認") && check0935.body.includes("54a7b93c-8407-426b-8340-a73193272732") && check0935.body.includes("1795509059.782579") && check0935.body.includes("134323400043") && check0935.body.includes("1roziQlZi3XlXycPfboY2xGenPlCXYlE-") && check0935.body.includes("B8640408") && check0935.body.includes("T6140001054380") && check0935.body.includes("株式会社ＭｏｎｏｔａＲＯ") && check0935.body.includes("09780592-5a0f-452c-b5a4-5c452d61bdf5") && check0935.body.includes("1795595533.522609") && check0935.body.includes("503-5003530-6750248") && check0935.body.includes("1qw_sTud4m3-oXg0_MPCqIICbxxzipG8H") && check0935.body.includes("株式会社ユーグリーン・ジャパン") && check0935.body.includes("T7010901052842") && check0935.body.includes("領収証を提出しています") && check0935.body.includes("納入済（11/26納品書受領）") && check0935.body.includes("納入済（11/26配達完了）") && check0935.body.includes("ゆうパック144947082545") && check0935.body.includes("出荷済（11/27発送）・納入待ち") && check0935.body.includes("ステータス・Driveを変えていない") && check0935.body.includes("メモなし23件") && check0935.body.includes("メモ・証憑なし12件") && check0935.body.includes("要処理39件") && check0935.body.includes("メモあり24件") && check0935.body.includes("登録完了にはしていない") && check0935.body.includes("メモ作成は行っていない"), "morning check attached two receipts and found no new in-scope card");
  check(check0926?.lead === "前回のチェック（11/26 09:25）" && check0926.tone === "info" && check0926.body.includes("2026-11-26 09:14〜09:25 JST") && check0926.body.includes("新規の対象取引は6件") && check0926.body.includes("柴田 善広") && check0926.body.includes("09780592-5a0f-452c-b5a4-5c452d61bdf5") && check0926.body.includes("1795595533.522609") && check0926.body.includes("503-5003530-6750248") && check0926.body.includes("YUBIGB製造") && check0926.body.includes("19b34e45-12d8-4ee6-9750-e4953a8ab822") && check0926.body.includes("134323400044") && check0926.body.includes("製造用測定機") && check0926.body.includes("0172ab5c-0cbd-492f-89c6-0f764d44e08e") && check0926.body.includes("134323400045") && check0926.body.includes("YUBI製造収納用品") && check0926.body.includes("91cef89e-f5c6-4c5d-b558-14c06945e572") && check0926.body.includes("EC261126-005510194") && check0926.body.includes("f2bf7ae4-6339-4241-aca1-c7104499106b") && check0926.body.includes("134323400046") && check0926.body.includes("製造用治具") && check0926.body.includes("2bbba167-607e-42a7-b58b-4f5767df1ce5") && check0926.body.includes("249-5533807-4183815") && check0926.body.includes("1795652205.005089") && check0926.body.includes("1jPikRC23S8CWCtqeS-LqUca-QrrUXMrK") && check0926.body.includes("T6010001130095") && check0926.body.includes("投稿者UPSIDER") && check0926.body.includes("納入済（11/24同梱納品書受領）") && check0926.body.includes("メモ・証憑なしからメモなし") && check0926.body.includes("既存30スレッド") && check0926.body.includes("ほかに新規の対象外カードはない") && check0926.body.includes("台帳67件") && check0926.body.includes("メモなし21件") && check0926.body.includes("メモ・証憑なし14件") && check0926.body.includes("要処理39件") && check0926.body.includes("メモあり24件") && check0926.body.includes("メモ作成は行っていない") && check0926.body.includes("登録完了にはしていない"), "morning check added six cards and attached the switch science invoice");
  check(check1530?.lead === "前回のチェック（11/25 15:30）" && check1530.tone === "info" && check1530.body.includes("2026-11-25 15:23〜15:30 JST") && check1530.body.includes("臨時更新") && check1530.body.includes("新規の対象取引はなし") && check1530.body.includes("09:11以降の新規カードはない") && check1530.body.includes("決済メモを追加しました！") && check1530.body.includes("領収証を添付しました") && check1530.body.includes("1795509059.782579") && check1530.body.includes("134323400043") && check1530.body.includes("1795350377.941919") && check1530.body.includes("134323400042") && check1530.body.includes("1795373587.639099") && check1530.body.includes("EC261123-004790140") && check1530.body.includes("1795340512.381139") && check1530.body.includes("スイッチサイエンス ¥3,560") && check1530.body.includes("tx-20261115-2152-switchscience-3560") && check1530.body.includes("返信は0件") && check1530.body.includes("11/24 09:11〜09:14の領収証添付のみ（決済メモなし）") && check1530.body.includes("tx-20261113-1023-monotaro-1318") && check1530.body.includes("tx-20261115-2230-monotaro-17151") && check1530.body.includes("tx-20261117-1831-misumi-7878") && check1530.body.includes("tx-20261118-2234-misumi-5984") && check1530.body.includes("tx-20261119-1514-misumi-8745") && check1530.body.includes("tx-20261118-2127-misumi-10890") && check1530.body.includes("ステータス・メモ・Driveリンク・メモ初期値は変えていない") && check1530.body.includes("納入状況だけ更新") && check1530.body.includes("ヤマト504506485652") && check1530.body.includes("一部納入（コンテナFCLD50-GR/C×3・台車×1は納品書受領、フタ×2は12/02出荷予定）") && check1530.body.includes("出荷済（11/24ツルガ出荷明細書受領・納入未確認）") && check1530.body.includes("納品書・出荷明細書は会計上の証憑ではない") && check1530.body.includes("この実行での証憑添付・メモ登録はしていない") && check1530.body.includes("SWITCHSCIENCE ¥4,334") && check1530.body.includes("対象外の新規カードはない") && check1530.body.includes("行は追加しない") && check1530.body.includes("台帳61件") && check1530.body.includes("メモ・証憑なし9件") && check1530.body.includes("要処理33件") && check1530.body.includes("メモあり24件") && check1530.body.includes("メモ作成は行っていない") && check1530.body.includes("新しい返金はない"), "ad-hoc check updated three deliveries and attached nothing");
  check(check1125?.lead === "前回のチェック（11/25 09:11）" && check1125.tone === "info" && check1125.body.includes("2026-11-25 09:05〜09:11 JST") && check1125.body.includes("新規の対象取引は1件") && check1125.body.includes("柴田 善広") && check1125.body.includes("DP12*MONOTARO.COM") && check1125.body.includes("1795509059.782579") && check1125.body.includes("54a7b93c-8407-426b-8340-a73193272732") && check1125.body.includes("TX-20261124-MNT-001") && check1125.body.includes("134323400043") && check1125.body.includes("203594336") && check1125.body.includes("230706540") && check1125.body.includes("YUBI Glove 資材") && check1125.body.includes("U3H-H042BK/E") && check1125.body.includes("13137315") && check1125.body.includes("¥2,525") && check1125.body.includes("受付（出荷予定11/25まで）・未出荷") && check1125.body.includes("決済メモを追加しました！") && check1125.body.includes("領収証を添付しました") && check1125.body.includes("この実行での証憑添付・メモ登録はしていない") && check1125.body.includes("既存の要処理32件") && check1125.body.includes("SWITCHSCIENCE ¥4,334") && check1125.body.includes("Amazon ¥297") && check1125.body.includes("Amazon ¥2,749") && check1125.body.includes("吉野 哲仁") && check1125.body.includes("NOTION ¥59,479") && check1125.body.includes("GITHUB* CARD VERIFY ¥8,151") && check1125.body.includes("GOOGLE*CLOUD ¥10,000") && check1125.body.includes("行は追加しない") && check1125.body.includes("台帳61件") && check1125.body.includes("メモ・証憑なし9件") && check1125.body.includes("要処理33件") && check1125.body.includes("メモあり24件") && check1125.body.includes("メモ作成は行っていない") && check1125.body.includes("新しい返金はない") && check1125.body.includes("ステータス・メモ・Driveリンク・メモ初期値は変えていない"), "morning check added the monotaro hub");
  const check1124 = ledger.callouts[5];
  check(check1124?.lead === "前回のチェック（11/24 09:15）" && check1124.tone === "info" && check1124.body.includes("2026-11-24 09:09〜09:15 JST") && check1124.body.includes("新規の対象取引はなし") && check1124.body.includes("柴田 善広") && check1124.body.includes("DP04*NEJIKURU") && check1124.body.includes("1795373587.639099") && check1124.body.includes("決済メモを追加しました！") && check1124.body.includes("本文なし") && check1124.body.includes("領収証を添付しました") && check1124.body.includes("メモ・証憑なしからメモなし") && check1124.body.includes("登録完了にはしていない") && check1124.body.includes("1794533037.399359") && check1124.body.includes("134323400033") && check1124.body.includes("20261113_1318JPY_モノタロウ_領収書.pdf") && check1124.body.includes("14HAJ9q8lo9D0P9_q4Jyd_bPb0UkRHe_b") && check1124.body.includes("1794749424.750489") && check1124.body.includes("134323400036") && check1124.body.includes("20261116_17151JPY_モノタロウ_領収書.pdf") && check1124.body.includes("1XIVDIGU0zWNbBGqs963Pk0w6p1kx25KU") && check1124.body.includes("1794907870.190879") && check1124.body.includes("AB257842A7") && check1124.body.includes("20261119_7878JPY_ミスミ_領収書.pdf") && check1124.body.includes("1rLnzRF_kUaYGb144MEqicOLd4qSV_ALJ") && check1124.body.includes("1795004853.355139") && check1124.body.includes("AB25793G31") && check1124.body.includes("20261120_10890JPY_ミスミ_領収書.pdf") && check1124.body.includes("1v6iwd4daq__eE91WVpkphFosckTQVXnH") && check1124.body.includes("空の返信は削除していない") && check1124.body.includes("1795008891.260349") && check1124.body.includes("AB257941F8") && check1124.body.includes("20261120_5984JPY_ミスミ_領収書.pdf") && check1124.body.includes("1Eq5RJc9S79ufmXM-dmNLesk4p0dF0-uD") && check1124.body.includes("1795068864.053439") && check1124.body.includes("AB2579CG2E") && check1124.body.includes("20261120_8745JPY_ミスミ_領収書.pdf") && check1124.body.includes("1RWaABcq5SLCutj65GFWn0rrMxGn_4D4Q") && check1124.body.includes("株式会社ＭｏｎｏｔａＲＯ") && check1124.body.includes("T6140001054380") && check1124.body.includes("株式会社ミスミ") && check1124.body.includes("T9010601030898") && check1124.body.includes("他の要処理26件") && check1124.body.includes("メモなし14件、メモ・証憑なし8件、証憑なし1件、確認決済（¥0）3件") && check1124.body.includes("メモなし20件") && check1124.body.includes("メモ・証憑なし8件") && check1124.body.includes("要処理32件") && check1124.body.includes("メモあり24件") && check1124.body.includes("メモ作成は行っていない") && check1124.body.includes("新しい返金はない") && check1124.body.includes("行は追加しない"), "morning check attached six receipts");
  const check1123 = ledger.callouts[6];
  check(check1123?.lead === "前回のチェック（11/23 09:24）" && check1123.tone === "info" && check1123.body.includes("2026-11-23 09:24 JST") && check1123.body.includes("新規の対象取引は3件") && check1123.body.includes("柴田 善広") && check1123.body.includes("1795340512.381139") && check1123.body.includes("DHL JAPAN, INC.") && check1123.body.includes("TX-20261117-JLC-001") && check1123.body.includes("W2026111623018994") && check1123.body.includes("5343843293") && check1123.body.includes("222815396-126505698") && check1123.body.includes("1795350377.941919") && check1123.body.includes("DP12*MONOTARO.COM") && check1123.body.includes("TX-20261122-MNT-001") && check1123.body.includes("134323400042") && check1123.body.includes("資材収納用品") && check1123.body.includes("FCLD50-GR/C") && check1123.body.includes("50GN") && check1123.body.includes("52666618") && check1123.body.includes("12/02入荷待ち") && check1123.body.includes("1795373587.639099") && check1123.body.includes("DP04*NEJIKURU") && check1123.body.includes("TX-20261123-TRG-001") && check1123.body.includes("EC261123-004790140") && check1123.body.includes("サンコータイト") && check1123.body.includes("2.3×8 ×8,000") && check1123.body.includes("2.3×6 ×1,000") && check1123.body.includes("返信は0件") && check1123.body.includes("決済メモを追加しました！") && check1123.body.includes("領収証を添付しました") && check1123.body.includes("メモ・証憑なし") && check1123.body.includes("既存の要処理26スレッド") && check1123.body.includes("メモなし14件、メモ・証憑なし11件、証憑なし1件") && check1123.body.includes("新しい返信・UPSIDER通知はなかった") && check1123.body.includes("AMAZON CO JP ¥8,862") && check1123.body.includes("ECサイト決済用") && check1123.body.includes("1PASSWORD ¥4,893") && check1123.body.includes("USD 29.95") && check1123.body.includes("SaaS決済用") && check1123.body.includes("AMAZON CO JP ¥10,220") && check1123.body.includes("イベント事業決済用") && check1123.body.includes("吉野 哲仁") && check1123.body.includes("行は追加しない") && check1123.body.includes("この実行での証憑添付・メモ登録はしていない") && check1123.body.includes("ステータス・メモ・Driveリンク・メモ初期値は変えていない") && check1123.body.includes("台帳60件") && check1123.body.includes("登録完了22件") && check1123.body.includes("メモなし14件") && check1123.body.includes("証憑なし1件") && check1123.body.includes("メモ・証憑なし14件") && check1123.body.includes("要処理32件") && check1123.body.includes("確認決済（¥0）3件") && check1123.body.includes("証憑保存済・Slack未添付0件") && check1123.body.includes("メモあり24件") && check1123.body.includes("メモ作成は行っていない") && check1123.body.includes("新しい返金はない") && check1123.body.includes("DHL JAPAN ¥31,900"), "morning check added three cards");
  const check1122 = ledger.callouts[7];
  check(check1122?.lead === "前回のチェック（11/22 09:14）" && check1122.tone === "info" && check1122.body.includes("2026-11-22 09:14 JST") && check1122.body.includes("新規の対象取引はなし") && check1122.body.includes("柴田 善広") && check1122.body.includes("既存の要処理26スレッド") && check1122.body.includes("メモなし14件、メモ・証憑なし11件、証憑なし1件") && check1122.body.includes("新しい返信・UPSIDER通知はなかった") && check1122.body.includes("TRIPO AI ¥3,200") && check1122.body.includes("AIトイ決済用") && check1122.body.includes("池滝 俊太") && check1122.body.includes("OPENAI ¥30,000") && check1122.body.includes("南里さん決済用") && check1122.body.includes("GITHUB ¥117") && check1122.body.includes("SaaS決済用") && check1122.body.includes("行は追加しない") && check1122.body.includes("この実行での証憑添付・メモ登録はしていない") && check1122.body.includes("ステータス・メモ・Driveリンク・メモ初期値は変えていない") && check1122.body.includes("台帳57件") && check1122.body.includes("登録完了22件") && check1122.body.includes("メモなし14件") && check1122.body.includes("証憑なし1件") && check1122.body.includes("メモ・証憑なし11件") && check1122.body.includes("要処理29件") && check1122.body.includes("確認決済（¥0）3件") && check1122.body.includes("証憑保存済・Slack未添付0件") && check1122.body.includes("メモあり24件") && check1122.body.includes("メモ作成は行っていない") && check1122.body.includes("新しい返金はない"), "previous morning found no in-scope card");
  const check1121 = ledger.callouts[8];
  check(check1121?.lead === "前回のチェック（11/21 09:13）" && check1121.tone === "info" && check1121.body.includes("2026-11-21 09:13 JST") && check1121.body.includes("1795161298.269269") && check1121.body.includes("確認決済（¥0、本決済¥691,525は別行）") && check1121.body.includes("返信は0件") && check1121.body.includes("1795161320.143969") && check1121.body.includes("PAYPAL *SEEEDDENWGW") && check1121.body.includes("TX-20261120-SEE-001") && check1121.body.includes("5000005852") && check1121.body.includes("池滝 俊太") && check1121.body.includes("Iwasaki_BO/Secretary") && check1121.body.includes("invoice.pdf") && check1121.body.includes("ファイルサイズ超過") && check1121.body.includes("AIハンド その他") && check1121.body.includes("領収証を添付しました") && check1121.body.includes("発行事業者・登録番号は読めない") && check1121.body.includes("Driveコピーはない") && check1121.body.includes("決済メモを追加しました！") && check1121.body.includes("人間の投稿はメモ完了に数えない") && check1121.body.includes("Lenovo先例") && check1121.body.includes("分類は研究開発") && check1121.body.includes("既存の要処理27スレッド") && check1121.body.includes("RUNPOD.IO ¥8,175×2") && check1121.body.includes("GOOGLE*CLOUD ¥3,200") && check1121.body.includes("LENOVO.COM JP EPRO ¥296,010") && check1121.body.includes("00:54") && check1121.body.includes("行は追加しない") && check1121.body.includes("台帳57件") && check1121.body.includes("メモなし14件") && check1121.body.includes("証憑なし1件") && check1121.body.includes("メモ・証憑なし11件") && check1121.body.includes("要処理29件") && check1121.body.includes("確認決済（¥0）3件") && check1121.body.includes("証憑保存済・Slack未添付0件") && check1121.body.includes("メモあり24件") && check1121.body.includes("メモ作成は行っていない") && check1121.body.includes("この実行での証憑添付・メモ登録はしていない"), "morning check added the paypal confirmation and the seeed charge");
  const check1120 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/20 09:20）");
  check(check1120?.lead === "前回のチェック（11/20 09:20）" && check1120.tone === "info" && check1120.body.includes("2026-11-20 09:20 JST") && check1120.body.includes("1794498836.125669") && check1120.body.includes("20261118_18678JPY_モノタロウ_領収書.pdf") && check1120.body.includes("1Y5WO-yG7fNzyngrM28mWlfXYHqmvM_6k") && check1120.body.includes("T6140001054380") && check1120.body.includes("領収日11/18") && check1120.body.includes("09:12 JST") && check1120.body.includes("証憑なしから登録完了") && check1120.body.includes("2026-11-15 23:18:16") && check1120.body.includes("1794907398.336749") && check1120.body.includes("20261118_10993JPY_モノタロウ_領収書.pdf") && check1120.body.includes("1MUWn04F3yOWXxvOMVlaSk81fRkFqqvUZ") && check1120.body.includes("134323400041-01・-02") && check1120.body.includes("メモ・証憑なしからメモなし") && check1120.body.includes("a9455490-07a5-43e6-9f4f-539dd9e7ba31") && check1120.body.includes("1795099892.731619") && check1120.body.includes("TX-20261119-JTB-001") && check1120.body.includes("326396607015686001") && check1120.body.includes("T3010005015907") && check1120.body.includes("1fS-9JJg5NQP5erWS3KWWxZujpLrItD5w") && check1120.body.includes("09:13 JST") && check1120.body.includes("258c756f-c5c5-4ea8-8ddb-d8f815056655") && check1120.body.includes("1795068864.053439") && check1120.body.includes("TX-20261119-MSM-001") && check1120.body.includes("AB2579CG2E") && check1120.body.includes("PACK-HNTTSS5-5") && check1120.body.includes("ffe416c0-a54c-48b1-9b5b-c6fa97dbdd54") && check1120.body.includes("1795113960.072679") && check1120.body.includes("TX-20261120-ADM-001") && check1120.body.includes("adam.new") && check1120.body.includes("GITHUB, INC. ¥549") && check1120.body.includes("RUNPOD.IO ¥8,160×3") && check1120.body.includes("DHL JAPAN ¥31,900") && check1120.body.includes("池滝 俊太") && check1120.body.includes("AMAZON CO JP ¥0・¥18,490・¥4,027") && check1120.body.includes("吉野 哲仁") && check1120.body.includes("行は追加しない") && check1120.body.includes("メモなし13件") && check1120.body.includes("証憑なし1件") && check1120.body.includes("メモ・証憑なし11件") && check1120.body.includes("要処理27件") && check1120.body.includes("証憑保存済・Slack未添付0件") && check1120.body.includes("メモ作成は行っていない") && check1120.body.includes("本文なし"), "morning check attached three receipts and added three cards");
  check(ledger.callouts[1]?.lead === "今回のチェック（11/27 09:35）", "morning check is first");
  check(ledger.callouts[2]?.lead === "前回のチェック（11/26 09:25）", "26th morning kept one step back");
  check(ledger.callouts[3]?.lead === "前回のチェック（11/25 15:30）", "ad-hoc check kept one step back");
  check(ledger.callouts[4]?.lead === "前回のチェック（11/25 09:11）", "morning check kept one step back");
  check(ledger.callouts[5]?.lead === "前回のチェック（11/24 09:15）", "previous morning kept one step back");
  check(ledger.callouts[6]?.lead === "前回のチェック（11/23 09:24）", "earlier morning kept one step back");
  check(ledger.callouts[7]?.lead === "前回のチェック（11/22 09:14）", "prior morning kept one step back");
  check(ledger.callouts[8]?.lead === "前回のチェック（11/21 09:13）", "older morning kept one step back");
  check(ledger.callouts[9]?.lead === "前回のチェック（11/20 09:20）", "20th morning kept one step back");
  check(ledger.callouts[10]?.lead === "前回のチェック（11/19 09:20）", "19th morning kept one step back");
  check(ledger.callouts[11]?.lead === "前回のチェック（11/18 13:40）", "afternoon patrol kept one step back");
  check(ledger.callouts[12]?.lead === "前回のチェック（11/18 09:12）", "morning check kept one step back");
  check(ledger.callouts[13]?.lead === "前回のチェック（11/17 18:09）", "evening patrol kept one step back");
  check(ledger.callouts[14]?.lead === "前回のチェック（11/17 09:18）", "morning callout kept one step back");
  const check0918 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/17 09:18）");
  check(check0918?.tone === "info" && check0918.body.includes("MonotaRO ¥439・¥3,953とAmazon ¥3,080の証憑を2026-11-17 09:12〜09:15 JSTにスレッドへ本文なしで添付し、3件ともUPSIDER「領収証を添付しました」を確認。") && check0918.body.includes("メモ未登録のためステータスはメモなし") && check0918.body.includes("MonotaRO ¥8,965・¥2,109、JLCPCB ¥25,017") && check0918.body.includes("14:23に訂正") && check0918.body.includes("Amazon ¥2,399・MonotaRO ¥18,678はメモあり・証憑なしのまま") && check0918.body.includes("Cubemars ¥8,425（AIトイ決済用）") && check0918.body.includes("RUNPOD.IO ¥8,186×2（SaaS決済用）") && check0918.body.includes("W2026111623018994") && check0918.body.includes("金額照合未確認"), "morning check kept");
  const check1630 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/16 16:30）");
  check(check1630?.tone === "info" && check1630.body.includes("2026-11-16 16:30 JST") && check1630.body.includes("ユーザー依頼の随時パトロール") && check1630.body.includes("ブラウザで#bo_upsiderを読んだ時刻") && check1630.body.includes("画面を更新した時刻ではない") && check1630.body.includes("投稿・添付・メモ登録はしていない") && check1630.body.includes("メモ作成は行っていない"), "ad-hoc patrol check log");
  check(check1630?.body.includes("B8561262") && check1630.body.includes("https://drive.google.com/file/d/1je93WSk4MCfw2TZccC-IAMdVyxosiUsd/view") && check1630.body.includes("134323400034") && check1630.body.includes("T6140001054380") && check1630.body.includes("株式会社MonotaRO") && check1630.body.includes("消費税¥40") && check1630.body.includes("登録完了にはしていない") && check1630.body.includes("メモは未登録のまま"), "monotaro 439 receipt saved");
  check(check1630?.body.includes("B8561267") && check1630.body.includes("https://drive.google.com/file/d/1DnCLbqWi9lVGlKzNFRbYDfpVUIaiKxKI/view") && check1630.body.includes("134323400035") && check1630.body.includes("消費税¥359"), "monotaro 3953 receipt saved");
  check(check1630?.body.includes("JP6CGS6P9AJGKI") && check1630.body.includes("https://drive.google.com/file/d/1_y8OnSSrgtIAAq0Sw4Hje595saTPjSis/view") && check1630.body.includes("249-5958752-6596606") && check1630.body.includes("T3040001028447") && check1630.body.includes("アマゾンジャパン合同会社") && check1630.body.includes("消費税¥280"), "amazon 3080 invoice saved");
  check(check1630?.body.includes("¥49,704") && check1630.body.includes("249-8562873-0763848") && check1630.body.includes("TX-20261115-AMZ-001") && check1630.body.includes("Polymaker HT-PLA") && check1630.body.includes("YUBI製造3DP材") && check1630.body.includes("15:23 UTC") && check1630.body.includes("https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY") && check1630.body.includes("スレッドtsは取れていない") && check1630.body.includes("11/17着予定"), "amazon 49704 added without a thread ts");
  check(check1630?.body.includes("TINMORRY Store JP") && check1630.body.includes("2026-11-16 16:33") && check1630.body.includes("証憑なしのまま") && check1630.body.includes("適格請求書はまだ取れず"), "amazon 2399 qualified invoice still unavailable");
  check(check1630?.body.includes("Cubemars ¥8,425") && check1630.body.includes("AIトイ決済用") && check1630.body.includes("池滝") && check1630.body.includes("行に加えていない") && check1630.body.includes("他の行は変えていない"), "cubemars stays out");
  check(check1630?.body.includes("登録完了21件、除外6件（返金2件、本人以外の課金4件）、証憑保存済・Slack未添付3件、要処理17件") && check1630.body.includes("メモあり24件") && check1630.body.includes("新しい返金はない") && check1630.body.includes("16:33〜16:36"), "ad-hoc counts");
  const check0916 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/16 09:16）");
  check(check0916?.tone === "info" && check0916.body.includes("2026-11-16 09:16 JST") && check0916.body.includes("ブラウザで#bo_upsiderを読んだ時刻") && check0916.body.includes("画面を更新した時刻ではない") && check0916.body.includes("投稿・添付・メモ登録はしていない") && check0916.body.includes("メモ作成は行っていない"), "morning check log");
  check(check0916?.body.includes("20261115_9000JPY_日本ロボット学会_領収書.pdf") && check0916.body.includes("本文なし") && check0916.body.includes("09:16:06") && check0916.body.includes("09:16:16") && check0916.body.includes("領収証を添付しました") && check0916.body.includes("一般社団法人日本ロボット学会") && check0916.body.includes("T7010005016414") && check0916.body.includes("登録完了にした"), "event pay receipt attached");
  check(check0916?.body.includes("1794755192.815079") && check0916.body.includes("b950c0a4-7232-4caa-a1e9-f4482d7ef7bf") && check0916.body.includes("134323400038") && check0916.body.includes("202929478") && check0916.body.includes("TX-20261116-MNT-001"), "monotaro 1868 added");
  check(check0916?.body.includes("1794763972.992929") && check0916.body.includes("f61fc546-e699-4dd7-ae33-2bac042aea20") && check0916.body.includes("249-3093885-1950211") && check0916.body.includes("TX-20261114-AMZ-001"), "amazon 5003 added");
  check(check0916?.body.includes("登録完了21件、除外6件（返金2件、本人以外の課金4件）、証憑保存済・Slack未添付0件、要処理16件") && check0916.body.includes("メモあり24件") && check0916.body.includes("返信0件のまま") && check0916.body.includes("新しい返金はない"), "morning counts");
  const midnightCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/16 00:02）");
  check(midnightCheck?.tone === "info" && midnightCheck.body.includes("2026-11-16 00:02 JST") && midnightCheck.body.includes("画面を更新した時刻ではない") && midnightCheck.body.includes("投稿・添付・メモ登録はしていない") && midnightCheck.body.includes("Slackブラウザ確認 11/16 00:02、15件のスレッド確認、メモ登録済3件（EVENT PAY ¥9,000・Amazon ¥2,399・MonotaRO ¥18,678）、領収証添付なし、新規カードなし"), "midnight check log");
  const nightCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/15 22:45）");
  check(nightCheck?.tone === "info" && nightCheck.body.includes("2026-11-15 22:45 JST") && nightCheck.body.includes("画面を更新した時刻ではない") && nightCheck.body.includes("投稿・添付・メモ登録はしていない"), "evening check time");
  check(nightCheck?.body.includes("登録完了20件、除外6件（返金2件、本人以外の課金4件）、証憑保存済・Slack未添付1件、要処理15件"), "evening counts");
  check(nightCheck?.body.includes("1794745427.252579") && nightCheck.body.includes("5cd099d7-e7ab-4af4-b21a-1f2633536ffa") && nightCheck.body.includes("249-5958752-6596606") && nightCheck.body.includes("TX-20261115-AMZ-002"), "amazon 3080 added");
  check(nightCheck?.body.includes("1794746054.930309") && nightCheck.body.includes("dae09261-8253-4cf5-b2d8-10ae108ac1a7") && nightCheck.body.includes("249-7546580-9987019") && nightCheck.body.includes("TX-20261115-AMZ-003"), "amazon 14549 added");
  check(nightCheck?.body.includes("1794746412.606309") && nightCheck.body.includes("7be90fc7-c734-4d31-8dc5-0f70b0feb481") && nightCheck.body.includes("メモを追加するボタンがない") && nightCheck.body.includes("台帳の取引はない"), "chrome zero added");
  check(nightCheck?.body.includes("1794746424.974559") && nightCheck.body.includes("8d7b2bae-7da2-40b6-acf5-5e24a0de1332") && nightCheck.body.includes("S169-50") && nightCheck.body.includes("T7010005016414") && nightCheck.body.includes("https://drive.google.com/file/d/1yBHveOx1AUhyLtxk_hLA2whZerfA72S1/view") && nightCheck.body.includes("証憑保存済・Slack未添付") && nightCheck.body.includes("登録完了にはしていない"), "event pay saved and not attached");
  check(nightCheck?.body.includes("1794747144.256949") && nightCheck.body.includes("4c9ec042-d484-47ff-bdf3-ed35f3f65b56") && nightCheck.body.includes("Y245720") && nightCheck.body.includes("TX-20261115-SWS-001"), "switch science added");
  check(nightCheck?.body.includes("1794749424.750489") && nightCheck.body.includes("9fa87e41-2f15-427b-9efd-12e968e8a504") && nightCheck.body.includes("202927990") && nightCheck.body.includes("TX-20261115-MNT-001"), "monotaro 17151 added");
  check(nightCheck?.body.includes("1794749518.102389") && nightCheck.body.includes("39de4707-3411-4a65-9809-de7d64bf648d") && nightCheck.body.includes("202928013") && nightCheck.body.includes("TX-20261115-MNT-002"), "monotaro 2198 added");
  check(nightCheck?.body.includes("RESEND ¥3,322") && nightCheck.body.includes("SaaS決済用") && nightCheck.body.includes("株式会社Algomatic Dynamics") && nightCheck.body.includes("行に加えていない"), "resend stays out");
  check(nightCheck?.body.includes("Amazon ¥49,704") && nightCheck.body.includes("TX-20261115-AMZ-001") && nightCheck.body.includes("Amazon ¥5,003") && nightCheck.body.includes("行は作っていない"), "unarrived amazon charges stay out");
  check(nightCheck?.body.includes("ステータスは変えていない") && nightCheck.body.includes("メモあり21件") && nightCheck.body.includes("新しい返金はない"), "existing action rows were not changed");
  const todayCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/14 09:20）");
  check(todayCheck?.tone === "info" && todayCheck.body.includes("2026-11-14 09:20 JST") && todayCheck.body.includes("画面を更新した時刻ではない"), "current check time");
  check(todayCheck?.body.includes("登録完了20件、除外6件（返金2件、本人以外の課金4件）、要処理8件"), "current counts");
  check(todayCheck?.body.includes("1794373453.560069") && todayCheck.body.includes("134323400030") && todayCheck.body.includes("B8538556") && todayCheck.body.includes("T6140001054380") && todayCheck.body.includes("株式会社ＭｏｎｏｔａＲＯ") && todayCheck.body.includes("20261111_30017JPY_モノタロウ_領収証.pdf") && todayCheck.body.includes("https://drive.google.com/file/d/1xaRjk-UuOI_SWzBO9e6bHz3VMu5BGL61/view?usp=drivesdk") && todayCheck.body.includes("21:35") && todayCheck.body.includes("領収証を添付しました") && todayCheck.body.includes("登録完了にした"), "monotaro 30017 registered");
  check(todayCheck?.body.includes("1794379576.006419") && todayCheck.body.includes("134323400031") && todayCheck.body.includes("20261111_4065JPY_モノタロウ_領収証.pdf") && todayCheck.body.includes("21:36") && todayCheck.body.includes("https://drive.google.com/file/d/1btXLz-yTieyIoK0IAz8qsz4cW1O_TeFf/view?usp=drivesdk"), "monotaro 4065 registered");
  check(todayCheck?.body.includes("1794393605.849899") && todayCheck.body.includes("AB25748GD4") && todayCheck.body.includes("T9010601030898") && todayCheck.body.includes("株式会社ミスミ") && todayCheck.body.includes("YUBI Glove製造用資材購入") && todayCheck.body.includes("樹脂製軸受、イグリデュール G GFM-2023-07 ×121") && todayCheck.body.includes("内容の行を省略") && todayCheck.body.includes("20261111_44189JPY_ミスミ_領収書.pdf") && todayCheck.body.includes("https://drive.google.com/file/d/1OzxJkEKS6GvpfE2CgopfOEWX5CJRtKhg/view?usp=drivesdk"), "misumi memo and receipt registered");
  check(todayCheck?.body.includes("1794408224.262909") && todayCheck.body.includes("250-6606641-6831015") && todayCheck.body.includes("適格請求書待ち") && todayCheck.body.includes("メモ・証憑なしのまま"), "amazon 2399 unchanged");
  check(todayCheck?.body.includes("1794498836.125669") && todayCheck.body.includes("134323400032") && todayCheck.body.includes("出荷予定は11/25まで"), "monotaro 18678 unchanged");
  check(todayCheck?.body.includes("1794380035.547129") && todayCheck.body.includes("確認決済のまま"), "amazon zero unchanged");
  check(todayCheck?.body.includes("1794533037.399359") && todayCheck.body.includes("c3e9cccd-d710-47b9-ba7e-2eb3a1e8391b") && todayCheck.body.includes("134323400033") && todayCheck.body.includes("426978777971"), "monotaro 1318 added");
  check(todayCheck?.body.includes("1794578109.819919") && todayCheck.body.includes("48ea51bf-e9d3-4cda-aa04-521fb1785978") && todayCheck.body.includes("E00339678"), "wilco added");
  check(todayCheck?.body.includes("1794587013.186459") && todayCheck.body.includes("77c29095-9e97-4414-b821-f43da3f06cfc") && todayCheck.body.includes("134323400034"), "monotaro 439 added");
  check(todayCheck?.body.includes("1794589796.697149") && todayCheck.body.includes("7d447db2-fe12-42b6-8103-21d277c56bc4") && todayCheck.body.includes("134323400035"), "monotaro 3953 added");
  check(todayCheck?.body.includes("1794597997.191909") && todayCheck.body.includes("8f74525f-ac8f-445a-9ec7-43056c166b2e") && todayCheck.body.includes("AB25764G15"), "misumi 3267 added");
  check(todayCheck?.body.includes("Bambu ¥228,000") && todayCheck.body.includes("Bambu ¥114,000") && todayCheck.body.includes("CubeMars ¥369,268") && todayCheck.body.includes("MonotaRO ¥8,576") && todayCheck.body.includes("池滝 俊太") && todayCheck.body.includes("SLACK ¥35,729") && todayCheck.body.includes("JLCPCB ¥8,218") && todayCheck.body.includes("行に加えていない"), "out of scope stays out of the ledger");
  const savedCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/13 19:30）");
  check(savedCheck?.tone === "info" && savedCheck.body.includes("2026-11-13 19:30 JST") && savedCheck.body.includes("画面を更新した時刻ではない"), "evidence save check time");
  check(savedCheck?.body.includes("登録完了17件、除外6件（返金2件、本人以外の課金4件）、要処理6件"), "evidence save counts");
  check(savedCheck?.body.includes("1794373453.560069") && savedCheck.body.includes("134323400030") && savedCheck.body.includes("B8538556") && savedCheck.body.includes("T6140001054380") && savedCheck.body.includes("https://drive.google.com/file/d/1xaRjk-UuOI_SWzBO9e6bHz3VMu5BGL61/view?usp=drivesdk") && savedCheck.body.includes("登録完了にはしていない"), "monotaro 30017 receipt saved");
  check(savedCheck?.body.includes("1794379576.006419") && savedCheck.body.includes("134323400031") && savedCheck.body.includes("B8538572") && savedCheck.body.includes("https://drive.google.com/file/d/1btXLz-yTieyIoK0IAz8qsz4cW1O_TeFf/view?usp=drivesdk"), "monotaro 4065 receipt saved");
  check(savedCheck?.body.includes("1794393605.849899") && savedCheck.body.includes("AB25748GD4") && savedCheck.body.includes("T9010601030898") && savedCheck.body.includes("https://drive.google.com/file/d/1OzxJkEKS6GvpfE2CgopfOEWX5CJRtKhg/view?usp=drivesdk") && savedCheck.body.includes("納品書を受領") && savedCheck.body.includes("メモは未登録のまま"), "misumi receipt saved and delivered");
  check(savedCheck?.body.includes("1794408224.262909") && savedCheck.body.includes("250-6606641-6831015") && savedCheck.body.includes("https://drive.google.com/file/d/1HcZ-haZhwf4GUE3V4txhGjiRiFTxAZT_/view") && savedCheck.body.includes("適格請求書ではない") && savedCheck.body.includes("Drive証憑には入れず注記した") && savedCheck.body.includes("メモは未登録のまま"), "amazon statement is a note");
  check(savedCheck?.body.includes("134323400032") && savedCheck.body.includes("変えていない") && savedCheck.body.includes("出荷予定は11/25まで"), "monotaro 18678 was unchanged at the save");
  check(savedCheck?.body.includes("証憑保存済・Slack未添付") && !savedCheck.body.includes("登録完了にした"), "saved receipts were not registered at 19:30");
  const check0921 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/13 09:21）");
  check(check0921?.tone === "info" && check0921.body.includes("2026-11-13 09:21 JST") && check0921.body.includes("画面を更新した時刻ではない"), "previous morning check time");
  check(check0921?.body.includes("登録完了17件、除外6件（返金2件、本人以外の課金4件）、要処理6件"), "previous morning counts");
  check(check0921?.body.includes("1794498836.125669") && check0921.body.includes("134323400032") && check0921.body.includes("202785267") && check0921.body.includes("TX-20261113-MNT-001") && check0921.body.includes("Seeed XIAO ESP32C6 ×10") && check0921.body.includes("税¥1,698") && check0921.body.includes("出荷予定は11/25まで"), "monotaro 18678");
  check(check0921?.body.includes("EVENTOS ¥0") && check0921.body.includes("1794476079.988119") && check0921.body.includes("BRAVESOFT INC. ¥0") && check0921.body.includes("1794476131.214289") && check0921.body.includes("BRAVESOFT INC. ¥60,500") && check0921.body.includes("1794476153.915879") && check0921.body.includes("取引行には加えていない"), "event charges stay out of the ledger");
  check(check0921?.body.includes("DP4*RAKSUL ¥4,711") && check0921.body.includes("1794480409.627769") && check0921.body.includes("株式会社Algomatic Dynamics") && check0921.body.includes("ECサイト決済用"), "raksul stays out of the ledger");
  check(check0921?.body.includes("0417677859336") && check0921.body.includes("SBS即配サポート") && check0921.body.includes("全数出荷") && check0921.body.includes("メモ・証憑なしのまま"), "misumi shipment without a status change");
  check(check0921?.body.includes("11/12 17:22 JSTに配達済み") && check0921.body.includes("適格請求書ではない") && check0921.body.includes("Driveはなしのまま"), "amazon 2399 delivered and still waiting for a qualified invoice");
  check(check0921?.body.includes("ステータスは変えていない") && check0921.body.includes("この確認決済も要処理に入る") && check0921.body.includes("メモあり20件"), "unchanged rows stay in the action count");
  check(todayCheck?.body.includes("投稿・添付・メモ登録はしていない") && todayCheck.body.includes("メモあり21件"), "no send from this check");
  check(todayCheck?.body.includes("新しい返金はない"), "no new refund");
  const latestCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/12 09:20）");
  check(latestCheck?.tone === "info" && latestCheck.body.includes("2026-11-12 09:20 JST") && latestCheck.body.includes("画面を更新した時刻ではない"), "latest check time");
  check(latestCheck?.body.includes("登録完了17件、除外6件（返金2件、本人以外の課金4件）、要処理5件"), "latest counts");
  check(latestCheck?.body.includes("1794393605.849899") && latestCheck.body.includes("AB25748GD4") && latestCheck.body.includes("TX-20261111-MSM-001") && latestCheck.body.includes("未出荷") && latestCheck.body.includes("税¥4,017"), "misumi 44189");
  check(latestCheck?.body.includes("1794408224.262909") && latestCheck.body.includes("250-6606641-6831015") && latestCheck.body.includes("TX-20261111-AMZ-001") && latestCheck.body.includes("YUBI製造SDS") && latestCheck.body.includes("納品予定は11/12"), "amazon 2399");
  check(latestCheck?.body.includes("HIMARI SHOTEN ¥26,310") && latestCheck.body.includes("1794400760.220609") && latestCheck.body.includes("南里 勇気") && latestCheck.body.includes("取引行には加えていない"), "himari stays out of the ledger");
  check(latestCheck?.body.includes("GITHUB, INC. ¥16,432") && latestCheck.body.includes("USD 101.20") && latestCheck.body.includes("1794424831.175209") && latestCheck.body.includes("株式会社Algomatic Dynamics"), "github 16432 stays out of the ledger");
  check(latestCheck?.body.includes("20:48:41") && latestCheck.body.includes("20:48:44") && latestCheck.body.includes("AIハンド製造ライン用資材収納用品購入") && latestCheck.body.includes("その他") && latestCheck.body.includes("備品") && latestCheck.body.includes("メモ登録済み・証憑未取得、納入待ち"), "monotaro 30017 memo");
  check(latestCheck?.body.includes("20:49:59") && latestCheck.body.includes("20:50:02") && latestCheck.body.includes("YUBI製造用副資材購入") && latestCheck.body.includes("プロダクト販売") && latestCheck.body.includes("副資材") && latestCheck.body.includes("426978601394") && latestCheck.body.includes("直送品"), "monotaro 4065 memo and shipment");
  check(latestCheck?.body.includes("確認決済（¥0、本決済¥2,399は別行）") && latestCheck.body.includes("行は削除していない") && latestCheck.body.includes("この確認決済も要処理に入る") && !latestCheck.body.includes("本決済¥2,399はSlackに出ていない") && !latestCheck.body.includes("行は作っていない"), "amazon zero is a confirmation of the separate charge");
  check(latestCheck?.body.includes("GITHUB, INC. ¥22") && latestCheck.body.includes("1794369591.509309") && latestCheck.body.includes("本人以外の課金（シバタさん回答 2026-11-11）"), "github 22 unchanged");
  check(latestCheck?.body.includes("投稿・添付・メモ登録はしていない"), "no send from this check");
  check(latestCheck?.body.includes("返金はない"), "no new refund");
  const eveningCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/11 18:47）");
  check(eveningCheck?.tone === "info" && eveningCheck.body.includes("2026-11-11 18:47 JST") && eveningCheck.body.includes("画面を更新した時刻ではない"), "evening check time kept");
  check(eveningCheck?.body.includes("登録完了17件、除外6件（返金2件、本人以外の課金4件）、要処理3件"), "evening counts kept");
  check(eveningCheck?.body.includes("1794369591.509309") && eveningCheck.body.includes("USD 0.14") && eveningCheck.body.includes("本人以外の課金（シバタさん回答 2026-11-11）") && eveningCheck.body.includes("行は削除していない") && eveningCheck.body.includes("返金とは別の除外理由") && !eveningCheck.body.includes("本人以外の課金にはしていない"), "github 22 excluded like the earlier github rows");
  check(eveningCheck?.body.includes("TX-20261111-MNT-001") && eveningCheck.body.includes("134323400030") && eveningCheck.body.includes("202639045") && eveningCheck.body.includes("664362973562") && eveningCheck.body.includes("9583853145") && eveningCheck.body.includes("要処理（メモ未登録・証憑未取得、納入待ち）"), "monotaro 30017 history");
  check(eveningCheck?.body.includes("TX-20261111-MNT-002") && eveningCheck.body.includes("134323400031") && eveningCheck.body.includes("202654082") && eveningCheck.body.includes("要処理（メモ未登録・証憑未取得、出荷待ち）"), "monotaro 4065 history");
  check(eveningCheck?.body.includes("1794380035.547129") && eveningCheck.body.includes("250-6606641-6831015") && eveningCheck.body.includes("TX-20261111-AMZ-001") && eveningCheck.body.includes("要確認（¥0の確認決済とみられる。本決済待ち）") && eveningCheck.body.includes("行は作っていない"), "evening check kept the unpaid 2399 note");
  check(eveningCheck?.body.includes("日進ゴム ¥17,600") && eveningCheck.body.includes("Slack添付確認済") && eveningCheck.body.includes("nisshin-4735.png") && eveningCheck.body.includes("2026-11-05 18:50 JST") && eveningCheck.body.includes("登録完了にした") && eveningCheck.body.includes("メモだけの要処理にはしていない"), "nisshin registered because the memo was already present");
  check(eveningCheck?.body.includes("新しい返金") === false && eveningCheck.body.includes("返金はない"), "evening check recorded no new refund");
  check(eveningCheck?.body.includes("投稿・添付・メモ登録はしていない"), "evening check sent nothing");
  const morningCheck11 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/11 09:34）");
  check(morningCheck11?.tone === "info" && morningCheck11.body.includes("2026-11-11 09:34 JST") && morningCheck11.body.includes("画面を更新した時刻ではない"), "morning check time kept");
  check(morningCheck11?.body.includes("登録完了16件、除外5件（返金2件、本人以外の課金3件）、要処理1件"), "morning counts kept");
  check(morningCheck11?.body.includes("20261102_5570JPY_アースダンボール_領収書.pdf") && morningCheck11.body.includes("13:49:59") && morningCheck11.body.includes("13:50:00") && morningCheck11.body.includes("13:50:07") && morningCheck11.body.includes("株式会社アースダンボール"), "earth receipt notice");
  check(morningCheck11?.body.includes("20261106_7160JPY_アースダンボール_領収書.pdf") && morningCheck11.body.includes("13:49:44") && morningCheck11.body.includes("13:49:45") && morningCheck11.body.includes("13:49:52") && morningCheck11.body.includes("1793948039.836289"), "danballace receipt notice");
  check(morningCheck11?.body.includes("日進ゴム ¥17,600") && morningCheck11.body.includes("証憑なしのまま") && morningCheck11.body.includes("nisshin-4735.png") && morningCheck11.body.includes("新しい返金はない") && morningCheck11.body.includes("新しいGitHub課金はない"), "morning finding kept");
  check(morningCheck11?.body.includes("AMAZON CO JP ¥8,990") && morningCheck11.body.includes("1794312604.656699") && morningCheck11.body.includes("吉野 哲仁") && morningCheck11.body.includes("取引行には加えていない"), "amazon out of scope");
  check(morningCheck11?.body.includes("投稿・添付・メモ登録はしていない"), "morning check sent nothing");
  const afternoonCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/10 13:40）");
  check(afternoonCheck?.tone === "info" && afternoonCheck.body.includes("2026-11-10 13:40:00 JST") && afternoonCheck.body.includes("画面を更新した時刻ではない"), "previous afternoon check time");
  check(afternoonCheck?.body.includes("登録完了14件、除外5件（返金2件、本人以外の課金3件）、要処理3件"), "previous afternoon counts kept");
  check(afternoonCheck?.body.includes("USD 0.29") && afternoonCheck.body.includes("1794275464.574969") && afternoonCheck.body.includes("2026-11-10 10:51:03 JST") && afternoonCheck.body.includes("2026-11-10 13:41 JST"), "github 47");
  check(afternoonCheck?.body.includes("1794214457.091699") && afternoonCheck.body.includes("1794214530.632489"), "github 392 and 783 threads");
  check(afternoonCheck?.body.includes(NOT_OWNER_STATUS) && afternoonCheck.body.includes("行は削除していない") && afternoonCheck.body.includes("返金とは別の除外理由"), "not-owner exclusion is distinct");
  check(afternoonCheck?.body.includes("DANBALLACE ¥7,160とアースダンボール ¥5,570は証憑保存済・Slack未添付のまま") && afternoonCheck.body.includes("日進ゴム ¥17,600は証憑なしのまま") && afternoonCheck.body.includes("新しい返金はない"), "previous protected rows named");
  check(afternoonCheck?.body.includes("連携による投稿・添付・再送はしていない"), "previous check sent nothing");
  const previousMorning = ledger.callouts.find((item) => item.lead === "前回のチェック（11/10 09:06）");
  check(previousMorning?.tone === "info" && previousMorning.body.includes("2026-11-10 09:06:29 JST") && previousMorning.body.includes("画面を更新した時刻ではない"), "previous check time");
  check(previousMorning?.body.includes("領収証を添付しました") && previousMorning.body.includes("2026-11-09 16:02:41 JST") && previousMorning.body.includes("20261105_2600JPY_秋月電子_領収書.pdf") && previousMorning.body.includes("T8010901000370"), "akizuki receipt notice");
  check(previousMorning?.body.includes("登録完了14件、返金除外2件、要処理5件"), "previous counts kept");
  check(previousMorning?.body.includes("USD 2.42") && previousMorning.body.includes("1794214457.091699") && previousMorning.body.includes("19d4ace8-8c22-4266-b43e-f55d6ec58050"), "github 392");
  check(previousMorning?.body.includes("USD 4.83") && previousMorning.body.includes("1794214530.632489") && previousMorning.body.includes("d910f06d-69ce-4253-81cd-8311c5a46b31"), "github 783");
  check(previousMorning?.body.includes("通常購買候補") && previousMorning.body.includes("用途は要確認") && previousMorning.body.includes("メモ・証憑なし"), "github classification");
  check(previousMorning?.body.includes("アースダンボール ¥5,570、DANBALLACE ¥7,160、日進ゴム ¥17,600は金額もステータスも変えていない"), "previous protected rows named");
  const currentCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 22:55）");
  check(currentCheck?.tone === "info" && currentCheck.body.includes("123402") && currentCheck.body.includes("123403") && currentCheck.body.includes("2026-11-06"), "misumi delivery slips");
  check(currentCheck?.body.includes("15,470円") && currentCheck.body.includes("1,144円") && currentCheck.body.includes("16,614円"), "misumi delivery amounts");
  check(currentCheck?.body.includes("tx-20261104-2114-misumi-16614") && currentCheck.body.includes("TX-20261104-MSM-001") && currentCheck.body.includes("AB256FB3F5"), "misumi delivery identity");
  check(currentCheck?.body.includes("納入済み（2026-11-09 納品書受領）") && currentCheck.body.includes("登録完了のまま") && currentCheck.body.includes("登録完了13件、返金除外2件、要処理4件"), "delivery check keeps registration");
  const earthShipment = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 22:25）");
  check(earthShipment?.tone === "info" && earthShipment.body.includes("66583392606") && earthShipment.body.includes("2956381-01") && earthShipment.body.includes("福山通運"), "earth 5570 shipment");
  check(earthShipment?.body.includes("12時～14時") && earthShipment.body.includes("2026-11-10") && earthShipment.body.includes("https://drive.google.com/file/d/12UcuIa_b5oA8PHpqp4OVjMu947EW6UO8/view"), "earth delivery note");
  check(earthShipment?.body.includes("発行日2026/11/07") && earthShipment.body.includes("ご請求額¥5,570") && earthShipment.body.includes("納品日2026/11/10"), "delivery note amounts");
  check(earthShipment?.body.includes("証憑保存済・Slack未添付") && earthShipment.body.includes("登録完了13件、返金除外2件、要処理4件"), "shipment check keeps counts");
  const receiptCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 16:25）");
  check(receiptCheck?.body.includes("C333470") && receiptCheck.body.includes("福山通運") && receiptCheck.body.includes("2026-11-10"), "earth 5570 receipt");
  check(receiptCheck?.body.includes("C333471") && receiptCheck.body.includes("佐川急便") && receiptCheck.body.includes("2026-11-13"), "danballace 7160 receipt");
  check(receiptCheck?.body.includes("T5030001042538") && receiptCheck.body.includes("但し梱包資材代") && receiptCheck.body.includes("株式会社AlgomaticDynamics"), "carton receipt identity");
  check(receiptCheck?.body.includes("共有拒否ではない") && receiptCheck.body.includes("ユーザーが手動で添付する予定"), "manual pending attachment");
  check(receiptCheck?.body.includes("登録完了13件、返金除外2件、要処理4件"), "counts recomputed");
  const akizukiCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 15:59）");
  check(akizukiCheck?.body.includes("20261105_2600JPY_秋月電子_領収書.pdf") && akizukiCheck.body.includes("T8010901000370") && akizukiCheck.body.includes("但し部品代"), "akizuki receipt");
  check(akizukiCheck?.body.includes("伝票437180618571") && akizukiCheck.body.includes("出荷済み"), "akizuki shipment");
  const attachedCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 15:31）");
  check(attachedCheck?.body.includes("成功3件／未完了0件"), "current attachment result");
  check(attachedCheck?.body.includes("20261105_17553JPY_モノタロウ_領収証.pdf") && attachedCheck.body.includes("15:28:09"), "monotaro 17553 receipt");
  check(attachedCheck?.body.includes("20261105_4833JPY_モノタロウ_領収証.pdf") && attachedCheck.body.includes("15:28:41"), "monotaro 4833 receipt");
  check(attachedCheck?.body.includes("20261104_16614JPY_ミスミ_領収書・ご注文明細書.pdf") && attachedCheck.body.includes("15:29:08"), "misumi receipt");
  check(attachedCheck?.body.includes("残り4件"), "remaining action count is computed");
  check(attachedCheck?.body.includes("連携による再送はしていない"), "no integration resend");
  const morningCheck = ledger.callouts.find((item) => item.lead === "前回のチェック（11/09 09:26）");
  check(morningCheck?.body.includes("VERCEL INC. ¥10,697") && morningCheck.body.includes("DOCUSIGN INC. ¥13,310"), "out of scope cards stay out of the ledger");
  check(morningCheck?.body.includes("返信数は前回値を保持していない"), "reply-count limit");
  check(morningCheck?.body.includes("今回証憑の有効性を再検証したとは扱わない"), "amazon 2473 is not marked revalidated");
  check(!morningCheck?.body.includes("再検証済"), "morning check does not claim revalidation");
  check(morningCheck?.body.includes("PNG形式であることだけを理由に画像証憑を一般に無効とはしない"), "png format is not a general invalidation");
  check(morningCheck?.body.includes("tx-20261102-2053-earth-23960") && morningCheck.body.includes("tx-20261104-0923-danballace-23960"), "both refund ids are named");
  check(morningCheck?.body.includes("既存の要処理8件との差は、返金元¥23,960を要処理に入れていたこと"), "difference from the previous 8 is explained");
  const previousAm9 = ledger.callouts.find((item) => item.lead === "前回のチェック（11/08 AM9）");
  check(previousAm9?.body.includes("DOCUSIGN INCは対象外") && previousAm9.body.includes("ステータス変更なし") && previousAm9.body.includes("再送していない"), "11/08 check body kept");
  check(ledger.callouts[0].body.includes("確認済み5項目メモと金額の一致した有効証憑PDFを登録します"), "memo registration copy");
  check(!ledger.callouts[0].body.includes("メモ作成は停止中です"), "current ops copy does not say memo creation is fully stopped");
  check(ledger.transactions.filter((tx) => tx.memoPresent === true).length === 24, "memo present 24");
  check(ledger.transactions.filter((tx) => tx.memoStatus === "未確認").length === 42, "unconfirmed memos include the new rows");
  check(!JSON.stringify(ledger).includes("13c1225a") && !JSON.stringify(ledger).includes("F0CF"), "internal attachment ids stay out");
  const counts = {
    "登録完了": 22,
    [REFUND_STATUS]: 2,
    [NOT_OWNER_STATUS]: 3,
    [NOT_OWNER_STATUS_20261111]: 1,
    "メモなし": 23,
    "証憑なし": 1,
    "証憑保存済・Slack未添付": 0,
    "メモ・証憑なし": 12,
    "証憑不一致": 0,
  };
  check(JSON.stringify(FILTERS.slice(1)) === JSON.stringify(Object.keys(counts)), "filters match counted statuses");
  for (const [status, count] of Object.entries(counts)) {
    check(countOf(ledger.transactions, status) === count, `${status} count ${countOf(ledger.transactions, status)} !== ${count}`);
  }
  const confirmationStatus = "確認決済（¥0、本決済¥2,399は別行）";
  const chromeConfirmationStatus = "確認決済（¥0）";
  const paypalConfirmationStatus = "確認決済（¥0、本決済¥691,525は別行）";
  check(countOf(ledger.transactions, confirmationStatus) === 1, "confirmation charge is its own status");
  check(countOf(ledger.transactions, chromeConfirmationStatus) === 1, "chrome verification charge uses the same confirmation category");
  check(countOf(ledger.transactions, paypalConfirmationStatus) === 1, "paypal verification charge is its own confirmation status");
  check(FILTERS.slice(1).reduce((total, status) => total + countOf(ledger.transactions, status), 0) + countOf(ledger.transactions, confirmationStatus) + countOf(ledger.transactions, chromeConfirmationStatus) + countOf(ledger.transactions, paypalConfirmationStatus) === 67, "status counts sum to 67");
  const sums = {
    "登録完了": 226563,
    [REFUND_STATUS]: 0,
    [NOT_OWNER_STATUS]: 1222,
    [NOT_OWNER_STATUS_20261111]: 22,
    "メモなし": 902050,
    "証憑なし": 2399,
    "証憑保存済・Slack未添付": 0,
    "メモ・証憑なし": 200977,
    "証憑不一致": 0,
  };
  check(sumOf(ledger.transactions) === 1333233, `total ${sumOf(ledger.transactions)}`);
  check(Object.values(sums).reduce((total, value) => total + value, 0) === 1333233, "status sums");
  for (const [status, amount] of Object.entries(sums)) {
    check(sumOf(ledger.transactions, status) === amount, `sum ${status} ${sumOf(ledger.transactions, status)} !== ${amount}`);
  }
  check(formatYen(307492) === "¥307,492", "yen format");
  check(formatYen(-23960) === "-¥23,960", "negative yen format");
  check(filterTransactions(ledger.transactions, "メモなし").every((tx) => tx.status === "メモなし"), "filter exact");
  check(JSON.stringify(filterTransactions(ledger.transactions, "証憑なし").map((tx) => tx.id)) === JSON.stringify(["tx-20261111-2343-amazon-2399"]), "memo-registered rows without a saved receipt");
  check(JSON.stringify(filterTransactions(ledger.transactions, "メモなし").map((tx) => tx.id)) === JSON.stringify(["tx-20261113-1023-monotaro-1318","tx-20261113-2255-wilco-20900","tx-20261114-0123-monotaro-439","tx-20261114-0209-monotaro-3953","tx-20261114-0426-misumi-3267","tx-20261115-2123-amazon-3080","tx-20261115-2152-switchscience-3560","tx-20261115-2230-monotaro-17151","tx-20261115-2231-monotaro-2198","tx-20261116-0006-monotaro-1868","tx-20261116-0023-amazon-49704","tx-20261116-0232-amazon-5003","tx-20261116-2027-monotaro-8965","tx-20261116-2030-monotaro-2109","tx-20261117-1823-monotaro-10993","tx-20261117-1831-misumi-7878","tx-20261118-2127-misumi-10890","tx-20261118-2234-misumi-5984","tx-20261119-1514-misumi-8745","tx-20261119-2351-jtbamarys-8000","tx-20261120-1655-seeed-691525","tx-20261124-1730-monotaro-27779","tx-20261125-1732-amazon-6741"]), "twenty three receipts are attached and still missing a memo");
  check(JSON.stringify(filterTransactions(ledger.transactions, "証憑保存済・Slack未添付").map((tx) => tx.id)) === "[]", "no receipt is saved and still unattached");
  check(filterTransactions(ledger.transactions, "メモなし").length === 23, "twenty three rows are memo-missing with a receipt");
  check(filterTransactions(ledger.transactions, "メモ・証憑なし").length === 12, "twelve rows are missing both memo and receipt");
  check(filterTransactions(ledger.transactions, NOT_OWNER_STATUS).length === 3, "three earlier not-owner charges stay listed");
  check(filterTransactions(ledger.transactions, NOT_OWNER_STATUS_20261111).length === 1, "github 22 is listed under the 11/11 exclusion");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 67, "slack urls unique");
  const detailIds = ledger.transactions.filter((tx) => tx.detailSection).map((tx) => tx.id);
  check(detailIds.length === 0, `detail sections ${detailIds.join(",")}`);
  check(JSON.stringify(detailIds) === JSON.stringify(ledger.details.map((detail) => detail.transactionId)), "details follow unhandled transactions");

  const completed = ledger.transactions.filter((tx) => tx.status === "登録完了");
  const savedReceipts = ledger.transactions.filter((tx) => tx.status === "証憑保存済・Slack未添付");
  check(completed.length === 22 && completed.every(hasEvidence), `登録完了 evidence ${completed.filter((tx) => !hasEvidence(tx)).map((tx) => tx.id).join(",") || completed.length}`);
  check(savedReceipts.length === 0, "saved-but-unattached queue is empty");
  const patrolReceipts = {
    "tx-20261113-2255-wilco-20900": ["https://drive.google.com/file/d/1AX1d-wS1rW_yAqKl5EBhtAi43EbZ3d3F/view", "伝票No.00716292", 1900, "請求書（適格・領収済み、納品書同梱）", "株式会社ウィルコ", "T5020001036961", "E00339678", "2026-11-17 15:21 JST", "納入済（2026-11-17 ScanSnap納品書・請求書受領）"],
    "tx-20261115-2231-monotaro-2198": ["https://drive.google.com/file/d/1tRzMB7AQJ8hZ6rHMGxcyz74dtmdrUI51/view", "B8571216", 200, "領収証", "株式会社MonotaRO", "T6140001054380", undefined, "2026-11-17 16:12 JST", "納入済（2026-11-17 ScanSnap納品書134323400037-01受領）"],
    "tx-20261116-0006-monotaro-1868": ["https://drive.google.com/file/d/1YwmP9tiOqL4qsTXRfi9VGfN_57QSe1an/view", "B8571212", 170, "領収証", "株式会社MonotaRO", "T6140001054380", "134323400038", "2026-11-17 16:12 JST", "納入済（2026-11-17 ScanSnap納品書134323400038-01受領）"],
    "tx-20261116-0023-amazon-49704": ["https://drive.google.com/file/d/1l0fs_9Wa8E37XqSmz2qeXVkNe74XMoTu/view", "JP6CHTXP1AJGKI", 4519, "適格請求書", "アマゾンジャパン合同会社", "T3040001028447", "249-8562873-0763848", "2026-11-17 12:14 JST", "配達済（2026-11-17 12:11 JST）"],
    "tx-20261116-0232-amazon-5003": ["https://drive.google.com/file/d/1E0y772dz8Ci6u8ZMOsKHT_xO0OgIvm8C/view", "JP6CHB0A9AJGKI", 455, "適格請求書", "アマゾンジャパン合同会社", "T3040001028447", "249-3093885-1950211", "2026-11-17 12:14 JST", "配達済（2026-11-17 12:11 JST）"],
  };
  for (const [id, [url, receiptNumber, tax, evidenceType, issuer, tin, orderNumber, acquiredAt, delivery]] of Object.entries(patrolReceipts)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.drive === url && tx?.receiptNumber === receiptNumber && tx?.accountingTaxYen === tax && tx?.accountingAmountYen === tx.amountYen && tx?.evidenceType === evidenceType && tx?.issuer === issuer && tx?.qualifiedInvoiceNumber === tin && tx?.orderNumber === orderNumber && tx?.accountingPdfAcquiredAt === acquiredAt && tx?.deliveryStatus === delivery && tx?.deliveryConfirmed === true, `patrol receipt ${id}`);
    const noticeAt = id === "tx-20261113-2255-wilco-20900" ? "2026-11-18 09:11 JST" : "2026-11-18 09:12 JST";
    check(tx?.status === "メモなし" && tx?.priorStatus === "証憑保存済・Slack未添付" && tx?.statusUpdatedAt === "2026-11-18 09:12 JST" && tx?.slackAttachmentStatus === `添付済（${noticeAt}、UPSIDER「領収証を添付しました」確認）` && tx?.upSiderReceiptRegistrationStatus === `登録済（UPSIDER「領収証を添付しました」${noticeAt}確認）` && tx?.slackAttachmentError === undefined && tx?.statusReason.includes("要処理（メモ未登録）。証憑はSlack添付済み") && tx?.statusReason.includes("本文なし") && tx?.statusReason.includes("登録完了にはしていない") && !tx?.statusReason.includes("シバタさんが手動で添付する") && tx?.priorStatusReason.includes("シバタさんが手動で添付する") && tx?.evidenceCheck.includes(url) && tx?.evidenceCheck.includes(receiptNumber) && tx?.evidenceCheck.includes("本文なし") && tx?.memoPresent === false && needsAction(tx), `patrol receipt attached ${id}`);
    check(tx?.memoDefault && MEMO_FIELDS.every((field) => tx.memoDefault[field].trim()) && tx.memoDefault.seg1 === "AIハンド" && !JSON.stringify(tx.memoDefault).includes("要確認"), `patrol receipt memo kept ${id}`);
  }
  const attachedMemos = {
    "tx-20261114-0123-monotaro-439": ["https://drive.google.com/file/d/1je93WSk4MCfw2TZccC-IAMdVyxosiUsd/view", "B8561262", 40, "領収証", "株式会社MonotaRO", "T6140001054380", "134323400034", "2026-11-17 09:12:46 JST", "09:12", "20261114_439JPY_モノタロウ_領収証.pdf"],
    "tx-20261114-0209-monotaro-3953": ["https://drive.google.com/file/d/1DnCLbqWi9lVGlKzNFRbYDfpVUIaiKxKI/view", "B8561267", 359, "領収証", "株式会社MonotaRO", "T6140001054380", "134323400035", "2026-11-17 09:14:51 JST", "09:14", "20261114_3953JPY_モノタロウ_領収証.pdf"],
    "tx-20261115-2123-amazon-3080": ["https://drive.google.com/file/d/1_y8OnSSrgtIAAq0Sw4Hje595saTPjSis/view", "JP6CGS6P9AJGKI", 280, "適格請求書", "アマゾンジャパン合同会社", "T3040001028447", "249-5958752-6596606", "2026-11-17 09:15:11 JST", "09:15", "20261115_3080JPY_Amazon_適格請求書.pdf"],
  };
  for (const [id, [url, receiptNumber, tax, evidenceType, issuer, tin, orderNumber, postedAt, noticeAt, file]] of Object.entries(attachedMemos)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.status === "メモなし" && tx?.priorStatus === "証憑保存済・Slack未添付" && needsAction(tx) && !tx?.registeredMemo && tx?.memoPresent === false && tx?.memoStatus === "未確認", `attached without memo ${id}`);
    check(tx?.drive === url && tx?.receiptNumber === receiptNumber && tx?.accountingTaxYen === tax && tx?.accountingAmountYen === tx.amountYen && tx?.evidenceType === evidenceType && tx?.issuer === issuer && tx?.qualifiedInvoiceNumber === tin && tx?.orderNumber === orderNumber && tx?.evidenceStorageStatus === "取得・Drive保存済" && tx?.accountingPdfAcquiredAt === "2026-11-16 16:36 JST", `saved receipt kept ${id}`);
    check(tx?.slackAttachmentStatus === `添付済（${postedAt}、本文なし、ブラウザ）` && tx?.upSiderReceiptRegistrationStatus === `登録済（UPSIDER「領収証を添付しました」2026-11-17 ${noticeAt} JST確認）` && tx?.statusUpdatedAt === "2026-11-17 09:18 JST" && tx?.slackAttachmentError === undefined, `slack attachment ${id}`);
    check(tx?.evidenceCheck.includes(url) && tx?.evidenceCheck.includes("登録完了にはしていない") && tx?.evidenceCheck.includes("未登録のまま") && tx?.evidenceCheck.includes(postedAt) && tx?.evidenceCheck.includes("本文なし") && tx?.statusReason.includes(file) && tx?.statusReason.includes("メモ未登録") && tx?.statusReason.includes("登録完了にはしていない"), `attachment note ${id}`);
    check(tx?.memoDefault && MEMO_FIELDS.every((field) => tx.memoDefault[field].trim()) && tx.memoDefault.seg1 === "AIハンド" && !JSON.stringify(tx.memoDefault).includes("要確認"), `saved receipt memo kept ${id}`);
  }
  const akizuki = ledger.transactions.find((tx) => tx.id === "tx-20261105-1241-akizuki-2600");
  check(akizuki?.status === "登録完了" && akizuki?.amount === "¥2,600" && akizuki?.amountYen === 2600, "akizuki registered without an amount change");
  check(akizuki?.drive === "https://drive.google.com/file/d/1gz3oExT325FAWtY0YprLunl6Eex9EUuw/view", "akizuki drive url");
  check(akizuki?.content === "Hub基板用ピンヘッダー" && !akizuki.content.includes("証憑なし"), "akizuki content drops the missing-evidence note");
  check(akizuki?.slackAttachmentError === undefined && akizuki?.slackAttachmentStatus === "添付済（ユーザーが手動）" && akizuki?.priorSlackAttachmentStatus === "未添付（ユーザーが手動で添付予定）", "akizuki is not share-refused");
  check(akizuki?.slackReceiptNotice === "領収証を添付しました" && akizuki?.slackReceiptNoticeAt === "2026-11-09 16:02:41 JST" && akizuki?.slackReceiptFile === "20261105_2600JPY_秋月電子_領収書.pdf", "akizuki notice");
  check(akizuki?.evidenceCheck.endsWith("UPSIDERの「領収証を添付しました」を2026-11-09 16:02:41 JSTに確認した。"), "akizuki evidence check ends with the notice");
  check(akizuki?.deliveryStatus === "出荷済み" && akizuki?.trackingNumber === "437180618571" && akizuki?.deliveryConfirmed === false, "akizuki shipment is unconfirmed");
  check(akizuki?.memoPresent === true && akizuki?.orderNumber === "EC261105-069042182-01", "akizuki memo and order kept");
  check(akizuki?.slack.endsWith("1793850104.514049") && !needsAction(akizuki), "akizuki leaves the action queue");
  const earth = ledger.transactions.find((tx) => tx.id === "tx-20261102-2054-earth-5570");
  check(earth?.drive === "https://drive.google.com/file/d/1Mc2l_KfD-eHDzObdVr3xtEoLNJoJKQSG/view" && earth?.receiptNumber === "C333470", "earth receipt");
  check(earth?.status === "登録完了" && earth?.priorStatus === "証憑保存済・Slack未添付" && earth?.amount === "¥5,570" && earth?.amountYen === 5570, "earth registered without an amount change");
  check(earth?.slackAttachmentStatus === "添付済み（シバタさん手動添付 2026-11-10 13:49:59 JST）", "earth manual attachment");
  check(earth?.upSiderReceiptRegistrationStatus === "UPSIDER「領収証を添付しました」2026-11-10 13:50:07 JST確認", "earth registration notice");
  check(earth?.statusUpdatedAt === "2026-11-11 09:34 JST" && earth?.slackReceiptFile === "20261102_5570JPY_アースダンボール_領収書.pdf" && earth?.slackReceiptPostedAt === "2026-11-10 13:49:59 JST" && earth?.slackReceiptPostedBy === "Yoshihiro Shibata" && earth?.slackReceiptNoticeAt === "2026-11-10 13:50:07 JST", "earth receipt times");
  check(earth?.priorSlackAttachmentStatus === "未添付（ユーザーが手動で添付予定）" && earth?.evidenceCheck.includes("領収証を提出しています") && earth?.evidenceCheck.includes("株式会社アースダンボール"), "earth prior attachment and issuer");
  check(earth?.deliveryStatus === "出荷済み（納入予定2026-11-10）" && earth?.carrier === "福山通運" && earth?.shippedDate === "2026-11-09" && earth?.trackingNumber === "66583392606" && earth?.expectedDeliveryDate === "2026-11-10" && earth?.deliveryConfirmed === false && earth?.expectedShippingDate === undefined, "earth shipping");
  check(earth?.deliveryNoteFile === "https://drive.google.com/file/d/12UcuIa_b5oA8PHpqp4OVjMu947EW6UO8/view", "earth delivery note file");
  check(earth?.content === "プロダクト販売用段ボール" && earth?.slackAttachmentError === undefined && !needsAction(earth), "earth content and no share refusal");
  const carton = ledger.transactions.find((tx) => tx.id === "tx-20261106-1553-danballace-7160");
  check(carton?.drive === "https://drive.google.com/file/d/1kZw-pFbWVnaT3csoEGb0w5DfMkrW5RKO/view" && carton?.receiptNumber === "C333471", "danballace receipt");
  check(carton?.status === "登録完了" && carton?.priorStatus === "証憑保存済・Slack未添付" && carton?.amountYen === 7160, "danballace registered without an amount change");
  check(carton?.slackAttachmentStatus === "添付済み（シバタさん手動添付 2026-11-10 13:49:44 JST）", "danballace manual attachment");
  check(carton?.upSiderReceiptRegistrationStatus === "UPSIDER「領収証を添付しました」2026-11-10 13:49:52 JST確認", "danballace registration notice");
  check(carton?.statusUpdatedAt === "2026-11-11 09:34 JST" && carton?.slackReceiptFile === "20261106_7160JPY_アースダンボール_領収書.pdf" && carton?.slackReceiptPostedBy === "Shibata" && carton?.slackReceiptNoticeAt === "2026-11-10 13:49:52 JST", "danballace receipt times");
  check(carton?.evidenceCheck.includes("領収証を提出しています") && carton?.priorSlackAttachmentStatus === "未添付（ユーザーが手動で添付予定）", "danballace submitting notice");
  check(carton?.deliveryStatus === "注文準備中" && carton?.priorDeliveryStatus === "発送予定連絡" && carton?.carrier === "佐川急便" && carton?.expectedShippingDate === "2026-11-13" && carton?.expectedDeliveryDate === "2026-11-16", "danballace shipping");
  check(carton?.content === "YUBI梱包用ダンボール80サイズ 50枚" && carton?.slackAttachmentError === undefined && !needsAction(carton), "danballace content and no share refusal");
  check(Object.keys(EVIDENCE_URLS).length === 5, "five evidence urls");
  for (const [id, url] of Object.entries(EVIDENCE_URLS)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(Boolean(tx), `missing evidenced tx ${id}`);
    check(tx?.status === "登録完了", `evidenced status ${id}`);
    check(tx?.drive === url, `drive url ${id}`);
    check(tx?.detailSection === false, `evidenced leaves unhandled details ${id}`);
    check(!ledger.details.some((detail) => detail.transactionId === id), `detail removed ${id}`);
  }
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-1703-amazon-2659")?.slack.endsWith("1793865808.053419"), "slack 2659");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2124-amazon-14680")?.slack.endsWith("1793881469.106739"), "slack 14680");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2312-amazon-9300")?.slack.endsWith("1793887975.184129"), "slack 9300");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2312-amazon-2117")?.slack.endsWith("1793887975.859849"), "slack 2117");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261106-0113-amazon-255")?.slack.endsWith("1793895200.333029"), "slack 255");
  check(ledger.transactions.filter((tx) => String(tx.drive).startsWith("https://")).length === 38, "thirty-eight drive urls");
  const savedUrls = {
    "tx-20261105-1253-monotaro-17553": ["https://drive.google.com/file/d/1jDKF67ouM3XLEfFoST-3FCfkjUEuEZle/view?usp=drivesdk", "2026-11-07 22:05:13 JST"],
    "tx-20261105-1404-monotaro-4833": ["https://drive.google.com/file/d/15cZV1IiQHyZRbDHykorO0DEes7XByYFD/view?usp=drivesdk", "2026-11-07 22:05:13 JST"],
    "tx-20261104-2114-misumi-16614": ["https://drive.google.com/file/d/1HfunjbtjE_pIRvdzKBPvUjmkMzO55b3-/view?usp=drivesdk", "2026-11-07 22:11:16 JST"],
  };
  const manualReceipts = {
    "tx-20261105-1253-monotaro-17553": ["20261105_17553JPY_モノタロウ_領収証.pdf", "2026-11-09 15:27:59 JST", "2026-11-09 15:28:09 JST", "Yoshihiro Shibata"],
    "tx-20261105-1404-monotaro-4833": ["20261105_4833JPY_モノタロウ_領収証.pdf", "2026-11-09 15:28:33 JST", "2026-11-09 15:28:41 JST", "ユーザー"],
    "tx-20261104-2114-misumi-16614": ["20261104_16614JPY_ミスミ_領収書・ご注文明細書.pdf", "2026-11-09 15:28:59 JST", "2026-11-09 15:29:08 JST", "ユーザー"],
  };
  for (const [id, [url, savedAt]] of Object.entries(savedUrls)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    const [file, postedAt, noticeAt, postedBy] = manualReceipts[id];
    check(tx?.status === "登録完了" && tx?.priorStatus === "証憑保存済・Slack未添付" && tx?.drive === url, `registered drive ${id}`);
    check(tx?.accountingPdfAcquiredAt === savedAt, `pdf time ${id}`);
    check(tx?.slackAttachmentStatus === "添付済（ユーザーが手動）", `manual attachment ${id}`);
    check(tx?.priorSlackAttachmentStatus === "未添付（共有制限で停止）", `prior attachment status ${id}`);
    check(tx?.priorSlackAttachmentError === "mcp_externally_shared_channel_restricted", `prior share rejection ${id}`);
    check(tx?.slackAttachmentError === undefined, `current share rejection cleared ${id}`);
    check(tx?.slackAttachmentAttemptAt === "2026-11-07 23:30:13 JST", `attempt time ${id}`);
    check(tx?.slackReceiptFile === file && tx?.slackReceiptPostedAt === postedAt && tx?.slackReceiptNoticeAt === noticeAt, `receipt times ${id}`);
    check(tx?.slackReceiptPostedBy === postedBy && tx?.slackReceiptNotice === "領収証を添付しました", `receipt notice ${id}`);
    check(tx?.upSiderReceiptRegistrationStatus === "登録完了（ユーザーが手動添付。UPSIDER『領収証を添付しました』を確認）", `registered ${id}`);
    check(!needsAction(tx), `registered leaves action queue ${id}`);
  }
  check(ledger.slackReceiptAttachment?.attempted === 3 && ledger.slackReceiptAttachment?.attached === 3 && ledger.slackReceiptAttachment?.blocked === 0 && ledger.slackReceiptAttachment?.upSiderRegistered === 3, "attachment result counts");
  check(ledger.slackReceiptAttachment?.error === undefined && ledger.slackReceiptAttachment?.priorAttempt?.error === "mcp_externally_shared_channel_restricted" && ledger.slackReceiptAttachment?.priorAttempt?.blocked === 3, "blocked attempt kept as history");
  check(ledger.evidencePatrol?.lastSuccessfulAcquisitionAt === "2026-11-27 09:33 JST", "receipt pdf time");
  check(ledger.evidencePatrol?.previousLastSuccessfulAcquisitionAt === "2026-11-26 09:16 JST", "previous receipt pdf time kept");
  check(ledger.evidencePatrol?.lastSuccessfulAcquisitionMeaning.includes("20261125_27779JPY_モノタロウ_領収証.pdf") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("B8640408") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("T6140001054380") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("株式会社ＭｏｎｏｔａＲＯ") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("1roziQlZi3XlXycPfboY2xGenPlCXYlE-") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("20261125_6741JPY_Amazon_適格請求書.pdf") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("株式会社ユーグリーン・ジャパン") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("T7010901052842") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("1qw_sTud4m3-oXg0_MPCqIICbxxzipG8H") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("09:33") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("09:32") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("投稿者UPSIDER") && ledger.evidencePatrol.lastSuccessfulAcquisitionMeaning.includes("メモ登録はしていない"), "pdf time covers the monotaro receipt and the amazon invoice");
  check(ledger.memoCheck?.lastIncrementalCheckedAt === "2026-11-09 09:26:56 JST" && ledger.memoCheck?.lastIncrementalThreadsScanned === 18, "eighteen threads rechecked");
  check(ledger.memoCheck?.previousIncrementalCheckedAt === "2026-11-08 09:07 JST" && ledger.memoCheck?.previousIncrementalThreadsScanned === 8, "11/08 incremental check kept");
  check(ledger.memoCheck?.lastIncrementalLimit.includes("増減比較はしない"), "reply counts are not compared");
  check(ledger.slackReceiptAttachment?.retryOn20261109 === false, "refused receipts were not resent");
  const actions = actionSummary(ledger.transactions);
  check(isNotOwnerStatus(NOT_OWNER_STATUS) && isNotOwnerStatus(NOT_OWNER_STATUS_20261111) && !isNotOwnerStatus("メモ・証憑なし"), "both not-owner statuses are excluded");
  check(actions.action === 39 && actions.refund === 2 && actions.notOwner === 4 && actions.excluded === 6 && actions.done === 22, `action summary ${JSON.stringify(actions)}`);
  check(actions.action === ledger.transactions.length - actions.excluded - actions.done, "action count excludes refund, not-owner, and completed");
  const actionIds = ledger.transactions.filter(needsAction).map((tx) => tx.id).sort();
  const previousActionIds = [
    "tx-20261111-1553-amazon-0",
    "tx-20261111-2343-amazon-2399",
    "tx-20261113-0053-monotaro-18678",
    "tx-20261113-1023-monotaro-1318",
    "tx-20261113-2255-wilco-20900",
    "tx-20261114-0123-monotaro-439",
    "tx-20261114-0209-monotaro-3953",
    "tx-20261114-0426-misumi-3267",
  ].sort();
  const addedActionIds = [
    "tx-20261115-2123-amazon-3080",
    "tx-20261115-2134-amazon-14549",
    "tx-20261115-2140-eventpay-9000",
    "tx-20261115-2140-google-0",
    "tx-20261115-2152-switchscience-3560",
    "tx-20261115-2230-monotaro-17151",
    "tx-20261115-2231-monotaro-2198",
  ];
  const midnightActionIds = previousActionIds.concat(addedActionIds).sort();
  const expectedActionIds = midnightActionIds.filter((id) => id !== "tx-20261115-2140-eventpay-9000").concat([
    "tx-20261116-0006-monotaro-1868",
    "tx-20261116-0232-amazon-5003",
  ]).sort();
  const patrolActionIds = expectedActionIds.concat(["tx-20261116-0023-amazon-49704"]).sort();
  const morningActionIds = patrolActionIds.concat([
    "tx-20261116-2027-monotaro-8965",
    "tx-20261116-2030-monotaro-2109",
    "tx-20261117-0001-jlcpcb-25017",
  ]).sort();
  const todayActionIds = morningActionIds.concat([
    "tx-20261117-1823-monotaro-10993",
    "tx-20261117-1831-misumi-7878",
    "tx-20261118-2127-misumi-10890",
    "tx-20261118-2211-nejikuru-5782",
    "tx-20261118-2234-misumi-5984",
  ]).filter((id) => id !== "tx-20261113-0053-monotaro-18678").concat([
    "tx-20261119-1514-misumi-8745",
    "tx-20261119-2351-jtbamarys-8000",
    "tx-20261120-0345-adam-33246",
    "tx-20261120-1654-paypal-0",
    "tx-20261120-1655-seeed-691525",
    "tx-20261122-1841-dhl-4500",
    "tx-20261122-2126-monotaro-23857",
    "tx-20261123-0353-nejikuru-27379",
    "tx-20261124-1730-monotaro-27779",
    "tx-20261125-1732-amazon-6741",
    "tx-20261125-1841-monotaro-34056",
    "tx-20261125-1846-monotaro-16803",
    "tx-20261126-0238-nejikuru-3300",
    "tx-20261126-0340-monotaro-5498",
    "tx-20261126-0753-amazon-6990",
  ]).sort();
  check(JSON.stringify(actionIds) === JSON.stringify(todayActionIds), `action ids ${actionIds.join(",")}`);
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify(patrolActionIds), "16:30 action ids kept");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify(expectedActionIds), "stored action ids match the status count");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify(midnightActionIds), "midnight action ids kept");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify(previousActionIds), "morning action ids kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-16 09:16 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。投稿・添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 16 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6, "morning stored counts");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 43 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 1 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261115-2140-eventpay-9000", "tx-20261116-0006-monotaro-1868", "tx-20261116-0232-amazon-5003"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("本文なし") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("領収証を添付しました") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("新規2件") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない"), "morning check registered the event pay receipt and added two rows");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-16 00:02 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。投稿・添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 20 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 15 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6, "midnight stored counts");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 41 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === JSON.stringify(["tx-20261115-2140-eventpay-9000"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261111-2343-amazon-2399", "tx-20261113-0053-monotaro-18678"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note === "Slackブラウザ確認 11/16 00:02、15件のスレッド確認、メモ登録済3件（EVENT PAY ¥9,000・Amazon ¥2,399・MonotaRO ¥18,678）、領収証添付なし、新規カードなし", "midnight check changed two statuses and attached nothing");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 7 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 41 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === JSON.stringify(["tx-20261115-2140-eventpay-9000"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261115-2123-amazon-3080", "tx-20261115-2134-amazon-14549", "tx-20261115-2140-google-0", "tx-20261115-2140-eventpay-9000", "tx-20261115-2152-switchscience-3560", "tx-20261115-2230-monotaro-17151", "tx-20261115-2231-monotaro-2198"]), "evening check added seven rows and attached nothing");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("RESEND ¥3,322") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("TX-20261115-AMZ-001") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("¥5,003") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 3, "evening out-of-scope list");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("1794745427.252579") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("証憑保存済・Slack未添付") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("RESEND ¥3,322") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモあり21件"), "evening note");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-16 09:16 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 18 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("メモ作成は行っていない"), "morning memo check");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-16 00:02 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 16 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 3 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note === "Slackブラウザ確認 11/16 00:02、15件のスレッド確認、メモ登録済3件（EVENT PAY ¥9,000・Amazon ¥2,399・MonotaRO ¥18,678）、領収証添付なし、新規カードなし", "midnight memo check");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-15 22:45 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 21 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 19 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新規7件にも決済メモ完了通知はない"), "evening memo check");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-15 09:20 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。投稿・添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 20 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 8 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6, "stored counts");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 34 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === "[]", "no new card and no status change, nothing sent");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note === "新しい決済カードはない。要処理8件のスレッドはいずれも返信がなく、メモ完了通知も領収証添付通知もない。ステータス変化なし。", "note matches this check");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-14 09:20 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newTransactions === 5 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.ledgerRows === 34 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.statusChanges) === JSON.stringify(["tx-20261111-1404-monotaro-30017", "tx-20261111-1546-monotaro-4065", "tx-20261111-1940-misumi-44189", "tx-20261113-1023-monotaro-1318", "tx-20261113-2255-wilco-20900", "tx-20261114-0123-monotaro-439", "tx-20261114-0209-monotaro-3953", "tx-20261114-0426-misumi-3267"]), "11/14 check nested");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("B8538556") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("株式会社ＭｏｎｏｔａＲＯ") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("21:36") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("T9010601030898") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("内容の行を省略") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("適格請求書待ち") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("134323400032") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("要処理8件") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモあり21件"), "11/14 note kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("Bambu ¥228,000") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[5]?.includes("JLCPCB ¥8,218") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 6, "six out-of-scope charges recorded");
  check(!ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("Slack未着"), "the 2399 charge is no longer described as unarrived");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcludedIds) === JSON.stringify(["tx-20261109-1754-github-392", "tx-20261109-1755-github-783", "tx-20261110-1051-github-47", "tx-20261111-1259-github-22"]), "stored not-owner exclusion");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-13 19:30 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.routine === "領収書のDrive保存" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.needsAction === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.ledgerRows === 29 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newTransactions === 0, "19:30 check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.savedNotAttached) === JSON.stringify(["tx-20261111-1404-monotaro-30017", "tx-20261111-1546-monotaro-4065", "tx-20261111-1940-misumi-44189"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.statusChanges) === JSON.stringify(["tx-20261111-1404-monotaro-30017", "tx-20261111-1546-monotaro-4065", "tx-20261111-1940-misumi-44189"]), "19:30 saved the three receipts");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("登録完了にはしていない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("要処理6件"), "19:30 note kept");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-15 09:20 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 21 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 12 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0, "memo check records this pass");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note === "新しい決済メモ完了通知はない。要処理8件のスレッドは返信0件。", "no new memo completion");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.checkedAt === "2026-11-14 09:20 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.memoPresent === 21 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.unconfirmed === 12 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.newMemoCompletions === 1 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.note.includes("内容の行を省略") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.note.includes("メモあり21件"), "11/14 memo check nested");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous?.checkedAt === "2026-11-13 19:30 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous?.memoPresent === 20 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous?.unconfirmed === 8 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous?.note.includes("メモは未登録のまま"), "19:30 memo check kept");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.checkedAt === "2026-11-13 09:21 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.memoPresent === 20 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.unconfirmed === 8 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.newMemoCompletions === 0, "previous memo check kept");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.previous?.checkedAt === "2026-11-12 09:20 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.previous?.memoPresent === 20 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous.previous.previous?.previous?.unconfirmed === 7, "earlier memo check kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-13 09:21 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.needsAction === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.ledgerRows === 29 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newTransactions === 5, "09:21 check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.statusChanges) === "[]", "09:21 statuses stayed unchanged");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.excludedOutOfScope?.[0]?.includes("EVENTOS ¥0") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("1794476079.988119"), "eventos stays out of scope");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.excludedOutOfScope?.[1]?.includes("BRAVESOFT INC. ¥0") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[1].includes("1794476131.214289"), "bravesoft zero stays out of scope");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.excludedOutOfScope?.[2]?.includes("BRAVESOFT INC. ¥60,500") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[2].includes("1794476153.915879"), "bravesoft charge stays out of scope");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.excludedOutOfScope?.[3]?.includes("DP4*RAKSUL ¥4,711") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[3].includes("1794480409.627769"), "raksul stays out of scope");
  check(!ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.excludedOutOfScope.some((item) => item.includes("未着")) && !ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("Slack未着"), "the 09:21 note does not describe 2399 as unarrived");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("要処理は6件") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("確認決済（¥0、本決済¥2,399は別行）") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("0417677859336") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("適格請求書ではない"), "09:21 note kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.checkedAt === "2026-11-12 09:20 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.needsAction === 5 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.ledgerRows === 28 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.newTransactions === 4, "morning check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.statusChanges) === JSON.stringify(["tx-20261111-1404-monotaro-30017", "tx-20261111-1546-monotaro-4065", "tx-20261111-1553-amazon-0"]), "previous status changes kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.excludedOutOfScope?.[0]?.includes("HIMARI SHOTEN ¥26,310") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("1794400760.220609"), "himari stays out of scope");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.excludedOutOfScope?.[1]?.includes("GITHUB, INC. ¥16,432") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[1].includes("USD 101.20"), "github 16432 stays out of scope");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.checkedAt === "2026-11-11 18:47 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.routine === "UPSIDERチェック" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.needsAction === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.ledgerRows === 26, "evening check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.statusChanges) === JSON.stringify(["tx-20261105-1357-nisshin-17600", "tx-20261111-1259-github-22"]), "evening status changes kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.checkedAt === "2026-11-11 09:34 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.registeredComplete === 16 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.needsAction === 1 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.ledgerRows === 22, "earlier morning check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.statusChanges) === JSON.stringify(["tx-20261102-2054-earth-5570", "tx-20261106-1553-danballace-7160"]), "11/11 morning status changes kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.checkedAt === "2026-11-10 13:40:00 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.registeredComplete === 14 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.needsAction === 3, "previous afternoon check nested");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.previous?.checkedAt === "2026-11-10 09:06 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.previous?.registeredComplete === 14 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.previous?.needsAction === 5, "earlier morning check nested");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.previous?.previous?.checkedAt === "2026-11-09 16:25 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.previous?.previous?.previous?.previous?.previous?.registeredComplete === 13 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0, "earlier check kept and nothing was sent");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcludedIds].sort()) === JSON.stringify(["tx-20261102-2053-earth-23960", REFUND_ID].sort()), "stored refund exclusion");
  check(!ledger.transactions.some((tx) => /VERCEL|DOCUSIGN/.test(tx.merchant)), "out of scope merchants are not rows");
  const attachment = attachmentResultView(ledger);
  check(attachment?.manual === true && attachment?.succeeded === 3 && attachment?.incomplete === 0 && attachment?.checkedAt === "2026-11-09 15:31 JST" && attachment?.rows.length === 0, `attachment view ${JSON.stringify(attachment && { manual: attachment.manual, succeeded: attachment.succeeded, incomplete: attachment.incomplete, checkedAt: attachment.checkedAt, rows: attachment.rows.length })}`);
  check(attachment?.note.includes("ユーザーが3件とも手動で添付した") && attachment.note.includes("領収証を添付しました"), "manual attachment note");
  check(ledger.transactions.filter((tx) => shareRestrictionRemark(tx)).length === 0, "share-refused remarks are cleared");
  const blockedView = attachmentResultView({
    slackReceiptAttachment: { attached: 0, blocked: 3, error: "mcp_externally_shared_channel_restricted", checkedAt: "2026-11-07 23:30:13 JST" },
    transactions: [{ id: "blocked", status: "証憑保存済・Slack未添付", slackAttachmentError: "mcp_externally_shared_channel_restricted" }],
  });
  check(blockedView?.manual === false && blockedView?.incomplete === 3 && blockedView?.rows.length === 1, "blocked view stays available for an unattached ledger");
  const misumi = ledger.transactions.find((tx) => tx.id === "tx-20261104-2114-misumi-16614");
  check(misumi?.status === "登録完了" && misumi?.amountYen === 16614 && misumi?.orderNumber === "AB256FB3F5" && misumi?.ledgerId === "TX-20261104-MSM-001", "misumi identity unchanged");
  check(misumi?.deliveryStatus === "納入済み（2026-11-09 納品書受領）" && misumi?.deliveryConfirmed === true && misumi?.deliveryConfirmedAt === "2026-11-09 22:52 JST" && misumi?.deliveryEvidence === "ScanSnap納品書（伝票123402・123403、出荷日2026-11-06、計16,614円）" && misumi?.expectedDeliveryDate === "2026-11-09", "misumi delivery confirmed");
  check(misumi?.evidenceCheck === "クレジットカード支払、最終出荷日後の税込合計受領文言あり。注文番号・税込額・税額・登録番号を実読確認。2026-11-09 納品書受領で納入済み。", "misumi evidence check ending replaced");
  check(!misumi?.evidenceCheck.includes("納入済とはしない"), "misumi is no longer marked undelivered");
  check(misumi?.evidenceAcquisitionStatus === "正式領収書の取得・保存確認済", "misumi 403 note replaced");

  const refund = ledger.transactions.find((tx) => tx.id === REFUND_ID);
  check(Boolean(refund), "refund included");
  check(refund?.merchant === "DANBALLACE" && refund?.datetime === "11/04 09:23", "refund identity");
  check(refund?.amount === "-¥23,960" && refund?.amountYen === -23960, "refund amount");
  check(refund?.status === REFUND_STATUS, "refund status");
  check(refund?.memoStatus === "不要" && refund?.memoPresent !== true, "refund memo exempt");
  check(refund?.drive === "証憑不要", "refund drive");
  check(refund?.detailSection === false, "refund is not an unhandled detail");
  check(refund?.slack.endsWith("1793751790.582399"), "refund slack");
  check(refund?.refundRole === "返金投稿" && refund?.refundPairId === "tx-20261102-2053-earth-23960", "refund pair kept");
  check(filterTransactions(ledger.transactions, "すべて").some((tx) => tx.id === REFUND_ID), "refund stays in the full list");
  const refundSource = ledger.transactions.find((tx) => tx.id === "tx-20261102-2053-earth-23960");
  check(refundSource?.merchant === "アースダンボール" && refundSource?.amountYen === 23960 && refundSource?.amount === "¥23,960", "refund source amount kept");
  check(refundSource?.orderNumber === "1881489" && refundSource?.drive === "なし", "refund source order and drive kept");
  check(refundSource?.slack.endsWith("1793620385.051929"), "refund source slack kept");
  check(refundSource?.upSiderTransactionId === "549bde33-c564-4db9-91af-7d776fc10282", "refund source id kept");
  check(refundSource?.content === "プロダクト販売用段ボール（梱包用50セット）", "refund source content kept");
  check(refundSource?.status === REFUND_STATUS && refundSource?.priorStatus === "証憑なし", "refund source leaves the action queue");
  check(refundSource?.memoPresent === true && refundSource?.memoEvidence.length === 1, "refund source memo history kept");
  check(refundSource?.refundPairId === REFUND_ID, "refund source points at the refund post");
  check(!needsAction(refundSource) && !needsAction(refund), "both refund rows are outside the action count");
  const nisshin = ledger.transactions.find((tx) => tx.id === "tx-20261105-1357-nisshin-17600");
  check(nisshin?.status === "登録完了" && nisshin?.priorStatus === "証憑なし" && nisshin?.amount === "¥17,600" && nisshin?.amountYen === 17600 && nisshin?.content === "HyperVシート PX-10H 15 非耐油 W270×L270×H1.5mm ×5", "nisshin registered without an amount change");
  check(nisshin?.memoPresent === true && nisshin?.memoStatus === "あり" && nisshin?.memoEvidence?.[0]?.notice === "決済メモを追加しました！", "nisshin memo was already registered");
  check(nisshin?.evidenceStatus === "Slack添付確認済" && nisshin?.evidenceStatusAt === "2026-11-05 18:50 JST" && nisshin?.slackAttachmentStatus === "Slack添付確認済", "nisshin evidence status");
  check(nisshin?.slackReceiptFile === "nisshin-4735.png" && nisshin?.slackReceiptPostedAt === "2026-11-05 18:50 JST" && nisshin?.slackReceiptNotice === "領収証を添付しました" && nisshin?.slackReceiptObservedAt === "2026-11-11 18:47 JST", "nisshin slack receipt");
  check(nisshin?.drive === "あり" && nisshin?.priorDrive === "なし（誤添付を削除）" && !nisshin.drive.startsWith("https://"), "nisshin drive url was not invented");
  check(!needsAction(nisshin), "nisshin leaves the action queue");
  const githubRows = [
    ["tx-20261109-1754-github-392", "¥392", 392, "USD 2.42", "2026-11-09 17:54:16 JST", "1794214457.091699", "19d4ace8-8c22-4266-b43e-f55d6ec58050", "TX-20261109-GHB-001", "2026-11-10 13:40 JST"],
    ["tx-20261109-1755-github-783", "¥783", 783, "USD 4.83", "2026-11-09 17:55:29 JST", "1794214530.632489", "d910f06d-69ce-4253-81cd-8311c5a46b31", "TX-20261109-GHB-002", "2026-11-10 13:40 JST"],
    ["tx-20261110-1051-github-47", "¥47", 47, "USD 0.29", "2026-11-10 10:51:03 JST", "1794275464.574969", "", "TX-20261110-GHB-003", "2026-11-10 13:41 JST"],
  ];
  for (const [id, amount, yen, foreignAmount, paidAt, thread, transactionId, ledgerId, answeredAt] of githubRows) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.merchant === "GITHUB, INC." && tx?.amount === amount && tx?.amountYen === yen && tx?.foreignAmount === foreignAmount, `github amount ${id}`);
    check(tx?.status === NOT_OWNER_STATUS && tx?.priorStatus === "メモ・証憑なし" && tx?.memoStatus === "未確認" && tx?.memoPresent !== true && tx?.memoEvidence == null && tx?.drive === "なし", `github excluded ${id}`);
    check(tx?.classification === "本人以外の課金" && tx?.purpose === "要処理対象外" && tx?.content.includes(foreignAmount) && tx?.content.includes("シバタさん回答 2026-11-10"), `github content ${id}`);
    check(tx?.paidAt === paidAt && tx?.slack.endsWith(thread) && tx?.ledgerId === ledgerId && tx?.statusUpdatedAt === answeredAt, `github identity ${id}`);
    check(tx?.detailSection === false && !needsAction(tx), `github leaves the action queue ${id}`);
    check(filterTransactions(ledger.transactions, "すべて").some((row) => row.id === id), `github stays listed ${id}`);
    if (transactionId) {
      check(tx?.upSiderTransactionId === transactionId && tx?.cardName === "SaaS決済用" && tx?.priorClassification === "通常購買候補", `github card ${id}`);
    } else {
      check(tx?.upSiderTransactionId === undefined && tx?.cardName === undefined && tx?.ownerAnswerAt === "2026-11-10 13:41 JST", "github 47 has no invented card id");
    }
  }
  const github22 = ledger.transactions.find((tx) => tx.id === "tx-20261111-1259-github-22");
  check(github22?.merchant === "GITHUB, INC." && github22?.amount === "¥22" && github22?.amountYen === 22 && github22?.foreignAmount === "USD 0.14", "github 22 amount");
  check(github22?.status === NOT_OWNER_STATUS_20261111 && github22?.priorStatus === "メモ・証憑なし" && github22?.memoStatus === "未確認" && github22?.memoPresent !== true && github22?.memoEvidence == null && github22?.drive === "なし" && github22?.cardName === "SaaS決済用", "github 22 excluded");
  check(github22?.classification === "本人以外の課金" && github22?.purpose === "要処理対象外" && github22?.priorPurpose === "要確認" && github22?.content.includes("USD 0.14") && github22?.content.includes("シバタさん回答 2026-11-11"), "github 22 content");
  check(github22?.paidAt === "2026-11-11 12:59:50 JST" && github22?.slack.endsWith("1794369591.509309") && github22?.statusUpdatedAt === "2026-11-11 18:47 JST" && !needsAction(github22), "github 22 identity");
  check(github22?.statusReason.includes("行は削除しない") && github22?.statusReason.includes("返金除外とは別の理由"), "github 22 exclusion reason");
  check(filterTransactions(ledger.transactions, "すべて").some((row) => row.id === github22.id), "github 22 stays listed");
  check(github22?.ledgerId === undefined && github22?.upSiderTransactionId === undefined, "github 22 has no invented ledger id");
  const monotaro30017 = ledger.transactions.find((tx) => tx.id === "tx-20261111-1404-monotaro-30017");
  check(monotaro30017?.merchant === "MonotaRO" && monotaro30017?.slackMerchant === "DP12*MONOTARO.COM" && monotaro30017?.amountYen === 30017 && monotaro30017?.cardholder === "柴田 善広" && monotaro30017?.cardName === "AIハンド決済用", "monotaro 30017 identity");
  check(monotaro30017?.status === "登録完了" && monotaro30017?.priorStatus === "証憑保存済・Slack未添付" && monotaro30017?.memoStatus === "あり" && monotaro30017?.memoPresent === true && monotaro30017?.drive === "https://drive.google.com/file/d/1xaRjk-UuOI_SWzBO9e6bHz3VMu5BGL61/view?usp=drivesdk" && monotaro30017?.deliveryStatus === "納入待ち" && !needsAction(monotaro30017), "monotaro 30017 status");
  check(monotaro30017?.evidenceType === "領収証" && monotaro30017?.receiptNumber === "B8538556" && monotaro30017?.receiptIssueDate === "2026-11-13" && monotaro30017?.qualifiedInvoiceNumber === "T6140001054380" && monotaro30017?.slackAttachmentStatus === "添付済み（柴田 善広 2026-11-13 21:35 JST）" && monotaro30017?.slackReceiptFile === "20261111_30017JPY_モノタロウ_領収証.pdf" && monotaro30017?.slackReceiptPostedBy === "柴田 善広" && monotaro30017?.slackReceiptNotice === "領収証を添付しました" && monotaro30017?.slackReceiptNoticeAt === "2026-11-13 21:35 JST" && monotaro30017?.slackReceiptObservedAt === "2026-11-14 09:20 JST" && monotaro30017?.evidenceCheck.includes("株式会社ＭｏｎｏｔａＲＯ") && monotaro30017?.slackAttachmentError === undefined, "monotaro 30017 receipt");
  check(monotaro30017?.memoEvidence?.[0]?.notice === "決済メモを追加しました！" && monotaro30017?.memoEvidence?.[0]?.postedBy === "UPSIDER" && monotaro30017?.memoEvidence?.[0]?.postedAt === "2026-11-11 20:48:44 JST" && monotaro30017?.memoEvidence?.[0]?.ts === null, "monotaro 30017 memo notice");
  check(monotaro30017?.registeredMemo?.purpose === "AIハンド製造ライン用資材収納用品購入" && monotaro30017?.registeredMemo?.seg1 === "AIハンド" && monotaro30017?.registeredMemo?.seg2 === "その他" && monotaro30017?.registeredMemo?.category === "備品" && monotaro30017?.registeredMemo?.content === monotaro30017.content && monotaro30017?.registeredMemo?.repliedAt === "2026-11-11 20:48:41 JST", "monotaro 30017 registered memo");
  check(monotaro30017?.expectedDeliveryDate === "2026-11-12", "monotaro 30017 delivery date");
  check(monotaro30017?.ledgerId === "TX-20261111-MNT-001" && monotaro30017?.orderNumber === "134323400030" && monotaro30017?.receptionNumber === "202639045" && monotaro30017?.paidAt === "2026-11-11 14:04:12 JST" && monotaro30017?.slack.endsWith("1794373453.560069"), "monotaro 30017 order");
  check(monotaro30017?.shipments?.[0]?.trackingNumber === "664362973562" && monotaro30017?.shipments?.[1]?.trackingNumber === "9583853145" && monotaro30017?.deliveryConfirmed === false, "monotaro 30017 shipments");
  const monotaro4065 = ledger.transactions.find((tx) => tx.id === "tx-20261111-1546-monotaro-4065");
  check(monotaro4065?.amountYen === 4065 && monotaro4065?.ledgerId === "TX-20261111-MNT-002" && monotaro4065?.orderNumber === "134323400031" && monotaro4065?.receptionNumber === "202654082", "monotaro 4065 order");
  check(monotaro4065?.status === "登録完了" && monotaro4065?.priorStatus === "証憑保存済・Slack未添付" && monotaro4065?.memoStatus === "あり" && monotaro4065?.memoPresent === true && monotaro4065?.drive === "https://drive.google.com/file/d/1btXLz-yTieyIoK0IAz8qsz4cW1O_TeFf/view?usp=drivesdk" && monotaro4065?.priorDeliveryStatus === "出荷待ち" && monotaro4065?.deliveryStatus === "納入待ち" && monotaro4065?.cardholder === "柴田 善広" && monotaro4065?.slack.endsWith("1794379576.006419") && monotaro4065?.content.includes("セメダイン スーパーXゴールド AX-014 20mL ×5") && !needsAction(monotaro4065), "monotaro 4065 status");
  check(monotaro4065?.evidenceType === "領収証" && monotaro4065?.receiptNumber === "B8538572" && monotaro4065?.slackAttachmentStatus === "添付済み（柴田 善広 2026-11-13 21:35 JST）" && monotaro4065?.slackReceiptFile === "20261111_4065JPY_モノタロウ_領収証.pdf" && monotaro4065?.slackReceiptNotice === "領収証を添付しました" && monotaro4065?.slackReceiptNoticeAt === "2026-11-13 21:36 JST" && monotaro4065?.qualifiedInvoiceNumber === undefined, "monotaro 4065 receipt");
  check(monotaro4065?.memoEvidence?.[0]?.postedAt === "2026-11-11 20:50:02 JST" && monotaro4065?.memoEvidence?.[0]?.postedBy === "UPSIDER" && monotaro4065?.memoEvidence?.[0]?.ts === null && monotaro4065?.registeredMemo?.purpose === "YUBI製造用副資材購入" && monotaro4065?.registeredMemo?.seg2 === "プロダクト販売" && monotaro4065?.registeredMemo?.category === "副資材" && monotaro4065?.registeredMemo?.repliedAt === "2026-11-11 20:49:59 JST", "monotaro 4065 memo");
  check(monotaro4065?.shipments?.[0]?.carrier === "ヤマト" && monotaro4065?.shipments?.[0]?.trackingNumber === "426978601394" && monotaro4065?.shipments?.[0]?.note === "直送品、全数出荷" && monotaro4065?.shippedDate === "2026-11-11", "monotaro 4065 shipment");
  const amazonZero = ledger.transactions.find((tx) => tx.id === "tx-20261111-1553-amazon-0");
  check(amazonZero?.merchant === "Amazon" && amazonZero?.slackMerchant === "AMAZON CO JP" && amazonZero?.amount === "¥0" && amazonZero?.amountYen === 0, "amazon zero amount");
  check(amazonZero?.status === "確認決済（¥0、本決済¥2,399は別行）" && amazonZero?.priorStatus === "メモ・証憑なし" && amazonZero?.memoStatus === "未確認" && amazonZero?.drive === "なし" && amazonZero?.cardholder === "柴田 善広" && amazonZero?.cardName === "AIハンド決済用", "amazon zero status");
  check(amazonZero?.paidAt === "2026-11-11 15:53:54 JST" && amazonZero?.slack.endsWith("1794380035.547129") && amazonZero?.likelyOrderNumber === "250-6606641-6831015" && amazonZero?.likelyOrderLedgerId === "TX-20261111-AMZ-001" && amazonZero?.likelyOrderAmountYen === 2399 && amazonZero?.expectedDeliveryDate === "2026-11-12", "amazon zero points at the settled order");
  check(amazonZero?.pairedTransactionId === "tx-20261111-2343-amazon-2399" && amazonZero?.statusReason.includes("確認決済（¥0、本決済¥2,399は別行") && !amazonZero.content.includes("未着") && !amazonZero.statusReason.includes("未着") && needsAction(amazonZero), "amazon zero stays listed and the page still counts it");
  check(amazonZero?.memoDefault?.purpose === "銀座3Dプリンター用消耗品購入（¥2,399本決済の¥0確認決済）" && amazonZero?.memoDefault?.seg1 === "AIハンド" && amazonZero?.memoDefault?.seg2 === "その他" && amazonZero?.memoDefault?.category === "消耗品" && amazonZero?.memoDefault?.content === "確認決済（¥0）。本決済はTINMORRY 257×257mm コールドプレート ×1（注文250-6606641-6831015）" && !amazonZero?.registeredMemo, "amazon zero memo mirrors the settled order");
  const misumiNew = ledger.transactions.find((tx) => tx.id === "tx-20261111-1940-misumi-44189");
  check(misumiNew?.merchant === "ミスミ" && misumiNew?.slackMerchant === "DP5*MISUMI" && misumiNew?.amount === "¥44,189" && misumiNew?.amountYen === 44189 && misumiNew?.accountingTaxYen === 4017, "misumi 44189 amount");
  check(misumiNew?.status === "登録完了" && misumiNew?.priorStatus === "証憑保存済・Slack未添付" && misumiNew?.memoStatus === "あり" && misumiNew?.memoPresent === true && misumiNew?.drive === "https://drive.google.com/file/d/1OzxJkEKS6GvpfE2CgopfOEWX5CJRtKhg/view?usp=drivesdk" && misumiNew?.deliveryStatus === "納入済み（2026-11-13 納品書受領）" && misumiNew?.priorDeliveryStatus === "出荷済（納入待ち）" && misumiNew?.deliveryConfirmed === true && misumiNew?.cardholder === "柴田 善広" && misumiNew?.cardName === "AIハンド決済用" && !needsAction(misumiNew), "misumi 44189 status");
  check(misumiNew?.paidAt === "2026-11-11 19:40:05 JST" && misumiNew?.slack.endsWith("1794393605.849899") && misumiNew?.ledgerId === "TX-20261111-MSM-001" && misumiNew?.orderNumber === "AB25748GD4" && misumiNew?.content === "イグリデュール G GFM-2023-07 ×121" && misumiNew?.expectedShippingDate === "2026-11-12" && misumiNew?.expectedDeliveryDate === "2026-11-13" && misumiNew?.shippedDate === "2026-11-12", "misumi 44189 order");
  check(misumiNew?.evidenceType === "領収書" && misumiNew?.qualifiedInvoiceNumber === "T9010601030898" && misumiNew?.slackAttachmentStatus === "添付済み（柴田 善広 2026-11-13 21:35 JST）" && misumiNew?.slackReceiptFile === "20261111_44189JPY_ミスミ_領収書.pdf" && misumiNew?.slackReceiptNotice === "領収証を添付しました" && misumiNew?.slackReceiptNoticeAt === "2026-11-13 21:35 JST" && misumiNew?.evidenceCheck.includes("株式会社ミスミ") && misumiNew?.deliveryEvidence === "納品書受領（2026-11-13）", "misumi 44189 receipt");
  check(misumiNew?.shipments?.[0]?.carrier === "SBS即配サポート" && misumiNew?.shipments?.[0]?.trackingNumber === "0417677859336" && misumiNew?.shipments?.[0]?.item === "GFM-2023-07 ×121" && misumiNew?.shipments?.[0]?.note === "全数出荷" && misumiNew?.statusUpdatedAt === "2026-11-14 09:20 JST" && misumiNew?.memoEvidence?.[0]?.notice === "決済メモを追加しました！" && misumiNew?.memoEvidence?.[0]?.postedAt === "2026-11-13 21:34 JST" && misumiNew?.memoEvidence?.[0]?.note.includes("内容の行を省略"), "misumi 44189 shipment and memo");
  check(misumiNew?.registeredMemo?.purpose === "YUBI Glove製造用資材購入" && misumiNew?.registeredMemo?.seg1 === "AIハンド" && misumiNew?.registeredMemo?.seg2 === "プロダクト販売" && misumiNew?.registeredMemo?.category === "製造用資材" && misumiNew?.registeredMemo?.content === "樹脂製軸受、イグリデュール G GFM-2023-07 ×121" && misumiNew?.registeredMemo?.repliedBy === "柴田 善広" && misumiNew?.registeredMemo?.repliedAt === "2026-11-13 21:34 JST", "misumi 44189 registered memo");
  check(misumiNew?.memoDefault?.purpose === "YUBI Glove製造用資材購入" && misumiNew?.memoDefault?.seg2 === "プロダクト販売" && misumiNew?.memoDefault?.category === "製造用資材" && misumiNew?.memoDefault?.content === "樹脂製軸受、イグリデュール G GFM-2023-07 ×121" && JSON.stringify(memoDefaults(misumiNew)) === JSON.stringify(misumiNew.memoDefault), "misumi 44189 memo default");
  const amazon2399 = ledger.transactions.find((tx) => tx.id === "tx-20261111-2343-amazon-2399");
  check(amazon2399?.merchant === "Amazon" && amazon2399?.slackMerchant === "AMAZON CO JP" && amazon2399?.amount === "¥2,399" && amazon2399?.amountYen === 2399, "amazon 2399 amount");
  check(amazon2399?.status === "証憑なし" && amazon2399?.priorStatus === "メモ・証憑なし" && amazon2399?.memoStatus === "あり" && amazon2399?.memoPresent === true && amazon2399?.drive === "なし" && amazon2399?.cardholder === "柴田 善広" && amazon2399?.cardName === "AIハンド決済用" && amazon2399?.deliveryStatus === "納入済（2026-11-12 17:22 JST配達済み）" && amazon2399?.deliveryConfirmed === true && needsAction(amazon2399), "amazon 2399 status");
  check(amazon2399?.paidAt === "2026-11-11 23:43:44 JST" && amazon2399?.slack.endsWith("1794408224.262909") && amazon2399?.ledgerId === "TX-20261111-AMZ-001" && amazon2399?.orderNumber === "250-6606641-6831015" && amazon2399?.content.includes("TINMORRY 257×257mm コールドプレート ×1") && amazon2399?.orderReference === "YUBI製造SDS" && amazon2399?.expectedDeliveryDate === "2026-11-12" && amazon2399?.pairedTransactionId === amazonZero.id && amazon2399?.statusUpdatedAt === "2026-11-16 00:02 JST" && amazon2399?.statusReason.includes("適格請求書ではない") && amazon2399?.evidenceCheck.includes("https://drive.google.com/file/d/1HcZ-haZhwf4GUE3V4txhGjiRiFTxAZT_/view") && amazon2399?.evidenceCheck.includes("補助証憑の欄はない") && amazon2399?.evidenceCheck.includes("2026-11-16 16:33") && amazon2399?.evidenceCheck.includes("TINMORRY Store JP") && amazon2399?.statusReason.includes("TINMORRY Store JP") && amazon2399?.memoEvidence?.[0]?.notice === "決済メモを追加しました！" && amazon2399?.memoEvidence?.[0]?.postedAt === "2026-11-15 23:17:53 JST" && amazon2399?.memoEvidence?.[0]?.note.includes("23:05:40"), "amazon 2399 order");
  check(JSON.stringify(amazon2399?.registeredMemo) === JSON.stringify(amazon2399?.memoDefault) && amazon2399?.registeredMemo?.purpose === "銀座3Dプリンター用消耗品購入" && amazon2399?.registeredMemo?.seg1 === "AIハンド" && amazon2399?.registeredMemo?.seg2 === "その他" && amazon2399?.registeredMemo?.category === "消耗品" && amazon2399?.registeredMemo?.content === "TINMORRY 257×257mm コールドプレート ×1（発注番号 YUBI製造SDS）", "amazon 2399 registered memo");
  const monotaro18678 = ledger.transactions.find((tx) => tx.id === "tx-20261113-0053-monotaro-18678");
  check(monotaro18678?.merchant === "MonotaRO" && monotaro18678?.slackMerchant === "DP12*MONOTARO.COM" && monotaro18678?.amount === "¥18,678" && monotaro18678?.amountYen === 18678 && monotaro18678?.accountingAmountYen === 18678 && monotaro18678?.accountingTaxYen === 1698, "monotaro 18678 amount");
  check(monotaro18678?.status === "登録完了" && monotaro18678?.priorStatus === "証憑なし" && monotaro18678?.memoStatus === "あり" && monotaro18678?.memoPresent === true && monotaro18678?.drive === "https://drive.google.com/file/d/1Y5WO-yG7fNzyngrM28mWlfXYHqmvM_6k/view" && monotaro18678?.cardholder === "柴田 善広" && monotaro18678?.cardName === "AIハンド決済用" && monotaro18678?.memoEvidence?.[0]?.postedAt === "2026-11-15 23:18:16 JST" && monotaro18678?.qualifiedInvoiceNumber === "T6140001054380" && monotaro18678?.slackReceiptFile === "20261118_18678JPY_モノタロウ_領収書.pdf" && monotaro18678?.slackReceiptNoticeAt === "2026-11-20 09:12 JST" && !needsAction(monotaro18678), "monotaro 18678 status");
  check(monotaro18678?.datetime === "11/13 00:53" && monotaro18678?.paidAt === "2026-11-13 00:53:56 JST" && monotaro18678?.slack.endsWith("1794498836.125669") && monotaro18678?.ledgerId === "TX-20261113-MNT-001" && monotaro18678?.orderNumber === "134323400032" && monotaro18678?.receptionNumber === "202785267" && monotaro18678?.content === "Seeed XIAO ESP32C6 ×10" && monotaro18678?.orderReference === "YUBI Glove製造", "monotaro 18678 order");
  check(monotaro18678?.items?.[0] === "Seeed XIAO ESP32C6 ×10" && monotaro18678?.deliveryStatus === "納入済（全数、11/18出荷・11/19納品書受領）" && monotaro18678?.priorDeliveryStatus === "未出荷（在庫切れ、出荷予定11/25まで）" && monotaro18678?.deliveryConfirmed === true && monotaro18678?.statusUpdatedAt === "2026-11-20 09:20 JST" && monotaro18678?.statusReason.includes("登録完了") && monotaro18678?.statusReason.includes("本文なし") && monotaro18678?.statusReason.includes("領収日11/18") && monotaro18678?.priorStatusReason.includes("出荷予定は11/25まで") && monotaro18678?.evidenceCheck.includes("1Y5WO-yG7fNzyngrM28mWlfXYHqmvM_6k"), "monotaro 18678 delivery");
  check(JSON.stringify(monotaro18678?.registeredMemo) === JSON.stringify(monotaro18678?.memoDefault) && monotaro18678?.registeredMemo?.purpose === "YUBI製造用資材購入" && monotaro18678?.registeredMemo?.seg1 === "AIハンド" && monotaro18678?.registeredMemo?.seg2 === "プロダクト販売" && monotaro18678?.registeredMemo?.category === "製造用資材" && monotaro18678?.registeredMemo?.content === "Seeed XIAO ESP32C6 ×10", "monotaro 18678 registered memo");
  check(monotaro30017?.statusUpdatedAt === "2026-11-14 09:20 JST" && monotaro4065?.statusUpdatedAt === "2026-11-14 09:20 JST" && amazonZero?.statusUpdatedAt === "2026-11-13 09:21 JST", "registered rows were updated and the confirmation charge was left alone");
  const added = [
    ["tx-20261113-1023-monotaro-1318", "MonotaRO", "DP12*MONOTARO.COM", "¥1,318", 1318, "11/13 10:23", "2026-11-13 10:23:56 JST", "1794533037.399359", "c3e9cccd-d710-47b9-ba7e-2eb3a1e8391b", "TX-20261113-MNT-002", "134323400033", "TRUSCO NS-10N R ×1", "出荷済（納入待ち、2026-11-13、ヤマト426978777971）", "メモなし", "https://drive.google.com/file/d/14HAJ9q8lo9D0P9_q4Jyd_bPb0UkRHe_b/view", "2026-11-24 09:15 JST"],
    ["tx-20261113-2255-wilco-20900", "ウィルコ", "WILCO.JP", "¥20,900", 20900, "11/13 22:55", "2026-11-13 22:55:08 JST", "1794578109.819919", "48ea51bf-e9d3-4cda-aa04-521fb1785978", "TX-20261113-WLC-001", "E00339678", "HUD-42601 ウルトラサート4 M2.6×1000", "納入済（2026-11-17 ScanSnap納品書・請求書受領）", "メモなし", "https://drive.google.com/file/d/1AX1d-wS1rW_yAqKl5EBhtAi43EbZ3d3F/view", "2026-11-18 09:12 JST"],
    ["tx-20261114-0426-misumi-3267", "ミスミ", "DP5*MISUMI", "¥3,267", 3267, "11/14 04:26", "2026-11-14 04:26:36 JST", "1794597997.191909", "8f74525f-ac8f-445a-9ec7-43056c166b2e", "TX-20261114-MSM-001", "AB25764G15", "HFSC5-2020-500 ×1、HFSB6-3060-1000-RTP ×1", "納入済（2026-11-18 ScanSnap納品書受領、伝票157126、出荷11/17）", "メモなし", "https://drive.google.com/file/d/14_TTkidrivNihVuK-XlJ3AYKZ2SdGRDw/view", "2026-11-18 13:40 JST"],
  ];
  const addedMemos = {
    "tx-20261113-1023-monotaro-1318": {
      purpose: "AIハンド製造ライン用資材収納用品購入",
      seg1: "AIハンド",
      seg2: "その他",
      category: "備品",
      content: "部品コンテナ、TRUSCO NS型コンテナ 10L NS-10N R（赤）×1",
    },
    "tx-20261113-2255-wilco-20900": {
      purpose: "YUBI Glove製造用資材購入",
      seg1: "AIハンド",
      seg2: "プロダクト販売",
      category: "製造用資材",
      content: "熱圧入インサートナット、黄銅 ウルトラサートⅣ M2.6 HUD-42601 ×1000",
    },
    "tx-20261114-0426-misumi-3267": {
      purpose: "LEAP開発用フレーム資材購入",
      seg1: "AIハンド",
      seg2: "研究開発",
      category: "製造用資材",
      content: "アルミフレーム、HFSC5-2020-500（20×20）×1、HFSB6-3060-1000-RTP（30×60 黒）×1",
    },
  };
  for (const [id, merchant, slackMerchant, amount, yen, datetime, paidAt, thread, transactionId, ledgerId, orderNumber, content, delivery, status, drive, statusUpdatedAt] of added) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.merchant === merchant && tx?.slackMerchant === slackMerchant && tx?.amount === amount && tx?.amountYen === yen && tx?.datetime === datetime, `added identity ${id}`);
    check(tx?.status === status && tx?.memoStatus === "未確認" && tx?.memoPresent === false && tx?.memoEvidence == null && tx?.drive === drive && tx?.cardholder === "柴田 善広" && tx?.cardName === "AIハンド決済用" && needsAction(tx), `added status ${id}`);
    check(tx?.paidAt === paidAt && tx?.slack.endsWith(thread) && tx?.upSiderTransactionId === transactionId && tx?.ledgerId === ledgerId && tx?.orderNumber === orderNumber && tx?.content === content && tx?.deliveryStatus === delivery && tx?.statusUpdatedAt === statusUpdatedAt, `added order ${id}`);
    check(JSON.stringify(tx?.memoDefault) === JSON.stringify(addedMemos[id]) && !tx?.registeredMemo, `added memo is filled ${id}`);
  }
  check(ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.shipments?.[0]?.trackingNumber === "426978777971", "monotaro 1318 tracking");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.slackReceiptFile === "20261113_1318JPY_モノタロウ_領収書.pdf" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.issuer === "株式会社ＭｏｎｏｔａＲＯ" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.qualifiedInvoiceNumber === "T6140001054380" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.slackReceiptPostedAt === "2026-11-24 09:11 JST" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.slackReceiptNoticeAt === "2026-11-24 09:11 JST" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.priorStatus === "メモ・証憑なし" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.memoPresent === false && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.evidenceCheck.includes("本文なし"), "monotaro 1318 receipt attached");
  const eveningRows = [
    ["tx-20261115-2134-amazon-14549", "Amazon", "AMAZON CO JP", "¥14,549", 14549, "11/15 21:34", "2026-11-15 21:34:14 JST", "1794746054.930309", "dae09261-8253-4cf5-b2d8-10ae108ac1a7", "TX-20261115-AMZ-003", "249-7546580-9987019", "KoiFlow ファイルラック4段 ×1（発注番号 オフィス什器）", "納入待ち（着予定11/26〜12/8）", "メモ・証憑なし"],
  ];
  const eveningMemos = {
    "tx-20261115-2134-amazon-14549": {
      purpose: "AIハンド事業部オフィス什器購入",
      seg1: "AIハンド",
      seg2: "その他",
      category: "備品",
      content: "書類棚、KoiFlow ファイルラック ファイルワゴン 4段 A4対応 キャスター付き ×1",
    },
  };
  for (const [id, merchant, slackMerchant, amount, yen, datetime, paidAt, thread, transactionId, ledgerId, orderNumber, content, delivery, status] of eveningRows) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.merchant === merchant && tx?.slackMerchant === slackMerchant && tx?.amount === amount && tx?.amountYen === yen && tx?.datetime === datetime && tx?.status === status, `evening identity ${id}`);
    check(tx?.memoStatus === "未確認" && tx?.memoPresent === false && tx?.memoEvidence == null && tx?.drive === "なし" && tx?.cardholder === "柴田 善広" && tx?.cardName === "AIハンド決済用" && needsAction(tx), `evening status ${id}`);
    check(tx?.paidAt === paidAt && tx?.slack.endsWith(thread) && tx?.upSiderTransactionId === transactionId && tx?.ledgerId === ledgerId && tx?.orderNumber === orderNumber && tx?.content === content && tx?.deliveryStatus === delivery && tx?.statusUpdatedAt === "2026-11-15 22:45 JST", `evening order ${id}`);
    check(JSON.stringify(tx?.memoDefault) === JSON.stringify(eveningMemos[id]) && !tx?.registeredMemo && !("token" in tx), `evening memo is filled ${id}`);
  }
  const switchScience = ledger.transactions.find((tx) => tx.id === "tx-20261115-2152-switchscience-3560");
  check(switchScience?.merchant === "スイッチサイエンス" && switchScience?.slackMerchant === "SP SWITCHSCIENCE" && switchScience?.amount === "¥3,560" && switchScience?.amountYen === 3560 && switchScience?.datetime === "11/15 21:52" && switchScience?.paidAt === "2026-11-15 21:52:24 JST" && switchScience?.slack.endsWith("1794747144.256949") && switchScience?.upSiderTransactionId === "4c9ec042-d484-47ff-bdf3-ed35f3f65b56" && switchScience?.ledgerId === "TX-20261115-SWS-001" && switchScience?.orderNumber === "Y245720" && switchScience?.content === "AS5601 磁気式エンコーダ Breakout Board ×2" && switchScience?.status === "メモなし" && switchScience?.priorStatus === "メモ・証憑なし" && switchScience?.drive === "https://drive.google.com/file/d/1jPikRC23S8CWCtqeS-LqUca-QrrUXMrK/view" && switchScience?.qualifiedInvoiceNumber === "T6010001130095" && switchScience?.slackReceiptFile === "20261115_3560JPY_スイッチサイエンス_納品書兼適格請求書.pdf" && switchScience?.slackReceiptPostedAt === "2026-11-26 09:16:36 JST" && switchScience?.slackReceiptNotice === "領収証を添付しました" && switchScience?.slackReceiptNoticeAt === "2026-11-26 09:16:45 JST" && switchScience?.slackReceiptNoticeTs === "1795652205.005089" && switchScience?.slackReceiptPoster === "UPSIDER" && switchScience?.deliveryStatus === "納入済（11/24同梱納品書受領）" && switchScience?.memoPresent === false && switchScience?.statusUpdatedAt === "2026-11-26 09:25 JST" && needsAction(switchScience), "switch science receipt attached without a memo");
  check(JSON.stringify(switchScience?.memoDefault) === JSON.stringify({
    purpose: "YUBI試作用センサー部品購入",
    seg1: "AIハンド",
    seg2: "研究開発",
    category: "消耗品",
    content: "磁気式エンコーダ、12bit AS5601 Breakout Board ×2",
  }) && !switchScience?.registeredMemo && !("token" in switchScience), "switch science memo default unchanged");
  const chromeZero = ledger.transactions.find((tx) => tx.id === "tx-20261115-2140-google-0");
  check(chromeZero?.merchant === "Google" && chromeZero?.slackMerchant === "GOOGLE *CHROME TEMP" && chromeZero?.amount === "¥0" && chromeZero?.amountYen === 0 && chromeZero?.status === "確認決済（¥0）" && chromeZero?.ledgerId === undefined && chromeZero?.drive === "なし" && chromeZero?.memoStatus === "未確認" && chromeZero?.memoEvidence == null && needsAction(chromeZero), "chrome zero matches the amazon zero category");
  check(chromeZero?.paidAt === "2026-11-15 21:40:12 JST" && chromeZero?.slack.endsWith("1794746412.606309") && chromeZero?.upSiderTransactionId === "7be90fc7-c734-4d31-8dc5-0f70b0feb481" && chromeZero?.cardholder === "柴田 善広" && chromeZero?.cardName === "AIハンド決済用" && chromeZero?.content.includes("メモを追加するボタンはない"), "chrome zero identity");
  const eventPay = ledger.transactions.find((tx) => tx.id === "tx-20261115-2140-eventpay-9000");
  check(eventPay?.merchant === "EVENT PAY" && eventPay?.amount === "¥9,000" && eventPay?.amountYen === 9000 && eventPay?.status === "登録完了" && eventPay?.priorStatus === "証憑保存済・Slack未添付" && eventPay?.drive === "https://drive.google.com/file/d/1yBHveOx1AUhyLtxk_hLA2whZerfA72S1/view" && !needsAction(eventPay), "event pay status and drive link");
  check(eventPay?.ledgerId === "TX-20261115-EVP-001" && eventPay?.receptionNumber === "S169-50" && eventPay?.qualifiedInvoiceNumber === "T7010005016414" && eventPay?.issuer === "一般社団法人日本ロボット学会" && eventPay?.accountingTaxYen === 818 && eventPay?.addressee === "株式会社AlgomaticDynamics" && eventPay?.priorSlackAttachmentStatus === "未添付" && eventPay?.slackAttachmentStatus === "添付済み（2026-11-16 09:16:06 JST、本文なし）" && eventPay?.slackAttachmentError === undefined && eventPay?.slackReceiptFile === "20261115_9000JPY_日本ロボット学会_領収書.pdf" && eventPay?.slackReceiptPostedAt === "2026-11-16 09:16:06 JST" && eventPay?.slackReceiptNotice === "領収証を添付しました" && eventPay?.slackReceiptNoticeAt === "2026-11-16 09:16:16 JST" && eventPay?.slackReceiptThreadTs === "1794746424.974559" && eventPay?.memoStatus === "あり" && eventPay?.memoPresent === true && eventPay?.memoEvidence?.[0]?.postedAt === "2026-11-15 23:55:35 JST" && eventPay?.upSiderTransactionId === "8d7b2bae-7da2-40b6-acf5-5e24a0de1332" && eventPay?.slack.endsWith("1794746424.974559") && eventPay?.statusUpdatedAt === "2026-11-16 09:16 JST", "event pay receipt was attached without a message body");
  check(ledger.slackReceiptAttachment?.attempted === 3 && ledger.slackReceiptAttachment?.latestObserved?.attachmentsAttempted === 1 && ledger.slackReceiptAttachment?.latestObserved?.file === "20261115_9000JPY_日本ロボット学会_領収書.pdf" && ledger.slackReceiptAttachment?.latestObserved?.body === "" && ledger.slackReceiptAttachment?.latestObserved?.noticeAt === "2026-11-16 09:16:16 JST", "event pay attachment is recorded beside the earlier manual result");
  const monotaroVise = ledger.transactions.find((tx) => tx.id === "tx-20261115-2230-monotaro-17151");
  check(monotaroVise?.amountYen === 17151 && monotaroVise?.ledgerId === "TX-20261115-MNT-001" && monotaroVise?.receptionNumber === "202927990" && monotaroVise?.orderReference === "YUBI製造工具" && monotaroVise?.orderNumber === "134323400036" && monotaroVise?.content === "LOBSTER シャコ万力 B125V ×4" && monotaroVise?.status === "メモなし" && monotaroVise?.priorStatus === "メモ・証憑なし" && monotaroVise?.drive === "https://drive.google.com/file/d/1XIVDIGU0zWNbBGqs963Pk0w6p1kx25KU/view" && monotaroVise?.issuer === "株式会社ＭｏｎｏｔａＲＯ" && monotaroVise?.qualifiedInvoiceNumber === "T6140001054380" && monotaroVise?.slackReceiptFile === "20261116_17151JPY_モノタロウ_領収書.pdf" && monotaroVise?.slackReceiptPostedAt === "2026-11-24 09:11 JST" && monotaroVise?.slackReceiptNoticeAt === "2026-11-24 09:11 JST" && monotaroVise?.memoPresent === false && monotaroVise?.deliveryStatus === "出荷済（11/17 出荷ご案内書を同梱受領、伝票1540293・問合せ055407470789-34845876。納入要確認）" && monotaroVise?.deliveryConfirmed === false && monotaroVise?.statusUpdatedAt === "2026-11-24 09:15 JST", "monotaro 17151");
  const monotaroTimer = ledger.transactions.find((tx) => tx.id === "tx-20261115-2231-monotaro-2198");
  check(monotaroTimer?.amountYen === 2198 && monotaroTimer?.ledgerId === "TX-20261115-MNT-002" && monotaroTimer?.receptionNumber === "202928013" && monotaroTimer?.content === "タニタ でか見えタイマー TD429GY ×2" && monotaroTimer?.slack.endsWith("1794749518.102389") && monotaroTimer?.status === "メモなし" && monotaroTimer?.priorStatus === "証憑保存済・Slack未添付" && monotaroTimer?.orderNumber === undefined, "monotaro 2198");
  check(JSON.stringify(eventPay?.memoDefault) === JSON.stringify({
    purpose: "セミナー参加費",
    seg1: "AIハンド",
    seg2: "研究開発",
    category: "会議費",
    content: "日本ロボット学会 第169回ロボット工学セミナー「人型ロボットハンド開発の現状と課題」（11/24・オンライン）参加費 正会員×1",
  }) && JSON.stringify(eventPay?.registeredMemo) === JSON.stringify(eventPay?.memoDefault), "event pay memo default");
  check(JSON.stringify(monotaroVise?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造ライン用工具購入",
    seg1: "AIハンド",
    seg2: "その他",
    category: "備品",
    content: "クランプ、LOBSTER シャコ万力B型 スタンダードエコ B125V ×4",
  }), "vise memo uses the YUBI reference");
  check(JSON.stringify(monotaroTimer?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造ライン用工具購入",
    seg1: "AIハンド",
    seg2: "その他",
    category: "備品",
    content: "タイマー、タニタ 抗菌でか見えタイマー TD429GY ×2",
  }), "timer memo uses the YUBI reference");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261113-2255-wilco-20900")?.memoDefault?.category === "製造用資材" && ledger.transactions.find((tx) => tx.id === "tx-20261114-0426-misumi-3267")?.memoDefault?.category === "製造用資材" && ledger.transactions.find((tx) => tx.id === "tx-20261113-1023-monotaro-1318")?.memoDefault?.category === "備品", "item categories");
  check(!ledger.transactions.some((tx) => /Bambu|CubeMars|^SLACK$/.test(tx.merchant) || tx.amountYen === 228000 || tx.amountYen === 114000 || tx.amountYen === 369268 || tx.amountYen === 8576 || tx.amountYen === 35729 || tx.amountYen === 8218), "out of scope charges are not rows");
  check(ledger.transactions.filter((tx) => tx.merchant === "JLCPCB").map((tx) => tx.amountYen).join() === "25017", "the in-scope JLCPCB row is the new ¥25,017 charge");
  const amazon2473 = ledger.transactions.find((tx) => tx.id === "tx-20261101-0440-amazon-2473");
  check(amazon2473?.status === "登録完了" && amazon2473?.orderNumber === "249-7203088-9467041" && amazon2473?.drive === "あり", "amazon 2473 registration kept");
  check(!("accountingPdfVerifiedAt" in amazon2473) && !("voucherValidityReverified" in amazon2473), "amazon 2473 was not marked revalidated");

  const order = ledger.transactions.find((tx) => tx.id === NEW_ORDER_ID);
  check(order?.merchant === "DANBALLACE" && order?.datetime === "11/06 15:53", "new order identity");
  check(order?.amountYen === 7160 && order?.status === "登録完了" && order?.drive.startsWith("https://drive.google.com/"), "new order status");
  check(order?.memoStatus === "あり" && order?.memoPresent === true, "new order memo");
  check(order?.memoEvidence?.length === 2, "additional memo observation");
  const slackUiMemo = order?.memoEvidence?.find((item) => item.slackUiTime === "2026-11-08 00:59 JST");
  check(slackUiMemo?.notice === "決済メモを追加しました！" && slackUiMemo?.noticeBy === "UPSIDER アプリ" && slackUiMemo?.observedAt === "2026-11-08 09:07 JST" && order?.memoEvidence?.length === 2, "slack ui memo observation kept");
  check(order?.slack.endsWith("1793948039.836289"), "new order slack");
  check(order?.detailSection === false, "new order is not an open detail");
  check(!ledger.details.some((detail) => detail.transactionId === NEW_ORDER_ID), "new order detail removed");
  check(!ledger.details.some((detail) => detail.transactionId === REFUND_ID), "refund excluded from unhandled details");

  const memoByKey = {
    "7160": "YUBI梱包用ダンボール80サイズ 50枚",
  };
  for (const tx of ledger.transactions.filter((row) => row.memoKey)) {
    check(tx.content === memoByKey[tx.memoKey], `content for ${tx.memoKey}`);
    const memo = initialMemo(tx.content);
    const text = formatMemoText(memo);
    check(text === [
      `用途：${tx.content}`,
      "セグメント1：AIハンド",
      "セグメント2：",
      "分類：消耗品",
      `内容：${tx.content}`,
    ].join("\n"), `memo text ${tx.memoKey}`);
    check(memoSeedText(tx) === tx.content && JSON.stringify(memoDefaults(tx)) === JSON.stringify({
      purpose: "YUBI梱包用ダンボール購入",
      seg1: "AIハンド",
      seg2: "プロダクト販売",
      category: "消耗品",
      content: "梱包用ダンボール80サイズ 50枚",
    }), `stored memo default ${tx.id}`);
    const request = buildExecutionRequest({
      transactionId: tx.id,
      slackThread: tx.slack,
      memo,
      savedAt: "2026-11-06T00:00:00.000Z",
    });
    check(isExecutionRequest(tx.id, request), `request valid ${tx.id}`);
    check(!isExecutionRequest(tx.id, { ...request, token: "x" }), "token rejected");
  }
  for (const tx of ledger.transactions) {
    check(memoSeedText(tx) === tx.content, `seed uses the row content ${tx.id}`);
    const defaults = memoDefaults(tx);
    if (tx.memoDefault) {
      const filledPreset = MEMO_FIELDS.every((field) => tx.memoDefault[field].trim());
      if (filledPreset) {
        check(defaults.purpose === tx.memoDefault.purpose && defaults.seg1 === tx.memoDefault.seg1 && defaults.seg2 === tx.memoDefault.seg2 && defaults.category === tx.memoDefault.category && defaults.content === tx.memoDefault.content, `preset defaults ${tx.id}`);
      }
    } else {
      check(defaults.purpose === tx.content && defaults.seg1 === "AIハンド" && defaults.seg2 === "" && defaults.category === "消耗品" && defaults.content === tx.content, `defaults ${tx.id}`);
    }
    check(MEMO_FIELDS.some((field) => defaults[field].trim()), `memo is not all empty ${tx.id}`);
    check(defaults.seg1 === "AIハンド", `seg1 stays AIハンド ${tx.id}`);
    if (tx.memoDefault) check(tx.memoDefault.seg1 === "AIハンド", `stored seg1 ${tx.id}`);
    if (tx.cardName === "AIハンド決済用" || (tx.status !== "返金（メモ・証憑不要）" && !isNotOwnerStatus(tx.status))) {
      check(defaults.seg1 === "AIハンド", `required seg1 ${tx.id}`);
    }
  }
  const monotaroTape = ledger.transactions.find((tx) => tx.id === "tx-20261116-0006-monotaro-1868");
  check(monotaroTape?.merchant === "MonotaRO" && monotaroTape?.slackMerchant === "DP12*MONOTARO.COM" && monotaroTape?.datetime === "11/16 00:06" && monotaroTape?.paidAt === "2026-11-16 00:06:32 JST" && monotaroTape?.amount === "¥1,868" && monotaroTape?.amountYen === 1868 && monotaroTape?.status === "メモなし" && monotaroTape?.priorStatus === "証憑保存済・Slack未添付" && monotaroTape?.drive === "https://drive.google.com/file/d/1YwmP9tiOqL4qsTXRfi9VGfN_57QSe1an/view" && monotaroTape?.memoStatus === "未確認" && monotaroTape?.memoPresent === false && monotaroTape?.memoEvidence == null && monotaroTape?.cardholder === "柴田 善広" && monotaroTape?.cardName === "AIハンド決済用" && needsAction(monotaroTape), "monotaro 1868 identity");
  check(monotaroTape?.slack.endsWith("1794755192.815079") && monotaroTape?.upSiderTransactionId === "b950c0a4-7232-4caa-a1e9-f4482d7ef7bf" && monotaroTape?.ledgerId === "TX-20261116-MNT-001" && monotaroTape?.orderNumber === "134323400038" && monotaroTape?.receptionNumber === "202929478" && monotaroTape?.orderReference === "YUBI製造副資材" && monotaroTape?.content === "3M 両面粘着テープ 93020LE ×1" && monotaroTape?.deliveryStatus === "納入済（2026-11-17 ScanSnap納品書134323400038-01受領）" && JSON.stringify(monotaroTape?.items) === JSON.stringify(["3M 両面粘着テープ 強粘着多用途タイプ 93020LE ×1"]), "monotaro 1868 order");
  check(JSON.stringify(monotaroTape?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造用副資材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "副資材",
    content: "両面テープ、3M 両面粘着テープ 強粘着多用途タイプ 93020LE ×1",
  }) && monotaroTape?.memoBasis.includes("YUBI製造副資材") && monotaroTape?.memoBasis.includes("セメダイン"), "monotaro 1868 memo");
  const amazonIron = ledger.transactions.find((tx) => tx.id === "tx-20261116-0232-amazon-5003");
  check(amazonIron?.merchant === "Amazon" && amazonIron?.slackMerchant === "AMAZON CO JP" && amazonIron?.datetime === "11/16 02:32" && amazonIron?.paidAt === "2026-11-16 02:32:52 JST" && amazonIron?.amount === "¥5,003" && amazonIron?.amountYen === 5003 && amazonIron?.status === "メモなし" && amazonIron?.priorStatus === "証憑保存済・Slack未添付" && amazonIron?.drive === "https://drive.google.com/file/d/1E0y772dz8Ci6u8ZMOsKHT_xO0OgIvm8C/view" && amazonIron?.memoStatus === "未確認" && amazonIron?.memoPresent === false && amazonIron?.memoEvidence == null && amazonIron?.cardholder === "柴田 善広" && amazonIron?.cardName === "AIハンド決済用" && needsAction(amazonIron), "amazon 5003 identity");
  check(amazonIron?.slack.endsWith("1794763972.992929") && amazonIron?.upSiderTransactionId === "f61fc546-e699-4dd7-ae33-2bac042aea20" && amazonIron?.ledgerId === "TX-20261114-AMZ-001" && amazonIron?.orderNumber === "249-3093885-1950211" && amazonIron?.orderReference === "製造用工具" && amazonIron?.content === "HAKKO はんだこて FX600-02 ほか1点" && amazonIron?.deliveryStatus === "配達済（2026-11-17 12:11 JST）" && amazonIron?.deliveryConfirmed === true && amazonIron?.items?.length === 2 && amazonIron.items[0].includes("FX600-02") && amazonIron.items[1].includes("PX-28T-NM2.6"), "amazon 5003 order");
  const amazonPla = ledger.transactions.find((tx) => tx.id === "tx-20261116-0023-amazon-49704");
  check(amazonPla?.merchant === "Amazon" && amazonPla?.slackMerchant === "AMAZON CO JP" && amazonPla?.datetime === "11/16 14:23" && amazonPla?.paidAt === "2026-11-16 14:23:41 JST" && amazonPla?.amount === "¥49,704" && amazonPla?.amountYen === 49704 && amazonPla?.status === "メモなし" && amazonPla?.priorStatus === "証憑保存済・Slack未添付" && amazonPla?.drive === "https://drive.google.com/file/d/1l0fs_9Wa8E37XqSmz2qeXVkNe74XMoTu/view" && amazonPla?.memoStatus === "未確認" && amazonPla?.memoPresent === false && amazonPla?.memoEvidence == null && amazonPla?.cardholder === "柴田 善広" && amazonPla?.cardName === "AIハンド決済用" && needsAction(amazonPla) && amazonPla?.statusUpdatedAt === "2026-11-18 09:12 JST", "amazon 49704 identity");
  check(amazonPla?.slack.endsWith("1794806622.820069") && amazonPla?.slackThreadTs === "1794806622.820069" && amazonPla?.upSiderTransactionId === undefined && amazonPla?.ledgerId === "TX-20261115-AMZ-001" && amazonPla?.orderNumber === "249-8562873-0763848" && amazonPla?.orderReference === "YUBI製造3DP材" && amazonPla?.content === "Polymaker HT-PLA 1.75mm 1kg Black ×12（発注番号 YUBI製造3DP材）" && amazonPla?.deliveryStatus === "配達済（2026-11-17 12:11 JST）" && amazonPla?.deliveryConfirmed === true && amazonPla?.cardDisplayedAt === "2026-11-16 05:23 UTC" && JSON.stringify(amazonPla?.items) === JSON.stringify(["Polymaker HT-PLA 1.75mm 1kg Black ×12"]) && amazonPla?.statusReason.includes("20261115_49704JPY_Amazon_適格請求書.pdf") && amazonPla?.priorStatusReason.includes("JP6CHTXP1AJGKI"), "amazon 49704 order");
  check(JSON.stringify(amazonPla?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造用3Dプリンター材料購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "Polymaker HT-PLA 1.75mm 1kg Black ×12（発注番号 YUBI製造3DP材）",
  }) && amazonPla?.memoBasis.includes("YUBI製造3DP材") && amazonPla?.memoBasis.includes("MonotaRO ¥18,678") && amazonPla?.memoBasis.includes("プロダクト販売") && !amazonPla?.registeredMemo, "amazon 49704 memo");
  check(ledger.transactions.findIndex((tx) => tx.id === "tx-20261116-0006-monotaro-1868") < ledger.transactions.findIndex((tx) => tx.id === amazonPla.id) && ledger.transactions.findIndex((tx) => tx.id === amazonPla.id) < ledger.transactions.findIndex((tx) => tx.id === "tx-20261116-0232-amazon-5003"), "amazon 49704 sits between the same-day rows");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-19 09:20 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。新規の証憑添付はなし。メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 52 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 25 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === "[]" && JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds, "tx-20261118-2127-misumi-10890", "tx-20261118-2211-nejikuru-5782", "tx-20261118-2234-misumi-5984"].sort()) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("ANTHROPIC* CLAUDE SUB ¥35,892") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("2026-11-18 17:31 JST") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("HANABI AI INC. ¥16,314") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 9 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("一部納入") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("行は追加しない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない"), "morning check added three cards and attached nothing");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-19 09:20 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.source === "ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 23 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("決済メモを追加しました！") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("返信0件") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("ANTHROPIC* CLAUDE SUB ¥35,892") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("HANABI AI INC. ¥16,314") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("行を追加しない"), "morning memo check");
  check(ledger.slackReceiptAttachment?.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-19 09:20 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.attempted === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.attached === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.method === "新規の証憑添付はなし" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.items) === "[]", "morning check attached nothing");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-18 13:40 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "臨時巡回（2026-11-18 13:36〜13:40 JST）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。証憑PDF3件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 49 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 3 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261114-0426-misumi-3267", "tx-20261116-2027-monotaro-8965", "tx-20261116-2030-monotaro-2109"]) && JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("RUNPOD.IO ¥8,157") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("DP4*RAKSUL ¥7,805") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("VERCEL INC. ¥3,595") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモなし") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("3/3点出荷済") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("行は追加しない") && !ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("シバタさんの手動作業として残す"), "afternoon patrol attached three receipts and added no rows");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-18 13:40 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.source === "臨時巡回。ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 20 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("領収証通知のみ（11/18 13:36）") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("返信0件のまま") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("RUNPOD.IO ¥8,157") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("行を追加しない"), "afternoon memo check");
  check(ledger.slackReceiptAttachment?.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-18 13:40 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attempted === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attached === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.method === "ブラウザでスレッドへ本文なし添付" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.map((item) => item.transactionId)) === JSON.stringify(["tx-20261114-0426-misumi-3267", "tx-20261116-2027-monotaro-8965", "tx-20261116-2030-monotaro-2109"]) && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.every((item) => item.notice === "領収証を添付しました" && item.noticeAt === "2026-11-18 13:36 JST" && item.body === ""), "afternoon attachments recorded beside the earlier runs");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-18 09:12 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。証憑PDF5件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 49 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 5 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 5 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261113-2255-wilco-20900", "tx-20261115-2231-monotaro-2198", "tx-20261116-0006-monotaro-1868", "tx-20261116-0023-amazon-49704", "tx-20261116-0232-amazon-5003", "tx-20261117-1823-monotaro-10993", "tx-20261117-1831-misumi-7878"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("VERCEL INC. ¥3,595") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("USD 22.00") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("SHEIN.COM ¥21,461") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("GITHUB, INC. ¥598") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[3]?.includes("RUNPOD.IO ¥8,171") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモなし") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("MonotaRO ¥10,993") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("ミスミ ¥7,878") && !ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("シバタさんの手動作業として残す"), "morning check attached five receipts and added two cards");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-17 18:09 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "臨時巡回（シバタさん指示 2026-11-17 18:02 JST）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを読み取りのみ確認（18スレッド＋新規カード）。投稿・添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 47 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 20 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.refundExcluded === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.notOwnerExcluded === 4 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === JSON.stringify(["tx-20261116-0232-amazon-5003", "tx-20261116-0023-amazon-49704", "tx-20261113-2255-wilco-20900", "tx-20261115-2231-monotaro-2198", "tx-20261116-0006-monotaro-1868"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261116-0232-amazon-5003", "tx-20261116-0023-amazon-49704", "tx-20261113-2255-wilco-20900", "tx-20261115-2231-monotaro-2198", "tx-20261116-0006-monotaro-1868"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("SHEIN.COM ¥21,461") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("GITHUB, INC. ¥598") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("USD 3.66") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("RUNPOD.IO ¥8,171") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[2]?.includes("USD 50.00") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("証憑保存済・Slack未添付") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("出荷状況（MonotaRO ¥17,151・¥8,965・¥2,109、ミスミ ¥3,267）") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("新規カードはなし"), "ad-hoc patrol saved five receipts and updated four shipments");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-17 09:18 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。証憑PDF3件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 47 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 20 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 3 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261114-0123-monotaro-439", "tx-20261114-0209-monotaro-3953", "tx-20261115-2123-amazon-3080", "tx-20261116-0023-amazon-49704"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("Cubemars ¥8,425") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[1]?.includes("RUNPOD.IO ¥8,186") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモなし") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("14:23に訂正"), "morning check kept");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-16 16:30 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（随時・ユーザー依頼）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 1 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 44 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 21 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 17 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === JSON.stringify(["tx-20261114-0123-monotaro-439", "tx-20261114-0209-monotaro-3953", "tx-20261115-2123-amazon-3080"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261114-0123-monotaro-439", "tx-20261114-0209-monotaro-3953", "tx-20261115-2123-amazon-3080", "tx-20261116-0023-amazon-49704"]) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope?.[0]?.includes("Cubemars ¥8,425") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない"), "ad-hoc check kept as the previous record");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds, "tx-20261116-2027-monotaro-8965", "tx-20261116-2030-monotaro-2109", "tx-20261117-0001-jlcpcb-25017"].sort()), "09:18 action ids kept");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()), "patrol action ids match the morning check");
  check(JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds].sort()) === JSON.stringify([...ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds, "tx-20261117-1823-monotaro-10993", "tx-20261117-1831-misumi-7878"].sort()), "morning action ids add the two new cards");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-18 09:12 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.source === "ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 20 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("領収証通知のみ（11/18 09:11〜09:12）") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新規2件") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("他の要処理スレッドは返信0件"), "morning memo check");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-17 18:09 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.source === "臨時巡回。ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 18 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("MonotaRO ¥439・¥3,953、Amazon ¥3,080は領収証通知のみ") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("他の要処理スレッドは返信0件"), "ad-hoc memo check");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-17 09:18 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 18 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("領収証通知のみ") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新規3件も返信0件"), "morning memo check kept");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-16 16:30 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.unconfirmed === 19 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.note.includes("メモ作成は行っていない"), "ad-hoc memo check kept");
  check(ledger.slackReceiptAttachment?.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.checkedAt === "2026-11-18 09:12 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attempted === 5 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attached === 5 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 5 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.method === "ブラウザでスレッドへ本文なし添付" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.map((item) => item.transactionId)) === JSON.stringify(["tx-20261113-2255-wilco-20900", "tx-20261115-2231-monotaro-2198", "tx-20261116-0006-monotaro-1868", "tx-20261116-0023-amazon-49704", "tx-20261116-0232-amazon-5003"]) && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.every((item) => item.notice === "領収証を添付しました" && item.body === ""), "morning attachments recorded beside the earlier runs");
  check(ledger.slackReceiptAttachment?.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous?.previous?.checkedAt === "2026-11-17 09:18 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attempted === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.attached === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.method === "ブラウザでスレッドへ本文なし添付" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.map((item) => item.transactionId)) === JSON.stringify(["tx-20261114-0123-monotaro-439", "tx-20261114-0209-monotaro-3953", "tx-20261115-2123-amazon-3080"]) && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.previous.items.every((item) => item.notice === "領収証を添付しました" && item.body === ""), "previous morning attachments kept");
  check(JSON.stringify(amazonIron?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造ライン用工具購入",
    seg1: "AIハンド",
    seg2: "その他",
    category: "備品",
    content: "はんだこて、白光(HAKKO) FX600-02 ×1、goot 替こて先 インサートナット挿入用 PX-28T-NM2.6 ×1",
  }) && amazonIron?.memoBasis.includes("製造用工具") && amazonIron?.memoBasis.includes("シャコ万力"), "amazon 5003 memo");
  const monotaroTools = ledger.transactions.find((tx) => tx.id === "tx-20261116-2027-monotaro-8965");
  check(monotaroTools?.merchant === "MonotaRO" && monotaroTools?.slackMerchant === "DP12*MONOTARO.COM" && monotaroTools?.datetime === "11/16 20:27" && monotaroTools?.paidAt === "2026-11-16 20:27:29 JST" && monotaroTools?.amount === "¥8,965" && monotaroTools?.amountYen === 8965 && monotaroTools?.status === "メモなし" && monotaroTools?.priorStatus === "メモ・証憑なし" && monotaroTools?.drive === "https://drive.google.com/file/d/1FY1uyx71ydI4TL_i742Y21xmUFuG5xwj/view" && monotaroTools?.memoStatus === "未確認" && monotaroTools?.memoPresent === false && monotaroTools?.cardholder === "柴田 善広" && monotaroTools?.cardName === "AIハンド決済用" && needsAction(monotaroTools), "monotaro 8965 identity");
  check(monotaroTools?.slack.endsWith("1794828450.137609") && monotaroTools?.slackThreadTs === "1794828450.137609" && monotaroTools?.ledgerId === "TX-20261116-MNT-002" && monotaroTools?.orderNumber === "134323400039" && monotaroTools?.receptionNumber === "203018515" && monotaroTools?.orderReference === "デモ用ロボット常備工具" && monotaroTools?.deliveryStatus === "納入済（2026-11-18 ScanSnap納品書134323400039-01受領、出荷11/17）" && monotaroTools?.priorDeliveryStatus === "出荷済（11/17、ヤマト664365065081）・納入待ち" && monotaroTools?.deliveryConfirmed === true && monotaroTools?.statusUpdatedAt === "2026-11-18 13:40 JST" && monotaroTools?.receiptNumber === "B8577710" && monotaroTools?.accountingTaxYen === 815 && monotaroTools?.qualifiedInvoiceNumber === "T6140001054380" && monotaroTools?.slackAttachmentStatus === "添付済（2026-11-18 13:36 JST、UPSIDER「領収証を添付しました」確認）" && monotaroTools?.evidenceCheck.includes("発行2026-11-18") && monotaroTools?.evidenceCheck.includes("本文なし") && monotaroTools?.statusReason.includes("20261116_8965JPY_モノタロウ_領収証.pdf") && monotaroTools?.memoDefault?.seg1 === "AIハンド", "monotaro 8965 order");
  check(JSON.stringify(monotaroTools?.memoDefault) === JSON.stringify({
    purpose: "デモ用ロボット常備工具購入",
    seg1: "AIハンド",
    seg2: "その他",
    category: "備品",
    content: "マルチツール・ドライバー、TONE マルチツール CMT11 ×4、ベッセル ボールグリップ ビット差替グリップ 220W ×2",
  }) && monotaroTools?.memoBasis.includes("デモ用ロボット常備工具") && !monotaroTools?.registeredMemo, "monotaro 8965 memo");
  const monotaroSquare = ledger.transactions.find((tx) => tx.id === "tx-20261116-2030-monotaro-2109");
  check(monotaroSquare?.datetime === "11/16 20:30" && monotaroSquare?.paidAt === "2026-11-16 20:30:51 JST" && monotaroSquare?.amountYen === 2109 && monotaroSquare?.status === "メモなし" && monotaroSquare?.priorStatus === "メモ・証憑なし" && monotaroSquare?.drive === "https://drive.google.com/file/d/1C9fkIqkyZusE-U80UvHXNBP-Qwrap2z8/view" && monotaroSquare?.deliveryStatus === "納入済（2026-11-18 ScanSnap納品書134323400040-01受領）" && monotaroSquare?.priorDeliveryStatus === "出荷済（11/17、ヤマト664365065081）・納入待ち" && monotaroSquare?.deliveryConfirmed === true && monotaroSquare?.statusUpdatedAt === "2026-11-18 13:40 JST" && monotaroSquare?.slack.endsWith("1794828652.010539") && monotaroSquare?.ledgerId === "TX-20261116-MNT-003" && monotaroSquare?.orderNumber === "134323400040" && monotaroSquare?.receptionNumber === "203018603" && monotaroSquare?.content === "シンワ測定 小型曲尺 平ステン 30×15cm 12325 ×3" && monotaroSquare?.receiptNumber === "B8577714" && monotaroSquare?.accountingTaxYen === 192 && monotaroSquare?.evidenceCheck.includes("宛名 株式会社Algomatic Dynamics") && monotaroSquare?.statusReason.includes("決済メモの完了通知はまだない") && needsAction(monotaroSquare), "monotaro 2109 identity");
  check(monotaroSquare?.memoDefault?.purpose === "デモ用ロボット常備工具購入" && monotaroSquare?.memoDefault?.seg1 === "AIハンド" && monotaroSquare?.memoDefault?.seg2 === "その他" && monotaroSquare?.memoDefault?.category === "備品" && monotaroSquare?.memoDefault?.content.includes("12325 ×3"), "monotaro 2109 memo");
  const jlcpcb = ledger.transactions.find((tx) => tx.id === "tx-20261117-0001-jlcpcb-25017");
  check(jlcpcb?.merchant === "JLCPCB" && jlcpcb?.slackMerchant === "JLCPCB.COM" && jlcpcb?.datetime === "11/17 00:01" && jlcpcb?.paidAt === "2026-11-17 00:01:51 JST" && jlcpcb?.amount === "¥25,017" && jlcpcb?.amountYen === 25017 && jlcpcb?.status === "メモ・証憑なし" && jlcpcb?.drive === "なし" && jlcpcb?.memoStatus === "未確認" && jlcpcb?.memoPresent === false && jlcpcb?.cardholder === "柴田 善広" && jlcpcb?.cardName === "AIハンド決済用" && jlcpcb?.ledgerId === null && jlcpcb?.orderNumber === "W2026111623018994（推定・金額未照合）" && jlcpcb?.slack.endsWith("1794841312.104879") && jlcpcb?.deliveryStatus === "製造準備中（審査完了）" && needsAction(jlcpcb), "jlcpcb 25017 identity");
  check(jlcpcb?.memoDefault?.purpose === "YUBI製造用資材購入" && jlcpcb?.memoDefault?.seg1 === "AIハンド" && jlcpcb?.memoDefault?.seg2 === "プロダクト販売" && jlcpcb?.memoDefault?.category === "製造用資材" && jlcpcb?.memoDefault?.content.includes("AD-YUBI_Hub_01") && jlcpcb?.memoBasis.includes("金額") && jlcpcb?.statusReason.includes("金額照合未確認") && !jlcpcb?.registeredMemo, "jlcpcb 25017 memo stays estimated");
  const monotaroTapeNew = ledger.transactions.find((tx) => tx.id === "tx-20261117-1823-monotaro-10993");
  check(monotaroTapeNew?.merchant === "MonotaRO" && monotaroTapeNew?.slackMerchant === "DP12*MONOTARO.COM" && monotaroTapeNew?.datetime === "11/17 18:23" && monotaroTapeNew?.paidAt === "2026-11-17 18:23:18 JST" && monotaroTapeNew?.amount === "¥10,993" && monotaroTapeNew?.amountYen === 10993 && monotaroTapeNew?.status === "メモなし" && monotaroTapeNew?.drive === "https://drive.google.com/file/d/1MUWn04F3yOWXxvOMVlaSk81fRkFqqvUZ/view" && monotaroTapeNew?.memoStatus === "未確認" && monotaroTapeNew?.memoPresent === false && monotaroTapeNew?.memoEvidence == null && monotaroTapeNew?.cardholder === "柴田 善広" && monotaroTapeNew?.cardName === "AIハンド決済用" && monotaroTapeNew?.slack.endsWith("1794907398.336749") && monotaroTapeNew?.slackThreadTs === "1794907398.336749" && monotaroTapeNew?.ledgerId === "TX-20261117-MNT-001" && monotaroTapeNew?.orderNumber === "134323400041" && monotaroTapeNew?.receptionNumber === "203116497" && monotaroTapeNew?.orderReference === "YUBI製造副資材" && monotaroTapeNew?.content === monotaroTapeNew?.items?.join("、") && monotaroTapeNew?.items?.length === 3 && monotaroTapeNew?.deliveryStatus === "納入済（全3点、納品書134323400041-01・-02）" && monotaroTapeNew?.priorDeliveryStatus.includes("一部納入") && monotaroTapeNew?.priorDeliveryStatus.includes("NO.775×1") && monotaroTapeNew?.status === "メモなし" && monotaroTapeNew?.priorStatus === "メモ・証憑なし" && monotaroTapeNew?.deliveryConfirmed === true && monotaroTapeNew?.statusUpdatedAt === "2026-11-20 09:20 JST" && monotaroTapeNew?.statusReason.includes("登録完了にはしていない") && monotaroTapeNew?.statusReason.includes("本文なし") && monotaroTapeNew?.statusReason.includes("消費税¥999") && monotaroTapeNew?.qualifiedInvoiceNumber === "T6140001054380" && monotaroTapeNew?.slackReceiptNoticeAt === "2026-11-20 09:12 JST" && monotaroTapeNew?.memoPresent === false && needsAction(monotaroTapeNew), "monotaro 10993 identity");
  check(JSON.stringify(monotaroTapeNew?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造用副資材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "副資材",
    content: "両面テープ、寺岡 NO.767 #50 30mm×30m ×1、寺岡 NO.775 30mm×20m ×1、日東電工 VR-5311-30 ×1",
  }) && monotaroTapeNew?.memoBasis.includes("YUBI製造副資材") && monotaroTapeNew?.memoBasis.includes("¥1,868") && !monotaroTapeNew?.registeredMemo, "monotaro 10993 memo");
  const misumiFrame = ledger.transactions.find((tx) => tx.id === "tx-20261117-1831-misumi-7878");
  check(misumiFrame?.merchant === "ミスミ" && misumiFrame?.slackMerchant === "DP5*MISUMI" && misumiFrame?.datetime === "11/17 18:31" && misumiFrame?.paidAt === "2026-11-17 18:31:10 JST" && misumiFrame?.amount === "¥7,878" && misumiFrame?.amountYen === 7878 && misumiFrame?.status === "メモなし" && misumiFrame?.priorStatus === "メモ・証憑なし" && misumiFrame?.drive === "https://drive.google.com/file/d/1rLnzRF_kUaYGb144MEqicOLd4qSV_ALJ/view" && misumiFrame?.issuer === "株式会社ミスミ" && misumiFrame?.qualifiedInvoiceNumber === "T9010601030898" && misumiFrame?.slackReceiptFile === "20261119_7878JPY_ミスミ_領収書.pdf" && misumiFrame?.slackReceiptNoticeAt === "2026-11-24 09:12 JST" && misumiFrame?.memoStatus === "未確認" && misumiFrame?.memoPresent === false && misumiFrame?.memoEvidence == null && misumiFrame?.cardholder === "柴田 善広" && misumiFrame?.cardName === "AIハンド決済用" && misumiFrame?.slack.endsWith("1794907870.190879") && misumiFrame?.slackThreadTs === "1794907870.190879" && misumiFrame?.ledgerId === "TX-20261117-MSM-001" && misumiFrame?.orderNumber === "AB257842A7" && misumiFrame?.content === misumiFrame?.items?.join("、") && misumiFrame?.deliveryStatus === "一部出荷（明細1 PACK-SHNTP5-4×1 が11/18 SBS即配サポート0417678150805で出荷、明細2 HFSB5-2040-1000-RTP×1 出荷待ち）" && misumiFrame?.deliveryConfirmed === false && misumiFrame?.statusReason.includes("20261119_7878JPY_ミスミ_領収書.pdf") && misumiFrame?.statusReason.includes("本文なし") && misumiFrame?.evidenceCheck.includes("T9010601030898") && misumiFrame?.statusReason.includes("消費税¥716") && misumiFrame?.statusReason.includes("LEAP_DEV") && needsAction(misumiFrame), "misumi 7878 identity");

  const misumiGlove = ledger.transactions.find((tx) => tx.id === "tx-20261118-2127-misumi-10890");
  check(misumiGlove?.merchant === "ミスミ" && misumiGlove?.slackMerchant === "DP5*MISUMI" && misumiGlove?.datetime === "11/18 21:27" && misumiGlove?.paidAt === "2026-11-18 21:27:33 JST" && misumiGlove?.amount === "¥10,890" && misumiGlove?.amountYen === 10890 && misumiGlove?.status === "メモなし" && misumiGlove?.priorStatus === "メモ・証憑なし" && misumiGlove?.drive === "https://drive.google.com/file/d/1v6iwd4daq__eE91WVpkphFosckTQVXnH/view" && misumiGlove?.issuer === "株式会社ミスミ" && misumiGlove?.qualifiedInvoiceNumber === "T9010601030898" && misumiGlove?.slackReceiptFile === "20261120_10890JPY_ミスミ_領収書.pdf" && misumiGlove?.slackReceiptNoticeAt === "2026-11-24 09:14 JST" && misumiGlove?.memoStatus === "未確認" && misumiGlove?.memoPresent === false && misumiGlove?.memoEvidence == null && misumiGlove?.cardholder === "柴田 善広" && misumiGlove?.cardName === "AIハンド決済用" && misumiGlove?.slack.endsWith("1795004853.355139") && misumiGlove?.slackThreadTs === "1795004853.355139" && misumiGlove?.upSiderTransactionId === "3b095d66-3f9f-4533-a0f7-b8cc2d78b8b4" && misumiGlove?.ledgerId === "TX-20261118-MSM-001" && misumiGlove?.orderNumber === "AB25793G31" && misumiGlove?.orderReference === "YUBI-GLOVE" && misumiGlove?.content === misumiGlove?.items?.join("、") && misumiGlove?.content.includes("C-AJKTNA5-70 ×44") && misumiGlove?.deliveryStatus === "受注確定・未出荷（出荷11/20・お届け11/24予定）" && misumiGlove?.deliveryConfirmed === false && misumiGlove?.statusReason.includes("20261120_10890JPY_ミスミ_領収書.pdf") && misumiGlove?.statusReason.includes("空の返信は削除していない") && misumiGlove?.evidenceCheck.includes("空の返信は削除していない") && misumiGlove?.statusReason.includes("消費税¥990") && misumiGlove?.statusReason.includes("柴田善広ＹＵＢＩ資材") && needsAction(misumiGlove), "misumi 10890 identity");
  check(JSON.stringify(misumiGlove?.memoDefault) === JSON.stringify({
    purpose: "YUBIグローブ製造用部材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "アジャスタボルト、エコノミーシリーズ C-AJKTNA5-70 ×44",
  }) && misumiGlove?.memoBasis.includes("YUBI-GLOVE") && misumiGlove?.memoBasis.includes("¥16,614") && misumiGlove?.memoBasis.includes("¥20,900") && !misumiGlove?.memoDefault?.purpose.includes("要確認") && !misumiGlove?.registeredMemo, "misumi 10890 memo");
  const nejikuru = ledger.transactions.find((tx) => tx.id === "tx-20261118-2211-nejikuru-5782");
  check(nejikuru?.merchant === "ネジクル" && nejikuru?.slackMerchant === "DP04*NEJIKURU" && nejikuru?.datetime === "11/18 22:11" && nejikuru?.paidAt === "2026-11-18 22:11:55 JST" && nejikuru?.amount === "¥5,782" && nejikuru?.amountYen === 5782 && nejikuru?.status === "メモ・証憑なし" && nejikuru?.drive === "なし" && nejikuru?.memoStatus === "未確認" && nejikuru?.memoPresent === false && nejikuru?.memoEvidence == null && nejikuru?.cardholder === "柴田 善広" && nejikuru?.cardName === "AIハンド決済用" && nejikuru?.slack.endsWith("1795007515.663979") && nejikuru?.upSiderTransactionId === "410abe0e-c611-469b-a370-6d0218586a7b" && nejikuru?.ledgerId === "TX-20261118-TRG-001" && nejikuru?.orderNumber === "EC261118-003952982" && nejikuru?.content.includes("C0002F110030012003") && nejikuru?.content.includes("×100") && nejikuru?.deliveryStatus === "受付・未出荷" && nejikuru?.statusReason.includes("T9122001004975") && nejikuru?.statusReason.includes("消費税¥526") && nejikuru?.statusReason.includes("返信は0件") && needsAction(nejikuru), "nejikuru 5782 identity");
  check(JSON.stringify(nejikuru?.memoDefault) === JSON.stringify({
    purpose: "YUBI Glove製造用資材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "花ボルト、黒 3×12（C0002F110030012003）×100",
  }) && nejikuru?.memoBasis.includes("ウィルコ") && nejikuru?.memoBasis.includes("¥20,900") && !nejikuru?.registeredMemo, "nejikuru 5782 memo");
  const misumiCover = ledger.transactions.find((tx) => tx.id === "tx-20261118-2234-misumi-5984");
  check(misumiCover?.merchant === "ミスミ" && misumiCover?.slackMerchant === "DP5*MISUMI" && misumiCover?.datetime === "11/18 22:34" && misumiCover?.paidAt === "2026-11-18 22:34:51 JST" && misumiCover?.amount === "¥5,984" && misumiCover?.amountYen === 5984 && misumiCover?.status === "メモなし" && misumiCover?.priorStatus === "メモ・証憑なし" && misumiCover?.drive === "https://drive.google.com/file/d/1Eq5RJc9S79ufmXM-dmNLesk4p0dF0-uD/view" && misumiCover?.issuer === "株式会社ミスミ" && misumiCover?.qualifiedInvoiceNumber === "T9010601030898" && misumiCover?.slackReceiptFile === "20261120_5984JPY_ミスミ_領収書.pdf" && misumiCover?.slackReceiptNoticeAt === "2026-11-24 09:13 JST" && misumiCover?.memoPresent === false && misumiCover?.memoEvidence == null && misumiCover?.slack.endsWith("1795008891.260349") && misumiCover?.upSiderTransactionId === "f1e71f7a-6703-49a0-beca-c4d2aecff099" && misumiCover?.ledgerId === "TX-20261118-MSM-002" && misumiCover?.orderNumber === "AB257941F8" && misumiCover?.orderReference === "YUBI_PRODUCT" && misumiCover?.items?.length === 3 && misumiCover?.content === misumiCover?.items?.join("、") && misumiCover?.deliveryStatus === "受注確定・未出荷（出荷11/20・お届け11/24予定）" && misumiCover?.statusReason.includes("消費税¥544") && misumiCover?.statusReason.includes("20261120_5984JPY_ミスミ_領収書.pdf") && misumiCover?.statusReason.includes("本文なし") && needsAction(misumiCover), "misumi 5984 identity");
  check(JSON.stringify(misumiCover?.memoDefault) === JSON.stringify({
    purpose: "YUBI製品用部材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "カバーボルト、GUTBS-A7-E20-M3-F4.5-L12 ×4、GUTBS-A7-E15-M3-F4.5-L12 ×4、GUTBRY3-3.5-6 ×4",
  }) && misumiCover?.memoBasis.includes("YUBI_PRODUCT") && misumiCover?.memoBasis.includes("¥16,614") && !misumiCover?.registeredMemo, "misumi 5984 memo");
  check(ledger.transactions.findIndex((tx) => tx.id === misumiFrame.id) < ledger.transactions.findIndex((tx) => tx.id === misumiGlove.id) && ledger.transactions.findIndex((tx) => tx.id === misumiGlove.id) < ledger.transactions.findIndex((tx) => tx.id === nejikuru.id) && ledger.transactions.findIndex((tx) => tx.id === nejikuru.id) < ledger.transactions.findIndex((tx) => tx.id === misumiCover.id), "18th night rows follow payment order");
  check(!JSON.stringify(ledger).includes("3b095d66-6f9f") && !JSON.stringify(ledger).includes("410abe0e-6a95"), "rejected transaction ids are absent");
  check(JSON.stringify(misumiFrame?.memoDefault) === JSON.stringify({
    purpose: "LEAP開発用フレーム資材購入",
    seg1: "AIハンド",
    seg2: "研究開発",
    category: "製造用資材",
    content: "アルミフレーム・バネナット、PACK-SHNTP5-4 ×1、HFSB5-2040-1000-RTP（20×40 黒）×1",
  }) && misumiFrame?.memoBasis.includes("LEAP_DEV") && misumiFrame?.memoBasis.includes("¥3,267") && !misumiFrame?.registeredMemo, "misumi 7878 memo");
  check(ledger.transactions.findIndex((tx) => tx.id === "tx-20261116-0232-amazon-5003") < ledger.transactions.findIndex((tx) => tx.id === monotaroTools.id) && ledger.transactions.findIndex((tx) => tx.id === monotaroTools.id) < ledger.transactions.findIndex((tx) => tx.id === monotaroSquare.id) && ledger.transactions.findIndex((tx) => tx.id === monotaroSquare.id) < ledger.transactions.findIndex((tx) => tx.id === jlcpcb.id) && ledger.transactions.findIndex((tx) => tx.id === jlcpcb.id) < ledger.transactions.findIndex((tx) => tx.id === monotaroTapeNew.id) && ledger.transactions.findIndex((tx) => tx.id === monotaroTapeNew.id) < ledger.transactions.findIndex((tx) => tx.id === misumiFrame.id) && ledger.transactions.findIndex((tx) => tx.id === misumiCover.id) < ledger.transactions.findIndex((tx) => tx.id === "tx-20261119-1514-misumi-8745") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261119-1514-misumi-8745") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261119-2351-jtbamarys-8000") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261119-2351-jtbamarys-8000") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-0345-adam-33246") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-0345-adam-33246") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-1654-paypal-0") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-1654-paypal-0") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-1655-seeed-691525") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261120-1655-seeed-691525") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261122-1841-dhl-4500") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261122-1841-dhl-4500") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261122-2126-monotaro-23857") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261122-2126-monotaro-23857") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261123-0353-nejikuru-27379") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261123-0353-nejikuru-27379") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261124-1730-monotaro-27779") && ledger.transactions.findIndex((tx) => tx.id === "tx-20261124-1730-monotaro-27779") < ledger.transactions.findIndex((tx) => tx.id === "tx-20261125-1732-amazon-6741") && ledger.transactions.at(-1).id === "tx-20261126-0753-amazon-6990", "new rows are appended in payment order");
  const misumiNut = ledger.transactions.find((tx) => tx.id === "tx-20261119-1514-misumi-8745");
  check(misumiNut?.merchant === "ミスミ" && misumiNut?.slackMerchant === "DP5*MISUMI" && misumiNut?.datetime === "11/19 15:14" && misumiNut?.paidAt === "2026-11-19 15:14:23 JST" && misumiNut?.amount === "¥8,745" && misumiNut?.amountYen === 8745 && misumiNut?.status === "メモなし" && misumiNut?.priorStatus === "メモ・証憑なし" && misumiNut?.drive === "https://drive.google.com/file/d/1RWaABcq5SLCutj65GFWn0rrMxGn_4D4Q/view" && misumiNut?.issuer === "株式会社ミスミ" && misumiNut?.qualifiedInvoiceNumber === "T9010601030898" && misumiNut?.slackReceiptFile === "20261120_8745JPY_ミスミ_領収書.pdf" && misumiNut?.slackReceiptNoticeAt === "2026-11-24 09:13 JST" && misumiNut?.memoPresent === false && misumiNut?.memoEvidence == null && misumiNut?.cardholder === "柴田 善広" && misumiNut?.cardName === "AIハンド決済用" && misumiNut?.slack.endsWith("1795068864.053439") && misumiNut?.upSiderTransactionId === "258c756f-c5c5-4ea8-8ddb-d8f815056655" && misumiNut?.ledgerId === "TX-20261119-MSM-001" && misumiNut?.orderNumber === "AB2579CG2E" && misumiNut?.orderReference === "YUBI_PRODUCT" && misumiNut?.content === "アルミフレーム用ナット PACK-HNTTSS5-5 ×1" && misumiNut?.deliveryStatus === "受注確定・未出荷（出荷11/20・お届け11/24予定）" && misumiNut?.accountingTaxYen === 795 && misumiNut?.statusReason.includes("20261120_8745JPY_ミスミ_領収書.pdf") && misumiNut?.statusReason.includes("本文なし") && misumiNut?.statusReason.includes("税別¥7,950") && needsAction(misumiNut), "misumi 8745 identity");
  check(JSON.stringify(misumiNut?.memoDefault) === JSON.stringify({
    purpose: "YUBI製品用部材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "アルミフレーム用ナット PACK-HNTTSS5-5 ×1",
  }) && misumiNut?.memoBasis.includes("¥5,984") && misumiNut?.memoBasis.includes("YUBI_PRODUCT") && !misumiNut?.registeredMemo, "misumi 8745 memo");
  const jtb = ledger.transactions.find((tx) => tx.id === "tx-20261119-2351-jtbamarys-8000");
  check(jtb?.merchant === "JTBAMARYS" && jtb?.slackMerchant === "JTBAMARYS" && jtb?.datetime === "11/19 23:51" && jtb?.paidAt === "2026-11-19 23:51:31 JST" && jtb?.amount === "¥8,000" && jtb?.amountYen === 8000 && jtb?.status === "メモなし" && jtb?.drive === "https://drive.google.com/file/d/1fS-9JJg5NQP5erWS3KWWxZujpLrItD5w/view" && jtb?.memoPresent === false && jtb?.memoEvidence == null && jtb?.cardholder === "柴田 善広" && jtb?.cardName === "AIハンド決済用" && jtb?.slack.endsWith("1795099892.731619") && jtb?.upSiderTransactionId === "a9455490-07a5-43e6-9f4f-539dd9e7ba31" && jtb?.ledgerId === "TX-20261119-JTB-001" && jtb?.orderNumber === "001948" && jtb?.content.includes("SI2026") && jtb?.content.includes("技術交流会(事前)企業展示者") && jtb?.receiptNumber === "326396607015686001" && jtb?.accountingTaxYen === 727 && jtb?.qualifiedInvoiceNumber === "T3010005015907" && jtb?.issuer === "公益社団法人計測自動制御学会" && jtb?.slackReceiptNoticeAt === "2026-11-20 09:13 JST" && jtb?.statusReason.includes("登録完了にはしていない") && jtb?.statusReason.includes("本文なし") && needsAction(jtb), "jtb 8000 identity");
  check(JSON.stringify(jtb?.memoDefault) === JSON.stringify({
    purpose: "学会講演会 技術交流会参加費",
    seg1: "AIハンド",
    seg2: "研究開発",
    category: "会議費",
    content: "SI2026 第27回SICE SI部門講演会 技術交流会参加費（企業展示者、予約番号001948）",
  }) && jtb?.memoBasis.includes("EVENT PAY ¥9,000") && jtb?.memoBasis.includes("会議費") && !jtb?.registeredMemo, "jtb 8000 memo");
  const adam = ledger.transactions.find((tx) => tx.id === "tx-20261120-0345-adam-33246");
  check(adam?.merchant === "ADAM AI LABS" && adam?.slackMerchant === "ADAM AI LABS" && adam?.datetime === "11/20 03:45" && adam?.paidAt === "2026-11-20 03:45:59 JST" && adam?.amount === "¥33,246" && adam?.amountYen === 33246 && adam?.status === "メモ・証憑なし" && adam?.drive === "なし" && adam?.memoPresent === false && adam?.memoEvidence == null && adam?.cardholder === "柴田 善広" && adam?.cardName === "AIハンド決済用" && adam?.slack.endsWith("1795113960.072679") && adam?.upSiderTransactionId === "ffe416c0-a54c-48b1-9b5b-c6fa97dbdd54" && adam?.ledgerId === "TX-20261120-ADM-001" && adam?.orderNumber === undefined && adam?.content.includes("品目未確認") && adam?.content.includes("adam.new") && adam?.statusReason.includes("返信は0件") && adam?.statusReason.includes("未検出") && adam?.statusReason.includes("品目・契約は未確認") && needsAction(adam), "adam 33246 identity");
  check(JSON.stringify(adam?.memoDefault) === JSON.stringify({
    purpose: "AI CAD設計ツール利用料",
    seg1: "AIハンド",
    seg2: "研究開発",
    category: "ソフトウェア利用料",
    content: "ADAM AI LABS（AI CADツール Adam）利用料 ¥33,246",
  }) && adam?.memoBasis.includes("hello@adam.new") && adam?.memoBasis.includes("品目・契約は未確認") && !adam?.memoBasis.includes("要確認") && !adam?.registeredMemo, "adam 33246 memo");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-20 09:20 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。証憑3件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.newTransactions === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 55 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.needsAction === 27 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 3 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 3 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.statusChanges) === JSON.stringify(["tx-20261113-0053-monotaro-18678", "tx-20261117-1823-monotaro-10993"]) && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && !ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261113-0053-monotaro-18678") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261119-1514-misumi-8745") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261119-2351-jtbamarys-8000") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261120-0345-adam-33246") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 15 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("GITHUB, INC. ¥549") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[4].includes("DHL JAPAN ¥31,900") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない"), "morning check attached three receipts");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-20 09:20 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.unconfirmed === 26 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("決済メモを追加しました！") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.previous.note.includes("行を追加しない"), "morning memo check records no new completion");
  check(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-20 09:20 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.attempted === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.attached === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 3 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.method === "ブラウザでスレッドへ本文なし添付" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.items.map((item) => item.transactionId)) === JSON.stringify(["tx-20261113-0053-monotaro-18678", "tx-20261117-1823-monotaro-10993", "tx-20261119-2351-jtbamarys-8000"]) && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.previous.items.every((item) => item.notice === "領収証を添付しました" && item.body === ""), "morning attachments recorded");
  const paypalZero = ledger.transactions.find((tx) => tx.id === "tx-20261120-1654-paypal-0");
  check(paypalZero?.merchant === "PayPal" && paypalZero?.slackMerchant === "PAYPALWALLET" && paypalZero?.datetime === "11/20 16:54" && paypalZero?.paidAt === "2026-11-20 16:54:58 JST" && paypalZero?.amount === "¥0" && paypalZero?.amountYen === 0 && paypalZero?.status === "確認決済（¥0、本決済¥691,525は別行）" && paypalZero?.drive === "なし" && paypalZero?.memoStatus === "未確認" && paypalZero?.memoPresent === false && paypalZero?.memoEvidence == null && paypalZero?.cardholder === "柴田 善広" && paypalZero?.cardName === "AIハンド決済用" && paypalZero?.slack.endsWith("1795161298.269269") && paypalZero?.slackReplyCount === 0 && paypalZero?.pairedTransactionId === "tx-20261120-1655-seeed-691525" && paypalZero?.likelyOrderNumber === "5000005852" && paypalZero?.likelyOrderAmountYen === 691525 && needsAction(paypalZero), "paypal zero identity");
  check(JSON.stringify(paypalZero?.memoDefault) === JSON.stringify({
    purpose: "ロボットアーム実験機材購入（¥691,525本決済の¥0確認決済）",
    seg1: "AIハンド",
    seg2: "その他",
    category: "研究開発",
    content: "確認決済（¥0）。本決済はSeeed注文5000005852 reBot Arm B601-RS Assembled Kit×2・Star Arm 102 Leader Arm×2・AC/DC電源アダプタ12V 2A×2",
  }) && paypalZero?.memoBasis.includes("Amazon ¥0") && !paypalZero?.memoBasis.includes("要確認") && !paypalZero?.registeredMemo, "paypal zero memo mirrors the seeed charge");
  const seeed = ledger.transactions.find((tx) => tx.id === "tx-20261120-1655-seeed-691525");
  check(seeed?.merchant === "Seeed Studio" && seeed?.slackMerchant === "PAYPAL *SEEEDDENWGW" && seeed?.datetime === "11/20 16:55" && seeed?.paidAt === "2026-11-20 16:55:20 JST" && seeed?.amount === "¥691,525" && seeed?.amountYen === 691525 && seeed?.status === "メモなし" && seeed?.drive === "なし" && seeed?.memoStatus === "未確認" && seeed?.memoPresent === false && seeed?.cardholder === "柴田 善広" && seeed?.cardName === "AIハンド決済用" && seeed?.orderedBy === "池滝 俊太" && seeed?.paymentChannel === "PayPal" && seeed?.slack.endsWith("1795161320.143969") && seeed?.ledgerId === "TX-20261120-SEE-001" && seeed?.orderNumber === "5000005852" && seeed?.slackReceiptFile === "invoice.pdf" && seeed?.slackReceiptPostedBy === "Iwasaki_BO/Secretary" && seeed?.slackReceiptNotice === "領収証を添付しました" && seeed?.slackReceiptNoticeAt === "2026-11-20 16:59 JST" && seeed?.issuerReadable === false && seeed?.qualifiedInvoiceNumber === undefined && seeed?.evidenceStorageStatus === "Slack添付済・Drive未保存" && seeed?.statusReason.includes("登録完了にはしていない") && seeed?.statusReason.includes("ファイルサイズ超過") && seeed?.statusReason.includes("人間の投稿はメモ完了に数えない") && seeed?.evidenceCheck.includes("Driveコピーはない") && needsAction(seeed), "seeed 691525 identity");
  check(JSON.stringify(seeed?.memoDefault) === JSON.stringify({
    purpose: "ロボットアーム実験機材（reBot Arm・リーダーアーム・電源アダプタ）",
    seg1: "AIハンド",
    seg2: "その他",
    category: "研究開発",
    content: "Seeed注文5000005852 reBot Arm B601-RS Assembled Kit×2・Star Arm 102 Leader Arm×2・AC/DC電源アダプタ12V 2A×2",
  }) && seeed?.memoBasis.includes("Iwasaki_BO/Secretary") && seeed?.memoBasis.includes("16:57") && seeed?.memoBasis.includes("16:59") && seeed?.memoBasis.includes("1795161320.143969") && seeed?.memoBasis.includes("Lenovo先例") && seeed?.memoBasis.includes("決済メモを追加しました！") && !seeed?.memoBasis.includes("要確認") && !seeed?.registeredMemo && seeed?.memoEvidence?.length === 4 && seeed.memoEvidence.every((item) => item.notice !== "決済メモを追加しました！") && seeed.memoEvidence[0].postedBy === "Iwasaki_BO/Secretary" && seeed.memoEvidence[0].postedAt === "2026-11-20 16:57 JST" && seeed.memoEvidence[1].notice.includes("ファイルサイズ超過") && seeed.memoEvidence[2].text === "AIハンド その他" && seeed.memoEvidence[2].file === "invoice.pdf" && seeed.memoEvidence[3].notice === "領収証を添付しました" && seeed.memoEvidence[3].threadTs === "1795161320.143969", "seeed 691525 memo is not a completion notice");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-21 09:13 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。この実行での証憑添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.newTransactions === 2 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.ledgerRows === 57 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.registeredComplete === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsAction === 29 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.statusChanges) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261120-1654-paypal-0") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261120-1655-seeed-691525") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261120-0345-adam-33246") && !ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsActionIds.includes("tx-20261113-0053-monotaro-18678") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 19 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("RUNPOD.IO ¥8,175") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[2].includes("GOOGLE*CLOUD ¥3,200") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[3].includes("LENOVO.COM JP EPRO ¥296,010") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.excludedOutOfScope[3].includes("00:54") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("人間の投稿はメモ完了に数えない"), "morning check added two cards and attached nothing");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-21 09:13 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.unconfirmed === 28 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("決済メモを追加しました！") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("人間の投稿はメモ完了に数えない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.note.includes("行を追加しない"), "morning memo check records no new completion");
  check(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-21 09:13 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.attempted === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.attached === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.upSiderRegistered === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.method === "この実行での証憑添付はなし" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.items) === "[]", "morning check attached nothing");
  check(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-22 09:14 JST" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。この実行での証憑添付・メモ登録はしていない。" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.ledgerRows === 57 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.registeredComplete === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.needsAction === 29 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excluded === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.memosCreated === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.attachmentsConfirmed === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.statusChanges) === "[]" && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.savedNotAttached) === "[]" && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.needsActionIds.length === 29 && JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.needsActionIds) === JSON.stringify(ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.previous.needsActionIds) && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope.length === 22 && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("TRIPO AI ¥3,200") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[0].includes("池滝 俊太") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[1].includes("OPENAI ¥30,000") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[1].includes("南里さん決済用") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[2].includes("GITHUB ¥117") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[2].includes("SaaS決済用") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[3].includes("RUNPOD.IO ¥8,175") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.excludedOutOfScope[3].includes("前回記載のまま対象外") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("新規の対象取引はなし") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("既存の要処理26スレッド") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("新しい返信・UPSIDER通知はなかった") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("証憑添付・メモ登録はしていない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("行は追加しない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("ステータス・メモ・Driveリンク・メモ初期値は変えていない") && ledger.upsiderCheck.previous.previous.previous.previous.previous.previous.note.includes("メモ作成は行っていない"), "morning check added no card and attached nothing");
  check(ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-22 09:14 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.memoPresent === 24 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.unconfirmed === 28 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.source === "ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.note.includes("決済メモを追加しました！") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.note.includes("新規の対象取引はない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.note.includes("行を追加しない") && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-21 09:13 JST", "morning memo check records no new completion today");
  check(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-22 09:14 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.attempted === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.attached === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.upSiderRegistered === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.method === "この実行での証憑添付はなし" && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.items) === "[]" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.previous.previous.checkedAt === "2026-11-21 09:13 JST", "morning check attached nothing today");
  const dhlDuty = ledger.transactions.find((tx) => tx.id === "tx-20261122-1841-dhl-4500");
  check(dhlDuty?.merchant === "DHL" && dhlDuty?.slackMerchant === "DHL JAPAN, INC." && dhlDuty?.datetime === "11/22 18:41" && dhlDuty?.paidAt === "2026-11-22 18:41:52 JST" && dhlDuty?.amount === "¥4,500" && dhlDuty?.amountYen === 4500 && dhlDuty?.status === "メモ・証憑なし" && dhlDuty?.drive === "なし" && dhlDuty?.memoStatus === "未確認" && dhlDuty?.memoPresent === false && dhlDuty?.memoEvidence == null && dhlDuty?.cardholder === "柴田 善広" && dhlDuty?.cardName === "AIハンド決済用" && dhlDuty?.slack === "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1795340512.381139" && dhlDuty?.slackThreadTs === "1795340512.381139" && dhlDuty?.slackReplyCount === 0 && dhlDuty?.ledgerId === "TX-20261117-JLC-001" && dhlDuty?.orderNumber === "W2026111623018994" && dhlDuty?.waybillNumber === "5343843293" && dhlDuty?.dhlTransactionId === "222815396-126505698" && dhlDuty?.relatedTransactionId === "tx-20261117-0001-jlcpcb-25017" && dhlDuty?.content.includes("AD-YUBI_Hub_01") && dhlDuty?.statusReason.includes("返信は0件") && dhlDuty?.statusReason.includes("領収証を添付しました") && dhlDuty?.statusReason.includes("決済メモを追加しました！") && !dhlDuty?.registeredMemo && needsAction(dhlDuty), "dhl 4500 identity");
  check(JSON.stringify(dhlDuty?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造用資材の輸入関税・消費税",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "DHL輸入関税・消費税、JLCPCB AD-YUBI_Hub_01基板（注文W2026111623018994・運送状5343843293）",
  }) && dhlDuty?.memoBasis.includes("222815396-126505698") && dhlDuty?.memoBasis.includes("5343843293") && !dhlDuty?.memoBasis.includes("要確認"), "dhl 4500 memo");
  const monotaroStorage = ledger.transactions.find((tx) => tx.id === "tx-20261122-2126-monotaro-23857");
  check(monotaroStorage?.merchant === "MonotaRO" && monotaroStorage?.slackMerchant === "DP12*MONOTARO.COM" && monotaroStorage?.datetime === "11/22 21:26" && monotaroStorage?.paidAt === "2026-11-22 21:26:17 JST" && monotaroStorage?.amount === "¥23,857" && monotaroStorage?.amountYen === 23857 && monotaroStorage?.status === "メモ・証憑なし" && monotaroStorage?.drive === "なし" && monotaroStorage?.memoStatus === "未確認" && monotaroStorage?.memoPresent === false && monotaroStorage?.memoEvidence == null && monotaroStorage?.cardholder === "柴田 善広" && monotaroStorage?.cardName === "AIハンド決済用" && monotaroStorage?.slack === "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1795350377.941919" && monotaroStorage?.slackThreadTs === "1795350377.941919" && monotaroStorage?.slackReplyCount === 0 && monotaroStorage?.ledgerId === "TX-20261122-MNT-001" && monotaroStorage?.orderNumber === "134323400042" && monotaroStorage?.orderReference === "資材収納用品" && monotaroStorage?.items?.length === 3 && monotaroStorage?.content === monotaroStorage?.items?.join("、") && monotaroStorage?.content.includes("FCLD50-GR/C") && monotaroStorage?.content.includes("50GN") && monotaroStorage?.content.includes("52666618") && monotaroStorage?.deliveryStatus === "一部納入（コンテナFCLD50-GR/C×3・台車×1は納品書受領、フタ×2は12/02出荷予定）" && monotaroStorage?.statusReason.includes("返信は0件") && !monotaroStorage?.registeredMemo && needsAction(monotaroStorage), "monotaro 23857 identity");
  check(JSON.stringify(monotaroStorage?.memoDefault) === JSON.stringify({
    purpose: "YUBI製造用資材の収納用品購入",
    seg1: "AIハンド",
    seg2: "その他",
    category: "備品",
    content: "折りたたみコンテナ・台車、モノタロウ 折りたたみコンテナ扉付き FCLD50-GR/C ×3、同用フタ 50GN ×2、同(50L)用台車 緑 ×1",
  }) && monotaroStorage?.memoBasis.includes("134323400042") && monotaroStorage?.memoBasis.includes("資材収納用品") && !monotaroStorage?.memoBasis.includes("要確認"), "monotaro 23857 memo");
  const nejikuruScrews = ledger.transactions.find((tx) => tx.id === "tx-20261123-0353-nejikuru-27379");
  check(nejikuruScrews?.merchant === "ネジクル" && nejikuruScrews?.slackMerchant === "DP04*NEJIKURU" && nejikuruScrews?.datetime === "11/23 03:53" && nejikuruScrews?.paidAt === "2026-11-23 03:53:07 JST" && nejikuruScrews?.amount === "¥27,379" && nejikuruScrews?.amountYen === 27379 && nejikuruScrews?.status === "メモ・証憑なし" && nejikuruScrews?.drive === "なし" && nejikuruScrews?.memoStatus === "未確認" && nejikuruScrews?.memoPresent === false && nejikuruScrews?.memoEvidence == null && nejikuruScrews?.cardholder === "柴田 善広" && nejikuruScrews?.cardName === "AIハンド決済用" && nejikuruScrews?.slack === "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1795373587.639099" && nejikuruScrews?.slackThreadTs === "1795373587.639099" && nejikuruScrews?.slackReplyCount === 0 && nejikuruScrews?.ledgerId === "TX-20261123-TRG-001" && nejikuruScrews?.orderNumber === "EC261123-004790140" && nejikuruScrews?.items?.length === 2 && nejikuruScrews?.deliveryStatus === "出荷済（11/24ツルガ出荷明細書受領・納入未確認）" && nejikuruScrews?.content.includes("サンコータイト") && nejikuruScrews?.content.includes("2.3×8 ×8,000") && nejikuruScrews?.content.includes("2.3×6 ×1,000") && nejikuruScrews?.statusReason.includes("返信は0件") && !nejikuruScrews?.registeredMemo && needsAction(nejikuruScrews), "nejikuru 27379 identity");
  check(JSON.stringify(nejikuruScrews?.memoDefault) === JSON.stringify({
    purpose: "YUBI Glove製造用資材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "ねじ、サンコータイト Pタイプ トラス 黒 2.3×8 ×8,000、十字穴付トラス小ねじ 黒 2.3×6 ×1,000",
  }) && nejikuruScrews?.memoBasis.includes("EC261123-004790140") && nejikuruScrews?.memoBasis.includes("¥5,782") && !nejikuruScrews?.memoBasis.includes("要確認"), "nejikuru 27379 memo");
  const monotaroHub = ledger.transactions.find((tx) => tx.id === "tx-20261124-1730-monotaro-27779");
  check(monotaroHub?.merchant === "MonotaRO" && monotaroHub?.slackMerchant === "DP12*MONOTARO.COM" && monotaroHub?.datetime === "11/24 17:30" && monotaroHub?.paidAt === "2026-11-24 17:30:58 JST" && monotaroHub?.amount === "¥27,779" && monotaroHub?.amountYen === 27779 && monotaroHub?.status === "メモなし" && monotaroHub?.drive === "https://drive.google.com/file/d/1roziQlZi3XlXycPfboY2xGenPlCXYlE-/view" && monotaroHub?.priorStatus === "メモ・証憑なし" && monotaroHub?.slackReceiptFile === "20261125_27779JPY_モノタロウ_領収証.pdf" && monotaroHub?.receiptNumber === "B8640408" && monotaroHub?.qualifiedInvoiceNumber === "T6140001054380" && monotaroHub?.issuer === "株式会社ＭｏｎｏｔａＲＯ" && monotaroHub?.slackReceiptPostedAt === "2026-11-27 09:33 JST" && monotaroHub?.slackReceiptNoticeAt === "2026-11-27 09:33 JST" && monotaroHub?.memoStatus === "未確認" && monotaroHub?.memoPresent === false && monotaroHub?.memoEvidence == null && monotaroHub?.cardholder === "柴田 善広" && monotaroHub?.cardName === "AIハンド決済用" && monotaroHub?.slack === "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1795509059.782579" && monotaroHub?.slackThreadTs === "1795509059.782579" && monotaroHub?.slackReplyCount === 3 && monotaroHub?.upSiderTransactionId === "54a7b93c-8407-426b-8340-a73193272732" && monotaroHub?.ledgerId === "TX-20261124-MNT-001" && monotaroHub?.orderNumber === "134323400043" && monotaroHub?.receptionNumber === "203594336" && monotaroHub?.orderReference === "YUBI Glove 資材" && monotaroHub?.content === "エレコム USBハブ U3H-H042BK/E ×23" && monotaroHub?.items?.length === 1 && monotaroHub?.deliveryStatus === "納入済（11/26納品書受領）" && monotaroHub?.deliveryConfirmed === true && monotaroHub?.statusUpdatedAt === "2026-11-27 09:35 JST" && monotaroHub?.statusReason.includes("返信は3件") && monotaroHub?.statusReason.includes("230706540") && monotaroHub?.statusReason.includes("¥2,525") && !monotaroHub?.registeredMemo && needsAction(monotaroHub), "monotaro 27779 identity");
  check(JSON.stringify(monotaroHub?.memoDefault) === JSON.stringify({
    purpose: "YUBI Glove製造用資材購入",
    seg1: "AIハンド",
    seg2: "プロダクト販売",
    category: "製造用資材",
    content: "USBハブ、エレコム U3H-H042BK/E ×23",
  }) && monotaroHub?.memoBasis.includes("参照番号「YUBI Glove 資材」") && monotaroHub?.memoBasis.includes("UGREEN USB Type-Cケーブル ×20") && monotaroHub?.memoBasis.includes("YUBI Glove製造用資材購入／プロダクト販売／製造用資材") && !monotaroHub?.memoBasis.includes("要確認") && MEMO_FIELDS.every((field) => monotaroHub.memoDefault[field].trim()), "monotaro 27779 memo");

  const addedToday = [
    ["tx-20261125-1732-amazon-6741", "Amazon", "AMAZON CO JP", "¥6,741", 6741, "11/25 17:32", "2026-11-25 17:32:13 JST", "1795595533.522609", "09780592-5a0f-452c-b5a4-5c452d61bdf5", "TX-20261125-AMZ-001", "503-5003530-6750248", "UGREEN USB Type-Cケーブル USB3.0 1M ×9（発注番号 YUBIGB製造）", "納入済（11/26配達完了）", "メモなし", "https://drive.google.com/file/d/1qw_sTud4m3-oXg0_MPCqIICbxxzipG8H/view", 3],
    ["tx-20261125-1841-monotaro-34056", "MonotaRO", "DP12*MONOTARO.COM", "¥34,056", 34056, "11/25 18:41", "2026-11-25 18:41:16 JST", "1795599676.369029", "19b34e45-12d8-4ee6-9750-e4953a8ab822", "TX-20261125-MNT-001", "134323400044", "丸井計器 Rキャリパー RC-150 ×1、Mitutoyo デジマチックキャリパ CD-15AXR ×1（参照番号 製造用測定機）", "受付（出荷予定11/26まで）・未出荷", "メモ・証憑なし", "なし", 0],
    ["tx-20261125-1846-monotaro-16803", "MonotaRO", "DP12*MONOTARO.COM", "¥16,803", 16803, "11/25 18:46", "2026-11-25 18:46:58 JST", "1795600018.117059", "0172ab5c-0cbd-492f-89c6-0f764d44e08e", "TX-20261125-MNT-002", "134323400045", "TRUSCO NS型コンテナ NS-10N Y・B・NR 各×3、R ×2、蓋 NS-10F NR ×3（参照番号 YUBI製造収納用品）", "受付（出荷予定11/26まで）・未出荷", "メモ・証憑なし", "なし", 0],
    ["tx-20261126-0238-nejikuru-3300", "ネジクル", "DP04*NEJIKURU", "¥3,300", 3300, "11/26 02:38", "2026-11-26 02:38:27 JST", "1795628307.043349", "91cef89e-f5c6-4c5d-b558-14c06945e572", "TX-20261126-TRG-001", "EC261126-005510194", "サンコータイト Pタイプ 皿 黒 2.6×8 ×76 ほか計6品目", "出荷済（11/26出荷、ゆうパック144947082545）・納入待ち", "メモ・証憑なし", "なし", 0],
    ["tx-20261126-0340-monotaro-5498", "MonotaRO", "DP12*MONOTARO.COM", "¥5,498", 5498, "11/26 03:40", "2026-11-26 03:40:37 JST", "1795632037.271039", "f2bf7ae4-6339-4241-aca1-c7104499106b", "TX-20261126-MNT-001", "134323400046", "Mitutoyo 標準形ダイヤルゲージ 2044A ×1（参照番号 製造用治具）", "受付（出荷予定11/26まで）・未出荷", "メモ・証憑なし", "なし", 0],
    ["tx-20261126-0753-amazon-6990", "Amazon", "AMAZON CO JP", "¥6,990", 6990, "11/26 07:53", "2026-11-26 07:53:27 JST", "1795647207.096069", "2bbba167-607e-42a7-b58b-4f5767df1ce5", "TX-20261126-AMZ-001", "249-5533807-4183815", "Anker 547 USB-C ハブ (7-in-2) ×1", "出荷済（11/27発送）・納入待ち", "メモ・証憑なし", "なし", 0],
  ];
  const addedTodayMemos = {
    "tx-20261125-1732-amazon-6741": { purpose: "YUBI Glove製造用資材購入", seg1: "AIハンド", seg2: "プロダクト販売", category: "製造用資材", content: "USB Type-Cケーブル、UGREEN USB3.0 1M ×9（発注番号 YUBIGB製造）" },
    "tx-20261125-1841-monotaro-34056": { purpose: "YUBI製造ライン用測定器購入", seg1: "AIハンド", seg2: "その他", category: "備品", content: "測定器、丸井計器 半径測定器 Rキャリパー RC-150 ×1、Mitutoyo 標準ABSデジマチックキャリパ CD-15AXR ×1" },
    "tx-20261125-1846-monotaro-16803": { purpose: "AIハンド製造ライン用資材収納用品購入", seg1: "AIハンド", seg2: "その他", category: "備品", content: "部品コンテナ、TRUSCO NS型コンテナ 10L NS-10N Y・B・NR 各×3、R ×2、同蓋 NS-10F NR ×3" },
    "tx-20261126-0238-nejikuru-3300": { purpose: "YUBI Glove製造用資材購入", seg1: "AIハンド", seg2: "プロダクト販売", category: "製造用資材", content: "ねじ、サンコータイト Pタイプ 皿 黒 2.6×8 ×76、Bタイト 黒 3×8 ×28、Pタイプ ナベ 2×4 銀 ×77・黒 ×68、皿小ねじ 銀 2.5×16 ×50・2.5×20 ×42" },
    "tx-20261126-0340-monotaro-5498": { purpose: "YUBI製造ライン用測定器購入", seg1: "AIハンド", seg2: "その他", category: "備品", content: "ダイヤルゲージ、Mitutoyo 標準形ダイヤルゲージ(目量0.01mm) 2044A ×1" },
    "tx-20261126-0753-amazon-6990": { purpose: "AIハンド開発用PC周辺機器購入", seg1: "AIハンド", seg2: "研究開発", category: "消耗品", content: "USB-Cハブ、Anker 547 USB-C ハブ (7-in-2, Thunderbolt 4) ×1" },
  };
  for (const [id, merchant, slackMerchant, amount, yen, datetime, paidAt, thread, transactionId, ledgerId, orderNumber, content, delivery, status, drive, replies] of addedToday) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.merchant === merchant && tx?.slackMerchant === slackMerchant && tx?.amount === amount && tx?.amountYen === yen && tx?.datetime === datetime && tx?.status === status && tx?.drive === drive && tx?.memoPresent === false && tx?.memoStatus === "未確認" && tx?.memoEvidence == null, `new card identity ${id}`);
    check(tx?.paidAt === paidAt && tx?.slack.endsWith(thread) && tx?.upSiderTransactionId === transactionId && tx?.ledgerId === ledgerId && tx?.orderNumber === orderNumber && tx?.content === content && tx?.deliveryStatus === delivery && tx?.cardholder === "柴田 善広" && tx?.cardName === "AIハンド決済用" && tx?.slackReplyCount === replies && needsAction(tx), `new card order ${id}`);
    check(JSON.stringify(tx?.memoDefault) === JSON.stringify(addedTodayMemos[id]) && tx?.memoBasis && !tx.memoBasis.includes("要確認") && MEMO_FIELDS.every((field) => tx.memoDefault[field].trim()) && tx.memoDefault.seg1 === "AIハンド" && !tx?.registeredMemo, `new card memo ${id}`);
  }
  check(ledger.transactions.slice(-6).map((tx) => tx.id).join() === addedToday.map((row) => row[0]).join(), "new cards are appended in datetime order");

  check(ledger.upsiderCheck.checkedAt === "2026-11-27 09:35 JST" && ledger.upsiderCheck.previous.checkedAt === "2026-11-26 09:25 JST" && ledger.upsiderCheck.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.source === "ブラウザで#bo_upsiderを確認。領収証PDF1件と適格請求書PDF1件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.previous.source === "ブラウザで#bo_upsiderを確認。納品書兼適格請求書PDF1件を本文なしで添付。メモ登録はしていない。" && ledger.upsiderCheck.newTransactions === 0 && ledger.upsiderCheck.previous.newTransactions === 6 && ledger.upsiderCheck.ledgerRows === 67 && ledger.upsiderCheck.registeredComplete === 22 && ledger.upsiderCheck.needsAction === 39 && ledger.upsiderCheck.excluded === 6 && ledger.upsiderCheck.memosCreated === 0 && ledger.upsiderCheck.attachmentsAttempted === 2 && ledger.upsiderCheck.attachmentsConfirmed === 2 && ledger.upsiderCheck.previous.attachmentsAttempted === 1 && ledger.upsiderCheck.previous.attachmentsConfirmed === 1 && JSON.stringify(ledger.upsiderCheck.statusChanges) === JSON.stringify(["tx-20261124-1730-monotaro-27779","tx-20261125-1732-amazon-6741"]) && JSON.stringify(ledger.upsiderCheck.previous.statusChanges) === JSON.stringify(["tx-20261115-2152-switchscience-3560"]) && JSON.stringify(ledger.upsiderCheck.savedNotAttached) === "[]" && ledger.upsiderCheck.needsActionIds.length === 39 && ledger.upsiderCheck.needsActionIds.at(-1) === "tx-20261126-0753-amazon-6990" && JSON.stringify(ledger.upsiderCheck.needsActionIds.slice(0, -6)) === JSON.stringify(ledger.upsiderCheck.previous.previous.needsActionIds) && ledger.upsiderCheck.excludedOutOfScope.length === 33 && ledger.upsiderCheck.note.includes("新規の対象取引はなし") && ledger.upsiderCheck.note.includes("未確認") && ledger.upsiderCheck.previous.note.includes("新規の対象取引は6件") && ledger.upsiderCheck.note.includes("ゆうパック144947082545") && ledger.upsiderCheck.previous.note.includes("1795652205.005089") && ledger.upsiderCheck.note.includes("メモ・証憑なしからメモなし") && ledger.upsiderCheck.note.includes("メモ作成は行っていない") && ledger.upsiderCheck.previous.previous.checkedAt === "2026-11-25 15:30 JST" && ledger.upsiderCheck.previous.previous.newTransactions === 0 && ledger.upsiderCheck.previous.previous.ledgerRows === 61 && ledger.upsiderCheck.previous.previous.needsAction === 33 && ledger.upsiderCheck.previous.previous.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.previous.previous.needsActionIds) === JSON.stringify(ledger.upsiderCheck.previous.previous.previous.needsActionIds) && ledger.upsiderCheck.previous.previous.previous.checkedAt === "2026-11-25 09:11 JST" && ledger.upsiderCheck.previous.previous.previous.newTransactions === 1 && ledger.upsiderCheck.previous.previous.previous.attachmentsAttempted === 0 && ledger.upsiderCheck.previous.previous.previous.previous.checkedAt === "2026-11-24 09:15 JST" && ledger.upsiderCheck.previous.previous.previous.previous.attachmentsAttempted === 6 && ledger.upsiderCheck.previous.previous.previous.previous.previous.checkedAt === "2026-11-23 09:24 JST", "morning check added the monotaro hub and attached nothing");
  check(ledger.memoCheck.latestCheck.checkedAt === "2026-11-27 09:35 JST" && ledger.memoCheck.latestCheck.previous.checkedAt === "2026-11-26 09:25 JST" && ledger.memoCheck.latestCheck.memoPresent === 24 && ledger.memoCheck.latestCheck.unconfirmed === 38 && ledger.memoCheck.latestCheck.newMemoCompletions === 0 && ledger.memoCheck.latestCheck.source === "ブラウザで#bo_upsiderを確認。メモ登録はしていない。" && ledger.memoCheck.latestCheck.note.includes("新しい決済メモ完了通知はない") && ledger.memoCheck.latestCheck.note.includes("決済メモを追加しました！") && ledger.memoCheck.latestCheck.note.includes("未確認") && ledger.memoCheck.latestCheck.note.includes("0件") && ledger.memoCheck.latestCheck.previous.note.includes("スイッチサイエンス ¥3,560") && ledger.memoCheck.latestCheck.previous.note.includes("1795652205.005089") && ledger.memoCheck.latestCheck.previous.note.includes("返信は0件") && ledger.memoCheck.latestCheck.note.includes("行を追加しない") && ledger.memoCheck.latestCheck.previous.previous.checkedAt === "2026-11-25 15:30 JST" && ledger.memoCheck.latestCheck.previous.previous.unconfirmed === 32 && ledger.memoCheck.latestCheck.previous.previous.note.includes("MonotaRO ¥27,779") && ledger.memoCheck.latestCheck.previous.previous.note.includes("領収証添付のみ") && ledger.memoCheck.latestCheck.previous.previous.previous.checkedAt === "2026-11-25 09:11 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.unconfirmed === 32 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.checkedAt === "2026-11-24 09:15 JST" && ledger.memoCheck.latestCheck.previous.previous.previous.previous.unconfirmed === 31 && ledger.memoCheck.latestCheck.previous.previous.previous.previous.previous.checkedAt === "2026-11-23 09:24 JST", "morning memo check records no new completion today");
  check(ledger.slackReceiptAttachment.latestRun.checkedAt === "2026-11-27 09:35 JST" && ledger.slackReceiptAttachment.latestRun.previous.checkedAt === "2026-11-26 09:25 JST" && ledger.slackReceiptAttachment.latestRun.attempted === 2 && ledger.slackReceiptAttachment.latestRun.attached === 2 && ledger.slackReceiptAttachment.latestRun.upSiderRegistered === 2 && ledger.slackReceiptAttachment.latestRun.previous.attempted === 1 && ledger.slackReceiptAttachment.latestRun.previous.attached === 1 && ledger.slackReceiptAttachment.latestRun.previous.upSiderRegistered === 1 && ledger.slackReceiptAttachment.latestRun.method === "ブラウザでスレッドへ本文なし添付" && ledger.slackReceiptAttachment.latestRun.items.length === 2 && ledger.slackReceiptAttachment.latestRun.items[0].transactionId === "tx-20261124-1730-monotaro-27779" && ledger.slackReceiptAttachment.latestRun.items[0].notice === "領収証を添付しました" && ledger.slackReceiptAttachment.latestRun.items[0].noticeAt === "2026-11-27 09:33 JST" && ledger.slackReceiptAttachment.latestRun.items[0].poster === "UPSIDER" && ledger.slackReceiptAttachment.latestRun.items[0].body === "" && ledger.slackReceiptAttachment.latestRun.items[0].file === "20261125_27779JPY_モノタロウ_領収証.pdf" && ledger.slackReceiptAttachment.latestRun.items[0].drive === "https://drive.google.com/file/d/1roziQlZi3XlXycPfboY2xGenPlCXYlE-/view" && ledger.slackReceiptAttachment.latestRun.items[0].receiptNumber === "B8640408" && ledger.slackReceiptAttachment.latestRun.items[1].transactionId === "tx-20261125-1732-amazon-6741" && ledger.slackReceiptAttachment.latestRun.items[1].noticeAt === "2026-11-27 09:32 JST" && ledger.slackReceiptAttachment.latestRun.items[1].body === "" && ledger.slackReceiptAttachment.latestRun.items[1].file === "20261125_6741JPY_Amazon_適格請求書.pdf" && ledger.slackReceiptAttachment.latestRun.items[1].qualifiedInvoiceNumber === "T7010901052842" && ledger.slackReceiptAttachment.latestRun.previous.items[0].transactionId === "tx-20261115-2152-switchscience-3560" && ledger.slackReceiptAttachment.latestRun.previous.items[0].notice === "領収証を添付しました" && ledger.slackReceiptAttachment.latestRun.previous.items[0].noticeAt === "2026-11-26 09:16:45 JST" && ledger.slackReceiptAttachment.latestRun.previous.items[0].noticeTs === "1795652205.005089" && ledger.slackReceiptAttachment.latestRun.previous.items[0].poster === "UPSIDER" && ledger.slackReceiptAttachment.latestRun.previous.items[0].body === "" && ledger.slackReceiptAttachment.latestRun.previous.items[0].file === "20261115_3560JPY_スイッチサイエンス_納品書兼適格請求書.pdf" && ledger.slackReceiptAttachment.latestRun.previous.previous.checkedAt === "2026-11-25 15:30 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.attempted === 0 && JSON.stringify(ledger.slackReceiptAttachment.latestRun.previous.previous.items) === "[]" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.checkedAt === "2026-11-25 09:11 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.attempted === 0 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.checkedAt === "2026-11-24 09:15 JST" && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.attempted === 6 && ledger.slackReceiptAttachment.latestRun.previous.previous.previous.previous.previous.checkedAt === "2026-11-23 09:24 JST", "morning check attached nothing today");
  check(ledger.transactions.length === 67 && ledger.transactions.every((tx) => {
    const preset = tx.memoDefault;
    return preset
      && MEMO_FIELDS.every((field) => typeof preset[field] === "string" && preset[field].trim() && !preset[field].includes("要確認"))
      && preset.seg1 === "AIハンド";
  }), "every row has a filled memoDefault with AIハンド and no 要確認");
  const partialMemo = memoDefaults({
    content: "軸受",
    memoDefault: { purpose: "  ", seg1: "", seg2: "プロダクト販売", category: "", content: "" },
  });
  check(partialMemo.purpose === "軸受" && partialMemo.seg1 === "AIハンド" && partialMemo.seg2 === "プロダクト販売" && partialMemo.category === "消耗品" && partialMemo.content === "軸受", "empty preset fields fall back one by one");
  const blankMemo = memoDefaults({
    content: "部品",
    memoDefault: { purpose: "", seg1: "", seg2: "", category: "", content: "" },
  });
  check(blankMemo.purpose === "部品" && blankMemo.seg1 === "AIハンド" && blankMemo.category === "消耗品" && blankMemo.content === "部品" && MEMO_FIELDS.some((field) => blankMemo[field].trim()), "an all-empty preset does not produce an all-empty memo");
  check(memoDefaults({ content: "部品", memoDefault: { purpose: "購入", seg1: "   ", seg2: "要確認", category: "備品", content: "部品" } }).seg1 === "AIハンド", "whitespace seg1 becomes AIハンド");
  const composed = memoSeedText({
    merchant: "MonotaRO",
    amount: "¥4,065",
    datetime: "11/11 15:46",
    orderNumber: "134323400031",
    items: ["セメダイン スーパーXゴールド AX-014 20mL ×5"],
    purpose: "消耗品",
    content: "  ",
  });
  check(composed === "MonotaRO ¥4,065 11/11 15:46 注文書番号134323400031 セメダイン スーパーXゴールド AX-014 20mL ×5 消耗品", `composed seed ${composed}`);
  check(memoSeedText({ merchant: "Amazon", paidAt: "2026-11-11 15:53:54 JST", content: "" }) === "Amazon 2026-11-11 15:53:54 JST", "date falls back to paidAt");
  check(JSON.stringify(loadMemoDrafts("")) === "{}" && JSON.stringify(loadMemoDrafts("{")) === "{}", "bad memo storage is ignored");
  const storedDrafts = loadMemoDrafts(JSON.stringify({
    version: 1,
    memos: {
      "tx-1": { purpose: "a", seg1: "b", seg2: "c", category: "d", content: "e", token: "no" },
      "tx-2": { purpose: "a", token: "x" },
    },
  }));
  check(storedDrafts["tx-1"]?.content === "e" && !("token" in storedDrafts["tx-1"]), "stored memo keeps the five strings");
  check(storedDrafts["tx-2"] === undefined, "incomplete memo draft is dropped");

  const hashes = {
    "17553.jpg": "8dd1567b719033aa6802aa90ce77300f80a2f9800ee6081d6f2ff435c8611b2c",
    "17600.jpg": "e1bfe986ca6c93f9573a0bc08b0e24a9270436dd2f5b7eaa2dd61a057f19e60f",
    "2659.jpg": "74f1074a9c7b11352cb60a889098c7fa6dd7e51f1fcaee37c6eb2db6d97e15e9",
    "4833.jpg": "357871b304747fd8732e79f078c0e4bf85e7a8a8e289080bd844eb5a0f07513f",
  };
  for (const [name, hash] of Object.entries(hashes)) {
    const digest = createHash("sha256").update(fs.readFileSync(path.join(root, "assets", name))).digest("hex");
    check(digest === hash, `${name} hash changed`);
  }

  const sources = fs.readFileSync(path.join(root, "js/app.js"), "utf8")
    + fs.readFileSync(path.join(root, "js/logic.js"), "utf8")
    + fs.readFileSync(path.join(root, "js/result.js"), "utf8");
  check(!/hooks\.slack|api\.slack|chat\.postMessage|xox[baprs]-/.test(sources), "no slack posting or token");
  check(!/UPSIDER_RESULT_WRITE_KEY|Bearer\s+\S|AIza/.test(sources), "result client has no write key");
  check(fs.readFileSync(path.join(root, "index.html"), "utf8").includes('src="js/app.js"'), "pages entry stays js/app.js");
  check(fs.readFileSync(path.join(root, "js/logic.js"), "utf8").includes('from "./result.js"'), "result.js is loaded from the page module");
  check(!fs.existsSync(path.join(root, ".github")), "no GitHub Actions");
  const gasSource = fs.readFileSync(path.join(root, "gas/Code.gs"), "utf8");
  check(gasSource.includes("【UPSIDERメモ登録依頼】"), "gas title");
  check(gasSource.includes("【モニターからの指示】"), "instruction title");
  check(!gasSource.includes("sendInstruction("), "template does not call the sheet writer");
  check(gasSource.includes("postSlack_("), "gas uses existing postSlack_");
  check(!/SpreadsheetApp|getActiveSpreadsheet|UrlFetchApp|hooks\.slack\.com/.test(gasSource), "gas does not touch sheets or embed a webhook");
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  check(!/^config\.js$/m.test(ignore), "published config.js is not gitignored");
  const publishedConfig = fs.readFileSync(path.join(root, "config.js"), "utf8");
  check(!publishedConfig.includes("script.google.com") && !publishedConfig.includes("AKfycbw"), "config.js has no reception url");
  check(/gasUrl:\s*""/.test(publishedConfig), "published gas url is empty");
  const appSource = fs.readFileSync(path.join(root, "js/app.js"), "utf8");
  check(!/postGasPayload|fetchResult|loadGasConfig|resumePolling|data-instruction-send|data-ai|data-recheck|script\.google\.com/.test(appSource), "page does not call reception");
  check(appSource.includes("メモ作成") && appSource.includes("初期値に戻す") && appSource.includes("localStorage.getItem(MEMO_STORAGE_KEY)"), "row memo card is part of the page");
  check(sources.includes(MEMO_STORAGE_KEY), "memo drafts use a local storage key");
  check((appSource.match(/fetch\(/g) || []).length === 1, "page still fetches only the ledger");
  check(appSource.includes("Slackの参照・メモ追加・証憑添付はブラウザのみ。API・MCP・Webhook等の連携機能は使用しません。"), "policy is on the page");
  const stoppedGas = fs.readFileSync(path.join(root, "gas/live-getter-reception-stopped.gs"), "utf8");
  check(stoppedGas.includes("受付を停止しています") && !/SpreadsheetApp|PropertiesService|UrlFetchApp|LockService|CacheService|SLACK_WEBHOOK|hooks\.slack/.test(stoppedGas), "stopped gas touches neither sheets nor secrets");
  check(!publishedConfig.includes("testPollMs"), "production config has no test poll interval");
  check(!/hooks\.slack\.com|xox[baprs]-|Bearer\s+\S/.test(publishedConfig), "config.js has no secret");
  const example = fs.readFileSync(path.join(root, "config.example.js"), "utf8");
  check(/gasUrl:\s*""/.test(example), "example gas url empty");
  check(!example.includes("AKfycbw"), "example does not contain the live url");
  check(gasSource.includes("e.parameter.payload") || gasSource.includes("e.parameter && e.parameter.payload"), "gas reads parameter payload");
  check(gasSource.includes("PropertiesService") && gasSource.includes("LockService"), "gas lock and property dedup");
  check(gasSource.includes("200") && gasSource.includes("30"), "gas caps ids and hourly rate");
  check(gasSource.includes("C0BG07UF1EY-\\d{10}\\.\\d{6}"), "gas slack pattern");
  check(!gasSource.includes("CacheService"), "gas does not use the old cache dedup");
  check(!/text\/plain/.test(fs.readFileSync(path.join(root, "js/logic.js"), "utf8")), "client does not post text/plain");

  for (const tx of ledger.transactions) {
    check(slackChannelId(tx.slack) === "C0BG07UF1EY", `channel ${tx.id}`);
    check(isAllowedSlackThread(tx.slack, ledger.transactions, tx.id), `strict slack ${tx.id}`);
    check(!isAllowedSlackThread(tx.slack.replace("C0BG07UF1EY", "C0OTHER"), ledger.transactions, tx.id), `other channel ${tx.id}`);
  }
  const sample = ledger.transactions.find((tx) => tx.memoKey === "7160");
  const held = buildExecutionRequest({
    transactionId: sample.id,
    slackThread: sample.slack,
    memo: initialMemo(sample.content),
    savedAt: "2026-11-06T00:00:00.000Z",
  });
  const legacy = {
    transactionId: sample.id,
    slackThread: sample.slack,
    memoLines: held.memoLines,
    savedAt: held.savedAt,
    status: "未実行",
  };
  const migrated = migrateExecutionRequest(sample.id, legacy);
  check(migrated.status === "未実行" && migrated.requestId === null, "v1 migrates");
  check(migrated.memoLines.join("\n") === held.memoLines.join("\n"), "v1 memo kept");
  check(loadStoredRequests(JSON.stringify({ version: 1, requests: { [sample.id]: legacy } }))[sample.id].memoLines[0] === legacy.memoLines[0], "v1 load");
  check(migrateExecutionRequest(sample.id, { ...legacy, token: "x" }) === null, "token dropped");
  const interrupted = migrateExecutionRequest(sample.id, { ...held, status: "送信中", requestId: "same-id" });
  check(interrupted.status === "エラー" && interrupted.requestId === "same-id", "interrupted send keeps id");
  check(resolveRequestId(interrupted, interrupted.memoLines, () => "new-id") === "same-id", "retry reuses id");
  check(resolveRequestId(interrupted, ["用途：別", "セグメント1：AIハンド", "セグメント2：", "分類：消耗品", "内容：別"], () => "new-id") === "new-id", "edited memo gets a new id");
  const sampleUuid = "11111111-2222-4333-8444-555555555555";
  const v3 = migrateExecutionRequest(sample.id, {
    ...held,
    status: "処理中",
    requestId: sampleUuid,
    acceptedAt: "2026-11-06T01:00:00.000Z",
    pollAttempts: 2,
    lastCheckedAt: "2026-11-06T01:00:15.000Z",
    result: null,
  });
  check(v3.acceptedAt === "2026-11-06T01:00:00.000Z" && v3.pollAttempts === 2, "v3 acceptedAt and pollAttempts");
  check(v3.lastCheckedAt === "2026-11-06T01:00:15.000Z" && v3.result === null, "v3 lastCheckedAt without result");
  const acceptedLegacy = migrateExecutionRequest(sample.id, {
    ...held,
    status: "受付済み",
    requestId: sampleUuid,
    updatedAt: "2026-11-06T02:00:00.000Z",
  });
  check(acceptedLegacy.status === "受付済み" && acceptedLegacy.acceptedAt === "2026-11-06T02:00:00.000Z", "v2 accepted uses updatedAt");
  const bareSuccess = migrateExecutionRequest(sample.id, {
    ...held,
    status: "成功",
    requestId: sampleUuid,
    acceptedAt: "2026-11-06T01:00:00.000Z",
  });
  check(bareSuccess.status === "処理中" && bareSuccess.result === null, "terminal without result returns to 処理中");
  const badResult = migrateExecutionRequest(sample.id, {
    ...held,
    status: "成功",
    requestId: sampleUuid,
    acceptedAt: "2026-11-06T01:00:00.000Z",
    result: { status: "success", finishedAt: "yesterday", message: "x" },
  });
  check(badResult === null, "invalid result dropped");
  const mismatchedResult = migrateExecutionRequest(sample.id, {
    ...held,
    status: "成功",
    requestId: sampleUuid,
    acceptedAt: "2026-11-06T01:00:00.000Z",
    result: { status: "noop", finishedAt: "2026-11-06T01:00:00.000Z", message: "変更なし。" },
  });
  check(mismatchedResult === null, "status and result label must match");
  const failedHeld = {
    ...held,
    status: "失敗",
    requestId: sampleUuid,
    result: { status: "failed", finishedAt: "2026-11-06T01:00:00.000Z", message: "失敗しました。" },
  };
  check(migrateExecutionRequest(sample.id, failedHeld).status === "失敗", "failed with result kept");
  check(resolveRequestId(failedHeld, failedHeld.memoLines, () => "new-id") === "new-id", "failure gets a new id");
  const noopHeld = {
    ...held,
    status: "変更なし",
    requestId: sampleUuid,
    result: { status: "noop", finishedAt: "2026-11-06T01:00:00.000Z", message: "変更はありませんでした。" },
  };
  check(resolveRequestId(noopHeld, noopHeld.memoLines, () => "new-id") === sampleUuid, "noop keeps id");
  const payload = buildGasPayload({ ...held, requestId: "req-1" });
  check(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(["memoLines", "requestId", "savedAt", "slackThread", "transactionId"]), "payload keys");
  check(!("amount" in payload) && !("merchant" in payload) && !("memo" in payload), "payload omits amount, merchant, and joined memo");
  check(payload.memoLines.length === 5 && payload.memoLines[0].startsWith("用途："), "payload memo lines");
  check(payload.savedAt === "2026-11-06T00:00:00.000Z", "payload savedAt");
  check(normalizeGasUrl("") === "" && normalizeGasUrl("javascript:alert(1)") === "", "blank url stays unset");
  check(normalizeGasUrl("http://127.0.0.1:9/mock-gas") === "http://127.0.0.1:9/mock-gas", "local test url");

  const calls = [];
  await postGasPayload("http://127.0.0.1:9/mock-gas", payload, async (url, init) => {
    calls.push({ url, init });
    check(!String(url).includes("AKfycbw"), "unit test does not call the live reception url");
    return { ok: true, text: async () => JSON.stringify({ ok: true, requestId: payload.requestId }) };
  });
  check(calls[0].init.method === "POST", "post method");
  check(calls[0].init.headers["Content-Type"] === "application/x-www-form-urlencoded", "form content type");
  const encoded = new URLSearchParams(calls[0].init.body);
  const decoded = JSON.parse(encoded.get("payload"));
  check(JSON.stringify(decoded.memoLines) === JSON.stringify(payload.memoLines), "form payload memo lines");
  check(decoded.savedAt === payload.savedAt, "form payload savedAt");
  check(calls[0].init.credentials === "omit", "no credentials");
  check(!calls[0].init.headers.Authorization && !calls[0].init.headers["X-Api-Key"], "no secret headers");
  let abnormal = false;
  try {
    await postGasPayload("https://script.google.com/macros/s/abc/exec", payload, async () => ({
      ok: true,
      text: async () => "<html>nope</html>",
    }));
  } catch {
    abnormal = true;
  }
  check(abnormal, "html response is an error");
  abnormal = false;
  try {
    await postGasPayload("https://script.google.com/macros/s/abc/exec", payload, async () => ({
      ok: true,
      text: async () => JSON.stringify({ ok: false }),
    }));
  } catch {
    abnormal = true;
  }
  check(abnormal, "ok false is an error");
  abnormal = false;
  try {
    await postGasPayload("https://script.google.com/macros/s/abc/exec", payload, async () => ({
      ok: false,
      text: async () => JSON.stringify({ ok: true, requestId: payload.requestId }),
    }));
  } catch {
    abnormal = true;
  }
  check(abnormal, "http error is an error");
  abnormal = false;
  try {
    await postGasPayload("", payload, async () => { throw new Error("should not send"); });
  } catch (error) {
    abnormal = error.message === "unconfigured";
  }
  check(abnormal, "unset url does not send");
}

async function browserChecks(base) {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on("pageerror", (error) => consoleErrors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) consoleErrors.push(message.text());
    });
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() >= 400 && !url.endsWith("/favicon.ico")) consoleErrors.push(`${response.status()} ${url}`);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("script.google.com") || url.includes("AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ")) {
        failures.push(`live reception url was contacted: ${request.method()} ${url}`);
      }
    });
    await browser.defaultBrowserContext().overridePermissions(base, ["clipboard-read", "clipboard-write"]);
    await page.setViewport({ width: 1280, height: 900 });
    const network = [];
    page.on("request", (request) => network.push(request.url()));
    await page.goto(base, { waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    check(consoleErrors.filter((entry) => !entry.includes("favicon.ico")).length === 0, `console errors ${consoleErrors.join(" | ")}`);

    const title = await page.title();
    check(title === "UPSIDERモニター", `title ${title}`);
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const phrase of [
      "AIハンド決済用カードのUPSIDERチェック結果ダッシュボード。チェック実行のたびに更新します。",
      "最新データ確認 2026-11-27 09:35 JST（ブラウザで#bo_upsiderを読んだ時刻）。",
      "09:25以降、AIハンド決済用（柴田 善広）の新規カードは検索で見つからなかった。",
      "Slack検索で「決済メモを追加しました！」は0件。",
      "チャンネル表示が11/21以降を読み込まなかったため、既存スレッドの返信は全件を開いて確認できておらず未確認。",
      "出荷済（11/25出荷、ヤマト504506485652、全数）・納入待ち。",
      "一部納入（コンテナFCLD50-GR/C×3・台車×1は納品書受領、フタ×2は12/02出荷予定）。",
      "出荷済（11/24ツルガ出荷明細書受領・納入未確認）。",
      "3件ともDrive証憑はなし（納品書・出荷明細書は会計上の証憑ではない）。",
      "添付もメモ登録もしていない。",
      "AIハンド決済用スレッドに2026-11-24 09:15 JST以降の「決済メモを追加しました！」も「領収証を添付しました」もない。",
      "新規の対象取引はなし。",
      "MonotaRO ¥18,678（tx-20261113-0053-monotaro-18678、スレッド1794498836.125669、台帳TX-20261113-MNT-001）は証憑なしから登録完了。",
      "ANTHROPIC* CLAUDE SUB ¥35,892",
      "Amazon ¥5,003・¥49,704、ウィルコ ¥20,900、MonotaRO ¥2,198・¥1,868の証憑をDriveへ保存済みのため「証憑保存済・Slack未添付」に更新（Slack未添付・メモ未登録）。",
      "MonotaRO ¥439・¥3,953とAmazon ¥3,080の証憑を2026-11-17 09:12〜09:15 JSTにスレッドへ本文なしで添付し、3件ともUPSIDER「領収証を添付しました」を確認。",
      "今回のチェック（11/27 09:35）",
      "前回のチェック（11/26 09:25）",
      "前回のチェック（11/25 15:30）",
      "前回のチェック（11/25 09:11）",
      "前回のチェック（11/24 09:15）",
      "前回のチェック（11/23 09:24）",
      "前回のチェック（11/22 09:14）",
      "前回のチェック（11/21 09:13）",
      "前回のチェック（11/20 09:20）",
      "前回のチェック（11/19 09:20）",
    "前回のチェック（11/18 13:40）",
      "前回のチェック（11/18 09:12）",
      "前回のチェック（11/17 18:09）",
      "前回のチェック（11/17 09:18）",
      "前回のチェック（11/16 16:30）",
      "前回のチェック（11/16 09:16）",
      "20261115_9000JPY_日本ロボット学会_領収書.pdf",
      "一般社団法人日本ロボット学会",
      "既存の要処理8件（Amazon ¥0、Amazon ¥2,399、MonotaRO ¥18,678、MonotaRO ¥1,318、MonotaRO ¥439、MonotaRO ¥3,953、ウィルコ ¥20,900、ミスミ ¥3,267）はスレッドに返信がなく、メモ完了通知も領収証添付通知もない。",
      "確認決済（¥0、本決済¥2,399は別行）にした。行は削除していない。",
      "前回のチェック（11/16 00:02）",
      "前回のチェック（11/15 22:45）",
      "Slackブラウザ確認 11/16 00:02、15件のスレッド確認、メモ登録済3件（EVENT PAY ¥9,000・Amazon ¥2,399・MonotaRO ¥18,678）、領収証添付なし、新規カードなし",
      "前回のチェック（11/14 09:20）",
      "前回のチェック（11/13 19:30）",
      "前回のチェック（11/13 09:21）",
      "前回のチェック（11/12 09:20）",
      "前回のチェック（11/11 18:47）",
      "前回のチェック（11/11 09:34）",
      "前回のチェック（11/10 13:40）",
      "前回のチェック（11/10 09:06）",
      "前回のチェック（11/09 22:55）",
      "前回のチェック（11/09 22:25）",
      "前回のチェック（11/09 16:25）",
      "伝票番号123402・123403、出荷日2026-11-06、税込15,470円＋1,144円＝16,614円",
      "前回のチェック（11/09 15:59）",
      "前回のチェック（11/09 15:31）",
      "前回のチェック（11/09 09:26）",
      "前回のチェック（11/08 AM9）",
      "前回のチェック（11/07 AM9）",
      "返信数は前回値を保持していないため、前回との増減は比較できない。",
      "今回証憑の有効性を再検証したとは扱わない。",
      "PNG形式であることだけを理由に画像証憑を一般に無効とはしない。",
      "既存の要処理8件との差は、返金元¥23,960を要処理に入れていたことである。",
      "2026-11-07 23:30:30 JST",
      "新規のAIハンド決済用取引なし（会社名義・SaaSカードのDOCUSIGN INCは対象外）。未完了8件をSlackブラウザで再確認し、いずれもUPSIDERアプリの「決済メモを追加しました！」を確認。ステータス変更なし。MonotaRO ¥17,553・¥4,833とミスミ ¥16,614の正式領収証はDrive保存済だが、共有チャンネル制限でSlack未添付のため再送していない。スレッド上のPNGスクショは会計証憑に数えない。秋月電子 ¥2,600、日進ゴム ¥17,600、アースダンボール／DANBALLACE の¥23,960・¥5,570・¥7,160は有効な領収書・請求書なし。DANBALLACE ¥7,160は11/08 00:59（Slack表示）にも完了通知を再確認。出荷予定11/13・納入予定11/16。",
      "正式領収証3件の添付をユーザー確認後に試行しましたが、共有チャンネル制限で停止。登録完了に変更していません。追加送信なし。",
      "注文AB256FB3F5・16,614円（税1,510円）の正式領収書を保存確認。モノタロウ2件も保持。Slack未添付のため登録完了ではない。納入は配送中・11/9予定。",
      "UPSIDER完了通知のみでメモあり。5項目本文不要。",
      "最終取得日時",
      "2026-11-27 09:35（日本時間）",
      "成功3件／未完了0件",
      "ユーザーが3件とも手動で添付した。UPSIDERの「領収証を添付しました」を確認し、登録完了にした。",
      "証憑PDF取得成功",
      "2026-11-27 09:33（日本時間）",
      "ブラウザで#bo_upsiderを読み取り確認した時刻（2026-11-27 09:35 JST）。画面を更新した時刻やページを開いた時刻ではない。領収証PDF1件と適格請求書PDF1件を本文なしで添付し、UPSIDER「領収証を添付しました」を確認した。メモ登録はしていない。",
      "UPSIDERが2026-11-09 16:02:41 JSTに「領収証を添付しました」と通知した。",
      "本人以外の課金（USD 2.42、シバタさん回答 2026-11-10）",
      "本人以外の課金（USD 4.83、シバタさん回答 2026-11-10）",
      "本人以外の課金（USD 0.29、シバタさん回答 2026-11-10 13:41）",
      "各取引詳細にメモ入力欄（用途・セグメント1・セグメント2・分類・内容）と「クリップボードにコピー」を設置しています。コピーすると改行付きで5行が入ります。ページ内の注文スクショは参照用で、UPSIDER側の証憑添付ではありません。新規で取引と根拠が確定したものは、#bo_upsider の該当取引スレッドに確認済み5項目メモと金額の一致した有効証憑PDFを登録します。用途やセグメントが未確定のものは確認するまで登録しません。",
      "DANBALLACE返金 -¥23,960 を追加。Amazon 4件（¥14,680・¥9,300・¥2,117・¥255）を本文なしPDF添付で登録完了。DANBALLACE ¥7,160 はメモ・証憑なし。",
      "新規取引なし。Slack再確認でメモ登録が進んでいたため、MonotaRO ¥17,553・¥4,833・日進ゴム ¥17,600 は「証憑なし」に更新（会計上有効な領収書・請求書は未取得。納品書・注文確認書・スクショは対象外）。Amazon ¥2,659 は適格請求書PDFを本文なしで新規添付し登録完了。Amazon ¥2,117 はスレッドに適格請求書PDFが既にあったため再添付なし。Driveに新たに添付可能な有効証憑は上記以外なし。メモ作成は停止中。",
      "要対応の取引です。Slackスレッドの下にメモ入力欄があり、スクショがある場合はその上に並びます。",
      "スクショはチャット／ページ参照用であり、UPSIDER証憑ではない。このページは使い捨てではなく、毎回のチェック結果で更新するダッシュボードです。",
    ]) {
      check(bodyText.includes(phrase), `missing phrase: ${phrase}`);
    }
    const layout = await page.evaluate(() => [...document.querySelector("#app").children].map((node) => {
      const heading = node.querySelector(":scope > h1, :scope > h2, :scope > strong");
      if (heading) return heading.textContent;
      if (node.matches("[data-ops-memo]")) return "運用メモ";
      return node.getAttribute("data-attachment-result") !== null ? "今回の添付結果" : node.tagName;
    }));
    const logLeads = ledger.callouts.filter((item) => item.lead !== "運用メモ").map((item) => item.lead);
    const opsAt = layout.indexOf("運用メモ");
    const firstLogAt = layout.indexOf(logLeads[0]);
    check(opsAt !== -1 && layout.indexOf("運用メモ") === layout.lastIndexOf("運用メモ"), "運用メモ is rendered once");
    check(layout.indexOf("取引一覧") !== -1 && layout.indexOf("取引一覧") < opsAt, "運用メモ follows the ledger table");
    check(layout.indexOf("集計") !== -1 && layout.indexOf("集計") < opsAt, "運用メモ follows the aggregation");
    check(layout.indexOf("注意") !== -1 && layout.indexOf("注意") < opsAt, "運用メモ follows the caution");
    check(firstLogAt === opsAt + 1, `check logs follow 運用メモ: ${layout.join(" / ")}`);
    check(layout.lastIndexOf(logLeads[logLeads.length - 1]) === layout.length - 1, `check logs end the page: ${layout.join(" / ")}`);
    check(logLeads.every((lead, index) => layout.indexOf(lead) === firstLogAt + index), `check logs newest first: ${layout.join(" / ")}`);
    const controlOrder = await page.evaluate(() => {
      const root = document.querySelector("#app");
      const nodes = [
        ["instruction", document.querySelector("[data-instruction]")],
        ["action", document.querySelector("[data-action-count]")],
        ["filters", document.querySelector(".filters")],
        ["table", document.querySelector(".tx-table")],
        ["caution", document.querySelector(".caution")],
        ["ops", document.querySelector("[data-ops-memo]")],
        ["firstLog", document.querySelector("[data-check-log]")],
      ];
      const missing = nodes.filter(([, node]) => !node).map(([name]) => name);
      let inOrder = missing.length === 0;
      for (let index = 1; index < nodes.length; index += 1) {
        const previous = nodes[index - 1][1];
        const current = nodes[index][1];
        if (!previous || !current) continue;
        if ((previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING) === 0) inOrder = false;
      }
      const logs = [...document.querySelectorAll("[data-check-log]")];
      return {
        missing,
        inOrder,
        leads: logs.map((node) => node.querySelector("strong")?.textContent || ""),
        lastIsLog: Boolean(root.lastElementChild && root.lastElementChild.matches("[data-check-log]")),
        logsBeforeTable: logs.some((node) => (node.compareDocumentPosition(document.querySelector(".tx-table")) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0),
      };
    });
    check(controlOrder.missing.length === 0 && controlOrder.inOrder && !controlOrder.logsBeforeTable, `controls before logs ${JSON.stringify(controlOrder)}`);
    check(controlOrder.lastIsLog && JSON.stringify(controlOrder.leads) === JSON.stringify(logLeads), `rendered log order ${controlOrder.leads.join(" / ")}`);
    const opsText = await page.$eval("[data-ops-memo]", (node) => ({
      lead: node.querySelector("strong")?.textContent || "",
      body: node.querySelector("p")?.textContent || "",
    }));
    const opsSource = ledger.callouts.find((item) => item.lead === "運用メモ");
    check(opsText.lead === opsSource.lead && opsText.body === opsSource.body, "ops memo content unchanged");
    const pageSourceText = await page.evaluate(() => document.body.textContent);
    for (const url of Object.values(EVIDENCE_URLS)) {
      check(pageSourceText.includes(url), `page missing evidence url ${url}`);
    }

    const rows = await page.$$eval("[data-tx-id]", (nodes) => nodes.map((node) => ({
      id: node.dataset.txId,
      cells: [...node.querySelectorAll("td")].map((td) => ({
        label: td.dataset.label,
        text: td.dataset.label === "Slack"
          ? td.querySelector("a")?.href || ""
          : td.dataset.label === "Drive証憑"
            ? (td.querySelector("a")?.textContent || td.textContent).trim()
            : td.innerText.trim(),
        href: td.querySelector("a")?.href || "",
        target: td.querySelector("a")?.target || "",
        rel: td.querySelector("a")?.rel || "",
      })),
    })));
    check(rows.length === 67, `visible rows ${rows.length}`);
    rows.forEach((row, index) => {
      const tx = ledger.transactions[index];
      const byLabel = Object.fromEntries(row.cells.map((cell) => [cell.label, cell]));
      check(row.id === tx.id, `row id ${row.id}`);
      check(byLabel["日時"].text === tx.datetime, `datetime ${tx.id}`);
      check(byLabel["利用先"].text === tx.merchant, `merchant ${tx.id}`);
      check(byLabel["金額"].text === tx.amount, `amount ${tx.id}`);
      check(byLabel["内容"].text === tx.content, `content ${tx.id}`);
      check(byLabel["ステータス"].text === tx.status, `status ${tx.id}`);
      check(byLabel["メモ"].text.startsWith(tx.memoStatus), `memo status ${tx.id} ${byLabel["メモ"].text}`);
      if (tx.memoStatus === "あり") {
        check(byLabel["メモ"].text.includes(`完了通知${tx.memoEvidence.length}件`), `memo evidence ${tx.id}`);
      } else {
        check(!byLabel["メモ"].text.includes("完了通知"), `no invented notice ${tx.id}`);
      }
      check(byLabel["Drive証憑"].text === tx.drive, `drive ${tx.id}`);
      if (tx.drive.startsWith("https://")) {
        check(byLabel["Drive証憑"].href === tx.drive, `drive href ${tx.id} ${byLabel["Drive証憑"].href}`);
        check(byLabel["Drive証憑"].target === "_blank", `drive target ${tx.id}`);
        check(byLabel["Drive証憑"].rel.includes("noopener"), `drive rel ${tx.id}`);
      } else {
        check(byLabel["Drive証憑"].href === "", `drive should be plain text ${tx.id}`);
      }
      check(byLabel.Slack.text === tx.slack, `slack ${tx.id} ${byLabel.Slack.text}`);
      check(byLabel.Slack.target === "_blank", `slack target ${tx.id}`);
      check(byLabel.Slack.rel.includes("noopener"), `slack rel ${tx.id}`);
      const rejected = tx.slackAttachmentError === "mcp_externally_shared_channel_restricted";
      check(byLabel["備考"].text === (rejected ? "添付試行済み・共有制限で未添付。連携経由の添付が共有制限で拒否された。" : ""), `remark ${tx.id} ${byLabel["備考"].text}`);
    });

    const aggHead = await page.$$eval(".agg-table th", (nodes) => nodes.map((node) => node.textContent));
    check(aggHead.join(",") === "区分,件数,金額", `agg head ${aggHead.join(",")}`);
    const txHead = await page.$$eval(".tx-table th", (nodes) => nodes.map((node) => node.textContent));
    check(txHead.join(",") === "日時,利用先,金額,内容,ステータス,メモ,Slack,Drive証憑,備考", `tx head ${txHead.join(",")}`);
    const acquired = await page.$eval("[data-acquired-value]", (node) => ({
      text: node.textContent,
      datetime: node.getAttribute("datetime"),
    }));
    check(acquired.text === "2026-11-27 09:35（日本時間）", `acquired text ${acquired.text}`);
    check(acquired.datetime === "2026-11-27T09:35:00+09:00", `acquired source ${acquired.datetime}`);
    check(!bodyText.includes("再検証済"), "page does not claim vouchers were revalidated");
    const pdfSaved = await page.$eval("[data-pdf-saved-at]", (node) => node.innerText);
    check(pdfSaved.includes("2026-11-27 09:33（日本時間）") && !pdfSaved.includes("23:30:30"), `pdf time ${pdfSaved}`);
    const attachmentText = await page.$eval("[data-attachment-result]", (node) => node.innerText);
    check(attachmentText.includes("ユーザーが3件とも手動で添付した。UPSIDERの「領収証を添付しました」を確認し、登録完了にした。"), attachmentText);
    check(attachmentText.includes("成功3件／未完了0件"), attachmentText);
    check(attachmentText.includes("確認時刻 2026-11-09 15:31 JST"), attachmentText);
    check(!attachmentText.includes("連携経由の添付が共有制限で拒否された。"), attachmentText);
    check(!attachmentText.includes("登録完了にはしていません"), attachmentText);
    check(!attachmentText.includes("投稿不能") && !attachmentText.includes("再試行") && !attachmentText.includes("復旧"), attachmentText);
    check(await page.$("[data-attachment-result] button") === null, "attachment result has no button");
    check((await page.$$("[data-unattached]")).length === 0, "unattached cards are gone");
    const actionLine = await page.$eval("[data-action-count]", (node) => node.textContent);
    check(actionLine === "要処理 39件。登録完了22件。除外6件（返金2件、本人以外の課金4件）は含めません。", actionLine);
    check(!bodyText.includes("トークン使用量"), "token heading removed");
    check(await page.$("[data-token-usage]") === null && await page.$("[data-token-field]") === null, "token fields removed");
    const instruction = await page.$eval("[data-instruction]", (node) => ({
      rows: node.getAttribute("rows"),
      labelled: document.querySelector("label[for='instruction-text']")?.textContent || "",
      overflow: getComputedStyle(node).overflowY,
      height: node.clientHeight,
    }));
    check(instruction.rows === "4" && instruction.labelled === "手元のメモ", `instruction box ${JSON.stringify(instruction)}`);
    check(instruction.overflow === "auto" || instruction.overflow === "scroll", `instruction overflow ${instruction.overflow}`);
    const tall = await page.$eval("[data-instruction]", (node) => {
      const before = node.clientHeight;
      node.value = Array.from({ length: 20 }, (_, index) => `指示${index}`).join("\n");
      return { before, client: node.clientHeight, scroll: node.scrollHeight };
    });
    check(tall.client === tall.before && tall.scroll > tall.client, `instruction stays four lines ${JSON.stringify(tall)}`);
    const beforeRequests = network.length;
    await page.focus("[data-instruction]");
    await page.keyboard.type("あいうえお");
    await page.keyboard.press("Enter");
    await page.keyboard.type("かきくけこ");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const instructionValue = await page.$eval("[data-instruction]", (node) => node.value);
    check(instructionValue.includes("あいうえお\nかきくけこ"), `instruction input ${JSON.stringify(instructionValue)}`);
    const sent = network.slice(beforeRequests).filter((url) => /mock-gas|script\.google|slack\.com\/api|hooks\.slack/.test(url));
    check(sent.length === 0, `instruction typed without send ${sent.join(",")}`);
    const limitNote = await page.$eval("[data-instruction-status]", (node) => node.textContent);
    check(limitNote.includes("送信しません") && !limitNote.includes("指示を送る"), limitNote);
    check(await page.$("[data-instruction-send]") === null, "instruction send button is gone");
    check((await page.$eval("[data-local-only]", (node) => node.textContent)).includes("API・MCP・Webhook等の連携機能は使用しません。"), "policy visible");
    const stillUnsent = network.slice(beforeRequests).filter((url) => /mock-gas|script\.google|slack\.com\/api|hooks\.slack|op=result/.test(url));
    check(stillUnsent.length === 0, `local note stayed local ${stillUnsent.join(",")}`);
    const leaked = await page.evaluate(() => document.body.innerText.includes("[object HTML"));
    check(!leaked, "object string leaked into the page");
    const agg = await page.$$eval(".agg-table tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    check(agg[0][0] === "すべて" && agg[0][1] === "67" && agg[0][2] === "¥1,333,233", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "登録完了")?.[1] === "22" && agg.find((row) => row[0] === "登録完了")?.[2] === "¥226,563", "agg 登録完了");
    check(agg.find((row) => row[0] === REFUND_STATUS)?.[1] === "2" && agg.find((row) => row[0] === REFUND_STATUS)?.[2] === "¥0", "agg refund");
    check(agg.find((row) => row[0] === "メモなし")?.[1] === "23" && agg.find((row) => row[0] === "メモなし")?.[2] === "¥902,050", "agg メモなし");
    check(agg.find((row) => row[0] === "証憑なし")?.[1] === "1" && agg.find((row) => row[0] === "証憑なし")?.[2] === "¥2,399", "agg 証憑なし");
    check(agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[1] === "0" && agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[2] === "¥0", "agg saved receipts");
    check(agg.find((row) => row[0] === "メモ・証憑なし")?.[1] === "12" && agg.find((row) => row[0] === "メモ・証憑なし")?.[2] === "¥200,977", "agg メモ・証憑なし");
    check(agg.find((row) => row[0] === NOT_OWNER_STATUS)?.[1] === "3" && agg.find((row) => row[0] === NOT_OWNER_STATUS)?.[2] === "¥1,222", "agg not-owner");
    check(agg.find((row) => row[0] === NOT_OWNER_STATUS_20261111)?.[1] === "1" && agg.find((row) => row[0] === NOT_OWNER_STATUS_20261111)?.[2] === "¥22", "agg github 22");
    const savedTone = await page.$eval("[data-tx-id='tx-20261105-1253-monotaro-17553'] [data-label='ステータス'] .status", (node) => node.className);
    check(savedTone.includes("success") && !savedTone.includes("warning"), `registered tone ${savedTone}`);
    check(agg.find((row) => row[0] === "証憑不一致")?.[1] === "0" && agg.find((row) => row[0] === "証憑不一致")?.[2] === "¥0", "agg zero mismatch");

    for (const filter of FILTERS) {
      await page.click(`[data-filter="${filter}"]`);
      const pressed = await page.$eval(`[data-filter="${filter}"]`, (button) => button.getAttribute("aria-pressed"));
      check(pressed === "true", `${filter} pressed`);
      const ids = await page.$$eval("[data-tx-id]", (nodes) => nodes.map((node) => node.dataset.txId));
      const expected = filterTransactions(ledger.transactions, filter).map((tx) => tx.id);
      check(JSON.stringify(ids) === JSON.stringify(expected), `filter ${filter}: ${ids.join(",")}`);
      const memoIds = await page.$$eval("[data-memo-row]", (nodes) => nodes.map((node) => node.dataset.memoRow));
      check(JSON.stringify(memoIds) === JSON.stringify(expected), `memo rows follow ${filter}`);
      const emptyHidden = await page.$eval("[data-empty]", (node) => node.hidden);
      check(emptyHidden === (expected.length !== 0), `empty state ${filter}`);
    }
    await page.click('[data-filter="すべて"]');

    const memoRows = await page.$$eval("[data-memo-row]", (nodes) => nodes.map((node) => {
      const details = node.querySelector("details");
      const inputs = [...node.querySelectorAll("[data-memo-field]")];
      const summary = node.querySelector("summary");
      const summaryBox = summary ? summary.getBoundingClientRect() : { width: 0, height: 0 };
      return {
        id: node.dataset.memoRow,
        attachedTo: node.previousElementSibling?.dataset.txId || "",
        summary: summary?.textContent || "",
        summaryVisible: summaryBox.width > 0 && summaryBox.height > 0,
        open: Boolean(details?.open),
        fields: Object.fromEntries(inputs.map((input) => [input.dataset.memoField, input.value])),
        editable: inputs.length === 5 && inputs.every((input) => !input.disabled && !input.readOnly && input.type === "text"),
        copy: node.querySelector("[data-copy]")?.textContent || "",
        reset: node.querySelector("[data-memo-reset]")?.textContent || "",
        slackLinks: node.querySelectorAll("a[href*='slack']").length,
      };
    }));
    check(memoRows.length === ledger.transactions.length, `memo rows ${memoRows.length}`);
    const eventDrive = rows.find((row) => row.id === "tx-20261115-2140-eventpay-9000");
    const eventDriveCell = eventDrive && Object.fromEntries(eventDrive.cells.map((cell) => [cell.label, cell]));
    check(eventDriveCell?.["Drive証憑"]?.text === "https://drive.google.com/file/d/1yBHveOx1AUhyLtxk_hLA2whZerfA72S1/view" && eventDriveCell["Drive証憑"].href === "https://drive.google.com/file/d/1yBHveOx1AUhyLtxk_hLA2whZerfA72S1/view", "event pay drive link is visible");
    memoRows.forEach((row, index) => {
      const tx = ledger.transactions[index];
      check(row.id === tx.id && row.attachedTo === tx.id, `memo row attached under ${tx.id}`);
      check(row.summary === "メモ作成" && row.summaryVisible, `memo toggle visible ${tx.id}`);
      check(row.open === false, `memo starts collapsed ${tx.id}`);
      check(row.editable, `five editable fields ${tx.id}`);
      check(row.copy === "クリップボードにコピー" && row.reset === "初期値に戻す", `memo actions ${tx.id}`);
      check(row.slackLinks === 0, `memo row does not add a slack link ${tx.id}`);
      check(JSON.stringify(row.fields) === JSON.stringify(memoDefaults(tx)), `memo defaults ${tx.id} ${JSON.stringify(row.fields)}`);
    });
    const freshId = "tx-20261115-2123-amazon-3080";
    const freshTx = ledger.transactions.find((tx) => tx.id === freshId);
    await page.$eval(`[data-memo-row="${freshId}"] details`, (node) => { node.open = true; });
    for (const [field, value] of [["purpose", "図書"], ["seg1", "AIハンド"], ["seg2", "その他"], ["category", "図書"], ["content", "口紅から機関車まで"]]) {
      await page.$eval(`[data-memo-row="${freshId}"] [data-memo-field="${field}"]`, (input, next) => {
        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    }
    const freshMemo = { purpose: "図書", seg1: "AIハンド", seg2: "その他", category: "図書", content: "口紅から機関車まで" };
    await page.click(`[data-memo-row="${freshId}"] [data-copy]`);
    await page.waitForFunction((expected) => navigator.clipboard.readText().then((text) => text === expected).catch(() => false), { timeout: 5000 }, formatMemoText(freshMemo));
    const freshStored = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), MEMO_STORAGE_KEY));
    check(freshStored.version === 1 && freshStored.memos[freshId].purpose === "図書" && freshStored.memos[freshId].seg1 === "AIハンド" && freshStored.memos[freshId].seg2 === "その他" && freshStored.memos[freshId].category === "図書" && freshStored.memos[freshId].content === "口紅から機関車まで" && !JSON.stringify(freshStored).includes("token"), "new row memo copy is stored locally");
    await page.click(`[data-memo-row="${freshId}"] [data-memo-reset]`);
    const freshReset = await page.$$eval(`[data-memo-row="${freshId}"] [data-memo-field]`, (nodes) => nodes.map((input) => input.value));
    check(JSON.stringify(freshReset) === JSON.stringify(["purpose", "seg1", "seg2", "category", "content"].map((field) => freshTx.memoDefault[field])), `new row reset ${freshReset.join("|")}`);
    const memoId = "tx-20261111-1404-monotaro-30017";
    const memoTx = ledger.transactions.find((tx) => tx.id === memoId);
    await page.$eval(`[data-memo-row="${memoId}"] details`, (node) => { node.open = true; });
    const copyVisible = await page.$eval(`[data-memo-row="${memoId}"] [data-copy]`, (node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    check(copyVisible, "opened memo copy button is visible in the table");
    await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="purpose"]`, (input) => {
      input.value = "折りたたみコンテナの追記";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="content"]`, (input) => {
      input.value = "台車を含む";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const beforeMemoNet = network.length;
    await page.click(`[data-memo-row="${memoId}"] [data-copy]`);
    const editedMemo = memoDefaults(memoTx);
    editedMemo.purpose = "折りたたみコンテナの追記";
    editedMemo.content = "台車を含む";
    await page.waitForFunction((expected) => navigator.clipboard.readText().then((text) => text === expected).catch(() => false), { timeout: 5000 }, formatMemoText(editedMemo));
    const memoCalls = network.slice(beforeMemoNet).filter((url) => /mock-gas|script\.google|slack\.com\/api|hooks\.slack|op=result/.test(url));
    check(memoCalls.length === 0, `memo copy stays local ${memoCalls.join(",")}`);
    const storedMemo = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), MEMO_STORAGE_KEY));
    check(storedMemo.version === 1 && storedMemo.memos[memoId].purpose === "折りたたみコンテナの追記" && storedMemo.memos[memoId].content === "台車を含む", "draft stored by transaction id");
    check(!JSON.stringify(storedMemo).includes("token"), "stored memo has no token");
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    const persistedPurpose = await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="purpose"]`, (input) => input.value);
    const persistedContent = await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="content"]`, (input) => input.value);
    check(persistedPurpose === "折りたたみコンテナの追記" && persistedContent === "台車を含む", `memo survives reload ${persistedPurpose}`);
    await page.$eval(`[data-memo-row="${memoId}"] details`, (node) => { node.open = true; });
    await page.click(`[data-memo-row="${memoId}"] [data-memo-reset]`);
    const resetPurpose = await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="purpose"]`, (input) => input.value);
    check(resetPurpose === "AIハンド製造ライン用資材収納用品購入" && resetPurpose === memoTx.memoDefault.purpose, `reset restores the stored purpose ${resetPurpose}`);
    const cleared = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), MEMO_STORAGE_KEY));
    check(cleared.memos[memoId] === undefined, "reset removes the stored draft");
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    const afterResetReload = await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="purpose"]`, (input) => input.value);
    check(afterResetReload === "AIハンド製造ライン用資材収納用品購入" && afterResetReload === memoTx.memoDefault.purpose, "reset value remains after reload");

    const details = await page.$$eval("[data-detail]", (cards) => cards.map((card) => {
      const image = card.querySelector("img");
      const memo = card.querySelector(".memo");
      return {
        id: card.dataset.detail,
        heading: card.querySelector("h2").textContent,
        intro: card.querySelector(".detail-intro").textContent,
        labels: [...card.querySelectorAll(".props dt")].map((dt) => dt.textContent),
        values: [...card.querySelectorAll(".props dd")].map((dd) => dd.innerText.trim()),
        fields: Object.fromEntries([...card.querySelectorAll("[data-memo-field]")].map((input) => [input.dataset.memoField, input.value])),
        imageSrc: image ? image.getAttribute("src") : null,
        imageAlt: image ? image.alt : null,
        imageNote: card.querySelector(".shot-note")?.textContent || "",
        imageBeforeMemo: image ? Boolean(image.compareDocumentPosition(memo) & Node.DOCUMENT_POSITION_FOLLOWING) : true,
        slackTarget: card.querySelector(".props a")?.target || "",
        ai: card.querySelector("[data-ai]")?.textContent || "",
        copy: card.querySelector("[data-copy]")?.textContent || "",
        note: card.querySelector(".exec-note")?.textContent || "",
      };
    }));
    check(details.length === 0, `details ${details.length}`);
    for (const detail of ledger.details) {
      const found = details.find((card) => card.id === detail.transactionId);
      const tx = ledger.transactions.find((row) => row.id === detail.transactionId);
      check(Boolean(found), `detail missing ${detail.transactionId}`);
      if (!found) continue;
      check(found.heading === detail.heading, `heading ${detail.transactionId}`);
      check(found.intro === detail.intro, `intro ${detail.transactionId}`);
      check(JSON.stringify(found.labels) === JSON.stringify(detail.properties.map((item) => item.label)), `labels ${detail.transactionId}`);
      check(JSON.stringify(found.values) === JSON.stringify(detail.properties.map((item) => item.value)), `values ${detail.transactionId} ${found.values}`);
      const expectedMemo = memoDefaults(tx);
      check(found.fields.purpose === expectedMemo.purpose, `purpose ${tx.id}`);
      check(found.fields.seg1 === expectedMemo.seg1 && expectedMemo.seg1 === "AIハンド", `seg1 ${tx.id}`);
      check(found.fields.seg2 === expectedMemo.seg2, `seg2 ${tx.id}`);
      check(found.fields.category === expectedMemo.category, `category ${tx.id}`);
      check(found.fields.content === expectedMemo.content, `memo content ${tx.id}`);
      check(found.slackTarget === "_blank", `detail slack target ${tx.id}`);
      check(found.copy === "クリップボードにコピー", "copy label");
      check(found.ai === "", "memo send button is gone");
      check(found.note.includes("送信しません"), "memo note does not offer sending");
      check(found.imageBeforeMemo === true, `image above memo ${tx.id}`);
      if (detail.image) {
        check(found.imageSrc === detail.image.src, `image src ${tx.id}`);
        check(found.imageAlt === detail.image.alt, `image alt ${tx.id}`);
        if (detail.image.readable) check(found.imageNote === "", `readable image note ${tx.id}`);
        else check(found.imageNote.includes("再生成はしていません"), `damaged note ${tx.id}`);
      } else {
        check(found.imageSrc === null, `no image ${tx.id}`);
      }
    }

    const loaded = await page.evaluate(() => Promise.all([...document.images].map(async (img) => {
      try {
        await img.decode();
        return { src: img.getAttribute("src"), width: img.naturalWidth, height: img.naturalHeight };
      } catch (error) {
        return { src: img.getAttribute("src"), error: String(error) };
      }
    })));
    check(loaded.length === ledger.details.filter((detail) => detail.image).length, `image count ${loaded.length}`);
    check(loaded.length === 0, "open detail has no screenshot");
    check(loaded.every((img) => img.width > 0 && !img.error), `images decoded ${JSON.stringify(loaded)}`);

    gas.interactionDetail = true;
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(`[data-detail="${NEW_ORDER_ID}"] [data-copy]`);
    const copyId = NEW_ORDER_ID;
    const copyTx = ledger.transactions.find((tx) => tx.id === copyId);
    const expectedCopy = formatMemoText(memoDefaults(copyTx));
    check(expectedCopy === [
      "用途：YUBI梱包用ダンボール購入",
      "セグメント1：AIハンド",
      "セグメント2：プロダクト販売",
      "分類：消耗品",
      "内容：梱包用ダンボール80サイズ 50枚",
    ].join("\n"), `detail copy uses the stored memo ${expectedCopy}`);
    await page.click(`[data-detail="${copyId}"] [data-copy]`);
    await page.waitForFunction((id) => {
      const node = document.querySelector(`[data-detail="${id}"] [data-copy-status]`);
      return node && !node.hidden && node.textContent === "コピーしました";
    }, {}, copyId);
    await page.waitForFunction((expected) => navigator.clipboard.readText().then((text) => text === expected).catch(() => false), { timeout: 5000 }, expectedCopy);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const still = await page.$eval(`[data-detail="${copyId}"] [data-copy-status]`, (node) => !node.hidden);
    check(still, "copy status remains before 2 seconds");
    await page.click(`[data-detail="${copyId}"] [data-copy]`);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const resetStill = await page.$eval(`[data-detail="${copyId}"] [data-copy-status]`, (node) => !node.hidden);
    check(resetStill, "copy timer resets");
    await new Promise((resolve) => setTimeout(resolve, 800));
    const hidden = await page.$eval(`[data-detail="${copyId}"] [data-copy-status]`, (node) => node.hidden);
    check(hidden, "copy status hides after 2 seconds");

    await page.$eval(`[data-detail="${copyId}"] [data-memo-field="seg2"]`, (input) => {
      input.value = "試作";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click(`[data-detail="${copyId}"] [data-copy]`);
    await page.waitForFunction((id) => !document.querySelector(`[data-detail="${id}"] [data-copy-status]`).hidden, {}, copyId);
    await page.waitForFunction(() => navigator.clipboard.readText().then((text) => text.includes("セグメント2：試作\n")).catch(() => false), { timeout: 5000 });

    const aiId = NEW_ORDER_ID;
    check(await page.$(`[data-detail="${aiId}"] [data-ai]`) === null, "detail has no memo send button");
    check(await page.$(`[data-detail="${aiId}"] [data-recheck]`) === null, "detail has no recheck button");
    check((await page.$eval(`[data-detail="${aiId}"] .exec-note`, (node) => node.textContent)).includes("送信しません"), "detail note");
    const before = network.length;
    await page.$eval(`[data-detail="${aiId}"] [data-memo-field="purpose"]`, (input) => {
      input.value = "段ボールの追加注文";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const editedRequests = network.slice(before).filter((url) => /mock-gas|script\.google|slack\.com\/api|hooks\.slack|op=result/.test(url));
    check(editedRequests.length === 0, `editing a memo does not call reception ${editedRequests.join(",")}`);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(`[data-detail="${NEW_ORDER_ID}"] [data-copy]`);
    const purposeAfterReload = await page.$eval(`[data-detail="${NEW_ORDER_ID}"] [data-memo-field="purpose"]`, (input) => input.value);
    const rowPurposeAfterReload = await page.$eval(`[data-memo-row="${NEW_ORDER_ID}"] [data-memo-field="purpose"]`, (input) => input.value);
    check(purposeAfterReload === "段ボールの追加注文" && rowPurposeAfterReload === "段ボールの追加注文", `edited memo persists ${purposeAfterReload} / ${rowPurposeAfterReload}`);
    await page.click(`[data-detail="${NEW_ORDER_ID}"] [data-memo-reset]`);
    const purposeAfterReset = await page.$eval(`[data-detail="${NEW_ORDER_ID}"] [data-memo-field="purpose"]`, (input) => input.value);
    const rowSegAfterReset = await page.$eval(`[data-memo-row="${NEW_ORDER_ID}"] [data-memo-field="seg2"]`, (input) => input.value);
    check(purposeAfterReset === "YUBI梱包用ダンボール購入" && rowSegAfterReset === "プロダクト販売", `reset restores both cards ${purposeAfterReset} / ${rowSegAfterReset}`);

    await page.evaluate(() => {
      document.execCommand = () => false;
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
      navigator.clipboard.write = () => Promise.reject(new Error("denied"));
    });
    const fallbackId = NEW_ORDER_ID;
    await page.click(`[data-detail="${fallbackId}"] [data-copy]`);
    await page.waitForSelector(`[data-detail="${fallbackId}"] [data-copy-fallback]:not([hidden])`);
    const fallbackValue = await page.$eval(`[data-detail="${fallbackId}"] [data-copy-fallback-text]`, (node) => node.value);
    const fallbackHiddenStatus = await page.$eval(`[data-detail="${fallbackId}"] [data-copy-status]`, (node) => node.hidden);
    check(fallbackHiddenStatus, "failed copy does not claim success");
    check(fallbackValue.startsWith("用途：YUBI梱包用ダンボール購入\nセグメント1：AIハンド\nセグメント2：プロダクト販売\n分類：消耗品\n内容：梱包用ダンボール80サイズ 50枚"), `fallback text ${fallbackValue}`);

    await page.setViewport({ width: 390, height: 844 });
    const mobile = await page.evaluate((id) => {
      const card = document.querySelector(`[data-detail="${id}"]`);
      const buttons = [...card.querySelectorAll(".memo-actions button")].map((button) => {
        const rect = button.getBoundingClientRect();
        return { text: button.textContent, left: rect.left, right: rect.right, top: rect.top };
      });
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        buttons,
      };
    }, copyId);
    check(mobile.overflow <= 1, `mobile overflow ${mobile.overflow}`);
    check(mobile.buttons.length === 2 && mobile.buttons[0].text === "クリップボードにコピー" && mobile.buttons[1].text === "初期値に戻す", `memo buttons ${JSON.stringify(mobile.buttons)}`);

    await page.setViewport({ width: 320, height: 700 });
    const narrow = await page.evaluate((id) => {
      const buttons = [...document.querySelectorAll(`[data-detail="${id}"] .memo-actions button`)].map((button) => button.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        width: buttons[0] ? buttons[0].width : 0,
      };
    }, copyId);
    check(narrow.overflow <= 1, `narrow overflow ${narrow.overflow}`);
    check(narrow.width > 0, "copy button remains at 320px");

    console.log(`checks before screenshots: ${failures.length}`);
    await page.setViewport({ width: 1280, height: 900 });
    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(desktopOverflow <= 1, `desktop overflow ${desktopOverflow}`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/upsider-desktop.png" });
    await page.evaluate(() => document.querySelector("#tx-heading").scrollIntoView());
    await page.screenshot({ path: "/tmp/upsider-desktop-table.png" });
    await page.evaluate((id) => document.querySelector(`[data-detail="${id}"]`).scrollIntoView(), NEW_ORDER_ID);
    await page.screenshot({ path: "/tmp/upsider-desktop-memo.png" });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/upsider-mobile-top.png" });
    await integrationStoppedChecks(browser, page.url());
  } finally {
    await browser.close();
  }
}

async function integrationStoppedChecks(browser, base) {
  gas.configUrl = new URL("/mock-gas", base).toString();
  gas.behavior = "ok";
  gas.hits = [];
  gas.gets = [];
  gas.results = {
    "11111111-2222-4333-8444-555555555555": [{ state: "done", result: { status: "success", finishedAt: "2026-11-07T01:00:00.000Z", message: "メモを追加しました。" } }],
  };
  const page = await browser.newPage();
  const calls = [];
  page.on("request", (request) => {
    const url = request.url();
    if (/mock-gas|script\.google|slack\.com\/api|hooks\.slack|op=result|AKfycbw/.test(url)) {
      calls.push(`${request.method()} ${url}`);
    }
  });
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify({
      version: 3,
      requests: {
        "tx-20261106-1553-danballace-7160": {
          transactionId: "tx-20261106-1553-danballace-7160",
          slackThread: "https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1793948039.836289",
          memoLines: ["用途：保管", "セグメント1：AIハンド", "セグメント2：", "分類：消耗品", "内容：保管"],
          savedAt: "2026-11-07T00:10:00.000Z",
          updatedAt: "2026-11-07T00:10:00.000Z",
          status: "受付済み",
          requestId: "11111111-2222-4333-8444-555555555555",
          errorMessage: "",
          acceptedAt: new Date().toISOString(),
          pollAttempts: 0,
          lastCheckedAt: null,
          result: null,
        },
      },
    }));
  });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready='true']");
  await new Promise((resolve) => setTimeout(resolve, 500));
  check(calls.length === 0, `stored request caused no reception call ${calls.join(",")}`);
  check(gas.hits.length === 0 && gas.gets.length === 0, `mock gas untouched posts ${gas.hits.length} gets ${gas.gets.length}`);
  check(await page.$("[data-instruction-send]") === null, "no instruction send button");
  check(await page.$("[data-ai]") === null, "no memo send button");
  check(await page.$("[data-recheck]") === null, "no recheck button");
  check(await page.$("[data-request]") === null, "old request is not resumed on screen");
  const text = await page.evaluate(() => document.body.innerText);
  check(text.includes("送信しません"), text);
  check(!text.includes("結果を再確認") && !text.includes("指示を送る") && !text.includes("AIがメモを追加する"), "send actions are not offered");
  await page.close();
}

await assertLedger();
const server = await startServer();
try {
  const { port } = server.address();
  await browserChecks(`http://127.0.0.1:${port}/`);
} catch (error) {
  failures.push(error.stack || String(error));
} finally {
  await new Promise((resolve) => server.close(resolve));
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
const counts = Object.fromEntries(FILTERS.slice(1).map((status) => [status, countOf(ledger.transactions, status)]));
const sums = Object.fromEntries(FILTERS.slice(1).map((status) => [status, sumOf(ledger.transactions, status)]));
console.log(JSON.stringify({
  asOf: ledger.asOf,
  transactions: ledger.transactions.length,
  details: ledger.details.length,
  totalYen: sumOf(ledger.transactions),
  counts,
  sums,
  evidenceUrls: EVIDENCE_URLS,
}, null, 2));
console.log("ok: 67 transactions, links, initial memos, copy, filters, execution requests");
