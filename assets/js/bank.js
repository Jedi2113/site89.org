import { app, auth, onAuthStateChanged } from "/assets/js/auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  addDoc,
  collection,
  query,
  orderBy,
  limit,
  where,
  getDocs,
  serverTimestamp,
  runTransaction,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

// ─────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────

function formatCurrency(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function formatDate(ts) {
  if (!ts) return '--';
  try {
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString();
  } catch {
    return '--';
  }
}

function safeText(value, fallback = '--') {
  const text = (value || '').toString().trim();
  return text || fallback;
}

function showStatus(el, msg, type) {
  if (!el) return;
  el.textContent = msg;
  el.className = `bank-status ${type}`;
}

function clearStatus(el) {
  if (!el) return;
  el.textContent = '';
  el.className = 'bank-status';
}

function getCreditBand(scoreInput) {
  const score = Number(scoreInput || 0);
  if (!score || score < 580) return 'Poor';
  if (score < 670) return 'Fair';
  if (score < 740) return 'Good';
  if (score < 800) return 'Very Good';
  return 'Excellent';
}

function renderCreditStatus(accountData) {
  const scoreEl = document.getElementById('bankCreditScore');
  const overdueEl = document.getElementById('bankOverdueBalance');
  if (!scoreEl && !overdueEl) return;

  const score = Number(accountData?.creditScore || 0);
  const overdue = Number(accountData?.overdueDeductionsBalance || 0);

  if (scoreEl) {
    if (score > 0) {
      scoreEl.textContent = `Credit score: ${Math.round(score)} (${getCreditBand(score)})`;
    } else {
      scoreEl.textContent = 'Credit score: Not enough data yet';
    }
  }

  if (overdueEl) {
    overdueEl.textContent = `Overdue deductions: ${formatCurrency(overdue)}`;
    overdueEl.style.color = overdue > 0 ? '#f87171' : 'var(--accent-mint)';
  }
}

// ─────────────────────────────────────────────────────────
//  Routing number generation
//  Format: middle-3-chars-of-PID + 5-random-digits
//  e.g. PID "A1B2C3" → mid chars "1B2" + "47381" → "1B247381"
// ─────────────────────────────────────────────────────────

function generateRoutingNumber(pid) {
  const clean = String(pid || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const len = clean.length;
  const start = Math.max(0, Math.floor(len / 2) - 1);
  const midChars = clean.substring(start, start + 3).padEnd(3, '0');
  const digits = Array.from({ length: 5 }, () => Math.floor(Math.random() * 10)).join('');
  return `${midChars}${digits}`;
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
      if (char.email) withEmail.push(char); else withoutEmail.push(char);
    }
  });

  withoutEmail.sort((a, b) => {
    const aSec = a.createdAt?.seconds || 0;
    const bSec = b.createdAt?.seconds || 0;
    if (aSec !== bSec) return aSec - bSec;
    const aNanos = a.createdAt?.nanoseconds || 0;
    const bNanos = b.createdAt?.nanoseconds || 0;
    if (aNanos !== bNanos) return aNanos - bNanos;
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
    const match = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return match ? match.email : bucket[0].email;
  }

  const snapshotCount = (counts.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

// ─────────────────────────────────────────────────────────
//  Account setup
// ─────────────────────────────────────────────────────────

async function ensureBankAccount(charData, user) {
  if (!charData || !charData.pid) return null;
  const pid = String(charData.pid).trim();
  if (!pid) return null;

  const accountRef = doc(db, 'bank_accounts', pid);
  const snap = await getDoc(accountRef);

  if (snap.exists()) {
    const data = snap.data();
    const updates = {};

    // Migrate legacy single balance → checking
    if (data.checkingBalance === undefined) updates.checkingBalance = Number(data.balance || 0);
    if (data.savingsBalance  === undefined) updates.savingsBalance  = 0;
    // Generate routing number if missing
    if (!data.routingNumber) updates.routingNumber = generateRoutingNumber(pid);

    if (Object.keys(updates).length > 0) {
      await updateDoc(accountRef, { ...updates, updatedAt: serverTimestamp() });
      return { ref: accountRef, data: { ...data, ...updates } };
    }

    return { ref: accountRef, data };
  }

  const routingNumber = generateRoutingNumber(pid);
  const payload = {
    pid,
    name: charData.name || '',
    department: charData.department || '',
    rank: charData.rank || '',
    linkedUID: user.uid,
    notifyEmail: user.email || '',
    checkingBalance: 0,
    savingsBalance: 0,
    balance: 0,
    routingNumber,
    deductions: [],
    recurring: {
      enabled: false,
      amount: 0,
      lastPayAt: null,
      lastPayrollKey: ''
    },
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    updatedByUid: user.uid
  };

  await setDoc(accountRef, payload, { merge: true });
  return { ref: accountRef, data: payload };
}

// ─────────────────────────────────────────────────────────
//  Transaction history
// ─────────────────────────────────────────────────────────

async function loadTransactions(pid, accountFilter = 'all') {
  const target = document.getElementById('bankTransactions');
  if (!target) return;

  try {
    const txRef   = collection(db, 'bank_accounts', pid, 'transactions');
    const txQuery = query(txRef, orderBy('createdAt', 'desc'), limit(40));
    const snap    = await getDocs(txQuery);

    const rows = [];
    snap.forEach(docSnap => {
      const tx = docSnap.data() || {};
      if (accountFilter !== 'all' && tx.accountType && tx.accountType !== accountFilter) return;
      rows.push(tx);
    });

    if (rows.length === 0) {
      target.textContent = accountFilter === 'all'
        ? 'No transactions yet.'
        : `No ${accountFilter} transactions yet.`;
      return;
    }

    const table = document.createElement('table');
    table.className = 'bank-table';

    const thead   = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Account', 'Type', 'Amount', 'Balance After', 'Date', 'Note'].forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach(tx => {
      const row = document.createElement('tr');

      const isIn       = ['deposit', 'payroll', 'transfer_in', 'shared_payout'].includes(tx.type || '');
      const isInternal = tx.type === 'internal_transfer';
      const typeClass  = isInternal ? 'tx-type-internal' : (isIn ? 'tx-type-in' : 'tx-type-out');
      const prefix     = isInternal ? '↔' : (isIn ? '+' : '−');

      const cells = [
        { text: (tx.accountType || 'checking').charAt(0).toUpperCase() + (tx.accountType || 'checking').slice(1), cls: '' },
        { text: safeText(tx.type, 'unknown'), cls: typeClass },
        { text: `${prefix}${formatCurrency(Math.abs(tx.amount || 0))}`, cls: typeClass },
        { text: formatCurrency(tx.balanceAfter), cls: '' },
        { text: formatDate(tx.createdAt), cls: '' },
        { text: safeText(tx.note, ''), cls: '' }
      ];

      cells.forEach(({ text, cls }) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (cls) td.className = cls;
        row.appendChild(td);
      });

      tbody.appendChild(row);
    });

    table.appendChild(tbody);
    target.innerHTML = '';
    target.appendChild(table);
  } catch (err) {
    console.error('Failed to load transactions:', err);
    target.textContent = 'Unable to load transactions.';
  }
}

