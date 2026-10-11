// Clinic mode: denial -> payer policy criteria -> appeal letter -> argue it with the insurer's agent.
// Reuses the shared helpers and the negotiation room from app.js.
import {
  I18N, $, h, api, busy, t, safeUrl, showError, setupErrorBox,
  connectCase, mergeEvent, createRoom, startElevenConversation, ADVOCATE_TOOLS,
} from "./app.js";

Object.assign(I18N.en, {
  clinicBrand: "Clinic appeals",
  clinicTitle: "Appeal a denied claim",
  clinicLede: "Enter the denial and the clinical notes. Vellum pulls the payer's medical policy, checks each criterion against the chart, and drafts the appeal.",
  useDemoClaim: "Demo: denied lumbar MRI (Aetna)", useDemoSleep: "Demo: denied sleep study (UnitedHealthcare)", ownClaim: "Or enter your own denial",
  payer: "Payer", denialReason: "Denial reason as written", procCode: "Procedure code", procDesc: "Procedure",
  diagnoses: "Diagnoses, one per line: code then description", notes: "Clinical notes", buildAppeal: "Build the appeal",
  building: "Pulling the payer policy and drafting the appeal…",
  criteriaTitle: "Policy criteria against the chart", thCriterion: "Criterion", thMet: "Met", thEvidence: "Evidence in the notes",
  met: "Met", notMet: "Not met", noCriteria: "No criteria were returned for this policy.", policy: "Payer policy:",
  letterTitle: "Appeal letter", copyLetter: "Copy letter", copied: "Copied", noLetter: "No appeal letter was returned.",
  callInsurerTitle: "Argue it with the insurer", insurerSide: "Insurer side is", callInsurer: "Call the insurer",
  denied: "Denied", procedure: "Procedure",
  metCount: (m, n) => `${m} of ${n} criteria met`,
  asked: "Billed", current: "Insurer now", saved: "Recovered",
  calling: "On the call with the insurer's agent.",
  humanMode: "Human mode: play the insurer's reviewer into the microphone. Vellum will argue the appeal with you.",
});

const state = { packet: null, sub: null, convo: null, bridgeOn: false };
const P = () => state.packet;
const room = createRoom({
  getPacket: P,
  getAsked: () => P()?.bill?.patientBalance ?? P()?.offers.find((o) => o.by === "advocate")?.amount,
});

setupErrorBox();

function adopt(packet) {
  if (!packet?.id) throw new Error("server returned no case");
  if (!state.packet || state.packet.id !== packet.id) {
    state.sub?.close();
    state.sub = connectCase(packet.id, onEvent);
    try {
      history.replaceState(null, "", `#case=${packet.id}`);
    } catch {}
  }
  state.packet = packet;
  render();
}

function onEvent(ev) {
  if (ev.type === "case" && ev.packet) {
    state.packet = ev.packet;
    return render();
  }
  if (ev.type === "audio") return room.handle(ev);
  if (ev.type === "error") return showError(t("failed") + ev.message);
  if (ev.type === "log") {
    $("#room-status").textContent = ev.message;
    return;
  }
  if (ev.type === "deal" || (ev.type === "status" && ["agreed", "failed", "settled"].includes(ev.status))) {
    state.bridgeOn = false;
    setCallLabel();
  }
  if (state.packet && mergeEvent(state.packet, ev)) render();
}

