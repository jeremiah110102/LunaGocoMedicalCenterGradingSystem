// ==========================================================
// dup-classes.js — Duplicate classes and duplicate grades of a student (Grading assignments →
// the duplicates warning). A "slot" is one student in one subject, school year and term; it
// should hold one class and one grade. A slot is listed when it has:
//   - the student in two or more classes, or
//   - two or more grade records: two in one class, a grade left behind in a class the student
//     was taken out of, or a grade of a deleted class.
// Decides which class the student can be kept in and what that removes. No database access:
// assignments.js loads and writes.
//   no grade anywhere          → any class the student is in can be kept
//   grades in the student's classes → only a graded one (a grade is kept whenever one can be)
//   Keep here                   → the student leaves the other classes, every grade outside the
//                                 kept class is deleted, and inside it one record stays
//                                 (the submitted one, else the newest)
//   safe                        → every grade in the slot has the same value and one is kept,
//                                 so Keep here loses no grade
// ==========================================================

const TERM_NAMES = ["1st Semester", "2nd Semester", "Summer"]; // as terms.js (kept import-free)
const termOf = (x) => (x && TERM_NAMES.includes(x.term) ? x.term : "");

/** A saved time in any form (Firestore / Sheets / Supabase / the mock) → ms (0 when missing). */
function timeMs(v) {
  if (!v) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Date.parse(v) || 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.__ts === "string") return Date.parse(v.__ts) || 0;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return 0;
}

/** What a grade says, for comparing records: "2", "INC"-like remarks, "" when empty. */
function valueOf(g) {
  const v = g.finalGrade;
  if (v === null || v === undefined || v === "") return `r:${g.remarks || ""}`;
  return `n:${Number(v)}`;
}

/** The record that stays when a class has several: submitted first, then the newest. */
function bestRecord(grades) {
  return grades.slice().sort((x, y) => (!!x.draft - !!y.draft) || (timeMs(y.updatedAt) - timeMs(x.updatedAt)))[0];
}

/**
 * One fix per student slot that has duplicate classes or duplicate grades:
 * { key, studentId, subjectCode, schoolYear, term, places: [{ assignmentId, assignment|null, enrolled, grades }], keepable, safe }.
 * `grades` can be any loaded grades (the involved classes' or all of them).
 */
export function studentFixes(assignments, grades) {
  const byId = new Map((assignments || []).map((a) => [a.id, a]));
  const slots = new Map(); // key → { info, places: Map(assignmentId → place) }
  const slotOf = (subjectId, schoolYear, term, sid, info) => {
    const key = [subjectId, schoolYear, term, sid].join("|");
    if (!slots.has(key)) slots.set(key, { key, studentId: sid, info, places: new Map() });
    return slots.get(key);
  };
  const placeOf = (slot, assignmentId) => {
    if (!slot.places.has(assignmentId)) {
      slot.places.set(assignmentId, { assignmentId, assignment: byId.get(assignmentId) || null, enrolled: false, grades: [] });
    }
    return slot.places.get(assignmentId);
  };

  (assignments || []).forEach((a) => {
    (a.studentIds || []).forEach((sid) => {
      placeOf(slotOf(a.subjectId, a.schoolYear, termOf(a), sid, a), a.id).enrolled = true;
    });
  });
  (grades || []).forEach((g) => {
    if (!g || !g.studentId) return;
    const a = byId.get(g.assignmentId); // the class decides the slot; a deleted class's grade uses its own fields
    const src = a || g;
    placeOf(slotOf(src.subjectId, src.schoolYear, termOf(src), g.studentId, src), g.assignmentId).grades.push(g);
  });

  const out = [];
  slots.forEach((slot) => {
    const places = [...slot.places.values()];
    const enrolled = places.filter((p) => p.enrolled && p.assignment);
    const all = places.flatMap((p) => p.grades);
    if (!enrolled.length) return; // nothing to keep the student in here
    if (enrolled.length < 2 && places.length < 2 && all.length < 2) return; // one class, at most one grade
    const graded = enrolled.filter((p) => p.grades.length);
    const keepable = (graded.length ? graded : enrolled).map((p) => p.assignmentId);
    const values = new Set(all.map(valueOf));
    out.push({
      key: slot.key,
      studentId: slot.studentId,
      subjectCode: slot.info.subjectCode || slot.info.subjectName || "",
      schoolYear: slot.info.schoolYear || "",
      term: termOf(slot.info),
      places,
      keepable,
      safe: values.size <= 1 && (!all.length || graded.length > 0),
    });
  });
  return out;
}

/** The class Keep here should suggest: one with a submitted grade, a graded one, the student's own section, else the first. */
export function defaultKeep(fix, studentSectionId) {
  const places = fix.places.filter((p) => fix.keepable.includes(p.assignmentId));
  const pick = places.find((p) => p.grades.some((g) => !g.draft))
    || places.find((p) => p.grades.length)
    || (studentSectionId && places.find((p) => p.assignment && p.assignment.sectionId === studentSectionId))
    || places[0];
  return pick ? pick.assignmentId : null;
}

/** The writes that keep the student only in `keepId`: { ops: [{ type, path, data? }], deletedGrades }. */
export function planKeep(fix, keepId) {
  if (!fix.keepable.includes(keepId)) throw new Error("not keepable");
  const ops = [];
  const deletedGrades = [];
  const del = (g) => { ops.push({ type: "delete", path: `grades/${g.id}` }); deletedGrades.push(g); };
  fix.places.forEach((p) => {
    if (p.assignmentId === keepId) {
      if (p.grades.length > 1) {
        const stay = bestRecord(p.grades);
        p.grades.filter((g) => g !== stay).forEach(del);
      }
      return;
    }
    if (p.enrolled && p.assignment) {
      ops.push({ type: "update", path: `gradingAssignments/${p.assignmentId}`, data: { studentIds: (p.assignment.studentIds || []).filter((id) => id !== fix.studentId) } });
    }
    p.grades.forEach(del);
  });
  return { ops, deletedGrades };
}
