# Medical bill negotiation: patient process and voice-worker plan

Research checkpoint: October 11, 2026. US medical bills. This is a proposed operating playbook for
the orchestrator, not a claim that the current product implements every stage or that a discount is
guaranteed. Hospital policy, insurance, state, provider entity, and dates determine which options apply.

## How a person would approach it

1. **Assemble the account.** Gather the bill, service dates, itemized charges, insurance explanation
   of benefits (EOB), payments already made, and any estimate. Confirm who is billing: a hospital,
   physician group, lab, insurer, or collector. An EOB explains insurance processing; it is not a bill.
   Ask about a balance that differs from the EOB rather than assuming the entire billed charge is owed.
   [CMS: reading an EOB](https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/medical-bill-guides-resources/how-read-health-insurance-explanation-benefits)
2. **Ask billing to investigate specific discrepancies.** Request itemization; compare dates, units,
   services, insurance credits, and prior payments. Ask about suspected duplicates or coding errors
   and request a corrected statement. A repeated code can represent separate legitimate services;
   a model flag is a question for review, not proof of fraud or upcoding. Ask whether billing can put
   the account on hold while the issue is reviewed and get the hold's scope and expiry confirmed.
   [CMS: bill errors](https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/guides-resources/check-your-bill-errors)
3. **Resolve insurance issues through the right channel.** Ask whether the claim was submitted and
   processed correctly; get the denial reason and correction or appeal procedure. Provider corrections
   and insurer appeals are different tasks. Record deadlines from the actual notice. Screen possible
   surprise-billing protections before treating a disputed charge as an amount to bargain down.
   [CFPB: medical bill help](https://www.consumerfinance.gov/ask-cfpb/what-should-i-do-if-i-cant-pay-a-medical-bill-en-2125/)
4. **Apply for financial assistance before promising payment.** Ask for the provider's current policy,
   application, covered providers, eligibility criteria, required documents, deadline, and a financial
   counselor. Assistance can be available even with insurance. Eligibility must be confirmed under
   the actual policy; the agent must not promise approval. Keep a copy of the application and follow up.
   [CMS: financial assistance](https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/guides-resources/apply-financial-assistance)
5. **Negotiate the remaining, understood balance.** Ask about hardship adjustments, applicable self-pay
   discounts, or a discounted lump-sum option if the patient can actually afford it. A sourced cash
   price or benchmark can support a request; it does not establish a universal legal payment ceiling.
   If a reduction is unavailable, ask for an affordable interest-free plan and the full terms, including
   fees and what happens after a missed payment. Do not take on medical credit merely to finish a call.
   [CFPB: negotiation and payment options](https://www.consumerfinance.gov/ask-cfpb/what-should-i-do-if-i-cant-pay-a-medical-bill-en-2125/)
6. **Confirm the outcome in writing.** Our recommended close is to request the exact remaining balance,
   accounts covered, payment schedule, interest/fees, expiry, and whether payment resolves those
   accounts. Record the representative, department, reference number, date, and promised follow-up.
   Review the written offer before committing; after payment, obtain and reconcile the updated statement.

This can take multiple calls and an application or appeal. A useful first call may only identify the
required authorization, correct a claim, or obtain a collections hold; it need not produce a settlement.

## Distinct routes the orchestrator must recognize

| Situation | Next task | Do not infer |
| --- | --- | --- |
| Bill/EOB mismatch or unpaid insurance claim | Billing correction or insurer clarification | That the gross charge is the final patient liability |
| Possible hardship | Obtain current policy and application requirements | Eligibility or approval from income alone |
| Denied insurance claim | Gather denial, policy, evidence, and appeal deadline | That the billing clerk can overturn the insurer |
| Potential surprise bill | Review the applicable federal/state route with the client | That every out-of-network charge is prohibited |
| Uninsured/self-pay bill above an estimate | Screen for CMS patient-provider dispute resolution | That the process also applies to insured claims |
| Collections notice or legal deadline | Preserve notice and route for appropriate review | That informal negotiation pauses every deadline |

For the CMS self-pay dispute route, check the actual requirements: care without using insurance,
advance notice of that choice, a qualifying good faith estimate, initial bill within 120 calendar days,
and at least $400 above one provider/facility's estimate. There is a $25 filing fee. This is a screening
task, not permission for the voice worker to file or pay. See the full
[CMS qualification rules](https://www.cms.gov/initiatives/your-patient-rights/medical-bill-rights/get-help/dispute-bill).

Tax-exempt hospital financial-assistance rules are specific to those facilities. Their policies must
identify eligible care and relevant providers; separate professional bills may have different coverage.
Do not assert one national income threshold or automatic cancellation of collections. The research
worker should check the current provider policy and applicable dates.
[IRS: financial assistance policies](https://www.irs.gov/charities-non-profits/financial-assistance-policies-faps)

## How our agent should execute this

The orchestrator owns the evidence, strategy, authorization, and follow-up. It selects one bounded
call task; Haiku executes that task in the same server and reads the latest shared case memory.
Research and document review happen before or between calls, not in a long pause during every turn.
The current outbound worker requests nonbinding proposals only. Client approval and any later payment
are separate product actions.

Before dispatch, the orchestrator should have:

- Verified billing contact and office hours; patient/account identifiers only as needed.
- Actual authorization evidence, its scope and expiry, and whether the office has accepted it. A user
  checkbox or an on-chain mandate alone does not prove the provider will disclose account information.
- Facts with document/page or source-URL references, dates, and uncertainty labels. Keep an extraction
  hypothesis distinct from a confirmed discrepancy or a provider's statement.
- A specific objective, allowed negotiation ceiling if any, forbidden actions, success evidence, and
  what requires a return to the client. An absent ceiling means no monetary offer.
- The next deadline and a fallback if the office requires the patient, another document, or a supervisor.

Providers may require written authorization or the patient to participate. Ask what they accept rather
than claiming the AI has a legal representative status or pretending to be the patient.
[HHS: personal representatives and authorizations](https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/personal-representatives/index.html)

Suggested `VoicePlan` content for a first billing call (placeholders must be filled from real evidence):

```text
objective: Confirm the account balance and obtain correction/assistance requirements without committing payment.
steps:
  - Confirm the billing office and complete only the approved verification steps.
  - If authorization is not accepted, ask for the required form/process and stop account discussion.
  - Confirm the current patient balance and insurance-processing status.
  - Ask for itemization and review only the discrepancies identified in the supplied facts.
  - Ask for the current financial-assistance policy, application channel, documents, and deadlines.
  - Request a billing/collections hold; record whether granted and its expiration.
  - Recap the reference number, written follow-up, and next action; return to the orchestrator.
constraints.forbiddenActions:
  - No binding agreement, payment authorization, credit application, waiver, or claim of submitted paperwork.
  - No invented eligibility, clinical facts, prices, balances, or claim of a signed form without evidence.
```

A later negotiation task may ask what reduction the office can offer or propose a client-approved
amount as nonbinding. It must clarify that client review is required. Do not describe an offer as a
completed deal, promise payment today, bluff about funds, or claim to have consulted the client during
a pause when no such consultation occurred.

Useful opening after reaching the right office:

> I'm an AI representative calling on behalf of my client about a bill. What authorization do you need
> before we discuss the account?

Useful close:

> Thank you. Could you send those terms in writing, including the accounts covered and the deadline?
> I'll bring the proposal back to my client for review.

## Shared memory and outcome evidence

Use existing `configureVoiceContext({ resolveTask, read, writeResult })` hooks. Store results by job ID
idempotently. The current result contains free-text `proposal`, `blockers`, `nextSteps`, and a transcript;
the following are recommended orchestrator records, not new fields already implemented by this worker:

- Account and payer identity, disputed items, original/corrected patient balances, and evidence references.
- Assistance status: policy obtained / documents missing / submitted / pending / approved / denied.
- Proposed terms: total, installments, fees/interest, covered accounts, expiry, and written confirmation.
- Hold granted or declined, scope, expiry, reference number, and which person owns the next action.
- Separate statuses for provider-reported, document-confirmed, client-approved, and payment-reconciled.

Savings should compare the verified original patient liability with the verified final liability for the
same accounts. Do not count a hospital's gross sticker charge, a verbal offer, or pending assistance as
realized savings. Human review should resolve contradictions between the transcript and model summary.

## Gaps before calling a real billing office

The real worker already has AI identification, nonbinding-only authority, IVR/hold tools, destination
allowlisting, journal-based duplicate protection, streamed Haiku responses, and v4 delivery guidance.
The three orchestrator hooks still need registration in the combined server. The browser/demo path in
`prompts.ts` has different acceptance tools and tactics; do not route real phone calls through it without
reviewing and reconciling that behavior.

For a first controlled test, use a teammate and synthetic account details. Exercise rejected authorization,
an EOB mismatch, uncertain duplicate charges, an assistance application, a bad offer, hold/IVR, interruption,
and a dropped call. Confirm memory updates, proposal review, and duplicate prevention. Before real patient
use, review provider data arrangements, access/retention controls, and applicable disclosure requirements.
Audio recording is disabled, but ElevenLabs and the local journal still process/store transcript text.
Measure end-of-speech to audible reply; the earlier TTS-only timings do not measure this full path.

See [BROWSER_DEMO.md](./BROWSER_DEMO.md) for the live-connection sequence and remaining blockers.
