/**
 * Admin Community Analytics Dashboard
 * Pulls data from Firestore, Discord invite API, and Minecraft status API.
 *
 * Collections used:
 *   events/{id}                   – site events
 *   events/{id}/rsvps/{charId}    – RSVPs per event
 *   characters/{id}               – player characters
 *   community_snapshots/{id}      – manually logged member counts
 *   event_attendance_reports/{id} – staff-submitted attendance records
 *   settings/community_config     – persisted Discord invite code
 */

import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  where,
  limit,
  serverTimestamp,
  Timestamp
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-functions.js';

// ─── Config ───────────────────────────────────────────────────────────────────
const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';
const MC_API        = 'https://api.mcsrvstat.us/2/play.site89.org';
const DISCORD_INVITE_API = 'https://discord.com/api/v9/invites/';
const EMAIL_FETCH_LIMIT = 1500;
const EXCLUDED_ANALYTICS_SENDERS = new Set(['fd.mgmt@site89.org']);
const EMAIL_SNOOP_PAGE_SIZE = 50;

const db = getFirestore(app);
const functionsClient = getFunctions(app);
const purgeMailboxEmailsCallable = httpsCallable(functionsClient, 'purgeMailboxEmails');

// ─── State ────────────────────────────────────────────────────────────────────
let currentUser   = null;
let eventsCache   = [];        // all events
let rsvpCache     = new Map(); // eventId → count
let snapshotsCache = [];       // sorted community_snapshots
let reportsCache  = [];        // event_attendance_reports
let emailsCache   = [];        // recent emails
let charCount     = 0;
let emailSnoopPage = 1;
let emailSnoopSelectedId = null;

// Chart instances — destroyed & re-created on refresh
const charts = {};

const EMAIL_CATEGORIES = [
  {
    key: 'operations',
    label: 'Operations',
    icon: 'fa-screwdriver-wrench',
    keywords: {
      ops: 3, operation: 3, incident: 3, anomaly: 2, containment: 3, breach: 3,
      clearance: 2, assignment: 2, requisition: 2, logistics: 2, maintenance: 2
    }
  },
  {
    key: 'events',
    label: 'Events',
    icon: 'fa-calendar-days',
    keywords: {
      event: 3, briefing: 2, debrief: 2, attendance: 2, schedule: 2, rsvp: 4,
      meetup: 2, exercise: 2, training: 2
    }
  },
  {
    key: 'personnel',
    label: 'Personnel',
    icon: 'fa-user-group',
    keywords: {
      personnel: 3, recruitment: 2, onboarding: 2, promotion: 2, transfer: 2,
      hr: 2, disciplinary: 2, leave: 1, resignation: 3
    }
  },
  {
    key: 'finance',
    label: 'Finance',
    icon: 'fa-building-columns',
    keywords: {
      bank: 4, payroll: 4, budget: 3, invoice: 3, payment: 4, transaction: 4,
      funds: 3, reimbursement: 3, stipend: 2
    }
  },
  {
    key: 'intel',
    label: 'Intel & Reports',
    icon: 'fa-magnifying-glass-chart',
    keywords: {
      intel: 4, report: 3, dossier: 3, observation: 2, surveillance: 3,
      investigation: 3, findings: 2, evidence: 3
    }
  },
  {
    key: 'social',
    label: 'Social',
    icon: 'fa-comments',
    keywords: {
      thanks: 2, congratulations: 2, welcome: 2, party: 2, celebration: 2,
      social: 2, appreciation: 2, checkin: 1, 'check-in': 1
    }
  }
];

// ─── Utility ──────────────────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str ?? '');
  return d.innerHTML;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : (ts.toDate ? ts.toDate() : new Date(ts));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'manager') return 'manager';
  if (role === 'raisa') return 'manager';
  return 'member';
}

function canAccessManagerTools(user, userDoc) {
  if (!user) return false;
  if (user.email === PRIMARY_ADMIN_EMAIL) return true;
  if (userDoc?.isAdmin === true) return true;
  const role = normalizeRole(userDoc?.role);
  return role === 'manager' || role === 'admin';
}

function fmtDateShort(ts) {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : (ts.toDate ? ts.toDate() : new Date(ts));
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getFullYear()}`;
}

function monthKey(ts) {
  const d = ts instanceof Date ? ts : (ts.toDate ? ts.toDate() : new Date(ts));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
  const [y, m] = key.split('-');
  const d = new Date(Number(y), Number(m) - 1, 1);
  return d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function last12MonthKeys() {
  const keys = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<i class="fa-solid fa-${type === 'success' ? 'check-circle' : 'circle-exclamation'}"></i> ${esc(msg)}`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtCount(value) {
  return typeof value === 'number' ? value.toLocaleString() : '—';
}

function normalizeEmailAddress(value) {
  return String(value || '').trim().toLowerCase();
}

function prettyMailboxName(value) {
  const normalized = normalizeEmailAddress(value);
  if (!normalized) return 'Unknown';
  if (!normalized.includes('@')) return normalized;
  const [local, domain] = normalized.split('@');
  if (domain === 'site89.org') return local;
  return normalized;
}

function resolveSenderMailbox(email) {
  const senderMailbox = normalizeEmailAddress(email?.sender || '');
  const senderAccount = normalizeEmailAddress(email?.senderEmail || '');

  // Prefer in-universe mailbox identity for analytics display/ranking.
  if (senderMailbox.endsWith('@site89.org')) return senderMailbox;
  if (senderAccount.endsWith('@site89.org')) return senderAccount;

  return senderMailbox || senderAccount || 'unknown';
}

function toDateSafe(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value.toDate === 'function') return value.toDate();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function weekKey(date) {
  const d = startOfWeek(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildEmailCategory(text, senderEmail, recipientCount) {
  const scores = EMAIL_CATEGORIES.map(cat => {
    let score = 0;
    for (const [keyword, weight] of Object.entries(cat.keywords)) {
      if (text.includes(keyword)) score += weight;
    }
    return { key: cat.key, score };
  });

  if (senderEmail.includes('bank@')) {
    const fin = scores.find(s => s.key === 'finance');
    if (fin) fin.score += 4;
  }

  if (recipientCount >= 8) {
    const ops = scores.find(s => s.key === 'operations');
    if (ops) ops.score += 2;
  }

  scores.sort((a, b) => b.score - a.score);
  const winner = scores[0];
  if (!winner || winner.score <= 0) return 'uncategorized';
  return winner.key;
}

function emptyRankHtml(message) {
  return `<div class="empty-state" style="padding:1.25rem .75rem;"><i class="fa-solid fa-inbox"></i>${esc(message)}</div>`;
}

function renderRankRows(containerId, rows, valueSuffix = '') {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = emptyRankHtml('No records in the selected period.');
    return;
  }

  el.innerHTML = rows.map((row, idx) => `
    <div class="rank-row">
      <span class="rank-idx">${idx + 1}</span>
      <span class="rank-name" title="${esc(row.name)}">${esc(row.name)}</span>
      <span class="rank-val">${row.value}${esc(valueSuffix)}</span>
    </div>
  `).join('');
}

const noteMarkersPlugin = {
  id: 'noteMarkers',
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const items = pluginOptions?.items ?? [];
    if (!items.length) return;

    const { ctx, chartArea, scales } = chart;
    const xScale = scales?.x;
    if (!xScale || !chartArea) return;

    ctx.save();
    items.forEach((item) => {
      const x = xScale.getPixelForValue(item.index);
      if (!Number.isFinite(x) || x < chartArea.left || x > chartArea.right) return;

      ctx.strokeStyle = 'rgba(255, 214, 102, 0.65)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(255, 214, 102, 0.95)';
      ctx.beginPath();
      ctx.arc(x, chartArea.top + 6, 2.2, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }
};

function destroyChart(key) {
  if (charts[key]) { charts[key].destroy(); delete charts[key]; }
}

const CHART_DEFAULTS = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  plugins: { legend: { display: false } },
  scales: {
    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 } } },
    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.5)', font: { size: 11 } }, beginAtZero: true }
  }
};

