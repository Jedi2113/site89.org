import { app, auth, onAuthStateChanged } from "/assets/js/auth.js";
import {
  getFirestore,
  collection,
  getDocs,
  query,
  where,
  doc,
  setDoc,
  getDoc,
  addDoc,
  serverTimestamp,
  updateDoc,
  orderBy
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

const STATUS = {
  CLEAN: 'Clean',
  WARNED: 'Warned',
  STRIKE_1: 'Strike I',
  STRIKE_2: 'Strike II',
  STRIKE_3: 'Strike III',
  TEMP_BAN: 'Banned (Temporary)',
  BAN: 'Banned'
};

const STATUS_ORDER = [
  STATUS.CLEAN,
  STATUS.WARNED,
  STATUS.STRIKE_1,
  STATUS.STRIKE_2,
  STATUS.STRIKE_3,
  STATUS.TEMP_BAN,
  STATUS.BAN
];

const IA_EMAIL = 'ia.mgmt@site89.org';
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';
const PAGE_SIZE = 9;

let allAccounts = [];
let allCharacters = [];
let moderationByUid = new Map();
let actionsByUid = new Map();
let rulesCatalog = [];
let filteredAccounts = [];
let currentPage = 1;
let activeUid = null;
let currentUser = null;

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'manager') return 'manager';
  if (role === 'raisa') return 'manager';
  return 'member';
}

function getStaffTierFromText(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 0;

  if (text.includes('trial roleplay manager')) return 1;
  if (text === 'rp manager' || text.includes('roleplay manager')) return 2;

  // Staff levels above Roleplay Manager.
  if (
    text.includes('roleplay administrator') ||
    text.includes('server administrator') ||
    text.includes('board of executives') ||
    text.includes('chief executive officer') ||
    text === 'ceo' ||
    text.includes('department director') ||
    text.includes('site director') ||
    text.includes('director') ||
    text.includes('executive')
  ) {
    return 3;
  }

  return 0;
}

