import {
  COPY_SUCCESS_MS,
  FILTERS,
  POLL,
  STORAGE_KEY,
  STORAGE_VERSION,
  TERMINAL_REQUEST_STATUSES,
  WAITING_REQUEST_STATUSES,
  buildGasPayload,
  countOf,
  createRequestId,
  fetchResult,
  filterTransactions,
  formatMemoText,
  formatYen,
  initialMemo,
  isAllowedSlackThread,
  isRequestId,
  loadStoredRequests,
  nextPollDelay,
  normalizeGasUrl,
  postGasPayload,
  requestStateText,
  requestStatusForResult,
  resolveRequestId,
  resultCheckedText,
  shouldResumePolling,
  statusTone,
  sumOf,
} from "./logic.js";
import { memoTone } from "./memo-presence.js";
import { TOKEN_FIELDS, currentTokenUpdate, tokenCountText } from "./token-usage.js";

const UNCONFIGURED_NOTE =
  "「AIがメモを追加する」は、このカードの取引ID・Slackスレッド・編集中の5行メモを1件の実行依頼としてまとめ、このブラウザの中だけに保持します。実行にはバックエンド接続が必要です。受付URLが未設定のため、ボタンを押しても実行は行われず、Slackへの投稿もエージェントの起動もありません。依頼に秘密情報やトークンは含まれません。";

const CONFIGURED_NOTE =
  "「AIがメモを追加する」は、このカードの取引ID・Slackスレッド・編集中の5行メモを1件の実行依頼として受付APIへ送ります。受付後の処理は証憑ゲッターロボ側で、このページは依頼IDだけを使って実行結果（成功・変更なし・失敗）を確認し、この欄に表示します。依頼IDを付けて二重送信を避けます。秘密情報やトークンは送りません。";

const state = {
  ledger: null,
  config: { gasUrl: "", pollFastMs: POLL.fastIntervalMs },
  filter: "すべて",
  memos: {},
  requests: {},
  inflight: new Set(),
  polls: new Map(),
  pollInflight: new Set(),
  deferredPolls: new Set(),
  unknownIds: new Set(),
  copiedId: null,
  copySeq: 0,
  copyTimer: 0,
  storageError: false,
};

const app = document.querySelector("#app");

init().catch((error) => {
  console.error(error);
  app.textContent = "台帳を読み込めませんでした。";
  document.body.dataset.ready = "error";
});

async function init() {
  state.config = await loadGasConfig();
  const response = await fetch(new URL("../data/ledger.json", import.meta.url));
  if (!response.ok) throw new Error(`ledger ${response.status}`);
  state.ledger = await response.json();
  for (const detail of state.ledger.details) {
    const tx = state.ledger.transactions.find((row) => row.id === detail.transactionId);
    state.memos[detail.transactionId] = initialMemo(tx.content);
  }
  state.requests = loadRequests();
  render();
  app.addEventListener("click", onClick);
  app.addEventListener("input", onInput);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resumePolling();
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
  );
  app.append(header, renderTokenUsage(ledger), renderMetrics(), renderAggregation());

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

function renderTokenUsage(ledger) {
  const section = el("section", { class: "token-usage", "data-token-usage": "" });
  const usage = ledger.tokenUsage || {};
  const update = currentTokenUpdate(usage);
  section.append(el("h2", {}, "トークン使用量（この更新）"));
  const list = el("dl", { class: "token-counts" });
  for (const [key, label] of TOKEN_FIELDS) {
    list.append(el("dt", {}, label), el("dd", { "data-token-field": key }, tokenCountText(update && update[key])));
  }
  section.append(list);
  if (update) {
    section.append(el("p", { class: "token-source" }, `取得源: ${update.source}`));
    section.append(el("p", { class: "token-scope" }, `範囲: ${update.scope}`));
  }
  if (usage.history) section.append(el("p", {}, usage.history));
  return section;
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
    el("button", {
      type: "button",
      class: "btn secondary",
      "data-ai": tx.id,
      "aria-describedby": noteId,
    }, "AIがメモを追加する"),
  );
  const status = el("p", { class: "copy-status", "data-copy-status": "", role: "status" }, "");
  status.hidden = true;
  const fallback = el("div", { class: "copy-fallback", "data-copy-fallback": "" });
  fallback.hidden = true;
  fallback.append(
    el("p", {}, "自動コピーに失敗しました。下の5行を選択してコピーしてください。"),
    el("textarea", { readonly: "", "data-copy-fallback-text": "" }),
  );
  box.append(actions, status, fallback, el("p", { class: "exec-note", id: noteId }, execNote()));
  const slot = el("div", { "data-request-slot": tx.id });
  slot.append(renderRequest(tx.id));
  box.append(slot);
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

