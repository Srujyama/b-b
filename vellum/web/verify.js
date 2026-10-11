// BangBang verify page (核验记录): recompute the advocate's tamper-evident log in the browser.
// Data: GET /api/cases/:id/proof (server/src/routes/proof.ts) or a downloaded bundle file. The math lives in
// verify-core.js (pure, also run by test/proof.test.ts against chain/bnb.ts verifyChain). keccak-256 comes from a
// pinned @noble/hashes build on jsDelivr; if it cannot load we say so instead of showing a verdict.

import { $, I18N, api, applyI18n, errorText, getLang, h, onLangChange, receiptItem, safeUrl, setupErrorBox, setupLangToggle, showError, t, usd } from "./app.js";
import { bundleProblems, flattenEntries, overall, verifyEntries } from "./verify-core.js";

export const KECCAK_URL = "https://cdn.jsdelivr.net/npm/@noble/hashes@1.4.0/esm/sha3.js/+esm";
// a CDN that never answers must not leave the page "computing" forever: after this long we say it failed
const KECCAK_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ strings (zh first, en for judges) */

const STRINGS = {
  zh: {
    vfBrand: "核验记录", vfEyebrow: "防篡改记录", vfTitle: "这份谈判记录有没有被改过？",
    vfLede: "帮帮把每一次出价和每一句对话做成哈希，串成一条链。这个页面在您自己的浏览器里重新计算，不需要相信我们的服务器。",
    vfPick: "选一个个案", vfNoCases: "服务器上还没有个案。",
    vfLoadTitle: "核验下载的文件", vfLoadLede: "别人发给您的核验文件（.json）也可以在这里检查。文件只在您的浏览器里读取，不会上传。",
    vfLoadBtn: "选择核验文件", vfBadFile: (why) => `这不是帮帮的核验文件：${why}`,
    vfFromFile: (name) => `正在核验文件 ${name}。文件里写的链上数值只是文件的说法，请点合约链接自己去 BNB 链上查。`,
    vfPreview: "这是界面预览数据（开发用）：病人、通话和交易都不是真的，这条记录也从来没有上链。",
    vfCase: (id) => `个案 ${id}`,
    vfLoading: "正在计算……", vfLoadingText: "正在加载哈希计算库，马上在您的浏览器里重新计算。", vfLibTimeout: "超时", vfNoLib: "无法加载哈希计算库，所以没法核验。请检查网络后刷新。",
    vfStates: {
      anchored: ["和 BNB 链上的记录一致", (n) => `${n} 条记录都重新算过，结果和 BNB 测试链上合约存的链头完全相同。`],
      local: ["本地一致，尚未上链", (n, why) => `${n} 条记录在您的浏览器里重新算过，前后完全对得上；但还没有锚定在 BNB 链上（${why}），所以还不能和链上比对。`],
      empty: ["还没有谈判记录", (n, why) => `这个个案还没有记录任何出价或对话。${why ? `链上状态：${why}。` : ""}`],
      broken: ["记录对不上", (n, why) => why],
      mismatch: ["和 BNB 链上的记录不一致", () => "每条记录自己对得上，但重新算出的链头和链上合约存的不一样：有记录被删掉、加进来，或者链上还有别的记录。"],
    },
    vfBrokenEdited: (i) => `第 ${i + 1} 条记录的内容和它当初的哈希不一样：内容被改过。从这一条开始，后面的链头全部对不上。`,
    vfBrokenHead: (i) => `第 ${i + 1} 条之后的链头和记录的不一样：有记录被删掉或调换了顺序。`,
    vfTamperOn: "（篡改测试：只改了您浏览器里的副本）",
    vfReasons: { "contract not deployed": "合约还没有部署", "on-chain read failed": "读取链上数据失败" },
    vfHeadRecomputed: "重新算出的链头", vfHeadClaimed: "服务器声称的链头", vfHeadOnChain: "BNB 链上的链头", vfNone: "没有",
    vfContract: "在 BscScan 上查看合约",
    vfTamper: "篡改测试", vfTamperWhich: "改哪一条",
    vfTamperNote: "把其中一条记录改动一个字节（只改您浏览器里的副本），看看哈希链从哪里断开。",
    vfTamperDid: (i, b, from, to) => `已把第 ${i + 1} 条的第 ${b} 个字节从 “${from}” 改成 “${to}”。`,
    vfTamperNone: "没有记录可以改。",
    vfEntries: "每一条记录", vfCount: (n) => `${n} 条`,
    vfSourceServer: "来源：服务器的链下记录（每一条都已经发到 BNB 链上的合约）。",
    vfSourcePreview: "来源：预览用的本地记录，从来没有发到链上。",
    vfNoEntries: "还没有记录。帮帮开始和医院谈以后，每一次出价都会在这里出现。",
    vfHashOk: "内容哈希对得上", vfHashBad: "内容被改过", vfHeadOk: "链头对得上", vfHeadBad: "链从这里断开",
    vfAfterBreak: "前面断了，这一条也跟着对不上",
    vfKinds: { offer: "出价", transcript: "对话", note: "备注" },
    vfBy: { advocate: "帮帮", hospital: "医院", insurer: "保险公司", patient: "病人", system: "系统" },
    vfDetails: "看完整哈希", vfEntryHash: "内容哈希", vfRecorded: "记录的", vfRecomputed: "重新算的", vfHead: "链头",
    vfMandate: "您的授权", vfNoMandate: "还没有授权。",
    vfMax: "最多可以同意", vfConsentHash: "同意书哈希（个人信息不上链）",
    vfMandateAnchored: "这个上限已经记录在 BNB 链上。", vfMandateMatch: "链上的同意书哈希和这里算的一样。", vfMandateNoMatch: "链上的同意书哈希和这里算的不一样！",
    vfMandateLocal: "这个哈希是根据个案算出来的，还没有记录在链上。",
    vfReceipts: "结算凭证", vfNoReceipts: "还没有凭证。",
    vfHow: "怎么算的",
    vfHowSteps: [
      "每条记录先排好字段顺序，变成一段固定的文字（canonical JSON）。",
      "内容哈希 = keccak256（这段文字）。改一个字，哈希就全变。",
      "链头从 32 个零字节开始；每加一条，新链头 = keccak256（上一个链头 + 这条的内容哈希）。",
      "BNB 链上的 AdvocateLedger 合约用同样的公式存链头。两边一样，就说明记录没有被改、删或调换。",
    ],
    vfDownload: "下载核验文件", vfToDash: "回到个案总览",
  },
  en: {
    vfBrand: "Verify the record", vfEyebrow: "Tamper-evident log", vfTitle: "Has this negotiation record been changed?",
    vfLede: "BangBang hashes every offer and every line of the call into a chain. This page recomputes it in your own browser, so you don't have to trust our server.",
    vfPick: "Pick a case", vfNoCases: "No cases on this server yet.",
    vfLoadTitle: "Verify a downloaded file", vfLoadLede: "You can also check a proof file (.json) someone sent you. It is read in your browser only, never uploaded.",
    vfLoadBtn: "Choose a proof file", vfBadFile: (why) => `This is not a BangBang proof file: ${why}`,
    vfFromFile: (name) => `Verifying the file ${name}. Any on-chain values inside a file are only the file's claim; open the contract link to check BNB Chain yourself.`,
    vfPreview: "UI preview data (dev harness): the patient, call and transactions are not real, and this log was never put on-chain.",
    vfCase: (id) => `Case ${id}`,
    vfLoading: "Computing…", vfLoadingText: "Loading the hashing library; the check runs in your browser in a moment.", vfLibTimeout: "timed out", vfNoLib: "Could not load the hashing library, so nothing can be verified. Check the network and reload.",
    vfStates: {
      anchored: ["Matches the record on BNB Chain", (n) => `All ${n} entries were recomputed and the head equals the one stored by the contract on BNB testnet.`],
      local: ["Locally consistent; not yet anchored on BNB", (n, why) => `All ${n} entries recompute and chain together in your browser, but the log is not yet anchored on BNB Chain (${why}), so there is no on-chain head to compare with.`],
      empty: ["No negotiation log yet", (n, why) => `No offers or call lines have been logged for this case.${why ? ` On-chain: ${why}.` : ""}`],
      broken: ["The record does not verify", (n, why) => why],
      mismatch: ["Does not match BNB Chain", () => "Each entry is self-consistent, but the recomputed head differs from the contract's head: entries were dropped or added, or the chain holds entries this file lacks."],
    },
    vfBrokenEdited: (i) => `Entry ${i + 1} no longer matches the hash it was recorded with: its content was changed. Every head after it breaks too.`,
    vfBrokenHead: (i) => `The head after entry ${i + 1} differs from the recorded one: an entry was dropped or reordered.`,
    vfTamperOn: " (tamper test: only your browser's copy was changed)",
    vfReasons: { "contract not deployed": "contract not deployed", "on-chain read failed": "on-chain read failed" },
    vfHeadRecomputed: "Recomputed head", vfHeadClaimed: "Head the server claims", vfHeadOnChain: "Head on BNB Chain", vfNone: "none",
    vfContract: "View the contract on BscScan",
    vfTamper: "Tamper test", vfTamperWhich: "Which entry",
    vfTamperNote: "Flip one byte of one entry (in your browser's copy only) and watch where the hash chain breaks.",
    vfTamperDid: (i, b, from, to) => `Changed byte ${b} of entry ${i + 1} from "${from}" to "${to}".`,
    vfTamperNone: "No entries to change.",
    vfEntries: "Every entry", vfCount: (n) => `${n} entr${n === 1 ? "y" : "ies"}`,
    vfSourceServer: "Source: the server's off-chain log (each entry was appended to the contract on BNB Chain).",
    vfSourcePreview: "Source: a local preview log that was never sent to any chain.",
    vfNoEntries: "No entries yet. Once BangBang negotiates, every offer appears here.",
    vfHashOk: "Content hash matches", vfHashBad: "Content was changed", vfHeadOk: "Head matches", vfHeadBad: "Chain breaks here",
    vfAfterBreak: "Broken upstream, so this head no longer matches",
    vfKinds: { offer: "Offer", transcript: "Call line", note: "Note" },
    vfBy: { advocate: "BangBang", hospital: "Hospital", insurer: "Insurer", patient: "Patient", system: "System" },
    vfDetails: "Full hashes", vfEntryHash: "Entry hash", vfRecorded: "recorded", vfRecomputed: "recomputed", vfHead: "Head",
    vfMandate: "The patient's mandate", vfNoMandate: "No mandate yet.",
    vfMax: "May agree to at most", vfConsentHash: "Consent hash (no personal data on-chain)",
    vfMandateAnchored: "This limit is recorded on BNB Chain.", vfMandateMatch: "The on-chain consent hash equals the one computed here.", vfMandateNoMatch: "The on-chain consent hash differs from the one computed here!",
    vfMandateLocal: "Computed from the case; not yet recorded on-chain.",
    vfReceipts: "Settlement receipts", vfNoReceipts: "No receipts yet.",
    vfHow: "How the check works",
    vfHowSteps: [
      "Each entry is serialized with sorted keys into one fixed string (canonical JSON).",
      "Entry hash = keccak256(that string). Change one character and the hash changes completely.",
      "The head starts as 32 zero bytes; each entry makes head = keccak256(previous head ‖ entry hash).",
      "The AdvocateLedger contract on BNB Chain stores its head with the same formula. Equal heads mean nothing was edited, dropped or reordered.",
    ],
    vfDownload: "Download the proof file", vfToDash: "Back to the case overview",
  },
};
Object.assign(I18N.zh, STRINGS.zh);
Object.assign(I18N.en, STRINGS.en);

