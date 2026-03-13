const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onRequest } = require('firebase-functions/v2/https');
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();

// Fallback webhook URLs (move to Firestore or environment variables for production)
const FALLBACK_EVENTS_WEBHOOK = 'https://discord.com/api/webhooks/1479885470216356098/xD9Et7LyKEqqaq3S8ESNIyUa3wqnqXvtS7Z-ulfvgcewkcKOn5Qn4yg4DdxRLfyPN3EN';
const FALLBACK_LOOKING_FOR_RP_ROLE = '1364330844528836679';
const FALLBACK_DEPARTMENT_ROLES = {
  AD: '1235374061396295701',
  TSD: '1235366964415959093',
  ScD: '1235366965413941378',
  SD: '1235366963690078359',
  IA: '1235374061291307119'
};

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

function sortCharsForDeterministicOrder(a, b) {
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
}

function seedCountsFromStoredEmail(char, counts) {
  const email = String(char.email || '').toLowerCase();
  const baseLocal = baseLocalFromName(char.name);
  if (!email || !baseLocal) return;

  const atIndex = email.indexOf('@');
  if (atIndex === -1) return;

  const localPart = email.substring(0, atIndex);
  const numMatch = localPart.match(/(\d+)$/);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const currentMax = counts.get(baseLocal) || 0;
    counts.set(baseLocal, Math.max(currentMax, num));
    return;
  }

  if (localPart === baseLocal) {
    const currentMax = counts.get(baseLocal) || 0;
    counts.set(baseLocal, Math.max(currentMax, 1));
  }
}

