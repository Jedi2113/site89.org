// Navbar functionality - accounts, theme, mail, search
import { app, auth } from '/assets/js/auth.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, collection, getDocs } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';
import { calculateMerit, meritTitle } from '/assets/js/merit.js';

const db = getFirestore(app);

// Site-wide search data
const sitePages = [
  { title: 'Home', url: '/', type: 'page' },
  { title: 'About Site-89', url: '/about/', type: 'page' },
  { title: 'Departments', url: '/departments/', type: 'page' },
  { title: 'Personnel Files', url: '/personnel-files/', type: 'page' },
  { title: 'Anomalies', url: '/anomalies/', type: 'page' },
  { title: 'Research Logs', url: '/research-logs/', type: 'page' },
  { title: 'Incident Reports', url: '/incident-reports/', type: 'page' },
  { title: 'Newsletter', url: '/newsletter/', type: 'page' },
  { title: 'Forum', url: '/forum/', type: 'page' },
  { title: 'Articles', url: '/articles/', type: 'page' },
  { title: 'Gallery', url: '/gallery/', type: 'page' },
  { title: 'Rules & Guidelines', url: '/rules/', type: 'page' },
  { title: 'Guides', url: '/guides/', type: 'page' },
  { title: 'Roadmap', url: '/roadmap/', type: 'page' },
  { title: 'Feedback', url: '/feedback/', type: 'page' },
  { title: 'Administrative Department', url: '/departments/AD/', type: 'department' },
  { title: 'Department of External Operations', url: '/departments/DEO/', type: 'department' },
  { title: 'Scientific Department', url: '/departments/ScD/', type: 'department' },
  { title: 'Security Department', url: '/departments/SD/', type: 'department' }
];

let searchableData = [...sitePages];
let searchTimeout = null;

// Load dynamic search data (characters, anomalies)
async function loadSearchData() {
  try {
    // Load characters
    const charactersSnap = await getDocs(collection(db, 'characters'));
    charactersSnap.forEach(doc => {
      const char = doc.data();
      searchableData.push({
        title: char.name || 'Unknown',
        url: `/personnel-files/#${doc.id}`,
        type: 'personnel',
        subtitle: `${char.rank || ''} - Level ${char.clearance || 1}`
      });
    });
  } catch (e) {
    console.warn('Could not load search data:', e);
  }
}

// Initialize search
const searchInput = document.getElementById('siteSearchInput');
const searchResults = document.getElementById('siteSearchResults');

if (searchInput && searchResults) {
  // Load data on init
  loadSearchData();
  
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    const query = e.target.value.trim().toLowerCase();
    
    if (!query) {
      searchResults.innerHTML = '';
      searchResults.setAttribute('aria-hidden', 'true');
      return;
    }
    
    searchTimeout = setTimeout(() => {
      performSearch(query);
    }, 300);
  });
  
  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!searchInput.contains(e.target) && !searchResults.contains(e.target)) {
      searchResults.innerHTML = '';
      searchResults.setAttribute('aria-hidden', 'true');
    }
  });
}