/* ------------------------------------------------------------------ state */

const state = { bundle: null, fileName: null, keccak: null, libError: false, tamperOn: false, tamperAt: 0, dl: null };

async function loadKeccak() {
  if (state.keccak || state.libError) return state.keccak;
  try {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${t("vfLibTimeout")} (${KECCAK_TIMEOUT_MS / 1000}s)`)), KECCAK_TIMEOUT_MS);
    });
    const mod = await Promise.race([import(KECCAK_URL), timeout]).finally(() => clearTimeout(timer));
    state.keccak = (bytes) => mod.keccak_256(bytes);
  } catch (e) {
    state.libError = true;
    showError(`${t("vfNoLib")} (${KECCAK_URL}: ${e.message})`);
  }
  return state.keccak;
}

/* ------------------------------------------------------------------ render */

const short = (x) => (typeof x === "string" && x.length > 18 ? `${x.slice(0, 10)}…${x.slice(-6)}` : x || "—");
const mark = (ok) => (ok === false ? "✗" : ok === true ? "✓" : "–");
const reasonText = (r) => (r ? t("vfReasons")[r] ?? r : "");

function renderVerdict(b, res) {
  const st = overall(res, b);
  const [title, body] = t("vfStates")[st];
  let why = reasonText(b.onChainReason);
  if (st === "broken") why = res.reason === "entry-edited" ? t("vfBrokenEdited", res.firstBadIndex) : t("vfBrokenHead", res.firstBadIndex);
  $("#vf-verdict").className = `vf-verdict ${st}`;
  $("#vf-stamp").textContent = st === "anchored" || st === "local" ? "✓" : st === "empty" ? "○" : "✗";
  $("#vf-case").textContent = t("vfCase", b.case.id);
  $("#vf-verdict-title").textContent = title;
  $("#vf-verdict-text").textContent = body(res.count, why) + (state.tamperOn && st !== "anchored" && st !== "local" ? t("vfTamperOn") : "");

  const oc = b.onChain;
  const row = (label, value, ok, extra) =>
    h("div", { class: "vf-head-row" }, h("dt", {}, label), h("dd", {}, h("code", { title: value ?? "" }, value ? short(value) : t("vfNone")), ok == null ? null : h("b", { class: ok ? "ok" : "bad" }, mark(ok)), extra ?? null));
  const claimedOk = b.claimedHead ? b.claimedHead.head.toLowerCase() === res.head.toLowerCase() && b.claimedHead.count === res.count : null;
  const href = oc && safeUrl(oc.contractUrl);
  $("#vf-heads").replaceChildren(
    row(t("vfHeadRecomputed"), res.head, null),
    row(t("vfHeadClaimed"), b.claimedHead?.head, claimedOk),
    oc
      ? row(t("vfHeadOnChain"), oc.head, res.onChainMatch, href ? h("a", { class: "vf-contract", href, target: "_blank", rel: "noopener" }, t("vfContract")) : null)
      : row(t("vfHeadOnChain"), null, null, h("span", { class: "vf-why" }, reasonText(b.onChainReason))),
  );
}

function renderTamper(b) {
  const n = b.entries.length;
  const sel = $("#vf-tamper-at");
  const on = $("#vf-tamper-on");
  $("#vf-tamper").hidden = n === 0; // nothing to tamper with
  on.disabled = n === 0;
  sel.disabled = n === 0 || !state.tamperOn;
  if (sel.options.length !== n) {
    sel.replaceChildren(...b.entries.map((e, i) => h("option", { value: String(i) }, `#${i + 1}`)));
    if (!state.tamperOn) state.tamperAt = Math.floor(n / 2);
  }
  if (state.tamperAt >= n) state.tamperAt = Math.max(0, n - 1);
  sel.value = String(state.tamperAt);
  on.checked = state.tamperOn;
}

