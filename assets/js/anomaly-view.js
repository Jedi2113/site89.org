import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
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

function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ if(!dept) return false; const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); }
function displayName(){ const ch = getSelectedCharacter(); if(ch && ch.name) return ch.name; return 'Unknown'; }

function formatItemNumber(raw){ const s = (raw || '').toUpperCase().replace(/\s+/g,''); const digits = s.match(/\d+/); if(!digits) return s || 'SCP-000'; const padded = digits[0].padStart(3,'0'); return `SCP-${padded}`; }
function docIdFromItemNumber(itemNumber){ const m = (itemNumber || '').match(/\d+/); if(m) return m[0]; return (itemNumber || 'scp-000').replace(/[^A-Za-z0-9]/g,'-'); }
function renderMarkdown(md){ return marked.parse(md || ''); }
function normalizeTagValue(value){ return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function buildArticleSignals(itemNumber){ const digits = String(itemNumber || '').match(/\d+/); if(!digits) return new Set(); const id = String(parseInt(digits[0], 10)); return new Set([id, `scp${id}`, normalizeTagValue(itemNumber)]); }

function renderMeta(data){
  const itemNum = (data.itemNumber || 'SCP-000').replace(/[^\d]/g, '').padStart(3, '0');
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

async function loadAnomaly(){ const params = new URLSearchParams(window.location.search); const rawId = params.get('id') || ''; if(!rawId){ titleEl.textContent = 'Missing anomaly id'; proceduresRender.textContent = 'Provide an id query parameter, e.g., ?id=131'; return; }
  try{
    const itemNumber = formatItemNumber(rawId);
    const docId = docIdFromItemNumber(itemNumber);
    const ref = doc(db,'anomalies',docId);
    const snap = await getDoc(ref);
    if(!snap.exists()){ titleEl.textContent = `${itemNumber} not found`; proceduresRender.textContent = 'No entry found. Use the create page to add one.'; descriptionRender.textContent = ''; classesGridEl.innerHTML=''; renderPhoto(''); return; }
    const data = snap.data();

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
    renderMeta(data);
    renderPhoto(data.photoUrl);
    renderCredits(data);
    loadLinkedResearchLogs(data.itemNumber);
    loadRelatedArticles(data.itemNumber);
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
function kickoff(){ if(booted) return; booted = true; loadAnomaly(); }

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
