// Vellum web: shared helpers (exported, reused by clinic.js) + the patient flow.
// Vanilla ES module, no build step. Contract: vellum/docs/API.md + server/src/types.ts CaseEvent.

const ELEVEN_CLIENT_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.25.0/+esm";

/* --------------------------------------------------------------- strings */

export const I18N = {
  en: {
    clinicLink: "For clinics", patientLink: "For patients", dismiss: "Dismiss",
    dashLink: "Case overview", dashBrand: "Case overview",
    dashPickTitle: "Pick a case", dashPickLede: "Bill cases in progress on this server.", dashStartNew: "Start with a bill photo",
    dashNoCases: "No cases yet. Try the demo bill.",
    dashPreview: "This is UI preview data (dev harness), not a real bill or real transactions.",
    dashCase: "Case", dashOpenFlow: "Open the patient flow", dashCaseId: (id) => `Case ${id}`,
    dashFindings: "Possible problems in the bill", dashToVerify: "To verify", dashNotSavings: "These are leads to verify, not confirmed savings.",
    dashNoFindings: "No obvious errors yet. Vellum still checks fair prices.", dashLine: (n) => `Line ${n}`,
    dashOptions: "Ways forward", dashAppeals: "Insurance denied a claim?",
    dashAppealsLede: "Reads the denial and drafts the appeal.", dashAppealsLink: "Appeal in clinic mode",
    dashRoom: "The negotiation", dashRun: "One-button run progress", dashActivity: "What just happened",
    statBill: "Original bill", statBillFoot: (amt) => `The hospital says you owe ${amt}`,
    statIssues: "Possible billing issues", statIssuesFoot: (n) => `${n} lead${n === 1 ? "" : "s"} to verify, not confirmed savings`,
    statLimit: "Your payment limit", statLimitFoot: "Set by you, not the hospital", statLimitUnset: "Not set yet",
    statDeal: "Agreed price", statDealFoot: (amt) => `${amt} less than the hospital asked`, statDealNone: "No deal yet",
    guardLimit: (amt) => `Vellum never accepts a price without your approval, and never above your limit of ${amt}.`,
    guardOnChain: "The limit is recorded on BNB Chain; anyone can check it.",
    guardUnset: "No limit set yet.",
    optErrors: "Correct billing errors", optErrorsBody: (n, amt) => `${n} likely error${n === 1 ? "" : "s"}, up to ${amt}, for the hospital to verify and remove.`,
    optErrorsNone: "No obvious errors found yet.",
    optCharity: "Financial assistance (charity care)", optCharityNone: "Policy not checked yet.",
    optCharityFree: (pct) => `Free care for household income under ${pct}% of the poverty line.`, optCharityNoFap: "No financial-assistance policy found for this hospital.",
    optCharityApply: "How to apply",
    optFinancing: "Lump sum or payment plan?", optFinancingNone: "No advice yet. It's on the receipts screen once a deal is reached.",
    simulatedTag: "Demo: the hospital side is simulated",
    caseStatus: { intake: "Just started", audited: "Bill explained", researched: "Prices checked", mandated: "Mandate on-chain", negotiating: "Negotiating", agreed: "Deal agreed", settled: "Settled", failed: "No deal" },
    caseSteps: ["Read the bill", "Fair prices", "Mandate", "Negotiate", "Settle"],
    flagKinds: { duplicate: "Duplicate", upcoding: "Upcoding", unbundling: "Unbundling", above_fair_price: "Above fair price", charity_eligible: "Charity eligible", no_surprises_act: "No Surprises Act", math_error: "Math error", other: "Other" },
    runStatus: { pending: "Pending", running: "Running", ok: "Done", skipped: "Skipped", failed: "Failed" },
    runSteps: { research: "Research fair prices + charity policy", financing: "Lump sum vs payment plan (Gemini Fed odds)", mandate: "Record the patient's mandate on BNB Chain", credential: "Issue the hardship credential on XRPL", negotiate: "Negotiate with the billing office (in English)", loan: "Open a 0% community-fund loan (XRPL)", settle: "Lock the agreed amount in XRPL escrow", recordDeal: "Record the deal on BNB Chain", confirm: "Hospital confirms a $0 balance (escrow release)" },
    flaggedNote: "Flagged for review, not confirmed savings.",
    limitGuard: "Never above her limit.",
    steps: ["Mrs. Lin's bill", "Her information", "Research", "The call", "Summary"],
    billTitleDemo: "Mrs. Lin's bill", billTitleOwn: "Your bill",
    dealReached: (amt) => `Deal reached at ${amt}`,
    sumBilled: "Billed", sumRemoved: "Billing errors flagged", sumAgreed: "Agreed", sumSaved: "She saved",
    sumNoDeal: "No deal yet", sumErrorsFoot: (n) => `${n} error${n === 1 ? "" : "s"} for the hospital to remove`,
    sumSavedFoot: (pct) => `${pct}% off the bill`,
    stepOf: (n, total, name) => `Step ${n} of ${total}: ${name}`,
    uploadTitle: "Take a photo of your hospital bill",
    uploadLede: "Finds the errors and talks the price down.",
    takePhoto: "Take a photo or choose a file", yourName: "Your name", readBill: "Read my bill",
    useDemo: "Try the demo bill", demoNote: "Demo bill (made-up patient).",
    needFile: "Add a photo or file of your bill first, or try the demo bill.",
    reading: "Reading your bill, about 30 seconds…",
    billTitle: "Your bill, line by line", next: "Next",
    hospitalSays: "The hospital says you owe", errorsFound: (n) => `${n} billing error${n === 1 ? "" : "s"} found`,
    atStake: "Could come off", noErrors: "No obvious errors yet. Vellum still checks fair prices next.",
    mayOvercharge: "May be overcharged", qty: "Qty",
    intakeTitle: "Tell Vellum about your situation",
    intakeLede: "Just talk, or fill in the form.",
    startTalking: "Start talking", stopTalking: "End conversation", connecting: "Connecting…",
    listening: "Vellum is listening", speaking: "Vellum is speaking", disconnected: "Conversation ended",
    micDenied: "No microphone access. Allow the microphone in your browser, or fill in the form.",
    orForm: "Can't talk right now? Fill in a form", household: "People in your household", income: "Household income per year (USD)",
    maxPay: "The most you can pay (USD)",
    consent: "Vellum may negotiate up to my limit.",
    saveIntake: "Save my answers", needConsent: "Vellum can only negotiate for you once you tick the consent box.",
    intakeSaved: (name, max) => `Saved: ${name}, pays at most ${max}.`,
    researchTitle: "Fair prices",
    researchLede: "Fair prices set the plan.",
    startResearch: "Check fair prices", researching: "Researching… this uses cached live data and takes a few seconds.",
    researchDone: "Research done. Review it below, then start the call.",
    researchStopped: "Research stopped. See the message above, then try again.",
    sourcesTitle: "Sources", medicareTitle: "Medicare rates", charityTitle: "The hospital's charity policy",
    colCode: "Code", colBilled: "Billed", colMedicare: "Medicare", ladderOpening: "Opening ask", ladderTarget: "Goal", ladderWalkaway: "Your limit",
    mandateLede: "Record her limit on-chain.", recordMandate: "Record authorization",
    mandateDone: "Authorization recorded on-chain.", toRoom: "Go negotiate",
    roomTitle: "Vellum is negotiating with the hospital", asked: "Hospital asked", current: "Now", saved: "Saved",
    counterparty: "Hospital side is", cpAgent: "AI billing agent", cpHuman: "A person",
    whoAdvocate: "Vellum", whoHospital: "Hospital", whoInsurer: "Insurer", whoPatient: "You",
    startCall: "Start the call", runAll: "Run everything", runStarted: "Running every step: research, mandate, the call, escrow.", endCall: "End the call", calling: "On the call. Each line appears below as it is spoken.",
    humanMode: "You play the hospital. Talk into the mic.",
    dealAt: (amt) => `Deal: ${amt}`, toReceipts: "See receipts", waitingLines: "The conversation appears here once the call starts.",
    receiptsTitle: "A receipt for every step",
    outcomeTitle: "The result", hearResult: "Hear the result", hearStop: "Stop", hearLoading: "Preparing the audio…",
    hearUnavailable: "Audio isn't available right now. The result is written below.", hearFailed: "The audio didn't play. The result is written below.",
    outcomePreview: "Preview data: a sample case, not a real result", hearDetails: "Technical details",
    receiptsLede: "Payment is held until the bill shows $0.",
    credential: "Prove hardship eligibility", settle: "Put the money in escrow", confirmZero: "Hospital confirms zero balance",
    months: "Months", loan: "0% payment plan", fedTitle: "Pay at once, or in installments?", getAdvice: "Get advice", hedge: "Hedge rate risk (Gemini sandbox)",
    lumpSum: "Pay in one lump sum", paymentPlan: "Use a payment plan", rateMove: (bps) => `Market-implied rate move: ${bps > 0 ? "+" : ""}${bps} bps`,
    loadPayments: "Show the data fees Vellum paid", noReceipts: "No receipts yet. Each step adds one here.",
    viewTx: "View on explorer", noPayments: "Vellum has not paid for any data yet.",
    notConfigured: "This step isn't available yet: ", failed: "Something failed: ", wsLost: "Lost the live connection to the server. Reconnecting.",
    kinds: {
      EscrowCreate: "Money placed in escrow", EscrowFinish: "Escrow released to hospital", CredentialCreate: "Clinic issued hardship credential",
      CredentialAccept: "Patient accepted credential", Batch: "Release and advocate fee in one batch", VaultDeposit: "Community fund deposit",
      LoanSet: "0% payment-plan loan", openMandate: "Mandate recorded", mandate: "Mandate recorded", logEntry: "Negotiation log entry",
      deal: "Deal recorded", recordDeal: "Deal recorded", "x402-payment": "Data fee paid (x402)", odds: "Fed-decision odds",
      "fed-odds": "Fed-decision odds", "prediction-hedge-order": "Rate-risk hedge (prediction market)", Payment: "Advocate fee",
      LoanPay: "Loan installment paid", VaultCreate: "Community medical fund created", LoanBrokerSet: "Fund opened for lending",
      CredentialDelete: "Old credential revoked", PermissionedDomainSet: "Fund limited to verified donors", AccountSet: "Account settings", TrustSet: "USD trust line opened",
    },
  },
};

