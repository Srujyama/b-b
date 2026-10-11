import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/index.js";

// Static web app served by @fastify/static from vellum/web. No keys needed.
let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp();
});
afterAll(async () => {
  await app.close();
});

async function get(url: string) {
  const res = await app.inject({ method: "GET", url });
  expect(res.statusCode, url).toBe(200);
  return res;
}

describe("web: patient app", () => {
  it("serves index.html with every screen and the key controls", async () => {
    const res = await get("/");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = res.body;
    expect(html).toContain('<html lang="en">');
    // The message-first landing opens the analysis workspace and existing case screens.
    for (const screen of ["analysis", "bill", "intake", "research", "room", "summary"]) {
      expect(html).toContain(`data-screen="${screen}"`);
    }
    for (const id of [
      "patient-app", "error", "message-form", "message-input", "bill-file", "send-btn", "attach-btn", "bill-lines", "talk-btn",
      "intake-form", "f-consent", "research-btn", "research-feed", "mandate-btn", "ticker", "tk-asked", "tk-current",
      "tk-saved", "counterparty", "negotiate-btn", "transcript", "receipts", "fed-card", "settle-btn", "confirm-btn",
      "credential-btn", "loan-btn", "hedge-btn", "financing-btn", "x402-btn", "intake-submit", "to-room", "deal-box",
      "to-summary", "sum-figs", "outcome-card", "pay-details", "agent-timeline", "activity-feed",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/styles.css"');
    // no landing intro animation: the page is the flow, plus a short home section
    expect(html).not.toContain("intro.js");
    expect(html).not.toContain("intro.css");
    expect((await app.inject({ method: "GET", url: "/intro.js" })).statusCode).toBe(404);
    expect(html).toContain('class="home"');
    for (const sponsor of ["Claude", "ElevenLabs", "Context.dev", "XRPL", "Gemini", "BNB Chain", "AUSD"]) expect(html, sponsor).toContain(sponsor);
    // research status line for the async (202 + /ws) research step
    expect(html).toContain('id="research-status"');
    expect(html).toContain('id="research-status-text"');
    // the five-step demo flow, with its exact wording; no "Run everything" in the main flow
    for (const words of ["Your preferences", "Research", "The call", "Summary", "Start the call", "See summary", "Payment &amp; receipts"]) {
      expect(html, words).toContain(words);
    }
    expect(html).not.toContain('id="run-btn"');
    expect(html).not.toContain('id="demo-btn"');
    expect(html).not.toContain("Try the demo bill");
    expect(html).toMatch(/Vellum <span class="accent">negotiates<\/span> your hospital bill\./);
  });

  it("serves app.js wired to the API contract", async () => {
    const res = await get("/app.js");
    expect(res.headers["content-type"]).toMatch(/javascript/);
    const js = res.body;
    for (const path of [
      "/api/cases", "/api/cases/start", "/api/intake/signed-url", "/api/eleven/tools/", "/research", "/mandate",
      "/negotiate", "/negotiate/stop", "/api/x402/payments", "/ws?case=",
    ]) {
      expect(js, path).toContain(path);
    }
    // per-case POST actions go through post("<name>") -> /api/cases/:id/<name>
    expect(js).toContain("api(`/api/cases/${P().id}/${path}`");
    for (const action of ["settle", "confirm-zero-balance", "credential", "loan", "financing", "hedge"]) {
      expect(js, action).toContain(`post("${action}"`);
    }
    // every CaseEvent type is handled
    for (const ev of ["status", "transcript", "offer", "deal", "receipt", "log", "error", "case", "audio"]) {
      expect(js, ev).toContain(`"${ev}"`);
    }
    // CDN libs pinned to an exact version
    expect(js).toMatch(/@elevenlabs\/client@\d+\.\d+\.\d+/);
    expect(js).toContain("conversation_config_override");
    expect(js).toContain("clientTools");
  });

  it("serves styles.css: always white, one blue accent", async () => {
    const res = await get("/styles.css");
    expect(res.headers["content-type"]).toMatch(/text\/css/);
    expect(res.body).toContain("--bg: #ffffff");
    expect(res.body).toContain("--accent: #2563eb");
    expect(res.body).toContain("color-scheme: light");
  });
});

describe("web: clinic page", () => {
  it("serves clinic.html with the appeal flow and the shared room", async () => {
    const html = (await get("/clinic.html")).body;
    for (const id of [
      "clinic-app", "claim-demo-btn", "claim-demo-sleep-btn", "claim-form", "criteria", "appeal-letter", "copy-letter", "insurer-room",
      "call-insurer-btn", "transcript", "tk-current", "error",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('src="/clinic.js"');
  });

  it("serves clinic.js wired to the clinic endpoints", async () => {
    const js = (await get("/clinic.js")).body;
    for (const path of ["/api/claims/demo", "/api/claims", "/negotiate", "/negotiate/stop"]) {
      expect(js, path).toContain(path);
    }
    expect(js).toContain('from "./app.js"');
  });
});

describe("web: case overview dashboard", () => {
  it("serves dashboard.html with every section", async () => {
    const res = await get("/dashboard.html");
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = res.body;
    expect(html).toContain('<html lang="en">');
    for (const id of [
      "dashboard-app", "error", "case-picker", "case-list", "case-view", "preview-banner", "case-head",
      "case-provider", "case-status", "stepper", "stats", "findings", "options", "room-card", "ticker", "tk-asked",
      "tk-current", "tk-saved", "limit-guard", "transcript", "run-card", "run-steps", "activity", "receipts",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    expect(html).toContain('src="/dashboard.js"');
    expect(html).toContain('href="/styles.css"');
    expect(html).toContain('href="/clinic.html"'); // appeals live in clinic mode, not duplicated
  });

  it("serves dashboard.js reading real case data, with no hard-coded demo numbers", async () => {
    const js = (await get("/dashboard.js")).body;
    expect(js).toContain('from "./app.js"');
    for (const path of ["/api/cases", "/run"]) expect(js, path).toContain(path);
    for (const fn of ["connectCase(", "mergeEvent(", "receiptItem"]) expect(js, fn).toContain(fn);
    for (const field of ["totalCharges", "amountAtStake", "maxPay", "agreedAmount", "charity", "financing"]) expect(js, field).toContain(field);
    // the PR #7 prototype's mock values must not ship
    for (const mock of ["14296", "14,296", "2230", "BB-1042", "Stanford"]) expect(js, mock).not.toContain(mock);
    // the simulated $0 confirmation keeps its label
    expect(js).toContain("simulatedTag");
  });

  it("is linked from the patient and clinic pages, and every dashboard string has English copy", async () => {
    expect((await get("/")).body).toContain('href="/dashboard.html"');
    expect((await get("/clinic.html")).body).toContain('href="/dashboard.html"');
    const g = globalThis as Record<string, unknown>;
    g.location ??= { pathname: "/", href: "http://localhost:8787/", protocol: "http:", host: "localhost:8787", hash: "" };
    g.document ??= { body: undefined, getElementById: () => null, querySelectorAll: () => [] };
    const { I18N } = (await import(/* @vite-ignore */ new URL("../../web/app.js", import.meta.url).href)) as Record<string, any>;
    const dashKeys = Object.keys(I18N.en).filter((k) => /^(dash|stat|guard|opt|caseStatus|caseSteps|flagKinds|runStatus|runSteps|simulatedTag|flaggedNote|limitGuard)/.test(k));
    expect(dashKeys.length).toBeGreaterThan(20);
    for (const k of dashKeys) expect(I18N.en[k], k).toBeTruthy();
  });
});

describe("web: English-only UI and the shared masthead", () => {
  const PAGES = ["/", "/clinic.html", "/dashboard.html", "/hospital.html", "/fund.html", "/verify.html"];

  it("ships no Chinese text, no language toggle and no i18n attributes in any page, script or stylesheet", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const webDir = new URL("../../web/", import.meta.url);
    for (const f of readdirSync(webDir).filter((f) => /\.(html|js|css)$/.test(f))) {
      const src = readFileSync(new URL(f, webDir), "utf8");
      expect(src, f).not.toMatch(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/);
      expect(src, f).not.toContain("lang-toggle");
      expect(src, f).not.toContain("data-i18n");
      expect(src, f).not.toMatch(/setupLangToggle|onLangChange|getLang|I18N\.zh/);
    }
    const g = globalThis as Record<string, unknown>;
    g.location ??= { pathname: "/", href: "http://localhost:8787/", protocol: "http:", host: "localhost:8787", hash: "" };
    g.document ??= { body: undefined, getElementById: () => null, querySelectorAll: () => [] };
    const { I18N, t } = (await import(/* @vite-ignore */ new URL("../../web/app.js", import.meta.url).href)) as Record<string, any>;
    expect(Object.keys(I18N)).toEqual(["en"]);
    expect(t("stepOf", 2, 6, "Your bill")).toBe("Step 2 of 6: Your bill");
    expect(t("no-such-key")).toBe("no-such-key");
  });

  it("every page carries the same plain masthead: wordmark and a six-link nav marking the current page", async () => {
    for (const page of PAGES) {
      const html = (await get(page)).body;
      expect(html, page).toContain('<html lang="en">');
      expect(html, page).toContain('<header class="masthead">');
      expect(html, page).toContain('<span class="wordmark">Vellum</span>');
      // Inter from Google Fonts, pinned to the css2 URL (system-ui fallback in styles.css); no decorative seal
      expect(html, page).toContain('href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap"');
      expect(html, page).not.toContain("seal-mark");
      for (const href of ['href="/"', 'href="/clinic.html"', 'href="/dashboard.html"', 'href="/hospital.html"', 'href="/fund.html"', 'href="/verify.html"']) {
        expect(html, `${page} ${href}`).toContain(href);
      }
      expect(html.match(/aria-current="page"/g) ?? [], page).toHaveLength(1);
      expect(html, page).toContain('id="dash-link"');
      expect(html, page).toContain('id="patient-link"');
    }
  });

  it("every page explains itself first: what it does, and which sponsors it uses", async () => {
    // the demo page ("/") keeps text minimal: its landing lists the sponsors once ("Built with")
    expect((await get("/")).body).toContain("Built with");
    for (const page of PAGES.filter((p) => p !== "/" && p !== "/index.html")) {
      const html = (await get(page)).body;
      const about = html.indexOf('class="about"');
      expect(about, page).toBeGreaterThan(-1);
      expect(html, page).toContain("<b>What this page does:</b>");
      expect(html, page).toContain("<b>Sponsors used here:</b>");
      // the explanation comes before the page's own content
      expect(about, page).toBeLessThan(html.indexOf("<main"));
    }
    // honest about what is not live yet
    expect((await get("/verify.html")).body).toMatch(/not deployed yet/);
    expect((await get("/")).body).toMatch(/not deployed yet/);
  });

  it("styles.css is plain: Inter over system-ui, no stamps, hard shadows or condensed display type", async () => {
    const css = (await get("/styles.css")).body;
    expect(css).toMatch(/--sans: "Inter", system-ui/);
    expect(css).not.toMatch(/text-transform: uppercase/);
    expect(css).not.toMatch(/font-weight: (?:[7-9]00|bold)/);
    expect(css).not.toMatch(/font-stretch/);
    expect(css).not.toMatch(/box-shadow: \d+px \d+px 0/); // hard offset shadows
    expect(css).not.toMatch(/rotate\(-?(?!360)\d+deg\)/); // tilted stamps (the spinner turns 360)
    expect(css).not.toMatch(/Archivo|Source Serif|IBM Plex/);
  });
});

describe("web: shared helpers (pure logic, no DOM)", () => {
  it("app.js exports parse cleanly as an ES module", async () => {
    const js = (await get("/app.js")).body;
    // the module only auto-runs the patient flow when #patient-app exists
    expect(js).toContain('document.getElementById("patient-app")');
    expect(js).toMatch(/export function mergeEvent/);
    expect(js).toMatch(/export function createAudio/);
  });
});

describe("web: app.js logic in node (DOM stubbed)", () => {
  async function load() {
    const g = globalThis as Record<string, unknown>;
    g.location ??= { pathname: "/", href: "http://localhost:8787/", protocol: "http:", host: "localhost:8787", hash: "" };
    g.document ??= { body: undefined, getElementById: () => null, querySelectorAll: () => [] };
    const url = new URL("../../web/app.js", import.meta.url).href;
    return (await import(/* @vite-ignore */ url)) as Record<string, any>;
  }

  it("maps the server's conversation init onto @elevenlabs/client session options", async () => {
    const { initToSessionOptions } = await load();
    const opts = initToSessionOptions(
      {
        type: "conversation_initiation_client_data",
        conversation_config_override: { agent: { prompt: { prompt: "P" }, first_message: "你好", language: "zh" },
          tts: { voice_id: "bella", model_id: "eleven_v4_turbo", stability: 0.5, speed: 1 } },
        custom_llm_extra_body: { browser_case_id: "c1" },
        dynamic_variables: { case_id: "c1" },
      },
      "c1",
    );
    expect(opts).toEqual({
      dynamicVariables: { case_id: "c1" },
      customLlmExtraBody: { browser_case_id: "c1" },
      overrides: { agent: { prompt: { prompt: "P" }, firstMessage: "你好", language: "zh" }, tts: { voiceId: "bella", stability: 0.5, speed: 1 } },
    });
    expect(initToSessionOptions(undefined, "c2")).toEqual({ dynamicVariables: { case_id: "c2" } });
  });

  it("has an English label for every receipt kind the server emits", async () => {
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const srcDir = fileURLToPath(new URL("../src/", import.meta.url)); // not .pathname: that yields /C:/... on Windows
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? (f !== "dev" && walk(join(d, f))) : f.endsWith(".ts") && files.push(join(d, f))));
    walk(srcDir);
    const kinds = new Set<string>();
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/receiptFor\([^,]+,\s*"([\w-]+)"/g)) kinds.add(m[1]); // XRPL
      for (const m of src.matchAll(/TransactionType:\s*"(\w+)"/g)) kinds.add(m[1]); // XRPL receipts keyed by tx type
      for (const m of src.matchAll(/\breceipt\("([\w-]+)"/g)) kinds.add(m[1]); // BNB
      for (const m of src.matchAll(/kind:\s*"([\w-]+)"[^\n]*\n?[^\n]*(?:txHash|explorerUrl)/g)) kinds.add(m[1]); // inline Receipt objects
    }
    for (const k of ["x402-payment", "prediction-hedge-order", "openMandate", "recordDeal", "logEntry", "EscrowCreate", "Batch"]) expect(kinds, `scanner should find ${k}`).toContain(k);
    const { I18N } = await load();
    const missing = [...kinds].filter((k) => !I18N.en.kinds[k]);
    expect(missing, "add these to I18N.en.kinds in web/app.js").toEqual([]);
  });

  it("merges CaseEvents without duplicating lines, offers or receipts", async () => {
    const { mergeEvent } = await load();
    const p: any = { status: "researched", transcript: [], offers: [], receipts: [] };
    const line = { role: "hospital", text: "We can do $9,000.", at: "t1" };
    mergeEvent(p, { type: "transcript", line });
    mergeEvent(p, { type: "transcript", line: { ...line, textZh: "我们可以给 9000 美元。" } });
    expect(p.transcript).toHaveLength(1);
    expect(p.transcript[0].textZh).toBe("我们可以给 9000 美元。");
    const offer = { by: "hospital", amount: 9000, at: "t1" };
    mergeEvent(p, { type: "offer", offer });
    mergeEvent(p, { type: "offer", offer });
    expect(p.offers).toHaveLength(1);
    const r = { chain: "xrpl", kind: "EscrowCreate", txHash: "ABC", explorerUrl: "https://devnet.xrpl.org/transactions/ABC", at: "t2" };
    mergeEvent(p, { type: "receipt", receipt: r });
    mergeEvent(p, { type: "receipt", receipt: r });
    expect(p.receipts).toHaveLength(1);
    mergeEvent(p, { type: "deal", amount: 2100 });
    mergeEvent(p, { type: "status", status: "agreed" });
    expect(p.agreedAmount).toBe(2100);
    expect(p.status).toBe("agreed");
    expect(mergeEvent(p, { type: "log", message: "x" })).toBe(false);
  });

  it("forwards client tool calls to /api/eleven/tools/:name with case_id", async () => {
    const { forwardTools } = await load();
    const calls: { url: string; body: any }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, message: "Intake saved." }), { status: 200 });
    }) as typeof fetch;
    try {
      const tools = forwardTools(["submit_intake"], "case-9");
      const out = await tools.submit_intake({ name: "林美", max_pay: 2500, consent: true });
      expect(out).toBe("Intake saved.");
      expect(calls).toEqual([{ url: "/api/eleven/tools/submit_intake", body: { name: "林美", max_pay: 2500, consent: true, case_id: "case-9" } }]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("api() surfaces the server's {error} message and status", async () => {
    const { api } = await load();
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "ELEVENLABS_API_KEY is not configured — set it" }), { status: 503 })) as typeof fetch;
    try {
      await expect(api("/api/intake/signed-url")).rejects.toMatchObject({ status: 503, message: expect.stringContaining("not configured") });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