function renderRequest(id) {
  const request = state.requests[id];
  const memo = state.memos[id];
  if (!request) return document.createDocumentFragment();
  const box = el("div", { class: "request", "data-request": id, "data-request-status": request.status });
  const stateLine = el("p", { class: "request-state", role: "status" }, requestStateText(request, Boolean(state.config.gasUrl)));
  if (request.result) box.dataset.resultStatus = request.result.status;
  box.append(el("h3", {}, "保持中の実行依頼"), stateLine);
  if (request.result && TERMINAL_REQUEST_STATUSES.includes(request.status)) {
    // 本文はサーバーが返した詳細。textContent で出し、HTMLとしては解釈しない。
    box.append(el("p", { class: "request-result", "data-request-result": "" }, request.result.message));
  } else if (WAITING_REQUEST_STATUSES.includes(request.status) && state.unknownIds.has(request.requestId)) {
    box.append(el("p", { class: "request-note" }, "受付APIはまだこの依頼IDの記録を返していません。結果が届くまで表示しません。"));
  }
  const checked = resultCheckedText(request);
  if (checked && request.status !== "未実行") box.append(el("p", { class: "request-note" }, checked));
  if (request.status === "確認停止" && state.config.gasUrl) {
    const recheck = el("button", { type: "button", class: "btn secondary", "data-recheck": id }, "結果を再確認");
    if (state.pollInflight.has(id)) recheck.disabled = true;
    box.append(recheck);
  }
  const memoText = el("dd");
  memoText.append(el("pre", {}, request.memoLines.join("\n")));
  const dl = el("dl");
  dl.append(
    el("dt", {}, "取引ID"),
    el("dd", {}, request.transactionId),
    el("dt", {}, "Slackスレッド"),
    el("dd", {}, request.slackThread),
    el("dt", {}, "メモ"),
    memoText,
    el("dt", {}, "依頼ID"),
    el("dd", {}, request.requestId || "未採番"),
    el("dt", {}, "最終更新"),
    el("dd", {}, formatSavedAt(request.updatedAt || request.savedAt)),
  );
  box.append(dl);
  if (memo && formatMemoText(memo) !== request.memoLines.join("\n")) {
    box.append(el("p", { class: "mismatch" }, "編集中の5行と保持中の依頼は違います。反映するには、もう一度「AIがメモを追加する」を押してください。"));
  }
  if (request.status === "エラー" && request.errorMessage) {
    box.append(el("p", { class: "mismatch" }, request.errorMessage));
  }
  if (state.storageError) {
    box.append(el("p", { class: "mismatch" }, "このブラウザでは保存領域を使えないため、依頼はこの画面を開いている間だけ残ります。"));
  }
  return box;
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
    return;
  }
  const aiButton = event.target.closest("[data-ai]");
  if (aiButton) {
    event.preventDefault();
    void submitMemoRequest(aiButton.dataset.ai);
    return;
  }
  const recheckButton = event.target.closest("[data-recheck]");
  if (recheckButton) {
    event.preventDefault();
    const id = recheckButton.dataset.recheck;
    const request = state.requests[id];
    if (request && request.status === "確認停止" && !state.pollInflight.has(id)) {
      cancelPoll(id);
      void runPoll(id, request.requestId);
    }
  }
}