function entryRow(r, res) {
  const body = r.body ?? {};
  const broken = res.firstBadIndex !== undefined && r.index >= res.firstBadIndex;
  const first = r.index === res.firstBadIndex;
  const cls = r.tampered ? "tampered" : first ? "bad" : broken ? "after" : "ok";
  const kinds = t("vfKinds");
  const by = t("vfBy");
  const status =
    r.hashOk === false
      ? h("span", { class: "vf-tag bad" }, `${mark(false)} ${t("vfHashBad")}`)
      : r.headOk === false
        ? h("span", { class: "vf-tag bad" }, `${mark(false)} ${first ? t("vfHeadBad") : t("vfAfterBreak")}`)
        : h("span", { class: "vf-tag ok" }, `${mark(true)} ${t("vfHashOk")} · ${t("vfHeadOk")}`);
  return h(
    "li",
    { class: `vf-entry ${cls}` },
    h("span", { class: "vf-seq", "aria-hidden": "true" }, String(r.index + 1)),
    h(
      "div",
      { class: "vf-entry-body" },
      h(
        "p",
        { class: "vf-entry-meta" },
        h("b", {}, by[body.by] ?? body.by ?? "—"),
        ` · ${kinds[body.kind] ?? body.kind ?? ""}`,
        typeof body.amount === "number" ? h("span", { class: "vf-amt" }, usd(body.amount)) : null,
      ),
      body.text ? h("p", { class: "vf-entry-text" }, body.text) : null,
      r.tampered ? h("p", { class: "vf-tampered" }, t("vfTamperDid", r.index, r.tampered.byte, r.tampered.from, r.tampered.to)) : null,
      status,
      h(
        "details",
        { class: "vf-hashes" },
        h("summary", {}, t("vfDetails")),
        h(
          "dl",
          {},
          h("dt", {}, `${t("vfEntryHash")} (${t("vfRecomputed")})`), h("dd", {}, h("code", {}, r.entryHash)),
          h("dt", {}, `${t("vfEntryHash")} (${t("vfRecorded")})`), h("dd", {}, h("code", {}, r.recordedEntryHash ?? "—")),
          h("dt", {}, `${t("vfHead")} (${t("vfRecomputed")})`), h("dd", {}, h("code", {}, r.head)),
          h("dt", {}, `${t("vfHead")} (${t("vfRecorded")})`), h("dd", {}, h("code", {}, r.recordedHead ?? "—")),
        ),
      ),
    ),
  );
}

