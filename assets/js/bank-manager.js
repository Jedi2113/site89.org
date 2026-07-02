import { app, auth, onAuthStateChanged } from "/assets/js/auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  runTransaction,
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  orderBy,
  limit
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

let allCharacters = [];
let bankAccounts = new Map();
let sharedAccounts = [];
let activeCharacter = null;
let activeSharedAccount = null;
let modalDeductions = [];

const SCHEDULE_DOC_REF = doc(db, 'bank_config', 'schedule');
const EST_TIMEZONE = 'America/New_York';
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';

// ─────────────────────────────────────────────────────────
//  Utility helpers
// ─────────────────────────────────────────────────────────

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'manager') return 'manager';
  if (role === 'raisa') return 'manager';
  return 'member';
}

function isManagerOrAboveUser(user, userDoc) {
  if (!user) return false;
  if (user.email === PRIMARY_ADMIN_EMAIL) return true;
  if (userDoc?.isAdmin === true) return true;
  const role = normalizeRole(userDoc?.role);
  return role === 'manager' || role === 'admin';
}

function formatCurrency(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function safeText(value, fallback = 'N/A') {
  const text = (value || '').toString().trim();
  return text ? text : fallback;
}

function parseAmount(rawValue) {
  const cleaned = String(rawValue || '').replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getAccountBalance(account) {
  if (!account) return 0;
  const checking = Number(account.checkingBalance ?? account.balance ?? 0);
  const savings = Number(account.savingsBalance ?? 0);
  return checking + savings;
}

function getCreditBand(scoreInput) {
  const score = Number(scoreInput || 0);
  if (!score || score < 580) return 'Poor';
  if (score < 670) return 'Fair';
  if (score < 740) return 'Good';
  if (score < 800) return 'Very Good';
  return 'Excellent';
}

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map(part => [part.type, part.value]));
  return { year: Number(map.get('year') || 0), month: Number(map.get('month') || 1), day: Number(map.get('day') || 1) };
}

function getTodayEstIsoDate() {
  const nowParts = getDatePartsInTimeZone(new Date(), EST_TIMEZONE);
  const month = String(nowParts.month).padStart(2, '0');
  const day = String(nowParts.day).padStart(2, '0');
  return `${nowParts.year}-${month}-${day}`;
}

function toTimeInputValue(hour, minute) {
  const h = String(Number(hour || 0)).padStart(2, '0');
  const m = String(Number(minute || 0)).padStart(2, '0');
  return `${h}:${m}`;
}

function parseTimeInputValue(value, fallbackHour, fallbackMinute) {
  const cleaned = String(value || '').trim();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: fallbackHour, minute: fallbackMinute };
  let hour = Number(match[1]);
  let minute = Number(match[2]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) hour = fallbackHour;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) minute = fallbackMinute;
  return { hour, minute };
}

function parseIsoDateParts(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function getDateTimePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map(part => [part.type, part.value]));
  return { year: Number(map.get('year') || 0), month: Number(map.get('month') || 1), day: Number(map.get('day') || 1), hour: Number(map.get('hour') || 0), minute: Number(map.get('minute') || 0) };
}

function utcDateMsFromParts(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function addDaysToYmd(parts, days) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate() };
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function zonedLocalToUtcDate(timeZone, localYmd, hour, minute) {
  let guess = new Date(Date.UTC(localYmd.year, localYmd.month - 1, localYmd.day, hour, minute, 0, 0));
  for (let index = 0; index < 3; index += 1) {
    const actual = getDateTimePartsInTimeZone(guess, timeZone);
    const desired = Date.UTC(localYmd.year, localYmd.month - 1, localYmd.day, hour, minute, 0, 0);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const diffMs = desired - actualMs;
    if (diffMs === 0) break;
    guess = new Date(guess.getTime() + diffMs);
  }
  return guess;
}

// ─────────────────────────────────────────────────────────
//  Schedule helpers
// ─────────────────────────────────────────────────────────

function computeNextPayrollRunDate(schedule) {
  const payroll = schedule?.payroll || {};
  if (payroll.enabled === false) return null;
  const anchor = parseIsoDateParts(payroll.anchorDate);
  if (!anchor) return null;
  const hour = Number(payroll.hour);
  const minute = Number(payroll.minute);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;
  const now = new Date();
  const nowMs = now.getTime();
  const todayInEst = getDatePartsInTimeZone(now, EST_TIMEZONE);
  const anchorDateMs = utcDateMsFromParts(anchor);
  for (let dayOffset = 0; dayOffset <= 60; dayOffset += 1) {
    const candidateYmd = addDaysToYmd(todayInEst, dayOffset);
    const candidateDateMs = utcDateMsFromParts(candidateYmd);
    const diffDays = Math.floor((candidateDateMs - anchorDateMs) / (24 * 60 * 60 * 1000));
    if (diffDays < 0 || diffDays % 14 !== 0) continue;
    const candidateUtc = zonedLocalToUtcDate(EST_TIMEZONE, candidateYmd, hour, minute);
    if (candidateUtc.getTime() > nowMs) return candidateUtc;
  }
  return null;
}

