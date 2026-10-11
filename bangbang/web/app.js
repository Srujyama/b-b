// BangBang web: shared helpers (exported, reused by clinic.js) + the patient flow.
// Vanilla ES module, no build step. Contract: bangbang/docs/API.md + server/src/types.ts CaseEvent.

const ELEVEN_CLIENT_URL = "https://cdn.jsdelivr.net/npm/@elevenlabs/client@1.25.0/+esm";

/* ------------------------------------------------------------------ i18n */

export const I18N = {
  zh: {
    clinicLink: "诊所入口", patientLink: "病人入口", dismiss: "知道了",
    dashLink: "个案总览", dashBrand: "个案总览",
    dashPickTitle: "选一个个案", dashPickLede: "这里显示服务器上正在办理的账单个案。", dashStartNew: "从拍账单开始",
    dashNoCases: "还没有个案。先在病人入口拍账单，或用示范账单。",
    dashPreview: "这是界面预览数据（开发用），不是真实的账单或交易。",
    dashCase: "个案", dashOpenFlow: "打开办理页面", dashCaseId: (id) => `编号 ${id}`,
    dashFindings: "账单里可能的问题", dashToVerify: "待核实", dashNotSavings: "这些是需要核实的线索，不是已经省下的钱。",
    dashNoFindings: "还没发现明显错误。帮帮还会去查合理价格。", dashLine: (n) => `第 ${n} 行`,
    dashOptions: "可以走的路", dashAppeals: "保险拒赔了？",
    dashAppealsLede: "诊所入口会读拒赔信、对照保险公司的医疗标准，并起草申诉信。", dashAppealsLink: "去诊所入口申诉",
    dashRoom: "和医院谈的过程", dashRun: "一键办理的进度", dashActivity: "刚刚发生的事",
    statBill: "账单原价", statBillFoot: (amt) => `医院说您要付 ${amt}`,
    statIssues: "待核实的问题", statIssuesFoot: (n) => `${n} 条线索，需要核实，不是已省下的钱`,
    statLimit: "您的上限", statLimitFoot: "您自己定的，不是医院定的", statLimitUnset: "还没设定",
    statDeal: "谈妥的价格", statDealFoot: (amt) => `比医院要的少 ${amt}`, statDealNone: "还没谈妥",
    guardLimit: (amt) => `没有您同意，帮帮不会答应任何价格，也绝不超过您的上限 ${amt}。`,
    guardOnChain: "这个上限已经记录在 BNB 链上，谁也改不了。",
    guardUnset: "您还没设定最多付多少。请在办理页面的“说说情况”里设定，帮帮才会去谈。",
    optErrors: "纠正账单错误", optErrorsBody: (n, amt) => `${n} 条可能的错误，最多 ${amt}，要请医院核实后删掉。`,
    optErrorsNone: "还没发现明显错误。",
    optCharity: "经济援助（慈善医疗）", optCharityNone: "还没查医院的经济援助政策。先在办理页面“查价格”。",
    optCharityFree: (pct) => `家庭收入在贫困线 ${pct}% 以下可以全免。`, optCharityNoFap: "没有找到这家医院的经济援助政策。",
    optCharityApply: "看申请方法",
    optFinancing: "一次付清，还是分期？", optFinancingNone: "还没看建议。谈妥以后在“凭证”页可以看。",
    simulatedTag: "示范：医院一方是模拟的",
    caseStatus: { intake: "刚开始", audited: "账单已读懂", researched: "价格已查好", mandated: "授权已上链", negotiating: "正在谈", agreed: "已谈妥", settled: "已结清", failed: "没谈成" },
    caseSteps: ["读懂账单", "查价格", "记录授权", "谈价钱", "结清"],
    flagKinds: { duplicate: "重复收费", upcoding: "级别收高了", unbundling: "拆开重复收", above_fair_price: "高于合理价", charity_eligible: "可申请援助", no_surprises_act: "意外账单保护", math_error: "算错了", other: "其他" },
    runStatus: { pending: "等待", running: "进行中", ok: "完成", skipped: "跳过", failed: "失败" },
    runSteps: { research: "查合理价格和慈善政策", financing: "看一次付清还是分期", mandate: "在 BNB 链上记录您的授权", credential: "在 XRPL 上签发经济困难证明", negotiate: "用英语和医院谈价钱", loan: "从互助基金开 0% 分期", settle: "把钱放进 XRPL 托管", recordDeal: "在 BNB 链上记录协议", confirm: "医院确认余额为零" },
    flaggedNote: "这是需要核实的金额，不是已经省下的钱。",
    limitGuard: "没有您同意，帮帮不会答应任何价格，也绝不超过您设定的上限。",
    steps: ["拍账单", "看懂账单", "说说情况", "查价格", "谈价钱", "凭证"],
    stepOf: (n, total, name) => `第 ${n} 步，共 ${total} 步：${name}`,
    uploadTitle: "把医院账单拍下来",
    uploadLede: "帮帮会用中文一行一行解释给您听，找出多收的钱。",
    takePhoto: "拍照或选择账单文件", yourName: "您的名字", readBill: "读账单",
    useDemo: "用示范账单试试", demoNote: "示范账单是虚构的病人和账号，只用来演示。",
    needFile: "请先拍照或选择账单文件，或者用示范账单。",
    reading: "正在读账单，大约需要半分钟……",
    billTitle: "您的账单，逐行说明", next: "下一步",
    hospitalSays: "医院说您要付", errorsFound: (n) => `找到 ${n} 个可能的错误`,
    atStake: "最多可以少付", noErrors: "暂时没有发现明显错误，帮帮还会去查合理价格。",
    mayOvercharge: "可能多收", qty: "数量",
    intakeTitle: "跟帮帮说说您的情况",
    intakeLede: "用普通话说就可以。帮帮会问您家里几口人、收入多少、最多愿意付多少。",
    startTalking: "开始说话", stopTalking: "结束对话", connecting: "正在连接……",
    listening: "帮帮在听", speaking: "帮帮在说话", disconnected: "对话已结束",
    micDenied: "没有麦克风权限。请在浏览器里允许使用麦克风，或者填表。",
    orForm: "不方便说话？填表也可以", household: "家里几口人", income: "全家一年收入（美元）",
    maxPay: "最多愿意付多少（美元）",
    consent: "我同意帮帮代表我和医院沟通账单，并在我设定的金额内达成协议。",
    saveIntake: "保存我的信息", needConsent: "需要您勾选同意，帮帮才能代表您去谈。",
    intakeSaved: (name, max) => `已记录：${name}，最多付 ${max}。`,
    researchTitle: "帮帮在查合理价格",
    researchLede: "查联邦医保价格、医院公开的价格表、以及医院依法必须提供的经济援助政策。",
    startResearch: "开始查", researching: "正在查，来源会一条条出现……",
    sourcesTitle: "查到的来源", ladderOpening: "开口价", ladderTarget: "目标", ladderWalkaway: "您的上限",
    mandateLede: "把您的授权（最高金额）记录在链上，谁也改不了。", recordMandate: "记录授权",
    mandateDone: "授权已记录在链上。", toRoom: "去谈价钱",
    roomTitle: "帮帮正在和医院谈", asked: "医院要", current: "现在", saved: "省下",
    counterparty: "医院那边是", cpAgent: "AI 账单员", cpHuman: "真人账单员",
    whoAdvocate: "帮帮", whoHospital: "医院", whoInsurer: "保险公司", whoPatient: "您",
    startCall: "开始通话", runAll: "一键全部办理", runStarted: "帮帮正在一步一步办理：查价格、记录授权、打电话、托管付款。", endCall: "结束通话", calling: "通话中。英文对话下面是中文翻译。",
    humanMode: "真人模式：请对着麦克风扮演医院账单员，帮帮会跟您谈。",
    dealAt: (amt) => `成交：${amt}`, toReceipts: "看凭证", waitingLines: "通话开始后，对话会出现在这里。",
    receiptsTitle: "每一步都有凭证",
    receiptsLede: "钱先放在托管账户里，医院确认您欠款为零才会付出去。",
    credential: "证明困难资格", settle: "把钱放进托管", confirmZero: "医院确认余额为零",
    months: "分期月数", loan: "0% 分期", fedTitle: "一次付清，还是分期？", getAdvice: "看建议", hedge: "用 Gemini 测试盘对冲利率风险",
    lumpSum: "建议一次付清", paymentPlan: "建议分期付款", rateMove: (bps) => `市场预期利率变化：${bps > 0 ? "+" : ""}${bps} 基点`,
    loadPayments: "显示帮帮付的数据费", noReceipts: "还没有凭证。每做一步，这里会多一条。",
    viewTx: "在区块浏览器查看", noPayments: "帮帮还没有付过数据费。",
    notConfigured: "这一步暂时不能用：", failed: "出错了：", wsLost: "和服务器的实时连接断了，正在重连。",
    kinds: {
      EscrowCreate: "钱放进托管", EscrowFinish: "托管放款给医院", CredentialCreate: "诊所签发困难资格证明",
      CredentialAccept: "您接受资格证明", Batch: "放款和服务费一次完成", VaultDeposit: "社区基金存款",
      LoanSet: "0% 分期贷款", openMandate: "您的授权上链", mandate: "您的授权上链", logEntry: "谈判记录上链",
      deal: "成交记录上链", recordDeal: "成交记录上链", "x402-payment": "帮帮付数据费", odds: "美联储利率概率",
      "fed-odds": "美联储利率概率", "prediction-hedge-order": "用预测市场对冲利率风险", Payment: "帮帮服务费",
      LoanPay: "按时还了一期", VaultCreate: "社区医疗基金成立", LoanBrokerSet: "基金开始放贷",
      CredentialDelete: "旧资格证明作废", PermissionedDomainSet: "只许审核过的捐款人存钱", AccountSet: "账户设置", TrustSet: "开通美元额度",
    },
  },
  en: {
    clinicLink: "For clinics", patientLink: "For patients", dismiss: "Dismiss",
    dashLink: "Case overview", dashBrand: "Case overview",
    dashPickTitle: "Pick a case", dashPickLede: "Bill cases in progress on this server.", dashStartNew: "Start with a bill photo",
    dashNoCases: "No cases yet. Start on the patient page with a bill photo or the demo bill.",
    dashPreview: "This is UI preview data (dev harness), not a real bill or real transactions.",
    dashCase: "Case", dashOpenFlow: "Open the patient flow", dashCaseId: (id) => `Case ${id}`,
    dashFindings: "Possible problems in the bill", dashToVerify: "To verify", dashNotSavings: "These are leads to verify, not confirmed savings.",
    dashNoFindings: "No obvious errors yet. BangBang still checks fair prices.", dashLine: (n) => `Line ${n}`,
    dashOptions: "Ways forward", dashAppeals: "Insurance denied a claim?",
    dashAppealsLede: "Clinic mode reads the denial, checks the payer's medical policy, and drafts the appeal.", dashAppealsLink: "Appeal in clinic mode",
    dashRoom: "The negotiation", dashRun: "One-button run progress", dashActivity: "What just happened",
    statBill: "Original bill", statBillFoot: (amt) => `Hospital says she owes ${amt}`,
    statIssues: "Possible billing issues", statIssuesFoot: (n) => `${n} lead${n === 1 ? "" : "s"} to verify, not confirmed savings`,
    statLimit: "Your payment limit", statLimitFoot: "Set by you, not the hospital", statLimitUnset: "Not set yet",
    statDeal: "Agreed price", statDealFoot: (amt) => `${amt} less than the hospital asked`, statDealNone: "No deal yet",
    guardLimit: (amt) => `BangBang never accepts a price without your approval, and never above your limit of ${amt}.`,
    guardOnChain: "This limit is recorded on BNB Chain, so nobody can change it.",
    guardUnset: "No payment limit yet. Set it in the patient flow (\"Your situation\") before BangBang negotiates.",
    optErrors: "Correct billing errors", optErrorsBody: (n, amt) => `${n} likely error${n === 1 ? "" : "s"}, up to ${amt}, for the hospital to verify and remove.`,
    optErrorsNone: "No obvious errors found yet.",
    optCharity: "Financial assistance (charity care)", optCharityNone: "The hospital's assistance policy hasn't been checked yet. Run \"Fair prices\" in the patient flow.",
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
    limitGuard: "BangBang never accepts a price without your approval, and never above the limit you set.",
    steps: ["Photo", "Your bill", "Your situation", "Fair prices", "Negotiate", "Receipts"],
    stepOf: (n, total, name) => `Step ${n} of ${total}: ${name}`,
    uploadTitle: "Take a photo of your hospital bill",
    uploadLede: "BangBang explains it line by line and finds what you were overcharged.",
    takePhoto: "Take a photo or choose a file", yourName: "Your name", readBill: "Read my bill",
    useDemo: "Try the demo bill", demoNote: "The demo bill uses a made-up patient and account, for demonstration only.",
    needFile: "Add a photo or file of your bill first, or try the demo bill.",
    reading: "Reading your bill, about 30 seconds…",
    billTitle: "Your bill, line by line", next: "Next",
    hospitalSays: "The hospital says you owe", errorsFound: (n) => `${n} likely error${n === 1 ? "" : "s"} found`,
    atStake: "Could come off", noErrors: "No obvious errors yet. BangBang still checks fair prices next.",
    mayOvercharge: "May be overcharged", qty: "Qty",
    intakeTitle: "Tell BangBang about your situation",
    intakeLede: "Just talk. BangBang asks about your household, income, and the most you can pay.",
    startTalking: "Start talking", stopTalking: "End conversation", connecting: "Connecting…",
    listening: "BangBang is listening", speaking: "BangBang is speaking", disconnected: "Conversation ended",
    micDenied: "No microphone access. Allow the microphone in your browser, or fill in the form.",
    orForm: "Can't talk right now? Fill in a form", household: "People in your household", income: "Household income per year (USD)",
    maxPay: "The most you can pay (USD)",
    consent: "I authorize BangBang to discuss this bill with the hospital and agree to a deal up to my limit.",
    saveIntake: "Save my answers", needConsent: "BangBang can only negotiate for you once you tick the consent box.",
    intakeSaved: (name, max) => `Saved: ${name}, pays at most ${max}.`,
    researchTitle: "BangBang is checking fair prices",
    researchLede: "Medicare rates, the hospital's own price file, and the financial-assistance policy it must publish by law.",
    startResearch: "Start checking", researching: "Checking. Sources appear here as they are found…",
    sourcesTitle: "Sources found", ladderOpening: "Opening ask", ladderTarget: "Goal", ladderWalkaway: "Your limit",
    mandateLede: "Record your authorization and limit on-chain so nobody can change it.", recordMandate: "Record authorization",
    mandateDone: "Authorization recorded on-chain.", toRoom: "Go negotiate",
    roomTitle: "BangBang is negotiating with the hospital", asked: "Hospital asked", current: "Now", saved: "Saved",
    counterparty: "Hospital side is", cpAgent: "AI billing agent", cpHuman: "A person",
    whoAdvocate: "BangBang", whoHospital: "Hospital", whoInsurer: "Insurer", whoPatient: "You",
    startCall: "Start the call", runAll: "Run everything", runStarted: "Running every step: research, mandate, the call, escrow.", endCall: "End the call", calling: "On the call. Chinese translation under each line.",
    humanMode: "Human mode: play the hospital billing office into the microphone. BangBang will negotiate with you.",
    dealAt: (amt) => `Deal: ${amt}`, toReceipts: "See receipts", waitingLines: "The conversation appears here once the call starts.",
    receiptsTitle: "A receipt for every step",
    receiptsLede: "Your money waits in escrow and is paid only after the hospital confirms a zero balance.",
    credential: "Prove hardship eligibility", settle: "Put the money in escrow", confirmZero: "Hospital confirms zero balance",
    months: "Months", loan: "0% payment plan", fedTitle: "Pay at once, or in installments?", getAdvice: "Get advice", hedge: "Hedge rate risk (Gemini sandbox)",
    lumpSum: "Pay in one lump sum", paymentPlan: "Use a payment plan", rateMove: (bps) => `Market-implied rate move: ${bps > 0 ? "+" : ""}${bps} bps`,
    loadPayments: "Show the data fees BangBang paid", noReceipts: "No receipts yet. Each step adds one here.",
    viewTx: "View on explorer", noPayments: "BangBang has not paid for any data yet.",
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

const LANG_KEY = `bb-lang-${location.pathname.includes("clinic") ? "clinic" : "patient"}`;
let lang = (() => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "zh" || v === "en") return v;
  } catch {}
  return document.body?.dataset.defaultLang === "en" ? "en" : "zh";
})();
const langListeners = new Set();

