import { app, auth } from '/assets/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import {
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  getDocs,
  updateDoc,
  where,
  increment,
  arrayUnion,
  arrayRemove
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
import DOMPurify from 'https://cdn.jsdelivr.net/npm/dompurify@3.1.2/dist/purify.es.mjs';
import { refreshMerit } from '/assets/js/merit.js';

const db = getFirestore(app);

const articleList = document.getElementById('articleList');
const articleSearch = document.getElementById('articleSearch');
const articleCount = document.getElementById('articleCount');
const featuredWrap = document.getElementById('featuredArticle');
const createBtn = document.getElementById('createArticleBtn');
const authHint = document.getElementById('articleAuthHint');

const editorModal = document.getElementById('articleEditorModal');
const editorTitle = document.getElementById('editorTitle');
const modeToggle = document.getElementById('articleModeToggle');
const oocWrap = document.getElementById('oocNicknameWrap');
const oocNickname = document.getElementById('oocNickname');
const articleTitle = document.getElementById('articleTitle');
const articleTags = document.getElementById('articleTags');
const articleBody = document.getElementById('articleBody');
const articlePreview = document.getElementById('articlePreview');
const editorError = document.getElementById('articleEditorError');
const saveBtn = document.getElementById('saveArticleBtn');
const cancelBtn = document.getElementById('cancelArticleBtn');

let currentUser = null;
let currentCharacter = null;
let userCharacterIds = new Set();
let allArticles = [];
let editingArticleId = null;

marked.setOptions({ gfm: true, breaks: true });

const ARTICLE_SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'loading', 'referrerpolicy', 'target', 'rel']
};

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  currentCharacter = null;
  userCharacterIds = new Set();

  if (currentUser) {
    await Promise.all([loadCurrentCharacter(), loadOwnedCharacterIds()]);
    if (authHint) authHint.style.display = 'none';
    if (createBtn) createBtn.disabled = false;
  } else {
    if (authHint) authHint.style.display = 'block';
    if (createBtn) createBtn.disabled = true;
  }

  startArticleFeed();
});

async function loadCurrentCharacter() {
  const selectedCharRaw = localStorage.getItem('selectedCharacter');
  if (!selectedCharRaw) return;

  try {
    const selectedChar = JSON.parse(selectedCharRaw);
    if (!selectedChar || !selectedChar.id) return;

    const charRef = doc(db, 'characters', selectedChar.id);
    const charSnap = await getDoc(charRef);
    if (!charSnap.exists()) return;

    currentCharacter = {
      id: charSnap.id,
      ...charSnap.data()
    };
  } catch (err) {
    console.error('Unable to load selected character:', err);
  }
}

async function loadOwnedCharacterIds() {
  if (!currentUser) return;

  try {
    const ownedChars = await getDocs(query(collection(db, 'characters'), where('linkedUID', '==', currentUser.uid)));
    ownedChars.forEach((charDoc) => {
      userCharacterIds.add(charDoc.id);
    });
  } catch (err) {
    console.error('Unable to load owned characters:', err);
  }
}

function startArticleFeed() {
  const articleQuery = query(collection(db, 'articles'), orderBy('createdAt', 'desc'));

  onSnapshot(articleQuery, (snapshot) => {
    allArticles = snapshot.docs.map((articleDoc) => ({ id: articleDoc.id, ...articleDoc.data() }));
    renderFeaturedArticle(allArticles);
    applyFilters();
  }, (error) => {
    console.error('Failed to load article feed:', error);
    if (articleList) {
      articleList.innerHTML = '<div class="articles-empty">Failed to load articles right now.</div>';
    }
  });
}

