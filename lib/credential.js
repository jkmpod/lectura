// lib/credential.js
//
// Builds an Open Badges 3.0 credential from the captured event log.
//
// Spec references:
//   - W3C Verifiable Credentials Data Model v2.0:
//     https://www.w3.org/TR/vc-data-model-2.0/
//   - Open Badges 3.0 (1EdTech):
//     https://www.imsglobal.org/spec/ob/v3p0
//   - Context (latest as of build):
//     https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json
//
// Verification status:
//   This builder produces a structurally-correct OB 3.0 credential but does
//   NOT sign it. We omit the `proof` field entirely (rather than fake one)
//   and add a `lectura:verificationStatus` extension field describing the
//   limitation. A future Cloud Run signing endpoint adds a real proof; the
//   rest of the credential stays as-is.

import { readLog, getSubjectId, EVENT_TYPES } from "./tracker.js";

// ============================================================================
// Public API
// ============================================================================

/**
 * Build an OB 3.0 AchievementCredential from the current event log.
 *
 * @param {object} options
 * @param {string} [options.studentName]  Optional. If provided, included in
 *                                        the credentialSubject. Otherwise the
 *                                        subject is anonymous (just a URN).
 * @param {object} [options.moduleContext] Optional info about the module
 *                                        being studied. If omitted, derived
 *                                        from event log heuristics.
 *
 * @returns {object} A credential object ready for JSON.stringify and download.
 */
export async function buildCredential(options = {}) {
  const log = readLog();
  const subjectId = getSubjectId();
  const issuedAt = new Date().toISOString();

  // Summarize what the student did
  const summary = summarizeLog(log);

  // The achievement being claimed: engagement with the module.
  // Note: for a real institutional credential, the Achievement would be a
  // stable URL hosted by IITM (e.g., https://study.iitm.ac.in/achievements/stats2-crv-engagement).
  // For the MVP demo, we use a URN that's clearly Lectura-internal.
  const achievement = buildAchievement(options.moduleContext, summary);

  const credentialSubject = {
    type: ["AchievementSubject"],
    id: subjectId,
    achievement,
    // Per-event evidence is included as a separate `evidence` field on the
    // credential rather than inside credentialSubject — this matches the
    // OB 3.0 model where evidence is about the credential, not the subject.
  };

  if (options.studentName) {
    credentialSubject.identifier = [{
      type: "IdentityObject",
      identityHash: options.studentName,  // not really hashed; demo only
      identityType: "name",
      hashed: false,
    }];
  }

  // The credential envelope
  const credential = {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json",
    ],
    id: `urn:uuid:${cryptoRandomUUID()}`,
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: {
      id: "urn:lectura:issuer:mvp",
      type: ["Profile"],
      name: "Lectura (MVP build)",
      description:
        "Lectura is a study-aid prototype for the IIT Madras BS Program. This issuer identity is for demonstration only; credentials it produces are not cryptographically verifiable.",
    },
    validFrom: issuedAt,
    name: achievement.name,
    description: `Engagement record for ${achievement.name.replace(/ —.*$/, "")}.`,
    credentialSubject,
    evidence: buildEvidence(summary, log),

    // === Lectura extensions (non-standard fields, namespaced) ===
    //
    // OB 3.0 allows additional fields outside the spec, but consumers may
    // drop them. We prefix with "lectura:" to make it obvious they're
    // extensions and avoid colliding with future spec terms.

    "lectura:verificationStatus": {
      level: "structural-only",
      signed: false,
      explanation:
        "This credential conforms to the Open Badges 3.0 / W3C Verifiable Credentials data model but has no cryptographic proof attached. The `proof` field is intentionally omitted (rather than faked). A future signing authority can add a real proof using EdDSA or RSA-256 per OB 3.0 §8 without changing the rest of this document.",
      integrityHash: null,  // populated below
    },
    "lectura:summary": summary,
  };

  // Integrity hash: lets a verifier detect post-export tampering of this
  // specific file, though it does NOT verify the underlying claims. This
  // is the only protection we can offer without a signing authority.
  const hash = await sha256Hex(JSON.stringify(credential));
  credential["lectura:verificationStatus"].integrityHash = `sha256:${hash}`;

  return credential;
}

