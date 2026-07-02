import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  setDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const db = getFirestore(app);
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';

const SETTINGS_REF = doc(db, 'bank_config', 'site_finance_settings');
const ACCOUNT_DEFS = [
  { id: 'site_total', name: 'Site Total Fund', code: 'SITE', category: 'site' },
  { id: 'reserve', name: 'Reserve Fund', code: 'RESERVE', category: 'site' },
  { id: 'dept_ad', name: 'Administrative Department', code: 'AD', category: 'department' },
  { id: 'dept_ia', name: 'Internal Affairs', code: 'IA', category: 'department' },
  { id: 'dept_tsd', name: 'Technical Services Department', code: 'TSD', category: 'department' },
  { id: 'dept_sd', name: 'Security Department', code: 'SD', category: 'department' },
  { id: 'dept_scd', name: 'Scientific Department', code: 'ScD', category: 'department' }
];

const DEPT_ALLOCATION_ORDER = [
  { code: 'AD', accountId: 'dept_ad' },
  { code: 'IA', accountId: 'dept_ia' },
  { code: 'TSD', accountId: 'dept_tsd' },
  { code: 'SD', accountId: 'dept_sd' },
  { code: 'ScD', accountId: 'dept_scd' }
];

let currentUser = null;
let accountsById = new Map();
let financeSettings = defaultSettings();

function defaultSettings() {
  return {
    foundationMonthlyDeposit: 0,
    autoAllocateEnabled: false,
    allocations: {
      AD: 20,
      IA: 20,
      TSD: 20,
      SD: 20,
      ScD: 20
    }
  };
}

function esc(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}

function roundToCents(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function parseAmount(value) {
  const cleaned = String(value || '').replace(/[^0-9.-]/g, '');
  const parsed = parseFloat(cleaned);
  return Number.isFinite(parsed) ? roundToCents(parsed) : 0;
}

function formatCurrency(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value || 0));
}

function formatDate(value) {
  if (!value) return '--';
  try {
    const date = value.toDate ? value.toDate() : new Date(value);
    return date.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '--';
  }
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'manager') return 'manager';
  if (role === 'raisa') return 'manager';
  return 'member';
}

function parseClearance(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

function hasFinanceCharacterAccess(char) {
  const dept = String(char?.department || '').toLowerCase();
  const rank = String(char?.rank || '').toLowerCase();
  const clearance = parseClearance(char?.clearance);
  const directorOf = Array.isArray(char?.directorOf) ? char.directorOf.map(item => String(item).toLowerCase()) : [];

  const isAdOrFd = dept.includes('ad') || dept.includes('administrative') || dept.includes('fd') || dept.includes('finance');
  const isDirector = rank.includes('site director') || rank.includes('finance director') || directorOf.includes('ad') || directorOf.includes('fd');
  const isLevelFive = Number.isFinite(clearance) && clearance >= 5;

  return isAdOrFd || isDirector || isLevelFive;
}

function isManagerOrAbove(user, userDoc) {
  if (!user) return false;
  if (user.email === PRIMARY_ADMIN_EMAIL) return true;
  if (userDoc?.isAdmin === true) return true;
  const role = normalizeRole(userDoc?.role);
  return role === 'manager' || role === 'admin';
}

function showStatus(message, type = '') {
  const el = document.getElementById('globalStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `status ${type}`.trim();
}

function accountPayload(def, balance = 0) {
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    department: def.code,
    balance: roundToCents(balance),
    updatedAt: serverTimestamp(),
    updatedByUid: currentUser?.uid || ''
  };
}

async function ensureAccountsExist() {
  await Promise.all(ACCOUNT_DEFS.map(async def => {
    const ref = doc(db, 'site_finance_accounts', def.id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        ...accountPayload(def, 0),
        createdAt: serverTimestamp()
      }, { merge: true });
    }
  }));
}

function normalizeSettings(raw) {
  const defaults = defaultSettings();
  const out = {
    foundationMonthlyDeposit: roundToCents(raw?.foundationMonthlyDeposit || defaults.foundationMonthlyDeposit),
    autoAllocateEnabled: raw?.autoAllocateEnabled === true,
    allocations: { ...defaults.allocations }
  };

  Object.keys(out.allocations).forEach(key => {
    const next = Number(raw?.allocations?.[key]);
    out.allocations[key] = Number.isFinite(next) && next >= 0 ? Math.min(100, next) : defaults.allocations[key];
  });

  return out;
}