// ─── Auth gate ─────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  const loadEl   = document.getElementById('loadingState');
  const deniedEl = document.getElementById('accessDenied');
  const dashEl   = document.getElementById('dashContent');

  if (!user) {
    loadEl.style.display  = 'none';
    deniedEl.style.display = 'flex';
    return;
  }

  let userDoc = null;
  try {
    const userSnap = await getDoc(doc(db, 'users', user.uid));
    userDoc = userSnap.exists() ? userSnap.data() : null;
  } catch {
    userDoc = null;
  }

  if (!canAccessManagerTools(user, userDoc)) {
    loadEl.style.display  = 'none';
    deniedEl.style.display = 'flex';
    return;
  }

  currentUser = user;
  loadEl.style.display  = 'none';
  dashEl.style.display  = 'block';

  initTabs();
  await loadAllData();
  renderDashboard();
  setupRefresh();
  setupForms();

  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadAllData();
    renderDashboard();
  });
});

// ─── Tabs ──────────────────────────────────────────────────────────────────────
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      if (pane) pane.classList.add('active');
    });
  });
}

// ─── Load all data ─────────────────────────────────────────────────────────────
async function loadAllData() {
  // Parallel fetches
  const [eventsSnap, charsSnap, snapsSnap, reportsSnap, configDoc, emailsSnap] = await Promise.all([
    getDocs(query(collection(db, 'events'), orderBy('start', 'desc'))),
    getDocs(collection(db, 'characters')),
    getDocs(query(collection(db, 'community_snapshots'), orderBy('date', 'asc'))),
    getDocs(query(collection(db, 'event_attendance_reports'), orderBy('eventDate', 'desc'))),
    getDoc(doc(db, 'settings/community_config')),
    getDocs(query(collection(db, 'emails'), orderBy('ts', 'desc'), limit(EMAIL_FETCH_LIMIT)))
  ]);

  // Events
  eventsCache = eventsSnap.docs.map(d => {
    const data = d.data();
    // Firestore stores the date as 'start'; normalize to 'startDate' for all downstream code
    return { id: d.id, ...data, startDate: data.start ?? data.startDate ?? null };
  });
  charCount   = charsSnap.size;

  // Community snapshots
  snapshotsCache = snapsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Attendance reports
  reportsCache = reportsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // Emails
  emailsCache = emailsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // RSVP counts — fetch for events in the last 6 months to keep reads manageable
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const recentEvents = eventsCache.filter(e => {
    const d = e.startDate?.toDate?.() ?? (e.startDate instanceof Date ? e.startDate : null);
    return d && d > sixMonthsAgo;
  });

  await Promise.all(recentEvents.map(async (event) => {
    const rsvpSnap = await getDocs(collection(db, 'events', event.id, 'rsvps'));
    rsvpCache.set(event.id, rsvpSnap.size);
  }));

  // Discord config
  if (configDoc.exists()) {
    const code = configDoc.data().discordInviteCode;
    if (code) {
      const input = document.getElementById('discordInviteInput');
      if (input) input.value = code;
      fetchDiscordLive(code);
    }
  }

  document.getElementById('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// ─── Discord live ──────────────────────────────────────────────────────────────
async function fetchDiscordLive(code) {
  if (!code) return;
  try {
    const res  = await fetch(`${DISCORD_INVITE_API}${encodeURIComponent(code)}?with_counts=true`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const nameEl   = document.getElementById('discordLiveName');
    const totalEl  = document.getElementById('discordLiveTotal');
    const onlineEl = document.getElementById('discordLiveOnline');

    if (nameEl)   nameEl.textContent   = data.guild?.name ?? '—';
    if (totalEl)  totalEl.textContent  = (data.approximate_member_count ?? '—').toLocaleString();
    if (onlineEl) onlineEl.textContent = (data.approximate_presence_count ?? '—').toLocaleString();
  } catch (err) {
    console.warn('[Analytics] Discord live fetch failed:', err.message);
  }
}

// ─── Render ────────────────────────────────────────────────────────────────────
function renderDashboard() {
  renderOverview();
  renderCommunity();
  renderEvents();
  renderServer();
  renderEmail();
  renderReports();
}

// ══ Email ═════════════════════════════════════════════════════════════════════

function buildEmailAnalytics(days = 90) {
  const now = new Date();
  const windowStart = new Date(now);
  windowStart.setDate(windowStart.getDate() - days);

  const recent = emailsCache
    .filter(email => {
      const date = toDateSafe(email.ts ?? email.createdAt ?? email.sentAt);
      return date && date >= windowStart && date <= now;
    })
    .filter(email => {
      const senderMailbox = resolveSenderMailbox(email);
      const senderAccount = normalizeEmailAddress(email.senderEmail || '');
      return !EXCLUDED_ANALYTICS_SENDERS.has(senderMailbox) && !EXCLUDED_ANALYTICS_SENDERS.has(senderAccount);
    });

  const categoryCounts = new Map();
  const recipientCounts = new Map();
  const senderCounts = new Map();
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  const hourCounts = Array.from({ length: 24 }, () => 0);
  let totalRecipients = 0;
  let broadcastEmails = 0;
  let externalRecipientTouches = 0;

  const allWeekKeys = [];
  const currentWeek = startOfWeek(now);
  for (let i = 11; i >= 0; i--) {
    const d = new Date(currentWeek);
    d.setDate(d.getDate() - (i * 7));
    allWeekKeys.push(weekKey(d));
  }
  const weekMap = Object.fromEntries(allWeekKeys.map(key => [key, 0]));

  recent.forEach(email => {
    const subject = String(email.subject || '');
    const body = String(email.body || '');
    const senderMailbox = resolveSenderMailbox(email);
    const senderAccount = normalizeEmailAddress(email.senderEmail || '');
    const categorySenderContext = `${senderMailbox} ${senderAccount}`.trim();
    const recipientsRaw = Array.isArray(email.recipients) ? email.recipients : [];
    const recipients = recipientsRaw
      .map(normalizeEmailAddress)
      .filter(Boolean)
      .filter((value, idx, arr) => arr.indexOf(value) === idx);

    totalRecipients += recipients.length;
    if (recipients.length >= 8) broadcastEmails += 1;

    recipients.forEach(recipient => {
      recipientCounts.set(recipient, (recipientCounts.get(recipient) ?? 0) + 1);
      if (!recipient.endsWith('@site89.org')) externalRecipientTouches += 1;
    });
    senderCounts.set(senderMailbox, (senderCounts.get(senderMailbox) ?? 0) + 1);

    const date = toDateSafe(email.ts ?? email.createdAt ?? email.sentAt);
    if (date) {
      dayCounts[date.getDay()] += 1;
      hourCounts[date.getHours()] += 1;
      const wk = weekKey(date);
      if (wk in weekMap) weekMap[wk] += 1;
    }

    const text = `${subject} ${body}`.toLowerCase();
    const cat = buildEmailCategory(text, categorySenderContext, recipients.length);
    categoryCounts.set(cat, (categoryCounts.get(cat) ?? 0) + 1);
  });

  const sortedCategories = [...categoryCounts.entries()]
    .map(([key, count]) => {
      const info = EMAIL_CATEGORIES.find(c => c.key === key);
      return {
        key,
        label: info?.label ?? 'Uncategorized',
        icon: info?.icon ?? 'fa-circle-question',
        count
      };
    })
    .sort((a, b) => b.count - a.count);

  const topRecipients = [...recipientCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([email, count]) => ({ name: prettyMailboxName(email), value: count, raw: email }));

  const topSenders = [...senderCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([email, count]) => ({ name: prettyMailboxName(email), value: count, raw: email }));

  const maxDayIndex = dayCounts.indexOf(Math.max(...dayCounts));
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const peakDay = maxDayIndex >= 0 ? dayNames[maxDayIndex] : '—';

  const maxHourIndex = hourCounts.indexOf(Math.max(...hourCounts));
  const peakHour = maxHourIndex >= 0
    ? new Date(2000, 0, 1, maxHourIndex, 0).toLocaleTimeString('en-US', { hour: 'numeric' })
    : '—';

  const avgRecipients = recent.length ? (totalRecipients / recent.length) : 0;

  const weeklyLabels = allWeekKeys.map(weekLabel);
  const weeklyCounts = allWeekKeys.map(key => weekMap[key] ?? 0);

  return {
    days,
    windowStart,
    totalEmails: recent.length,
    uniqueRecipients: recipientCounts.size,
    uniqueSenders: senderCounts.size,
    avgRecipients,
    broadcastEmails,
    externalRecipientTouches,
    peakDay,
    peakHour,
    categories: sortedCategories,
    topRecipients,
    topSenders,
    weeklyLabels,
    weeklyCounts
  };
}

function renderEmail() {
  const analytics = buildEmailAnalytics(90);
  const kpi = document.getElementById('emailKpiGrid');
  if (kpi) {
    kpi.innerHTML = `
      ${statCard('fa-envelope', analytics.totalEmails, 'Emails (90 Days)', `${fmtDate(analytics.windowStart)} to now`) }
      ${statCard('fa-inbox', analytics.uniqueRecipients, 'Unique Recipients', 'Distinct inboxes touched')}
      ${statCard('fa-paper-plane', analytics.uniqueSenders, 'Unique Senders', 'Distinct character/account sender mailboxes')}
      ${statCard('fa-users', analytics.avgRecipients.toFixed(1), 'Avg Recipients / Email', 'Distribution breadth')}
      ${statCard('fa-bullhorn', analytics.broadcastEmails, 'Broadcast Emails', '8+ recipients in one send')}
      ${statCard('fa-clock', analytics.peakDay, 'Peak Email Day', `${analytics.peakHour} most active hour`, '', '', 'stat-value-text')}
    `;
  }

  renderEmailTypeChart(analytics);
  renderEmailCategoryTable(analytics);
  renderRankRows('topRecipientsList', analytics.topRecipients, ' msgs');
  renderRankRows('topSendersList', analytics.topSenders, ' sent');
  renderEmailInsights(analytics);
  renderEmailTrendChart(analytics);
  renderEmailSnoop();
}

function getEmailRecipientsText(recipients) {
  return Array.isArray(recipients) ? recipients.join(', ') : '';
}

function getEmailPlainBody(email) {
  const raw = String(email?.body || '');
  if (!email?.isHTML) return raw;
  const temp = document.createElement('div');
  temp.innerHTML = raw;
  return (temp.textContent || temp.innerText || '').trim();
}

function startOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function endOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59.999`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatEmailDateTime(value) {
  const date = toDateSafe(value);
  return date ? date.toLocaleString() : '—';
}

function getEmailSnoopFilteredRows() {
  const searchInput = document.getElementById('emailSnoopSearchInput');
  const folderFilter = document.getElementById('emailSnoopFolderFilter');
  const statusFilter = document.getElementById('emailSnoopStatusFilter');
  const fromDate = document.getElementById('emailSnoopFromDate');
  const toDate = document.getElementById('emailSnoopToDate');

  const search = String(searchInput?.value || '').trim().toLowerCase();
  const folder = String(folderFilter?.value || '').trim().toLowerCase();
  const status = String(statusFilter?.value || '').trim().toLowerCase();
  const from = startOfDay(fromDate?.value || '');
  const to = endOfDay(toDate?.value || '');

  return emailsCache.filter((email) => {
    const emailFolder = String(email.folder || '').toLowerCase();
    const emailStatus = String(email.status || '').toLowerCase();
    const emailDate = toDateSafe(email.ts ?? email.createdAt ?? email.sentAt);

    if (folder && emailFolder !== folder) return false;
    if (status && emailStatus !== status) return false;

    if (from || to) {
      if (!emailDate) return false;
      if (from && emailDate < from) return false;
      if (to && emailDate > to) return false;
    }

    if (search) {
      const haystack = [
        email.sender || '',
        email.senderEmail || '',
        getEmailRecipientsText(email.recipients),
        email.subject || '',
        getEmailPlainBody(email),
        email.status || '',
        email.folder || ''
      ].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }

    return true;
  });
}

function renderEmailSnoop() {
  const body = document.getElementById('emailSnoopBody');
  const totalEl = document.getElementById('emailSnoopTotalCount');
  const filteredEl = document.getElementById('emailSnoopFilteredCount');
  const pageInfo = document.getElementById('emailSnoopPageInfo');
  const prevBtn = document.getElementById('emailSnoopPrevBtn');
  const nextBtn = document.getElementById('emailSnoopNextBtn');
  const detailEl = document.getElementById('emailSnoopDetail');
  const bodyPreviewEl = document.getElementById('emailSnoopBodyPreview');

  if (!body || !totalEl || !filteredEl || !pageInfo || !prevBtn || !nextBtn || !detailEl || !bodyPreviewEl) return;

  const filtered = getEmailSnoopFilteredRows();
  const totalPages = Math.max(1, Math.ceil(filtered.length / EMAIL_SNOOP_PAGE_SIZE));
  if (emailSnoopPage > totalPages) emailSnoopPage = totalPages;
  if (emailSnoopPage < 1) emailSnoopPage = 1;

  totalEl.textContent = `Total: ${emailsCache.length}`;
  filteredEl.textContent = `Filtered: ${filtered.length}`;
  pageInfo.textContent = `Page ${emailSnoopPage} of ${totalPages}`;
  prevBtn.disabled = emailSnoopPage <= 1;
  nextBtn.disabled = emailSnoopPage >= totalPages;

  const start = (emailSnoopPage - 1) * EMAIL_SNOOP_PAGE_SIZE;
  const pageRows = filtered.slice(start, start + EMAIL_SNOOP_PAGE_SIZE);

  if (!pageRows.length) {
    body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:1.2rem;color:rgba(255,255,255,.4);">No emails match current filters.</td></tr>';
    if (!filtered.find((email) => email.id === emailSnoopSelectedId)) {
      emailSnoopSelectedId = null;
      detailEl.textContent = 'Click a row to preview details.';
      bodyPreviewEl.textContent = 'Select an email to read its contents.';
    }
    return;
  }

  body.innerHTML = pageRows.map((email) => {
    const recipientsText = getEmailRecipientsText(email.recipients) || '—';
    const subject = String(email.subject || '(no subject)');
    const from = String(email.sender || '—');
    const selectedClass = email.id === emailSnoopSelectedId ? ' style="background:rgba(78,250,170,.08);"' : '';
    return `<tr data-snoop-email-id="${esc(email.id)}"${selectedClass}>
      <td>${esc(formatEmailDateTime(email.ts ?? email.createdAt ?? email.sentAt))}</td>
      <td title="${esc(from)}">${esc(from)}</td>
      <td title="${esc(recipientsText)}">${esc(recipientsText)}</td>
      <td title="${esc(subject)}">${esc(subject)}</td>
      <td>${esc(email.status || '—')}</td>
      <td>${esc(email.folder || '—')}</td>
    </tr>`;
  }).join('');

  body.querySelectorAll('[data-snoop-email-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const rowId = row.getAttribute('data-snoop-email-id');
      const email = filtered.find((item) => item.id === rowId) || emailsCache.find((item) => item.id === rowId);
      if (!email) return;

      emailSnoopSelectedId = email.id;
      const recipientsText = getEmailRecipientsText(email.recipients) || '—';
      detailEl.textContent = `${formatEmailDateTime(email.ts ?? email.createdAt ?? email.sentAt)} • ${email.sender || '—'} -> ${recipientsText} • ${email.subject || '(no subject)'}`;
      bodyPreviewEl.textContent = getEmailPlainBody(email) || '—';
      renderEmailSnoop();
    });
  });

  const selectedEmail = filtered.find((email) => email.id === emailSnoopSelectedId)
    || emailsCache.find((email) => email.id === emailSnoopSelectedId);
  if (selectedEmail) {
    const recipientsText = getEmailRecipientsText(selectedEmail.recipients) || '—';
    detailEl.textContent = `${formatEmailDateTime(selectedEmail.ts ?? selectedEmail.createdAt ?? selectedEmail.sentAt)} • ${selectedEmail.sender || '—'} -> ${recipientsText} • ${selectedEmail.subject || '(no subject)'}`;
    bodyPreviewEl.textContent = getEmailPlainBody(selectedEmail) || '—';
  } else {
    emailSnoopSelectedId = null;
    detailEl.textContent = 'Click a row to preview details.';
    bodyPreviewEl.textContent = 'Select an email to read its contents.';
  }
}

function renderEmailTypeChart(analytics) {
  destroyChart('emailType');
  const canvas = document.getElementById('emailTypeChart');
  if (!canvas || !analytics.categories.length) return;

  const topCats = analytics.categories.slice(0, 6);
  charts.emailType = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: topCats.map(c => c.label),
      datasets: [{
        data: topCats.map(c => c.count),
        backgroundColor: ['#4efaaa', '#6495ed', '#ffd166', '#ff8c69', '#72d6c9', '#b8c0ff'],
        borderColor: 'rgba(10,10,11,0.9)',
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(255,255,255,.68)', font: { size: 11 } }
        }
      }
    }
  });
}

function renderEmailCategoryTable(analytics) {
  const table = document.getElementById('emailCategoryTable');
  if (!table) return;
  if (!analytics.categories.length) {
    table.innerHTML = '<p style="color:rgba(255,255,255,.45);font-size:.82rem;margin:0;">No classified emails in the selected period.</p>';
    return;
  }

  const total = analytics.totalEmails || 1;
  table.innerHTML = `<div class="rank-list">${analytics.categories.slice(0, 6).map((cat, idx) => {
    const pct = Math.round((cat.count / total) * 100);
    return `<div class="rank-row">
      <span class="rank-idx">${idx + 1}</span>
      <span class="rank-name"><i class="fa-solid ${cat.icon}" style="color:#4efaaa;margin-right:.45rem;"></i>${esc(cat.label)}</span>
      <span class="rank-val">${cat.count} (${pct}%)</span>
    </div>`;
  }).join('')}</div>`;
}

function renderEmailInsights(analytics) {
  const block = document.getElementById('emailInsightList');
  if (!block) return;

  if (!analytics.totalEmails) {
    block.innerHTML = '<p style="color:rgba(255,255,255,.45);font-size:.84rem;">No email activity in the last 90 days.</p>';
    return;
  }

  const topCategory = analytics.categories[0];
  const externalPct = analytics.totalEmails
    ? Math.round((analytics.externalRecipientTouches / Math.max(1, analytics.totalEmails)) * 100)
    : 0;

  const items = [
    {
      icon: 'fa-layer-group',
      text: topCategory
        ? `Top email type is <strong>${esc(topCategory.label)}</strong> with <strong>${topCategory.count}</strong> messages.`
        : 'No dominant category yet.'
    },
    {
      icon: 'fa-arrows-turn-to-dots',
      text: `<strong>${analytics.broadcastEmails}</strong> messages were broad sends (8+ recipients), indicating wider announcements or directives.`
    },
    {
      icon: 'fa-user-clock',
      text: `Most active day is <strong>${esc(analytics.peakDay)}</strong>, with peak send hour around <strong>${esc(analytics.peakHour)}</strong>.`
    },
    {
      icon: 'fa-earth-americas',
      text: `External inbox touches are approximately <strong>${externalPct}%</strong> of email volume.`
    }
  ];

  block.innerHTML = `<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.75rem;">
    ${items.map(item => `<li style="display:flex;align-items:flex-start;gap:.7rem;font-size:.86rem;color:rgba(255,255,255,.78);">
      <i class="fa-solid ${item.icon}" style="color:#4efaaa;margin-top:.1rem;"></i>
      <span>${item.text}</span>
    </li>`).join('')}
  </ul>`;
}

function renderEmailTrendChart(analytics) {
  destroyChart('emailTrend');
  const canvas = document.getElementById('emailTrendChart');
  if (!canvas || !analytics.weeklyLabels.length) return;

  charts.emailTrend = new Chart(canvas, {
    type: 'line',
    data: {
      labels: analytics.weeklyLabels,
      datasets: [{
        label: 'Emails per week',
        data: analytics.weeklyCounts,
        borderColor: '#ffd166',
        backgroundColor: 'rgba(255, 209, 102, 0.14)',
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointBackgroundColor: '#ffd166'
      }]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(255,255,255,.6)', font: { size: 11 } }
        }
      }
    }
  });
}

// ══ Overview ══════════════════════════════════════════════════════════════════

function renderOverview() {
  const now      = new Date();
  const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1);
  const eventsThisMonth = eventsCache.filter(e => {
    const d = e.startDate?.toDate?.() ?? null;
    return d && d >= monthAgo && d <= now;
  });
  const totalRsvpsMonth = eventsThisMonth.reduce((sum, e) => sum + (rsvpCache.get(e.id) ?? 0), 0);

  // KPI cards
  const kpiGrid = document.getElementById('kpiGrid');
  kpiGrid.innerHTML = `
    ${statCard('fa-id-card',          charCount.toLocaleString(),              'Total Characters',       'Live from Firestore')}
    ${statCard('fa-calendar-days',    eventsThisMonth.length,                  'Events This Month',      `${eventsCache.length} total`)}
    ${statCard('fa-hand-point-up',    totalRsvpsMonth.toLocaleString(),        'RSVPs This Month',       'Across all current-month events')}
    ${statCard('fa-chart-line',       snapshotsCache.length > 0 ? snapshotsCache[snapshotsCache.length-1].discordMembers?.toLocaleString() ?? '—' : '—',
                                                                               'Discord Members',        snapshotsCache.length ? `As of ${fmtDate(snapshotsCache.at(-1)?.date)}` : 'No snapshots yet')}
    ${statCard('fa-cube',             '—',                                     'MC Players Online',      'Loading…', 'mcKpiValue', 'mcKpiSub')}
    ${statCard('fa-arrow-trend-up',   growthSummary(),                         'Member Growth',          'Since last snapshot')}
  `;

  // Recent events table
  const pastEvents = eventsCache
    .filter(e => e.startDate?.toDate?.()?.getTime() < now.getTime())
    .slice(0, 8);

  const tbody = document.getElementById('recentEventsBody');
  if (!pastEvents.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:2rem;color:rgba(255,255,255,.4);">No past events.</td></tr>`;
  } else {
    tbody.innerHTML = pastEvents.map(e => {
      const rsvps   = rsvpCache.get(e.id) ?? '?';
      const report  = reportsCache.find(r => r.eventId === e.id);
      const repBadge = report
        ? `<span class="badge badge-green">Filed</span>`
        : `<span class="badge badge-gray">Pending</span>`;
      return `<tr>
        <td>${esc(e.title)}</td>
        <td>${fmtDate(e.startDate)}</td>
        <td>${esc(rsvps)}</td>
        <td>${repBadge}</td>
      </tr>`;
    }).join('');
  }

  // Insights
  renderInsights();

  // Mini charts
  renderMiniMemberChart();
  renderMiniEventsChart();
  fetchMcStatus(true);
}

function growthSummary() {
  if (snapshotsCache.length < 2) return '—';
  const last   = snapshotsCache.at(-1)?.discordMembers ?? 0;
  const prev   = snapshotsCache.at(-2)?.discordMembers ?? 0;
  const delta  = last - prev;
  return delta >= 0 ? `+${delta}` : `${delta}`;
}

function statCard(icon, value, label, sub, valueId = '', subId = '', valueClass = '') {
  return `<div class="stat-card">
    <div class="stat-icon"><i class="fa-solid ${icon}"></i></div>
    <div class="stat-value ${valueClass}" ${valueId ? `id="${valueId}"` : ''}>${esc(value)}</div>
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-sub"  ${subId   ? `id="${subId}"`   : ''}>${esc(sub)}</div>
  </div>`;
}

function renderInsights() {
  const panel = document.getElementById('insightsPanel');
  const items = [];

  // Average RSVPs per event (last 10 past events)
  const pastWithRsvp = eventsCache
    .filter(e => e.startDate?.toDate?.()?.getTime() < Date.now())
    .slice(0, 10)
    .filter(e => rsvpCache.has(e.id));

  if (pastWithRsvp.length) {
    const avg = Math.round(pastWithRsvp.reduce((s, e) => s + rsvpCache.get(e.id), 0) / pastWithRsvp.length);
    items.push({ icon: 'fa-star', text: `Average RSVPs per event: <strong>${avg}</strong>` });
  }

  // Show rate from reports
  if (reportsCache.length) {
    const showRates = reportsCache
      .filter(r => r.rsvpCount > 0)
      .map(r => (r.actualAttendance / r.rsvpCount) * 100);
    if (showRates.length) {
      const avg = Math.round(showRates.reduce((a, b) => a + b, 0) / showRates.length);
      items.push({ icon: 'fa-person-walking-arrow-right', text: `Average RSVP→show rate: <strong>${avg}%</strong>` });
    }
  }

  // Member growth last 30 days (from snapshots)
  if (snapshotsCache.length >= 2) {
    const last  = snapshotsCache.at(-1);
    const prev  = snapshotsCache.at(-2);
    const delta = (last.discordMembers ?? 0) - (prev.discordMembers ?? 0);
    const color = delta >= 0 ? 'diff-positive' : 'diff-negative';
    items.push({ icon: delta >= 0 ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down', text: `Member change since last snapshot: <span class="${color}"><strong>${delta >= 0 ? '+' : ''}${delta}</strong></span>` });
  }

  // Most active month (events)
  const monthGroups = {};
  eventsCache.forEach(e => {
    const d = e.startDate?.toDate?.();
    if (!d) return;
    const k = monthKey(d);
    monthGroups[k] = (monthGroups[k] ?? 0) + 1;
  });
  if (Object.keys(monthGroups).length) {
    const topMonth = Object.entries(monthGroups).sort((a, b) => b[1] - a[1])[0];
    items.push({ icon: 'fa-trophy', text: `Most active month: <strong>${monthLabel(topMonth[0])}</strong> (${topMonth[1]} events)` });
  }

  // Total events all time
  items.push({ icon: 'fa-calendar', text: `Total events on record: <strong>${eventsCache.length}</strong>` });

  if (!items.length) {
    panel.innerHTML = `<p style="color:rgba(255,255,255,.4);font-size:.875rem;">Not enough data yet. Start logging snapshots and submitting reports to see insights.</p>`;
    return;
  }

  panel.innerHTML = `<ul style="list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:.85rem;">
    ${items.map(i => `<li style="display:flex;align-items:flex-start;gap:.75rem;font-size:.88rem;color:rgba(255,255,255,.75);">
      <i class="fa-solid ${i.icon}" style="color:#4efaaa;margin-top:.15rem;flex-shrink:0;"></i>
      <span>${i.text}</span>
    </li>`).join('')}
  </ul>`;
}

function renderMiniMemberChart() {
  destroyChart('miniMember');
  const canvas = document.getElementById('miniMemberChart');
  if (!canvas || !snapshotsCache.length) return;

  const sliced = snapshotsCache.slice(-12);
  charts.miniMember = new Chart(canvas, {
    type: 'line',
    data: {
      labels: sliced.map(s => fmtDate(s.date)),
      datasets: [{
        data:  sliced.map(s => s.discordMembers ?? 0),
        borderColor: '#4efaaa',
        backgroundColor: 'rgba(78,250,170,0.08)',
        fill: true,
        tension: 0.4,
        pointRadius: 3,
        pointBackgroundColor: '#4efaaa'
      }]
    },
    options: { ...CHART_DEFAULTS }
  });
}

function renderMiniEventsChart() {
  destroyChart('miniEvents');
  const canvas = document.getElementById('miniEventsChart');
  if (!canvas) return;

  const keys    = last12MonthKeys();
  const counts  = buildEventsPerMonth(keys);

  charts.miniEvents = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: keys.map(monthLabel),
      datasets: [{
        data: counts,
        backgroundColor: 'rgba(78,250,170,0.5)',
        borderColor: '#4efaaa',
        borderWidth: 1,
        borderRadius: 4
      }]
    },
    options: { ...CHART_DEFAULTS }
  });
}

