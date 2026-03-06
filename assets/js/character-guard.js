/**
 * Character Guard - Enforces that users cannot access character-specific pages without a valid character selected
 * Provides utilities to redirect to character-select and prevent email-based fallbacks
 */

import { auth, onAuthStateChanged } from "/assets/js/auth.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";

const db = getFirestore();

/**
 * Validates that a selected character exists and is valid
 * @returns {Promise<Object|null>} Character data if valid, null otherwise
 */
export async function validateSelectedCharacter(user) {
  if (!user) return null;

  const stored = localStorage.getItem("selectedCharacter");
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    if (!parsed || !parsed.id) return null;

    const charRef = doc(db, "characters", parsed.id);
    const snap = await getDoc(charRef);
    if (!snap.exists()) return null;

    const charData = snap.data();
    // Verify character is linked to current user
    if (!charData || charData.linkedUID !== user.uid) return null;

    // Verify character is active (not archived/inactive)
    const status = (charData.status || "active").toLowerCase();
    if (status !== "active") return null;

    return { ...charData, id: parsed.id };
  } catch (err) {
    console.error("Failed to validate selected character:", err);
    return null;
  }
}

/**
 * Requires a valid character selection before allowing page access
 * If no character is selected, redirects to character-select with optional message
 * @param {Function} callback Function to execute when valid character is confirmed
 * @param {Object} options Configuration options
 * @param {string} options.redirectUrl Override redirect URL (default: /character-select/)
 * @param {string} options.reason Reason for requiring character (stored in session for display)
 * @returns {void}
 */
export function requireCharacterSelection(callback, options = {}) {
  const { redirectUrl = "/character-select/", reason = "" } = options;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      // Not logged in - redirect to login
      window.location.href = "/login/";
      return;
    }

    const validCharacter = await validateSelectedCharacter(user);
    
    if (!validCharacter) {
      // No valid character - redirect to character select
      if (reason) {
        sessionStorage.setItem("characterRequirementReason", reason);
      }
      window.location.href = redirectUrl;
      return;
    }

    // Valid character exists, proceed
    if (callback) {
      callback(validCharacter, user);
    }
  });
}

/**
 * Gets the currently selected character from localStorage
 * @returns {Object|null} Character data or null
 */
export function getSelectedCharacter() {
  try {
    const stored = localStorage.getItem("selectedCharacter");
    return stored ? JSON.parse(stored) : null;
  } catch {
    return null;
  }
}

/**
 * Clears selected character from localStorage
 * Used during logout or character deselection
 */
export function clearSelectedCharacter() {
  try {
    localStorage.removeItem("selectedCharacter");
  } catch (err) {
    console.error("Failed to clear selected character:", err);
  }
}
