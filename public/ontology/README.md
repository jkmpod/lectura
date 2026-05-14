# public/ontology/

Shared concept vocabularies for the lesson library. One JSON file per module.

The ontology is the keystone artifact for the assessment-driven flow:
- Every lesson concept references one or more ontology IDs (in `lesson_mappings`).
- Every question in `public/lessons/*.json` has `concept_tags` pointing to ontology IDs.
- The recommender (in `lib/recommender.js`) joins these to surface relevant
  lesson moments for unanswered questions.

## Files

- `index.json` — registry of available ontologies (parallel to `lessons/index.json`)
- `statistics-crv.json` — the Stats II Module on Continuous Random Variables & CDF
  - Covers lectures 4.1, 4.2, 4.3
  - ~47 concepts with a `parent_id` hierarchy
  - Lesson mappings for all three lectures

## Authoring

The ontology is **instructor-validated**. Don't add or modify concepts without
domain-expert review.

The canonical authoring format is YAML (easier for humans). The JSON files here
are the runtime form. To regenerate the JSON from a YAML source:

```python
import yaml, json
data = yaml.safe_load(open("statistics-crv.yaml"))
json.dump(data["ontology"], open("public/ontology/statistics-crv.json", "w"), indent=2)
```

(Yes, this is informal. When you have a second module, formalize it as a
build script. For one ontology, the inline conversion is fine.)

## Schema

```json
{
  "metadata": {
    "domain": "...",
    "module": "...",
    "kind_definitions": { ... }
  },
  "concepts": [
    {
      "id": "CRV_001",
      "label": "Human-readable name",
      "kind": "concept | property | principle | structural_element | application | visualization | relation",
      "parent_id": "CRV_xxx (optional)",
      "aliases": ["Other names (optional)"],
      "description": "Single-sentence definition"
    }
  ],
  "lesson_mappings": [
    {
      "lesson_id": "stats2-4-2-cdf",
      "concepts": [
        { "source_title": "Definition: F_X(x) = P(X ≤ x)", "ontology_refs": ["CRV_020"] }
      ],
      "annotations": [
        { "annotation_id": "a2", "ontology_refs": ["CRV_027", "CRV_028"] }
      ]
    }
  ]
}
```

## Conventions

- **IDs are stable and opaque.** Once `CRV_007` exists, never reuse it for a
  different concept. If a concept is merged or removed, leave a gap.
- **Aliases capture synonyms only.** Distinct concepts (even closely related)
  get their own IDs.
- **Parent IDs form a tree, not a DAG.** A concept has at most one parent.
- **`kind_definitions` lives in metadata** and documents the allowed values
  of the `kind` field.