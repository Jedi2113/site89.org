// Site-89 Forum Thread View - with moderation controls
// Features: Reply, Edit, Delete, Pin, Lock (Level 5+ mods)

import { app, auth } from '/assets/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, collection, addDoc, query, orderBy, onSnapshot, doc, updateDoc, deleteDoc, getDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const db = getFirestore(app);

let currentUser = null;
let currentCharacter = null;
let userClearance = 1;
let isModerator = false;
let threadId = null;
let threadData = null;

// Get thread ID from URL
const urlParams = new URLSearchParams(window.location.search);
threadId = urlParams.get('id');

if (!threadId) {
  window.location.href = '/forum/';
}

// Initialize
onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  
  if (user) {
    await loadCharacterData();
    isModerator = userClearance >= 5;
  }
  
  loadThread();
  loadReplies();
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

// Load thread
async function loadThread() {
  const threadRef = doc(db, 'forum-threads', threadId);
  
  onSnapshot(threadRef, (snapshot) => {
    if (!snapshot.exists()) {
      alert('Thread not found');
      window.location.href = '/forum/';
      return;
    }
    
    threadData = { id: snapshot.id, ...snapshot.data() };
    displayThread();
  });
}

// Display thread
function displayThread() {
  const threadView = document.getElementById('threadView');
  const isAuthor = currentUser && threadData.authorUid === currentUser.uid;
  const canModerate = isModerator;
  const isLocked = threadData.locked || false;
  
  const categoryColors = {
    'announcements': '#ffc800',
    'discussion': '#4efaaa',
    'roleplay': '#007c6b',
    'questions': '#00bfff',
    'feedback': '#ff6b6b'
  };
  
  const categoryColor = categoryColors[threadData.category] || '#4efaaa';
  const votes = (threadData.upvotes || 0) - (threadData.downvotes || 0);
  const hasUpvoted = threadData.upvoters?.includes(currentUser?.uid);
  const hasDownvoted = threadData.downvoters?.includes(currentUser?.uid);
  const authorClearance = threadData.authorClearance || 1;
  const isMod = authorClearance >= 5;
  
  const timeAgo = threadData.createdAt ? formatTimeAgo(threadData.createdAt.toDate()) : 'Just now';
  
  threadView.innerHTML = `
    <div class="thread-post ${isLocked ? 'locked' : ''}">
      <span class="thread-category-badge" style="background: ${categoryColor};">${threadData.category}</span>
      ${threadData.pinned ? '<span class="thread-category-badge" style="background: #ffc800;"><i class="fas fa-thumbtack"></i> PINNED</span>' : ''}
      ${isLocked ? '<span class="thread-category-badge" style="background: #ff6b6b;"><i class="fas fa-lock"></i> LOCKED</span>' : ''}
      
      <div class="post-header">
        <div class="post-author-info">
          <div class="author-avatar">
            <i class="fas fa-user"></i>
          </div>
          <div class="author-details">
            <div class="author-name">
              ${escapeHtml(threadData.authorName || 'Anonymous')}
              ${isMod ? '<span class="mod-badge">MOD</span>' : ''}
            </div>
            <div class="author-meta">
              <span>Level ${authorClearance} Clearance</span>
              <span>•</span>
              <span>${timeAgo}</span>
            </div>
          </div>
        </div>
        
        <div class="post-actions">
          ${isAuthor ? `<button class="action-btn" onclick="editThread()"><i class="fas fa-edit"></i> Edit</button>` : ''}
          ${canModerate ? `
            <button class="action-btn" onclick="togglePin()">
              <i class="fas fa-thumbtack"></i> ${threadData.pinned ? 'Unpin' : 'Pin'}
            </button>
            <button class="action-btn" onclick="toggleLock()">
              <i class="fas fa-lock"></i> ${isLocked ? 'Unlock' : 'Lock'}
            </button>
          ` : ''}
          ${(isAuthor || canModerate) ? `<button class="action-btn danger" onclick="deleteThread()"><i class="fas fa-trash"></i> Delete</button>` : ''}
        </div>
      </div>
      
      <h1 class="thread-title">${escapeHtml(threadData.title)}</h1>
      
      <div class="thread-content">${escapeHtml(threadData.content)}</div>
      
      <div class="post-footer">
        <div class="post-votes">
          <button class="vote-btn ${hasUpvoted ? 'upvoted' : ''}" onclick="handleVote('up')">
            <i class="fas fa-arrow-up"></i>
            <span>${threadData.upvotes || 0}</span>
          </button>
          <span style="color: var(--text-light); opacity: 0.5;">|</span>
          <button class="vote-btn ${hasDownvoted ? 'downvoted' : ''}" onclick="handleVote('down')">
            <i class="fas fa-arrow-down"></i>
            <span>${threadData.downvotes || 0}</span>
          </button>
          <span style="color: var(--accent-mint); font-weight: 600; margin-left: 0.5rem;">${votes} points</span>
        </div>
      </div>
    </div>
  `;
  
  // Show replies section
  document.getElementById('repliesSection').style.display = 'block';
  
  // Show/hide reply form based on locked status
  const replyForm = document.getElementById('replyForm');
  const lockedNotice = document.getElementById('lockedNotice');
  
  if (isLocked) {
    replyForm.style.display = 'none';
    lockedNotice.style.display = 'flex';
  } else if (currentUser && currentCharacter) {
    replyForm.style.display = 'block';
    lockedNotice.style.display = 'none';
  } else {
    replyForm.style.display = 'none';
    lockedNotice.style.display = 'none';
  }
}