// ══ Community ══════════════════════════════════════════════════════════════════

function renderCommunity() {
  renderMemberCountChart();
  renderGrowthDeltaChart();
  renderSnapshotTable();
}

function renderMemberCountChart() {
  destroyChart('memberCount');
  const canvas = document.getElementById('memberCountChart');
  if (!canvas || !snapshotsCache.length) return;

  const noteMarkers = snapshotsCache
    .map((snap, index) => ({ index, note: (snap.notes ?? '').trim(), snap }))
    .filter(m => m.note);
  const noteByIndex = new Map(noteMarkers.map(m => [m.index, m]));

  charts.memberCount = new Chart(canvas, {
    type: 'line',
    data: {
      labels: snapshotsCache.map(s => fmtDate(s.date)),
      datasets: [
        {
          label: 'Discord Members',
          data:  snapshotsCache.map(s => s.discordMembers ?? null),
          borderColor: '#7289da',
          backgroundColor: 'rgba(114,137,218,0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: '#7289da',
          spanGaps: true
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(255,255,255,0.6)', font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            footer: (ctx) => {
              const idx = ctx?.[0]?.dataIndex;
              const marker = noteByIndex.get(idx);
              if (!marker) return '';
              return [
                `Members: ${fmtCount(marker.snap.discordMembers)}`,
                `Online: ${fmtCount(marker.snap.discordOnline)}`,
                `Note: ${marker.note}`
              ];
            }
          }
        },
        noteMarkers: {
          items: noteMarkers
        }
      }
    },
    plugins: [noteMarkersPlugin]
  });
}

