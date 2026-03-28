import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import {
  getFirestore,
  collection,
  getDocs,
  getDoc,
  doc,
  setDoc,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const PRIMARY_ADMIN_EMAIL = 'jedi21132@gmail.com';
const ROLE_VALUES = ['member', 'manager', 'admin'];
const ROLE_LABELS = {
  member: 'Member',
  manager: 'Manager',
  admin: 'Admin'
};

const db = getFirestore(app);
let currentUser = null;
let usersCache = [];

function esc(str) {
  const d = document.createElement('div');
  d.textContent = String(str ?? '');
  return d.innerHTML;
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (role === 'admin') return 'admin';
  if (role === 'manager') return 'manager';
  if (role === 'member') return 'member';
  if (role === 'user') return 'member';
  if (role === 'raisa') return 'manager';
  return 'member';
}

function fmtTs(ts) {
  if (!ts) return '—';
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function setFeedback(message, isError = false) {
  const el = document.getElementById('rolesFeedback');
  if (!el) return;
  el.style.color = isError ? 'var(--accent-red)' : 'var(--accent-mint)';
  el.textContent = message;
}

function applyFilters() {
  const search = (document.getElementById('rolesSearch')?.value || '').trim().toLowerCase();
  const filterRole = (document.getElementById('rolesFilter')?.value || '').trim();

  const filtered = usersCache.filter((u) => {
    const role = normalizeRole(u.role);
    const haystack = `${u.email || ''} ${u.uid || ''}`.toLowerCase();
    const matchSearch = !search || haystack.includes(search);
    const matchRole = !filterRole || role === filterRole;
    return matchSearch && matchRole;
  });

  renderTable(filtered);
}

function renderTable(rows) {
  const tbody = document.getElementById('rolesTableBody');
  if (!tbody) return;

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="padding:1rem;opacity:.8;">No users found.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map((u) => {
    const role = normalizeRole(u.role);
    const isProtected = (u.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL;

    return `
      <tr style="border-bottom:1px solid rgba(255,255,255,0.06);">
        <td style="padding:.65rem;">${esc(u.email || 'Unknown')}</td>
        <td style="padding:.65rem;"><span style="font-family:monospace;opacity:.9;">${esc(u.uid)}</span></td>
        <td style="padding:.65rem;"><span class="badge ${role === 'admin' ? 'badge-green' : role === 'manager' ? '' : 'badge-red'}">${ROLE_LABELS[role]}</span></td>
        <td style="padding:.65rem;">
          <select data-role-select="${esc(u.uid)}" ${isProtected ? 'disabled' : ''}>
            ${ROLE_VALUES.map((r) => `<option value="${r}" ${r === role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('')}
          </select>
        </td>
        <td style="padding:.65rem;opacity:.8;">${fmtTs(u.updatedAt)}</td>
        <td style="padding:.65rem;">
          <button class="btn-primary" type="button" data-role-save="${esc(u.uid)}" ${isProtected ? 'disabled' : ''}>Save</button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-role-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-role-save');
      const select = tbody.querySelector(`[data-role-select="${uid}"]`);
      if (!select) return;
      const newRole = normalizeRole(select.value);
      await saveRole(uid, newRole, btn);
    });
  });
}

async function loadUsers() {
  const snap = await getDocs(collection(db, 'users'));
  usersCache = snap.docs.map((d) => ({ uid: d.id, ...d.data() }));
  usersCache.sort((a, b) => {
    const ea = (a.email || a.uid || '').toLowerCase();
    const eb = (b.email || b.uid || '').toLowerCase();
    return ea.localeCompare(eb);
  });

  applyFilters();
}

async function saveRole(uid, role, btn) {
  const row = usersCache.find((u) => u.uid === uid);
  if (!row) return;

  if ((row.email || '').toLowerCase() === PRIMARY_ADMIN_EMAIL && role !== 'admin') {
    setFeedback('Primary admin role is protected.', true);
    return;
  }

  btn.disabled = true;
  setFeedback('Saving role…');

  try {
    await setDoc(doc(db, 'users', uid), {
      role,
      isAdmin: role === 'admin',
      updatedAt: serverTimestamp(),
      updatedBy: currentUser.email || currentUser.uid
    }, { merge: true });

    row.role = role;
    row.isAdmin = role === 'admin';
    row.updatedBy = currentUser.email || currentUser.uid;
    row.updatedAt = new Date();

    applyFilters();
    setFeedback(`Saved ${row.email || uid} as ${ROLE_LABELS[role]}.`);
  } catch (err) {
    setFeedback(`Save failed: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

function setupUiHandlers() {
  const search = document.getElementById('rolesSearch');
  const filter = document.getElementById('rolesFilter');
  const refresh = document.getElementById('rolesRefresh');

  if (search) search.addEventListener('input', applyFilters);
  if (filter) filter.addEventListener('change', applyFilters);
  if (refresh) {
    refresh.addEventListener('click', async () => {
      setFeedback('Refreshing…');
      try {
        await loadUsers();
        setFeedback('Refreshed.');
      } catch (err) {
        setFeedback(`Refresh failed: ${err.message}`, true);
      }
    });
  }
}

onAuthStateChanged(auth, async (user) => {
  const loadingEl = document.getElementById('rolesLoading');
  const deniedEl = document.getElementById('rolesDenied');
  const appEl = document.getElementById('rolesApp');

  if (!user) {
    window.location.replace('/login/');
    return;
  }

  currentUser = user;
  if (user.email !== PRIMARY_ADMIN_EMAIL) {
    if (loadingEl) loadingEl.style.display = 'none';
    if (deniedEl) deniedEl.style.display = 'block';
    return;
  }

  if (loadingEl) loadingEl.style.display = 'none';
  if (appEl) appEl.style.display = 'block';

  setupUiHandlers();
  try {
    await loadUsers();
    setFeedback('Loaded users.');
  } catch (err) {
    setFeedback(`Failed to load users: ${err.message}`, true);
  }
});
