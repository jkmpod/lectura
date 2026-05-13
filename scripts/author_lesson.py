#!/usr/bin/env python3
"""
author_lesson.py — Scaffold a Lectura lesson JSON from a YouTube URL + transcript.

Stages:
  1. parse      — Extract YouTube ID, parse transcript file (SRT/VTT/bracketed)
  2. concepts   — Claude extracts key concepts with timestamps
  3. annotations — Claude proposes Context/Quiz/Recap annotations at high-utility moments
  4. questions  — Claude generates the Practice tab question pool
  5. translate  — Claude translates the transcript into each requested language
  6. related    — Claude suggests YouTube search queries (you vet the URLs)
  7. assemble   — Write the final JSON to public/lessons/

Each Claude call is cached to .cache/{lesson-id}/ so re-runs are cheap and resumable.

Usage:
  export ANTHROPIC_API_KEY=sk-ant-...
  python scripts/author_lesson.py \\
      --id intro-hypothesis-testing \\
      --url 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' \\
      --transcript transcripts/hypothesis-testing.srt \\
      --title 'Hypothesis Testing: An Introduction' \\
      --instructor 'Prof. Andrew Thangaraj' \\
      --course 'Statistics II' \\
      --duration 600 \\
      --languages hi,ta,ml

Optional flags:
  --no-confirm        Skip interactive review between stages
  --output-dir DIR    Where to write the final JSON (default: public/lessons)
  --skip stage1,...   Skip specific stages (useful for partial re-runs)
  --model MODEL       Override default Claude model
  --estimate-only     Show cost estimate and exit without making API calls
"""

import argparse
import json
import os
import re
import sys
import hashlib
from pathlib import Path
from typing import Optional

try:
    from anthropic import Anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEFAULT_MODEL = "claude-sonnet-4-5"
# Rough pricing per million tokens (input/output) — for cost estimation only
PRICING = {"input": 3.0, "output": 15.0}  # USD per 1M tokens, Sonnet ballpark

LANGUAGE_NAMES = {
    "hi": "Hindi (हिन्दी)",
    "ta": "Tamil (தமிழ்)",
    "gu": "Gujarati (ગુજરાતી)",
    "te": "Telugu (తెలుగు)",
    "bn": "Bangla (বাংলা)",
    "kn": "Kannada (ಕನ್ನಡ)",
    "ml": "Malayalam (മലയാളം)",
    "mr": "Marathi (मराठी)",
    "pa": "Punjabi (ਪੰਜਾਬੀ)",
}

# ---------------------------------------------------------------------------
# Terminal output helpers
# ---------------------------------------------------------------------------
class Style:
    BOLD = "\033[1m"
    DIM = "\033[2m"
    OCHRE = "\033[33m"
    GREEN = "\033[32m"
    RED = "\033[31m"
    BLUE = "\033[34m"
    END = "\033[0m"

def banner(text):
    print(f"\n{Style.BOLD}{Style.OCHRE}━━━ {text} ━━━{Style.END}\n")

def info(text):
    print(f"{Style.DIM}  {text}{Style.END}")

def ok(text):
    print(f"{Style.GREEN}  ✓ {text}{Style.END}")

def warn(text):
    print(f"{Style.OCHRE}  ! {text}{Style.END}")

def err(text):
    print(f"{Style.RED}  ✗ {text}{Style.END}")

def prompt(text):
    return input(f"{Style.BOLD}  ? {text}{Style.END} ").strip().lower()

# ---------------------------------------------------------------------------
# Transcript parsing
# ---------------------------------------------------------------------------
def time_to_seconds(t: str) -> float:
    clean = t.replace(",", ".").strip()
    parts = clean.split(":")
    parts = [float(p) for p in parts]
    if len(parts) == 3:
        return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return float(parts[0])

def parse_srt_vtt(text: str) -> list:
    out = []
    for block in re.split(r"\n\s*\n", text.strip()):
        lines = [l for l in block.split("\n") if l.strip()]
        time_line = next((l for l in lines if "-->" in l), None)
        if not time_line:
            continue
        start_str, end_str = [s.strip() for s in time_line.split("-->")]
        content = [l for l in lines if l != time_line and not l.strip().isdigit() and not l.startswith("WEBVTT")]
        text = re.sub(r"<[^>]+>", "", " ".join(content)).strip()
        if text:
            out.append({"start": time_to_seconds(start_str), "end": time_to_seconds(end_str), "text": text})
    return out

