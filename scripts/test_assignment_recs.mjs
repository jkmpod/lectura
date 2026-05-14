// Quick test: run the recommender on assignment questions, confirm pedagogically sensible results
import { readFileSync } from "fs";
import { recommendForQuestion } from "../lib/recommender.js";

const lessonIds = [
  "stats2-4-1-continuous-rv-intro",
  "stats2-4-2-cdf",
  "stats2-4-3-cdf-discrete-to-continuous",
];
const lessons = lessonIds.map((id) =>
  JSON.parse(readFileSync(`./public/lessons/${id}.json`, "utf-8"))
);
const ontology = JSON.parse(
  readFileSync("./public/ontology/statistics-crv.json", "utf-8")
);
const assignment = JSON.parse(
  readFileSync("./public/assignments/stats2-week4-graded.json", "utf-8")
);

for (const q of assignment.questions) {
  console.log(`\n--- ${q.id}: ${q.prompt.slice(0, 70)}…`);
  console.log(`    tags: ${JSON.stringify(q.concept_tags)}`);
  const moments = recommendForQuestion(q, ontology, lessons, { maxResults: 3 });
  for (const m of moments) {
    const mm = Math.floor(m.timestamp / 60);
    const ss = String(m.timestamp % 60).padStart(2, "0");
    console.log(`    [${m.score}]  ${m.lessonId} @ ${mm}:${ss}  →  ${m.conceptTitle}`);
  }
}
