require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const nodemailer = require('nodemailer');
const { SYSTEM_PROMPT } = require('./prompt');

const app = express();
const PORT = process.env.PORT || 3000;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Forces a guaranteed-valid structured response via tool use, instead of asking the
// model to hand-write JSON as text. Removes an entire class of bug: any free-text
// answer content (a client name with an apostrophe, a quote mark, anything) used to be
// able to break naive string escaping and corrupt the whole response — the API now
// enforces this schema itself, so that's no longer possible regardless of what's in the
// account data or what the user asks.
const SCOUT_ANSWER_TOOL = {
  name: 'scout_answer',
  description: "Return Scout's structured, tiered answer to the user's tax question.",
  input_schema: {
    type: 'object',
    properties: {
      tier: {
        type: 'string',
        enum: ['GREEN', 'YELLOW', 'RED', 'REFUSE'],
        description: 'The confidence/trust tier for this answer.',
      },
      tierLabel: {
        type: 'string',
        description: "Short human label, e.g. 'High confidence', 'Situation-dependent', 'Route to Expert', 'Refused'.",
      },
      deductibility: {
        type: 'string',
        enum: ['Yes', 'Partial', 'No', 'Uncertain', ''],
        description: 'Deductibility verdict, or empty string if not applicable (e.g. REFUSE).',
      },
      lawSource: {
        type: 'string',
        description: "e.g. '§4 Abs. 5 EStG'. Empty string if REFUSE.",
      },
      answer: {
        type: 'string',
        description: 'The deductibility answer in plain language, 1-3 sentences.',
      },
      document: {
        type: 'string',
        description: 'Practical next step / what to document, 1-2 sentences. Empty string if REFUSE.',
      },
      expertServiceNote: {
        type: 'string',
        description: 'Only populated for RED tier — short note on why this needs a professional. Empty string otherwise.',
      },
    },
    required: ['tier', 'tierLabel', 'answer', 'deductibility', 'lawSource', 'document', 'expertServiceNote'],
  },
};

const MAX_INPUT_CHARS = 600;
const RATE_LIMIT = 20;
const RATE_WINDOW = 60 * 60 * 1000;

const rateLimiter = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimiter.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateLimiter.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

// Attacks on Scout's own implementation — never legitimate tax questions, so these are
// blocked before spending an API call. Tax-evasion framing is handled separately below:
// it still needs to reach the model so the REFUSE tier fires and the UI shows it properly.
const PROMPT_INJECTION_PATTERNS = [
  /ignore (all |previous |your |all previous )?(instructions|prompt|rules)/i,
  /forget (everything|your instructions|what you were told)/i,
  /you are now/i,
  /pretend (you are|to be)(?!.*steuerberater)/i,
  /act as (a |an )?(?!.*steuerberater)/i,
  /roleplay as/i,
  /new (persona|personality|role|instructions)/i,
  /system prompt/i,
  /reveal your (instructions|prompt)/i,
  /jailbreak/i,
  /do anything now/i,
  /\[?DAN\]?/i,
];

// Tax-evasion intent — detected and alerted on for visibility, but deliberately NOT
// blocked here. Scout's system prompt is designed to catch these itself and return a
// proper REFUSE-tier response; short-circuiting with a raw HTTP error would skip that.
const EVASION_PATTERNS = [
  /don'?t declare/i,
  /not declare/i,
  /avoid (the )?(finanzamt|tax office)/i,
  /hide (this |the |my )?(income|payment|money)/i,
  /off the books/i,
  /cash in hand/i,
  /under the table/i,
  /not report (this |the )?(income|payment)/i,
];

function isPromptInjection(text) {
  return PROMPT_INJECTION_PATTERNS.some((p) => p.test(text));
}

function isEvasionAttempt(text) {
  return EVASION_PATTERNS.some((p) => p.test(text));
}

