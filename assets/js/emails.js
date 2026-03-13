import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { getFirestore, collection, query, where, orderBy, getDocs, onSnapshot, addDoc, updateDoc, doc, deleteDoc, serverTimestamp, getDoc } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { marked } from 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';

// Normalize a name into a local-part seed like "lastname.firstname"
function baseLocalFromName(name){
  if(!name) return '';
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ? parts[0].toLowerCase().replace(/[^a-z]/g,'') : '';
  const last = parts.length>1 ? parts[parts.length-1].toLowerCase().replace(/[^a-z]/g,'') : first;
  return last && first ? `${last}.${first}` : '';
}

// Given a base local-part and running counts, return a unique email (appends numbers on duplicates)
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

// Build a deterministic directory of character emails with collision handling
async function getEmailDirectory(db){
  if(emailDirectory) return emailDirectory;
  if(emailDirectoryPromise) return emailDirectoryPromise;

  emailDirectoryPromise = (async () => {
    const raw = [];
    try {
      const snap = await getDocs(collection(db, 'characters'));
      snap.forEach(docSnap => {
        const data = docSnap.data();
        if(data && data.name) raw.push({ docId: docSnap.id, ...data });
      });
    } catch(err) {
      console.error('Failed to load characters for email directory:', err);
      return { entries: [], byPid: new Map(), byBase: new Map(), countsSnapshot: new Map() };
    }

    // Separate characters with existing emails from those without
    const withEmail = raw.filter(char => char.email);
    const withoutEmail = raw.filter(char => !char.email);

    // Sort characters without emails by creation time (older first) for stable assignment
    withoutEmail.sort((a,b)=>{
      const aSec = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
      const bSec = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
      const aNanos = a.createdAt && a.createdAt.nanoseconds ? a.createdAt.nanoseconds : 0;
      const bNanos = b.createdAt && b.createdAt.nanoseconds ? b.createdAt.nanoseconds : 0;
      if (aSec !== bSec) return aSec - bSec;
      if (aNanos !== bNanos) return aNanos - bNanos;

      const aPid = String(a.pid || '');
      const bPid = String(b.pid || '');
      if (aPid !== bPid) return aPid.localeCompare(bPid);

      return String(a.docId || '').localeCompare(String(b.docId || ''));
    });

    // Build counts from existing emails to avoid conflicts
    const counts = new Map();
    const usedEmails = new Set();
    
    withEmail.forEach(char => {
      const email = char.email.toLowerCase();
      usedEmails.add(email);
      const baseLocal = baseLocalFromName(char.name);
      if (baseLocal) {
        // Extract number from email if present (e.g., "smith.john2" -> 2)
        const match = email.match(/@/);
        if (match) {
          const localPart = email.substring(0, match.index);
          const numMatch = localPart.match(/(\d+)$/);
          if (numMatch) {
            const num = parseInt(numMatch[1], 10);
            const currentMax = counts.get(baseLocal) || 0;
            counts.set(baseLocal, Math.max(currentMax, num));
          } else if (localPart === baseLocal) {
            // Non-numbered email, record as 1
            const currentMax = counts.get(baseLocal) || 0;
            counts.set(baseLocal, Math.max(currentMax, 1));
          }
        }
      }
    });

    // Create entries for characters with existing emails
    const entries = withEmail.map(char => {
      const baseLocal = baseLocalFromName(char.name);
      return {
        email: char.email.toLowerCase(),
        baseLocal,
        pid: char.pid ? String(char.pid) : '',
        department: char.department || '',
        name: char.name || '',
        image: char.image || char.photo || char.photoUrl || char.photoURL || char.profileImage || char.avatar || char.picture || null,
        docId: char.docId
      };
    });

    // Generate emails for characters without them
    withoutEmail.forEach(char => {
      const baseLocal = baseLocalFromName(char.name);
      if (baseLocal) {
        const email = makeUniqueEmail(baseLocal, counts);
        entries.push({
          email,
          baseLocal,
          pid: char.pid ? String(char.pid) : '',
          department: char.department || '',
          name: char.name || '',
          image: char.image || char.photo || char.photoUrl || char.photoURL || char.profileImage || char.avatar || char.picture || null,
          docId: char.docId
        });
      }
    });

    const filteredEntries = entries.filter(entry => !!entry.email);

    const byPid = new Map();
    const byBase = new Map();
    const byDocId = new Map();
    filteredEntries.forEach(entry => {
      if(entry.pid) byPid.set(entry.pid, entry.email);
      if(entry.docId) byDocId.set(entry.docId, entry.email);
      const list = byBase.get(entry.baseLocal) || [];
      list.push(entry);
      byBase.set(entry.baseLocal, list);
    });

    emailDirectory = { entries: filteredEntries, byPid, byBase, byDocId, countsSnapshot: new Map(counts) };
    return emailDirectory;
  })();

  return emailDirectoryPromise;
}

