# BangBang Blue Healthcare Dashboard

A responsive React dashboard prototype for medical-bill review, insurance appeals, patient-controlled negotiations, and possible savings. It uses a blue visual theme and has no third-party UI dependencies.

## Files

- `BangBangDashboard.jsx` — React component
- `BangBangDashboard.css` — all dashboard styling
- `README-INTEGRATION.md` — setup and integration notes

## Quick integration

1. In your repository, locate the existing frontend app and identify its main route/page (often `src/App.jsx`, `app/page.tsx`, or a page under `src/pages/`).
2. Copy `BangBangDashboard.jsx` and `BangBangDashboard.css` into the same frontend source folder, for example:
   `src/components/BangBangDashboard.jsx` and `src/components/BangBangDashboard.css`.
3. Import and render the component from the route you want to use:

   ```jsx
   import BangBangDashboard from "./components/BangBangDashboard";

   export default function App() {
     return <BangBangDashboard />;
   }
   ```

   Adjust the import path to match where you saved the file. If your project uses a router, render it inside the appropriate route instead of replacing the whole app.
4. Start the existing frontend using the repository's current instructions (for example, `npm run dev` if it uses Vite).
5. If your existing project uses Tailwind or global CSS, the styles here are scoped under `.bb-*` class names, but the Google Fonts import requires internet access. Remove the `@import` line if you prefer local/system fonts.

## Connect it to the existing BangBang backend

The UI is intentionally a front-end prototype. Search for the `TODO` comments in `BangBangDashboard.jsx`:

- `startReview()` — connect your existing case creation / document analysis API.
- `selectFile()` — send the selected document to your existing secure upload endpoint.
- `startNegotiation()` — connect the negotiation/session API.
- The sample `initialCase` values are demo data. Replace them with your actual case data or API response.

Suggested data contract (adapt to the actual backend rather than adding a new duplicate API):

```ts
type MedicalCase = {
  id: string;
  provider: string;
  type: string;
  originalBill: number;
  potentialIssues: number;
  patientLimit: number;
  status: "needs_review" | "in_review" | "negotiating" | "resolved";
};
```

## Important

- The demo's bill amounts and flagged charges are sample values, not verified claims or guaranteed savings.
- This component does not submit real appeals, contact providers, place calls, or make payments.
- Do not send medical documents to a third-party service without appropriate authorization, privacy safeguards, and secure handling.
- Do not let an AI model autonomously accept a settlement or exceed the patient's explicitly authorized limit.
