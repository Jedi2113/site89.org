import { app } from "./auth.js";
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, query, orderBy, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

const db = getFirestore(app);
const auth = getAuth(app);

// Helper functions
function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ 
  if(!dept) return false; 
  const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); // Remove spaces/special chars
  return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); 
}
function canEdit(){ const c = userClearance(); if(!isNaN(c) && c >= 5) return true; return isDeptAllowed(userDepartment()); }
function displayName(){ const ch = getSelectedCharacter(); return ch ? (ch.name || auth.currentUser?.email || 'Unknown') : (auth.currentUser?.email || 'Unknown'); }
function formatDate(ts){ if(!ts) return ''; try { return new Date(ts.seconds * 1000).toLocaleDateString(); } catch(e){ return ''; } }

// State
let logs = [];
let currentLogId = null;
let versions = []; // Array of {clearance: number, content: string}

// DOM elements
const searchInput = document.getElementById('rlSearch');
const newBtn = document.getElementById('rlNewBtn');
const modal = document.getElementById('rlModal');
const modalTitle = document.getElementById('rlModalTitle');
const closeBtn = document.getElementById('rlCloseBtn');
const cancelBtn = document.getElementById('rlCancelBtn');
const loadBtn = document.getElementById('rlLoadBtn');
const addVersionBtn = document.getElementById('rlAddVersion');
const versionsContainer = document.getElementById('rlVersionsContainer');
const form = document.getElementById('rlForm');
const titleInput = document.getElementById('rlTitle');
const clearanceInput = document.getElementById('rlClearance');
const tagsInput = document.getElementById('rlTags');
const linkedItemsInput = document.getElementById('rlLinkedItems');
const linkedPreview = document.getElementById('rlLinkedPreview');
const statusDiv = document.getElementById('rlStatus');
const tableBody = document.getElementById('rlTableBody');

const viewModal = document.getElementById('rlViewModal');
const viewTitle = document.getElementById('rlViewTitle');
const viewMeta = document.getElementById('rlViewMeta');
const viewLinked = document.getElementById('rlViewLinked');
const viewContent = document.getElementById('rlViewContent');
const viewCloseBtn = document.getElementById('rlViewCloseBtn');
const editBtn = document.getElementById('rlEditBtn');

function setStatus(msg, isError = false){
  statusDiv.textContent = msg;
  statusDiv.style.color = isError ? 'var(--accent-red)' : 'var(--accent-mint)';
}

function resetForm(){
  form.reset();
  currentLogId = null;
  modalTitle.textContent = 'New Research Log';
  linkedPreview.innerHTML = '';
  versions = [];
  renderVersions();
  setStatus('');
}

// Version management
function addVersion(){
  versions.push({ clearance: 1, content: '' });
  renderVersions();
}

function removeVersion(index){
  versions.splice(index, 1);
  renderVersions();
}

// Expose removeVersion globally for inline handlers
window.rlRemoveVersion = removeVersion;

