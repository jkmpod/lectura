"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

// ============================================================================
// LECTURA — Lesson Player (JSON-driven, with timeline annotations)
//
// Annotation types: context | quiz | recap   (concepts are rendered separately)
// Annotation behaviors: soft (toast) | marker (timeline only) | pause (blocking)
// ============================================================================

const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "hi", name: "हिन्दी (Hindi)" },
  { code: "ta", name: "தமிழ் (Tamil)" },
  { code: "gu", name: "ગુજરાતી (Gujarati)" },
  { code: "te", name: "తెలుగు (Telugu)" },
  { code: "bn", name: "বাংলা (Bangla)" },
  { code: "kn", name: "ಕನ್ನಡ (Kannada)" },
  { code: "ml", name: "മലയാളം (Malayalam)" },
  { code: "mr", name: "मराठी (Marathi)" },
  { code: "pa", name: "ਪੰਜਾਬੀ (Punjabi)" },
];

const ANNOTATION_STYLE = {
  context: { color: "#3a6b9c", label: "Context", icon: "ⓘ" },
  quiz:    { color: "#a8651b", label: "Quiz",    icon: "?" },
  recap:   { color: "#4a6b3a", label: "Recap",   icon: "↻" },
};
const CONCEPT_STYLE = { color: "#6b6258", label: "Key idea", icon: "◆" };

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

// Returns a shuffled permutation of [0, 1, ..., n-1] for displaying quiz options
// in a random order without mutating the underlying data. Each entry in the
// returned array is an ORIGINAL index; the array position is the DISPLAY position.
function permutationFor(question) {
  if (!question?.options) return [];
  return shuffle(question.options.map((_, i) => i));
}

