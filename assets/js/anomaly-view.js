import { app, auth, onAuthStateChanged } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';

const db = getFirestore(app);
const titleEl = document.getElementById('anomalyTitle');
const itemNumEl = document.getElementById('itemNum');
const clearanceTextEl = document.getElementById('clearanceText');
const clearanceLinesContainer = document.getElementById('clearanceLinesContainer');
const classesGridEl = document.getElementById('classesGrid');
const proceduresRender = document.getElementById('proceduresRender');
const descriptionRender = document.getElementById('descriptionRender');
const photoArea = document.getElementById('photoArea');
const creditsRender = document.getElementById('creditsRender');
const linkedLogsSection = document.getElementById('linkedLogsSection');
const linkedLogsContainer = document.getElementById('linkedLogsContainer');
const relatedArticlesSection = document.getElementById('relatedArticlesSection');
const relatedArticlesContainer = document.getElementById('relatedArticlesContainer');
const addendumsSection = document.getElementById('addendumsSection');
const addendumsRender = document.getElementById('addendumsRender');

const editSourceBtn = document.getElementById('editSourceBtn');
const sourceEditorSection = document.getElementById('sourceEditorSection');
const sourceEditorStatus = document.getElementById('sourceEditorStatus');
const sourceItemNumber = document.getElementById('sourceItemNumber');
const sourceNickname = document.getElementById('sourceNickname');
const sourcePhotoUrl = document.getElementById('sourcePhotoUrl');
const sourceContainmentClass = document.getElementById('sourceContainmentClass');
const sourceRiskClass = document.getElementById('sourceRiskClass');
const sourceDisruptionClass = document.getElementById('sourceDisruptionClass');
const sourceClearanceLevel = document.getElementById('sourceClearanceLevel');
const sourceProcedures = document.getElementById('sourceProcedures');
const sourceDescription = document.getElementById('sourceDescription');
const sourceAddendumsList = document.getElementById('sourceAddendumsList');
const addAddendumBtn = document.getElementById('addAddendumBtn');
const saveSourceBtn = document.getElementById('saveSourceBtn');

function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ if(!dept) return false; const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); }
function displayName(){ const ch = getSelectedCharacter(); if(ch && ch.name) return ch.name; return 'Unknown'; }
function canEdit(){ const c = userClearance(); if(!Number.isNaN(c) && c >= 5) return true; return isDeptAllowed(userDepartment()); }

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