// Resolve a character's email using the directory (falls back to baseLocal if missing)
function resolveEmailForCharacter(char, directory){
  if(!char || !char.name){
    return '';
  }
  
  // If character has a stored email, use it
  if(char.email) return char.email.toLowerCase();
  
  const baseLocal = baseLocalFromName(char.name);
  if(!baseLocal) return '';

  // Try to find by PID first
  const pidKey = char.pid ? String(char.pid) : '';
  if(pidKey && directory.byPid.has(pidKey)){
    return directory.byPid.get(pidKey);
  }

  // Try to find by docId (for characters loaded from firestore)
  const docId = char.docId || char.id || '';
  if(docId && directory.byDocId && directory.byDocId.has(docId)){
    return directory.byDocId.get(docId);
  }

  const bucket = directory.byBase.get(baseLocal);
  if(bucket && bucket.length){
    if(bucket.length === 1) return bucket[0].email;
    const dept = (char.department || '').toLowerCase();
    const deptMatch = bucket.find(entry => (entry.department || '').toLowerCase() === dept);
    if(deptMatch) return deptMatch.email;
    return bucket[0].email;
  }

  // Fallback: generate next available using snapshot counts
  const snapshotCount = (directory.countsSnapshot.get(baseLocal) || 0) + 1;
  const localPart = snapshotCount === 1 ? baseLocal : `${baseLocal}${snapshotCount}`;
  return `${localPart}@site89.org`.toLowerCase();
}

// Helper: Get divisions a character can send from (clearance 5+ for their division)
function getDirectorDivisions(){
  try {
    const ch = JSON.parse(localStorage.getItem('selectedCharacter'));
    if(!ch) return [];
    
    // Check if character has directorOf array (explicit permission)
    if(ch.directorOf && Array.isArray(ch.directorOf)){
      return ch.directorOf;
    }
    
    // Check clearance level - must be 5 or higher to send from division addresses
    const clearance = ch.clearance || 0;
    const department = ch.department || '';
    
    if(clearance >= 5 && department){
      const divisions = [];
      const deptUpper = department.toUpperCase();
      
      // Map departments to email divisions
      if(deptUpper.includes('AD/BOD')) divisions.push('bod');
      if(deptUpper.includes('IA/') || deptUpper.includes('IA')) divisions.push('ia');
      if(deptUpper.includes('RAISA')) divisions.push('raisa');
      if(deptUpper.includes('SD/') || deptUpper.includes('SD')) divisions.push('sd');
      
      return [...new Set(divisions)];
    }
    
    return [];
  } catch(e){ 
    console.error('getDirectorDivisions error:', e);
    return []; 
  }
}

function getSecurityDirectorAliases(selectedCharacter, user){
  const securityAliases = [
    'sd.mgmt@site89.org',
    'sd.cmd.mgmt@site89.org',
    'sd.sis.mgmt@site89.org',
    'sd.sdu.mgmt@site89.org',
    'sd.seccont.mgmt@site89.org'
  ];

  const authEmail = ((user && user.email) || '').toLowerCase();
  if(authEmail === 'andrews.alyx@site89.org') return securityAliases;

  const selectedName = ((selectedCharacter && selectedCharacter.name) || '').toLowerCase();
  if(selectedName.includes('alyx') && selectedName.includes('andrews')) return securityAliases;

  return [];
}

function buildSendAsAddresses(divisions, selectedCharacter, user){
  const divisionAddresses = (divisions || []).map(div => `${div}.mgmt@site89.org`.toLowerCase());
  const securityAliases = getSecurityDirectorAliases(selectedCharacter, user);
  return [...new Set([...divisionAddresses, ...securityAliases])];
}

function getOwnedAddresses(primaryAddress, sendAsAddresses){
  const addresses = [primaryAddress, ...(sendAsAddresses || [])]
    .map(addr => (addr || '').toLowerCase())
    .filter(Boolean);
  return new Set(addresses);
}