function renderGrowthDeltaChart() {
  destroyChart('growthDelta');
  const canvas = document.getElementById('growthDeltaChart');
  if (!canvas || snapshotsCache.length < 2) return;

  const labels = [];
  const joinData = [];
  const leaveData = [];
  const noteMarkers = [];
  const noteByIndex = new Map();

  for (let i = 1; i < snapshotsCache.length; i++) {
    const prev   = snapshotsCache[i - 1].discordMembers ?? 0;
    const snap   = snapshotsCache[i];
    const curr   = snap.discordMembers ?? 0;
    const delta  = curr - prev;
    labels.push(fmtDate(snap.date));
    joinData.push(delta > 0 ? delta : 0);
    leaveData.push(delta < 0 ? Math.abs(delta) : 0);

    const note = (snap.notes ?? '').trim();
    if (note) {
      const index = labels.length - 1;
      const marker = { index, note, snap };
      noteMarkers.push(marker);
      noteByIndex.set(index, marker);
    }
  }

  charts.growthDelta = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Joins',  data: joinData,  backgroundColor: 'rgba(78,250,170,0.6)', borderColor: '#4efaaa', borderWidth: 1, borderRadius: 4 },
        { label: 'Leaves', data: leaveData, backgroundColor: 'rgba(255,107,107,0.6)', borderColor: '#ff6b6b', borderWidth: 1, borderRadius: 4 }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(255,255,255,0.6)', font: { size: 11 } }
        },
        tooltip: {
          callbacks: {
            footer: (ctx) => {
              const idx = ctx?.[0]?.dataIndex;
              const marker = noteByIndex.get(idx);
              if (!marker) return '';
              return [
                `Members: ${fmtCount(marker.snap.discordMembers)}`,
                `Online: ${fmtCount(marker.snap.discordOnline)}`,
                `Note: ${marker.note}`
              ];
            }
          }
        },
        noteMarkers: {
          items: noteMarkers
        }
      }
    },
    plugins: [noteMarkersPlugin]
  });
}