// ─────────────────────────────────────────────────────────
//  Deductions
// ─────────────────────────────────────────────────────────

function renderDeductions(accountData) {
  const container = document.getElementById('deductionsList');
  const summary = document.getElementById('deductionsSummary');
  if (!container) return;

  const deductions = accountData.deductions || accountData.monthlyDeductions || [];
  const overdue = Number(accountData?.overdueDeductionsBalance || 0);
  const creditFactors = accountData?.creditFactors || {};
  const onTimeRatio = Number(creditFactors?.onTimeRatio || 0);

  if (summary) {
    const onTimePct = Math.max(0, Math.min(100, Math.round(onTimeRatio * 100)));
    const overdueText = overdue > 0
      ? `Outstanding amount due: ${formatCurrency(overdue)}.`
      : 'No overdue deduction balance.';
    summary.textContent = `${overdueText} Recent on-time payment ratio: ${onTimePct}%.`;
    summary.style.color = overdue > 0 ? '#f87171' : 'var(--muted)';
  }

  if (deductions.length === 0) {
    container.innerHTML = '<p class="bank-muted">No active monthly deductions.</p>';
    return;
  }

  let total = 0;
  const items = deductions.map(d => {
    const amount = Number(d.amount || 0);
    total += amount;
    return `
      <div class="deduction-item">
        <div>
          <div class="deduction-label">${safeText(d.label, 'Unnamed deduction')}</div>
          <div class="deduction-meta">${safeText(d.frequency, 'Monthly')}${d.nextDate ? ` · Next: ${d.nextDate}` : ''}</div>
        </div>
        <div class="deduction-amount">−${formatCurrency(amount)}</div>
      </div>`;
  }).join('');

  container.innerHTML = `
    ${items}
    <div class="deductions-total">
      <span>Total Monthly Deductions</span>
      <span style="color:#f87171;">−${formatCurrency(total)}</span>
    </div>`;
}

// ─────────────────────────────────────────────────────────
//  Transfers
// ─────────────────────────────────────────────────────────

async function findAccountByIdentifier(identifier) {
  const clean = identifier.trim().toUpperCase();
  if (!clean) return null;

  // Try direct PID lookup
  const pidRef  = doc(db, 'bank_accounts', clean);
  const pidSnap = await getDoc(pidRef);
  if (pidSnap.exists()) return { id: pidSnap.id, ...pidSnap.data() };

  // Try routing number
  const rQuery = query(
    collection(db, 'bank_accounts'),
    where('routingNumber', '==', clean)
  );
  const rSnap = await getDocs(rQuery);
  if (!rSnap.empty) {
    const d = rSnap.docs[0];
    return { id: d.id, ...d.data() };
  }

  return null;
}

async function transferBetweenAccounts({ fromPid, fromAccountType, toPid, toAccountType, amount, note, isSelfTransfer = false }) {
  const fromField = fromAccountType === 'savings' ? 'savingsBalance' : 'checkingBalance';
  const toField   = toAccountType   === 'savings' ? 'savingsBalance' : 'checkingBalance';
  const fromRef   = doc(db, 'bank_accounts', fromPid);
  const toRef     = doc(db, 'bank_accounts', toPid);

  await runTransaction(db, async (tx) => {
    const fromSnap = await tx.get(fromRef);
    const toSnap   = isSelfTransfer ? fromSnap : await tx.get(toRef);

    if (!fromSnap.exists()) throw new Error('Your account was not found.');
    if (!toSnap.exists())   throw new Error('Recipient account was not found.');

    const fromBalance = Number(fromSnap.data()[fromField] || 0);
    if (fromBalance < amount) throw new Error(`Insufficient funds in your ${fromAccountType} account.`);

    const newFromBalance = fromBalance - amount;
    const newToBalance   = Number((isSelfTransfer ? fromSnap : toSnap).data()[toField] || 0) + amount;

    if (isSelfTransfer) {
      tx.update(fromRef, { [fromField]: newFromBalance, [toField]: newToBalance, updatedAt: serverTimestamp() });
    } else {
      tx.update(fromRef, { [fromField]: newFromBalance, updatedAt: serverTimestamp() });
      tx.update(toRef,   { [toField]:   newToBalance,   updatedAt: serverTimestamp() });
    }
  });

  const now       = serverTimestamp();
  const fromSnap2 = await getDoc(fromRef);
  const fromData2 = fromSnap2.data();

  await addDoc(collection(db, 'bank_accounts', fromPid, 'transactions'), {
    type: isSelfTransfer ? 'internal_transfer' : 'transfer_out',
    accountType: fromAccountType,
    amount,
    balanceAfter: Number(fromData2[fromField] || 0),
    note: note || (isSelfTransfer ? `Transfer to ${toAccountType}` : `Transfer to ${toPid}`),
    toPid: isSelfTransfer ? fromPid : toPid,
    toAccountType,
    createdAt: now
  });

  if (!isSelfTransfer) {
    const toSnap2 = await getDoc(toRef);
    const toData2 = toSnap2.data();
    await addDoc(collection(db, 'bank_accounts', toPid, 'transactions'), {
      type: 'transfer_in',
      accountType: toAccountType,
      amount,
      balanceAfter: Number(toData2[toField] || 0),
      note: note || `Transfer from ${fromPid}`,
      fromPid,
      fromAccountType,
      createdAt: now
    });
  }
}

