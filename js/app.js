import {
  COPY_SUCCESS_MS,
  FILTERS,
  actionSummary,
  attachmentResultView,
  countOf,
  shareRestrictionRemark,
  filterTransactions,
  formatMemoText,
  formatYen,
  initialMemo,
  statusTone,
  sumOf,
} from "./logic.js";
import { ledgerAcquiredAt, normalizeAcquiredAt } from "./acquired-at.js";
import { memoTone } from "./memo-presence.js";

const LOCAL_ONLY_NOTE = "Slackの参照・メモ追加・証憑添付はブラウザのみ。API・MCP・Webhook等の連携機能は使用しません。";

const state = {
  ledger: null,
  filter: "すべて",
  memos: {},
  copiedId: null,
  copySeq: 0,
  copyTimer: 0,
};

const app = document.querySelector("#app");

init().catch((error) => {
  console.error(error);
  app.textContent = "台帳を読み込めませんでした。";
  document.body.dataset.ready = "error";
});

async function init() {
  const response = await fetch(new URL("../data/ledger.json", import.meta.url));
  if (!response.ok) throw new Error(`ledger ${response.status}`);
  state.ledger = await response.json();
  for (const detail of state.ledger.details) {
    const tx = state.ledger.transactions.find((row) => row.id === detail.transactionId);
    state.memos[detail.transactionId] = initialMemo(tx.content);
  }
  render();
  app.addEventListener("click", onClick);
  app.addEventListener("input", onInput);
  document.body.dataset.ready = "true";
}

function render() {
  const { ledger } = state;
  app.replaceChildren();

  const header = el("header", { class: "page-header" });
  header.append(
    el("h1", {}, ledger.title),
    el("p", { class: "summary" }, ledger.summary),
    el("p", { class: "lead" }, ledger.lead),
    renderAcquiredAt(ledger),
    renderPolicy(),
    renderInstruction(),
  );
  app.append(header, renderAttachmentResult(ledger), renderActionCount(ledger), renderMetrics(), renderAggregation());

  for (const callout of ledger.callouts) {
    const box = el("aside", { class: `callout ${callout.tone}` });
    const body = el("p", {}, callout.body);
    box.append(el("strong", {}, callout.lead), body);
    app.append(box);
  }

  const list = el("section", { "aria-labelledby": "tx-heading" });
  list.append(
    el("h2", { id: "tx-heading" }, "取引一覧"),
    renderFilters(),
    renderTable(),
  );
  const empty = el("p", { class: "empty", "data-empty": "" }, "該当する取引はありません。");
  empty.hidden = filterTransactions(ledger.transactions, state.filter).length !== 0;
  list.append(empty);
  app.append(list);

  const detailIntro = el("section");
  detailIntro.append(
    el("h2", {}, ledger.detailHeading),
    el("p", { class: "detail-intro" }, ledger.detailIntro),
  );
  app.append(detailIntro);

  for (const detail of ledger.details) app.append(renderDetail(detail));

  const caution = el("section", { class: "caution" });
  caution.append(el("h2", {}, ledger.cautionHeading), el("p", {}, ledger.caution));
  app.append(caution);
}

function renderAcquiredAt(ledger) {
  const acquired = ledgerAcquiredAt(ledger);
  const recorded = acquired.source === "asOf"
    ? ledger.asOf
    : acquired.source === "memoCheck.asOf"
      ? ledger.memoCheck.asOf
      : undefined;
  const box = el("div", { class: "acquired-at" });
  const line = el("p", { "data-acquired-at": "" });
  line.append(
    el("span", {}, "最終取得日時"),
    document.createTextNode(" "),
    el("time", { "data-acquired-value": "", datetime: recorded }, acquired.text),
  );
  box.append(line);
  if (typeof ledger.dataAcquiredAtLabel === "string" && ledger.dataAcquiredAtLabel.trim()) {
    box.append(el("p", { class: "acquired-note" }, ledger.dataAcquiredAtLabel));
  }
  const pdfRaw = ledger.evidencePatrol && ledger.evidencePatrol.lastSuccessfulAcquisitionAt;
  const pdf = normalizeAcquiredAt(pdfRaw);
  if (pdf) {
    const pdfLine = el("p", { "data-pdf-saved-at": "" });
    pdfLine.append(
      el("span", {}, "証憑PDF取得成功"),
      document.createTextNode(" "),
      el("time", { datetime: pdfRaw }, pdf),
    );
    box.append(pdfLine);
  }
  return box;
}

function renderPolicy() {
  const box = el("aside", { class: "callout info", "data-local-only": "" });
  box.append(
    el("strong", {}, "連携機能は使いません"),
    el("p", {}, LOCAL_ONLY_NOTE),
    el("p", {}, "秘密情報やトークンは送りません。"),
  );
  return box;
}

