import { app, auth } from '/assets/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  updateDoc,
  increment,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
  collection,
  query,
  where,
  getDocs,
  limit
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.mjs';
import { refreshMerit } from '/assets/js/merit.js';

const db = getFirestore(app);
marked.setOptions({ gfm: true, breaks: true });

const ARTICLE_SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'loading', 'referrerpolicy', 'target', 'rel']
};

const articleTitle = document.getElementById('articleTitle');
const articleMeta = document.getElementById('articleMeta');
const articleBody = document.getElementById('articleBody');
const articleTags = document.getElementById('articleTags');
const articleVotes = document.getElementById('articleVotes');
const editArticleBtn = document.getElementById('editArticleBtn');
const similarArticles = document.getElementById('similarArticles');
const loadError = document.getElementById('articleLoadError');

const editorModal = document.getElementById('articleEditModal');
const editorMode = document.getElementById('editModeToggle');
const oocWrap = document.getElementById('editOocWrap');
const oocNickname = document.getElementById('editOocNickname');
const editorTitle = document.getElementById('editArticleTitle');
const editorTags = document.getElementById('editArticleTags');
const editorBody = document.getElementById('editArticleBody');
const editorPreview = document.getElementById('editArticlePreview');
const editorError = document.getElementById('editArticleError');
const editorSaveBtn = document.getElementById('saveArticleChangesBtn');
const editorCancelBtn = document.getElementById('cancelArticleChangesBtn');

const params = new URLSearchParams(window.location.search);
const articleId = params.get('id');

let currentUser = null;
let currentCharacter = null;
let userCharacterIds = new Set();
let articleData = null;

if (!articleId) {
  showError('Article ID is missing.');
}

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentCharacter = null;
  userCharacterIds = new Set();

  if (currentUser) {
    await Promise.all([loadCurrentCharacter(), loadOwnedCharacterIds()]);
  }

  await loadArticle();
});

async function loadCurrentCharacter() {
  const selectedCharRaw = localStorage.getItem('selectedCharacter');
  if (!selectedCharRaw) return;

  try {
    const selected = JSON.parse(selectedCharRaw);
    if (!selected?.id) return;

    const selectedSnap = await getDoc(doc(db, 'characters', selected.id));
    if (selectedSnap.exists()) {
      currentCharacter = { id: selectedSnap.id, ...selectedSnap.data() };
    }
  } catch (err) {
    console.error('Failed to load current character:', err);
  }
}

async function loadOwnedCharacterIds() {
  if (!currentUser) return;

  try {
    const ownedChars = await getDocs(query(collection(db, 'characters'), where('linkedUID', '==', currentUser.uid)));
    ownedChars.forEach((owned) => userCharacterIds.add(owned.id));
  } catch (err) {
    console.error('Failed to load character ownership:', err);
  }
}

async function loadArticle() {
  if (!articleId) return;

  try {
    const articleRef = doc(db, 'articles', articleId);
    const articleSnap = await getDoc(articleRef);

    if (!articleSnap.exists()) {
      showError('This article does not exist.');
      return;
    }

    articleData = { id: articleSnap.id, ...articleSnap.data() };
    renderArticle(articleData);
    await loadSimilarArticles(articleData);
  } catch (err) {
    console.error('Failed to load article:', err);
    showError('Failed to load article content.');
  }
}

function renderArticle(article) {
  articleTitle.textContent = article.title || 'Untitled article';
  document.title = `${article.title || 'Article'} - Site-89`;

  const createdDate = formatDate(article.createdAt);
  const updatedDate = formatDate(article.updatedAt);
  const modeText = article.mode === 'ooc' ? 'Out of Character' : 'In Character';
  articleMeta.textContent = `${formatAuthor(article)} • ${modeText} • Published ${createdDate} • Updated ${updatedDate}`;

  articleBody.innerHTML = renderArticleBody(article.bodyMd || '');
  renderTags(article.tags || []);
  renderVotes(article);

  if (canEditArticle(article)) {
    editArticleBtn.style.display = 'inline-flex';
  } else {
    editArticleBtn.style.display = 'none';
  }
}

