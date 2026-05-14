// lib/tracker.js
//
// Event tracker for Lectura. Captures mid-level engagement events into
// localStorage. Pure functions; can be called from any client component.
//
// Granularity choice: mid-level. We record meaningful state transitions
// (lesson opened, assignment question attempted, recommendation clicked)
// not micro-events (every time-polling tick, every transcript scroll).
//
// Why localStorage:
//   - No backend in the MVP; the student carries their own log
//   - Per-browser limitation is accepted (a credential earned in Chrome
//     won't merge with one earned in Firefox — fine for the demo)
//
// Future migration path: when a backend exists, the same track() function
// can POST events to a Cloud Run endpoint; no consumer changes needed.

const STORAGE_KEY = "lectura:study-log:v1";
const SESSION_KEY = "lectura:study-log:session";

// All recognized event types. Adding a new event type is a one-line change
// here plus a call site that uses it. Keep the list small and meaningful.
export const EVENT_TYPES = {
  // Lesson engagement
  LESSON_OPENED: "lesson_opened",
  LESSON_PROGRESS: "lesson_progress",         // periodic: max position reached
  LESSON_COMPLETED: "lesson_completed",       // when progress crosses 90%
  ANNOTATION_TRIGGERED: "annotation_triggered",
  PAUSE_QUIZ_ANSWERED: "pause_quiz_answered",
  PRACTICE_QUESTION_ATTEMPTED: "practice_question_attempted",

  // Assignment engagement
  ASSIGNMENT_OPENED: "assignment_opened",
  ASSIGNMENT_QUESTION_ATTEMPTED: "assignment_question_attempted",
  ASSIGNMENT_REVEALED: "assignment_revealed",

  // The killer signal: did students follow recommendations?
  RECOMMENDATION_SHOWN: "recommendation_shown",
  RECOMMENDATION_CLICKED: "recommendation_clicked",

  // Page-level
  ACTIVITY_VIEWED: "activity_viewed",
  CREDENTIAL_EXPORTED: "credential_exported",
};

// ============================================================================
// Session identity (anonymous, browser-scoped)
// ============================================================================

/**
 * Each browser gets a stable random subject ID. This is what goes into the
 * `credentialSubject.id` field of an exported credential. It's NOT a real
 * identity — just a stable handle so multiple credentials from the same
 * browser are linkable. Anyone who clears localStorage gets a new one.
 *
 * Naming: "urn:lectura:subject:{uuid}" — a URN form, valid as a credential
 * subject ID under W3C VC Data Model.
 */
export function getSubjectId() {
  if (typeof window === "undefined") return null;
  let id = window.localStorage.getItem(SESSION_KEY);
  if (!id) {
    // crypto.randomUUID() exists in all modern browsers
    const uuid = (window.crypto?.randomUUID?.() || fallbackUuid()).toLowerCase();
    id = `urn:lectura:subject:${uuid}`;
    try {
      window.localStorage.setItem(SESSION_KEY, id);
    } catch (e) {
      // localStorage may be unavailable (private mode); use ephemeral
    }
  }
  return id;
}

function fallbackUuid() {
  // Reasonable fallback for environments lacking crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// Event capture
// ============================================================================

/**
 * Record an event. Silent no-op on the server (no window/localStorage).
 *
 * @param {string} type    One of EVENT_TYPES values
 * @param {object} payload Event-specific data
 */
export function track(type, payload = {}) {
  if (typeof window === "undefined") return;
  const event = {
    ts: new Date().toISOString(),
    type,
    payload,
  };
  try {
    const log = readLog();
    log.push(event);
    // Soft cap to prevent localStorage runaway; trim oldest if needed.
    // 10,000 events is plenty for a real student's term-long usage.
    const trimmed = log.length > 10000 ? log.slice(-10000) : log;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("[Lectura/tracker] could not write event", e);
  }
}

/**
 * Read all stored events. Returns [] on any failure.
 */
export function readLog() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

/**
 * Clear the log. Returns true on success.
 */
export function clearLog() {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

// ============================================================================
// De-duplication helpers
// ============================================================================
//
// Some events fire often (LESSON_PROGRESS every few seconds). The tracker
// itself stays dumb; consumers de-dupe via these helpers.

/**
 * Track a progress update only if the new position exceeds the last recorded
 * max for this lesson by at least `thresholdSeconds`. Prevents flooding.
 */
export function trackProgress(lessonId, positionSeconds, thresholdSeconds = 30) {
  const log = readLog();
  // Find the most recent LESSON_PROGRESS for this lesson
  let lastMax = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.type === EVENT_TYPES.LESSON_PROGRESS && e.payload?.lessonId === lessonId) {
      lastMax = e.payload.maxPosition || 0;
      break;
    }
  }
  if (positionSeconds < lastMax + thresholdSeconds) return false;
  track(EVENT_TYPES.LESSON_PROGRESS, {
    lessonId,
    maxPosition: positionSeconds,
  });
  return true;
}

/**
 * Track an event only if not already tracked with the same key.
 * Useful for one-shot events like "lesson opened" that shouldn't multiply
 * if the user navigates back and forth in a session.
 */
export function trackOnce(type, payload, dedupKey) {
  const log = readLog();
  const seen = log.some(
    (e) => e.type === type && JSON.stringify(e.payload || {}) === JSON.stringify(payload)
  );
  if (seen) return false;
  track(type, payload);
  return true;
}
