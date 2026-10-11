**Stream:** A (voice) / B (rails) / C (research) / D (product). Delete the ones that don't apply.

**What changed and how you verified it** (paste the `live:*` output or a tx/explorer link if it touched a live API):

-

**Checklist**
- [ ] Only touched my stream's files (CI `ownership` checks this; shared-file changes go through D)
- [ ] `npm test` and `npx tsc --noEmit` pass locally
- [ ] No keys, private keys, or `.env` in the diff (the repo is public)
- [ ] New env var? Listed here so D adds it to `.env.example`:
- [ ] New npm package? Don't add it here. Ask D.
