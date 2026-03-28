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
  runTransaction,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

let allCharacters = [];
let bankAccounts = new Map();
let activeCharacter = null;
let modalDeductions = [];

const SCHEDULE_DOC_REF = doc(db, 'bank_config', 'schedule');
const EST_TIMEZONE = 'America/New_York';
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';

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

function getDatePartsInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map(part => [part.type, part.value]));
  return {
    year: Number(map.get('year') || 0),
    month: Number(map.get('month') || 1),
    day: Number(map.get('day') || 1)
  };
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
  if (!match) {
    return { hour: fallbackHour, minute: fallbackMinute };
  }

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
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(date);
  const map = new Map(parts.map(part => [part.type, part.value]));
  return {
    year: Number(map.get('year') || 0),
    month: Number(map.get('month') || 1),
    day: Number(map.get('day') || 1),
    hour: Number(map.get('hour') || 0),
    minute: Number(map.get('minute') || 0)
  };
}

function utcDateMsFromParts(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function addDaysToYmd(parts, days) {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate()
  };
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function zonedLocalToUtcDate(timeZone, localYmd, hour, minute) {
  let guess = new Date(Date.UTC(localYmd.year, localYmd.month - 1, localYmd.day, hour, minute, 0, 0));

  for (let index = 0; index < 3; index += 1) {
    const actual = getDateTimePartsInTimeZone(guess, timeZone);
    const desiredUtcAsWallClock = Date.UTC(localYmd.year, localYmd.month - 1, localYmd.day, hour, minute, 0, 0);
    const actualUtcAsWallClock = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const diffMs = desiredUtcAsWallClock - actualUtcAsWallClock;
    if (diffMs === 0) break;
    guess = new Date(guess.getTime() + diffMs);
  }

  return guess;
}

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
    if (candidateUtc.getTime() > nowMs) {
      return candidateUtc;
    }
  }

  return null;
}

