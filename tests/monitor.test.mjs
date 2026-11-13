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
  check(ledger.transactions.length === 29, "ledger has 29 transactions");
  check(ledger.asOf === "2026-11-13T09:21:02+09:00", "asOf");
  check(ledger.dataAcquiredAt === "2026-11-13T09:21:02+09:00", "data acquired at");
  check(ledger.previousDataAcquiredAt === "2026-11-12 09:20 JST", "previous acquisition kept");
  check(ledger.earlierDataAcquiredAt === "2026-11-11 18:47 JST", "earlier acquisition kept");
  check(ledger.dataAcquiredAtLabel.includes("ブラウザで確認した時刻") && ledger.dataAcquiredAtLabel.includes("画面を更新した時刻やページを開いた時刻ではない"), "acquisition label");
  check(ledger.lead.startsWith("最新データ確認 2026-11-13 09:21 JST"), "lead check time");
  check(ledger.lead.includes("#bo_upsiderをブラウザで確認した時刻"), "lead is the browser check time");
  check(ledger.lead.includes("登録完了17件"), "lead registered count");
  check(ledger.lead.includes("要処理6件"), "lead action count");
  check(ledger.lead.includes("台帳29件"), "lead ledger count");
  check(ledger.lead.includes("除外6件（返金2件、本人以外の課金4件）"), "lead exclusion");
  check(ledger.lead.includes("DP12*MONOTARO.COM ¥18,678") && ledger.lead.includes("134323400032") && ledger.lead.includes("XIAO ESP32C6×10") && ledger.lead.includes("出荷予定11/25まで"), "lead records monotaro 18678");
  check(ledger.lead.includes("EVENTOS ¥0") && ledger.lead.includes("BRAVESOFT INC. ¥60,500") && ledger.lead.includes("DP4*RAKSUL ¥4,711") && ledger.lead.includes("行は追加しない"), "lead keeps the four new charges out of scope");
  check(ledger.lead.includes("証憑なしのMonotaRO ¥30,017と¥4,065") && ledger.lead.includes("ミスミ ¥44,189") && ledger.lead.includes("Amazon ¥2,399") && ledger.lead.includes("MonotaRO ¥18,678") && ledger.lead.includes("確認決済のAmazon ¥0"), "lead names the six action rows");
  check(ledger.lead.includes("ミスミは11/12出荷") && ledger.lead.includes("11/12配達済みで適格請求書待ち"), "lead records shipment and delivery");
  check(!ledger.lead.includes("本決済¥2,399はSlack未着"), "lead does not describe the settled amazon charge as unarrived");
  check(ledger.lead.includes("メモあり20件"), "lead memo counts");
  check(!("tokenUsage" in ledger), "token usage is not stored");
  check(JSON.stringify(ledger.callouts.map((item) => item.lead)) === JSON.stringify([
    "運用メモ",
    "今回のチェック（11/13 09:21）",
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
  const todayCheck = ledger.callouts.find((item) => item.lead === "今回のチェック（11/13 09:21）");
  check(todayCheck?.tone === "info" && todayCheck.body.includes("2026-11-13 09:21 JST") && todayCheck.body.includes("画面を更新した時刻ではない"), "current check time");
  check(todayCheck?.body.includes("登録完了17件、除外6件（返金2件、本人以外の課金4件）、要処理6件"), "current counts");
  check(todayCheck?.body.includes("1794498836.125669") && todayCheck.body.includes("134323400032") && todayCheck.body.includes("202785267") && todayCheck.body.includes("TX-20261113-MNT-001") && todayCheck.body.includes("Seeed XIAO ESP32C6 ×10") && todayCheck.body.includes("税¥1,698") && todayCheck.body.includes("出荷予定は11/25まで"), "monotaro 18678");
  check(todayCheck?.body.includes("EVENTOS ¥0") && todayCheck.body.includes("1794476079.988119") && todayCheck.body.includes("BRAVESOFT INC. ¥0") && todayCheck.body.includes("1794476131.214289") && todayCheck.body.includes("BRAVESOFT INC. ¥60,500") && todayCheck.body.includes("1794476153.915879") && todayCheck.body.includes("取引行には加えていない"), "event charges stay out of the ledger");
  check(todayCheck?.body.includes("DP4*RAKSUL ¥4,711") && todayCheck.body.includes("1794480409.627769") && todayCheck.body.includes("株式会社Algomatic Dynamics") && todayCheck.body.includes("ECサイト決済用"), "raksul stays out of the ledger");
  check(todayCheck?.body.includes("0417677859336") && todayCheck.body.includes("SBS即配サポート") && todayCheck.body.includes("全数出荷") && todayCheck.body.includes("メモ・証憑なしのまま"), "misumi shipment without a status change");
  check(todayCheck?.body.includes("11/12 17:22 JSTに配達済み") && todayCheck.body.includes("適格請求書ではない") && todayCheck.body.includes("Driveはなしのまま"), "amazon 2399 delivered and still waiting for a qualified invoice");
  check(todayCheck?.body.includes("ステータスは変えていない") && todayCheck.body.includes("この確認決済も要処理に入る") && todayCheck.body.includes("メモあり20件"), "unchanged rows stay in the action count");
  check(todayCheck?.body.includes("投稿・添付・メモ登録はしていない"), "no send from this check");
  check(todayCheck?.body.includes("返金はない"), "no new refund");
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
  check(ledger.transactions.filter((tx) => tx.memoPresent === true).length === 20, "memo present 20");
  check(ledger.transactions.filter((tx) => tx.memoStatus === "未確認").length === 8, "unconfirmed memos stay unconfirmed");
  check(!JSON.stringify(ledger).includes("13c1225a") && !JSON.stringify(ledger).includes("F0CF"), "internal attachment ids stay out");
  const counts = {
    "登録完了": 17,
    [REFUND_STATUS]: 2,
    [NOT_OWNER_STATUS]: 3,
    [NOT_OWNER_STATUS_20261111]: 1,
    "メモなし": 0,
    "証憑なし": 2,
    "証憑保存済・Slack未添付": 0,
    "メモ・証憑なし": 3,
    "証憑不一致": 0,
  };
  check(JSON.stringify(FILTERS.slice(1)) === JSON.stringify(Object.keys(counts)), "filters match counted statuses");
  for (const [status, count] of Object.entries(counts)) {
    check(countOf(ledger.transactions, status) === count, `${status} count ${countOf(ledger.transactions, status)} !== ${count}`);
  }
  const confirmationStatus = "確認決済（¥0、本決済¥2,399は別行）";
  check(countOf(ledger.transactions, confirmationStatus) === 1, "confirmation charge is its own status");
  check(FILTERS.slice(1).reduce((total, status) => total + countOf(ledger.transactions, status), 0) + countOf(ledger.transactions, confirmationStatus) === 29, "status counts sum to 29");
  const sums = {
    "登録完了": 120614,
    [REFUND_STATUS]: 0,
    [NOT_OWNER_STATUS]: 1222,
    [NOT_OWNER_STATUS_20261111]: 22,
    "メモなし": 0,
    "証憑なし": 34082,
    "証憑保存済・Slack未添付": 0,
    "メモ・証憑なし": 65266,
    "証憑不一致": 0,
  };
  check(sumOf(ledger.transactions) === 221206, `total ${sumOf(ledger.transactions)}`);
  check(Object.values(sums).reduce((total, value) => total + value, 0) === 221206, "status sums");
  for (const [status, amount] of Object.entries(sums)) {
    check(sumOf(ledger.transactions, status) === amount, `sum ${status} ${sumOf(ledger.transactions, status)} !== ${amount}`);
  }
  check(formatYen(221206) === "¥221,206", "yen format");
  check(formatYen(-23960) === "-¥23,960", "negative yen format");
  check(filterTransactions(ledger.transactions, "メモなし").every((tx) => tx.status === "メモなし"), "filter exact");
  check(filterTransactions(ledger.transactions, "証憑なし").length === 2, "two rows have a memo and no receipt");
  check(filterTransactions(ledger.transactions, "証憑保存済・Slack未添付").length === 0, "no receipt remains saved and unattached");
  check(filterTransactions(ledger.transactions, "メモなし").length === 0, "メモなし is empty");
  check(filterTransactions(ledger.transactions, "メモ・証憑なし").length === 3, "three rows are missing both memo and receipt");
  check(filterTransactions(ledger.transactions, NOT_OWNER_STATUS).length === 3, "three earlier not-owner charges stay listed");
  check(filterTransactions(ledger.transactions, NOT_OWNER_STATUS_20261111).length === 1, "github 22 is listed under the 11/11 exclusion");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 29, "slack urls unique");
  const detailIds = ledger.transactions.filter((tx) => tx.detailSection).map((tx) => tx.id);
  check(detailIds.length === 0, `detail sections ${detailIds.join(",")}`);
  check(JSON.stringify(detailIds) === JSON.stringify(ledger.details.map((detail) => detail.transactionId)), "details follow unhandled transactions");

  const completed = ledger.transactions.filter((tx) => tx.status === "登録完了");
  const savedReceipts = ledger.transactions.filter((tx) => tx.status === "証憑保存済・Slack未添付");
  check(completed.length === 17 && completed.every(hasEvidence), `登録完了 evidence ${completed.length}`);
  check(savedReceipts.length === 0, "no saved receipt is still unattached");
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
  check(ledger.transactions.filter((tx) => String(tx.drive).startsWith("https://")).length === 11, "eleven drive urls");
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
  check(ledger.evidencePatrol?.lastSuccessfulAcquisitionAt === "2026-11-09 16:25 JST", "carton pdf time");
  check(ledger.evidencePatrol?.previousLastSuccessfulAcquisitionAt === "2026-11-09 15:59 JST", "akizuki pdf time kept");
  check(ledger.memoCheck?.lastIncrementalCheckedAt === "2026-11-09 09:26:56 JST" && ledger.memoCheck?.lastIncrementalThreadsScanned === 18, "eighteen threads rechecked");
  check(ledger.memoCheck?.previousIncrementalCheckedAt === "2026-11-08 09:07 JST" && ledger.memoCheck?.previousIncrementalThreadsScanned === 8, "11/08 incremental check kept");
  check(ledger.memoCheck?.lastIncrementalLimit.includes("増減比較はしない"), "reply counts are not compared");
  check(ledger.slackReceiptAttachment?.retryOn20261109 === false, "refused receipts were not resent");
  const actions = actionSummary(ledger.transactions);
  check(isNotOwnerStatus(NOT_OWNER_STATUS) && isNotOwnerStatus(NOT_OWNER_STATUS_20261111) && !isNotOwnerStatus("メモ・証憑なし"), "both not-owner statuses are excluded");
  check(actions.action === 6 && actions.refund === 2 && actions.notOwner === 4 && actions.excluded === 6 && actions.done === 17, `action summary ${JSON.stringify(actions)}`);
  check(actions.action === ledger.transactions.length - actions.excluded - actions.done, "action count excludes refund, not-owner, and completed");
  const actionIds = ledger.transactions.filter(needsAction).map((tx) => tx.id).sort();
  const expectedActionIds = [
    "tx-20261111-1404-monotaro-30017",
    "tx-20261111-1546-monotaro-4065",
    "tx-20261111-1553-amazon-0",
    "tx-20261111-1940-misumi-44189",
    "tx-20261111-2343-amazon-2399",
    "tx-20261113-0053-monotaro-18678",
  ].sort();
  check(JSON.stringify(actionIds) === JSON.stringify(expectedActionIds), `action ids ${actionIds.join(",")}`);
  check(JSON.stringify([...ledger.upsiderCheck.needsActionIds].sort()) === JSON.stringify(expectedActionIds), "stored action ids match the status count");
  check(ledger.upsiderCheck.checkedAt === "2026-11-13 09:21 JST" && ledger.upsiderCheck.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.registeredComplete === 17 && ledger.upsiderCheck.needsAction === 6 && ledger.upsiderCheck.refundExcluded === 2 && ledger.upsiderCheck.notOwnerExcluded === 4 && ledger.upsiderCheck.excluded === 6, "stored counts");
  check(ledger.upsiderCheck.newTransactions === 5 && ledger.upsiderCheck.ledgerRows === 29 && ledger.upsiderCheck.memosCreated === 0 && ledger.upsiderCheck.attachmentsAttempted === 0 && JSON.stringify(ledger.upsiderCheck.savedNotAttached) === "[]" && JSON.stringify(ledger.upsiderCheck.statusChanges) === "[]", "five new card charges, one added, statuses unchanged, nothing sent");
  check(ledger.upsiderCheck.excludedOutOfScope?.[0]?.includes("EVENTOS ¥0") && ledger.upsiderCheck.excludedOutOfScope[0].includes("1794476079.988119"), "eventos stays out of scope");
  check(ledger.upsiderCheck.excludedOutOfScope?.[1]?.includes("BRAVESOFT INC. ¥0") && ledger.upsiderCheck.excludedOutOfScope[1].includes("1794476131.214289"), "bravesoft zero stays out of scope");
  check(ledger.upsiderCheck.excludedOutOfScope?.[2]?.includes("BRAVESOFT INC. ¥60,500") && ledger.upsiderCheck.excludedOutOfScope[2].includes("1794476153.915879"), "bravesoft charge stays out of scope");
  check(ledger.upsiderCheck.excludedOutOfScope?.[3]?.includes("DP4*RAKSUL ¥4,711") && ledger.upsiderCheck.excludedOutOfScope[3].includes("1794480409.627769"), "raksul stays out of scope");
  check(!ledger.upsiderCheck.excludedOutOfScope.some((item) => item.includes("未着")) && !ledger.upsiderCheck.note.includes("Slack未着"), "the 2399 charge is no longer described as unarrived");
  check(ledger.upsiderCheck.note.includes("要処理は6件") && ledger.upsiderCheck.note.includes("確認決済（¥0、本決済¥2,399は別行）") && ledger.upsiderCheck.note.includes("0417677859336") && ledger.upsiderCheck.note.includes("適格請求書ではない"), "note matches the page action count");
  check(JSON.stringify(ledger.upsiderCheck.notOwnerExcludedIds) === JSON.stringify(["tx-20261109-1754-github-392", "tx-20261109-1755-github-783", "tx-20261110-1051-github-47", "tx-20261111-1259-github-22"]), "stored not-owner exclusion");
  check(ledger.memoCheck.latestCheck?.checkedAt === "2026-11-13 09:21 JST" && ledger.memoCheck.latestCheck?.memoPresent === 20 && ledger.memoCheck.latestCheck?.unconfirmed === 8 && ledger.memoCheck.latestCheck?.newMemoCompletions === 0, "memo check records this pass");
  check(ledger.memoCheck.latestCheck?.previous?.checkedAt === "2026-11-12 09:20 JST" && ledger.memoCheck.latestCheck?.previous?.memoPresent === 20 && ledger.memoCheck.latestCheck?.previous?.unconfirmed === 7, "previous memo check kept");
  check(ledger.upsiderCheck.previous?.checkedAt === "2026-11-12 09:20 JST" && ledger.upsiderCheck.previous?.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous?.needsAction === 5 && ledger.upsiderCheck.previous?.ledgerRows === 28 && ledger.upsiderCheck.previous?.newTransactions === 4, "morning check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous?.statusChanges) === JSON.stringify(["tx-20261111-1404-monotaro-30017", "tx-20261111-1546-monotaro-4065", "tx-20261111-1553-amazon-0"]), "previous status changes kept");
  check(ledger.upsiderCheck.previous?.excludedOutOfScope?.[0]?.includes("HIMARI SHOTEN ¥26,310") && ledger.upsiderCheck.previous.excludedOutOfScope[0].includes("1794400760.220609"), "himari stays out of scope");
  check(ledger.upsiderCheck.previous?.excludedOutOfScope?.[1]?.includes("GITHUB, INC. ¥16,432") && ledger.upsiderCheck.previous.excludedOutOfScope[1].includes("USD 101.20"), "github 16432 stays out of scope");
  check(ledger.upsiderCheck.previous?.previous?.checkedAt === "2026-11-11 18:47 JST" && ledger.upsiderCheck.previous?.previous?.routine === "UPSIDERチェック" && ledger.upsiderCheck.previous?.previous?.registeredComplete === 17 && ledger.upsiderCheck.previous?.previous?.needsAction === 3 && ledger.upsiderCheck.previous?.previous?.ledgerRows === 26, "evening check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous?.previous?.statusChanges) === JSON.stringify(["tx-20261105-1357-nisshin-17600", "tx-20261111-1259-github-22"]), "evening status changes kept");
  check(ledger.upsiderCheck.previous?.previous?.previous?.checkedAt === "2026-11-11 09:34 JST" && ledger.upsiderCheck.previous?.previous?.previous?.routine === "UPSIDERチェック（毎日AM9時）" && ledger.upsiderCheck.previous?.previous?.previous?.registeredComplete === 16 && ledger.upsiderCheck.previous?.previous?.previous?.needsAction === 1 && ledger.upsiderCheck.previous?.previous?.previous?.ledgerRows === 22, "earlier morning check nested");
  check(JSON.stringify(ledger.upsiderCheck.previous?.previous?.previous?.statusChanges) === JSON.stringify(["tx-20261102-2054-earth-5570", "tx-20261106-1553-danballace-7160"]), "11/11 morning status changes kept");
  check(ledger.upsiderCheck.previous?.previous?.previous?.previous?.checkedAt === "2026-11-10 13:40:00 JST" && ledger.upsiderCheck.previous?.previous?.previous?.previous?.registeredComplete === 14 && ledger.upsiderCheck.previous?.previous?.previous?.previous?.needsAction === 3, "previous afternoon check nested");
  check(ledger.upsiderCheck.previous?.previous?.previous?.previous?.previous?.checkedAt === "2026-11-10 09:06 JST" && ledger.upsiderCheck.previous?.previous?.previous?.previous?.previous?.registeredComplete === 14 && ledger.upsiderCheck.previous?.previous?.previous?.previous?.previous?.needsAction === 5, "earlier morning check nested");
  check(ledger.upsiderCheck.previous?.previous?.previous?.previous?.previous?.previous?.checkedAt === "2026-11-09 16:25 JST" && ledger.upsiderCheck.previous?.previous?.previous?.previous?.previous?.previous?.registeredComplete === 13 && ledger.upsiderCheck.attachmentsAttempted === 0 && ledger.upsiderCheck.memosCreated === 0, "earlier check kept and nothing was sent");
  check(JSON.stringify([...ledger.upsiderCheck.refundExcludedIds].sort()) === JSON.stringify(["tx-20261102-2053-earth-23960", REFUND_ID].sort()), "stored refund exclusion");
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
  check(monotaro30017?.status === "証憑なし" && monotaro30017?.priorStatus === "メモ・証憑なし" && monotaro30017?.memoStatus === "あり" && monotaro30017?.memoPresent === true && monotaro30017?.drive === "なし" && monotaro30017?.deliveryStatus === "納入待ち" && monotaro30017?.statusReason === "メモ登録済み・証憑未取得（納入待ち、11/12納入予定）。", "monotaro 30017 status");
  check(monotaro30017?.memoEvidence?.[0]?.notice === "決済メモを追加しました！" && monotaro30017?.memoEvidence?.[0]?.postedBy === "UPSIDER" && monotaro30017?.memoEvidence?.[0]?.postedAt === "2026-11-11 20:48:44 JST" && monotaro30017?.memoEvidence?.[0]?.ts === null, "monotaro 30017 memo notice");
  check(monotaro30017?.registeredMemo?.purpose === "AIハンド製造ライン用資材収納用品購入" && monotaro30017?.registeredMemo?.seg1 === "AIハンド" && monotaro30017?.registeredMemo?.seg2 === "その他" && monotaro30017?.registeredMemo?.category === "備品" && monotaro30017?.registeredMemo?.content === monotaro30017.content && monotaro30017?.registeredMemo?.repliedAt === "2026-11-11 20:48:41 JST", "monotaro 30017 registered memo");
  check(monotaro30017?.expectedDeliveryDate === "2026-11-12", "monotaro 30017 delivery date");
  check(monotaro30017?.ledgerId === "TX-20261111-MNT-001" && monotaro30017?.orderNumber === "134323400030" && monotaro30017?.receptionNumber === "202639045" && monotaro30017?.paidAt === "2026-11-11 14:04:12 JST" && monotaro30017?.slack.endsWith("1794373453.560069"), "monotaro 30017 order");
  check(monotaro30017?.shipments?.[0]?.trackingNumber === "664362973562" && monotaro30017?.shipments?.[1]?.trackingNumber === "9583853145" && monotaro30017?.deliveryConfirmed === false, "monotaro 30017 shipments");
  const monotaro4065 = ledger.transactions.find((tx) => tx.id === "tx-20261111-1546-monotaro-4065");
  check(monotaro4065?.amountYen === 4065 && monotaro4065?.ledgerId === "TX-20261111-MNT-002" && monotaro4065?.orderNumber === "134323400031" && monotaro4065?.receptionNumber === "202654082", "monotaro 4065 order");
  check(monotaro4065?.status === "証憑なし" && monotaro4065?.priorStatus === "メモ・証憑なし" && monotaro4065?.memoStatus === "あり" && monotaro4065?.memoPresent === true && monotaro4065?.priorDeliveryStatus === "出荷待ち" && monotaro4065?.deliveryStatus === "納入待ち" && monotaro4065?.cardholder === "柴田 善広" && monotaro4065?.slack.endsWith("1794379576.006419") && monotaro4065?.content.includes("セメダイン スーパーXゴールド AX-014 20mL ×5"), "monotaro 4065 status");
  check(monotaro4065?.memoEvidence?.[0]?.postedAt === "2026-11-11 20:50:02 JST" && monotaro4065?.memoEvidence?.[0]?.postedBy === "UPSIDER" && monotaro4065?.memoEvidence?.[0]?.ts === null && monotaro4065?.registeredMemo?.purpose === "YUBI製造用副資材購入" && monotaro4065?.registeredMemo?.seg2 === "プロダクト販売" && monotaro4065?.registeredMemo?.category === "副資材" && monotaro4065?.registeredMemo?.repliedAt === "2026-11-11 20:49:59 JST", "monotaro 4065 memo");
  check(monotaro4065?.shipments?.[0]?.carrier === "ヤマト" && monotaro4065?.shipments?.[0]?.trackingNumber === "426978601394" && monotaro4065?.shipments?.[0]?.note === "直送品、全数出荷" && monotaro4065?.shippedDate === "2026-11-11", "monotaro 4065 shipment");
  const amazonZero = ledger.transactions.find((tx) => tx.id === "tx-20261111-1553-amazon-0");
  check(amazonZero?.merchant === "Amazon" && amazonZero?.slackMerchant === "AMAZON CO JP" && amazonZero?.amount === "¥0" && amazonZero?.amountYen === 0, "amazon zero amount");
  check(amazonZero?.status === "確認決済（¥0、本決済¥2,399は別行）" && amazonZero?.priorStatus === "メモ・証憑なし" && amazonZero?.memoStatus === "未確認" && amazonZero?.drive === "なし" && amazonZero?.cardholder === "柴田 善広" && amazonZero?.cardName === "AIハンド決済用", "amazon zero status");
  check(amazonZero?.paidAt === "2026-11-11 15:53:54 JST" && amazonZero?.slack.endsWith("1794380035.547129") && amazonZero?.likelyOrderNumber === "250-6606641-6831015" && amazonZero?.likelyOrderLedgerId === "TX-20261111-AMZ-001" && amazonZero?.likelyOrderAmountYen === 2399 && amazonZero?.expectedDeliveryDate === "2026-11-12", "amazon zero points at the settled order");
  check(amazonZero?.pairedTransactionId === "tx-20261111-2343-amazon-2399" && amazonZero?.statusReason.includes("確認決済（¥0、本決済¥2,399は別行") && !amazonZero.content.includes("未着") && !amazonZero.statusReason.includes("未着") && needsAction(amazonZero), "amazon zero stays listed and the page still counts it");
  const misumiNew = ledger.transactions.find((tx) => tx.id === "tx-20261111-1940-misumi-44189");
  check(misumiNew?.merchant === "ミスミ" && misumiNew?.slackMerchant === "DP5*MISUMI" && misumiNew?.amount === "¥44,189" && misumiNew?.amountYen === 44189 && misumiNew?.accountingTaxYen === 4017, "misumi 44189 amount");
  check(misumiNew?.status === "メモ・証憑なし" && misumiNew?.memoStatus === "未確認" && misumiNew?.memoPresent !== true && misumiNew?.drive === "なし" && misumiNew?.deliveryStatus === "出荷済（納入待ち）" && misumiNew?.priorDeliveryStatus === "未出荷" && misumiNew?.cardholder === "柴田 善広" && misumiNew?.cardName === "AIハンド決済用", "misumi 44189 status");
  check(misumiNew?.paidAt === "2026-11-11 19:40:05 JST" && misumiNew?.slack.endsWith("1794393605.849899") && misumiNew?.ledgerId === "TX-20261111-MSM-001" && misumiNew?.orderNumber === "AB25748GD4" && misumiNew?.content === "イグリデュール G GFM-2023-07 ×121" && misumiNew?.expectedShippingDate === "2026-11-12" && misumiNew?.expectedDeliveryDate === "2026-11-13" && misumiNew?.shippedDate === "2026-11-12", "misumi 44189 order");
  check(misumiNew?.shipments?.[0]?.carrier === "SBS即配サポート" && misumiNew?.shipments?.[0]?.trackingNumber === "0417677859336" && misumiNew?.shipments?.[0]?.item === "GFM-2023-07 ×121" && misumiNew?.shipments?.[0]?.note === "全数出荷" && misumiNew?.statusUpdatedAt === "2026-11-13 09:21 JST" && misumiNew?.statusReason.includes("11/12に全数出荷、到着予定11/13"), "misumi 44189 shipment");
  const amazon2399 = ledger.transactions.find((tx) => tx.id === "tx-20261111-2343-amazon-2399");
  check(amazon2399?.merchant === "Amazon" && amazon2399?.slackMerchant === "AMAZON CO JP" && amazon2399?.amount === "¥2,399" && amazon2399?.amountYen === 2399, "amazon 2399 amount");
  check(amazon2399?.status === "メモ・証憑なし" && amazon2399?.memoStatus === "未確認" && amazon2399?.drive === "なし" && amazon2399?.cardholder === "柴田 善広" && amazon2399?.cardName === "AIハンド決済用" && amazon2399?.deliveryStatus === "納入済（2026-11-12 17:22 JST配達済み）" && amazon2399?.deliveryConfirmed === true, "amazon 2399 status");
  check(amazon2399?.paidAt === "2026-11-11 23:43:44 JST" && amazon2399?.slack.endsWith("1794408224.262909") && amazon2399?.ledgerId === "TX-20261111-AMZ-001" && amazon2399?.orderNumber === "250-6606641-6831015" && amazon2399?.content.includes("TINMORRY 257×257mm コールドプレート ×1") && amazon2399?.orderReference === "YUBI製造SDS" && amazon2399?.expectedDeliveryDate === "2026-11-12" && amazon2399?.pairedTransactionId === amazonZero.id && amazon2399?.statusUpdatedAt === "2026-11-13 09:21 JST" && amazon2399?.statusReason.includes("適格請求書ではない"), "amazon 2399 order");
  const monotaro18678 = ledger.transactions.find((tx) => tx.id === "tx-20261113-0053-monotaro-18678");
  check(monotaro18678?.merchant === "MonotaRO" && monotaro18678?.slackMerchant === "DP12*MONOTARO.COM" && monotaro18678?.amount === "¥18,678" && monotaro18678?.amountYen === 18678 && monotaro18678?.accountingAmountYen === 18678 && monotaro18678?.accountingTaxYen === 1698, "monotaro 18678 amount");
  check(monotaro18678?.status === "メモ・証憑なし" && monotaro18678?.memoStatus === "未確認" && monotaro18678?.memoPresent === false && monotaro18678?.memoEvidence == null && monotaro18678?.drive === "なし" && monotaro18678?.cardholder === "柴田 善広" && monotaro18678?.cardName === "AIハンド決済用", "monotaro 18678 status");
  check(monotaro18678?.datetime === "11/13 00:53" && monotaro18678?.paidAt === "2026-11-13 00:53:56 JST" && monotaro18678?.slack.endsWith("1794498836.125669") && monotaro18678?.ledgerId === "TX-20261113-MNT-001" && monotaro18678?.orderNumber === "134323400032" && monotaro18678?.receptionNumber === "202785267" && monotaro18678?.content === "Seeed XIAO ESP32C6 ×10" && monotaro18678?.orderReference === "YUBI Glove製造", "monotaro 18678 order");
  check(monotaro18678?.items?.[0] === "Seeed XIAO ESP32C6 ×10" && monotaro18678?.deliveryStatus === "未出荷（在庫切れ、出荷予定11/25まで）" && monotaro18678?.deliveryConfirmed === false && monotaro18678?.statusUpdatedAt === "2026-11-13 09:21 JST" && monotaro18678?.statusReason.includes("出荷予定は11/25まで") && needsAction(monotaro18678), "monotaro 18678 delivery");
  check(monotaro30017?.statusUpdatedAt === "2026-11-13 09:21 JST" && monotaro4065?.statusUpdatedAt === "2026-11-13 09:21 JST" && amazonZero?.statusUpdatedAt === "2026-11-13 09:21 JST", "unchanged rows were rechecked");
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
    check(memoSeedText(tx) === tx.content && JSON.stringify(memoDefaults(tx)) === JSON.stringify(memo), `row defaults stay the content text ${tx.id}`);
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
    check(defaults.purpose === tx.content && defaults.seg1 === "AIハンド" && defaults.seg2 === "" && defaults.category === "消耗品" && defaults.content === tx.content, `defaults ${tx.id}`);
  }
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

    const title = await page.title();
    check(title === "UPSIDERモニター", `title ${title}`);
    const bodyText = await page.evaluate(() => document.body.innerText);
    for (const phrase of [
      "AIハンド決済用カードのUPSIDERチェック結果ダッシュボード。チェック実行のたびに更新します。",
      "最新データ確認 2026-11-13 09:21 JST（#bo_upsiderをブラウザで確認した時刻）。",
      "確認決済（¥0、本決済¥2,399は別行）にした。行は削除していない。",
      "要処理6件（証憑なしのMonotaRO ¥30,017と¥4,065、メモ・証憑なしのミスミ ¥44,189・Amazon ¥2,399・MonotaRO ¥18,678、確認決済のAmazon ¥0）。メモあり20件。",
      "今回のチェック（11/13 09:21）",
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
      "2026-11-13 09:21（日本時間）",
      "2026-11-09 16:25（日本時間）",
      "成功3件／未完了0件",
      "ユーザーが3件とも手動で添付した。UPSIDERの「領収証を添付しました」を確認し、登録完了にした。",
      "証憑PDF取得成功",
      "2026-11-09 16:25（日本時間）",
      "Slack #bo_upsiderをブラウザで確認した時刻。画面を更新した時刻やページを開いた時刻ではない。",
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
    check(rows.length === 29, `visible rows ${rows.length}`);
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
    check(acquired.text === "2026-11-13 09:21（日本時間）", `acquired text ${acquired.text}`);
    check(acquired.datetime === "2026-11-13T09:21:02+09:00", `acquired source ${acquired.datetime}`);
    check(!bodyText.includes("再検証済"), "page does not claim vouchers were revalidated");
    const pdfSaved = await page.$eval("[data-pdf-saved-at]", (node) => node.innerText);
    check(pdfSaved.includes("2026-11-09 16:25（日本時間）") && !pdfSaved.includes("23:30:30"), `pdf time ${pdfSaved}`);
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
    check(actionLine === "要処理 6件。登録完了17件。除外6件（返金2件、本人以外の課金4件）は含めません。", actionLine);
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
    check(agg[0][0] === "すべて" && agg[0][1] === "29" && agg[0][2] === "¥221,206", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "登録完了")?.[1] === "17" && agg.find((row) => row[0] === "登録完了")?.[2] === "¥120,614", "agg 登録完了");
    check(agg.find((row) => row[0] === REFUND_STATUS)?.[1] === "2" && agg.find((row) => row[0] === REFUND_STATUS)?.[2] === "¥0", "agg refund");
    check(agg.find((row) => row[0] === "メモなし")?.[1] === "0" && agg.find((row) => row[0] === "メモなし")?.[2] === "¥0", "agg メモなし");
    check(agg.find((row) => row[0] === "証憑なし")?.[1] === "2" && agg.find((row) => row[0] === "証憑なし")?.[2] === "¥34,082", "agg 証憑なし");
    check(agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[1] === "0" && agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[2] === "¥0", "agg saved receipts");
    check(agg.find((row) => row[0] === "メモ・証憑なし")?.[1] === "3" && agg.find((row) => row[0] === "メモ・証憑なし")?.[2] === "¥65,266", "agg メモ・証憑なし");
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
    check(resetPurpose === memoTx.content, `reset restores the row content ${resetPurpose}`);
    const cleared = JSON.parse(await page.evaluate((key) => localStorage.getItem(key), MEMO_STORAGE_KEY));
    check(cleared.memos[memoId] === undefined, "reset removes the stored draft");
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    const afterResetReload = await page.$eval(`[data-memo-row="${memoId}"] [data-memo-field="purpose"]`, (input) => input.value);
    check(afterResetReload === memoTx.content, "reset value remains after reload");

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
      check(found.fields.purpose === tx.content, `purpose ${tx.id}`);
      check(found.fields.seg1 === "AIハンド", `seg1 ${tx.id}`);
      check(found.fields.seg2 === "", `seg2 ${tx.id}`);
      check(found.fields.category === "消耗品", `category ${tx.id}`);
      check(found.fields.content === tx.content, `memo content ${tx.id}`);
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
    const expectedCopy = formatMemoText(initialMemo(ledger.transactions.find((tx) => tx.id === copyId).content));
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
    check(purposeAfterReset === "YUBI梱包用ダンボール80サイズ 50枚" && rowSegAfterReset === "", `reset restores both cards ${purposeAfterReset} / ${rowSegAfterReset}`);

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
    check(fallbackValue.startsWith("用途：YUBI梱包用ダンボール80サイズ 50枚\n"), `fallback text ${fallbackValue}`);

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
console.log("ok: 29 transactions, links, initial memos, copy, filters, execution requests");
