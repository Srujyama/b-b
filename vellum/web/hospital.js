// Vellum hospital portal: the billing office's side of the settlement.
//
// A teammate on a second laptop plays the hospital. They pick a settlement from the queue, check the XRPL escrow
// the patient locked for them (amount, transaction, condition) and the hardship credential, then confirm the
// account is at $0. That calls POST /api/hospital/cases/:id/confirm-zero-balance, which runs the same release path
// as /api/cases/:id/confirm-zero-balance: one XRPL Batch [EscrowFinish + advocate fee].
// Every value on the page comes from the server (GET /api/hospital/...) or live CaseEvents over /ws.

import {
  $, I18N, api, busy, connectCase, h, receiptItem, safeUrl, setupErrorBox, t, usd,
} from "./app.js";

Object.assign(I18N.en, {
  hospBrand: "Hospital billing portal",
  hospNet: "XRPL devnet: a test network. No real money moves.",
  hospQueueTitle: "Settlements to confirm",
  hospQueueLede:
    "Each patient below agreed a settlement with a Vellum advocate. The money is locked in escrow for the hospital, or will be, and is paid out only when you confirm the account is at $0.",
  hospEmpty: "No settlements yet. Cases appear here once the advocate and the billing office agree on an amount.",
  hospBack: "All settlements",
  hospPreview: "Preview data from the design harness: not a real patient, and its receipts are not real transactions.",
  hospPatient: "Patient",
  hospWaiting: "The patient's advocate is waiting on your confirmation right now.",
  hospBilled: "Billed balance",
  hospAgreed: "Agreed settlement",
  hospLocked: "Locked in escrow",
  hospConfirmTitle: "Confirm the account balance",
  hospStaff: "Your name (optional, shown to the patient's advocate)",
  hospConfirmBtn: "Confirm $0 balance & release escrow",
  hospStamp: "PAID",
  hospReleasedTitle: "Escrow released to the hospital",
  hospEscrowTitle: "XRPL escrow",
  hospConditionNote:
    "The condition is a PREIMAGE-SHA-256 crypto-condition. Its fulfillment (the release key) stays with Vellum and is revealed on the ledger only inside the release transaction, so nobody can pull the money early.",
  hospCredTitle: "Hardship credential",
  hospCredNote:
    "Issued on XRPL by the patient's clinic social worker and accepted by the patient. It supports the financial-assistance basis for the settlement.",
  hospActivity: "Activity on this case",
  hospActivityEmpty: "Live updates since you opened this page will appear here.",
  hospStage: { awaiting_confirmation: "Ready to confirm", awaiting_escrow: "Waiting for escrow", released: "Released" },
  hospAdvocateWaiting: "Advocate waiting",
  hospRowAgreed: (a) => `Agreed ${a}`,
  hospAcct: (a) => `Account ${a}`,
  hospServed: (d) => `Service date ${d}`,
  hospConfirmLede: (prov, pat, amt, locked) =>
    `${prov} agreed to settle ${pat}'s account for ${amt}. ${locked} is locked in escrow, payable to the hospital's XRPL account.`,
  hospConfirmLedeNoEscrow: (prov, pat, amt) => `${prov} agreed to settle ${pat}'s account for ${amt}. The money is not in escrow yet.`,
  hospAttest: (prov, pat, amt) =>
    `I have checked ${prov}'s records: with this ${amt} settlement applied, ${pat}'s account has a balance of $0.`,
  hospWhyNoEscrow: "The patient's side has not locked the money in escrow yet. This page updates by itself when it does.",
  hospWhyAttest: "Tick the box above to confirm the balance first.",
  hospReleasedLede: (amt) => `${amt} was paid to the hospital in one atomic XRPL Batch, together with Vellum's advocate fee.`,
  hospReleasedNoAmt: "The escrow was paid to the hospital in one atomic XRPL Batch, together with Vellum's advocate fee.",
  hospReleasedBy: (who) => `Confirmed by ${who}.`,
  hospDl: {
    state: "Status", amount: "Amount", tx: "Escrow transaction", from: "From (patient wallet)", to: "To (hospital wallet)",
    seq: "Offer sequence", condition: "Condition", expires: "Returns to the patient if not released by",
    type: "Type", credStatus: "Status", issuer: "Issuer (clinic)", holder: "Holder (patient)", issued: "Issued", accepted: "Accepted",
  },
  hospEscrowState: { open: "Open, waiting for your confirmation", released: "Released to the hospital", none: "Not created yet" },
  hospCredState: { yes: "Accepted by the patient", issued: "Issued, not yet accepted by the patient", no: "Not issued for this case" },
  hospLedgerOk: (time) => `Found on the ledger, checked ${time}`,
  hospLedgerMissing: "Not found on the ledger",
  hospLedgerChecking: "Checking the ledger…",
  hospLedgerUnknown: (why) => `Ledger check unavailable: ${why}`,
  hospLedgerCredOk: "Credential found on the ledger",
  hospLedgerCredMissing: "Credential not found on the ledger",
});