// Load replies
function loadReplies() {
  const q = query(
    collection(db, 'forum-threads', threadId, 'replies'),
    orderBy('createdAt', 'asc')
  );
  
  onSnapshot(q, (snapshot) => {
    const replies = [];
    snapshot.forEach((doc) => {
      replies.push({ id: doc.id, ...doc.data() });
    });
    
    displayReplies(replies);
    
    // Update thread reply count
    if (threadData) {
      const replyCount = replies.length;
      document.getElementById('replyCount').textContent = `${replyCount} ${replyCount === 1 ? 'Reply' : 'Replies'}`;
      
      // Update Firestore
      const threadRef = doc(db, 'forum-threads', threadId);
      updateDoc(threadRef, { replyCount }).catch(() => {});
    }
  });
}

// Display replies
function displayReplies(replies) {
  const repliesList = document.getElementById('repliesList');
  
  if (replies.length === 0) {
    repliesList.innerHTML = '<p style="text-align: center; color: var(--text-light); opacity: 0.6; padding: 2rem;">No replies yet. Be the first to reply!</p>';
    return;
  }
  
  // Build threaded structure
  const topLevelReplies = replies.filter(r => !r.parentReplyId);
  const replyMap = {};
  replies.forEach(r => replyMap[r.id] = r);
  
  repliesList.innerHTML = topLevelReplies.map(reply => createReplyThread(reply, replies, replyMap)).join('');
}

// Create threaded reply structure
function createReplyThread(reply, allReplies, replyMap, depth = 0) {
  const childReplies = allReplies.filter(r => r.parentReplyId === reply.id);
  const replyCard = createReplyCard(reply, depth);
  
  if (childReplies.length === 0) {
    return replyCard;
  }
  
  const children = childReplies.map(child => createReplyThread(child, allReplies, replyMap, depth + 1)).join('');
  
  return `${replyCard}<div class="reply-thread">${children}</div>`;
}

// Create reply card
function createReplyCard(reply, depth = 0) {
  const isAuthor = currentUser && reply.authorUid === currentUser.uid;
  const canModerate = isModerator;
  const authorClearance = reply.authorClearance || 1;
  const isMod = authorClearance >= 5;
  const timeAgo = reply.createdAt ? formatTimeAgo(reply.createdAt.toDate()) : 'Just now';
  const isLocked = threadData?.locked || false;
  
  return `
    <div class="reply-card" data-reply-id="${reply.id}">
      <div class="post-header">
        <div class="post-author-info">
          <div class="author-avatar" style="width: 40px; height: 40px;">
            <i class="fas fa-user"></i>
          </div>
          <div class="author-details">
            <div class="author-name" style="font-size: 1rem;">
              ${escapeHtml(reply.authorName || 'Anonymous')}
              ${isMod ? '<span class="mod-badge">MOD</span>' : ''}
            </div>
            <div class="author-meta">
              <span>Level ${authorClearance}</span>
              <span>•</span>
              <span>${timeAgo}</span>
            </div>
          </div>
        </div>
        
        <div class="post-actions">
          ${isAuthor ? `<button class="action-btn" onclick="editReply('${reply.id}')"><i class="fas fa-edit"></i></button>` : ''}
          ${(isAuthor || canModerate) ? `<button class="action-btn danger" onclick="deleteReply('${reply.id}')"><i class="fas fa-trash"></i></button>` : ''}
        </div>
      </div>
      
      <div class="reply-content">${escapeHtml(reply.content)}</div>
      
      <div style="margin-top: 0.75rem; display: flex; gap: 1rem; align-items: center;">
        ${!isLocked && currentUser && currentCharacter ? `<button class="reply-btn" onclick="showReplyForm('${reply.id}')"><i class="fas fa-reply"></i> Reply</button>` : ''}
      </div>
      
      <div id="reply-form-${reply.id}" style="display: none;"></div>
    </div>
  `;
}

