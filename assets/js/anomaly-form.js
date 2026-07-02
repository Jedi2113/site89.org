import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs, deleteDoc, orderBy } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.js';

const db = getFirestore(app);
const form = document.getElementById('anomalyForm');
const statusEl = document.getElementById('formStatus');
const proceduresInput = document.getElementById('procedures');
const descriptionInput = document.getElementById('description');
const proceduresPreview = document.getElementById('proceduresPreview');
const descriptionPreview = document.getElementById('descriptionPreview');
const loadBtn = document.getElementById('loadBtn');
const clearanceInput = document.getElementById('clearanceLevel');

// Draft-related elements
const saveDraftBtn = document.getElementById('saveDraftBtn');
const myDraftsBtn = document.getElementById('myDraftsBtn');
const publishBtn = document.getElementById('publishBtn');
const deleteDraftBtn = document.getElementById('deleteDraftBtn');
const draftIndicator = document.getElementById('draftIndicator');
const draftsModal = document.getElementById('draftsModal');
const closeDraftsModal = document.getElementById('closeDraftsModal');
const draftList = document.getElementById('draftList');

let currentUser = null;
let currentDraftId = null; // Track if we're editing a draft

function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ if(!dept) return false; const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); }
function canSubmit(){ const c = userClearance(); if(!isNaN(c) && c >= 5) return true; return isDeptAllowed(userDepartment()); }
function displayName(){ const ch = getSelectedCharacter(); if(ch && ch.name) return ch.name; return null; }
function characterId(){ const ch = getSelectedCharacter(); return ch && ch.id ? ch.id : null; }

