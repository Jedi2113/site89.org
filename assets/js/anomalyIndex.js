import { app } from '/assets/js/auth.js';
import { getFirestore, collection, doc, setDoc, getDoc, onSnapshot, serverTimestamp, query, where, getDocs, deleteDoc, orderBy } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';

const db = getFirestore(app);
const auth = getAuth(app);

function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ if(!dept) return false; const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); }
function canEdit(){ const c = userClearance(); if(!isNaN(c) && c >= 5) return true; return isDeptAllowed(userDepartment()); }
function displayName(){ const ch = getSelectedCharacter(); if(ch && ch.name) return ch.name; return null; }
function characterId(){ const ch = getSelectedCharacter(); return ch && ch.id ? ch.id : null; }

function docIdFromItemNumber(itemNumber){ const m = (itemNumber || '').match(/\d+/); if(m) return m[0]; return (itemNumber || 'scp-000').replace(/[^A-Za-z0-9]/g,'-'); }
function formatItemNumber(raw){ const s = (raw || '').toUpperCase().replace(/\s+/g,''); const digits = s.match(/\d+/); if(!digits) return s || 'SCP-000'; const padded = digits[0].padStart(3,'0'); return `SCP-${padded}`; }
function renderMarkdown(md){ return marked.parse(md || ''); }
function summarize(md){ const plain = (md || '').replace(/[\n\r]+/g,' ').replace(/[#*_`>\[\]]/g,' ').trim(); return plain.length > 140 ? plain.slice(0,140) + '…' : (plain || 'No description yet.'); }

// Elements
const newBtn = document.getElementById('newAnomalyBtn');
const modal = document.getElementById('createModal');
const closeModalBtn = document.getElementById('closeModalBtn');
const loadExistingBtn = document.getElementById('loadExistingBtn');
const form = document.getElementById('anomalyForm');
const proceduresInput = document.getElementById('procedures');
const descriptionInput = document.getElementById('description');
const proceduresPreview = document.getElementById('proceduresPreview');
const descriptionPreview = document.getElementById('descriptionPreview');
const formStatus = document.getElementById('formStatus');
const saveDraftBtn = document.getElementById('saveDraftBtn');
const myDraftsBtn = document.getElementById('myDraftsBtn');
const deleteDraftBtn = document.getElementById('deleteDraftBtn');
const draftsModal = document.getElementById('draftsModal');
const closeDraftsModal = document.getElementById('closeDraftsModal');
const draftList = document.getElementById('draftList');
const searchInput = document.getElementById('anomalySearch');
const classFilter = document.getElementById('classFilter');
const riskFilter = document.getElementById('riskFilter');
const disruptionFilter = document.getElementById('disruptionFilter');
const tableBody = document.getElementById('anomalyTableBody');

let anomalies = [];
let currentDraftId = null;

function setStatus(msg, isError=false){ if(!formStatus) return; formStatus.textContent = msg || ''; formStatus.style.color = isError ? 'var(--accent-red)' : 'var(--text-light)'; }
function refreshPreview(){ if(proceduresPreview) proceduresPreview.innerHTML = renderMarkdown(proceduresInput.value); if(descriptionPreview) descriptionPreview.innerHTML = renderMarkdown(descriptionInput.value); }

function updateDraftUI(isDraft){
  if(!deleteDraftBtn) return;
  deleteDraftBtn.style.display = isDraft ? 'inline-block' : 'none';
  if(!isDraft) currentDraftId = null;
}

function resetForm(){ form.reset(); refreshPreview(); updateDraftUI(false); }

function getFormData(){
  return {
    itemNumber: document.getElementById('itemNumber').value || '',
    nickname: document.getElementById('nickname').value || '',
    photoUrl: (document.getElementById('photoUrl').value || '').trim(),
    containmentClass: document.getElementById('containmentClass').value || '',
    riskClass: document.getElementById('riskClass').value || '',
    disruptionClass: document.getElementById('disruptionClass').value || '',
    clearanceLevel: document.getElementById('clearanceLevel').value || '',
    proceduresMd: proceduresInput.value || '',
    descriptionMd: descriptionInput.value || ''
  };
}

function setFormData(data){
  document.getElementById('itemNumber').value = data.itemNumber || '';
  document.getElementById('nickname').value = data.nickname || '';
  document.getElementById('photoUrl').value = data.photoUrl || '';
  document.getElementById('containmentClass').value = data.containmentClass || '';
  document.getElementById('riskClass').value = data.riskClass || '';
  document.getElementById('disruptionClass').value = data.disruptionClass || '';
  document.getElementById('clearanceLevel').value = data.clearanceLevel || '';
  proceduresInput.value = data.proceduresMd || '';
  descriptionInput.value = data.descriptionMd || '';
  refreshPreview();
}

function generateDraftTitle(formData){
  if(formData.itemNumber && formData.itemNumber.trim()) return `Draft: ${formData.itemNumber}`;
  return 'Draft: Untitled Anomaly';
}

function escapeHtml(text){
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function saveDraft(){
  if(!auth.currentUser){ setStatus('Login is required to save drafts.', true); return; }
  const charId = characterId();
  if(!charId){ setStatus('Please select a character first.', true); return; }

  const formData = getFormData();
  const draftTitle = generateDraftTitle(formData);
  const draftId = currentDraftId || `draft_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const draftPayload = {
    ...formData,
    draftId,
    draftTitle,
    characterId: charId,
    characterName: displayName(),
    createdByUid: auth.currentUser.uid,
    createdByEmail: auth.currentUser.email || '',
    updatedAt: serverTimestamp()
  };
  if(!currentDraftId) draftPayload.createdAt = serverTimestamp();

  try{
    await setDoc(doc(db, 'anomaly_drafts', draftId), draftPayload, { merge: true });
    currentDraftId = draftId;
    updateDraftUI(true);
    setStatus('Draft saved.');
  } catch(err){
    console.error('Error saving draft', err);
    setStatus('Error saving draft: ' + err.message, true);
  }
}

async function loadDraft(draftId){
  if(!auth.currentUser){ setStatus('Login is required.', true); return; }
  try{
    const snap = await getDoc(doc(db, 'anomaly_drafts', draftId));
    if(!snap.exists()){ setStatus('Draft not found.', true); return; }
    const data = snap.data();
    const charId = characterId();
    if(data.characterId !== charId){ setStatus('This draft belongs to another character.', true); return; }
    setFormData(data);
    currentDraftId = draftId;
    updateDraftUI(true);
    setStatus('Draft loaded.');
    draftsModal?.classList.remove('active');
  } catch(err){
    console.error('Error loading draft', err);
    setStatus('Error loading draft: ' + err.message, true);
  }
}

async function deleteDraft(){
  if(!currentDraftId) return;
  if(!confirm('Delete this draft? This cannot be undone.')) return;
  try{
    await deleteDoc(doc(db, 'anomaly_drafts', currentDraftId));
    setStatus('Draft deleted.');
    resetForm();
  } catch(err){
    console.error('Error deleting draft', err);
    setStatus('Error deleting draft: ' + err.message, true);
  }
}

async function deleteDraftById(draftId){
  if(!confirm('Delete this draft? This cannot be undone.')) return;
  try{
    await deleteDoc(doc(db, 'anomaly_drafts', draftId));
    if(currentDraftId === draftId) resetForm();
    showDraftsModal();
  } catch(err){
    console.error('Error deleting draft', err);
    alert('Error deleting draft: ' + err.message);
  }
}

async function showDraftsModal(){
  if(!auth.currentUser){ setStatus('Login is required.', true); return; }
  const charId = characterId();
  if(!charId){ setStatus('Please select a character first.', true); return; }

  draftsModal?.classList.add('active');
  if(draftList) draftList.innerHTML = '<p class="empty-drafts">Loading drafts...</p>';

  try{
    const q = query(
      collection(db, 'anomaly_drafts'),
      where('createdByUid', '==', auth.currentUser.uid)
    );
    const snapshot = await getDocs(q);
    if(snapshot.empty){
      if(draftList) draftList.innerHTML = '<p class="empty-drafts">No drafts found. Start writing to create one!</p>';
      return;
    }

    const drafts = [];
    snapshot.forEach((docSnap)=>{
      const data = docSnap.data();
      if(data.characterId !== charId) return;
      drafts.push(data);
    });

    drafts.sort((a, b) => {
      const aTime = a.updatedAt?.toMillis?.() || 0;
      const bTime = b.updatedAt?.toMillis?.() || 0;
      return bTime - aTime;
    });

    let html = '';
    drafts.forEach((data)=>{
      const updatedDate = data.updatedAt?.toDate?.() || new Date();
      const formattedDate = updatedDate.toLocaleDateString() + ' ' + updatedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      html += `
        <div class="draft-item">
          <div class="draft-info">
            <div class="draft-title">${escapeHtml(data.draftTitle || 'Untitled Draft')}</div>
            <div class="draft-meta">Last modified: ${formattedDate}</div>
          </div>
          <div class="draft-actions">
            <button class="btn-small" onclick="window.anomalyIndex.loadDraftById('${data.draftId}')">Load</button>
            <button class="btn-small danger" onclick="window.anomalyIndex.deleteDraftById('${data.draftId}')">Delete</button>
          </div>
        </div>
      `;
    });

    if(!drafts.length){
      if(draftList) draftList.innerHTML = '<p class="empty-drafts">No drafts found. Start writing to create one!</p>';
      return;
    }

    if(draftList) draftList.innerHTML = html;
  } catch(err){
    console.error('Error loading drafts', err);
    if(draftList) draftList.innerHTML = `<p class="empty-drafts" style="color:var(--accent-red)">Error loading drafts: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadExisting(){ 
  const formatted = formatItemNumber(document.getElementById('itemNumber').value || ''); 
  if(!formatted){ setStatus('Enter an item number to load.', true); return; } 
  const docId = docIdFromItemNumber(formatted); 
  const ref = doc(db,'anomalies',docId); 
  const snap = await getDoc(ref); 
  if(!snap.exists()){ setStatus('No anomaly found for that item number.', true); return; } 
  const data = snap.data(); 
  
  // Clearance check - prevent loading anomalies above user's clearance
  const required = parseClearance(data.clearanceLevel || 0);
  const userC = userClearance();
  const deptOk = isDeptAllowed(userDepartment());
  const userHasClearance = !Number.isNaN(userC) && userC >= required;
  const allowed = deptOk || userHasClearance;
  
  if(!allowed){
    setStatus(`Access denied: Requires Level ${required} clearance or ScD/R&D assignment.`, true);
    return;
  }
  
  document.getElementById('itemNumber').value = data.itemNumber || formatted; 
  document.getElementById('nickname').value = data.nickname || ''; 
  document.getElementById('photoUrl').value = data.photoUrl || ''; 
  document.getElementById('containmentClass').value = data.containmentClass || ''; 
  document.getElementById('riskClass').value = data.riskClass || ''; 
  document.getElementById('disruptionClass').value = data.disruptionClass || ''; 
  document.getElementById('clearanceLevel').value = data.clearanceLevel || ''; 
  proceduresInput.value = data.proceduresMd || ''; 
  descriptionInput.value = data.descriptionMd || ''; 
  refreshPreview(); 
  updateDraftUI(false);
  setStatus('Loaded existing entry.'); 
}

async function handleSubmit(e){ e.preventDefault(); setStatus(''); if(!auth.currentUser){ setStatus('Login is required.', true); return; } if(!canEdit()){ setStatus('Only ScD/R&D or Level 5 may edit.', true); return; }
  const formatted = formatItemNumber(document.getElementById('itemNumber').value || ''); if(!formatted){ setStatus('Item number required.', true); return; }
  const clearanceLevel = parseClearance(document.getElementById('clearanceLevel').value || ''); if(Number.isNaN(clearanceLevel)){ setStatus('Select a clearance level.', true); return; }
  const docId = docIdFromItemNumber(formatted);
  const ref = doc(db,'anomalies',docId);
  const snap = await getDoc(ref);
  const payload = {
    itemNumber: formatted,
    nickname: (document.getElementById('nickname').value || '').trim(),
    containmentClass: document.getElementById('containmentClass').value,
    riskClass: document.getElementById('riskClass').value,
    disruptionClass: document.getElementById('disruptionClass').value,
    clearanceLevel,
    photoUrl: (document.getElementById('photoUrl').value || '').trim(),
    proceduresMd: proceduresInput.value || '',
    descriptionMd: descriptionInput.value || '',
    updatedAt: serverTimestamp(),
    createdByUid: snap.exists() ? (snap.data().createdByUid || auth.currentUser.uid) : auth.currentUser.uid,
    createdByEmail: snap.exists() ? (snap.data().createdByEmail || auth.currentUser.email || '') : (auth.currentUser.email || ''),
    createdByDisplay: snap.exists() ? (snap.data().createdByDisplay || displayName()) : displayName(),
    updatedByUid: auth.currentUser.uid,
    updatedByEmail: auth.currentUser.email || '',
    updatedByDisplay: displayName()
  };
  if(!snap.exists()) payload.createdAt = serverTimestamp();
  try{
    await setDoc(ref, payload, { merge:true });
    if(currentDraftId){
      try{ await deleteDoc(doc(db, 'anomaly_drafts', currentDraftId)); }
      catch(err){ console.error('Error deleting draft after publish', err); }
    }
    setStatus('Saved.');
    modal.style.display='none'; modal.setAttribute('aria-hidden','true');
    resetForm();
  } catch(err){ console.error('Error saving anomaly', err); setStatus('Error: ' + err.message, true); }
}

function renderList(){
  const q = (searchInput?.value || '').toLowerCase().trim();
  const cls = classFilter?.value || 'all';
  const risk = riskFilter?.value || 'all';
  const dis = disruptionFilter?.value || 'all';
  const userC = userClearance();
  const deptOk = isDeptAllowed(userDepartment());
  
  console.log('📋 CLEARANCE CHECK - User Clearance:', userC, '| Dept OK:', deptOk, '| Dept:', userDepartment());
  
  const filtered = anomalies.filter(a => {
    const req = parseClearance(a.clearanceLevel);
    
    console.log(`Checking ${a.itemNumber}: req=${req} (type: ${typeof a.clearanceLevel}, raw: ${a.clearanceLevel})`);
    
    // ScD/R&D departments can see all clearance levels
    if(deptOk) {
      console.log(`  ✅ ScD/R&D bypass`);
      // Skip clearance check for ScD/R&D
    } else {
      // Not in special dept - must have sufficient clearance
      // User clearance must be >= required clearance
      if(Number.isNaN(userC)) {
        console.log(`  ❌ BLOCKED: User has invalid clearance (NaN)`);
        return false;
      }
      if(Number.isNaN(req)) {
        console.log(`  ❌ BLOCKED: Anomaly has invalid clearance (NaN)`);
        return false;
      }
      if(userC < req) {
        console.log(`  ❌ BLOCKED: User clearance ${userC} < required ${req}`);
        return false;
      }
      console.log(`  ✅ ALLOWED: User clearance ${userC} >= required ${req}`);
    }
    
    if(cls !== 'all' && a.containmentClass !== cls) return false;
    if(risk !== 'all' && a.riskClass !== risk) return false;
    if(dis !== 'all' && a.disruptionClass !== dis) return false;
    if(q){
      const hay = `${a.itemNumber||''} ${a.descriptionMd||''} ${a.containmentClass||''}`.toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  });

  if(!filtered.length){ tableBody.innerHTML = '<tr><td colspan="5" class="empty">No anomalies visible for your clearance.</td></tr>'; return; }
  tableBody.innerHTML = '';
  filtered.forEach(a => {
    const docId = docIdFromItemNumber(a.itemNumber || a.docId || '');
    const url = `/anomalies/view/?id=${encodeURIComponent(docId)}`;
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><a class="click-row" href="${url}">${a.itemNumber || 'SCP-000'}</a></td>
      <td><a class="click-row" href="${url}"><span class="pill ${a.containmentClass||''}">${a.containmentClass || '?'}</span></a></td>
      <td><a class="click-row" href="${url}">${a.riskClass || '?'}</a></td>
      <td><a class="click-row" href="${url}">${a.disruptionClass || '?'}</a></td>
      <td><a class="click-row" href="${url}">${a.nickname || '(No nickname)'}</a></td>
    `;
    tableBody.appendChild(row);
  });
}

function wireModal(){
  const updateButtonVisibility = () => {
    if(newBtn){ newBtn.style.display = canEdit() ? 'inline-block' : 'none'; }
  };
  
  if(newBtn){ 
    updateButtonVisibility();
    newBtn.addEventListener('click', ()=>{ if(!canEdit()) return alert('Only ScD/R&D or Level 5 may edit.'); modal.style.display='flex'; modal.setAttribute('aria-hidden','false'); document.getElementById('itemNumber').focus(); refreshPreview(); }); 
  }
  if(closeModalBtn) closeModalBtn.addEventListener('click', ()=>{ modal.style.display='none'; modal.setAttribute('aria-hidden','true'); setStatus(''); });
  if(loadExistingBtn) loadExistingBtn.addEventListener('click', loadExisting);
  if(saveDraftBtn) saveDraftBtn.addEventListener('click', saveDraft);
  if(myDraftsBtn) myDraftsBtn.addEventListener('click', showDraftsModal);
  if(deleteDraftBtn) deleteDraftBtn.addEventListener('click', deleteDraft);
  if(closeDraftsModal) closeDraftsModal.addEventListener('click', ()=> draftsModal?.classList.remove('active'));
  draftsModal?.addEventListener('click', (e)=>{ if(e.target === draftsModal) draftsModal.classList.remove('active'); });
  [proceduresInput, descriptionInput].forEach(el=> el && el.addEventListener('input', refreshPreview));
  if(form) form.addEventListener('submit', handleSubmit);
  
  // Update button visibility when character selection changes
  window.addEventListener('storage', updateButtonVisibility);
}

function subscribe(){
  const q = collection(db,'anomalies');
  onSnapshot(q, (snap)=>{
    anomalies = [];
    snap.forEach(docSnap => anomalies.push({ docId: docSnap.id, ...(docSnap.data()||{}) }));
    anomalies.sort((a,b)=> (a.itemNumber||'').localeCompare(b.itemNumber||''));
    renderList();
  }, (err)=>{
    console.error('Firestore error:', err);
    tableBody.innerHTML = '<tr><td colspan="5" class="empty">Error loading anomalies: ' + err.message + '</td></tr>';
  });
}

function kickoff(){ 
  if(window.__anomalyIndexReady) return; 
  
  // Verify character is selected before allowing any interactions
  const selectedChar = getSelectedCharacter();
  if (!selectedChar || !selectedChar.name) {
    if(newBtn) newBtn.disabled = true;
    if(newBtn) newBtn.title = 'You must select a character first. Go to Character Select.';
    if(newBtn) newBtn.style.opacity = '0.5';
    if(newBtn) newBtn.style.cursor = 'not-allowed';
    if(form) form.style.opacity = '0.5';
    if(form) form.style.pointerEvents = 'none';
    if(formStatus) setStatus('You must select a character before creating or editing anomaly records.', true);
    return;
  }
  
  window.__anomalyIndexReady=true; 
  refreshPreview(); 
  subscribe(); 
  if(searchInput) searchInput.addEventListener('input', renderList); 
  classFilter?.addEventListener('change', renderList); 
  riskFilter?.addEventListener('change', renderList); 
  disruptionFilter?.addEventListener('change', renderList); 
  // Wire modal after a small delay to ensure character is loaded
  setTimeout(() => { wireModal(); }, 50);
  // auto-load anomaly if id or item param provided
  const params = new URLSearchParams(window.location.search);
  const draftParam = params.get('draft');
  const idParam = params.get('id') || params.get('item');
  if(draftParam){
    modal.style.display='flex';
    modal.setAttribute('aria-hidden','false');
    setTimeout(() => loadDraft(draftParam), 100);
  } else if(idParam){ 
    modal.style.display='flex'; 
    modal.setAttribute('aria-hidden','false'); 
    document.getElementById('itemNumber').value = formatItemNumber(idParam); 
    setTimeout(() => loadExisting(), 100); 
  }
}

window.anomalyIndex = {
  loadDraftById: loadDraft,
  deleteDraftById: deleteDraftById
};

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
