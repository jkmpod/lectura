// scripts/test_credential.mjs
//
// Tests the credential builder by simulating a realistic event log
// (the kind a real student session would produce) and printing the resulting
// OB 3.0 credential, plus key validation checks.
//
// Run with: node scripts/test_credential.mjs

// Since the tracker and credential modules expect `window` / localStorage,
// we shim a minimal global before importing.
const localStorageShim = {
  data: {},
  getItem(k) { return this.data[k] || null; },
  setItem(k, v) { this.data[k] = String(v); },
  removeItem(k) { delete this.data[k]; },
};
globalThis.window = {
  localStorage: localStorageShim,
  crypto: {
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
    subtle: {
      digest: async (algo, data) => {
        // Use Node's crypto to produce a real SHA-256
        const { createHash } = await import("crypto");
        const buf = createHash("sha256").update(Buffer.from(data)).digest();
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    },
  },
};
globalThis.localStorage = localStorageShim;

const { track, EVENT_TYPES } = await import("../lib/tracker.js");
const { buildCredential, summarizeLog } = await import("../lib/credential.js");
const { readLog } = await import("../lib/tracker.js");

// ---------- Simulate a realistic study session ----------

console.log("Simulating events...\n");

// Student opens the first lesson
track(EVENT_TYPES.LESSON_OPENED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
  duration: 1144,
});

// Student watches through, triggering annotations
for (let pct of [10, 25, 50, 75, 100]) {
  const pos = Math.floor(1144 * pct / 100);
  track(EVENT_TYPES.LESSON_PROGRESS, {
    lessonId: "stats2-4-1-continuous-rv-intro",
    maxPosition: pos,
  });
}
track(EVENT_TYPES.LESSON_COMPLETED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
});

// A few annotations triggered
for (const annId of ["a1", "a2", "a3"]) {
  track(EVENT_TYPES.ANNOTATION_TRIGGERED, {
    lessonId: "stats2-4-1-continuous-rv-intro",
    annotationId: annId,
    annotationType: "context",
    behavior: "soft",
  });
}

// One pause-quiz, got it right
track(EVENT_TYPES.PAUSE_QUIZ_ANSWERED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
  annotationId: "a3",
  correct: true,
  conceptTags: ["CRV_007", "CRV_004"],
});

// Three practice questions, mixed
track(EVENT_TYPES.PRACTICE_QUESTION_ATTEMPTED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
  questionId: "q1",
  correct: true,
  conceptTags: ["CRV_004", "CRV_050", "CRV_049"],
});
track(EVENT_TYPES.PRACTICE_QUESTION_ATTEMPTED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
  questionId: "q3",
  correct: false,
  conceptTags: ["CRV_012", "CRV_011"],
});
track(EVENT_TYPES.PRACTICE_QUESTION_ATTEMPTED, {
  lessonId: "stats2-4-1-continuous-rv-intro",
  questionId: "q3",  // retried
  correct: true,
  conceptTags: ["CRV_012", "CRV_011"],
});

// Student opens the graded assignment
track(EVENT_TYPES.ASSIGNMENT_OPENED, {
  assignmentId: "stats2-week4-graded",
  questionsTotal: 5,
});

// Attempts a question, sees recommendations
track(EVENT_TYPES.ASSIGNMENT_QUESTION_ATTEMPTED, {
  assignmentId: "stats2-week4-graded",
  questionId: "aq1",
  conceptTags: ["CRV_007", "CRV_008", "CRV_050"],
});
track(EVENT_TYPES.RECOMMENDATION_SHOWN, {
  assignmentId: "stats2-week4-graded",
  questionId: "aq1",
  count: 3,
});
track(EVENT_TYPES.RECOMMENDATION_CLICKED, {
  assignmentId: "stats2-week4-graded",
  questionId: "aq1",
  targetLessonId: "stats2-4-1-continuous-rv-intro",
  targetTimestamp: 677,
});

