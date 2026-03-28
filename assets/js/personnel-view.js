import { app } from '/assets/js/auth.js';
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';

const db = getFirestore(app);

const fileSection = document.getElementById('personnelFile');
const messageSection = document.getElementById('pfMessage');
const messageText = messageSection ? messageSection.querySelector('.pf-message') : null;

const pfName = document.getElementById('pfName');
const pfSubtitle = document.getElementById('pfSubtitle');
const pfDept = document.getElementById('pfDept');
const pfClearance = document.getElementById('pfClearance');
const pfEmail = document.getElementById('pfEmail');
const pfPid = document.getElementById('pfPid');
const pfPhoto = document.getElementById('pfPhoto');
const pfAwardsSection = document.getElementById('pfAwardsSection');
const pfAwards = document.getElementById('pfAwards');
const pfBioSection = document.getElementById('pfBioSection');
const pfBio = document.getElementById('pfBio');

function setMessage(html) {
  if (!messageText) return;
  messageText.innerHTML = html;
}

function showFile() {
  if (fileSection) fileSection.style.display = 'block';
  if (messageSection) messageSection.style.display = 'none';
}

function showOnlyMessage(html) {
  if (fileSection) fileSection.style.display = 'none';
  if (messageSection) messageSection.style.display = 'block';
  setMessage(html);
}

function maskPID(pid) {
  if (!pid) return '';
  const s = String(pid);
  if (s.length <= 3) return s;
  return '█'.repeat(Math.max(0, s.length - 3)) + s.slice(-3);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function renderMarkdown(md) {
  return marked.parse(md || '', { gfm: true, breaks: true });
}

function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    id: (params.get('id') || '').trim(),
    character: (params.get('character') || '').trim()
  };
}

async function findByDocId(docId) {
  if (!docId) return null;
  const snap = await getDoc(doc(db, 'characters', docId));
  if (!snap.exists()) return null;
  return { docId: snap.id, ...snap.data() };
}

async function findByCharacterId(characterId) {
  if (!characterId) return null;

  const q = query(collection(db, 'characters'), where('id', '==', characterId));
  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const first = snapshot.docs[0];
  return { docId: first.id, ...first.data() };
}

async function loadAwards(awardIds) {
  if (!pfAwards || !pfAwardsSection) return;

  if (!awardIds || !awardIds.length) {
    pfAwardsSection.style.display = 'none';
    pfAwards.innerHTML = '';
    return;
  }

  try {
    const awardsRes = await fetch('/assets/data/awards.json');
    const allAwards = await awardsRes.json();
    const awardMap = {};
    allAwards.forEach(a => {
      awardMap[a.id] = a;
    });

    const rendered = awardIds
      .map(id => awardMap[id])
      .filter(Boolean)
      .map(award => {
        const safeName = escapeHtml(award.name || 'Award');
        const safeImage = escapeHtml(award.image || '');
        return `
          <div class="award-ribbon">
            <img src="${safeImage}" alt="${safeName}" onerror="this.src='https://via.placeholder.com/54x86?text=Award'">
            <div class="award-tooltip">${safeName}</div>
          </div>
        `;
      })
      .join('');

    if (!rendered) {
      pfAwardsSection.style.display = 'none';
      pfAwards.innerHTML = '';
      return;
    }

    pfAwards.innerHTML = rendered;
    pfAwardsSection.style.display = 'block';
  } catch (err) {
    console.warn('Failed to load awards:', err);
    pfAwardsSection.style.display = 'none';
    pfAwards.innerHTML = '';
  }
}

function renderPersonnel(person) {
  const name = person.name || 'Unknown Personnel';
  const rank = person.rank || 'Unassigned';
  const dept = person.department || 'Unassigned';
  const clearance = person.clearance || '-';
  const email = person.email || '';
  const pid = person.pid || '';
  const bio = (person.bio || '').trim();
  const photo = person.profileImage || '/assets/img/dataunavailable.png';

  document.title = `${name} - Personnel File - Site-89`;
  pfName.textContent = name;
  pfSubtitle.textContent = rank;
  pfDept.textContent = dept;
  pfClearance.textContent = clearance;

  if (email) {
    pfEmail.innerHTML = `<a href="/emails/?compose=${encodeURIComponent(email)}" style="color:var(--accent-teal)">${escapeHtml(email)}</a>`;
  } else {
    pfEmail.textContent = '-';
  }

  pfPid.textContent = maskPID(pid) || '-';

  pfPhoto.onerror = () => {
    pfPhoto.onerror = null;
    pfPhoto.src = '/assets/img/dataunavailable.png';
  };
  pfPhoto.src = photo;

  if (bio) {
    pfBio.innerHTML = renderMarkdown(bio);
    pfBioSection.style.display = 'block';
  } else {
    pfBio.innerHTML = '';
    pfBioSection.style.display = 'none';
  }

  loadAwards(person.awards || []);
  showFile();
}

async function loadPersonnelFile() {
  const params = getQueryParams();
  if (!params.id && !params.character) {
    showOnlyMessage('No personnel identifier provided. Use ?id=<docId> or ?character=<characterId>.');
    return;
  }

  try {
    let person = null;

    // Preferred: direct Firestore document id.
    if (params.id) {
      person = await findByDocId(params.id);
    }

    // Compatibility: old links pass a character id field, not the document id.
    if (!person && params.character) {
      person = await findByCharacterId(params.character);
    }

    // If id is present but was actually a character id, try it as legacy id too.
    if (!person && params.id) {
      person = await findByCharacterId(params.id);
    }

    if (!person || (person.status || 'active') === 'archived') {
      showOnlyMessage('Personnel record not found or is no longer publicly listed.');
      return;
    }

    renderPersonnel(person);
  } catch (err) {
    console.error('Error loading personnel file:', err);
    showOnlyMessage(`Error loading personnel file: ${escapeHtml(err.message || 'Unknown error')}`);
  }
}

let booted = false;
function kickoff() {
  if (booted) return;
  booted = true;
  loadPersonnelFile();
}

document.addEventListener('includesLoaded', kickoff);
document.addEventListener('DOMContentLoaded', kickoff);