function formatItemNumber(raw){
  let s = String(raw || '').toUpperCase().trim();
  if(!s) return 'SCP-000';
  s = s.replace(/\s+/g, '-').replace(/_+/g, '-').replace(/[^A-Z0-9-]/g, '');
  s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
  if(!s.startsWith('SCP')) s = `SCP-${s}`;
  s = s.replace(/^SCP(?=\d)/, 'SCP-').replace(/^SCP-+/, 'SCP-');
  const m = s.match(/^SCP-(\d+)(.*)$/);
  if(!m) return s || 'SCP-000';
  const numberPart = m[1].padStart(3, '0');
  const suffix = (m[2] || '').replace(/^-+/, '').replace(/[^A-Z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return suffix ? `SCP-${numberPart}-${suffix}` : `SCP-${numberPart}`;
}

function docIdFromItemNumber(itemNumber){
  const formatted = formatItemNumber(itemNumber);
  const m = formatted.match(/^SCP-(\d+)(?:-(.+))?$/);
  if(m){
    const base = String(parseInt(m[1], 10));
    const suffix = String(m[2] || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return suffix ? `${base}-${suffix}` : base;
  }
  return formatted.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'scp-000';
}

function renderMarkdown(md){ return DOMPurify.sanitize(marked.parse(md || '')); }
function refreshPreview(){ proceduresPreview.innerHTML = renderMarkdown(proceduresInput.value); descriptionPreview.innerHTML = renderMarkdown(descriptionInput.value); }
function setStatus(msg, isError=false){ statusEl.textContent = msg || ''; statusEl.style.color = isError ? 'var(--accent-red)' : 'var(--text-light)'; }

function updateDraftUI(isDraft) {
  if (isDraft) {
    draftIndicator.style.display = 'inline-block';
    deleteDraftBtn.style.display = 'inline-block';
    publishBtn.textContent = 'Publish Draft';
  } else {
    draftIndicator.style.display = 'none';
    deleteDraftBtn.style.display = 'none';
    publishBtn.textContent = 'Publish Anomaly';
    currentDraftId = null;
  }
}

function clearForm() {
  form.reset();
  refreshPreview();
  updateDraftUI(false);
  setStatus('');
}

// Get form data as object
function getFormData() {
  return {
    itemNumber: form.itemNumber.value || '',
    photoUrl: (form.photoUrl.value || '').trim(),
    containmentClass: form.containmentClass.value || '',
    riskClass: form.riskClass.value || '',
    disruptionClass: form.disruptionClass.value || '',
    clearanceLevel: clearanceInput.value || '',
    proceduresMd: form.procedures.value || '',
    descriptionMd: form.description.value || ''
  };
}

// Set form data from object
function setFormData(data) {
  form.itemNumber.value = data.itemNumber || '';
  form.photoUrl.value = data.photoUrl || '';
  form.containmentClass.value = data.containmentClass || '';
  form.riskClass.value = data.riskClass || '';
  form.disruptionClass.value = data.disruptionClass || '';
  clearanceInput.value = data.clearanceLevel || '';
  form.procedures.value = data.proceduresMd || '';
  form.description.value = data.descriptionMd || '';
  refreshPreview();
}

// Generate draft title
function generateDraftTitle(formData) {
  if (formData.itemNumber && formData.itemNumber.trim()) {
    return `Draft: ${formData.itemNumber}`;
  }
  return `Draft: Untitled Anomaly`;
}

// Save as Draft
async function saveDraft() {
  if (!currentUser) {
    setStatus('Login is required to save drafts.', true);
    return;
  }
  
  const charId = characterId();
  if (!charId) {
    setStatus('Please select a character first.', true);
    return;
  }

  const formData = getFormData();
  const draftTitle = generateDraftTitle(formData);
  
  // Generate draft ID if new draft
  const draftId = currentDraftId || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  const draftPayload = {
    ...formData,
    draftId,
    draftTitle,
    characterId: charId,
    characterName: displayName(),
    createdByUid: currentUser.uid,
    createdByEmail: currentUser.email || '',
    updatedAt: serverTimestamp()
  };

  // Add createdAt only for new drafts
  if (!currentDraftId) {
    draftPayload.createdAt = serverTimestamp();
  }

  try {
    const draftRef = doc(db, 'anomaly_drafts', draftId);
    await setDoc(draftRef, draftPayload, { merge: true });
    
    currentDraftId = draftId;
    updateDraftUI(true);
    setStatus('Draft saved successfully!');
    
    // Update URL to include draft ID
    const url = new URL(window.location);
    url.searchParams.set('draft', draftId);
    window.history.replaceState({}, '', url);
  } catch (err) {
    console.error('Error saving draft:', err);
    setStatus(`Error saving draft: ${err.message}`, true);
  }
}

// Load draft by ID
async function loadDraft(draftId) {
  if (!currentUser) {
    setStatus('Login is required.', true);
    return;
  }

  try {
    const draftRef = doc(db, 'anomaly_drafts', draftId);
    const snap = await getDoc(draftRef);
    
    if (!snap.exists()) {
      setStatus('Draft not found.', true);
      return;
    }

    const data = snap.data();
    
    // Verify draft belongs to current character
    const charId = characterId();
    if (data.characterId !== charId) {
      setStatus('This draft belongs to another character.', true);
      return;
    }

    setFormData(data);
    currentDraftId = draftId;
    updateDraftUI(true);
    setStatus('Draft loaded successfully.');
    
    // Close modal if open
    draftsModal.classList.remove('active');
  } catch (err) {
    console.error('Error loading draft:', err);
    setStatus(`Error loading draft: ${err.message}`, true);
  }
}

// Delete current draft
async function deleteDraft() {
  if (!currentDraftId) return;
  
  if (!confirm('Are you sure you want to delete this draft? This cannot be undone.')) {
    return;
  }

  try {
    const draftRef = doc(db, 'anomaly_drafts', currentDraftId);
    await deleteDoc(draftRef);
    
    setStatus('Draft deleted.');
    clearForm();
    
    // Remove draft param from URL
    const url = new URL(window.location);
    url.searchParams.delete('draft');
    window.history.replaceState({}, '', url);
  } catch (err) {
    console.error('Error deleting draft:', err);
    setStatus(`Error deleting draft: ${err.message}`, true);
  }
}

// Show drafts modal
async function showDraftsModal() {
  if (!currentUser) {
    setStatus('Login is required.', true);
    return;
  }

  const charId = characterId();
  if (!charId) {
    setStatus('Please select a character first.', true);
    return;
  }

  draftsModal.classList.add('active');
  draftList.innerHTML = '<p class="empty-drafts">Loading drafts...</p>';

  try {
    const draftsRef = collection(db, 'anomaly_drafts');
    const q = query(
      draftsRef,
      where('createdByUid', '==', currentUser.uid)
    );
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      draftList.innerHTML = '<p class="empty-drafts">No drafts found. Start writing to create your first draft!</p>';
      return;
    }

    const drafts = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      if (data.characterId !== charId) return;
      drafts.push(data);
    });

    drafts.sort((a, b) => {
      const aTime = a.updatedAt?.toMillis?.() || 0;
      const bTime = b.updatedAt?.toMillis?.() || 0;
      return bTime - aTime;
    });

    let html = '';
    drafts.forEach((data) => {
      const updatedDate = data.updatedAt?.toDate?.() || new Date();
      const formattedDate = updatedDate.toLocaleDateString() + ' ' + updatedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      
      html += `
        <div class="draft-item">
          <div class="draft-info">
            <div class="draft-title">${escapeHtml(data.draftTitle || 'Untitled Draft')}</div>
            <div class="draft-meta">Last modified: ${formattedDate}</div>
          </div>
          <div class="draft-actions">
            <button class="btn-small" onclick="window.anomalyForm.loadDraftById('${data.draftId}')">Load</button>
            <button class="btn-small danger" onclick="window.anomalyForm.deleteDraftById('${data.draftId}')">Delete</button>
          </div>
        </div>
      `;
    });

    draftList.innerHTML = html;
  } catch (err) {
    console.error('Error loading drafts:', err);
    draftList.innerHTML = `<p class="empty-drafts" style="color:var(--accent-red)">Error loading drafts: ${escapeHtml(err.message)}</p>`;
  }
}

