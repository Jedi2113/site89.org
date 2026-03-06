/**
 * Character Auto-Selection and Validation Utility
 * Handles:
 * 1. Auto-selecting first active character (alphabetically) on login
 * 2. Kicking out users with disabled characters
 * 3. Redirecting to character-select if character becomes inactive
 */

import { app, auth, onAuthStateChanged } from "/assets/js/auth.js";
import { getFirestore, collection, query, where, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore(app);

/**
 * Gets all active characters for a user and returns them sorted alphabetically
 * @param {string} uid User ID
 * @returns {Promise<Array>} Array of character objects sorted by name
 */
export async function getUserActiveCharacters(uid) {
  if (!uid) return [];

  try {
    const charQuery = query(
      collection(db, "characters"),
      where("linkedUID", "==", uid)
    );
    const charSnap = await getDocs(charQuery);
    
    const allCharacters = charSnap.docs.map(doc => ({
      ...doc.data(),
      id: doc.id
    }));

    // Filter for active characters (same logic as character-select page)
    const characters = allCharacters.filter(char => {
      const status = (char.status || 'active').toLowerCase();
      return status === 'active';
    });

    // Sort alphabetically by name
    characters.sort((a, b) => {
      const nameA = (a.name || "").toLowerCase();
      const nameB = (b.name || "").toLowerCase();
      return nameA.localeCompare(nameB);
    });

    return characters;
  } catch (err) {
    console.error("Failed to fetch user characters:", err);
    return [];
  }
}

/**
 * Validates that the currently selected character is still active
 * If not, clears the selection and returns false
 * @param {Object} selectedChar Currently selected character from localStorage
 * @returns {Promise<boolean>} True if character is valid and active, false otherwise
 */
export async function validateCurrentCharacter(selectedChar) {
  if (!selectedChar || !selectedChar.id) return false;

  try {
    const charRef = doc(db, "characters", selectedChar.id);
    const charSnap = await getDoc(charRef);

    if (!charSnap.exists()) return false;

    const charData = charSnap.data();
    const status = (charData.status || "active").toLowerCase();

    if (status !== "active") {
      // Character is disabled - clear selection
      try {
        localStorage.removeItem("selectedCharacter");
      } catch (err) {
        console.error("Failed to clear selected character:", err);
      }
      return false;
    }

    return true;
  } catch (err) {
    console.error("Failed to validate current character:", err);
    return false;
  }
}

/**
 * Monitors selected character for changes (e.g., deactivation)
 * If character becomes inactive, redirects to character-select
 * @param {string} characterId Character ID to monitor
 * @param {Object} options Configuration options
 * @param {string} options.redirectUrl URL to redirect to if character becomes invalid
 * @param {Function} options.onInactive Callback when character becomes inactive
 */
export function monitorCharacterStatus(characterId, options = {}) {
  const { redirectUrl = "/character-select/", onInactive = null } = options;

  if (!characterId) return;

  const checkInterval = setInterval(async () => {
    try {
      const charRef = doc(db, "characters", characterId);
      const charSnap = await getDoc(charRef);

      if (!charSnap.exists()) {
        // Character deleted
        clearInterval(checkInterval);
        try {
          localStorage.removeItem("selectedCharacter");
        } catch (err) {}
        if (onInactive) onInactive("Character was deleted");
        window.location.href = redirectUrl;
        return;
      }

      const charData = charSnap.data();
      const status = (charData.status || "active").toLowerCase();

      if (status !== "active") {
        // Character became inactive
        clearInterval(checkInterval);
        try {
          localStorage.removeItem("selectedCharacter");
        } catch (err) {}
        if (onInactive) onInactive(`Character is now ${status}`);
        window.location.href = redirectUrl;
      }
    } catch (err) {
      console.error("Error monitoring character status:", err);
    }
  }, 5000); // Check every 5 seconds
}

/**
 * Auto-selects the first active character (alphabetically) if user has no selection
 * Handles initial login flow to automatically assign character
 * @param {string} uid User ID
 * @returns {Promise<Object|null>} Selected character or null if none available
 */
export async function autoSelectFirstCharacter(uid) {
  if (!uid) return null;

  // Check if character is already selected
  try {
    const stored = localStorage.getItem("selectedCharacter");
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && parsed.id && parsed.name) {
        // Validate it's still active
        const isValid = await validateCurrentCharacter(parsed);
        if (isValid) {
          return parsed; // Already selected and valid
        }
      }
    }
  } catch (err) {
    // Invalid stored character - clear it
    try {
      localStorage.removeItem("selectedCharacter");
    } catch (e) {}
  }

  // No valid selection - get first active character
  const characters = await getUserActiveCharacters(uid);

  if (characters.length === 0) {
    // No active characters available
    return null;
  }

  const firstChar = characters[0];
  const charData = {
    id: firstChar.id,
    name: firstChar.name,
    pid: firstChar.pid,
    department: firstChar.department,
    clearance: firstChar.clearance,
    status: firstChar.status
  };

  // Auto-select first character
  try {
    localStorage.setItem("selectedCharacter", JSON.stringify(charData));
  } catch (err) {
    console.error("Failed to store character selection:", err);
  }

  return charData;
}

/**
 * Sets up auto-selection and monitoring for logged-in users
 * Call this on pages that need character validation
 * @param {Function} onCharacterSelected Callback when character is automatically selected
 * @param {Function} onCharacterRequired Callback when character selection is required
 */
export function setupCharacterAutoSelection(onCharacterSelected, onCharacterRequired) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Not logged in
      return;
    }

    // User is logged in - auto-select if needed
    const selectedChar = await autoSelectFirstCharacter(user.uid);

    if (!selectedChar) {
      // No active characters - require selection
      if (onCharacterRequired) {
        onCharacterRequired(user);
      }
      return;
    }

    // Character selected successfully
    if (onCharacterSelected) {
      onCharacterSelected(selectedChar, user);
    }

    // Start monitoring for character status changes
    monitorCharacterStatus(selectedChar.id, {
      onInactive: (reason) => {
        console.warn("Character became inactive:", reason);
      }
    });
  });
}
