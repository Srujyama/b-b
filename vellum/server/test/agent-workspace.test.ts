import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
vi.mock('../src/llm.js', () => ({ llmJson: vi.fn(), llmText: vi.fn() }));
import { llmJson } from '../src/llm.js';
import { buildApp } from '../src/index.js';
import { createCase, emit, requireCase, subscribe } from '../src/store.js';
// @ts-expect-error The web app uses native JavaScript modules.
import { agentProgress } from '../../web/agent.js';

const model = vi.mocked(llmJson);
let app: FastifyInstance;
beforeAll(async () => { app = await buildApp(); });
afterAll(async () => { await app.close(); });
beforeEach(() => { model.mockReset(); vi.stubEnv('ANTHROPIC_API_KEY', 'test-key'); });
afterEach(() => vi.unstubAllEnvs());
const bill = { provider: { name: 'Example hospital' }, patientName: 'Test Patient', lineItems: [
  { code: '99284', description: 'ER visit', qty: 1, charge: 1500 },
], patientBalance: 1500, totalCharges: 1500 };

async function settled(id: string) {
  await vi.waitFor(() => expect(requireCase(id).intake?.state).not.toBe('running'));
  return requireCase(id);
}

describe('message-first intake', () => {
  it('returns a resumable case before analysis finishes and asks for the actual bill', async () => {
    let resolve!: (value: any) => void;
    model.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    const res = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { message: 'I cannot afford my hospital bill.' } });
    expect(res.statusCode).toBe(202);
    const pending = res.json();
    expect(pending.intake.state).toBe('running');
    expect(pending.bill).toBeUndefined();
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    resolve({ hasBill: false, reply: 'I can help review it. Please attach your itemized bill.' });
    const c = await settled(pending.id);
    expect(c.intake).toMatchObject({ state: 'needs_bill', request: 'I cannot afford my hospital bill.' });
    expect(c.patient?.consent).not.toBe(true);
    expect(c.activity?.at(-1)?.message).toContain('Please attach');
  });

  it('accepts a pasted statement, audits it, and requires explicit preferences before a call', async () => {
    model.mockResolvedValueOnce({ hasBill: true } as never).mockResolvedValueOnce(bill as never);
    const res = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { message: 'Example hospital, ER visit 99284: $1,500. Balance $1,500.' } });
    const c = await settled(res.json().id);
    expect(c.status).toBe('audited');
    expect(c.intake?.state).toBe('done');
    expect(c.patient).toMatchObject({ name: 'Test Patient', consent: false, maxPay: 0 });
    expect(c.activity?.some(e => e.message.startsWith('Audit:'))).toBe(true);
    const call = await app.inject({ method: 'POST', url: `/api/cases/${c.id}/negotiate`, payload: {} });
    expect(call.statusCode).toBe(409);
  });

  it('attaches a bill to the same conversation without losing the original request or its events', async () => {
    model.mockResolvedValueOnce({ hasBill: false, reply: 'Please attach a bill.' } as never);
    const first = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { message: 'Help with my bill' } });
    const c = await settled(first.json().id);
    const history = c.activity!.map(e => e.id);
    model.mockResolvedValueOnce(bill as never);
    const boundary = 'vellum-test-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="caseId"\r\n\r\n${c.id}\r\n--${boundary}\r\nContent-Disposition: form-data; name="bill"; filename="bill.png"\r\nContent-Type: image/png\r\n\r\ntest-image\r\n--${boundary}--\r\n`;
    const res = await app.inject({ method: 'POST', url: '/api/cases/start', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(res.statusCode).toBe(202);
    expect(res.json().id).toBe(c.id);
    await settled(c.id);
    expect(c.intake).toMatchObject({ state: 'done', request: 'Help with my bill', fileName: 'bill.png' });
    expect(c.activity!.map(e => e.id)).toEqual(expect.arrayContaining(history));
    expect(model.mock.calls.at(-1)?.[2]?.image).toContain('data:image/png;base64,');
    const duplicate = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { caseId: c.id, message: 'Again' } });
    expect(duplicate.statusCode).toBe(409);
  });

  it('keeps failures visible and lets the same case retry', async () => {
    model.mockRejectedValueOnce(new Error('The reader timed out.'));
    const res = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { message: 'Review my bill' } });
    const c = await settled(res.json().id);
    expect(c.intake?.state).toBe('failed');
    expect(c.activity?.at(-1)).toMatchObject({ kind: 'error', message: 'The reader timed out.' });
    model.mockResolvedValueOnce({ hasBill: false, reply: 'Please attach the itemized bill.' } as never);
    const retry = await app.inject({ method: 'POST', url: '/api/cases/start', payload: { caseId: c.id, message: 'Review my bill' } });
    expect(retry.statusCode).toBe(202);
    await settled(c.id);
    expect(c.intake?.state).toBe('needs_bill');
  });
});

describe('recoverable activity and timeline', () => {
  it('retains updates before subscription and pushes new updates without retaining audio', () => {
    const c = createCase({ mode: 'patient' });
    emit(c.id, { type: 'log', message: 'Reviewing your message.' });
    const send = vi.fn();
    subscribe(c.id, { send, on: vi.fn(), readyState: 1 } as any);
    expect(JSON.parse(send.mock.calls[0][0]).packet.activity).toHaveLength(1);
    emit(c.id, { type: 'log', message: 'Researching prices via Context.dev' });
    const activity = send.mock.calls.map(c => JSON.parse(c[0])).find(e => e.type === 'activity');
    expect(activity.entry).toMatchObject({ stage: 'research', kind: 'update' });
    const before = c.activity?.length;
    emit(c.id, { type: 'audio', who: 'advocate', chunk: 'AA==', sampleRate: 16000 });
    expect(c.activity).toHaveLength(before!);
  });

  it('does not claim research or calls happened when still waiting for user input', () => {
    expect(agentProgress({ intake: { state: 'needs_bill' } })).toMatchObject({ review: 'waiting', research: 'pending', call: 'pending' });
    expect(agentProgress({ bill, status: 'audited', facts: ['PREVIEW: seed only'] })).toMatchObject({ review: 'done', research: 'waiting', plan: 'pending', call: 'pending' });
  });

  it('reflects research failure, running calls and completed outcomes from server state', () => {
    expect(agentProgress({ bill, research: { state: 'failed' } })).toMatchObject({ research: 'error', call: 'pending' });
    expect(agentProgress({ bill, status: 'negotiating', facts: ['Verified price'] })).toMatchObject({ research: 'done', plan: 'done', call: 'running', outcome: 'pending' });
    expect(agentProgress({ bill, status: 'agreed', facts: ['Verified price'], agreedAmount: 0 })).toMatchObject({ call: 'done', outcome: 'done' });
    expect(agentProgress({ bill, status: 'negotiating', facts: ['Verified price'], agreedAmount: 600 })).toMatchObject({ call: 'done', outcome: 'done' });
    expect(agentProgress({ bill, status: 'failed', fairPrices: [{}], facts: ['Verified price'] })).toMatchObject({ call: 'error', outcome: 'pending' });
  });
});
