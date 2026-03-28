import { app } from "./auth.js";
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.mjs';

// Get references from the shared app
const db = getFirestore(app);
const auth = getAuth(app);

function getSelectedCharacter(){
  try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; }
}

function parseClearance(v){
  if(v === undefined || v === null) return NaN;
  if(typeof v === 'number') return v;
  const s = String(v);
  const m = s.match(/\d+/);
  return m ? parseInt(m[0],10) : NaN;
}

function userClearance(){
  const ch = getSelectedCharacter();
  return ch ? parseClearance(ch.clearance) : NaN;
}

function userDepartment(){
  const ch = getSelectedCharacter();
  return ch && ch.department ? ch.department : '';
}

function isDeptAllowedForIncident(dept){
  if(!dept) return false;
  const d = dept.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Accept common Security Department aliases, including S&C naming.
  if(d.includes('sd') || d.includes('security')) return true;
  if(d === 'sc' || d === 'sandc') return true;
  if(d.includes('securitycontainment') || d.includes('securityandcontainment')) return true;
  return false;
}

function canCreateIncident(){
  // Only SD members can create incident reports
  const dept = userDepartment();
  return isDeptAllowedForIncident(dept);
}

function updateCreateButtonState(){
  if(!newBtn) return;

  const signedIn = !!auth.currentUser;
  const allowed = signedIn && canCreateIncident();

  // Keep button visible so users can understand permission requirements.
  newBtn.style.display = 'inline-block';
  newBtn.disabled = !allowed;
  newBtn.style.opacity = allowed ? '1' : '0.65';
  newBtn.style.cursor = allowed ? 'pointer' : 'not-allowed';

  if(!signedIn){
    newBtn.title = 'Sign in to create incident reports.';
  } else if(!canCreateIncident()){
    newBtn.title = 'SD membership required to create incident reports.';
  } else {
    newBtn.title = 'Create a new incident report.';
  }
}

function formatDate(ts){
  if(!ts) return '';
  try { return new Date(ts.seconds * 1000).toLocaleDateString(); } catch(e){ return ''; }
}

// State
let incidents = [];

// DOM elements
const searchInput = document.getElementById('incidentSearch');
const newBtn = document.getElementById('newIncidentBtn');
const createModal = document.getElementById('createIncidentModal');
const closeIncidentModal = document.getElementById('closeIncidentModal');
const cancelIncidentBtn = document.getElementById('cancelIncidentBtn');
const createForm = document.getElementById('createIncidentForm');
const tableBody = document.getElementById('incTableBody');
const feedback = document.getElementById('incFeedback');
const previewDiv = document.getElementById('incPreview');
const reportIdInput = document.getElementById('incReportId');
const titleInput = document.getElementById('incTitle');
const tagsInput = document.getElementById('incTags');
const dateInput = document.getElementById('incDate');
const locationInput = document.getElementById('incLocation');
const causeInput = document.getElementById('incCause');
const descriptionInput = document.getElementById('incDescription');
const eventsInput = document.getElementById('incEvents');
const deductionsInput = document.getElementById('incDeductions');
const additionalInput = document.getElementById('incAdditionalInfo');

marked.setOptions({ gfm: true, breaks: true });

function sanitizeHtml(html){
  return DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });
}