/** Look up an interface string. The UI is English-only; page modules add their own keys with
 *  Object.assign(I18N.en, {...}). Function values take arguments: t("stepOf", 1, 6, "Photo"). */
export function t(key, ...args) {
  const v = I18N.en[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}

/* ------------------------------------------------------------- utilities */

export const $ = (sel, root = document) => root.querySelector(sel);
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
export const usd = (n) => (typeof n === "number" && Number.isFinite(n) ? usdFmt.format(n) : "—");
// whole dollars for the big ticker numbers, where cents are noise and cost width on a phone
const usd0Fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const usd0 = (n) => (typeof n === "number" && Number.isFinite(n) ? usd0Fmt.format(n) : "—");

/** Tiny hyperscript: h("p", {class: "x"}, "text", child). Strings are text nodes (never HTML). */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** Only http(s) links from the server get rendered as hrefs. */
export function safeUrl(u) {
  try {
    const url = new URL(u, location.href);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function showError(msg) {
  const box = document.getElementById("error");
  if (!box) return alert(msg);
  document.getElementById("error-text").textContent = msg;
  box.hidden = false;
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
export function clearError() {
  const box = document.getElementById("error");
  if (box) box.hidden = true;
}
export function setupErrorBox() {
  document.getElementById("error-close")?.addEventListener("click", clearError);
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** fetch wrapper: JSON in/out, throws ApiError with the server's {error} message. */
export async function api(path, { method = "GET", body, form, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new ApiError(0, `${method} ${path}: network error (${e.message}). Is the server running?`);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `${method} ${path} failed (${res.status})`);
  return data;
}

export function errorText(e) {
  if (e instanceof ApiError && (e.status === 503 || /not configured/i.test(e.message))) return t("notConfigured") + e.message;
  return t("failed") + (e?.message ?? String(e));
}

/** Disable a button while an async action runs; any failure becomes a visible message. */
export async function busy(btn, fn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add("busy");
  }
  try {
    clearError();
    return await fn();
  } catch (e) {
    showError(errorText(e));
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  }
}

/* ----------------------------------------------------------- live events */

/** Subscribe to WS /ws?case=<id>; reconnects with backoff. Returns {close}. */
// Where /ws lives. Same host by default; when the page is served from a static host (Vercel) that proxies
// /api to the backend, GET /api/config names the backend's own WebSocket origin (static hosts can't proxy WS).
let wsOriginPromise;
export function wsOrigin() {
  const local = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  wsOriginPromise ??= fetch("/api/config")
    .then((r) => (r.ok ? r.json() : {}))
    .then((c) => (typeof c?.wsOrigin === "string" && /^wss?:\/\//.test(c.wsOrigin) ? c.wsOrigin : local))
    .catch(() => local);
  return wsOriginPromise;
}

export function connectCase(id, onEvent) {
  let ws;
  let closed = false;
  let tries = 0;
  const open = async () => {
    const origin = await wsOrigin();
    if (closed) return;
    ws = new WebSocket(`${origin}/ws?case=${encodeURIComponent(id)}`);
    ws.onopen = () => {
      tries = 0;
    };
    ws.onmessage = (m) => {
      let ev;
      try {
        ev = JSON.parse(m.data);
      } catch {
        return;
      }
      onEvent(ev);
    };
    ws.onclose = () => {
      if (closed) return;
      tries += 1;
      if (tries === 3) showError(t("wsLost"));
      setTimeout(open, Math.min(8000, 500 * 2 ** tries));
    };
  };
  open();
  return {
    close() {
      closed = true;
      ws?.close();
    },
  };
}

/** Merge a CaseEvent into a local CasePacket copy. Returns true if the packet changed. */
export function mergeEvent(packet, ev) {
  switch (ev.type) {
    case "status":
      packet.status = ev.status;
      return true;
    case "transcript": {
      const l = ev.line;
      const same = packet.transcript.find((x) => x.role === l.role && x.at === l.at && x.text === l.text);
      if (same) Object.assign(same, l);
      else packet.transcript.push(l);
      return true;
    }
    case "offer": {
      const o = ev.offer;
      if (!packet.offers.some((x) => x.by === o.by && x.amount === o.amount && x.at === o.at)) packet.offers.push(o);
      return true;
    }
    case "deal":
      packet.agreedAmount = ev.amount;
      return true;
    case "receipt":
      addReceipts(packet, [ev.receipt]);
      return true;
    default:
      return false;
  }
}

export function addReceipts(packet, receipts) {
  for (const r of receipts ?? []) {
    if (!r || typeof r !== "object") continue;
    if (!packet.receipts.some((x) => x.txHash === r.txHash && x.kind === r.kind)) packet.receipts.push(r);
  }
}

/* ------------------------------------------------- voice: browser audio */

/** Plays base64 PCM16 mono chunks from /ws `audio` events, in arrival order, so turns never overlap. */
export function createAudio(onSpeaking) {
  let ctx;
  let head = 0;
  const until = {};
  const ensure = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!ctx && AC) ctx = new AC();
    if (ctx?.state === "suspended") ctx.resume();
    return ctx;
  };
  return {
    unlock: ensure,
    play({ who, sampleRate, chunk }) {
      const c = ensure();
      if (!c || !chunk) return;
      const bin = atob(chunk);
      const n = bin.length >> 1;
      if (!n) return;
      const buf = c.createBuffer(1, n, sampleRate || 16000);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        if (v >= 0x8000) v -= 0x10000;
        ch[i] = v / 32768;
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      const start = Math.max(c.currentTime + 0.04, head);
      src.start(start);
      head = start + buf.duration;
      until[who] = head;
      onSpeaking?.(who, true);
      const ms = (head - c.currentTime) * 1000 + 30;
      setTimeout(() => {
        if (c.currentTime >= (until[who] ?? 0) - 0.02) onSpeaking?.(who, false);
      }, ms);
    },
  };
}

let elevenModule;
export const INTAKE_TOOLS = ["submit_intake"];
export const ADVOCATE_TOOLS = ["log_offer", "accept_offer", "report_outcome", "end_call"];

/** Client tools: the ElevenLabs session calls them in the browser; we forward to the server and hand back its answer. */
export function forwardTools(names, caseId, onResult) {
  const tools = {};
  for (const name of names) {
    tools[name] = async (params) => {
      try {
        const r = await api(`/api/eleven/tools/${encodeURIComponent(name)}`, { method: "POST", body: { ...(params ?? {}), case_id: caseId } });
        onResult?.(name, r);
        return r?.message ?? (r?.ok ? "ok" : "failed");
      } catch (e) {
        showError(errorText(e));
        return `error: ${e.message}`;
      }
    };
  }
  return tools;
}

/** conversation_initiation_client_data (server shape) -> @elevenlabs/client startSession options. */
export function initToSessionOptions(init, caseId) {
  const agent = init?.conversation_config_override?.agent ?? {};
  const overrides = {};
  if (agent.prompt || agent.first_message != null || agent.language) {
    overrides.agent = {};
    if (agent.prompt) overrides.agent.prompt = agent.prompt;
    if (agent.first_message != null) overrides.agent.firstMessage = agent.first_message;
    if (agent.language) overrides.agent.language = agent.language;
  }
  const opts = { dynamicVariables: { ...(init?.dynamic_variables ?? {}), case_id: caseId } };
  if (init?.custom_llm_extra_body) opts.customLlmExtraBody = init.custom_llm_extra_body;
  const tts = init?.conversation_config_override?.tts;
  if (tts) overrides.tts = { voiceId: tts.voice_id, stability: tts.stability, speed: tts.speed };
  if (overrides.agent || overrides.tts) opts.overrides = overrides;
  return opts;
}

/**
 * Lazy-load @elevenlabs/client (pinned) and start a browser conversation from a signed URL.
 * `init` is the server's conversation_initiation_client_data; `tools` are the client tools to forward.
 */
export async function startElevenConversation(signedUrl, { init, caseId, tools = [], onToolResult, ...callbacks } = {}) {
  if (!elevenModule) {
    try {
      elevenModule = await import(ELEVEN_CLIENT_URL);
    } catch (e) {
      throw new Error(`could not load the ElevenLabs voice client from the CDN (${e.message})`);
    }
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((tr) => tr.stop());
  } catch {
    throw new Error(t("micDenied"));
  }
  return elevenModule.Conversation.startSession({
    signedUrl,
    connectionType: "websocket",
    ...initToSessionOptions(init, caseId),
    clientTools: forwardTools(tools, caseId, onToolResult),
    onUnhandledClientToolCall: (call) => showError(`${t("failed")}unhandled voice tool ${call?.tool_name ?? "?"}`),
    ...callbacks,
  });
}

/* ------------------------------------------------- negotiation room (shared) */

const ROLE_KEYS = {
  advocate: "whoAdvocate", agent: "whoAdvocate", ai: "whoAdvocate", vellum: "whoAdvocate",
  hospital: "whoHospital", billing: "whoHospital", insurer: "whoInsurer", payer: "whoInsurer",
  patient: "whoPatient", user: "whoPatient",
};
export const roleLabel = (role) => (ROLE_KEYS[String(role).toLowerCase()] ? t(ROLE_KEYS[String(role).toLowerCase()]) : role);
const sideOf = (role) => (/advoc|bang|^agent$|^ai$/i.test(role) ? "us" : "them");

/**
 * Shared room renderer. Expects in the page: #transcript, #tk-asked, #tk-current, #tk-saved, #tk-pct,
 * #deal-stamp, #v-advocate, #v-hospital. getAsked() returns the starting $ (or undefined).
 */
export function createRoom({ getPacket, getAsked }) {
  const audio = createAudio((who, on) => {
    const id = who === "advocate" ? "v-advocate" : "v-hospital";
    document.getElementById(id)?.classList.toggle("on", on);
  });
  let lastLen = -1;

  function renderTranscript() {
    const p = getPacket();
    const list = document.getElementById("transcript");
    if (!list || !p) return;
    list.replaceChildren();
    if (!p.transcript.length) {
      list.append(h("li", { class: "empty" }, t("waitingLines")));
      lastLen = 0;
      return;
    }
    for (const line of p.transcript) {
      list.append(h("li", { class: `line ${sideOf(line.role)}` }, h("span", { class: "who" }, roleLabel(line.role)), h("p", {}, line.text)));
    }
    if (p.transcript.length !== lastLen) list.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    lastLen = p.transcript.length;
  }

  function renderTicker() {
    const p = getPacket();
    if (!p) return;
    const asked = getAsked();
    const theirs = [...p.offers].reverse().find((o) => o.by !== "advocate");
    const current = p.agreedAmount ?? theirs?.amount ?? p.offers.at(-1)?.amount;
    document.getElementById("tk-asked").textContent = usd0(asked);
    document.getElementById("tk-current").textContent = usd0(current);
    const saved = typeof asked === "number" && typeof current === "number" ? asked - current : undefined;
    document.getElementById("tk-saved").textContent = saved != null && saved > 0 ? usd0(saved) : "—";
    document.getElementById("tk-pct").textContent = saved != null && saved > 0 && asked > 0 ? `${Math.round((saved / asked) * 100)}%` : "";
    const stamp = document.getElementById("deal-stamp");
    if (stamp) stamp.hidden = p.agreedAmount == null;
  }

  return {
    audio,
    render() {
      renderTicker();
      renderTranscript();
    },
    handle(ev) {
      if (ev.type === "audio") audio.play(ev);
    },
  };
}

/** Render one receipt for a timeline. */
const CHAINS = {
  xrpl: { name: "XRPL", note: "devnet" },
  bsc: { name: "BNB Chain", note: "testnet" },
  base: { name: "AUSD on Base", note: "Sepolia" },
  gemini: { name: "Gemini", note: "markets" },
};
export function receiptItem(r) {
  const chain = CHAINS[r.chain] ?? { name: r.chain, note: "" };
  const kinds = t("kinds");
  const label = (kinds && kinds[r.kind]) || r.kind;
  const href = safeUrl(r.explorerUrl);
  const amount = r.detail && (r.detail.amount ?? r.detail.value ?? r.detail.price);
  const when = new Date(r.at);
  return h(
    "li",
    { class: `receipt chain-${r.chain}` },
    h("span", { class: "chain-mark", "aria-hidden": "true" }, chainGlyph(r.chain)),
    h(
      "div",
      { class: "r-body" },
      h("p", { class: "r-title" }, label),
      h(
        "p",
        { class: "r-meta" },
        `${chain.name} ${chain.note}`,
        amount != null ? `  ${typeof amount === "number" ? usd(amount) : amount}` : "",
        isNaN(when) ? "" : `  ${when.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
      ),
      href
        ? h("a", { class: "r-link", href, target: "_blank", rel: "noopener" }, `${t("viewTx")} ${shortHash(r.txHash)}`)
        : h("p", { class: "r-meta" }, shortHash(r.txHash)),
    ),
  );
}
const shortHash = (x) => (x && x.length > 14 ? `${x.slice(0, 6)}…${x.slice(-4)}` : x || "");
function chainGlyph(chain) {
  // Simple geometric marks per network (not brand logos), colored in CSS.
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  const paths = {
    xrpl: "M4 5l5 5a4 4 0 006 0l5-5M4 19l5-5a4 4 0 016 0l5 5",
    bsc: "M12 3l3 3-3 3-3-3zM6 9l3 3-3 3-3-3zM18 9l3 3-3 3-3-3zM12 15l3 3-3 3-3-3z",
    base: "M12 3a9 9 0 110 18 9 9 0 010-18zM3 12h12",
    gemini: "M12 3a9 9 0 019 9M12 21a9 9 0 01-9-9M7 7h10v10H7z",
  };
  const p = document.createElementNS(ns, "path");
  p.setAttribute("d", paths[chain] ?? "M5 5h14v14H5z");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", "currentColor");
  p.setAttribute("stroke-width", "2");
  p.setAttribute("stroke-linejoin", "round");
  p.setAttribute("stroke-linecap", "round");
  svg.append(p);
  return svg;
}

/* ===================================================== patient flow ===== */

// The five demo steps. "upload" is the landing (hero + "use your own bill"), not a numbered step.
const SCREENS = ["bill", "intake", "research", "room", "summary"];

function initPatient() {
  setupErrorBox();

  const state = { packet: null, sub: null, logs: [], screen: "upload", convo: null, callConvo: null, bridgeOn: false };
  const P = () => state.packet;
  // the demo case is Mrs. Lin; a bill the user uploads is "Your bill"
  const isDemo = (p) => /\bLin\b/i.test(p?.patient?.name ?? "");
  const room = createRoom({ getPacket: P, getAsked: () => P()?.bill?.patientBalance });

  /* ---- navigation ---- */
  function show(name) {
    state.screen = name;
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.dataset.screen !== name;
    document.getElementById("patient-app")?.classList.toggle("landing", name === "upload");
    renderProgress();
    if (name === "research") startResearch();
    document.querySelector(`[data-screen="${name}"] h1`)?.focus?.({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function renderProgress() {
    const idx = SCREENS.indexOf(state.screen);
    const names = t("steps");
    if (idx < 0) return;
    document.querySelectorAll("#steps li").forEach((li, i) => {
      li.className = i < idx ? "done" : i === idx ? "now" : "";
      li.setAttribute("aria-current", i === idx ? "step" : "false");
      li.textContent = names[i];
    });
    $("#step-label").textContent = t("stepOf", idx + 1, SCREENS.length, names[idx]);
  }
  document.querySelectorAll(".screen h1").forEach((h1) => h1.setAttribute("tabindex", "-1"));

  /* ---- case lifecycle ---- */
  function adopt(packet) {
    if (!packet || !packet.id) throw new Error("server returned no case");
    const fresh = !state.packet || state.packet.id !== packet.id;
    state.packet = packet;
    if (fresh) {
      state.sub?.close();
      state.logs = [];
      state.sub = connectCase(packet.id, onEvent);
      try {
        history.replaceState(null, "", `#case=${packet.id}`);
      } catch {}
      const dash = document.getElementById("dash-link");
      if (dash) dash.href = `/dashboard.html#case=${encodeURIComponent(packet.id)}`;
    }
    renderAll();
  }

  function onEvent(ev) {
    if (ev.type === "case") {
      if (!ev.packet) return;
      state.packet = ev.packet;
      renderAll();
      return;
    }
    if (ev.type === "audio") return room.handle(ev);
    if (ev.type === "log") {
      state.logs.push(ev);
      renderFeed();
      // during the call, show the latest server note quietly (e.g. "Voice unavailable … continuing as a live text negotiation")
      if (state.screen === "room" && ev.message) $("#room-log").textContent = ev.message;
      return;
    }
    if (ev.type === "error") {
      // one code's lookup failing is not fatal: show it in the research feed, not as a page error
      if (/^fair price /i.test(ev.message ?? "")) {
        state.logs.push({ message: ev.message, warn: true });
        renderFeed();
        return;
      }
      if (state.researching) setResearching(false, "researchStopped");
      return showError(t("failed") + ev.message);
    }
    if (!state.packet) return;
    if (mergeEvent(state.packet, ev)) {
      if (ev.type === "deal") $("#room-status").textContent = "";
      if (ev.type === "deal" || (ev.type === "status" && ["agreed", "failed", "settled"].includes(ev.status))) {
        state.bridgeOn = false;
        setCallLabel();
      }
      renderAll();
    }
  }

  function renderAll() {
    renderBill();
    renderIntake();
    renderResearch();
    room.render();
    renderDeal();
    renderSummary();
    renderReceipts();
  }

  /* ---- 1 upload ---- */
  $("#bill-file").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    $("#file-name").textContent = f ? f.name : t("takePhoto");
  });
  $("#upload-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const file = $("#bill-file").files?.[0];
    if (!file) return showError(t("needFile"));
    const name = $("#patient-name").value.trim();
    const form = new FormData();
    if (name) form.append("patient", JSON.stringify({ name, language: "zh", maxPay: 0, consent: false }));
    form.append("bill", file, file.name);
    busy($("#upload-btn"), async () => {
      $("#file-name").textContent = t("reading");
      adopt(await api("/api/cases", { method: "POST", form }));
      show("bill");
    }).finally(() => {
      $("#file-name").textContent = file.name;
    });
  });
  $("#demo-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      adopt(await api("/api/cases/demo", { method: "POST", body: {} }));
      show("bill");
    }),
  );
  // "Or use your own bill": open the upload panel below the hero
  $("#own-bill-link")?.addEventListener("click", (e) => {
    e.preventDefault();
    const d = $("#own-bill");
    d.open = true;
    d.scrollIntoView({ block: "start", behavior: "smooth" });
    d.querySelector("summary")?.focus({ preventScroll: true });
  });

  /* ---- 2 bill ---- */
  function renderBill() {
    const p = P();
    const bill = p?.bill;
    const sum = $("#bill-summary");
    const list = $("#bill-lines");
    if (!bill) return;
    const flags = p.flags ?? [];
    // a "billing error" is a flag with money on it; zero-dollar flags (e.g. a No Surprises Act note) stay as notes
    const errors = flags.filter((f) => Number(f.amountAtStake) > 0);
    const stake = errors.reduce((a, f) => a + (Number(f.amountAtStake) || 0), 0);
    $("#bill-title").textContent = isDemo(p) ? t("billTitleDemo") : t("billTitleOwn");
    const billImg = document.getElementById("bill-image");
    if (billImg) billImg.hidden = !isDemo(p); // the picture is of the demo statement only
    sum.replaceChildren(
      h("p", { class: "provider" }, bill.provider?.name ?? ""),
      h("div", { class: "owe" }, h("span", {}, t("hospitalSays")), h("b", {}, usd(bill.patientBalance))),
      errors.length
        ? h("div", { class: "stake" }, h("span", {}, t("errorsFound", errors.length)), h("b", {}, `${t("atStake")} ${usd(stake)}`))
        : h("p", { class: "fine" }, t("noErrors")),
      errors.length ? h("p", { class: "fine flagged-note" }, t("flaggedNote")) : null,
      ...flags.filter((f) => f.lineIndex == null).map(flagEl),
    );
    list.replaceChildren(
      ...bill.lineItems.map((li, i) => {
        const lf = flags.filter((f) => f.lineIndex === i);
        return h(
          "li",
          { class: lf.some((f) => Number(f.amountAtStake) > 0) ? "flagged" : lf.length ? "noted" : "" },
          h(
            "div",
            { class: "li-head" },
            h("p", { class: "li-desc" }, li.description),
            h("b", { class: "li-amt" }, usd(li.charge)),
          ),
          h(
            "p",
            { class: "li-meta" },
            [li.code ? `${li.codeType ?? ""} ${li.code}`.trim() : "", li.qty > 1 ? `${t("qty")} ${li.qty}` : "", li.date ?? ""]
              .filter(Boolean)
              .join("   "),
          ),
          ...lf.map(flagEl),
        );
      }),
    );
  }
  function flagEl(f) {
    return h(
      "div",
      { class: `flag kind-${f.kind}` },
      h("p", {}, f.message),
      f.amountAtStake ? h("b", {}, `${t("mayOvercharge")} ${usd(f.amountAtStake)}`) : null,
    );
  }
  $("#to-intake").addEventListener("click", () => show("intake"));

  /* ---- 3 intake ---- */
  function intakeOk() {
    const pt = P()?.patient;
    return Boolean(pt && pt.consent && pt.maxPay > 0);
  }
  function renderIntake() {
    const pt = P()?.patient;
    const done = $("#intake-done");
    if (pt && !$("#f-name").value) {
      $("#f-name").value = pt.name ?? "";
      if (pt.householdSize) $("#f-household").value = pt.householdSize;
      if (pt.annualIncome) $("#f-income").value = pt.annualIncome;
      if (pt.maxPay) $("#f-maxpay").value = pt.maxPay;
      $("#f-consent").checked = Boolean(pt.consent);
    }
    if (state.intakeSaved && intakeOk()) {
      done.hidden = false;
      done.textContent = t("intakeSaved", pt.name, usd(pt.maxPay));
    } else done.hidden = true;
  }
  function addBubble(source, text) {
    $("#intake-transcript").append(h("li", { class: source === "user" ? "me" : "bb" }, text));
    $("#intake-transcript").lastElementChild.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function setTalking(on) {
    const btn = $("#talk-btn");
    btn.setAttribute("aria-pressed", String(on));
    btn.classList.toggle("live", on);
    $("#talk-label").textContent = on ? t("stopTalking") : t("startTalking");
  }
  $("#talk-btn").addEventListener("click", async (e) => {
    if (state.convo) {
      const c = state.convo;
      state.convo = null;
      setTalking(false);
      await c.endSession().catch(() => {});
      return;
    }
    if (!P()) return showError(t("needFile"));
    await busy(e.currentTarget, async () => {
      $("#talk-status").textContent = t("connecting");
      try {
        const { signedUrl, init } = await api(`/api/intake/signed-url?case=${encodeURIComponent(P().id)}`);
        if (!signedUrl) throw new Error("/api/intake/signed-url returned no signedUrl");
        state.convo = await startElevenConversation(signedUrl, {
            init,
            caseId: P().id,
            tools: INTAKE_TOOLS,
            onToolResult: () => api(`/api/cases/${P().id}`).then(adopt).catch(() => {}),
            onMessage: ({ message, source }) => message && addBubble(source, message),
            onModeChange: ({ mode }) => {
              $("#talk-status").textContent = mode === "speaking" ? t("speaking") : t("listening");
              $("#talk-btn").classList.toggle("speaking", mode === "speaking");
            },
            onError: (m) => showError(t("failed") + m),
            onDisconnect: () => {
              state.convo = null;
              setTalking(false);
              $("#talk-status").textContent = t("disconnected");
              api(`/api/cases/${P().id}`).then(adopt).catch(() => {});
            },
          });
        setTalking(true);
        $("#talk-status").textContent = t("listening");
      } catch (err) {
        $("#talk-status").textContent = "";
        throw err;
      }
    });
  });
  $("#intake-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!P()) return showError(t("needFile"));
    if (!$("#f-consent").checked) return showError(t("needConsent"));
    const num = (sel) => ($(sel).value === "" ? undefined : Number($(sel).value));
    const args = {
      case_id: P().id,
      name: $("#f-name").value.trim(),
      household_size: num("#f-household"),
      annual_income: num("#f-income"),
      max_pay: num("#f-maxpay"),
      consent: true,
    };
    busy($("#intake-submit"), async () => {
      // Same tool the voice agent calls (submit_intake), so voice and form take one path.
      const res = await api("/api/eleven/tools/submit_intake", { method: "POST", body: args });
      if (res && res.ok === false) throw new Error(res.message || "submit_intake rejected the form");
      adopt(res?.packet?.id ? res.packet : await api(`/api/cases/${P().id}`));
      if (!intakeOk()) throw new Error(t("needConsent"));
      state.intakeSaved = true;
      // "Next": straight into research, which starts on its own
      show("research");
      startResearch();
    });
  });

  /* ---- 4 research ---- */
  function renderFeed() {
    const feed = $("#research-feed");
    feed.replaceChildren(...state.logs.map((l) => h("li", { class: l.warn ? "warn" : null }, l.message)));
    if (state.researching && state.logs.length) $("#research-status-text").textContent = `${t("researching")} ${state.logs.at(-1).message}`;
    if (state.screen === "research") feed.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  // Research runs in the background: POST /research answers 202 (or, on older servers, the finished
  // packet), progress arrives as "log" events and the result as a "case" event over /ws.
  function setResearching(on, doneKey) {
    state.researching = on;
    const box = $("#research-status");
    if (!box) return;
    if (on) {
      box.hidden = false;
      box.classList.remove("done");
      $("#research-status-text").textContent = t("researching");
    } else if (doneKey) {
      box.hidden = false;
      box.classList.add("done");
      $("#research-status-text").textContent = t(doneKey);
    } else box.hidden = true;
    $("#research-btn").disabled = on;
    $("#research-btn").hidden = on || isResearched(P()); // shown only to retry after a failure
  }
  function renderResearch() {
    const p = P();
    if (!p) return;
    const researched = ["researched", "mandated", "negotiating", "agreed", "settled"].includes(p.status) || p.fairPrices.length > 0;
    if (p.status === "researching" && !state.researching) setResearching(true);
    if (researched && state.researching) setResearching(false, "researchDone");
    const ladder = $("#ladder");
    if (researched) {
      const sources = [...p.fairPrices.flatMap((f) => f.sources ?? []), ...(p.charity?.sources ?? [])];
      const seen = new Set();
      ladder.hidden = false;
      ladder.replaceChildren(
        h(
          "div",
          { class: "rungs" },
          rung(t("ladderOpening"), p.opening),
          rung(t("ladderTarget"), p.target),
          rung(t("ladderWalkaway"), p.walkaway ?? p.patient?.maxPay),
        ),
        p.fairPrices.length ? h("h2", {}, t("medicareTitle")) : null,
        p.fairPrices.length
          ? h(
              "div",
              { class: "table-wrap" },
              h(
                "table",
                {},
                h("thead", {}, h("tr", {}, h("th", {}, t("colCode")), h("th", { class: "num" }, t("colBilled")), h("th", { class: "num" }, t("colMedicare")))),
                h(
                  "tbody",
                  {},
                  ...p.fairPrices.map((f) =>
                    h(
                      "tr",
                      {},
                      h("td", {}, h("b", {}, f.code), f.description ? h("span", { class: "td-sub" }, f.description) : null),
                      h("td", { class: "num" }, usd(f.billed)),
                      h("td", { class: "num" }, usd(f.medicareRate)),
                    ),
                  ),
                ),
              ),
            )
          : null,
        p.charity ? h("h2", {}, t("charityTitle")) : null,
        p.charity ? h("p", { class: "charity" }, p.charity.summary) : null,
        sources.length ? h("h2", {}, t("sourcesTitle")) : null,
        h(
          "ul",
          { class: "sources" },
          ...sources
            .filter((s) => s && s.url && !seen.has(s.url) && seen.add(s.url))
            .map((s) => {
              const href = safeUrl(s.url);
              return h("li", {}, href ? h("a", { href, target: "_blank", rel: "noopener" }, s.title || s.url) : s.title, h("span", { class: "via" }, s.via));
            }),
        ),
      );
      $("#to-room").disabled = false;
    }
    const hasMandate = p.receipts.some((r) => r.chain === "bsc" && /mandate/i.test(r.kind));
    if (hasMandate) {
      $("#mandate-box").replaceChildren(h("p", {}, t("mandateDone")), receiptList(p.receipts.filter((r) => r.chain === "bsc" && /mandate/i.test(r.kind))));
    }
  }
  const rung = (label, v) => h("div", { class: "rung" }, h("span", {}, label), h("b", {}, usd(v)));
  const receiptList = (rs) => h("ol", { class: "timeline compact" }, ...rs.map(receiptItem));

  const isResearched = (p) => ["researched", "mandated", "negotiating", "agreed", "settled"].includes(p?.status) || (p?.fairPrices?.length ?? 0) > 0;
  // Research is async: POST /research answers 202, the result arrives as a "case" event over /ws.
  async function startResearch() {
    const btn = $("#research-btn");
    if (!P() || state.researching || isResearched(P())) return;
    state.logs = [];
    renderFeed();
    setResearching(true);
    await busy(btn, async () => {
      try {
        const res = await api(`/api/cases/${P().id}/research`, { method: "POST", body: {} });
        if (res?.id && res?.bill) adopt(res); // a full packet: finished (older servers) or the 202 snapshot
      } catch (err) {
        setResearching(false);
        throw err;
      }
    });
    // busy() re-enables the button; keep it off while the background research is still running
    btn.disabled = Boolean(state.researching);
    btn.hidden = Boolean(state.researching) || isResearched(P());
  }
  $("#research-btn").addEventListener("click", startResearch);
  $("#mandate-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await api(`/api/cases/${P().id}/mandate`, { method: "POST", body: {} });
      addReceipts(P(), Array.isArray(r) ? r : [r]);
      renderAll();
    }),
  );
  // "Start the call": go to the call and dial straight away (unless a call already ran)
  $("#to-room").addEventListener("click", () => {
    show("room");
    const p = P();
    if (p && !p.transcript.length && p.agreedAmount == null && !state.bridgeOn && !state.callConvo) startCall($("#negotiate-btn"));
  });

  /* ---- 5 room ---- */
  function setCallLabel() {
    $("#negotiate-btn").textContent = state.callConvo || state.bridgeOn ? t("endCall") : t("startCall");
  }
  $("#negotiate-btn").addEventListener("click", (e) => startCall(e.currentTarget));
  async function startCall(btn) {
    if (state.callConvo) {
      const c = state.callConvo;
      state.callConvo = null;
      setCallLabel();
      await c.endSession().catch(() => {});
      return;
    }
    if (state.bridgeOn) {
      await busy(btn, async () => {
        await api(`/api/cases/${P().id}/negotiate/stop`, { method: "POST", body: {} });
        state.bridgeOn = false;
      });
      setCallLabel();
      return;
    }
    room.audio.unlock(); // user gesture: lets the browser play the agents' audio
    const counterparty = document.querySelector('input[name="counterparty"]:checked')?.value ?? "agent";
    await busy(btn, async () => {
      const res = await api(`/api/cases/${P().id}/negotiate`, { method: "POST", body: { counterparty } });
      if (res?.mode === "human") {
        if (!res.advocateSignedUrl) throw new Error("negotiate returned no advocateSignedUrl for human mode");
        $("#room-status").textContent = t("humanMode");
        state.callConvo = await startElevenConversation(res.advocateSignedUrl, {
          init: res.advocateInit,
          caseId: P().id,
          tools: ADVOCATE_TOOLS,
          onMessage: ({ message, source }) => {
            if (!message) return;
            const line = { role: source === "ai" ? "advocate" : P().mode === "clinic" ? "insurer" : "hospital", text: message, at: new Date().toISOString() };
            mergeEvent(P(), { type: "transcript", line });
            room.render();
            api(`/api/cases/${P().id}/voice/transcript`, { method: "POST", headers: { "x-voice-session": res.transcriptToken }, body: line })
              .catch((e) => showError(errorText(e)));
          },
          onError: (m) => showError(t("failed") + m),
          onDisconnect: () => {
            state.callConvo = null;
            setCallLabel();
          },
        });
      } else {
        state.bridgeOn = true;
        $("#room-status").textContent = t("calling");
      }
    });
    setCallLabel();
  }
  function renderDeal() {
    const p = P();
    const box = $("#deal-box");
    if (!p || !box) return;
    box.hidden = p.agreedAmount == null;
    if (p.agreedAmount != null) $("#deal-stamp").textContent = t("dealReached", usd0(p.agreedAmount));
  }
  $("#to-summary").addEventListener("click", () => show("summary"));

  /* ---- 5 summary ---- */
  function renderSummary() {
    const p = P();
    const box = $("#sum-figs");
    if (!p?.bill || !box) return;
    const billed = p.bill.patientBalance;
    const errors = (p.flags ?? []).filter((f) => Number(f.amountAtStake) > 0);
    const removed = errors.reduce((a, f) => a + Number(f.amountAtStake), 0);
    const agreed = p.agreedAmount;
    const saved = typeof agreed === "number" && typeof billed === "number" ? billed - agreed : undefined;
    const fig = (cls, label, value, foot) => h("div", { class: `stat ${cls}` }, h("span", { class: "stat-label" }, label), h("b", { class: "stat-value" }, value), foot ? h("p", { class: "stat-foot" }, foot) : null);
    box.replaceChildren(
      fig("billed", t("sumBilled"), usd0(billed)),
      fig("removed", t("sumRemoved"), usd(removed), t("sumErrorsFoot", errors.length)),
      fig("agreed", t("sumAgreed"), agreed != null ? usd0(agreed) : t("sumNoDeal")),
      fig("saved", t("sumSaved"), saved != null && saved > 0 ? usd0(saved) : "—", saved > 0 && billed > 0 ? t("sumSavedFoot", Math.round((saved / billed) * 100)) : null),
    );
  }

  /* ---- payment & receipts (a collapsed row under the summary) ---- */
  // Outcome summary: deterministic English text from GET /summary; audio from GET /summary.mp3 (ElevenLabs).
  const outcome = { key: "", seq: 0, url: null, audioKey: "" };
  function summaryKey(p) {
    return [p.id, p.status, p.voiceSimulation, p.agreedAmount ?? "", p.flags.length, p.receipts.map((r) => r.kind).join(",")].join("|");
  }
  function renderOutcome() {
    const p = P();
    if (!p) return;
    const key = summaryKey(p);
    if (key === outcome.key) return;
    outcome.key = key;
    const seq = ++outcome.seq;
    api(`/api/cases/${encodeURIComponent(p.id)}/summary`)
      .then((s) => {
        if (seq !== outcome.seq) return;
        const lines = s.lines ?? { en: [s.en] };
        // the main summary stays about the bill; payment/ledger sentences go in the collapsed "Payment & receipts" row
        const isPay = (l) => /XRPL|BNB|escrow|credential|on-chain|ledger|x402/i.test(l);
        $("#outcome-en").replaceChildren(...lines.en.filter((l) => !isPay(l)).map((l) => h("li", {}, l)));
        $("#pay-summary").replaceChildren(...lines.en.filter(isPay).map((l) => h("li", {}, l)));
        const tag = $("#outcome-preview");
        tag.hidden = !(s.preview || s.simulated);
        tag.textContent = t(s.preview ? "outcomePreview" : "simulatedTag");
        $("#outcome-card").classList.toggle("is-preview", Boolean(s.preview || s.simulated));
        $("#outcome-card").hidden = false;
      })
      .catch(() => {
        if (seq === outcome.seq) $("#outcome-card").hidden = true;
      });
  }
  function setHearLabel(playing) {
    $("#hear-btn").classList.toggle("playing", playing);
    $("#hear-btn .hear-icon").textContent = playing ? "■" : "▶";
    $("#hear-label").textContent = t(playing ? "hearStop" : "hearResult");
  }
  const hearAudio = $("#hear-audio");
  hearAudio.addEventListener("ended", () => setHearLabel(false));
  hearAudio.addEventListener("pause", () => setHearLabel(false));
  hearAudio.addEventListener("play", () => setHearLabel(true));
  // The server's own message (e.g. "ElevenLabs is not configured — set ELEVENLABS_API_KEY") stays
  // visible for honesty but is tucked into a collapsed "details" line Mrs. Lin doesn't have to read.
  const hearNote = { key: null, detail: "" };
  function renderHearNote() {
    const note = $("#hear-note");
    note.hidden = !hearNote.key;
    if (!hearNote.key) return note.replaceChildren();
    const wasOpen = Boolean(note.querySelector("details")?.open);
    const kids = [h("span", {}, t(hearNote.key))];
    if (hearNote.detail) {
      kids.push(h("details", { class: "hear-why", open: wasOpen }, h("summary", {}, t("hearDetails")), h("span", { lang: "en" }, hearNote.detail)));
    }
    note.replaceChildren(...kids);
  }
  function setHearNote(key, detail = "") {
    hearNote.key = key;
    hearNote.detail = detail;
    renderHearNote();
  }
  $("#hear-btn").addEventListener("click", async (e) => {
    const p = P();
    if (!p) return;
    if (!hearAudio.paused) return hearAudio.pause();
    const btn = e.currentTarget;
    setHearNote(null);
    if (outcome.url && outcome.audioKey === outcome.key) {
      hearAudio.currentTime = 0;
      return hearAudio.play().catch(() => undefined);
    }
    btn.disabled = true;
    btn.classList.add("busy");
    setHearNote("hearLoading");
    try {
      const res = await fetch(`/api/cases/${encodeURIComponent(p.id)}/summary.mp3`);
      if (!res.ok) {
        let msg = "";
        try {
          msg = (await res.json()).error ?? "";
        } catch {}
        setHearNote(res.status === 503 ? "hearUnavailable" : "hearFailed", msg);
        return;
      }
      if (outcome.url) URL.revokeObjectURL(outcome.url);
      outcome.url = URL.createObjectURL(await res.blob());
      outcome.audioKey = outcome.key;
      hearAudio.src = outcome.url;
      setHearNote(null);
      await hearAudio.play();
    } catch (err) {
      setHearNote("hearFailed", err?.message ?? String(err));
    } finally {
      btn.disabled = false;
      btn.classList.remove("busy");
    }
  });

  function renderReceipts() {
    const p = P();
    if (!p) return;
    renderOutcome();
    const list = $("#receipts");
    const rs = [...p.receipts].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    list.replaceChildren(...(rs.length ? rs.map(receiptItem) : [h("li", { class: "empty" }, t("noReceipts"))]));
    if (p.financing) renderFed(p.financing);
  }
  const post = (path, body = {}) => api(`/api/cases/${P().id}/${path}`, { method: "POST", body });
  const receiptAction = (sel, fn) =>
    $(sel).addEventListener("click", (e) =>
      busy(e.currentTarget, async () => {
        if (!P()) throw new Error(t("needFile"));
        const r = await fn();
        addReceipts(P(), Array.isArray(r) ? r : [r]);
        renderAll();
      }),
    );
  receiptAction("#credential-btn", () => post("credential"));
  receiptAction("#settle-btn", () => post("settle"));
  receiptAction("#confirm-btn", () => post("confirm-zero-balance"));
  receiptAction("#hedge-btn", () => post("hedge"));
  receiptAction("#loan-btn", () => post("loan", { months: Number($("#loan-months").value) || 12 }));
  $("#x402-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const rs = await api("/api/x402/payments");
      if (!Array.isArray(rs) || !rs.length) throw new Error(t("noPayments"));
      addReceipts(P(), rs);
      renderAll();
    }),
  );
  $("#financing-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const adv = await post("financing");
      if (P()) P().financing = adv;
      renderFed(adv);
    }),
  );
  function renderFed(adv) {
    const odds = adv.fedOdds;
    $("#fed-body").replaceChildren(
      h("p", { class: `rec ${adv.recommendation}` }, adv.recommendation === "lump_sum" ? t("lumpSum") : t("paymentPlan")),
      h("p", {}, adv.reason),
      odds
        ? h(
            "div",
            { class: "odds" },
            h("p", { class: "fine" }, odds.market),
            ...odds.outcomes.map((o) =>
              h(
                "div",
                { class: "odd" },
                h("span", {}, o.label),
                h("span", { class: "bar" }, h("i", { style: `width:${Math.max(0, Math.min(100, o.prob * 100)).toFixed(1)}%` })),
                h("b", {}, `${Math.round(o.prob * 100)}%`),
              ),
            ),
          )
        : null,
      typeof adv.expectedRatePath === "number" ? h("p", { class: "fine" }, t("rateMove", Math.round(adv.expectedRatePath))) : null,
      h(
        "ul",
        { class: "sources" },
        ...(adv.sources ?? []).map((s) => {
          const href = safeUrl(s.url);
          return h("li", {}, href ? h("a", { href, target: "_blank", rel: "noopener" }, s.title || s.url) : s.title);
        }),
      ),
    );
  }

  /* ---- resume ---- */
  const resumeId = new URLSearchParams(location.hash.slice(1)).get("case");
  const deepLink = new URLSearchParams(location.hash.slice(1)).get("screen");
  show("upload");
  if (resumeId) {
    api(`/api/cases/${encodeURIComponent(resumeId)}`)
      .then((p) => {
        adopt(p);
        const byStatus = { intake: "bill", audited: "bill", researching: "research", researched: "research", mandated: "research", negotiating: "room", agreed: "summary", settled: "summary", failed: "room" };
        // #case=<id>&screen=<step> deep-links one step (handy for review); otherwise resume where the case is
        show(SCREENS.includes(deepLink) ? deepLink : byStatus[p.status] ?? "bill");
      })
      .catch(() => history.replaceState(null, "", location.pathname));
  }
}

if (document.getElementById("patient-app")) initPatient();
