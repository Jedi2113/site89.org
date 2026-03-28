import { app, auth, onAuthStateChanged } from "/assets/js/auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  query,
  orderBy,
  limit,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

function formatCurrency(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function formatDate(ts) {
  if (!ts) return '--';
  try {
    const date = ts.toDate ? ts.toDate() : new Date(ts);
    return date.toLocaleString();
  } catch (err) {
    return '--';
  }
}

function safeText(value, fallback = '--') {
  const text = (value || '').toString().trim();
  return text ? text : fallback;
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

async function loadTransactions(pid) {
  const target = document.getElementById('bankTransactions');
  if (!target) return;

  try {
    const txRef = collection(db, 'bank_accounts', pid, 'transactions');
    const txQuery = query(txRef, orderBy('createdAt', 'desc'), limit(25));
    const snap = await getDocs(txQuery);

    if (snap.empty) {
      target.textContent = 'No transactions yet.';
      return;
    }

    const table = document.createElement('table');
    table.className = 'bank-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Type', 'Amount', 'Balance', 'Date', 'Note'].forEach(label => {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    snap.forEach(docSnap => {
      const tx = docSnap.data() || {};
      const row = document.createElement('tr');
      const cells = [
        safeText(tx.type, 'unknown'),
        formatCurrency(tx.amount),
        formatCurrency(tx.balanceAfter),
        formatDate(tx.createdAt),
        safeText(tx.note, '')
      ];
      cells.forEach(cellValue => {
        const td = document.createElement('td');
        td.textContent = cellValue;
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

async function ensureBankAccount(charData, user) {
  if (!charData || !charData.pid) return null;
  const pid = String(charData.pid).trim();
  if (!pid) return null;

  const accountRef = doc(db, 'bank_accounts', pid);
  const snap = await getDoc(accountRef);

  if (snap.exists()) return { ref: accountRef, data: snap.data() };

  const payload = {
    pid,
    name: charData.name || '',
    department: charData.department || '',
    rank: charData.rank || '',
    linkedUID: user.uid,
    notifyEmail: user.email || '',
    balance: 0,
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

async function loadBankAccount(charData, user) {
  const bankContainer = document.getElementById('bankContainer');
  const authRequired = document.getElementById('authRequired');
  const characterRequired = document.getElementById('characterRequired');

  if (authRequired) authRequired.style.display = 'none';
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
  if (bankContainer) bankContainer.style.display = 'block';

  document.getElementById('bankCharacterName').textContent = safeText(charData.name, 'Character Account');
  document.getElementById('bankCharacterMeta').textContent = `${safeText(charData.pid)} | ${safeText(charData.department)} | ${safeText(charData.rank)}`;
  document.getElementById('bankBalance').textContent = formatCurrency(accountData.balance);
  document.getElementById('bankBalanceUpdated').textContent = `Last updated: ${formatDate(accountData.updatedAt)}`;

  document.getElementById('bankPayAmount').textContent = `Pay amount: ${formatCurrency(accountData.recurring?.amount || 0)}`;

  document.getElementById('bankAccountPid').textContent = `PID: ${safeText(accountData.pid)}`;
  document.getElementById('bankAccountDept').textContent = `Department: ${safeText(accountData.department)}`;
  document.getElementById('bankAccountRank').textContent = `Rank: ${safeText(accountData.rank)}`;
  document.getElementById('bankAccountUid').textContent = `Linked UID: ${safeText(accountData.linkedUID)}`;

  const notifyInput = document.getElementById('bankNotifyEmail');
  if (notifyInput) {
    try {
      notifyInput.value = await resolveCharacterEmail(charData);
    } catch (err) {
      notifyInput.value = '';
    }
  }

  await loadTransactions(String(charData.pid).trim());
}

async function validateSelectedCharacter(user) {
  const stored = localStorage.getItem('selectedCharacter');
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !parsed.id) return null;

    const charRef = doc(db, 'characters', parsed.id);
    const snap = await getDoc(charRef);
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
  const authRequired = document.getElementById('authRequired');
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