/**
 * Trigger a browser download of the credential as a .json file.
 */
export function downloadCredential(credential) {
  const json = JSON.stringify(credential, null, 2);
  const blob = new Blob([json], { type: "application/ld+json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const filename = `lectura-study-log-${new Date().toISOString().slice(0, 10)}.json`;
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}

// ============================================================================
// Achievement definition
// ============================================================================

function buildAchievement(moduleContext, summary) {
  // If the caller provided explicit module context, use it. Otherwise infer
  // from the events — for the MVP we know it's Stats II / CRV.
  const ctx = moduleContext || {
    moduleId: "stats2-crv-module",
    moduleName: "Continuous Random Variables and CDF",
    course: "Statistics for Data Science II",
  };

  return {
    id: `urn:lectura:achievement:${ctx.moduleId}-engagement`,
    type: ["Achievement"],
    name: `${ctx.moduleName} — Study Log`,
    description: `Records the student's engagement with lessons, assignments, and recommended remediation moments in the ${ctx.moduleName} module of ${ctx.course}. This is an engagement credential (not a competency or mastery credential); it describes work done rather than knowledge acquired.`,
    achievementType: "LearningProgram",  // OB 3.0 enum; "LearningProgram" fits an engagement record
    criteria: {
      narrative:
        "The student has interacted with the module's learning materials. Specific engagement details are listed in the evidence field of this credential.",
    },
    // Alignment ties the achievement to an external taxonomy. For real
    // credentials this would point to a NSQF level, an NPTEL course ID, etc.
    // For the MVP we leave it empty but document the slot.
    alignment: [],
  };
}

// ============================================================================
// Evidence — per-activity details
// ============================================================================

function buildEvidence(summary, log) {
  // OB 3.0 evidence: an array of Evidence objects, each describing one
  // piece of work. We produce one Evidence per lesson engaged with and
  // one per assignment attempted.
  const evidence = [];

  for (const lessonId of Object.keys(summary.lessons)) {
    const ls = summary.lessons[lessonId];
    evidence.push({
      id: `urn:lectura:evidence:lesson:${lessonId}:${summary.exportTimestamp}`,
      type: ["Evidence"],
      name: `Lesson engagement: ${lessonId}`,
      description: `Opened, watched to a maximum position of ${formatSec(ls.maxPosition)} (${ls.completionPct}% of duration if known). Triggered ${ls.annotationsTriggered} timeline annotations. Attempted ${ls.practiceQuestionsAttempted} practice questions (${ls.practiceQuestionsCorrect} correct). Attempted ${ls.pauseQuizzesAnswered} pause quizzes (${ls.pauseQuizzesCorrect} correct).`,
      // narrative is a free-text version of the same info, for human consumers
      narrative: `Engagement with lesson ${lessonId}`,
    });
  }

  for (const assignmentId of Object.keys(summary.assignments)) {
    const a = summary.assignments[assignmentId];
    evidence.push({
      id: `urn:lectura:evidence:assignment:${assignmentId}:${summary.exportTimestamp}`,
      type: ["Evidence"],
      name: `Assignment engagement: ${assignmentId}`,
      description: `Attempted ${a.questionsAttempted} of ${a.questionsTotal} questions. Followed ${a.recommendationsClicked} of ${a.recommendationsShown} recommended lesson moments. ${a.revealed ? `At reveal: ${a.correctCount} of ${a.questionsTotal} correct.` : "Not yet revealed."}`,
      narrative: `Engagement with assignment ${assignmentId}`,
    });
  }

  // One aggregate piece of evidence: concept coverage
  if (summary.conceptsCovered.length > 0) {
    evidence.push({
      id: `urn:lectura:evidence:concepts:${summary.exportTimestamp}`,
      type: ["Evidence"],
      name: "Concepts encountered",
      description: `The student attempted questions tagged with ${summary.conceptsCovered.length} distinct concepts from the module's ontology: ${summary.conceptsCovered.join(", ")}`,
      narrative: "Concept-tag coverage based on practice and assignment questions attempted.",
    });
  }

  return evidence;
}

// ============================================================================
// Log summarization
// ============================================================================

/**
 * Reduce the raw event log into a per-lesson and per-assignment summary.
 * This is what gets shown on the /activity page AND embedded in the
 * credential.
 */
export function summarizeLog(log) {
  const summary = {
    exportTimestamp: new Date().toISOString(),
    totalEvents: log.length,
    firstEventAt: log[0]?.ts || null,
    lastEventAt: log[log.length - 1]?.ts || null,

    lessons: {},        // lessonId → {opened, maxPosition, completionPct, annotationsTriggered, ...}
    assignments: {},    // assignmentId → {opened, questionsAttempted, ...}
    conceptsCovered: [], // unique concept_tags across all attempts

    recommendationsShown: 0,
    recommendationsClicked: 0,
    credentialExports: 0,
  };

  const conceptSet = new Set();

  for (const e of log) {
    const p = e.payload || {};
    switch (e.type) {
      case EVENT_TYPES.LESSON_OPENED: {
        ensureLesson(summary, p.lessonId);
        summary.lessons[p.lessonId].opened = true;
        if (p.duration) summary.lessons[p.lessonId].duration = p.duration;
        break;
      }
      case EVENT_TYPES.LESSON_PROGRESS: {
        ensureLesson(summary, p.lessonId);
        const cur = summary.lessons[p.lessonId];
        if ((p.maxPosition || 0) > (cur.maxPosition || 0)) {
          cur.maxPosition = p.maxPosition;
        }
        break;
      }
      case EVENT_TYPES.LESSON_COMPLETED: {
        ensureLesson(summary, p.lessonId);
        summary.lessons[p.lessonId].completed = true;
        break;
      }
      case EVENT_TYPES.ANNOTATION_TRIGGERED: {
        ensureLesson(summary, p.lessonId);
        summary.lessons[p.lessonId].annotationsTriggered =
          (summary.lessons[p.lessonId].annotationsTriggered || 0) + 1;
        break;
      }
      case EVENT_TYPES.PAUSE_QUIZ_ANSWERED: {
        ensureLesson(summary, p.lessonId);
        const ls = summary.lessons[p.lessonId];
        ls.pauseQuizzesAnswered = (ls.pauseQuizzesAnswered || 0) + 1;
        if (p.correct) ls.pauseQuizzesCorrect = (ls.pauseQuizzesCorrect || 0) + 1;
        (p.conceptTags || []).forEach((t) => conceptSet.add(t));
        break;
      }
      case EVENT_TYPES.PRACTICE_QUESTION_ATTEMPTED: {
        ensureLesson(summary, p.lessonId);
        const ls = summary.lessons[p.lessonId];
        ls.practiceQuestionsAttempted = (ls.practiceQuestionsAttempted || 0) + 1;
        if (p.correct) ls.practiceQuestionsCorrect = (ls.practiceQuestionsCorrect || 0) + 1;
        (p.conceptTags || []).forEach((t) => conceptSet.add(t));
        break;
      }
      case EVENT_TYPES.ASSIGNMENT_OPENED: {
        ensureAssignment(summary, p.assignmentId);
        summary.assignments[p.assignmentId].opened = true;
        if (p.questionsTotal) summary.assignments[p.assignmentId].questionsTotal = p.questionsTotal;
        break;
      }
      case EVENT_TYPES.ASSIGNMENT_QUESTION_ATTEMPTED: {
        ensureAssignment(summary, p.assignmentId);
        const a = summary.assignments[p.assignmentId];
        const attempted = a.attemptedQuestions || new Set();
        attempted.add(p.questionId);
        a.attemptedQuestions = attempted;
        a.questionsAttempted = attempted.size;
        (p.conceptTags || []).forEach((t) => conceptSet.add(t));
        break;
      }
      case EVENT_TYPES.ASSIGNMENT_REVEALED: {
        ensureAssignment(summary, p.assignmentId);
        const a = summary.assignments[p.assignmentId];
        a.revealed = true;
        a.correctCount = p.correctCount;
        a.questionsTotal = p.questionsTotal || a.questionsTotal;
        break;
      }
      case EVENT_TYPES.RECOMMENDATION_SHOWN: {
        summary.recommendationsShown += (p.count || 1);
        if (p.assignmentId) {
          ensureAssignment(summary, p.assignmentId);
          summary.assignments[p.assignmentId].recommendationsShown =
            (summary.assignments[p.assignmentId].recommendationsShown || 0) + (p.count || 1);
        }
        break;
      }
      case EVENT_TYPES.RECOMMENDATION_CLICKED: {
        summary.recommendationsClicked += 1;
        if (p.assignmentId) {
          ensureAssignment(summary, p.assignmentId);
          summary.assignments[p.assignmentId].recommendationsClicked =
            (summary.assignments[p.assignmentId].recommendationsClicked || 0) + 1;
        }
        break;
      }
      case EVENT_TYPES.CREDENTIAL_EXPORTED: {
        summary.credentialExports += 1;
        break;
      }
    }
  }

  // Finalize: compute completionPct per lesson, clean up internal sets
  for (const id in summary.lessons) {
    const ls = summary.lessons[id];
    if (ls.duration && ls.maxPosition) {
      ls.completionPct = Math.min(100, Math.round((ls.maxPosition / ls.duration) * 100));
    } else {
      ls.completionPct = null;
    }
    // Default-zero fields for cleanliness
    ls.annotationsTriggered = ls.annotationsTriggered || 0;
    ls.practiceQuestionsAttempted = ls.practiceQuestionsAttempted || 0;
    ls.practiceQuestionsCorrect = ls.practiceQuestionsCorrect || 0;
    ls.pauseQuizzesAnswered = ls.pauseQuizzesAnswered || 0;
    ls.pauseQuizzesCorrect = ls.pauseQuizzesCorrect || 0;
    ls.maxPosition = ls.maxPosition || 0;
  }
  for (const id in summary.assignments) {
    const a = summary.assignments[id];
    delete a.attemptedQuestions;  // Sets don't serialize; we already have the count
    a.recommendationsShown = a.recommendationsShown || 0;
    a.recommendationsClicked = a.recommendationsClicked || 0;
    a.questionsAttempted = a.questionsAttempted || 0;
    a.questionsTotal = a.questionsTotal || 0;
  }

  summary.conceptsCovered = Array.from(conceptSet).sort();
  return summary;
}

function ensureLesson(summary, lessonId) {
  if (!lessonId) return;
  if (!summary.lessons[lessonId]) summary.lessons[lessonId] = {};
}
function ensureAssignment(summary, assignmentId) {
  if (!assignmentId) return;
  if (!summary.assignments[assignmentId]) summary.assignments[assignmentId] = {};
}

function formatSec(s) {
  if (!s) return "0:00";
  const m = Math.floor(s / 60);
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${m}:${ss}`;
}

// ============================================================================
// Crypto helpers
// ============================================================================

function cryptoRandomUUID() {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function sha256Hex(text) {
  if (typeof window === "undefined" || !window.crypto?.subtle) {
    return "unavailable";
  }
  const enc = new TextEncoder().encode(text);
  const buf = await window.crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