function renderInstruction() {
  const box = el("form", { class: "instruction-box", "data-instruction-form": "" });
  box.addEventListener("submit", (event) => event.preventDefault());
  const area = el("textarea", {
    id: "instruction-text",
    name: "instruction",
    rows: "4",
    "data-instruction": "",
    autocomplete: "off",
    autocapitalize: "sentences",
    enterkeyhint: "enter",
    inputmode: "text",
  });
  box.append(
    el("label", { for: "instruction-text" }, "手元のメモ"),
    area,
    el("p", { class: "instruction-note", "data-instruction-status": "" }, "この欄はブラウザの中だけです。送信しません。"),
  );
  return box;
}

function renderAttachmentResult(ledger) {
  const view = attachmentResultView(ledger);
  if (!view) return el("div");
  const section = el("section", { class: "attachment-result", "data-attachment-result": "" });
  const summary = el("aside", { class: "callout warning" });
  summary.append(
    el("strong", {}, "今回の添付結果"),
    el("p", {}, "連携経由の添付が共有制限で拒否された。"),
    el("p", { "data-attachment-counts": "" }, `成功${view.succeeded}件／未完了${view.incomplete}件`),
    el("p", { "data-attachment-checked": "" }, `確認時刻 ${view.checkedAt}`),
    el("p", {}, "証憑のDrive保存とSlackへの添付は別です。ここに出した取引は保存済みで、添付は未完了です。登録完了にはしていません。"),
  );
  section.append(summary);
  for (const tx of view.rows) {
    const article = el("article", { class: "detail", "data-unattached": tx.id });
    article.append(el("h2", {}, `${tx.datetime} ${tx.merchant}`));
    const props = el("dl", { class: "props" });
    props.append(el("dt", {}, "注文"), el("dd", {}, tx.orderNumber || ""));
    props.append(el("dt", {}, "金額"), el("dd", {}, tx.amount));
    props.append(el("dt", {}, "添付"), el("dd", {}, "添付試行済み・共有制限で未添付"));
    const drive = el("dd", {});
    drive.append(evidenceLink(tx.drive, "保存済みの証憑"));
    props.append(el("dt", {}, "Drive証憑"), drive);
    const slack = el("dd", {});
    slack.append(evidenceLink(tx.slack, "取引スレッド"));
    props.append(el("dt", {}, "Slack"), slack);
    article.append(props);
    section.append(article);
  }
  return section;
}

function renderActionCount(ledger) {
  const summary = actionSummary(ledger.transactions);
  return el(
    "p",
    { class: "action-count", "data-action-count": "" },
    `要処理 ${summary.action}件。登録完了${summary.done}件と返金${summary.refund}件は含めません。`,
  );
}

function evidenceLink(url, label) {
  if (typeof url !== "string" || !url.startsWith("https://")) return el("span", {}, url || "");
  return el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, label);
}

function renderMetrics() {
  const wrap = el("div", { class: "metrics" });
  for (const status of FILTERS.slice(1)) {
    const card = el("article", { class: `metric ${statusTone(status)}` });
    card.append(el("b", {}, String(countOf(state.ledger.transactions, status))), el("span", {}, status));
    wrap.append(card);
  }
  return wrap;
}

function renderAggregation() {
  const section = el("section", { "aria-labelledby": "agg-heading" });
  const table = el("table", { class: "agg-table panel" });
  const head = el("tr");
  head.append(el("th", { scope: "col" }, "区分"), el("th", { scope: "col", class: "num" }, "件数"), el("th", { scope: "col", class: "num" }, "金額"));
  table.append(el("caption", { class: "sr-only" }, "ステータス別の件数と金額"), el("thead", {}, head));
  const body = el("tbody");
  const rows = [["すべて", state.ledger.transactions.length, sumOf(state.ledger.transactions)]];
  for (const status of FILTERS.slice(1)) {
    rows.push([status, countOf(state.ledger.transactions, status), sumOf(state.ledger.transactions, status)]);
  }
  for (const [label, count, amount] of rows) {
    const tr = el("tr");
    tr.append(el("td", {}, label), el("td", { class: "num" }, String(count)), el("td", { class: "num" }, formatYen(amount)));
    body.append(tr);
  }
  table.append(body);
  section.append(el("h2", { id: "agg-heading" }, "集計"), table);
  return section;
}

