// Community fund dashboard (互助基金): the three roles of XRPL's lending protocol on one page.
//   Broker  (LoanBroker on the vault, run by the fund)  ->  Depositor (vetted donors, private vault shares)
//   ->  Borrower (patients with a FinancialHardship credential, 0% LoanSet, monthly LoanPay)
// Every value comes from GET /api/fund and GET /api/fund/donors, which read the validated XRPL devnet ledger.
// Nothing here is hard-coded; when the ledger has no loans the page says so instead of showing an example.

import {
  I18N, $, api, applyI18n, busy, errorText, getLang, h, onLangChange, safeUrl, setupErrorBox, setupLangToggle, showError, t, usd,
} from "./app.js";

Object.assign(I18N.zh, {
  fundBrand: "互助基金",
  fundEyebrow: "XRPL 开发网 · 实时账本",
  fundTitle: "社区医疗债务互助基金",
  fundLede: "捐款人把钱存进一个只收经过核实的捐款人的金库，病人从中借零利息分期还医院，再按月还给基金。下面每个数字都是刚从账本上读的。",
  fundLoading: "正在读取 XRPL 开发网……",
  fundLoadFailed: "读不到基金的账本数据。看上面的错误说明。",
  ledgerLine: (n, at) => `XRPL 开发网 · 第 ${n} 号账本 · 账本时间 ${at}`,
  fundRolesTitle: "三个角色",
  roleBroker: "贷款经纪人", roleBrokerWhat: "建金库、开贷款。",
  brokerTerms: (fee, cover) => `账本上的条款：管理费 ${fee}，首损保证金 ${cover}。`,
  roleDepositor: "存款人（捐款人）", roleDepositorWhat: "持有“VerifiedDonor”凭证的人才能存钱，换成金库份额。",
  roleBorrower: "借款人（病人）", roleBorrowerWhat: "有诊所签发的“经济困难”凭证的病人借分期，按月还款。",
  statTotal: "基金总额", statTotalFoot: (s) => `已发出 ${s} 份金库份额`,
  statAvail: "可以借出", statAvailFoot: "金库里还没借出去的钱",
  statLent: "已借出", statLentFoot: (n) => `${n} 笔贷款还没还完`,
  statLoans: "贷款笔数", statLoansFoot: (rate, fee) => `利率 ${rate}，管理费 ${fee}`, statLoansFootNone: (fee) => `还没有贷款 · 管理费 ${fee}`,
  factOwner: "基金账户（经纪人所有者）", factBrokerId: "经纪人编号", factPseudo: "经纪人的账本账户", factFee: "管理费",
  factCover: "首损保证金", factDebt: "未还本金总额", factSetupTx: "建立交易",
  factVaultId: "金库编号", factVaultAcct: "金库的账本账户", factAsset: "资产", factPrivate: "存款权限",
  privateYes: "私有：只收许可域里的成员", privateNo: "公开：任何人都能存",
  factDomain: "许可域", factCred: "许可域接受的凭证", credBy: (type, who) => `${type}，签发人 ${who}`,
  factKind: "金库类型", kindClosed: "封闭式（有认购期和赎回日）", kindOpen: "开放式",
  factSub: "认购期结束", factRed: "赎回日", factShares: "份额代币", domainEnvMismatch: (env) => `注意：.env 里的 XRPL_DONOR_DOMAIN_ID 是 ${env}，和账本不一致`,
  phase: { subscription: "认购期：可以存款", investment: "投资期：可以放贷", redemption: "赎回期", open: "开放式" },
  depositClosed: (date, total) => `存款已关闭。这是封闭式金库，认购期在 ${date} 结束（按账本时间）。基金里的 ${total} 是建立基金时由经过核实的捐款人存进去的，见下面的存款交易。现在账本会拒绝新的存款，所以这页没有“存款”按钮。`,
  depositOpen: (date) => `认购期到 ${date} 为止：只有持有 VerifiedDonor 凭证的账户能存款。存款要捐款人自己签名，这个页面不替任何人签，所以没有“存款”按钮。`,
  depositRedemption: (date) => `金库已经在 ${date} 进入赎回期，不能再存款或放新贷款。`,
  depositOpenEnded: "开放式金库：持有许可的人随时可以存款。存款要捐款人自己签名，这个页面不替任何人签。",
  depositTx: "存款交易",
  sharesOf: (s, v) => `${s} 份，现值 ${v}`,
  credAccepted: "凭证已接受", credPending: "凭证未接受", ownerTag: "基金账户",
  noDonors: "账本上没有找到存款人。",
  noBorrowers: "还没有人借款。个案谈妥、诊所签发“经济困难”凭证之后，可以在办理页面申请零利息分期，借款会出现在这里。",
  borrowerLoans: (n, amt) => `${n} 笔贷款，还欠 ${amt}`,
  loansCount: (n) => `${n} 笔`,
  noLoans: "这个金库还没有放出任何贷款。上面的数字说明钱都还在金库里。",
  loanStatus: { active: "还款中", paid: "已还清", impaired: "逾期", defaulted: "违约" },
  loanCase: (id) => `个案 ${id}`, loanNoCase: "没有关联的个案", loanCaseElsewhere: (id) => `个案 ${id}（不在这台服务器上）`,
  payCaseElsewhere: "这笔贷款的个案不在这台服务器上，所以这页不能替它还款。", payNoCase: "这笔贷款没有关联个案，服务器只替个案还款。",
  loanPrincipal: "借款", loanOutstanding: "还欠", loanPeriodic: "每期", loanNext: "下次到期",
  loanProgress: (m, n) => `已还 ${m} / ${n} 期`, loanProgressUnknown: (r) => `还剩 ${r} 期`,
  loanOrigin: "借款交易", loanPayments: "还款交易",
  payBtn: (amt) => `还一期 ${amt}`, payNotSigner: "这笔贷款的借款人不是本服务器的病人钱包，只能由借款人自己还。",
  paid: (amt) => `已还一期：${amt}`,
  historyTitle: "账本上的每一步", noHistory: "没有找到这个基金的交易。",
  txKinds: {
    PermissionedDomainSet: "建立许可域（只收核实过的捐款人）", CredentialCreate: "签发 VerifiedDonor 凭证", CredentialAccept: "捐款人接受凭证",
    CredentialDelete: "撤销凭证", VaultCreate: "建立私有金库", VaultSet: "修改金库", VaultDeposit: "捐款人存款", VaultWithdraw: "存款人取款",
    VaultClawback: "金库追回", LoanBrokerSet: "设立贷款经纪人", LoanBrokerCoverDeposit: "存入首损保证金", LoanBrokerCoverWithdraw: "取出首损保证金",
    LoanSet: "开出贷款", LoanPay: "病人还款", LoanManage: "管理贷款", LoanDelete: "删除已结清的贷款",
  },
  refresh: "重新读取账本",
  vaultTitle: "金库", loansTitle: "贷款",
  donorMethodPrivate: "私有金库：账本只接受许可域成员（持有被接受凭证的人）和金库所有者存款。这里列出的是凭证签发人名下每一个持有该凭证的账户（以及持有份额的金库所有者），份额是各自持有的金库份额代币余额。",
  donorMethodPublic: "公开金库：任何人都能存款，而账本没有份额持有人的索引，所以这里只核对了凭证持有人和金库所有者，可能还有其他存款人。",
});
Object.assign(I18N.en, {
  fundBrand: "Community fund",
  fundEyebrow: "XRPL devnet · live ledger",
  fundTitle: "Community medical-debt fund",
  fundLede: "Vetted donors deposit into a vault only they can join. Patients borrow from it at 0% to pay the hospital, then repay the fund monthly. Every number below was just read from the ledger.",
  fundLoading: "Reading XRPL devnet…",
  fundLoadFailed: "Couldn't read the fund from the ledger. See the error above.",
  ledgerLine: (n, at) => `XRPL devnet · ledger #${n} · ledger time ${at}`,
  fundRolesTitle: "The three roles",
  roleBroker: "Loan broker", roleBrokerWhat: "Creates the vault and opens loans.",
  brokerTerms: (fee, cover) => `Terms on the ledger: ${fee} management fee, ${cover} first-loss cover.`,
  roleDepositor: "Depositors (donors)", roleDepositorWhat: "Only holders of the VerifiedDonor credential can deposit; they receive vault shares.",
  roleBorrower: "Borrowers (patients)", roleBorrowerWhat: "Patients with a clinic-issued FinancialHardship credential borrow and repay monthly.",
  statTotal: "Fund total", statTotalFoot: (s) => `${s} vault shares outstanding`,
  statAvail: "Available to lend", statAvailFoot: "In the vault, not lent out",
  statLent: "Lent out", statLentFoot: (n) => `${n} loans still being repaid`,
  statLoans: "Loans", statLoansFoot: (rate, fee) => `${rate} interest, ${fee} management fee`, statLoansFootNone: (fee) => `No loans yet · ${fee} management fee`,
  factOwner: "Fund account (broker owner)", factBrokerId: "Broker ID", factPseudo: "Broker ledger account", factFee: "Management fee",
  factCover: "First-loss cover", factDebt: "Debt outstanding", factSetupTx: "Setup transaction",
  factVaultId: "Vault ID", factVaultAcct: "Vault ledger account", factAsset: "Asset", factPrivate: "Who can deposit",
  privateYes: "Private: Permissioned Domain members only", privateNo: "Public: anyone",
  factDomain: "Permissioned Domain", factCred: "Accepted credential", credBy: (type, who) => `${type}, issued by ${who}`,
  factKind: "Vault kind", kindClosed: "Closed-ended (subscription + redemption dates)", kindOpen: "Open-ended",
  factSub: "Subscription closed", factRed: "Redemption date", factShares: "Share token", domainEnvMismatch: (env) => `Note: XRPL_DONOR_DOMAIN_ID in .env is ${env}, which does not match the ledger`,
  phase: { subscription: "Subscription: deposits open", investment: "Investment: lending", redemption: "Redemption", open: "Open-ended" },
  depositClosed: (date, total) => `Deposits are closed. This is a closed-ended vault and its subscription window ended ${date} (ledger time). The ${total} in the fund was deposited at setup by a vetted donor; see the deposit transaction below. The ledger now rejects new deposits, so this page has no deposit button.`,
  depositOpen: (date) => `Subscription is open until ${date}: only VerifiedDonor holders can deposit. A deposit must be signed by the donor, and this page signs for no one, so there is no deposit button.`,
  depositRedemption: (date) => `The vault entered redemption on ${date}: no new deposits or loans.`,
  depositOpenEnded: "Open-ended vault: permitted accounts can deposit any time. A deposit must be signed by the donor; this page signs for no one.",
  depositTx: "Deposit tx",
  sharesOf: (s, v) => `${s} shares, worth ${v}`,
  credAccepted: "Credential accepted", credPending: "Credential not accepted", ownerTag: "Fund account",
  noDonors: "No depositors found on the ledger.",
  noBorrowers: "No one has borrowed yet. After a case reaches a deal and the clinic issues the FinancialHardship credential, a 0% plan is opened from the case page and shows up here.",
  borrowerLoans: (n, amt) => `${n} loan(s), ${amt} outstanding`,
  loansCount: (n) => `${n} total`,
  noLoans: "This vault has not made any loans yet. The numbers above show all of it is still in the vault.",
  loanStatus: { active: "Repaying", paid: "Paid off", impaired: "Late", defaulted: "Defaulted" },
  loanCase: (id) => `Case ${id}`, loanNoCase: "No linked case", loanCaseElsewhere: (id) => `Case ${id} (not on this server)`,
  payCaseElsewhere: "This loan's case is not on this server, so this page can't pay it.", payNoCase: "This loan names no case; the server only pays loans for a case.",
  loanPrincipal: "Borrowed", loanOutstanding: "Outstanding", loanPeriodic: "Per payment", loanNext: "Next due",
  loanProgress: (m, n) => `${m} of ${n} payments made`, loanProgressUnknown: (r) => `${r} payments remaining`,
  loanOrigin: "Loan tx", loanPayments: "Payments",
  payBtn: (amt) => `Pay one installment ${amt}`, payNotSigner: "This borrower is not the server's patient wallet; only the borrower can pay it.",
  paid: (amt) => `Installment paid: ${amt}`,
  historyTitle: "Every step on the ledger", noHistory: "No transactions found for this fund.",
  txKinds: {
    PermissionedDomainSet: "Permissioned Domain created (vetted donors only)", CredentialCreate: "VerifiedDonor credential issued", CredentialAccept: "Donor accepted credential",
    CredentialDelete: "Credential revoked", VaultCreate: "Private vault created", VaultSet: "Vault updated", VaultDeposit: "Donor deposit", VaultWithdraw: "Depositor withdrawal",
    VaultClawback: "Vault clawback", LoanBrokerSet: "Loan broker set up", LoanBrokerCoverDeposit: "First-loss cover deposited", LoanBrokerCoverWithdraw: "First-loss cover withdrawn",
    LoanSet: "Loan opened", LoanPay: "Patient repayment", LoanManage: "Loan managed", LoanDelete: "Paid-off loan deleted",
  },
  refresh: "Read the ledger again",
  vaultTitle: "Vault", loansTitle: "Loans",
  donorMethodPrivate: "Private vault: the ledger only accepts deposits from Permissioned Domain members (holders of an accepted credential) and the vault owner. Listed: every holder of that credential in the issuer's owner directory (plus the owner if it holds shares); shares are each account's balance of the vault's share token.",
  donorMethodPublic: "Public vault: anyone can deposit and the ledger has no index of share holders, so only credential holders and the owner were checked; other depositors may exist.",
});

