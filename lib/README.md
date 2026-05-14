# lib/

Standalone utility modules. Pure functions, framework-agnostic.

## `recommender.js`

Given a question with `concept_tags` and the available lessons + ontology,
returns a ranked list of lesson moments where those concepts are taught.

Used by the (planned) assignment-page UI to suggest "watch these moments"
under unanswered questions.

### Usage

```js
import { recommendForQuestion, momentToUrl } from "@/lib/recommender";

const moments = recommendForQuestion(question, ontology, lessons, {
  expandHierarchy: true,  // also surface parent-concept lessons (default: true)
  maxResults: 5,          // cap on returned moments (default: 5)
});

for (const m of moments) {
  console.log(`Watch: ${m.lessonTitle} at ${m.timestamp}s`);
  console.log(`URL: ${momentToUrl(m)}`);
}
```

### Data shape contracts

`question`:
```json
{
  "id": "q5",
  "concept_tags": ["CRV_030", "CRV_002"]
}
```

`ontology` (the contents of `public/ontology/statistics-crv.json`):
```json
{
  "concepts": [{ "id": "CRV_001", "label": "...", "parent_id": "CRV_049" }, ...],
  "lesson_mappings": [
    {
      "lesson_id": "stats2-4-2-cdf",
      "concepts": [
        { "source_title": "Definition: ...", "ontology_refs": ["CRV_020"] }
      ]
    }
  ]
}
```

`lessons` (array of lesson JSONs as loaded from `public/lessons/*.json`):
```json
[
  { "id": "...", "title": "...", "concepts": [{ "title": "...", "timestamp": 51 }, ...] }
]
```

### Scoring

Each moment gets a score:
- **+2 per direct tag match** (the ontology ID is in the question's tags)
- **+1 per parent-via-hierarchy match** (the ontology ID is a parent of one of
  the question's tags, only counted when `expandHierarchy` is on)

Ties are broken by earlier timestamp (introductions before applications).

### Testing

```bash
node scripts/test_recommender.mjs
```

Runs against the live content in `public/`. Prints recommended moments for
six sample questions.