// account data and profile are client-supplied in this demo (no real auth/backend), so
// they get the same injection screen as the free-text question before reaching Claude —
// in production these would come server-side from an authenticated session instead.
function containsInjection(value) {
  if (typeof value === 'string') return isPromptInjection(value);
  if (Array.isArray(value)) return value.some(containsInjection);
  if (value && typeof value === 'object') return Object.values(value).some(containsInjection);
  return false;
}

const alertThrottle = new Map();

// Explicit timeouts matter here: some hosts restrict/slow-walk outbound SMTP, and
// nodemailer has no timeout by default — without one, a stalled connection hangs the
// request indefinitely instead of failing with a clear error.
const mailer = process.env.ALERT_EMAIL_FROM
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.ALERT_EMAIL_FROM, pass: process.env.ALERT_EMAIL_PASSWORD },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    })
  : null;

function sendAlert(type, ip, message) {
  if (!mailer) {
    console.log(`[Alert] ${type} detected from ${ip}, mailer not configured — set ALERT_EMAIL_FROM in .env to enable email alerts`);
    return;
  }
  const key = `${ip}:${type}`;
  const now = Date.now();
  if (alertThrottle.has(key) && now - alertThrottle.get(key) < 60 * 60 * 1000) return;
  alertThrottle.set(key, now);

  mailer.sendMail({
    from: process.env.ALERT_EMAIL_FROM,
    to: process.env.ALERT_EMAIL_TO,
    subject: `Scout alert: ${type} attempt`,
    text: `Type: ${type}\nIP: ${ip}\nMessage: "${message}"\nTime: ${new Date().toISOString()}`,
  }).then(() => console.log('[Alert] Email sent successfully'))
    .catch((err) => console.error('[Alert] Email failed:', err.message));
}

function formatAccountData(accountData) {
  if (!accountData || typeof accountData !== 'object') return null;
  const lines = [];

  if (accountData.vatStatus) lines.push(`VAT status: ${accountData.vatStatus}`);
  if (typeof accountData.revenueLastYear === 'number') lines.push(`Revenue last year: €${accountData.revenueLastYear.toLocaleString('de-DE')}`);
  if (typeof accountData.revenueYTD === 'number') lines.push(`Revenue year-to-date: €${accountData.revenueYTD.toLocaleString('de-DE')}`);
  if (typeof accountData.homeOfficeDaysThisYear === 'number') lines.push(`Home office days logged this year: ${accountData.homeOfficeDaysThisYear}`);
  if (typeof accountData.lastYearDeductionsClaimed?.homeOffice === 'number') {
    lines.push(`Home office deduction claimed last year: €${accountData.lastYearDeductionsClaimed.homeOffice}`);
  }

  if (Array.isArray(accountData.expenseInvoices) && accountData.expenseInvoices.length) {
    lines.push('Recent expense invoices:');
    for (const inv of accountData.expenseInvoices) {
      lines.push(`  - ${inv.vendor} — €${inv.amount} — ${inv.category} — ${inv.date}`);
    }
  }

  if (Array.isArray(accountData.clientInvoices) && accountData.clientInvoices.length) {
    lines.push('Recent invoices issued to clients:');
    for (const inv of accountData.clientInvoices) {
      lines.push(`  - ${inv.client} — €${inv.amount} — client location: ${inv.clientLocation} — VAT charged: ${inv.vatCharged ? 'yes' : 'no'} — ${inv.date}`);
    }
  }

  return lines.length ? lines.join('\n') : null;
}

app.use(express.json());
app.use(express.static('public'));