def parse_bracketed(text: str) -> list:
    pattern = re.compile(r"\[(\d{1,2}(?::\d{2}){1,2})\]\s*([^\[]+)")
    matches = list(pattern.finditer(text))
    out = []
    for i, m in enumerate(matches):
        start = time_to_seconds(m.group(1))
        end = time_to_seconds(matches[i+1].group(1)) if i+1 < len(matches) else start + 8
        out.append({"start": start, "end": end, "text": m.group(2).strip()})
    return out

def parse_transcript_file(path: Path) -> list:
    raw = path.read_text(encoding="utf-8").strip()
    if raw.upper().startswith("WEBVTT"):
        return parse_srt_vtt(re.sub(r"^WEBVTT.*\n", "", raw, flags=re.IGNORECASE))
    if "-->" in raw:
        return parse_srt_vtt(raw)
    if re.search(r"\[\d{1,2}:\d{2}", raw):
        return parse_bracketed(raw)
    raise ValueError(f"Could not detect transcript format in {path}. Expected SRT, WebVTT, or [MM:SS] prefixed lines.")

def extract_youtube_id(url: str) -> Optional[str]:
    patterns = [
        r"(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/|youtube\.com/v/)([\w-]{11})",
        r"^([\w-]{11})$",
    ]
    for p in patterns:
        m = re.search(p, url)
        if m:
            return m.group(1)
    return None

# ---------------------------------------------------------------------------
# Claude API wrapper with caching
# ---------------------------------------------------------------------------
class ClaudeClient:
    def __init__(self, cache_dir: Path, model: str, dry_run: bool = False):
        self.cache_dir = cache_dir
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.model = model
        self.dry_run = dry_run
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        if not dry_run:
            if not HAS_ANTHROPIC:
                err("anthropic package not installed. Run: pip install -r scripts/requirements.txt")
                sys.exit(1)
            api_key = os.environ.get("ANTHROPIC_API_KEY")
            if not api_key:
                err("ANTHROPIC_API_KEY not set in environment.")
                sys.exit(1)
            self.client = Anthropic(api_key=api_key)

    def call(self, cache_key: str, system: str, user: str, max_tokens: int = 4000) -> str:
        cache_file = self.cache_dir / f"{cache_key}.json"
        if cache_file.exists():
            info(f"cache hit: {cache_key}")
            return cache_file.read_text(encoding="utf-8")

        if self.dry_run:
            # Rough estimate: 4 chars per token
            est_input = (len(system) + len(user)) // 4
            self.total_input_tokens += est_input
            self.total_output_tokens += max_tokens // 2  # assume half of max
            return ""

        info(f"calling Claude ({cache_key})...")
        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            system=system,
            messages=[{"role": "user", "content": user}],
        )
        text = "\n".join(b.text for b in response.content if b.type == "text")
        self.total_input_tokens += response.usage.input_tokens
        self.total_output_tokens += response.usage.output_tokens
        cache_file.write_text(text, encoding="utf-8")
        return text

    def cost_so_far(self) -> float:
        return (
            self.total_input_tokens * PRICING["input"] / 1_000_000
            + self.total_output_tokens * PRICING["output"] / 1_000_000
        )

# ---------------------------------------------------------------------------
# JSON extraction (robust to code fences)
# ---------------------------------------------------------------------------
def extract_json(text: str):
    cleaned = re.sub(r"```(?:json)?", "", text).strip()
    # Find first [ or {
    starts = [cleaned.find(c) for c in "[{"]
    starts = [s for s in starts if s >= 0]
    if not starts:
        raise ValueError(f"No JSON found in response. Got: {text[:200]}")
    first = min(starts)
    # Find matching end
    last = max(cleaned.rfind("]"), cleaned.rfind("}"))
    if last < first:
        raise ValueError(f"Malformed JSON in response. Got: {text[:200]}")
    return json.loads(cleaned[first:last+1])

def confirm(prompt_text: str, auto_yes: bool) -> bool:
    if auto_yes:
        return True
    ans = prompt(f"{prompt_text} [y/N]")
    return ans in ("y", "yes")

