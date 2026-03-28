import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.mjs';

marked.setOptions({ gfm: true, breaks: true });

const db = getFirestore(app);

const incidentView = document.getElementById('incidentView');
const incidentMessage = document.getElementById('incidentMessage');
const messageText = document.getElementById('irvMessageText');

const eyebrowEl = document.getElementById('irvEyebrow');
const titleEl = document.getElementById('irvTitle');
const metaEl = document.getElementById('irvMeta');
const dateEl = document.getElementById('irvDate');
const locationEl = document.getElementById('irvLocation');
const causeEl = document.getElementById('irvCause');

const descriptionEl = document.getElementById('irvDescription');
const eventsEl = document.getElementById('irvEvents');
const deductionsEl = document.getElementById('irvDeductions');
const additionalSectionEl = document.getElementById('irvAdditionalSection');
const additionalEl = document.getElementById('irvAdditional');
const fullBodyEl = document.getElementById('irvFullBody');

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

function formatDate(ts){
  try{
    if(!ts) return 'Unknown';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString();
  } catch(e){
    return 'Unknown';
  }
}

function sanitizeHtml(html){
  return DOMPurify.sanitize(html || '', { USE_PROFILES: { html: true } });
}

function showMessage(text){
  if(incidentView) incidentView.style.display = 'none';
  if(incidentMessage) incidentMessage.style.display = 'block';
  if(messageText) messageText.textContent = text;
}

function showReport(){
  if(incidentView) incidentView.style.display = 'block';
  if(incidentMessage) incidentMessage.style.display = 'none';
}

async function renderMarkdown(target, value, fallbackText){
  if(!target) return;
  const src = String(value || '').trim();
  if(!src){
    target.innerHTML = `<p class="irv-empty">${fallbackText}</p>`;
    return;
  }

  const parsed = marked.parse(src);
  const html = (typeof parsed === 'string') ? parsed : await parsed;
  target.innerHTML = sanitizeHtml(html);
}

function getQueryId(){
  const params = new URLSearchParams(window.location.search);
  return (params.get('id') || '').trim();
}

async function loadIncidentReport(){
  const id = getQueryId();
  if(!id){
    showMessage('Missing incident id. Open a report from the incident reports list.');
    return;
  }

  const clearance = userClearance();
  if(Number.isNaN(clearance) || clearance < 1){
    showMessage('You need clearance level 1 or higher to view this report.');
    return;
  }

  try {
    const snap = await getDoc(doc(db, 'incidentReports', id));
    if(!snap.exists()){
      showMessage('Incident report not found.');
      return;
    }

    const data = snap.data() || {};
    const reportId = data.reportId || 'IR-UNKNOWN';
    const title = data.title || 'Untitled Incident Report';

    eyebrowEl.textContent = reportId;
    titleEl.textContent = title;
    document.title = `${reportId}: ${title} - Incident Report - Site-89`;

    metaEl.textContent = `${data.author || 'Unknown'} • ${data.department || 'Unknown Department'} • Filed ${formatDate(data.createdAt)}`;

    dateEl.textContent = data.incidentDate || 'Unknown';
    locationEl.textContent = data.location || 'Unknown';
    causeEl.textContent = data.cause || 'Unknown';

    await renderMarkdown(descriptionEl, data.reportDescriptionMd, 'No report description provided.');
    await renderMarkdown(eventsEl, data.eventsMd, 'No event timeline provided.');
    await renderMarkdown(deductionsEl, data.deductionsMd, 'No deductions provided.');

    if(data.additionalInfoMd && String(data.additionalInfoMd).trim()){
      await renderMarkdown(additionalEl, data.additionalInfoMd, '');
      additionalSectionEl.style.display = 'block';
    } else {
      additionalSectionEl.style.display = 'none';
      additionalEl.innerHTML = '';
    }

    await renderMarkdown(fullBodyEl, data.contentMd || '', 'No compiled report body available.');

    showReport();
  } catch (err) {
    console.error('Failed to load incident report:', err);
    showMessage(`Failed to load incident report: ${err.message || 'Unknown error'}`);
  }
}

let booted = false;
function kickoff(){
  if(booted) return;
  booted = true;
  loadIncidentReport();
}

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
