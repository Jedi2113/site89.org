const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

admin.initializeApp();

const db = admin.firestore();

function formatCurrency(value) {
  const num = Number(value || 0);
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(num);
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
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

async function resolveCharacterEmail(account) {
  if (!account || !account.name) return '';

  const snap = await db.collection('characters').get();
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

  const baseLocal = baseLocalFromName(account.name);
  const pidKey = account.pid ? String(account.pid) : '';
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);

  const bucket = byBase.get(baseLocal);
  if (bucket && bucket.length) {
    if (bucket.length === 1) return bucket[0].email;
    const dept = (account.department || '').toLowerCase();
    const match = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return match ? match.email : bucket[0].email;
  }

  const snapshotCount = (counts.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

exports.processPayroll = onSchedule('every day 06:00', async () => {
  const now = admin.firestore.Timestamp.now();
  const snap = await db
    .collection('bank_accounts')
    .where('recurring.enabled', '==', true)
    .where('recurring.nextPayAt', '<=', now)
    .get();

  const tasks = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};
    const amount = Number(data.recurring?.amount || 0);
    if (!amount || amount <= 0) return;

    const intervalDays = Number(data.recurring?.intervalDays || 14);
    const nextPayAt = data.recurring?.nextPayAt?.toDate ? data.recurring.nextPayAt.toDate() : new Date();

    tasks.push(db.runTransaction(async tx => {
      const accountRef = docSnap.ref;
      const accountSnap = await tx.get(accountRef);
      if (!accountSnap.exists) return;

      const account = accountSnap.data() || {};
      const balance = Number(account.balance || 0) + amount;
      const newNextPay = addDays(nextPayAt, intervalDays);
      const txRef = accountRef.collection('transactions').doc();

      tx.set(accountRef, {
        balance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedByUid: 'system',
        recurring: {
          enabled: true,
          amount,
          intervalDays,
          nextPayAt: admin.firestore.Timestamp.fromDate(newNextPay),
          lastPayAt: admin.firestore.FieldValue.serverTimestamp()
        }
      }, { merge: true });

      tx.set(txRef, {
        type: 'payroll',
        amount,
        note: 'Automated bi-weekly payroll',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdByUid: 'system',
        createdByName: 'Payroll Scheduler',
        balanceAfter: balance
      });
    }));
  });

  await Promise.all(tasks);
});

exports.onBankTransaction = onDocumentCreated('bank_accounts/{pid}/transactions/{txId}', async (event) => {
  const txData = event.data?.data();
  if (!txData) return;

  const pid = event.params.pid;
  const accountSnap = await db.doc(`bank_accounts/${pid}`).get();
  if (!accountSnap.exists) return;

  const account = accountSnap.data() || {};
  const recipient = await resolveCharacterEmail(account);
  if (!recipient) return;

  const typeLabel = (txData.type || 'transaction').toString().replace(/_/g, ' ');
  const subject = `Site-89 Bank: ${typeLabel}`;
  const amountText = formatCurrency(txData.amount || 0);
  const balanceText = formatCurrency(txData.balanceAfter || account.balance || 0);

  const bodyLines = [
    `Account: ${account.name || pid}`,
    `Transaction: ${typeLabel}`,
    `Amount: ${amountText}`,
    `Balance: ${balanceText}`,
    txData.note ? `Note: ${txData.note}` : ''
  ].filter(Boolean).join('\n');

  await db.collection('emails').add({
    sender: 'bank@site89.org',
    senderEmail: 'bank@site89.org',
    recipients: [recipient],
    subject,
    body: bodyLines,
    isHTML: false,
    format: 'markdown',
    status: 'sent',
    folder: '',
    ts: admin.firestore.FieldValue.serverTimestamp()
  });
});