async function transferToSharedAccount({ fromPid, fromAccountType, sharedAccountId, amount, note, charData }) {
  const fromField  = fromAccountType === 'savings' ? 'savingsBalance' : 'checkingBalance';
  const fromRef    = doc(db, 'bank_accounts', fromPid);
  const sharedRef  = doc(db, 'shared_accounts', sharedAccountId);

  await runTransaction(db, async (tx) => {
    const fromSnap   = await tx.get(fromRef);
    const sharedSnap = await tx.get(sharedRef);

    if (!fromSnap.exists())   throw new Error('Your account was not found.');
    if (!sharedSnap.exists()) throw new Error('Shared account was not found.');

    const fromBalance = Number(fromSnap.data()[fromField] || 0);
    if (fromBalance < amount) throw new Error(`Insufficient funds in your ${fromAccountType} account.`);

    tx.update(fromRef,   { [fromField]: fromBalance - amount, updatedAt: serverTimestamp() });
    tx.update(sharedRef, { balance: Number(sharedSnap.data().balance || 0) + amount, updatedAt: serverTimestamp() });
  });

  const now       = serverTimestamp();
  const fromSnap2 = await getDoc(fromRef);

  await addDoc(collection(db, 'bank_accounts', fromPid, 'transactions'), {
    type: 'shared_deposit',
    accountType: fromAccountType,
    amount,
    balanceAfter: Number(fromSnap2.data()[fromField] || 0),
    note: note || 'Deposit to shared account',
    sharedAccountId,
    createdAt: now
  });

  await addDoc(collection(db, 'shared_accounts', sharedAccountId, 'transactions'), {
    type: 'transfer_in',
    amount,
    fromPid,
    fromName: charData?.name || fromPid,
    note: note || '',
    createdAt: now
  });
}

// ─────────────────────────────────────────────────────────
//  Shared accounts
// ─────────────────────────────────────────────────────────

let _currentManageAccountId = null;

async function loadSharedAccounts(pid, charEmail) {
  const container   = document.getElementById('sharedAccountsList');
  const sharedSelect = document.getElementById('transferSharedSelect');

  try {
    const ownedSnap  = await getDocs(query(collection(db, 'shared_accounts'), where('ownerPid', '==', pid)));
    const memberSnap = await getDocs(query(collection(db, 'shared_accounts'), where('memberPids', 'array-contains', pid)));

    const accounts = new Map();
    ownedSnap.forEach(d  => accounts.set(d.id, { id: d.id, ...d.data(), isOwner: true }));
    memberSnap.forEach(d => { if (!accounts.has(d.id)) accounts.set(d.id, { id: d.id, ...d.data(), isOwner: false }); });

    // Update shared dropdown in transfer panel
    if (sharedSelect) {
      sharedSelect.innerHTML = accounts.size === 0
        ? '<option value="">No shared accounts available</option>'
        : '';
      accounts.forEach(acct => {
        const opt = document.createElement('option');
        opt.value = acct.id;
        opt.textContent = `${acct.name} (${formatCurrency(acct.balance || 0)})`;
        sharedSelect.appendChild(opt);
      });
    }

    if (!container) return;

    if (accounts.size === 0) {
      container.innerHTML = '<p class="bank-muted">You have no shared accounts. Create one to get started.</p>';
      return;
    }

    let html = '';
    accounts.forEach(acct => {
      const members        = acct.members || [];
      const pendingInvites = acct.pendingInvites || [];
      const memberNames    = members.map(m => `<span class="member-tag"><i class="fas fa-user"></i> ${m.name || m.pid}</span>`).join('');
      const ownerBadge     = acct.isOwner
        ? '<span class="bank-pill" style="font-size:0.7rem;padding:0.15rem 0.5rem;margin-left:0.4rem;">Owner</span>'
        : '';
      const pendingBadge = pendingInvites.length > 0
        ? `<span style="font-size:0.78rem;color:#9d8df8;margin-left:0.4rem;">${pendingInvites.length} pending invite${pendingInvites.length !== 1 ? 's' : ''}</span>`
        : '';

      html += `
        <div class="shared-account-card">
          <div class="shared-account-header">
            <div>
              <span class="shared-account-name">${safeText(acct.name)}</span>
              ${ownerBadge}${pendingBadge}
            </div>
            <div class="shared-account-balance">${formatCurrency(acct.balance || 0)}</div>
          </div>
          <div class="shared-account-meta">
            ${members.length + 1} member${members.length + 1 !== 1 ? 's' : ''} · Owner: ${safeText(acct.ownerName)}
          </div>
          <div style="margin-bottom:0.6rem;">${memberNames || '<span class="bank-muted" style="font-size:0.82rem;">No other members yet.</span>'}</div>
          <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">
            <button class="bank-btn-sm" onclick="window._bankTransferToShared('${acct.id}')">
              <i class="fas fa-arrow-up" style="margin-right:0.3rem;"></i>Deposit Into
            </button>
            <button class="bank-btn-sm ghost" onclick="window._bankWithdrawFromShared('${acct.id}')">
              <i class="fas fa-arrow-down" style="margin-right:0.3rem;"></i>Withdraw From
            </button>
            ${acct.isOwner ? `<button class="bank-btn-sm ghost" onclick="window._bankManageShared('${acct.id}')"><i class="fas fa-cog" style="margin-right:0.3rem;"></i>Manage</button>` : ''}
          </div>
        </div>`;
    });

    container.innerHTML = html;
  } catch (err) {
    console.error('Failed to load shared accounts:', err);
    if (container) container.innerHTML = '<p class="bank-muted">Unable to load shared accounts.</p>';
  }
}

