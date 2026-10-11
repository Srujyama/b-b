// Clinic mode: denial -> payer policy criteria -> appeal letter -> argue it with the insurer's agent.
// Reuses the shared helpers and the negotiation room from app.js.
import {
  I18N, $, h, api, busy, t, getLang, safeUrl, showError, setupLangToggle, setupErrorBox, onLangChange,
  connectCase, mergeEvent, createRoom, startElevenConversation,
} from "./app.js";

Object.assign(I18N.en, {
  clinicBrand: "Clinic appeals",
  clinicTitle: "Appeal a denied claim",
  clinicLede: "Enter the denial and the clinical notes. BangBang pulls the payer's medical policy, checks each criterion against the chart, and drafts the appeal.",
  useDemoClaim: "Load the demo denial", ownClaim: "Or enter your own denial",
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
  humanMode: "Human mode: play the insurer's reviewer into the microphone. BangBang will argue the appeal with you.",
});
Object.assign(I18N.zh, {
  clinicBrand: "诊所申诉",
  clinicTitle: "申诉被拒的理赔",
  clinicLede: "输入拒赔理由和病历。帮帮会找到保险公司的医疗政策，逐条对照病历，并写好申诉信。",
  useDemoClaim: "载入示范拒赔", ownClaim: "或者输入您自己的拒赔",
  payer: "保险公司", denialReason: "拒赔理由（原文）", procCode: "项目代码", procDesc: "检查/治疗项目",
  diagnoses: "诊断，每行一个：代码 + 描述", notes: "病历记录", buildAppeal: "生成申诉",
  building: "正在找保险政策并写申诉信……",
  criteriaTitle: "政策条件 vs 病历", thCriterion: "条件", thMet: "符合", thEvidence: "病历里的证据",
  met: "符合", notMet: "不符合", noCriteria: "没有拿到这条政策的条件。", policy: "保险政策：",
  letterTitle: "申诉信", copyLetter: "复制申诉信", copied: "已复制", noLetter: "没有生成申诉信。",
  callInsurerTitle: "和保险公司谈", insurerSide: "保险公司那边是", callInsurer: "打给保险公司",
  denied: "拒赔", procedure: "项目",
  metCount: (m, n) => `${n} 条中符合 ${m} 条`,
  asked: "账单金额", current: "保险现在给", saved: "追回",
  calling: "正在和保险公司的 AI 通话。",
  humanMode: "真人模式：请对着麦克风扮演保险公司审核员，帮帮会跟您谈。",
});

const state = { packet: null, sub: null, convo: null };
const P = () => state.packet;
const room = createRoom({
  getPacket: P,
  getAsked: () => P()?.bill?.patientBalance ?? P()?.offers.find((o) => o.by === "advocate")?.amount,
});

setupLangToggle();
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
    $("#room-status").textContent = getLang() === "zh" ? ev.messageZh || ev.message : ev.message;
    return;
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

$("#claim-demo-btn").addEventListener("click", (e) =>
  busy(e.currentTarget, async () => {
    $("#room-status").textContent = t("building");
    adopt(await api("/api/claims/demo", { method: "POST", body: {} }));
    $("#room-status").textContent = "";
    $("#claim-result").scrollIntoView({ behavior: "smooth" });
  }),
);

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

$("#call-insurer-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  if (state.convo) {
    const c = state.convo;
    state.convo = null;
    btn.textContent = t("callInsurer");
    await c.endSession().catch(() => {});
    return;
  }
  room.audio.unlock();
  const counterparty = document.querySelector('input[name="counterparty"]:checked')?.value ?? "agent";
  await busy(btn, async () => {
    const res = await api(`/api/cases/${P().id}/negotiate`, { method: "POST", body: { counterparty } });
    if (res?.mode === "human") {
      if (!res.advocateSignedUrl) throw new Error("negotiate returned no advocateSignedUrl for human mode");
      $("#room-status").textContent = t("humanMode");
      state.convo = await startElevenConversation(
        res.advocateSignedUrl,
        {
          onMessage: ({ message, source }) => {
            if (!message) return;
            mergeEvent(P(), { type: "transcript", line: { role: source === "ai" ? "advocate" : "insurer", text: message, at: new Date().toISOString() } });
            room.render();
          },
          onError: (m) => showError(t("failed") + m),
          onDisconnect: () => {
            state.convo = null;
            $("#call-insurer-btn").textContent = t("callInsurer");
          },
        },
        { case_id: P().id },
      );
      btn.textContent = t("endCall");
    } else {
      $("#room-status").textContent = t("calling");
    }
  });
});

onLangChange(render);

const resumeId = new URLSearchParams(location.hash.slice(1)).get("case");
if (resumeId) {
  api(`/api/cases/${encodeURIComponent(resumeId)}`)
    .then((p) => (p.mode === "clinic" ? adopt(p) : null))
    .catch(() => history.replaceState(null, "", location.pathname));
}
