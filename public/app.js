const form = document.getElementById('ask-form');
const questionInput = document.getElementById('question');
const submitBtn = document.getElementById('submit-btn');
const chips = document.getElementById('chips');
const insightsSection = document.getElementById('insights-section');
const resultSection = document.getElementById('result-section');
const resultCard = document.getElementById('result-card');

const PROFILE = {
  jobType: 'Freelance web developer',
  location: 'Berlin, Germany',
  since: '2017',
};

// Fake account data standing in for what Scout would pull from a real Taxfix
// VAT-product account — revenue, VAT status, logged days, and recent invoices.
const ACCOUNT_DATA = {
  vatStatus: 'Regelbesteuerung — registered for standard VAT, not Kleinunternehmer',
  revenueLastYear: 58200,
  revenueYTD: 41750,
  homeOfficeDaysThisYear: 142,
  lastYearDeductionsClaimed: {
    homeOffice: 714,
  },
  // Expenses she paid — relevant to deduction questions (Figma, MacBook, etc.).
  expenseInvoices: [
    { vendor: 'Figma', category: 'Software subscription', amount: 15, date: '2026-08-01' },
    { vendor: 'Adobe Creative Cloud', category: 'Software subscription', amount: 60.99, date: '2026-08-05' },
    { vendor: 'Apple Store — MacBook Pro 14"', category: 'Hardware', amount: 2399, date: '2026-06-12' },
    { vendor: 'Udemy — Advanced React course', category: 'Professional development', amount: 19.99, date: '2026-05-20' },
    { vendor: 'Restaurant Zur Letzten Instanz', category: 'Client meal', amount: 80, date: '2026-07-22' },
  ],
  // Invoices she issued to clients — relevant to "do I owe VAT on this" questions.
  clientInvoices: [
    { client: 'Local Berlin design agency', amount: 3200, date: '2026-08-10', clientLocation: 'Germany', vatCharged: true },
    { client: 'Startup GmbH, Munich', amount: 4500, date: '2026-07-15', clientLocation: 'Germany', vatCharged: true },
  ],
};

const TIER_LABELS = {
  GREEN: 'High confidence',
  YELLOW: 'Situation-dependent',
  RED: 'Route to Expert',
  REFUSE: 'Refused',
};

let currentQuestion = '';
let currentResult = null;

chips.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  questionInput.value = btn.dataset.q;
  askScout(btn.dataset.q);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = questionInput.value.trim();
  if (!q) return;
  askScout(q);
});

insightsSection.addEventListener('click', (e) => {
  const btn = e.target.closest('.insight-followup');
  if (!btn) return;
  const question = btn.closest('.insight-card').dataset.followup;
  questionInput.value = question;
  askScout(question);
});

async function askScout(question) {
  currentQuestion = question;
  submitBtn.disabled = true;
  resultSection.classList.remove('hidden');
  resultCard.innerHTML = '<div class="loading">Scout is checking §4 EStG…</div>';

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: PROFILE, accountData: ACCOUNT_DATA, question }),
    });

    const data = await res.json();

    if (!res.ok) {
      resultCard.innerHTML = `<div class="error-msg">${escapeHtml(data.error || 'Something went wrong.')}</div>`;
      return;
    }

    renderResult(data);
  } catch (err) {
    resultCard.innerHTML = `<div class="error-msg">Could not reach Scout. Check that the server is running.</div>`;
  } finally {
    submitBtn.disabled = false;
  }
}