async function loadSettings() {
  const snap = await getDoc(SETTINGS_REF);
  financeSettings = normalizeSettings(snap.exists() ? snap.data() : {});

  document.getElementById('foundationDepositInput').value = String(financeSettings.foundationMonthlyDeposit || 0);
  document.getElementById('autoAllocateInput').checked = !!financeSettings.autoAllocateEnabled;
  document.getElementById('allocAD').value = String(financeSettings.allocations.AD ?? 0);
  document.getElementById('allocIA').value = String(financeSettings.allocations.IA ?? 0);
  document.getElementById('allocTSD').value = String(financeSettings.allocations.TSD ?? 0);
  document.getElementById('allocSD').value = String(financeSettings.allocations.SD ?? 0);
  document.getElementById('allocScD').value = String(financeSettings.allocations.ScD ?? 0);
  updateAllocationTotalDisplay();
}

function updateAllocationTotalDisplay() {
  const total = ['allocAD', 'allocIA', 'allocTSD', 'allocSD', 'allocScD']
    .map(id => Number(document.getElementById(id)?.value || 0))
    .reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);

  const display = document.getElementById('allocTotalDisplay');
  if (!display) return;
  display.value = `${roundToCents(total)}%`;
  display.style.color = total > 100 ? '#ff6b6b' : '#4efaaa';
}

async function saveSettings() {
  const payload = {
    foundationMonthlyDeposit: roundToCents(parseAmount(document.getElementById('foundationDepositInput').value)),
    autoAllocateEnabled: !!document.getElementById('autoAllocateInput').checked,
    allocations: {
      AD: Math.max(0, Math.min(100, Number(document.getElementById('allocAD').value || 0))),
      IA: Math.max(0, Math.min(100, Number(document.getElementById('allocIA').value || 0))),
      TSD: Math.max(0, Math.min(100, Number(document.getElementById('allocTSD').value || 0))),
      SD: Math.max(0, Math.min(100, Number(document.getElementById('allocSD').value || 0))),
      ScD: Math.max(0, Math.min(100, Number(document.getElementById('allocScD').value || 0)))
    },
    updatedAt: serverTimestamp(),
    updatedByUid: currentUser?.uid || ''
  };

  await setDoc(SETTINGS_REF, payload, { merge: true });
  financeSettings = normalizeSettings(payload);
  showStatus('Finance settings saved.', 'ok');
}

async function loadAccounts() {
  const snap = await getDocs(collection(db, 'site_finance_accounts'));
  accountsById = new Map();
  snap.forEach(docSnap => {
    accountsById.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
  });

  ACCOUNT_DEFS.forEach(def => {
    if (!accountsById.has(def.id)) {
      accountsById.set(def.id, { ...accountPayload(def, 0) });
    }
  });
}

function getAccountBalance(accountId) {
  return Number(accountsById.get(accountId)?.balance || 0);
}

function renderKPIs() {
  const siteTotal = getAccountBalance('site_total');
  const reserve = getAccountBalance('reserve');
  const deptTotal = DEPT_ALLOCATION_ORDER.reduce((sum, row) => sum + getAccountBalance(row.accountId), 0);
  const grandTotal = ACCOUNT_DEFS.reduce((sum, def) => sum + getAccountBalance(def.id), 0);

  const kpi = document.getElementById('kpiGrid');
  kpi.innerHTML = `
    <div class="kpi-card"><div class="kpi-label">All Site Funds</div><div class="kpi-value">${esc(formatCurrency(grandTotal))}</div></div>
    <div class="kpi-card"><div class="kpi-label">Central Site Total</div><div class="kpi-value">${esc(formatCurrency(siteTotal))}</div></div>
    <div class="kpi-card"><div class="kpi-label">Department Budgets</div><div class="kpi-value">${esc(formatCurrency(deptTotal))}</div></div>
    <div class="kpi-card"><div class="kpi-label">Reserve Fund</div><div class="kpi-value">${esc(formatCurrency(reserve))}</div></div>
  `;
}