// Delete draft by ID (from modal)
async function deleteDraftById(draftId) {
  if (!confirm('Are you sure you want to delete this draft? This cannot be undone.')) {
    return;
  }

  try {
    const draftRef = doc(db, 'anomaly_drafts', draftId);
    await deleteDoc(draftRef);
    
    // If deleting current draft, clear form
    if (currentDraftId === draftId) {
      clearForm();
    }
    
    // Refresh modal
    showDraftsModal();
  } catch (err) {
    console.error('Error deleting draft:', err);
    alert(`Error deleting draft: ${err.message}`);
  }
}

// Utility function to escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function loadExisting(){ 
  const formatted = formatItemNumber(form.itemNumber.value || ''); 
  if(!formatted){ 
    setStatus('Enter an item number to load.', true); 
    return; 
  } 
  const docId = docIdFromItemNumber(formatted); 
  const ref = doc(db,'anomalies',docId); 
  const snap = await getDoc(ref); 
  if(!snap.exists()){ 
    setStatus('No anomaly found for that item number.', true); 
    return; 
  } 
  const data = snap.data(); 
  
  setFormData({
    itemNumber: data.itemNumber || formatted,
    photoUrl: data.photoUrl || '',
    containmentClass: data.containmentClass || '',
    riskClass: data.riskClass || '',
    disruptionClass: data.disruptionClass || '',
    clearanceLevel: data.clearanceLevel || '',
    proceduresMd: data.proceduresMd || '',
    descriptionMd: data.descriptionMd || ''
  });
  
  // Clear draft state when loading published anomaly
  updateDraftUI(false);
  setStatus('Loaded existing entry.'); 
}