# ---------------------------------------------------------------------------
# Stage implementations
# ---------------------------------------------------------------------------
def stage_concepts(client: ClaudeClient, transcript: list) -> list:
    compact = "\n".join(f"[{int(s['start'])}s] {s['text']}" for s in transcript)
    system = (
        "You analyze educational video transcripts and identify the key concepts taught. "
        "Respond ONLY with a valid JSON array, no other text, no markdown fences."
    )
    user = (
        "From this lesson transcript, identify 5 to 10 key concepts being taught. "
        "For each concept, give the timestamp (integer seconds) where it first appears or is explained. "
        'Respond as a JSON array of objects with keys "title" (3-7 words) and "timestamp" '
        "(integer seconds). Order by timestamp ascending.\n\nTranscript:\n" + compact
    )
    raw = client.call("concepts", system, user, max_tokens=1500)
    if not raw:
        return []
    parsed = extract_json(raw)
    return [
        {"title": str(c["title"]).strip(), "timestamp": max(0, int(c["timestamp"]))}
        for c in parsed if c.get("title")
    ]

def stage_annotations(client: ClaudeClient, transcript: list) -> list:
    compact = "\n".join(f"[{int(s['start'])}s] {s['text']}" for s in transcript)
    system = (
        "You design timeline annotations for educational videos. You suggest annotations "
        "of three types — context (background info), quiz (formative check), and recap (consolidation) — "
        "placed at moments of high pedagogical utility. "
        "Respond ONLY with a valid JSON array, no other text, no markdown fences."
    )
    user = (
        "Design 4-7 timeline annotations for this lesson. Mix of three types:\n"
        '- "context" (behavior: "soft"): provides background or motivation; non-interrupting toast\n'
        '- "quiz" (behavior: "pause"): formative MCQ; pauses video, requires interaction\n'
        '- "recap" (behavior: "marker"): consolidates what was just learned; timeline marker only\n\n'
        "Place context BEFORE the topic it motivates, quiz AFTER the key idea has been explained, "
        "and recap at natural section boundaries.\n\n"
        "Return a JSON array. Schema:\n"
        '  context: { "id", "type": "context", "behavior": "soft", "timestamp", "title", "body" }\n'
        '  quiz:    { "id", "type": "quiz", "behavior": "pause", "timestamp", "title", "question", "options" (4), "correctIndex", "hint", "explanation" }\n'
        '  recap:   { "id", "type": "recap", "behavior": "marker", "timestamp", "title", "body" }\n\n'
        "IDs should be a1, a2, a3...\n\nTranscript:\n" + compact
    )
    raw = client.call("annotations", system, user, max_tokens=3000)
    if not raw:
        return []
    return extract_json(raw)

def stage_questions(client: ClaudeClient, transcript: list, n_questions: int) -> list:
    compact = " ".join(s["text"] for s in transcript)[:6000]
    system = (
        "You generate high-quality multiple-choice practice questions from educational content. "
        "Questions test understanding (not trivia). "
        "Respond ONLY with a valid JSON array, no other text, no markdown fences."
    )
    user = (
        f"Generate {n_questions} multiple-choice questions covering the lesson. "
        "Mix difficulties (easy, medium, hard). Each question must have a hint that guides "
        "without revealing the answer, and an explanation revealed only after answering.\n\n"
        "Schema for each question:\n"
        '{ "id": "q1", "question": "...", "options": ["A","B","C","D"], "correctIndex": 0..3, '
        '"hint": "...", "explanation": "...", "concept": "which concept this tests", '
        '"difficulty": "easy" | "medium" | "hard" }\n\n'
        "Lesson content:\n" + compact
    )
    raw = client.call("questions", system, user, max_tokens=4000)
    if not raw:
        return []
    return extract_json(raw)

def stage_translate(client: ClaudeClient, transcript: list, lang_code: str) -> list:
    lang_name = LANGUAGE_NAMES.get(lang_code, lang_code)
    lines = [s["text"] for s in transcript]
    system = (
        "You translate text accurately while preserving meaning and educational tone. "
        "Respond ONLY with a valid JSON array of strings, no other text, no markdown fences."
    )
    user = (
        f"Translate each of the following English transcript lines into {lang_name}. "
        "Return a JSON array of translated strings in the same order and same count. "
        "Preserve technical terms in English when there is no commonly used translation "
        f"(e.g. 'null hypothesis', 'p-value').\n\nLines ({len(lines)} total):\n"
        + json.dumps(lines, ensure_ascii=False)
    )
    raw = client.call(f"translate_{lang_code}", system, user, max_tokens=8000)
    if not raw:
        return []
    arr = extract_json(raw)
    if len(arr) != len(lines):
        warn(f"Expected {len(lines)} translations for {lang_code}, got {len(arr)}. Using what we got.")
    # Reattach to original timestamps
    out = []
    for i, seg in enumerate(transcript):
        translated = arr[i] if i < len(arr) else seg["text"]
        out.append({"start": seg["start"], "end": seg["end"], "text": translated})
    return out

