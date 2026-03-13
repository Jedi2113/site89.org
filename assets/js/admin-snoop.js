import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const ADMIN_EMAIL = 'jedi21132@gmail.com';
const PAGE_SIZE = 50;
const FETCH_LIMIT = 2500;

function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function tsToDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (typeof ts === 'number') return new Date(ts);
  if (typeof ts === 'string') return new Date(ts);
  return null;
}

function formatDate(ts) {
  const date = tsToDate(ts);
  return date ? date.toLocaleString() : '—';
}

function startOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

function endOfDay(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T23:59:59.999');
  return Number.isNaN(d.getTime()) ? null : d;
}

document.addEventListener('includesLoaded', () => {
  const auth = getAuth();
  const db = getFirestore();

  const searchInput = document.getElementById('searchInput');
  const folderFilter = document.getElementById('folderFilter');
  const statusFilter = document.getElementById('statusFilter');
  const fromDate = document.getElementById('fromDate');
  const toDate = document.getElementById('toDate');
  const clearFiltersBtn = document.getElementById('clearFiltersBtn');
  const emailsTableBody = document.getElementById('emailsTableBody');
  const totalCount = document.getElementById('totalCount');
  const filteredCount = document.getElementById('filteredCount');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  const pageInfo = document.getElementById('pageInfo');
  const emailDetail = document.getElementById('emailDetail');
  const emailModalOverlay = document.getElementById('emailModalOverlay');
  const emailModalClose = document.getElementById('emailModalClose');
  const emailModalMeta = document.getElementById('emailModalMeta');
  const emailModalBody = document.getElementById('emailModalBody');

  let allEmails = [];
  let filteredEmails = [];
  let currentPage = 1;
  let selectedEmailId = null;

  function getRecipientsText(recipients) {
    return Array.isArray(recipients) ? recipients.join(', ') : '';
  }

  function getSearchHaystack(email) {
    return [
      email.sender || '',
      email.senderEmail || '',
      getRecipientsText(email.recipients),
      email.subject || '',
      email.body || '',
      email.status || '',
      email.folder || ''
    ].join(' ').toLowerCase();
  }

  function applyFilters() {
    const search = (searchInput.value || '').trim().toLowerCase();
    const folder = (folderFilter.value || '').trim().toLowerCase();
    const status = (statusFilter.value || '').trim().toLowerCase();
    const from = startOfDay(fromDate.value);
    const to = endOfDay(toDate.value);

    filteredEmails = allEmails.filter((email) => {
      const emailFolder = (email.folder || '').toLowerCase();
      const emailStatus = (email.status || '').toLowerCase();
      const emailDate = tsToDate(email.ts);

      if (folder && emailFolder !== folder) return false;
      if (status && emailStatus !== status) return false;

      if (from || to) {
        if (!emailDate) return false;
        if (from && emailDate < from) return false;
        if (to && emailDate > to) return false;
      }

      if (search) {
        const haystack = getSearchHaystack(email);
        if (!haystack.includes(search)) return false;
      }

      return true;
    });

    currentPage = 1;
    renderTable();
  }

  function updatePager() {
    const totalPages = Math.max(1, Math.ceil(filteredEmails.length / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
  }

  function getPlainBody(email) {
    const raw = String(email.body || '');
    if (!email.isHTML) return raw;
    const temp = document.createElement('div');
    temp.innerHTML = raw;
    return (temp.textContent || temp.innerText || '').trim();
  }

  function openEmailModal(email) {
    const recipientsText = getRecipientsText(email.recipients) || '—';
    const deletedByText = Array.isArray(email.deletedBy) && email.deletedBy.length
      ? email.deletedBy.join(', ')
      : '—';

    emailModalMeta.innerHTML = `
      <div class="snoop-meta-label">ID</div><div>${escapeHtml(email.id)}</div>
      <div class="snoop-meta-label">Time</div><div>${escapeHtml(formatDate(email.ts))}</div>
      <div class="snoop-meta-label">From</div><div>${escapeHtml(email.sender || '—')}</div>
      <div class="snoop-meta-label">Sender Login</div><div>${escapeHtml(email.senderEmail || '—')}</div>
      <div class="snoop-meta-label">To</div><div>${escapeHtml(recipientsText)}</div>
      <div class="snoop-meta-label">Subject</div><div>${escapeHtml(email.subject || '(no subject)')}</div>
      <div class="snoop-meta-label">Status</div><div>${escapeHtml(email.status || '—')}</div>
      <div class="snoop-meta-label">Folder</div><div>${escapeHtml(email.folder || '—')}</div>
      <div class="snoop-meta-label">Deleted By</div><div>${escapeHtml(deletedByText)}</div>
    `;

    emailModalBody.textContent = getPlainBody(email) || '—';

    emailModalOverlay.classList.add('show');
    emailModalOverlay.setAttribute('aria-hidden', 'false');
  }

  function closeEmailModal() {
    emailModalOverlay.classList.remove('show');
    emailModalOverlay.setAttribute('aria-hidden', 'true');
  }

  function renderTable() {
    totalCount.textContent = `Total: ${allEmails.length}`;
    filteredCount.textContent = `Filtered: ${filteredEmails.length}`;

    const start = (currentPage - 1) * PAGE_SIZE;
    const pageRows = filteredEmails.slice(start, start + PAGE_SIZE);

    emailsTableBody.innerHTML = '';

    if (!pageRows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="7" class="muted">No emails matched current filters.</td>';
      emailsTableBody.appendChild(tr);
      updatePager();
      return;
    }

    pageRows.forEach((email) => {
      const tr = document.createElement('tr');
      const recipientsText = getRecipientsText(email.recipients);
      const snippet = getPlainBody(email).replace(/\s+/g, ' ').trim().slice(0, 140);
      const isSelected = selectedEmailId === email.id;
      if (isSelected) tr.classList.add('selected');
      const statusClass = (email.status || '').toLowerCase() === 'draft' ? 'draft' : 'sent';

      tr.innerHTML = `
        <td>${escapeHtml(formatDate(email.ts))}</td>
        <td>${escapeHtml(email.sender || '—')}</td>
        <td>${escapeHtml(recipientsText || '—')}</td>
        <td><div class="snoop-subject">${escapeHtml(email.subject || '(no subject)')}</div></td>
        <td><div class="snoop-snippet">${escapeHtml(snippet || '—')}</div></td>
        <td><span class="snoop-pill ${statusClass}">${escapeHtml(email.status || '—')}</span></td>
        <td>${escapeHtml(email.folder || '—')}</td>
      `;

      tr.addEventListener('click', () => {
        selectedEmailId = email.id;
        emailDetail.textContent = `${formatDate(email.ts)} • ${email.sender || '—'} → ${recipientsText || '—'} • ${email.subject || '(no subject)'}`;
        emailDetail.classList.remove('muted');
        renderTable();
        openEmailModal(email);
      });

      emailsTableBody.appendChild(tr);
    });

    updatePager();
  }

  async function loadEmails() {
    emailsTableBody.innerHTML = '<tr><td colspan="7" class="muted">Loading emails…</td></tr>';

    try {
      const q = query(collection(db, 'emails'), orderBy('ts', 'desc'), limit(FETCH_LIMIT));
      const snap = await getDocs(q);
      allEmails = [];

      snap.forEach((docSnap) => {
        allEmails.push({ id: docSnap.id, ...docSnap.data() });
      });

      filteredEmails = [...allEmails];
      renderTable();
    } catch (error) {
      console.error('Failed to load snoop emails:', error);
      emailsTableBody.innerHTML = '<tr><td colspan="7" class="muted">Failed to load emails.</td></tr>';
    }
  }

  emailModalClose.addEventListener('click', closeEmailModal);
  emailModalOverlay.addEventListener('click', (event) => {
    if (event.target === emailModalOverlay) {
      closeEmailModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && emailModalOverlay.classList.contains('show')) {
      closeEmailModal();
    }
  });

  searchInput.addEventListener('input', applyFilters);
  folderFilter.addEventListener('change', applyFilters);
  statusFilter.addEventListener('change', applyFilters);
  fromDate.addEventListener('change', applyFilters);
  toDate.addEventListener('change', applyFilters);

  clearFiltersBtn.addEventListener('click', () => {
    searchInput.value = '';
    folderFilter.value = '';
    statusFilter.value = '';
    fromDate.value = '';
    toDate.value = '';
    applyFilters();
  });

  prevPageBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage -= 1;
      renderTable();
    }
  });

  nextPageBtn.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil(filteredEmails.length / PAGE_SIZE));
    if (currentPage < totalPages) {
      currentPage += 1;
      renderTable();
    }
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user || user.email !== ADMIN_EMAIL) {
      window.location.replace('/403/');
      return;
    }

    await loadEmails();
  });
});