function renderMandate(b) {
  const m = b.mandate;
  if (!m) return $("#vf-mandate").replaceChildren(h("p", { class: "fine" }, t("vfNoMandate"), b.mandateReason ? ` (${b.mandateReason})` : ""));
  const kids = [
    h("p", { class: "vf-max" }, h("span", {}, t("vfMax")), h("b", {}, usd(m.maxAmountUsd))),
    h("p", { class: "vf-k" }, t("vfConsentHash")),
    h("code", { class: "vf-long" }, m.consentHash),
  ];
  if (m.anchored) {
    kids.push(h("p", { class: "vf-ok" }, t("vfMandateAnchored")));
    kids.push(h("p", { class: m.consentHashMatchesOnChain ? "vf-ok" : "vf-bad" }, m.consentHashMatchesOnChain ? t("vfMandateMatch") : t("vfMandateNoMatch")));
  } else kids.push(h("p", { class: "fine" }, t("vfMandateLocal")));
  $("#vf-mandate").replaceChildren(...kids);
}

function renderReceipts(b) {
  const all = [...(b.receipts?.bsc ?? []), ...(b.receipts?.xrpl ?? []), ...(b.receipts?.other ?? [])].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  $("#vf-receipts").replaceChildren(...(all.length ? all.map(receiptItem) : [h("li", { class: "empty" }, t("vfNoReceipts"))]));
}

