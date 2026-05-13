# Lectura

A small Next.js learning app: YouTube lessons with synced multilingual transcripts, timeline-anchored annotations (context, quiz, recap), practice questions, and curated further reading. **Fully static at runtime** — no backend, no LLM calls, no API keys, no costs.

All lesson content (transcripts, translations, annotations, questions, related videos) lives as JSON in `public/lessons/`. To add or change a lesson, you edit a JSON file. A Python authoring script (`scripts/author_lesson.py`) drafts that JSON for you by calling Claude offline, with caching and human review at each stage.

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:3000>.

---

## Project structure

```
lectura/
├── app/
│   ├── layout.jsx              # Root HTML layout
│   ├── page.jsx                # Landing page (lesson cards)
│   └── lesson/[id]/page.jsx    # Lesson player with timeline annotations
├── public/
│   └── lessons/
│       ├── index.json          # Lists which lessons are available
│       ├── intro-hypothesis-testing.json
│       └── linear-regression-basics.json
├── scripts/
│   ├── author_lesson.py        # Offline lesson generator
│   └── requirements.txt
├── package.json
└── next.config.js
```

---

## Lesson player features

- **Video + concepts panel** — top half. The right-side concept list jumps the video to that moment.
- **Timeline ribbon** — below the video. Shows concepts and annotations as colored dots. Hover for tooltip, click to seek.
- **Annotation system** — when playback crosses an annotation timestamp, the configured behavior fires:
  - `soft` — non-blocking toast notification, auto-dismisses
  - `marker` — appears on the timeline only, no interruption
  - `pause` — video pauses, modal appears with a quiz that must be answered before continuing
- **Tabs**: Transcript (with language switcher), Annotations (list view of all annotations for navigation/review), Practice (end-of-lesson MCQ pool, random no-repeat), Learn more (related videos).
- **Forward-only triggering** — annotations only fire on forward playback, never on rewind. Rewinding past an annotation resets it so the user can experience it again on the next forward pass.

---

## How to add a new lesson — two paths

### Path A: Hand-author the JSON

1. Create a new JSON file in `public/lessons/`, e.g. `my-new-lesson.json`. Copy `intro-hypothesis-testing.json` as a template.
2. Register it in `public/lessons/index.json`:

   ```json
   {
     "lessons": [
       { "id": "intro-hypothesis-testing",   "file": "intro-hypothesis-testing.json" },
       { "id": "linear-regression-basics",   "file": "linear-regression-basics.json" },
       { "id": "my-new-lesson",              "file": "my-new-lesson.json" }
     ]
   }
   ```

3. Reload the browser. The new lesson appears on the landing page.

### Path B: Use the authoring script

The Python script generates a draft JSON by calling Claude. It caches every response, asks for confirmation between stages, and writes the final file plus updates the index.

```bash
# One-time setup
pip install -r scripts/requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...

# Run for each new lesson
python scripts/author_lesson.py \
    --id intro-hypothesis-testing \
    --url 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' \
    --transcript transcripts/hypothesis-testing.srt \
    --title 'Hypothesis Testing: An Introduction' \
    --instructor 'Prof. Andrew Thangaraj' \
    --course 'Statistics II' \
    --duration 600 \
    --languages hi,ta,ml \
    --n-questions 6
```

The script runs through 7 stages:

1. **Parse** the YouTube URL and transcript file (SRT / WebVTT / `[MM:SS]` plain text).
2. **Concepts** — Claude extracts 5–10 key concepts with timestamps.
3. **Annotations** — Claude proposes Context / Quiz / Recap annotations at pedagogically useful moments.
4. **Questions** — Claude generates the Practice tab question pool with hints, explanations, concept tags, and difficulty.
5. **Translations** — For each `--languages` code, Claude translates the transcript.
6. **Related videos** — Claude suggests YouTube *search queries*. Search URLs are written to the JSON; **replace these with vetted video URLs before publishing** (Claude hallucinates video IDs, so we deliberately avoid asking it for direct video links).
7. **Assemble** — Writes the final JSON to `public/lessons/{id}.json` and registers it in `index.json`.