function renderVersions(){
  if(!versionsContainer) return;
  
  versionsContainer.innerHTML = versions.map((v, i) => `
    <div class="rl-version-block">
      <div class="rl-version-header">
        <div class="rl-version-label">Version ${i + 1} - Clearance Level</div>
        <button type="button" class="rl-version-remove" onclick="window.rlRemoveVersion(${i})">✕ Remove</button>
      </div>
      <select class="rl-version-clearance" data-index="${i}" style="width:100%;padding:.6rem;margin-bottom:.5rem;background:var(--bg-card);border:1px solid rgba(255,255,255,0.08);border-radius:6px;color:var(--text-primary)">
        <option value="0" ${v.clearance === 0 ? 'selected' : ''}>Level 0 (Public)</option>
        <option value="1" ${v.clearance === 1 ? 'selected' : ''}>Level 1</option>
        <option value="2" ${v.clearance === 2 ? 'selected' : ''}>Level 2</option>
        <option value="3" ${v.clearance === 3 ? 'selected' : ''}>Level 3</option>
        <option value="4" ${v.clearance === 4 ? 'selected' : ''}>Level 4</option>
        <option value="5" ${v.clearance === 5 ? 'selected' : ''}>Level 5 (Restricted)</option>
      </select>
      <div class="rl-version-grid">
        <div class="rl-version-editor">
          <div style="font-weight:600;margin-bottom:.5rem">Markdown Editor</div>
          <textarea class="rl-version-content" data-index="${i}" placeholder="Content for this clearance level...">${v.content}</textarea>
        </div>
        <div>
          <div style="font-weight:600;margin-bottom:.5rem">Live Preview</div>
          <div class="rl-version-preview" id="preview-${i}"></div>
        </div>
      </div>
    </div>
  `).join('');
  
  // Wire up event listeners
  document.querySelectorAll('.rl-version-clearance').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const index = parseInt(e.target.dataset.index);
      versions[index].clearance = parseInt(e.target.value);
    });
  });
  
  document.querySelectorAll('.rl-version-content').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const index = parseInt(e.target.dataset.index);
      versions[index].content = e.target.value;
      updateVersionPreview(index);
    });
  });
  
  // Update all previews
  versions.forEach((v, i) => updateVersionPreview(i));
}

function updateVersionPreview(index){
  const previewEl = document.getElementById(`preview-${index}`);
  if(!previewEl || !window.marked) return;
  const content = versions[index]?.content || '';
  previewEl.innerHTML = content ? window.marked.parse(content) : '<em>Preview will appear here...</em>';
}

// Helper to get appropriate version for user
function getVersionForUser(log){
  console.log('🔍 getVersionForUser called', { 
    logTitle: log.title, 
    hasVersions: !!log.versions, 
    versionCount: log.versions?.length 
  });
  
  if(!log.versions || log.versions.length === 0) {
    // Fallback to old single-version format
    console.log('📜 Using single-version fallback');
    return { clearance: log.clearanceLevel || 0, content: log.contentMd || '' };
  }
  
  const userC = userClearance();
  console.log('👤 User clearance:', userC);
  console.log('📚 Available versions:', log.versions.map(v => ({ 
    clearance: v.clearance, 
    hasContent: !!(v.contentMd || v.content),
    contentLength: (v.contentMd || v.content || '').length
  })));
  
  // Find versions user has clearance for (clearance >= version.clearance)
  const accessible = log.versions.filter(v => !isNaN(userC) && userC >= v.clearance);
  console.log('✅ Accessible versions:', accessible.map(v => v.clearance));
  
  let selectedVersion;
  if(accessible.length > 0) {
    // Return highest clearance version they can access
    selectedVersion = accessible.reduce((highest, current) => 
      current.clearance > highest.clearance ? current : highest
    );
  } else {
    // Fallback: return lowest clearance version available
    selectedVersion = log.versions.reduce((lowest, current) => 
      current.clearance < lowest.clearance ? current : lowest
    );
  }
  
  console.log('🎯 Selected version:', { 
    clearance: selectedVersion.clearance, 
    hasContentMd: !!selectedVersion.contentMd,
    hasContent: !!selectedVersion.content,
    contentMdLength: (selectedVersion.contentMd || '').length,
    contentLength: (selectedVersion.content || '').length
  });
  
  // Normalize property name: contentMd -> content
  return {
    clearance: selectedVersion.clearance,
    content: selectedVersion.contentMd || selectedVersion.content || ''
  };
}

function openModal(){
  if(!canEdit()){ alert('Only ScD/R&D personnel or Level 5+ can create/edit logs.'); return; }
  resetForm();
  versions = [{ clearance: 1, content: '' }]; // Initialize with one version
  renderVersions();
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  titleInput.focus();
}

function closeModal(){
  modal.style.display = 'none';
  modal.setAttribute('aria-hidden', 'true');
  resetForm();
}