function updateNextPayrollRunDisplay(schedule = null) {
  const target = document.getElementById('globalPayrollNextRun');
  if (!target) return;

  const activeSchedule = schedule || collectGlobalScheduleFromForm();
  if (activeSchedule?.payroll?.enabled === false) {
    target.textContent = 'Next payroll run (EST): Disabled';
    return;
  }

  const nextRun = computeNextPayrollRunDate(activeSchedule);
  if (!nextRun) {
    target.textContent = 'Next payroll run (EST): Invalid schedule';
    return;
  }

  const datePart = nextRun.toLocaleDateString('en-US', {
    timeZone: EST_TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timePart = nextRun.toLocaleTimeString('en-US', {
    timeZone: EST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });

  target.textContent = `Next payroll run (EST): ${datePart} at ${timePart}`;
}

function computeNextMonthlyRunDate(schedule) {
  const monthly = schedule?.monthly || {};
  if (monthly.enabled === false) return null;

  const anchor = parseIsoDateParts(monthly.anchorDate);
  const hour = Number(monthly.hour);
  const minute = Number(monthly.minute);
  if (!anchor) return null;
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return null;

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
    if (candidateUtc.getTime() > nowMs) {
      return candidateUtc;
    }
  }

  return null;
}

function updateNextMonthlyRunDisplay(schedule = null) {
  const target = document.getElementById('globalMonthlyNextRun');
  if (!target) return;

  const activeSchedule = schedule || collectGlobalScheduleFromForm();
  if (activeSchedule?.monthly?.enabled === false) {
    target.textContent = 'Next monthly deduction run (EST): Disabled';
    return;
  }

  const nextRun = computeNextMonthlyRunDate(activeSchedule);
  if (!nextRun) {
    target.textContent = 'Next monthly deduction run (EST): Invalid schedule';
    return;
  }

  const datePart = nextRun.toLocaleDateString('en-US', {
    timeZone: EST_TIMEZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  const timePart = nextRun.toLocaleTimeString('en-US', {
    timeZone: EST_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  });

  target.textContent = `Next monthly deduction run (EST): ${datePart} at ${timePart}`;
}

function defaultGlobalSchedule() {
  return {
    timezone: EST_TIMEZONE,
    payroll: {
      enabled: true,
      anchorDate: getTodayEstIsoDate(),
      hour: 9,
      minute: 0
    },
    monthly: {
      enabled: true,
      anchorDate: getTodayEstIsoDate(),
      hour: 9,
      minute: 0
    }
  };
}

function normalizeDeductionType(type) {
  const normalized = String(type || '').toLowerCase().replace(/[^a-z_]/g, '_');
  const allowed = new Set(['rent', 'mortgage', 'car_payment', 'loan', 'insurance', 'utilities', 'other']);
  return allowed.has(normalized) ? normalized : 'other';
}

function toDeductionTypeLabel(type) {
  const labels = {
    rent: 'Rent',
    mortgage: 'Mortgage',
    car_payment: 'Car Payment',
    loan: 'Loan',
    insurance: 'Insurance',
    utilities: 'Utilities',
    other: 'Other'
  };
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
  
  // If character has a stored email, use it
  if (targetChar.email) return targetChar.email.toLowerCase();

  const snap = await getDocs(collection(db, 'characters'));
  
  // Separate characters with existing emails from those without
  const withEmail = [];
  const withoutEmail = [];
  const targetCharId = targetChar.docId || targetChar.id || '';
  
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if (data && data.name) {
      const char = { docId: docSnap.id, ...data };
      if (char.email) {
        withEmail.push(char);
      } else {
        withoutEmail.push(char);
      }
    }
  });

  // Sort characters without emails by creation time (older first)
  withoutEmail.sort((a, b) => {
    const aSec = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
    const bSec = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
    const aNanos = a.createdAt && a.createdAt.nanoseconds ? a.createdAt.nanoseconds : 0;
    const bNanos = b.createdAt && b.createdAt.nanoseconds ? b.createdAt.nanoseconds : 0;
    if (aSec !== bSec) return aSec - bSec;
    if (aNanos !== bNanos) return aNanos - bNanos;

    const aPid = String(a.pid || '');
    const bPid = String(b.pid || '');
    if (aPid !== bPid) return aPid.localeCompare(bPid);

    return String(a.docId || '').localeCompare(String(b.docId || ''));
  });

  // Build counts from existing emails
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
          const currentMax = counts.get(baseLocal) || 0;
          counts.set(baseLocal, Math.max(currentMax, num));
        } else if (localPart === baseLocal) {
          const currentMax = counts.get(baseLocal) || 0;
          counts.set(baseLocal, Math.max(currentMax, 1));
        }
      }
      
      const list = byBase.get(baseLocal) || [];
      list.push({ email, department: char.department || '' });
      byBase.set(baseLocal, list);
    }
  });

  // Generate emails for characters without them
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

  // Resolve for target character
  const baseLocal = baseLocalFromName(targetChar.name);
  const pidKey = targetChar.pid ? String(targetChar.pid) : '';
  
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);
  if (targetCharId && byDocId.has(targetCharId)) return byDocId.get(targetCharId);

  const bucket = byBase.get(baseLocal);
  if (bucket && bucket.length) {
    if (bucket.length === 1) return bucket[0].email;
    const dept = (targetChar.department || '').toLowerCase();
    const match = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return match ? match.email : bucket[0].email;
  }

  const snapshotCount = (counts.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

async function sendBankNotification(char, txType, amount, balanceAfter, note) {
  try {
    const recipient = await resolveCharacterEmail(char);
    if (!recipient) return;

    const typeLabel = (txType || 'transaction').toString().replace(/_/g, ' ').toUpperCase();
    const subject = `Transaction Alert: ${typeLabel}`;
    const amountText = formatCurrency(amount);
    const balanceText = formatCurrency(balanceAfter);
    const accountName = char.name || `Personnel ${char.pid}`;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    // Determine transaction type icon and color
    let txIcon = '💰';
    let txColor = '#00D9FF'; // mint
    if (txType === 'deposit' || txType === 'payroll') {
      txIcon = '✅';
      txColor = '#00D9FF';
    } else if (txType === 'withdraw') {
      txIcon = '⚠️';
      txColor = '#FF6B6B';
    }

    const body = `---

## ${txIcon} SITE-89 FINANCIAL DEPARTMENT

**Transaction Notification**

---

### Account Activity Summary

**Account Holder:** ${accountName}  
**Personnel ID:** \`${char.pid || 'N/A'}\`  
**Date & Time:** ${dateStr} at ${timeStr}

---

### Transaction Details

| Field | Value |
|-------|-------|
| **Transaction Type** | ${typeLabel} |
| **Amount** | **${amountText}** |
| **New Balance** | **${balanceText}** |
${note ? `| **Notes** | ${note} |` : ''}

---

${txType === 'payroll' ? '### 💼 Payroll Information\n\nYour bi-weekly salary has been automatically deposited into your account. Thank you for your continued service to the Foundation.\n\n---\n\n' : ''}
${txType === 'deposit' ? '### ✅ Deposit Confirmation\n\nA deposit has been credited to your account. Your updated balance is reflected above.\n\n---\n\n' : ''}
${txType === 'withdraw' ? '### ⚠️ Withdrawal Notice\n\nA withdrawal has been processed on your account. Please verify this transaction was authorized.\n\n---\n\n' : ''}
> **Security Notice:** If you did not authorize this transaction, please contact the Financial Department immediately at \`fd.mgmt@site89.org\` or visit your nearest Site-89 Financial Office.

---

*This is an automated notification from the Site-89 Financial Department. Please do not reply to this email.*

**Foundation Banking Services** | Site-89 Financial Operations  
*Secure • Contain • Protect • Pay*`;

    await addDoc(collection(db, 'emails'), {
      sender: 'fd.mgmt@site89.org',
      senderEmail: 'fd.mgmt@site89.org',
      recipients: [recipient],
      subject,
      body,
      isHTML: false,
      format: 'markdown',
      status: 'sent',
      folder: '',
      ts: serverTimestamp()
    });
  } catch (err) {
    console.error('Failed to send bank notification:', err);
  }
}

function hasBankAccess(char) {
  const dept = (char.department || '').toLowerCase();
  const rank = (char.rank || '').toLowerCase();
  const directorOf = Array.isArray(char.directorOf) ? char.directorOf.map(item => String(item).toLowerCase()) : [];

  return dept.includes('ad') ||
    dept.includes('administrative') ||
    dept.includes('fd') ||
    dept.includes('field') ||
    rank.includes('site director') ||
    directorOf.includes('sd');
}

function isSiteDirectorEmail(user) {
  return !!user && (user.email || '').toLowerCase() === 'jedi21132@gmail.com';
}

function getAccountForPid(pid) {
  if (!pid) return null;
  return bankAccounts.get(String(pid)) || null;
}

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
    if (sortValue === 'department') {
      return (a.department || '').localeCompare(b.department || '');
    }
    if (sortValue === 'balance') {
      const aBal = getAccountForPid(a.pid)?.balance || 0;
      const bBal = getAccountForPid(b.pid)?.balance || 0;
      return bBal - aBal;
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

    const nameEl = document.createElement('h3');
    nameEl.textContent = safeText(char.name, 'Unknown');

    const pidEl = document.createElement('p');
    pidEl.textContent = `PID: ${safeText(char.pid, 'Unassigned')}`;

    const deptEl = document.createElement('p');
    deptEl.textContent = `Dept: ${safeText(char.department)}`;

    const rankEl = document.createElement('p');
    rankEl.textContent = `Rank: ${safeText(char.rank)}`;

    const balanceEl = document.createElement('div');
    balanceEl.className = 'balance';
    balanceEl.textContent = formatCurrency(account?.balance || 0);

    card.appendChild(nameEl);
    card.appendChild(pidEl);
    card.appendChild(deptEl);
    card.appendChild(rankEl);
    card.appendChild(balanceEl);

    if (char.pid) {
      card.addEventListener('click', () => openBankModal(char));
    } else {
      card.style.opacity = '0.6';
      card.style.cursor = 'not-allowed';
    }

    grid.appendChild(card);
  });
}

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

