const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const express = require('express');
const crypto = require('crypto');

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
  console.log('🔔 Transaction trigger fired!', { pid: event.params.pid, txId: event.params.txId });
  
  const txData = event.data?.data();
  if (!txData) {
    console.log('❌ No transaction data found');
    return;
  }
  console.log('📝 Transaction data:', txData);

  const pid = event.params.pid;
  const accountSnap = await db.doc(`bank_accounts/${pid}`).get();
  if (!accountSnap.exists) {
    console.log('❌ Account not found:', pid);
    return;
  }

  const account = accountSnap.data() || {};
  console.log('👤 Account found:', { name: account.name, pid });
  
  const recipient = await resolveCharacterEmail(account);
  if (!recipient) {
    console.log('❌ Could not resolve email for:', account.name);
    return;
  }
  console.log('📧 Recipient resolved:', recipient);

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

  console.log('✉️ Creating email:', { sender: 'fd.mgmt@site89.org', recipient, subject });
  
  try {
    await db.collection('emails').add({
      sender: 'fd.mgmt@site89.org',
      senderEmail: 'fd.mgmt@site89.org',
      recipients: [recipient],
      subject,
      body: bodyLines,
      isHTML: false,
      format: 'markdown',
      status: 'sent',
      folder: '',
      deletedBy: [],
      ts: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log('✅ Email created successfully!');
  } catch (error) {
    console.error('❌ Error creating email:', error);
    throw error;
  }
});

const IMAGE_CODE_LENGTH = 8;
const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
  'image/svg+xml'
]);

const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
};

function normalizeMimeType(contentType = '') {
  return contentType.toString().split(';')[0].trim().toLowerCase();
}

function normalizeImageCode(input = '') {
  const cleaned = input.toString().trim();
  const match = cleaned.match(/^([A-Za-z0-9]{6,32})(?:\.[A-Za-z0-9]+)?$/);
  return match ? match[1] : '';
}

function randomImageCode() {
  const bytes = crypto.randomBytes(IMAGE_CODE_LENGTH);
  return bytes
    .toString('base64')
    .replace(/\+/g, 'A')
    .replace(/\//g, 'B')
    .replace(/=/g, '')
    .slice(0, IMAGE_CODE_LENGTH);
}

async function createUniqueImageCode() {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = randomImageCode();
    const doc = await db.collection('image_files').doc(code).get();
    if (!doc.exists) return code;
  }
  throw new Error('Unable to generate unique image code');
}

async function verifyUserFromRequest(req) {
  const authHeader = (req.headers.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  try {
    return await admin.auth().verifyIdToken(token);
  } catch (_error) {
    return null;
  }
}

const imageApiApp = express();

imageApiApp.get('/image/:code', async (req, res) => {
  const code = normalizeImageCode(req.params.code);
  if (!code) {
    res.status(404).send('Not found');
    return;
  }

  const imageDoc = await db.collection('image_files').doc(code).get();
  if (!imageDoc.exists) {
    res.status(404).send('Not found');
    return;
  }

  const imageData = imageDoc.data() || {};
  const storagePath = imageData.storagePath;
  if (!storagePath) {
    res.status(404).send('Not found');
    return;
  }

  try {
    const bucket = admin.storage().bucket('site-89-2d768.firebasestorage.app');
    const storageFile = bucket.file(storagePath);
    const [exists] = await storageFile.exists();
    if (!exists) {
      res.status(404).send('Not found');
      return;
    }

    const contentType = imageData.mimeType || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    storageFile.createReadStream().pipe(res);
  } catch (error) {
    console.error('Image read error:', error);
    res.status(500).send('Failed to load image');
  }
});

imageApiApp.post('/upload', express.raw({ type: '*/*', limit: IMAGE_MAX_UPLOAD_BYTES }), async (req, res) => {
  const verifiedUser = await verifyUserFromRequest(req);
  if (!verifiedUser) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const mimeType = normalizeMimeType(req.get('content-type'));
  if (!IMAGE_ALLOWED_MIME_TYPES.has(mimeType)) {
    res.status(400).json({ error: 'Unsupported file type' });
    return;
  }

  const uploadedBuffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!uploadedBuffer || !uploadedBuffer.length) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  try {
    const code = await createUniqueImageCode();
    const extension = IMAGE_MIME_EXTENSIONS[mimeType] || '.bin';
    const storagePath = `images/${code}${extension}`;

    const bucket = admin.storage().bucket('site-89-2d768.firebasestorage.app');
    const storageFile = bucket.file(storagePath);

    await storageFile.save(uploadedBuffer, {
      resumable: false,
      contentType: mimeType,
      metadata: {
        cacheControl: 'public, max-age=31536000, immutable'
      }
    });

    await db.collection('image_files').doc(code).set({
      code,
      extension,
      mimeType,
      size: uploadedBuffer.length,
      storagePath,
      uploaderUid: verifiedUser.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Always use site89.org domain for image URLs
    const url = `https://site89.org/image/${code}${extension}`;

    res.status(201).json({
      code,
      extension,
      url
    });
  } catch (error) {
    console.error('Image upload error:', error);
    
    // Provide more specific error messages
    let errorMessage = 'Upload failed';
    if (error.code === 'storage/unauthorized') {
      errorMessage = 'Storage access denied. Please check Firebase Storage configuration.';
    } else if (error.code === 'storage/bucket-not-found') {
      errorMessage = 'Storage bucket not found. Please configure Firebase Storage.';
    } else if (error.code === 'storage/quota-exceeded') {
      errorMessage = 'Storage quota exceeded. Please contact administrator.';
    } else if (error.message) {
      errorMessage = error.message;
    }
    
    res.status(500).json({ error: errorMessage });
  }
});

imageApiApp.use((error, _req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'File exceeds 10MB upload limit' });
    return;
  }

  console.error('Image API middleware error:', error);
  res.status(400).json({ error: error.message || 'Invalid upload request' });
});

imageApiApp.use((_req, res) => {
  res.status(404).send('Not found');
});

exports.imageApi = onRequest({ invoker: 'public' }, imageApiApp);