function render() {
  const p = P();
  const claim = p?.claim;
  if (!claim) return;
  $("#claim-result").hidden = false;
  $("#insurer-room").hidden = false;

  const crit = claim.criteriaMet ?? [];
  const metN = crit.filter((c) => c.met).length;
  $("#claim-head").replaceChildren(
    h("p", { class: "payer" }, claim.payer),
    h("h2", {}, `${claim.procedure.code} ${claim.procedure.description}`),
    h("p", { class: "denial" }, h("b", {}, `${t("denied")}: `), claim.denialReason),
    claim.diagnoses?.length ? h("p", { class: "fine" }, claim.diagnoses.map((d) => `${d.code} ${d.description}`).join("; ")) : null,
    crit.length ? h("p", { class: metN === crit.length ? "tally ok" : "tally" }, t("metCount", metN, crit.length)) : null,
  );

  const pol = claim.policy;
  const href = pol && safeUrl(pol.url);
  $("#policy-link").replaceChildren(
    ...(pol ? [`${t("policy")} `, href ? h("a", { href, target: "_blank", rel: "noopener" }, pol.title) : pol.title] : []),
  );

  const body = $("#criteria tbody");
  body.replaceChildren(
    ...(crit.length
      ? crit.map((c) =>
          h(
            "tr",
            { class: c.met ? "met" : "unmet" },
            h("td", {}, c.criterion),
            h("td", { class: "mark" }, h("span", { class: "pill" }, c.met ? t("met") : t("notMet"))),
            h("td", {}, c.evidence),
          ),
        )
      : [h("tr", {}, h("td", { colspan: "3", class: "fine" }, t("noCriteria")))]),
  );

  $("#appeal-letter").textContent = claim.appealLetter || t("noLetter");
  room.render();
}

for (const [id, fixture] of [["#claim-demo-btn", "mri"], ["#claim-demo-sleep-btn", "sleep"]]) {
  $(id).addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      $("#room-status").textContent = t("building");
      adopt(await api("/api/claims/demo", { method: "POST", body: { fixture } }));
      $("#room-status").textContent = "";
      $("#claim-result").scrollIntoView({ behavior: "smooth" });
    }),
  );
}

$("#claim-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const diagnoses = $("#c-dx")
    .value.split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [code, ...rest] = l.split(/\s+/);
      return { code, description: rest.join(" ") };
    });
  const claim = {
    payer: $("#c-payer").value.trim(),
    denialReason: $("#c-reason").value.trim(),
    procedure: { code: $("#c-code").value.trim(), description: $("#c-desc").value.trim() },
    diagnoses,
    clinicalNotes: $("#c-notes").value.trim(),
  };
  busy($("#claim-submit"), async () => {
    adopt(await api("/api/claims", { method: "POST", body: { claim } }));
    $("#claim-result").scrollIntoView({ behavior: "smooth" });
  });
});

$("#copy-letter").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($("#appeal-letter").textContent);
    btn.textContent = t("copied");
    setTimeout(() => (btn.textContent = t("copyLetter")), 1500);
  } catch (err) {
    showError(t("failed") + err.message);
  }
});

function setCallLabel() {
  $("#call-insurer-btn").textContent = state.convo || state.bridgeOn ? t("endCall") : t("callInsurer");
}

$("#call-insurer-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (state.convo) {
    const c = state.convo;
    state.convo = null;
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
  if (!P()) return showError(t("failed") + "load a denial first");
  room.audio.unlock(); // user gesture: lets the browser play the agents' audio
  const counterparty = document.querySelector('input[name="counterparty"]:checked')?.value ?? "agent";
  await busy(btn, async () => {
    const res = await api(`/api/cases/${P().id}/negotiate`, { method: "POST", body: { counterparty } });
    if (res?.mode === "human") {
      if (!res.advocateSignedUrl) throw new Error("negotiate returned no advocateSignedUrl for human mode");
      $("#room-status").textContent = t("humanMode");
      state.convo = await startElevenConversation(res.advocateSignedUrl, {
        init: res.advocateInit,
        caseId: P().id,
        tools: ADVOCATE_TOOLS,
        onMessage: ({ message, source }) => {
          if (!message) return;
          mergeEvent(P(), { type: "transcript", line: { role: source === "ai" ? "advocate" : "insurer", text: message, at: new Date().toISOString() } });
          room.render();
        },
        onError: (m) => showError(t("failed") + m),
        onDisconnect: () => {
          state.convo = null;
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

const resumeId = new URLSearchParams(location.hash.slice(1)).get("case");
if (resumeId) {
  api(`/api/cases/${encodeURIComponent(resumeId)}`)
    .then((p) => (p.mode === "clinic" ? adopt(p) : null))
    .catch(() => history.replaceState(null, "", location.pathname));
}