function hasRoleplayManagerOrAboveFromUserDoc(user, userDoc) {
  if (!user) return false;
  if ((user.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL) return true;
  if (userDoc?.isAdmin === true) return true;

  const normalizedRole = normalizeRole(userDoc?.role);
  if (normalizedRole === 'manager' || normalizedRole === 'admin') return true;

  const candidates = [
    userDoc?.rank,
    userDoc?.staffRank,
    userDoc?.staffRole,
    userDoc?.discordRole,
    userDoc?.title
  ];

  return candidates.some(value => getStaffTierFromText(value) >= 2);
}

function hasRoleplayManagerOrAboveFromCharacter(characterRow) {
  return getStaffTierFromText(characterRow?.rank) >= 2;
}

function safeText(value, fallback = 'N/A') {
  const text = (value || '').toString().trim();
  return text || fallback;
}

function statusClass(status) {
  if (status === STATUS.BAN) return 'ban';
  if (status === STATUS.TEMP_BAN) return 'temp-ban';
  if (status === STATUS.WARNED) return 'warned';
  if (status.includes('Strike')) return 'strike';
  return 'clean';
}

function setFeedback(element, message, isError = false) {
  if (!element) return;
  element.className = `feedback ${isError ? 'error' : 'success'}`;
  element.textContent = message;
}

function parseRulebookHtml(html) {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');
  const sectionNodes = Array.from(parsed.querySelectorAll('.rules-section'));

  const found = [];
  sectionNodes.forEach(section => {
    const ruleCodeNodes = Array.from(section.querySelectorAll('h3'));
    ruleCodeNodes.forEach(codeNode => {
      const code = (codeNode.textContent || '').trim();
      if (!/^\d+\.\d+$/.test(code)) return;

      let li = codeNode.nextElementSibling;
      while (li && li.tagName !== 'LI') {
        li = li.nextElementSibling;
      }
      if (!li) return;

      const strong = li.querySelector('strong');
      const title = strong ? strong.textContent.trim() : 'Rule Violation';
      const description = li.textContent.trim();

      found.push({ code, title, description });
    });
  });

  found.sort((a, b) => {
    const [aMajor, aMinor] = a.code.split('.').map(Number);
    const [bMajor, bMinor] = b.code.split('.').map(Number);
    if (aMajor !== bMajor) return aMajor - bMajor;
    return aMinor - bMinor;
  });

  return found;
}

async function loadRuleCatalog() {
  try {
    const response = await fetch('/rules/');
    if (!response.ok) throw new Error('Failed to fetch rulebook');
    const html = await response.text();
    const parsed = parseRulebookHtml(html);
    rulesCatalog = parsed;
  } catch (error) {
    console.error('Failed to load rules catalog:', error);
    rulesCatalog = [];
  }
}

function getCharactersForUid(uid) {
  if (!uid) return [];
  return allCharacters
    .filter(character => (character.linkedUID || '') === uid)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function getDefaultIgn(userRow) {
  const email = (userRow.email || '').toLowerCase();
  if (email.includes('@')) return email.split('@')[0];
  return userRow.uid.slice(0, 10);
}

function buildAccountViewModel(userRow) {
  const modDoc = moderationByUid.get(userRow.uid) || {};
  const chars = getCharactersForUid(userRow.uid);
  const ign = safeText(modDoc.ign || userRow.ign || getDefaultIgn(userRow), 'Unknown IGN');
  const status = STATUS_ORDER.includes(modDoc.status) ? modDoc.status : STATUS.CLEAN;
  return {
    uid: userRow.uid,
    email: userRow.email || '',
    ign,
    status,
    characters: chars,
    moderationMeta: modDoc
  };
}

const ACTION_LABELS = {
  verbal_warning: 'Verbal Warning',
  written_warning: 'Written Warning',
  add_strike: 'Add 1 Strike',
  add_2_strikes: 'Add 2 Strikes',
  add_3_strikes: 'Add 3 Strikes',
  temp_ban: 'Temporary Ban',
  ban: 'Permanent Ban'
};

function getStrikeCountFromStatus(status) {
  if (status === STATUS.STRIKE_1) return 1;
  if (status === STATUS.STRIKE_2) return 2;
  if (status === STATUS.STRIKE_3) return 3;
  return 0;
}

function getStatusFromStrikeCount(strikes) {
  if (strikes <= 0) return STATUS.CLEAN;
  if (strikes === 1) return STATUS.STRIKE_1;
  if (strikes === 2) return STATUS.STRIKE_2;
  return STATUS.STRIKE_3;
}

function applyStrikeDelta(currentStatus, delta) {
  if (currentStatus === STATUS.BAN || currentStatus === STATUS.TEMP_BAN) return null;
  const now = getStrikeCountFromStatus(currentStatus);
  if (now >= 3) return null;
  const nextCount = Math.min(3, now + Math.max(1, delta));
  return getStatusFromStrikeCount(nextCount);
}

function getRuleSeverityProfile(ruleCode) {
  const zeroBan = new Set(['0.1', '0.2', '0.3', '0.4', '2.1', '2.2', '2.5', '3.8']);
  const writtenWarn = new Set(['1.4', '1.5', '2.3', '3.5', '3.9']);
  const medium = new Set(['1.2', '1.3', '1.6', '2.4', '3.4', '3.6']);

  if (zeroBan.has(ruleCode)) {
    return {
      score: 10,
      tier: 'Critical',
      steps: {
        first: 'Permanent ban',
        second: 'Permanent ban',
        third: 'Permanent ban'
      },
      actions: {
        first: 'ban',
        second: 'ban',
        third: 'ban'
      }
    };
  }

  if (writtenWarn.has(ruleCode)) {
    return {
      score: 6,
      tier: 'High',
      steps: {
        first: 'Written warning',
        second: 'Add 1 strike',
        third: 'Temporary ban'
      },
      actions: {
        first: 'written_warning',
        second: 'add_strike',
        third: 'temp_ban'
      }
    };
  }

  if (medium.has(ruleCode)) {
    return {
      score: 4,
      tier: 'Moderate',
      steps: {
        first: 'Verbal warning',
        second: 'Written warning',
        third: 'Add 1 strike'
      },
      actions: {
        first: 'verbal_warning',
        second: 'written_warning',
        third: 'add_strike'
      }
    };
  }

  return {
    score: 2,
    tier: 'Low',
    steps: {
      first: 'Verbal warning',
      second: 'Written warning',
      third: 'Add 1 strike'
    },
    actions: {
      first: 'verbal_warning',
      second: 'written_warning',
      third: 'add_strike'
    }
  };
}

function getPriorRuleSignal(uid, ruleCode) {
  const rows = actionsByUid.get(uid) || [];
  const relevant = rows.filter(row => row.ruleCode === ruleCode);
  const priorWritten = relevant.filter(row => row.actionType === 'written_warning').length;
  const priorEscalated = relevant.filter(row => ['add_strike', 'add_2_strikes', 'add_3_strikes', 'temp_ban', 'ban'].includes(row.actionType)).length;
  return { priorWritten, priorEscalated, totalRelevant: relevant.length };
}

function resolveEscalationForRule(account, ruleCode) {
  const profile = getRuleSeverityProfile(ruleCode);
  const prior = getPriorRuleSignal(account.uid, ruleCode);
  const strikeCount = getStrikeCountFromStatus(account.status);

  let stage = 1;
  if (prior.priorWritten > 0 || prior.priorEscalated > 0 || account.status === STATUS.WARNED || strikeCount >= 1) {
    stage = 2;
  }
  if (prior.priorEscalated > 0 || strikeCount >= 2) {
    stage = 3;
  }

  if (stage === 1) {
    return {
      ...profile,
      stage,
      stageLabel: 'First offense',
      recommendedAction: profile.actions.first,
      recommendedStep: profile.steps.first,
      prior
    };
  }

  if (stage === 2) {
    return {
      ...profile,
      stage,
      stageLabel: 'Second offense',
      recommendedAction: profile.actions.second,
      recommendedStep: profile.steps.second,
      prior
    };
  }

  return {
    ...profile,
    stage,
    stageLabel: 'Third offense',
    recommendedAction: profile.actions.third,
    recommendedStep: profile.steps.third,
    prior
  };
}

async function resolveCharacterEmailsForUid(uid) {
  const chars = getCharactersForUid(uid);
  if (!chars.length) return [];

  const withEmail = chars
    .map(char => (char.email || '').toString().trim().toLowerCase())
    .filter(Boolean);

  if (withEmail.length) {
    return [...new Set(withEmail)];
  }

  const generated = chars
    .map(char => {
      const name = (char.name || '').trim();
      if (!name) return '';
      const parts = name.split(/\s+/);
      const first = parts[0] ? parts[0].toLowerCase().replace(/[^a-z]/g, '') : '';
      const last = parts.length > 1 ? parts[parts.length - 1].toLowerCase().replace(/[^a-z]/g, '') : first;
      if (!first || !last) return '';
      return `${last}.${first}@site89.org`;
    })
    .filter(Boolean);

  return [...new Set(generated)];
}

async function sendModerationNotification(account, actionType, reason, issuer, ruleCodes = []) {
  const requiresMail = ['written_warning', 'add_strike', 'add_2_strikes', 'add_3_strikes', 'temp_ban', 'ban'].includes(actionType);
  if (!requiresMail) return;

  const recipients = await resolveCharacterEmailsForUid(account.uid);
  if (!recipients.length) return;

  const typeLabel = ACTION_LABELS[actionType] || 'Moderation Action';

  const subject = `Site-89 Moderation Notice: ${typeLabel}`;
  
  const bodyParts = [
    '# Site-89 Moderation Notice',
    '',
    `## **${typeLabel}**`,
    '',
    '### Account Information',
    `- **Account:** ${account.ign}`,
    `- **UID:** ${account.uid}`
  ];
  
  if (account.email) {
    bodyParts.push(`- **Email:** ${account.email}`);
  }
  
  bodyParts.push(
    '',
    '### Action Details',
    `- **Action:** ${typeLabel}`,
  );

  if (ruleCodes.length) {
    bodyParts.push(`- **Rules Violated:** ${ruleCodes.join(', ')}`);
  }
  
  bodyParts.push(
    `- **Issued By:** ${issuer || 'Staff'}`,
    '',
    '### Reason',
    reason,
    '',
    '---',
    '',
    '*This message was sent by Site-89 Internal Affairs moderation systems.*'
  );
  
  const body = bodyParts.join('\n');

  try {
    await addDoc(collection(db, 'emails'), {
      sender: IA_EMAIL,
      senderEmail: IA_EMAIL,
      recipients,
      subject,
      body,
      isHTML: false,
      format: 'markdown',
      status: 'sent',
      folder: '',
      ts: serverTimestamp()
    });
  } catch (error) {
    console.error('Failed to send moderation email notification:', error);
  }
}

async function loadBaseData() {
  const [usersSnap, charsSnap, modSnap, actionSnap] = await Promise.all([
    getDocs(collection(db, 'users')),
    getDocs(collection(db, 'characters')),
    getDocs(collection(db, 'moderation_accounts')),
    getDocs(query(collection(db, 'moderation_actions'), orderBy('createdAt', 'desc')))
  ]);

  allAccounts = [];
  usersSnap.forEach(docSnap => {
    const data = docSnap.data() || {};
    allAccounts.push({ uid: docSnap.id, email: data.email || '' });
  });

  allCharacters = [];
  charsSnap.forEach(docSnap => {
    allCharacters.push({ id: docSnap.id, ...docSnap.data() });
  });

  moderationByUid = new Map();
  modSnap.forEach(docSnap => {
    moderationByUid.set(docSnap.id, { id: docSnap.id, ...docSnap.data() });
  });

  actionsByUid = new Map();
  actionSnap.forEach(docSnap => {
    const row = { id: docSnap.id, ...docSnap.data() };
    const uid = row.accountUid || '';
    if (!uid) return;
    const bucket = actionsByUid.get(uid) || [];
    bucket.push(row);
    actionsByUid.set(uid, bucket);
  });

  allAccounts.sort((a, b) => {
    const aIgn = buildAccountViewModel(a).ign;
    const bIgn = buildAccountViewModel(b).ign;
    return aIgn.localeCompare(bIgn);
  });
}

function buildFilterHaystack(account) {
  const chars = account.characters.map(c => `${c.name || ''} ${c.pid || ''} ${c.department || ''}`).join(' ');
  return `${account.ign} ${account.email} ${account.uid} ${chars}`.toLowerCase();
}

function updatePager() {
  const pageInfo = document.getElementById('pageInfo');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  pageInfo.textContent = `Page ${currentPage} / ${totalPages}`;
  prevPageBtn.disabled = currentPage <= 1;
  nextPageBtn.disabled = currentPage >= totalPages;
}

function openAccountModal(uid) {
  const modal = document.getElementById('accountModal');
  activeUid = uid;
  renderDetails(uid, 'accountModalBody');
  modal.classList.add('show');
  modal.setAttribute('aria-hidden', 'false');
}

function closeAccountModal() {
  const modal = document.getElementById('accountModal');
  modal.classList.remove('show');
  modal.setAttribute('aria-hidden', 'true');
}

function renderGrid() {
  const grid = document.getElementById('moderationGrid');
  const searchValue = (document.getElementById('searchInput').value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('statusFilter').value || 'all';

  filteredAccounts = allAccounts
    .map(buildAccountViewModel)
    .filter(account => {
      if (statusFilter !== 'all' && account.status !== statusFilter) return false;
      if (!searchValue) return true;
      return buildFilterHaystack(account).includes(searchValue);
    });

  grid.innerHTML = '';

  if (!filteredAccounts.length) {
    grid.innerHTML = '<div class="access-denied">No accounts match the current filters.</div>';
    updatePager();
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const visibleRows = filteredAccounts.slice(start, start + PAGE_SIZE);

  visibleRows.forEach(account => {
    const card = document.createElement('div');
    card.className = 'mod-card';
    if (activeUid === account.uid) card.classList.add('active');

    const charsText = account.characters.length
      ? account.characters.map(char => char.name || 'Unknown').join(', ')
      : 'No linked characters';

    card.innerHTML = `
      <h3>${account.ign}</h3>
      <span class="mod-pill ${statusClass(account.status)}">${account.status}</span>
      <div class="mod-muted" style="margin-bottom:0.2rem;"><strong>Account:</strong> ${safeText(account.email || account.uid)}</div>
      <div class="mod-muted"><strong>Characters:</strong> ${safeText(charsText)}</div>
    `;

    card.addEventListener('click', () => {
      openAccountModal(account.uid);
      renderGrid();
    });

    grid.appendChild(card);
  });

  updatePager();
}

function formatTs(ts) {
  if (!ts) return 'Unknown time';
  if (typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
  if (typeof ts === 'string' || typeof ts === 'number') return new Date(ts).toLocaleString();
  return 'Unknown time';
}

async function persistModerationAccount(uid, patch) {
  await setDoc(doc(db, 'moderation_accounts', uid), patch, { merge: true });
  const existing = moderationByUid.get(uid) || { id: uid };
  moderationByUid.set(uid, { ...existing, ...patch });
}

async function logAction(action) {
  const ref = await addDoc(collection(db, 'moderation_actions'), {
    ...action,
    createdAt: serverTimestamp()
  });

  const bucket = actionsByUid.get(action.accountUid) || [];
  bucket.unshift({ id: ref.id, ...action, createdAt: new Date().toISOString() });
  actionsByUid.set(action.accountUid, bucket);
}

async function applyStatusChange(uid, nextStatus, reason, source = 'manual') {
  const account = buildAccountViewModel(allAccounts.find(row => row.uid === uid) || { uid, email: '' });
  const before = account.status;
  if (!reason.trim()) throw new Error('Reason is required for status changes.');

  await persistModerationAccount(uid, {
    ign: account.ign,
    status: nextStatus,
    email: account.email,
    updatedAt: serverTimestamp(),
    updatedByUid: currentUser.uid,
    updatedByEmail: currentUser.email || ''
  });

  await logAction({
    accountUid: uid,
    ignSnapshot: account.ign,
    actionType: 'status_change',
    source,
    statusBefore: before,
    statusAfter: nextStatus,
    reason,
    issuedBy: currentUser.email || 'Unknown Moderator',
    createdByUid: currentUser.uid,
    createdByEmail: currentUser.email || ''
  });
}

function renderDetails(uid, targetElementId = 'accountModalBody') {
  const details = document.getElementById(targetElementId);
  const account = allAccounts.find(row => row.uid === uid);
  if (!account) {
    details.innerHTML = '<div class="mod-muted">Select an account card to view and manage its moderation record.</div>';
    return;
  }

  const model = buildAccountViewModel(account);
  const charText = model.characters.length
    ? model.characters.map(char => `${char.name || 'Unknown'}${char.pid ? ` (${char.pid})` : ''}`).join(', ')
    : 'No linked characters';

  const actionRows = actionsByUid.get(uid) || [];
  const timeline = actionRows.length
    ? actionRows.map(row => {
        const rulesText = Array.isArray(row.ruleCodes) && row.ruleCodes.length
          ? row.ruleCodes.join(', ')
          : row.ruleCode || '';
        const ruleText = rulesText
          ? `<div class="mod-muted"><strong>Rules:</strong> ${rulesText}</div>`
          : '';
        const statusText = row.statusAfter ? `<div class="mod-muted"><strong>Status:</strong> ${safeText(row.statusBefore, 'N/A')} → ${safeText(row.statusAfter, 'N/A')}</div>` : '';
        const actionLabel = ACTION_LABELS[row.actionType] || safeText(row.actionType, 'action').replace(/_/g, ' ');
        return `
          <div class="action-item">
            <div class="action-title">${actionLabel.toUpperCase()}</div>
            ${statusText}
            ${ruleText}
            <div class="mod-muted"><strong>Reason:</strong> ${safeText(row.reason, 'No reason recorded')}</div>
            <div class="mod-muted"><strong>Issued By:</strong> ${safeText(row.issuedBy, 'Unknown')}</div>
            <div class="mod-muted"><strong>Time:</strong> ${formatTs(row.createdAt)}</div>
          </div>
        `;
      }).join('')
    : '<div class="mod-muted">No recorded actions for this account.</div>';

  details.innerHTML = `
    <div class="detail-top">
      <div class="detail-card">
        <div style="font-size:1.15rem; font-weight:700; color:var(--accent-mint); margin-bottom:0.4rem;">${model.ign}</div>
        <div class="mod-muted"><strong>Status:</strong> <span class="mod-pill ${statusClass(model.status)}">${model.status}</span></div>
        <div class="mod-muted" style="margin-top:0.3rem;"><strong>Email:</strong> ${safeText(model.email, 'No email')}</div>
        <div class="mod-muted" style="margin-top:0.3rem;"><strong>UID:</strong> ${model.uid}</div>
      </div>

      <div class="detail-card">
        <label style="display:block; margin-bottom:0.4rem;">IGN (Minecraft Username)</label>
        <input id="detailIgn" class="mod-input" type="text" value="${model.ign}" style="width:100%; min-width:0;">

        <label style="display:block; margin:0.8rem 0 0.4rem 0;">Status</label>
        <select id="detailStatus" class="mod-select" style="width:100%;">
          ${STATUS_ORDER.map(status => `<option value="${status}" ${status === model.status ? 'selected' : ''}>${status}</option>`).join('')}
        </select>

        <label style="display:block; margin:0.8rem 0 0.4rem 0;">Reason (required for status changes)</label>
        <textarea id="detailReason" class="mod-textarea" placeholder="Enter reason for status update..."></textarea>

        <div style="display:flex; gap:0.6rem; margin-top:0.7rem;">
          <button id="saveAccountBtn" class="btn-primary" type="button">Save</button>
        </div>
        <div id="detailFeedback" class="feedback"></div>
      </div>
    </div>

    <div class="detail-card" style="margin-bottom:1rem;">
      <div style="font-weight:700; color:var(--accent-mint); margin-bottom:0.4rem;">Linked Characters</div>
      <div class="mod-muted">${charText}</div>
    </div>

    <div class="action-list">${timeline}</div>
  `;

  const saveBtn = document.getElementById('saveAccountBtn');
  const detailFeedback = document.getElementById('detailFeedback');

  saveBtn.addEventListener('click', async () => {
    const ign = (document.getElementById('detailIgn').value || '').trim();
    const nextStatus = document.getElementById('detailStatus').value;
    const reason = (document.getElementById('detailReason').value || '').trim();

    try {
      const updates = {
        ign: ign || model.ign,
        email: model.email,
        updatedAt: serverTimestamp(),
        updatedByUid: currentUser.uid,
        updatedByEmail: currentUser.email || ''
      };

      const hasStatusChange = nextStatus !== model.status;
      if (hasStatusChange && !reason) {
        throw new Error('Reason is required when changing status.');
      }

      if (hasStatusChange) {
        updates.status = nextStatus;
      } else {
        updates.status = model.status;
      }

      await persistModerationAccount(uid, updates);

      if (hasStatusChange) {
        await logAction({
          accountUid: uid,
          ignSnapshot: ign || model.ign,
          actionType: 'status_change',
          source: 'manual',
          statusBefore: model.status,
          statusAfter: nextStatus,
          reason,
          issuedBy: currentUser.email || 'Unknown Moderator',
          createdByUid: currentUser.uid,
          createdByEmail: currentUser.email || ''
        });
      }

      setFeedback(detailFeedback, hasStatusChange ? 'Account updated and status change logged.' : 'Account details saved.');
      renderGrid();
      renderDetails(uid, targetElementId);
    } catch (error) {
      setFeedback(detailFeedback, error.message || 'Failed to save account.', true);
    }
  });
}

function populateViolationFormOptions() {
  const accountSelect = document.getElementById('violationAccount');
  const ruleSelect = document.getElementById('violationRule');

  accountSelect.innerHTML = '';
  allAccounts.map(buildAccountViewModel).forEach(account => {
    const option = document.createElement('option');
    option.value = account.uid;
    option.textContent = `${account.ign} — ${account.email || account.uid}`;
    accountSelect.appendChild(option);
  });

  ruleSelect.innerHTML = '';
  if (!rulesCatalog.length) {
    const fallback = document.createElement('option');
    fallback.value = '';
    fallback.textContent = 'Rulebook unavailable';
    ruleSelect.appendChild(fallback);
    document.getElementById('suggestedAction').textContent = 'Rulebook unavailable. Unable to calculate severity/escalation guidance.';
    return;
  }

  rulesCatalog.forEach(rule => {
    const option = document.createElement('option');
    option.value = rule.code;
    option.textContent = `${rule.code} — ${rule.title}`;
    option.dataset.title = rule.title;
    ruleSelect.appendChild(option);
  });
}

function getSelectedRuleCodes() {
  const ruleSelect = document.getElementById('violationRule');
  if (!ruleSelect) return [];
  return Array.from(ruleSelect.selectedOptions || [])
    .map(option => option.value)
    .filter(Boolean);
}

function buildViolationAnalysis(accountUid, ruleCodes) {
  const accountRow = allAccounts.find(row => row.uid === accountUid);
  if (!accountRow || !ruleCodes.length) {
    return { totalScore: 0, rows: [], top: null };
  }

  const account = buildAccountViewModel(accountRow);
  const rows = ruleCodes.map(code => {
    const rule = rulesCatalog.find(item => item.code === code);
    const escalation = resolveEscalationForRule(account, code);
    return {
      code,
      title: rule?.title || 'Rule Violation',
      ...escalation
    };
  });

  const totalScore = rows.reduce((sum, row) => sum + row.score, 0);
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const top = sorted[0] || null;

  return { totalScore, rows, top };
}

function refreshViolationAnalysis() {
  const accountUid = document.getElementById('violationAccount').value;
  const ruleCodes = getSelectedRuleCodes();
  const suggestedActionElement = document.getElementById('suggestedAction');
  const severityElement = document.getElementById('severityBreakdown');
  const actionSelect = document.getElementById('violationAction');

  if (!ruleCodes.length) {
    suggestedActionElement.textContent = 'Select one or more rules to view severity score and escalation guidance.';
    severityElement.innerHTML = `
      <div class="severity-total">Total Severity Score: 0</div>
      <div class="mod-muted">No rules selected.</div>
    `;
    actionSelect.value = 'verbal_warning';
    return;
  }

  const analysis = buildViolationAnalysis(accountUid, ruleCodes);
  if (!analysis.top) {
    suggestedActionElement.textContent = 'Unable to build escalation guidance for the selected rules.';
    return;
  }

  suggestedActionElement.textContent = `Suggested action: ${ACTION_LABELS[analysis.top.recommendedAction] || 'Review manually'} (highest severity rule ${analysis.top.code}, ${analysis.top.stageLabel.toLowerCase()}).`;
  actionSelect.value = analysis.top.recommendedAction;

  const rowsMarkup = analysis.rows
    .map(row => {
      const isTop = analysis.top && row.code === analysis.top.code;
      return `
        <li>
          <div class="severity-item-top ${isTop ? 'primary' : ''}">${row.code} — ${row.title} (Score ${row.score}, ${row.tier})${isTop ? ' • Highest Severity' : ''}</div>
          <div class="severity-step"><strong>Escalation:</strong> 1st: ${row.steps.first} • 2nd: ${row.steps.second} • 3rd: ${row.steps.third}</div>
          <div class="severity-step"><strong>Current Recommendation:</strong> ${row.stageLabel} → ${row.recommendedStep}</div>
          <div class="severity-step"><strong>Prior for this topic:</strong> ${row.prior.priorWritten} written warning(s), ${row.prior.priorEscalated} escalated action(s)</div>
        </li>
      `;
    })
    .join('');

  severityElement.innerHTML = `
    <div class="severity-total">Total Severity Score: ${analysis.totalScore}</div>
    <ul class="severity-list">${rowsMarkup}</ul>
  `;
}

function openViolationModal() {
  document.getElementById('violationModal').classList.add('show');
  document.getElementById('violationModal').setAttribute('aria-hidden', 'false');
  document.getElementById('violationFeedback').textContent = '';
  populateViolationFormOptions();
  refreshViolationAnalysis();
}

function closeViolationModal() {
  document.getElementById('violationModal').classList.remove('show');
  document.getElementById('violationModal').setAttribute('aria-hidden', 'true');
}

function wireViolationModal() {
  document.getElementById('newViolationBtn').addEventListener('click', openViolationModal);
  document.getElementById('violationModalClose').addEventListener('click', closeViolationModal);
  document.getElementById('cancelViolationBtn').addEventListener('click', closeViolationModal);

  document.getElementById('violationRule').addEventListener('change', refreshViolationAnalysis);
  document.getElementById('violationAccount').addEventListener('change', refreshViolationAnalysis);

  document.getElementById('submitViolationBtn').addEventListener('click', async () => {
    const accountUid = document.getElementById('violationAccount').value;
    const selectedRuleCodes = getSelectedRuleCodes();
    const reason = (document.getElementById('violationReason').value || '').trim();
    const issuer = (document.getElementById('violationIssuer').value || '').trim();
    const actionType = document.getElementById('violationAction').value;
    const feedback = document.getElementById('violationFeedback');

    try {
      if (!accountUid) throw new Error('Select an account username/IGN.');
      if (!selectedRuleCodes.length) throw new Error('Select at least one violated rule.');
      if (!reason) throw new Error('Description/reason is required.');
      if (!issuer) throw new Error('Issuer is required.');

      const accountRow = allAccounts.find(row => row.uid === accountUid);
      if (!accountRow) throw new Error('Selected account was not found.');

      const account = buildAccountViewModel(accountRow);
      const selectedRules = selectedRuleCodes.map(code => rulesCatalog.find(rule => rule.code === code)).filter(Boolean);
      const analysis = buildViolationAnalysis(accountUid, selectedRuleCodes);
      const topRule = analysis.top;
      const offRecord = actionType === 'verbal_warning';

      let statusAfter = account.status;
      if (actionType === 'written_warning') statusAfter = STATUS.WARNED;
      if (actionType === 'add_strike' || actionType === 'add_2_strikes' || actionType === 'add_3_strikes') {
        const strikeDelta = actionType === 'add_2_strikes' ? 2 : actionType === 'add_3_strikes' ? 3 : 1;
        statusAfter = applyStrikeDelta(account.status, strikeDelta);
        if (statusAfter === null) throw new Error(`${account.ign} has already reached the maximum amount of strikes. Consider a more severe punishment.`);
      }
      if (actionType === 'temp_ban') statusAfter = STATUS.TEMP_BAN;
      if (actionType === 'ban') statusAfter = STATUS.BAN;

      if (!offRecord) {
        await addDoc(collection(db, 'moderation_actions'), {
          accountUid,
          ignSnapshot: account.ign,
          actionType,
          source: 'violation',
          ruleCode: topRule?.code || selectedRuleCodes[0],
          ruleTitle: topRule?.title || selectedRules[0]?.title || '',
          ruleCodes: selectedRuleCodes,
          ruleTitles: selectedRules.map(rule => `${rule.code} — ${rule.title}`),
          severityTotal: analysis.totalScore,
          severityPrimaryScore: topRule?.score || 0,
          reason,
          issuedBy: issuer,
          statusBefore: account.status,
          statusAfter,
          createdByUid: currentUser.uid,
          createdByEmail: currentUser.email || '',
          createdAt: serverTimestamp()
        });

        const bucket = actionsByUid.get(accountUid) || [];
        bucket.unshift({
          accountUid,
          ignSnapshot: account.ign,
          actionType,
          source: 'violation',
          ruleCode: topRule?.code || selectedRuleCodes[0],
          ruleTitle: topRule?.title || selectedRules[0]?.title || '',
          ruleCodes: selectedRuleCodes,
          ruleTitles: selectedRules.map(rule => `${rule.code} — ${rule.title}`),
          severityTotal: analysis.totalScore,
          severityPrimaryScore: topRule?.score || 0,
          reason,
          issuedBy: issuer,
          statusBefore: account.status,
          statusAfter,
          createdByUid: currentUser.uid,
          createdByEmail: currentUser.email || '',
          createdAt: new Date().toISOString()
        });
        actionsByUid.set(accountUid, bucket);

        if (statusAfter !== account.status) {
          await persistModerationAccount(accountUid, {
            ign: account.ign,
            email: account.email,
            status: statusAfter,
            updatedAt: serverTimestamp(),
            updatedByUid: currentUser.uid,
            updatedByEmail: currentUser.email || ''
          });
        }

        await sendModerationNotification(account, actionType, reason, issuer, selectedRuleCodes);
      }

      if (offRecord) {
        setFeedback(feedback, 'Verbal warning submitted as off-record. No status/log/email changes were made.');
      } else {
        setFeedback(feedback, 'Violation recorded successfully.');
      }

      renderGrid();
      if (activeUid === accountUid && document.getElementById('accountModal').classList.contains('show')) {
        renderDetails(accountUid, 'accountModalBody');
      }

      setTimeout(() => closeViolationModal(), 500);
    } catch (error) {
      setFeedback(feedback, error.message || 'Failed to submit violation.', true);
    }
  });
}

function wireFilters() {
  document.getElementById('searchInput').addEventListener('input', () => {
    currentPage = 1;
    renderGrid();
  });
  document.getElementById('statusFilter').addEventListener('change', () => {
    currentPage = 1;
    renderGrid();
  });
}

function wirePagination() {
  document.getElementById('prevPageBtn').addEventListener('click', () => {
    if (currentPage <= 1) return;
    currentPage -= 1;
    renderGrid();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  document.getElementById('nextPageBtn').addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredAccounts.length / PAGE_SIZE));
    if (currentPage >= totalPages) return;
    currentPage += 1;
    renderGrid();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

function wireAccountModal() {
  const modal = document.getElementById('accountModal');
  const closeBtn = document.getElementById('accountModalClose');

  closeBtn.addEventListener('click', closeAccountModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) {
      closeAccountModal();
    }
  });
}

async function initializePanel() {
  const loadingState = document.getElementById('loadingState');
  const accessDenied = document.getElementById('accessDenied');
  const managementContainer = document.getElementById('managementContainer');

  let authComplete = false;
  const timeout = setTimeout(() => {
    if (authComplete) return;
    loadingState.style.display = 'none';
    accessDenied.style.display = 'block';
    accessDenied.innerHTML = `
      <i class="fas fa-exclamation-triangle" style="font-size:3rem;margin-bottom:1rem;opacity:0.6;display:block;"></i>
      <h2>Connection Timeout</h2>
      <p>The page took too long to authenticate with Firebase. Please refresh and try again.</p>
    `;
  }, 10000);

  onAuthStateChanged(auth, async user => {
    authComplete = true;
    clearTimeout(timeout);

    if (!user) {
      loadingState.style.display = 'none';
      accessDenied.style.display = 'block';
      return;
    }

    currentUser = user;

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

      let hasAccess = hasRoleplayManagerOrAboveFromUserDoc(user, userDoc);
      charSnap.forEach(docSnap => {
        const row = docSnap.data() || {};
        const dept = (row.department || '').toLowerCase();
        if (dept.includes('ia') || dept.includes('raisa') || hasRoleplayManagerOrAboveFromCharacter(row)) {
          hasAccess = true;
        }
      });

      if (!hasAccess) {
        loadingState.style.display = 'none';
        accessDenied.style.display = 'block';
        return;
      }

      await Promise.all([
        loadRuleCatalog(),
        loadBaseData()
      ]);

      loadingState.style.display = 'none';
      managementContainer.style.display = 'block';

      wireFilters();
      wirePagination();
      wireAccountModal();
      wireViolationModal();
      renderGrid();
    } catch (error) {
      console.error('Failed to initialize moderation panel:', error);
      loadingState.style.display = 'none';
      accessDenied.style.display = 'block';
      accessDenied.innerHTML = `
        <i class="fas fa-exclamation-circle" style="font-size:3rem;margin-bottom:1rem;opacity:0.6;display:block;"></i>
        <h2>Error Loading Moderation Panel</h2>
        <p>${error.message || 'Unexpected error.'}</p>
      `;
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('includesLoaded', initializePanel);
} else {
  initializePanel();
}