async function loadPendingInvites(charEmail) {
  if (!charEmail) return;
  const container = document.getElementById('pendingInvites');
  if (!container) return;

  try {
    const inviteSnap = await getDocs(query(
      collection(db, 'shared_accounts'),
      where('pendingInvites', 'array-contains', charEmail)
    ));

    container.innerHTML = '';

    inviteSnap.forEach(docSnap => {
      const acct = docSnap.data();
      const banner = document.createElement('div');
      banner.className = 'bank-invite-banner';
      banner.innerHTML = `
        <div class="bank-invite-text">
          You've been invited to join the shared account <strong>${safeText(acct.name)}</strong>
          by <strong>${safeText(acct.ownerName)}</strong>.
        </div>
        <div class="bank-invite-actions">
          <button class="bank-btn-sm" id="accept_${docSnap.id}">Accept</button>
          <button class="bank-btn-sm danger" id="decline_${docSnap.id}">Decline</button>
        </div>`;

      banner.querySelector(`#accept_${docSnap.id}`).addEventListener('click', async () => {
        await acceptSharedInvite(docSnap.id, charEmail, window._bankCurrentChar);
        banner.remove();
        const pid = _currentPid;
        if (pid) await loadSharedAccounts(pid, charEmail);
      });

      banner.querySelector(`#decline_${docSnap.id}`).addEventListener('click', async () => {
        await declineSharedInvite(docSnap.id, charEmail);
        banner.remove();
      });

      container.appendChild(banner);
    });
  } catch (err) {
    console.error('Failed to load pending invites:', err);
  }
}

async function acceptSharedInvite(accountId, charEmail, charData) {
  const sharedRef = doc(db, 'shared_accounts', accountId);
  await updateDoc(sharedRef, {
    pendingInvites: arrayRemove(charEmail),
    members:        arrayUnion({ pid: charData?.pid || '', name: charData?.name || '', email: charEmail }),
    memberPids:     arrayUnion(charData?.pid || ''),
    updatedAt:      serverTimestamp()
  });
}

async function declineSharedInvite(accountId, charEmail) {
  await updateDoc(doc(db, 'shared_accounts', accountId), {
    pendingInvites: arrayRemove(charEmail),
    updatedAt:      serverTimestamp()
  });
}

async function createSharedAccount(name, charData) {
  await addDoc(collection(db, 'shared_accounts'), {
    name:           name.trim(),
    balance:        0,
    ownerPid:       charData.pid,
    ownerName:      charData.name || charData.pid,
    members:        [],
    memberPids:     [],
    pendingInvites: [],
    createdAt:      serverTimestamp(),
    updatedAt:      serverTimestamp()
  });
}

async function refreshManageModal(accountId) {
  const snap = await getDoc(doc(db, 'shared_accounts', accountId));
  if (!snap.exists()) return;

  const acct      = snap.data();
  const titleEl   = document.getElementById('sharedManageTitle');
  const balanceEl = document.getElementById('sharedManageBalance');
  const membersEl = document.getElementById('sharedManageMembers');

  if (titleEl)   titleEl.textContent   = safeText(acct.name);
  if (balanceEl) balanceEl.textContent = formatCurrency(acct.balance || 0);

  if (membersEl) {
    const members        = acct.members || [];
    const pendingInvites = acct.pendingInvites || [];

    let html = `<div class="member-tag"><i class="fas fa-crown"></i> ${safeText(acct.ownerName)} (Owner)</div>`;
    members.forEach(m => {
      html += `<div class="member-tag"><i class="fas fa-user"></i> ${m.name || m.pid}</div>`;
    });
    if (pendingInvites.length > 0) {
      html += '<div style="margin-top:0.5rem;font-size:0.8rem;color:var(--muted);">Pending invites:</div>';
      pendingInvites.forEach(email => {
        html += `<div class="member-tag" style="opacity:0.6;"><i class="fas fa-clock"></i> ${email}</div>`;
      });
    }
    membersEl.innerHTML = html;
  }
}

// ─────────────────────────────────────────────────────────
//  Main page load
// ─────────────────────────────────────────────────────────

let _currentPid = null;
window._bankCurrentChar = null;