function renderFilters() {
  const group = el("div", { class: "filters", role: "group", "aria-label": "ステータスフィルタ" });
  for (const filter of FILTERS) {
    const count = filter === "すべて"
      ? state.ledger.transactions.length
      : countOf(state.ledger.transactions, filter);
    const button = el("button", {
      type: "button",
      "data-filter": filter,
      "aria-pressed": filter === state.filter ? "true" : "false",
    });
    button.append(document.createTextNode(filter), el("span", { class: "count" }, String(count)));
    group.append(button);
  }
  return group;
}

function renderTable() {
  const table = el("table", { class: "tx-table panel" });
  const head = el("tr");
  const columns = [
    ["日時", ""],
    ["利用先", ""],
    ["金額", "num"],
    ["内容", ""],
    ["ステータス", ""],
    ["メモ", ""],
    ["Slack", ""],
    ["Drive証憑", ""],
    ["備考", ""],
  ];
  for (const [label, className] of columns) {
    head.append(el("th", { scope: "col", class: className }, label));
  }
  table.append(el("caption", { class: "sr-only" }, "取引一覧"), el("thead", {}, head));
  const body = el("tbody", { "data-tx-body": "" });
  for (const tx of filterTransactions(state.ledger.transactions, state.filter)) {
    body.append(renderRow(tx));
  }
  table.append(body);
  return table;
}

function renderRow(tx) {
  const tr = el("tr", { "data-tx-id": tx.id });
  tr.append(
    cell("日時", tx.datetime),
    cell("利用先", tx.merchant),
    cell("金額", tx.amount, "num"),
    cell("内容", tx.content),
    cell("ステータス", null, "", statusPill(tx.status)),
    renderMemoStatus(tx),
    cell("Slack", null, "", slackLink(tx.slack)),
    renderDrive(tx),
    cell("備考", shareRestrictionRemark(tx), "remark"),
  );
  return tr;
}

function renderMemoStatus(tx) {
  const status = tx.memoStatus || "未確認";
  const notices = Array.isArray(tx.memoEvidence) ? tx.memoEvidence : [];
  const wrap = el("div", {});
  wrap.append(el("span", { class: `status ${memoTone(status)}` }, status));
  if (status === "あり") wrap.append(el("span", { class: "memo-note" }, `完了通知${notices.length}件`));
  return cell("メモ", null, "", wrap);
}

function renderDetail(detail) {
  const tx = state.ledger.transactions.find((row) => row.id === detail.transactionId);
  const article = el("article", { class: "detail", "data-detail": tx.id });
  article.append(el("h2", {}, detail.heading), el("p", { class: "detail-intro" }, detail.intro));

  const props = el("dl", { class: "props" });
  for (const item of detail.properties) {
    props.append(el("dt", {}, item.label));
    const dd = el("dd", {});
    if (item.kind === "slack") dd.append(slackLink(item.value));
    else if (item.label === "ステータス") dd.append(statusPill(item.value));
    else dd.textContent = item.value;
    props.append(dd);
  }
  article.append(props);
  if (detail.image) article.append(renderImage(detail.image));
  article.append(renderMemo(tx));
  return article;
}

function renderMemo(tx) {
  const memo = state.memos[tx.id];
  const box = el("div", { class: "memo" });
  const fields = [
    ["purpose", "用途："],
    ["seg1", "セグメント1："],
    ["seg2", "セグメント2："],
    ["category", "分類："],
    ["content", "内容："],
  ];
  for (const [field, label] of fields) {
    const id = `memo-${tx.id}-${field}`;
    const wrap = el("label", { class: "memo-field", for: id });
    const input = el("input", {
      id,
      type: "text",
      value: memo[field],
      autocomplete: "off",
      "data-memo-id": tx.id,
      "data-memo-field": field,
    });
    wrap.append(el("span", {}, label), input);
    box.append(wrap);
  }

  const actions = el("div", { class: "memo-actions" });
  const noteId = `exec-note-${tx.id}`;
  actions.append(
    el("button", { type: "button", class: "btn primary", "data-copy": tx.id }, "クリップボードにコピー"),
  );
  const status = el("p", { class: "copy-status", "data-copy-status": "", role: "status" }, "");
  status.hidden = true;
  const fallback = el("div", { class: "copy-fallback", "data-copy-fallback": "" });
  fallback.hidden = true;
  fallback.append(
    el("p", {}, "自動コピーに失敗しました。下の5行を選択してコピーしてください。"),
    el("textarea", { readonly: "", "data-copy-fallback-text": "" }),
  );
  box.append(actions, status, fallback, el("p", { class: "exec-note", id: noteId }, "このメモはブラウザの中だけです。送信しません。"));
  return box;
}

