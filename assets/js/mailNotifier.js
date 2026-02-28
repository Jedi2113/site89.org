// Global email notification badge updater
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, getDocs, orderBy } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

// Normalize a name into a base local-part "lastname.firstname"
function baseLocalFromName(name){
  if(!name) return '';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ? parts[0].toLowerCase().replace(/[^a-z]/g,'') : '';
  const last = parts.length>1 ? parts[parts.length-1].toLowerCase().replace(/[^a-z]/g,'') : first;
  return last && first ? `${last}.${first}` : '';
}

// Given a base local and counts, return a unique email with numeric suffixes for duplicates
function makeUniqueEmail(baseLocal, counts){
  if(!baseLocal) return '';
  const current = counts.get(baseLocal) || 0;
  const next = current + 1;
  counts.set(baseLocal, next);
  const localPart = next === 1 ? baseLocal : `${baseLocal}${next}`;
  return `${localPart}@site89.org`.toLowerCase();
}

let emailDirectoryPromise = null;
let emailDirectory = null;

async function getEmailDirectory(db){
  if(emailDirectory) return emailDirectory;
  if(emailDirectoryPromise) return emailDirectoryPromise;

  emailDirectoryPromise = (async ()=>{
    const raw = [];
    try {
      const snap = await getDocs(collection(db,'characters'));
      snap.forEach(docSnap => {
        const data = docSnap.data();
        if(data && data.name) raw.push(data);
      });
    } catch(err) {
      console.error('Failed to load characters for email directory:', err);
      return { entries: [], byPid: new Map(), byBase: new Map(), countsSnapshot: new Map() };
    }

    raw.sort((a,b)=>{
      const aName = (a.name||'').toLowerCase();
      const bName = (b.name||'').toLowerCase();
      if(aName !== bName) return aName.localeCompare(bName);
      const aPid = (a.pid||'').toString();
      const bPid = (b.pid||'').toString();
      return aPid.localeCompare(bPid);
    });

    const counts = new Map();
    const entries = raw.map(char => {
      const baseLocal = baseLocalFromName(char.name);
      const email = makeUniqueEmail(baseLocal, counts);
      return {
        email,
        baseLocal,
        pid: char.pid ? String(char.pid) : '',
        department: char.department || '',
        name: char.name || '',
        pfp: char.pfp || char.image || char.photo || char.photoUrl || char.photoURL || char.profileImage || char.avatar || char.picture || '/assets/img/logo.png'
      };
    }).filter(entry => !!entry.email);

    const byPid = new Map();
    const byBase = new Map();
    entries.forEach(entry => {
      if(entry.pid) byPid.set(entry.pid, entry.email);
      const list = byBase.get(entry.baseLocal) || [];
      list.push(entry);
      byBase.set(entry.baseLocal, list);
    });

    emailDirectory = { entries, byPid, byBase, countsSnapshot: new Map(counts) };
    return emailDirectory;
  })();

  return emailDirectoryPromise;
}

