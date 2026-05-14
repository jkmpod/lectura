// lib/recommender.js
//
// Tiny recommender for Lectura.
// Given a question (with concept_tags) and the available content, returns a
// ranked list of lesson moments where the underlying concepts are taught.
//
// Pure functions, no framework dependencies. Runs in browser or Node.
//
// DATA FLOW:
//   - Each question has: concept_tags = ["CRV_030", "CRV_002", ...]
//   - Each lesson has:   concepts = [{ title, timestamp }, ...]
//   - The ontology has:  lesson_mappings = [{ lesson_id, concepts: [{ source_title, ontology_refs }] }]
//
// We join question.concept_tags → lesson_mappings (via ontology_refs) →
// lesson.concepts (via source_title) → timestamp.

// ============================================================================
// Public API
// ============================================================================

/**
 * Recommend lesson moments for a question.
 *
 * @param {Object} question  The question, with a `concept_tags` array.
 * @param {Object} ontology  The parsed ontology (from public/ontology/*.json).
 * @param {Array}  lessons   Array of lesson objects (from public/lessons/*.json).
 * @param {Object} [options]
 * @param {boolean} [options.expandHierarchy=true]  Also surface lessons covering
 *                  PARENT concepts of the question's tags. Increases recall.
 * @param {number}  [options.maxResults=5]  Cap on number of returned moments.
 *
 * @returns {Array<RecommendedMoment>} ranked best-first.
 *
 * A RecommendedMoment looks like:
 *   {
 *     lessonId:    "stats2-4-2-cdf",
 *     lessonTitle: "Cumulative Distribution Function",
 *     conceptTitle:"Recovering PMF from CDF: jumps = probabilities",
 *     timestamp:   825,
 *     matchedTags: ["CRV_030", "CRV_002"],  // which question tags this moment covers
 *     score:       2,                        // count of matched tags (higher = better)
 *     viaParent:   false                     // true if matched only through hierarchy expansion
 *   }
 */
export function recommendForQuestion(question, ontology, lessons, options = {}) {
  const { expandHierarchy = true, maxResults = 5 } = options;

  const tags = question?.concept_tags;
  if (!Array.isArray(tags) || tags.length === 0) return [];

  // Build the effective tag set (optionally expanded up the parent_id chain).
  const effectiveTags = expandHierarchy
    ? expandTagsUpward(tags, ontology)
    : new Set(tags);

  // For each lesson, find concepts whose ontology_refs intersect effectiveTags.
  const moments = [];
  const mappingsByLessonId = indexMappingsByLessonId(ontology);

  for (const lesson of lessons) {
    const mapping = mappingsByLessonId[lesson.id];
    if (!mapping) continue;

    // The lesson has a `concepts` array with {title, timestamp}.
    // The mapping has entries with {source_title, ontology_refs}.
    // Join on title.
    const conceptTimestamps = indexConceptTimestamps(lesson);

    for (const m of mapping.concepts || []) {
      const matchedDirect = (m.ontology_refs || []).filter((r) => tags.includes(r));
      const matchedExpanded = (m.ontology_refs || []).filter((r) => effectiveTags.has(r));

      if (matchedExpanded.length === 0) continue;

      const timestamp = conceptTimestamps[m.source_title];
      if (timestamp === undefined) continue; // mapping references a title not in the lesson

      moments.push({
        lessonId: lesson.id,
        lessonTitle: lesson.title,
        conceptTitle: m.source_title,
        timestamp,
        matchedTags: matchedExpanded,
        score: matchedDirect.length > 0 ? matchedDirect.length * 2 : matchedExpanded.length,
        // direct matches score 2× to prioritize exact concept hits over hierarchy expansion
        viaParent: matchedDirect.length === 0,
      });
    }
  }

  // Sort: highest score first; ties broken by earlier timestamp (earlier in the
  // lesson is usually the introduction of the concept, which is what someone
  // confused about it should see first).
  moments.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.timestamp - b.timestamp;
  });

  return moments.slice(0, maxResults);
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Given a set of ontology tags, return them plus any of their ancestors in the
 * parent_id chain. This is how the recommender finds more general lessons when
 * a very specific concept isn't directly taught anywhere.
 */
function expandTagsUpward(tags, ontology) {
  const parentMap = {};
  for (const c of ontology.concepts || []) {
    if (c.parent_id) parentMap[c.id] = c.parent_id;
  }

  const out = new Set(tags);
  for (const tag of tags) {
    let cur = parentMap[tag];
    while (cur && !out.has(cur)) {
      out.add(cur);
      cur = parentMap[cur];
    }
  }
  return out;
}

/** Index ontology.lesson_mappings by lesson_id for O(1) lookup. */
function indexMappingsByLessonId(ontology) {
  const out = {};
  for (const m of ontology.lesson_mappings || []) {
    out[m.lesson_id] = m;
  }
  return out;
}

/** Build {source_title: timestamp} for a lesson's concepts array. */
function indexConceptTimestamps(lesson) {
  const out = {};
  for (const c of lesson.concepts || []) {
    out[c.title] = c.timestamp;
  }
  return out;
}

// ============================================================================
// Helper: deep-link URL builder
// ============================================================================

/**
 * Given a recommended moment, build the URL to that lesson at that timestamp.
 *
 * @param {RecommendedMoment} moment
 * @returns {string}  e.g. "/lesson/stats2-4-2-cdf?t=825"
 *
 * The lesson page can read the `t` query parameter and seek the video on load.
 * If you don't wire that into the player yet, the link still navigates to the
 * lesson and the user can find the timestamp manually.
 */
export function momentToUrl(moment) {
  return `/lesson/${moment.lessonId}?t=${moment.timestamp}`;
}