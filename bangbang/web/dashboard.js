// BangBang case overview (个案总览): one page that shows where a bill case stands, for the person helping
// Mrs. Lin (family member, caseworker) and for judges. Read-only: every action stays in the patient flow.
//
// Design credit: the stat tiles, the case stepper, the numbered "to verify" findings and the approval guard
// on the payment limit are ported from LemonLover101's blue React dashboard prototype (PR #7). Rebuilt here as
// vanilla JS on our jade/seal tokens, Chinese first, with every number read from the real CasePacket
// (GET /api/cases/:id + live CaseEvents over /ws). Nothing on this page is hard-coded data.

import {
  $, api, applyI18n, connectCase, getLang, h, mergeEvent, onLangChange, receiptItem, roleLabel, safeUrl, setupErrorBox,
  setupLangToggle, showError, t, usd, usd0, errorText,
} from "./app.js";

const state = { packet: null, sub: null, run: null, logs: [], runTimer: null };
const P = () => state.packet;
const zh = () => getLang() === "zh";

/* ------------------------------------------------------------ derived data */

const stakeOf = (p) => (p.flags ?? []).reduce((a, f) => a + (Number(f.amountAtStake) || 0), 0);
const hasMandate = (p) => p.receipts.some((r) => r.chain === "bsc" && /mandate/i.test(r.kind));
// A real (non-preview) BNB Chain mandate receipt: the only case where we say the limit is on-chain.
const hasRealMandate = (p) =>
  p.receipts.some((r) => r.chain === "bsc" && r.kind === "openMandate" && !/PREVIEW/.test(String(r.txHash)));
const isPreview = (p) =>
  (p.facts ?? []).some((f) => /^PREVIEW/.test(String(f))) ||
  p.receipts.some((r) => /PREVIEW/.test(String(r.txHash)) || /PREVIEW/.test(String(r.detail?.note ?? ""))) ||
  /PREVIEW/.test(p.charity?.summary ?? "") ||
  p.fairPrices.some((f) => (f.sources ?? []).some((s) => /PREVIEW/.test(s.title ?? "")));

/** How many of the 5 stepper steps are done, from CaseStatus (plus the data, for a failed case). */
function stepsDone(p) {
  const byStatus = { intake: 0, audited: 1, researched: 2, mandated: 3, negotiating: 3, agreed: 4, settled: 5 };
  if (p.status in byStatus) return byStatus[p.status];
  // failed: count what actually happened
  let n = p.bill ? 1 : 0;
  if (n === 1 && (p.fairPrices.length || p.charity)) n = 2;
  if (n === 2 && hasMandate(p)) n = 3;
  return n;
}
const pillClass = (s) => ({ negotiating: "live", agreed: "done", settled: "done", failed: "fail" })[s] ?? "review";

/* ---------------------------------------------------------------- render */

function renderHead(p) {
  $("#case-provider").textContent = p.bill?.provider?.name ?? (p.mode === "clinic" ? p.claim?.payer ?? "—" : "—");
  $("#case-id").textContent = [t("dashCaseId", p.id), p.bill?.serviceDate].filter(Boolean).join(" · ");
  const pill = $("#case-status");
  pill.className = `pill ${pillClass(p.status)}`;
  pill.textContent = t("caseStatus")[p.status] ?? p.status;
  $("#open-flow").href = p.mode === "clinic" ? "/clinic.html" : `/#case=${encodeURIComponent(p.id)}`;

  const names = t("caseSteps");
  const done = stepsDone(p);
  $("#stepper").replaceChildren(
    ...names.map((name, i) => {
      const cls = i < done ? "done" : i === done ? (p.status === "failed" ? "fail" : "now") : "todo";
      return h(
        "li",
        { class: cls, "aria-current": i === done ? "step" : null },
        h("span", { class: "dot", "aria-hidden": "true" }, i < done ? "✓" : String(i + 1)),
        h("span", { class: "label" }, name),
      );
    }),
  );
  $("#preview-banner").hidden = !isPreview(p);
}

function stat(cls, label, value, foot, tag) {
  return h(
    "div",
    { class: `stat ${cls}` },
    h("div", { class: "stat-top" }, h("span", { class: "stat-label" }, label), tag ?? null),
    h("b", { class: "stat-value" }, value),
    h("p", { class: "stat-foot" }, foot),
  );
}

function renderStats(p) {
  const bill = p.bill;
  const flags = p.flags ?? [];
  const max = p.patient?.maxPay;
  const tiles = [
    stat("bill", t("statBill"), usd(bill?.totalCharges), bill ? t("statBillFoot", usd(bill.patientBalance)) : ""),
    stat("issues", t("statIssues"), usd(stakeOf(p)), t("statIssuesFoot", flags.length), h("span", { class: "pill review" }, t("dashToVerify"))),
    stat("limit", t("statLimit"), max > 0 ? usd(max) : t("statLimitUnset"), t("statLimitFoot")),
  ];
  const asked = bill?.patientBalance;
  if (p.agreedAmount != null) {
    const saved = typeof asked === "number" ? asked - p.agreedAmount : undefined;
    tiles.push(stat("deal", t("statDeal"), usd(p.agreedAmount), saved > 0 ? t("statDealFoot", usd(saved)) : ""));
  } else tiles.push(stat("deal pending", t("statDeal"), "—", t("statDealNone")));
  $("#stats").replaceChildren(...tiles);
}