async function handleSubmit(e){ 
  e.preventDefault(); 
  if(!currentUser){ 
    setStatus('Login is required to save.', true); 
    return; 
  } 
  if(!canSubmit()){ 
    setStatus('Only Level 5 or ScD/R&D characters can publish.', true); 
    return; 
  }
  
  const formatted = formatItemNumber(form.itemNumber.value || ''); 
  form.itemNumber.value = formatted;
  const docId = docIdFromItemNumber(formatted);
  const ref = doc(db,'anomalies',docId);
  const snap = await getDoc(ref);

  const clearanceLevel = parseClearance(clearanceInput.value || '');
  if(Number.isNaN(clearanceLevel)){ 
    setStatus('Select a clearance level for viewing.', true); 
    return; 
  }

  const payload = {
    itemNumber: formatted,
    containmentClass: form.containmentClass.value,
    riskClass: form.riskClass.value,
    disruptionClass: form.disruptionClass.value,
    clearanceLevel,
    photoUrl: (form.photoUrl.value || '').trim(),
    proceduresMd: form.procedures.value || '',
    descriptionMd: form.description.value || '',
    updatedAt: serverTimestamp(),
    createdByUid: snap.exists() ? (snap.data().createdByUid || currentUser.uid) : currentUser.uid,
    createdByEmail: snap.exists() ? (snap.data().createdByEmail || currentUser.email || '') : (currentUser.email || ''),
    createdByDisplay: snap.exists() ? (snap.data().createdByDisplay || displayName()) : displayName(),
    updatedByUid: currentUser.uid,
    updatedByEmail: currentUser.email,
    updatedByDisplay: displayName()
  };

  if(!snap.exists()) payload.createdAt = serverTimestamp();

  try{
    await setDoc(ref, payload, { merge:true });
    
    // If publishing from a draft, delete the draft
    if (currentDraftId) {
      try {
        const draftRef = doc(db, 'anomaly_drafts', currentDraftId);
        await deleteDoc(draftRef);
      } catch (draftErr) {
        console.error('Error deleting draft after publish:', draftErr);
        // Continue even if draft deletion fails
      }
    }
    
    const viewUrl = `/anomalies/view/?id=${encodeURIComponent(docId)}`;
    statusEl.innerHTML = `Published! <a href="${viewUrl}">View entry</a>`;
    
    // Clear draft state
    updateDraftUI(false);
    
    // Update URL
    const url = new URL(window.location);
    url.searchParams.delete('draft');
    window.history.replaceState({}, '', url);
  } catch(err){
    console.error('Error saving anomaly', err);
    setStatus(`Error: ${err.message}`, true);
  }
}

function init(){ 
  if(!form) return; 
  refreshPreview();
  
  [proceduresInput, descriptionInput].forEach(el=> el.addEventListener('input', refreshPreview));
  
  // Button event listeners
  loadBtn?.addEventListener('click', loadExisting);
  saveDraftBtn?.addEventListener('click', saveDraft);
  myDraftsBtn?.addEventListener('click', showDraftsModal);
  deleteDraftBtn?.addEventListener('click', deleteDraft);
  closeDraftsModal?.addEventListener('click', () => draftsModal.classList.remove('active'));
  
  // Close modal when clicking outside
  draftsModal?.addEventListener('click', (e) => {
    if (e.target === draftsModal) {
      draftsModal.classList.remove('active');
    }
  });
  
  form.addEventListener('submit', handleSubmit);

  onAuthStateChanged(auth, (user)=>{ 
    currentUser = user; 
    if(!user){ 
      setStatus('Login is required to save.', true); 
      form.style.opacity = '0.5';
      form.style.pointerEvents = 'none';
    } else {
      const selectedChar = getSelectedCharacter();
      if(!selectedChar || !selectedChar.name) {
        setStatus('You must select a character before submitting anomaly forms. Go to Character Select.', true);
        form.style.opacity = '0.5';
        form.style.pointerEvents = 'none';
      } else {
        setStatus(''); 
        form.style.opacity = '1';
        form.style.pointerEvents = 'auto';
      }
    } 
  });

  // Check URL parameters
  const params = new URLSearchParams(window.location.search);
  const draftParam = params.get('draft');
  const idParam = params.get('id') || params.get('item');
  
  if (draftParam) {
    // Load draft from URL
    loadDraft(draftParam);
  } else if (idParam) {
    // Load existing published anomaly
    form.itemNumber.value = formatItemNumber(idParam); 
    loadExisting();
  }
}

// Export functions for global access (for modal buttons)
window.anomalyForm = {
  loadDraftById: loadDraft,
  deleteDraftById: deleteDraftById
};

let booted = false;
function kickoff(){ 
  if(booted) return; 
  booted = true; 
  init(); 
}

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