function renderTags(tags) {
  if (!Array.isArray(tags) || !tags.length) {
    articleTags.innerHTML = '<span class="tag-empty">No tags</span>';
    return;
  }

  articleTags.innerHTML = tags.map((tag) => `<span class="tag-chip">#${escapeHtml(tag)}</span>`).join('');
}

function normalizeTagValue(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildTagSignals(values) {
  const exact = new Set();
  const normalized = new Set();
  const anomalyIds = new Set();

  (Array.isArray(values) ? values : []).forEach((value) => {
    const raw = String(value || '').trim();
    if (!raw) return;

    exact.add(raw.toLowerCase());

    const normalizedTag = normalizeTagValue(raw);
    if (normalizedTag) normalized.add(normalizedTag);

    const digits = raw.match(/\d+/g);
    if (digits) {
      digits.forEach((chunk) => {
        const trimmed = String(parseInt(chunk, 10));
        if (trimmed && trimmed !== 'NaN') anomalyIds.add(trimmed);
      });
    }
  });

  return { exact, normalized, anomalyIds };
}

function countSharedTags(candidateTags, sourceSignals) {
  let count = 0;
  const matched = new Set();

  (Array.isArray(candidateTags) ? candidateTags : []).forEach((tag) => {
    const exact = String(tag || '').trim().toLowerCase();
    const normalized = normalizeTagValue(tag);
    const hit = (exact && sourceSignals.exact.has(exact)) || (normalized && sourceSignals.normalized.has(normalized));
    if (hit) {
      matched.add(exact || normalized);
    }
  });

  count = matched.size;
  return count;
}

function anomalyIdFromValue(value) {
  const match = String(value || '').match(/\d+/);
  if (!match) return null;
  return String(parseInt(match[0], 10));
}

function exactOrNormalizedMatch(value, sourceSignals) {
  const exact = String(value || '').trim().toLowerCase();
  const normalized = normalizeTagValue(value);
  return (exact && sourceSignals.exact.has(exact)) || (normalized && sourceSignals.normalized.has(normalized));
}

function buildRelatedCard(item) {
  return `
    <a class="similar-item" href="${item.href}">
      <span class="similar-title">${escapeHtml(item.title || 'Untitled')}</span>
      <span class="similar-meta">${escapeHtml(item.meta || '')}</span>
    </a>
  `;
}

function renderVotes(article) {
  const hasUpvoted = article.upvoters?.includes(currentUser?.uid);
  const hasDownvoted = article.downvoters?.includes(currentUser?.uid);

  articleVotes.innerHTML = `
    <button class="vote-btn ${hasUpvoted ? 'upvoted' : ''}" data-vote="up" aria-label="Upvote article">
      <i class="fas fa-arrow-up"></i>
    </button>
    <span class="vote-score">${score(article)}</span>
    <button class="vote-btn ${hasDownvoted ? 'downvoted' : ''}" data-vote="down" aria-label="Downvote article">
      <i class="fas fa-arrow-down"></i>
    </button>
  `;

  const upBtn = articleVotes.querySelector('[data-vote="up"]');
  const downBtn = articleVotes.querySelector('[data-vote="down"]');

  if (upBtn) {
    upBtn.addEventListener('click', () => handleVote('up'));
  }

  if (downBtn) {
    downBtn.addEventListener('click', () => handleVote('down'));
  }
}

async function handleVote(voteType) {
  if (!currentUser) {
    if (confirm('You need to login to rate this article. Go to login page?')) {
      window.location.href = '/login/';
    }
    return;
  }

  if (!articleData) return;

  const articleRef = doc(db, 'articles', articleData.id);
  const freshSnap = await getDoc(articleRef);
  if (!freshSnap.exists()) return;

  const fresh = freshSnap.data();
  const hasUpvoted = fresh.upvoters?.includes(currentUser.uid);
  const hasDownvoted = fresh.downvoters?.includes(currentUser.uid);
  const updates = {};

  if (voteType === 'up') {
    if (hasUpvoted) {
      updates.upvotes = increment(-1);
      updates.upvoters = arrayRemove(currentUser.uid);
    } else {
      updates.upvotes = increment(1);
      updates.upvoters = arrayUnion(currentUser.uid);
      if (hasDownvoted) {
        updates.downvotes = increment(-1);
        updates.downvoters = arrayRemove(currentUser.uid);
      }
    }
  } else {
    if (hasDownvoted) {
      updates.downvotes = increment(-1);
      updates.downvoters = arrayRemove(currentUser.uid);
    } else {
      updates.downvotes = increment(1);
      updates.downvoters = arrayUnion(currentUser.uid);
      if (hasUpvoted) {
        updates.upvotes = increment(-1);
        updates.upvoters = arrayRemove(currentUser.uid);
      }
    }
  }

  await updateDoc(articleRef, updates);
  if (fresh.authorUid === currentUser.uid) {
    await refreshMerit(currentUser.uid);
  }
  await loadArticle();
}

async function loadSimilarArticles(currentArticle) {
  if (!similarArticles) return;

  const tags = Array.isArray(currentArticle.tags) ? currentArticle.tags : [];
  if (!tags.length) {
    similarArticles.innerHTML = '<p class="similar-empty">Add tags to surface related reads.</p>';
    return;
  }

  try {
    const sourceSignals = buildTagSignals(tags);

    const [articleSnap, researchSnap, incidentSnap, poiSnap, goiSnap, anomalyDocs] = await Promise.all([
      getDocs(query(collection(db, 'articles'), limit(50))),
      getDocs(query(collection(db, 'researchLogs'), limit(50))),
      getDocs(query(collection(db, 'incidentReports'), limit(50))),
      getDocs(query(collection(db, 'persons-of-interest'), limit(50))),
      getDocs(query(collection(db, 'groups-of-interest'), limit(50))),
      Promise.all(Array.from(sourceSignals.anomalyIds).slice(0, 10).map(async (id) => {
        const snap = await getDoc(doc(db, 'anomalies', id));
        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
      }))
    ]);

    const related = [];

    articleSnap.forEach((relatedDoc) => {
      if (relatedDoc.id === currentArticle.id) return;
      const data = { id: relatedDoc.id, ...relatedDoc.data() };
      const shared = countSharedTags(data.tags, sourceSignals);
      if (!shared) return;

      related.push({
        id: data.id,
        type: 'article',
        sortScore: 300 + shared * 10 + score(data),
        title: data.title || 'Untitled article',
        href: `/articles/view/?id=${data.id}`,
        meta: `Article • ${shared} shared tag${shared === 1 ? '' : 's'} • ${score(data)} pts`
      });
    });

    researchSnap.forEach((logDoc) => {
      const data = { id: logDoc.id, ...logDoc.data() };
      const shared = countSharedTags(data.tags, sourceSignals);
      const idMatched = exactOrNormalizedMatch(data.researchId, sourceSignals);
      if (!shared && !idMatched) return;

      related.push({
        id: data.id,
        type: 'research-log',
        sortScore: 220 + shared * 10 + (idMatched ? 15 : 0),
        title: `${data.researchId ? `${data.researchId}: ` : ''}${data.title || 'Untitled research log'}`,
        href: `/research-logs/view/?id=${encodeURIComponent(data.id)}`,
        meta: `Research Log • ${idMatched ? 'ID match' : `${shared} shared tag${shared === 1 ? '' : 's'}`} • ${data.author || 'Unknown'}`
      });
    });

    incidentSnap.forEach((incidentDoc) => {
      const data = { id: incidentDoc.id, ...incidentDoc.data() };
      const shared = countSharedTags(data.tags, sourceSignals);
      if (!shared) return;

      related.push({
        id: data.id,
        type: 'incident',
        sortScore: 210 + shared * 10,
        title: `${data.reportId ? `${data.reportId}: ` : ''}${data.title || 'Untitled incident report'}`,
        href: `/incident-reports/view/?id=${data.id}`,
        meta: `Incident Report • ${shared} shared tag${shared === 1 ? '' : 's'} • ${data.author || 'Unknown'}`
      });
    });

    poiSnap.forEach((poiDoc) => {
      const data = { id: poiDoc.id, ...poiDoc.data() };
      if (!exactOrNormalizedMatch(data.designation, sourceSignals)) return;

      related.push({
        id: data.id,
        type: 'poi',
        sortScore: 230,
        title: `${data.designation ? `${data.designation}: ` : ''}${data.name || 'Unknown POI'}`,
        href: `/archives/poi/view/?id=${encodeURIComponent(data.id)}`,
        meta: `POI File • ${data.priority || 'Unknown'} Priority • ${data.status || 'Unknown'}`
      });
    });

    goiSnap.forEach((goiDoc) => {
      const data = { id: goiDoc.id, ...goiDoc.data() };
      if (!exactOrNormalizedMatch(data.designation, sourceSignals)) return;

      related.push({
        id: data.id,
        type: 'goi',
        sortScore: 230,
        title: `${data.designation ? `${data.designation}: ` : ''}${data.name || 'Unknown GOI'}`,
        href: `/archives/goi/view/?id=${encodeURIComponent(data.id)}`,
        meta: `GOI File • ${data.threatLevel || 'Unknown'} Threat • ${data.stance || 'Unknown'}`
      });
    });

    anomalyDocs.filter(Boolean).forEach((data) => {
      const anomalyValue = anomalyIdFromValue(data.itemNumber || data.id);
      if (!anomalyValue || !sourceSignals.anomalyIds.has(anomalyValue)) return;

      related.push({
        id: data.id,
        type: 'anomaly',
        sortScore: 260,
        title: data.itemNumber || `SCP-${String(data.id).padStart(3, '0')}`,
        href: `/anomalies/view/?id=${encodeURIComponent(data.id)}`,
        meta: `Anomaly File • ${data.containmentClass || '?'} / ${data.riskClass || '?'} / ${data.disruptionClass || '?'}`
      });
    });

    if (!related.length) {
      similarArticles.innerHTML = '<p class="similar-empty">No related files found yet.</p>';
      return;
    }

    const unique = [];
    const seen = new Set();
    related
      .sort((a, b) => b.sortScore - a.sortScore)
      .forEach((item) => {
        const key = `${item.type}:${item.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        unique.push(item);
      });

    similarArticles.innerHTML = unique.slice(0, 6).map(buildRelatedCard).join('');
  } catch (err) {
    console.error('Failed to load similar articles:', err);
    similarArticles.innerHTML = '<p class="similar-empty">Unable to load related files.</p>';
  }
}

function canEditArticle(article) {
  if (!currentUser) return false;

  if (article.mode === 'ooc') {
    return article.authorUid === currentUser.uid;
  }

  if (article.mode === 'ic') {
    return !!article.authorCharacterId && userCharacterIds.has(article.authorCharacterId);
  }

  return false;
}

function openEditor() {
  if (!articleData) return;
  if (!canEditArticle(articleData)) return;

  editorError.textContent = '';
  editorMode.checked = articleData.mode === 'ooc';
  editorTitle.value = articleData.title || '';
  editorTags.value = Array.isArray(articleData.tags) ? articleData.tags.join(', ') : '';
  editorBody.value = articleData.bodyMd || '';
  oocNickname.value = articleData.mode === 'ooc' ? (articleData.authorDisplay || '') : '';

  syncEditorMode();
  renderEditorPreview();
  editorModal.classList.add('active');
}

function closeEditor() {
  editorModal.classList.remove('active');
}

function syncEditorMode() {
  const isOoc = editorMode.checked;
  oocWrap.style.display = isOoc ? 'block' : 'none';
}

function parseTags(input) {
  if (!input) return [];
  const unique = new Set();
  input.split(',').forEach((rawTag) => {
    const normalized = rawTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (normalized) unique.add(normalized);
  });
  return Array.from(unique);
}

function renderEditorPreview() {
  editorPreview.innerHTML = renderArticleBody(editorBody.value || '');
}

function looksLikeHtml(content) {
  return /<\/?[a-z][\s\S]*>/i.test(content || '');
}

function renderArticleBody(content) {
  const source = String(content || '');
  const parsed = looksLikeHtml(source) ? source : marked.parse(source);
  return DOMPurify.sanitize(parsed, ARTICLE_SANITIZE_OPTIONS);
}

async function saveChanges() {
  if (!articleData || !canEditArticle(articleData)) return;

  const title = editorTitle.value.trim();
  const bodyMd = editorBody.value.trim();
  const tags = parseTags(editorTags.value.trim());
  const isOoc = editorMode.checked;

  if (!title) {
    editorError.textContent = 'Title is required.';
    return;
  }

  if (!bodyMd) {
    editorError.textContent = 'Body is required.';
    return;
  }

  const updates = {
    title,
    bodyMd,
    tags,
    updatedAt: serverTimestamp()
  };

  if (isOoc) {
    updates.mode = 'ooc';
    updates.authorCharacterId = null;
    updates.authorCharacterName = null;
    updates.authorDisplay = oocNickname.value.trim() || (currentUser?.email ? currentUser.email.split('@')[0] : 'Anonymous');
  } else {
    if (!currentCharacter?.id) {
      editorError.textContent = 'Select a character to save this as in-character.';
      return;
    }

    updates.mode = 'ic';
    updates.authorCharacterId = currentCharacter.id;
    updates.authorCharacterName = currentCharacter.name || 'Unknown Character';
    updates.authorDisplay = currentCharacter.name || 'Unknown Character';
  }

  editorSaveBtn.disabled = true;
  editorSaveBtn.textContent = 'Saving...';

  try {
    await updateDoc(doc(db, 'articles', articleData.id), updates);
    closeEditor();
    await loadArticle();
  } catch (err) {
    editorError.textContent = err.message || 'Could not save changes.';
  } finally {
    editorSaveBtn.disabled = false;
    editorSaveBtn.textContent = 'Save Changes';
  }
}

function score(article) {
  return (article.upvotes || 0) - (article.downvotes || 0);
}

function formatAuthor(article) {
  if (article.mode === 'ic') return `${article.authorDisplay || 'Unknown Character'} (IC)`;
  return `${article.authorDisplay || 'Anonymous'} (OOC)`;
}

function formatDate(ts) {
  if (!ts) return 'Unknown date';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : ts;
  return new Date(date).toLocaleDateString();
}

function showError(message) {
  if (!loadError) return;
  loadError.textContent = message;
  loadError.style.display = 'block';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function insertMarkdown(prefix, suffix = '') {
  const start = editorBody.selectionStart;
  const end = editorBody.selectionEnd;
  const selected = editorBody.value.slice(start, end);
  const replacement = `${prefix}${selected || 'text'}${suffix}`;

  editorBody.setRangeText(replacement, start, end, 'end');
  editorBody.focus();
  renderEditorPreview();
}

if (editArticleBtn) {
  editArticleBtn.addEventListener('click', openEditor);
}

if (editorMode) {
  editorMode.addEventListener('change', syncEditorMode);
}

if (editorBody) {
  editorBody.addEventListener('input', renderEditorPreview);
}

if (editorSaveBtn) {
  editorSaveBtn.addEventListener('click', saveChanges);
}

if (editorCancelBtn) {
  editorCancelBtn.addEventListener('click', closeEditor);
}

document.querySelectorAll('[data-edit-md-tool]').forEach((button) => {
  button.addEventListener('click', () => {
    const tool = button.dataset.editMdTool;
    if (tool === 'bold') insertMarkdown('**', '**');
    if (tool === 'italic') insertMarkdown('*', '*');
    if (tool === 'link') insertMarkdown('[', '](https://example.com)');
    if (tool === 'image') insertMarkdown('![alt text](', ')');
    if (tool === 'quote') insertMarkdown('> ');
    if (tool === 'code') insertMarkdown('`', '`');
    if (tool === 'heading') insertMarkdown('## ');
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeEditor();
});