function setDownload(b) {
  if (state.dl) URL.revokeObjectURL(state.dl);
  state.dl = URL.createObjectURL(new Blob([JSON.stringify(b, null, 2)], { type: "application/json" }));
  const a = $("#vf-download");
  a.href = state.dl;
  a.download = state.fileName ?? `bangbang-proof-${b.case.id.slice(0, 8)}.json`;
}

// The file loader sits at the top while nothing is open, and moves below the results once a case or file is shown,
// so the verdict is the first thing on screen (especially on a phone).
function placeLoader(afterResults) {
  const loader = $("#vf-loader");
  const anchor = afterResults ? $("#vf-result") : $("#vf-picker");
  if (anchor.nextElementSibling !== loader) anchor.after(loader);
  loader.classList.toggle("vf-loader-after", afterResults);
}

function render() {
  const b = state.bundle;
  if (!b) return;
  placeLoader(true);
  $("#vf-result").hidden = false;
  $("#vf-preview").hidden = !b.preview;
  const fn = $("#vf-from-file");
  fn.hidden = !state.fileName;
  fn.textContent = state.fileName ? t("vfFromFile", state.fileName) : "";
  $("#vf-count").textContent = t("vfCount", b.entries.length);
  $("#vf-source").hidden = b.entries.length === 0;
  $("#vf-source").textContent = /^PREVIEW/.test(b.entriesSource ?? "") ? t("vfSourcePreview") : t("vfSourceServer");
  $("#vf-how").replaceChildren(...t("vfHowSteps").map((s) => h("li", {}, s)));
  renderTamper(b);
  renderMandate(b);
  renderReceipts(b);

  if (!state.keccak) {
    // not a verdict yet: neutral while loading, and "could not check" (not "tampered") if the library failed
    $("#vf-verdict").className = `vf-verdict ${state.libError ? "nolib" : "loading"}`;
    $("#vf-stamp").textContent = state.libError ? "!" : "…";
    $("#vf-case").textContent = t("vfCase", b.case.id);
    $("#vf-verdict-title").textContent = state.libError ? t("vfNoLib") : t("vfLoading");
    $("#vf-verdict-text").textContent = state.libError ? "" : t("vfLoadingText");
    $("#vf-heads").hidden = true;
    $("#vf-entries").replaceChildren();
    return;
  }
  const tamper = state.tamperOn && b.entries.length ? { index: state.tamperAt } : undefined;
  const res = verifyEntries(state.keccak, flattenEntries(b), { tamper, onChain: b.onChain });
  $("#vf-heads").hidden = false;
  renderVerdict(b, res);
  $("#vf-entries").replaceChildren(...(res.rows.length ? res.rows.map((r) => entryRow(r, res)) : [h("li", { class: "empty" }, t("vfNoEntries"))]));
}

