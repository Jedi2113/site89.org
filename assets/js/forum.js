// Site-89 Forum System - Micro-Reddit style
// Features: Upvotes, Pins, Mod controls (Level 5+), Edit/Delete

import { app, auth } from '/assets/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, doc, updateDoc, deleteDoc, getDoc, increment, arrayUnion, arrayRemove, serverTimestamp, where } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const db = getFirestore(app);

let currentUser = null;
let currentCharacter = null;
let userClearance = 1;
let isModerator = false;
let currentFilter = 'all';
let allThreads = [];

// Initialize
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  
  if (user) {
    await loadCharacterData();
    isModerator = userClearance >= 5;
  }
  
  loadThreads();
  setupEventListeners();
});

// Load character data
async function loadCharacterData() {
  const selectedCharRaw = localStorage.getItem('selectedCharacter');
  if (!selectedCharRaw) return;
  
  try {
    const char = JSON.parse(selectedCharRaw);
    const charRef = doc(db, 'characters', char.id);
    const charSnap = await getDoc(charRef);
    
    if (charSnap.exists()) {
      currentCharacter = { id: char.id, ...charSnap.data() };
      userClearance = currentCharacter.clearance || 1;
    }
  } catch (e) {
    console.error('Failed to load character:', e);
  }
}

// Load threads
function loadThreads() {
  const q = query(collection(db, 'forum-threads'), orderBy('createdAt', 'desc'));
  
  onSnapshot(q, 
    (snapshot) => {
      allThreads = [];
      snapshot.forEach((doc) => {
        allThreads.push({ id: doc.id, ...doc.data() });
      });
      
      // Sort pinned to top
      allThreads.sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return b.createdAt?.toMillis() - a.createdAt?.toMillis();
      });
      
      filterThreads(currentFilter);
    },
    (error) => {
      console.error('Error loading threads:', error);
      // Show empty state on error
      document.getElementById('threadList').style.display = 'none';
      document.getElementById('emptyState').style.display = 'block';
    }
  );
}

// Filter threads
function filterThreads(filter) {
  currentFilter = filter;
  
  let filtered = allThreads;
  
  if (filter === 'pinned') {
    filtered = allThreads.filter(t => t.pinned);
  } else if (filter !== 'all') {
    filtered = allThreads.filter(t => t.category === filter);
  }
  
  displayThreads(filtered);
  
  // Update active filter button
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
}

// Display threads
function displayThreads(threads) {
  const threadList = document.getElementById('threadList');
  const emptyState = document.getElementById('emptyState');
  
  if (threads.length === 0) {
    threadList.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }
  
  threadList.style.display = 'flex';
  emptyState.style.display = 'none';
  
  threadList.innerHTML = threads.map(thread => createThreadCard(thread)).join('');
  
  // Add event listeners
  threads.forEach(thread => {
    attachThreadListeners(thread);
  });
}