// Load existing log for editing
async function loadExisting(){
  if(!canEdit()){ alert('Only ScD/R&D personnel or Level 5+ can edit logs.'); return; }
  const logId = prompt('Enter the log ID to edit (check URL or document ID):');
  if(!logId) return;
  
  setStatus('Loading...');
  try{
    const docRef = doc(db, 'researchLogs', logId);
    const snap = await getDoc(docRef);
    if(!snap.exists()){ setStatus('Log not found.', true); return; }
    
    const data = snap.data();
    const req = parseClearance(data.clearanceLevel);
    const userC = userClearance();
    const deptOk = isDeptAllowed(userDepartment());
    
    // Check clearance
    if(!deptOk && (Number.isNaN(userC) || Number.isNaN(req) || userC < req)){
      setStatus('Insufficient clearance to edit this log.', true);
      return;
    }
    
    currentLogId = logId;
    modalTitle.textContent = 'Edit Research Log';
    titleInput.value = data.title || '';
    clearanceInput.value = data.clearanceLevel || '1';
    tagsInput.value = (data.tags || []).join(', ');
    linkedItemsInput.value = (data.linkedItems || []).join(', ');
    
    // Load versions
    if(data.versions && data.versions.length > 0){
      versions = data.versions.map(v => ({ clearance: v.clearance || 0, content: v.contentMd || '' }));
    } else {
      // Fallback for old format
      versions = [{ clearance: data.clearanceLevel || 1, content: data.contentMd || '' }];
    }
    
    updateLinkedPreview();
    renderVersions();
    setStatus('');
  } catch(err){
    console.error('Error loading log:', err);
    setStatus('Error: ' + err.message, true);
  }
}

// Update linked items preview
function updateLinkedPreview(){
  const value = linkedItemsInput.value.trim();
  if(!value){
    linkedPreview.innerHTML = '';
    return;
  }
  
  const items = value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  linkedPreview.innerHTML = items.map(item => {
    const type = item.startsWith('AN-') ? 'Anomaly' : item.startsWith('POI-') ? 'POI' : item.startsWith('GOI-') ? 'GOI' : 'Item';
    return `<div class="rl-linked-item">${type}: ${item}</div>`;
  }).join('');
}

// Handle form submission
async function handleSubmit(e){
  e.preventDefault();
  setStatus('');
  
  if(!auth.currentUser){ setStatus('Login required.', true); return; }
  if(!canEdit()){ setStatus('Only ScD/R&D or Level 5+ may edit.', true); return; }
  
  const title = titleInput.value.trim();
  if(!title){ setStatus('Title required.', true); return; }
  
  const clearanceLevel = parseInt(clearanceInput.value);
  if(isNaN(clearanceLevel)){ setStatus('Select clearance level.', true); return; }
  
  // Validate versions
  if(versions.length === 0){ setStatus('Add at least one clearance version.', true); return; }
  const hasContent = versions.some(v => v.content && v.content.trim());
  if(!hasContent){ setStatus('At least one version must have content.', true); return; }
  
  console.log('💾 Saving versions:', versions.map(v => ({ 
    clearance: v.clearance, 
    contentLength: (v.content || '').length,
    contentPreview: (v.content || '').substring(0, 50) 
  })));
  
  const tags = tagsInput.value.split(',').map(s => s.trim()).filter(Boolean);
  const linkedItems = linkedItemsInput.value.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  
  // Generate ID from title if creating new
  const logId = currentLogId || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') + '-' + Date.now().toString(36);
  const docRef = doc(db, 'researchLogs', logId);
  const snap = await getDoc(docRef);
  
  const ch = getSelectedCharacter();
  const payload = {
    title,
    author: ch ? ch.name : null,
    department: ch ? (ch.department || '') : '',
    clearanceLevel,
    tags,
    linkedItems,
    versions: versions.map(v => ({ clearance: v.clearance, contentMd: v.content })),
    updatedAt: serverTimestamp(),
    createdByUid: snap.exists() ? (snap.data().createdByUid || auth.currentUser.uid) : auth.currentUser.uid,
    createdByEmail: snap.exists() ? (snap.data().createdByEmail || auth.currentUser.email) : auth.currentUser.email,
    updatedByUid: auth.currentUser.uid,
    updatedByEmail: auth.currentUser.email || ''
  };
  
  if(!snap.exists()) payload.createdAt = serverTimestamp();
  
  try{
    await setDoc(docRef, payload, { merge: true });
    setStatus('Saved.');
    closeModal();
  } catch(err){
    console.error('Error saving log:', err);
    setStatus('Error: ' + err.message, true);
  }
}