async function loadBankAccount(charData, user) {
  const bankContainer     = document.getElementById('bankContainer');
  const authRequired      = document.getElementById('authRequired');
  const characterRequired = document.getElementById('characterRequired');

  if (authRequired)      authRequired.style.display = 'none';
  if (characterRequired) characterRequired.style.display = 'none';

  if (!charData || !charData.pid) {
    if (characterRequired) characterRequired.style.display = 'block';
    return;
  }

  const account = await ensureBankAccount(charData, user);
  if (!account) {
    if (characterRequired) characterRequired.style.display = 'block';
    return;
  }

  const accountData = account.data || {};
  _currentPid = String(charData.pid).trim();
  window._bankCurrentChar = { ...charData, pid: _currentPid };

  if (bankContainer) bankContainer.style.display = 'block';

  // Hero
  document.getElementById('bankCharacterName').textContent = safeText(charData.name, 'Character Account');
  document.getElementById('bankCharacterMeta').textContent =
    `${safeText(charData.pid)} | ${safeText(charData.department)} | ${safeText(charData.rank)}`;
  document.getElementById('bankRoutingNumber').textContent  = safeText(accountData.routingNumber, 'Generating...');
  document.getElementById('bankBalanceUpdated').textContent = `Last updated: ${formatDate(accountData.updatedAt)}`;
  document.getElementById('bankPayAmount').textContent      = `Pay amount: ${formatCurrency(accountData.recurring?.amount || 0)}`;

  // Account balances
  document.getElementById('checkingBalance').textContent = formatCurrency(accountData.checkingBalance || 0);
  document.getElementById('savingsBalance').textContent  = formatCurrency(accountData.savingsBalance  || 0);

  // Account details
  document.getElementById('bankAccountPid').textContent  = `PID: ${safeText(accountData.pid)}`;
  document.getElementById('bankAccountDept').textContent = `Department: ${safeText(accountData.department)}`;
  document.getElementById('bankAccountRank').textContent = `Rank: ${safeText(accountData.rank)}`;
  document.getElementById('bankAccountUid').textContent  = `Linked UID: ${safeText(accountData.linkedUID)}`;

  // Mailbox email
  const notifyInput = document.getElementById('bankNotifyEmail');
  let charEmail = '';
  if (notifyInput) {
    try { charEmail = await resolveCharacterEmail(charData); notifyInput.value = charEmail; }
    catch { notifyInput.value = ''; }
  }

  // Deductions
  renderDeductions(accountData);
  renderCreditStatus(accountData);

  // Shared accounts & invites
  await loadSharedAccounts(_currentPid, charEmail);
  await loadPendingInvites(charEmail);

  // Transactions
  await loadTransactions(_currentPid, 'all');

  // Wire up UI
  initTabs();
  initTransferPanel(accountData, charData, charEmail);
  initSharedPanel(charData, charEmail);
}

// ─────────────────────────────────────────────────────────
//  Tabs
// ─────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.bank-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.bank-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.bank-tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panelId = `tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`;
      document.getElementById(panelId)?.classList.add('active');
    });
  });

  document.getElementById('txAccountFilter')?.addEventListener('change', e => {
    if (_currentPid) loadTransactions(_currentPid, e.target.value);
  });
}

// ─────────────────────────────────────────────────────────
//  Transfer panel
// ─────────────────────────────────────────────────────────