function renderImage(image) {
  const figure = el("figure", { class: image.readable ? "shot" : "shot is-damaged" });
  if (!image.readable) figure.append(el("p", { class: "shot-note" }, image.notice));
  figure.append(el("img", {
    src: image.src,
    alt: image.alt,
    width: String(image.width),
    height: String(image.height),
  }));
  return figure;
}

function onClick(event) {
  const filterButton = event.target.closest("[data-filter]");
  if (filterButton) {
    state.filter = filterButton.dataset.filter;
    paintFilter();
    return;
  }
  const copyButton = event.target.closest("[data-copy]");
  if (copyButton) {
    event.preventDefault();
    copyMemo(copyButton.dataset.copy);
  }
}

function onInput(event) {
  const input = event.target.closest("[data-memo-field]");
  if (!input) return;
  const id = input.dataset.memoId;
  state.memos[id][input.dataset.memoField] = input.value;
}

function paintFilter() {
  for (const button of app.querySelectorAll("[data-filter]")) {
    button.setAttribute("aria-pressed", button.dataset.filter === state.filter ? "true" : "false");
  }
  const body = app.querySelector("[data-tx-body]");
  body.replaceChildren();
  const rows = filterTransactions(state.ledger.transactions, state.filter);
  for (const tx of rows) body.append(renderRow(tx));
  app.querySelector("[data-empty]").hidden = rows.length !== 0;
}

function copyMemo(id) {
  const text = formatMemoText(state.memos[id]);
  const legacyOk = execCommandCopy(text);
  const clipboard = navigator.clipboard;
  if (legacyOk) {
    hideFallback(id);
    markCopied(id);
    if (clipboard && typeof clipboard.writeText === "function") {
      clipboard.writeText(text).catch(() => {});
    }
    return;
  }
  if (clipboard && typeof clipboard.writeText === "function") {
    clipboard.writeText(text).then(
      () => {
        hideFallback(id);
        markCopied(id);
      },
      () => copyWithClipboardItem(id, text),
    );
    return;
  }
  copyWithClipboardItem(id, text);
}

function copyWithClipboardItem(id, text) {
  const clipboard = navigator.clipboard;
  if (clipboard && typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    const item = new ClipboardItem({ "text/plain": new Blob([text], { type: "text/plain" }) });
    clipboard.write([item]).then(
      () => {
        hideFallback(id);
        markCopied(id);
      },
      () => showFallback(id, text),
    );
    return;
  }
  showFallback(id, text);
}

function execCommandCopy(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function markCopied(id) {
  state.copiedId = id;
  state.copySeq += 1;
  const seq = state.copySeq;
  for (const node of app.querySelectorAll("[data-copy-status]")) {
    const active = node.closest("[data-detail]")?.dataset.detail === id;
    node.hidden = !active;
    node.textContent = active ? "コピーしました" : "";
  }
  window.clearTimeout(state.copyTimer);
  state.copyTimer = window.setTimeout(() => {
    if (seq !== state.copySeq) return;
    state.copiedId = null;
    for (const node of app.querySelectorAll("[data-copy-status]")) {
      node.hidden = true;
      node.textContent = "";
    }
  }, COPY_SUCCESS_MS);
}

function hideFallback(id) {
  const node = detailOf(id)?.querySelector("[data-copy-fallback]");
  if (node) node.hidden = true;
}

function showFallback(id, text) {
  for (const node of app.querySelectorAll("[data-copy-status]")) {
    node.hidden = true;
    node.textContent = "";
  }
  state.copiedId = null;
  const card = detailOf(id);
  const fallback = card.querySelector("[data-copy-fallback]");
  const area = fallback.querySelector("[data-copy-fallback-text]");
  area.value = text;
  fallback.hidden = false;
  area.focus();
  area.select();
}

function detailOf(id) {
  return app.querySelector(`[data-detail="${CSS.escape(id)}"]`);
}

function renderDrive(tx) {
  if (typeof tx.drive === "string" && tx.drive.startsWith("https://")) {
    return cell("Drive証憑", null, "", el("a", {
      href: tx.drive,
      target: "_blank",
      rel: "noopener noreferrer",
    }, tx.drive));
  }
  return cell("Drive証憑", tx.drive);
}

function slackLink(url) {
  const link = el("a", { href: url, target: "_blank", rel: "noopener noreferrer" }, url);
  return link;
}

function statusPill(status) {
  return el("span", { class: `status ${statusTone(status)}` }, status);
}

function cell(label, text, className = "", node) {
  const attrs = { "data-label": label };
  if (className) attrs.class = className;
  const td = el("td", attrs);
  if (node) td.append(node);
  else td.textContent = text;
  return td;
}

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  if (text instanceof Node) node.append(text);
  else if (text !== undefined) node.textContent = text;
  return node;
}
