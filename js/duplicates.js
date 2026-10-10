// ==========================================================
// duplicates.js — The same student entered twice (Students page)
// "Dela Peña, Cloui Miles" and "DELA PENA, Cloui M." are the same person:
// same surname and first given name, ignoring capitals and accents.
// planMerge() moves one record's classes and grades onto the other.
// ==========================================================

import { fold } from "./name-list.js";

/** Surname + first given name, folded: "dela pena|cloui". */
export function nameKey(name) {
  const f = fold(name);
  const i = f.indexOf(",");
  if (i < 0) return f.replace(/,/g, "");
  const first = f.slice(i + 1).replace(/,/g, " ").trim().split(" ")[0] || "";
  return `${f.slice(0, i).trim()}|${first}`;
}

/** Students (other than exceptId) whose name has the same key. */
export function similarStudents(name, students, exceptId = null) {
  const k = nameKey(name);
  return k ? (students || []).filter((s) => s.id !== exceptId && nameKey(s.studentName) === k) : [];
}

/** Groups of 2+ students with the same key. */
export function duplicateGroups(students) {
  const by = new Map();
  (students || []).forEach((s) => {
    const k = nameKey(s.studentName);
    if (!k) return;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  });
  return [...by.values()].filter((g) => g.length > 1);
}

const gradeText = (g) => (g.finalGrade === null || g.finalGrade === undefined
  ? (g.remarks === "Incomplete" ? "INC" : g.remarks === "Dropped" ? "DRP" : "—")
  : Number(g.finalGrade).toFixed(2));

/**
 * Merge `drop` into `keep`. Returns { ops: [{ type, path, data? }], moved, conflicts }:
 *  - grading assignments: drop's id replaced by keep's (no duplicates)
 *  - drop's grades: moved to `${assignmentId}_${keep.id}`; when keep already has a grade in
 *    that class, keep's grade stays and the dropped one is listed in `conflicts`
 *  - finally the dropped student record is deleted
 */
export function planMerge(keep, drop, assignments, grades) {
  const ops = [];
  (assignments || []).forEach((a) => {
    const ids = a.studentIds || [];
    if (!ids.includes(drop.id)) return;
    const next = [...new Set(ids.map((id) => (id === drop.id ? keep.id : id)))];
    ops.push({ type: "update", path: `gradingAssignments/${a.id}`, data: { studentIds: next } });
  });
  const keepHas = new Map((grades || []).filter((g) => g.studentId === keep.id).map((g) => [g.assignmentId, g]));
  const conflicts = [];
  let moved = 0;
  (grades || []).filter((g) => g.studentId === drop.id).forEach((g) => {
    const kept = keepHas.get(g.assignmentId);
    if (kept) {
      conflicts.push({ subjectCode: g.subjectCode || kept.subjectCode || "", keptGrade: gradeText(kept), droppedGrade: gradeText(g) });
    } else {
      const { id, ...data } = g;
      ops.push({ type: "set", path: `grades/${g.assignmentId}_${keep.id}`, data: { ...data, studentId: keep.id, studentNumber: keep.studentId, studentName: keep.studentName } });
      moved++;
    }
    ops.push({ type: "delete", path: `grades/${g.id}` });
  });
  ops.push({ type: "delete", path: `students/${drop.id}` });
  return { ops, moved, conflicts };
}