function renderAccountCards() {
  const wrap = document.getElementById('accountGrid');
  wrap.innerHTML = ACCOUNT_DEFS.map(def => {
    const balance = getAccountBalance(def.id);
    return `
      <div class="account-card">
        <div class="account-meta">${esc(def.code)} • ${esc(def.category.toUpperCase())}</div>
        <h3>${esc(def.name)}</h3>
        <div class="account-balance">${esc(formatCurrency(balance))}</div>
      </div>
    `;
  }).join('');

  const options = ACCOUNT_DEFS.map(def => `<option value="${esc(def.id)}">${esc(def.name)}</option>`).join('');
  document.getElementById('transferFrom').innerHTML = options;
  document.getElementById('transferTo').innerHTML = options;
  document.getElementById('adjustAccount').innerHTML = options;
}

function computeAllocationRows(baseAmount, allocations) {
  const amount = roundToCents(baseAmount);
  if (!amount || amount <= 0) return { rows: [], allocated: 0 };

  const rows = DEPT_ALLOCATION_ORDER
    .map(row => ({ ...row, percent: Number(allocations[row.code] || 0) }))
    .filter(row => row.percent > 0);
  if (!rows.length) return { rows: [], allocated: 0 };

  const totalPct = rows.reduce((sum, row) => sum + row.percent, 0);
  const cappedPct = Math.min(totalPct, 100);
  if (cappedPct <= 0) return { rows: [], allocated: 0 };

  const allocatableCents = Math.round((amount * cappedPct / 100) * 100);
  const raw = rows.map(row => {
    const rawCents = allocatableCents * (row.percent / totalPct);
    return { ...row, rawCents, cents: Math.floor(rawCents) };
  });

  let remainder = allocatableCents - raw.reduce((sum, row) => sum + row.cents, 0);
  if (remainder > 0) {
    raw.sort((a, b) => (b.rawCents - b.cents) - (a.rawCents - a.cents)).forEach(row => {
      if (remainder <= 0) return;
      row.cents += 1;
      remainder -= 1;
    });
  }

  const normalized = raw.filter(row => row.cents > 0).map(row => ({
    accountId: row.accountId,
    code: row.code,
    amount: roundToCents(row.cents / 100)
  }));

  return {
    rows: normalized,
    allocated: roundToCents(normalized.reduce((sum, row) => sum + row.amount, 0))
  };
}

async function applyAllocationNow() {
  const siteBalance = getAccountBalance('site_total');
  if (siteBalance <= 0) {
    showStatus('No funds available in Site Total to allocate.', 'warn');
    return;
  }

  const allocation = computeAllocationRows(siteBalance, financeSettings.allocations);
  if (!allocation.rows.length) {
    showStatus('Allocation percentages are zero. Nothing to distribute.', 'warn');
    return;
  }

  await runTransaction(db, async tx => {
    const siteRef = doc(db, 'site_finance_accounts', 'site_total');
    const siteSnap = await tx.get(siteRef);
    const liveSiteBalance = roundToCents(siteSnap.exists() ? siteSnap.data()?.balance : 0);
    if (liveSiteBalance <= 0) throw new Error('No funds available in Site Total.');

    const liveAllocation = computeAllocationRows(liveSiteBalance, financeSettings.allocations);
    if (!liveAllocation.rows.length) throw new Error('No distribution rows generated.');

    let nextSiteBalance = roundToCents(liveSiteBalance - liveAllocation.allocated);
    tx.set(siteRef, accountPayload(ACCOUNT_DEFS.find(def => def.id === 'site_total'), nextSiteBalance), { merge: true });

    const outTxRef = doc(collection(siteRef, 'transactions'));
    tx.set(outTxRef, {
      scope: 'site_finance',
      type: 'manual_allocation_out',
      direction: 'debit',
      amount: liveAllocation.allocated,
      note: 'Manual allocation from Site Total to departments',
      breakdown: liveAllocation.rows,
      createdAt: serverTimestamp(),
      createdByUid: currentUser?.uid || '',
      createdByName: currentUser?.email || 'unknown',
      balanceAfter: nextSiteBalance
    });

    for (const row of liveAllocation.rows) {
      const targetDef = ACCOUNT_DEFS.find(def => def.id === row.accountId);
      const targetRef = doc(db, 'site_finance_accounts', row.accountId);
      const targetSnap = await tx.get(targetRef);
      const nextBalance = roundToCents((targetSnap.exists() ? targetSnap.data()?.balance : 0) + row.amount);

      tx.set(targetRef, accountPayload(targetDef, nextBalance), { merge: true });
      const inTxRef = doc(collection(targetRef, 'transactions'));
      tx.set(inTxRef, {
        scope: 'site_finance',
        type: 'manual_allocation_in',
        direction: 'credit',
        amount: row.amount,
        note: `Manual allocation from Site Total (${row.code})`,
        createdAt: serverTimestamp(),
        createdByUid: currentUser?.uid || '',
        createdByName: currentUser?.email || 'unknown',
        balanceAfter: nextBalance
      });
    }
  });

  showStatus('Department allocation applied.', 'ok');
}

