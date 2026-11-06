import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import {
  buildExecutionRequest,
  countOf,
  filterTransactions,
  formatMemoText,
  formatYen,
  initialMemo,
  isExecutionRequest,
  sumOf,
} from "../js/logic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(fs.readFileSync(path.join(root, "data/ledger.json"), "utf8"));
const failures = [];

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

function assertLedger() {
  check(ledger.transactions.length === 17, "ledger has 17 transactions");
  check(ledger.asOf === "2026-11-06 09:10 Asia/Tokyo", "asOf");
  const counts = {
    "登録完了": 5,
    "メモなし": 3,
    "証憑なし": 4,
    "メモ・証憑なし": 5,
    "証憑不一致": 0,
  };
  for (const [status, count] of Object.entries(counts)) {
    check(countOf(ledger.transactions, status) === count, `${status} count ${countOf(ledger.transactions, status)} !== ${count}`);
  }
  check(sumOf(ledger.transactions) === 137414, `total ${sumOf(ledger.transactions)}`);
  check(formatYen(137414) === "¥137,414", "yen format");
  check(sumOf(ledger.transactions, "登録完了") === 19673, "sum 登録完了");
  check(sumOf(ledger.transactions, "メモなし") === 25045, "sum メモなし");
  check(sumOf(ledger.transactions, "証憑なし") === 48744, "sum 証憑なし");
  check(sumOf(ledger.transactions, "メモ・証憑なし") === 43952, "sum メモ・証憑なし");
  check(filterTransactions(ledger.transactions, "メモなし").every((tx) => tx.status === "メモなし"), "filter exact");
  check(filterTransactions(ledger.transactions, "証憑なし").length === 4, "証憑なし excludes メモ・証憑なし");
  check(new Set(ledger.transactions.map((tx) => tx.slack)).size === 17, "slack urls unique");
  check(ledger.transactions.filter((tx) => tx.detailSection).length === 8, "8 detail sections");

  const specPath = "/home/ubuntu/.cursor/projects/workspace/uploads/upsider-web-spec_79aa.md";
  if (fs.existsSync(specPath)) {
    const spec = fs.readFileSync(specPath, "utf8");
    const blocks = [...spec.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);
    const fromSpec = JSON.parse(blocks.find((block) => block.includes('"transactions"')));
    check(JSON.stringify(ledger.transactions) === JSON.stringify(fromSpec.transactions), "transactions match spec JSON");
    check(ledger.asOf === fromSpec.asOf, "asOf matches spec");
  } else {
    failures.push("spec file missing; transactions were not checked against the source markdown");
  }

  const memoByKey = {
    "17553": "パーツケース4段×2・ゴム切はさみ・L型カッターなど工具7点",
    "17600": "HyperVシート PX-10H 15 非耐油 W270×L270×H1.5mm ×5",
    "4833": "チャック付き袋 M8G×2・M8I×1",
    "2659": "NEEWER 六角ドライバー4本セット",
    "14680": "UGREEN USB Type-Cケーブル 1m ×20",
    "9300": "KIOXIA microSDカード64GB ×6",
    "2117": "UGREEN SDカードリーダー 収納型",
    "255": "輪ゴム オーバンド#16 100g箱",
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
}

async function browserChecks(base) {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
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
      "最終更新: 2026-11-06 09:10 Asia/Tokyo。11月以降のAIハンド決済用取引17件のステータスです。",
      "各取引詳細にメモ入力欄（用途・セグメント1・セグメント2・分類・内容）と「クリップボードにコピー」を設置しました。",
      "日進ゴム ¥17,600 の誤添付 nisshin-4735.png を削除しました。",
      "メモ入力欄とコピー機能を復活済み。",
      "要対応の取引です。Slackスレッドの下にメモ入力欄があり、スクショがある場合はその上に並びます。",
    ]) {
      check(bodyText.includes(phrase), `missing phrase: ${phrase}`);
    }

    const rows = await page.$$eval("[data-tx-id]", (nodes) => nodes.map((node) => ({
      id: node.dataset.txId,
      cells: [...node.querySelectorAll("td")].map((td) => ({
        label: td.dataset.label,
        text: td.dataset.label === "Slack" ? td.querySelector("a")?.href || "" : td.innerText.trim(),
        target: td.querySelector("a")?.target || "",
        rel: td.querySelector("a")?.rel || "",
      })),
    })));
    check(rows.length === 17, `visible rows ${rows.length}`);
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
    check(agg[0][0] === "すべて" && agg[0][1] === "17" && agg[0][2] === "¥137,414", `agg total ${agg[0]}`);
    check(agg.find((row) => row[0] === "証憑不一致")?.[1] === "0", "agg zero mismatch");

    for (const filter of ["すべて", "登録完了", "メモなし", "証憑なし", "メモ・証憑なし", "証憑不一致"]) {
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
    check(details.length === 8, `details ${details.length}`);
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

    const aiId = "tx-20261106-0113-amazon-255";
    await page.$eval(`[data-detail="${aiId}"] [data-memo-field="purpose"]`, (input) => {
      input.value = "輪ゴムの補充";
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
    check(requestText.includes("https://app.slack.com/client/T0AS9K3390T/C0BG07UF1EY/thread/C0BG07UF1EY-1793895200.333029"), "request shows slack");
    check(requestText.includes("用途：輪ゴムの補充"), "request shows edited memo");
    check(requestText.includes("セグメント1：AIハンド"), "request seg1");
    check(requestText.includes("分類：消耗品"), "request category");
    check(requestText.includes("内容：輪ゴム オーバンド#16 100g箱"), "request content");
    check(requestText.includes("実行は行われていません"), "request not executed");
    check(!/投稿しました|実行しました|追加しました|連携しました/.test(requestText), `false success: ${requestText}`);
    const stored = await page.evaluate(() => localStorage.getItem("upsider-monitor.execution-requests.v1"));
    const parsed = JSON.parse(stored);
    const saved = parsed.requests[aiId];
    check(JSON.stringify(Object.keys(saved).sort()) === JSON.stringify(["memoLines", "savedAt", "slackThread", "status", "transactionId"]), `stored keys ${Object.keys(saved)}`);
    check(saved.status === "未実行", "stored status");
    check(saved.memoLines.length === 5, "stored five lines");
    check(!/token|secret|password|authorization|api[_-]?key/i.test(stored), "stored secrets");

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector("body[data-ready='true']");
    const restored = await page.$eval(`[data-request="${aiId}"]`, (node) => node.innerText);
    check(restored.includes("用途：輪ゴムの補充"), "request restored");
    check(restored.includes("編集中の5行と保持中の依頼は違います"), "mismatch after reload");
    const purposeAfterReload = await page.$eval(`[data-detail="${aiId}"] [data-memo-field="purpose"]`, (input) => input.value);
    check(purposeAfterReload === "輪ゴム オーバンド#16 100g箱", "form resets to initial value");

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
    await page.evaluate(() => document.querySelector('[data-request="tx-20261106-0113-amazon-255"]').scrollIntoView({ block: "center" }));
    await page.screenshot({ path: "/tmp/upsider-request.png" });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/upsider-mobile-top.png" });
  } finally {
    await browser.close();
  }
}

assertLedger();
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
console.log("ok: 17 transactions, links, initial memos, copy, filters, execution requests");