// cases: caseId -> true when this server has the case (GET /api/cases/:id answered 200), false otherwise
const state = { fund: null, donors: null, donorsError: null, cases: new Map() };
const short = (x) => (x && x.length > 14 ? `${x.slice(0, 6)}…${x.slice(-4)}` : x || "—");
const locale = () => (getLang() === "zh" ? "zh-CN" : "en-US");
const when = (iso) => (iso ? new Date(iso).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) : "—");
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(locale(), { dateStyle: "medium" }) : "—");
const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString(locale(), { maximumFractionDigits: 2 }) : "—");

function link(href, text, cls = "mono") {
  const u = safeUrl(href);
  return u ? h("a", { class: cls, href: u, target: "_blank", rel: "noopener" }, text) : h("span", { class: cls }, text);
}
function facts(el, rows) {
  el.replaceChildren(...rows.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}
function stat(cls, label, value, foot) {
  return h("div", { class: `stat ${cls}` }, h("div", { class: "stat-top" }, h("span", { class: "stat-label" }, label)), h("b", { class: "stat-value" }, value), h("p", { class: "stat-foot" }, foot));
}
// XRPL lending rates (ManagementFeeRate, InterestRate) are in tenths of a basis point: 1000 = 1%.
const rate = (r) => (typeof r === "number" && Number.isFinite(r) ? `${num(r / 1000)}%` : "—");
function rateRange(rates) {
  const rs = rates.filter((r) => typeof r === "number" && Number.isFinite(r));
  if (!rs.length) return "—";
  const lo = Math.min(...rs), hi = Math.max(...rs);
  return lo === hi ? rate(lo) : `${rate(lo)}–${rate(hi)}`;
}
const txOf = (type) => (state.fund?.history ?? []).find((x) => x.type === type);

/* ---------------------------------------------------------------- render */

function render() {
  const f = state.fund;
  if (!f) return;
  const v = f.vault;
  const b = f.broker;
  const active = f.loans.filter((l) => l.status !== "paid");

  $("#ledger-line").textContent = t("ledgerLine", f.ledgerIndex ?? "—", when(f.ledgerTime));

  $("#stats").replaceChildren(
    stat("total", t("statTotal"), usd(v.assetsTotal), t("statTotalFoot", num(v.shares.outstanding))),
    stat("avail", t("statAvail"), usd(v.assetsAvailable), t("statAvailFoot")),
    stat("lent", t("statLent"), usd(v.assetsLent), t("statLentFoot", active.length)),
    stat("count", t("statLoans"), String(f.loans.length), f.loans.length ? t("statLoansFoot", rateRange(f.loans.map((l) => l.interestRate)), rate(b.managementFeeRate)) : t("statLoansFootNone", rate(b.managementFeeRate))),
  );
  $("#broker-terms").textContent = t("brokerTerms", rate(b.managementFeeRate), usd(b.coverAvailable));

  // 1 broker
  const setup = txOf("LoanBrokerSet");
  facts($("#broker-facts"), [
    [t("factOwner"), link(b.ownerExplorerUrl, short(b.owner))],
    [t("factPseudo"), link(b.accountExplorerUrl, short(b.account))],
    [t("factBrokerId"), h("span", { class: "mono", title: b.id }, short(b.id))],
    [t("factFee"), rate(b.managementFeeRate)],
    [t("factCover"), usd(b.coverAvailable)],
    [t("factDebt"), usd(b.debtTotal)],
    setup && [t("factSetupTx"), link(setup.explorerUrl, short(setup.hash))],
  ]);

  // 2 depositors
  const ds = state.donors;
  if (ds) {
    $("#donors").replaceChildren(
      ...(ds.donors.length
        ? ds.donors.map((d) =>
            h(
              "li",
              { class: "person" },
              h("div", { class: "person-top" }, link(d.explorerUrl, short(d.address)), d.isVaultOwner ? h("span", { class: "pill review" }, t("ownerTag")) : d.credential ? h("span", { class: `pill ${d.credential.accepted ? "live" : "review"}` }, d.credential.accepted ? t("credAccepted") : t("credPending")) : null),
              h("p", { class: "person-meta" }, t("sharesOf", num(d.shares), usd(d.claimUsd))),
              ...d.deposits.map((x) => h("p", { class: "person-meta" }, `${t("txKinds")[x.type] ?? x.type} ${usd(x.amount)} · `, link(x.explorerUrl, short(x.hash)))),
            ),
          )
        : [h("li", { class: "empty" }, t("noDonors"))]),
    );
    $("#donor-method").textContent = ds.private ? t("donorMethodPrivate") : t("donorMethodPublic");
  } else if (state.donorsError) {
    $("#donors").replaceChildren(h("li", { class: "empty" }, errorText(state.donorsError)));
  }

  // 3 borrowers (grouped from the loans)
  const byBorrower = new Map();
  for (const l of f.loans) {
    const g = byBorrower.get(l.borrower) ?? { url: l.borrowerExplorerUrl, n: 0, owed: 0 };
    g.n += 1;
    g.owed += l.totalValueOutstanding ?? 0;
    byBorrower.set(l.borrower, g);
  }
  $("#borrowers").replaceChildren(
    ...(byBorrower.size
      ? [...byBorrower].map(([addr, g]) => h("li", { class: "person" }, h("div", { class: "person-top" }, link(g.url, short(addr))), h("p", { class: "person-meta" }, t("borrowerLoans", g.n, usd(g.owed)))))
      : [h("li", { class: "empty" }, t("noBorrowers"))]),
  );

  // vault
  const pill = $("#vault-pill");
  pill.className = `pill ${v.depositsOpen ? "live" : v.phase === "investment" ? "done" : "review"}`;
  pill.textContent = t("phase")[v.phase] ?? v.phase;
  const deposit = txOf("VaultDeposit");
  const note =
    v.kind === "open"
      ? t("depositOpenEnded")
      : v.phase === "subscription"
        ? t("depositOpen", when(v.subscriptionDate))
        : v.phase === "redemption"
          ? t("depositRedemption", when(v.redemptionDate))
          : t("depositClosed", when(v.subscriptionDate), usd(v.assetsTotal));
  $("#deposit-note").replaceChildren(h("p", {}, note), deposit ? h("p", { class: "fine" }, `${t("depositTx")}: `, link(deposit.explorerUrl, short(deposit.hash))) : null);
  const vc = txOf("VaultCreate");
  facts($("#vault-facts"), [
    [t("factVaultId"), h("span", { class: "mono", title: v.id }, short(v.id))],
    [t("factVaultAcct"), link(v.accountExplorerUrl, short(v.account))],
    [t("factAsset"), `${v.asset.currency} · ${short(v.asset.issuer)}`],
    [t("factPrivate"), v.private ? t("privateYes") : t("privateNo")],
    v.domainId && [t("factDomain"), h("span", { class: "mono", title: v.domainId }, short(v.domainId))],
    ...v.acceptedCredentials.map((c) => [t("factCred"), t("credBy", c.type, short(c.issuer))]),
    [t("factKind"), v.kind === "closed" ? t("kindClosed") : t("kindOpen")],
    v.subscriptionDate && [t("factSub"), when(v.subscriptionDate)],
    v.redemptionDate && [t("factRed"), day(v.redemptionDate)],
    [t("factShares"), h("span", { class: "mono", title: v.shares.mptIssuanceId }, short(v.shares.mptIssuanceId))],
    vc && [t("factSetupTx"), link(vc.explorerUrl, short(vc.hash))],
  ]);
  if (v.domainIdEnv && v.domainId && v.domainIdEnv !== v.domainId) $("#vault-facts").append(h("dd", { class: "warn" }, t("domainEnvMismatch", v.domainIdEnv)));

  // loans
  $("#loans-pill").textContent = t("loansCount", f.loans.length);
  $("#loans").replaceChildren(...(f.loans.length ? f.loans.map(loanItem) : [h("li", { class: "empty" }, t("noLoans"))]));

  // history
  $("#history").replaceChildren(
    ...(f.history.length
      ? f.history.map((x) =>
          h(
            "li",
            { class: "fh-item" },
            h("span", { class: "fh-dot", "aria-hidden": "true" }),
            h(
              "div",
              { class: "fh-body" },
              h("p", { class: "r-title" }, t("txKinds")[x.type] ?? x.type),
              h("p", { class: "r-meta" }, [when(x.at), x.amount != null ? usd(x.amount) : null, x.result !== "tesSUCCESS" ? x.result : null].filter(Boolean).join(" · ")),
              link(x.explorerUrl, `${t("viewTx")} ${short(x.hash)}`, "r-link"),
            ),
          ),
        )
      : [h("li", { class: "empty" }, t("noHistory"))]),
  );
}

function loanItem(l) {
  const f = state.fund;
  const caseHere = Boolean(l.caseId && state.cases.get(l.caseId));
  const signer = f.signer?.patient === l.borrower;
  // the pay route needs the loan's own case to exist on this server (the case id is the capability)
  const canPay = l.status !== "paid" && signer && caseHere;
  const why = l.status === "paid" || canPay ? null : !signer ? t("payNotSigner") : !l.caseId ? t("payNoCase") : t("payCaseElsewhere");
  const caseLine = !l.caseId
    ? t("loanNoCase")
    : caseHere
      ? h("a", { href: `/dashboard.html#case=${encodeURIComponent(l.caseId)}` }, t("loanCase", l.caseId))
      : t("loanCaseElsewhere", l.caseId);
  const pct = l.paymentTotal ? Math.round(((l.paymentsMade ?? 0) / l.paymentTotal) * 100) : null;
  const btn = canPay
    ? h("button", { class: "primary pay", type: "button", onclick: (e) => pay(l, e.currentTarget) }, t("payBtn", usd(l.periodicPayment)))
    : null;
  return h(
    "li",
    { class: `loan ${l.status}` },
    h(
      "div",
      { class: "loan-top" },
      h("div", {}, link(l.borrowerExplorerUrl, short(l.borrower)), h("p", { class: "person-meta" }, caseLine)),
      h("span", { class: `pill ${l.status === "paid" ? "done" : l.status === "active" ? "live" : "fail"}` }, t("loanStatus")[l.status] ?? l.status),
    ),
    h(
      "dl",
      { class: "loan-nums" },
      h("div", {}, h("dt", {}, t("loanPrincipal")), h("dd", {}, usd(l.principalRequested))),
      h("div", {}, h("dt", {}, t("loanOutstanding")), h("dd", {}, usd(l.totalValueOutstanding))),
      h("div", {}, h("dt", {}, t("loanPeriodic")), h("dd", {}, usd(l.periodicPayment))),
      h("div", {}, h("dt", {}, t("loanNext")), h("dd", {}, day(l.nextPaymentDue))),
    ),
    pct != null
      ? h("div", { class: "loan-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(l.paymentTotal), "aria-valuenow": String(l.paymentsMade ?? 0) }, h("i", { style: `width:${pct}%` }))
      : null,
    h("p", { class: "person-meta" }, l.paymentTotal != null ? t("loanProgress", l.paymentsMade, l.paymentTotal) : t("loanProgressUnknown", l.paymentRemaining)),
    h(
      "p",
      { class: "person-meta" },
      l.origin ? [`${t("loanOrigin")}: `, link(l.origin.explorerUrl, short(l.origin.hash))] : null,
      ...l.payments.map((p) => [" · ", link(p.explorerUrl, `${t("loanPayments")} ${short(p.hash)}`)]),
    ),
    btn,
    why ? h("p", { class: "fine" }, why) : null,
  );
}

async function pay(loan, btn) {
  const r = await busy(btn, () => api(`/api/fund/loans/${encodeURIComponent(loan.id)}/pay`, { method: "POST", body: { caseId: loan.caseId } }));
  if (r) {
    await load();
    $("#loans").prepend(h("li", { class: "note" }, t("paid", usd(Number(r.detail?.amount))), " · ", link(r.explorerUrl, short(r.txHash))));
  }
}

/* ---------------------------------------------------------------- load */

async function load() {
  const [fund, donors] = await Promise.allSettled([api("/api/fund"), api("/api/fund/donors")]);
  if (fund.status === "rejected") {
    showError(errorText(fund.reason));
    $("#loading").textContent = t("fundLoadFailed");
    $("#loading").hidden = false;
    return;
  }
  state.fund = fund.value;
  // Which linked cases live on THIS server (a loan opened by another run names a case we don't have).
  const ids = [...new Set(state.fund.loans.map((l) => l.caseId).filter(Boolean))];
  const found = await Promise.all(
    ids.map((id) =>
      fetch(`/api/cases/${encodeURIComponent(id)}`)
        .then((r) => r.ok)
        .catch(() => false),
    ),
  );
  state.cases = new Map(ids.map((id, i) => [id, found[i]]));
  state.donors = donors.status === "fulfilled" ? donors.value : null;
  state.donorsError = donors.status === "rejected" ? donors.reason : null;
  $("#loading").hidden = true;
  $("#fund-view").hidden = false;
  render();
}

setupLangToggle();
setupErrorBox();
onLangChange(() => {
  applyI18n();
  render();
});
$("#refresh-btn").addEventListener("click", (e) => busy(e.currentTarget, load));
load().catch((e) => showError(errorText(e)));
