// Public execution summaries, derived from actual case state and persisted server events.
// No timer advances a stage and no private model reasoning is exposed.
export const AGENT_STAGES = [
  { id: 'review', title: 'Read your bill', tool: 'Vellum', icon: '01' },
  { id: 'research', title: 'Find fair prices', tool: 'Context.dev', icon: '02' },
  { id: 'plan', title: 'Build your case', tool: 'Caller agent', icon: '03' },
  { id: 'call', title: 'Make the call', tool: 'ElevenLabs', icon: '04' },
  { id: 'outcome', title: 'Your outcome', tool: 'Summary', icon: '05' },
];

export function agentProgress(p) {
  const stages = Object.fromEntries(AGENT_STAGES.map(s => [s.id, 'pending']));
  if (!p) return { ...stages, review: 'running' };
  if (!p.bill) return { ...stages, review: p.intake?.state === 'failed' || p.status === 'failed' ? 'error' : p.intake?.state === 'needs_bill' ? 'waiting' : 'running' };
  stages.review = 'done';
  if (p.research?.state === 'running') stages.research = 'running';
  else if (p.research?.state === 'failed') stages.research = 'error';
  else if (['researched', 'mandated', 'negotiating', 'agreed', 'settled'].includes(p.status) || p.research?.state === 'done' || (p.status === 'failed' && p.fairPrices?.length)) stages.research = 'done';
  else stages.research = 'waiting';
  if (stages.research === 'done') stages.plan = p.facts?.length ? 'done' : 'waiting';
  if (p.agreedAmount != null) { stages.call = 'done'; stages.outcome = 'done'; }
  else if (p.status === 'negotiating') stages.call = 'running';
  else if (p.status === 'failed') stages.call = 'error';
  else if (stages.plan === 'done') stages.call = 'waiting';
  return stages;
}

const labels = { pending: 'Up next', running: 'In progress', done: 'Complete', waiting: 'Needs your input', error: 'Needs attention' };
const element = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const dollars = n => typeof n === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n) : '—';

