// ==========================================================
// combined.js — Combined classes (Setup and options → Combined classes)
//
// When one teacher has the same subject in two or more sections in the same
// school year and term (e.g. GE 1 for BSPT 1 and BSPH 1), Enter grades can
// show them as ONE class list. Each grading assignment stays separate, so
// every section's records, report cards and Excel sheets stay correct:
// grades are saved to the student's own section's assignment.
// ==========================================================

import { termOf } from "./terms.js";

/** Classes with the same key are combined. */
export const combineKey = (a) => `${a.teacherDocId}|${a.subjectId}|${a.schoolYear}|${termOf(a)}`;
/** Combined classes are on unless switched off in Setup and options. */
export const combineOn = (options) => (options || {}).combineClasses !== "off";

/** Groups of 2+ grading assignments taught together: Map key → assignments (by section name). */
export function combinedGroups(assignments) {
  const groups = new Map();
  (assignments || []).forEach((a) => {
    const k = combineKey(a);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(a);
  });
  for (const [k, list] of groups) {
    if (list.length < 2) groups.delete(k);
    else list.sort((x, y) => String(x.sectionName).localeCompare(String(y.sectionName), undefined, { numeric: true }));
  }
  return groups;
}

/** A combined class as one "assignment" for Enter grades (parts = the real assignments). */
export function combinedView(key, parts) {
  const first = parts[0];
  return {
    ...first,
    id: `combo:${key}`,
    combined: true,
    parts,
    sectionName: parts.map((a) => a.sectionName).join(" + "),
    yearLevel: [...new Set(parts.map((a) => a.yearLevel))].join(" / "),
    studentIds: [...new Set(parts.flatMap((a) => a.studentIds || []))],
  };
}
