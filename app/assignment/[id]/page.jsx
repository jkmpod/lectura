"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { recommendForQuestion, momentToUrl } from "@/lib/recommender";
import { track, trackOnce, EVENT_TYPES } from "@/lib/tracker";

// ============================================================================
// LECTURA — Assignment Page
//
// Shows graded assignment questions. Students attempt answers; after each
// attempt, the recommender surfaces lesson moments that may help refine
// the answer. Correct answers are hidden until the student clicks "Reveal"
// (which simulates the due-date passing).
//
// Persistence: localStorage, keyed per assignment.
// ============================================================================

const STORAGE_KEY = (assignmentId) => `lectura:assignment:${assignmentId}`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function permutationFor(question) {
  if (!question?.options) return [];
  return shuffle(question.options.map((_, i) => i));
}

function formatDate(isoDate) {
  if (!isoDate) return "";
  const d = new Date(isoDate);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

export default function AssignmentPage() {
  const params = useParams();
  const assignmentId = params?.id;

  const [assignment, setAssignment] = useState(null);
  const [ontology, setOntology] = useState(null);
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Per-question state: { [questionId]: { selectedIdx, permutation } }
  const [answers, setAnswers] = useState({});
  // Whether answers have been revealed (simulates due-date passing)
  const [revealed, setRevealed] = useState(false);
  // Recommendations cache: { [questionId]: [moments] }
  const [recsCache, setRecsCache] = useState({});

  // ---------- Load everything ----------
  useEffect(() => {
    if (!assignmentId) return;
    async function loadAll() {
      try {
        // Assignment metadata
        const aRes = await fetch("/assignments/index.json");
        if (!aRes.ok) throw new Error("Could not load assignment index");
        const aIdx = await aRes.json();
        const entry = aIdx.assignments.find((x) => x.id === assignmentId);
        if (!entry) throw new Error(`Assignment "${assignmentId}" not found`);
        const aFull = await fetch(`/assignments/${entry.file}`).then((r) => r.json());
        setAssignment(aFull);

        // Track assignment opened (deduped — multiple opens of same assignment
        // in this browser only get logged once)
        trackOnce(
          EVENT_TYPES.ASSIGNMENT_OPENED,
          { assignmentId: aFull.id, questionsTotal: aFull.questions?.length || 0 },
          aFull.id
        );

        // Ontology
        const oIdx = await fetch("/ontology/index.json").then((r) => r.json());
        const oEntry = oIdx.ontologies[0]; // MVP: assume one ontology
        const ont = await fetch(`/ontology/${oEntry.file}`).then((r) => r.json());
        setOntology(ont);

        // All lessons (to feed the recommender)
        const lIdx = await fetch("/lessons/index.json").then((r) => r.json());
        const allLessons = await Promise.all(
          lIdx.lessons.map((l) => fetch(`/lessons/${l.file}`).then((r) => r.json()))
        );
        setLessons(allLessons);
      } catch (e) {
        console.error("[Lectura/assignment]", e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    loadAll();
  }, [assignmentId]);

  // ---------- Restore state from localStorage once everything has loaded ----------
  useEffect(() => {
    if (!assignment) return;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY(assignment.id));
      if (raw) {
        const parsed = JSON.parse(raw);
        setAnswers(parsed.answers || {});
        setRevealed(!!parsed.revealed);
      }
    } catch (e) {
      console.warn("[Lectura/assignment] could not restore state", e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignment?.id]);

  // ---------- Persist state ----------
  useEffect(() => {
    if (!assignment) return;
    try {
      window.localStorage.setItem(
        STORAGE_KEY(assignment.id),
        JSON.stringify({ answers, revealed })
      );
    } catch (e) {
      console.warn("[Lectura/assignment] could not save state", e);
    }
  }, [answers, revealed, assignment?.id]);

  // ---------- Compute recommendations on demand ----------
  // Done lazily per question (so initial render is fast).
  const getRecsFor = (questionId) => {
    if (recsCache[questionId]) return recsCache[questionId];
    if (!assignment || !ontology || lessons.length === 0) return null;
    const q = assignment.questions.find((x) => x.id === questionId);
    if (!q) return [];
    const moments = recommendForQuestion(q, ontology, lessons, { maxResults: 4 });
    setRecsCache((prev) => ({ ...prev, [questionId]: moments }));
    return moments;
  };

  // ---------- Answer submission ----------
  const submitAnswer = (questionId, origIdx) => {
    if (revealed) return; // can't change after reveal
    const q = assignment.questions.find((qq) => qq.id === questionId);
    setAnswers((prev) => {
      const existing = prev[questionId] || {};
      return {
        ...prev,
        [questionId]: {
          permutation:
            existing.permutation && existing.permutation.length > 0
              ? existing.permutation
              : permutationFor(q),
          selectedIdx: origIdx,
        },
      };
    });
    // Track the attempt (every attempt, including answer changes)
    track(EVENT_TYPES.ASSIGNMENT_QUESTION_ATTEMPTED, {
      assignmentId: assignment.id,
      questionId,
      conceptTags: q?.concept_tags || [],
    });
  };

  // Build a permutation for a question if it doesn't have one yet.
  // Stored per-question so the option order is stable within a session.
  const getPermutation = (q) => {
    const existing = answers[q.id]?.permutation;
    if (existing && existing.length === q.options.length) return existing;
    const perm = permutationFor(q);
    setAnswers((prev) => ({
      ...prev,
      [q.id]: { ...(prev[q.id] || {}), permutation: perm },
    }));
    return perm;
  };

  const handleReveal = () => {
    if (window.confirm("Reveal correct answers and explanations? This simulates the due date passing.")) {
      setRevealed(true);
      // Track the reveal with score
      const correctCount = assignment.questions.filter(
        (q) => answers[q.id]?.selectedIdx === q.correctIndex
      ).length;
      track(EVENT_TYPES.ASSIGNMENT_REVEALED, {
        assignmentId: assignment.id,
        correctCount,
        questionsTotal: assignment.questions.length,
      });
    }
  };

  const handleReset = () => {
    if (window.confirm("Clear all your answers and start over? This cannot be undone.")) {
      setAnswers({});
      setRevealed(false);
      setRecsCache({});
      try {
        window.localStorage.removeItem(STORAGE_KEY(assignment.id));
      } catch (e) {}
    }
  };

  // ============================================================================
  // RENDER
  // ============================================================================
  if (loading) {
    return (
      <div style={styles.loadingPage}>
        <style suppressHydrationWarning>{globalCSS}</style>
        <div style={styles.loadingDot} />
        <p style={styles.loadingMsg}>Loading assignment…</p>
      </div>
    );
  }

  if (error || !assignment) {
    return (
      <div style={styles.loadingPage}>
        <style suppressHydrationWarning>{globalCSS}</style>
        <p style={styles.loadingMsg}>{error || "Assignment not found"}</p>
        <Link href="/" style={styles.backLink}>← Back to library</Link>
      </div>
    );
  }

  const attemptedCount = assignment.questions.filter(
    (q) => answers[q.id]?.selectedIdx !== undefined && answers[q.id]?.selectedIdx !== null
  ).length;
  const totalCount = assignment.questions.length;
  const correctCount = revealed
    ? assignment.questions.filter(
        (q) => answers[q.id]?.selectedIdx === q.correctIndex
      ).length
    : 0;

  return (
    <div style={styles.app}>
      <style suppressHydrationWarning>{globalCSS}</style>

      <header style={styles.header}>
        <div style={styles.brand}>
          <Link href="/" style={styles.brandLink}>
            <span style={styles.brandMark}>※</span>
            <span style={styles.brandName}>Lectura</span>
          </Link>
          <span style={styles.crumb}>
            <span style={styles.crumbSep}>·</span>
            Assignment
          </span>
        </div>
        <Link href="/" style={styles.libraryBtn}>↺ Library</Link>
      </header>

      <main style={styles.main}>
        <div style={styles.titleBlock}>
          <div style={styles.courseLine}>{assignment.course}</div>
          <h1 style={styles.title}>{assignment.title}</h1>
          {assignment.subtitle && (
            <p style={styles.subtitle}>{assignment.subtitle}</p>
          )}
          <div style={styles.metaRow}>
            {assignment.instructor && <span>{assignment.instructor}</span>}
            {assignment.dueDate && (
              <span>Due: {formatDate(assignment.dueDate)}</span>
            )}
            <span>
              {attemptedCount} of {totalCount} attempted
              {revealed && ` · ${correctCount} correct`}
            </span>
          </div>
        </div>

        {assignment.instructions && (
          <div style={styles.instructions}>
            <span style={styles.instructionsLabel}>Instructions</span>
            <p style={styles.instructionsBody}>{assignment.instructions}</p>
          </div>
        )}

        <div style={styles.questionList}>
          {assignment.questions.map((q, qIdx) => (
            <QuestionCard
              key={q.id}
              question={q}
              questionNumber={qIdx + 1}
              totalQuestions={totalCount}
              answerState={answers[q.id] || {}}
              permutation={getPermutation(q)}
              revealed={revealed}
              onAnswer={(origIdx) => submitAnswer(q.id, origIdx)}
              getRecsFor={getRecsFor}
              assignmentId={assignment.id}
            />
          ))}
        </div>

        <div style={styles.footer}>
          {!revealed ? (
            <>
              <span style={styles.footerNote}>
                {attemptedCount === totalCount
                  ? "All questions attempted. Click below to reveal correct answers."
                  : `${totalCount - attemptedCount} question(s) remaining.`}
              </span>
              <button onClick={handleReveal} style={styles.primaryBtn}>
                Reveal answers
              </button>
            </>
          ) : (
            <>
              <span style={styles.footerNote}>
                Score: {correctCount} of {totalCount}
              </span>
              <button onClick={handleReset} style={styles.secondaryBtn}>
                Reset & try again
              </button>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

// ============================================================================
// QuestionCard
// ============================================================================
function QuestionCard({
  question,
  questionNumber,
  totalQuestions,
  answerState,
  permutation,
  revealed,
  onAnswer,
  getRecsFor,
  assignmentId,
}) {
  const selectedIdx = answerState.selectedIdx;
  const hasAttempted = selectedIdx !== undefined && selectedIdx !== null;
  const isCorrect = revealed && selectedIdx === question.correctIndex;
  const isWrong = revealed && hasAttempted && selectedIdx !== question.correctIndex;

  // Lazy-fetch recommendations only after the student has attempted
  const recs = hasAttempted ? getRecsFor(question.id) : null;

  // Map display order using the stable per-question permutation
  const displayOrder =
    permutation && permutation.length === question.options.length
      ? permutation
      : question.options.map((_, i) => i);

  return (
    <article style={styles.qCard}>
      <div style={styles.qHeader}>
        <span style={styles.qNumber}>
          QUESTION {questionNumber} OF {totalQuestions}
        </span>
        {revealed && (
          <span
            style={{
              ...styles.qVerdict,
              color: isCorrect ? colors.green : colors.red,
              borderColor: isCorrect ? colors.green : colors.red,
            }}
          >
            {isCorrect ? "✓ Correct" : isWrong ? "✗ Not quite" : "Unanswered"}
          </span>
        )}
      </div>
      <h3 style={styles.qPrompt}>{question.prompt}</h3>

      <div style={styles.qOptions}>
        {displayOrder.map((origIdx, displayPos) => {
          const opt = question.options[origIdx];
          const isSelected = origIdx === selectedIdx;
          const isCorrectOpt = revealed && origIdx === question.correctIndex;
          const isSelectedAndWrong = revealed && isSelected && !isCorrectOpt;

          let optStyle = { ...styles.qOption };
          if (revealed) {
            if (isCorrectOpt) optStyle = { ...optStyle, ...styles.qOptionCorrect };
            else if (isSelectedAndWrong)
              optStyle = { ...optStyle, ...styles.qOptionWrong };
            else optStyle = { ...optStyle, ...styles.qOptionDim };
          } else if (isSelected) {
            optStyle = { ...optStyle, ...styles.qOptionSelected };
          }

          return (
            <button
              key={origIdx}
              onClick={() => !revealed && onAnswer(origIdx)}
              disabled={revealed}
              style={optStyle}
            >
              <span style={styles.qOptionLetter}>
                {String.fromCharCode(65 + displayPos)}
              </span>
              <span style={styles.qOptionText}>{opt}</span>
            </button>
          );
        })}
      </div>

      {/* Recommendations panel — shown after attempt, before reveal */}
      {hasAttempted && !revealed && recs && recs.length > 0 && (
        <Recommendations
          moments={recs}
          assignmentId={assignmentId}
          questionId={question.id}
        />
      )}

      {/* Reveal-state feedback */}
      {revealed && hasAttempted && (
        <div style={styles.qExplanationBlock}>
          <div style={styles.explanationHeader}>EXPLANATION</div>
          <p style={styles.explanationBody}>{question.explanation}</p>
          {question.hint && (
            <p style={styles.qHintLine}>
              <span style={styles.qHintLabel}>Hint that was available: </span>
              {question.hint}
            </p>
          )}
        </div>
      )}
    </article>
  );
}

// ============================================================================
// Recommendations panel
// ============================================================================
function Recommendations({ moments, assignmentId, questionId }) {
  // Fire a recommendation_shown event once when this panel mounts
  // (i.e., when the student first attempts the question and the recs appear).
  // The dedupKey ensures we don't double-count if React remounts the component.
  useEffect(() => {
    if (!moments || moments.length === 0) return;
    trackOnce(
      EVENT_TYPES.RECOMMENDATION_SHOWN,
      {
        assignmentId,
        questionId,
        count: moments.length,
        targetLessons: moments.map((m) => `${m.lessonId}@${m.timestamp}`),
      },
      `${assignmentId}:${questionId}`
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  if (!moments || moments.length === 0) return null;

  const handleClick = (m) => {
    track(EVENT_TYPES.RECOMMENDATION_CLICKED, {
      assignmentId,
      questionId,
      targetLessonId: m.lessonId,
      targetTimestamp: m.timestamp,
      score: m.score,
    });
  };

  return (
    <div style={styles.recsBlock}>
      <div style={styles.recsHeader}>
        <span style={styles.recsLabel}>Moments from the library</span>
        <span style={styles.recsSubLabel}>
          watch these to refine your answer
        </span>
      </div>
      <ul style={styles.recsList}>
        {moments.map((m, i) => {
          const mm = Math.floor(m.timestamp / 60);
          const ss = String(m.timestamp % 60).padStart(2, "0");
          return (
            <li key={i} style={styles.recItem}>
              <Link
                href={momentToUrl(m)}
                target="_blank"
                rel="noopener noreferrer"
                style={styles.recLink}
                className="rec-link"
                onClick={() => handleClick(m)}
              >
                <span style={styles.recTime}>{mm}:{ss}</span>
                <span style={styles.recBody}>
                  <span style={styles.recConcept}>{m.conceptTitle}</span>
                  <span style={styles.recLesson}>{m.lessonTitle}</span>
                </span>
                <span style={styles.recArrow}>↗</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ============================================================================
// STYLES
// ============================================================================
const colors = {
  paper: "#f5f1e8",
  paperDeep: "#ede7d8",
  ink: "#1a1a1a",
  inkSoft: "#3a3530",
  inkMute: "#6b6258",
  rule: "#cfc4ad",
  ochre: "#a8651b",
  ochreSoft: "#d4a574",
  green: "#4a6b3a",
  red: "#9a3a2a",
  cream: "#faf6ec",
  blue: "#3a6b9c",
};

const fontDisplay = `'Fraunces', 'Cormorant Garamond', Georgia, serif`;
const fontBody = `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`;
const fontMono = `'JetBrains Mono', 'Courier New', monospace`;

const globalCSS = `
  @import url("https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap");
  * { box-sizing: border-box; }
  body { margin: 0; background: ${colors.paper}; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  button:hover:not(:disabled) { opacity: 0.92; }
  .rec-link:hover { background: ${colors.paperDeep} !important; }
`;

const styles = {
  app: { minHeight: "100vh", background: colors.paper, color: colors.ink, fontFamily: fontBody },
  loadingPage: { minHeight: "100vh", background: colors.paper, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, fontFamily: fontBody },
  loadingDot: { width: 12, height: 12, borderRadius: "50%", background: colors.ochre, animation: "pulse 1.4s ease-in-out infinite" },
  loadingMsg: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, color: colors.inkSoft, margin: 0 },
  backLink: { color: colors.ochre, textDecoration: "none", fontSize: 14, fontFamily: fontBody, marginTop: 16 },

  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 32px", borderBottom: `1px solid ${colors.rule}`, background: colors.cream },
  brand: { display: "flex", alignItems: "baseline", gap: 12 },
  brandLink: { display: "flex", alignItems: "baseline", gap: 8, textDecoration: "none", color: colors.ink },
  brandMark: { fontSize: 22, color: colors.ochre, fontFamily: fontDisplay },
  brandName: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" },
  crumb: { fontFamily: fontDisplay, fontSize: 15, fontStyle: "italic", color: colors.inkSoft },
  crumbSep: { color: colors.inkMute, marginRight: 8 },
  libraryBtn: { background: "transparent", border: `1px solid ${colors.ink}`, color: colors.ink, padding: "7px 14px", fontSize: 12, fontFamily: fontBody, cursor: "pointer", letterSpacing: "0.02em", textDecoration: "none" },

  main: { maxWidth: 820, margin: "0 auto", padding: "32px 32px 80px" },

  titleBlock: { marginBottom: 32, paddingBottom: 24, borderBottom: `1px solid ${colors.rule}` },
  courseLine: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.18em", color: colors.ochre, fontFamily: fontBody, fontWeight: 500, marginBottom: 10 },
  title: { fontFamily: fontDisplay, fontSize: 38, fontWeight: 500, lineHeight: 1.15, margin: "0 0 8px", color: colors.ink, letterSpacing: "-0.01em" },
  subtitle: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, color: colors.inkSoft, margin: "0 0 16px", lineHeight: 1.4 },
  metaRow: { display: "flex", gap: 24, fontSize: 13, color: colors.inkMute, fontFamily: fontBody, flexWrap: "wrap" },

  instructions: { background: colors.cream, border: `1px solid ${colors.rule}`, padding: "18px 22px", marginBottom: 32 },
  instructionsLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", color: colors.inkMute, fontWeight: 500, display: "block", marginBottom: 6 },
  instructionsBody: { margin: 0, fontFamily: fontDisplay, fontSize: 15, lineHeight: 1.55, color: colors.inkSoft },

  questionList: { display: "flex", flexDirection: "column", gap: 24 },

  qCard: { background: colors.cream, border: `1px solid ${colors.rule}`, padding: "28px 32px" },
  qHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 },
  qNumber: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.ochre, fontWeight: 500, fontFamily: fontMono },
  qVerdict: { fontSize: 10, padding: "3px 10px", border: "1px solid", letterSpacing: "0.1em", fontWeight: 500, fontFamily: fontMono, textTransform: "uppercase" },
  qPrompt: { fontFamily: fontDisplay, fontSize: 19, fontWeight: 500, lineHeight: 1.4, margin: "0 0 20px", color: colors.ink },

  qOptions: { display: "flex", flexDirection: "column", gap: 8 },
  qOption: { display: "flex", alignItems: "flex-start", gap: 14, padding: "14px 18px", background: colors.paper, border: `1px solid ${colors.rule}`, cursor: "pointer", textAlign: "left", fontSize: 14, fontFamily: fontBody, color: colors.ink, transition: "all 0.15s", lineHeight: 1.5 },
  qOptionSelected: { background: colors.ochreSoft + "33", borderColor: colors.ochre, fontWeight: 500 },
  qOptionCorrect: { background: colors.green + "22", borderColor: colors.green, color: colors.green, fontWeight: 500 },
  qOptionWrong: { background: colors.red + "1a", borderColor: colors.red, color: colors.red },
  qOptionDim: { opacity: 0.45 },
  qOptionLetter: { fontFamily: fontMono, fontSize: 12, color: colors.inkMute, flexShrink: 0, paddingTop: 2 },
  qOptionText: { flex: 1 },

  qExplanationBlock: { marginTop: 22, padding: "18px 22px", background: colors.paper, border: `1px solid ${colors.rule}`, animation: "fadeIn 0.25s ease-out" },
  explanationHeader: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.18em", color: colors.inkMute, fontWeight: 500, marginBottom: 8, fontFamily: fontBody },
  explanationBody: { margin: 0, fontFamily: fontDisplay, fontSize: 15, lineHeight: 1.6, color: colors.inkSoft },
  qHintLine: { marginTop: 12, marginBottom: 0, fontFamily: fontDisplay, fontStyle: "italic", fontSize: 13, color: colors.inkMute, lineHeight: 1.5 },
  qHintLabel: { fontStyle: "normal", fontWeight: 500, color: colors.ochre },

  recsBlock: { marginTop: 22, padding: "18px 22px", background: colors.paper, border: `1px solid ${colors.blue}`, borderLeftWidth: 4, animation: "fadeIn 0.3s ease-out" },
  recsHeader: { marginBottom: 12, display: "flex", flexDirection: "column", gap: 2 },
  recsLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.blue, fontWeight: 500, fontFamily: fontBody },
  recsSubLabel: { fontSize: 12, fontStyle: "italic", color: colors.inkMute, fontFamily: fontDisplay },
  recsList: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 },
  recItem: {},
  recLink: { display: "flex", alignItems: "center", gap: 14, padding: "10px 12px", textDecoration: "none", color: colors.ink, transition: "background 0.15s" },
  recTime: { fontFamily: fontMono, fontSize: 12, color: colors.ochre, flexShrink: 0, minWidth: 45 },
  recBody: { flex: 1, display: "flex", flexDirection: "column", gap: 2 },
  recConcept: { fontFamily: fontDisplay, fontSize: 14, color: colors.ink, lineHeight: 1.3 },
  recLesson: { fontFamily: fontBody, fontSize: 11, color: colors.inkMute, textTransform: "uppercase", letterSpacing: "0.08em" },
  recArrow: { fontSize: 14, color: colors.inkMute, flexShrink: 0 },

  footer: { marginTop: 32, padding: "20px 24px", background: colors.cream, border: `1px solid ${colors.rule}`, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" },
  footerNote: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 15, color: colors.inkSoft },
  primaryBtn: { background: colors.ink, color: colors.cream, border: "none", padding: "12px 24px", fontSize: 13, fontFamily: fontBody, fontWeight: 500, cursor: "pointer", letterSpacing: "0.02em" },
  secondaryBtn: { background: "transparent", color: colors.ink, border: `1px solid ${colors.ink}`, padding: "10px 20px", fontSize: 13, fontFamily: fontBody, cursor: "pointer" },
};