function renderFindings(p) {
  const flags = p.flags ?? [];
  const list = $("#findings");
  if (!flags.length) {
    list.replaceChildren(h("li", { class: "empty" }, t("dashNoFindings")));
    return;
  }
  const kinds = t("flagKinds");
  list.replaceChildren(
    ...flags.map((f, i) => {
      const li = f.lineIndex != null ? p.bill?.lineItems?.[f.lineIndex] : null;
      const lineName = li ? (zh() ? li.descriptionZh || li.description : li.description) : null;
      return h(
        "li",
        { class: `finding kind-${f.kind}` },
        h("span", { class: "num", "aria-hidden": "true" }, String(i + 1).padStart(2, "0")),
        h(
          "div",
          { class: "finding-body" },
          h("p", { class: "finding-text" }, zh() ? f.messageZh || f.message : f.message),
          lineName ? h("p", { class: "finding-line" }, `${t("dashLine", f.lineIndex + 1)}: ${lineName}${li.code ? ` (${li.code})` : ""}`) : null,
          h("div", { class: "finding-foot" }, h("span", { class: "tag" }, kinds[f.kind] ?? f.kind), f.amountAtStake ? h("b", {}, usd(f.amountAtStake)) : null),
        ),
      );
    }),
  );
}

function option(title, body, link) {
  return h("div", { class: "option" }, h("h3", {}, title), ...[].concat(body).filter(Boolean).map((b) => (b instanceof Node ? b : h("p", {}, b))), link ?? null);
}

function renderOptions(p) {
  const flags = p.flags ?? [];
  const flow = `/#case=${encodeURIComponent(p.id)}`;
  const errors = option(t("optErrors"), flags.length ? t("optErrorsBody", flags.length, usd(stakeOf(p))) : t("optErrorsNone"));

  let charityBody = t("optCharityNone");
  let charityLink = h("a", { class: "text", href: flow }, t("dashOpenFlow"));
  const c = p.charity;
  if (c) {
    charityBody = [c.hasFap ? (c.freeCareBelowPctFpl ? t("optCharityFree", c.freeCareBelowPctFpl) : null) : t("optCharityNoFap"), c.summary];
    const href = safeUrl(c.applicationUrl);
    charityLink = href ? h("a", { class: "text", href, target: "_blank", rel: "noopener" }, t("optCharityApply")) : null;
  }
  const charity = option(t("optCharity"), charityBody, charityLink);

  const fin = p.financing;
  const financing = option(
    t("optFinancing"),
    fin ? [h("p", { class: `rec-sm ${fin.recommendation}` }, fin.recommendation === "lump_sum" ? t("lumpSum") : t("paymentPlan")), zh() ? fin.reasonZh || fin.reason : fin.reason] : t("optFinancingNone"),
  );
  $("#options").replaceChildren(errors, charity, financing);
}

function renderRoom(p) {
  const asked = p.bill?.patientBalance;
  const theirs = [...p.offers].reverse().find((o) => o.by !== "advocate");
  const current = p.agreedAmount ?? theirs?.amount ?? p.offers.at(-1)?.amount;
  $("#tk-asked").textContent = usd0(asked);
  $("#tk-current").textContent = usd0(current);
  const saved = typeof asked === "number" && typeof current === "number" ? asked - current : undefined;
  $("#tk-saved").textContent = saved > 0 ? usd0(saved) : "—";
  $("#tk-pct").textContent = saved > 0 && asked > 0 ? `${Math.round((saved / asked) * 100)}%` : "";
  $("#deal-stamp").hidden = p.agreedAmount == null;

  const pill = $("#room-pill");
  pill.className = `pill ${pillClass(p.status)}`;
  pill.textContent = t("caseStatus")[p.status] ?? p.status;

  const max = p.patient?.maxPay;
  $("#limit-guard").replaceChildren(
    max > 0 ? t("guardLimit", usd(max)) : t("guardUnset"),
    max > 0 && hasRealMandate(p) ? h("span", { class: "onchain" }, ` ${t("guardOnChain")}`) : "",
  );
  $("#limit-guard").classList.toggle("unset", !(max > 0));

  const list = $("#transcript");
  if (!p.transcript.length) {
    list.replaceChildren(h("li", { class: "empty" }, t("waitingLines")));
    return;
  }
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  list.replaceChildren(
    ...p.transcript.map((line) => {
      const zhP = line.textZh ? h("p", { class: "zh", lang: "zh-CN" }, line.textZh) : null;
      const enP = h("p", { class: "en", lang: "en" }, line.text);
      const us = /advoc|bang|^agent$|^ai$/i.test(line.role);
      return h("li", { class: `line ${us ? "us" : "them"}` }, h("span", { class: "who" }, roleLabel(line.role)), ...(zh() ? [zhP, enP] : [enP, zhP]));
    }),
  );
  // follow new lines inside the box only; never scroll the page
  if (atBottom || !state.roomSeen) list.scrollTop = list.scrollHeight;
  state.roomSeen = true;
}