async function postFoundationDepositNow() {
  const amount = roundToCents(financeSettings.foundationMonthlyDeposit || 0);
  if (!amount || amount <= 0) {
    showStatus('Set a positive Foundation monthly deposit first.', 'warn');
    return;
  }

  await runTransaction(db, async tx => {
    const siteRef = doc(db, 'site_finance_accounts', 'site_total');
    const siteSnap = await tx.get(siteRef);
    const current = roundToCents(siteSnap.exists() ? siteSnap.data()?.balance : 0);
    let nextSiteBalance = roundToCents(current + amount);

    tx.set(siteRef, accountPayload(ACCOUNT_DEFS.find(def => def.id === 'site_total'), nextSiteBalance), { merge: true });
    tx.set(doc(collection(siteRef, 'transactions')), {
      scope: 'site_finance',
      type: 'manual_foundation_deposit',
      direction: 'credit',
      amount,
      note: 'Manual Foundation deposit posted by admin',
      createdAt: serverTimestamp(),
      createdByUid: currentUser?.uid || '',
      createdByName: currentUser?.email || 'unknown',
      balanceAfter: nextSiteBalance
    });

    if (financeSettings.autoAllocateEnabled) {
      const allocation = computeAllocationRows(amount, financeSettings.allocations);
      if (allocation.rows.length) {
        nextSiteBalance = roundToCents(nextSiteBalance - allocation.allocated);
        tx.set(siteRef, accountPayload(ACCOUNT_DEFS.find(def => def.id === 'site_total'), nextSiteBalance), { merge: true });
        tx.set(doc(collection(siteRef, 'transactions')), {
          scope: 'site_finance',
          type: 'auto_allocation_out',
          direction: 'debit',
          amount: allocation.allocated,
          note: 'Auto-allocation from manual Foundation deposit',
          breakdown: allocation.rows,
          createdAt: serverTimestamp(),
          createdByUid: currentUser?.uid || '',
          createdByName: currentUser?.email || 'unknown',
          balanceAfter: nextSiteBalance
        });

        for (const row of allocation.rows) {
          const targetDef = ACCOUNT_DEFS.find(def => def.id === row.accountId);
          const targetRef = doc(db, 'site_finance_accounts', row.accountId);
          const targetSnap = await tx.get(targetRef);
          const nextBalance = roundToCents((targetSnap.exists() ? targetSnap.data()?.balance : 0) + row.amount);

          tx.set(targetRef, accountPayload(targetDef, nextBalance), { merge: true });
          tx.set(doc(collection(targetRef, 'transactions')), {
            scope: 'site_finance',
            type: 'auto_allocation_in',
            direction: 'credit',
            amount: row.amount,
            note: `Auto-allocation from Foundation deposit (${row.code})`,
            createdAt: serverTimestamp(),
            createdByUid: currentUser?.uid || '',
            createdByName: currentUser?.email || 'unknown',
            balanceAfter: nextBalance
          });
        }
      }
    }
  });

  showStatus('Foundation deposit posted.', 'ok');
}