Each Claude response is cached to `.cache/{id}/`, so re-runs cost nothing for already-completed stages. You can edit a cached file by hand and rerun; the cached version is used.

Useful flags:

- `--estimate-only` — show approximate cost without making API calls
- `--no-confirm` — skip interactive review between stages (use after you trust the pipeline)
- `--skip translate,related` — skip specific stages
- `--n-questions 10` — change practice pool size
- `--model claude-opus-4-5` — pick a different model

---

## Lesson JSON shape

```jsonc
{
  "id": "unique-slug",
  "title": "Lesson title",
  "subtitle": "Optional subtitle",
  "instructor": "Prof. Name",
  "course": "Course name",
  "youtubeId": "dQw4w9WgXcQ",
  "thumbnailUrl": null,
  "duration": 600,

  "concepts": [
    { "title": "Concept name", "timestamp": 45 }
  ],

  "annotations": [
    {
      "id": "a1",
      "type": "context",          // context | quiz | recap
      "behavior": "soft",         // soft | marker | pause
      "timestamp": 30,
      "title": "Why we need formal testing",
      "body": "Informal judgments..."
    },
    {
      "id": "a2",
      "type": "quiz",
      "behavior": "pause",
      "timestamp": 155,
      "title": "Quick check",
      "question": "Which of these is a valid null hypothesis?",
      "options": ["...", "...", "...", "..."],
      "correctIndex": 1,
      "hint": "A null hypothesis must be...",
      "explanation": "Null hypotheses must be specific statements..."
    },
    {
      "id": "a3",
      "type": "recap",
      "behavior": "marker",
      "timestamp": 580,
      "title": "What you've learned",
      "body": "You now have the full hypothesis-testing skeleton..."
    }
  ],

  "transcript": {
    "en": [ { "start": 0, "end": 5.2, "text": "..." } ],
    "hi": [ /* same timestamps, translated text */ ],
    "ta": [ /* ... */ ]
  },

  "questions": [
    {
      "id": "q1",
      "question": "...",
      "options": ["A", "B", "C", "D"],
      "correctIndex": 0,
      "hint": "...",
      "explanation": "...",
      "concept": "Which concept this tests",
      "difficulty": "easy"
    }
  ],

  "relatedVideos": [
    { "title": "...", "url": "https://...", "description": "..." }
  ]
}
```

### Annotation behavior pairings

Not all `type` × `behavior` combinations make pedagogical sense. The sensible defaults:

| Type    | Default behavior | When to use                                |
|---------|------------------|--------------------------------------------|
| context | `soft`           | Background or motivation, non-disruptive   |
| quiz    | `pause`          | Formative check at a key moment            |
| recap   | `marker`         | Section boundary, no interruption needed   |

You *can* set `quiz` to `soft` (suggested check, optional) or `context` to `pause` (forced reading before continuing), but use sparingly — students dislike unnecessary interruptions.

---

## Deploying to Vercel

```bash
npm install -g vercel
vercel login
vercel               # follow prompts, accept defaults
vercel --prod        # promote to production URL
```

**Zero environment variables to configure.** The whole app is static at runtime.

### Other hosting options

Because there's no backend, the built app works on GitHub Pages (`next build && next export`, host `out/`), Firebase Hosting, Cloudflare Pages, or any static file host.

---

## Design notes

- **No persistence.** Each session starts fresh. No tracking of which inline quizzes a student has answered, no progress bars, no scores stored anywhere. Adding `localStorage`-based progress would be a single-file change to the player.
- **Forward-only annotation firing.** Annotations fire when playback crosses their timestamp going forward. Rewinding past one resets it. This means a session-scoped "answered" state lives only in the React tree, never persisted.
- **Translations as static files.** Each language is pre-generated and lives in the lesson JSON. The dropdown shows all 9 Indian languages plus English; languages without a translation fall back to English with a visible note.
- **Pedagogical framing.** Annotations are meant for short formative interruptions (multimedia learning segmenting principle), not blocking gates. The Practice tab is the retrieval-practice surface; inline quizzes are concept-checks.
