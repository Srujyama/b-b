import React, { useMemo, useState } from "react";
import "./VellumDashboard.css";

/**
 * Vellum — blue medical-bill negotiation dashboard
 * Self-contained UI prototype. Connect the marked handlers to your existing
 * Vellum API / negotiation backend when integrating.
 */
const initialCase = {
  provider: "Stanford Health Care",
  type: "Emergency department",
  bill: 14296,
  potentialIssues: 2230,
  patientLimit: 2500,
  status: "Needs review",
};

const money = (n) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);

const navItems = [
  { id: "overview", icon: "▦", label: "Overview" },
  { id: "bills", icon: "▤", label: "My bills" },
  { id: "appeals", icon: "✉", label: "Insurance appeals" },
  { id: "negotiation", icon: "↔", label: "Negotiations" },
  { id: "savings", icon: "↗", label: "Savings & offers" },
];

export default function VellumDashboard() {
  const [activeTab, setActiveTab] = useState("overview");
  const [caseType, setCaseType] = useState("bill");
  const [description, setDescription] = useState(
    "I received a hospital bill that seems too high. Find billing errors and help me negotiate a lower amount."
  );
  const [patientLimit, setPatientLimit] = useState(initialCase.patientLimit);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [negotiating, setNegotiating] = useState(false);
  const [notice, setNotice] = useState("");
  const [caseData, setCaseData] = useState(initialCase);

  const possibleBalance = useMemo(
    () => Math.max(0, caseData.bill - caseData.potentialIssues),
    [caseData.bill, caseData.potentialIssues]
  );

  function startReview() {
    // TODO: Replace with your backend call, e.g. createCase({ caseType, description, uploadedFile }).
    setNotice(
      caseType === "appeal"
        ? "Appeal workspace opened. Connect your denial-letter extraction and appeal API here."
        : "Bill review opened. Connect your document parser and billing-audit API here."
    );
    setActiveTab(caseType === "appeal" ? "appeals" : "bills");
  }

  function startNegotiation() {
    // TODO: Replace with your real negotiation/session API.
    setNegotiating(true);
    setNotice("Demo negotiation started. No call, offer, or payment was sent.");
  }

  function selectFile(event) {
    const file = event.target.files?.[0];
    if (file) {
      setUploadedFile(file);
      setNotice(`Attached ${file.name}. Connect this to your existing upload endpoint to process it.`);
    }
  }

  return (
    <div className="bb-app">
      <aside className="bb-sidebar">
        <div className="bb-brand">
          <div className="bb-brand-mark">b</div>
          <div>
            <div className="bb-brand-name">vellum</div>
            <div className="bb-brand-caption">YOUR AI PATIENT ADVOCATE</div>
          </div>
        </div>

        <div className="bb-side-label">WORKSPACE</div>
        <nav className="bb-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              key={item.id}
              className={`bb-nav-item ${activeTab === item.id ? "active" : ""}`}
              onClick={() => {
                setActiveTab(item.id);
                setNotice("");
              }}
            >
              <span className="bb-nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "bills" && <span className="bb-nav-count">1</span>}
            </button>
          ))}
        </nav>

        <div className="bb-sidebar-spacer" />
        <div className="bb-trust-card">
          <div className="bb-trust-icon">✓</div>
          <strong>Your care. Your terms.</strong>
          <p>You approve every settlement. Your payment limit stays in your control.</p>
        </div>
        <div className="bb-profile">
          <div className="bb-avatar">P</div>
          <div>
            <strong>Patient workspace</strong>
            <span>Demo account</span>
          </div>
          <span className="bb-dots">•••</span>
        </div>
      </aside>

      <main className="bb-main">
        <header className="bb-topbar">
          <div className="bb-mobile-brand">
            <div className="bb-brand-mark">b</div>
            <strong>vellum</strong>
          </div>
          <div className="bb-breadcrumb">Patient workspace <span>/</span> {navItems.find((x) => x.id === activeTab)?.label}</div>
          <div className="bb-top-actions">
            <span className="bb-demo-pill"><i /> Demo mode</span>
            <button className="bb-help-button" onClick={() => setNotice("Help center: connect this action to your support/contact flow.")}>?</button>
          </div>
        </header>

        <div className="bb-content">
          {notice && (
            <div className="bb-notice" role="status">
              <span>ⓘ</span> {notice}
              <button onClick={() => setNotice("")} aria-label="Dismiss notice">×</button>
            </div>
          )}

          {activeTab === "overview" && (
            <>
              <section className="bb-welcome">
                <div>
                  <div className="bb-eyebrow">SIMPLE, HUMAN-CENTERED BILLING SUPPORT</div>
                  <h1>Let's make your medical bills<br className="bb-desktop-break" /> make more sense.</h1>
                  <p>Find questionable charges, explore assistance options, and prepare a stronger negotiation — with you in control.</p>
                </div>
                <div className="bb-welcome-art" aria-hidden="true">
                  <div className="bb-art-circle circle-one" />
                  <div className="bb-art-circle circle-two" />
                  <div className="bb-art-document"><span>✚</span><i /><i /><i /><b>✓</b></div>
                  <div className="bb-art-spark">✦</div>
                </div>
              </section>

              <section className="bb-intake bb-card">
                <div className="bb-section-heading">
                  <div className="bb-heading-icon">✦</div>
                  <div>
                    <h2>What can we help with?</h2>
                    <p>Start with a sentence. Vellum will help you figure out the next step.</p>
                  </div>
                </div>
                <div className="bb-choice-row">
                  <button className={`bb-choice ${caseType === "bill" ? "selected" : ""}`} onClick={() => setCaseType("bill")}>
                    <span>▤</span> Medical bill
                  </button>
                  <button className={`bb-choice ${caseType === "appeal" ? "selected" : ""}`} onClick={() => setCaseType("appeal")}>
                    <span>♧</span> Insurance denial
                  </button>
                </div>
                <label className="bb-sr-only" htmlFor="bb-description">Describe your bill or insurance problem</label>
                <textarea id="bb-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Describe your bill or denied claim..." />
                {showUpload && (
                  <label className="bb-upload-box">
                    <span className="bb-upload-symbol">↑</span>
                    <span><strong>{uploadedFile ? uploadedFile.name : "Choose a bill or denial letter"}</strong><small>PDF, PNG, JPG or other supported document</small></span>
                    <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={selectFile} />
                  </label>
                )}
                <div className="bb-intake-footer">
                  <button className="bb-primary-button" onClick={startReview} disabled={!description.trim()}>
                    Find savings <span>→</span>
                  </button>
                  <button className="bb-secondary-button" onClick={() => setShowUpload((v) => !v)}>
                    <span>↑</span> {showUpload ? "Hide upload" : "Upload a bill"}
                  </button>
                  <span className="bb-secure-note"><span>♧</span> Your documents stay yours</span>
                </div>
              </section>

              <div className="bb-section-title-row">
                <div><h2>Your case at a glance</h2><p>Sample data from a demo case</p></div>
                <button className="bb-text-button" onClick={() => setActiveTab("bills")}>View case details <span>→</span></button>
              </div>

              <section className="bb-stat-grid">
                <div className="bb-stat-card">
                  <div className="bb-stat-top"><span className="bb-stat-icon blue">▤</span><span className="bb-stat-label">Original bill</span><span className="bb-stat-more">↗</span></div>
                  <div className="bb-stat-value">{money(caseData.bill)}</div>
                  <div className="bb-stat-foot">Hospital emergency visit</div>
                </div>
                <div className="bb-stat-card">
                  <div className="bb-stat-top"><span className="bb-stat-icon amber">⌕</span><span className="bb-stat-label">Potential billing issues</span><span className="bb-status status-review">To verify</span></div>
                  <div className="bb-stat-value amber-text">{money(caseData.potentialIssues)}</div>
                  <div className="bb-stat-foot">Flagged for review — not confirmed savings</div>
                </div>
                <div className="bb-stat-card">
                  <div className="bb-stat-top"><span className="bb-stat-icon green">◎</span><span className="bb-stat-label">Your payment limit</span></div>
                  <div className="bb-stat-value">{money(patientLimit)}</div>
                  <div className="bb-stat-foot">Set by you, not the hospital</div>
                </div>
              </section>

              <section className="bb-case-card bb-card">
                <div className="bb-case-head">
                  <div className="bb-provider-avatar">✚</div>
                  <div className="bb-case-title"><h3>{caseData.provider}</h3><p>{caseData.type} · Case BB-1042</p></div>
                  <span className="bb-status status-review">{caseData.status}</span>
                  <button className="bb-icon-button" onClick={() => setActiveTab("bills")} aria-label="Open case">↗</button>
                </div>
                <div className="bb-case-progress">
                  <div className="bb-progress-step done"><span>✓</span><div><strong>Case created</strong><small>Sample record</small></div></div>
                  <div className="bb-progress-line" />
                  <div className="bb-progress-step current"><span>2</span><div><strong>Review charges</strong><small>Next step</small></div></div>
                  <div className="bb-progress-line" />
                  <div className="bb-progress-step"><span>3</span><div><strong>Negotiate</strong><small>With your approval</small></div></div>
                </div>
                <div className="bb-case-footer"><span>Demo values only — not a live bill audit.</span><button className="bb-primary-button small" onClick={() => setActiveTab("negotiation")}>Open negotiation room →</button></div>
              </section>
            </>
          )}

          {activeTab === "bills" && (
            <section className="bb-page-stack">
              <div className="bb-page-heading"><div><div className="bb-eyebrow">DOCUMENT REVIEW</div><h1>Bill intelligence</h1><p>Understand the charges before you negotiate them.</p></div><span className="bb-status status-review">1 sample bill</span></div>
              <div className="bb-bill-summary bb-card">
                <div><span className="bb-stat-label">Provider</span><h2>{caseData.provider}</h2><p>{caseData.type} · Self-pay demo case</p></div>
                <div className="bb-bill-amount"><span>Original bill</span><strong>{money(caseData.bill)}</strong></div>
              </div>
              <div className="bb-audit-banner"><span className="bb-audit-icon">⌕</span><div><strong>Potential issues to investigate</strong><p>These are audit leads, not confirmed errors. Verify them against the itemized bill and medical record.</p></div><strong className="bb-audit-amount">{money(caseData.potentialIssues)}</strong></div>
              <div className="bb-card bb-findings">
                <div className="bb-card-title"><div><h2>Audit findings</h2><p>Sample leads for human review</p></div><span className="bb-status status-review">Needs verification</span></div>
                {[
                  ["01", "Potential duplicate IV charge", "Compare administration entries and dates for duplicate billing.", "Possible duplicate"],
                  ["02", "Emergency visit level", "Check whether the documented service supports the billed level.", "Coding review"],
                  ["03", "Potentially unbundled lab tests", "Compare individual tests with applicable panel billing and payer rules.", "Billing review"],
                ].map((finding) => <div className="bb-finding-row" key={finding[0]}><span className="bb-finding-number">{finding[0]}</span><div className="bb-finding-copy"><strong>{finding[1]}</strong><p>{finding[2]}</p></div><span className="bb-finding-tag">{finding[3]}</span><button className="bb-outline-mini" onClick={() => setNotice(`Review task created for: ${finding[1]}. Connect this action to your case/task API.`)}>Review</button></div>)}
                <div className="bb-findings-footer"><span>Unverified items should never be represented as guaranteed savings.</span><button className="bb-primary-button" onClick={() => setActiveTab("savings")}>Explore options →</button></div>
              </div>
              <div className="bb-card bb-balance-card"><div><span className="bb-stat-label">Illustrative balance after flagged amount</span><strong>{money(possibleBalance)}</strong><p>Arithmetic illustration only; no adjustment has been confirmed.</p></div><button className="bb-secondary-button" onClick={() => setActiveTab("negotiation")}>Prepare negotiation</button></div>
            </section>
          )}

          {activeTab === "appeals" && (
            <section className="bb-page-stack">
              <div className="bb-page-heading"><div><div className="bb-eyebrow">CLAIM SUPPORT</div><h1>Insurance appeal center</h1><p>Build a clear, evidence-backed appeal with your records.</p></div></div>
              <div className="bb-card bb-appeal-hero"><div className="bb-appeal-icon">✉</div><div><h2>Challenge a denied claim</h2><p>Start with the denial letter and explanation of benefits (EOB). The goal is to understand the reason, identify the relevant plan criteria, and draft an appeal for your review.</p><button className="bb-primary-button" onClick={() => { setCaseType("appeal"); setShowUpload(true); setActiveTab("overview"); }}>Add denial letter →</button></div></div>
              <div className="bb-card bb-findings"><div className="bb-card-title"><div><h2>Appeal workflow</h2><p>Every step remains reviewable by the patient</p></div></div>{[["01","Extract denial reason","Identify the insurer's stated basis and relevant deadlines."],["02","Match policy criteria","Compare the denial rationale with the plan's language."],["03","Gather supporting evidence","Organize relevant clinical notes, referrals, and test results."],["04","Draft and review","Prepare a letter for the patient and clinician to review before submission."]].map((x) => <div className="bb-workflow-row" key={x[0]}><span>{x[0]}</span><div><strong>{x[1]}</strong><p>{x[2]}</p></div></div>)}</div>
              <div className="bb-compliance-note">Appeal rules and deadlines depend on the plan and jurisdiction. This prototype does not submit appeals or provide a determination of coverage.</div>
            </section>
          )}

          {activeTab === "negotiation" && (
            <section className="bb-page-stack">
              <div className="bb-page-heading"><div><div className="bb-eyebrow">PATIENT-CONTROLLED NEGOTIATION</div><h1>Negotiation room</h1><p>Review the approach and set your limit before any offer is made.</p></div><span className={`bb-status ${negotiating ? "status-live" : "status-review"}`}>{negotiating ? "Demo in progress" : "Not started"}</span></div>
              <div className="bb-negotiation-layout">
                <div className="bb-card bb-chat-card">
                  <div className="bb-chat-header"><div className="bb-bot-avatar">✦</div><div><strong>Vellum advocate</strong><span>Medical billing assistant · Demo</span></div><span className="bb-online-dot" /></div>
                  <div className="bb-chat-messages">
                    <div className="bb-chat-date">CASE BB-1042 · SAMPLE CONVERSATION</div>
                    <div className="bb-chat-bubble assistant"><small>Vellum · Advocate</small>I’ll start by asking the billing office to review the flagged line items, confirm the applicable self-pay rate, and explain any available financial-assistance options.</div>
                    {negotiating && <div className="bb-chat-bubble provider"><small>Billing office · Example response</small>Please identify the specific line items in question. We can review the bill and explain any applicable financial-assistance options.</div>}
                    {negotiating && <div className="bb-chat-bubble assistant"><small>Vellum · Proposed next step</small>I’ll prepare a line-item review request and ask for an itemized statement. I will not accept a settlement or exceed your limit without your explicit approval.</div>}
                    {!negotiating && <div className="bb-chat-placeholder">Start the demo to preview a sample negotiation exchange.</div>}
                  </div>
                  <div className="bb-chat-footer"><span>◈</span><input disabled placeholder="Live messaging connects to your backend" /><button disabled>↑</button></div>
                  <div className="bb-chat-disclaimer">Scripted preview only. No real call, offer, or payment was sent.</div>
                </div>
                <aside className="bb-card bb-limit-card"><div className="bb-limit-icon">◎</div><h2>Your payment limit</h2><p>Set the maximum amount you would be willing to pay. The prototype never submits an offer.</p><div className="bb-limit-value">{money(patientLimit)}</div><input className="bb-limit-slider" type="range" min="500" max="5000" step="100" value={patientLimit} onChange={(e) => setPatientLimit(Number(e.target.value))} /><div className="bb-slider-labels"><span>$500</span><span>$5,000</span></div><label className="bb-limit-label">Maximum settlement budget<input type="number" min="0" value={patientLimit} onChange={(e) => setPatientLimit(Math.max(0, Number(e.target.value)))} /></label><div className="bb-limit-guard"><span>✓</span><div><strong>Your approval is required</strong><p>No settlement should be accepted automatically.</p></div></div><button className="bb-primary-button full" onClick={negotiating ? () => { setNegotiating(false); setNotice("Demo negotiation ended."); } : startNegotiation}>{negotiating ? "End demo negotiation" : "Start demo negotiation"} <span>→</span></button></aside>
              </div>
            </section>
          )}

          {activeTab === "savings" && (
            <section className="bb-page-stack">
              <div className="bb-page-heading"><div><div className="bb-eyebrow">YOUR OPTIONS</div><h1>Savings & offers</h1><p>Compare possible paths before deciding how to proceed.</p></div></div>
              <div className="bb-savings-intro bb-card"><div className="bb-savings-spark">✦</div><div><h2>There may be more than one way to resolve a bill.</h2><p>Start with documentation and eligibility. Any discounts or savings must be confirmed by the provider or insurer.</p></div></div>
              <div className="bb-option-grid">
                {[["01","Correct billing errors","Request review of questionable charges before negotiating the remaining balance.","Documentation first"],["02","Financial assistance","Check the provider's published eligibility policy and apply if potentially eligible.","Income-based options"],["03","Self-pay discount or plan","Ask whether a discounted settlement or affordable payment plan is available.","Ask the billing office"]].map((x) => <article className="bb-card bb-option-card" key={x[0]}><span className="bb-option-number">{x[0]}</span><h2>{x[1]}</h2><p>{x[2]}</p><span className="bb-option-tag">{x[3]}</span><button className="bb-text-button" onClick={() => { setActiveTab("negotiation"); setNotice(`Selected: ${x[1]}. Review your limit before continuing.`); }}>Explore this option →</button></article>)}
              </div>
              <div className="bb-compliance-note">No estimated savings shown here are guaranteed. Eligibility, negotiated rates, and final balances depend on the provider, insurer, and individual case.</div>
            </section>
          )}

          <footer className="bb-footer"><span>© Vellum · AI patient advocacy</span><span><i /> Prototype workspace <b>·</b> No real claims or payments</span></footer>
        </div>
      </main>
    </div>
  );
}
