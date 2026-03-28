import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, collection, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: true });

const db = getFirestore(app);
const viewSection = document.getElementById('researchLogView');
const messageSection = document.getElementById('researchLogMessage');
const messageText = document.getElementById('rlvMessageText');
const idEl = document.getElementById('rlvId');
const titleEl = document.getElementById('rlvTitle');
const metaEl = document.getElementById('rlvMeta');
const tagsEl = document.getElementById('rlvTags');
const linkedEl = document.getElementById('rlvLinked');
const contentEl = document.getElementById('rlvContent');

function getSelectedCharacter(){ try { return JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ return null; } }
function parseClearance(v){ if(v === undefined || v === null) return NaN; if(typeof v === 'number') return v; const s = String(v); const m = s.match(/\d+/); return m ? parseInt(m[0],10) : NaN; }
function userClearance(){ const ch = getSelectedCharacter(); return ch ? parseClearance(ch.clearance) : NaN; }
function userDepartment(){ const ch = getSelectedCharacter(); return ch && ch.department ? ch.department : ''; }
function isDeptAllowed(dept){ if(!dept) return false; const d = dept.toLowerCase().replace(/[^a-z0-9]/g, ''); return d.includes('research') || d.includes('rd') || d.includes('scien') || d.includes('scd') || d.includes('scientificdepartment'); }
function formatDate(ts){ try{ if(!ts) return 'Unknown'; const d = ts.toDate ? ts.toDate() : new Date(ts); return d.toLocaleString(); } catch(e){ return 'Unknown'; } }
function normalizeResearchId(value){ return String(value || '').trim().toUpperCase(); }
function sanitize(html){ return DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } }); }
function renderMd(md){ return sanitize(marked.parse(md || '')); }
function showMessage(text){ if(viewSection) viewSection.style.display = 'none'; if(messageSection) messageSection.style.display = 'block'; if(messageText) messageText.textContent = text; }
function showFile(){ if(viewSection) viewSection.style.display = 'block'; if(messageSection) messageSection.style.display = 'none'; }
function getVersionForUser(log){ if(!log.versions || !log.versions.length){ return { clearance: log.clearanceLevel || 0, content: log.contentMd || '' }; } const userC = userClearance(); const accessible = log.versions.filter(v => !isNaN(userC) && userC >= (v.clearance || 0)); const selected = accessible.length ? accessible.reduce((best, current) => (current.clearance > best.clearance ? current : best)) : log.versions.reduce((lowest, current) => ((current.clearance || 0) < (lowest.clearance || 0) ? current : lowest)); return { clearance: selected.clearance || 0, content: selected.contentMd || selected.content || '' }; }
function linkedHref(item){ const upper = String(item || '').toUpperCase(); if(upper.startsWith('AN-')) return `/anomalies/view/?id=${encodeURIComponent(upper)}`; if(upper.startsWith('POI-')) return `/archives/poi/view/?id=${encodeURIComponent(upper)}`; if(upper.startsWith('GOI-')) return `/archives/goi/view/?id=${encodeURIComponent(upper)}`; if(upper.startsWith('RL-')) return `/research-logs/view/?id=${encodeURIComponent(upper)}`; return null; }
async function findByResearchId(researchId){ const snap = await getDocs(query(collection(db, 'researchLogs'), where('researchId', '==', normalizeResearchId(researchId)))); return snap.empty ? null : snap.docs[0]; }
async function loadResearchLog(){ const params = new URLSearchParams(window.location.search); const rawId = (params.get('id') || '').trim(); if(!rawId){ showMessage('Missing research log id.'); return; } try{ let snap = await getDoc(doc(db, 'researchLogs', rawId)); if(!snap.exists()){ const byVisibleId = await findByResearchId(rawId); if(byVisibleId) snap = byVisibleId; } if(!snap.exists()){ showMessage('Research log not found.'); return; } const data = { id: snap.id, ...snap.data() }; const req = parseClearance(data.clearanceLevel); const userC = userClearance(); const deptOk = isDeptAllowed(userDepartment()); if(!deptOk && (Number.isNaN(userC) || Number.isNaN(req) || userC < req)){ showMessage(`Requires clearance level ${req} or ScD/R&D assignment.`); return; } const version = getVersionForUser(data); idEl.textContent = data.researchId || 'Research Log'; titleEl.textContent = data.title || '(untitled)'; document.title = `${data.researchId ? `${data.researchId}: ` : ''}${data.title || 'Research Log'} - Site-89`; metaEl.textContent = `${data.author || 'Unknown'} • ${data.department || ''} • ${formatDate(data.createdAt)} • Clearance ${data.clearanceLevel || '?'}${data.versions && data.versions.length > 1 ? ` • Viewing Level ${version.clearance} version` : ''}`; const tags = Array.isArray(data.tags) ? data.tags : []; tagsEl.innerHTML = tags.length ? tags.map(tag => `<span class="rlv-pill">#${tag}</span>`).join('') : '<span class="rlv-empty">No tags</span>'; const linked = Array.isArray(data.linkedItems) ? data.linkedItems : []; linkedEl.innerHTML = linked.length ? linked.map(item => { const href = linkedHref(item); return href ? `<a class="rlv-pill" href="${href}">${item}</a>` : `<span class="rlv-pill">${item}</span>`; }).join('') : '<span class="rlv-empty">No linked items</span>'; contentEl.innerHTML = version.content ? renderMd(version.content) : '<p class="rlv-empty">No content available.</p>'; showFile(); } catch(err){ console.error('Failed to load research log:', err); showMessage(`Failed to load research log: ${err.message || 'Unknown error'}`); } }
let booted = false; function kickoff(){ if(booted) return; booted = true; loadResearchLog(); }
document.addEventListener('includesLoaded', kickoff); document.addEventListener('DOMContentLoaded', kickoff);