const state = { list: [], caseId: null, detail: null, ledger: null, sub: null, logs: [], confirmedBy: null, listTimer: null, refreshTimer: null };

const shortHash = (x) => (x && x.length > 18 ? `${x.slice(0, 8)}…${x.slice(-6)}` : x || "");
const timeStr = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
};
const dateStr = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};
const stageClass = (s) => ({ awaiting_confirmation: "live", awaiting_escrow: "review", released: "done" })[s] ?? "review";
const nameOf = (c) => c.patientName ?? "—";
const providerOf = (c) => c.provider ?? "—";

function txLink(r, label) {
  if (!r?.txHash) return "—";
  const href = safeUrl(r.explorerUrl);
  return href ? h("a", { href, target: "_blank", rel: "noopener", class: "mono", title: r.txHash }, label ?? shortHash(r.txHash)) : h("span", { class: "mono" }, shortHash(r.txHash));
}

/* ---------------------------------------------------------------- queue */

function renderList() {
  const ul = $("#case-list");
  $("#queue-empty").hidden = state.list.length > 0;
  ul.replaceChildren(
    ...state.list.map((c) =>
      h(
        "li",
        {},
        h(
          "a",
          { class: `hosp-row${c.id === state.caseId ? " on" : ""}`, href: `#case=${encodeURIComponent(c.id)}`, "aria-current": c.id === state.caseId ? "page" : null },
          h("span", { class: "hr-name" }, nameOf(c)),
          h("span", { class: "hr-amt" }, usd(c.agreedAmount ?? c.escrowAmount)),
          h(
            "span",
            { class: "hr-meta" },
            [providerOf(c), c.accountNumber ? t("hospAcct", c.accountNumber) : null].filter(Boolean).join(" · "),
          ),
          h(
            "span",
            { class: "hr-tags" },
            c.waitingOnPortal ? h("span", { class: "pill hosp-wait-pill" }, t("hospAdvocateWaiting")) : null,
            c.preview ? h("span", { class: "pill review" }, "PREVIEW") : null,
            h("span", { class: `pill ${stageClass(c.stage)}` }, t("hospStage")[c.stage] ?? c.stage),
          ),
        ),
      ),
    ),
  );
}

async function loadList() {
  try {
    state.list = await api("/api/hospital/cases");
    renderList();
  } catch (e) {
    // the queue refreshes in the background; only the first failure is shown loudly
    if (!state.listLoaded) busy(null, () => Promise.reject(e));
  }
  state.listLoaded = true;
}

/* ---------------------------------------------------------------- one case */

function row(label, value) {
  return [h("dt", {}, label), h("dd", {}, value ?? "—")];
}

