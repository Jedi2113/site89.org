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