function renderResult(data) {
  currentResult = data;
  const tier = data.tier || 'RED';
  const tierLabel = data.tierLabel || TIER_LABELS[tier] || tier;

  let rows = '';

  if (data.deductibility) {
    rows += resultRow('Deductibility', data.deductibility);
  }
  if (data.lawSource) {
    rows += resultRow('Law source', data.lawSource);
  }
  if (data.document) {
    rows += resultRow('Document', data.document);
  }
  if (data.expertServiceNote) {
    rows += resultRow('Why Expert Service', data.expertServiceNote);
  }

  const forwardBlock = tier === 'RED' ? `
    <div class="forward-expert">
      <p class="forward-expert-prompt">Do you want to forward this question to our expert?</p>
      <button type="button" class="forward-expert-btn">Forward to Expert Service</button>
    </div>
  ` : '';

  resultCard.innerHTML = `
    <div class="badge ${escapeHtml(tier)}">
      <span class="badge-dot"></span>
      ${escapeHtml(tier)} — ${escapeHtml(tierLabel)}
    </div>
    <div class="result-answer">${escapeHtml(data.answer || '')}</div>
    ${rows}
    ${forwardBlock}
  `;
}

resultCard.addEventListener('click', (e) => {
  const btn = e.target.closest('.forward-expert-btn');
  if (btn) forwardToExpert(btn);
});

async function forwardToExpert(btn) {
  btn.disabled = true;
  btn.textContent = 'Forwarding…';

  try {
    const res = await fetch('/api/forward-to-expert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: PROFILE,
        accountData: ACCOUNT_DATA,
        question: currentQuestion,
        scoutAnswer: currentResult,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = 'Forward to Expert Service';
      btn.parentElement.querySelectorAll('.forward-expert-status').forEach((el) => el.remove());
      btn.insertAdjacentHTML('afterend', `<p class="forward-expert-status forward-expert-status--error">${escapeHtml(data.error || 'Could not forward this question.')}</p>`);
      return;
    }

    btn.outerHTML = '<p class="forward-expert-status forward-expert-status--success">Sent — an expert will review this and follow up.</p>';
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Forward to Expert Service';
    btn.parentElement.querySelectorAll('.forward-expert-status').forEach((el) => el.remove());
    btn.insertAdjacentHTML('afterend', '<p class="forward-expert-status forward-expert-status--error">Could not reach Scout. Please try again.</p>');
  }
}

function resultRow(label, value) {
  return `
    <div class="result-row">
      <div class="result-row-label">${escapeHtml(label)}</div>
      <div class="result-row-value">${escapeHtml(value)}</div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatEuro(amount) {
  return `€${amount.toLocaleString('de-DE')}`;
}

function renderAccountData() {
  const statsEl = document.getElementById('account-stats');
  const invoicesEl = document.getElementById('account-invoices');
  if (!statsEl || !invoicesEl) return;

  const stats = [
    { label: 'VAT status', value: ACCOUNT_DATA.vatStatus },
    { label: 'Revenue (YTD)', value: formatEuro(ACCOUNT_DATA.revenueYTD) },
    { label: 'Revenue (last year)', value: formatEuro(ACCOUNT_DATA.revenueLastYear) },
    { label: 'Home office days logged', value: `${ACCOUNT_DATA.homeOfficeDaysThisYear} this year` },
  ];

  statsEl.innerHTML = stats.map((s) => `
    <div class="account-stat">
      <div class="account-stat-label">${escapeHtml(s.label)}</div>
      <div class="account-stat-value">${escapeHtml(s.value)}</div>
    </div>
  `).join('');

  const allInvoices = [
    ...ACCOUNT_DATA.expenseInvoices.map((inv) => ({ tag: 'Expense', vendor: inv.vendor, amount: inv.amount, date: inv.date })),
    ...ACCOUNT_DATA.clientInvoices.map((inv) => ({ tag: 'Client invoice', vendor: inv.client, amount: inv.amount, date: inv.date })),
  ].sort((a, b) => new Date(b.date) - new Date(a.date));

  invoicesEl.innerHTML = `
    <div class="account-invoices-heading">Recent activity</div>
    ${allInvoices.map((inv) => `
      <div class="account-invoice-row">
        <span class="account-invoice-tag">${escapeHtml(inv.tag)}</span>
        <span class="account-invoice-vendor">${escapeHtml(inv.vendor)}</span>
        <span class="account-invoice-amount">${escapeHtml(formatEuro(inv.amount))}</span>
        <span class="account-invoice-date">${escapeHtml(inv.date)}</span>
      </div>
    `).join('')}
  `;
}

renderAccountData();