// Perform search
function performSearch(query) {
  const results = searchableData.filter(item => 
    item.title.toLowerCase().includes(query) ||
    item.subtitle?.toLowerCase().includes(query)
  ).slice(0, 8); // Limit to 8 results
  
  if (results.length === 0) {
    searchResults.innerHTML = '<div style="padding: 1rem; color: var(--text-light); opacity: 0.6;">No results found</div>';
    searchResults.setAttribute('aria-hidden', 'false');
    return;
  }
  
  const typeIcons = {
    'page': 'fa-file',
    'personnel': 'fa-user',
    'department': 'fa-building',
    'anomaly': 'fa-flask'
  };
  
  searchResults.innerHTML = results.map(result => `
    <a href="${result.url}" class="search-result-item">
      <i class="fas ${typeIcons[result.type] || 'fa-file'}"></i>
      <div>
        <div class="search-result-title">${escapeHtml(result.title)}</div>
        ${result.subtitle ? `<div class="search-result-subtitle">${escapeHtml(result.subtitle)}</div>` : ''}
      </div>
    </a>
  `).join('');
  
  searchResults.setAttribute('aria-hidden', 'false');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatCompactNumber(value) {
  if (value >= 1000) {
    const compact = (value / 1000).toFixed(value % 1000 === 0 ? 0 : 1);
    return `${compact}k`;
  }
  return String(value);
}

// Account management
onAuthStateChanged(auth, async (user) => {
  const accountsText = document.getElementById('navAccountsText');
  const accountsBtn = document.getElementById('navAccountsBtn');
  const accountsDropdown = document.getElementById('navAccountsDropdown');
  const logoutBtn = document.getElementById('logoutBtn');
  const orientationLink = document.getElementById('orientationLink');
  const chevron = accountsBtn?.querySelector('.nav-chevron');
  
  if (user) {
    // Check for selected character
    const selectedCharRaw = localStorage.getItem('selectedCharacter');
    if (selectedCharRaw) {
      try {
        const char = JSON.parse(selectedCharRaw);
        accountsText.textContent = char.name || user.email.split('@')[0];
        
        // Show orientation for new characters
        if (char.clearance === 1 || char.department === 'Unassigned') {
          orientationLink.style.display = 'flex';
        }
      } catch (e) {
        accountsText.textContent = user.email.split('@')[0];
      }
    } else {
      accountsText.textContent = user.email.split('@')[0];
    }
    
    // Show merit score in dropdown
    const meritDisplay = document.getElementById('navMeritDisplay');
    const meritScore   = document.getElementById('navMeritScore');
    const meritTier    = document.getElementById('navMeritTier');
    try {
      const merit = await calculateMerit(user.uid);
      if (meritDisplay && meritScore && meritTier) {
        meritScore.textContent = formatCompactNumber(merit);
        meritTier.textContent  = meritTitle(merit);
        meritDisplay.style.display = 'flex';
      }
    } catch {
      if (meritDisplay && meritScore && meritTier) {
        meritScore.textContent = '0';
        meritTier.textContent = 'Newcomer';
        meritDisplay.style.display = 'flex';
      }
    }

    // Logout handler
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        await auth.signOut();
        window.location.href = '/';
      });
    }
    
    // Enable dropdown functionality for logged-in users
    if (accountsBtn && chevron) {
      accountsBtn.style.cursor = 'pointer';
      chevron.style.display = 'inline';
      accountsBtn.classList.remove('login-button');
    }
  } else {
    accountsText.textContent = 'Login';
    if (accountsDropdown) {
      accountsDropdown.classList.add('hidden');
    }
    
    // Convert button to simple login link for non-logged-in users
    if (accountsBtn && chevron) {
      accountsBtn.style.cursor = 'pointer';
      chevron.style.display = 'none';
      accountsBtn.classList.add('login-button');
      accountsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.location.href = '/login/';
      });
    }
  }
});

// Accounts dropdown toggle (only for logged-in users)
const accountsBtn2 = document.getElementById('navAccountsBtn');
const accountsDropdown2 = document.getElementById('navAccountsDropdown');

if (accountsBtn2 && accountsDropdown2) {
  // Initialize with check for logged-in state
  let isLoggedIn2 = false;
  onAuthStateChanged(auth, (user) => {
    isLoggedIn2 = !!user;
  });
  
  accountsBtn2.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isLoggedIn2) {
      accountsDropdown2.classList.toggle('hidden');
    }
  });
  
  document.addEventListener('click', () => {
    accountsDropdown2.classList.add('hidden');
  });
}

// Theme toggle
import { ThemeManager } from '/assets/js/theme.js';

const themeToggleBtn = document.getElementById('themeToggleBtn');
if (themeToggleBtn) {
  themeToggleBtn.addEventListener('click', () => {
    ThemeManager.toggle();
  });
}

// Mobile menu toggle
const navToggle = document.getElementById('navToggle');
const mobileMenu = document.getElementById('mobileMenu');

if (navToggle && mobileMenu) {
  navToggle.addEventListener('click', () => {
    const isHidden = mobileMenu.classList.toggle('hidden');
    navToggle.setAttribute('aria-expanded', !isHidden);
    mobileMenu.setAttribute('aria-hidden', isHidden);
  });
}

// Clocks
function updateClocks() {
  const localClock = document.getElementById('localClock');
  const siteClock = document.getElementById('siteClock');
  
  if (localClock) {
    const local = new Date().toLocaleTimeString('en-US', { hour12: false });
    localClock.textContent = local;
  }
  
  if (siteClock) {
    const site = new Date().toLocaleTimeString('en-US', { 
      timeZone: 'America/New_York',
      hour12: false 
    });
    siteClock.textContent = site;
  }
}

updateClocks();
setInterval(updateClocks, 1000);