function renderSnapshotTable() {
  const tbody = document.getElementById('snapshotHistoryBody');
  if (!snapshotsCache.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:rgba(255,255,255,.4);"><i class="fa-solid fa-database" style="display:block;margin-bottom:.5rem;font-size:1.5rem;"></i>No snapshots yet. Use the form above to log your first one.</td></tr>`;
    return;
  }

  const rows = [...snapshotsCache].reverse().map((snap, idx, arr) => {
    const prevSnap = arr[idx + 1];
    let changeBadge = '';
    if (prevSnap && typeof snap.discordMembers === 'number' && typeof prevSnap.discordMembers === 'number') {
      const delta = snap.discordMembers - prevSnap.discordMembers;
      if (delta > 0)      changeBadge = `<span class="diff-positive">+${delta}</span>`;
      else if (delta < 0) changeBadge = `<span class="diff-negative">${delta}</span>`;
      else                changeBadge = `<span class="diff-neutral">±0</span>`;
    } else {
      changeBadge = '<span class="diff-neutral">—</span>';
    }

    return `<tr>
      <td>${fmtDate(snap.date)}</td>
      <td>${snap.discordMembers?.toLocaleString() ?? '—'}</td>
      <td>${snap.discordOnline?.toLocaleString() ?? '—'}</td>
      <td>${snap.characterCount?.toLocaleString() ?? '—'}</td>
      <td>${changeBadge}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(snap.notes ?? '')}">${esc(snap.notes ?? '—')}</td>
      <td>
        <button class="btn btn-danger btn-sm" data-delete-snap="${esc(snap.id)}">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    </tr>`;
  });

  tbody.innerHTML = rows.join('');

  // Bind delete buttons
  tbody.querySelectorAll('[data-delete-snap]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteSnap;
      if (!confirm('Delete this snapshot? This cannot be undone.')) return;
      try {
        await deleteDoc(doc(db, 'community_snapshots', id));
        showToast('Snapshot deleted.');
        snapshotsCache = snapshotsCache.filter(s => s.id !== id);
        renderCommunity();
        renderOverview();
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
      }
    });
  });
}

// ══ Events ════════════════════════════════════════════════════════════════════

