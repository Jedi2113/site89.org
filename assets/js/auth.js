import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import { 
  getAuth, 
  onAuthStateChanged, 
  signInWithEmailAndPassword, 
  signOut, 
  createUserWithEmailAndPassword,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";

const firebaseConfig = {
  // If you're reading this you are very naughty, please go back to your own project :)
  //Seriously, get out of here, this is not your code to see.
  apiKey: "AIzaSyBaNDQOu9Aq5pcWJsfgIIj1SSeAbHI-VRg",
  authDomain: "site-89-2d768.firebaseapp.com",
  projectId: "site-89-2d768",
  storageBucket: "site-89-2d768.firebasestorage.app",
  messagingSenderId: "851485754416",
  appId: "1:851485754416:web:aefbe8aa2a7d1f334799f5",
  measurementId: "G-EDX3DLNV52"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Initialize OAuth Providers
const googleProvider = new GoogleAuthProvider();

export { app, auth, onAuthStateChanged, googleProvider, signInWithPopup };

document.addEventListener("includesLoaded", () => {
  const navAccountsText = document.querySelector("#navAccountsBtn span");
  const navAccountsDropdown = document.getElementById("navAccountsDropdown");

  onAuthStateChanged(auth, (user) => {
    let displayName = "Login";
    let isLoggedIn = false;
    
    if (user) {
      isLoggedIn = true;
      const selectedChar = localStorage.getItem("selectedCharacter");
      if (selectedChar) {
        try {
          const charObj = JSON.parse(selectedChar);
          const parts = charObj.name.split(" ");
          displayName = parts.length >= 2 ? `${parts[0][0]}. ${parts[parts.length - 1]}` : charObj.name;
        } catch {
          displayName = user.email;
        }
      } else {
        displayName = user.email;
      }
    }
    if (navAccountsText) navAccountsText.textContent = displayName;
    
    const clampAccountsDropdown = () => {
      if (!navAccountsDropdown || navAccountsDropdown.classList.contains('hidden')) return;

      const padding = 12;
      navAccountsDropdown.style.left = 'auto';
      navAccountsDropdown.style.right = '0';
      navAccountsDropdown.style.maxWidth = `calc(100vw - ${padding * 2}px)`;

      const rect = navAccountsDropdown.getBoundingClientRect();
      if (rect.right > window.innerWidth - padding) {
        navAccountsDropdown.style.right = `${padding}px`;
        navAccountsDropdown.style.left = 'auto';
      }
      if (rect.left < padding) {
        navAccountsDropdown.style.left = `${padding}px`;
        navAccountsDropdown.style.right = 'auto';
      }
    };

    // Update button href based on login status
    let navAccountsBtn = document.getElementById("navAccountsBtn");
    if (navAccountsBtn) {
      if (isLoggedIn) {
        // Link to character select for logged-in users
        navAccountsBtn.href = '/character-select/';
      } else {
        // Link to login for non-logged-in users
        navAccountsBtn.href = '/login/';
      }
    }

    window.addEventListener('resize', clampAccountsDropdown);
  });

  Array.from(document.querySelectorAll('#logoutBtn')).forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try { localStorage.removeItem('selectedCharacter'); } catch (err) { }
      signOut(auth).then(() => window.location.href = '/login/').catch(() => window.location.href = '/login/');
    });
  });

  // Monitor selected character status - kick out users if character becomes inactive/archived
  (async () => {
    // Create modal for character disabled notification
    const createDisabledModal = (characterName, reason, onOkayClick) => {
      // Remove existing modal if any
      const existing = document.getElementById('characterDisabledModal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'characterDisabledModal';
      modal.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0,0,0,0.85);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        animation: fadeIn 0.3s ease;
      `;

      modal.innerHTML = `
        <div style="
          background: linear-gradient(135deg, #1a1a1a 0%, #2a2a2a 100%);
          border: 2px solid #ff6b6b;
          border-radius: 12px;
          padding: 2rem;
          max-width: 500px;
          width: 90%;
          box-shadow: 0 10px 40px rgba(255,107,107,0.3);
          animation: slideUp 0.3s ease;
        ">
          <div style="text-align: center; margin-bottom: 1.5rem;">
            <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: #ff6b6b;"></i>
          </div>
          <h2 style="
            font-family: var(--font-head, 'Montserrat', sans-serif);
            color: #ff6b6b;
            text-align: center;
            margin: 0 0 1rem 0;
            font-size: 1.5rem;
          ">Character Disabled</h2>
          <p style="
            color: rgba(255,255,255,0.9);
            text-align: center;
            line-height: 1.6;
            margin: 1rem 0;
            font-size: 1.1rem;
          ">
            Your character <strong style="color: var(--accent-mint, #4efaaa);">${characterName}</strong> has been disabled.
          </p>
          ${reason ? `
            <div style="
              background: rgba(255,107,107,0.1);
              border-left: 3px solid #ff6b6b;
              padding: 1rem;
              margin: 1rem 0;
              border-radius: 4px;
            ">
              <p style="
                color: rgba(255,255,255,0.7);
                margin: 0 0 0.5rem 0;
                font-size: 0.9rem;
                text-transform: uppercase;
                letter-spacing: 0.5px;
              ">Reason:</p>
              <p style="
                color: rgba(255,255,255,0.95);
                margin: 0;
                line-height: 1.5;
              ">${reason}</p>
            </div>
          ` : ''}
          <div id="modalActionArea" style="text-align: center; margin-top: 1.5rem;">
            <button id="modalOkayBtn" style="
              background: var(--accent-mint, #4efaaa);
              color: #0a0a0a;
              border: none;
              padding: 0.75rem 2rem;
              border-radius: 6px;
              font-weight: 600;
              font-size: 1rem;
              cursor: pointer;
              transition: all 0.2s ease;
              font-family: var(--font-head, 'Montserrat', sans-serif);
            " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
              Okay
            </button>
          </div>
        </div>
        <style>
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes slideUp {
            from { transform: translateY(30px); opacity: 0; }
            to { transform: translateY(0); opacity: 1; }
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      `;

      document.body.appendChild(modal);
      
      // Attach button click handler
      const okayBtn = document.getElementById('modalOkayBtn');
      if (okayBtn && onOkayClick) {
        okayBtn.addEventListener('click', onOkayClick);
      }
      
      return modal;
    };

    const showModalLoadingState = () => {
      const actionArea = document.getElementById('modalActionArea');
      if (actionArea) {
        actionArea.innerHTML = `
          <p style="
            color: rgba(255,255,255,0.7);
            text-align: center;
            font-size: 0.95rem;
            margin: 0 0 1rem 0;
          " id="modalRedirectText">Switching to another character...</p>
          <div style="text-align: center;">
            <div class="spinner" style="
              border: 3px solid rgba(255,255,255,0.1);
              border-top: 3px solid var(--accent-mint, #4efaaa);
              border-radius: 50%;
              width: 30px;
              height: 30px;
              animation: spin 1s linear infinite;
              margin: 0 auto;
            "></div>
          </div>
        `;
      }
    };

    const checkCharacterStatus = async () => {
      try {
        const selectedCharJson = localStorage.getItem('selectedCharacter');
        if (!selectedCharJson) return; // No character selected

        const selectedChar = JSON.parse(selectedCharJson);
        if (!selectedChar || !selectedChar.id) return;

        // Import Firestore for character lookup
        const { getFirestore, doc, getDoc } = await import('https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js');
        const db = getFirestore(app);
        
        const charRef = doc(db, 'characters', selectedChar.id);
        const charSnap = await getDoc(charRef);

        if (!charSnap.exists()) {
          // Character deleted
          localStorage.removeItem('selectedCharacter');
          if (window.location.pathname !== '/character-select/' && window.location.pathname !== '/login/') {
            const handleDeletedCharacter = async () => {
              showModalLoadingState();
              await new Promise(resolve => setTimeout(resolve, 1000));
              window.location.href = '/character-select/';
            };
            createDisabledModal(selectedChar.name, 'This character has been deleted.', handleDeletedCharacter);
          }
          return;
        }

        const charData = charSnap.data();
        const status = (charData.status || 'active').toLowerCase();

        if (status !== 'active') {
          // Character is inactive or archived - show modal and wait for user to click Okay
          const characterName = selectedChar.name || 'Unknown';
          const reason = charData.disableReason || 'No reason provided.';
          
          // Define what happens when user clicks "Okay"
          const handleOkayClick = async () => {
            showModalLoadingState();
            localStorage.removeItem('selectedCharacter');
            
            try {
              const { autoSelectFirstCharacter } = await import('/assets/js/character-auto-select.js');
              const user = auth.currentUser;
              if (user) {
                const newChar = await autoSelectFirstCharacter(user.uid);
                if (newChar) {
                  // Successfully switched to another character
                  const modalText = document.getElementById('modalRedirectText');
                  if (modalText) {
                    modalText.textContent = `Switched to ${newChar.name}`;
                  }
                  await new Promise(resolve => setTimeout(resolve, 1500));
                  window.location.reload();
                  return;
                }
              }
            } catch (err) {
              console.error('Failed to auto-select another character:', err);
            }

            // No other characters available, redirect to character select
            const modalText = document.getElementById('modalRedirectText');
            if (modalText) {
              modalText.textContent = 'You have no other active characters. Redirecting to character select...';
            }
            await new Promise(resolve => setTimeout(resolve, 1500));
            
            if (window.location.pathname !== '/character-select/' && window.location.pathname !== '/login/') {
              window.location.href = '/character-select/';
            }
          };
          
          createDisabledModal(characterName, reason, handleOkayClick);
        }
      } catch (err) {
        // Silently fail on check to avoid disrupting user experience
        console.debug('Character status check failed (this is normal):', err.message);
      }
    };

    // Check on page load
    checkCharacterStatus();

    // Check every 30 seconds while page is open
    setInterval(checkCharacterStatus, 30000);
  })();

  const loginForm = document.getElementById("loginForm");
  if (loginForm) {
    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = document.getElementById("email").value;
      const password = document.getElementById("password").value;
      signInWithEmailAndPassword(auth, email, password)
        .then(() => window.location.href = "/")
        .catch(err => {
          const feedback = document.getElementById("loginFeedback");
          if (feedback) feedback.textContent = err.message;
        });
    });
  }

  const registerForm = document.getElementById("registerForm");
  if (registerForm) {
    registerForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const email = document.getElementById("regEmail").value;
      const password = document.getElementById("regPassword").value;
      createUserWithEmailAndPassword(auth, email, password)
        .then(() => window.location.href = "/")
        .catch(err => {
          const feedback = document.getElementById("registerFeedback");
          if (feedback) feedback.textContent = err.message;
        });
    });
  }
});
