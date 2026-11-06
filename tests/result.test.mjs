import { randomUUID } from "node:crypto";
import {
  POLL, buildResultUrl, fetchResult, isTerminalRequest, nextPollDelay, parseResultResponse,
  requestStatusForResult, resultHeadline, shouldResumePolling, validateResult,
} from "../js/result.js";

const failures = [];
let passed = 0;
const check = (c, m) => { if (c) passed += 1; else failures.push(m); };
const id = randomUUID();
const GAS = "https://script.google.com/macros/s/AKfycbTEST/exec";

const url = new URL(buildResultUrl(GAS, id));
check(url.origin + url.pathname === GAS, "same exec url");
check([...url.searchParams.keys()].join(",") === "op,requestId", "only op & requestId");
check(url.searchParams.get("op") === "result" && url.searchParams.get("requestId") === id, "query values");
let threw = false; try { buildResultUrl(GAS, "x&op=list"); } catch { threw = true; }
check(threw, "non-uuid rejected before fetch");

const done = { ok: true, requestId: id, state: "done", result: { status: "noop", finishedAt: "2026-11-06T10:13:05.000Z", message: "19:13（日本時間）に実行して処理済みです。" } };
check(parseResultResponse(JSON.stringify(done), id).kind === "done", "done");
check(parseResultResponse(JSON.stringify(done), id.toUpperCase()).kind === "done", "case-insensitive id");
check(parseResultResponse(JSON.stringify({ ...done, requestId: randomUUID() }), id).kind === "invalid", "other request id ignored");
check(parseResultResponse(JSON.stringify({ ok: true, requestId: id, state: "pending" }), id).kind === "pending", "pending");
check(parseResultResponse(JSON.stringify({ ok: true, requestId: id, state: "unknown" }), id).kind === "unknown", "unknown");
check(parseResultResponse("<html>", id).kind === "invalid", "html invalid");
check(parseResultResponse(JSON.stringify({ ok: false }), id).kind === "invalid", "ok false invalid");
check(parseResultResponse(JSON.stringify({ ...done, result: { ...done.result, status: "great" } }), id).kind === "invalid", "bad status");
check(parseResultResponse(JSON.stringify({ ...done, result: { ...done.result, extra: 1 } }), id).kind === "invalid", "extra field");
check(validateResult({ ...done.result, message: "あ".repeat(401) }) === null, "message > 400");
check(validateResult({ ...done.result, finishedAt: "yesterday" }) === null, "bad date");

const h = resultHeadline(done.result);
check(h === "変更なし：2026/11/06 19:13（日本時間）に実行。変更はありませんでした。", `headline ${h}`);
check(resultHeadline({ ...done.result, status: "failed" }).startsWith("失敗：2026/11/06 19:13（日本時間）"), "failed headline");
check(requestStatusForResult("success") === "成功" && requestStatusForResult("x") === null, "status labels");

const t0 = Date.parse("2026-11-06T10:00:00Z");
const acc = new Date(t0).toISOString();
check(nextPollDelay(0, acc, t0) === 15000, "fast");
check(nextPollDelay(19, acc, t0 + 19 * 15000) === 15000, "fast until 20");
check(nextPollDelay(20, acc, t0 + 300000) === 60000, "slow after 20");
check(nextPollDelay(40, acc, t0 + 30 * 60000) === null, "stop after 30 min");
check(nextPollDelay(0, "bad", t0) === null, "bad acceptedAt stops");
let total = 0; let n = 0; let now = t0;
for (let d = nextPollDelay(n, acc, now); d !== null; d = nextPollDelay(n, acc, now)) { now += d; n += 1; total += 1; }
check(total <= 50, `max GETs per request ${total}`);
console.log(`polls per request until stop: ${total}`);

check(shouldResumePolling({ status: "処理中", requestId: id, acceptedAt: acc }, t0 + 3600000), "resume within 24h");
check(!shouldResumePolling({ status: "処理中", requestId: id, acceptedAt: acc }, t0 + 25 * 3600000), "no resume after 24h");
check(!shouldResumePolling({ status: "成功", requestId: id, acceptedAt: acc }, t0), "terminal not resumed");
check(isTerminalRequest({ status: "失敗", result: done.result }), "terminal");

const calls = [];
const r = await fetchResult(GAS, id, async (u, init) => { calls.push({ u, init }); return { ok: true, text: async () => JSON.stringify(done) }; });
check(r.kind === "done", "fetch done");
check(calls[0].init.method === "GET" && calls[0].init.credentials === "omit" && !calls[0].init.headers && !calls[0].init.body, "simple GET, no headers/body (no preflight)");
check((await fetchResult(GAS, id, async () => ({ ok: false, text: async () => JSON.stringify(done) }))).kind === "invalid", "http error invalid");

if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`ok: js/result.js ${passed} checks passed`);
