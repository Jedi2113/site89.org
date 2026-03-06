import { app } from "./auth.js";
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

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
  // Check for SD (Security Department)
  return d.includes('sd') || d.includes('security');
}

function canCreateIncident(){
  // Only SD members can create incident reports
  const dept = userDepartment();
  return isDeptAllowedForIncident(dept);
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
const viewModal = document.getElementById('viewIncidentModal');
const viewModalTitle = document.getElementById('viewIncidentTitle');
const viewModalBody = document.getElementById('viewIncidentBody');
const viewModalMeta = document.getElementById('viewIncidentMeta');
const viewModalClose = document.getElementById('viewIncidentClose');
const feedback = document.getElementById('incFeedback');
const contentInput = document.getElementById('incContent');
const previewDiv = document.getElementById('incPreview');

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

function updatePreview(){
  if(!window.marked) return;
  const content = contentInput.value;
  previewDiv.innerHTML = content ? window.marked.parse(content) : '<em>Preview will appear here...</em>';
}

// Main initialization
document.addEventListener('includesLoaded', ()=>{
  // Show 'New' button for authorized users
  if(newBtn){
    if(canCreateIncident()) newBtn.style.display = 'inline-block';
    else newBtn.style.display = 'none';
    
    newBtn.addEventListener('click', ()=>{ 
      if(canCreateIncident()){ 
        resetForm();
        createModal.style.display = 'flex'; 
        createModal.setAttribute('aria-hidden','false'); 
        document.getElementById('incReportId').focus(); 
      } else alert('You do not have permission to create incident reports. SD membership required.'); 
    });
  }

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

  // Live markdown preview
  if(contentInput){
    contentInput.addEventListener('input', updatePreview);
  }

  // Render table
  function render(list){
    const q = (searchInput && searchInput.value || '').trim().toLowerCase();
    if(isNaN(userClearance()) || userClearance() < 0){ 
      tableBody.innerHTML = '<tr><td colspan="2" class="empty">You need clearance ≥ 0 to view incident reports.</td></tr>'; 
      return; 
    }
    const filtered = (!q) ? list : list.filter(d => 
      (d.title||'').toLowerCase().includes(q) || 
      (d.reportId||'').toLowerCase().includes(q) ||
      (d.tags||[]).join(' ').toLowerCase().includes(q)
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
      link.href = '#'; 
      link.textContent = (d.reportId ? d.reportId + ': ' : '') + (d.title || '(untitled)');
      link.addEventListener('click', (e)=>{ e.preventDefault(); openView(d); });
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
      
      const reportId = document.getElementById('incReportId').value.trim();
      const title = document.getElementById('incTitle').value.trim();
      const tags = document.getElementById('incTags').value.split(',').map(s=>s.trim()).filter(Boolean);
      const content = contentInput.value.trim();
      
      // Validate report ID format
      const pattern = /^IR-\d{2}\.\d{2}\.\d{2}-\d{3}$/;
      if (!pattern.test(reportId)) {
        setStatus('Invalid format. Use: IR-MM.DD.YY-###', true);
        return;
      }
      
      if(!reportId || !title || !content) { 
        setStatus('Report ID, title and content required.', true); 
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
          author, 
          authorPid,
          department: ch ? ch.department || '' : '', 
          createdAt: serverTimestamp(), 
          createdByUid: auth.currentUser.uid 
        });
        
        setStatus('Report created.');
        createForm.reset(); 
        updatePreview();
        setTimeout(() => {
          createModal.style.display='none'; 
          createModal.setAttribute('aria-hidden','true');
        }, 1500);
      } catch(err){ 
        setStatus('Error: ' + err.message, true); 
      }
    });
  }

  // View modal
  function openView(d){
    viewModalTitle.textContent = (d.reportId ? d.reportId + ': ' : '') + (d.title || '(untitled)');
    viewModalMeta.textContent = `${d.author || 'Unknown'} • ${d.department || ''} • ${formatDate(d.createdAt)}`;
    if(d.contentMd && window.marked){
      viewModalBody.innerHTML = window.marked.parse(d.contentMd);
    } else if(d.content && window.marked){
      // Support for old content field
      viewModalBody.innerHTML = window.marked.parse(d.content);
    } else {
      viewModalBody.innerHTML = '<em>No content available.</em>';
    }
    viewModal.setAttribute('aria-hidden','false');
  }

  function closeView(){ 
    viewModal.setAttribute('aria-hidden','true'); 
  }

  if(viewModalClose) viewModalClose.addEventListener('click', closeView);
  if(viewModal) viewModal.addEventListener('click', (ev)=>{ if(ev.target === viewModal) closeView(); });

  // Live subscribe to incidents
  const q = query(collection(db,'incidentReports'), orderBy('createdAt','desc'));
  onSnapshot(q, snap => { 
    incidents = []; 
    snap.forEach(s => incidents.push({ id: s.id, ...(s.data()||{}) })); 
    render(incidents); 
  }, (err)=>{ 
    tableBody.innerHTML = '<tr><td colspan="2" class="empty">Error loading incident reports: ' + err.message + '</td></tr>'; 
  });
});

// Check permissions on character change
window.addEventListener('storage', () => {
  const newBtn = document.getElementById('newIncidentBtn');
  if(newBtn) {
    if(canCreateIncident()) newBtn.style.display = 'inline-block';
    else newBtn.style.display = 'none';
  }
});