def stage_related(client: ClaudeClient, concepts: list) -> list:
    system = (
        "You suggest helpful YouTube search queries for learning more about specific concepts. "
        "Respond ONLY with a valid JSON array, no other text, no markdown fences."
    )
    user = (
        "For a student learning these concepts, suggest 4 helpful YouTube search queries that would "
        'find videos explaining them in more depth. Return a JSON array of objects with keys "title" '
        '(4-8 words), "searchQuery" (exact YouTube search query), and "description" (one sentence).\n\n'
        f"Concepts: {json.dumps([c['title'] for c in concepts])}"
    )
    raw = client.call("related", system, user, max_tokens=1000)
    if not raw:
        return []
    parsed = extract_json(raw)
    return [
        {
            "title": p["title"],
            "url": f"https://www.youtube.com/results?search_query={p['searchQuery'].replace(' ', '+')}",
            "description": p["description"] + " (search result — vet manually before publishing)",
        }
        for p in parsed
    ]

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Scaffold a Lectura lesson JSON", formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--id", required=True, help="Lesson slug (e.g. 'intro-hypothesis-testing')")
    parser.add_argument("--url", required=True, help="YouTube video URL")
    parser.add_argument("--transcript", required=True, type=Path, help="Path to SRT/VTT/txt transcript")
    parser.add_argument("--title", required=True)
    parser.add_argument("--instructor", default="")
    parser.add_argument("--course", default="")
    parser.add_argument("--subtitle", default="")
    parser.add_argument("--duration", type=int, default=0, help="Duration in seconds (optional)")
    parser.add_argument("--languages", default="", help="Comma-separated language codes (e.g. 'hi,ta,ml')")
    parser.add_argument("--n-questions", type=int, default=6, help="How many Practice tab questions")
    parser.add_argument("--no-confirm", action="store_true", help="Skip interactive review between stages")
    parser.add_argument("--output-dir", type=Path, default=Path("public/lessons"))
    parser.add_argument("--skip", default="", help="Comma-separated stages to skip: concepts,annotations,questions,translate,related")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--estimate-only", action="store_true", help="Estimate cost and exit")
    args = parser.parse_args()

    auto = args.no_confirm or args.estimate_only
    skip = set(s.strip() for s in args.skip.split(",") if s.strip())
    langs = [l.strip() for l in args.languages.split(",") if l.strip()]

    # ---------- Stage 1: parse ----------
    banner("Stage 1 — Parse inputs")
    yt_id = extract_youtube_id(args.url)
    if not yt_id:
        err(f"Could not extract YouTube ID from URL: {args.url}")
        sys.exit(1)
    ok(f"YouTube ID: {yt_id}")

    if not args.transcript.exists():
        err(f"Transcript file not found: {args.transcript}")
        sys.exit(1)
    transcript = parse_transcript_file(args.transcript)
    if not transcript:
        err(f"Parsed 0 segments from transcript. Check the file format.")
        sys.exit(1)
    ok(f"Parsed {len(transcript)} transcript segments (last ts: {int(transcript[-1]['end'])}s)")

    duration = args.duration or int(transcript[-1]["end"])
    info(f"duration set to {duration}s")

    cache_dir = Path(".cache") / args.id
    client = ClaudeClient(cache_dir, args.model, dry_run=args.estimate_only)
    info(f"cache dir: {cache_dir}")

    if args.estimate_only:
        info("dry run — estimating cost only")

    # ---------- Stage 2: concepts ----------
    banner("Stage 2 — Concepts")
    if "concepts" in skip:
        info("(skipped)")
        concepts = []
    else:
        concepts = stage_concepts(client, transcript)
        ok(f"Got {len(concepts)} concepts")
        for c in concepts[:5]:
            print(f"    {int(c['timestamp']):4d}s  {c['title']}")
        if len(concepts) > 5:
            print(f"    ... and {len(concepts)-5} more")
        if not confirm("Continue with these concepts?", auto):
            err("Edit .cache/{}/concepts.json by hand or rerun with --skip concepts then re-add.".format(args.id))
            sys.exit(1)

    # ---------- Stage 3: annotations ----------
    banner("Stage 3 — Annotations")
    if "annotations" in skip:
        info("(skipped)")
        annotations = []
    else:
        annotations = stage_annotations(client, transcript)
        ok(f"Got {len(annotations)} annotations")
        for a in annotations:
            t = a.get("type", "?")
            print(f"    {int(a.get('timestamp', 0)):4d}s  [{t.upper():<7s}]  {a.get('title','')}")
        if not confirm("Continue with these annotations?", auto):
            sys.exit(1)

    # ---------- Stage 4: questions ----------
    banner(f"Stage 4 — Practice questions (target: {args.n_questions})")
    if "questions" in skip:
        info("(skipped)")
        questions = []
    else:
        questions = stage_questions(client, transcript, args.n_questions)
        ok(f"Got {len(questions)} questions")
        for q in questions:
            print(f"    [{q.get('difficulty','?'):<6}] {q.get('question','')[:80]}")
        if not confirm("Continue with these questions?", auto):
            sys.exit(1)

    # ---------- Stage 5: translations ----------
    banner(f"Stage 5 — Translations ({len(langs)} languages)")
    transcript_obj = {"en": transcript}
    if "translate" in skip or not langs:
        info("(skipped)")
    else:
        for lc in langs:
            info(f"translating to {LANGUAGE_NAMES.get(lc, lc)}...")
            translated = stage_translate(client, transcript, lc)
            if translated:
                transcript_obj[lc] = translated
                ok(f"  {lc}: {len(translated)} segments")

    # ---------- Stage 6: related videos ----------
    banner("Stage 6 — Related videos")
    if "related" in skip or not concepts:
        info("(skipped)")
        related = []
    else:
        related = stage_related(client, concepts)
        ok(f"Got {len(related)} suggested search queries")
        for r in related:
            print(f"    - {r['title']}")
        warn("These are SEARCH URLs — replace with vetted video URLs before publishing.")

    # ---------- Cost summary ----------
    banner("Cost summary")
    info(f"input tokens:  {client.total_input_tokens:,}")
    info(f"output tokens: {client.total_output_tokens:,}")
    info(f"approximate cost: ${client.cost_so_far():.3f} USD")

    if args.estimate_only:
        return

    # ---------- Stage 7: assemble ----------
    banner("Stage 7 — Assemble JSON")
    lesson = {
        "id": args.id,
        "title": args.title,
        "subtitle": args.subtitle,
        "instructor": args.instructor,
        "course": args.course,
        "youtubeId": yt_id,
        "thumbnailUrl": None,
        "duration": duration,
        "concepts": concepts,
        "annotations": annotations,
        "transcript": transcript_obj,
        "questions": questions,
        "relatedVideos": related,
    }

    args.output_dir.mkdir(parents=True, exist_ok=True)
    output_file = args.output_dir / f"{args.id}.json"
    output_file.write_text(json.dumps(lesson, indent=2, ensure_ascii=False), encoding="utf-8")
    ok(f"wrote {output_file}")

    # Update the index.json
    index_file = args.output_dir / "index.json"
    if index_file.exists():
        index_data = json.loads(index_file.read_text(encoding="utf-8"))
    else:
        index_data = {"lessons": []}
    existing_ids = {l["id"] for l in index_data["lessons"]}
    if args.id not in existing_ids:
        index_data["lessons"].append({"id": args.id, "file": f"{args.id}.json"})
        index_file.write_text(json.dumps(index_data, indent=2, ensure_ascii=False), encoding="utf-8")
        ok(f"registered in {index_file}")
    else:
        info(f"already registered in {index_file}")

    banner("Done")
    info(f"Review and edit:  {output_file}")
    info(f"Things to verify by hand:")
    info(f"  - Annotation timestamps land at useful moments")
    info(f"  - Quiz hints don't leak the answer")
    info(f"  - Related videos: replace search URLs with vetted YouTube URLs")
    info(f"  - Translations: spot-check technical terms in target languages")
    print()


if __name__ == "__main__":
    main()