// Attempts more questions
for (const qId of ["aq2", "aq3", "aq4", "aq5"]) {
  track(EVENT_TYPES.ASSIGNMENT_QUESTION_ATTEMPTED, {
    assignmentId: "stats2-week4-graded",
    questionId: qId,
    conceptTags: ["CRV_028"],
  });
  track(EVENT_TYPES.RECOMMENDATION_SHOWN, {
    assignmentId: "stats2-week4-graded",
    questionId: qId,
    count: 3,
  });
}

// Two of those recommendations also clicked
track(EVENT_TYPES.RECOMMENDATION_CLICKED, {
  assignmentId: "stats2-week4-graded",
  questionId: "aq3",
  targetLessonId: "stats2-4-2-cdf",
  targetTimestamp: 251,
});

// Reveal
track(EVENT_TYPES.ASSIGNMENT_REVEALED, {
  assignmentId: "stats2-week4-graded",
  correctCount: 4,
  questionsTotal: 5,
});

console.log(`Logged ${readLog().length} events\n`);

// ---------- Build credential ----------

const cred = await buildCredential({ studentName: "J. K. Test" });

// ---------- Validate ----------
console.log("=== Credential structure checks ===\n");

const checks = [
  ["Has @context array",
    Array.isArray(cred["@context"]) && cred["@context"].length >= 2],
  ["@context[0] is W3C VC v2",
    cred["@context"][0] === "https://www.w3.org/ns/credentials/v2"],
  ["@context includes OB 3.0",
    cred["@context"].some((c) => c.includes("ob/v3p0"))],
  ["type includes VerifiableCredential",
    cred.type.includes("VerifiableCredential")],
  ["type includes OpenBadgeCredential",
    cred.type.includes("OpenBadgeCredential")],
  ["Has issuer.id",
    cred.issuer?.id !== undefined],
  ["Has validFrom timestamp",
    typeof cred.validFrom === "string" && cred.validFrom.length > 0],
  ["credentialSubject.id is URN",
    cred.credentialSubject?.id?.startsWith("urn:")],
  ["credentialSubject has achievement",
    cred.credentialSubject?.achievement !== undefined],
  ["achievement.type includes Achievement",
    cred.credentialSubject?.achievement?.type?.includes?.("Achievement")],
  ["achievement has name and description",
    cred.credentialSubject?.achievement?.name &&
    cred.credentialSubject?.achievement?.description],
  ["achievement has criteria",
    cred.credentialSubject?.achievement?.criteria !== undefined],
  ["evidence array present",
    Array.isArray(cred.evidence) && cred.evidence.length > 0],
  ["No proof field (honestly omitted)",
    cred.proof === undefined],
  ["lectura:verificationStatus explains the gap",
    cred["lectura:verificationStatus"]?.signed === false],
  ["Integrity hash is SHA-256",
    cred["lectura:verificationStatus"]?.integrityHash?.startsWith("sha256:")],
  ["Summary embedded for human review",
    cred["lectura:summary"] !== undefined],
  ["Summary has correct lesson count",
    Object.keys(cred["lectura:summary"]?.lessons || {}).length === 1],
  ["Summary has correct assignment count",
    Object.keys(cred["lectura:summary"]?.assignments || {}).length === 1],
  ["Concept coverage is non-empty",
    cred["lectura:summary"]?.conceptsCovered?.length > 0],
];

let pass = 0, fail = 0;
for (const [label, ok] of checks) {
  const mark = ok ? "✓" : "✗";
  if (ok) pass++; else fail++;
  console.log(`  ${mark} ${label}`);
}
console.log(`\n  ${pass} passed, ${fail} failed`);

// ---------- Show the credential ----------
console.log("\n=== Generated credential (truncated for terminal) ===\n");
const printCred = JSON.parse(JSON.stringify(cred));
if (printCred.evidence?.length > 2) {
  printCred.evidence = [...printCred.evidence.slice(0, 2), `... ${printCred.evidence.length - 2} more elided`];
}
console.log(JSON.stringify(printCred, null, 2));

// ---------- Show summary that would appear on /activity ----------
console.log("\n=== Summary that would appear on /activity ===\n");
console.log(JSON.stringify(summarizeLog(readLog()), null, 2));