function wireFilters() {
  document.getElementById('searchInput').addEventListener('input', refreshGrid);
  document.getElementById('sortSelect').addEventListener('change', refreshGrid);
}

function updateModalFields(char, account) {
  document.getElementById('modalTitle').textContent = `Manage ${safeText(char.name, 'Account')}`;
  document.getElementById('modalMeta').textContent = `PID: ${safeText(char.pid)} | ${safeText(char.department)} | ${safeText(char.rank)}`;

  document.getElementById('setBalanceInput').value = '';
  document.getElementById('depositInput').value = '';
  document.getElementById('withdrawInput').value = '';
  document.getElementById('noteInput').value = '';

  document.getElementById('payAmountInput').value = account?.recurring?.amount || '';
  document.getElementById('payEnabledInput').checked = !!account?.recurring?.enabled;

  modalDeductions = normalizeMonthlyDeductions(account?.monthlyDeductions || []);
  document.getElementById('deductionAmountInput').value = '';
  document.getElementById('deductionLabelInput').value = '';
  document.getElementById('deductionTypeInput').value = 'rent';
  renderDeductionList();

  const feedback = document.getElementById('modalFeedback');
  if (feedback) feedback.textContent = '';
}

function showModalFeedback(message, type) {
  const feedback = document.getElementById('modalFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
}

function showGlobalScheduleFeedback(message, type = '') {
  const feedback = document.getElementById('globalScheduleFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = `scheduler-feedback ${type}`.trim();
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
    meta.textContent = `${title} - ${formatCurrency(item.amount)} / month`;

    const toggleLabel = document.createElement('label');
    toggleLabel.style.display = 'flex';
    toggleLabel.style.alignItems = 'center';
    toggleLabel.style.gap = '0.35rem';

    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox';
    enabledInput.checked = !!item.enabled;
    enabledInput.addEventListener('change', () => {
      modalDeductions = modalDeductions.map(existing => {
        if (existing.id !== item.id) return existing;
        return { ...existing, enabled: enabledInput.checked };
      });
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
      modalDeductions = modalDeductions.filter(existing => existing.id !== item.id);
      renderDeductionList();
    });

    row.appendChild(meta);
    row.appendChild(toggleLabel);
    row.appendChild(removeBtn);
    list.appendChild(row);
  });
}

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
    payroll: {
      enabled: payrollEnabled,
      anchorDate: payrollAnchorDate,
      hour: payrollTime.hour,
      minute: payrollTime.minute
    },
    monthly: {
      enabled: monthlyEnabled,
      anchorDate: monthlyAnchorDate,
      hour: monthlyTime.hour,
      minute: monthlyTime.minute
    }
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
    payroll: {
      enabled: payroll.enabled !== false,
      anchorDate: payrollDay,
      hour: Number(payroll.hour ?? defaults.payroll.hour),
      minute: Number(payroll.minute ?? defaults.payroll.minute)
    },
    monthly: {
      enabled: monthly.enabled !== false,
      anchorDate: monthlyAnchorDate,
      hour: Number(monthly.hour ?? defaults.monthly.hour),
      minute: Number(monthly.minute ?? defaults.monthly.minute)
    }
  };

  updateNextPayrollRunDisplay(activeSchedule);
  updateNextMonthlyRunDisplay(activeSchedule);
}

