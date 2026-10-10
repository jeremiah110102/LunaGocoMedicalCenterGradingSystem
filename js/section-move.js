// ==========================================================
// section-move.js — When students change section: also move them in grading
// assignments (Setup and options → "When a student changes section").
// Used by Students (Edit, Change section) and Grading assignments (Paste list).
// ==========================================================

import { db, doc, getDoc, getDocs, collection, serverTimestamp } from "./firebase-config.js";
import { confirmDialog, commitOperations, getOptions } from "./app.js";
import { termOf } from "./terms.js";

const assignmentsCol = collection(db, "gradingAssignments");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Plans the grading assignment changes for students who change section:
 *  • added to the new section's assignments (same school year),
 *  • removed from the old section's assignments, unless they already have a saved grade there.
 * moves: [{ id, name, fromSectionId, fromSchoolYear, to: section }]
 */
export async function planSectionMoves(moves) {
  const snap = await getDocs(assignmentsCol);
  const assignments = snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data(), studentIds: [...(d.data().studentIds || [])] }));
  const changed = new Map(); // assignment id -> assignment with its new studentIds
  let added = 0, removed = 0, alreadyTaking = 0;
  const kept = []; // [{ name, subject }]: old-section assignments with a saved grade
  for (const m of moves) {
    // 1) Leave the old section's assignments (unless a grade is saved there)
    for (const a of assignments) {
      const has = a.studentIds.includes(m.id);
      // Only this school year's: a past school year's assignments are its record (Final grades
      // of that year), so a student promoted to the next school year stays in them
      if (has && m.fromSectionId && a.sectionId === m.fromSectionId && a.sectionId !== m.to.id && a.schoolYear === m.to.schoolYear) {
        // Grade documents are named {assignmentId}_{studentDocId}
        const grade = await getDoc(doc(db, "grades", `${a.id}_${m.id}`));
        if (grade.exists()) {
          kept.push({ name: m.name, subject: a.subjectCode || a.subjectName });
        } else {
          a.studentIds = a.studentIds.filter((x) => x !== m.id);
          changed.set(a.id, a);
          removed++;
        }
      }
    }
    // 2) Join the new section's assignments, but never a subject the student still takes this
    //    school year and term (a student takes a subject only once a term)
    for (const a of assignments) {
      if (a.studentIds.includes(m.id) || a.sectionId !== m.to.id || a.schoolYear !== m.to.schoolYear) continue;
      const takes = assignments.some((b) => b !== a && b.subjectId === a.subjectId && b.schoolYear === a.schoolYear && termOf(b) === termOf(a) && b.studentIds.includes(m.id));
      if (takes) { alreadyTaking++; continue; }
      a.studentIds.push(m.id);
      changed.set(a.id, a);
      added++;
    }
  }
  const otherYear = moves.filter((m) => m.fromSchoolYear && m.fromSchoolYear !== m.to.schoolYear).length;
  return { changed: [...changed.values()], added, removed, kept, alreadyTaking, otherYear };
}

/** Asks (or not, per Setup and options) and applies the plan. Returns a note for the toast. */
export async function moveInAssignments(moves) {
  if (!moves.length) return "";
  const { sectionMove } = await getOptions();
  if (sectionMove === "never") return "";
  const plan = await planSectionMoves(moves);
  const yearText = plan.otherYear
    ? " Last school year's grading assignments and grades stay as they are (they're that year's record)."
    : "";
  if (!plan.added && !plan.removed && !plan.kept.length) return yearText;
  const keptText = plan.kept.length
    ? `\n\nKept in the old section's ${plan.kept.length === 1 ? "assignment" : "assignments"} because a grade is already saved: ` +
      plan.kept.map((k) => `${k.name} (${k.subject})`).join(", ") + ". Saved grades are never deleted."
    : "";
  const takingText = plan.alreadyTaking
    ? `\n\nNot added to ${plural(plan.alreadyTaking, "subject")} of the new section that ${moves.length === 1 ? "the student already takes" : "they already take"} this school year.`
    : "";
  if (sectionMove !== "always") {
    const ok = await confirmDialog({
      title: "Also move them in grading assignments?",
      message:
        `• Add to ${plural(plan.added, "grading assignment")} of the new section` +
        `\n• Remove from ${plural(plan.removed, "grading assignment")} of the old section (no grade saved yet)` + keptText + takingText,
      confirmText: "Yes, move them",
      cancelText: "No, only the student",
      variant: "primary",
    });
    if (!ok) return " Grading assignments were not changed.";
  }
  await commitOperations(plan.changed.map((a) => ({
    type: "update",
    ref: a.ref,
    data: { studentIds: a.studentIds, updatedAt: serverTimestamp() },
  })));
  return ` Grading assignments: added to ${plan.added}, removed from ${plan.removed}` +
    (plan.kept.length ? `, kept in ${plan.kept.length} with a saved grade.` : ".") + yearText;
}

