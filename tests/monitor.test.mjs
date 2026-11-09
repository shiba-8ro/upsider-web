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
  actionSummary,
  needsAction,
  attachmentResultView,
  countOf,
  filterTransactions,
  shareRestrictionRemark,
  formatMemoText,
  formatYen,
  initialMemo,
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
  check(ledger.transactions.length === 19, "ledger has 19 transactions");
  check(ledger.asOf === "2026-11-09 22:25 JST", "asOf");
  check(ledger.dataAcquiredAt === "2026-11-09 22:25 JST", "data acquired at");
  check(ledger.previousDataAcquiredAt === "2026-11-09 16:25 JST", "previous acquisition kept");
  check(ledger.earlierDataAcquiredAt === "2026-11-09 15:59 JST", "earlier acquisition kept");
  check(ledger.lead.includes("2026-11-09 22:25 JST"), "lead check time");
  check(ledger.lead.includes("画面の更新時刻ではない"), "lead separates screen update time");
  check(ledger.lead.includes("登録完了13件"), "lead registered count");
  check(ledger.lead.includes("要処理4件"), "lead action count");
  check(ledger.lead.includes("返金除外2件"), "lead refund exclusion");
  check(ledger.lead.includes("証憑保存済・Slack未添付"), "lead shows the saved receipt");
  check(ledger.lead.includes("共有拒否ではない"), "akizuki is not share-refused");
  check(ledger.lead.includes("メモあり18件"), "lead memo counts");
  check(JSON.stringify(ledger.callouts.map((item) => item.lead)) === JSON.stringify([
    "運用メモ",
    "今回のチェック（11/09 22:25）",
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
  const currentCheck = ledger.callouts.find((item) => item.lead === "今回のチェック（11/09 22:25）");
  check(currentCheck?.tone === "info" && currentCheck.body.includes("66583392606") && currentCheck.body.includes("2956381-01") && currentCheck.body.includes("福山通運"), "earth 5570 shipment");
  check(currentCheck?.body.includes("12時～14時") && currentCheck.body.includes("2026-11-10") && currentCheck.body.includes("https://drive.google.com/file/d/12UcuIa_b5oA8PHpqp4OVjMu947EW6UO8/view"), "earth delivery note");
  check(currentCheck?.body.includes("発行日2026/11/07") && currentCheck.body.includes("ご請求額¥5,570") && currentCheck.body.includes("納品日2026/11/10"), "delivery note amounts");
  check(currentCheck?.body.includes("証憑保存済・Slack未添付") && currentCheck.body.includes("登録完了13件、返金除外2件、要処理4件"), "shipment check keeps counts");
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
  check(ledger.transactions.filter((tx) => tx.memoPresent === true).length === 18, "memo present 18");
  check(!JSON.stringify(ledger).includes("13c1225a") && !JSON.stringify(ledger).includes("F0CF"), "internal attachment ids stay out");
  const counts = {
    "登録完了": 13,
    [REFUND_STATUS]: 2,
    "メモなし": 0,
    "証憑なし": 1,
    "証憑保存済・Slack未添付": 3,
    "メモ・証憑なし": 0,
    "証憑不一致": 0,
  };
  check(JSON.stringify(FILTERS.slice(1)) === JSON.stringify(Object.keys(counts)), "filters match counted statuses");
  for (const [status, count] of Object.entries(counts)) {
    check(countOf(ledger.transactions, status) === count, `${status} count ${countOf(ledger.transactions, status)} !== ${count}`);
  }
  check(FILTERS.slice(1).reduce((total, status) => total + countOf(ledger.transactions, status), 0) === 19, "status counts sum to 19");
  const sums = {
    "登録完了": 87684,
    [REFUND_STATUS]: 0,
    "メモなし": 0,
    "証憑なし": 17600,
    "証憑保存済・Slack未添付": 15330,
    "メモ・証憑なし": 0,
    "証憑不一致": 0,
  };
  check(sumOf(ledger.transactions) === 120614, `total ${sumOf(ledger.transactions)}`);
  check(Object.values(sums).reduce((total, value) => total + value, 0) === 120614, "status sums");
  for (const [status, amount] of Object.entries(sums)) {
    check(sumOf(ledger.transactions, status) === amount, `sum ${status} ${sumOf(ledger.transactions, status)} !== ${amount}`);
  }
  check(formatYen(120614) === "¥120,614", "yen format");
  check(formatYen(-23960) === "-¥23,960", "negative yen format");
  check(filterTransactions(ledger.transactions, "メモなし").every((tx) => tx.status === "メモなし"), "filter exact");
  check(filterTransactions(ledger.transactions, "証憑なし").length === 1, "only nisshin remains without a receipt");
  check(filterTransactions(ledger.transactions, "証憑保存済・Slack未添付").length === 3, "three receipts are saved and not yet attached");
  check(filterTransactions(ledger.transactions, "メモなし").length === 0, "メモなし is empty");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 19, "slack urls unique");
  const detailIds = ledger.transactions.filter((tx) => tx.detailSection).map((tx) => tx.id);
  check(detailIds.length === 0, `detail sections ${detailIds.join(",")}`);
  check(JSON.stringify(detailIds) === JSON.stringify(ledger.details.map((detail) => detail.transactionId)), "details follow unhandled transactions");

  const completed = ledger.transactions.filter((tx) => tx.status === "登録完了");
  const savedReceipts = ledger.transactions.filter((tx) => tx.status === "証憑保存済・Slack未添付");
  check(completed.length === 13 && completed.every(hasEvidence), `登録完了 evidence ${completed.length}`);
  const savedById = Object.fromEntries(savedReceipts.map((tx) => [tx.id, tx]));
  check(savedReceipts.length === 3, "three saved receipts");
  const akizuki = savedById["tx-20261105-1241-akizuki-2600"];
  check(akizuki?.drive === "https://drive.google.com/file/d/1gz3oExT325FAWtY0YprLunl6Eex9EUuw/view", "akizuki drive url");
  check(akizuki?.content === "Hub基板用ピンヘッダー" && !akizuki.content.includes("証憑なし"), "akizuki content drops the missing-evidence note");
  check(akizuki?.slackAttachmentError === undefined && akizuki?.slackAttachmentStatus === "未添付（ユーザーが手動で添付予定）", "akizuki is not share-refused");
  check(akizuki?.deliveryStatus === "出荷済み" && akizuki?.trackingNumber === "437180618571" && akizuki?.deliveryConfirmed === false, "akizuki shipment is unconfirmed");
  check(akizuki?.memoPresent === true && akizuki?.orderNumber === "EC261105-069042182-01", "akizuki memo and order kept");
  const earth = savedById["tx-20261102-2054-earth-5570"];
  check(earth?.drive === "https://drive.google.com/file/d/1Mc2l_KfD-eHDzObdVr3xtEoLNJoJKQSG/view" && earth?.receiptNumber === "C333470", "earth receipt");
  check(earth?.status === "証憑保存済・Slack未添付" && earth?.amount === "¥5,570" && earth?.amountYen === 5570, "earth status and amount unchanged");
  check(earth?.deliveryStatus === "出荷済み（納入予定2026-11-10）" && earth?.carrier === "福山通運" && earth?.shippedDate === "2026-11-09" && earth?.trackingNumber === "66583392606" && earth?.expectedDeliveryDate === "2026-11-10" && earth?.deliveryConfirmed === false && earth?.expectedShippingDate === undefined, "earth shipping");
  check(earth?.deliveryNoteFile === "https://drive.google.com/file/d/12UcuIa_b5oA8PHpqp4OVjMu947EW6UO8/view", "earth delivery note file");
  check(earth?.content === "プロダクト販売用段ボール" && earth?.slackAttachmentError === undefined, "earth content and no share refusal");
  const carton = savedById["tx-20261106-1553-danballace-7160"];
  check(carton?.drive === "https://drive.google.com/file/d/1kZw-pFbWVnaT3csoEGb0w5DfMkrW5RKO/view" && carton?.receiptNumber === "C333471", "danballace receipt");
  check(carton?.deliveryStatus === "注文準備中" && carton?.priorDeliveryStatus === "発送予定連絡" && carton?.carrier === "佐川急便" && carton?.expectedShippingDate === "2026-11-13" && carton?.expectedDeliveryDate === "2026-11-16", "danballace shipping");
  check(carton?.content === "YUBI梱包用ダンボール80サイズ 50枚" && carton?.slackAttachmentError === undefined, "danballace content and no share refusal");
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
  check(actions.action === 4 && actions.refund === 2 && actions.done === 13, `action summary ${JSON.stringify(actions)}`);
  check(actions.action === ledger.transactions.length - actions.refund - actions.done, "action count excludes refund and completed");
  const actionIds = ledger.transactions.filter(needsAction).map((tx) => tx.id).sort();
  const expectedActionIds = [
    "tx-20261102-2054-earth-5570",
    "tx-20261105-1241-akizuki-2600",
    "tx-20261105-1357-nisshin-17600",
    "tx-20261106-1553-danballace-7160",
  ];
  check(JSON.stringify(actionIds) === JSON.stringify(expectedActionIds), `action ids ${actionIds.join(",")}`);
  check(JSON.stringify([...ledger.upsiderCheck.needsActionIds].sort()) === JSON.stringify(expectedActionIds), "stored action ids match the status count");
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
  check(misumi?.deliveryStatus === "配送中" && misumi?.expectedDeliveryDate === "2026-11-09", "misumi delivery kept");
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
  const amazon2473 = ledger.transactions.find((tx) => tx.id === "tx-20261101-0440-amazon-2473");
  check(amazon2473?.status === "登録完了" && amazon2473?.orderNumber === "249-7203088-9467041" && amazon2473?.drive === "あり", "amazon 2473 registration kept");
  check(!("accountingPdfVerifiedAt" in amazon2473) && !("voucherValidityReverified" in amazon2473), "amazon 2473 was not marked revalidated");

  const order = ledger.transactions.find((tx) => tx.id === NEW_ORDER_ID);
  check(order?.merchant === "DANBALLACE" && order?.datetime === "11/06 15:53", "new order identity");
  check(order?.amountYen === 7160 && order?.status === "証憑保存済・Slack未添付" && order?.drive.startsWith("https://drive.google.com/"), "new order status");
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
    const request = buildExecutionRequest({
      transactionId: tx.id,
      slackThread: tx.slack,
      memo,
      savedAt: "2026-11-06T00:00:00.000Z",
    });
    check(isExecutionRequest(tx.id, request), `request valid ${tx.id}`);
    check(!isExecutionRequest(tx.id, { ...request, token: "x" }), "token rejected");
  }

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
      "最新データ確認: 2026-11-09 22:25 JST（出荷と納品書のメールを読んだ時刻。画面の更新時刻ではない）。アースダンボール ¥5,570 は2026-11-09に福山通運で出荷済み、納入予定は2026-11-10の12時～14時。ステータスは証憑保存済・Slack未添付のまま。添付はユーザーが手動で行う予定で、共有拒否ではない。登録完了13件。返金除外2件。要処理4件。メモあり18件。",
      "今回のチェック（11/09 22:25）",
      "前回のチェック（11/09 16:25）",
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
      "2026-11-09 16:25（日本時間）",
      "成功3件／未完了0件",
      "ユーザーが3件とも手動で添付した。UPSIDERの「領収証を添付しました」を確認し、登録完了にした。",
      "証憑PDF取得成功",
      "2026-11-09 16:25（日本時間）",
      "アースダンボール ¥5,570 の出荷とご請求情報、および納品書類のメールを読んだ時刻。画面を更新した時刻やページを開いた時刻ではない。",
      "各取引詳細にメモ入力欄（用途・セグメント1・セグメント2・分類・内容）と「クリップボードにコピー」を設置しています。コピーすると改行付きで5行が入ります。ページ内の注文スクショは参照用で、UPSIDER側の証憑添付ではありません。新規で取引と根拠が確定したものは、#bo_upsider の該当取引スレッドに確認済み5項目メモと金額の一致した有効証憑PDFを登録します。用途やセグメントが未確定のものは確認するまで登録しません。",
      "DANBALLACE返金 -¥23,960 を追加。Amazon 4件（¥14,680・¥9,300・¥2,117・¥255）を本文なしPDF添付で登録完了。DANBALLACE ¥7,160 はメモ・証憑なし。",
      "新規取引なし。Slack再確認でメモ登録が進んでいたため、MonotaRO ¥17,553・¥4,833・日進ゴム ¥17,600 は「証憑なし」に更新（会計上有効な領収書・請求書は未取得。納品書・注文確認書・スクショは対象外）。Amazon ¥2,659 は適格請求書PDFを本文なしで新規添付し登録完了。Amazon ¥2,117 はスレッドに適格請求書PDFが既にあったため再添付なし。Driveに新たに添付可能な有効証憑は上記以外なし。メモ作成は停止中。",
      "要対応の取引です。Slackスレッドの下にメモ入力欄があり、スクショがある場合はその上に並びます。",
      "スクショはチャット／ページ参照用であり、UPSIDER証憑ではない。このページは使い捨てではなく、毎回のチェック結果で更新するダッシュボードです。",
    ]) {
      check(bodyText.includes(phrase), `missing phrase: ${phrase}`);
    }
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
    check(rows.length === 19, `visible rows ${rows.length}`);
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
    check(acquired.text === "2026-11-09 22:25（日本時間）", `acquired text ${acquired.text}`);
    check(acquired.datetime === "2026-11-09 22:25 JST", `acquired source ${acquired.datetime}`);
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
    check(actionLine === "要処理 4件。登録完了13件と返金2件は含めません。", actionLine);
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
    check(agg[0][0] === "すべて" && agg[0][1] === "19" && agg[0][2] === "¥120,614", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "登録完了")?.[1] === "13" && agg.find((row) => row[0] === "登録完了")?.[2] === "¥87,684", "agg 登録完了");
    check(agg.find((row) => row[0] === REFUND_STATUS)?.[1] === "2" && agg.find((row) => row[0] === REFUND_STATUS)?.[2] === "¥0", "agg refund");
    check(agg.find((row) => row[0] === "メモなし")?.[1] === "0" && agg.find((row) => row[0] === "メモなし")?.[2] === "¥0", "agg メモなし");
    check(agg.find((row) => row[0] === "証憑なし")?.[1] === "1" && agg.find((row) => row[0] === "証憑なし")?.[2] === "¥17,600", "agg 証憑なし");
    check(agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[1] === "3" && agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[2] === "¥15,330", "agg saved receipts");
    check(agg.find((row) => row[0] === "メモ・証憑なし")?.[1] === "0" && agg.find((row) => row[0] === "メモ・証憑なし")?.[2] === "¥0", "agg メモ・証憑なし");
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
      const emptyHidden = await page.$eval("[data-empty]", (node) => node.hidden);
      check(emptyHidden === (expected.length !== 0), `empty state ${filter}`);
    }
    await page.click('[data-filter="すべて"]');

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
    check(purposeAfterReload === "YUBI梱包用ダンボール80サイズ 50枚", "form resets to initial value");

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
    check(mobile.buttons.length === 1 && mobile.buttons[0].text === "クリップボードにコピー", `memo buttons ${JSON.stringify(mobile.buttons)}`);

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
console.log("ok: 19 transactions, links, initial memos, copy, filters, execution requests");