async function loadGlobalSchedule() {
  const snap = await getDoc(SCHEDULE_DOC_REF);
  if (!snap.exists()) {
    const defaults = defaultGlobalSchedule();
    applyGlobalScheduleToForm(defaults);
    return;
  }

  const payload = snap.data() || {};
  applyGlobalScheduleToForm(payload);
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

async function saveMonthlyDeductions(char) {
  const pid = String(char?.pid || '').trim();
  if (!pid) throw new Error('Character PID is required to save deductions.');

  const sanitized = normalizeMonthlyDeductions(modalDeductions).map(item => ({
    id: item.id,
    type: item.type,
    label: item.label || '',
    amount: Number(item.amount || 0),
    enabled: item.enabled !== false,
    lastProcessedMonthKey: item.lastProcessedMonthKey || '',
    lastChargedAt: item.lastChargedAt || null
  }));

  await setDoc(doc(db, 'bank_accounts', pid), {
    pid,
    name: char.name || '',
    department: char.department || '',
    rank: char.rank || '',
    linkedUID: char.linkedUID || '',
    monthlyDeductions: sanitized,
    updatedAt: serverTimestamp(),
    updatedByUid: auth.currentUser?.uid || ''
  }, { merge: true });
}

async function applyTransaction({ pid, type, amount, note, char }) {
  const accountRef = doc(db, 'bank_accounts', pid);
  const txRef = doc(collection(db, 'bank_accounts', pid, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';
  let finalBalance = 0;

  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accountRef);
    const existing = accSnap.exists() ? accSnap.data() : null;
    const previousBalance = Number(existing?.balance || 0);
    let newBalance = previousBalance;

    if (type === 'set_balance') {
      newBalance = amount;
    } else if (type === 'deposit' || type === 'payroll') {
      newBalance = previousBalance + amount;
    } else if (type === 'withdraw') {
      newBalance = previousBalance - amount;
    }

    finalBalance = newBalance;

    const basePayload = {
      pid,
      name: char.name || '',
      department: char.department || '',
      rank: char.rank || '',
      linkedUID: char.linkedUID || '',
      notifyEmail: existing?.notifyEmail || '',
      balance: newBalance,
      updatedAt: serverTimestamp(),
      updatedByUid: auth.currentUser?.uid || ''
    };

    if (!accSnap.exists()) {
      basePayload.createdAt = serverTimestamp();
      basePayload.recurring = {
        enabled: false,
        amount: 0,
        lastPayAt: null,
        lastPayrollKey: ''
      };
      basePayload.monthlyDeductions = [];
    }

    tx.set(accountRef, basePayload, { merge: true });
    tx.set(txRef, {
      type,
      amount,
      note: note || '',
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newBalance
    });
  });

  // Notification is sent by Cloud Functions on transaction creation.
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
    if (!amount || amount <= 0) {
      throw new Error('Payroll amount must be greater than 0. Set a pay amount first.');
    }

    const previousBalance = Number(existing?.balance || 0);
    const newBalance = previousBalance + amount;

    const basePayload = {
      pid,
      name: char.name || '',
      department: char.department || '',
      rank: char.rank || '',
      linkedUID: char.linkedUID || '',
      balance: newBalance,
      updatedAt: serverTimestamp(),
      updatedByUid: auth.currentUser?.uid || '',
      recurring: {
        enabled: true,
        amount,
        lastPayAt: serverTimestamp(),
        lastPayrollKey: ''
      }
    };

    if (!accSnap.exists()) {
      basePayload.createdAt = serverTimestamp();
    }

    tx.set(accountRef, basePayload, { merge: true });
    tx.set(txRef, {
      type: 'payroll',
      amount,
      note: 'Manual payroll payout',
      createdAt: serverTimestamp(),
      createdByUid: auth.currentUser?.uid || '',
      createdByName: actorName,
      balanceAfter: newBalance
    });
  });

  // Notification is sent by Cloud Functions on transaction creation.
}

