/**
 * Admin User Manager
 * Manages user accounts, privileges, and character assignments
 * Replaces hardcoded email-based access control with role-based system
 */

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js";
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  getDocs, 
  getDoc, 
  deleteDoc, 
  updateDoc, 
  query, 
  where,
  serverTimestamp,
  arrayUnion,
  arrayRemove
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const SYSTEM_ADMIN_CHARACTER = {
  id: 'system-admin-unrestricted',
  name: 'System Admin',
  linkedUID: null, // Set dynamically per admin
  clearance: 5,
  department: 'Administration',
  rank: 'System Administrator',
  isSystemAdmin: true,
  hidden: true // Don't show in character lists
};

const PRIVILEGE_LEVELS = {
  USER: 'user',
  RAISA: 'raisa',
  ADMIN: 'admin'
};

const PRIVILEGE_LABELS = {
  user: 'User',
  raisa: 'RAISA Personnel',
  admin: 'Administrator'
};

const DEFAULT_ADMIN_EMAIL = 'jedi21132@gmail.com';

document.addEventListener('includesLoaded', () => {
  const auth = getAuth();
  const db = getFirestore();

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.replace('/login/');
      return;
    }

    // Check if user has admin role
    const userDocRef = doc(db, 'users', user.uid);
    const userDocSnap = await getDoc(userDocRef);
    
    if (!userDocSnap.exists()) {
      // User doesn't exist in users collection
      window.location.replace('/403/');
      return;
    }

    const userData = userDocSnap.data();
    if (userData.role !== PRIVILEGE_LEVELS.ADMIN) {
      // User is not an admin
      window.location.replace('/403/');
      return;
    }

    console.log('Admin access granted for', user.email);

    // Initialize the user manager
    initializeUserManager(db, auth);
  });

  async function initializeUserManager(db, auth) {
    const usersContainer = document.getElementById('usersContainer');
    const userSearchInput = document.getElementById('userSearchInput');
    const userFilterSelect = document.getElementById('userFilterSelect');
    const initButton = document.getElementById('initializeUsersBtn');

    let allUsers = [];

    /**
     * Load all users and display them
     * Includes both initialized users (with user documents) and uninitialized users (with characters but no user doc)
     */
    async function loadUsers() {
      try {
        const usersSnap = await getDocs(collection(db, 'users'));
        const uniqueUids = new Map();

        // First, add all users from users collection
        for (const userDoc of usersSnap.docs) {
          const userData = userDoc.data();
          uniqueUids.set(userDoc.id, {
            uid: userDoc.id,
            email: userData.email || 'Unknown',
            role: userData.role || PRIVILEGE_LEVELS.USER,
            characters: [],
            createdAt: userData.createdAt,
            initialized: true
          });
        }

        // Then, find all characters with linkedUIDs (including those without user documents)
        const charactersSnap = await getDocs(collection(db, 'characters'));
        for (const charDoc of charactersSnap.docs) {
          const charData = charDoc.data();
          if (charData.linkedUID && !charData.hidden) {
            if (!uniqueUids.has(charData.linkedUID)) {
              // User doesn't have a user document yet - create placeholder
              uniqueUids.set(charData.linkedUID, {
                uid: charData.linkedUID,
                email: 'Not initialized',
                role: 'user',
                characters: [],
                createdAt: null,
                initialized: false
              });
            }
            // Add character to this user
            uniqueUids.get(charData.linkedUID).characters.push(charData.name);
          }
        }

        // Convert to array and sort
        allUsers = Array.from(uniqueUids.values());
        allUsers.forEach(user => user.characters.sort());
        allUsers.sort((a, b) => a.email.localeCompare(b.email));

        // Render users
        renderUsers(allUsers);
      } catch (error) {
        console.error('Error loading users:', error);
        usersContainer.innerHTML = `<div class="error-box">Error loading users: ${escapeHtml(error.message)}</div>`;
      }
    }

    /**
     * Render users table
     */
    function renderUsers(usersToShow) {
      if (usersToShow.length === 0) {
        usersContainer.innerHTML = '<div class="info-box">No users found.</div>';
        return;
      }

      const html = `
        <table class="users-table" style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="border-bottom:2px solid rgba(255,255,255,0.1);">
              <th style="text-align:left;padding:0.8rem;font-weight:600;">Email</th>
              <th style="text-align:left;padding:0.8rem;font-weight:600;">UID</th>
              <th style="text-align:left;padding:0.8rem;font-weight:600;">Assigned Characters</th>
              <th style="text-align:center;padding:0.8rem;font-weight:600;">Privilege Level</th>
              <th style="text-align:center;padding:0.8rem;font-weight:600;">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${usersToShow.map(user => `
              <tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:0.8rem;"><span style="font-family:monospace;font-size:0.9em;">${escapeHtml(user.email)}</span>${!user.initialized ? '<small style="display:block;color:var(--accent-orange);margin-top:0.2rem;">(Needs login)</small>' : ''}</td>
                <td style="padding:0.8rem;"><code style="font-size:0.85em;color:var(--accent-mint);">${escapeHtml(user.uid.substring(0, 12))}...</code></td>
                <td style="padding:0.8rem;">
                  ${user.characters.length > 0 
                    ? `<small>${user.characters.map(c => escapeHtml(c)).join(', ')}</small>`
                    : '<small style="opacity:0.6;"><em>No characters</em></small>'
                  }
                </td>
                <td style="padding:0.8rem;text-align:center;">
                  ${!user.initialized
                    ? `<div style="padding:0.4rem;background:rgba(255,255,255,0.05);color:var(--text-light);border-radius:4px;text-align:center;opacity:0.6;">User</div>`
                    : user.email === DEFAULT_ADMIN_EMAIL
                    ? `<div style="padding:0.4rem;background:var(--accent-gold);color:var(--bg-dark);border-radius:4px;text-align:center;font-weight:600;cursor:not-allowed;">${PRIVILEGE_LABELS.admin} (Default)</div>`
                    : `<select class="privilege-select" data-uid="${escapeHtml(user.uid)}" style="padding:0.4rem;background:var(--bg-card);border:1px solid rgba(255,255,255,0.1);border-radius:4px;color:var(--text-light);cursor:pointer;">
                      <option value="${PRIVILEGE_LEVELS.USER}" ${user.role === PRIVILEGE_LEVELS.USER ? 'selected' : ''}>${PRIVILEGE_LABELS.user}</option>
                      <option value="${PRIVILEGE_LEVELS.RAISA}" ${user.role === PRIVILEGE_LEVELS.RAISA ? 'selected' : ''}>${PRIVILEGE_LABELS.raisa}</option>
                      <option value="${PRIVILEGE_LEVELS.ADMIN}" ${user.role === PRIVILEGE_LEVELS.ADMIN ? 'selected' : ''}>${PRIVILEGE_LABELS.admin}</option>
                    </select>`
                  }
                </td>
                <td style="padding:0.8rem;text-align:center;">
                  ${!user.initialized
                    ? `<div style="padding:0.4rem;opacity:0.5;cursor:not-allowed;color:var(--text-light);">—</div>`
                    : user.email === DEFAULT_ADMIN_EMAIL
                    ? `<div style="padding:0.4rem;opacity:0.5;cursor:not-allowed;color:var(--accent-red);">Protected</div>`
                    : `<button class="delete-user-btn" data-uid="${escapeHtml(user.uid)}" style="padding:0.4rem 0.8rem;background:rgba(255,0,0,0.15);border:1px solid rgba(255,0,0,0.3);color:#ff6b6b;border-radius:4px;cursor:pointer;">Delete</button>`
                  }
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;

      usersContainer.innerHTML = html;

      // Wire up event listeners
      document.querySelectorAll('.privilege-select').forEach(select => {
        select.addEventListener('change', async (e) => {
          const uid = select.dataset.uid;
          const newRole = e.target.value;
          
          // Find the user email to check if it's protected
          const user = allUsers.find(u => u.uid === uid);
          if (user && user.email === DEFAULT_ADMIN_EMAIL) {
            alert('This account is protected and cannot be modified.');
            e.target.value = PRIVILEGE_LEVELS.ADMIN; // Reset to admin
            return;
          }
          
          await updateUserRole(uid, newRole);
        });
      });

      document.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const uid = btn.dataset.uid;
          
          // Find the user email to check if it's protected
          const user = allUsers.find(u => u.uid === uid);
          if (user && user.email === DEFAULT_ADMIN_EMAIL) {
            alert('This account is protected and cannot be deleted.');
            return;
          }
          
          if (confirm('Are you sure you want to delete this user? This cannot be undone.')) {
            await deleteUser(uid);
          }
        });
      });
    }

    /**
     * Update user's privilege level
     * Protected: cannot modify default admin account (jedi21132@gmail.com)
     */
    async function updateUserRole(uid, newRole) {
      try {
        // Check if this is the protected account
        const user = allUsers.find(u => u.uid === uid);
        if (user && user.email === DEFAULT_ADMIN_EMAIL) {
          console.warn('Attempted to modify protected admin account');
          return;
        }
        
        // Check if user is uninitialized
        if (user && !user.initialized) {
          alert('This user must log in first before their role can be changed.');
          return;
        }
        
        const userRef = doc(db, 'users', uid);
        
        if (newRole === PRIVILEGE_LEVELS.ADMIN) {
          // Add System Admin character to admin users
          await createSystemAdminCharacter(uid);
        } else if (newRole !== PRIVILEGE_LEVELS.ADMIN) {
          // Remove System Admin character if role is no longer admin
          await removeSystemAdminCharacter(uid);
        }

        await updateDoc(userRef, {
          role: newRole,
          updatedAt: serverTimestamp()
        });

        // Reload users
        await loadUsers();
      } catch (error) {
        console.error('Error updating user role:', error);
        alert('Error updating user role: ' + error.message);
      }
    }

    /**
     * Create System Admin character for an admin user
     */
    async function createSystemAdminCharacter(uid) {
      try {
        const charDoc = { ...SYSTEM_ADMIN_CHARACTER };
        charDoc.linkedUID = uid;

        await setDoc(doc(db, 'characters', SYSTEM_ADMIN_CHARACTER.id), charDoc, { merge: true });
      } catch (error) {
        console.error('Error creating System Admin character:', error);
      }
    }

    /**
     * Remove System Admin character from user
     */
    async function removeSystemAdminCharacter(uid) {
      try {
        await deleteDoc(doc(db, 'characters', SYSTEM_ADMIN_CHARACTER.id));
      } catch (error) {
        console.error('Error removing System Admin character:', error);
      }
    }

    /**
     * Delete user account
     * Protected: cannot delete default admin account (jedi21132@gmail.com)
     */
    async function deleteUser(uid) {
      try {
        // Check if this is the protected account
        const user = allUsers.find(u => u.uid === uid);
        if (user && user.email === DEFAULT_ADMIN_EMAIL) {
          console.warn('Attempted to delete protected admin account');
          return;
        }
        
        // Delete user document
        await deleteDoc(doc(db, 'users', uid));
        
        // Remove System Admin character if it exists
        try {
          await deleteDoc(doc(db, 'characters', SYSTEM_ADMIN_CHARACTER.id));
        } catch (e) {
          // Ignore if character doesn't exist
        }

        // Reload users
        await loadUsers();
      } catch (error) {
        console.error('Error deleting user:', error);
        alert('Error deleting user: ' + error.message);
      }
    }

    /**
     * Filter users by search term
     */
    function filterUsers() {
      const searchTerm = (userSearchInput.value || '').toLowerCase();
      const filterRole = userFilterSelect.value;

      const filtered = allUsers.filter(user => {
        const matchesSearch = !searchTerm || 
          user.email.toLowerCase().includes(searchTerm) ||
          user.uid.toLowerCase().includes(searchTerm) ||
          user.characters.some(c => c.toLowerCase().includes(searchTerm));

        const matchesFilter = !filterRole || user.role === filterRole;

        return matchesSearch && matchesFilter;
      });

      renderUsers(filtered);
    }

    // Wire up search and filter
    userSearchInput.addEventListener('input', filterUsers);
    userFilterSelect.addEventListener('change', filterUsers);

    // Initialize users button
    if (initButton) {
      initButton.addEventListener('click', async () => {
        if (confirm('This will initialize all existing Firebase auth users in the users collection with User role. Existing users will not be modified. Continue?')) {
          await initializeAllUsers();
        }
      });
    }

    /**
     * Initialize all Firebase auth users that don't exist in users collection
     */
    async function initializeAllUsers() {
      try {
        // Get all characters to find linked UIDs
        const charactersSnap = await getDocs(collection(db, 'characters'));
        const linkedUids = new Set();
        charactersSnap.docs.forEach(doc => {
          const data = doc.data();
          if (data.linkedUID) {
            linkedUids.add(data.linkedUID);
          }
        });

        let initialized = 0;
        const usersSnap = await getDocs(collection(db, 'users'));
        
        for (const uid of linkedUids) {
          const userRef = doc(db, 'users', uid);
          const userSnap = await getDoc(userRef);
          
          if (!userSnap.exists()) {
            // Try to get user from auth email if possible
            try {
              // We can't directly fetch from auth, so we'll just create with User role
              await setDoc(userRef, {
                role: PRIVILEGE_LEVELS.USER,
                createdAt: serverTimestamp()
              });
              initialized++;
            } catch (err) {
              console.error(`Failed to initialize user ${uid}:`, err);
            }
          }
        }

        alert(`Initialized ${initialized} new users with User role.`);
        await loadUsers();
      } catch (error) {
        console.error('Error initializing users:', error);
        alert('Error initializing users: ' + error.message);
      }
    }

    // Load users on initialization
    await loadUsers();
  }
});

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