function renderEscrow(d) {
  const L = t("hospDl");
  const e = d.escrow;
  const rows = [row(L.state, t("hospEscrowState")[e.state] ?? e.state)];
  if (e.state !== "none" || e.txHash) {
    rows.push(
      row(L.amount, e.amount != null ? `${usd(e.amount)} USD` : "—"),
      row(L.tx, txLink(e)),
      row(L.from, e.owner ? h("span", { class: "mono" }, e.owner) : "—"),
      row(L.to, e.destination ? h("span", { class: "mono" }, e.destination) : "—"),
      row(L.seq, e.offerSequence != null ? h("span", { class: "mono" }, String(e.offerSequence)) : "—"),
      row(L.condition, e.condition ? h("code", { class: "hosp-cond" }, e.condition) : "—"),
    );
    if (e.state === "open" && e.cancelAfter) rows.push(row(L.expires, dateStr(e.cancelAfter)));
  }
  $("#escrow").replaceChildren(...rows.flat());

  const lc = $("#ledger-check");
  lc.className = "hosp-ledger";
  if (e.state !== "open") lc.textContent = "";
  else if (!state.ledger) lc.textContent = t("hospLedgerChecking");
  else if (state.ledger.error) {
    lc.classList.add("warn");
    lc.textContent = t("hospLedgerUnknown", state.ledger.error);
  } else if (state.ledger.escrow.onLedger === true) {
    lc.classList.add("ok");
    lc.textContent = t("hospLedgerOk", timeStr(state.ledger.checkedAt));
  } else if (state.ledger.escrow.onLedger === false) {
    lc.classList.add("bad");
    lc.textContent = t("hospLedgerMissing");
  } else {
    lc.classList.add("warn");
    lc.textContent = t("hospLedgerUnknown", state.ledger.escrow.error ?? "?");
  }
}

function renderCredential(d) {
  const L = t("hospDl");
  const c = d.credential;
  const credLedger = state.ledger && !state.ledger.error ? state.ledger.credential.onLedger : null;
  const S = t("hospCredState");
  const status = c.accepted ? S.yes : c.create ? S.issued : S.no;
  const rows = [
    row(L.type, h("span", { class: "mono" }, c.type)),
    row(
      L.credStatus,
      h(
        "span",
        {},
        status,
        credLedger === true ? h("span", { class: "hosp-ok" }, ` · ${t("hospLedgerCredOk")}`) : null,
        credLedger === false ? h("span", { class: "hosp-bad" }, ` · ${t("hospLedgerCredMissing")}`) : null,
      ),
    ),
  ];
  if (c.issuer) rows.push(row(L.issuer, h("span", { class: "mono" }, c.issuer)));
  if (c.subject) rows.push(row(L.holder, h("span", { class: "mono" }, c.subject)));
  if (c.create) rows.push(row(L.issued, txLink(c.create)));
  if (c.accept) rows.push(row(L.accepted, txLink(c.accept)));
  $("#credential").replaceChildren(...rows.flat());
  // The "issued by the clinic and accepted by the patient" note is only true once the accept is on record.
  $("#cred-note").hidden = !c.accepted;
}

