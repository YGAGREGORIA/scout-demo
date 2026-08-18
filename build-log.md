# Scout — Prompt Build Log

## Purpose of this doc

A chronological record of what changed in Scout's prompt and system, and why — for
walking the Taxfix panel through the "AI-native building" and "judgment on AI output"
criteria live, per the case study's own instruction: *"If you build with AI, keep your
prompts or workflow so you can walk us through it."*

Full working code: `prompt.js`, `server.js`, `public/` (this repo).

---

## v1 — Initial system prompt (from the original spec)

Built from CLAUDE.md's brief before I had the actual case study document: trust tiers
(Green/Yellow/Red/Refuse), a knowledge base of the top 10 freelancer deductions, the RDG
legal boundary (information, not advice), and jailbreak-handling instructions.

---

## v2 — Read the real case study brief → added VAT + an explicit out-of-scope list

**Trigger:** got the actual case study PDF. Its own scenario names three example
questions verbatim: *"Can I deduct my home office?", "Does this client dinner count?",
"Do I owe VAT on this?"* — the first two were covered, VAT had zero knowledge-base
coverage. If an interviewer tried their own brief's example question, Scout had nothing
to answer from.

**Changed:**
- Added knowledge-base item #11: VAT / Kleinunternehmerregelung (§19 UStG), with tier
  guidance splitting a simple domestic threshold check (YELLOW) from anything
  cross-border or invoice-specific (RED).
- Added a `# WHAT SCOUT DELIBERATELY DOES NOT DO` section — an explicit out-of-scope list
  (cross-border income, business-structure decisions, audits in progress, amending filed
  returns, any numeric threshold Scout isn't confident is current) that overrides tier
  logic and forces RED regardless of how confident the model feels about the general area.
- Added a calibration rule: *"when in doubt between two tiers, pick the more cautious
  one."*

**Why:** the grading rubric explicitly asks for "a confidence threshold below which the
assistant declines" and to "name a question it should refuse to answer." This made both
concrete and testable instead of implicit in the tier table.

---

## v3 — Account-data-aware reasoning

**Trigger:** Scout's own differentiator (per the deck: "lives inside the VAT product,"
"previous years' data — yes" vs. competitors' "no") was claimed but not demonstrable —
the running demo had no actual data to reason from, so the VAT question always fell back
to a generic hedge regardless of the user's real situation.

**Changed:**
- Added a `# ACCOUNT DATA` section instructing the model to check profile + account data
  (VAT status, revenue YTD/last year, home office days logged, recent invoices) FIRST,
  before falling back to general knowledge-base rules.
- Two hard guardrails written into that section:
  1. Never invent a number that isn't in the provided account data.
  2. Account data narrows uncertainty, it doesn't eliminate the trust tiers — a
     cross-border invoice is still RED even with precise revenue figures known, because
     the complexity is structural, not a missing-data problem.
- Updated the home office and VAT knowledge-base entries specifically to use account
  data directly (e.g. calculate `days × €6` instead of just describing the flat-rate rule
  abstractly).

**Verified live:** a domestic VAT question resolved to GREEN with a real 19% calculation
on a specific invoice amount. The same question about a cross-border (EU) client still
resolved to RED, despite the model having precise revenue and VAT-status data — proof the
calibration guardrail actually holds under pressure, not just in the easy case.

**What I trusted:** the account-data-first ordering — matches what a real user expects
from a personalized assistant rather than a generic FAQ bot.

**What I caught and turned into a feature, not a bug:** the demo's own VAT chip
("Do I owe VAT on this?") is genuinely ambiguous once the fake account has two client
invoices — there's no conversation history and no invoice-selection UI, so "this" doesn't
resolve to anything specific. Scout's actual behavior: it recognized the ambiguity,
declined to guess which invoice, and asked for clarification rather than picking one
arbitrarily. I kept this as a deliberate demo beat for "judgment on AI output" instead of
quietly fixing it, because a model that admits it doesn't know which invoice you mean is
a *better* answer than one that guesses.

**What I rejected:** considered having the app auto-select the "most recent" invoice when
a question was ambiguous. Rejected it — that would be silently guessing at user intent,
exactly the kind of overconfident behavior the trust model exists to prevent.

---

## v4 — Security hardening for a stateless, no-auth demo

**Trigger:** adapted patterns from an earlier Claude API project I built (Spark, my
portfolio assistant, live at ygagregoria.com) — asked to be "inspired by" its
`server.js`, then deliberately adapted rather than copied, since Spark hard-blocks
jailbreaks before the model ever sees them, but Scout's actual product value is that the
*model itself* handles certain jailbreaks gracefully (the REFUSE-tier badge is one of the
three scripted demo moments).

**Changed:**
- Rate limiting: sliding window, 20 requests/hour per IP.
- Prompt-injection detection: a pattern list blocks attacks on Scout's own implementation
  ("ignore your instructions," "reveal your system prompt," DAN-style jailbreaks) before
  an API call is made — with one deliberate exception: phrasing containing
  "Steuerberater" is let through, so Claude's own in-persona hard-redirect (named in the
  original "Jailbreaks to handle" list) fires instead of a generic blocked-request error.
- Tax-evasion phrasing ("don't declare," "off the books," "cash in hand") is detected and
  *alerted on but not blocked* — deliberately forwarded to Scout so it returns a proper
  REFUSE-tier JSON response (the demo's third scripted beat), rather than short-circuiting
  with a raw HTTP error that would skip the UI's Refuse badge entirely.

**Gap found and fixed (a real one, not staged):** the injection filter above only checked
the free-text question field. `profile` and `accountData` are plain client-side JS
objects in this demo (no real auth/backend), so someone could bypass the filter entirely
by editing the account data in browser dev tools instead of typing an attack into the
question box — a side door around a front-door guard. Added `containsInjection()`, which
recursively walks every string value in both `profile` and `accountData` through the same
pattern check the question already got, before either reaches Claude. This matters more
once deployed publicly: the real attack surface becomes the `/api/ask` endpoint itself,
callable directly with any payload regardless of what the shipped frontend object
contains.

---

## v5 — RED tier → a real Expert Service handoff

**Trigger:** RED-tier answers said "route to Expert Service" but had no action behind the
words — descriptive, not functional. The case study explicitly asks for "when it hands
off to a human expert," so I made the handoff real.

**Changed:** added a "Forward to Expert Service" button on RED answers. Clicking it POSTs
to a new `/api/forward-to-expert` endpoint that sends an actual email (via nodemailer)
containing the question, Scout's reasoning, and the account data behind it.

**Correction made along the way:** the first version reused the same inbox as misuse
alerts (`ALERT_EMAIL_TO`). Caught this was wrong before shipping it — conflating "someone
jailbreaking Scout" with "a legitimate customer with a genuinely complex question" is the
wrong product decision, not just a naming nitpick. Split into a separate
`EXPERT_SERVICE_EMAIL_TO` env var so the two flows can never land in the same place.

---

## Rubric mapping (for quick reference in the room)

| Rubric criterion | Where it shows up |
|---|---|
| Judgment on AI output | v2 calibration rule + named refusal; v3 cross-border override holding even with precise data |
| Structuring ambiguity | v3 — the VAT chip's ambiguity, and choosing not to auto-guess an invoice |
| Engineering fluency | v4 — can explain a real security gap I found and closed, not just features I added |
| Design taste | v5 — separate inboxes for misuse vs. legitimate escalation |
| Bias to action | Built incrementally, verified each change live (curl + browser) before moving to the next, across the prep window |
| AI-native building | This whole doc — every change has a trigger, a diff, and a reason |