// Setup event listeners
function setupEventListeners() {
  // Submit reply
  const submitBtn = document.getElementById('submitReply');
  if (submitBtn) {
    submitBtn.addEventListener('click', submitReply);
  }
}

// Submit reply
async function submitReply() {
  if (!currentUser || !currentCharacter) {
    alert('Please login and select a character');
    return;
  }
  
  const content = document.getElementById('replyContent').value.trim();
  
  if (!content) {
    alert('Please enter a reply');
    return;
  }
  
  try {
    await addDoc(collection(db, 'forum-threads', threadId, 'replies'), {
      content,
      authorUid: currentUser.uid,
      authorName: currentCharacter ? currentCharacter.name : null,
      authorClearance: userClearance,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    
    // Clear form
    document.getElementById('replyContent').value = '';
    
    // Update thread updated time
    const threadRef = doc(db, 'forum-threads', threadId);
    await updateDoc(threadRef, { updatedAt: serverTimestamp() });
    
  } catch (e) {
    alert('Failed to post reply: ' + e.message);
  }
}

// Show reply form for nested reply
window.showReplyForm = function(parentReplyId) {
  // Hide any other open reply forms
  document.querySelectorAll('[id^="reply-form-"]').forEach(form => {
    form.style.display = 'none';
    form.innerHTML = '';
  });
  
  const formContainer = document.getElementById(`reply-form-${parentReplyId}`);
  formContainer.style.display = 'block';
  formContainer.innerHTML = `
    <div class="reply-form-inline">
      <textarea id="nested-reply-${parentReplyId}" placeholder="Write your reply..."></textarea>
      <div style="display: flex; gap: 0.5rem; justify-content: flex-end;">
        <button class="btn-secondary" onclick="cancelReply('${parentReplyId}')">Cancel</button>
        <button class="btn-primary" onclick="submitNestedReply('${parentReplyId}')">Reply</button>
      </div>
    </div>
  `;
  
  // Focus textarea
  document.getElementById(`nested-reply-${parentReplyId}`).focus();
};

// Cancel nested reply
window.cancelReply = function(parentReplyId) {
  const formContainer = document.getElementById(`reply-form-${parentReplyId}`);
  formContainer.style.display = 'none';
  formContainer.innerHTML = '';
};

// Submit nested reply
window.submitNestedReply = async function(parentReplyId) {
  if (!currentUser || !currentCharacter) {
    alert('Please login and select a character');
    return;
  }
  
  const content = document.getElementById(`nested-reply-${parentReplyId}`).value.trim();
  
  if (!content) {
    alert('Please enter a reply');
    return;
  }
  
  try {
    await addDoc(collection(db, 'forum-threads', threadId, 'replies'), {
      content,
      parentReplyId: parentReplyId,
      authorUid: currentUser.uid,
      authorName: currentCharacter ? currentCharacter.name : null,
      authorClearance: userClearance,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    
    // Clear and hide form
    cancelReply(parentReplyId);
    
    // Update thread updated time
    const threadRef = doc(db, 'forum-threads', threadId);
    await updateDoc(threadRef, { updatedAt: serverTimestamp() });
    
  } catch (e) {
    alert('Failed to post reply: ' + e.message);
  }
}

// Vote handling
window.handleVote = async function(voteType) {
  if (!currentUser) {
    if (confirm('You need to login to vote. Go to login page?')) {
      window.location.href = '/login/';
    }
    return;
  }
  
  const threadRef = doc(db, 'forum-threads', threadId);
  const hasUpvoted = threadData.upvoters?.includes(currentUser.uid);
  const hasDownvoted = threadData.downvoters?.includes(currentUser.uid);
  
  const updates = {};
  
  if (voteType === 'up') {
    if (hasUpvoted) {
      // Remove upvote
      updates.upvotes = (threadData.upvotes || 0) - 1;
      updates.upvoters = threadData.upvoters.filter(uid => uid !== currentUser.uid);
    } else {
      // Add upvote
      updates.upvotes = (threadData.upvotes || 0) + 1;
      updates.upvoters = [...(threadData.upvoters || []), currentUser.uid];
      
      // Remove downvote if exists
      if (hasDownvoted) {
        updates.downvotes = (threadData.downvotes || 0) - 1;
        updates.downvoters = threadData.downvoters.filter(uid => uid !== currentUser.uid);
      }
    }
  } else {
    if (hasDownvoted) {
      // Remove downvote
      updates.downvotes = (threadData.downvotes || 0) - 1;
      updates.downvoters = threadData.downvoters.filter(uid => uid !== currentUser.uid);
    } else {
      // Add downvote
      updates.downvotes = (threadData.downvotes || 0) + 1;
      updates.downvoters = [...(threadData.downvoters || []), currentUser.uid];
      
      // Remove upvote if exists
      if (hasUpvoted) {
        updates.upvotes = (threadData.upvotes || 0) - 1;
        updates.upvoters = threadData.upvoters.filter(uid => uid !== currentUser.uid);
      }
    }
  }
  
  await updateDoc(threadRef, updates);
};

// Edit thread
window.editThread = function() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box" style="max-width: 700px;">
      <div class="modal-header">
        <h2>Edit Thread</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      
      <div class="modal-body">
        <div class="form-group">
          <label>Title</label>
          <input type="text" id="editTitle" class="form-input" value="${escapeHtml(threadData.title)}" maxlength="150">
        </div>
        
        <div class="form-group">
          <label>Content</label>
          <textarea id="editContent" class="form-input" rows="8">${escapeHtml(threadData.content)}</textarea>
        </div>
      </div>
      
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn-primary" onclick="saveThreadEdit()">Save Changes</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
};

// Save thread edit
window.saveThreadEdit = async function() {
  const title = document.getElementById('editTitle').value.trim();
  const content = document.getElementById('editContent').value.trim();
  
  if (!title || !content) {
    alert('Title and content are required');
    return;
  }
  
  try {
    const threadRef = doc(db, 'forum-threads', threadId);
    await updateDoc(threadRef, {
      title,
      content,
      updatedAt: serverTimestamp(),
      edited: true
    });
    
    document.querySelector('.modal-overlay').remove();
  } catch (e) {
    alert('Failed to update thread: ' + e.message);
  }
};

// Toggle pin
window.togglePin = async function() {
  if (!isModerator) return;
  
  try {
    const threadRef = doc(db, 'forum-threads', threadId);
    await updateDoc(threadRef, {
      pinned: !threadData.pinned
    });
  } catch (e) {
    alert('Failed to pin/unpin thread: ' + e.message);
  }
};

// Toggle lock
window.toggleLock = async function() {
  if (!isModerator) return;
  
  const confirmed = confirm(`Are you sure you want to ${threadData.locked ? 'unlock' : 'lock'} this thread?`);
  if (!confirmed) return;
  
  try {
    const threadRef = doc(db, 'forum-threads', threadId);
    await updateDoc(threadRef, {
      locked: !threadData.locked
    });
  } catch (e) {
    alert('Failed to lock/unlock thread: ' + e.message);
  }
};

// Delete thread
window.deleteThread = async function() {
  const confirmed = confirm('Are you sure you want to delete this thread? This cannot be undone!');
  if (!confirmed) return;
  
  try {
    const threadRef = doc(db, 'forum-threads', threadId);
    await deleteDoc(threadRef);
    window.location.href = '/forum/';
  } catch (e) {
    alert('Failed to delete thread: ' + e.message);
  }
};

// Edit reply
window.editReply = function(replyId) {
  // Get reply content (would need to store in memory or re-fetch)
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header">
        <h2>Edit Reply</h2>
        <button class="modal-close" onclick="this.closest('.modal-overlay').remove()">×</button>
      </div>
      
      <div class="modal-body">
        <textarea id="editReplyContent" class="form-input" rows="6" placeholder="Reply content..."></textarea>
      </div>
      
      <div class="modal-footer">
        <button class="btn-secondary" onclick="this.closest('.modal-overlay').remove()">Cancel</button>
        <button class="btn-primary" onclick="saveReplyEdit('${replyId}')">Save</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
};

// Save reply edit
window.saveReplyEdit = async function(replyId) {
  const content = document.getElementById('editReplyContent').value.trim();
  
  if (!content) {
    alert('Reply cannot be empty');
    return;
  }
  
  try {
    const replyRef = doc(db, 'forum-threads', threadId, 'replies', replyId);
    await updateDoc(replyRef, {
      content,
      updatedAt: serverTimestamp(),
      edited: true
    });
    
    document.querySelector('.modal-overlay').remove();
  } catch (e) {
    alert('Failed to update reply: ' + e.message);
  }
};

// Delete reply
window.deleteReply = async function(replyId) {
  const confirmed = confirm('Delete this reply?');
  if (!confirmed) return;
  
  try {
    const replyRef = doc(db, 'forum-threads', threadId, 'replies', replyId);
    await deleteDoc(replyRef);
  } catch (e) {
    alert('Failed to delete reply: ' + e.message);
  }
};

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