export const getLang = () => lang;
export function t(key, ...args) {
  const v = I18N[lang][key] ?? I18N.zh[key] ?? key;
  return typeof v === "function" ? v(...args) : v;
}
export function applyI18n(root = document) {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  for (const el of root.querySelectorAll("[data-i18n]")) {
    const v = t(el.dataset.i18n);
    if (typeof v === "string") el.textContent = v;
  }
  const btn = document.getElementById("lang-toggle");
  if (btn) btn.textContent = lang === "zh" ? "EN" : "中文";
}
export function onLangChange(fn) {
  langListeners.add(fn);
}
export function setupLangToggle() {
  applyI18n();
  document.getElementById("lang-toggle")?.addEventListener("click", () => {
    lang = lang === "zh" ? "en" : "zh";
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {}
    applyI18n();
    for (const fn of langListeners) fn(lang);
  });
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
export async function api(path, { method = "GET", body, form } = {}) {
  const init = { method, headers: {} };
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
export function connectCase(id, onEvent) {
  let ws;
  let closed = false;
  let tries = 0;
  const open = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?case=${encodeURIComponent(id)}`);
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
  if (overrides.agent) opts.overrides = overrides;
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
  advocate: "whoAdvocate", agent: "whoAdvocate", ai: "whoAdvocate", bangbang: "whoAdvocate",
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
    const zhFirst = getLang() === "zh";
    for (const line of p.transcript) {
      const zh = line.textZh ? h("p", { class: "zh", lang: "zh-CN" }, line.textZh) : null;
      const en = h("p", { class: "en", lang: "en" }, line.text);
      list.append(
        h("li", { class: `line ${sideOf(line.role)}` }, h("span", { class: "who" }, roleLabel(line.role)), ...(zhFirst ? [zh, en] : [en, zh])),
      );
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
        isNaN(when) ? "" : `  ${when.toLocaleTimeString(getLang() === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" })}`,
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

const SCREENS = ["upload", "bill", "intake", "research", "room", "receipts"];

function initPatient() {
  setupLangToggle();
  setupErrorBox();

  const state = { packet: null, sub: null, logs: [], screen: "upload", convo: null, callConvo: null, bridgeOn: false };
  const P = () => state.packet;
  const room = createRoom({ getPacket: P, getAsked: () => P()?.bill?.patientBalance });

  /* ---- navigation ---- */
  function show(name) {
    state.screen = name;
    for (const s of document.querySelectorAll(".screen")) s.hidden = s.dataset.screen !== name;
    renderProgress();
    document.querySelector(`[data-screen="${name}"] h1`)?.focus?.({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function renderProgress() {
    const idx = SCREENS.indexOf(state.screen);
    const names = t("steps");
    document.querySelectorAll("#steps li").forEach((li, i) => {
      li.className = i < idx ? "done" : i === idx ? "now" : "";
      li.setAttribute("aria-current", i === idx ? "step" : "false");
      li.title = names[i];
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
      return;
    }
    if (ev.type === "error") return showError(t("failed") + ev.message);
    if (!state.packet) return;
    if (mergeEvent(state.packet, ev)) {
      if (ev.type === "deal") $("#room-status").textContent = t("dealAt", usd(ev.amount));
      // one-button run: follow the pipeline to the call, then to the receipts
      if (state.running && ev.type === "status" && ev.status === "negotiating" && state.screen !== "room") {
        const cp = document.querySelector('input[name="counterparty"]:checked')?.value ?? "agent";
        if (cp === "agent") state.bridgeOn = true;
        $("#room-status").textContent = t("runStarted");
        show("room");
      }
      if (state.running && ev.type === "status" && ["settled", "failed"].includes(ev.status)) {
        state.running = false;
        if (ev.status === "settled") show("receipts");
      }
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

  /* ---- 2 bill ---- */
  function renderBill() {
    const p = P();
    const bill = p?.bill;
    const sum = $("#bill-summary");
    const list = $("#bill-lines");
    if (!bill) return;
    const zh = getLang() === "zh";
    const flags = p.flags ?? [];
    const stake = flags.reduce((a, f) => a + (Number(f.amountAtStake) || 0), 0);
    sum.replaceChildren(
      h("p", { class: "provider" }, bill.provider?.name ?? ""),
      h("div", { class: "owe" }, h("span", {}, t("hospitalSays")), h("b", {}, usd(bill.patientBalance))),
      flags.length
        ? h("div", { class: "stake" }, h("span", {}, t("errorsFound", flags.length)), h("b", {}, `${t("atStake")} ${usd(stake)}`))
        : h("p", { class: "fine" }, t("noErrors")),
      flags.length ? h("p", { class: "fine flagged-note" }, t("flaggedNote")) : null,
      ...flags.filter((f) => f.lineIndex == null).map(flagEl),
    );
    list.replaceChildren(
      ...bill.lineItems.map((li, i) => {
        const lf = flags.filter((f) => f.lineIndex === i);
        return h(
          "li",
          { class: lf.length ? "flagged" : "" },
          h(
            "div",
            { class: "li-head" },
            h("p", { class: "li-desc" }, zh ? li.descriptionZh || li.description : li.description),
            h("b", { class: "li-amt" }, usd(li.charge)),
          ),
          h(
            "p",
            { class: "li-meta" },
            [li.code ? `${li.codeType ?? ""} ${li.code}`.trim() : "", zh && li.descriptionZh ? li.description : "", li.qty > 1 ? `${t("qty")} ${li.qty}` : "", li.date ?? ""]
              .filter(Boolean)
              .join("   "),
          ),
          ...lf.map(flagEl),
        );
      }),
    );
  }
  function flagEl(f) {
    const zh = getLang() === "zh";
    return h(
      "div",
      { class: `flag kind-${f.kind}` },
      h("p", {}, zh ? f.messageZh || f.message : f.message),
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
    if (intakeOk()) {
      done.hidden = false;
      done.textContent = t("intakeSaved", pt.name, usd(pt.maxPay));
    } else done.hidden = true;
    $("#to-research").disabled = !intakeOk();
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
    });
  });
  $("#to-research").addEventListener("click", () => {
    if (!intakeOk()) return showError(t("needConsent"));
    show("research");
  });

  /* ---- 4 research ---- */
  function renderFeed() {
    const feed = $("#research-feed");
    const zh = getLang() === "zh";
    feed.replaceChildren(...state.logs.map((l) => h("li", {}, zh ? l.messageZh || l.message : l.message)));
    if (state.screen === "research") feed.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function renderResearch() {
    const p = P();
    if (!p) return;
    const researched = ["researched", "mandated", "negotiating", "agreed", "settled"].includes(p.status) || p.fairPrices.length > 0;
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
      $("#mandate-box").hidden = false;
      $("#to-room").disabled = false;
    }
    const hasMandate = p.receipts.some((r) => r.chain === "bsc" && /mandate/i.test(r.kind));
    if (hasMandate) {
      $("#mandate-box").replaceChildren(h("p", {}, t("mandateDone")), receiptList(p.receipts.filter((r) => r.chain === "bsc" && /mandate/i.test(r.kind))));
    }
  }
  const rung = (label, v) => h("div", { class: "rung" }, h("span", {}, label), h("b", {}, usd(v)));
  const receiptList = (rs) => h("ol", { class: "timeline compact" }, ...rs.map(receiptItem));

  $("#research-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      if (!state.logs.length) $("#research-feed").replaceChildren(h("li", { class: "empty" }, t("researching")));
      adopt(await api(`/api/cases/${P().id}/research`, { method: "POST", body: {} }));
    }),
  );
  $("#mandate-btn").addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const r = await api(`/api/cases/${P().id}/mandate`, { method: "POST", body: {} });
      addReceipts(P(), Array.isArray(r) ? r : [r]);
      renderAll();
    }),
  );
  $("#to-room").addEventListener("click", () => show("room"));

  /* ---- 5 room ---- */
  function setCallLabel() {
    $("#negotiate-btn").textContent = state.callConvo || state.bridgeOn ? t("endCall") : t("startCall");
  }
  $("#negotiate-btn").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
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
            const line = { role: source === "ai" ? "advocate" : "hospital", text: message, at: new Date().toISOString() };
            mergeEvent(P(), { type: "transcript", line });
            room.render();
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
  });
  // One button for the demo: POST /run drives research -> financing -> mandate -> credential -> call -> escrow -> release.
  $("#run-btn")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      room.audio.unlock();
      const counterparty = document.querySelector('input[name="counterparty"]:checked')?.value ?? "agent";
      await api(`/api/cases/${P().id}/run`, { method: "POST", body: { counterparty } });
      $("#room-status").textContent = t("runStarted");
      state.running = true;
      if (!state.logs.length) $("#research-feed").replaceChildren(h("li", { class: "empty" }, t("researching")));
    }),
  );
  $("#to-receipts").addEventListener("click", () => show("receipts"));

  /* ---- 6 receipts ---- */
  function renderReceipts() {
    const p = P();
    if (!p) return;
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
    const zh = getLang() === "zh";
    const odds = adv.fedOdds;
    $("#fed-body").replaceChildren(
      h("p", { class: `rec ${adv.recommendation}` }, adv.recommendation === "lump_sum" ? t("lumpSum") : t("paymentPlan")),
      h("p", {}, zh ? adv.reasonZh || adv.reason : adv.reason),
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

  /* ---- language + resume ---- */
  onLangChange(() => {
    renderProgress();
    renderAll();
    renderFeed();
    setTalking(Boolean(state.convo));
    setCallLabel();
    if (!$("#bill-file").files?.length) $("#file-name").textContent = t("takePhoto");
  });

  const resumeId = new URLSearchParams(location.hash.slice(1)).get("case");
  show("upload");
  if (resumeId) {
    api(`/api/cases/${encodeURIComponent(resumeId)}`)
      .then((p) => {
        adopt(p);
        const byStatus = { intake: "bill", audited: "bill", researched: "research", mandated: "room", negotiating: "room", agreed: "receipts", settled: "receipts", failed: "room" };
        show(byStatus[p.status] ?? "bill");
      })
      .catch(() => history.replaceState(null, "", location.pathname));
  }
}

if (document.getElementById("patient-app")) initPatient();