export default function LessonPage() {
  const params = useParams();
  const lessonId = params.id;

  const [lesson, setLesson] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [currentTime, setCurrentTime] = useState(0);
  const playerRef = useRef(null);
  const rafRef = useRef(null);
  // Track which annotation ids have fired this session (to avoid re-triggering on rewind)
  const firedAnnotationsRef = useRef(new Set());
  const lastTimeRef = useRef(0);

  const [activeTab, setActiveTab] = useState("transcript");
  const [transcriptLang, setTranscriptLang] = useState("en");

  // Annotation UI state
  const [softToast, setSoftToast] = useState(null);
  const [pauseModal, setPauseModal] = useState(null);

  // Practice tab quiz state
  const [quiz, setQuiz] = useState({
    queue: [],
    currentIdx: -1,
    showHint: false,
    userAnswer: null,
    permutation: [],
  });

  // ---------- Load lesson ----------
  useEffect(() => {
    async function loadLesson() {
      try {
        const indexRes = await fetch("/lessons/index.json");
        const index = await indexRes.json();
        const entry = index.lessons.find((l) => l.id === lessonId);
        if (!entry) throw new Error(`Lesson "${lessonId}" not found`);

        const res = await fetch(`/lessons/${entry.file}`);
        if (!res.ok) throw new Error("Could not load lesson data");
        const data = await res.json();
        setLesson(data);
      } catch (e) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    loadLesson();
  }, [lessonId]);

  // ---------- Initialize question queue ----------
  useEffect(() => {
    if (lesson?.questions?.length) {
      setQuiz({
        queue: shuffle(lesson.questions.map((q) => q.id)),
        currentIdx: -1,
        showHint: false,
        userAnswer: null,
        permutation: [],
      });
    }
  }, [lesson]);

  // ---------- YouTube player ----------
  useEffect(() => {
    if (!lesson?.youtubeId) return;

    const onAPIReady = () => {
      if (!window.YT || !window.YT.Player) return;
      playerRef.current = new window.YT.Player("yt-player", {
        videoId: lesson.youtubeId,
        playerVars: { rel: 0, modestbranding: 1 },
        events: { onReady: startTimePolling },
      });
    };

    if (window.YT && window.YT.Player) {
      onAPIReady();
    } else {
      const existing = document.getElementById("yt-iframe-api");
      if (!existing) {
        const tag = document.createElement("script");
        tag.id = "yt-iframe-api";
        tag.src = "https://www.youtube.com/iframe_api";
        document.body.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = onAPIReady;
    }

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (playerRef.current?.destroy) {
        try { playerRef.current.destroy(); } catch (e) {}
      }
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lesson?.youtubeId]);

  const startTimePolling = () => {
    const tick = () => {
      try {
        if (playerRef.current?.getCurrentTime) {
          const t = playerRef.current.getCurrentTime();
          setCurrentTime(t);
          checkAnnotationCrossings(t);
          lastTimeRef.current = t;
        }
      } catch (e) {}
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();
  };

  // ---------- Annotation crossing detection ----------
  const checkAnnotationCrossings = (t) => {
    if (!lesson?.annotations?.length) return;
    const prev = lastTimeRef.current;
    // Only fire on forward crossings (prev < ts <= t)
    if (t < prev) return;

    for (const ann of lesson.annotations) {
      if (firedAnnotationsRef.current.has(ann.id)) continue;
      if (ann.timestamp > prev && ann.timestamp <= t) {
        firedAnnotationsRef.current.add(ann.id);
        triggerAnnotation(ann);
      }
    }
  };

  const triggerAnnotation = (ann) => {
    if (ann.behavior === "marker") return;
    if (ann.behavior === "pause") {
      playerRef.current?.pauseVideo?.();
      setPauseModal({ annotation: ann, userAnswer: null, showHint: false, permutation: permutationFor(ann) });
      return;
    }
    setSoftToast({ annotation: ann });
    setTimeout(() => {
      setSoftToast((prev) => (prev?.annotation.id === ann.id ? null : prev));
    }, 8000);
  };

  const seekTo = (seconds) => {
    if (playerRef.current?.seekTo) {
      playerRef.current.seekTo(seconds, true);
      playerRef.current.playVideo?.();
    }
  };

  // Jumping via timeline/concept click should reset crossing tracking for items past target,
  // so that scrubbing back-and-forth doesn't deadlock the user out of forward triggers.
  const seekToAndResetFired = (seconds) => {
    if (lesson?.annotations) {
      for (const ann of lesson.annotations) {
        if (ann.timestamp >= seconds) {
          firedAnnotationsRef.current.delete(ann.id);
        }
      }
    }
    lastTimeRef.current = seconds;
    seekTo(seconds);
  };

  // ---------- Transcript ----------
  const displayedTranscript = lesson
    ? (lesson.transcript[transcriptLang] || lesson.transcript.en || [])
    : [];

  const activeTranscriptIndex = displayedTranscript.findIndex(
    (s) => currentTime >= s.start && currentTime < s.end
  );

  const activeConceptIndex = (() => {
    if (!lesson?.concepts?.length) return -1;
    let idx = -1;
    for (let i = 0; i < lesson.concepts.length; i++) {
      if (currentTime >= lesson.concepts[i].timestamp) idx = i;
      else break;
    }
    return idx;
  })();

  const transcriptScrollRef = useRef(null);
  useEffect(() => {
    if (activeTranscriptIndex < 0 || !transcriptScrollRef.current) return;
    const el = transcriptScrollRef.current.querySelector(`[data-idx="${activeTranscriptIndex}"]`);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [activeTranscriptIndex]);

  // ---------- Practice tab quiz helpers ----------
  const currentQuestion = (() => {
    if (!lesson || quiz.currentIdx < 0 || quiz.currentIdx >= quiz.queue.length) return null;
    const qId = quiz.queue[quiz.currentIdx];
    return lesson.questions.find((q) => q.id === qId);
  })();

  const startQuiz = () =>
    setQuiz((q) => {
      const firstQ = lesson.questions.find((quest) => quest.id === q.queue[0]);
      return { ...q, currentIdx: 0, showHint: false, userAnswer: null, permutation: permutationFor(firstQ) };
    });
  const nextQuestion = () =>
    setQuiz((q) => {
      const nextIdx = q.currentIdx + 1;
      const nextQ = lesson.questions.find((quest) => quest.id === q.queue[nextIdx]);
      return { ...q, currentIdx: nextIdx, showHint: false, userAnswer: null, permutation: permutationFor(nextQ) };
    });
  const reshuffleAndRestart = () => {
    const newQueue = shuffle(lesson.questions.map((qq) => qq.id));
    const firstQ = lesson.questions.find((qq) => qq.id === newQueue[0]);
    setQuiz({
      queue: newQueue,
      currentIdx: 0,
      showHint: false,
      userAnswer: null,
      permutation: permutationFor(firstQ),
    });
  };
  const submitAnswer = (idx) => setQuiz((q) => ({ ...q, userAnswer: idx }));

  // ---------- Pause-modal quiz helpers ----------
  const submitPauseAnswer = (idx) => setPauseModal((m) => ({ ...m, userAnswer: idx }));
  const dismissPauseModal = () => {
    setPauseModal(null);
    playerRef.current?.playVideo?.();
  };

  // ============================================================================
  // RENDER
  // ============================================================================
  if (loading) {
    return (
      <div style={styles.loadingPage}>
        <style>{globalCSS}</style>
        <div style={styles.loadingDot} />
        <p style={styles.loadingMsg}>Opening the lesson…</p>
      </div>
    );
  }

  if (error || !lesson) {
    return (
      <div style={styles.loadingPage}>
        <style>{globalCSS}</style>
        <p style={styles.loadingMsg}>{error || "Lesson not found"}</p>
        <Link href="/" style={styles.backLink}>← Back to library</Link>
      </div>
    );
  }

  const timelineMarkers = [
    ...(lesson.concepts || []).map((c, i) => ({
      kind: "concept",
      id: `c${i}`,
      timestamp: c.timestamp,
      title: c.title,
      style: CONCEPT_STYLE,
    })),
    ...(lesson.annotations || []).map((a) => ({
      kind: "annotation",
      id: a.id,
      timestamp: a.timestamp,
      title: a.title,
      style: ANNOTATION_STYLE[a.type] || CONCEPT_STYLE,
      behavior: a.behavior,
      annotation: a,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  const annotationsList = lesson.annotations || [];
  const hasAnyAnnotations = annotationsList.length > 0;

  return (
    <div style={styles.app}>
      <style>{globalCSS}</style>

      <header style={styles.header}>
        <div style={styles.brand}>
          <Link href="/" style={styles.brandLink}>
            <span style={styles.brandMark}>※</span>
            <span style={styles.brandName}>Lectura</span>
          </Link>
          <span style={styles.lessonTitleHeader}>
            <span style={styles.headerSep}>·</span>
            {lesson.title}
          </span>
        </div>
        <Link href="/" style={styles.resetBtn}>↺ Library</Link>
      </header>

      <div style={styles.workspace}>
        <div style={styles.topHalf}>
          <div style={styles.videoCol}>
            <div style={styles.videoFrame}>
              <div id="yt-player" style={styles.ytPlayer}></div>
            </div>
            <TimelineRibbon
              markers={timelineMarkers}
              duration={lesson.duration}
              currentTime={currentTime}
              onSeek={seekToAndResetFired}
            />
          </div>

          <div style={styles.conceptsCol}>
            <div style={styles.conceptsHeader}>
              <span style={styles.conceptsLabel}>Key concepts</span>
              <span style={styles.conceptsCount}>{lesson.concepts.length}</span>
            </div>
            <div style={styles.conceptsList}>
              {lesson.concepts.map((c, i) => (
                <button
                  key={i}
                  onClick={() => seekToAndResetFired(c.timestamp)}
                  style={{
                    ...styles.conceptItem,
                    ...(i === activeConceptIndex ? styles.conceptItemActive : {}),
                  }}
                >
                  <span style={styles.conceptNum}>{String(i + 1).padStart(2, "0")}</span>
                  <span style={styles.conceptTitle}>{c.title}</span>
                  <span style={styles.conceptTime}>{formatTime(c.timestamp)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div style={styles.bottomHalf}>
          <div style={styles.tabBar}>
            {[
              { id: "transcript", label: "Transcript" },
              ...(hasAnyAnnotations ? [{ id: "annotations", label: "Annotations" }] : []),
              { id: "practice", label: "Practice" },
              { id: "learn-more", label: "Learn more" },
            ].map((t) => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                style={{
                  ...styles.tab,
                  ...(activeTab === t.id ? styles.tabActive : {}),
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div style={styles.tabContent}>
            {activeTab === "transcript" && (
              <div style={styles.transcriptWrap}>
                <div style={styles.transcriptToolbar}>
                  <span style={styles.toolbarLabel}>Language</span>
                  <select
                    value={transcriptLang}
                    onChange={(e) => setTranscriptLang(e.target.value)}
                    style={styles.select}
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.name}
                        {l.code !== "en" && !lesson.transcript[l.code] ? " (English fallback)" : ""}
                      </option>
                    ))}
                  </select>
                  {transcriptLang !== "en" && !lesson.transcript[transcriptLang] && (
                    <span style={styles.fallbackNote}>
                      Translation not yet available — showing English.
                    </span>
                  )}
                </div>
                <div style={styles.transcriptScroll} ref={transcriptScrollRef}>
                  {displayedTranscript.map((s, i) => (
                    <div
                      key={i}
                      data-idx={i}
                      onClick={() => seekToAndResetFired(s.start)}
                      style={{
                        ...styles.transcriptLine,
                        ...(i === activeTranscriptIndex ? styles.transcriptLineActive : {}),
                      }}
                    >
                      <span style={styles.transcriptTime}>{formatTime(s.start)}</span>
                      <span style={styles.transcriptText}>{s.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "annotations" && (
              <div style={styles.annotationsWrap}>
                <div style={styles.annotationsLegend}>
                  {Object.entries(ANNOTATION_STYLE).map(([type, st]) => {
                    const count = annotationsList.filter((a) => a.type === type).length;
                    return (
                      <span key={type} style={styles.legendItem}>
                        <span style={{ ...styles.legendDot, background: st.color }} />
                        <span>{st.label} ({count})</span>
                      </span>
                    );
                  })}
                </div>
                <div style={styles.annotationsList}>
                  {annotationsList.map((a) => {
                    const st = ANNOTATION_STYLE[a.type] || CONCEPT_STYLE;
                    return (
                      <div
                        key={a.id}
                        style={styles.annotationRow}
                        onClick={() => seekToAndResetFired(a.timestamp)}
                      >
                        <span style={styles.annTime}>{formatTime(a.timestamp)}</span>
                        <span style={{ ...styles.annTypePill, color: st.color, borderColor: st.color }}>
                          {st.label.toUpperCase()}
                        </span>
                        <span style={styles.annTitle}>{a.title}</span>
                        <span style={styles.annBehavior}>{a.behavior}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {activeTab === "practice" && (
              <div style={styles.practiceWrap}>
                {quiz.currentIdx === -1 && (
                  <div style={styles.practiceStart}>
                    <p style={styles.practiceIntro}>
                      {lesson.questions.length} practice questions, asked in random order.
                      Take your time — use the hint if you need a nudge.
                    </p>
                    <button onClick={startQuiz} style={styles.primaryBtn}>
                      Begin practice →
                    </button>
                  </div>
                )}

                {currentQuestion && (
                  <div style={styles.questionCard}>
                    <div style={styles.questionMeta}>
                      Question {quiz.currentIdx + 1} of {quiz.queue.length}
                      {currentQuestion.difficulty && (
                        <span style={styles.difficultyPill}>{currentQuestion.difficulty}</span>
                      )}
                    </div>
                    <h3 style={styles.questionText}>{currentQuestion.question}</h3>
                    <div style={styles.optionsList}>
                      {(quiz.permutation.length === currentQuestion.options.length
                        ? quiz.permutation
                        : currentQuestion.options.map((_, i) => i)
                      ).map((origIdx, displayPos) => {
                        const opt = currentQuestion.options[origIdx];
                        const answered = quiz.userAnswer !== null;
                        const isCorrect = origIdx === currentQuestion.correctIndex;
                        const isSelected = origIdx === quiz.userAnswer;
                        let optStyle = { ...styles.option };
                        if (answered) {
                          if (isCorrect) optStyle = { ...optStyle, ...styles.optionCorrect };
                          else if (isSelected) optStyle = { ...optStyle, ...styles.optionWrong };
                          else optStyle = { ...optStyle, ...styles.optionDim };
                        }
                        return (
                          <button
                            key={origIdx}
                            onClick={() => !answered && submitAnswer(origIdx)}
                            disabled={answered}
                            style={optStyle}
                          >
                            <span style={styles.optionLetter}>{String.fromCharCode(65 + displayPos)}</span>
                            <span>{opt}</span>
                          </button>
                        );
                      })}
                    </div>

                    {quiz.userAnswer === null && (
                      <div style={styles.questionActions}>
                        {!quiz.showHint ? (
                          <button
                            onClick={() => setQuiz((q) => ({ ...q, showHint: true }))}
                            style={styles.secondaryBtn}
                          >
                            ◇ Hint
                          </button>
                        ) : (
                          <div style={styles.hintBox}>
                            <span style={styles.hintLabel}>Hint</span>
                            <span>{currentQuestion.hint}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {quiz.userAnswer !== null && (
                      <>
                        <div
                          style={
                            quiz.userAnswer === currentQuestion.correctIndex
                              ? styles.feedbackCorrect
                              : styles.feedbackWrong
                          }
                        >
                          {quiz.userAnswer === currentQuestion.correctIndex ? "✓ Correct" : "✗ Not quite"}
                        </div>
                        <div style={styles.explanationBox}>
                          <span style={styles.explanationLabel}>Explanation</span>
                          <span>{currentQuestion.explanation}</span>
                        </div>
                        <div style={styles.nextRow}>
                          <span style={styles.nextPrompt}>
                            {quiz.currentIdx + 1 < quiz.queue.length
                              ? "Ready for another?"
                              : "That was the last one."}
                          </span>
                          {quiz.currentIdx + 1 < quiz.queue.length ? (
                            <button onClick={nextQuestion} style={styles.primaryBtn}>
                              Next question →
                            </button>
                          ) : (
                            <button onClick={reshuffleAndRestart} style={styles.primaryBtn}>
                              Reshuffle & restart ↻
                            </button>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === "learn-more" && (
              <div style={styles.relatedWrap}>
                <p style={styles.relatedIntro}>
                  Videos and resources to deepen your understanding of the concepts in this lesson.
                </p>
                {lesson.relatedVideos?.length > 0 ? (
                  <div style={styles.relatedGrid}>
                    {lesson.relatedVideos.map((r, i) => (
                      <a
                        key={i}
                        href={r.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={styles.relatedCard}
                        className="related-card"
                      >
                        <div style={styles.relatedCardHead}>
                          <span style={styles.relatedNum}>{String(i + 1).padStart(2, "0")}</span>
                          <span style={styles.relatedArrow}>↗</span>
                        </div>
                        <h4 style={styles.relatedTitle}>{r.title}</h4>
                        <p style={styles.relatedDesc}>{r.description}</p>
                      </a>
                    ))}
                  </div>
                ) : (
                  <p style={styles.emptyNote}>No further reading curated for this lesson yet.</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {softToast && (
        <SoftToast annotation={softToast.annotation} onClose={() => setSoftToast(null)} />
      )}

      {pauseModal && (
        <PauseModal
          state={pauseModal}
          onAnswer={submitPauseAnswer}
          onToggleHint={() => setPauseModal((m) => ({ ...m, showHint: !m.showHint }))}
          onContinue={dismissPauseModal}
        />
      )}
    </div>
  );
}

// ============================================================================
// TIMELINE RIBBON
// ============================================================================
function TimelineRibbon({ markers, duration, currentTime, onSeek }) {
  const [hoveredId, setHoveredId] = useState(null);
  const ribbonRef = useRef(null);

  if (!duration) return null;
  const progress = Math.min(100, (currentTime / duration) * 100);

  const handleTrackClick = (e) => {
    if (!ribbonRef.current) return;
    const rect = ribbonRef.current.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    onSeek(Math.max(0, Math.min(duration, pct * duration)));
  };

  return (
    <div style={ribbonStyles.wrap}>
      <div ref={ribbonRef} style={ribbonStyles.track} onClick={handleTrackClick}>
        <div style={{ ...ribbonStyles.progress, width: `${progress}%` }} />
        {markers.map((m) => {
          const left = `${(m.timestamp / duration) * 100}%`;
          const isHovered = hoveredId === m.id;
          return (
            <div
              key={m.id}
              style={{ ...ribbonStyles.markerWrap, left }}
              onMouseEnter={() => setHoveredId(m.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSeek(m.timestamp);
              }}
            >
              <div
                style={{
                  ...ribbonStyles.marker,
                  background: m.style.color,
                  ...(m.kind === "concept" ? ribbonStyles.markerConcept : {}),
                  ...(isHovered ? ribbonStyles.markerHover : {}),
                }}
              >
                <span style={ribbonStyles.markerIcon}>{m.style.icon}</span>
              </div>
              {isHovered && (
                <div style={ribbonStyles.tooltip}>
                  <div style={ribbonStyles.tooltipMeta}>
                    <span style={{ color: m.style.color, fontWeight: 600 }}>
                      {m.style.label}
                    </span>
                    <span style={ribbonStyles.tooltipTime}>{formatTime(m.timestamp)}</span>
                  </div>
                  <div style={ribbonStyles.tooltipTitle}>{m.title}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div style={ribbonStyles.legend}>
        <span style={ribbonStyles.legendTime}>{formatTime(currentTime)}</span>
        <div style={ribbonStyles.legendItems}>
          {markers.length > 0 && (
            <>
              <LegendChip style={CONCEPT_STYLE} label="Key idea" />
              {["context", "quiz", "recap"].map((type) => {
                const has = markers.some((m) => m.annotation?.type === type);
                if (!has) return null;
                return <LegendChip key={type} style={ANNOTATION_STYLE[type]} label={ANNOTATION_STYLE[type].label} />;
              })}
            </>
          )}
        </div>
        <span style={ribbonStyles.legendTime}>{formatTime(duration)}</span>
      </div>
    </div>
  );
}

function LegendChip({ style, label }) {
  return (
    <span style={ribbonStyles.legendChip}>
      <span style={{ ...ribbonStyles.legendDot, background: style.color }} />
      <span>{label}</span>
    </span>
  );
}

// ============================================================================
// SOFT TOAST
// ============================================================================
function SoftToast({ annotation, onClose }) {
  const st = ANNOTATION_STYLE[annotation.type] || CONCEPT_STYLE;
  return (
    <div style={toastStyles.wrap}>
      <div style={{ ...toastStyles.card, borderLeftColor: st.color }}>
        <div style={toastStyles.head}>
          <span style={{ ...toastStyles.pill, color: st.color, borderColor: st.color }}>
            {st.label}
          </span>
          <button onClick={onClose} style={toastStyles.closeBtn}>×</button>
        </div>
        <div style={toastStyles.title}>{annotation.title}</div>
        {annotation.body && <div style={toastStyles.body}>{annotation.body}</div>}
      </div>
    </div>
  );
}

// ============================================================================
// PAUSE MODAL
// ============================================================================
function PauseModal({ state, onAnswer, onToggleHint, onContinue }) {
  const { annotation: a, userAnswer, showHint, permutation } = state;
  const answered = userAnswer !== null;
  const isCorrect = answered && userAnswer === a.correctIndex;
  const displayOrder =
    permutation && permutation.length === a.options.length
      ? permutation
      : a.options.map((_, i) => i);

  return (
    <div style={modalStyles.scrim}>
      <div style={modalStyles.card}>
        <div style={modalStyles.head}>
          <span style={modalStyles.pill}>Pause for a quick check</span>
          <span style={modalStyles.timeTag}>{formatTime(a.timestamp)}</span>
        </div>
        {a.title && <div style={modalStyles.title}>{a.title}</div>}
        <h3 style={modalStyles.question}>{a.question}</h3>
        <div style={modalStyles.options}>
          {displayOrder.map((origIdx, displayPos) => {
            const opt = a.options[origIdx];
            const isCorrectOpt = origIdx === a.correctIndex;
            const isSelected = origIdx === userAnswer;
            let s = { ...modalStyles.option };
            if (answered) {
              if (isCorrectOpt) s = { ...s, ...modalStyles.optionCorrect };
              else if (isSelected) s = { ...s, ...modalStyles.optionWrong };
              else s = { ...s, ...modalStyles.optionDim };
            }
            return (
              <button
                key={origIdx}
                disabled={answered}
                onClick={() => !answered && onAnswer(origIdx)}
                style={s}
              >
                <span style={modalStyles.letter}>{String.fromCharCode(65 + displayPos)}</span>
                <span>{opt}</span>
              </button>
            );
          })}
        </div>

        {!answered && (
          <div style={modalStyles.actions}>
            {!showHint ? (
              <button onClick={onToggleHint} style={modalStyles.secondaryBtn}>
                ◇ Hint
              </button>
            ) : (
              <div style={modalStyles.hintBox}>
                <span style={modalStyles.hintLabel}>Hint</span>
                <span>{a.hint}</span>
              </div>
            )}
          </div>
        )}

        {answered && (
          <>
            <div style={isCorrect ? modalStyles.feedbackCorrect : modalStyles.feedbackWrong}>
              {isCorrect ? "✓ Correct" : "✗ Not quite"}
            </div>
            <div style={modalStyles.explanation}>
              <span style={modalStyles.explLabel}>Explanation</span>
              <span>{a.explanation}</span>
            </div>
            <div style={modalStyles.continueRow}>
              <button onClick={onContinue} style={modalStyles.primaryBtn}>
                Continue lesson →
              </button>
            </div>
          </>
        )}
      </div>
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
};

const fontDisplay = `'Fraunces', 'Cormorant Garamond', Georgia, serif`;
const fontBody = `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`;
const fontMono = `'JetBrains Mono', 'Courier New', monospace`;

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; background: ${colors.paper}; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
  @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  button:hover:not(:disabled) { opacity: 0.92; }
  .related-card:hover { background: ${colors.paperDeep} !important; transform: translateY(-1px); }
`;

const styles = {
  app: { minHeight: "100vh", background: colors.paper, color: colors.ink, fontFamily: fontBody, display: "flex", flexDirection: "column" },
  loadingPage: { minHeight: "100vh", background: colors.paper, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20, fontFamily: fontBody },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 32px", borderBottom: `1px solid ${colors.rule}`, background: colors.cream },
  brand: { display: "flex", alignItems: "baseline", gap: 12 },
  brandLink: { display: "flex", alignItems: "baseline", gap: 8, textDecoration: "none", color: colors.ink },
  brandMark: { fontSize: 22, color: colors.ochre, fontFamily: fontDisplay },
  brandName: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" },
  headerSep: { color: colors.inkMute, marginRight: 8 },
  lessonTitleHeader: { fontFamily: fontDisplay, fontSize: 15, fontStyle: "italic", color: colors.inkSoft },
  resetBtn: { background: "transparent", border: `1px solid ${colors.ink}`, color: colors.ink, padding: "7px 14px", fontSize: 12, fontFamily: fontBody, cursor: "pointer", letterSpacing: "0.02em", textDecoration: "none" },
  backLink: { color: colors.ochre, textDecoration: "none", fontSize: 14, fontFamily: fontBody, marginTop: 16 },
  workspace: { flex: 1, display: "flex", flexDirection: "column", height: "calc(100vh - 61px)" },
  topHalf: { flex: 1, display: "flex", minHeight: 0, borderBottom: `1px solid ${colors.rule}` },
  videoCol: { flex: "1 1 65%", background: colors.ink, display: "flex", flexDirection: "column" },
  videoFrame: { width: "100%", flex: 1, position: "relative", minHeight: 0 },
  ytPlayer: { width: "100%", height: "100%" },
  conceptsCol: { flex: "1 1 35%", maxWidth: 380, background: colors.cream, display: "flex", flexDirection: "column", borderLeft: `1px solid ${colors.rule}`, minHeight: 0 },
  conceptsHeader: { padding: "16px 24px 12px", display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: `1px solid ${colors.rule}` },
  conceptsLabel: { fontFamily: fontDisplay, fontSize: 18, fontWeight: 500 },
  conceptsCount: { fontSize: 11, color: colors.inkMute, fontFamily: fontMono },
  conceptsList: { flex: 1, overflowY: "auto", padding: "8px 0" },
  conceptItem: { display: "flex", alignItems: "baseline", gap: 12, width: "100%", padding: "12px 24px", background: "transparent", border: "none", borderLeft: `3px solid transparent`, textAlign: "left", cursor: "pointer", fontFamily: fontBody, color: colors.inkSoft, transition: "all 0.15s" },
  conceptItemActive: { background: colors.paperDeep, borderLeft: `3px solid ${colors.ochre}`, color: colors.ink },
  conceptNum: { fontFamily: fontMono, fontSize: 11, color: colors.ochre, flexShrink: 0, width: 22 },
  conceptTitle: { flex: 1, fontSize: 14, lineHeight: 1.35 },
  conceptTime: { fontFamily: fontMono, fontSize: 11, color: colors.inkMute, flexShrink: 0 },
  bottomHalf: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, background: colors.paper },
  tabBar: { display: "flex", borderBottom: `1px solid ${colors.rule}`, background: colors.cream, paddingLeft: 24 },
  tab: { background: "transparent", border: "none", padding: "14px 28px", fontSize: 12, fontFamily: fontBody, color: colors.inkMute, cursor: "pointer", letterSpacing: "0.05em", textTransform: "uppercase", fontWeight: 500, borderBottom: `2px solid transparent`, marginBottom: -1 },
  tabActive: { color: colors.ink, borderBottom: `2px solid ${colors.ochre}` },
  tabContent: { flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" },
  transcriptWrap: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0 },
  transcriptToolbar: { padding: "12px 32px", borderBottom: `1px solid ${colors.rule}`, display: "flex", alignItems: "center", gap: 12, background: colors.cream, flexWrap: "wrap" },
  toolbarLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.inkMute, fontWeight: 500 },
  select: { padding: "6px 10px", fontSize: 13, fontFamily: fontBody, border: `1px solid ${colors.rule}`, background: colors.paper, color: colors.ink, cursor: "pointer", outline: "none" },
  fallbackNote: { fontSize: 12, color: colors.ochre, fontStyle: "italic", fontFamily: fontDisplay },
  transcriptScroll: { flex: 1, overflowY: "auto", padding: "16px 32px 32px" },
  transcriptLine: { display: "flex", gap: 16, padding: "10px 12px", cursor: "pointer", transition: "all 0.2s", color: colors.inkSoft },
  transcriptLineActive: { background: colors.ochreSoft + "33", color: colors.ink, fontWeight: 500 },
  transcriptTime: { fontFamily: fontMono, fontSize: 11, color: colors.inkMute, flexShrink: 0, paddingTop: 3, width: 50 },
  transcriptText: { flex: 1, fontSize: 15, lineHeight: 1.6, fontFamily: fontDisplay },
  annotationsWrap: { flex: 1, overflowY: "auto", padding: "20px 32px" },
  annotationsLegend: { display: "flex", gap: 16, marginBottom: 20, flexWrap: "wrap", padding: "12px 16px", background: colors.cream, border: `1px solid ${colors.rule}`, fontSize: 12 },
  legendItem: { display: "flex", alignItems: "center", gap: 8, color: colors.inkSoft },
  legendDot: { width: 10, height: 10, borderRadius: "50%", display: "inline-block" },
  annotationsList: { display: "flex", flexDirection: "column", gap: 6 },
  annotationRow: { display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", background: colors.cream, border: `1px solid ${colors.rule}`, cursor: "pointer", transition: "all 0.15s" },
  annTime: { fontFamily: fontMono, fontSize: 12, color: colors.inkMute, width: 50, flexShrink: 0 },
  annTypePill: { fontSize: 10, padding: "3px 8px", border: "1px solid", letterSpacing: "0.1em", fontWeight: 500, fontFamily: fontMono, flexShrink: 0 },
  annTitle: { flex: 1, fontFamily: fontDisplay, fontSize: 15, color: colors.ink },
  annBehavior: { fontSize: 10, color: colors.inkMute, fontFamily: fontMono, textTransform: "uppercase", letterSpacing: "0.08em" },
  practiceWrap: { flex: 1, overflowY: "auto", padding: "32px 48px" },
  practiceStart: { maxWidth: 560, margin: "0 auto", textAlign: "center", paddingTop: 40 },
  practiceIntro: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, lineHeight: 1.6, color: colors.inkSoft, margin: "0 0 32px" },
  questionCard: { maxWidth: 720, width: "100%", margin: "0 auto", background: colors.cream, border: `1px solid ${colors.rule}`, padding: "32px 40px" },
  questionMeta: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.ochre, fontWeight: 500, marginBottom: 12, fontFamily: fontMono, display: "flex", alignItems: "center", gap: 12 },
  difficultyPill: { padding: "2px 8px", background: colors.paper, border: `1px solid ${colors.rule}`, color: colors.inkMute, fontSize: 10 },
  questionText: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 500, lineHeight: 1.35, margin: "0 0 24px", color: colors.ink },
  optionsList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 },
  option: { display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", background: colors.paper, border: `1px solid ${colors.rule}`, cursor: "pointer", textAlign: "left", fontSize: 14, fontFamily: fontBody, color: colors.ink, transition: "all 0.15s" },
  optionCorrect: { background: colors.green + "22", borderColor: colors.green, color: colors.green, fontWeight: 500 },
  optionWrong: { background: colors.red + "1a", borderColor: colors.red, color: colors.red },
  optionDim: { opacity: 0.45 },
  optionLetter: { fontFamily: fontMono, fontSize: 12, color: colors.inkMute, width: 20, flexShrink: 0 },
  questionActions: { marginTop: 8 },
  secondaryBtn: { background: "transparent", color: colors.ink, border: `1px solid ${colors.ink}`, padding: "10px 20px", fontSize: 13, fontFamily: fontBody, cursor: "pointer", letterSpacing: "0.02em" },
  primaryBtn: { background: colors.ink, color: colors.cream, border: "none", padding: "12px 24px", fontSize: 13, fontFamily: fontBody, fontWeight: 500, cursor: "pointer", letterSpacing: "0.02em" },
  hintBox: { background: colors.ochreSoft + "26", borderLeft: `3px solid ${colors.ochre}`, padding: "14px 18px", fontSize: 14, lineHeight: 1.5, color: colors.inkSoft, fontFamily: fontDisplay, display: "flex", flexDirection: "column", gap: 4 },
  hintLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.ochre, fontFamily: fontBody, fontWeight: 500 },
  feedbackCorrect: { color: colors.green, fontSize: 14, fontWeight: 500, marginBottom: 14 },
  feedbackWrong: { color: colors.red, fontSize: 14, fontWeight: 500, marginBottom: 14 },
  explanationBox: { background: colors.paper, border: `1px solid ${colors.rule}`, padding: "14px 18px", fontSize: 14, lineHeight: 1.55, color: colors.inkSoft, fontFamily: fontDisplay, marginBottom: 20, display: "flex", flexDirection: "column", gap: 4 },
  explanationLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.inkMute, fontFamily: fontBody, fontWeight: 500 },
  nextRow: { display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 16, borderTop: `1px solid ${colors.rule}`, gap: 12, flexWrap: "wrap" },
  nextPrompt: { fontFamily: fontDisplay, fontStyle: "italic", color: colors.inkSoft, fontSize: 15 },
  relatedWrap: { flex: 1, overflowY: "auto", padding: "32px 48px" },
  relatedIntro: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 16, color: colors.inkSoft, margin: "0 0 28px", maxWidth: 600 },
  relatedGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 },
  relatedCard: { display: "block", background: colors.cream, border: `1px solid ${colors.rule}`, padding: "20px 22px", textDecoration: "none", color: colors.ink, transition: "all 0.2s" },
  relatedCardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  relatedNum: { fontFamily: fontMono, fontSize: 11, color: colors.ochre },
  relatedArrow: { fontSize: 16, color: colors.inkMute },
  relatedTitle: { fontFamily: fontDisplay, fontSize: 17, fontWeight: 500, lineHeight: 1.3, margin: "0 0 8px" },
  relatedDesc: { fontSize: 13, lineHeight: 1.5, color: colors.inkSoft, margin: 0 },
  emptyNote: { fontFamily: fontDisplay, fontStyle: "italic", color: colors.inkMute, textAlign: "center", paddingTop: 40 },
  loadingDot: { width: 12, height: 12, borderRadius: "50%", background: colors.ochre, animation: "pulse 1.4s ease-in-out infinite" },
  loadingMsg: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, color: colors.inkSoft, margin: 0 },
};

const ribbonStyles = {
  wrap: { padding: "14px 20px 12px", background: "#0d0d0d", borderTop: `1px solid #222` },
  track: { position: "relative", height: 8, background: "#2a2a2a", cursor: "pointer", marginBottom: 26 },
  progress: { position: "absolute", top: 0, left: 0, height: "100%", background: colors.ochre, transition: "width 0.1s linear", opacity: 0.7 },
  markerWrap: { position: "absolute", top: "50%", transform: "translate(-50%, -50%)", cursor: "pointer", zIndex: 2 },
  marker: { width: 18, height: 18, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", border: `2px solid #0d0d0d`, transition: "transform 0.15s", color: "#fff", fontSize: 9, fontWeight: 700 },
  markerConcept: { width: 14, height: 14, opacity: 0.85 },
  markerHover: { transform: "scale(1.4)" },
  markerIcon: { lineHeight: 1, fontFamily: fontMono },
  tooltip: { position: "absolute", bottom: "calc(100% + 10px)", left: "50%", transform: "translateX(-50%)", background: colors.cream, color: colors.ink, padding: "8px 12px", minWidth: 180, maxWidth: 240, fontSize: 12, fontFamily: fontBody, border: `1px solid ${colors.rule}`, whiteSpace: "normal", animation: "fadeIn 0.15s", pointerEvents: "none", zIndex: 10 },
  tooltipMeta: { display: "flex", justifyContent: "space-between", fontSize: 10, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.08em" },
  tooltipTime: { color: colors.inkMute, fontFamily: fontMono },
  tooltipTitle: { fontFamily: fontDisplay, fontSize: 13, lineHeight: 1.35 },
  legend: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, color: "#888" },
  legendTime: { fontFamily: fontMono, fontSize: 11, color: "#888" },
  legendItems: { display: "flex", gap: 14, flexWrap: "wrap" },
  legendChip: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#aaa", fontFamily: fontBody },
  legendDot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
};

const toastStyles = {
  wrap: { position: "fixed", top: 80, right: 24, zIndex: 1000, maxWidth: 380, animation: "slideIn 0.25s ease-out" },
  card: { background: colors.cream, borderLeft: "4px solid", border: `1px solid ${colors.rule}`, padding: "16px 18px", boxShadow: "0 10px 30px -10px rgba(0,0,0,0.25)" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  pill: { fontSize: 10, padding: "3px 8px", border: "1px solid", letterSpacing: "0.1em", fontWeight: 500, fontFamily: fontMono, textTransform: "uppercase" },
  closeBtn: { background: "transparent", border: "none", color: colors.inkMute, cursor: "pointer", fontSize: 20, lineHeight: 1, padding: 0, marginRight: -4 },
  title: { fontFamily: fontDisplay, fontSize: 17, fontWeight: 500, marginBottom: 6, color: colors.ink },
  body: { fontFamily: fontDisplay, fontSize: 14, lineHeight: 1.5, color: colors.inkSoft },
};

const modalStyles = {
  scrim: { position: "fixed", inset: 0, background: "rgba(20, 18, 14, 0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999, padding: 20, animation: "fadeIn 0.2s" },
  card: { background: colors.cream, border: `1px solid ${colors.rule}`, maxWidth: 640, width: "100%", maxHeight: "90vh", overflowY: "auto", padding: "32px 40px", boxShadow: "0 30px 80px -20px rgba(0,0,0,0.4)", animation: "slideIn 0.25s ease-out" },
  head: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
  pill: { fontSize: 10, padding: "4px 10px", border: `1px solid ${colors.ochre}`, color: colors.ochre, letterSpacing: "0.12em", fontWeight: 500, fontFamily: fontMono, textTransform: "uppercase" },
  timeTag: { fontFamily: fontMono, fontSize: 11, color: colors.inkMute },
  title: { fontFamily: fontDisplay, fontSize: 14, fontStyle: "italic", color: colors.inkMute, marginBottom: 8 },
  question: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 500, lineHeight: 1.35, margin: "0 0 24px", color: colors.ink },
  options: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 },
  option: { display: "flex", alignItems: "center", gap: 14, padding: "14px 18px", background: colors.paper, border: `1px solid ${colors.rule}`, cursor: "pointer", textAlign: "left", fontSize: 14, fontFamily: fontBody, color: colors.ink, transition: "all 0.15s" },
  optionCorrect: { background: colors.green + "22", borderColor: colors.green, color: colors.green, fontWeight: 500 },
  optionWrong: { background: colors.red + "1a", borderColor: colors.red, color: colors.red },
  optionDim: { opacity: 0.45 },
  letter: { fontFamily: fontMono, fontSize: 12, color: colors.inkMute, width: 20, flexShrink: 0 },
  actions: { marginTop: 8 },
  secondaryBtn: { background: "transparent", color: colors.ink, border: `1px solid ${colors.ink}`, padding: "10px 20px", fontSize: 13, fontFamily: fontBody, cursor: "pointer" },
  primaryBtn: { background: colors.ink, color: colors.cream, border: "none", padding: "12px 24px", fontSize: 13, fontFamily: fontBody, fontWeight: 500, cursor: "pointer", letterSpacing: "0.02em" },
  hintBox: { background: colors.ochreSoft + "26", borderLeft: `3px solid ${colors.ochre}`, padding: "14px 18px", fontSize: 14, lineHeight: 1.5, color: colors.inkSoft, fontFamily: fontDisplay, display: "flex", flexDirection: "column", gap: 4 },
  hintLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.ochre, fontFamily: fontBody, fontWeight: 500 },
  feedbackCorrect: { color: colors.green, fontSize: 14, fontWeight: 500, marginBottom: 14 },
  feedbackWrong: { color: colors.red, fontSize: 14, fontWeight: 500, marginBottom: 14 },
  explanation: { background: colors.paper, border: `1px solid ${colors.rule}`, padding: "14px 18px", fontSize: 14, lineHeight: 1.55, color: colors.inkSoft, fontFamily: fontDisplay, marginBottom: 20, display: "flex", flexDirection: "column", gap: 4 },
  explLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.inkMute, fontFamily: fontBody, fontWeight: 500 },
  continueRow: { display: "flex", justifyContent: "flex-end", paddingTop: 14, borderTop: `1px solid ${colors.rule}` },
};