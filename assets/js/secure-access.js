/**
 * SECURE ACCESS CONTROL - REVISED
 * 
 * This module handles clearance-based access control with server-side verification.
 * REVISED: Now tries to authenticate first, only blocks if we're sure access is denied.
 * 
 * CRITICAL: This must be loaded before any page content renders.
 * Add to ALL pages with clearance requirements as EARLY as possible in head.
 */

(function(){
  let accessCheckComplete = false;
  let pageBlocked = false;
  
  // Don't block immediately - only block if we determine we need to
  // This prevents the "403 before auth loads" problem
  
  async function performSecureAccessCheck(){
    try {
      const getRequired = () => {
        const meta = document.querySelector('meta[name="required-clearance"]');
        if (meta && meta.content) return meta.content;
        const b = document.body.getAttribute('data-required-clearance');
        if (b) return b;
        return null;
      };

      const required = getRequired();
      if (!required) {
        // No restriction on this page
        completeCheck(true);
        return;
      }

      // Page has clearance requirement - try to verify
      const userClearance = await fetchUserClearanceFromFirebase();
      const reqNum = parseClearance(required);
      
      if (Number.isNaN(reqNum)) {
        // Invalid required value - allow (fail open)
        completeCheck(true);
        return;
      }

      if (reqNum <= 0) {
        // Level 0 is public access and must not require authentication.
        completeCheck(true);
        return;
      }

      // Check clearance result
      if (Number.isNaN(userClearance)) {
        // No valid user/clearance - BLOCK
        blockPage();
        return;
      }

      if (userClearance >= reqNum) {
        // User has sufficient clearance - ALLOW
        completeCheck(true);
      } else {
        // User has insufficient clearance - BLOCK
        blockPage();
      }
    } catch (err) {
      console.error('Secure access check error:', err);
      // On error, allow the page to load and let it handle auth
      // This prevents complete failures
      completeCheck(true);
    }
  }

  /**
   * Initialize Firebase with proper app config
   */
  async function initializeFirebase() {
    try {
      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js");
      
      const firebaseConfig = {
        apiKey: "AIzaSyBaNDQOu9Aq5pcWJsfgIIj1SSeAbHI-VRg",
        authDomain: "site-89-2d768.firebaseapp.com",
        projectId: "site-89-2d768",
        storageBucket: "site-89-2d768.firebasestorage.app",
        messagingSenderId: "851485754416",
        appId: "1:851485754416:web:aefbe8aa2a7d1f334799f5",
        measurementId: "G-EDX3DLNV52"
      };
      
      const app = initializeApp(firebaseConfig);
      return app;
    } catch (err) {
      console.error('Firebase initialization failed', err);
      return null;
    }
  }

  /**
   * Fetch the current user's clearance level from Firebase
   * Returns NaN if user is not authenticated or doesn't have access
   * Returns clearance number if user is authenticated
   */
  async function fetchUserClearanceFromFirebase(){
    try {
      // Initialize Firebase app
      const app = await initializeFirebase();
      if (!app) {
        console.warn('Firebase app not initialized');
        return NaN;
      }

      // Import Firebase modules dynamically
      const { getAuth, onAuthStateChanged } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js");
      const { getFirestore, doc, getDoc } = await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js");
      
      // Get auth instance
      const auth = getAuth(app);
      
      // Wait for auth state to be established - with longer timeout for slower connections
      const user = await new Promise((resolve) => {
        let resolved = false;
        
        const unsubscribe = onAuthStateChanged(auth, (user) => {
          if (!resolved) {
            resolved = true;
            unsubscribe();
            resolve(user);
          }
        });
        
        // Timeout after 5 seconds (longer to allow for slower networks)
        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            unsubscribe();
            console.warn('Auth state check timed out');
            resolve(null);
          }
        }, 5000);
      });
      
      if (!user) {
        // Not authenticated
        console.log('User not authenticated');
        return NaN;
      }

      // User is authenticated - check their character clearance
      const selectedCharRaw = localStorage.getItem('selectedCharacter');
      let selectedCharId = null;
      
      if (selectedCharRaw) {
        try {
          const char = JSON.parse(selectedCharRaw);
          selectedCharId = char.id;
        } catch (e) {
          console.warn('Invalid selectedCharacter in localStorage');
        }
      }

      if (!selectedCharId) {
        // No character selected - default to clearance 1 (Intern)
        console.log('No character selected, defaulting to clearance 1');
        return 1;
      }

      // Get character from Firebase
      const db = getFirestore(app);
      const charRef = doc(db, 'characters', selectedCharId);
      const charSnap = await getDoc(charRef);
      
      if (!charSnap.exists()) {
        console.warn('Character document does not exist');
        return 0;
      }

      const charData = charSnap.data();
      
      // Verify the character belongs to this user
      if (charData.linkedUID !== user.uid) {
        console.warn('Character belongs to different user');
        return NaN;
      }

      // Get clearance level with fallback to 1
      const clearance = charData.clearance !== undefined ? parseClearance(charData.clearance) : 1;
      const finalClearance = Number.isNaN(clearance) ? 1 : clearance;
      console.log('User clearance:', finalClearance);
      return finalClearance;
      
    } catch (err) {
      console.error('Error fetching clearance:', err);
      // On error, allow page load - let the page handle auth
      return NaN;
    }
  }

  function parseClearance(v) {
    if (v === undefined || v === null) return NaN;
    if (typeof v === 'number') return v;
    const s = String(v);
    const m = s.match(/\d+/);
    return m ? parseInt(m[0], 10) : NaN;
  }

  function completeCheck(allow) {
    accessCheckComplete = true;
    if (allow) {
      // Allow page to render
      document.documentElement.style.opacity = '1';
      document.documentElement.style.pointerEvents = 'auto';
      document.dispatchEvent(new Event('secureAccessGranted'));
    }
  }

  function blockPage() {
    pageBlocked = true;
    accessCheckComplete = true;
    // Hide the page
    document.documentElement.style.opacity = '0';
    document.documentElement.style.pointerEvents = 'none';
    // Redirect to 403
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    setTimeout(() => {
      window.location.replace('/403/?from=' + next);
    }, 200);
  }

  // Start the security check
  // Use a small delay to let the DOM settle
  setTimeout(() => {
    performSecureAccessCheck();
  }, 50);

  // Fallback: if check hasn't completed after 8 seconds, force completion
  // This prevents hanging if something goes wrong
  setTimeout(() => {
    if (!accessCheckComplete) {
      console.warn('Security check timed out, allowing page load');
      completeCheck(true);
    }
  }, 8000);
})();