// Render table
function renderList(){
  const q = (searchInput?.value || '').toLowerCase().trim();
  const userC = userClearance();
  const deptOk = isDeptAllowed(userDepartment());
  
  const filtered = logs.filter(log => {
    const req = parseClearance(log.clearanceLevel);
    
    // ScD/R&D can see all
    if(!deptOk){
      if(Number.isNaN(userC) || Number.isNaN(req)) return false;
      if(userC < req) return false;
    }
    
    if(q){
      const hay = `${log.title||''} ${(log.tags||[]).join(' ')} ${(log.linkedItems||[]).join(' ')}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    
    return true;
  });
  
  if(filtered.length === 0){
    tableBody.innerHTML = '<tr><td colspan="4" class="rl-empty">No logs found.</td></tr>';
    return;
  }
  
  tableBody.innerHTML = '';
  filtered.forEach(log => {
    const row = document.createElement('tr');
    row.addEventListener('click', () => openViewModal(log));
    
    const titleCell = document.createElement('td');
    titleCell.innerHTML = `<span class="rl-link">${log.title || '(untitled)'}</span>`;
    
    const authorCell = document.createElement('td');
    authorCell.textContent = log.author || 'Unknown';
    
    const tagsCell = document.createElement('td');
    const tagsPart = (log.tags || []).map(t => `<span class="rl-tag">${t}</span>`).join('');
    const linkedPart = (log.linkedItems || []).map(i => `<span class="rl-linked">${i}</span>`).join('');
    tagsCell.innerHTML = tagsPart + linkedPart || '<span style="color:var(--text-light)">—</span>';
    
    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(log.createdAt);
    
    row.appendChild(titleCell);
    row.appendChild(authorCell);
    row.appendChild(tagsCell);
    row.appendChild(dateCell);
    tableBody.appendChild(row);
  });
}

// View modal
function openViewModal(log){
  viewTitle.textContent = log.title || '(untitled)';
  
  // Get appropriate version for user
  const version = getVersionForUser(log);
  const versionInfo = log.versions && log.versions.length > 1 ? ` • Viewing Level ${version.clearance} version` : '';
  
  viewMeta.textContent = `${log.author || 'Unknown'} • ${log.department || ''} • ${formatDate(log.createdAt)} • Clearance ${log.clearanceLevel || '?'}${versionInfo}`;
  
  if(log.linkedItems && log.linkedItems.length){
    viewLinked.innerHTML = '<strong>Linked to:</strong> ' + log.linkedItems.map(i => `<span class="rl-linked">${i}</span>`).join('');
  } else {
    viewLinked.innerHTML = '';
  }
  
  if(version.content && window.marked){
    viewContent.innerHTML = window.marked.parse(version.content);
  } else {
    viewContent.innerHTML = '<em>No content available.</em>';
  }
  
  // Show edit button if user can edit
  if(canEdit()){
    editBtn.style.display = 'inline-block';
    editBtn.onclick = async () => {
      viewModal.setAttribute('aria-hidden', 'true');
      currentLogId = log.id;
      
      // Load the log data
      try{
        const docRef = doc(db, 'researchLogs', log.id);
        const snap = await getDoc(docRef);
        if(!snap.exists()) return;
        
        const data = snap.data();
        const req = parseClearance(data.clearanceLevel);
        const userC = userClearance();
        const deptOk = isDeptAllowed(userDepartment());
        
        if(!deptOk && (Number.isNaN(userC) || Number.isNaN(req) || userC < req)){
          alert('Insufficient clearance to edit this log.');
          return;
        }
        
        modalTitle.textContent = 'Edit Research Log';
        titleInput.value = data.title || '';
        clearanceInput.value = data.clearanceLevel || '1';
        tagsInput.value = (data.tags || []).join(', ');
        linkedItemsInput.value = (data.linkedItems || []).join(', ');
        
        // Load versions
        if(data.versions && data.versions.length > 0){
          versions = data.versions.map(v => ({ clearance: v.clearance || 0, content: v.contentMd || '' }));
        } else {
          versions = [{ clearance: data.clearanceLevel || 1, content: data.contentMd || '' }];
        }
        
        updateLinkedPreview();
        renderVersions();
        
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
      } catch(err){
        console.error('Error loading log:', err);
        alert('Error loading log: ' + err.message);
      }
    };
  } else {
    editBtn.style.display = 'none';
  }
  
  viewModal.style.display = 'flex';
  viewModal.setAttribute('aria-hidden', 'false');
}

function closeViewModal(){
  viewModal.style.display = 'none';
  viewModal.setAttribute('aria-hidden', 'true');
}

// Initialize
function initializeResearchLogs(){
  // Debug logging
  const dept = userDepartment();
  const clearance = userClearance();
  const canEditResult = canEdit();
  console.log('🔍 Research Logs Permission Check:', { 
    department: dept, 
    clearance, 
    isDeptAllowed: isDeptAllowed(dept),
    canEdit: canEditResult 
  });
  
  // Show new button if authorized
  setTimeout(() => {
    if(canEdit()) {
      newBtn.style.display = 'inline-block';
      console.log('✅ Showing New Log button');
    } else {
      console.log('❌ Hiding New Log button');
    }
  }, 50);
  
  // Wire buttons
  newBtn?.addEventListener('click', openModal);
  closeBtn?.addEventListener('click', closeModal);
  cancelBtn?.addEventListener('click', closeModal);
  loadBtn?.addEventListener('click', loadExisting);
  addVersionBtn?.addEventListener('click', addVersion);
  form?.addEventListener('submit', handleSubmit);
  
  viewCloseBtn?.addEventListener('click', closeViewModal);
  viewModal?.addEventListener('click', (e) => { if(e.target === viewModal) closeViewModal(); });
  
  // Wire live preview
  linkedItemsInput?.addEventListener('input', updateLinkedPreview);
  
  // Wire search
  searchInput?.addEventListener('input', renderList);
  
  // Subscribe to logs
  const q = query(collection(db, 'researchLogs'), orderBy('createdAt', 'desc'));
  onSnapshot(q, (snap) => {
    logs = [];
    snap.forEach(docSnap => logs.push({ id: docSnap.id, ...docSnap.data() }));
    renderList();
    
    // Check if URL has ?view= parameter to auto-open a log
    const params = new URLSearchParams(window.location.search);
    const viewId = params.get('view');
    if(viewId){
      const log = logs.find(l => l.id === viewId);
      if(log) openViewModal(log);
    }
  }, (err) => {
    console.error('Error loading logs:', err);
    tableBody.innerHTML = '<tr><td colspan="4" class="rl-empty">Error: ' + err.message + '</td></tr>';
  });
  
  // Storage listener for button visibility
  window.addEventListener('storage', () => {
    if(canEdit()) newBtn.style.display = 'inline-block';
    else newBtn.style.display = 'none';
  });
}

// Initialize when ready
document.addEventListener('includesLoaded', initializeResearchLogs);
if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', () => setTimeout(initializeResearchLogs, 100));
} else {
  setTimeout(initializeResearchLogs, 100);
}
