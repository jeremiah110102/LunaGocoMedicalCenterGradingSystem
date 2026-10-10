// ==========================================================
// curriculum-core.js — Curriculum rules (no page code; used by the Curriculum
// page and by Grading assignments → Add from curriculum)
//
// curriculum/{id} = { program, yearLevel, term, subjectIds[], updatedAt }
// One record per program + year level + term, e.g. BSC · 1st Year · 1st Semester.
// ==========================================================

import { termOf } from "./terms.js";
import { isAttending } from "./student-status.js";
import { subjectTakers } from "./app.js";

/** The program in a section name: the text before the first digit ("BSC 1A" → "BSC", "Rizal" → ""). */
export function programOf(sectionName) {
  const m = /^([^\d]*)\d/.exec(String(sectionName ?? ""));
  return m ? m[1].replace(/[\s\-–_.]+$/g, "").trim().toUpperCase() : "";
}

/** Record id for a program + year level + term ("bsc-1st-year-1st-semester"). */
export function curriculumId(program, yearLevel, term) {
  return [program, yearLevel, term || "no-term"].join(" ").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * The classes to create for a section from its curriculum:
 *   create:  [{ subjectId, studentIds, leftOut }]  (attending students who don't already take it this school year and term)
 *   skipped: [{ subjectId, reason: "already assigned" }]  (the section already has it this school year and term)
 */
export function planFromCurriculum({ curriculum, section, term, assignments, sectionStudents }) {
  const out = { create: [], skipped: [] };
  if (!curriculum || !section) return out;
  const t = term || "";
  const attending = (sectionStudents || []).filter(isAttending).map((s) => s.id);
  (curriculum.subjectIds || []).forEach((subjectId) => {
    const has = (assignments || []).some((a) => a.sectionId === section.id && a.schoolYear === section.schoolYear && a.subjectId === subjectId && termOf(a) === t);
    if (has) { out.skipped.push({ subjectId, reason: "already assigned" }); return; }
    const takers = subjectTakers(assignments, subjectId, section.schoolYear, null, t);
    out.create.push({
      subjectId,
      studentIds: attending.filter((id) => !takers.has(id)),
      leftOut: attending.filter((id) => takers.has(id)),
    });
  });
  return out;
}