async function submitTransfer(event) {
  event.preventDefault();
  const fromId = document.getElementById('transferFrom').value;
  const toId = document.getElementById('transferTo').value;
  const amount = roundToCents(parseAmount(document.getElementById('transferAmount').value));
  const note = String(document.getElementById('transferNote').value || '').trim();

  if (!fromId || !toId || fromId === toId) {
    showStatus('Choose different source and destination accounts.', 'warn');
    return;
  }
  if (!amount || amount <= 0) {
    showStatus('Transfer amount must be greater than zero.', 'warn');
    return;
  }

  await runTransaction(db, async tx => {
    const fromRef = doc(db, 'site_finance_accounts', fromId);
    const toRef = doc(db, 'site_finance_accounts', toId);
    const fromDef = ACCOUNT_DEFS.find(def => def.id === fromId);
    const toDef = ACCOUNT_DEFS.find(def => def.id === toId);

    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
    const fromBalance = roundToCents(fromSnap.exists() ? fromSnap.data()?.balance : 0);
    if (fromBalance < amount) throw new Error('Insufficient funds in source account.');

    const nextFrom = roundToCents(fromBalance - amount);
    const nextTo = roundToCents((toSnap.exists() ? toSnap.data()?.balance : 0) + amount);

    tx.set(fromRef, accountPayload(fromDef, nextFrom), { merge: true });
    tx.set(toRef, accountPayload(toDef, nextTo), { merge: true });

    tx.set(doc(collection(fromRef, 'transactions')), {
      scope: 'site_finance',
      type: 'transfer_out',
      direction: 'debit',
      amount,
      note: note || `Transfer to ${toDef?.name || toId}`,
      linkedAccountId: toId,
      createdAt: serverTimestamp(),
      createdByUid: currentUser?.uid || '',
      createdByName: currentUser?.email || 'unknown',
      balanceAfter: nextFrom
    });

    tx.set(doc(collection(toRef, 'transactions')), {
      scope: 'site_finance',
      type: 'transfer_in',
      direction: 'credit',
      amount,
      note: note || `Transfer from ${fromDef?.name || fromId}`,
      linkedAccountId: fromId,
      createdAt: serverTimestamp(),
      createdByUid: currentUser?.uid || '',
      createdByName: currentUser?.email || 'unknown',
      balanceAfter: nextTo
    });
  });

  event.target.reset();
  showStatus('Transfer completed.', 'ok');
}

async function submitAdjustment(event) {
  event.preventDefault();
  const accountId = document.getElementById('adjustAccount').value;
  const direction = document.getElementById('adjustType').value;
  const amount = roundToCents(parseAmount(document.getElementById('adjustAmount').value));
  const note = String(document.getElementById('adjustNote').value || '').trim();

  if (!accountId) {
    showStatus('Select an account for adjustment.', 'warn');
    return;
  }
  if (!amount || amount <= 0) {
    showStatus('Adjustment amount must be greater than zero.', 'warn');
    return;
  }

  await runTransaction(db, async tx => {
    const ref = doc(db, 'site_finance_accounts', accountId);
    const def = ACCOUNT_DEFS.find(item => item.id === accountId);
    const snap = await tx.get(ref);
    const current = roundToCents(snap.exists() ? snap.data()?.balance : 0);
    const delta = direction === 'debit' ? -amount : amount;
    const next = roundToCents(current + delta);
    if (next < 0) throw new Error('Adjustment would create a negative balance.');

    tx.set(ref, accountPayload(def, next), { merge: true });
    tx.set(doc(collection(ref, 'transactions')), {
      scope: 'site_finance',
      type: direction === 'debit' ? 'manual_debit' : 'manual_credit',
      direction,
      amount,
      note: note || 'Manual adjustment',
      createdAt: serverTimestamp(),
      createdByUid: currentUser?.uid || '',
      createdByName: currentUser?.email || 'unknown',
      balanceAfter: next
    });
  });

  event.target.reset();
  showStatus('Adjustment posted.', 'ok');
}

