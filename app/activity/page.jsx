"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import {
  readLog,
  clearLog,
  getSubjectId,
  track,
  EVENT_TYPES,
} from "@/lib/tracker";
import {
  buildCredential,
  downloadCredential,
  summarizeLog,
} from "@/lib/credential";

// ============================================================================
// LECTURA — My Activity (study log dashboard + credential export)
// ============================================================================

export default function ActivityPage() {
  const [log, setLog] = useState([]);
  const [summary, setSummary] = useState(null);
  const [subjectId, setSubjectId] = useState(null);
  const [showRawLog, setShowRawLog] = useState(false);

  // Credential preview state
  const [previewCred, setPreviewCred] = useState(null);
  const [studentName, setStudentName] = useState("");
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    const fresh = readLog();
    setLog(fresh);
    setSummary(summarizeLog(fresh));
    setSubjectId(getSubjectId());
    track(EVENT_TYPES.ACTIVITY_VIEWED, {});
  }, []);

  const handlePreview = async () => {
    setBuilding(true);
    try {
      const cred = await buildCredential({
        studentName: studentName.trim() || undefined,
      });
      setPreviewCred(cred);
    } catch (e) {
      console.error("Could not build credential", e);
      alert("Something went wrong building the credential. See console.");
    } finally {
      setBuilding(false);
    }
  };

  const handleDownload = () => {
    if (!previewCred) return;
    const filename = downloadCredential(previewCred);
    track(EVENT_TYPES.CREDENTIAL_EXPORTED, {
      filename,
      subjectId: previewCred.credentialSubject?.id,
      summary: previewCred["lectura:summary"],
    });
    // Refresh the log so the export event itself shows up
    const fresh = readLog();
    setLog(fresh);
    setSummary(summarizeLog(fresh));
  };

  const handleClearLog = () => {
    if (!window.confirm("Erase your entire study log? This cannot be undone.")) return;
    clearLog();
    setLog([]);
    setSummary(summarizeLog([]));
    setPreviewCred(null);
  };

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
            My Activity
          </span>
        </div>
        <Link href="/" style={styles.libraryBtn}>↺ Library</Link>
      </header>

      <main style={styles.main}>
        <div style={styles.titleBlock}>
          <h1 style={styles.title}>Your study log</h1>
          <p style={styles.subtitle}>
            A record of what you've engaged with on Lectura. Stored on this
            device only — no server keeps a copy.
          </p>
          {subjectId && (
            <div style={styles.subjectIdLine}>
              <span style={styles.subjectIdLabel}>Anonymous subject ID</span>
              <code style={styles.subjectIdValue}>{subjectId}</code>
            </div>
          )}
        </div>

        {(!summary || summary.totalEvents === 0) ? (
          <EmptyState />
        ) : (
          <>
            <OverviewCards summary={summary} />

            {Object.keys(summary.lessons).length > 0 && (
              <Section title="Lesson engagement">
                <LessonTable lessons={summary.lessons} />
              </Section>
            )}

            {Object.keys(summary.assignments).length > 0 && (
              <Section title="Assignment engagement">
                <AssignmentTable assignments={summary.assignments} />
              </Section>
            )}

            {summary.conceptsCovered.length > 0 && (
              <Section title="Concepts touched">
                <ConceptList concepts={summary.conceptsCovered} />
              </Section>
            )}

            <Section title="Raw event log">
              <button
                onClick={() => setShowRawLog((s) => !s)}
                style={styles.toggleBtn}
              >
                {showRawLog ? "Hide raw log" : `Show all ${log.length} events`}
              </button>
              {showRawLog && <RawLog log={log} />}
            </Section>

            <Section title="Export as Open Badges 3.0 credential">
              <CredentialPanel
                studentName={studentName}
                setStudentName={setStudentName}
                onPreview={handlePreview}
                building={building}
                preview={previewCred}
                onDownload={handleDownload}
              />
            </Section>

            <Section title="Manage your data">
              <p style={styles.bodyText}>
                This log is stored in your browser's localStorage. You can clear
                it at any time. Clearing the log also resets your anonymous
                subject ID, so a new credential exported after clearing will
                not link to credentials exported before.
              </p>
              <button onClick={handleClearLog} style={styles.dangerBtn}>
                Clear my entire study log
              </button>
            </Section>
          </>
        )}
      </main>
    </div>
  );
}

// ============================================================================
// Sub-components
// ============================================================================