function renderConfirm(d) {
  const open = d.escrow.state === "open";
  const released = d.stage === "released";
  $("#confirm-card").hidden = released;
  $("#released-card").hidden = !released;
  const amt = usd(d.agreedAmount);
  const pat = nameOf(d);
  const prov = providerOf(d);
  if (!released) {
    $("#confirm-lede").textContent = open ? t("hospConfirmLede", prov, pat, amt, usd(d.escrow.amount)) : t("hospConfirmLedeNoEscrow", prov, pat, amt);
    $("#attest-text").textContent = t("hospAttest", prov, pat, amt);
    const attest = $("#attest");
    attest.disabled = !open;
    if (!open) attest.checked = false;
    $("#confirm-btn").disabled = !open || !attest.checked;
    $("#confirm-why").textContent = !open ? t("hospWhyNoEscrow") : attest.checked ? "" : t("hospWhyAttest");
  } else {
    const paid = d.release.find((r) => r.kind === "EscrowFinish")?.detail?.amount ?? d.escrow.amount;
    $("#released-lede").textContent = [
      typeof paid === "number" ? t("hospReleasedLede", usd(paid)) : t("hospReleasedNoAmt"),
      state.confirmedBy ? t("hospReleasedBy", state.confirmedBy) : "",
    ].filter(Boolean).join(" ");
    $("#release-receipts").replaceChildren(...d.release.map((r) => receiptItem({ chain: "xrpl", ...r })));
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  $("#d-preview").hidden = !d.preview;
  $("#d-patient").textContent = nameOf(d);
  $("#d-meta").textContent = [providerOf(d), d.accountNumber ? t("hospAcct", d.accountNumber) : null, d.serviceDate ? t("hospServed", d.serviceDate) : null]
    .filter(Boolean)
    .join(" · ");
  const pill = $("#d-stage");
  pill.className = `pill ${stageClass(d.stage)}`;
  pill.textContent = t("hospStage")[d.stage] ?? d.stage;
  $("#d-waiting").hidden = !d.waitingOnPortal;
  $("#f-billed").textContent = usd(d.billedBalance);
  $("#f-agreed").textContent = usd(d.agreedAmount);
  $("#f-locked").textContent = d.escrow.state === "open" ? usd(d.escrow.amount) : d.stage === "released" ? t("hospStage").released : "—";
  renderConfirm(d);
  renderEscrow(d);
  renderCredential(d);
  renderActivity();
}

function renderActivity() {
  const ol = $("#activity");
  if (!state.logs.length) return ol.replaceChildren(h("li", { class: "empty" }, t("hospActivityEmpty")));
  ol.replaceChildren(
    ...state.logs
      .slice(-30)
      .reverse()
      .map((l) => h("li", { class: l.error ? "err" : "" }, h("time", {}, timeStr(l.at)), h("span", {}, l.message))),
  );
}

async function checkLedger(id) {
  try {
    const r = await api(`/api/hospital/cases/${encodeURIComponent(id)}/ledger`);
    if (state.caseId === id) state.ledger = r;
  } catch (e) {
    if (state.caseId === id) state.ledger = { error: e.message };
  }
  if (state.caseId === id) renderDetail();
}

async function loadDetail({ ledger = false } = {}) {
  const id = state.caseId;
  if (!id) return;
  try {
    const d = await api(`/api/hospital/cases/${encodeURIComponent(id)}`);
    if (state.caseId !== id) return;
    const escrowChanged = state.detail?.escrow?.txHash !== d.escrow.txHash || state.detail?.escrow?.state !== d.escrow.state;
    state.detail = d;
    renderDetail();
    if ((ledger || escrowChanged) && d.escrow.state === "open") checkLedger(id);
  } catch (e) {
    busy(null, () => Promise.reject(e));
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    loadDetail();
    loadList();
  }, 250);
}

function openCase(id) {
  if (id === state.caseId) return;
  state.sub?.close();
  Object.assign(state, { caseId: id, detail: null, ledger: null, logs: [], confirmedBy: null, sub: null });
  document.body.classList.toggle("has-case", Boolean(id));
  $("#detail").hidden = !id;
  renderList();
  if (!id) return;
  $("#attest").checked = false;
  loadDetail({ ledger: true });
  state.sub = connectCase(id, (ev) => {
    if (ev.type === "log" || ev.type === "error") {
      state.logs.push({ message: ev.message, at: new Date().toISOString(), error: ev.type === "error" });
      renderActivity();
    }
    if (["log", "receipt", "status", "deal"].includes(ev.type)) scheduleRefresh();
  });
  if (matchMedia("(max-width: 899px)").matches) $("#detail").scrollIntoView({ block: "start" });
}

function route() {
  const m = /case=([^&]+)/.exec(location.hash);
  openCase(m ? decodeURIComponent(m[1]) : null);
}

/* ---------------------------------------------------------------- boot */

function boot() {
  setupErrorBox();
  $("#back").addEventListener("click", (e) => {
    e.preventDefault();
    history.pushState(null, "", location.pathname);
    route();
  });
  $("#attest").addEventListener("change", () => state.detail && renderConfirm(state.detail));
  $("#confirm-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const id = state.caseId;
      const staffName = $("#staff-name").value.trim();
      const r = await api(`/api/hospital/cases/${encodeURIComponent(id)}/confirm-zero-balance`, {
        method: "POST",
        body: { attest: $("#attest").checked, ...(staffName ? { staffName } : {}) },
      });
      if (state.caseId !== id) return;
      state.confirmedBy = r.confirmedBy;
      state.detail = r.case;
      renderDetail();
      loadList();
      $("#released-card").focus?.();
    }),
  );
  addEventListener("hashchange", route);
  loadList();
  state.listTimer = setInterval(loadList, 5000);
  route();
}

if (document.getElementById("hospital-app")) boot();