function initTransferPanel(accountData, charData, charEmail) {
  const destTypeSelect   = document.getElementById('transferDestType');
  const personFields     = document.getElementById('transferPersonFields');
  const sharedField      = document.getElementById('transferSharedField');
  const lookupBtn        = document.getElementById('transferLookupBtn');
  const recipientIdInput = document.getElementById('transferRecipientId');
  const recipientPreview = document.getElementById('transferRecipientPreview');
  const submitBtn        = document.getElementById('transferSubmitBtn');
  const statusEl         = document.getElementById('transferStatus');

  let lookupResult = null;

  function updateDestUI() {
    const val = destTypeSelect?.value;
    personFields.style.display = val === 'person' ? 'block' : 'none';
    sharedField.style.display  = val === 'shared' ? 'block' : 'none';
    lookupBtn.style.display    = val === 'person' ? 'inline-block' : 'none';
    lookupResult = null;
    if (recipientPreview) { recipientPreview.textContent = ''; recipientPreview.classList.remove('visible'); }
    clearStatus(statusEl);
  }

  destTypeSelect?.addEventListener('change', updateDestUI);
  updateDestUI();

  lookupBtn?.addEventListener('click', async () => {
    clearStatus(statusEl);
    const id = recipientIdInput?.value?.trim();
    if (!id) { showStatus(statusEl, 'Enter a PID or routing number.', 'error'); return; }

    lookupBtn.disabled = true;
    lookupBtn.textContent = 'Looking up...';

    try {
      const result = await findAccountByIdentifier(id);
      if (!result) {
        showStatus(statusEl, 'No account found for that PID or routing number.', 'error');
        lookupResult = null;
        if (recipientPreview) { recipientPreview.textContent = ''; recipientPreview.classList.remove('visible'); }
      } else if (result.pid === _currentPid) {
        showStatus(statusEl, 'You cannot transfer to yourself this way. Use "My Other Account" instead.', 'error');
        lookupResult = null;
      } else {
        lookupResult = result;
        if (recipientPreview) {
          recipientPreview.textContent = `✓ Found: ${result.name || result.pid} (${result.department || 'Unknown dept'}) — Routing: ${result.routingNumber || result.pid}`;
          recipientPreview.classList.add('visible');
        }
        clearStatus(statusEl);
      }
    } catch (err) {
      showStatus(statusEl, 'Lookup failed. Please try again.', 'error');
    } finally {
      lookupBtn.disabled = false;
      lookupBtn.textContent = 'Look Up Recipient';
    }
  });

  submitBtn?.addEventListener('click', async () => {
    clearStatus(statusEl);
    const destType    = destTypeSelect?.value;
    const fromAccount = document.getElementById('transferFromAccount')?.value || 'checking';
    const amountRaw   = parseFloat(document.getElementById('transferAmount')?.value || '0');
    const note        = document.getElementById('transferNote')?.value?.trim() || '';

    if (!amountRaw || amountRaw <= 0) {
      showStatus(statusEl, 'Enter a valid amount greater than $0.', 'error');
      return;
    }

    const fromBalance = fromAccount === 'savings'
      ? Number(accountData.savingsBalance || 0)
      : Number(accountData.checkingBalance || 0);

    if (amountRaw > fromBalance) {
      showStatus(statusEl, `Insufficient funds. Your ${fromAccount} balance is ${formatCurrency(fromBalance)}.`, 'error');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Processing...';

    try {
      if (destType === 'self') {
        const toAccount = fromAccount === 'checking' ? 'savings' : 'checking';
        await transferBetweenAccounts({
          fromPid: _currentPid, fromAccountType: fromAccount,
          toPid: _currentPid,   toAccountType: toAccount,
          amount: amountRaw, note, isSelfTransfer: true
        });
        showStatus(statusEl, `Moved ${formatCurrency(amountRaw)} from ${fromAccount} to ${toAccount}.`, 'success');

      } else if (destType === 'person') {
        if (!lookupResult) {
          showStatus(statusEl, 'Look up a recipient first.', 'error');
          submitBtn.disabled = false; submitBtn.textContent = 'Transfer';
          return;
        }
        const toAccount = document.getElementById('transferToAccount')?.value || 'checking';
        await transferBetweenAccounts({
          fromPid: _currentPid, fromAccountType: fromAccount,
          toPid: lookupResult.pid, toAccountType: toAccount,
          amount: amountRaw, note
        });
        showStatus(statusEl, `Transferred ${formatCurrency(amountRaw)} to ${lookupResult.name || lookupResult.pid}.`, 'success');

      } else if (destType === 'shared') {
        const sharedId = document.getElementById('transferSharedSelect')?.value;
        if (!sharedId) { showStatus(statusEl, 'Select a shared account.', 'error'); submitBtn.disabled = false; submitBtn.textContent = 'Transfer'; return; }
        await transferToSharedAccount({
          fromPid: _currentPid, fromAccountType: fromAccount,
          sharedAccountId: sharedId, amount: amountRaw, note, charData
        });
        showStatus(statusEl, `Deposited ${formatCurrency(amountRaw)} into the shared account.`, 'success');
      }

      // Refresh balances
      const refreshed = await getDoc(doc(db, 'bank_accounts', _currentPid));
      if (refreshed.exists()) {
        const d = refreshed.data();
        accountData.checkingBalance = d.checkingBalance;
        accountData.savingsBalance  = d.savingsBalance;
        accountData.overdueDeductionsBalance = d.overdueDeductionsBalance || 0;
        accountData.creditScore = d.creditScore || 0;
        accountData.creditFactors = d.creditFactors || {};
        document.getElementById('checkingBalance').textContent   = formatCurrency(d.checkingBalance || 0);
        document.getElementById('savingsBalance').textContent    = formatCurrency(d.savingsBalance  || 0);
        document.getElementById('bankBalanceUpdated').textContent = `Last updated: ${formatDate(d.updatedAt)}`;
        renderCreditStatus(accountData);
        renderDeductions(accountData);
      }

      await loadTransactions(_currentPid, document.getElementById('txAccountFilter')?.value || 'all');
      await loadSharedAccounts(_currentPid, charEmail);

    } catch (err) {
      console.error('Transfer failed:', err);
      showStatus(statusEl, err.message || 'Transfer failed. Please try again.', 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Transfer';
    }
  });
}

// ─────────────────────────────────────────────────────────
//  Shared accounts panel
// ─────────────────────────────────────────────────────────

function initSharedPanel(charData, charEmail) {
  const createBtn        = document.getElementById('createSharedBtn');
  const createModal      = document.getElementById('createSharedModal');
  const createCancelBtn  = document.getElementById('createSharedCancelBtn');
  const createConfirmBtn = document.getElementById('createSharedConfirmBtn');
  const createNameInput  = document.getElementById('sharedAccountName');
  const createStatus     = document.getElementById('createSharedStatus');

  const manageModal      = document.getElementById('sharedManageModal');
  const manageCloseBtn   = document.getElementById('sharedManageCloseBtn');
  const manageOverlay    = document.getElementById('sharedManageOverlay');
  const inviteSendBtn    = document.getElementById('sharedInviteSendBtn');
  const inviteEmailInput = document.getElementById('sharedInviteEmail');
  const inviteStatus     = document.getElementById('sharedInviteStatus');

  const depositBtn        = document.getElementById('sharedDepositBtn');
  const depositAmount     = document.getElementById('sharedDepositAmount');
  const depositAccountType = document.getElementById('sharedDepositAccountType');
  const depositStatus     = document.getElementById('sharedDepositStatus');

  createBtn?.addEventListener('click', () => {
    if (createNameInput) createNameInput.value = '';
    clearStatus(createStatus);
    if (createModal) createModal.style.display = 'block';
  });

  createCancelBtn?.addEventListener('click', () => { if (createModal) createModal.style.display = 'none'; });

  createConfirmBtn?.addEventListener('click', async () => {
    clearStatus(createStatus);
    const name = createNameInput?.value?.trim();
    if (!name) { showStatus(createStatus, 'Please enter an account name.', 'error'); return; }

    createConfirmBtn.disabled = true;
    createConfirmBtn.textContent = 'Creating...';

    try {
      await createSharedAccount(name, charData);
      showStatus(createStatus, 'Shared account created!', 'success');
      await loadSharedAccounts(_currentPid, charEmail);
      setTimeout(() => { if (createModal) createModal.style.display = 'none'; }, 1000);
    } catch (err) {
      console.error(err);
      showStatus(createStatus, 'Failed to create account. Try again.', 'error');
    } finally {
      createConfirmBtn.disabled = false;
      createConfirmBtn.textContent = 'Create Account';
    }
  });

  manageCloseBtn?.addEventListener('click', () => { if (manageModal) manageModal.style.display = 'none'; });
  manageOverlay?.addEventListener('click', e => { if (e.target === manageOverlay && manageModal) manageModal.style.display = 'none'; });

  inviteSendBtn?.addEventListener('click', async () => {
    clearStatus(inviteStatus);
    const email = inviteEmailInput?.value?.trim().toLowerCase();
    if (!email || !email.includes('@')) { showStatus(inviteStatus, 'Enter a valid email address.', 'error'); return; }
    if (!_currentManageAccountId) return;

    inviteSendBtn.disabled = true;
    inviteSendBtn.textContent = 'Sending...';

    try {
      await updateDoc(doc(db, 'shared_accounts', _currentManageAccountId), {
        pendingInvites: arrayUnion(email),
        updatedAt: serverTimestamp()
      });
      showStatus(inviteStatus, `Invite sent to ${email}.`, 'success');
      if (inviteEmailInput) inviteEmailInput.value = '';
      await refreshManageModal(_currentManageAccountId);
    } catch (err) {
      console.error(err);
      showStatus(inviteStatus, 'Failed to send invite. Try again.', 'error');
    } finally {
      inviteSendBtn.disabled = false;
      inviteSendBtn.textContent = 'Invite';
    }
  });

  depositBtn?.addEventListener('click', async () => {
    clearStatus(depositStatus);
    const amount = parseAmount(depositAmount?.value);
    if (amount <= 0) { showStatus(depositStatus, 'Enter a valid amount.', 'error'); return; }
    if (!_currentManageAccountId) return;
    if (!charData?.pid) { showStatus(depositStatus, 'Character data is missing.', 'error'); return; }

    depositBtn.disabled = true;
    depositBtn.textContent = 'Transferring...';

    try {
      const accountType = depositAccountType?.value || 'checking';
      await transferToSharedAccount({
        fromPid: _currentPid,
        fromAccountType: accountType,
        sharedAccountId: _currentManageAccountId,
        amount,
        note: '',
        charData
      });
      showStatus(depositStatus, `Transferred ${formatCurrency(amount)} to shared account.`, 'success');
      if (depositAmount) depositAmount.value = '';
      
      // Refresh balances
      const refreshed = await getDoc(doc(db, 'bank_accounts', _currentPid));
      if (refreshed.exists()) {
        const d = refreshed.data();
        accountData.checkingBalance = d.checkingBalance;
        accountData.savingsBalance  = d.savingsBalance;
        accountData.overdueDeductionsBalance = d.overdueDeductionsBalance || 0;
        accountData.creditScore = d.creditScore || 0;
        accountData.creditFactors = d.creditFactors || {};
        document.getElementById('checkingBalance').textContent   = formatCurrency(d.checkingBalance || 0);
        document.getElementById('savingsBalance').textContent    = formatCurrency(d.savingsBalance  || 0);
        renderCreditStatus(accountData);
        renderDeductions(accountData);
      }
      
      await refreshManageModal(_currentManageAccountId);
      await loadSharedAccounts(_currentPid, charEmail);
    } catch (err) {
      console.error(err);
      showStatus(depositStatus, err.message || 'Transfer failed. Try again.', 'error');
    } finally {
      depositBtn.disabled = false;
      depositBtn.textContent = 'Transfer';
    }
  });

  const withdrawBtn = document.getElementById('withdrawFromSharedBtn');
  const withdrawAmount = document.getElementById('withdrawFromSharedAmount');
  const withdrawAccountType = document.getElementById('withdrawFromSharedAccountType');
  const withdrawStatus = document.getElementById('withdrawFromSharedStatus');
  const withdrawModal = document.getElementById('sharedWithdrawModal');
  const withdrawOverlay = document.getElementById('withdrawFromSharedOverlay');

  withdrawBtn?.addEventListener('click', async () => {
    clearStatus(withdrawStatus);
    const sharedAccountId = withdrawBtn._sharedAccountId;
    const amount = parseAmount(withdrawAmount?.value);
    if (amount <= 0) { showStatus(withdrawStatus, 'Enter a valid amount.', 'error'); return; }
    if (!sharedAccountId) { showStatus(withdrawStatus, 'Shared account not found.', 'error'); return; }
    if (!charData?.pid) { showStatus(withdrawStatus, 'Character data is missing.', 'error'); return; }

    withdrawBtn.disabled = true;
    withdrawBtn.textContent = 'Withdrawing...';

    try {
      const accountType = withdrawAccountType?.value || 'checking';
      const sharedSnap = await getDoc(doc(db, 'shared_accounts', sharedAccountId));
      if (!sharedSnap.exists()) throw new Error('Shared account not found.');
      const sharedData = sharedSnap.data();
      if ((sharedData.balance || 0) < amount) throw new Error('Insufficient balance in shared account.');

      // Withdraw from shared to personal
      await runTransaction(db, async (tx) => {
        const personalRef = doc(db, 'bank_accounts', _currentPid);
        const sharedRef = doc(db, 'shared_accounts', sharedAccountId);
        const acctField = accountType === 'savings' ? 'savingsBalance' : 'checkingBalance';

        const personalSnap = await tx.get(personalRef);
        const personalData = personalSnap.data();
        const personalPrevBal = Number(personalData?.[acctField] ?? 0);
        const personalNewBal = personalPrevBal + amount;

        const sharedPrevBal = Number(sharedData?.balance || 0);
        const sharedNewBal = sharedPrevBal - amount;

        tx.set(personalRef, { [acctField]: personalNewBal, updatedAt: serverTimestamp() }, { merge: true });
        tx.set(doc(collection(db, 'bank_accounts', _currentPid, 'transactions')), {
          type: 'withdrawal_from_shared',
          accountType,
          amount,
          note: `Withdrawal from shared account: ${sharedData.name}`,
          createdAt: serverTimestamp(),
          createdByUid: auth.currentUser?.uid || '',
          balanceAfter: personalNewBal
        });

        tx.set(sharedRef, { balance: sharedNewBal, updatedAt: serverTimestamp() }, { merge: true });
        tx.set(doc(collection(db, 'shared_accounts', sharedAccountId, 'transactions')), {
          type: 'withdrawal',
          amount,
          note: `Withdrawal by ${charData.name} (${_currentPid})`,
          createdAt: serverTimestamp(),
          createdByUid: auth.currentUser?.uid || '',
          balanceAfter: sharedNewBal
        });
      });

      showStatus(withdrawStatus, `Withdrawn ${formatCurrency(amount)} from shared account.`, 'success');
      if (withdrawAmount) withdrawAmount.value = '';
      
      // Refresh balances and close modal after delay
      const refreshed = await getDoc(doc(db, 'bank_accounts', _currentPid));
      if (refreshed.exists()) {
        const d = refreshed.data();
        accountData.checkingBalance = d.checkingBalance;
        accountData.savingsBalance  = d.savingsBalance;
        accountData.overdueDeductionsBalance = d.overdueDeductionsBalance || 0;
        accountData.creditScore = d.creditScore || 0;
        accountData.creditFactors = d.creditFactors || {};
        document.getElementById('checkingBalance').textContent   = formatCurrency(d.checkingBalance || 0);
        document.getElementById('savingsBalance').textContent    = formatCurrency(d.savingsBalance  || 0);
        renderCreditStatus(accountData);
        renderDeductions(accountData);
      }
      
      await loadSharedAccounts(_currentPid, charEmail);
      setTimeout(() => { if (withdrawModal) withdrawModal.style.display = 'none'; }, 1000);
    } catch (err) {
      console.error(err);
      showStatus(withdrawStatus, err.message || 'Withdrawal failed. Try again.', 'error');
    } finally {
      withdrawBtn.disabled = false;
      withdrawBtn.textContent = 'Withdraw';
    }
  });

  withdrawOverlay?.addEventListener('click', e => { if (e.target === withdrawOverlay && withdrawModal) withdrawModal.style.display = 'none'; });

  window._bankManageShared = async (accountId) => {
    _currentManageAccountId = accountId;
    clearStatus(inviteStatus);
    if (inviteEmailInput) inviteEmailInput.value = '';
    await refreshManageModal(accountId);
    if (manageModal) manageModal.style.display = 'block';
  };

  window._bankTransferToShared = (accountId) => {
    document.querySelectorAll('.bank-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.bank-tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector('.bank-tab[data-tab="transfer"]')?.classList.add('active');
    document.getElementById('tabTransfer')?.classList.add('active');

    const destTypeSelect = document.getElementById('transferDestType');
    if (destTypeSelect) { destTypeSelect.value = 'shared'; destTypeSelect.dispatchEvent(new Event('change')); }
    const sharedSelect = document.getElementById('transferSharedSelect');
    if (sharedSelect) sharedSelect.value = accountId;
  };

  window._bankWithdrawFromShared = (accountId) => {
    const modal = document.getElementById('sharedWithdrawModal');
    if (!modal) return;
    
    const withdrawInput = document.getElementById('withdrawFromSharedAmount');
    const accountTypeSelect = document.getElementById('withdrawFromSharedAccountType');
    const withdrawBtn = document.getElementById('withdrawFromSharedBtn');
    const statusEl = document.getElementById('withdrawFromSharedStatus');
    
    if (withdrawInput) withdrawInput.value = '';
    if (accountTypeSelect) accountTypeSelect.value = 'checking';
    if (statusEl) statusEl.textContent = '';
    
    // Store the shared account ID for the withdrawal
    withdrawBtn._sharedAccountId = accountId;
    withdrawBtn._charEmail = charEmail;
    
    modal.style.display = 'block';
  };
}

// ─────────────────────────────────────────────────────────
//  Auth + character validation
// ─────────────────────────────────────────────────────────

async function validateSelectedCharacter(user) {
  const stored = localStorage.getItem('selectedCharacter');
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !parsed.id) return null;

    const charRef  = doc(db, 'characters', parsed.id);
    const snap     = await getDoc(charRef);
    if (!snap.exists()) return null;

    const charData = snap.data();
    if (!charData || charData.linkedUID !== user.uid) return null;

    return { ...charData, id: parsed.id };
  } catch (err) {
    console.error('Failed to parse selected character:', err);
    return null;
  }
}

function initBankPage() {
  const authRequired      = document.getElementById('authRequired');
  const characterRequired = document.getElementById('characterRequired');

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      if (authRequired) authRequired.style.display = 'block';
      return;
    }

    const charData = await validateSelectedCharacter(user);
    if (!charData) {
      if (characterRequired) characterRequired.style.display = 'block';
      return;
    }

    await loadBankAccount(charData, user);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('includesLoaded', initBankPage);
} else {
  initBankPage();
}
