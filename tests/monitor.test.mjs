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
  countOf,
  filterTransactions,
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
          res.end(JSON.stringify({ ok: false }));
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
  check(ledger.asOf === "2026-11-07 22:20:00 JST", "asOf");
  check(ledger.lead.includes("2026-11-07 22:20:00 JST"), "lead asOf");
  check(ledger.lead.includes("メモあり18件・返金不要1件"), "lead memo counts");
  const counts = {
    "登録完了": 10,
    [REFUND_STATUS]: 1,
    "メモなし": 0,
    "証憑なし": 5,
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
    "登録完了": 48684,
    [REFUND_STATUS]: -23960,
    "メモなし": 0,
    "証憑なし": 56890,
    "証憑保存済・Slack未添付": 39000,
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
  check(filterTransactions(ledger.transactions, "証憑なし").length === 5, "証憑なし excludes saved and combined");
  check(filterTransactions(ledger.transactions, "証憑保存済・Slack未添付").length === 3, "saved receipts are their own status");
  check(filterTransactions(ledger.transactions, "メモなし").length === 0, "メモなし is empty");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 19, "slack urls unique");
  const detailIds = ledger.transactions.filter((tx) => tx.detailSection).map((tx) => tx.id);
  check(detailIds.length === 0, `detail sections ${detailIds.join(",")}`);
  check(JSON.stringify(detailIds) === JSON.stringify(ledger.details.map((detail) => detail.transactionId)), "details follow unhandled transactions");

  const completed = ledger.transactions.filter((tx) => tx.status === "登録完了");
  const savedReceipts = ledger.transactions.filter((tx) => tx.status === "証憑保存済・Slack未添付");
  check(completed.length === 10 && completed.every(hasEvidence), `登録完了 evidence ${completed.length}`);
  check(savedReceipts.length === 3 && savedReceipts.every((tx) => tx.drive.startsWith("https://drive.google.com/")), "saved receipts have drive urls");
  check(savedReceipts.every((tx) => tx.status !== "登録完了"), "saved receipts are not 登録完了");
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
  check(ledger.transactions.filter((tx) => String(tx.drive).startsWith("https://")).length === 8, "eight drive urls");
  const savedUrls = {
    "tx-20261105-1253-monotaro-17553": ["https://drive.google.com/file/d/1jDKF67ouM3XLEfFoST-3FCfkjUEuEZle/view?usp=drivesdk", "2026-11-07 22:05:13 JST"],
    "tx-20261105-1404-monotaro-4833": ["https://drive.google.com/file/d/15cZV1IiQHyZRbDHykorO0DEes7XByYFD/view?usp=drivesdk", "2026-11-07 22:05:13 JST"],
    "tx-20261104-2114-misumi-16614": ["https://drive.google.com/file/d/1HfunjbtjE_pIRvdzKBPvUjmkMzO55b3-/view?usp=drivesdk", "2026-11-07 22:11:16 JST"],
  };
  for (const [id, [url, savedAt]] of Object.entries(savedUrls)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(tx?.status === "証憑保存済・Slack未添付" && tx?.drive === url, `saved drive ${id}`);
    check(tx?.accountingPdfAcquiredAt === savedAt, `pdf time ${id}`);
    check(tx?.slackAttachmentStatus === "未添付", `slack not attached ${id}`);
  }
  const misumi = ledger.transactions.find((tx) => tx.id === "tx-20261104-2114-misumi-16614");
  check(misumi?.deliveryStatus === "配送中" && misumi?.expectedDeliveryDate === "2026-11-09", "misumi delivery kept");
  check(misumi?.evidenceAcquisitionStatus === "正式領収書の取得・保存確認済", "misumi 403 note replaced");

  const refund = ledger.transactions.find((tx) => tx.id === REFUND_ID);
  check(Boolean(refund), "refund included");
  check(refund?.merchant === "DANBALLACE" && refund?.datetime === "11/04 09:23", "refund identity");
  check(refund?.amount === "-¥23,960" && refund?.amountYen === -23960, "refund amount");
  check(refund?.status === REFUND_STATUS, "refund status");
  check(refund?.drive === "証憑不要", "refund drive");
  check(refund?.detailSection === false, "refund is not an unhandled detail");
  check(refund?.slack.endsWith("1793751790.582399"), "refund slack");
  check(filterTransactions(ledger.transactions, "すべて").some((tx) => tx.id === REFUND_ID), "refund stays in the full list");

  const order = ledger.transactions.find((tx) => tx.id === NEW_ORDER_ID);
  check(order?.merchant === "DANBALLACE" && order?.datetime === "11/06 15:53", "new order identity");
  check(order?.amountYen === 7160 && order?.status === "証憑なし" && order?.drive === "なし", "new order status");
  check(order?.memoStatus === "あり" && order?.memoPresent === true, "new order memo");
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
  check(publishedConfig.includes("https://script.google.com/macros/s/AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ/exec"), "config.js has the public reception url");
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
      "最新データ取得・確認: 2026-11-07 22:20:00 JST。正式領収書は今回巡回分で計3件・39,000円をDrive保存確認。Slack未添付。メモあり18件・返金不要1件。ミスミ正式領収書を確認済、納入は11/9予定。",
      "注文AB256FB3F5・16,614円（税1,510円）の正式領収書を保存確認。モノタロウ2件も保持。Slack未添付のため登録完了ではない。納入は配送中・11/9予定。",
      "UPSIDER完了通知のみでメモあり。5項目本文不要。",
      "最終取得日時",
      "2026-11-07 22:20:00（日本時間）",
      "証憑PDF取得成功",
      "2026-11-07 22:11:16（日本時間）",
      "会計証憑PDFの取得成功時刻ではない",
      "各取引詳細にメモ入力欄（用途・セグメント1・セグメント2・分類・内容）と「クリップボードにコピー」を設置しています。コピーすると改行付きで5行が入ります。ページ内の注文スクショは参照用で、UPSIDER側の証憑添付ではありません。メモ作成は停止中です。",
      "DANBALLACE返金 -¥23,960 を追加。Amazon 4件（¥14,680・¥9,300・¥2,117・¥255）を本文なしPDF添付で登録完了。DANBALLACE ¥7,160 はメモ・証憑なし。",
      "新規取引なし。Slack再確認でメモ登録が進んでいたため、MonotaRO ¥17,553・¥4,833・日進ゴム ¥17,600 は「証憑なし」に更新（会計上有効な領収書・請求書は未取得。納品書・注文確認書・スクショは対象外）。Amazon ¥2,659 は適格請求書PDFを本文なしで新規添付し登録完了。Amazon ¥2,117 はスレッドに適格請求書PDFが既にあったため再添付なし。Driveに新たに添付可能な有効証憑は上記以外なし。メモ作成は停止中。",
      "要対応の取引です。Slackスレッドの下にメモ入力欄があり、スクショがある場合はその上に並びます。",
      "メモ作成は停止中。スクショはチャット／ページ参照用であり、UPSIDER証憑ではない。このページは使い捨てではなく、毎回のチェック結果で更新するダッシュボードです。",
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
    });

    const aggHead = await page.$$eval(".agg-table th", (nodes) => nodes.map((node) => node.textContent));
    check(aggHead.join(",") === "区分,件数,金額", `agg head ${aggHead.join(",")}`);
    const txHead = await page.$$eval(".tx-table th", (nodes) => nodes.map((node) => node.textContent));
    check(txHead.join(",") === "日時,利用先,金額,内容,ステータス,メモ,Slack,Drive証憑", `tx head ${txHead.join(",")}`);
    const acquired = await page.$eval("[data-acquired-value]", (node) => ({
      text: node.textContent,
      datetime: node.getAttribute("datetime"),
    }));
    check(acquired.text === "2026-11-07 22:20:00（日本時間）", `acquired text ${acquired.text}`);
    check(acquired.datetime === "2026-11-07 22:20:00 JST", `acquired source ${acquired.datetime}`);
    const pdfSaved = await page.$eval("[data-pdf-saved-at]", (node) => node.innerText);
    check(pdfSaved.includes("2026-11-07 22:11:16（日本時間）") && !pdfSaved.includes("22:20:00"), `pdf time ${pdfSaved}`);
    check(!bodyText.includes("トークン使用量"), "token heading removed");
    check(await page.$("[data-token-usage]") === null && await page.$("[data-token-field]") === null, "token fields removed");
    const instruction = await page.$eval("[data-instruction]", (node) => ({
      rows: node.getAttribute("rows"),
      labelled: document.querySelector("label[for='instruction-text']")?.textContent || "",
      overflow: getComputedStyle(node).overflowY,
      height: node.clientHeight,
    }));
    check(instruction.rows === "4" && instruction.labelled === "指示", `instruction box ${JSON.stringify(instruction)}`);
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
    check(limitNote.includes("暫定で400字まで") && limitNote.includes("切らず"), limitNote);
    const sendButton = await page.$eval("[data-instruction-send]", (node) => ({ text: node.textContent, type: node.getAttribute("type") }));
    check(sendButton.text === "指示を送る" && sendButton.type === "button", `instruction button ${JSON.stringify(sendButton)}`);
    await page.click("[data-instruction-send]");
    const unconfigured = await page.$eval("[data-instruction-status]", (node) => node.textContent);
    check(unconfigured.includes("受付URLが未設定のため、送信していません。"), unconfigured);
    const stillUnsent = network.slice(beforeRequests).filter((url) => /mock-gas|script\.google|slack\.com\/api|hooks\.slack/.test(url));
    check(stillUnsent.length === 0, `unconfigured send stayed local ${stillUnsent.join(",")}`);
    const leaked = await page.evaluate(() => document.body.innerText.includes("[object HTML"));
    check(!leaked, "object string leaked into the page");
    const agg = await page.$$eval(".agg-table tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    check(agg[0][0] === "すべて" && agg[0][1] === "19" && agg[0][2] === "¥120,614", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "登録完了")?.[1] === "10" && agg.find((row) => row[0] === "登録完了")?.[2] === "¥48,684", "agg 登録完了");
    check(agg.find((row) => row[0] === REFUND_STATUS)?.[1] === "1" && agg.find((row) => row[0] === REFUND_STATUS)?.[2] === "-¥23,960", "agg refund");
    check(agg.find((row) => row[0] === "メモなし")?.[1] === "0" && agg.find((row) => row[0] === "メモなし")?.[2] === "¥0", "agg メモなし");
    check(agg.find((row) => row[0] === "証憑なし")?.[1] === "5" && agg.find((row) => row[0] === "証憑なし")?.[2] === "¥56,890", "agg 証憑なし");
    check(agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[1] === "3" && agg.find((row) => row[0] === "証憑保存済・Slack未添付")?.[2] === "¥39,000", "agg saved receipts");
    check(agg.find((row) => row[0] === "メモ・証憑なし")?.[1] === "0" && agg.find((row) => row[0] === "メモ・証憑なし")?.[2] === "¥0", "agg メモ・証憑なし");
    const savedTone = await page.$eval("[data-tx-id='tx-20261105-1253-monotaro-17553'] [data-label='ステータス'] .status", (node) => node.className);
    check(savedTone.includes("warning") && !savedTone.includes("success"), `saved tone ${savedTone}`);
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
      check(found.ai === "AIがメモを追加する", "ai label");
      check(found.note.includes("バックエンド接続が必要"), "backend note");
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
    await page.$eval(`[data-detail="${aiId}"] [data-memo-field="purpose"]`, (input) => {
      input.value = "段ボールの追加注文";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = network.length;
    const popups = [];
    browser.on("targetcreated", (target) => popups.push(target.url()));
    await page.evaluate(() => {
      window.__opened = [];
      window.open = (...args) => {
        window.__opened.push(args);
        return null;
      };
    });
    await page.click(`[data-detail="${aiId}"] [data-ai]`);
    await page.waitForSelector(`[data-request="${aiId}"]`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const newRequests = network.slice(before);
    check(network.some((url) => url.includes("/js/result.js")), "published page loads result.js");
    check(newRequests.length === 0, `network after AI button: ${newRequests.join(", ")}`);
    check(popups.length === 0, `popup ${popups.join(",")}`);
    const opened = await page.evaluate(() => window.__opened);
    check(opened.length === 0, "window.open was called");
    const requestText = await page.$eval(`[data-request="${aiId}"]`, (node) => node.innerText);
    check(requestText.includes(aiId), "request shows transaction id");
    check(requestText.includes("https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1793948039.836289"), "request shows slack");
    check(requestText.includes("用途：段ボールの追加注文"), "request shows edited memo");
    check(requestText.includes("セグメント1：AIハンド"), "request seg1");
    check(requestText.includes("分類：消耗品"), "request category");
    check(requestText.includes("内容：YUBI梱包用ダンボール80サイズ 50枚"), "request content");
    check(requestText.includes("実行は行われていません"), "request not executed");
    check(!/投稿しました|実行しました|追加しました|連携しました/.test(requestText), `false success: ${requestText}`);
    const stored = await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1"));
    const parsed = JSON.parse(stored);
    const saved = parsed.requests[aiId];
    check(parsed.version === 3, "storage version");
    check(saved.status === "未実行", "stored status");
    check(saved.requestId === null, "unset request has no id");
    check(typeof saved.updatedAt === "string", "stored updatedAt");
    check(saved.memoLines.length === 5, "stored five lines");
    check(!("amount" in saved) && !("merchant" in saved), "stored request omits amount and merchant");
    check(!/token|secret|password|authorization|api[_-]?key/i.test(stored), "stored secrets");

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    const restored = await page.$eval(`[data-request="${aiId}"]`, (node) => node.innerText);
    check(restored.includes("用途：段ボールの追加注文"), "request restored");
    check(restored.includes("編集中の5行と保持中の依頼は違います"), "mismatch after reload");
    const purposeAfterReload = await page.$eval(`[data-detail="${aiId}"] [data-memo-field="purpose"]`, (input) => input.value);
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
    check(mobile.buttons[0].text === "クリップボードにコピー" && mobile.buttons[1].text === "AIがメモを追加する", "button order");
    check(mobile.buttons[1].left >= mobile.buttons[0].right - 1, `AI button not to the right ${JSON.stringify(mobile.buttons)}`);
    check(Math.abs(mobile.buttons[0].top - mobile.buttons[1].top) < 2, "buttons share a row");

    await page.setViewport({ width: 320, height: 700 });
    const narrow = await page.evaluate((id) => {
      const buttons = [...document.querySelectorAll(`[data-detail="${id}"] .memo-actions button`)].map((button) => button.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sideBySide: buttons[1].left >= buttons[0].right - 1 && Math.abs(buttons[0].top - buttons[1].top) < 2,
      };
    }, copyId);
    check(narrow.overflow <= 1, `narrow overflow ${narrow.overflow}`);
    check(narrow.sideBySide, "buttons stay side by side at 320px");

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
    await page.evaluate((id) => document.querySelector(`[data-request="${id}"]`).scrollIntoView({ block: "center" }), aiId);
    await page.screenshot({ path: "/tmp/upsider-request.png" });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/upsider-mobile-top.png" });
    await instructionPostChecks(browser, page.url());
    await connectionChecks(browser, page.url());
    await resultFlowChecks(browser, page.url());
  } finally {
    await browser.close();
  }
}

function storedRequest(tx, fields) {
  const base = buildExecutionRequest({
    transactionId: tx.id,
    slackThread: tx.slack,
    memo: initialMemo(tx.content),
    savedAt: "2026-11-07T00:10:00.000Z",
  });
  return { ...base, ...fields };
}

async function reloadReady(page) {
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready='true']");
}

async function clearStoredRequests(page) {
  await page.evaluate(() => localStorage.removeItem("upsider-monitor.execution-requests.v1"));
  await reloadReady(page);
  gas.hits = [];
  gas.gets = [];
  gas.results = {};
}

async function dropRequest(page, id) {
  await page.evaluate((key) => {
    const saved = JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1"));
    delete saved.requests[key];
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify(saved));
  }, id);
  await reloadReady(page);
}