function onInput(event) {
  const input = event.target.closest("[data-memo-field]");
  if (!input) return;
  const id = input.dataset.memoId;
  state.memos[id][input.dataset.memoField] = input.value;
  replaceRequest(id);
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

async function submitMemoRequest(id) {
  if (state.inflight.has(id)) return;
  const tx = state.ledger.transactions.find((row) => row.id === id);
  if (!tx) return;
  const memoLines = formatMemoText(state.memos[id]).split("\n");
  const now = new Date().toISOString();
  const previous = state.requests[id];
  const sameMemo = Boolean(previous && previous.memoLines.join("\n") === memoLines.join("\n"));
  const gasUrl = state.config.gasUrl;

  if (!gasUrl) {
    state.requests[id] = baseRequest(tx, memoLines, previous, now, {
      status: "未実行",
      requestId: null,
      errorMessage: "",
    });
    cancelPoll(id);
    saveRequests();
    replaceRequest(id);
    return;
  }

  // 受付済み・処理中・結果待ち・成功・変更なしの同じメモは再送しない。結果が出るまで自動再投稿しない。
  if (sameMemo && ["受付済み", "処理中", "確認停止", "成功", "変更なし"].includes(previous.status)) {
    replaceRequest(id);
    return;
  }
  if (sameMemo && previous.status === "送信中") return;
  if (!isAllowedSlackThread(tx.slack, state.ledger.transactions, tx.id)) {
    state.requests[id] = baseRequest(tx, memoLines, previous, now, {
      status: "エラー",
      requestId: previous?.requestId || null,
      errorMessage: "Slackスレッドが取引一覧と一致しないため、送信していません。",
    });
    saveRequests();
    replaceRequest(id);
    return;
  }

  const request = baseRequest(tx, memoLines, previous, now, {
    status: "送信中",
    requestId: resolveRequestId(previous, memoLines, createRequestId),
    errorMessage: "",
  });
  cancelPoll(id);
  state.inflight.add(id);
  state.requests[id] = request;
  saveRequests();
  replaceRequest(id);
  setAiBusy(id, true);
  try {
    await postGasPayload(gasUrl, buildGasPayload(request));
    request.status = "受付済み";
    request.errorMessage = "";
    request.acceptedAt = new Date().toISOString();
    request.pollAttempts = 0;
    request.lastCheckedAt = null;
    request.result = null;
  } catch {
    request.status = "エラー";
    request.errorMessage = "受付APIの応答を確認できませんでした。同じ依頼IDで再試行できます。";
  } finally {
    request.updatedAt = new Date().toISOString();
    state.inflight.delete(id);
    setAiBusy(id, false);
    saveRequests();
    replaceRequest(id);
    // 結果が返るまでは成否を出さない。受付直後は「受付済み」、照会を始めたら「処理中」。
    if (request.status === "受付済み" && state.requests[id] === request) {
      schedulePoll(id, state.config.pollFastMs);
    }
  }
}

function baseRequest(tx, memoLines, previous, now, fields) {
  return {
    transactionId: tx.id,
    slackThread: tx.slack,
    memoLines,
    savedAt: previous?.savedAt || now,
    updatedAt: now,
    status: fields.status,
    requestId: fields.requestId,
    errorMessage: fields.errorMessage,
    acceptedAt: null,
    pollAttempts: 0,
    lastCheckedAt: null,
    result: null,
  };
}

function schedulePoll(id, delay) {
  cancelPoll(id);
  const request = state.requests[id];
  if (!state.config.gasUrl || !request || !isRequestId(request.requestId)) return;
  if (!WAITING_REQUEST_STATUSES.includes(request.status)) return;
  const requestId = request.requestId;
  const timer = window.setTimeout(() => {
    state.polls.delete(id);
    void runPoll(id, requestId);
  }, Math.max(0, delay));
  state.polls.set(id, { timer, requestId });
}

function cancelPoll(id) {
  const poll = state.polls.get(id);
  if (poll) window.clearTimeout(poll.timer);
  state.polls.delete(id);
  state.deferredPolls.delete(id);
}

async function runPoll(id, requestId) {
  const current = state.requests[id];
  if (!current || current.requestId !== requestId || !WAITING_REQUEST_STATUSES.includes(current.status)) return;
  if (document.hidden && current.status !== "確認停止") {
    state.deferredPolls.add(id);
    return;
  }
  if (state.pollInflight.has(id)) return;
  if (current.status === "受付済み") {
    current.status = "処理中";
    saveRequests();
    replaceRequest(id);
  }
  state.pollInflight.add(id);
  replaceRequest(id);
  let outcome;
  try {
    outcome = await fetchResult(state.config.gasUrl, requestId);
  } catch {
    outcome = { kind: "invalid" };
  } finally {
    state.pollInflight.delete(id);
  }
  const latest = state.requests[id];
  // 確認中に依頼IDが変わった応答は捨てる。サーバーの requestId 一致は fetchResult 側でも見る。
  if (!latest || latest.requestId !== requestId || !WAITING_REQUEST_STATUSES.includes(latest.status)) {
    replaceRequest(id);
    return;
  }
  const now = new Date().toISOString();
  latest.pollAttempts += 1;
  latest.lastCheckedAt = now;
  if (outcome.kind === "done") {
    state.unknownIds.delete(requestId);
    latest.status = requestStatusForResult(outcome.result.status);
    latest.result = outcome.result;
    latest.updatedAt = now;
    saveRequests();
    replaceRequest(id);
    return;
  }
  if (outcome.kind === "unknown") state.unknownIds.add(requestId);
  else if (outcome.kind === "pending") state.unknownIds.delete(requestId);
  const delay = nextPollDelay(latest.pollAttempts, latest.acceptedAt);
  latest.status = delay === null ? "確認停止" : "処理中";
  saveRequests();
  replaceRequest(id);
  if (delay !== null) {
    const fast = latest.pollAttempts < POLL.fastAttempts;
    schedulePoll(id, fast ? state.config.pollFastMs : delay);
  }
}

function resumePolling() {
  if (!state.config.gasUrl) return;
  let changed = false;
  let stagger = 0;
  for (const [id, request] of Object.entries(state.requests)) {
    if (!WAITING_REQUEST_STATUSES.includes(request.status)) continue;
    if (shouldResumePolling(request) && nextPollDelay(request.pollAttempts, request.acceptedAt) !== null) {
      schedulePoll(id, stagger);
      stagger += 500;
    } else if (request.status !== "確認停止") {
      request.status = "確認停止";
      changed = true;
    }
  }
  if (changed) {
    saveRequests();
    for (const id of Object.keys(state.requests)) replaceRequest(id);
  }
}

function onVisibilityChange() {
  if (document.hidden) return;
  const ids = [...state.deferredPolls];
  state.deferredPolls.clear();
  ids.forEach((id, index) => schedulePoll(id, index * 500));
}

function setAiBusy(id, busy) {
  const button = detailOf(id)?.querySelector("[data-ai]");
  if (!button) return;
  button.disabled = busy;
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}

function replaceRequest(id) {
  const slot = detailOf(id)?.querySelector("[data-request-slot]");
  if (!slot) return;
  slot.replaceChildren(renderRequest(id));
}

function detailOf(id) {
  return app.querySelector(`[data-detail="${CSS.escape(id)}"]`);
}

function loadRequests() {
  try {
    return loadStoredRequests(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function saveRequests() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, requests: state.requests }));
    state.storageError = false;
  } catch {
    state.storageError = true;
  }
}

async function loadGasConfig() {
  try {
    const response = await fetch(new URL("../config.js", import.meta.url), { cache: "no-store" });
    if (!response.ok) return { gasUrl: "", pollFastMs: POLL.fastIntervalMs };
    const source = await response.text();
    const readConfig = new Function(`${source}\n; return window.UPSIDER_CONFIG;`);
    const config = readConfig();
    const gasUrl = normalizeGasUrl(config && config.gasUrl);
    return { gasUrl, pollFastMs: testPollMs(gasUrl, config && config.testPollMs) };
  } catch {
    return { gasUrl: "", pollFastMs: POLL.fastIntervalMs };
  }
}

// テスト用の短い確認間隔は、ローカルの模擬受付URLのときだけ使う。公開URLでは常に15秒。
function testPollMs(gasUrl, value) {
  if (!gasUrl || !Number.isInteger(value) || value < 50 || value > POLL.fastIntervalMs) return POLL.fastIntervalMs;
  const host = new URL(gasUrl).hostname;
  return host === "127.0.0.1" || host === "localhost" ? value : POLL.fastIntervalMs;
}

function execNote() {
  return state.config.gasUrl ? CONFIGURED_NOTE : UNCONFIGURED_NOTE;
}

function formatSavedAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
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