function escapeHtml(text){
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

async function renderMarkdown(raw){
  const content = String(raw || '').trim();
  if(!content) return '';

  const parsed = marked.parse(content);
  const html = (typeof parsed === 'string') ? parsed : await parsed;
  return sanitizeHtml(html);
}

function parseTags(value){
  if(!value) return [];
  const unique = new Set();
  value.split(',').forEach((raw) => {
    const cleaned = raw.trim();
    if(cleaned) unique.add(cleaned);
  });
  return Array.from(unique);
}

function buildComposedMarkdown(fields){
  const lines = [];
  lines.push('## Incident Summary');
  lines.push(`- **Date of Incident:** ${fields.incidentDate || 'Unknown'}`);
  lines.push(`- **Location:** ${fields.location || 'Unknown'}`);
  lines.push(`- **Suspected Cause:** ${fields.cause || 'Unknown'}`);

  lines.push('');
  lines.push('## Report Description');
  lines.push(fields.description || '_No description provided._');

  lines.push('');
  lines.push('## Events Transpired');
  lines.push(fields.events || '_No event timeline provided._');

  lines.push('');
  lines.push('## Deductions and Findings');
  lines.push(fields.deductions || '_No deductions provided._');

  if(fields.additionalInfo){
    lines.push('');
    lines.push('## Additional Information');
    lines.push(fields.additionalInfo);
  }

  return lines.join('\n');
}

function collectFormFields(){
  return {
    incidentDate: dateInput ? dateInput.value.trim() : '',
    location: locationInput ? locationInput.value.trim() : '',
    cause: causeInput ? causeInput.value.trim() : '',
    description: descriptionInput ? descriptionInput.value.trim() : '',
    events: eventsInput ? eventsInput.value.trim() : '',
    deductions: deductionsInput ? deductionsInput.value.trim() : '',
    additionalInfo: additionalInput ? additionalInput.value.trim() : ''
  };
}

function setStatus(msg, isError = false){
  feedback.textContent = msg;
  feedback.style.color = isError ? 'var(--accent-red)' : 'var(--accent-mint)';
  feedback.style.marginTop = '0.5rem';
}

function resetForm(){
  createForm.reset();
  previewDiv.innerHTML = '<em>Preview will appear here...</em>';
  setStatus('');
}

let previewRenderId = 0;

async function updatePreview(){
  const fields = collectFormFields();
  const content = buildComposedMarkdown(fields);
  const renderId = ++previewRenderId;

  if(!content.trim()){
    previewDiv.innerHTML = '<em>Preview will appear here...</em>';
    return;
  }

  try {
    const html = await renderMarkdown(content);
    if(renderId !== previewRenderId) return;
    previewDiv.innerHTML = html || '<em>Preview will appear here...</em>';
  } catch (err) {
    console.error('Incident preview render failed:', err);
    if(renderId !== previewRenderId) return;
    previewDiv.innerHTML = `<pre style="white-space:pre-wrap">${escapeHtml(content)}</pre>`;
  }
}

// Main initialization
function initIncidentReportsPage(){
  // Show 'New' button for authorized users
  if(newBtn){
    updateCreateButtonState();
    
    newBtn.addEventListener('click', ()=>{ 
      if(canCreateIncident()){ 
        resetForm();
        createModal.style.display = 'flex'; 
        createModal.setAttribute('aria-hidden','false'); 
        document.getElementById('incReportId').focus(); 
      } else if(!auth.currentUser){
        alert('You must be signed in to create incident reports.');
      } else {
        alert('You do not have permission to create incident reports. SD membership required.');
      }
    });
  }

  onAuthStateChanged(auth, () => {
    updateCreateButtonState();
  });

  window.addEventListener('focus', updateCreateButtonState);
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden) updateCreateButtonState();
  });

  if(closeIncidentModal) closeIncidentModal.addEventListener('click', ()=>{ 
    createModal.style.display='none'; 
    createModal.setAttribute('aria-hidden','true'); 
    feedback.textContent=''; 
  });

  if(cancelIncidentBtn) cancelIncidentBtn.addEventListener('click', ()=>{ 
    createModal.style.display='none'; 
    createModal.setAttribute('aria-hidden','true'); 
    feedback.textContent=''; 
  });

  // Live markdown preview for all police report fields
  [dateInput, locationInput, causeInput, descriptionInput, eventsInput, deductionsInput, additionalInput, titleInput]
    .filter(Boolean)
    .forEach(el => el.addEventListener('input', updatePreview));

  // Render table
  function render(list){
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    if(isNaN(userClearance()) || userClearance() < 1){ 
      tableBody.innerHTML = '<tr><td colspan="2" class="empty">You need clearance ≥ 1 to view incident reports.</td></tr>'; 
      return; 
    }
    const filtered = (!q) ? list : list.filter(d => 
      (d.title||'').toLowerCase().includes(q) || 
      (d.reportId||'').toLowerCase().includes(q) ||
      (d.tags||[]).join(' ').toLowerCase().includes(q) ||
      (d.location||'').toLowerCase().includes(q) ||
      (d.cause||'').toLowerCase().includes(q)
    );
    if(filtered.length === 0){ 
      tableBody.innerHTML = '<tr><td colspan="2" class="empty">No entries match.</td></tr>'; 
      return; 
    }
    tableBody.innerHTML = '';
    filtered.forEach(d => {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      const link = document.createElement('a'); 
      link.className = 'click-row'; 
      link.href = `/incident-reports/view/?id=${encodeURIComponent(d.id)}`;
      link.textContent = (d.reportId ? d.reportId + ': ' : '') + (d.title || '(untitled)');
      titleCell.appendChild(link);

      const tagsCell = document.createElement('td');
      tagsCell.innerHTML = (d.tags && d.tags.length) ? d.tags.map(t => `<span class="pill" style="margin-right:.4rem">${t}</span>`).join('') : '<span style="color:var(--text-light);opacity:.7">—</span>';

      row.appendChild(titleCell); 
      row.appendChild(tagsCell);
      tableBody.appendChild(row);
    });
  }

  if(searchInput) searchInput.addEventListener('input', ()=> render(incidents));

  // Create/submit form
  if(createForm){
    createForm.addEventListener('submit', async (e)=>{
      e.preventDefault(); 
      feedback.textContent = '';
      
      if(!auth.currentUser){ 
        setStatus('You must be signed in to create incident reports.', true); 
        return; 
      }
      if(!canCreateIncident()){ 
        setStatus('You do not have permission to create incident reports. SD membership required.', true); 
        return; 
      }
      
      const reportId = reportIdInput ? reportIdInput.value.trim() : '';
      const titleRaw = titleInput ? titleInput.value.trim() : '';
      const tags = parseTags(tagsInput ? tagsInput.value : '');
      const fields = collectFormFields();
      const content = buildComposedMarkdown(fields).trim();
      const title = titleRaw || `${fields.cause || 'Incident'} at ${fields.location || 'Unknown Location'}`;
      
      // Validate report ID format
      const pattern = /^IR-\d{2}\.\d{2}\.\d{2}-\d{3}$/;
      if (!pattern.test(reportId)) {
        setStatus('Invalid format. Use: IR-MM.DD.YY-###', true);
        return;
      }
      
      if(!reportId || !title || !content) { 
        setStatus('Report ID, title, and report details are required.', true); 
        return; 
      }

      if(!fields.incidentDate || !fields.location || !fields.cause || !fields.description || !fields.events || !fields.deductions){
        setStatus('Complete required police report fields: date, location, cause, description, events, and deductions.', true);
        return; 
      }
      
      try{
        const ch = getSelectedCharacter();
        const author = ch ? ch.name : null;
        const authorPid = ch ? (ch.pid || '') : '';
        
        await addDoc(collection(db,'incidentReports'), { 
          reportId, 
          title, 
          tags, 
          contentMd: content,
          incidentDate: fields.incidentDate,
          location: fields.location,
          cause: fields.cause,
          reportDescriptionMd: fields.description,
          eventsMd: fields.events,
          deductionsMd: fields.deductions,
          additionalInfoMd: fields.additionalInfo,
          author, 
          authorPid,
          department: ch ? ch.department || '' : '', 
          createdAt: serverTimestamp(), 
          createdByUid: auth.currentUser.uid 
        });
        
        setStatus('Report created.');
        resetForm();
        setTimeout(() => {
          createModal.style.display='none'; 
          createModal.setAttribute('aria-hidden','true');
        }, 1500);
      } catch(err){ 
        setStatus('Error: ' + err.message, true); 
      }
    });
  }

  // Live subscribe to incidents
  const q = query(collection(db,'incidentReports'), orderBy('createdAt','desc'));
  onSnapshot(q, snap => { 
    incidents = []; 
    snap.forEach(s => incidents.push({ id: s.id, ...(s.data()||{}) })); 
    render(incidents); 
  }, (err)=>{ 
    tableBody.innerHTML = '<tr><td colspan="2" class="empty">Error loading incident reports: ' + err.message + '</td></tr>'; 
  });
}

let booted = false;
function kickoff(){
  if(booted) return;
  booted = true;
  initIncidentReportsPage();
}

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);

// Check permissions on character change
window.addEventListener('storage', () => {
  updateCreateButtonState();
});