import { createHash } from "node:crypto";
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
const gas = { configUrl: "", behavior: "ok", hits: [] };

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
      const source = `window.UPSIDER_CONFIG = { gasUrl: ${JSON.stringify(gas.configUrl)} };\n`;
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(source);
      return;
    }
    if (pathname === "/mock-gas") {
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
      res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function assertLedger() {
  check(ledger.transactions.length === 19, "ledger has 19 transactions");
  check(ledger.asOf === "2026-11-06 19:25 Asia/Tokyo", "asOf");
  check(ledger.lead.includes("2026-11-06 19:25 Asia/Tokyo"), "lead asOf");
  check(ledger.lead.includes("19件"), "lead count");
  const counts = {
    "登録完了": 9,
    [REFUND_STATUS]: 1,
    "メモなし": 3,
    "証憑なし": 4,
    "メモ・証憑なし": 2,
    "証憑不一致": 0,
  };
  check(JSON.stringify(FILTERS.slice(1)) === JSON.stringify(Object.keys(counts)), "filters match counted statuses");
  for (const [status, count] of Object.entries(counts)) {
    check(countOf(ledger.transactions, status) === count, `${status} count ${countOf(ledger.transactions, status)} !== ${count}`);
  }
  check(FILTERS.slice(1).reduce((total, status) => total + countOf(ledger.transactions, status), 0) === 19, "status counts sum to 19");
  const sums = {
    "登録完了": 46025,
    [REFUND_STATUS]: -23960,
    "メモなし": 25045,
    "証憑なし": 48744,
    "メモ・証憑なし": 24760,
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
  check(filterTransactions(ledger.transactions, "証憑なし").length === 4, "証憑なし excludes メモ・証憑なし");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 19, "slack urls unique");
  const detailIds = ledger.transactions.filter((tx) => tx.detailSection).map((tx) => tx.id);
  check(detailIds.length === 5, "5 detail sections");
  check(JSON.stringify(detailIds) === JSON.stringify(ledger.details.map((detail) => detail.transactionId)), "details follow unhandled transactions");

  const completed = ledger.transactions.filter((tx) => tx.status === "登録完了");
  const evidenced = ledger.transactions.filter(hasEvidence);
  check(completed.length === 9 && evidenced.length === 9, `evidence pair ${completed.length}/${evidenced.length}`);
  check(completed.every(hasEvidence), "登録完了 without evidence");
  check(evidenced.every((tx) => tx.status === "登録完了"), "evidence without 登録完了");
  check(Object.keys(EVIDENCE_URLS).length === 4, "four evidence urls");
  for (const [id, url] of Object.entries(EVIDENCE_URLS)) {
    const tx = ledger.transactions.find((row) => row.id === id);
    check(Boolean(tx), `missing evidenced tx ${id}`);
    check(tx?.status === "登録完了", `evidenced status ${id}`);
    check(tx?.drive === url, `drive url ${id}`);
    check(tx?.detailSection === false, `evidenced leaves unhandled details ${id}`);
    check(!ledger.details.some((detail) => detail.transactionId === id), `detail removed ${id}`);
  }
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2124-amazon-14680")?.slack.endsWith("1793881469.106739"), "slack 14680");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2312-amazon-9300")?.slack.endsWith("1793887975.184129"), "slack 9300");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261105-2312-amazon-2117")?.slack.endsWith("1793887975.859849"), "slack 2117");
  check(ledger.transactions.find((tx) => tx.id === "tx-20261106-0113-amazon-255")?.slack.endsWith("1793895200.333029"), "slack 255");
  check(ledger.transactions.filter((tx) => String(tx.drive).startsWith("https://")).length === 4, "only four drive urls");

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
  check(order?.amountYen === 7160 && order?.status === "メモ・証憑なし" && order?.drive === "なし", "new order status");
  check(order?.slack.endsWith("1793948039.836289"), "new order slack");
  check(order?.detailSection === true, "new order detail flag");
  const orderDetail = ledger.details.find((detail) => detail.transactionId === NEW_ORDER_ID);
  check(Boolean(orderDetail), "new order detail");
  check(orderDetail?.properties.some((item) => item.label === "Drive証憑" && item.value === "なし"), "new order drive detail");
  check(!ledger.details.some((detail) => detail.transactionId === REFUND_ID), "refund excluded from unhandled details");

  const memoByKey = {
    "17553": "パーツケース4段×2・ゴム切はさみ・L型カッターなど工具7点",
    "17600": "HyperVシート PX-10H 15 非耐油 W270×L270×H1.5mm ×5",
    "4833": "チャック付き袋 M8G×2・M8I×1",
    "2659": "NEEWER 六角ドライバー4本セット",
    "7160": "新規注文",
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
    + fs.readFileSync(path.join(root, "js/logic.js"), "utf8");
  check(!/hooks\.slack|api\.slack|chat\.postMessage|xox[baprs]-/.test(sources), "no slack posting or token");
  check(!fs.existsSync(path.join(root, ".github")), "no GitHub Actions");
  const gasSource = fs.readFileSync(path.join(root, "gas/Code.gs"), "utf8");
  check(gasSource.includes("【UPSIDERメモ登録依頼】"), "gas title");
  check(gasSource.includes("postSlack_("), "gas uses existing postSlack_");
  check(!/SpreadsheetApp|getActiveSpreadsheet|UrlFetchApp|hooks\.slack\.com/.test(gasSource), "gas does not touch sheets or embed a webhook");
  const ignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  check(!/^config\.js$/m.test(ignore), "published config.js is not gitignored");
  const publishedConfig = fs.readFileSync(path.join(root, "config.js"), "utf8");
  check(publishedConfig.includes("https://script.google.com/macros/s/AKfycbwJp3mFMSCeX5uxXEuqxWAexx8VRsQMTcA5GnTbriNh-vCayiy1b2slo_cZ5YFlgDHdYQ/exec"), "config.js has the public reception url");
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
  const sample = ledger.transactions.find((tx) => tx.memoKey === "2659");
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
      "最終更新: 2026-11-06 19:25 Asia/Tokyo。11月以降のAIハンド決済用取引19件（返金1件を含む）のステータスです。",
      "各取引詳細にメモ入力欄（用途・セグメント1・セグメント2・分類・内容）と「クリップボードにコピー」を設置しました。",
      "日進ゴム ¥17,600 の誤添付 nisshin-4735.png を削除しました。",
      "DANBALLACEの返金 -¥23,960（11/04 09:23）は除外せず、メモ・証憑が不要な返金として追加しました。",
      "登録完了9件はすべて証憑ありで、証憑がある取引はすべて登録完了です。",
      "メモ入力欄とコピー機能を復活済み。",
      "要対応の取引です。Slackスレッドの下にメモ入力欄があり、スクショがある場合はその上に並びます。",
      "内容: 新規注文。返信はなく、メモ・証憑はありません。Driveを検索しても証憑は見つかりませんでした。",
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
    check(txHead.join(",") === "日時,利用先,金額,内容,ステータス,Slack,Drive証憑", `tx head ${txHead.join(",")}`);
    const leaked = await page.evaluate(() => document.body.innerText.includes("[object HTML"));
    check(!leaked, "object string leaked into the page");
    const agg = await page.$$eval(".agg-table tbody tr", (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent)));
    check(agg[0][0] === "すべて" && agg[0][1] === "19" && agg[0][2] === "¥120,614", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "登録完了")?.[1] === "9" && agg.find((row) => row[0] === "登録完了")?.[2] === "¥46,025", "agg 登録完了");
    check(agg.find((row) => row[0] === REFUND_STATUS)?.[1] === "1" && agg.find((row) => row[0] === REFUND_STATUS)?.[2] === "-¥23,960", "agg refund");
    check(agg.find((row) => row[0] === "メモなし")?.[1] === "3" && agg.find((row) => row[0] === "メモなし")?.[2] === "¥25,045", "agg メモなし");
    check(agg.find((row) => row[0] === "証憑なし")?.[1] === "4" && agg.find((row) => row[0] === "証憑なし")?.[2] === "¥48,744", "agg 証憑なし");
    check(agg.find((row) => row[0] === "メモ・証憑なし")?.[1] === "2" && agg.find((row) => row[0] === "メモ・証憑なし")?.[2] === "¥24,760", "agg メモ・証憑なし");
    check(agg.find((row) => row[0] === "証憑不一致")?.[1] === "0", "agg zero mismatch");

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
    check(details.length === 5, `details ${details.length}`);
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
    check(loaded.length === 4, `image count ${loaded.length}`);
    check(loaded.every((img) => img.width > 0 && !img.error), `images decoded ${JSON.stringify(loaded)}`);

    const copyId = "tx-20261105-1253-monotaro-17553";
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
    check(requestText.includes("内容：新規注文"), "request content");
    check(requestText.includes("実行は行われていません"), "request not executed");
    check(!/投稿しました|実行しました|追加しました|連携しました/.test(requestText), `false success: ${requestText}`);
    const stored = await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1"));
    const parsed = JSON.parse(stored);
    const saved = parsed.requests[aiId];
    check(parsed.version === 2, "storage version");
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
    check(purposeAfterReload === "新規注文", "form resets to initial value");

    await page.evaluate(() => {
      document.execCommand = () => false;
      navigator.clipboard.writeText = () => Promise.reject(new Error("denied"));
      navigator.clipboard.write = () => Promise.reject(new Error("denied"));
    });
    const fallbackId = "tx-20261105-1703-amazon-2659";
    await page.click(`[data-detail="${fallbackId}"] [data-copy]`);
    await page.waitForSelector(`[data-detail="${fallbackId}"] [data-copy-fallback]:not([hidden])`);
    const fallbackValue = await page.$eval(`[data-detail="${fallbackId}"] [data-copy-fallback-text]`, (node) => node.value);
    const fallbackHiddenStatus = await page.$eval(`[data-detail="${fallbackId}"] [data-copy-status]`, (node) => node.hidden);
    check(fallbackHiddenStatus, "failed copy does not claim success");
    check(fallbackValue.startsWith("用途：NEEWER 六角ドライバー4本セット\n"), `fallback text ${fallbackValue}`);

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
    await page.evaluate(() => document.querySelector('[data-detail="tx-20261105-1253-monotaro-17553"]').scrollIntoView());
    await page.screenshot({ path: "/tmp/upsider-desktop-memo.png" });
    await page.evaluate((id) => document.querySelector(`[data-request="${id}"]`).scrollIntoView({ block: "center" }), aiId);
    await page.screenshot({ path: "/tmp/upsider-request.png" });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/upsider-mobile-top.png" });
    await connectionChecks(browser, page.url());
  } finally {
    await browser.close();
  }
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

  const legacyId = "tx-20261105-1357-nisshin-17600";
  const legacyTx = ledger.transactions.find((tx) => tx.id === legacyId);
  const legacyLines = formatMemoText(initialMemo(legacyTx.content)).split("\n");
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
  }, legacyId, legacyTx.slack, legacyLines);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector("body[data-ready='true']");
  const legacyText = await page.$eval(`[data-request="${legacyId}"]`, (node) => node.innerText);
  check(legacyText.includes(legacyLines[0]), "migrated memo visible");
  check(legacyText.includes("実行は行われていません"), "migrated request stays unsent");
  const legacyStored = await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1"));
  check(JSON.parse(legacyStored).version === 1, "reload does not rewrite the old cache");

  const sendId = NEW_ORDER_ID;
  gas.hits = [];
  await page.evaluate((id) => {
    const button = document.querySelector(`[data-detail="${id}"] [data-ai]`);
    button.click();
    button.click();
  }, sendId);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "受付済み", {}, sendId);
  check(gas.hits.length === 1, `double click posts ${gas.hits.length}`);
  const hit = gas.hits[0];
  check(hit.method === "POST", "gas method");
  check(hit.contentType.startsWith("application/x-www-form-urlencoded"), `content type ${hit.contentType}`);
  check(!hit.headers.authorization && !Object.keys(hit.headers).some((key) => key.startsWith("x-")), "no custom headers");
  const body = JSON.parse(new URLSearchParams(hit.body).get("payload"));
  const sendTx = ledger.transactions.find((tx) => tx.id === sendId);
  check(body.transactionId === sendId, "posted id");
  check(body.slackThread === sendTx.slack, "posted slack matches ledger");
  check(/^https:\/\/app\.slack\.com\/client\/T0AS9K3390T\/C0BG07UF1EY\/thread\/C0BG07UF1EY-\d{10}\.\d{6}$/.test(body.slackThread), "posted thread pattern");
  check(Array.isArray(body.memoLines) && body.memoLines.length === 5, "posted five lines");
  check(body.memoLines[0] === `用途：${sendTx.content}` && body.memoLines[1] === "セグメント1：AIハンド", `posted memo ${body.memoLines}`);
  check(typeof body.savedAt === "string" && !Number.isNaN(Date.parse(body.savedAt)), "posted savedAt");
  check(typeof body.requestId === "string" && body.requestId.length > 0, "posted request id");
  check(!("amount" in body) && !("merchant" in body) && !("memo" in body), "posted body omits amount, merchant, and joined memo");
  const acceptedId = body.requestId;
  const afterAccept = gas.hits.length;
  await page.click(`[data-detail="${sendId}"] [data-ai]`);
  await new Promise((resolve) => setTimeout(resolve, 250));
  check(gas.hits.length === afterAccept, "accepted memo is not sent again");

  const retryId = "tx-20261105-1404-monotaro-4833";
  gas.behavior = "html";
  await page.click(`[data-detail="${retryId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, retryId);
  const failedId = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id].requestId, retryId);
  gas.behavior = "ok";
  await page.click(`[data-detail="${retryId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "受付済み", {}, retryId);
  const retriedId = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id].requestId, retryId);
  check(failedId === retriedId, "retry keeps request id");
  const retryBodies = gas.hits.map((item) => JSON.parse(new URLSearchParams(item.body).get("payload"))).filter((item) => item.transactionId === retryId).map((item) => item.requestId);
  check(retryBodies.length === 2 && retryBodies[0] === retryBodies[1], `retry ids ${retryBodies}`);

  gas.behavior = "reject";
  const mismatchId = "tx-20261105-1703-amazon-2659";
  await page.click(`[data-detail="${mismatchId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, mismatchId);

  gas.behavior = "mismatch";
  const hitsBeforeMismatch = gas.hits.length;
  await page.click(`[data-detail="${mismatchId}"] [data-ai]`);
  const mismatchStarted = Date.now();
  while (gas.hits.length < hitsBeforeMismatch + 1 && Date.now() - mismatchStarted < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  check(gas.hits.length === hitsBeforeMismatch + 1, "mismatched response is still a retry post");
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, mismatchId);

  gas.behavior = "500";
  const httpId = "tx-20261105-1253-monotaro-17553";
  await page.click(`[data-detail="${httpId}"] [data-ai]`);
  await page.waitForFunction((id) => document.querySelector(`[data-request="${id}"]`)?.dataset.requestStatus === "エラー", {}, httpId);

  const kept = await page.evaluate((id) => JSON.parse(localStorage.getItem("upsider-monitor.execution-requests.v1")).requests[id], legacyId);
  check(kept.memoLines.join("\n") === legacyLines.join("\n"), "later saves keep the old held memo");
  check(kept.status === "未実行", "old held request was not sent");
  check(kept.requestId === null, "old held request stays unnumbered");
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