async function loadRecentTransactions() {
  const txRows = [];

  await Promise.all(ACCOUNT_DEFS.map(async def => {
    const txSnap = await getDocs(query(collection(db, 'site_finance_accounts', def.id, 'transactions'), orderBy('createdAt', 'desc'), limit(10)));
    txSnap.forEach(docSnap => {
      txRows.push({ id: docSnap.id, accountId: def.id, accountName: def.name, ...docSnap.data() });
    });
  }));

  txRows.sort((a, b) => {
    const aMs = a.createdAt?.toDate ? a.createdAt.toDate().getTime() : 0;
    const bMs = b.createdAt?.toDate ? b.createdAt.toDate().getTime() : 0;
    return bMs - aMs;
  });

  const body = document.getElementById('txTableBody');
  if (!txRows.length) {
    body.innerHTML = '<tr><td colspan="6" class="muted">No transactions yet.</td></tr>';
    return;
  }

  body.innerHTML = txRows.slice(0, 40).map(row => `
    <tr>
      <td>${esc(formatDate(row.createdAt))}</td>
      <td>${esc(row.accountName)}</td>
      <td>${esc(String(row.type || '--').replace(/_/g, ' '))}</td>
      <td>${esc(row.direction || '--')}</td>
      <td>${esc(formatCurrency(row.amount || 0))}</td>
      <td>${esc(row.note || '--')}</td>
    </tr>
  `).join('');
}

async function refreshAll() {
  await ensureAccountsExist();
  await loadSettings();
  await loadAccounts();
  renderKPIs();
  renderAccountCards();
  await loadRecentTransactions();
}

function wireActions() {
  ['allocAD', 'allocIA', 'allocTSD', 'allocSD', 'allocScD'].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('input', updateAllocationTotalDisplay);
    input.addEventListener('change', updateAllocationTotalDisplay);
  });

  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    try {
      await saveSettings();
      await refreshAll();
    } catch (error) {
      showStatus(`Save failed: ${error.message}`, 'error');
    }
  });

  document.getElementById('allocateNowBtn').addEventListener('click', async () => {
    try {
      await applyAllocationNow();
      await refreshAll();
    } catch (error) {
      showStatus(`Allocation failed: ${error.message}`, 'error');
    }
  });

  document.getElementById('foundationDepositNowBtn').addEventListener('click', async () => {
    try {
      await postFoundationDepositNow();
      await refreshAll();
    } catch (error) {
      showStatus(`Deposit failed: ${error.message}`, 'error');
    }
  });

  document.getElementById('transferForm').addEventListener('submit', async (event) => {
    try {
      await submitTransfer(event);
      await refreshAll();
    } catch (error) {
      showStatus(`Transfer failed: ${error.message}`, 'error');
    }
  });

  document.getElementById('adjustForm').addEventListener('submit', async (event) => {
    try {
      await submitAdjustment(event);
      await refreshAll();
    } catch (error) {
      showStatus(`Adjustment failed: ${error.message}`, 'error');
    }
  });

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    showStatus('Refreshing data...');
    try {
      await refreshAll();
      showStatus('Data refreshed.', 'ok');
    } catch (error) {
      showStatus(`Refresh failed: ${error.message}`, 'error');
    }
  });
}

async function initFinancePage() {
  const loading = document.getElementById('loadingState');
  const denied = document.getElementById('accessDenied');
  const appShell = document.getElementById('financeApp');

  onAuthStateChanged(auth, async user => {
    if (!user) {
      loading.style.display = 'none';
      denied.style.display = 'block';
      denied.querySelector('.reason').textContent = 'Sign in required.';
      return;
    }

    currentUser = user;

    try {
      const userSnap = await getDoc(doc(db, 'users', user.uid));
      const userDoc = userSnap.exists() ? userSnap.data() : null;

      const charSnap = await getDocs(query(collection(db, 'characters'), where('linkedUID', '==', user.uid)));
      const chars = charSnap.docs.map(docSnap => docSnap.data());

      let allowed = isManagerOrAbove(user, userDoc);
      if (!allowed) {
        allowed = chars.some(hasFinanceCharacterAccess);
      }

      if (!allowed) {
        loading.style.display = 'none';
        denied.style.display = 'block';
        denied.querySelector('.reason').textContent = 'Requires Level 5 clearance or AD/FD finance permissions.';
        return;
      }

      loading.style.display = 'none';
      appShell.style.display = 'block';
      wireActions();
      await refreshAll();
      showStatus('Finance dashboard ready.', 'ok');
    } catch (error) {
      loading.style.display = 'none';
      denied.style.display = 'block';
      denied.querySelector('.reason').textContent = `Access check failed: ${error.message}`;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('includesLoaded', initFinancePage);
} else {
  initFinancePage();
}