async function backfillMissingCharacterEmails() {
  const snap = await db.collection('characters').get();
  const withEmail = [];
  const withoutEmail = [];

  snap.forEach(docSnap => {
    const data = docSnap.data() || {};
    if (!data.name) return;
    const row = { docId: docSnap.id, ...data };
    if (row.email) withEmail.push(row);
    else withoutEmail.push(row);
  });

  if (!withoutEmail.length) {
    return { updated: 0, scanned: withEmail.length + withoutEmail.length };
  }

  const counts = new Map();
  withEmail.forEach(char => seedCountsFromStoredEmail(char, counts));

  withoutEmail.sort(sortCharsForDeterministicOrder);

  const updates = [];
  withoutEmail.forEach(char => {
    const baseLocal = baseLocalFromName(char.name);
    if (!baseLocal) return;
    const email = makeUniqueEmail(baseLocal, counts);
    updates.push({ docId: char.docId, email });
  });

  let applied = 0;
  let batch = db.batch();
  let batchCount = 0;

  for (const update of updates) {
    const ref = db.collection('characters').doc(update.docId);
    batch.set(ref, { email: update.email }, { merge: true });
    batchCount += 1;

    if (batchCount >= 400) {
      await batch.commit();
      applied += batchCount;
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
    applied += batchCount;
  }

  return { updated: applied, scanned: withEmail.length + withoutEmail.length };
}

async function resolveCharacterEmail(account) {
  if (!account || !account.name) return '';
  
  // If character has a stored email, use it
  if (account.email) return account.email.toLowerCase();

  const snap = await db.collection('characters').get();
  
  // Separate characters with existing emails from those without
  const withEmail = [];
  const withoutEmail = [];
  const targetCharId = account.docId || account.id || '';
  
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
  const baseLocal = baseLocalFromName(account.name);
  const pidKey = account.pid ? String(account.pid) : '';
  
  if (pidKey && byPid.has(pidKey)) return byPid.get(pidKey);
  if (targetCharId && byDocId.has(targetCharId)) return byDocId.get(targetCharId);

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

exports.backfillCharacterEmails = onSchedule('every 15 minutes', async () => {
  try {
    const result = await backfillMissingCharacterEmails();
    console.log('character email backfill complete', result);
  } catch (error) {
    console.error('character email backfill failed', error);
  }
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

function parseCharacterClearance(value) {
  if (value === undefined || value === null) return NaN;
  if (typeof value === 'number') return value;
  const match = String(value).match(/\d+/);
  return match ? parseInt(match[0], 10) : NaN;
}

function characterCanManageEvents(characterData = {}) {
  const clearance = parseCharacterClearance(characterData.clearance);
  if (!Number.isNaN(clearance) && clearance >= 4) return true;

  const rank = String(characterData.rank || '').toLowerCase();
  return rank.includes('director') || rank.includes('asst. director') || rank.includes('assistant director');
}

async function userCanManageEventsByUid(uid) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return false;

  try {
    const charsSnap = await db.collection('characters')
      .where('linkedUID', '==', normalizedUid)
      .get();

    return charsSnap.docs.some(docSnap => characterCanManageEvents(docSnap.data() || {}));
  } catch (error) {
    console.error(`❌ Error checking event permissions for ${normalizedUid}:`, error);
    return false;
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

// ==============================================
// Discord Email Notifications
// ==============================================

// IMPORTANT: Set this webhook URL in your Firebase Functions config:
// firebase functions:config:set discord.webhook_url="YOUR_WEBHOOK_URL"
// Or use environment variables in Firebase Console

exports.onEmailCreated = onDocumentCreated('emails/{emailId}', async (event) => {
  console.log('📧 New email created, checking for Discord notifications');
  
  const emailData = event.data?.data();
  if (!emailData) {
    console.log('❌ No email data found');
    return;
  }

  // Resolve webhook URL in priority order:
  // 1) process.env.DISCORD_WEBHOOK_URL
  // 2) firebase functions config (discord.webhook_url)
  // 3) Firestore doc settings/integrations.discordWebhookUrl
  let DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

  if (!DISCORD_WEBHOOK_URL) {
    try {
      const config = functions.config();
      DISCORD_WEBHOOK_URL = (config && config.discord && config.discord.webhook_url) || '';
    } catch (_e) {
      // Ignore and continue to Firestore fallback
    }
  }

  if (!DISCORD_WEBHOOK_URL) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const integrationsData = integrationsDoc.data() || {};
        DISCORD_WEBHOOK_URL = String(integrationsData.discordWebhookUrl || '').trim();
      }
    } catch (error) {
      console.error('⚠️ Failed to read settings/integrations webhook fallback:', error);
    }
  }
  
  if (!DISCORD_WEBHOOK_URL) {
    console.warn('⚠️ Discord webhook URL not configured. Skipping notification.');
    console.log('Set one of: DISCORD_WEBHOOK_URL env var, firebase config discord.webhook_url, or Firestore settings/integrations.discordWebhookUrl');
    return;
  }

  const recipients = emailData.recipients || [];
  console.log(`📬 Processing ${recipients.length} recipient(s)`);

  // Track which users we've already notified (to avoid duplicate notifications)
  const notifiedUsers = new Set();

  // Process each recipient
  for (const recipientEmail of recipients) {
    try {
      const normalizedEmail = recipientEmail.toLowerCase().trim();
      console.log(`🔍 Looking up character for email: ${normalizedEmail}`);
      
      // Find character by email
      const charSnap = await db.collection('characters')
        .where('email', '==', normalizedEmail)
        .limit(1)
        .get();
      
      if (charSnap.empty) {
        console.log(`⚠️ No character found for email: ${normalizedEmail}`);
        continue;
      }
      
      const charDoc = charSnap.docs[0];
      const charData = charDoc.data();
      const linkedUID = charData.linkedUID;
      
      if (!linkedUID) {
        console.log(`⚠️ Character ${charData.name || 'Unknown'} has no linked account`);
        continue;
      }
      
      // Skip if we've already notified this user (in case they have multiple characters receiving the same email)
      if (notifiedUsers.has(linkedUID)) {
        console.log(`⏭️ Already notified user ${linkedUID}, skipping duplicate`);
        continue;
      }
      
      console.log(`🔍 Looking up user account: ${linkedUID}`);
      
      // Find user's Discord ID from users collection
      const userDoc = await db.collection('users').doc(linkedUID).get();
      
      if (!userDoc.exists) {
        console.log(`⚠️ No user document found for UID: ${linkedUID}`);
        continue;
      }
      
      const userData = userDoc.data();
      const discordUserId = normalizeDiscordUserId(userData.discordUserId);
      
      if (!discordUserId) {
        console.log(`⚠️ User account has no Discord linked (character: ${charData.name || 'Unknown'})`);
        continue;
      }
      
      console.log(`✅ Found Discord user: ${discordUserId} for character ${charData.name}`);
      
      // Prepare Discord message
      const characterName = charData.name || 'your character';
      
      const discordPayload = {
        content: `<@${discordUserId}>`,
        allowed_mentions: buildAllowedMentions({ userIds: [discordUserId] }),
        embeds: [{
          title: '📬 New Email Received',
          description: `**To:** ${characterName}`,
          color: 0x00d9b5, // Teal accent color matching Site-89 theme
          timestamp: new Date().toISOString(),
          footer: {
            text: 'Site-89 Email System'
          },
          url: 'https://site89.org/emails/'
        }]
      };
      
      console.log(`📤 Sending Discord notification to user ${discordUserId}`);
      
      // Send to Discord webhook using native fetch (Node 18+ has built-in fetch)
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discordPayload)
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ Discord webhook failed (${response.status}):`, errorText);
      } else {
        console.log(`✅ Discord notification sent successfully to ${charData.name}'s owner`);
        notifiedUsers.add(linkedUID); // Mark this user as notified
      }
      
      // Rate limiting: wait 100ms between notifications to avoid Discord rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
      
    } catch (error) {
      console.error(`❌ Error processing recipient ${recipientEmail}:`, error);
      // Continue with other recipients even if one fails
    }
  }
  
  console.log('✅ Email notification processing complete');
});