/* ------------------------------------------------------------------ load */

async function show(bundle, fileName = null, tamperAt = null) {
  state.bundle = bundle;
  state.fileName = fileName;
  // #case=<id>&tamper=<n> opens with the tamper test on entry n (1-based), for a shareable demo link
  state.tamperOn = tamperAt != null && tamperAt >= 1 && tamperAt <= (bundle.entries?.length ?? 0);
  if (state.tamperOn) state.tamperAt = tamperAt - 1;
  $("#vf-picker").hidden = true;
  $("#vf-dash").href = `/dashboard.html#case=${encodeURIComponent(bundle.case.id)}`;
  setDownload(bundle);
  render();
  await loadKeccak();
  render();
}

async function openCase(id, tamperAt) {
  try {
    await show(await api(`/api/cases/${encodeURIComponent(id)}/proof`), null, tamperAt);
  } catch (e) {
    showError(errorText(e));
    showPicker();
  }
}

async function showPicker() {
  state.bundle = null;
  placeLoader(false);
  $("#vf-result").hidden = true;
  $("#vf-picker").hidden = false;
  let cases = [];
  try {
    cases = await api("/api/cases");
  } catch (e) {
    showError(errorText(e));
  }
  cases = (Array.isArray(cases) ? cases : []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $("#vf-cases").replaceChildren(
    ...(cases.length
      ? cases.map((c) =>
          h(
            "li",
            {},
            h(
              "a",
              { class: "case-row", href: `#case=${encodeURIComponent(c.id)}` },
              h("span", { class: "cr-name" }, c.bill?.provider?.name ?? c.claim?.payer ?? c.id),
              h("span", { class: "cr-meta" }, c.id),
            ),
          ),
        )
      : [h("li", { class: "empty" }, t("vfNoCases"))]),
  );
}

async function onFile(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = "";
  if (!file) return;
  let b;
  try {
    b = JSON.parse(await file.text());
  } catch (e) {
    return showError(t("vfBadFile", e.message));
  }
  const problems = bundleProblems(b);
  if (problems.length) return showError(t("vfBadFile", problems.join("; ")));
  history.replaceState(null, "", location.pathname);
  await show(b, file.name);
}

function route() {
  const q = new URLSearchParams(location.hash.slice(1));
  const id = q.get("case");
  if (id) openCase(id, q.has("tamper") ? Number(q.get("tamper")) : null);
  else if (!state.fileName) showPicker();
}

setupLangToggle();
setupErrorBox();
onLangChange(() => {
  applyI18n();
  if (state.bundle) render();
  else showPicker();
});
$("#vf-file").addEventListener("change", onFile);
$("#vf-tamper-on").addEventListener("change", (e) => {
  state.tamperOn = e.target.checked;
  render();
});
$("#vf-tamper-at").addEventListener("change", (e) => {
  state.tamperAt = Number(e.target.value) || 0;
  render();
});
window.addEventListener("hashchange", route);
document.documentElement.lang = getLang() === "zh" ? "zh-CN" : "en";
route();