// Helper: Validate email format
function isValidEmail(email){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Helper: Expand mailing lists (e.g., "SD@site89.org" → all characters with "SD/" in dept)
async function expandMailingLists(recipients, db){
  const expanded = [];
  const normalizedRecipients = recipients.map(r => r.toLowerCase());
  const mailingLists = normalizedRecipients.filter(r => /^(bod|io|sd|scd|deo|mtf|ia)@site89\.org$/i.test(r));
  const personalEmails = normalizedRecipients.filter(r => !/^(bod|io|sd|scd|deo|mtf|ia)@site89\.org$/i.test(r));

  expanded.push(...personalEmails);

  if(!mailingLists.length) return [...new Set(expanded)];

  const directory = await getEmailDirectory(db);
  const entries = directory.entries || [];

  for(const list of mailingLists){
    const divCode = list.split('@')[0].toLowerCase();
    const deptPrefixes = divCode === 'bod' ? ['AD/BOD', 'AD/BOD/'] : 
                         divCode === 'io' ? ['AD/IO', 'AD/IO/'] : 
                         divCode === 'sd' ? ['SD/', 'SD'] : 
                         divCode === 'scd' ? ['SCD/', 'SCD'] : 
                         divCode === 'deo' ? ['DEO/', 'DEO'] : 
                         divCode === 'mtf' ? ['DEO/MTF', 'DEO/MTF/'] : 
                         divCode === 'ia' ? ['DEO/IA', 'DEO/IA/'] : null;

    if(!deptPrefixes) continue;

    entries.forEach(entry => {
      const dept = (entry.department || '').toUpperCase();
      if(deptPrefixes.some(prefix => dept.indexOf(prefix.toUpperCase()) !== -1)){
        expanded.push(entry.email);
      }
    });
  }

  return [...new Set(expanded)];
}

// Friendly date (handles Firestore Timestamp objects too)
function fmtDate(ts){
  if(!ts) return '';
  if (ts && typeof ts.toDate === 'function') return ts.toDate().toLocaleString();
  return new Date(ts).toLocaleString();
}

document.addEventListener('includesLoaded', () => {
  const auth = getAuth();
  const db = getFirestore();

  const myAddressEl = document.getElementById('myAddress');
  const messagesContainer = document.getElementById('messagesContainer');
  const folderEls = Array.from(document.querySelectorAll('.folder'));
  const composeBtn = document.getElementById('composeBtn');
  const composeArea = document.getElementById('composeArea');
  const composeClose = document.getElementById('composeClose');
  const sendBtn = document.getElementById('sendBtn');
  const saveDraftBtn = document.getElementById('saveDraftBtn');
  const composeTo = document.getElementById('composeTo');
  const composeSubject = document.getElementById('composeSubject');
  const composeBody = document.getElementById('composeBody');
  const globalMailSearch = document.getElementById('globalMailSearch');
  const mailContentWrapper = document.getElementById('mailContentWrapper');
  const btnReply = document.getElementById('btnReply');
  const btnForward = document.getElementById('btnForward');
  const btnDelete = document.getElementById('btnDelete');
  const composeSendAs = document.getElementById('composeSendAs');
  const composeSuggestions = document.getElementById('composeSuggestions');
  const folderTitle = document.getElementById('folderTitle');
  const refreshBtn = document.getElementById('refreshBtn');
  const mailApp = document.querySelector('.mail-app');
  const discordLinkModalOverlay = document.getElementById('discordLinkModalOverlay');
  const discordPromptDontShowAgain = document.getElementById('discordPromptDontShowAgain');
  const discordPromptDismiss = document.getElementById('discordPromptDismiss');
  const discordPromptLink = document.getElementById('discordPromptLink');

  let currentFolder = 'inbox';
  let myAddress = '';
  let currentUser = null;
  let currentMessage = null;
  let selectedMessageId = null;
  let allMessages = [];
  let emailsUnsubscribe = null;
  let directorDivisions = [];
  let directorSendAddr = '';
  let sendAsAddresses = [];
  let locallyMarkedRead = new Set();
  let contactsList = new Set();
  let charactersCache = {};
  let isMobile = window.innerWidth <= 768;
  let discordPromptShownThisSession = false;
  const DISCORD_PROMPT_HIDE_KEY = 'emails.discordPrompt.hide';

  function isValidEmail(e){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function shouldHideDiscordPrompt(){
    try {
      return localStorage.getItem(DISCORD_PROMPT_HIDE_KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  function persistDiscordPromptPreference(){
    if(!discordPromptDontShowAgain) return;
    if(!discordPromptDontShowAgain.checked) return;
    try {
      localStorage.setItem(DISCORD_PROMPT_HIDE_KEY, '1');
    } catch (_e) {
      // Ignore storage failures
    }
  }

  function hideDiscordLinkPrompt(){
    if(!discordLinkModalOverlay) return;
    discordLinkModalOverlay.classList.remove('show');
    discordLinkModalOverlay.setAttribute('aria-hidden', 'true');
  }

  function showDiscordLinkPrompt(){
    if(!discordLinkModalOverlay) return;
    discordLinkModalOverlay.classList.add('show');
    discordLinkModalOverlay.setAttribute('aria-hidden', 'false');
    discordPromptShownThisSession = true;
  }

  async function maybeShowDiscordLinkPrompt(user){
    if(!user || !user.uid) return;
    if(discordPromptShownThisSession || shouldHideDiscordPrompt()) return;

    try {
      const userRef = doc(db, 'users', user.uid);
      const userSnap = await getDoc(userRef);
      const userData = userSnap.exists() ? (userSnap.data() || {}) : {};
      const linkedDiscordId = String(userData.discordUserId || '').trim();
      if(!linkedDiscordId){
        showDiscordLinkPrompt();
      }
    } catch (err) {
      console.warn('Unable to verify Discord link status:', err);
    }
  }

  if(discordPromptDismiss){
    discordPromptDismiss.addEventListener('click', ()=> {
      persistDiscordPromptPreference();
      hideDiscordLinkPrompt();
    });
  }

  if(discordPromptLink){
    discordPromptLink.addEventListener('click', ()=> {
      persistDiscordPromptPreference();
      window.location.href = '/accounts/';
    });
  }

  if(discordLinkModalOverlay){
    discordLinkModalOverlay.addEventListener('click', (event)=> {
      if(event.target === discordLinkModalOverlay){
        persistDiscordPromptPreference();
        hideDiscordLinkPrompt();
      }
    });
  }
  
  // Track mobile state
  window.addEventListener('resize', () => {
    isMobile = window.innerWidth <= 768;
  });
  
  // Handle mobile back navigation
  function setupMobileNavigation(){
    if(!isMobile) return;
    
    const toolbar = document.querySelector('.mail-view-toolbar');
    if(toolbar){
      toolbar.addEventListener('click', (e) => {
        if(e.target === toolbar || e.target.textContent === '←'){
          if(mailApp) mailApp.classList.remove('viewing-message');
          selectedMessageId = null;
          currentMessage = null;
          renderList();
        }
      });
    }
  }
  
  function setActiveFolder(name){
    folderEls.forEach(f => f.classList.toggle('active', f.dataset.folder === name));
    currentFolder = name;
    const folderNames = {
      'inbox': 'Inbox',
      'drafts': 'Drafts',
      'sent': 'Sent',
      'trash': 'Trash'
    };
    if(folderTitle) folderTitle.textContent = folderNames[name] || name;
    renderList();
  }

  folderEls.forEach(f => f.addEventListener('click', ()=> setActiveFolder(f.dataset.folder)));
  
  if(refreshBtn){
    refreshBtn.addEventListener('click', ()=> {
      renderList();
    });
  }

  // Update Send As dropdown when compose opens
  function updateSendAsOptions(){
    composeSendAs.innerHTML = '<option value="">Send as personal account</option>';
    if(sendAsAddresses && sendAsAddresses.length > 0){
      const addressMap = {
        'bod.mgmt@site89.org': 'Board of Directors (bod.mgmt@site89.org)',
        'ia.mgmt@site89.org': 'Internal Affairs (ia.mgmt@site89.org)',
        'raisa.mgmt@site89.org': 'RAISA (raisa.mgmt@site89.org)',
        'sd.mgmt@site89.org': 'Security Department (sd.mgmt@site89.org)',
        'scd.mgmt@site89.org': 'Scientific Department (scd.mgmt@site89.org)',
        'mtf.mgmt@site89.org': 'Mobile Task Force (mtf.mgmt@site89.org)',
        'sd.cmd.mgmt@site89.org': 'Security Command (sd.cmd.mgmt@site89.org)',
        'sd.sis.mgmt@site89.org': 'Security Intelligence Service (sd.sis.mgmt@site89.org)',
        'sd.sdu.mgmt@site89.org': 'Specialized Divisions Unit (sd.sdu.mgmt@site89.org)',
        'sd.seccont.mgmt@site89.org': 'Security & Containment (sd.seccont.mgmt@site89.org)'
      };
      sendAsAddresses.forEach(addr => {
        const opt = document.createElement('option');
        const normalized = (addr || '').toLowerCase();
        opt.value = normalized;
        opt.textContent = addressMap[normalized] || normalized;
        composeSendAs.appendChild(opt);
      });
    }
  }

  composeSendAs.addEventListener('change', ()=>{
    directorSendAddr = composeSendAs.value;
  });

  // Autocomplete for recipient field
  composeTo.addEventListener('input', ()=>{
    const value = composeTo.value;
    const lastComma = value.lastIndexOf(',');
    const currentInput = lastComma >= 0 ? value.substring(lastComma + 1).trim() : value.trim();
    
    if(currentInput.length >= 2){
      const suggestions = showContactSuggestions(currentInput);
      if(suggestions.length > 0){
        composeSuggestions.innerHTML = suggestions.map(s => `<div data-email="${s}">${s}</div>`).join('');
        composeSuggestions.style.display = 'block';
      } else {
        composeSuggestions.style.display = 'none';
      }
    } else {
      composeSuggestions.style.display = 'none';
    }
  });

  composeSuggestions.addEventListener('click', (e)=>{
    if(e.target.dataset.email){
      const value = composeTo.value;
      const lastComma = value.lastIndexOf(',');
      if(lastComma >= 0){
        composeTo.value = value.substring(0, lastComma + 1) + ' ' + e.target.dataset.email;
      } else {
        composeTo.value = e.target.dataset.email;
      }
      composeSuggestions.style.display = 'none';
      composeTo.focus();
    }
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', (e)=>{
    if(!composeTo.contains(e.target) && !composeSuggestions.contains(e.target)){
      composeSuggestions.style.display = 'none';
    }
  });

  composeBtn.addEventListener('click', ()=> { 
    updateSendAsOptions();
    mailContentWrapper.style.display = 'none';
    composeArea.classList.add('active');
    
    // On mobile, switch to compose view
    if(isMobile && mailApp){
      mailApp.classList.add('viewing-message');
    }
    
    composeTo.focus();
  });
  
  composeClose.addEventListener('click', ()=> { 
    composeArea.classList.remove('active');
    mailContentWrapper.style.display = '';
    clearCompose();
    directorSendAddr = '';
    composeSendAs.value = '';
    
    // On mobile, go back to list view
    if(isMobile && mailApp){
      mailApp.classList.remove('viewing-message');
    }
  });
  
  function clearCompose(){ 
    composeTo.value=''; 
    composeSubject.value='';
    composeBody.value='';
  }

  // Contacts autocomplete helpers
  function saveContact(email){
    if(email && isValidEmail(email)){
      contactsList.add(email);
      try {
        localStorage.setItem('emailContacts', JSON.stringify([...contactsList]));
      } catch(e){ console.warn('Failed to save contacts', e); }
    }
  }

  function loadContacts(){
    try {
      const saved = localStorage.getItem('emailContacts');
      if(saved){
        const contacts = JSON.parse(saved);
        contacts.forEach(c => contactsList.add(c));
      }
    } catch(e){ console.warn('Failed to load contacts', e); }
  }

  function showContactSuggestions(input){
    const query = input.toLowerCase();
    const suggestions = [...contactsList].filter(c => c.toLowerCase().includes(query));
    return suggestions.slice(0, 10); // Limit to 10 suggestions
  }

  // Get character profile image
  async function getCharacterImage(email){
    // Normalize email to lowercase for case-insensitive lookup
    const normalizedEmail = email ? email.toLowerCase() : '';
    
    // Special case for system sender
    if(normalizedEmail === 'fd.mgmt@site89.org') {
      return 'fa-mgmt-special';
    }
    
    // Check cache first
    if(charactersCache[normalizedEmail]) return charactersCache[normalizedEmail];

    try {
      const directory = await getEmailDirectory(db);
      directory.entries.forEach(entry => {
        const image = entry.image || null;
        charactersCache[entry.email.toLowerCase()] = image;
      });
    } catch(e){ 
      console.error('Failed to fetch character images:', e); 
    }

    return charactersCache[normalizedEmail] || null;
  }

  async function sendMessage(status='sent'){
    const toRaw = (composeTo.value||'').split(',').map(s=>s.trim()).filter(Boolean);
    if (!toRaw.length) return alert('Add at least one recipient');
    // Basic validation
    for (const r of toRaw){ if(!isValidEmail(r)) return alert('Invalid recipient email: ' + r); }
    
    // Check if sending to mailing lists - requires clearance 4+
    const hasMailingList = toRaw.some(r => /^(bod|io|sd|scd|deo|mtf|ia)@site89\.org$/i.test(r));
    if(hasMailingList){
      try {
        const ch = JSON.parse(localStorage.getItem('selectedCharacter'));
        const clearance = ch ? (ch.clearance || 0) : 0;
        if(clearance < 4){
          return alert('Clearance Level 4 or higher required to send to division mailing lists.');
        }
      } catch(e){
        return alert('Unable to verify clearance level. Please select a character.');
      }
    }
    
    // Determine sender: use selected director address or personal address (normalized to lowercase)
    let sender = (directorSendAddr || myAddress).toLowerCase();
    if(!sender) return alert('No sender address set. Select a character or sign in.');
    
    // Validate director is allowed to send from chosen address
    if(directorSendAddr){
      const normalizedSendAs = directorSendAddr.toLowerCase();
      if(!sendAsAddresses.includes(normalizedSendAs)){
      return alert('You do not have permission to send from ' + directorSendAddr);
    }
    }

    // disable buttons while sending
    sendBtn.disabled = true; saveDraftBtn.disabled = true;
    
    // Expand mailing lists
    let recipients = toRaw;
    try {
      recipients = await expandMailingLists(toRaw, db);
    } catch(e){ console.warn('Mailing list expansion error', e); recipients = toRaw; }

    // Normalize all recipients to lowercase for case-insensitive matching
    recipients = recipients.map(r => r.toLowerCase());
    
    // Get email body from Markdown textarea
    const emailBody = composeBody.value || '';

    const payload = {
      sender: sender,
      senderEmail: currentUser ? currentUser.email : '',
      recipients: recipients,
      subject: composeSubject.value || '(no subject)',
      body: emailBody,
      isHTML: false,
      format: 'markdown',
      status: status, // 'sent' or 'draft'
      folder: status === 'draft' ? 'drafts' : '',
      deletedBy: [],
      ts: serverTimestamp()
    };

    try {
      await addDoc(collection(db,'emails'), payload);
    } catch(e){
      console.error('send failed', e); alert('Failed to send message');
    } finally {
      sendBtn.disabled = false; saveDraftBtn.disabled = false;
      composeArea.classList.remove('active');
      mailContentWrapper.style.display = '';
      clearCompose();
      directorSendAddr = '';
      composeSendAs.value = '';
      
      // On mobile, go back to list view
      if(isMobile && mailApp){
        mailApp.classList.remove('viewing-message');
      }
    }
  }

  sendBtn.addEventListener('click', ()=> sendMessage('sent'));
  saveDraftBtn.addEventListener('click', ()=> sendMessage('draft'));

  if(globalMailSearch){
    globalMailSearch.addEventListener('input', ()=> renderList());
  }

  btnDelete.addEventListener('click', async ()=>{
    if(!currentMessage) return;
    try{
      const ownedAddresses = getOwnedAddresses(myAddress, sendAsAddresses);
      const senderLower = (currentMessage.sender || '').toLowerCase();
      const isSender = ownedAddresses.has(senderLower);
      
      if(isSender){
        // Sender: move to trash or permanently delete
        if(currentMessage.folder === 'trash'){
          await deleteDoc(doc(db,'emails',currentMessage.id));
        } else {
          await updateDoc(doc(db,'emails',currentMessage.id), { folder: 'trash' });
        }
      } else {
        // Recipient: add self to deletedBy array (all lowercase for consistency)
        const deletedByLower = (currentMessage.deletedBy || []).map(e => (e || '').toLowerCase());
        const myAddressLower = myAddress.toLowerCase();
        if(!deletedByLower.includes(myAddressLower)){
          deletedByLower.push(myAddressLower);
          await updateDoc(doc(db,'emails',currentMessage.id), { deletedBy: deletedByLower });
        }
      }
      
      currentMessage = null; 
      selectedMessageId = null;
      showEmptyState();
      renderList();
    } catch(e){ console.warn('delete failed', e); alert('Could not delete message'); }
  });

  btnReply.addEventListener('click', ()=>{
    if(!currentMessage) return;
    mailContentWrapper.style.display = 'none';
    composeArea.classList.add('active');
    composeTo.value = currentMessage.sender;
    composeSubject.value = 'Re: ' + (currentMessage.subject||'');
    const originalText = getMessagePlainText(currentMessage);
    const quoted = originalText.split('\n').map(line => `> ${line}`).join('\n');
    composeBody.value = `\n\n---\nOn ${fmtDate(currentMessage.ts)} ${currentMessage.sender} wrote:\n${quoted}`;
  });

  btnForward.addEventListener('click', ()=>{
    if(!currentMessage) return;
    mailContentWrapper.style.display = 'none';
    composeArea.classList.add('active');
    composeTo.value = '';
    composeSubject.value = 'Fwd: ' + (currentMessage.subject||'');
    const originalText = getMessagePlainText(currentMessage);
    const quoted = originalText.split('\n').map(line => `> ${line}`).join('\n');
    const header = `---\nForwarded message\nFrom: ${currentMessage.sender}\nDate: ${fmtDate(currentMessage.ts)}\nTo: ${(currentMessage.recipients || []).join(', ')}`;
    composeBody.value = `\n\n${header}\n\n${quoted}`;
  });

  // Render list depending on folder
  function renderList(){
    const q = globalMailSearch ? (globalMailSearch.value||'').toLowerCase() : '';
    const ownedAddresses = getOwnedAddresses(myAddress, sendAsAddresses);
    const myAddressLower = myAddress.toLowerCase();
    const list = allMessages.filter(m => {
      const recipientsLower = (m.recipients || []).map(r => r.toLowerCase());
      const senderLower = (m.sender || '').toLowerCase();
      const isRecipient = recipientsLower.some(r => ownedAddresses.has(r));
      const isSender = ownedAddresses.has(senderLower);
      const userInDeletedBy = (m.deletedBy || []).some(e => e.toLowerCase() === myAddressLower);
      
      if (currentFolder === 'inbox') return isRecipient && m.folder !== 'trash' && m.status !== 'draft' && !userInDeletedBy;
      if (currentFolder === 'drafts') return m.status === 'draft' && isSender;
      if (currentFolder === 'sent') return isSender && m.folder !== 'trash' && m.status !== 'draft';
      if (currentFolder === 'trash') return (m.folder === 'trash' && isSender) || (isRecipient && userInDeletedBy);
      return false;
    }).filter(m => (m.subject||'').toLowerCase().includes(q) || (m.body||'').toLowerCase().includes(q) || (m.sender||'').toLowerCase().includes(q));

    // counts and unread badge on navbar
    const inboxMsgs = allMessages.filter(m => {
      const recipientsLower = (m.recipients || []).map(r => r.toLowerCase());
      const userInDeletedBy = (m.deletedBy || []).some(e => e.toLowerCase() === myAddressLower);
      return recipientsLower.some(r => ownedAddresses.has(r)) && m.folder !== 'trash' && m.status !== 'draft' && !userInDeletedBy;
    });
    // Count unread: neither m.read nor in locallyMarkedRead
    const unreadCount = inboxMsgs.filter(m => !m.read && !locallyMarkedRead.has(m.id)).length;
    document.getElementById('countInbox').textContent = inboxMsgs.length;
    const navMailBadge = document.getElementById('navMailBadge');
    if(navMailBadge){
      if(unreadCount > 0){
        navMailBadge.textContent = unreadCount;
        navMailBadge.style.display = 'flex';
      } else {
        navMailBadge.textContent = '';
        navMailBadge.style.display = 'none';
      }
    }
    document.getElementById('countDrafts').textContent = allMessages.filter(m => m.status === 'draft' && ownedAddresses.has((m.sender || '').toLowerCase())).length;
    document.getElementById('countSent').textContent = allMessages.filter(m => ownedAddresses.has((m.sender || '').toLowerCase()) && m.folder !== 'trash').length;
    document.getElementById('countTrash').textContent = allMessages.filter(m => {
      const recipientsLower = (m.recipients || []).map(r => r.toLowerCase());
      const senderLower = (m.sender || '').toLowerCase();
      const userInDeletedBy = (m.deletedBy || []).some(e => e.toLowerCase() === myAddressLower);
      const isSender = ownedAddresses.has(senderLower);
      const isRecipient = recipientsLower.some(r => ownedAddresses.has(r));
      return (m.folder === 'trash' && isSender) || (isRecipient && userInDeletedBy);
    }).length;

    messagesContainer.innerHTML = '';
    
    // Build all message HTML in correct order using Promise.all to wait for all async operations
    Promise.all(list.map(async (m) => {
      const recipientsLower = (m.recipients || []).map(r => r.toLowerCase());
      const isUnread = !m.read && !locallyMarkedRead.has(m.id) && recipientsLower.some(r => ownedAddresses.has(r));
      const isSelected = selectedMessageId === m.id;
      const className = 'message-item'+ (isUnread ? ' unread' : '') + (isSelected ? ' selected' : '');
      
      // Save contacts for autocomplete
      if(m.sender) saveContact(m.sender);
      if(m.recipients) m.recipients.forEach(r => saveContact(r));
      
      // Get profile picture asynchronously
      const profileImage = await getCharacterImage(m.sender);
      let avatarHtml;
      if(profileImage === 'fa-mgmt-special') {
        avatarHtml = `<div class="message-avatar fa-mgmt-avatar"><img src="/assets/img/FA.png" alt="FA Department" class="fa-mgmt-img"></div>`;
      } else if(profileImage && !profileImage.includes('placeholder')) {
        avatarHtml = `<div class="message-avatar"><img src="${profileImage}" alt="Profile"></div>`;
      } else {
        avatarHtml = `<div class="message-avatar">${(m.sender||'').charAt(0).toUpperCase()||'?'}</div>`;
      }
      
      // Get time display
      const timeDisplay = formatMessageTime(m.ts);
      
      // Strip HTML tags for snippet if isHTML
      let snippet = m.body || '';
      if(m.isHTML){
        snippet = snippet.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
      snippet = snippet.slice(0,100);
      
      // Return object with HTML and metadata to preserve order
      return {
        html: `${avatarHtml}
        <div class="message-meta">
          <div class="message-header">
            <div class="message-sender">${m.sender}</div>
            <div class="message-time">${timeDisplay}</div>
          </div>
          <div class="message-subject">${m.subject}</div>
          <div class="message-snippet">${snippet}</div>
        </div>`,
        className,
        message: m
      };
    })).then((renderedMessages) => {
      // Render all messages in order
      renderedMessages.forEach(({html, className, message}) => {
        const el = document.createElement('div');
        el.className = className;
        el.innerHTML = html;
        el.addEventListener('click', () => openMessage(message));
        messagesContainer.appendChild(el);
      });
    });
    
    if(list.length === 0){
      messagesContainer.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-light);opacity:0.5">No messages in this folder</div>';
    }
  }
  
  // Format message time (relative for recent, date for older)
  function formatMessageTime(ts){
    if(!ts) return '';
    // Convert normalized timestamp to Date
    let date;
    if (typeof ts === 'number') {
      date = new Date(ts);
    } else if (ts && typeof ts.toDate === 'function') {
      date = ts.toDate();
    } else if (ts && typeof ts.getTime === 'function') {
      date = ts;
    } else {
      return '';
    }
    
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if(diffMins < 1) return 'Just now';
    if(diffMins < 60) return `${diffMins}m ago`;
    if(diffHours < 24) return `${diffHours}h ago`;
    if(diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  }
  
  function showEmptyState(){
    mailContentWrapper.innerHTML = `
      <div class="mail-empty-state">
        <i class="fas fa-envelope-open"></i>
        <h3>No message selected</h3>
        <p>Select a message from the list to read its contents</p>
      </div>
    `;
  }

  function getMessagePlainText(message){
    if(!message) return '';
    if(message.isHTML){
      const div = document.createElement('div');
      div.innerHTML = message.body || '';
      return (div.textContent || div.innerText || '').trim();
    }
    return (message.body || '').trim();
  }

  async function openMessage(m){
    currentMessage = m;
    selectedMessageId = m.id;
    
    // On mobile, switch to message view
    if(isMobile && mailApp){
      mailApp.classList.add('viewing-message');
    }
    
    // Re-render list to show selected state
    renderList();
    
    // Try to get profile picture
    const profileImage = await getCharacterImage(m.sender);
    let avatarHtml;
    if(profileImage === 'fa-mgmt-special') {
      avatarHtml = `<div class="mail-sender-avatar fa-mgmt-avatar"><img src="/assets/img/FA.png" alt="FA Department" class="fa-mgmt-img"></div>`;
    } else if(profileImage && !profileImage.includes('placeholder')) {
      avatarHtml = `<div class="mail-sender-avatar"><img src="${profileImage}" alt="Profile"></div>`;
    } else {
      avatarHtml = `<div class="mail-sender-avatar">${(m.sender||'').charAt(0).toUpperCase()||'?'}</div>`;
    }
    
    // Format body content (handle HTML vs Markdown)
    const bodyContent = m.isHTML
      ? (m.body || '')
      : `<div class="markdown-body">${marked.parse(m.body || '')}</div>`;
    
    mailContentWrapper.innerHTML = `
      <div class="mail-message-header">
        <h1 class="mail-subject">${m.subject || '(no subject)'}</h1>
        
        <div class="mail-sender-info">
          ${avatarHtml}
          <div class="mail-sender-details">
            <div class="mail-sender-name">${m.sender}</div>
            <div class="mail-sender-email">${m.sender}</div>
          </div>
          <div class="mail-date">${fmtDate(m.ts)}</div>
        </div>
        
        <div class="mail-recipients">
          <div class="mail-recipients-label">To:</div>
          <div class="mail-recipients-list">${(m.recipients || []).join(', ')}</div>
        </div>
      </div>
      
      <div class="mail-body">
        ${bodyContent}
      </div>
    `;

    // mark read if I'm recipient and not already read or locally marked (case-insensitive)
    const recipientsLower = (m.recipients || []).map(r => r.toLowerCase());
    const ownedAddresses = getOwnedAddresses(myAddress, sendAsAddresses);
    if (recipientsLower.some(r => ownedAddresses.has(r)) && !m.read && !locallyMarkedRead.has(m.id)){
      // Immediately add to locally marked set for optimistic UI update
      locallyMarkedRead.add(m.id);
      // Re-render to update UI immediately
      renderList();
      
      // Then update Firestore in background
      try { 
        await updateDoc(doc(db,'emails',m.id), { read: true });
      }
      catch(e){ 
        console.error('mark read failed', e);
        // If update fails, remove from local set
        locallyMarkedRead.delete(m.id);
        renderList();
      }
    }
  }

  // Real-time listener for emails collection
  // Normalize Firestore timestamp to milliseconds
  function normalizeTimestamp(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (ts.toMillis && typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts.toDate && typeof ts.toDate === 'function') return ts.toDate().getTime();
    if (ts.getTime && typeof ts.getTime === 'function') return ts.getTime();
    return 0;
  }

  function startRealtimeMessages(){
    if (emailsUnsubscribe) emailsUnsubscribe();
    const q = query(collection(db,'emails'), orderBy('ts','desc'));
    emailsUnsubscribe = onSnapshot(q, (snapshot) => {
      allMessages = [];
      snapshot.forEach(s => {
        const data = s.data();
        // Normalize timestamp immediately when loading
        if (data.ts) {
          data._tsMs = normalizeTimestamp(data.ts);
        } else {
          data._tsMs = 0;
        }
        allMessages.push({ id: s.id, ...data });
      });
      
      // Preload character images for all senders
      const senders = [...new Set(allMessages.map(m => m.sender).filter(Boolean))];
      senders.forEach(sender => getCharacterImage(sender));
      
      renderList();
    }, (err) => { console.warn('emails listener error', err); });
  }

  // If DB empty, create a tiny demo exchange
  async function ensureSampleData(){
    const snaps = await getDocs(collection(db,'emails'));
    if (snaps.empty){
      const demoSenderEmail = currentUser ? currentUser.email : 'demo@site89.org';
      const directorDemo = 'director.mgmt@site89.org';
      await addDoc(collection(db,'emails'), { sender: directorDemo, senderEmail: 'demo@site89.org', recipients: [myAddress], subject: 'Welcome to Site‑89 Mail', body: 'This is a demo message. Use Compose to send test emails between characters.', status: 'sent', deletedBy: [], ts: serverTimestamp() });
      await addDoc(collection(db,'emails'), { sender: myAddress, senderEmail: demoSenderEmail, recipients: [directorDemo], subject: 'Re: Welcome', body: 'Thanks — message received.', status: 'sent', deletedBy: [], ts: serverTimestamp() });
    }
  }

  // Auth and address detection
  onAuthStateChanged(auth, async (user) => {
    currentUser = user; // Store current user for UID in emails
    // Load contacts from localStorage
    loadContacts();
    
    // Use selectedCharacter if present, otherwise fallback to user email
    let selected = null;
    try { selected = JSON.parse(localStorage.getItem('selectedCharacter')); } catch(e){ selected = null; }
    
    // Check if user has a character with level 1+ clearance
    if (!selected || !selected.name || !selected.clearance || Number(selected.clearance) < 1) {
      // Insufficient clearance or no character selected
      messagesContainer.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-light);opacity:0.7;"><div style="font-size:1.2rem;color:var(--accent-red);margin-bottom:1rem;"><i class="fas fa-lock"></i> Access Denied</div><p>You must create a character with security clearance level 1 or higher to access the mail system.</p><p><a href="/character-select/" style="color:var(--accent-mint);text-decoration:underline;">Manage Your Characters</a></p></div>';
      showEmptyState();
      if (emailsUnsubscribe){ emailsUnsubscribe(); emailsUnsubscribe = null; }
      return;
    }
    
    try {
      if (selected && selected.name){
        const directory = await getEmailDirectory(db);
        myAddress = resolveEmailForCharacter(selected, directory);
        directorDivisions = getDirectorDivisions();
        sendAsAddresses = buildSendAsAddresses(directorDivisions, selected, user);
        updateSendAsOptions();
      } else if (user && user.email){
        myAddress = user.email;
        directorDivisions = [];
        sendAsAddresses = buildSendAsAddresses(directorDivisions, selected, user);
      } else {
        myAddress = '';
        directorDivisions = [];
        sendAsAddresses = [];
      }
    } catch(err){
      console.error('Failed to resolve character email:', err);
      // Fallback: use simple name-based email or user email
      if(selected && selected.name){
        const baseLocal = baseLocalFromName(selected.name);
        myAddress = baseLocal ? `${baseLocal}@site89.org` : (user && user.email ? user.email : '');
      } else {
        myAddress = user && user.email ? user.email : '';
      }
      directorDivisions = selected ? getDirectorDivisions() : [];
      sendAsAddresses = buildSendAsAddresses(directorDivisions, selected, user);
      updateSendAsOptions();
    }

    myAddress = (myAddress || '').toLowerCase();
    myAddressEl.textContent = myAddress || 'Not signed in';

    if(!myAddress){
      // no identity; show notice and stop any active listener
      messagesContainer.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-light);opacity:0.7">Select a character from your account first to use Mail.</div>';
      showEmptyState();
      if (emailsUnsubscribe){ emailsUnsubscribe(); emailsUnsubscribe = null; }
      return;
    }

    await maybeShowDiscordLinkPrompt(user);

    await ensureSampleData();
    startRealtimeMessages();
    setupMobileNavigation();
  });

});