// Discord Event Notifications
// ==============================================

// IMPORTANT: Set these webhook URLs in your Firebase Functions config or environment variables:
// firebase functions:config:set discord.events_webhook_url="YOUR_EVENTS_WEBHOOK_URL"
// firebase functions:config:set discord.looking_for_rp_role_id="YOUR_ROLE_ID"
// firebase functions:config:set discord.department_role_ids='{"AD":"role_id_1","TSD":"role_id_2","ScD":"role_id_3","SD":"role_id_4","IA":"role_id_5"}'
// firebase functions:config:set discord.debug_mode="true" -- Set to "true" to use plaintext role names instead of pings

function getRuntimeConfigFromEnv() {
  try {
    const raw = process.env.CLOUD_RUNTIME_CONFIG;
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed || {};
  } catch (_e) {
    return {};
  }
}

function parseLooseRoleIdMap(input) {
  if (!input) return {};
  if (typeof input === 'object' && !Array.isArray(input)) return input;

  let raw = String(input).trim();
  if (!raw) return {};

  if ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"'))) {
    raw = raw.slice(1, -1).trim();
  }

  try {
    return JSON.parse(raw);
  } catch (_e) {
    const result = {};
    const cleaned = raw.replace(/^\{/, '').replace(/\}$/, '');
    const parts = cleaned.split(',').map(p => p.trim()).filter(Boolean);
    parts.forEach(part => {
      const idx = part.indexOf(':');
      if (idx === -1) return;
      const key = part.slice(0, idx).trim().replace(/^['"]|['"]$/g, '');
      const value = part.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && value) result[key] = value;
    });
    return result;
  }
}

async function resolveDebugMode() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let debugMode = process.env.DISCORD_DEBUG_MODE === 'true' || false;

  if (!debugMode) {
    const envConfigDebug = runtimeConfig && runtimeConfig.discord && runtimeConfig.discord.debug_mode;
    debugMode = envConfigDebug === 'true' || envConfigDebug === true;
  }

  if (!debugMode) {
    try {
      const config = functions.config();
      debugMode = (config && config.discord && (config.discord.debug_mode === 'true' || config.discord.debug_mode === true)) || false;
    } catch (_e) {
      // Ignore
    }
  }

  if (!debugMode) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        debugMode = data.discordDebugMode === true;
      }
    } catch (error) {
      console.error('⚠️ Failed to read debug mode from Firestore:', error);
    }
  }

  return debugMode;
}