async function resultFlowChecks(browser, base) {
  gas.configUrl = new URL("/mock-gas", base).toString();
  gas.behavior = "ok";
  gas.hits = [];
  gas.gets = [];
  gas.results = {};
  const page = await browser.newPage();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("script.google.com") || url.includes("AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ")) {
      failures.push(`live reception url was contacted: ${request.method()} ${url}`);
    }
  });
  page.on("pageerror", (error) => failures.push(`pageerror ${error.message}`));
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.evaluate(() => localStorage.removeItem("upsider-monitor.execution-requests.v1"));
  await reloadReady(page);
  gas.hits = [];
  gas.gets = [];
  gas.results = {};
  const statusOf = (id) => page.$eval(`[data-request="${id}"]`, (node) => node.dataset.requestStatus).catch(() => null);
  const reqId = (id) => page.evaluate((key) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[key].requestId, id);
  const openId = NEW_ORDER_ID;

  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "受付済み", {}, openId);
  const acceptedLine = await page.$eval(`[data-request="${openId}"] .request-state`, (node) => node.textContent);
  check(acceptedLine.startsWith("受付済み"), `shows 受付済み before the first check ${acceptedLine}`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  const processingLine = await page.$eval(`[data-request="${openId}"] .request-state`, (node) => node.textContent);
  check(processingLine.startsWith("処理中"), `shows 処理中 once checking ${processingLine}`);
  const processingBg = await page.$eval(`[data-request="${openId}"]`, (node) => getComputedStyle(node).backgroundColor);
  check(processingBg === "rgb(232, 241, 251)", `processing info-bg ${processingBg}`);
  const idA = await reqId(openId);
  check(gas.hits.length === 1 && JSON.parse(new URLSearchParams(gas.hits[0].body).get("payload")).requestId === idA, "one POST with request id");
  const posted = JSON.parse(new URLSearchParams(gas.hits[0].body).get("payload"));
  check(Object.keys(posted).sort().join(",") === "memoLines,requestId,savedAt,slackThread,transactionId", "result flow keeps the 5 payload fields");
  const msg = "19:13（日本時間）に実行して処理済みです。\nそのスレッドには既に同じ5項目のメモと、UPSIDERの「決済メモを追加しました！」の返信があり、重複防止のため新規投稿はしていません。<b>x</b>";
  gas.results[idA] = [{ state: "pending" }, { state: "pending" }, { state: "done", result: { status: "noop", finishedAt: "2026-11-06T10:13:05.000Z", message: msg } }];
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "変更なし", { timeout: 10000 }, openId);
  const card = await page.$eval(`[data-request="${openId}"]`, (node) => ({
    text: node.innerText,
    bg: getComputedStyle(node).backgroundColor,
    html: node.querySelector("[data-request-result]").innerHTML,
  }));
  check(card.text.includes("変更なし：2026/11/06 19:13（日本時間）に実行。変更はありませんでした。"), `headline ${card.text.slice(0, 160)}`);
  check(card.text.includes("重複防止のため新規投稿はしていません。"), "message shown");
  check(card.text.includes("最終確認:"), "last check time shown");
  check(card.text.includes(idA) && card.text.includes(openId), "request id and tx kept");
  check(!card.html.includes("<b>"), "message rendered as text, not HTML");
  check(card.bg === "rgb(231, 246, 238)", `success-bg ${card.bg}`);
  const getsA = gas.gets.filter((item) => item.requestId === idA);
  check(getsA.length === 3, `3 GETs until done (${getsA.length})`);
  check(getsA.every((item) => item.params.join(",") === "op,requestId"), "GET params only op,requestId");
  await sleep(600);
  check(gas.gets.filter((item) => item.requestId === idA).length === 3, "no GET after terminal");
  const postsAfter = gas.hits.length;
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await sleep(300);
  check(gas.hits.length === postsAfter, "terminal result not POSTed again");

  await clearStoredRequests(page);
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  const idB = await reqId(openId);
  gas.results[idB] = [{ state: "done", result: { status: "failed", finishedAt: "2026-11-06T10:20:00Z", message: "UPSIDERの画面を開けず、メモを追加できませんでした。" } }];
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "失敗", { timeout: 10000 }, openId);
  const failCard = await page.$eval(`[data-request="${openId}"]`, (node) => ({
    text: node.innerText,
    bg: getComputedStyle(node).backgroundColor,
    border: getComputedStyle(node).borderTopColor,
  }));
  check(failCard.text.includes("失敗：2026/11/06 19:20（日本時間）に実行。実行に失敗しました。"), `fail headline ${failCard.text.slice(0, 120)}`);
  check(failCard.bg === "rgb(253, 236, 236)", `danger-bg ${failCard.bg}`);
  check(failCard.border === "rgb(159, 45, 45)", `danger border ${failCard.border}`);
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  const idB2 = await reqId(openId);
  check(idB2 !== idB && JSON.parse(new URLSearchParams(gas.hits.at(-1).body).get("payload")).requestId === idB2, "retry after failure uses new id");

  await clearStoredRequests(page);
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  const idC = await reqId(openId);
  gas.results[idC] = [
    { requestId: "11111111-2222-4333-8444-555555555555", state: "done", result: { status: "success", finishedAt: "2026-11-06T10:00:00Z", message: "他人の結果" } },
    { raw: "<html>bad</html>" },
    { state: "done", result: { status: "success", finishedAt: "2026-11-06T10:00:00Z", message: "x", extra: 1 } },
    { state: "unknown" },
  ];
  await sleep(2000);
  const waitText = await page.$eval(`[data-request="${openId}"]`, (node) => node.innerText);
  check((await statusOf(openId)) === "処理中", `mismatched/invalid/unknown keep 処理中 (${await statusOf(openId)})`);
  check(!waitText.includes("他人の結果") && !waitText.includes("成功："), "foreign result not shown");
  check(waitText.includes("記録を返していません"), "unknown note shown");

  const storedNoopId = "tx-20261105-1253-monotaro-17553";
  const storedFailId = "tx-20261105-1404-monotaro-4833";
  const seededNoopId = randomUUID();
  const seededFailId = randomUUID();
  const seededNoop = storedRequest(ledger.transactions.find((tx) => tx.id === storedNoopId), {
    status: "変更なし",
    requestId: seededNoopId,
    acceptedAt: "2026-11-07T00:10:00.000Z",
    pollAttempts: 3,
    lastCheckedAt: "2026-11-07T00:10:30.000Z",
    result: { status: "noop", finishedAt: "2026-11-06T10:13:05.000Z", message: "変更はありませんでした。" },
  });
  const seededFail = storedRequest(ledger.transactions.find((tx) => tx.id === storedFailId), {
    status: "処理中",
    requestId: seededFailId,
    acceptedAt: new Date().toISOString(),
    pollAttempts: 1,
    lastCheckedAt: new Date().toISOString(),
    result: null,
  });
  gas.results[idC] = [{ state: "pending" }];
  await page.evaluate((extra) => {
    const saved = JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1"));
    Object.assign(saved.requests, extra);
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify(saved));
  }, { [storedNoopId]: seededNoop, [storedFailId]: seededFail });
  const before = gas.gets.length;
  await reloadReady(page);
  check((await statusOf(openId)) === "処理中", "waiting detail restored");
  const restored = JSON.parse(await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1")));
  check(restored.requests[storedNoopId].status === "変更なし" && restored.requests[storedFailId].status === "処理中", "states restored");
  check(restored.requests[storedFailId].requestId === seededFailId && restored.requests[storedFailId].requestId !== idB, "superseded fail id is not stored");
  await sleep(1000);
  const after = gas.gets.slice(before);
  check(!after.some((item) => item.requestId === seededNoopId || item.requestId === idB), "terminal / superseded ids not polled after reload");
  check(after.some((item) => item.requestId === idC), "waiting request resumed after reload");
  check(restored.version === 3 && restored.requests[storedNoopId].result.status === "noop", "stored v3 with result");
  check(!/token|secret|password|authorization|api[_-]?key/i.test(JSON.stringify(restored)), "no secrets in storage");

  await page.evaluate((id) => {
    const saved = JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1"));
    saved.requests[id].acceptedAt = new Date(Date.now() - 31 * 60000).toISOString();
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify(saved));
  }, openId);
  await reloadReady(page);
  check((await statusOf(openId)) === "確認停止", "old wait becomes 確認停止");
  const stoppedGets = gas.gets.filter((item) => item.requestId === idC).length;
  await sleep(500);
  check(gas.gets.filter((item) => item.requestId === idC).length === stoppedGets, "no auto polling when stopped");
  gas.results[idC] = [{ state: "done", result: { status: "success", finishedAt: "2026-11-06T10:30:00Z", message: "メモを追加しました。" } }];
  await page.click(`[data-recheck="${openId}"]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "成功", { timeout: 5000 }, openId);
  check(gas.gets.filter((item) => item.requestId === idC).length === stoppedGets + 1, "recheck = exactly one GET");
  const successText = await page.$eval(`[data-request="${openId}"]`, (node) => node.innerText);
  check(successText.includes("成功：2026/11/06 19:30（日本時間）に実行。処理済みです。"), `success headline ${successText.slice(0, 80)}`);
  check(successText.includes("メモを追加しました。"), "success message from server");

  await page.setViewport({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow <= 1, `result mobile overflow ${overflow}`);
  await page.setViewport({ width: 1280, height: 900 });
  fs.mkdirSync("/opt/cursor/artifacts", { recursive: true });
  await page.evaluate((id) => document.querySelector(`[data-request="${id}"]`).scrollIntoView({ block: "center" }), openId);
  await page.screenshot({ path: "/opt/cursor/artifacts/result-success.png" });
  await page.evaluate((id) => {
    const saved = JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1"));
    saved.requests[id].status = "変更なし";
    saved.requests[id].result = { status: "noop", finishedAt: "2026-11-06T10:13:05.000Z", message: "重複防止のため新規投稿はしていません。" };
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify(saved));
  }, openId);
  await reloadReady(page);
  await page.evaluate((id) => document.querySelector(`[data-request="${id}"]`).scrollIntoView({ block: "center" }), openId);
  await page.screenshot({ path: "/opt/cursor/artifacts/result-noop.png" });
  await page.evaluate((id) => {
    const saved = JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1"));
    saved.requests[id].status = "失敗";
    saved.requests[id].result = { status: "failed", finishedAt: "2026-11-06T10:20:00.000Z", message: "UPSIDERの画面を開けず、メモを追加できませんでした。" };
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify(saved));
  }, openId);
  await reloadReady(page);
  await page.evaluate((id) => document.querySelector(`[data-request="${id}"]`).scrollIntoView({ block: "center" }), openId);
  await page.screenshot({ path: "/opt/cursor/artifacts/result-failed.png" });

  gas.configUrl = "";
  const traffic = gas.gets.length + gas.hits.length;
  await reloadReady(page);
  await sleep(500);
  check(gas.gets.length + gas.hits.length === traffic, "no GAS traffic when unconfigured");
  await page.close();
}

async function instructionPostChecks(browser, base) {
  const previous = gas.configUrl;
  gas.configUrl = new URL("/mock-gas", base).toString();
  gas.behavior = "ok";
  gas.hits = [];
  const page = await browser.newPage();
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("script.google.com") || url.includes("AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ")) {
      failures.push(`live reception url was contacted: ${request.method()} ${url}`);
    }
  });
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector("[data-instruction-send]");
  gas.hits = [];
  await page.click("[data-instruction-send]");
  check(gas.hits.length === 0, "blank instruction is not posted");
  check((await page.$eval("[data-instruction-status]", (node) => node.textContent)).includes("空の指示は送れません。"), "blank instruction");
  await page.$eval("[data-instruction]", (node) => { node.value = "あ".repeat(401); });
  await page.click("[data-instruction-send]");
  check(gas.hits.length === 0, "long instruction is not posted");
  check((await page.$eval("[data-instruction]", (node) => node.value)).length === 401, "over-limit text is not cut");
  check((await page.$eval("[data-instruction-status]", (node) => node.textContent)).includes("400字を超える指示は送れません。"), "limit is shown");
  await page.$eval("[data-instruction]", (node) => { node.value = "段ボールを確認"; });
  await page.evaluate(() => {
    const button = document.querySelector("[data-instruction-send]");
    button.click();
    button.click();
  });
  await page.waitForFunction(() => document.querySelector("[data-instruction-status]").textContent.includes("受付済み"));
  check(gas.hits.length === 1, `instruction posts ${gas.hits.length}`);
  const body = JSON.parse(new URLSearchParams(gas.hits[0].body).get("payload"));
  check(Object.keys(body).sort().join(",") === "kind,requestId,savedAt,text", `instruction keys ${Object.keys(body)}`);
  check(body.kind === "instruction" && body.text === "段ボールを確認", `instruction body ${JSON.stringify(body)}`);
  check(!("memoLines" in body) && !("transactionId" in body) && !("slackThread" in body), "instruction is not a memo payload");
  const status = await page.$eval("[data-instruction-status]", (node) => node.textContent);
  check(status.includes("受付済み") && status.includes("作業は完了していません") && status.includes("確認後に実行"), status);
  check(!/実行しました|登録しました|完了しました/.test(status), `false completion ${status}`);
  await page.click("[data-instruction-send]");
  await new Promise((resolve) => setTimeout(resolve, 200));
  check(gas.hits.length === 1, "accepted instruction is not posted again");
  await page.$eval("[data-instruction]", (node) => { node.value = "段ボールを再確認"; });
  gas.behavior = "500";
  await page.click("[data-instruction-send]");
  await page.waitForFunction(() => document.querySelector("[data-instruction-status]").textContent.includes("エラー"));
  const failedId = JSON.parse(new URLSearchParams(gas.hits.at(-1).body).get("payload")).requestId;
  gas.behavior = "ok";
  await page.click("[data-instruction-send]");
  await page.waitForFunction(() => document.querySelector("[data-instruction-status]").textContent.includes("受付済み"));
  const retried = JSON.parse(new URLSearchParams(gas.hits.at(-1).body).get("payload")).requestId;
  check(failedId === retried, `instruction retry id ${failedId} ${retried}`);
  await page.close();
  gas.configUrl = previous;
  gas.behavior = "ok";
  gas.hits = [];
}

async function connectionChecks(browser, base) {
  gas.configUrl = new URL("/mock-gas", base).toString();
  gas.behavior = "ok";
  gas.hits = [];
  const page = await browser.newPage();
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes("script.google.com") || url.includes("AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ")) {
      failures.push(`live reception url was contacted: ${request.method()} ${url}`);
    }
    if (request.method() !== "GET" && request.method() !== "POST") {
      failures.push(`unexpected method ${request.method()} ${url}`);
    }
  });
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready='true']");
  const note = await page.$eval(".exec-note", (node) => node.textContent);
  check(note.includes("受付API"), "configured note");

  const openId = NEW_ORDER_ID;
  const openTx = ledger.transactions.find((tx) => tx.id === openId);
  const openLines = formatMemoText(initialMemo(openTx.content)).split("\n");
  await page.evaluate((id, slack, memoLines) => {
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify({
      version: 1,
      requests: {
        [id]: {
          transactionId: id,
          slackThread: slack,
          memoLines,
          savedAt: "2026-11-06T00:00:00.000Z",
          status: "未実行",
        },
      },
    }));
  }, openId, openTx.slack, openLines);
  await reloadReady(page);
  const legacyText = await page.$eval(`[data-request="${openId}"]`, (node) => node.innerText);
  check(legacyText.includes(openLines[0]), "migrated memo visible");
  check(legacyText.includes("実行は行われていません"), "migrated request stays unsent");
  const legacyStored = await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1"));
  check(JSON.parse(legacyStored).version === 1, "reload does not rewrite the old cache");

  const heldId = "tx-20261105-1357-nisshin-17600";
  const heldTx = ledger.transactions.find((tx) => tx.id === heldId);
  const heldLines = formatMemoText(initialMemo(heldTx.content)).split("\n");
  await page.evaluate((id, slack, memoLines) => {
    localStorage.setItem("upsider-monitor.execution-requests.v1", JSON.stringify({
      version: 1,
      requests: {
        [id]: {
          transactionId: id,
          slackThread: slack,
          memoLines,
          savedAt: "2026-11-06T00:00:00.000Z",
          status: "未実行",
        },
      },
    }));
  }, heldId, heldTx.slack, heldLines);
  await reloadReady(page);
  const heldBefore = JSON.parse(await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1")));
  check(heldBefore.version === 1, "held v1 cache stays unsent across reload");
  check(await page.$(`[data-request="${heldId}"]`) === null, "held request is not rendered without a detail");
  check(heldBefore.requests[heldId].status === "未実行" && heldBefore.requests[heldId].memoLines.join("\n") === heldLines.join("\n"), "held memo kept before sends");

  gas.hits = [];
  await page.evaluate((id) => {
    const button = document.querySelector(`[data-detail="${id}"] [data-ai]`);
    button.click();
    button.click();
  }, openId);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  check(gas.hits.length === 1, `double click posts ${gas.hits.length}`);
  const hit = gas.hits[0];
  check(hit.method === "POST", "gas method");
  check(hit.contentType.startsWith("application/x-www-form-urlencoded"), `content type ${hit.contentType}`);
  check(!hit.headers.authorization && !Object.keys(hit.headers).some((key) => key.startsWith("x-")), "no custom headers");
  const body = JSON.parse(new URLSearchParams(hit.body).get("payload"));
  check(body.transactionId === openId, "posted id");
  check(body.slackThread === openTx.slack, "posted slack matches ledger");
  check(/^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/.test(body.slackThread), "posted thread pattern");
  check(Array.isArray(body.memoLines) && body.memoLines.length === 5, "posted five lines");
  check(body.memoLines[0] === `用途：${openTx.content}` && body.memoLines[1] === "セグメント1：AIハンド", `posted memo ${body.memoLines}`);
  check(typeof body.savedAt === "string" && !Number.isNaN(Date.parse(body.savedAt)), "posted savedAt");
  check(typeof body.requestId === "string" && body.requestId.length > 0, "posted request id");
  check(!("amount" in body) && !("merchant" in body) && !("memo" in body), "posted body omits amount, merchant, and joined memo");
  const afterAccept = gas.hits.length;
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  check(gas.hits.length === afterAccept, "accepted memo is not sent again");

  await dropRequest(page, openId);
  gas.hits = [];
  gas.behavior = "html";
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, openId);
  const failedId = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id].requestId, openId);
  gas.behavior = "ok";
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "処理中", {}, openId);
  const retriedId = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id].requestId, openId);
  check(failedId === retriedId, "retry keeps request id");
  const retryBodies = gas.hits.map((item) => JSON.parse(new URLSearchParams(item.body).get("payload"))).filter((item) => item.transactionId === openId).map((item) => item.requestId);
  check(retryBodies.length === 2 && retryBodies[0] === retryBodies[1], `retry ids ${retryBodies}`);

  await dropRequest(page, openId);
  gas.behavior = "reject";
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, openId);

  gas.behavior = "mismatch";
  const hitsBeforeMismatch = gas.hits.length;
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  const mismatchStarted = Date.now();
  while (gas.hits.length < hitsBeforeMismatch + 1 && Date.now() - mismatchStarted < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(gas.hits.length === hitsBeforeMismatch + 1, "mismatched response is still a retry post");
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, openId);

  await dropRequest(page, openId);
  gas.behavior = "500";
  await page.click(`[data-detail="${openId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, openId);

  const kept = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id], heldId);
  check(kept.memoLines.join("\n") === heldLines.join("\n"), "later saves keep the old held memo");
  check(kept.status === "未実行", "old held request was not sent");
  check(kept.requestId === null, "old held request stays unnumbered");
  check(!gas.hits.some((item) => JSON.parse(new URLSearchParams(item.body).get("payload")).transactionId === heldId), "held transaction was not posted");
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