function renderFeaturedArticle(articles) {
  if (!featuredWrap) return;

  if (!articles.length) {
    featuredWrap.innerHTML = '<p class="feature-empty">No featured article yet. Publish one to start the board.</p>';
    return;
  }

  const picks = articles.filter((article) => article.editorPick === true);
  let featured = null;
  let featuredLabel = 'Top rated this month';

  if (picks.length) {
    picks.sort((a, b) => (toMillis(b.updatedAt) - toMillis(a.updatedAt)));
    featured = picks[0];
    featuredLabel = "Editor's pick";
  } else {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const monthArticles = articles.filter((article) => toMillis(article.createdAt) >= startOfMonth.getTime());
    if (monthArticles.length) {
      monthArticles.sort((a, b) => articleScore(b) - articleScore(a));
      featured = monthArticles[0];
    } else {
      const sortedByScore = [...articles].sort((a, b) => articleScore(b) - articleScore(a));
      featured = sortedByScore[0];
      featuredLabel = 'Highest rated overall';
    }
  }

  if (!featured) {
    featuredWrap.innerHTML = '<p class="feature-empty">No featured article yet. Publish one to start the board.</p>';
    return;
  }

  featuredWrap.innerHTML = `
    <div class="feature-pill">${featuredLabel}</div>
    <h2>${escapeHtml(featured.title || 'Untitled article')}</h2>
    <p>${escapeHtml(excerpt(bodyPreviewText(featured.bodyMd || ''), 220))}</p>
    <div class="feature-meta">
      <span>${escapeHtml(formatAuthorLabel(featured))}</span>
      <span>${formatDate(featured.createdAt)}</span>
      <span>${articleScore(featured)} points</span>
    </div>
    <a class="feature-read" href="/articles/view/?id=${featured.id}">Read article</a>
  `;
}

function applyFilters() {
  if (!articleList) return;

  const term = (articleSearch?.value || '').trim().toLowerCase();

  const filtered = allArticles.filter((article) => {
    if (!term) return true;
    const tagText = (Array.isArray(article.tags) ? article.tags.join(' ') : '').toLowerCase();
    const haystack = `${article.title || ''} ${article.bodyMd || ''} ${tagText} ${article.authorDisplay || ''}`.toLowerCase();
    return haystack.includes(term);
  });

  if (!filtered.length) {
    articleList.innerHTML = '<div class="articles-empty">No articles match that search.</div>';
    if (articleCount) articleCount.textContent = '0 articles';
    return;
  }

  articleList.innerHTML = filtered.map((article) => buildArticleCard(article)).join('');
  if (articleCount) articleCount.textContent = `${filtered.length} article${filtered.length === 1 ? '' : 's'}`;

  filtered.forEach((article) => attachArticleListeners(article));
}