function buildEventsPerMonth(keys) {
  const map = {};
  keys.forEach(k => { map[k] = 0; });
  eventsCache.forEach(e => {
    const d = e.startDate?.toDate?.();
    if (!d) return;
    const k = monthKey(d);
    if (k in map) map[k]++;
  });
  return keys.map(k => map[k]);
}

function renderEvents() {
  const now       = new Date();
  const sixMoAgo  = new Date(now.getFullYear(), now.getMonth() - 6, 1);

  // Events per month chart
  destroyChart('eventsPerMonth');
  const epmCanvas = document.getElementById('eventsPerMonthChart');
  if (epmCanvas) {
    const keys   = last12MonthKeys();
    const counts = buildEventsPerMonth(keys);
    charts.eventsPerMonth = new Chart(epmCanvas, {
      type: 'bar',
      data: {
        labels: keys.map(monthLabel),
        datasets: [{
          label: 'Events',
          data: counts,
          backgroundColor: 'rgba(78,250,170,0.5)',
          borderColor: '#4efaaa',
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: { ...CHART_DEFAULTS }
    });
  }

  // RSVP bar chart — last 10 past events with RSVP data
  const pastWithRsvp = eventsCache
    .filter(e => e.startDate?.toDate?.()?.getTime() < now.getTime() && rsvpCache.has(e.id))
    .slice(0, 10)
    .reverse();

  destroyChart('rsvpBar');
  const rsvpCanvas = document.getElementById('rsvpBarChart');
  if (rsvpCanvas && pastWithRsvp.length) {
    charts.rsvpBar = new Chart(rsvpCanvas, {
      type: 'bar',
      data: {
        labels: pastWithRsvp.map(e => {
          const t = e.title ?? 'Event';
          return t.length > 18 ? t.slice(0, 16) + '…' : t;
        }),
        datasets: [{
          label: 'RSVPs',
          data: pastWithRsvp.map(e => rsvpCache.get(e.id) ?? 0),
          backgroundColor: 'rgba(100,149,237,0.55)',
          borderColor: '#6495ed',
          borderWidth: 1,
          borderRadius: 4
        }]
      },
      options: { ...CHART_DEFAULTS }
    });
  }

  // Event KPIs
  const allPastEvents = eventsCache.filter(e => e.startDate?.toDate?.()?.getTime() < now.getTime());
  const rsvpValues    = allPastEvents.map(e => rsvpCache.get(e.id)).filter(n => n !== undefined);
  const avgRsvp       = rsvpValues.length ? Math.round(rsvpValues.reduce((a, b) => a + b, 0) / rsvpValues.length) : 0;
  const maxRsvp       = rsvpValues.length ? Math.max(...rsvpValues) : 0;
  const thisMonthEvts = eventsCache.filter(e => {
    const d = e.startDate?.toDate?.();
    return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  });

  const ekGrid = document.getElementById('eventKpiGrid');
  if (ekGrid) {
    ekGrid.innerHTML = `
      ${statCard('fa-star',          avgRsvp,                               'Avg RSVPs / Event',   `Based on ${rsvpValues.length} tracked events`)}
      ${statCard('fa-fire',          maxRsvp,                               'Peak RSVPs',           'Single event record')}
      ${statCard('fa-calendar-week', thisMonthEvts.length,                  'Events This Month',    now.toLocaleString('en-US',{month:'long',year:'numeric'}))}
      ${statCard('fa-database',      allPastEvents.length,                  'Total Past Events',    'All time')}
    `;
  }

  // Detail table — past 6 months
  const tableEvents = eventsCache
    .filter(e => {
      const d = e.startDate?.toDate?.();
      return d && d >= sixMoAgo && d <= now;
    })
    .sort((a, b) => b.startDate.toDate() - a.startDate.toDate());

  const tbody = document.getElementById('eventsDetailBody');
  if (!tableEvents.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:rgba(255,255,255,.4);">No events in the past 6 months.</td></tr>`;
    return;
  }

  tbody.innerHTML = tableEvents.map(e => {
    const rsvps   = rsvpCache.has(e.id) ? rsvpCache.get(e.id) : '?';
    const report  = reportsCache.find(r => r.eventId === e.id);
    const actual  = report ? report.actualAttendance : '—';
    let showPctNum = null;
    let showPct   = '—';
    if (report && typeof rsvps === 'number' && rsvps > 0) {
      showPctNum = Math.round((report.actualAttendance / rsvps) * 100);
      showPct = `${showPctNum}%`;
    }
    return `<tr>
      <td>${esc(e.title)}</td>
      <td>${fmtDate(e.startDate)}</td>
      <td>${esc(e.zone ?? '—')}</td>
      <td>${esc(e.manager ?? '—')}</td>
      <td>${esc(rsvps)}</td>
      <td>${esc(actual)}</td>
      <td>${showPct !== '—' ? `<span class="badge ${showPctNum >= 65 ? 'badge-green' : 'badge-red'}">${showPct}</span>` : '—'}</td>
    </tr>`;
  }).join('');
}

// ══ Server ════════════════════════════════════════════════════════════════════

async function fetchMcStatus(forOverview = false) {
  try {
    const res  = await fetch(MC_API);
    const data = await res.json();

    const online  = data.online === true;
    const players = data.players?.online ?? 0;
    const max     = data.players?.max ?? 0;
    const list    = data.players?.list ?? [];
    const motd    = data.motd?.clean?.[0] ?? '';

    // Overview KPI
    const mcKpi = document.getElementById('mcKpiValue');
    const mcSub = document.getElementById('mcKpiSub');
    if (mcKpi) mcKpi.textContent = online ? `${players}/${max}` : 'Offline';
    if (mcSub) mcSub.textContent = online ? `playing now` : 'Server offline';

    if (forOverview) return;

    const block = document.getElementById('mcStatusBlock');
    if (!block) return;

    block.innerHTML = `
      <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;margin-bottom:1rem;">
        <div style="font-size:2.5rem;color:${online ? '#4efaaa' : '#ff6b6b'};">
          <i class="fa-solid fa-cube"></i>
        </div>
        <div>
          <div class="mc-info-label">Status</div>
          <div class="mc-info-value" style="color:${online ? '#4efaaa' : '#ff6b6b'}">${online ? 'Online' : 'Offline'}</div>
          ${motd ? `<div style="font-size:.8rem;color:rgba(255,255,255,.4);margin-top:.2rem;">${esc(motd)}</div>` : ''}
        </div>
        <div>
          <div class="mc-info-label">Players Online</div>
          <div class="mc-info-value">${online ? `${players} / ${max}` : '—'}</div>
        </div>
        <div>
          <div class="mc-info-label">Server Address</div>
          <div style="font-family:'Roboto Mono',monospace;font-size:1rem;color:#4efaaa;">play.site89.org</div>
        </div>
      </div>
      ${online && list.length ? `
        <div class="mc-info-label" style="margin-bottom:.5rem;">Current Players</div>
        <div class="mc-player-list">
          ${list.map(p => `<span class="mc-player"><i class="fa-solid fa-person" style="font-size:.7rem;"></i> ${esc(p)}</span>`).join('')}
        </div>
      ` : ''}
    `;
  } catch (err) {
    console.warn('[Analytics] MC status fetch failed:', err.message);
    const block = document.getElementById('mcStatusBlock');
    if (block) block.innerHTML = `<p style="color:rgba(255,255,255,.4);">Could not reach Minecraft API.</p>`;
  }
}

async function fetchWebsiteStatus() {
  const block = document.getElementById('websiteStatusBlock');
  if (!block) return;
  const start = Date.now();
  try {
    await fetch('/?_ping=1', { method: 'HEAD', cache: 'no-store' });
    const ms = Date.now() - start;
    block.innerHTML = `
      <div style="display:flex;align-items:center;gap:1.5rem;flex-wrap:wrap;">
        <div style="font-size:2.5rem;color:#4efaaa;"><i class="fa-solid fa-globe"></i></div>
        <div>
          <div class="mc-info-label">Status</div>
          <div class="mc-info-value" style="color:#4efaaa;">Online</div>
        </div>
        <div>
          <div class="mc-info-label">Response Time</div>
          <div class="mc-info-value">${ms}ms</div>
        </div>
        <div>
          <div class="mc-info-label">URL</div>
          <div style="font-family:'Roboto Mono',monospace;font-size:.9rem;color:#4efaaa;">site89.org</div>
        </div>
      </div>`;
  } catch {
    block.innerHTML = `<p style="color:#ff6b6b;"><i class="fa-solid fa-triangle-exclamation"></i> Could not reach website endpoint.</p>`;
  }
}

function renderServer() {
  fetchMcStatus();
  fetchWebsiteStatus();

  // Server KPIs
  const sgGrid = document.getElementById('serverKpiGrid');
  if (sgGrid) {
    sgGrid.innerHTML = `
      ${statCard('fa-id-card',    charCount.toLocaleString(), 'Total Characters', 'From Firestore')}
      ${statCard('fa-cube',       '…',                        'MC Players Live',  'Loading…', 'serverMcKpi', '')}
    `;
  }

  // Character breakdown by clearance
  renderCharBreakdown();
}

async function renderCharBreakdown() {
  const block = document.getElementById('charStatBlock');
  if (!block) return;

  try {
    const snap = await getDocs(collection(db, 'characters'));
    const chars = snap.docs.map(d => d.data());
    const clearanceCounts = {};
    const rankCounts = {};

    chars.forEach(c => {
      const cl = String(c.clearance ?? 'Unknown');
      clearanceCounts[cl] = (clearanceCounts[cl] ?? 0) + 1;

      const rank = c.rank ? c.rank.split(' ')[0] : 'Unknown';
      rankCounts[rank] = (rankCounts[rank] ?? 0) + 1;
    });

    block.innerHTML = `
      <div>
        <h3 style="font-size:.95rem;font-weight:700;margin:0 0 .75rem;color:rgba(255,255,255,.7);">By Clearance Level</h3>
        ${Object.entries(clearanceCounts).sort((a, b) => Number(a[0]) - Number(b[0])).map(([cl, cnt]) => `
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.875rem;">
            <span style="color:rgba(255,255,255,.7);">Level ${esc(cl)}</span>
            <span style="font-weight:700;color:#4efaaa;">${cnt}</span>
          </div>
        `).join('')}
      </div>
      <div>
        <h3 style="font-size:.95rem;font-weight:700;margin:0 0 .75rem;color:rgba(255,255,255,.7);">By Rank Group</h3>
        ${Object.entries(rankCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([rank, cnt]) => `
          <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid rgba(255,255,255,.05);font-size:.875rem;">
            <span style="color:rgba(255,255,255,.7);">${esc(rank)}</span>
            <span style="font-weight:700;color:#4efaaa;">${cnt}</span>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    block.innerHTML = `<p style="color:rgba(255,255,255,.4);">Could not load character breakdown.</p>`;
  }

  // Also update server MC KPI after MC fetch if applicable
  const serverMc = document.getElementById('serverMcKpi');
  if (serverMc) {
    fetchMcStatus().then(() => {
      const v = document.getElementById('mcKpiValue');
      if (v) serverMc.textContent = v.textContent;
    });
  }
}

// ══ Staff Reports ══════════════════════════════════════════════════════════════

function renderReports() {
  populateEventSelect();
  renderAttendanceChart();
  renderReportsTable();
}

function populateEventSelect() {
  const sel = document.getElementById('reportEventSel');
  if (!sel) return;

  const now      = new Date();
  const pastEvts = eventsCache
    .filter(e => e.startDate?.toDate?.()?.getTime() < now.getTime())
    .sort((a, b) => b.startDate.toDate() - a.startDate.toDate())
    .slice(0, 50);

  sel.innerHTML = '<option value="">— Select a past event —</option>';
  pastEvts.forEach(e => {
    const opt = document.createElement('option');
    opt.value = e.id;
    opt.textContent = `${e.title} — ${fmtDate(e.startDate)}`;
    sel.appendChild(opt);
  });

  sel.addEventListener('change', () => {
    const event   = eventsCache.find(e => e.id === sel.value);
    const rsvpEl  = document.getElementById('reportRsvpCount');
    if (rsvpEl) rsvpEl.value = event ? (rsvpCache.get(event.id) ?? '') : '';
  });
}

function renderAttendanceChart() {
  destroyChart('attendanceComparison');
  const canvas = document.getElementById('attendanceComparisonChart');
  if (!canvas || !reportsCache.length) {
    if (canvas) {
      canvas.parentElement.innerHTML = `<div style="text-align:center;padding:3rem;color:rgba(255,255,255,.35);"><i class="fa-solid fa-chart-bar" style="display:block;font-size:2rem;margin-bottom:.5rem;"></i>No attendance reports submitted yet.</div>`;
    }
    return;
  }

  const sliced = [...reportsCache].reverse().slice(-12);
  const labels = sliced.map(r => {
    const t = r.eventTitle ?? 'Event';
    return t.length > 14 ? t.slice(0, 12) + '…' : t;
  });

  charts.attendanceComparison = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'RSVPs',
          data: sliced.map(r => r.rsvpCount ?? 0),
          backgroundColor: 'rgba(100,149,237,0.55)',
          borderColor: '#6495ed',
          borderWidth: 1,
          borderRadius: 4
        },
        {
          label: 'Actual',
          data: sliced.map(r => r.actualAttendance ?? 0),
          backgroundColor: 'rgba(78,250,170,0.55)',
          borderColor: '#4efaaa',
          borderWidth: 1,
          borderRadius: 4
        }
      ]
    },
    options: {
      ...CHART_DEFAULTS,
      plugins: {
        legend: {
          display: true,
          labels: { color: 'rgba(255,255,255,.6)', font: { size: 11 } }
        }
      }
    }
  });
}