app.post('/api/ask', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { profile, accountData, question } = req.body;

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  if (question.length > MAX_INPUT_CHARS) {
    return res.status(400).json({ error: `Question too long. Please keep it under ${MAX_INPUT_CHARS} characters.` });
  }

  if (isPromptInjection(question)) {
    sendAlert('prompt-injection', ip, question);
    return res.status(400).json({ error: "I'm Scout, a tax information assistant. I can only help with questions about your German freelance taxes." });
  }

  if (containsInjection(profile) || containsInjection(accountData)) {
    sendAlert('prompt-injection-account-data', ip, JSON.stringify({ profile, accountData }));
    return res.status(400).json({ error: "Something in your account data couldn't be processed safely. Please try again." });
  }

  if (isEvasionAttempt(question)) {
    sendAlert('evasion-attempt', ip, question);
    // Deliberately not blocked — forwarded to Scout so it returns a proper REFUSE tier.
  }

  const profileLine = profile
    ? `User profile: ${profile.jobType || 'Freelancer'}, ${profile.location || 'Germany'}, self-employed since ${profile.since || 'unknown'}.`
    : 'User profile: Freelancer, Germany.';

  const accountDataBlock = formatAccountData(accountData);
  const accountDataSection = accountDataBlock ? `\n\nAccount data:\n${accountDataBlock}` : '';

  const MAX_ATTEMPTS = 3;
  let lastErr;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [SCOUT_ANSWER_TOOL],
        tool_choice: { type: 'tool', name: 'scout_answer' },
        messages: [
          {
            role: 'user',
            content: `${profileLine}${accountDataSection}\n\nQuestion: ${question}`,
          },
        ],
      });

      const toolUse = message.content.find((block) => block.type === 'tool_use' && block.name === 'scout_answer');
      if (!toolUse) {
        throw new Error('No scout_answer tool call in response');
      }

      const input = toolUse.input;
      const parsed = {
        tier: input.tier,
        tierLabel: input.tierLabel,
        deductibility: input.deductibility || null,
        lawSource: input.lawSource || null,
        answer: input.answer,
        document: input.document || null,
        expertServiceNote: input.expertServiceNote || null,
      };

      return res.json(parsed);
    } catch (err) {
      lastErr = err;
      console.error(`Scout error (attempt ${attempt}/${MAX_ATTEMPTS}):`, err.message);
    }
  }

  console.error('Scout error: exhausted all attempts, last failure:', lastErr?.message);
  res.status(500).json({ error: 'Scout could not process that question. Please try again.' });
});

app.post('/api/forward-to-expert', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const { profile, accountData, question, scoutAnswer } = req.body;

  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  if (!question || typeof question !== 'string' || !question.trim()) {
    return res.status(400).json({ error: 'A question is required.' });
  }

  if (!mailer || !process.env.EXPERT_SERVICE_EMAIL_TO) {
    return res.status(503).json({ error: 'Expert Service forwarding is not configured yet.' });
  }

  if (containsInjection(profile) || containsInjection(accountData)) {
    sendAlert('prompt-injection-account-data', ip, JSON.stringify({ profile, accountData }));
    return res.status(400).json({ error: "Something in your account data couldn't be processed safely. Please try again." });
  }

  const profileLine = profile
    ? `${profile.jobType || 'Freelancer'}, ${profile.location || 'Germany'}, self-employed since ${profile.since || 'unknown'}`
    : 'Freelancer, Germany';

  const accountDataBlock = formatAccountData(accountData) || 'No account data provided.';

  try {
    await mailer.sendMail({
      from: process.env.ALERT_EMAIL_FROM,
      to: process.env.EXPERT_SERVICE_EMAIL_TO,
      subject: `Scout Expert Service request: "${question.slice(0, 60)}"`,
      text: [
        'A user asked Scout a question that Scout routed to Expert Service (RED tier).',
        '',
        `Profile: ${profileLine}`,
        '',
        `Question: ${question}`,
        '',
        `Scout's answer: ${scoutAnswer?.answer || 'n/a'}`,
        '',
        `Why Expert Service: ${scoutAnswer?.expertServiceNote || 'n/a'}`,
        '',
        `Account data:\n${accountDataBlock}`,
        '',
        `Requester IP: ${ip}`,
        `Time: ${new Date().toISOString()}`,
      ].join('\n'),
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Expert forward error:', err);
    res.status(500).json({ error: 'Could not forward to Expert Service. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`Scout is running at http://localhost:${PORT}`);
});