function buildArticleCard(article) {
  const isOwn = canEditArticle(article);
  const hasUpvoted = article.upvoters?.includes(currentUser?.uid);
  const hasDownvoted = article.downvoters?.includes(currentUser?.uid);
  const tags = Array.isArray(article.tags) ? article.tags : [];

  return `
    <article class="article-card" data-article-id="${article.id}">
      <div class="article-type ${article.mode === 'ooc' ? 'type-ooc' : 'type-ic'}">${article.mode === 'ooc' ? 'Out of Character' : 'In Character'}</div>
      <h3><a href="/articles/view/?id=${article.id}">${escapeHtml(article.title || 'Untitled article')}</a></h3>
      <p class="article-excerpt">${escapeHtml(excerpt(bodyPreviewText(article.bodyMd || ''), 260))}</p>
      <div class="article-tags">${tags.map((tag) => `<span>#${escapeHtml(tag)}</span>`).join('')}</div>
      <div class="article-meta">
        <span>${escapeHtml(formatAuthorLabel(article))}</span>
        <span>${formatDate(article.createdAt)}</span>
      </div>
      <div class="article-actions-row">
        <div class="inline-votes">
          <button class="vote-btn vote-up ${hasUpvoted ? 'upvoted' : ''}" data-article-id="${article.id}" data-vote="up" title="Upvote">
            <i class="fas fa-arrow-up"></i>
          </button>
          <span class="vote-count">${articleScore(article)}</span>
          <button class="vote-btn vote-down ${hasDownvoted ? 'downvoted' : ''}" data-article-id="${article.id}" data-vote="down" title="Downvote">
            <i class="fas fa-arrow-down"></i>
          </button>
        </div>
        <div class="inline-actions">
          <a class="read-link" href="/articles/view/?id=${article.id}">Open</a>
          ${isOwn ? `<button class="edit-link" data-edit-id="${article.id}">Edit</button>` : ''}
        </div>
      </div>
    </article>
  `;
}

function attachArticleListeners(article) {
  const upBtn = document.querySelector(`.vote-btn.vote-up[data-article-id="${article.id}"]`);
  const downBtn = document.querySelector(`.vote-btn.vote-down[data-article-id="${article.id}"]`);
  const editButton = document.querySelector(`.edit-link[data-edit-id="${article.id}"]`);

  if (upBtn) {
    upBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await handleArticleVote(article.id, 'up');
    });
  }

  if (downBtn) {
    downBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await handleArticleVote(article.id, 'down');
    });
  }

  if (editButton) {
    editButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openEditor(article);
    });
  }
}

async function handleArticleVote(articleId, voteType) {
  if (!currentUser) {
    if (confirm('You need to login to rate articles. Go to login page?')) {
      window.location.href = '/login/';
    }
    return;
  }

  const articleRef = doc(db, 'articles', articleId);
  const articleSnap = await getDoc(articleRef);
  if (!articleSnap.exists()) return;

  const article = articleSnap.data();
  const hasUpvoted = article.upvoters?.includes(currentUser.uid);
  const hasDownvoted = article.downvoters?.includes(currentUser.uid);
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

  if (article.authorUid === currentUser.uid) {
    await refreshMerit(currentUser.uid);
  }
}

function openEditor(article = null) {
  if (!editorModal) return;

  if (!currentUser) {
    if (confirm('You need to login to create an article. Go to login page?')) {
      window.location.href = '/login/';
    }
    return;
  }

  editorError.textContent = '';
  editingArticleId = article?.id || null;

  if (article) {
    editorTitle.textContent = 'Edit Article';
    modeToggle.checked = article.mode === 'ooc';
    articleTitle.value = article.title || '';
    articleTags.value = Array.isArray(article.tags) ? article.tags.join(', ') : '';
    articleBody.value = article.bodyMd || '';
    oocNickname.value = article.mode === 'ooc' ? (article.authorDisplay || '') : '';
  } else {
    editorTitle.textContent = 'Create Article';
    modeToggle.checked = false;
    articleTitle.value = '';
    articleTags.value = '';
    articleBody.value = '';
    oocNickname.value = '';
  }

  syncModeUi();
  renderPreview();
  editorModal.classList.add('active');
}

function closeEditor() {
  if (!editorModal) return;
  editorModal.classList.remove('active');
  editingArticleId = null;
}

function syncModeUi() {
  const isOoc = modeToggle.checked;
  oocWrap.style.display = isOoc ? 'block' : 'none';
}

function parseTags(value) {
  if (!value) return [];
  const unique = new Set();
  value.split(',').forEach((rawTag) => {
    const cleaned = rawTag.trim().toLowerCase().replace(/\s+/g, '-');
    if (cleaned) unique.add(cleaned);
  });
  return Array.from(unique);
}

function renderPreview() {
  const html = renderArticleBody(articleBody.value || '');
  articlePreview.innerHTML = html || '<p class="preview-empty">HTML preview will appear here.</p>';
}

function looksLikeHtml(content) {
  return /<\/?[a-z][\s\S]*>/i.test(content || '');
}

function renderArticleBody(content) {
  const source = String(content || '');
  const parsed = looksLikeHtml(source) ? source : marked.parse(source);
  return DOMPurify.sanitize(parsed, ARTICLE_SANITIZE_OPTIONS);
}

function bodyPreviewText(content) {
  const source = String(content || '');
  if (!source) return '';

  if (looksLikeHtml(source)) {
    const temp = document.createElement('div');
    temp.innerHTML = DOMPurify.sanitize(source, ARTICLE_SANITIZE_OPTIONS);
    return (temp.textContent || temp.innerText || '').replace(/\s+/g, ' ').trim();
  }

  return source.replace(/\s+/g, ' ').trim();
}

function canEditArticle(article) {
  if (!currentUser || !article) return false;

  if (article.mode === 'ooc') {
    return article.authorUid === currentUser.uid;
  }

  if (article.mode === 'ic') {
    return !!article.authorCharacterId && userCharacterIds.has(article.authorCharacterId);
  }

  return false;
}

async function saveArticle() {
  if (!currentUser) return;

  const title = articleTitle.value.trim();
  const tags = parseTags(articleTags.value.trim());
  const bodyMd = articleBody.value.trim();
  const isOoc = modeToggle.checked;

  if (!title) {
    editorError.textContent = 'Please enter a title.';
    return;
  }

  if (!bodyMd) {
    editorError.textContent = 'Please write the article body.';
    return;
  }

  const mode = isOoc ? 'ooc' : 'ic';
  let authorDisplay = '';
  let authorCharacterId = null;
  let authorCharacterName = null;

  if (mode === 'ic') {
    if (!currentCharacter || !currentCharacter.id) {
      editorError.textContent = 'Select a character first for in-character posts.';
      return;
    }
    authorDisplay = currentCharacter.name || 'Unknown Character';
    authorCharacterId = currentCharacter.id;
    authorCharacterName = currentCharacter.name || 'Unknown Character';
  } else {
    authorDisplay = oocNickname.value.trim() || (currentUser.email ? currentUser.email.split('@')[0] : 'Anonymous');
  }

  saveBtn.disabled = true;
  saveBtn.textContent = editingArticleId ? 'Saving...' : 'Publishing...';

  try {
    if (editingArticleId) {
      const articleRef = doc(db, 'articles', editingArticleId);
      const articleSnap = await getDoc(articleRef);

      if (!articleSnap.exists()) {
        throw new Error('Article no longer exists.');
      }

      const existing = articleSnap.data();
      if (!canEditArticle({ ...existing, id: editingArticleId })) {
        throw new Error('You are not allowed to edit this article.');
      }

      await updateDoc(articleRef, {
        title,
        bodyMd,
        tags,
        updatedAt: serverTimestamp(),
        authorDisplay,
        mode,
        authorCharacterId,
        authorCharacterName
      });
    } else {
      await addDoc(collection(db, 'articles'), {
        title,
        bodyMd,
        tags,
        mode,
        authorUid: currentUser.uid,
        authorDisplay,
        authorCharacterId,
        authorCharacterName,
        upvotes: 0,
        downvotes: 0,
        upvoters: [],
        downvoters: [],
        editorPick: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });

      await refreshMerit(currentUser.uid);
    }

    closeEditor();
  } catch (err) {
    editorError.textContent = err.message || 'Failed to save article.';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = editingArticleId ? 'Save Changes' : 'Publish Article';
  }
}

function articleScore(article) {
  return (article.upvotes || 0) - (article.downvotes || 0);
}

function formatAuthorLabel(article) {
  if (article.mode === 'ic') {
    return `${article.authorDisplay || 'Unknown Character'} (IC)`;
  }
  return `${article.authorDisplay || 'Anonymous'} (OOC)`;
}

function excerpt(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

function formatDate(ts) {
  if (!ts) return 'Unknown date';
  const date = typeof ts.toDate === 'function' ? ts.toDate() : ts;
  return new Date(date).toLocaleDateString();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function insertMarkdown(prefix, suffix = '') {
  const start = articleBody.selectionStart;
  const end = articleBody.selectionEnd;
  const selected = articleBody.value.slice(start, end);
  const insertion = `${prefix}${selected || 'text'}${suffix}`;

  articleBody.setRangeText(insertion, start, end, 'end');
  articleBody.focus();
  renderPreview();
}

if (createBtn) {
  createBtn.addEventListener('click', () => openEditor());
}

if (cancelBtn) {
  cancelBtn.addEventListener('click', closeEditor);
}

if (saveBtn) {
  saveBtn.addEventListener('click', saveArticle);
}

if (modeToggle) {
  modeToggle.addEventListener('change', syncModeUi);
}

if (articleBody) {
  articleBody.addEventListener('input', renderPreview);
}

if (articleSearch) {
  articleSearch.addEventListener('input', applyFilters);
}

document.querySelectorAll('[data-md-tool]').forEach((button) => {
  button.addEventListener('click', () => {
    const tool = button.dataset.mdTool;

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
  if (event.key === 'Escape') {
    closeEditor();
  }
});