async function resolveEventsWebhookUrl() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let webhookUrl = process.env.DISCORD_EVENTS_WEBHOOK_URL || '';
  console.log(`🔍 Checking process.env.DISCORD_EVENTS_WEBHOOK_URL: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);

  if (!webhookUrl) {
    webhookUrl = String(runtimeConfig?.discord?.events_webhook_url || '').trim();
    console.log(`🔍 Checking CLOUD_RUNTIME_CONFIG.discord.events_webhook_url: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
  }

  if (!webhookUrl) {
    try {
      const config = functions.config();
      webhookUrl = (config && config.discord && config.discord.events_webhook_url) || '';
      console.log(`🔍 Checking functions.config().discord.events_webhook_url: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
    } catch (e) {
      console.warn(`⚠️ functions.config() failed:`, e.message);
    }
  }

  if (!webhookUrl) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        webhookUrl = String(data.discordEventsWebhookUrl || '').trim();
        console.log(`🔍 Checking Firestore settings/integrations.discordEventsWebhookUrl: ${webhookUrl ? 'FOUND' : 'NOT FOUND'}`);
      } else {
        console.log(`🔍 Firestore settings/integrations document does not exist`);
      }
    } catch (error) {
      console.error('⚠️ Failed to read events webhook from Firestore:', error);
    }
  }

  // Last resort fallback
  if (!webhookUrl) {
    console.warn(`⚠️ Using fallback webhook URL`);
    webhookUrl = FALLBACK_EVENTS_WEBHOOK;
  }

  console.log(`✅ Final webhook URL: ${webhookUrl ? 'RESOLVED' : 'NOT RESOLVED'}`);
  return webhookUrl;
}

async function resolveLookingForRpRoleId() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let roleId = process.env.DISCORD_LOOKING_FOR_RP_ROLE_ID || '';

  if (!roleId) {
    roleId = String(runtimeConfig?.discord?.looking_for_rp_role_id || '').trim();
  }

  if (!roleId) {
    try {
      const config = functions.config();
      roleId = (config && config.discord && config.discord.looking_for_rp_role_id) || '';
    } catch (_e) {
      // Ignore
    }
  }

  if (!roleId) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        roleId = String(data.discordLookingForRpRoleId || '').trim();
      }
    } catch (error) {
      console.error('⚠️ Failed to read looking for RP role ID from Firestore:', error);
    }
  }

  // Last resort fallback
  if (!roleId) {
    console.warn(`⚠️ Using fallback looking for RP role ID`);
    roleId = FALLBACK_LOOKING_FOR_RP_ROLE;
  }

  return roleId;
}

async function resolveDepartmentRoleIds() {
  const runtimeConfig = getRuntimeConfigFromEnv();
  let roleIds = {};

  const envRoleIds = process.env.DISCORD_DEPARTMENT_ROLE_IDS || '';
  if (envRoleIds) {
    roleIds = parseLooseRoleIdMap(envRoleIds);
  }

  if (Object.keys(roleIds).length === 0) {
    roleIds = parseLooseRoleIdMap(runtimeConfig?.discord?.department_role_ids);
  }

  if (Object.keys(roleIds).length === 0) {
    try {
      const config = functions.config();
      if (config && config.discord && config.discord.department_role_ids) {
        roleIds = parseLooseRoleIdMap(config.discord.department_role_ids);
      }
    } catch (_e) {
      // Ignore
    }
  }

  if (Object.keys(roleIds).length === 0) {
    try {
      const integrationsDoc = await db.doc('settings/integrations').get();
      if (integrationsDoc.exists) {
        const data = integrationsDoc.data() || {};
        roleIds = parseLooseRoleIdMap(data.discordDepartmentRoleIds || {});
      }
    } catch (error) {
      console.error('⚠️ Failed to read department role IDs from Firestore:', error);
    }
  }

  // Last resort fallback
  if (Object.keys(roleIds).length === 0) {
    console.warn(`⚠️ Using fallback department role IDs`);
    roleIds = FALLBACK_DEPARTMENT_ROLES;
  }

  return roleIds;
}

function normalizeDiscordUserId(value) {
  const normalized = String(value || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function normalizeDiscordRoleId(value) {
  const normalized = String(value || '').trim();
  return /^\d{17,20}$/.test(normalized) ? normalized : '';
}

function buildAllowedMentions({ userIds = [], roleIds = [] } = {}) {
  const users = [...new Set(userIds.map(normalizeDiscordUserId).filter(Boolean))];
  const roles = [...new Set(roleIds.map(normalizeDiscordRoleId).filter(Boolean))];
  return {
    parse: [],
    users,
    roles
  };
}

async function resolveLinkedUidForRsvp(rsvpDoc) {
  const rsvpData = rsvpDoc.data() || {};
  const characterId = String(rsvpData.characterId || rsvpDoc.id || '').trim();
  const fallbackUid = String(rsvpData.createdByUid || '').trim();
  const fallbackCharacterName = rsvpData.characterName || 'Unknown';

  if (!characterId) {
    return {
      uid: fallbackUid,
      characterName: fallbackCharacterName
    };
  }

  try {
    const characterDoc = await db.collection('characters').doc(characterId).get();
    if (characterDoc.exists) {
      const characterData = characterDoc.data() || {};
      const linkedUID = String(characterData.linkedUID || '').trim();
      return {
        uid: linkedUID || fallbackUid,
        characterName: characterData.name || fallbackCharacterName
      };
    }

    console.log(`⚠️ No character document found for RSVP character ${characterId}`);
  } catch (error) {
    console.error(`❌ Error resolving character ${characterId} for RSVP:`, error);
  }

  return {
    uid: fallbackUid,
    characterName: fallbackCharacterName
  };
}

// Returns { attendees, mentionUserIds }
// attendees  – every RSVPd character (matches website display)
// mentionUserIds – deduplicated Discord user IDs that should be pinged
async function getRsvpedUsers(eventId) {
  const attendees = [];
  const seenDiscordIds = new Set();
  const mentionUserIds = [];

  try {
    const rsvpSnap = await db.collection('events').doc(eventId).collection('rsvps').get();
    console.log(`📋 Found ${rsvpSnap.size} RSVP doc(s) for event ${eventId}`);

    for (const rsvpDoc of rsvpSnap.docs) {
      const rsvpData = rsvpDoc.data() || {};
      const { uid, characterName } = await resolveLinkedUidForRsvp(rsvpDoc);

      // Always record this character – they show on the website regardless of Discord linkage
      const entry = { characterName, uid: uid || null, discordUserId: null };

      if (!uid) {
        console.log(`⚠️ RSVP for ${characterName} has no linked UID – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        console.log(`⚠️ No user doc for UID ${uid} (${characterName}) – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      const discordUserId = normalizeDiscordUserId((userDoc.data() || {}).discordUserId);
      if (!discordUserId) {
        console.log(`⚠️ User ${uid} has no valid Discord ID (${characterName}) – listed but cannot be pinged`);
        attendees.push(entry);
        continue;
      }

      entry.discordUserId = discordUserId;
      attendees.push(entry);

      if (!seenDiscordIds.has(discordUserId)) {
        seenDiscordIds.add(discordUserId);
        mentionUserIds.push(discordUserId);
      } else {
        console.log(`⏭️ Discord user ${discordUserId} already queued for ping (${characterName})`);
      }
    }
  } catch (error) {
    console.error(`❌ Error fetching RSVPs for event ${eventId}:`, error);
  }

  console.log(`📊 RSVP summary for ${eventId}: ${attendees.length} total attendee(s), ${mentionUserIds.length} unique Discord ping(s)`);
  return { attendees, mentionUserIds };
}

// Builds the attendee field value, respecting Discord's 1024-char embed field limit
function formatAttendeeList(attendees) {
  const MAX_CHARS = 1024;
  const lines = attendees.map(a => `• **${a.characterName || 'Unknown'}**`);
  const full = lines.join('\n');
  if (full.length <= MAX_CHARS) return full || '—';

  let result = '';
  let included = 0;
  for (const line of lines) {
    const candidate = result ? `${result}\n${line}` : line;
    if (candidate.length > MAX_CHARS - 40) {
      result += `\n*…and ${lines.length - included} more*`;
      break;
    }
    result = candidate;
    included++;
  }
  return result || '—';
}

async function sendDiscordNotification(webhookUrl, payload) {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`❌ Discord webhook failed (${response.status}):`, errorText);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`❌ Error sending Discord notification:`, error);
    return false;
  }
}

async function markNotificationSent(eventId, notificationType) {
  const notificationKey = `${notificationType}_sent`;
  try {
    await db.collection('events').doc(eventId).update({
      [notificationKey]: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log(`✅ Marked ${notificationType} notification as sent for event ${eventId}`);
  } catch (error) {
    console.error(`❌ Error marking notification sent:`, error);
  }
}

async function hasNotificationBeenSent(eventData, notificationType) {
  const notificationKey = `${notificationType}_sent`;
  return !!eventData[notificationKey];
}

function formatEventTime(date) {
  // Discord timestamp format - shows in user's local timezone
  const epoch = Math.floor(date.getTime() / 1000);
  return `<t:${epoch}:F>`; // F = Full date and time
}

// Returns { start, end } as UTC Dates for the ET calendar day, optionally offset by N days
function getETDayBoundaries(offsetDays = 0) {
  const now = new Date();
  // Determine the ET date string for a point +offsetDays from now
  const base = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const etDateStr = base.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // "YYYY-MM-DD"
  const [y, m, d] = etDateStr.split('-').map(Number);

  // Find the ET UTC-offset by checking what ET hour noon UTC falls on that day
  const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const etHourAtNoon = parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(noonUTC),
    10
  );
  // Winter (EST) = UTC-5 → etHourAtNoon = 7 → offset = 5
  // Summer (EDT) = UTC-4 → etHourAtNoon = 8 → offset = 4
  const etOffsetHours = 12 - etHourAtNoon;

  const start = new Date(Date.UTC(y, m - 1, d, etOffsetHours, 0, 0));
  const end   = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function formatRoleMention(roleId) {
  return `<@&${roleId}>`;
}

function formatUserMention(userId) {
  return `<@${userId}>`;
}

// Check for events 3 days away - notify @looking for rp and departments
exports.checkEvents3DaysAway = onSchedule({ schedule: 'every day 00:00', timeZone: 'America/New_York' }, async () => {
  console.log('🔔 Checking for events 3 days away (ET)...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const lookingForRpRoleId = await resolveLookingForRpRoleId();
  const departmentRoleIds = await resolveDepartmentRoleIds();
  
  const { start: startOfTargetDay, end: endOfTargetDay } = getETDayBoundaries(3);
  console.log(`📅 Looking for events between ${startOfTargetDay.toISOString()} and ${endOfTargetDay.toISOString()}`);
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(startOfTargetDay))
    .where('start', '<', admin.firestore.Timestamp.fromDate(endOfTargetDay))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) 3 days away`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if 3-day notification already sent
    if (await hasNotificationBeenSent(eventData, 'three_day')) {
      console.log(`⏭️ 3-day notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    const eventDepartments = Array.isArray(eventData.departments) ? eventData.departments : [];
    const eventZone = eventData.zone || 'TBD';
    const eventManager = eventData.manager || 'TBD';
    const eventShortDesc = eventData.shortDesc || 'Details on events page.';
    
    // Build mentions string - include @looking for rp and department roles
    const mentions = [];
    const mentionedRoleIds = [];
    if (lookingForRpRoleId) {
      mentions.push(formatRoleMention(lookingForRpRoleId));
      mentionedRoleIds.push(lookingForRpRoleId);
    }
    
    // Add department role mentions
    for (const dept of eventDepartments) {
      const deptRoleId = departmentRoleIds[dept];
      if (deptRoleId) {
        mentions.push(formatRoleMention(deptRoleId));
        mentionedRoleIds.push(deptRoleId);
      }
    }
    
    // Main announcement to events channel
    const mainPayload = {
      content: mentions.length > 0 ? mentions.join(' ') : undefined,
      allowed_mentions: buildAllowedMentions({ roleIds: mentionedRoleIds }),
      embeds: [{
        title: '📅 Upcoming Event in 3 Days',
        description: `**${eventTitle}**\n\n${eventShortDesc}`,
        color: 0x00d9b5,
        fields: [
          { name: '⏰ Time', value: formatEventTime(eventStart), inline: false },
          { name: '🌍 Zone', value: eventZone, inline: true },
          { name: '🏢 Departments', value: eventDepartments.join(', ') || 'All', inline: true },
          { name: '👤 RP Manager', value: eventManager, inline: true }
        ],
        footer: { text: 'RSVP at site89.org/events' },
        url: 'https://site89.org/events/'
      }]
    };
    
    const mainSuccess = await sendDiscordNotification(webhookUrl, mainPayload);
    if (mainSuccess) {
      console.log(`✅ Sent 3-day notification for: ${eventTitle}`);
    }
    
    await markNotificationSent(eventId, 'three_day');
    await new Promise(resolve => setTimeout(resolve, 500)); // Rate limiting between events
  }
  
  console.log('✅ 3-day event check complete');
});

// Check for events starting today - notify RSVPed users
exports.checkEventsDayOf = onSchedule({ schedule: 'every day 00:00', timeZone: 'America/New_York' }, async () => {
  console.log('🔔 Checking for events starting today (ET)...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const { start: startOfToday, end: endOfToday } = getETDayBoundaries(0);
  console.log(`📅 Looking for events between ${startOfToday.toISOString()} and ${endOfToday.toISOString()}`);
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(startOfToday))
    .where('start', '<', admin.firestore.Timestamp.fromDate(endOfToday))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) today`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if day-of notification already sent
    if (await hasNotificationBeenSent(eventData, 'day_of')) {
      console.log(`⏭️ Day-of notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    
    // Get RSVPed users
    const { attendees: dayOfAttendees, mentionUserIds: dayOfMentions } = await getRsvpedUsers(eventId);

    if (dayOfAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'day_of');
      continue;
    }

    console.log(`📬 Notifying ${dayOfAttendees.length} RSVP(s) (${dayOfMentions.length} Discord ping(s)) for: ${eventTitle}`);

    const dayOfMentionStr = dayOfMentions.map(formatUserMention).join(' ');
    const payload = {
      content: dayOfMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: dayOfMentions }),
      embeds: [{
        title: '📅 Event Today!',
        description: `**${eventTitle}** starts today!\n\nThe following characters are registered to attend:`,
        color: 0x00d9b5,
        fields: [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${dayOfAttendees.length})`, value: formatAttendeeList(dayOfAttendees), inline: false }
        ],
        footer: { text: 'Site-89 Events' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated day-of notification to ${dayOfAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'day_of');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ Day-of event check complete');
});

// Check for events starting in 30 minutes
exports.checkEvents30MinutesAway = onSchedule('every 15 minutes', async () => {
  console.log('🔔 Checking for events starting in 30 minutes...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const now = new Date();
  const thirtyMinutesFromNow = new Date(now.getTime() + (30 * 60 * 1000));
  const fortyFiveMinutesFromNow = new Date(now.getTime() + (45 * 60 * 1000)); // 15-minute window
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(thirtyMinutesFromNow))
    .where('start', '<', admin.firestore.Timestamp.fromDate(fortyFiveMinutesFromNow))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) starting in ~30 minutes`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if 30-minute notification already sent
    if (await hasNotificationBeenSent(eventData, 'thirty_min')) {
      console.log(`⏭️ 30-minute notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
    
    const { attendees: thirtyMinAttendees, mentionUserIds: thirtyMinMentions } = await getRsvpedUsers(eventId);

    if (thirtyMinAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'thirty_min');
      continue;
    }

    console.log(`📬 Sending 30-min reminders for: ${eventTitle} – ${thirtyMinAttendees.length} attendee(s), ${thirtyMinMentions.length} Discord ping(s)`);

    const thirtyMinMentionStr = thirtyMinMentions.map(formatUserMention).join(' ');
    const payload = {
      content: thirtyMinMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: thirtyMinMentions }),
      embeds: [{
        title: '⏰ Event Starting in 30 Minutes!',
        description: `**${eventTitle}** is starting soon!\n\nThe following characters are registered to attend:`,
        color: 0xFFA500,
        fields: [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${thirtyMinAttendees.length})`, value: formatAttendeeList(thirtyMinAttendees), inline: false }
        ],
        footer: { text: 'Get ready!' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated 30-min reminder to ${thirtyMinAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'thirty_min');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ 30-minute event check complete');
});

// Check for events starting now
exports.checkEventsStartingNow = onSchedule('every 5 minutes', async () => {
  console.log('🔔 Checking for events starting now...');
  
  const webhookUrl = await resolveEventsWebhookUrl();
  if (!webhookUrl) {
    console.warn('⚠️ Events webhook URL not configured. Skipping.');
    return;
  }
  
  const now = new Date();
  const fiveMinutesAgo = new Date(now.getTime() - (5 * 60 * 1000));
  const fiveMinutesFromNow = new Date(now.getTime() + (5 * 60 * 1000));
  
  const eventsSnap = await db.collection('events')
    .where('start', '>=', admin.firestore.Timestamp.fromDate(fiveMinutesAgo))
    .where('start', '<', admin.firestore.Timestamp.fromDate(fiveMinutesFromNow))
    .get();
  
  console.log(`📅 Found ${eventsSnap.size} event(s) starting now`);
  
  for (const eventDoc of eventsSnap.docs) {
    const eventData = eventDoc.data();
    const eventId = eventDoc.id;
    
    // Skip if start notification already sent
    if (await hasNotificationBeenSent(eventData, 'start')) {
      console.log(`⏭️ Start notification already sent for: ${eventData.title}`);
      continue;
    }
    
    const eventTitle = eventData.title || 'Untitled Event';
    const eventZone = eventData.zone || 'TBD';
    
    const { attendees: startAttendees, mentionUserIds: startMentions } = await getRsvpedUsers(eventId);

    if (startAttendees.length === 0) {
      console.log(`⚠️ No RSVPs for event: ${eventTitle}`);
      await markNotificationSent(eventId, 'start');
      continue;
    }

    console.log(`📬 Sending start notifications for: ${eventTitle} – ${startAttendees.length} attendee(s), ${startMentions.length} Discord ping(s)`);

    const startMentionStr = startMentions.map(formatUserMention).join(' ');
    const payload = {
      content: startMentionStr || undefined,
      allowed_mentions: buildAllowedMentions({ userIds: startMentions }),
      embeds: [{
        title: '🎬 Event Starting NOW!',
        description: `**${eventTitle}** is starting right now!\n\nGo to the ${eventZone} to participate:`,
        color: 0xFF0000,
        fields: [
          { name: `Attendees (${startAttendees.length})`, value: formatAttendeeList(startAttendees), inline: false }
        ],
        footer: { text: 'Have fun!' },
        url: 'https://site89.org/events/'
      }]
    };

    await sendDiscordNotification(webhookUrl, payload);
    console.log(`✅ Sent consolidated start notification to ${startAttendees.length} attendees`);
    
    await markNotificationSent(eventId, 'start');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('✅ Start event check complete');
});

// Manual trigger endpoints for debugging
// ==============================================

exports.triggerEventNotifications = onRequest({ cors: true }, async (req, res) => {
  // Only allow POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  const requester = await verifyUserFromRequest(req);
  if (!requester) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return;
  }

  const canManageEvents = await userCanManageEventsByUid(requester.uid);
  if (!canManageEvents) {
    res.status(403).json({ success: false, message: 'Insufficient permissions' });
    return;
  }

  const { notificationType, eventId } = req.body || {};

  if (!notificationType) {
    res.status(400).json({ success: false, message: 'Missing notificationType' });
    return;
  }

  console.log(`🔧 Manual trigger requested: ${notificationType} for event ${eventId || 'all'}`);

  try {
    const webhookUrl = await resolveEventsWebhookUrl();
    if (!webhookUrl) {
      res.status(500).json({
        success: false,
        message: 'Events webhook URL not configured (discord.events_webhook_url / DISCORD_EVENTS_WEBHOOK_URL / settings/integrations.discordEventsWebhookUrl)'
      });
      return;
    }

    if (notificationType === 'three_day') {
      const lookingForRpRoleId = await resolveLookingForRpRoleId();
      const departmentRoleIds = await resolveDepartmentRoleIds();
      
      // If eventId specified, only process that event
      let eventsSnap;
      if (eventId) {
        const eventDoc = await db.collection('events').doc(eventId).get();
        eventsSnap = { docs: eventDoc.exists ? [eventDoc] : [], size: eventDoc.exists ? 1 : 0 };
      } else {
        // Process all upcoming events (next 7 days)
        const now = new Date();
        const sevenDaysFromNow = new Date(now.getTime() + (7 * 24 * 60 * 60 * 1000));
        eventsSnap = await db.collection('events')
          .where('start', '>=', admin.firestore.Timestamp.fromDate(now))
          .where('start', '<', admin.firestore.Timestamp.fromDate(sevenDaysFromNow))
          .get();
      }
      
      for (const eventDoc of eventsSnap.docs) {
        const eventData = eventDoc.data();
        const eventTitle = eventData.title || 'Untitled Event';
        const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
        const eventDepartments = Array.isArray(eventData.departments) ? eventData.departments : [];
        const eventZone = eventData.zone || 'TBD';
        const eventManager = eventData.manager || 'TBD';
        const eventShortDesc = eventData.shortDesc || 'Details on events page.';
        
        const mentions = [];
        const mentionedRoleIds = [];
        if (lookingForRpRoleId) {
          mentions.push(formatRoleMention(lookingForRpRoleId));
          mentionedRoleIds.push(lookingForRpRoleId);
        }
        for (const dept of eventDepartments) {
          const deptRoleId = departmentRoleIds[dept];
          if (deptRoleId) {
            mentions.push(formatRoleMention(deptRoleId));
            mentionedRoleIds.push(deptRoleId);
          }
        }
        
        const payload = {
          content: mentions.length > 0 ? mentions.join(' ') : undefined,
          allowed_mentions: buildAllowedMentions({ roleIds: mentionedRoleIds }),
          embeds: [{
            title: '📅 Upcoming Event in 3 Days',
            description: `**${eventTitle}**\n\n${eventShortDesc}`,
            color: 0x00d9b5,
            fields: [
              { name: '⏰ Time', value: formatEventTime(eventStart), inline: false },
              { name: '🌍 Zone', value: eventZone, inline: true },
              { name: '🏢 Departments', value: eventDepartments.join(', ') || 'All', inline: true },
              { name: '👤 RP Manager', value: eventManager, inline: true }
            ],
            footer: { text: 'RSVP at site89.org/events [MANUAL TEST]' },
            url: 'https://site89.org/events/'
          }]
        };
        
        await sendDiscordNotification(webhookUrl, payload);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      res.json({ success: true, message: `Sent ${eventsSnap.size} notification(s)` });
    } else if (notificationType === 'day_of' || notificationType === 'thirty_min' || notificationType === 'start') {
      if (!eventId) {
        res.status(400).send('eventId required for this notification type');
        return;
      }
      
      const eventDoc = await db.collection('events').doc(eventId).get();
      if (!eventDoc.exists) {
        res.status(404).send('Event not found');
        return;
      }
      
      const eventData = eventDoc.data();
      const eventTitle = eventData.title || 'Untitled Event';
      const eventStart = eventData.start?.toDate ? eventData.start.toDate() : new Date();
      const eventZone = eventData.zone || 'TBD';
      
      const { attendees: manualAttendees, mentionUserIds: manualMentions } = await getRsvpedUsers(eventId);

      if (manualAttendees.length === 0) {
        res.json({ success: true, message: 'No RSVPs found' });
        return;
      }

      const manualMentionStr = manualMentions.map(formatUserMention).join(' ');
      const manualAttendeeList = formatAttendeeList(manualAttendees);

      let title, description, color, fields;
      if (notificationType === 'day_of') {
        title = '📅 Event Today!';
        description = `**${eventTitle}** starts today!\n\nThe following characters are registered to attend:`;
        color = 0x00d9b5;
        fields = [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      } else if (notificationType === 'thirty_min') {
        title = '⏰ Event Starting in 30 Minutes!';
        description = `**${eventTitle}** is starting soon!\n\nThe following characters are registered to attend:`;
        color = 0xFFA500;
        fields = [
          { name: '⏰ Start Time', value: formatEventTime(eventStart), inline: false },
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      } else {
        title = '🎬 Event Starting NOW!';
        description = `**${eventTitle}** is starting right now!\n\nJoin the ${eventZone} to participate:`;
        color = 0xFF0000;
        fields = [
          { name: `Attendees (${manualAttendees.length})`, value: manualAttendeeList, inline: false }
        ];
      }

      const payload = {
        content: manualMentionStr || undefined,
        allowed_mentions: buildAllowedMentions({ userIds: manualMentions }),
        embeds: [{
          title,
          description,
          color,
          fields,
          footer: { text: 'Site-89 Events [MANUAL TEST]' },
          url: 'https://site89.org/events/'
        }]
      };

      await sendDiscordNotification(webhookUrl, payload);
      res.json({
        success: true,
        message: `Sent notification to ${manualAttendees.length} attendees (${manualMentions.length} Discord ping(s))`,
        attendees: manualAttendees.map(a => ({ name: a.characterName, pinged: !!a.discordUserId }))
      });
    } else {
      res.status(400).json({ success: false, message: 'Invalid notification type' });
    }
  } catch (error) {
    console.error('Error in manual trigger:', error);
    res.status(500).json({ success: false, message: 'Error: ' + error.message });
  }
});