function renderMarkdown(md){ return marked.parse(md || ''); }
function normalizeTagValue(value){ return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function buildArticleSignals(itemNumber){ const digits = String(itemNumber || '').match(/\d+/); if(!digits) return new Set(); const id = String(parseInt(digits[0], 10)); return new Set([id, `scp${id}`, normalizeTagValue(itemNumber)]); }

let currentUser = null;
let currentAnomalyDocId = '';
let currentAnomalyData = null;

function renderMeta(data){
  const itemNum = formatItemNumber(data.itemNumber || 'SCP-000');
  itemNumEl.textContent = itemNum;
  const clearanceLevel = data.clearanceLevel || 0;
  clearanceTextEl.textContent = `LEVEL ${clearanceLevel} RESTRICTED`;
  
  // Create clearance lines based on level
  clearanceLinesContainer.innerHTML = '';
  for(let i = 0; i < clearanceLevel; i++){
    const line = document.createElement('div');
    line.className = `an-clearance-line level-${clearanceLevel}`;
    clearanceLinesContainer.appendChild(line);
  }
  
  classesGridEl.innerHTML = '';
  const classes = [
    { label: 'Containment Class', value: data.containmentClass || '?' },
    { label: 'Risk Class', value: data.riskClass || '?' },
    { label: 'Disruption Class', value: data.disruptionClass || '?' }
  ];
  
  classes.forEach(cls => {
    const box = document.createElement('div');
    box.className = 'an-class-box';
    box.innerHTML = `<div class="an-class-label">${cls.label}</div><div class="an-class-value">${cls.value}</div>`;
    classesGridEl.appendChild(box);
  });
}

function renderPhoto(url){ if(url){ const img = document.createElement('img'); img.src = url; img.alt = 'Anomaly photo'; photoArea.innerHTML=''; photoArea.appendChild(img); } else { photoArea.textContent = 'No photo provided.'; } }

function formatDate(ts){ try{ if(!ts) return 'Unknown'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleString(); } catch(e){ return 'Unknown'; } }

function renderCredits(data){ if(!creditsRender) return; const createdBy = data.createdByDisplay || data.createdByEmail || 'Unknown'; const updatedBy = data.updatedByDisplay || data.updatedByEmail || createdBy; const createdAt = formatDate(data.createdAt); const updatedAt = formatDate(data.updatedAt); creditsRender.innerHTML = `Created by <strong>${createdBy}</strong> on ${createdAt}. Last updated by <strong>${updatedBy}</strong> on ${updatedAt}.`; }

function renderAddendums(addendums){
  if(!addendumsSection || !addendumsRender) return;
  const list = Array.isArray(addendums) ? addendums.filter(a => a && (String(a.title || '').trim() || String(a.bodyMd || '').trim())) : [];
  if(!list.length){
    addendumsSection.style.display = 'none';
    addendumsRender.innerHTML = '';
    return;
  }
  addendumsSection.style.display = 'block';
  addendumsRender.innerHTML = list.map((entry, idx) => {
    const safeTitle = String(entry.title || '').trim() || `Addendum ${idx + 1}`;
    return `<section class="an-addendum-card"><h4>${safeTitle}</h4><div>${renderMarkdown(entry.bodyMd || '')}</div></section>`;
  }).join('');
}

function setSourceEditorStatus(msg, isError = false){
  if(!sourceEditorStatus) return;
  sourceEditorStatus.textContent = msg || '';
  sourceEditorStatus.style.color = isError ? 'var(--accent-red)' : 'var(--text-light)';
}

function addAddendumEditorRow(entry = {}){
  if(!sourceAddendumsList) return;
  const row = document.createElement('div');
  row.className = 'an-source-addendum-item';
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'an-source-addendum-title';
  titleInput.placeholder = 'Addendum title';
  titleInput.value = String(entry.title || '');

  const bodyInput = document.createElement('textarea');
  bodyInput.className = 'an-source-addendum-body';
  bodyInput.placeholder = 'Addendum markdown...';
  bodyInput.value = String(entry.bodyMd || '');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-secondary an-source-remove-addendum';
  removeBtn.textContent = 'Remove';
  removeBtn.addEventListener('click', ()=> row.remove());

  row.appendChild(titleInput);
  row.appendChild(bodyInput);
  row.appendChild(removeBtn);
  sourceAddendumsList.appendChild(row);
}

function collectAddendumsFromEditor(){
  if(!sourceAddendumsList) return [];
  return Array.from(sourceAddendumsList.querySelectorAll('.an-source-addendum-item')).map((row) => {
    const title = row.querySelector('.an-source-addendum-title')?.value || '';
    const bodyMd = row.querySelector('.an-source-addendum-body')?.value || '';
    return { title: title.trim(), bodyMd };
  }).filter(entry => entry.title || String(entry.bodyMd || '').trim());
}

function hydrateSourceEditor(data){
  if(!sourceEditorSection) return;
  sourceItemNumber.value = formatItemNumber(data.itemNumber || 'SCP-000');
  sourceNickname.value = data.nickname || '';
  sourcePhotoUrl.value = data.photoUrl || '';
  sourceContainmentClass.value = data.containmentClass || '';
  sourceRiskClass.value = data.riskClass || '';
  sourceDisruptionClass.value = data.disruptionClass || '';
  sourceClearanceLevel.value = String(data.clearanceLevel || '');
  sourceProcedures.value = data.proceduresMd || '';
  sourceDescription.value = data.descriptionMd || '';
  sourceAddendumsList.innerHTML = '';
  const addendums = Array.isArray(data.addendums) ? data.addendums : [];
  addendums.forEach((entry) => addAddendumEditorRow(entry));
  if(!addendums.length) addAddendumEditorRow({});
}

async function findAnomaly(rawId){
  const incoming = String(rawId || '').trim();
  const candidates = [];
  const pushCandidate = (v) => {
    const value = String(v || '').trim();
    if(!value) return;
    if(candidates.includes(value)) return;
    candidates.push(value);
  };
  pushCandidate(incoming);
  pushCandidate(docIdFromItemNumber(incoming));
  const numberMatch = incoming.match(/\d+/);
  if(numberMatch) pushCandidate(String(parseInt(numberMatch[0], 10)));

  for(const id of candidates){
    const snap = await getDoc(doc(db, 'anomalies', id));
    if(snap.exists()) return { snap, docId: id };
  }
  return null;
}

async function loadAnomaly(){ const params = new URLSearchParams(window.location.search); const rawId = params.get('id') || ''; if(!rawId){ titleEl.textContent = 'Missing anomaly id'; proceduresRender.textContent = 'Provide an id query parameter, e.g., ?id=131'; return; }
  try{
    const found = await findAnomaly(rawId);
    const itemNumber = formatItemNumber(rawId);
    if(!found){ titleEl.textContent = `${itemNumber} not found`; proceduresRender.textContent = 'No entry found. Use the create page to add one.'; descriptionRender.textContent = ''; classesGridEl.innerHTML=''; renderPhoto(''); return; }
    const { snap, docId } = found;
    const data = snap.data();
    currentAnomalyDocId = docId;
    currentAnomalyData = data;

    // clearance gate
    const required = parseClearance(data.clearanceLevel || 0);
    const userC = userClearance();
    const deptOk = isDeptAllowed(userDepartment());
    const userHasClearance = !Number.isNaN(userC) && userC >= required;
    const allowed = deptOk || userHasClearance;
    if(!allowed){
      titleEl.textContent = 'Restricted file';
      proceduresRender.textContent = `Requires clearance Level ${required} or ScD/R&D assignment.`;
      descriptionRender.textContent = '';
      classesGridEl.innerHTML = '';
      renderPhoto('');
      creditsRender.innerHTML = '';
      return;
    }

    titleEl.textContent = data.itemNumber || itemNumber;
    proceduresRender.innerHTML = renderMarkdown(data.proceduresMd);
    descriptionRender.innerHTML = renderMarkdown(data.descriptionMd);
    renderAddendums(data.addendums);
    renderMeta(data);
    renderPhoto(data.photoUrl);
    renderCredits(data);
    loadLinkedResearchLogs(data.itemNumber);
    loadRelatedArticles(data.itemNumber);
    hydrateSourceEditor(data);
    if(editSourceBtn){
      editSourceBtn.style.display = canEdit() ? 'inline-flex' : 'none';
    }
  } catch(err){
    titleEl.textContent = 'Error loading anomaly';
    proceduresRender.textContent = err.message;
    descriptionRender.textContent = '';
    classesGridEl.innerHTML='';
    renderPhoto('');
    if(creditsRender) creditsRender.textContent = '';
    if(relatedArticlesSection) relatedArticlesSection.style.display = 'none';
  }
}

async function saveSourceChanges(){
  if(!currentAnomalyDocId || !currentAnomalyData){
    setSourceEditorStatus('Load an anomaly before saving edits.', true);
    return;
  }
  if(!currentUser){
    setSourceEditorStatus('Login is required to save source changes.', true);
    return;
  }
  if(!canEdit()){
    setSourceEditorStatus('Only ScD/R&D or Level 5 may edit anomaly source.', true);
    return;
  }

  const formattedItem = formatItemNumber(sourceItemNumber?.value || currentAnomalyData.itemNumber || '');
  const clearanceLevel = parseClearance(sourceClearanceLevel?.value || currentAnomalyData.clearanceLevel || 0);
  if(Number.isNaN(clearanceLevel)){
    setSourceEditorStatus('Select a valid clearance level.', true);
    return;
  }

  const payload = {
    itemNumber: formattedItem,
    nickname: (sourceNickname?.value || '').trim(),
    photoUrl: (sourcePhotoUrl?.value || '').trim(),
    containmentClass: sourceContainmentClass?.value || '',
    riskClass: sourceRiskClass?.value || '',
    disruptionClass: sourceDisruptionClass?.value || '',
    clearanceLevel,
    proceduresMd: sourceProcedures?.value || '',
    descriptionMd: sourceDescription?.value || '',
    addendums: collectAddendumsFromEditor(),
    updatedAt: serverTimestamp(),
    updatedByUid: currentUser.uid,
    updatedByEmail: currentUser.email || '',
    updatedByDisplay: displayName(),
    createdByUid: currentAnomalyData.createdByUid || currentUser.uid,
    createdByEmail: currentAnomalyData.createdByEmail || (currentUser.email || ''),
    createdByDisplay: currentAnomalyData.createdByDisplay || displayName()
  };
  if(!currentAnomalyData.createdAt) payload.createdAt = serverTimestamp();

  try{
    await setDoc(doc(db, 'anomalies', currentAnomalyDocId), payload, { merge: true });
    setSourceEditorStatus('Source saved. Reloading view...');
    await loadAnomaly();
    if(sourceEditorSection){
      sourceEditorSection.hidden = false;
      sourceEditorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setSourceEditorStatus('Source saved.');
  } catch(err){
    console.error('Failed to save source changes:', err);
    setSourceEditorStatus(`Save failed: ${err.message}`, true);
  }
}

function wireSourceEditor(){
  if(editSourceBtn && sourceEditorSection){
    editSourceBtn.addEventListener('click', () => {
      if(!canEdit()) return;
      sourceEditorSection.hidden = false;
      sourceEditorSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
  if(addAddendumBtn){
    addAddendumBtn.addEventListener('click', () => addAddendumEditorRow({}));
  }
  if(saveSourceBtn){
    saveSourceBtn.addEventListener('click', saveSourceChanges);
  }
  onAuthStateChanged(auth, (user) => {
    currentUser = user;
    if(editSourceBtn){
      editSourceBtn.style.display = user && canEdit() ? 'inline-flex' : 'none';
    }
  });
}

async function loadLinkedResearchLogs(itemNumber){
  if(!linkedLogsSection || !linkedLogsContainer) return;
  
  try{
    // Format item number to match linked format (e.g., AN-049)
    const digits = (itemNumber || '').match(/\d+/);
    if(!digits) return;
    const formatted = `AN-${digits[0].padStart(3, '0')}`;
    
    // Query research logs where linkedItems array contains this anomaly
    const logsRef = collection(db, 'researchLogs');
    const q = query(logsRef, where('linkedItems', 'array-contains', formatted));
    const snapshot = await getDocs(q);
    
    if(snapshot.empty){
      linkedLogsSection.style.display = 'none';
      return;
    }
    
    // Check user clearance for filtering
    const userC = userClearance();
    const deptOk = isDeptAllowed(userDepartment());
    
    const logs = [];
    snapshot.forEach(docSnap => {
      const log = { id: docSnap.id, ...docSnap.data() };
      const req = parseClearance(log.clearanceLevel);
      
      // Apply clearance filter
      if(!deptOk){
        if(Number.isNaN(userC) || Number.isNaN(req) || userC < req) return;
      }
      
      logs.push(log);
    });
    
    if(logs.length === 0){
      linkedLogsSection.style.display = 'none';
      return;
    }
    
    linkedLogsSection.style.display = 'block';
    linkedLogsContainer.innerHTML = logs.map(log => {
      return `<div style="padding:.7rem;background:rgba(78,250,170,0.06);border:1px solid rgba(78,250,170,0.12);border-radius:6px">
        <a href="/research-logs/view/?id=${encodeURIComponent(log.id)}" style="color:var(--accent-mint);font-weight:600;text-decoration:none">${log.title || '(untitled)'}</a>
        <div style="font-size:.85rem;color:var(--text-light);margin-top:.3rem">${log.author || 'Unknown'} • Level ${log.clearanceLevel || '?'}</div>
      </div>`;
    }).join('');
  } catch(err){
    console.error('Error loading linked logs:', err);
    linkedLogsSection.style.display = 'none';
  }
}

async function loadRelatedArticles(itemNumber){
  if(!relatedArticlesSection || !relatedArticlesContainer) return;

  try {
    const signals = buildArticleSignals(itemNumber);
    if(!signals.size){
      relatedArticlesSection.style.display = 'none';
      return;
    }

    const articleSnap = await getDocs(query(collection(db, 'articles')));
    const related = [];

    articleSnap.forEach((articleDoc) => {
      const data = { id: articleDoc.id, ...articleDoc.data() };
      const tags = Array.isArray(data.tags) ? data.tags : [];
      const matched = tags.some((tag) => signals.has(normalizeTagValue(tag)));
      if(!matched) return;
      related.push(data);
    });

    if(!related.length){
      relatedArticlesSection.style.display = 'none';
      relatedArticlesContainer.innerHTML = '';
      return;
    }

    related.sort((a, b) => ((b.upvotes || 0) - (b.downvotes || 0)) - ((a.upvotes || 0) - (a.downvotes || 0)));
    relatedArticlesSection.style.display = 'block';
    relatedArticlesContainer.innerHTML = related.slice(0, 6).map((article) => {
      const articleScore = (article.upvotes || 0) - (article.downvotes || 0);
      const author = article.authorDisplay || 'Unknown';
      return `<div style="padding:.7rem;background:rgba(78,250,170,0.06);border:1px solid rgba(78,250,170,0.12);border-radius:6px">
        <a href="/articles/view/?id=${article.id}" style="color:var(--accent-mint);font-weight:600;text-decoration:none">${article.title || '(untitled)'}</a>
        <div style="font-size:.85rem;color:var(--text-light);margin-top:.3rem">${author} • ${articleScore} pts</div>
      </div>`;
    }).join('');
  } catch(err){
    console.error('Error loading related articles:', err);
    relatedArticlesSection.style.display = 'none';
  }
}

let booted = false;
function kickoff(){ if(booted) return; booted = true; wireSourceEditor(); loadAnomaly(); }

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
