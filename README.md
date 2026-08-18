# Scout

A proactive deduction discovery assistant for self-employed Taxfix users — built for the
Taxfix "AI First Builder" case study.

Not a Q&A chatbot. Self-employed people don't miss deductions because they can't get
answers — they miss them because they don't know the question exists. Scout surfaces
what you're missing before you ask, and answers what you do ask with a calibrated
confidence tier and a legal citation, grounded in your actual account data.

- **Live demo:** https://scout-demo-production-939a.up.railway.app
- **Presentation:** https://drive.google.com/file/d/135FvVlzjX3RRcllCIUT__sfXt6TcJPyM/view?usp=sharing

---

## What it does

- **Reactive Q&A** — ask a tax question, get an answer classified into one of four
  trust tiers (GREEN / YELLOW / RED / REFUSE), each with a German law citation and a
  practical next step.
- **Proactive insights** — before you ask anything, Scout surfaces deductions it
  already noticed from your account data (home office days logged, a software
  subscription renewal, an equipment-purchase timing tip).
- **Account-data-aware reasoning** — answers are grounded in real account data (VAT
  status, revenue, invoices) where available, and explicitly hedge or route to a human
  expert when the data doesn't resolve the question or the situation is structurally
  too complex (e.g. cross-border VAT).
- **A real Expert Service handoff** — RED-tier answers include a working "Forward to
  Expert Service" button that sends an actual email, not just descriptive text.

## Tech stack

Node.js + Express + the Anthropic Claude API (tool-use for guaranteed-valid structured
output), vanilla HTML/CSS/JS on the frontend, nodemailer for email. No database —
stateless by design; account data is a client-side stand-in for what would come from an
authenticated Taxfix session in production.

## Project structure

```
scout-demo/
├── server.js       ← Express server, Claude API calls, security/rate-limit guards
├── prompt.js        ← System prompt + knowledge base (trust tiers, deductions, VAT)
├── public/
│   ├── index.html    ← UI
│   ├── app.js         ← frontend logic + the fake account-data object
│   └── style.css      ← Taxfix-branded styles
├── CLAUDE.md          ← original project spec
├── build-log.md               ← technical changelog (see below)
└── taxfix-scout-prompts.md    ← build narrative (see below)
```

## Documentation — two different docs, on purpose

There are two write-ups of how this was built, and they're deliberately different, not
duplicates:

- **[`build-log.md`](./build-log.md)** — a chronological technical changelog (v1
  through v5). Each entry has a trigger (what prompted the change), what actually
  changed in the code, and why — including a real security bug found and fixed, not
  just features added. This is the reference for "walk me through exactly what you
  built and when."

- **[`taxfix-scout-prompts.md`](./taxfix-scout-prompts.md)** — a first-person narrative
  of the build process: research into Taxfix's existing product, grounding the problem
  in personal experience, designing the trust model from the legal constraint first,
  stress-testing the prompt against jailbreaks, and the reasoning behind choosing
  Claude (and Sonnet specifically) over other models. This is the reference for "why
  did you build it this way."

Both exist because the case study explicitly asks candidates to keep their prompts and
workflow available to walk through — one covers the *what changed*, the other covers
the *why this approach*.

## The trust model

| Tier | When | Scout does |
|------|------|-----------|
| GREEN | Clear rule, universally applicable | Answers directly, cites the law |
| YELLOW | Rule exists, situation-dependent | Answers with an explicit hedge naming what it depends on |
| RED | Complex, high-stakes, or structurally outside scope | Routes to Expert Service instead of guessing |
| REFUSE | Tax evasion, requests for guaranteed outcomes | Hard stop, no exceptions |

Scout gives tax **information**, not tax **advice** — a hard legal boundary under the
Rechtsdienstleistungsgesetz (RDG). Only a licensed Steuerberater can give personalized,
binding tax advice in Germany.