function EmptyState() {
  return (
    <div style={styles.empty}>
      <p style={styles.emptyMsg}>
        Your study log is empty. As you watch lessons and attempt assignments,
        events will appear here.
      </p>
      <div style={styles.emptyActions}>
        <Link href="/" style={styles.primaryBtn}>Open the library</Link>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section style={styles.section}>
      <h2 style={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

function OverviewCards({ summary }) {
  const lessonCount = Object.keys(summary.lessons).length;
  const assignmentCount = Object.keys(summary.assignments).length;
  const recRate = summary.recommendationsShown > 0
    ? Math.round((summary.recommendationsClicked / summary.recommendationsShown) * 100)
    : null;

  return (
    <div style={styles.overviewGrid}>
      <StatCard label="Lessons engaged" value={lessonCount} />
      <StatCard label="Assignments attempted" value={assignmentCount} />
      <StatCard label="Concepts touched" value={summary.conceptsCovered.length} />
      <StatCard
        label="Recommendations followed"
        value={
          recRate === null
            ? "—"
            : `${summary.recommendationsClicked} / ${summary.recommendationsShown}`
        }
        sub={recRate === null ? null : `${recRate}% click-through`}
      />
    </div>
  );
}

function StatCard({ label, value, sub }) {
  return (
    <div style={styles.statCard}>
      <div style={styles.statValue}>{value}</div>
      <div style={styles.statLabel}>{label}</div>
      {sub && <div style={styles.statSub}>{sub}</div>}
    </div>
  );
}

function LessonTable({ lessons }) {
  const rows = Object.entries(lessons);
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Lesson</th>
          <th style={styles.thNum}>Progress</th>
          <th style={styles.thNum}>Annotations</th>
          <th style={styles.thNum}>Practice</th>
          <th style={styles.thNum}>Pause quiz</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, ls]) => (
          <tr key={id}>
            <td style={styles.td}>
              <Link href={`/lesson/${id}`} style={styles.tableLink}>{id}</Link>
            </td>
            <td style={styles.tdNum}>
              {ls.completionPct !== null
                ? `${ls.completionPct}%`
                : formatSec(ls.maxPosition)}
            </td>
            <td style={styles.tdNum}>{ls.annotationsTriggered}</td>
            <td style={styles.tdNum}>
              {ls.practiceQuestionsCorrect} / {ls.practiceQuestionsAttempted}
            </td>
            <td style={styles.tdNum}>
              {ls.pauseQuizzesCorrect} / {ls.pauseQuizzesAnswered}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AssignmentTable({ assignments }) {
  const rows = Object.entries(assignments);
  return (
    <table style={styles.table}>
      <thead>
        <tr>
          <th style={styles.th}>Assignment</th>
          <th style={styles.thNum}>Attempted</th>
          <th style={styles.thNum}>Score</th>
          <th style={styles.thNum}>Recs followed</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([id, a]) => (
          <tr key={id}>
            <td style={styles.td}>
              <Link href={`/assignment/${id}`} style={styles.tableLink}>{id}</Link>
            </td>
            <td style={styles.tdNum}>
              {a.questionsAttempted} / {a.questionsTotal}
            </td>
            <td style={styles.tdNum}>
              {a.revealed
                ? `${a.correctCount} / ${a.questionsTotal}`
                : "—"}
            </td>
            <td style={styles.tdNum}>
              {a.recommendationsClicked} / {a.recommendationsShown}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ConceptList({ concepts }) {
  return (
    <div style={styles.conceptList}>
      {concepts.map((c) => (
        <span key={c} style={styles.conceptChip}>{c}</span>
      ))}
    </div>
  );
}

function RawLog({ log }) {
  // Show newest first
  const ordered = [...log].reverse();
  return (
    <div style={styles.rawLog}>
      {ordered.map((e, i) => (
        <div key={i} style={styles.rawRow}>
          <span style={styles.rawTime}>
            {new Date(e.ts).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })}
          </span>
          <span style={styles.rawType}>{e.type}</span>
          <span style={styles.rawPayload}>
            {JSON.stringify(e.payload || {})}
          </span>
        </div>
      ))}
    </div>
  );
}

function CredentialPanel({
  studentName, setStudentName, onPreview, building, preview, onDownload,
}) {
  return (
    <div style={styles.credPanel}>
      <div style={styles.credIntro}>
        <p style={styles.bodyText}>
          Export your study log as an{" "}
          <a
            href="https://www.imsglobal.org/spec/ob/v3p0"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.inlineLink}
          >
            Open Badges 3.0
          </a>{" "}
          / W3C Verifiable Credential. The exported file describes what you've
          done on Lectura in a portable, machine-readable format.
        </p>
        <div style={styles.warningBox}>
          <span style={styles.warningLabel}>Honest note</span>
          <p style={styles.warningBody}>
            This credential conforms to the Open Badges 3.0 data model, but it
            is <strong>not cryptographically signed</strong>. The Lectura MVP
            has no signing authority. A SHA-256 integrity hash is included so
            anyone can detect post-export edits to the file, but the underlying
            engagement data is self-reported and not independently verified.
            When a future Lectura signing authority is set up, the same
            credential structure will be issued with a real{" "}
            <code style={styles.inlineCode}>proof</code> field, and credentials
            issued today will need to be re-issued to be cryptographically
            verifiable.
          </p>
        </div>
      </div>

      <div style={styles.credForm}>
        <label style={styles.label}>
          <span style={styles.labelText}>Your name (optional)</span>
          <input
            type="text"
            value={studentName}
            onChange={(e) => setStudentName(e.target.value)}
            placeholder="Leave blank for an anonymous credential"
            style={styles.input}
          />
          <span style={styles.helpText}>
            If left blank, only your anonymous subject ID appears in the
            credential. If you provide a name, it's stored in plaintext in the
            credential (the Lectura MVP does not perform identity hashing).
          </span>
        </label>

        <div style={styles.credActions}>
          <button
            onClick={onPreview}
            disabled={building}
            style={styles.primaryBtn}
          >
            {building ? "Building…" : preview ? "Rebuild preview" : "Preview credential"}
          </button>
          {preview && (
            <button onClick={onDownload} style={styles.secondaryBtn}>
              Download credential (.json)
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div style={styles.preview}>
          <div style={styles.previewHeader}>
            <span style={styles.previewLabel}>Preview</span>
            <span style={styles.previewSub}>
              Review the contents before downloading
            </span>
          </div>
          <pre style={styles.previewPre}>
            {JSON.stringify(preview, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatSec(s) {
  if (!s) return "0:00";
  const m = Math.floor(s / 60);
  const ss = String(Math.floor(s % 60)).padStart(2, "0");
  return `${m}:${ss}`;
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
  button:hover:not(:disabled) { opacity: 0.92; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const styles = {
  app: { minHeight: "100vh", background: colors.paper, color: colors.ink, fontFamily: fontBody },

  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 32px", borderBottom: `1px solid ${colors.rule}`, background: colors.cream },
  brand: { display: "flex", alignItems: "baseline", gap: 12 },
  brandLink: { display: "flex", alignItems: "baseline", gap: 8, textDecoration: "none", color: colors.ink },
  brandMark: { fontSize: 22, color: colors.ochre, fontFamily: fontDisplay },
  brandName: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" },
  crumb: { fontFamily: fontDisplay, fontSize: 15, fontStyle: "italic", color: colors.inkSoft },
  crumbSep: { color: colors.inkMute, marginRight: 8 },
  libraryBtn: { background: "transparent", border: `1px solid ${colors.ink}`, color: colors.ink, padding: "7px 14px", fontSize: 12, fontFamily: fontBody, cursor: "pointer", letterSpacing: "0.02em", textDecoration: "none" },

  main: { maxWidth: 880, margin: "0 auto", padding: "32px 32px 80px" },

  titleBlock: { marginBottom: 36, paddingBottom: 24, borderBottom: `1px solid ${colors.rule}` },
  title: { fontFamily: fontDisplay, fontSize: 42, fontWeight: 500, lineHeight: 1.15, margin: "0 0 12px", color: colors.ink, letterSpacing: "-0.02em" },
  subtitle: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, color: colors.inkSoft, margin: "0 0 16px", lineHeight: 1.4 },

  subjectIdLine: { display: "flex", alignItems: "center", gap: 12, marginTop: 12 },
  subjectIdLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.inkMute, fontWeight: 500 },
  subjectIdValue: { fontFamily: fontMono, fontSize: 12, color: colors.inkSoft, background: colors.cream, padding: "3px 8px", border: `1px solid ${colors.rule}` },

  empty: { textAlign: "center", padding: "60px 20px", background: colors.cream, border: `1px solid ${colors.rule}` },
  emptyMsg: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 17, color: colors.inkSoft, margin: "0 0 20px" },
  emptyActions: { display: "flex", justifyContent: "center", gap: 12 },

  overviewGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 16, marginBottom: 40 },
  statCard: { background: colors.cream, border: `1px solid ${colors.rule}`, padding: "20px 22px" },
  statValue: { fontFamily: fontDisplay, fontSize: 36, fontWeight: 500, color: colors.ink, lineHeight: 1.0, marginBottom: 6 },
  statLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: colors.inkMute, fontWeight: 500 },
  statSub: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 13, color: colors.inkSoft, marginTop: 4 },

  section: { marginBottom: 40 },
  sectionTitle: { fontFamily: fontDisplay, fontSize: 22, fontWeight: 500, letterSpacing: "-0.01em", margin: "0 0 16px", color: colors.ink },

  table: { width: "100%", borderCollapse: "collapse", background: colors.cream, border: `1px solid ${colors.rule}`, fontSize: 13 },
  th: { textAlign: "left", padding: "10px 14px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: colors.inkMute, fontWeight: 500, borderBottom: `1px solid ${colors.rule}` },
  thNum: { textAlign: "right", padding: "10px 14px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: colors.inkMute, fontWeight: 500, borderBottom: `1px solid ${colors.rule}` },
  td: { padding: "10px 14px", borderBottom: `1px solid ${colors.rule}`, fontFamily: fontBody, color: colors.ink },
  tdNum: { padding: "10px 14px", borderBottom: `1px solid ${colors.rule}`, textAlign: "right", fontFamily: fontMono, fontSize: 12, color: colors.inkSoft },
  tableLink: { color: colors.ink, textDecoration: "none", borderBottom: `1px dotted ${colors.inkMute}` },

  conceptList: { display: "flex", flexWrap: "wrap", gap: 6 },
  conceptChip: { background: colors.cream, border: `1px solid ${colors.rule}`, padding: "4px 10px", fontFamily: fontMono, fontSize: 11, color: colors.inkSoft },

  toggleBtn: { background: "transparent", border: `1px solid ${colors.rule}`, color: colors.inkSoft, padding: "8px 14px", fontSize: 12, fontFamily: fontBody, cursor: "pointer", marginBottom: 12 },
  rawLog: { background: colors.cream, border: `1px solid ${colors.rule}`, maxHeight: 360, overflowY: "auto", padding: "12px 16px", fontFamily: fontMono, fontSize: 11 },
  rawRow: { display: "grid", gridTemplateColumns: "120px 220px 1fr", gap: 12, padding: "4px 0", borderBottom: `1px dotted ${colors.rule}`, alignItems: "baseline" },
  rawTime: { color: colors.inkMute },
  rawType: { color: colors.ochre, fontWeight: 500 },
  rawPayload: { color: colors.inkSoft, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },

  credPanel: { background: colors.cream, border: `1px solid ${colors.rule}`, padding: "24px 26px" },
  credIntro: { marginBottom: 24 },
  bodyText: { fontFamily: fontDisplay, fontSize: 15, lineHeight: 1.6, color: colors.inkSoft, margin: "0 0 12px" },
  inlineLink: { color: colors.ochre, textDecoration: "none", borderBottom: `1px solid ${colors.ochre}` },
  inlineCode: { fontFamily: fontMono, fontSize: 13, background: colors.paper, padding: "1px 5px", border: `1px solid ${colors.rule}` },

  warningBox: { background: colors.paper, border: `1px solid ${colors.ochre}`, borderLeftWidth: 4, padding: "14px 18px", marginTop: 14 },
  warningLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.ochre, fontWeight: 500, display: "block", marginBottom: 6 },
  warningBody: { margin: 0, fontFamily: fontDisplay, fontSize: 14, lineHeight: 1.55, color: colors.inkSoft },

  credForm: { display: "flex", flexDirection: "column", gap: 18 },
  label: { display: "flex", flexDirection: "column", gap: 6 },
  labelText: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.12em", color: colors.inkMute, fontWeight: 500 },
  input: { padding: "10px 14px", border: `1px solid ${colors.rule}`, background: colors.paper, fontFamily: fontBody, fontSize: 14, color: colors.ink },
  helpText: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 12, color: colors.inkMute, lineHeight: 1.4 },

  credActions: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" },
  primaryBtn: { background: colors.ink, color: colors.cream, border: "none", padding: "12px 22px", fontSize: 13, fontFamily: fontBody, fontWeight: 500, cursor: "pointer", letterSpacing: "0.02em", textDecoration: "none", display: "inline-block" },
  secondaryBtn: { background: "transparent", color: colors.ink, border: `1px solid ${colors.ink}`, padding: "10px 20px", fontSize: 13, fontFamily: fontBody, cursor: "pointer" },
  dangerBtn: { background: "transparent", color: colors.red, border: `1px solid ${colors.red}`, padding: "10px 20px", fontSize: 13, fontFamily: fontBody, cursor: "pointer", marginTop: 8 },

  preview: { marginTop: 22, padding: "18px 20px", background: colors.paper, border: `1px solid ${colors.rule}` },
  previewHeader: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 },
  previewLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: "0.15em", color: colors.inkMute, fontWeight: 500 },
  previewSub: { fontFamily: fontDisplay, fontStyle: "italic", fontSize: 13, color: colors.inkMute },
  previewPre: { fontFamily: fontMono, fontSize: 11, lineHeight: 1.45, color: colors.inkSoft, maxHeight: 460, overflow: "auto", margin: 0, padding: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" },
};