export function createAgentWorkspace(onNavigate) {
  const timeline = document.getElementById('agent-timeline');
  const feed = document.getElementById('activity-feed');
  const nodes = new Map();
  let caseId;
  let visibleStage;
  const cards = AGENT_STAGES.map(s => {
    const li = element('li', 'journey-step');
    const button = element('button', 'journey-button');
    button.type = 'button';
    const icon = element('span', 'journey-icon', s.icon);
    const copy = element('span', 'journey-copy');
    const title = element('b', '', s.title);
    const tool = element('span', 'journey-tool', s.tool);
    const status = element('span', 'journey-status', 'Up next');
    copy.append(title, tool, status);
    button.append(icon, copy);
    button.addEventListener('click', () => onNavigate(s.id));
    li.append(button);
    timeline.append(li);
    return { li, button, icon, status, tool, stage: s };
  });
  function connection(state) {
    const el = document.getElementById('agent-connection');
    el.dataset.state = state;
    el.textContent = { connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting…' }[state] || state;
  }
  function render(p, { sending = false, error = '', analysisError = '', actionError = null } = {}) {
    error ||= analysisError || actionError?.message || '';
    const progress = agentProgress(p);
    if (analysisError) progress.review = 'error';
    if (error && !p) progress.review = 'error';
    if (actionError) progress[actionError.stage] = 'error';
    cards.forEach(({ li, button, icon, status, tool, stage }) => {
      const value = progress[stage.id];
      const toolName = stage.id === 'call' && p?.negotiationChannel === 'text' ? 'Live text' : stage.tool;
      tool.textContent = toolName;
      li.dataset.state = value;
      button.disabled = !p || value === 'pending' || (stage.id === 'research' && !p.patient?.consent) || (stage.id === 'review' && !p.bill);
      button.setAttribute('aria-label', `${stage.title}, ${toolName}, ${labels[value]}`);
      button.setAttribute('aria-current', value === 'running' ? 'step' : 'false');
      icon.textContent = value === 'done' ? '✓' : value === 'error' ? '!' : stage.icon;
      status.textContent = labels[value];
    });
    const current = cards.find(c => progress[c.stage.id] === 'running' || progress[c.stage.id] === 'error')
      ?? cards.find(c => progress[c.stage.id] === 'waiting') ?? cards.at(-1);
    if (current && visibleStage !== current.stage.id && timeline.parentElement.clientWidth < timeline.scrollWidth) {
      visibleStage = current.stage.id;
      timeline.parentElement.scrollTo({ left: Math.max(0, current.li.offsetLeft - cards[0].li.offsetLeft - 16),
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    const active = sending || Object.values(progress).includes('running');
    const failed = !!error || Object.values(progress).includes('error');
    const finished = progress.outcome === 'done';
    const badge = document.getElementById('activity-state');
    badge.textContent = failed ? 'Needs attention' : active ? 'Working' : finished ? 'Complete' : 'Your turn';
    badge.dataset.state = failed ? 'error' : active ? 'running' : finished ? 'done' : 'waiting';
    let summary = p?.intake?.message || 'Sending your request to Vellum…';
    if (p?.bill) {
      summary = p.patient?.consent ? 'Ready to research the strongest ways to reduce your bill.' : 'Review your bill and set your preferences to continue.';
      if (progress.research === 'running') summary = 'Checking published prices and financial assistance with Context.dev.';
      if (progress.research === 'done') summary = 'Your research is ready. Review the plan, then start the call.';
      if (progress.call === 'running') summary = p.negotiationChannel === 'text' ? 'Your advocate is negotiating with the AI billing agent in live text.' : p.voiceSimulation ? 'Your advocate is speaking with the AI billing agent.' : 'Your advocate is negotiating. Follow the conversation below.';
      if (finished) summary = `${p.voiceSimulation ? 'Simulated agreement' : 'Agreement'} reached at ${dollars(p.agreedAmount)}. Your summary is ready.`;
      if (failed) summary = 'A step needs attention. See the latest update before continuing.';
    }
    if (error) summary = error;
    const summaryEl = document.getElementById('activity-summary');
    if (summaryEl.textContent !== summary) summaryEl.textContent = summary;
    document.getElementById('analysis-title').textContent = failed ? 'Let’s try that again' : p?.intake?.state === 'needs_bill' ? 'Let’s take a look at your bill' : 'Reviewing your request';
    document.getElementById('analysis-message').textContent = error || p?.intake?.message || 'I’ll check the details and find the next step for your bill.';
    document.getElementById('screen-analysis').classList.toggle('is-working', active && !failed);
    document.getElementById('retry-analysis').hidden = !failed || !!p?.bill;
    if (p?.intake) {
      document.getElementById('request-card').hidden = false;
      document.getElementById('request-text').textContent = p.intake.request;
      document.getElementById('request-file').textContent = p.intake.fileName || '';
    }
    if (caseId !== p?.id) { feed.replaceChildren(); nodes.clear(); caseId = p?.id; }
    const entries = p?.activity ?? [];
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
    let added = false;
    for (const entry of entries) {
      if (nodes.has(entry.id)) continue;
      added = true;
      const li = element('li', `activity-entry ${entry.kind}`);
      const meta = element('div', 'activity-meta');
      const stage = AGENT_STAGES.find(s => s.id === entry.stage);
      const time = element('time', '', new Date(entry.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      time.dateTime = entry.at;
      const toolName = entry.stage === 'call' && /live text/i.test(entry.message) ? 'Live text' : stage?.tool || 'Vellum';
      meta.append(element('span', 'activity-tool', toolName), time);
      li.append(meta, element('p', '', entry.message));
      nodes.set(entry.id, li);
      feed.append(li);
    }
    const kept = new Set(entries.map(e => e.id));
    for (const [id, node] of nodes) if (!kept.has(id)) { node.remove(); nodes.delete(id); }
    // A reconnect snapshot can include earlier events that arrived before the socket opened.
    // Insert them in the server's order instead of appending them after newer live updates.
    entries.forEach((entry, index) => {
      const node = nodes.get(entry.id);
      if (feed.children[index] !== node) feed.insertBefore(node, feed.children[index] ?? null);
    });
    if (added && atBottom) feed.scrollTop = feed.scrollHeight;
    document.getElementById('agent-preview').hidden = !p?.facts?.some(f => f.startsWith('PREVIEW'));
    if (failed && !p) connection('Unavailable');
    document.getElementById('activity-count').textContent = `${entries.length} update${entries.length === 1 ? '' : 's'}`;
    document.getElementById('activity-empty').hidden = entries.length > 0;
    const facts = document.getElementById('agent-case-facts');
    facts.replaceChildren();
    if (p?.bill) {
      for (const [label, value] of [['Original bill', dollars(p.bill.patientBalance)], ['Your limit', p.patient?.maxPay > 0 ? dollars(p.patient.maxPay) : 'Not set yet']]) {
        const row = element('div', 'agent-fact'); row.append(element('span', '', label), element('b', '', value)); facts.append(row);
      }
      if (p.voiceSimulation) facts.append(element('p', 'simulation-note', 'AI practice call · no hospital is contacted'));
    }
  }
  return { render, connection };
}