// Create thread card HTML
function createThreadCard(thread) {
  const votes = (thread.upvotes || 0) - (thread.downvotes || 0);
  const hasUpvoted = thread.upvoters?.includes(currentUser?.uid);
  const hasDownvoted = thread.downvoters?.includes(currentUser?.uid);
  const replyCount = thread.replyCount || 0;
  const viewCount = thread.views || 0;
  
  const categoryColors = {
    'announcements': '#ffc800',
    'discussion': '#4efaaa',
    'roleplay': '#007c6b',
    'questions': '#00bfff',
    'feedback': '#ff6b6b'
  };
  
  const categoryColor = categoryColors[thread.category] || '#4efaaa';
  
  const authorName = thread.authorName || 'Anonymous';
  const authorClearance = thread.authorClearance || 1;
  const isMod = authorClearance >= 5;
  
  const timeAgo = thread.createdAt ? formatTimeAgo(thread.createdAt.toDate()) : 'Just now';
  
  return `
    <div class="thread-card ${thread.pinned ? 'pinned' : ''}" data-thread-id="${thread.id}">
      <div class="thread-header">
        <div class="thread-votes">
          <button class="vote-btn vote-up ${hasUpvoted ? 'upvoted' : ''}" data-thread-id="${thread.id}">
            <i class="fas fa-arrow-up"></i>
          </button>
          <div class="vote-count">${votes}</div>
          <button class="vote-btn vote-down ${hasDownvoted ? 'downvoted' : ''}" data-thread-id="${thread.id}">
            <i class="fas fa-arrow-down"></i>
          </button>
        </div>
        
        <div class="thread-content">
          <div class="thread-meta">
            <span class="thread-category" style="background: ${categoryColor};">${thread.category}</span>
            ${thread.pinned ? '<span class="thread-pinned-badge"><i class="fas fa-thumbtack"></i> Pinned</span>' : ''}
          </div>
          
          <div class="thread-title">${escapeHtml(thread.title)}</div>
          <div class="thread-preview">${escapeHtml(thread.content.substring(0, 200))}${thread.content.length > 200 ? '...' : ''}</div>
          
          <div class="thread-footer">
            <div class="thread-author">
              <i class="fas fa-user-circle"></i>
              <span class="author-name">${escapeHtml(authorName)}</span>
              ${isMod ? '<span class="mod-badge">MOD</span>' : ''}
              <span>•</span>
              <span>${timeAgo}</span>
            </div>
            
            <div class="thread-stats">
              <div class="thread-stat">
                <i class="fas fa-comments"></i>
                <span>${replyCount}</span>
              </div>
              <div class="thread-stat">
                <i class="fas fa-eye"></i>
                <span>${viewCount}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

// Attach event listeners to thread
function attachThreadListeners(thread) {
  // Upvote
  const upBtn = document.querySelector(`.vote-up[data-thread-id="${thread.id}"]`);
  if (upBtn) {
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleVote(thread.id, 'up');
    });
  }
  
  // Downvote
  const downBtn = document.querySelector(`.vote-down[data-thread-id="${thread.id}"]`);
  if (downBtn) {
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleVote(thread.id, 'down');
    });
  }
  
  // Click to view thread
  const card = document.querySelector(`.thread-card[data-thread-id="${thread.id}"]`);
  if (card) {
    card.addEventListener('click', () => {
      viewThread(thread.id);
    });
  }
}

// Handle voting
async function handleVote(threadId, voteType) {
  if (!currentUser) {
    if (confirm('You need to login to vote. Go to login page?')) {
      window.location.href = '/login/';
    }
    return;
  }
  
  const threadRef = doc(db, 'forum-threads', threadId);
  const threadSnap = await getDoc(threadRef);
  
  if (!threadSnap.exists()) return;
  
  const thread = threadSnap.data();
  const hasUpvoted = thread.upvoters?.includes(currentUser.uid);
  const hasDownvoted = thread.downvoters?.includes(currentUser.uid);
  
  const updates = {};
  
  if (voteType === 'up') {
    if (hasUpvoted) {
      // Remove upvote
      updates.upvotes = increment(-1);
      updates.upvoters = arrayRemove(currentUser.uid);
    } else {
      // Add upvote
      updates.upvotes = increment(1);
      updates.upvoters = arrayUnion(currentUser.uid);
      
      // Remove downvote if exists
      if (hasDownvoted) {
        updates.downvotes = increment(-1);
        updates.downvoters = arrayRemove(currentUser.uid);
      }
    }
  } else {
    if (hasDownvoted) {
      // Remove downvote
      updates.downvotes = increment(-1);
      updates.downvoters = arrayRemove(currentUser.uid);
    } else {
      // Add downvote
      updates.downvotes = increment(1);
      updates.downvoters = arrayUnion(currentUser.uid);
      
      // Remove upvote if exists
      if (hasUpvoted) {
        updates.upvotes = increment(-1);
        updates.upvoters = arrayRemove(currentUser.uid);
      }
    }
  }
  
  await updateDoc(threadRef, updates);
}

// View thread (navigate to thread page)
function viewThread(threadId) {
  // Increment view count
  const threadRef = doc(db, 'forum-threads', threadId);
  updateDoc(threadRef, { views: increment(1) }).catch(() => {});
  
  // Navigate to thread page
  window.location.href = `/forum/thread.html?id=${threadId}`;
}

// Setup event listeners
function setupEventListeners() {
  // Filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filterThreads(btn.dataset.filter);
    });
  });
  
  // Search
  const searchInput = document.getElementById('forumSearch');
  searchInput.addEventListener('input', (e) => {
    const searchTerm = e.target.value.toLowerCase();
    
    if (!searchTerm) {
      filterThreads(currentFilter);
      return;
    }
    
    const filtered = allThreads.filter(thread => 
      thread.title.toLowerCase().includes(searchTerm) ||
      thread.content.toLowerCase().includes(searchTerm) ||
      thread.authorName?.toLowerCase().includes(searchTerm)
    );
    
    displayThreads(filtered);
  });
  
  // Create thread button
  document.getElementById('createThreadBtn').addEventListener('click', () => {
    if (!currentUser) {
      if (confirm('You need to login to create a thread. Go to login page?')) {
        window.location.href = '/login/';
      }
      return;
    }
    
    if (!currentCharacter) {
      if (confirm('You need to select a character to post. Go to character selection?')) {
        window.location.href = '/character-select/';
      }
      return;
    }
    
    showCreateThreadModal();
  });
}

// Show create thread modal
function showCreateThreadModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width: 700px;">
      <div class="modal-header">
        <h2>Create New Thread</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      
      <div class="modal-body">
        <div class="form-group">
          <label>Category</label>
          <select id="threadCategory" class="form-input">
            <option value="discussion">Discussion</option>
            <option value="announcements">Announcements</option>
            <option value="roleplay">Roleplay</option>
            <option value="questions">Questions</option>
            <option value="feedback">Feedback</option>
          </select>
        </div>
        
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="threadTitle" class="form-input" placeholder="Enter thread title..." maxlength="150">
        </div>
        
        <div class="form-group">
          <label>Content</label>
          <textarea id="threadContent" class="form-input" rows="8" placeholder="What's on your mind?"></textarea>
        </div>
        
        <div id="createThreadError" class="error-message" style="display: none;"></div>
      </div>
      
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn-primary" id="submitThread">Create Thread</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  document.getElementById('submitThread').addEventListener('click', createThread);
}

// Create thread
async function createThread() {
  const title = document.getElementById('threadTitle').value.trim();
  const content = document.getElementById('threadContent').value.trim();
  const category = document.getElementById('threadCategory').value;
  const errorDiv = document.getElementById('createThreadError');
  
  if (!title) {
    errorDiv.textContent = 'Please enter a title';
    errorDiv.style.display = 'block';
    return;
  }
  
  if (!content) {
    errorDiv.textContent = 'Please enter some content';
    errorDiv.style.display = 'block';
    return;
  }
  
  try {
    await addDoc(collection(db, 'forum-threads'), {
      title,
      content,
      category,
      authorUid: currentUser.uid,
      authorName: currentCharacter ? currentCharacter.name : null,
      authorClearance: userClearance,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      upvotes: 0,
      downvotes: 0,
      upvoters: [],
      downvoters: [],
      replyCount: 0,
      views: 0,
      pinned: false,
      locked: false
    });
    
    document.querySelector('.modal-overlay').remove();
  } catch (e) {
    errorDiv.textContent = 'Failed to create thread: ' + e.message;
    errorDiv.style.display = 'block';
  }
}

// Utility functions
function formatTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
  if (seconds < 2592000) return Math.floor(seconds / 604800) + 'w ago';
  return Math.floor(seconds / 2592000) + 'mo ago';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
