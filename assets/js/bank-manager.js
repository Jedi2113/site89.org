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
  serverTimestamp,
  Timestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

let allCharacters = [];
let bankAccounts = new Map();
let activeCharacter = null;

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

  const snap = await getDocs(collection(db, 'characters'));
  const raw = [];
  snap.forEach(docSnap => {
    const data = docSnap.data();
    if (data && data.name) raw.push(data);
  });

  raw.sort((a, b) => {
    const aName = (a.name || '').toLowerCase();
    const bName = (b.name || '').toLowerCase();
    if (aName !== bName) return aName.localeCompare(bName);
    const aPid = (a.pid || '').toString();
    const bPid = (b.pid || '').toString();
    return aPid.localeCompare(bPid);
  });

  const counts = new Map();
  const entries = raw.map(char => {
    const baseLocal = baseLocalFromName(char.name);
    const email = makeUniqueEmail(baseLocal, counts);
    return {
      email,
      baseLocal,
      pid: char.pid ? String(char.pid) : '',
      department: char.department || '',
      name: char.name || ''
    };
  }).filter(entry => !!entry.email);

  const byPid = new Map();
  const byBase = new Map();
  entries.forEach(entry => {
    if (entry.pid) byPid.set(entry.pid, entry.email);
    const list = byBase.get(entry.baseLocal) || [];
    list.push(entry);
    byBase.set(entry.baseLocal, list);
  });

  const baseLocal = baseLocalFromName(targetChar.name);
  const pidKey = targetChar.pid ? String(targetChar.pid) : '';
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);

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
  const nextPay = account?.recurring?.nextPayAt?.toDate ? account.recurring.nextPayAt.toDate() : null;
  document.getElementById('nextPayInput').value = nextPay ? nextPay.toISOString().slice(0, 10) : '';
  document.getElementById('payEnabledInput').checked = !!account?.recurring?.enabled;

  const feedback = document.getElementById('modalFeedback');
  if (feedback) feedback.textContent = '';
}

function showModalFeedback(message, type) {
  const feedback = document.getElementById('modalFeedback');
  if (!feedback) return;
  feedback.textContent = message;
  feedback.className = `feedback ${type}`;
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
        intervalDays: 14,
        nextPayAt: null,
        lastPayAt: null
      };
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

  // Send notification email after transaction completes
  await sendBankNotification(char, type, amount, finalBalance, note);
}

async function forcePayrollNow(char) {
  const pid = String(char.pid || '').trim();
  const accountRef = doc(db, 'bank_accounts', pid);
  const txRef = doc(collection(db, 'bank_accounts', pid, 'transactions'));
  const actorName = auth.currentUser?.email || 'system';
  let finalBalance = 0;
  let payAmount = 0;

  await runTransaction(db, async (tx) => {
    const accSnap = await tx.get(accountRef);
    const existing = accSnap.exists() ? accSnap.data() : null;

    const inputAmount = parseAmount(document.getElementById('payAmountInput').value);
    const amount = inputAmount || Number(existing?.recurring?.amount || 0);
    if (!amount || amount <= 0) {
      throw new Error('Payroll amount must be greater than 0. Set a pay amount first.');
    }

    payAmount = amount;

    const intervalDays = Number(existing?.recurring?.intervalDays || 14);
    const now = new Date();
    const nextPayAt = Timestamp.fromDate(new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000));

    const previousBalance = Number(existing?.balance || 0);
    const newBalance = previousBalance + amount;
    finalBalance = newBalance;

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
        intervalDays,
        nextPayAt,
        lastPayAt: serverTimestamp()
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

  // Send notification email after payroll completes
  await sendBankNotification(char, 'payroll', payAmount, finalBalance, 'Manual payroll payout');
}

async function savePayrollSettings(char) {
  const pid = String(char.pid || '').trim();
  const amountValue = parseAmount(document.getElementById('payAmountInput').value);
  const enabled = document.getElementById('payEnabledInput').checked;
  const nextPayRaw = document.getElementById('nextPayInput').value;
  if (enabled && (!amountValue || amountValue <= 0)) {
    throw new Error('Payroll amount must be greater than 0.');
  }

  let nextPayAt = null;
  if (nextPayRaw) {
    nextPayAt = Timestamp.fromDate(new Date(`${nextPayRaw}T00:00:00`));
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
      intervalDays: 14,
      nextPayAt,
      lastPayAt: null
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

  document.getElementById('bankModal').addEventListener('click', (event) => {
    if (event.target.id === 'bankModal') {
      window.closeBankModal();
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
      const charQuery = query(collection(db, 'characters'), where('linkedUID', '==', user.uid));
      const charSnap = await getDocs(charQuery);
      let allowed = isSiteDirectorEmail(user);
      charSnap.forEach(docSnap => {
        const char = docSnap.data();
        if (hasBankAccess(char)) allowed = true;
      });

      if (!allowed) {
        accessDenied.style.display = 'block';
        return;
      }

      management.style.display = 'block';
      await loadCharactersAndAccounts();
      wireFilters();
      wireModalActions();
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
