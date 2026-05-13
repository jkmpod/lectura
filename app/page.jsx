"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";

export default function HomePage() {
  const [lessons, setLessons] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadLessons() {
      try {
        const indexRes = await fetch("/lessons/index.json");
        if (!indexRes.ok) throw new Error("Could not load lesson index");
        const index = await indexRes.json();

        const lessonData = await Promise.all(
          index.lessons.map(async (entry) => {
            const res = await fetch(`/lessons/${entry.file}`);
            if (!res.ok) throw new Error(`Could not load ${entry.file}`);
            const data = await res.json();
            return { id: entry.id, ...data };
          })
        );
        setLessons(lessonData);
      } catch (e) {
        console.error(e);
        setError(e.message);
      } finally {
        setLoading(false);
      }
    }
    loadLessons();
  }, []);

  return (
    <div style={styles.page}>
      <style>{globalCSS}</style>

      <header style={styles.header}>
        <div style={styles.brand}>
          <span style={styles.brandMark}>※</span>
          <span style={styles.brandName}>Lectura</span>
          <span style={styles.brandSub}>· a study companion</span>
        </div>
      </header>

      <main style={styles.main}>
        <div style={styles.hero}>
          <h1 style={styles.heroTitle}>The library</h1>
          <p style={styles.heroLede}>
            A small, curated set of lessons. Each one comes with synced transcripts in
            multiple languages, practice questions, and further reading.
          </p>
        </div>

        {loading && (
          <div style={styles.loadingWrap}>
            <div style={styles.loadingDot} />
            <p style={styles.loadingMsg}>Opening the library…</p>
          </div>
        )}

        {error && <div style={styles.errorBar}>{error}</div>}

        {!loading && !error && (
          <div style={styles.grid}>
            {lessons.map((lesson, i) => (
              <Link
                key={lesson.id}
                href={`/lesson/${lesson.id}`}
                style={styles.card}
                className="lesson-card"
              >
                <div style={styles.thumbWrap}>
                  <img
                    src={
                      lesson.thumbnailUrl ||
                      `https://img.youtube.com/vi/${lesson.youtubeId}/maxresdefault.jpg`
                    }
                    alt={lesson.title}
                    style={styles.thumb}
                    onError={(e) => {
                      // Fallback to lower-res thumbnail if maxres unavailable
                      e.target.src = `https://img.youtube.com/vi/${lesson.youtubeId}/hqdefault.jpg`;
                    }}
                  />
                  <div style={styles.thumbOverlay}>
                    <span style={styles.cardNum}>{String(i + 1).padStart(2, "0")}</span>
                  </div>
                </div>
                <div style={styles.cardBody}>
                  <div style={styles.cardCourse}>{lesson.course}</div>
                  <h2 style={styles.cardTitle}>{lesson.title}</h2>
                  {lesson.subtitle && <p style={styles.cardSubtitle}>{lesson.subtitle}</p>}
                  <div style={styles.cardMeta}>
                    <span>{lesson.instructor}</span>
                    <span style={styles.cardMetaSep}>·</span>
                    <span>{formatDuration(lesson.duration)}</span>
                    <span style={styles.cardMetaSep}>·</span>
                    <span>{lesson.questions?.length || 0} questions</span>
                  </div>
                  <div style={styles.cardCta}>Begin lesson →</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>

      <footer style={styles.footer}>
        <span>A learning prototype.</span>
      </footer>
    </div>
  );
}

function formatDuration(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

// ============================================================================
// Shared design tokens (also imported by lesson page)
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
  cream: "#faf6ec",
  red: "#9a3a2a",
};

const fontDisplay = `'Fraunces', 'Cormorant Garamond', Georgia, serif`;
const fontBody = `'Inter', -apple-system, BlinkMacSystemFont, sans-serif`;
const fontMono = `'JetBrains Mono', 'Courier New', monospace`;

const globalCSS = `
  @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
  * { box-sizing: border-box; }
  body { margin: 0; background: ${colors.paper}; }
  .lesson-card:hover { transform: translateY(-3px); box-shadow: 0 30px 60px -30px rgba(58, 53, 48, 0.25); }
  .lesson-card:hover .card-cta { color: ${colors.ochre}; }
  @keyframes pulse { 0%, 100% { opacity: 0.3; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.1); } }
`;

const styles = {
  page: {
    minHeight: "100vh",
    background: colors.paper,
    backgroundImage: `
      radial-gradient(ellipse at top left, rgba(168, 101, 27, 0.05), transparent 50%),
      radial-gradient(ellipse at bottom right, rgba(74, 107, 58, 0.03), transparent 50%)
    `,
    color: colors.ink,
    fontFamily: fontBody,
    display: "flex",
    flexDirection: "column",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "18px 32px",
    borderBottom: `1px solid ${colors.rule}`,
    background: colors.cream,
  },
  brand: { display: "flex", alignItems: "baseline", gap: 10 },
  brandMark: { fontSize: 24, color: colors.ochre, fontFamily: fontDisplay },
  brandName: {
    fontFamily: fontDisplay,
    fontSize: 24,
    fontWeight: 600,
    letterSpacing: "-0.02em",
  },
  brandSub: { fontSize: 13, color: colors.inkMute, fontStyle: "italic" },
  main: {
    flex: 1,
    maxWidth: 1100,
    width: "100%",
    margin: "0 auto",
    padding: "60px 32px",
  },
  hero: { marginBottom: 56, maxWidth: 640 },
  heroTitle: {
    fontFamily: fontDisplay,
    fontSize: 56,
    fontWeight: 500,
    letterSpacing: "-0.03em",
    lineHeight: 1.0,
    margin: "0 0 20px",
  },
  heroLede: {
    fontFamily: fontDisplay,
    fontStyle: "italic",
    fontSize: 19,
    lineHeight: 1.55,
    color: colors.inkSoft,
    margin: 0,
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 24,
  },
  card: {
    display: "flex",
    flexDirection: "column",
    background: colors.cream,
    border: `1px solid ${colors.rule}`,
    textDecoration: "none",
    color: colors.ink,
    overflow: "hidden",
    transition: "all 0.25s ease",
  },
  thumbWrap: {
    position: "relative",
    width: "100%",
    paddingTop: "56.25%",
    background: colors.ink,
    overflow: "hidden",
  },
  thumb: {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  thumbOverlay: {
    position: "absolute",
    top: 12,
    left: 12,
    background: colors.cream,
    padding: "4px 10px",
  },
  cardNum: {
    fontFamily: fontMono,
    fontSize: 11,
    color: colors.ochre,
    fontWeight: 500,
  },
  cardBody: { padding: "22px 24px 24px", flex: 1, display: "flex", flexDirection: "column" },
  cardCourse: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: "0.15em",
    color: colors.ochre,
    fontWeight: 500,
    marginBottom: 10,
    fontFamily: fontMono,
  },
  cardTitle: {
    fontFamily: fontDisplay,
    fontSize: 22,
    fontWeight: 500,
    lineHeight: 1.25,
    margin: "0 0 8px",
    letterSpacing: "-0.01em",
  },
  cardSubtitle: {
    fontFamily: fontDisplay,
    fontStyle: "italic",
    fontSize: 14,
    lineHeight: 1.5,
    color: colors.inkSoft,
    margin: "0 0 14px",
  },
  cardMeta: {
    fontSize: 12,
    color: colors.inkMute,
    marginBottom: 18,
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
  },
  cardMetaSep: { opacity: 0.5 },
  cardCta: {
    marginTop: "auto",
    fontSize: 13,
    fontWeight: 500,
    color: colors.ink,
    paddingTop: 14,
    borderTop: `1px solid ${colors.rule}`,
    transition: "color 0.2s",
  },
  loadingWrap: {
    padding: "80px 20px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 20,
  },
  loadingDot: {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: colors.ochre,
    animation: "pulse 1.4s ease-in-out infinite",
  },
  loadingMsg: {
    fontFamily: fontDisplay,
    fontStyle: "italic",
    fontSize: 17,
    color: colors.inkSoft,
    margin: 0,
  },
  errorBar: {
    background: colors.red,
    color: colors.cream,
    padding: "12px 20px",
    fontSize: 13,
  },
  footer: {
    padding: "32px",
    textAlign: "center",
    fontSize: 12,
    color: colors.inkMute,
    fontStyle: "italic",
    fontFamily: fontDisplay,
    borderTop: `1px solid ${colors.rule}`,
  },
};
