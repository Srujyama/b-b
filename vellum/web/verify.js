// Vellum verify page: recompute the advocate's tamper-evident log in the browser.
// Data: GET /api/cases/:id/proof (server/src/routes/proof.ts) or a downloaded bundle file. The math lives in
// verify-core.js (pure, also run by test/proof.test.ts against chain/bnb.ts verifyChain). keccak-256 comes from a
// pinned @noble/hashes build on jsDelivr; if it cannot load we say so instead of showing a verdict.

import { $, I18N, api, errorText, h, receiptItem, safeUrl, setupErrorBox, showError, t, usd } from "./app.js";
import { bundleProblems, flattenEntries, overall, verifyEntries } from "./verify-core.js";

export const KECCAK_URL = "https://cdn.jsdelivr.net/npm/@noble/hashes@1.4.0/esm/sha3.js/+esm";
// a CDN that never answers must not leave the page "computing" forever: after this long we say it failed
const KECCAK_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ strings */

const STRINGS = {
  en: {
    vfBrand: "Verify the record", vfEyebrow: "Tamper-evident log", vfTitle: "Has this negotiation record been changed?",
    vfLede: "Vellum hashes every offer and every line of the call into a chain. This page recomputes it in your own browser, so you don't have to trust our server.",
    vfPick: "Pick a case", vfNoCases: "No cases on this server yet.",
    vfLoadTitle: "Verify a downloaded file", vfLoadLede: "You can also check a proof file (.json) someone sent you. It is read in your browser only, never uploaded.",
    vfLoadBtn: "Choose a proof file", vfBadFile: (why) => `This is not a Vellum proof file: ${why}`,
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
    vfNoEntries: "No entries yet. Once Vellum negotiates, every offer appears here.",
    vfHashOk: "Content hash matches", vfHashBad: "Content was changed", vfHeadOk: "Head matches", vfHeadBad: "Chain breaks here",
    vfAfterBreak: "Broken upstream, so this head no longer matches",
    vfKinds: { offer: "Offer", transcript: "Call line", note: "Note" },
    vfBy: { advocate: "Vellum", hospital: "Hospital", insurer: "Insurer", patient: "Patient", system: "System" },
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
  a.download = state.fileName ?? `vellum-proof-${b.case.id.slice(0, 8)}.json`;
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

setupErrorBox();
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
route();
