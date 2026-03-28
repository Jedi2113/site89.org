/**
 * Merit system - Site-89 contribution score.
 * Calculated from articles, gallery uploads, anomalies, research logs,
 * incident reports, and forum posts/replies authored by a user.
 * Merit is bound to the user's account (UID), not to any individual character.
 *
 * Scoring:
 *   - Each piece of content with a net score >= 0 earns: 10 base merit + 2 merit per net upvote.
 *   - Content with a net negative score earns 0 (no penalty, no reward).
 *   - Forum replies are worth 0.5x (shorter contributions).
 *
 * Slot unlock thresholds (cumulative, +1 slot each):
 *   150 → 300 → 600 → 1200
 */

import { app } from '/assets/js/auth.js';
import {
  getFirestore,
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  doc,
  updateDoc
} from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const db = getFirestore(app);
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const BASE_CONTENT_MERIT = 10;
const MERIT_PER_NET_UPVOTE = 2;

function broadcastMerit(uid, merit) {
  window.dispatchEvent(new CustomEvent('site89:merit-updated', {
    detail: { uid, merit }
  }));
}

function getCached(uid) {
  try {
    const raw = sessionStorage.getItem(`merit_${uid}`);
    if (!raw) return null;
    const { value, ts } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return value;
  } catch { return null; }
}

function setCache(uid, value) {
  try {
    sessionStorage.setItem(`merit_${uid}`, JSON.stringify({ value, ts: Date.now() }));
  } catch {}
}

export function invalidateMeritCache(uid) {
  try {
    sessionStorage.removeItem(`merit_${uid}`);
  } catch {}
}

function contentMerit(upvotes, downvotes, multiplier = 1) {
  const score = (upvotes || 0) - (downvotes || 0);
  if (score < 0) return 0;
  return Math.round((BASE_CONTENT_MERIT + (score * MERIT_PER_NET_UPVOTE)) * multiplier);
}

// --- Public helpers ---

/** Number of bonus character slots unlocked by the given merit total. */
export function meritSlotBonus(merit) {
  let bonus = 0;
  if (merit >= 150) bonus++;
  if (merit >= 300) bonus++;
  if (merit >= 600) bonus++;
  if (merit >= 1200) bonus++;
  return bonus;
}

/** Human-readable tier label for a merit value. */
export function meritTitle(merit) {
  if (merit >= 1200) return 'Distinguished';
  if (merit >= 600) return 'Notable';
  if (merit >= 300) return 'Recognized';
  if (merit >= 150) return 'Established';
  if (merit >= 50) return 'Active';
  return 'Newcomer';
}

/** The next merit threshold to unlock a perk, or null if already at max. */
export function nextMeritThreshold(merit) {
  for (const t of [50, 150, 300, 600, 1200]) {
    if (merit < t) return t;
  }
  return null;
}

/**
 * Calculate and cache the merit score for a given UID.
 * Persists the result to the user's Firestore document.
 */
export async function calculateMerit(uid, forceRefresh = false) {
  if (!forceRefresh) {
    const cached = getCached(uid);
    if (cached !== null) {
      broadcastMerit(uid, cached);
      return cached;
    }
  }

  let merit = 0;

  try {
    // Articles (full weight)
    const articlesSnap = await getDocs(
      query(collection(db, 'articles'), where('authorUid', '==', uid))
    );
    articlesSnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Gallery uploads (full weight)
    const gallerySnap = await getDocs(
      query(collection(db, 'gallery'), where('uploaderId', '==', uid))
    );
    gallerySnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Forum threads (full weight)
    const threadsSnap = await getDocs(
      query(collection(db, 'forum-threads'), where('authorUid', '==', uid))
    );
    threadsSnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Anomalies (authored contributions, unrated defaults still count)
    const anomaliesSnap = await getDocs(
      query(collection(db, 'anomalies'), where('createdByUid', '==', uid))
    );
    anomaliesSnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Research logs (authored contributions, unrated defaults still count)
    const researchSnap = await getDocs(
      query(collection(db, 'researchLogs'), where('createdByUid', '==', uid))
    );
    researchSnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Incident reports (authored contributions, unrated defaults still count)
    const incidentSnap = await getDocs(
      query(collection(db, 'incidentReports'), where('createdByUid', '==', uid))
    );
    incidentSnap.forEach(d => {
      merit += contentMerit(d.data().upvotes, d.data().downvotes, 1);
    });

    // Forum replies (half weight — shorter contributions)
    try {
      const repliesSnap = await getDocs(
        query(collectionGroup(db, 'replies'), where('authorUid', '==', uid))
      );
      repliesSnap.forEach(d => {
        merit += contentMerit(d.data().upvotes, d.data().downvotes, 0.5);
      });
    } catch {
      // collectionGroup requires a Firestore composite index on replies.authorUid;
      // skip gracefully if it hasn't been deployed yet.
    }
  } catch (err) {
    console.error('[Merit] Calculation error:', err);
  }

  merit = Math.round(merit);
  setCache(uid, merit);

  // Persist to user doc so other pages can read it without recalculating
  try {
    await updateDoc(doc(db, 'users', uid), { merit });
  } catch {}

  broadcastMerit(uid, merit);

  return merit;
}

export async function refreshMerit(uid) {
  invalidateMeritCache(uid);
  return calculateMerit(uid, true);
}