function resolveEmailForCharacter(char, directory){
  if(!char || !char.name) return '';
  const baseLocal = baseLocalFromName(char.name);
  if(!baseLocal) return '';

  const pidKey = char.pid ? String(char.pid) : '';
  if(pidKey && directory.byPid.has(pidKey)) return directory.byPid.get(pidKey);

  const bucket = directory.byBase.get(baseLocal);
  if(bucket && bucket.length){
    if(bucket.length === 1) return bucket[0].email;
    const dept = (char.department || '').toLowerCase();
    const match = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    return match ? match.email : bucket[0].email;
  }

  const snapshotCount = (directory.countsSnapshot.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

// Request desktop notification permission on first load
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Pre-load the mail notification sound
let mailAudio = null;
let audioEnabled = false;

function preloadMailSound() {
  console.log('[MailNotifier] Preloading mail sound...');
  if (!mailAudio) {
    try {
      mailAudio = new Audio('/assets/sound/mail.mp3');
      mailAudio.volume = 0.3; // Comfortable notification volume
      mailAudio.preload = 'auto';
      
      mailAudio.addEventListener('canplaythrough', () => {
        console.log('[MailNotifier] ✓ Mail sound loaded and ready to play');
      }, { once: true });
      
      mailAudio.addEventListener('error', (e) => {
        console.error('[MailNotifier] ✗ Error loading mail sound:', e, mailAudio.error);
      });
      
      // Load the audio
      mailAudio.load();
      console.log('[MailNotifier] Audio object created, loading started');
    } catch(e) {
      console.error('[MailNotifier] ✗ Failed to create Audio object:', e);
    }
  } else {
    console.log('[MailNotifier] Mail sound already preloaded');
  }
}

// Play notification sound
async function playNotificationSound() {
  console.log('[MailNotifier] 🔔 Attempting to play notification sound...');
  console.log('[MailNotifier] - audioEnabled:', audioEnabled);
  console.log('[MailNotifier] - mailAudio exists:', !!mailAudio);
  
  if (!audioEnabled) {
    console.warn('[MailNotifier] ⚠️ Audio not enabled yet. User needs to interact with page first.');
    return;
  }
  
  if (!mailAudio) {
    console.warn('[MailNotifier] ⚠️ Mail audio object not created. Creating now...');
    preloadMailSound();
    // Wait a moment for it to load
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  try {
    console.log('[MailNotifier] - mailAudio.readyState:', mailAudio?.readyState);
    console.log('[MailNotifier] - mailAudio.volume:', mailAudio?.volume);
    console.log('[MailNotifier] - mailAudio.paused:', mailAudio?.paused);
    
    // Reset to beginning in case it was already played
    mailAudio.currentTime = 0;
    console.log('[MailNotifier] Playing audio...');
    const playPromise = mailAudio.play();
    
    if (playPromise !== undefined) {
      await playPromise;
      console.log('[MailNotifier] ✓ Audio played successfully!');
    }
  } catch(e) {
    console.error('[MailNotifier] ✗ Audio play failed:', e);
    console.error('[MailNotifier] Error name:', e.name);
    console.error('[MailNotifier] Error message:', e.message);
    console.error('[MailNotifier] 💡 Tip: Make sure you\'ve clicked or interacted with the page before receiving mail');
    // Don't throw - notifications should be non-blocking
  }
}

// Get sender's profile picture from character database
async function getSenderPfp(senderEmail, db) {
  const normalized = (senderEmail || '').toLowerCase();
  try {
    const directory = await getEmailDirectory(db);
    const match = (directory.entries || []).find(entry => entry.email === normalized);
    if(match && match.pfp) return match.pfp;
  } catch(e) {
    console.log('Could not fetch sender pfp:', e);
  }
  return '/assets/img/logo.png'; // Fallback to logo
}

// Show desktop notification
async function showDesktopNotification(sender, subject, senderEmail, db) {
  if ('Notification' in window && Notification.permission === 'granted') {
    const icon = await getSenderPfp(senderEmail, db);
    
    const notification = new Notification('New Email - Site-89', {
      body: `From: ${sender}\n${subject}`,
      icon: icon,
      badge: icon,
      tag: 'site89-email',
      requireInteraction: false,
      silent: true // Keep silent - we handle our own audio
    });
    
    notification.onclick = function() {
      window.focus();
      window.location.href = '/emails/';
      notification.close();
    };
    
    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  }
}

// Enable audio on first user interaction (required by browsers)
function enableAudioOnInteraction() {
  console.log('[MailNotifier] Setting up audio interaction listeners...');
  if (!audioEnabled) {
    const enableAudio = async () => {
      // Don't auto-enable if user explicitly disabled it
      if (localStorage.getItem('mailAudioEnabled') === 'false') {
        console.log('[MailNotifier] Audio was explicitly disabled by user, not auto-enabling');
        return;
      }
      
      console.log('[MailNotifier] User interaction detected, enabling audio...');
      if (!audioEnabled) {
        try {
          // Create and resume AudioContext
          const audioContext = new (window.AudioContext || window.webkitAudioContext)();
          console.log('[MailNotifier] AudioContext created, state:', audioContext.state);
          await audioContext.resume();
          console.log('[MailNotifier] AudioContext resumed, state:', audioContext.state);
          
          // Preload and "unlock" the audio by playing it silently
          if (!mailAudio) {
            mailAudio = new Audio('/assets/sound/mail.mp3');
            mailAudio.volume = 0.3;
            mailAudio.preload = 'auto';
            console.log('[MailNotifier] Audio object created');
          }
          
          // Attempt to play and immediately pause to unlock audio playback
          console.log('[MailNotifier] Attempting to unlock audio playback...');
          mailAudio.volume = 0.01; // Very quiet for the unlock
          try {
            await mailAudio.play();
            mailAudio.pause();
            mailAudio.currentTime = 0;
            mailAudio.volume = 0.3; // Restore normal notification volume
            audioEnabled = true;
            console.log('[MailNotifier] ✓ Audio unlocked and enabled successfully!');
            
            // Store that audio is enabled
            localStorage.setItem('mailAudioEnabled', 'true');
            
            // Update toggle switch if it exists
            updateSoundToggleUI();
          } catch(playErr) {
            console.error('[MailNotifier] ✗ Failed to unlock audio:', playErr);
            // Still mark as enabled to prevent repeated attempts
            audioEnabled = true;
          }
        } catch(e) {
          console.error('[MailNotifier] ✗ Could not enable audio context:', e);
        }
      }
    };
    
    // Expose function globally so the toggle can call it
    window.enableMailAudio = enableAudio;
    
    document.addEventListener('click', enableAudio, { once: true });
    document.addEventListener('keydown', enableAudio, { once: true });
    // Also try on touchstart for mobile
    document.addEventListener('touchstart', enableAudio, { once: true });
    console.log('[MailNotifier] Audio interaction listeners registered');
  } else {
    console.log('[MailNotifier] Audio already enabled');
  }
}

// Update the toggle switch UI
function updateSoundToggleUI() {
  const toggleSwitch = document.getElementById('soundToggleSwitch');
  if (toggleSwitch) {
    if (audioEnabled || localStorage.getItem('mailAudioEnabled') === 'true') {
      toggleSwitch.classList.add('active');
    } else {
      toggleSwitch.classList.remove('active');
    }
  }
}

// Initialize the sound toggle switch
function initSoundToggle() {
  const toggleContainer = document.getElementById('soundNotificationToggle');
  const toggleSwitch = document.getElementById('soundToggleSwitch');
  
  if (!toggleContainer || !toggleSwitch) {
    console.log('[MailNotifier] Sound toggle not found on this page');
    return;
  }
  
  console.log('[MailNotifier] Initializing sound toggle switch');
  
  // Check if audio was previously enabled/disabled
  const storedPref = localStorage.getItem('mailAudioEnabled');
  if (storedPref === 'true') {
    audioEnabled = true;
    preloadMailSound();
    console.log('[MailNotifier] Audio preference loaded: enabled');
  } else if (storedPref === 'false') {
    audioEnabled = false;
    console.log('[MailNotifier] Audio preference loaded: disabled');
  }
  
  // Set initial state
  updateSoundToggleUI();
  
  // Handle toggle click
  toggleContainer.addEventListener('click', async () => {
    if (!audioEnabled) {
      console.log('[MailNotifier] User toggled sound ON - enabling audio...');
      // Enable audio directly (user interaction gives us permission)
      try {
        // Create and resume AudioContext
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        console.log('[MailNotifier] AudioContext created, state:', audioContext.state);
        await audioContext.resume();
        console.log('[MailNotifier] AudioContext resumed, state:', audioContext.state);
        
        // Create audio if it doesn't exist
        if (!mailAudio) {
          mailAudio = new Audio('/assets/sound/mail.mp3');
          mailAudio.volume = 0.3;
          mailAudio.preload = 'auto';
          console.log('[MailNotifier] Audio object created');
        }
        
        // Unlock audio by playing briefly at low volume
        mailAudio.volume = 0.01;
        await mailAudio.play();
        mailAudio.pause();
        mailAudio.currentTime = 0;
        mailAudio.volume = 0.3;
        
        audioEnabled = true;
        localStorage.setItem('mailAudioEnabled', 'true');
        updateSoundToggleUI();
        console.log('[MailNotifier] ✓ Audio enabled via toggle!');
      } catch(e) {
        console.error('[MailNotifier] ✗ Failed to enable audio:', e);
      }
    } else {
      console.log('[MailNotifier] User toggled sound OFF - disabling audio');
      // Disable audio
      audioEnabled = false;
      localStorage.setItem('mailAudioEnabled', 'false');
      updateSoundToggleUI();
    }
  });
}

function initMailNotifier() {
  console.log('[MailNotifier] ======== Initializing Mail Notifier ========');
  const auth = getAuth();
  const db = getFirestore();
  const navMailBadge = document.getElementById('navMailBadge');
  console.log('[MailNotifier] Nav badge element found:', !!navMailBadge);
  
  let unsubscribe = null;
  let previousUnreadCount = 0;
  let isFirstLoad = true;

  // Request notification permission
  console.log('[MailNotifier] Requesting notification permission...');
  requestNotificationPermission();
  
  // Enable audio on user interaction
  console.log('[MailNotifier] Setting up audio enablement...');
  enableAudioOnInteraction();
  
  // Initialize sound toggle if on emails page (wait for DOM to be ready)
  setTimeout(() => {
    initSoundToggle();
  }, 100);

  onAuthStateChanged(auth, async (user) => {
    // Clean up previous listener
    if(unsubscribe){ 
      unsubscribe(); 
      unsubscribe = null; 
  
  // Show sound enable prompt after a short delay (give page time to load)
  setTimeout(() => {
    showEnableSoundPrompt();
  }, 2000);
    }
    
    if(!user || !navMailBadge) return;
    
    // Get character email
    let myAddress = '';
    try {
      const selected = JSON.parse(localStorage.getItem('selectedCharacter'));
      if(selected && selected.name){
        try {
          const directory = await getEmailDirectory(db);
          myAddress = resolveEmailForCharacter(selected, directory);
        } catch(dirErr) {
          console.warn('Directory resolution failed, using fallback:', dirErr);
          const baseLocal = baseLocalFromName(selected.name);
          myAddress = baseLocal ? `${baseLocal}@site89.org` : '';
        }
      } else if(user.email){
        myAddress = user.email;
      }
    } catch(e){ 
      if(user.email) myAddress = user.email;
    }

    myAddress = (myAddress || '').toLowerCase();
    
    if(!myAddress) {
      navMailBadge.style.display = 'none';
      return;
    }
    
    // Set up real-time listener for unread messages
    const q = query(
      collection(db, 'emails'),
      where('recipients', 'array-contains', myAddress)
    );
    
    unsubscribe = onSnapshot(q, (snapshot) => {
      let unreadCount = 0;
      let newestEmail = null;
      let newestTimestamp = 0;

      snapshot.forEach(doc => {
        const data = doc.data();
        // Count if: recipient matches, not in trash, not draft, and not read
        if(data.recipients && data.recipients.includes(myAddress) && 
           data.folder !== 'trash' && 
           data.status !== 'draft' && 
           !data.read){
          unreadCount++;
          
          // Track newest unread email (using 'ts' field from emails.js)
          const emailTime = data.ts?.toMillis() || 0;
          if(emailTime > newestTimestamp) {
            newestTimestamp = emailTime;
            newestEmail = data;
          }
        }
      });
      
      // Check if we got a NEW email (count increased)
      if(!isFirstLoad && unreadCount > previousUnreadCount && newestEmail) {
        console.log('[MailNotifier] 📧 NEW EMAIL DETECTED!');
        console.log('[MailNotifier] Previous count:', previousUnreadCount, '→ New count:', unreadCount);
        console.log('[MailNotifier] Sender:', newestEmail.sender);
        console.log('[MailNotifier] Subject:', newestEmail.subject);
        
        // Try to play custom sound
        if (audioEnabled) {
          playNotificationSound().catch(err => {
            console.warn('[MailNotifier] ⚠️ Custom sound failed:', err);
          });
        } else {
          console.log('[MailNotifier] ⚠️ Audio not enabled - user needs to enable sound notifications');
        }
        
        // Show desktop notification
        showDesktopNotification(
          newestEmail.sender || 'Unknown Sender',
          newestEmail.subject || '(No Subject)',
          newestEmail.sender || '',
          db
        );
      } else {
        console.log('[MailNotifier] Unread count updated:', unreadCount, '(isFirstLoad:', isFirstLoad, ', previous:', previousUnreadCount, ')');
      }
      
      previousUnreadCount = unreadCount;
      isFirstLoad = false;
      
      // Update badge
      if(unreadCount > 0){
        navMailBadge.textContent = unreadCount;
        navMailBadge.style.display = 'flex';
      } else {
        navMailBadge.textContent = '';
        navMailBadge.style.display = 'none';
      }
    }, (err) => {
      console.error('MailNotifier error:', err);
    });
  });
}

// Try multiple initialization methods
let initialized = false;

document.addEventListener('includesLoaded', () => {
  if(!initialized){
    console.log('[MailNotifier] Initializing via includesLoaded event');
    initialized = true;
    initMailNotifier();
  }
});

document.addEventListener('DOMContentLoaded', () => {
  if(!initialized){
    console.log('[MailNotifier] Initializing via DOMContentLoaded event');
    initialized = true;
    initMailNotifier();
  }
});

// Fallback: try after a short delay
setTimeout(() => {
  if(!initialized){
    console.log('[MailNotifier] Initializing via timeout fallback');
    initialized = true;
    initMailNotifier();
  }
}, 1000);