function updateNextPayrollRunDisplay(schedule = null) {
  const target = document.getElementById('globalPayrollNextRun');
  if (!target) return;
  const activeSchedule = schedule || collectGlobalScheduleFromForm();
  if (activeSchedule?.payroll?.enabled === false) { target.textContent = 'Next payroll run (EST): Disabled'; return; }
  const nextRun = computeNextPayrollRunDate(activeSchedule);
  if (!nextRun) { target.textContent = 'Next payroll run (EST): Invalid schedule'; return; }
  const datePart = nextRun.toLocaleDateString('en-US', { timeZone: EST_TIMEZONE, year: 'numeric', month: 'long', day: 'numeric' });
  const timePart = nextRun.toLocaleTimeString('en-US', { timeZone: EST_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  target.textContent = `Next payroll run (EST): ${datePart} at ${timePart}`;
}

function computeNextMonthlyRunDate(schedule) {
  const monthly = schedule?.monthly || {};
  if (monthly.enabled === false) return null;
  const anchor = parseIsoDateParts(monthly.anchorDate);
  const hour = Number(monthly.hour);
  const minute = Number(monthly.minute);
  if (!anchor || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const targetDay = Math.max(1, Math.min(31, Math.trunc(anchor.day)));
  const now = new Date();
  const nowMs = now.getTime();
  const todayInEst = getDatePartsInTimeZone(now, EST_TIMEZONE);
  const anchorDateMs = utcDateMsFromParts(anchor);
  const todayDateMs = utcDateMsFromParts(todayInEst);
  if (todayDateMs < anchorDateMs) {
    const anchorUtc = zonedLocalToUtcDate(EST_TIMEZONE, anchor, hour, minute);
    if (anchorUtc.getTime() > nowMs) return anchorUtc;
  }
  for (let dayOffset = 0; dayOffset <= 62; dayOffset += 1) {
    const candidateYmd = addDaysToYmd(todayInEst, dayOffset);
    const candidateDateMs = utcDateMsFromParts(candidateYmd);
    if (candidateDateMs < anchorDateMs) continue;
    const dueDay = Math.min(targetDay, getDaysInMonth(candidateYmd.year, candidateYmd.month));
    if (candidateYmd.day !== dueDay) continue;
    const candidateUtc = zonedLocalToUtcDate(EST_TIMEZONE, candidateYmd, hour, minute);
    if (candidateUtc.getTime() > nowMs) return candidateUtc;
  }
  return null;
}

function updateNextMonthlyRunDisplay(schedule = null) {
  const target = document.getElementById('globalMonthlyNextRun');
  if (!target) return;
  const activeSchedule = schedule || collectGlobalScheduleFromForm();
  if (activeSchedule?.monthly?.enabled === false) { target.textContent = 'Next monthly deduction run (EST): Disabled'; return; }
  const nextRun = computeNextMonthlyRunDate(activeSchedule);
  if (!nextRun) { target.textContent = 'Next monthly deduction run (EST): Invalid schedule'; return; }
  const datePart = nextRun.toLocaleDateString('en-US', { timeZone: EST_TIMEZONE, year: 'numeric', month: 'long', day: 'numeric' });
  const timePart = nextRun.toLocaleTimeString('en-US', { timeZone: EST_TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true, timeZoneName: 'short' });
  target.textContent = `Next monthly deduction run (EST): ${datePart} at ${timePart}`;
}

function defaultGlobalSchedule() {
  return {
    timezone: EST_TIMEZONE,
    payroll: { enabled: true, anchorDate: getTodayEstIsoDate(), hour: 9, minute: 0 },
    monthly: { enabled: true, anchorDate: getTodayEstIsoDate(), hour: 9, minute: 0 }
  };
}

// ─────────────────────────────────────────────────────────
//  Deductions helpers
// ─────────────────────────────────────────────────────────

function normalizeDeductionType(type) {
  const normalized = String(type || '').toLowerCase().replace(/[^a-z_]/g, '_');
  const allowed = new Set(['rent', 'mortgage', 'car_payment', 'loan', 'insurance', 'utilities', 'other']);
  return allowed.has(normalized) ? normalized : 'other';
}

function toDeductionTypeLabel(type) {
  const labels = { rent: 'Rent', mortgage: 'Mortgage', car_payment: 'Car Payment', loan: 'Loan', insurance: 'Insurance', utilities: 'Utilities', other: 'Other' };
  return labels[type] || 'Other';
}

function makeDeductionId() {
  return `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeMonthlyDeductions(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item, index) => {
      const amount = Number(item?.amount || 0);
      return {
        id: String(item?.id || makeDeductionId() || `d_${index}`),
        type: normalizeDeductionType(item?.type),
        label: safeText(item?.label, ''),
        amount: Number.isFinite(amount) && amount > 0 ? amount : 0,
        enabled: item?.enabled !== false,
        lastProcessedMonthKey: safeText(item?.lastProcessedMonthKey, ''),
        lastChargedAt: item?.lastChargedAt || null
      };
    })
    .filter(item => item.amount > 0);
}

// ─────────────────────────────────────────────────────────
//  Email resolution
// ─────────────────────────────────────────────────────────

function baseLocalFromName(name) {
  if (!name) return '';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ? parts[0].toLowerCase().replace(/[^a-z]/g, '') : '';
  const last = parts.length > 1 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '') : first;
  return last && first ? `${last}.${first}` : '';
}

function makeUniqueEmail(baseLocal, counts) {
  if (!baseLocal) return '';
  const current = counts.get(baseLocal) || 0;
  const next = current + 1;
  counts.set(baseLocal, next);
  const localPart = next === 1 ? baseLocal : `${baseLocal}${next}`;
  return `${localPart}@site89.org`.toLowerCase();
}

async function resolveCharacterEmail(targetChar) {
  if (!targetChar || !targetChar.name) return '';
  if (targetChar.email) return targetChar.email.toLowerCase();
  const snap = await getDocs(collection(db, 'characters'));
  const withEmail = [];
  const withoutEmail = [];
  const targetCharId = targetChar.docId || targetChar.id || '';
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if (data && data.name) {
      const char = { docId: docSnap.id, ...data };
      if (char.email) { withEmail.push(char); } else { withoutEmail.push(char); }
    }
  });
  withoutEmail.sort((a, b) => {
    const aSec = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    const bSec = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    if (aSec !== bSec) return aSec - bSec;
    const aPid = String(a.pid || '');
    const bPid = String(b.pid || '');
    if (aPid !== bPid) return aPid.localeCompare(bPid);
    return String(a.docId || '').localeCompare(String(b.docId || ''));
  });
  const counts = new Map();
  const byPid = new Map();
  const byDocId = new Map();
  const byBase = new Map();
  withEmail.forEach(char => {
    const email = char.email.toLowerCase();
    const baseLocal = baseLocalFromName(char.name);
    if (char.pid) byPid.set(String(char.pid), email);
    if (char.docId) byDocId.set(char.docId, email);
    if (baseLocal) {
      const match = email.match(/@/);
      if (match) {
        const localPart = email.substring(0, match.index);
        const numMatch = localPart.match(/(\d+)$/);
        if (numMatch) {
          const num = parseInt(numMatch[1], 10);
          counts.set(baseLocal, Math.max(counts.get(baseLocal) || 0, num));
        } else if (localPart === baseLocal) {
          counts.set(baseLocal, Math.max(counts.get(baseLocal) || 0, 1));
        }
      }
      const list = byBase.get(baseLocal) || [];
      list.push({ email, department: char.department || '' });
      byBase.set(baseLocal, list);
    }
  });
  withoutEmail.forEach(char => {
    const baseLocal = baseLocalFromName(char.name);
    if (baseLocal) {
      const email = makeUniqueEmail(baseLocal, counts);
      if (char.pid) byPid.set(String(char.pid), email);
      if (char.docId) byDocId.set(char.docId, email);
      const list = byBase.get(baseLocal) || [];
      list.push({ email, department: char.department || '' });
      byBase.set(baseLocal, list);
    }
  });
  const baseLocal = baseLocalFromName(targetChar.name);
  const pidKey = targetChar.pid ? String(targetChar.pid) : '';
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);
  if (targetCharId && byDocId.has(targetCharId)) return byDocId.get(targetCharId);
  const bucket = byBase.get(baseLocal);
  if (bucket && bucket.length) {
    if (bucket.length === 1) return bucket[0].email;
    const dept = (targetChar.department || '').toLowerCase();
    const matchEntry = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return matchEntry ? matchEntry.email : bucket[0].email;
  }
  const snapshotCount = (counts.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

// ─────────────────────────────────────────────────────────
//  Access helpers
// ─────────────────────────────────────────────────────────

function hasBankAccess(char) {
  const dept = (char.department || '').toLowerCase();
  const rank = (char.rank || '').toLowerCase();
  const directorOf = Array.isArray(char.directorOf) ? char.directorOf.map(item => String(item).toLowerCase()) : [];
  return dept.includes('ad') || dept.includes('administrative') || dept.includes('fd') || dept.includes('field') || rank.includes('site director') || directorOf.includes('sd');
}

function isSiteDirectorEmail(user) {
  return !!user && (user.email || '').toLowerCase() === 'jedi21132@gmail.com';
}

function getAccountForPid(pid) {
  if (!pid) return null;
  return bankAccounts.get(String(pid)) || null;
}

// ─────────────────────────────────────────────────────────
//  Grid rendering — personal accounts
// ─────────────────────────────────────────────────────────

function refreshGrid() {
  const grid = document.getElementById('bankGrid');
  if (!grid) return;

  const searchValue = (document.getElementById('searchInput').value || '').toLowerCase();
  const sortValue = document.getElementById('sortSelect').value || 'name';

  let filtered = allCharacters.filter(char => {
    const name = (char.name || '').toLowerCase();
    const dept = (char.department || '').toLowerCase();
    const pid = (char.pid || '').toString().toLowerCase();
    return name.includes(searchValue) || dept.includes(searchValue) || pid.includes(searchValue);
  });

  filtered.sort((a, b) => {
    if (sortValue === 'department') return (a.department || '').localeCompare(b.department || '');
    if (sortValue === 'balance') {
      return getAccountBalance(getAccountForPid(b.pid)) - getAccountBalance(getAccountForPid(a.pid));
    }
    return (a.name || '').localeCompare(b.name || '');
  });

  grid.innerHTML = '';

  if (!filtered.length) {
    grid.innerHTML = '<div class="access-denied">No characters found.</div>';
    return;
  }

  filtered.forEach(char => {
    const card = document.createElement('div');
    card.className = 'bank-card';
    const account = getAccountForPid(char.pid);
    const checking = Number(account?.checkingBalance ?? account?.balance ?? 0);
    const savings = Number(account?.savingsBalance ?? 0);
    const creditScore = Number(account?.creditScore || 0);
    const overdueBalance = Number(account?.overdueDeductionsBalance || 0);
    const routing = account?.routingNumber ? `<p class="bank-muted" style="font-size:0.82rem;margin:0.2rem 0 0 0;">Routing: ${account.routingNumber}</p>` : '';
    const creditMeta = creditScore > 0
      ? `<p class="bank-muted" style="font-size:0.82rem;margin:0.2rem 0 0 0;">Credit: ${Math.round(creditScore)} (${getCreditBand(creditScore)})</p>`
      : '<p class="bank-muted" style="font-size:0.82rem;margin:0.2rem 0 0 0;">Credit: Not scored yet</p>';
    const overdueMeta = `<p class="bank-muted" style="font-size:0.82rem;margin:0.2rem 0 0 0;color:${overdueBalance > 0 ? '#f87171' : 'var(--muted)'};">Overdue: ${formatCurrency(overdueBalance)}</p>`;

    card.innerHTML = `
      <h3>${safeText(char.name, 'Unknown')}</h3>
      <p>PID: ${safeText(char.pid, 'Unassigned')}</p>
      <p>Dept: ${safeText(char.department)}</p>
      <p>Rank: ${safeText(char.rank)}</p>
      ${routing}
      ${creditMeta}
      ${overdueMeta}
      <div style="display:flex;gap:0.7rem;margin-top:0.6rem;">
        <div style="flex:1;background:rgba(0,217,255,0.08);border-radius:6px;padding:0.4rem 0.6rem;">
          <div class="bank-muted" style="font-size:0.78rem;">Checking</div>
          <div class="balance">${formatCurrency(checking)}</div>
        </div>
        <div style="flex:1;background:rgba(78,250,170,0.08);border-radius:6px;padding:0.4rem 0.6rem;">
          <div class="bank-muted" style="font-size:0.78rem;">Savings</div>
          <div class="balance">${formatCurrency(savings)}</div>
        </div>
      </div>`;

    if (char.pid) {
      card.addEventListener('click', () => openBankModal(char));
    } else {
      card.style.opacity = '0.6';
      card.style.cursor = 'not-allowed';
    }
    grid.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────
//  Grid rendering — shared accounts
// ─────────────────────────────────────────────────────────

function refreshSharedGrid() {
  const grid = document.getElementById('sharedGrid');
  if (!grid) return;

  const searchValue = (document.getElementById('sharedSearchInput')?.value || '').toLowerCase();

  const filtered = sharedAccounts.filter(acc => {
    const name = (acc.name || '').toLowerCase();
    const owner = (acc.ownerName || '').toLowerCase();
    return !searchValue || name.includes(searchValue) || owner.includes(searchValue);
  });

  grid.innerHTML = '';

  if (!filtered.length) {
    grid.innerHTML = '<div class="access-denied">No shared accounts found.</div>';
    return;
  }

  filtered.forEach(acc => {
    const card = document.createElement('div');
    card.className = 'bank-card';
    card.style.cursor = 'pointer';
    const memberCount = Array.isArray(acc.members) ? acc.members.length : 0;
    const pendingCount = Array.isArray(acc.pendingInvites) ? acc.pendingInvites.length : 0;
    card.innerHTML = `
      <h3>${safeText(acc.name, 'Unnamed Account')}</h3>
      <p>Owner: ${safeText(acc.ownerName)} (${safeText(acc.ownerPid)})</p>
      <p>${memberCount} member${memberCount !== 1 ? 's' : ''}${pendingCount ? ` &middot; ${pendingCount} pending` : ''}</p>
      <div class="balance">${formatCurrency(acc.balance || 0)}</div>`;
    card.addEventListener('click', (e) => {
      e.stopPropagation();
      openSharedModal(acc);
    });
    grid.appendChild(card);
  });
}

// ─────────────────────────────────────────────────────────
//  Data loading
// ─────────────────────────────────────────────────────────

async function loadCharactersAndAccounts() {
  const charsSnap = await getDocs(collection(db, 'characters'));
  allCharacters = [];
  charsSnap.forEach(docSnap => {
    allCharacters.push({ id: docSnap.id, ...docSnap.data() });
  });
  allCharacters.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

  const accountSnap = await getDocs(collection(db, 'bank_accounts'));
  bankAccounts = new Map();
  accountSnap.forEach(docSnap => {
    bankAccounts.set(docSnap.id, docSnap.data());
  });
}

async function loadSharedAccounts() {
  const snap = await getDocs(collection(db, 'shared_accounts'));
  sharedAccounts = [];
  snap.forEach(docSnap => {
    sharedAccounts.push({ id: docSnap.id, ...docSnap.data() });
  });
  sharedAccounts.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ─────────────────────────────────────────────────────────
//  Personal account modal
// ─────────────────────────────────────────────────────────

function updateModalFields(char, account) {
  document.getElementById('modalTitle').textContent = `Manage ${safeText(char.name, 'Account')}`;
  const routing = account?.routingNumber ? ` · Routing: ${account.routingNumber}` : '';
  const creditScore = Number(account?.creditScore || 0);
  const overdueBalance = Number(account?.overdueDeductionsBalance || 0);
  const creditMeta = creditScore > 0
    ? ` | Credit: ${Math.round(creditScore)} (${getCreditBand(creditScore)})`
    : ' | Credit: Not scored yet';
  const overdueMeta = ` | Overdue: ${formatCurrency(overdueBalance)}`;
  document.getElementById('modalMeta').textContent = `PID: ${safeText(char.pid)} | ${safeText(char.department)} | ${safeText(char.rank)}${routing}${creditMeta}${overdueMeta}`;

  const checking = Number(account?.checkingBalance ?? account?.balance ?? 0);
  const savings = Number(account?.savingsBalance ?? 0);
  const balDisplay = document.getElementById('modalBalDisplay');
  if (balDisplay) {
    balDisplay.innerHTML = `
      <div style="display:flex;gap:1rem;margin-bottom:0.8rem;">
        <div style="flex:1;background:rgba(0,217,255,0.08);border-radius:6px;padding:0.5rem 0.8rem;">
          <div class="bank-muted" style="font-size:0.8rem;">Checking</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--accent-mint);">${formatCurrency(checking)}</div>
        </div>
        <div style="flex:1;background:rgba(78,250,170,0.08);border-radius:6px;padding:0.5rem 0.8rem;">
          <div class="bank-muted" style="font-size:0.8rem;">Savings</div>
          <div style="font-size:1.1rem;font-weight:700;color:var(--accent-mint);">${formatCurrency(savings)}</div>
        </div>
      </div>`;
  }

  document.getElementById('setBalanceInput').value = '';
  document.getElementById('depositInput').value = '';
  document.getElementById('withdrawInput').value = '';
  document.getElementById('noteInput').value = '';
  const acctType = document.getElementById('accountTypeSelect');
  if (acctType) acctType.value = 'checking';

  document.getElementById('payAmountInput').value = account?.recurring?.amount || '';
  document.getElementById('payEnabledInput').checked = !!account?.recurring?.enabled;

  modalDeductions = normalizeMonthlyDeductions(account?.deductions || account?.monthlyDeductions || []);
  document.getElementById('deductionAmountInput').value = '';
  document.getElementById('deductionLabelInput').value = '';
  document.getElementById('deductionTypeInput').value = 'rent';
  renderDeductionList();

  const feedback = document.getElementById('modalFeedback');
  if (feedback) feedback.textContent = '';
}

function showModalFeedback(message, type) {
  const el = document.getElementById('modalFeedback');
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${type}`;
}

function showGlobalScheduleFeedback(message, type = '') {
  const el = document.getElementById('globalScheduleFeedback');
  if (!el) return;
  el.textContent = message;
  el.className = `scheduler-feedback ${type}`.trim();
}

function renderDeductionList() {
  const list = document.getElementById('deductionList');
  if (!list) return;
  list.innerHTML = '';
  if (!modalDeductions.length) {
    const empty = document.createElement('div');
    empty.className = 'bank-muted';
    empty.textContent = 'No monthly deductions configured.';
    list.appendChild(empty);
    return;
  }
  modalDeductions.forEach(item => {
    const row = document.createElement('div');
    row.className = 'deduction-item';

    const meta = document.createElement('div');
    meta.className = 'deduction-meta';
    const title = item.label ? `${item.label} (${toDeductionTypeLabel(item.type)})` : toDeductionTypeLabel(item.type);
    meta.textContent = `${title} — ${formatCurrency(item.amount)} / month`;

    const toggleLabel = document.createElement('label');
    toggleLabel.style.cssText = 'display:flex;align-items:center;gap:0.35rem;';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = !!item.enabled;
    enabledInput.addEventListener('change', () => {
      modalDeductions = modalDeductions.map(e => e.id !== item.id ? e : { ...e, enabled: enabledInput.checked });
    });
    const enabledText = document.createElement('span');
    enabledText.className = 'bank-muted';
    enabledText.textContent = 'Enabled';
    toggleLabel.appendChild(enabledInput);
    toggleLabel.appendChild(enabledText);

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-danger';
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      modalDeductions = modalDeductions.filter(e => e.id !== item.id);
      renderDeductionList();
    });

    row.appendChild(meta);
    row.appendChild(toggleLabel);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────
//  Shared account modal
// ─────────────────────────────────────────────────────────

function showSharedFeedback(message, type) {
  const el = document.getElementById('sharedModalFeedback');
  if (!el) return;
  el.textContent = message;
  el.className = `feedback ${type}`;
}

function renderSharedMembers(acc) {
  const container = document.getElementById('sharedMembersList');
  if (!container) return;
  container.innerHTML = '';

  // Extract email strings - handle both direct strings and objects with email property
  const members = Array.isArray(acc.members) ? acc.members.map(m => typeof m === 'string' ? m : (m?.email || String(m))) : [];
  const pending = Array.isArray(acc.pendingInvites) ? acc.pendingInvites.map(p => typeof p === 'string' ? p : (p?.email || String(p))) : [];

  if (!members.length && !pending.length) {
    container.innerHTML = '<p class="bank-muted">No members yet.</p>';
    return;
  }

  members.forEach((email, idx) => {
    const memberObj = acc.members[idx];
    const row = document.createElement('div');
    row.className = 'deduction-item';
    row.innerHTML = `<div class="deduction-meta">${safeText(email)}</div>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-danger';
    removeBtn.type = 'button';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', async () => {
      try {
        await updateDoc(doc(db, 'shared_accounts', acc.id), { members: arrayRemove(memberObj), updatedAt: serverTimestamp() });
        acc.members = (acc.members || []).filter(m => (typeof m === 'string' ? m : m?.email) !== email);
        renderSharedMembers(acc);
        showSharedFeedback('Member removed.', 'success');
      } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
    });
    row.appendChild(removeBtn);
    container.appendChild(row);
  });

  if (pending.length) {
    const header = document.createElement('p');
    header.className = 'bank-muted';
    header.style.marginTop = '0.5rem';
    header.textContent = 'Pending invites:';
    container.appendChild(header);
    pending.forEach((email, idx) => {
      const pendingObj = acc.pendingInvites[idx];
      const row = document.createElement('div');
      row.className = 'deduction-item';
      row.innerHTML = `<div class="deduction-meta" style="color:var(--muted);">${safeText(email)} (pending)</div>`;
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'btn-danger';
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        try {
          await updateDoc(doc(db, 'shared_accounts', acc.id), { pendingInvites: arrayRemove(pendingObj), updatedAt: serverTimestamp() });
          acc.pendingInvites = (acc.pendingInvites || []).filter(p => (typeof p === 'string' ? p : p?.email) !== email);
          renderSharedMembers(acc);
          showSharedFeedback('Invite cancelled.', 'success');
        } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
      });
      row.appendChild(cancelBtn);
      container.appendChild(row);
    });
  }
}

function openSharedModal(acc) {
  activeSharedAccount = acc;
  document.getElementById('sharedModalTitle').textContent = `Shared: ${safeText(acc.name)}`;
  document.getElementById('sharedModalMeta').textContent = `Owner: ${safeText(acc.ownerName)} (${safeText(acc.ownerPid)}) · ID: ${acc.id}`;
  document.getElementById('sharedModalBalance').textContent = formatCurrency(acc.balance || 0);
  document.getElementById('sharedSetBalanceInput').value = '';
  document.getElementById('sharedDepositInput').value = '';
  document.getElementById('sharedWithdrawInput').value = '';
  document.getElementById('sharedInviteEmailInput').value = '';
  document.getElementById('sharedTransferAmountInput').value = '';
  
  // Populate transfer account dropdown
  const accountSelect = document.getElementById('sharedTransferAccountSelect');
  accountSelect.innerHTML = '<option value="">-- Select Account --</option>';
  allCharacters.forEach(char => {
    const account = bankAccounts.get(char.pid);
    if (account) {
      const checking = Number(account?.checkingBalance ?? account?.balance ?? 0);
      const savings = Number(account?.savingsBalance ?? 0);
      const total = checking + savings;
      const option = document.createElement('option');
      option.value = JSON.stringify({ pid: char.pid, name: char.name });
      option.textContent = `${safeText(char.name)} (PID: ${safeText(char.pid)}) — ${formatCurrency(total)}`;
      accountSelect.appendChild(option);
    }
  });
  
  renderSharedMembers(acc);
  const feedback = document.getElementById('sharedModalFeedback');
  if (feedback) feedback.textContent = '';
  document.getElementById('sharedModal').classList.add('show');
}

window.closeSharedModal = function () {
  document.getElementById('sharedModal').classList.remove('show');
  activeSharedAccount = null;
};

// ─────────────────────────────────────────────────────────
//  Schedule form
// ─────────────────────────────────────────────────────────

function collectGlobalScheduleFromForm() {
  const defaults = defaultGlobalSchedule();
  const payrollEnabled = !!document.getElementById('globalPayrollEnabled')?.checked;
  const payrollAnchorDate = document.getElementById('globalPayrollAnchorDate')?.value || defaults.payroll.anchorDate;
  const payrollTime = parseTimeInputValue(document.getElementById('globalPayrollTime')?.value, defaults.payroll.hour, defaults.payroll.minute);
  const monthlyEnabled = !!document.getElementById('globalMonthlyEnabled')?.checked;
  const monthlyAnchorDate = document.getElementById('globalMonthlyAnchorDate')?.value || defaults.monthly.anchorDate;
  const monthlyTime = parseTimeInputValue(document.getElementById('globalMonthlyTime')?.value, defaults.monthly.hour, defaults.monthly.minute);
  return {
    timezone: EST_TIMEZONE,
    payroll: { enabled: payrollEnabled, anchorDate: payrollAnchorDate, hour: payrollTime.hour, minute: payrollTime.minute },
    monthly: { enabled: monthlyEnabled, anchorDate: monthlyAnchorDate, hour: monthlyTime.hour, minute: monthlyTime.minute }
  };
}

function applyGlobalScheduleToForm(config) {
  const defaults = defaultGlobalSchedule();
  const payroll = config?.payroll || defaults.payroll;
  const monthly = config?.monthly || defaults.monthly;
  const payrollDay = safeText(payroll.anchorDate, defaults.payroll.anchorDate);
  document.getElementById('globalPayrollEnabled').checked = payroll.enabled !== false;
  document.getElementById('globalPayrollAnchorDate').value = payrollDay;
  document.getElementById('globalPayrollTime').value = toTimeInputValue(payroll.hour ?? defaults.payroll.hour, payroll.minute ?? defaults.payroll.minute);
  const monthlyAnchorDate = safeText(monthly.anchorDate, defaults.monthly.anchorDate);
  document.getElementById('globalMonthlyEnabled').checked = monthly.enabled !== false;
  document.getElementById('globalMonthlyAnchorDate').value = monthlyAnchorDate;
  document.getElementById('globalMonthlyTime').value = toTimeInputValue(monthly.hour ?? defaults.monthly.hour, monthly.minute ?? defaults.monthly.minute);
  const activeSchedule = {
    timezone: EST_TIMEZONE,
    payroll: { enabled: payroll.enabled !== false, anchorDate: payrollDay, hour: Number(payroll.hour ?? defaults.payroll.hour), minute: Number(payroll.minute ?? defaults.payroll.minute) },
    monthly: { enabled: monthly.enabled !== false, anchorDate: monthlyAnchorDate, hour: Number(monthly.hour ?? defaults.monthly.hour), minute: Number(monthly.minute ?? defaults.monthly.minute) }
  };
  updateNextPayrollRunDisplay(activeSchedule);
  updateNextMonthlyRunDisplay(activeSchedule);
}

async function loadGlobalSchedule() {
  const snap = await getDoc(SCHEDULE_DOC_REF);
  if (!snap.exists()) { applyGlobalScheduleToForm(defaultGlobalSchedule()); return; }
  applyGlobalScheduleToForm(snap.data() || {});
}

async function saveGlobalSchedule() {
  const payload = collectGlobalScheduleFromForm();
  await setDoc(SCHEDULE_DOC_REF, {
    timezone: EST_TIMEZONE,
    payroll: payload.payroll,
    monthly: payload.monthly,
    updatedAt: serverTimestamp(),
    updatedByUid: auth.currentUser?.uid || ''
  }, { merge: true });
}

// ─────────────────────────────────────────────────────────
//  Audit logging
// ─────────────────────────────────────────────────────────

async function addAuditLog({ actionType, pid, charName, amount, accountType, note, details }) {
  try {
    await addDoc(collection(db, 'bank_audit_logs'), {
      timestamp: serverTimestamp(),
      actionType,
      pid: pid || '',
      charName: charName || '',
      amount: Number(amount || 0),
      accountType: accountType || 'checking',
      note: note || '',
      details: details || '',
      adminEmail: auth.currentUser?.email || 'system',
      adminUid: auth.currentUser?.uid || ''
    });
  } catch (err) {
    console.error('Failed to add audit log:', err);
  }
}

let auditLogs = [];
async function loadAuditLogs() {
  try {
    const snap = await getDocs(query(collection(db, 'bank_audit_logs'), orderBy('timestamp', 'desc'), limit(100)));
    auditLogs = [];
    snap.forEach(docSnap => {
      auditLogs.push({ id: docSnap.id, ...docSnap.data() });
    });
  } catch (err) {
    console.error('Failed to load audit logs:', err);
    auditLogs = [];
  }
}

function renderAuditLogs() {
  const container = document.getElementById('auditLogList');
  if (!container) return;
  container.innerHTML = '';

  if (!auditLogs.length) {
    container.innerHTML = '<p class="bank-muted">No audit log entries.</p>';
    return;
  }

  auditLogs.slice(0, 50).forEach(log => {
    const timestamp = log.timestamp?.toDate ? log.timestamp.toDate() : new Date(log.timestamp);
    const timeStr = timestamp.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const row = document.createElement('div');
    row.className = 'deduction-item';
    
    const actionLabel = {
      'set_balance': 'Set Balance',
      'deposit': 'Deposit',
      'withdraw': 'Withdrawal',
      'payroll': 'Payroll',
      'shared_deposit': 'Shared Deposit',
      'shared_withdraw': 'Shared Withdrawal'
    }[log.actionType] || log.actionType;

    row.innerHTML = `
      <div class="deduction-meta">
        <div style="font-weight:600;">${actionLabel} — ${safeText(log.charName, 'Unknown')} (${safeText(log.pid)})</div>
        <div style="font-size:0.85rem;margin-top:0.2rem;">${timeStr} by ${safeText(log.adminEmail)}</div>
        <div style="font-size:0.85rem;color:var(--accent-mint);">${formatCurrency(log.amount)} (${log.accountType || 'checking'})</div>
        ${log.note ? `<div style="font-size:0.8rem;margin-top:0.2rem;color:var(--muted);">"${log.note}"</div>` : ''}
      </div>`;

    container.appendChild(row);
  });
}

// ─────────────────────────────────────────────────────────
//  Transactions
// ─────────────────────────────────────────────────────────

async function applyTransaction({ pid, type, amount, note, char, accountType }) {
  const accountRef = doc(db, 'bank_accounts', pid);
  const txRef = doc(collection(db, 'bank_accounts', pid, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';
  const acctField = (accountType === 'savings') ? 'savingsBalance' : 'checkingBalance';

  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accountRef);
    const existing = accSnap.exists() ? accSnap.data() : null;
    const legacyBalance = Number(existing?.balance ?? 0);
    const previousBalance = Number(existing?.[acctField] ?? (acctField === 'checkingBalance' ? legacyBalance : 0));
    let newBalance = previousBalance;
    if (type === 'set_balance') newBalance = amount;
    else if (type === 'deposit' || type === 'payroll') newBalance = previousBalance + amount;
    else if (type === 'withdraw') newBalance = previousBalance - amount;

    const basePayload = {
      pid,
      name: char.name || '',
      department: char.department || '',
      rank: char.rank || '',
      linkedUID: char.linkedUID || '',
      [acctField]: newBalance,
      updatedAt: serverTimestamp(),
      updatedByUid: auth.currentUser?.uid || ''
    };
    if (!accSnap.exists() || (existing?.balance !== undefined && existing?.checkingBalance === undefined)) {
      basePayload.checkingBalance = acctField === 'checkingBalance' ? newBalance : legacyBalance;
      basePayload.savingsBalance = acctField === 'savingsBalance' ? newBalance : 0;
    }
    if (!accSnap.exists()) {
      basePayload.createdAt = serverTimestamp();
      basePayload.recurring = { enabled: false, amount: 0, lastPayAt: null, lastPayrollKey: '' };
      basePayload.deductions = [];
    }
    tx.set(accountRef, basePayload, { merge: true });
    tx.set(txRef, {
      type,
      accountType: accountType || 'checking',
      amount,
      note: note || '',
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newBalance
    });
  });

  // Log to audit
  await addAuditLog({ actionType: type, pid, charName: char.name, amount, accountType, note });
}

async function applySharedTransaction({ accountId, type, amount, note }) {
  const accountRef = doc(db, 'shared_accounts', accountId);
  const txRef = doc(collection(db, 'shared_accounts', accountId, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';

  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accountRef);
    if (!accSnap.exists()) throw new Error('Shared account not found.');
    const existing = accSnap.data();
    const previousBalance = Number(existing?.balance || 0);
    let newBalance = previousBalance;
    if (type === 'set_balance') newBalance = amount;
    else if (type === 'deposit') newBalance = previousBalance + amount;
    else if (type === 'withdraw') newBalance = previousBalance - amount;
    tx.set(accountRef, { balance: newBalance, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(txRef, {
      type, amount, note: note || '',
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newBalance
    });
  });

  // Log to audit
  await addAuditLog({ actionType: `shared_${type}`, pid: '', charName: `Shared: ${existing?.name}`, amount, note });
}

async function transferToSharedAccount({ pid, charName, amount, accountType, sharedAccountId, sharedAccountName }) {
  const personalRef = doc(db, 'bank_accounts', pid);
  const personalTxRef = doc(collection(db, 'bank_accounts', pid, 'transactions'));
  const sharedRef = doc(db, 'shared_accounts', sharedAccountId);
  const sharedTxRef = doc(collection(db, 'shared_accounts', sharedAccountId, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';
  const acctField = accountType === 'savings' ? 'savingsBalance' : 'checkingBalance';

  await runTransaction(db, async (tx) => {
    // Get personal account
    const personalSnap = await tx.get(personalRef);
    if (!personalSnap.exists()) throw new Error('Personal account not found.');
    const personalData = personalSnap.data();
    const previousPersonalBalance = Number(personalData?.[acctField] ?? 0);
    const newPersonalBalance = previousPersonalBalance - amount;
    if (newPersonalBalance < 0) throw new Error('Insufficient funds in ' + accountType + ' account.');

    // Get shared account
    const sharedSnap = await tx.get(sharedRef);
    if (!sharedSnap.exists()) throw new Error('Shared account not found.');
    const sharedData = sharedSnap.data();
    const previousSharedBalance = Number(sharedData?.balance || 0);
    const newSharedBalance = previousSharedBalance + amount;

    // Update personal account
    tx.set(personalRef, { [acctField]: newPersonalBalance, updatedAt: serverTimestamp(), updatedByUid: auth.currentUser?.uid || '' }, { merge: true });
    tx.set(personalTxRef, {
      type: 'transfer_out',
      accountType,
      amount,
      note: `Transfer to shared account: ${sharedAccountName}`,
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newPersonalBalance
    });

    // Update shared account
    tx.set(sharedRef, { balance: newSharedBalance, updatedAt: serverTimestamp() }, { merge: true });
    tx.set(sharedTxRef, {
      type: 'transfer_in',
      amount,
      note: `Transfer from ${charName} (${pid})`,
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newSharedBalance
    });
  });

  // Log to audit
  await addAuditLog({ actionType: 'transfer_to_shared', pid, charName, amount, accountType, note: `Transfer to shared account: ${sharedAccountName}` });
}

async function forcePayrollNow(char) {
  const pid = String(char.pid || '').trim();
  const accountRef = doc(db, 'bank_accounts', pid);
  const txRef = doc(collection(db, 'bank_accounts', pid, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';

  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accountRef);
    const existing = accSnap.exists() ? accSnap.data() : null;
    const inputAmount = parseAmount(document.getElementById('payAmountInput').value);
    const amount = inputAmount || Number(existing?.recurring?.amount || 0);
    if (!amount || amount <= 0) throw new Error('Payroll amount must be greater than 0. Set a pay amount first.');
    const previousBalance = Number(existing?.checkingBalance ?? existing?.balance ?? 0);
    const newBalance = previousBalance + amount;
    const basePayload = {
      pid, name: char.name || '', department: char.department || '', rank: char.rank || '', linkedUID: char.linkedUID || '',
      checkingBalance: newBalance, updatedAt: serverTimestamp(), updatedByUid: auth.currentUser?.uid || '',
      recurring: { enabled: true, amount, lastPayAt: serverTimestamp(), lastPayrollKey: '' }
    };
    if (!accSnap.exists()) basePayload.createdAt = serverTimestamp();
    tx.set(accountRef, basePayload, { merge: true });
    tx.set(txRef, {
      type: 'payroll', accountType: 'checking', amount, note: 'Manual payroll payout',
      createdAt: serverTimestamp(), createdByUid: auth.currentUser?.uid || '', createdByName: actorName, balanceAfter: newBalance
    });
  });

  // Log to audit
  await addAuditLog({ actionType: 'payroll', pid: String(char.pid), charName: char.name, amount, accountType: 'checking', note: 'Manual payroll payout' });
}

async function savePayrollSettings(char) {
  const pid = String(char.pid || '').trim();
  const amountValue = parseAmount(document.getElementById('payAmountInput').value);
  const enabled = document.getElementById('payEnabledInput').checked;
  if (enabled && (!amountValue || amountValue <= 0)) throw new Error('Payroll amount must be greater than 0.');
  await setDoc(doc(db, 'bank_accounts', pid), {
    pid, name: char.name || '', department: char.department || '', rank: char.rank || '', linkedUID: char.linkedUID || '',
    recurring: { enabled, amount: amountValue, lastPayAt: null, lastPayrollKey: '' },
    updatedAt: serverTimestamp(), updatedByUid: auth.currentUser?.uid || ''
  }, { merge: true });
}

async function saveMonthlyDeductions(char) {
  const pid = String(char?.pid || '').trim();
  if (!pid) throw new Error('Character PID is required to save deductions.');
  const sanitized = normalizeMonthlyDeductions(modalDeductions).map(item => ({
    id: item.id, type: item.type, label: item.label || '', amount: Number(item.amount || 0),
    enabled: item.enabled !== false, lastProcessedMonthKey: item.lastProcessedMonthKey || '', lastChargedAt: item.lastChargedAt || null
  }));
  // Write to `deductions` — the canonical field bank.js reads
  await setDoc(doc(db, 'bank_accounts', pid), {
    pid, name: char.name || '', department: char.department || '', rank: char.rank || '', linkedUID: char.linkedUID || '',
    deductions: sanitized, updatedAt: serverTimestamp(), updatedByUid: auth.currentUser?.uid || ''
  }, { merge: true });

  // Log to audit
  await addAuditLog({ actionType: 'deductions_updated', pid, charName: char.name, amount: 0, note: `Deductions updated (${sanitized.length} items)` });
}

// ─────────────────────────────────────────────────────────
//  Modal open/close
// ─────────────────────────────────────────────────────────

function openBankModal(char) {
  const pid = String(char.pid || '').trim();
  if (!pid) return;
  activeCharacter = char;
  const account = getAccountForPid(pid);
  updateModalFields(char, account);
  document.getElementById('bankModal').classList.add('show');
}

window.closeBankModal = function () {
  document.getElementById('bankModal').classList.remove('show');
  activeCharacter = null;
};

// ─────────────────────────────────────────────────────────
//  Wire: personal modal actions
// ─────────────────────────────────────────────────────────

function wireModalActions() {
  function getAcctType() {
    return document.getElementById('accountTypeSelect')?.value || 'checking';
  }

  async function refreshAfterTx() {
    await loadCharactersAndAccounts();
    refreshGrid();
    if (activeCharacter) {
      const account = getAccountForPid(String(activeCharacter.pid));
      updateModalFields(activeCharacter, account);
    }
  }

  document.getElementById('setBalanceBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await applyTransaction({ pid: String(activeCharacter.pid), type: 'set_balance', amount: parseAmount(document.getElementById('setBalanceInput').value), note: document.getElementById('noteInput').value || '', char: activeCharacter, accountType: getAcctType() });
      showModalFeedback('Balance updated.', 'success');
      await refreshAfterTx();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('depositBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await applyTransaction({ pid: String(activeCharacter.pid), type: 'deposit', amount: parseAmount(document.getElementById('depositInput').value), note: document.getElementById('noteInput').value || '', char: activeCharacter, accountType: getAcctType() });
      showModalFeedback('Deposit recorded.', 'success');
      await refreshAfterTx();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('withdrawBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await applyTransaction({ pid: String(activeCharacter.pid), type: 'withdraw', amount: parseAmount(document.getElementById('withdrawInput').value), note: document.getElementById('noteInput').value || '', char: activeCharacter, accountType: getAcctType() });
      showModalFeedback('Withdrawal recorded.', 'success');
      await refreshAfterTx();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('savePayBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await savePayrollSettings(activeCharacter);
      showModalFeedback('Payroll settings saved.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('forcePayBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await forcePayrollNow(activeCharacter);
      showModalFeedback('Payroll sent.', 'success');
      await refreshAfterTx();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('addDeductionBtn').addEventListener('click', () => {
    if (!activeCharacter) return;
    const type = normalizeDeductionType(document.getElementById('deductionTypeInput').value);
    const amount = parseAmount(document.getElementById('deductionAmountInput').value);
    const label = safeText(document.getElementById('deductionLabelInput').value, '');
    if (!amount || amount <= 0) { showModalFeedback('Deduction amount must be greater than 0.', 'error'); return; }
    modalDeductions.push({ id: makeDeductionId(), type, label, amount, enabled: true, lastProcessedMonthKey: '', lastChargedAt: null });
    document.getElementById('deductionAmountInput').value = '';
    document.getElementById('deductionLabelInput').value = '';
    renderDeductionList();
    showModalFeedback('Item added. Click Save Deductions to persist.', 'success');
  });

  document.getElementById('saveDeductionsBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    try {
      await saveMonthlyDeductions(activeCharacter);
      showModalFeedback('Monthly deductions saved.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) { showModalFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('bankModal').addEventListener('click', event => {
    if (event.target.id === 'bankModal') window.closeBankModal();
  });
}

// ─────────────────────────────────────────────────────────
//  Wire: shared modal actions
// ─────────────────────────────────────────────────────────

function wireSharedModalActions() {
  async function refreshSharedAfterTx() {
    await loadSharedAccounts();
    refreshSharedGrid();
  }

  document.getElementById('sharedSetBalanceBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    const amount = parseAmount(document.getElementById('sharedSetBalanceInput').value);
    try {
      await applySharedTransaction({ accountId: activeSharedAccount.id, type: 'set_balance', amount, note: 'Admin set balance' });
      activeSharedAccount.balance = amount;
      document.getElementById('sharedModalBalance').textContent = formatCurrency(amount);
      showSharedFeedback('Balance updated.', 'success');
      await refreshSharedAfterTx();
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedDepositBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    const amount = parseAmount(document.getElementById('sharedDepositInput').value);
    try {
      await applySharedTransaction({ accountId: activeSharedAccount.id, type: 'deposit', amount, note: 'Admin deposit' });
      activeSharedAccount.balance = (activeSharedAccount.balance || 0) + amount;
      document.getElementById('sharedModalBalance').textContent = formatCurrency(activeSharedAccount.balance);
      showSharedFeedback('Deposit recorded.', 'success');
      await refreshSharedAfterTx();
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedWithdrawBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    const amount = parseAmount(document.getElementById('sharedWithdrawInput').value);
    try {
      await applySharedTransaction({ accountId: activeSharedAccount.id, type: 'withdraw', amount, note: 'Admin withdrawal' });
      activeSharedAccount.balance = (activeSharedAccount.balance || 0) - amount;
      document.getElementById('sharedModalBalance').textContent = formatCurrency(activeSharedAccount.balance);
      showSharedFeedback('Withdrawal recorded.', 'success');
      await refreshSharedAfterTx();
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedTransferBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    const accountSelectValue = document.getElementById('sharedTransferAccountSelect').value;
    if (!accountSelectValue) { showSharedFeedback('Select an account to transfer from.', 'error'); return; }
    const amount = parseAmount(document.getElementById('sharedTransferAmountInput').value);
    const accountType = document.getElementById('sharedTransferTypeSelect').value;
    
    try {
      const { pid, name } = JSON.parse(accountSelectValue);
      await transferToSharedAccount({
        pid,
        charName: name,
        amount,
        accountType,
        sharedAccountId: activeSharedAccount.id,
        sharedAccountName: activeSharedAccount.name
      });
      activeSharedAccount.balance = (activeSharedAccount.balance || 0) + amount;
      document.getElementById('sharedModalBalance').textContent = formatCurrency(activeSharedAccount.balance);
      document.getElementById('sharedTransferAmountInput').value = '';
      showSharedFeedback(`Transfer of ${formatCurrency(amount)} completed.`, 'success');
      await refreshSharedAfterTx();
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedInviteBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    const email = (document.getElementById('sharedInviteEmailInput').value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) { showSharedFeedback('Enter a valid email address.', 'error'); return; }
    try {
      await updateDoc(doc(db, 'shared_accounts', activeSharedAccount.id), { pendingInvites: arrayUnion(email), updatedAt: serverTimestamp() });
      activeSharedAccount.pendingInvites = [...(activeSharedAccount.pendingInvites || []), email];
      document.getElementById('sharedInviteEmailInput').value = '';
      renderSharedMembers(activeSharedAccount);
      showSharedFeedback('Invite sent.', 'success');
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedDeleteBtn').addEventListener('click', async () => {
    if (!activeSharedAccount) return;
    if (!confirm(`Permanently delete shared account "${activeSharedAccount.name}"? This cannot be undone.`)) return;
    try {
      await deleteDoc(doc(db, 'shared_accounts', activeSharedAccount.id));
      window.closeSharedModal();
      await refreshSharedAfterTx();
    } catch (err) { showSharedFeedback(`Error: ${err.message}`, 'error'); }
  });

  document.getElementById('sharedModal').addEventListener('click', event => {
    if (event.target.id === 'sharedModal') window.closeSharedModal();
  });
}

// ─────────────────────────────────────────────────────────
//  Wire: filters, schedule, tabs
// ─────────────────────────────────────────────────────────

function wireFilters() {
  document.getElementById('searchInput').addEventListener('input', refreshGrid);
  document.getElementById('sortSelect').addEventListener('change', refreshGrid);
  document.getElementById('sharedSearchInput')?.addEventListener('input', refreshSharedGrid);
}

function wireGlobalScheduleActions() {
  const saveBtn = document.getElementById('saveGlobalScheduleBtn');
  if (!saveBtn) return;
  const watchedIds = ['globalPayrollEnabled', 'globalPayrollAnchorDate', 'globalPayrollTime', 'globalMonthlyEnabled', 'globalMonthlyAnchorDate', 'globalMonthlyTime'];
  watchedIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => { updateNextPayrollRunDisplay(); updateNextMonthlyRunDisplay(); });
    el.addEventListener('input', () => { updateNextPayrollRunDisplay(); updateNextMonthlyRunDisplay(); });
  });
  saveBtn.addEventListener('click', async () => {
    try {
      await saveGlobalSchedule();
      showGlobalScheduleFeedback('Global EST schedule saved successfully.', 'success');
      updateNextPayrollRunDisplay();
      updateNextMonthlyRunDisplay();
    } catch (err) { showGlobalScheduleFeedback(`Error: ${err.message}`, 'error'); }
  });
}

function wireTabs() {
  const tabs = document.querySelectorAll('.bm-tab');
  const panels = document.querySelectorAll('.bm-panel');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => {
        p.classList.remove('active');
        p.style.display = 'none';
      });
      tab.classList.add('active');
      const target = document.getElementById(tab.dataset.panel);
      if (target) {
        target.classList.add('active');
        target.style.display = 'block';
        // Load audit logs when switching to audit tab
        if (tab.dataset.panel === 'panelAudit') {
          loadAuditLogs().then(() => renderAuditLogs());
        }
      }
    });
  });

  // Wire refresh audit button
  const refreshBtn = document.getElementById('refreshAuditBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing...';
      await loadAuditLogs();
      renderAuditLogs();
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh Audit Log';
    });
  }
}

// ─────────────────────────────────────────────────────────
//  Init
// ─────────────────────────────────────────────────────────

async function initBankManager() {
  const accessDenied = document.getElementById('accessDenied');
  const management = document.getElementById('managementContainer');

  onAuthStateChanged(auth, async (user) => {
    if (!user) { accessDenied.style.display = 'block'; return; }

    try {
      let userDoc = null;
      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid));
        userDoc = userSnap.exists() ? userSnap.data() : null;
      } catch { userDoc = null; }

      const charQuery = query(collection(db, 'characters'), where('linkedUID', '==', user.uid));
      const charSnap = await getDocs(charQuery);
      let allowed = isSiteDirectorEmail(user) || isManagerOrAboveUser(user, userDoc);
      charSnap.forEach(docSnap => { if (hasBankAccess(docSnap.data())) allowed = true; });

      if (!allowed) { accessDenied.style.display = 'block'; return; }

      management.style.display = 'block';
      await loadGlobalSchedule();
      await loadCharactersAndAccounts();
      await loadSharedAccounts();
      await loadAuditLogs();
      wireFilters();
      wireTabs();
      wireModalActions();
      wireSharedModalActions();
      wireGlobalScheduleActions();
      refreshGrid();
      refreshSharedGrid();
      renderAuditLogs();
    } catch (err) {
      console.error('Access check failed:', err);
      accessDenied.style.display = 'block';
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('includesLoaded', initBankManager);
} else {
  initBankManager();
}