function renderRun() {
  const r = state.run;
  $("#run-card").hidden = !r;
  if (!r) return;
  const names = t("runSteps");
  const st = t("runStatus");
  $("#run-steps").replaceChildren(
    ...r.steps.map((s) =>
      h(
        "li",
        { class: `run-step ${s.status}` },
        h("span", { class: "run-name" }, names[s.name] ?? s.name),
        h("span", { class: `pill ${s.status === "ok" ? "done" : s.status === "failed" ? "fail" : s.status === "running" ? "live" : "review"}` }, st[s.status] ?? s.status),
        // the one-button run simulates the hospital's $0 confirmation: say so, always
        s.name === "confirm" && s.status !== "pending" ? h("span", { class: "sim" }, t("simulatedTag")) : null,
        s.message && s.status !== "ok" ? h("span", { class: "run-msg" }, s.message) : null,
      ),
    ),
  );
}

function renderActivity() {
  $("#activity-card").hidden = !state.logs.length;
  $("#activity").replaceChildren(...state.logs.slice(-8).map((l) => h("li", {}, zh() ? l.messageZh || l.message : l.message)));
}

function renderReceipts(p) {
  const rs = [...p.receipts].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  $("#receipts").replaceChildren(...(rs.length ? rs.map(receiptItem) : [h("li", { class: "empty" }, t("noReceipts"))]));
}

function renderAll() {
  const p = P();
  if (!p) return;
  renderHead(p);
  renderStats(p);
  renderFindings(p);
  renderOptions(p);
  renderRoom(p);
  renderRun();
  renderActivity();
  renderReceipts(p);
}

/* ------------------------------------------------------------ data flow */

async function refreshRun() {
  if (!P()) return;
  try {
    state.run = await api(`/api/cases/${encodeURIComponent(P().id)}/run`);
  } catch {
    state.run = null; // 404: no one-button run for this case
  }
  renderRun();
}
function scheduleRun() {
  clearTimeout(state.runTimer);
  state.runTimer = setTimeout(refreshRun, 400);
}

function onEvent(ev) {
  if (ev.type === "case") {
    if (ev.packet) state.packet = ev.packet;
    renderAll();
    return;
  }
  if (ev.type === "audio") return; // the dashboard is silent; audio plays in the patient room
  if (ev.type === "log") {
    state.logs.push(ev);
    renderActivity();
    scheduleRun();
    return;
  }
  if (ev.type === "error") {
    showError(t("failed") + ev.message);
    scheduleRun();
    return;
  }
  if (P() && mergeEvent(P(), ev)) {
    renderAll();
    if (ev.type === "status") scheduleRun();
  }
}

async function openCase(id) {
  state.sub?.close();
  state.logs = [];
  state.roomSeen = false;
  $("#case-picker").hidden = true;
  try {
    state.packet = await api(`/api/cases/${encodeURIComponent(id)}`);
  } catch (e) {
    showError(errorText(e));
    return showPicker();
  }
  $("#case-view").hidden = false;
  $("#patient-link").href = `/#case=${encodeURIComponent(id)}`;
  state.sub = connectCase(id, onEvent);
  renderAll();
  refreshRun();
}

async function showPicker() {
  state.sub?.close();
  state.packet = null;
  $("#case-view").hidden = true;
  $("#case-picker").hidden = false;
  const list = $("#case-list");
  let cases = [];
  try {
    cases = await api("/api/cases");
  } catch (e) {
    showError(errorText(e));
  }
  cases = (Array.isArray(cases) ? cases : []).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  list.replaceChildren(
    ...(cases.length
      ? cases.map((c) =>
          h(
            "li",
            {},
            h(
              "a",
              { class: "case-row", href: `#case=${encodeURIComponent(c.id)}` },
              h("span", { class: "cr-name" }, c.bill?.provider?.name ?? c.claim?.payer ?? c.id),
              h("span", { class: "cr-meta" }, `${c.id}${c.bill ? ` · ${usd(c.bill.totalCharges)}` : ""}`),
              h("span", { class: `pill ${pillClass(c.status)}` }, t("caseStatus")[c.status] ?? c.status),
            ),
          ),
        )
      : [h("li", { class: "empty" }, t("dashNoCases"))]),
  );
}

function route() {
  const id = new URLSearchParams(location.hash.slice(1)).get("case");
  if (id) openCase(id);
  else showPicker();
}

setupLangToggle();
setupErrorBox();
onLangChange(() => {
  applyI18n();
  if (P()) renderAll();
  else showPicker();
});
window.addEventListener("hashchange", route);
route();