function renderReportsTable() {
  const tbody = document.getElementById('reportsTableBody');
  if (!tbody) return;

  if (!reportsCache.length) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:rgba(255,255,255,.4);">No reports yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = reportsCache.map(r => {
    const rsvps   = r.rsvpCount ?? 0;
    const actual  = r.actualAttendance ?? 0;
    const rate    = rsvps > 0 ? `${Math.round((actual / rsvps) * 100)}%` : '—';
    const diff    = actual - rsvps;
    const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
    const diffCls = diff > 0 ? 'diff-positive' : diff < 0 ? 'diff-negative' : 'diff-neutral';

    return `<tr>
      <td>${esc(r.eventTitle ?? '—')}</td>
      <td>${fmtDate(r.eventDate)}</td>
      <td>${rsvps}</td>
      <td>${actual} <span class="${diffCls}">(${diffStr})</span></td>
      <td>${rate !== '—' ? `<span class="badge ${Math.round((actual/rsvps)*100) >= 65 ? 'badge-green' : 'badge-red'}">${rate}</span>` : '—'}</td>
      <td style="font-size:.8rem;">${esc(r.reportedBy ?? '—')}</td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(r.notes ?? '')}">${esc(r.notes || '—')}</td>
      <td>
        <button class="btn btn-danger btn-sm" data-delete-report="${esc(r.id)}">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-delete-report]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.deleteReport;
      if (!confirm('Delete this report? This cannot be undone.')) return;
      try {
        await deleteDoc(doc(db, 'event_attendance_reports', id));
        showToast('Report deleted.');
        reportsCache = reportsCache.filter(r => r.id !== id);
        renderReports();
        renderEvents();
      } catch (err) {
        showToast(`Delete failed: ${err.message}`, 'error');
      }
    });
  });
}

// ─── Form setup ───────────────────────────────────────────────────────────────

function setupForms() {
  setupSnapshotForm();
  setupDiscordConfigForm();
  setupReportForm();
  setupEmailSnoop();

  const mcRefreshBtn = document.getElementById('mcRefreshBtn');
  if (mcRefreshBtn) mcRefreshBtn.addEventListener('click', fetchMcStatus);
}

function setupEmailSnoop() {
  const searchInput = document.getElementById('emailSnoopSearchInput');
  const folderFilter = document.getElementById('emailSnoopFolderFilter');
  const statusFilter = document.getElementById('emailSnoopStatusFilter');
  const fromDate = document.getElementById('emailSnoopFromDate');
  const toDate = document.getElementById('emailSnoopToDate');
  const prevBtn = document.getElementById('emailSnoopPrevBtn');
  const nextBtn = document.getElementById('emailSnoopNextBtn');
  const purgeBtn = document.getElementById('purgeMailboxBtnAnalytics');
  const purgeInput = document.getElementById('purgeMailboxInputAnalytics');
  const purgeStatus = document.getElementById('purgeMailboxStatusAnalytics');

  const resetToFirstPageAndRender = () => {
    emailSnoopPage = 1;
    renderEmailSnoop();
  };

  [searchInput, folderFilter, statusFilter, fromDate, toDate].forEach((el) => {
    if (!el) return;
    const eventName = el.tagName === 'SELECT' || el.type === 'date' ? 'change' : 'input';
    el.addEventListener(eventName, resetToFirstPageAndRender);
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (emailSnoopPage <= 1) return;
      emailSnoopPage -= 1;
      renderEmailSnoop();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const filteredCount = getEmailSnoopFilteredRows().length;
      const totalPages = Math.max(1, Math.ceil(filteredCount / EMAIL_SNOOP_PAGE_SIZE));
      if (emailSnoopPage >= totalPages) return;
      emailSnoopPage += 1;
      renderEmailSnoop();
    });
  }

  if (purgeBtn && purgeInput && purgeStatus) {
    purgeBtn.addEventListener('click', async () => {
      const mailbox = normalizeEmailAddress(purgeInput.value);
      if (!mailbox || !mailbox.includes('@')) {
        purgeStatus.textContent = 'Enter a valid mailbox email first.';
        purgeStatus.style.color = '#ff6b6b';
        return;
      }

      const confirmed = confirm(`Delete all emails where ${mailbox} is recipient or sender? This cannot be undone.`);
      if (!confirmed) return;

      purgeBtn.disabled = true;
      purgeStatus.textContent = 'Purging mailbox emails...';
      purgeStatus.style.color = 'rgba(255,255,255,.65)';

      try {
        const result = await purgeMailboxEmailsCallable({ mailbox, includeSent: true });
        const deleted = Number(result?.data?.deletedCount || 0);
        purgeStatus.textContent = `Deleted ${deleted.toLocaleString()} email(s) for ${mailbox}.`;
        purgeStatus.style.color = '#4efaaa';
        showToast(`Mailbox purge complete: ${deleted.toLocaleString()} email(s) deleted.`);

        await loadAllData();
        renderDashboard();
      } catch (error) {
        const message = String(error?.message || 'Mailbox purge failed.');
        purgeStatus.textContent = message;
        purgeStatus.style.color = '#ff6b6b';
        showToast(message, 'error');
      } finally {
        purgeBtn.disabled = false;
      }
    });
  }
}

function setupSnapshotForm() {
  const form = document.getElementById('snapshotForm');
  if (!form) return;

  // Default date to today
  const snapDate = document.getElementById('snapDate');
  if (snapDate) snapDate.value = new Date().toISOString().slice(0, 10);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn    = document.getElementById('snapSubmitBtn');
    const status = document.getElementById('snapStatus');
    btn.disabled = true;
    status.textContent = 'Saving…';

    const dateVal     = document.getElementById('snapDate').value;
    const discordMem  = parseInt(document.getElementById('snapDiscordMembers').value, 10);
    const discordOn   = document.getElementById('snapDiscordOnline').value ? parseInt(document.getElementById('snapDiscordOnline').value, 10) : null;
    const charCountIn = document.getElementById('snapCharCount').value ? parseInt(document.getElementById('snapCharCount').value, 10) : charCount;
    const notes       = document.getElementById('snapNotes').value.trim();

    if (!dateVal || isNaN(discordMem)) {
      status.textContent = 'Missing required fields.';
      btn.disabled = false;
      return;
    }

    try {
      const [y, m, d] = dateVal.split('-').map(Number);
      const snapRef = await addDoc(collection(db, 'community_snapshots'), {
        date:           Timestamp.fromDate(new Date(y, m - 1, d)),
        discordMembers: discordMem,
        ...(discordOn !== null && { discordOnline: discordOn }),
        characterCount: charCountIn,
        notes:          notes || null,
        loggedBy:       currentUser.email,
        loggedAt:       serverTimestamp()
      });

      showToast('Snapshot saved!');
      status.textContent = '';
      form.reset();
      snapDate.value = new Date().toISOString().slice(0, 10);

      // Update local cache
      snapshotsCache.push({
        id: snapRef.id,
        date: Timestamp.fromDate(new Date(y, m - 1, d)),
        discordMembers: discordMem,
        ...(discordOn !== null && { discordOnline: discordOn }),
        characterCount: charCountIn,
        notes: notes || null,
        loggedBy: currentUser.email
      });
      snapshotsCache.sort((a, b) => {
        const da = a.date?.toDate?.() ?? new Date(0);
        const db2 = b.date?.toDate?.() ?? new Date(0);
        return da - db2;
      });

      renderCommunity();
      renderOverview();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      showToast(`Save failed: ${err.message}`, 'error');
    }

    btn.disabled = false;
  });
}

function setupDiscordConfigForm() {
  const btn = document.getElementById('saveDiscordConfigBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const input  = document.getElementById('discordInviteInput');
    const status = document.getElementById('discordConfigStatus');
    const code   = (input?.value ?? '').trim();

    if (!code) {
      status.textContent = 'Enter an invite code first.';
      return;
    }

    btn.disabled = true;
    status.textContent = 'Verifying…';

    try {
      const res  = await fetch(`${DISCORD_INVITE_API}${encodeURIComponent(code)}?with_counts=true`);
      if (!res.ok) throw new Error(`Discord returned HTTP ${res.status}. Check the invite code.`);
      const data = await res.json();
      const name = data.guild?.name ?? 'Unknown';

      await setDoc(doc(db, 'settings/community_config'), { discordInviteCode: code }, { merge: true });

      status.textContent = `✓ Verified: "${name}" — ${data.approximate_member_count?.toLocaleString()} members`;
      status.style.color = '#4efaaa';

      fetchDiscordLive(code);
      showToast(`Discord configured: ${name}`);
    } catch (err) {
      status.textContent = err.message;
      status.style.color = '#ff6b6b';
      showToast(err.message, 'error');
    }

    btn.disabled = false;
  });
}

function setupReportForm() {
  const form = document.getElementById('reportForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn    = document.getElementById('reportSubmitBtn');
    const status = document.getElementById('reportStatus');
    btn.disabled = true;
    status.textContent = 'Submitting…';

    const eventId    = document.getElementById('reportEventSel').value;
    const actual     = parseInt(document.getElementById('reportActualCount').value, 10);
    const notes      = document.getElementById('reportNotes').value.trim();

    if (!eventId || isNaN(actual)) {
      status.textContent = 'Select an event and enter an attendee count.';
      btn.disabled = false;
      return;
    }

    const event = eventsCache.find(e => e.id === eventId);
    if (!event) {
      status.textContent = 'Event not found.';
      btn.disabled = false;
      return;
    }

    const rsvps = rsvpCache.get(eventId) ?? 0;

    // Prevent duplicate reports (one per event)
    const existing = reportsCache.find(r => r.eventId === eventId);
    if (existing) {
      if (!confirm(`A report for "${event.title}" already exists. Overwrite it?`)) {
        status.textContent = '';
        btn.disabled = false;
        return;
      }
      try { await deleteDoc(doc(db, 'event_attendance_reports', existing.id)); } catch (_) {}
      reportsCache = reportsCache.filter(r => r.id !== existing.id);
    }

    try {
      const docRef = await addDoc(collection(db, 'event_attendance_reports'), {
        eventId:          eventId,
        eventTitle:       event.title ?? '—',
        eventDate:        event.startDate,
        rsvpCount:        rsvps,
        actualAttendance: actual,
        notes:            notes || null,
        reportedBy:       currentUser.email,
        reportedAt:       serverTimestamp()
      });

      showToast('Attendance report submitted!');
      status.textContent = '';
      form.reset();

      reportsCache.unshift({
        id:               docRef.id,
        eventId,
        eventTitle:       event.title ?? '—',
        eventDate:        event.startDate,
        rsvpCount:        rsvps,
        actualAttendance: actual,
        notes:            notes || null,
        reportedBy:       currentUser.email
      });

      renderReports();
      renderEvents();
      renderOverview();
    } catch (err) {
      status.textContent = `Error: ${err.message}`;
      showToast(`Submit failed: ${err.message}`, 'error');
    }

    btn.disabled = false;
  });
}

// ─── Auto-refresh ─────────────────────────────────────────────────────────────
function setupRefresh() {
  // Refresh MC status every 60 seconds silently
  setInterval(() => fetchMcStatus(), 60_000);
  // Refresh Discord live every 5 minutes
  setInterval(async () => {
    const input = document.getElementById('discordInviteInput');
    const code  = (input?.value ?? '').trim();
    if (code) fetchDiscordLive(code);
  }, 300_000);
}