async function savePayrollSettings(char) {
  const pid = String(char.pid || '').trim();
  const amountValue = parseAmount(document.getElementById('payAmountInput').value);
  const enabled = document.getElementById('payEnabledInput').checked;
  if (enabled && (!amountValue || amountValue <= 0)) {
    throw new Error('Payroll amount must be greater than 0.');
  }

  await setDoc(doc(db, 'bank_accounts', pid), {
    pid,
    name: char.name || '',
    department: char.department || '',
    rank: char.rank || '',
    linkedUID: char.linkedUID || '',
    recurring: {
      enabled,
      amount: amountValue,
      lastPayAt: null,
      lastPayrollKey: ''
    },
    updatedAt: serverTimestamp(),
    updatedByUid: auth.currentUser?.uid || ''
  }, { merge: true });
}

function openBankModal(char) {
  const pid = String(char.pid || '').trim();
  if (!pid) return;

  activeCharacter = char;
  const account = getAccountForPid(pid);
  updateModalFields(char, account);
  document.getElementById('bankModal').classList.add('show');
}

window.closeBankModal = function() {
  document.getElementById('bankModal').classList.remove('show');
  activeCharacter = null;
};

function wireModalActions() {
  document.getElementById('setBalanceBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    const amount = parseAmount(document.getElementById('setBalanceInput').value);
    const note = document.getElementById('noteInput').value || '';

    try {
      await applyTransaction({
        pid: String(activeCharacter.pid),
        type: 'set_balance',
        amount,
        note,
        char: activeCharacter
      });
      showModalFeedback('Balance updated.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('depositBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    const amount = parseAmount(document.getElementById('depositInput').value);
    const note = document.getElementById('noteInput').value || '';

    try {
      await applyTransaction({
        pid: String(activeCharacter.pid),
        type: 'deposit',
        amount,
        note,
        char: activeCharacter
      });
      showModalFeedback('Deposit recorded.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('withdrawBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;
    const amount = parseAmount(document.getElementById('withdrawInput').value);
    const note = document.getElementById('noteInput').value || '';

    try {
      await applyTransaction({
        pid: String(activeCharacter.pid),
        type: 'withdraw',
        amount,
        note,
        char: activeCharacter
      });
      showModalFeedback('Withdrawal recorded.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('savePayBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;

    try {
      await savePayrollSettings(activeCharacter);
      showModalFeedback('Payroll settings saved.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('forcePayBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;

    try {
      await forcePayrollNow(activeCharacter);
      showModalFeedback('Payroll sent.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('addDeductionBtn').addEventListener('click', () => {
    if (!activeCharacter) return;
    const type = normalizeDeductionType(document.getElementById('deductionTypeInput').value);
    const amount = parseAmount(document.getElementById('deductionAmountInput').value);
    const label = safeText(document.getElementById('deductionLabelInput').value, '');

    if (!amount || amount <= 0) {
      showModalFeedback('Deduction amount must be greater than 0.', 'error');
      return;
    }

    modalDeductions.push({
      id: makeDeductionId(),
      type,
      label,
      amount,
      enabled: true,
      lastProcessedMonthKey: '',
      lastChargedAt: null
    });

    document.getElementById('deductionAmountInput').value = '';
    document.getElementById('deductionLabelInput').value = '';
    renderDeductionList();
    showModalFeedback('Deduction item added. Click Save Deductions to persist.', 'success');
  });

  document.getElementById('saveDeductionsBtn').addEventListener('click', async () => {
    if (!activeCharacter) return;

    try {
      await saveMonthlyDeductions(activeCharacter);
      showModalFeedback('Monthly deductions saved.', 'success');
      await loadCharactersAndAccounts();
      refreshGrid();
    } catch (err) {
      showModalFeedback(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('bankModal').addEventListener('click', (event) => {
    if (event.target.id === 'bankModal') {
      window.closeBankModal();
    }
  });
}

function wireGlobalScheduleActions() {
  const saveBtn = document.getElementById('saveGlobalScheduleBtn');
  if (!saveBtn) return;

  const watchedIds = [
    'globalPayrollEnabled',
    'globalPayrollAnchorDate',
    'globalPayrollTime',
    'globalMonthlyEnabled',
    'globalMonthlyAnchorDate',
    'globalMonthlyTime'
  ];
  watchedIds.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      updateNextPayrollRunDisplay();
      updateNextMonthlyRunDisplay();
    });
    el.addEventListener('input', () => {
      updateNextPayrollRunDisplay();
      updateNextMonthlyRunDisplay();
    });
  });

  saveBtn.addEventListener('click', async () => {
    try {
      await saveGlobalSchedule();
      showGlobalScheduleFeedback('Global EST schedule saved successfully.', 'success');
      updateNextPayrollRunDisplay();
      updateNextMonthlyRunDisplay();
    } catch (err) {
      showGlobalScheduleFeedback(`Error: ${err.message}`, 'error');
    }
  });
}

async function initBankManager() {
  const accessDenied = document.getElementById('accessDenied');
  const management = document.getElementById('managementContainer');

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      accessDenied.style.display = 'block';
      return;
    }

    try {
      let userDoc = null;
      try {
        const userSnap = await getDoc(doc(db, 'users', user.uid));
        userDoc = userSnap.exists() ? userSnap.data() : null;
      } catch {
        userDoc = null;
      }

      const charQuery = query(collection(db, 'characters'), where('linkedUID', '==', user.uid));
      const charSnap = await getDocs(charQuery);
      let allowed = isSiteDirectorEmail(user) || isManagerOrAboveUser(user, userDoc);
      charSnap.forEach(docSnap => {
        const char = docSnap.data();
        if (hasBankAccess(char)) allowed = true;
      });

      if (!allowed) {
        accessDenied.style.display = 'block';
        return;
      }

      management.style.display = 'block';
      await loadGlobalSchedule();
      await loadCharactersAndAccounts();
      wireFilters();
      wireModalActions();
      wireGlobalScheduleActions();
      refreshGrid();
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
