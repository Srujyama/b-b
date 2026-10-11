// Shared contracts. Every module imports from here — change a shape here, not locally.

export type Lang = "zh" | "en";

export type Source = {
  title: string;
  url: string;
  snippet?: string;
  via: "context.dev" | "cms" | "gemini" | "llm" | "other";
};

// ---- bill ----
export type LineItem = {
  code?: string; // CPT / HCPCS / revenue code as printed
  codeType?: "CPT" | "HCPCS" | "REV" | "DRG" | "NDC" | "OTHER";
  description: string;
  descriptionZh?: string; // plain-language Chinese explanation
  qty: number;
  charge: number; // USD, line total
  date?: string; // YYYY-MM-DD
};

export type Bill = {
  provider: { name: string; address?: string; website?: string; npi?: string; ein?: string; phone?: string };
  patientName?: string;
  accountNumber?: string;
  serviceDate?: string;
  insurer?: string;
  lineItems: LineItem[];
  totalCharges: number;
  insurancePaid?: number;
  adjustments?: number;
  patientBalance: number; // what the hospital says she owes
};

export type AuditFlagKind =
  | "duplicate"
  | "upcoding"
  | "unbundling"
  | "above_fair_price"
  | "charity_eligible"
  | "no_surprises_act"
  | "math_error"
  | "other";

export type AuditFlag = {
  kind: AuditFlagKind;
  lineIndex?: number;
  message: string; // English, citable by the negotiator
  messageZh?: string; // what we show Mom
  amountAtStake: number; // USD this flag could remove from the balance
  evidence?: string;
};

// ---- research ----
export type FairPrice = {
  code: string;
  description?: string;
  medicareRate?: number;
  hospitalCashPrice?: number;
  negotiatedMedian?: number;
  billed?: number;
  sources: Source[];
};

export type CharityPolicy = {
  hospital: string;
  hasFap: boolean; // 501(r) financial assistance policy found
  freeCareBelowPctFpl?: number; // e.g. 200 => free care under 200% FPL
  discountBelowPctFpl?: number; // e.g. 400 => discounted care under 400% FPL
  discountPct?: number;
  applicationUrl?: string;
  summary: string;
  sources: Source[];
};

export type FinancingAdvice = {
  recommendation: "lump_sum" | "payment_plan";
  reason: string;
  reasonZh?: string;
  fedOdds?: { market: string; ticker: string; outcomes: { label: string; prob: number }[]; fetchedAt: string };
  expectedRatePath?: number; // implied policy-rate change in bps
  sources: Source[];
};

// ---- people ----
export type Patient = {
  name: string;
  language: Lang;
  householdSize?: number;
  annualIncome?: number; // USD
  maxPay: number; // the mandate: never agree above this
  consent: boolean; // HIPAA-style authorization for the agent to act
};

// ---- clinic mode ----
export type ClaimCase = {
  payer: string;
  denialReason: string;
  procedure: { code: string; description: string };
  diagnoses: { code: string; description: string }[];
  clinicalNotes: string;
  policy?: { title: string; url: string; criteria: string[] };
  criteriaMet?: { criterion: string; met: boolean; evidence: string }[];
  appealLetter?: string;
};

// ---- negotiation ----
export type Offer = { by: "advocate" | "hospital" | "insurer"; amount: number; at: string; note?: string };

export type Receipt = {
  chain: "xrpl" | "bsc" | "base" | "gemini";
  kind: string; // e.g. "CredentialCreate", "EscrowCreate", "x402-payment", "logEntry"
  txHash: string;
  explorerUrl: string;
  detail?: Record<string, unknown>;
  at: string;
};

export type TranscriptLine = { role: string; text: string; textZh?: string; at: string };

export type CaseStatus =
  | "intake"
  | "audited"
  | "researched"
  | "mandated"
  | "negotiating"
  | "agreed"
  | "settled"
  | "failed";

export type CasePacket = {
  id: string;
  mode: "patient" | "clinic";
  status: CaseStatus;
  /** Browser / AI-counterparty rehearsal; any negotiated outcome is simulated. */
  voiceSimulation?: boolean;
  patient?: Patient;
  bill?: Bill;
  flags: AuditFlag[];
  fairPrices: FairPrice[];
  charity?: CharityPolicy;
  financing?: FinancingAdvice;
  claim?: ClaimCase;
  // negotiation ladder (USD). target = genuine goal, opening = first ask, walkaway = Patient.maxPay
  target?: number;
  opening?: number;
  walkaway?: number;
  facts: string[]; // the ONLY claims the negotiator may make, English
  offers: Offer[];
  agreedAmount?: number;
  transcript: TranscriptLine[];
  receipts: Receipt[];
  createdAt: string;
};

// Events pushed over WS /ws?case=<id>
export type CaseEvent =
  | { type: "status"; status: CaseStatus }
  | { type: "transcript"; line: TranscriptLine }
  | { type: "offer"; offer: Offer }
  | { type: "deal"; amount: number }
  | { type: "receipt"; receipt: Receipt }
  | { type: "log"; message: string; messageZh?: string }
  | { type: "error"; message: string }
  | { type: "case"; packet: CasePacket }
  // agent-vs-agent bridge: base64 PCM16 mono chunks so the browser can play both voices
  | { type: "audio"; who: "advocate" | "hospital" | "insurer"; sampleRate: number; chunk: string };
