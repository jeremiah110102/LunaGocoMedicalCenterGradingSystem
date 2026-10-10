// ==========================================================
// roster-requests.js — Class list requests: a teacher asks to add, remove or move a student
// (move = to the class of this subject the student belongs to, picked by the teacher, or to a
// section that has no class of it yet; the registrar creates that class first). The teacher keeps the lines in a
// draft, submits it, and a registrar or admin approves or declines each line.
//
//   rosterRequests/{id} { assignmentId, teacherDocId, …, status: draft | submitted | done | withdrawn,
//                         reviewStarted, items: [{ id, type, studentId, …, reason, decision, note }] }
//
// Pure decisions only (which lines are allowed, what approving one writes); grading.js and
// notifications.js load and write.
// ==========================================================

const TERM_NAMES = ["1st Semester", "2nd Semester", "Summer"]; // as terms.js (kept import-free)
const termOf = (x) => (x && TERM_NAMES.includes(x.term) ? x.term : "");

export const MIN_REASON = 10;
export const MAX_ITEMS = 50;
export const TYPE_LABEL = { add: "Add", remove: "Remove", move: "Move to another class" };
const PICK = "Pick the class or the section the student belongs to.";

const sameSubject = (a, b) => a.subjectId === b.subjectId && a.schoolYear === b.schoolYear && termOf(a) === termOf(b);
const hasSubmitted = (grades, a, sid) => (grades || []).some((g) => g.assignmentId === a.id && g.studentId === sid && !g.draft);

/** Classes a student can be moved to from `assignment`: the same subject, year and term (any other class). */
export function moveTargets(assignment, assignments) {
  return (assignments || []).filter((b) => b.id !== assignment.id && sameSubject(b, assignment));
}

const fold = (t) => String(t || "").toLowerCase().replace(/\b(sir|ma'?am|mr|mrs|ms|miss|prof|dr)\.?\s+/g, "").trim();

/**
 * The class a move line goes to: the class the teacher picked (if it still exists), else this
 * subject's class in the picked section (when there are several, the one whose teacher matches
 * the name the teacher typed). null when there is none yet.
 */
export function findTarget(item, assignment, assignments) {
  const targets = moveTargets(assignment, assignments);
  const picked = item.toAssignmentId && targets.find((b) => b.id === item.toAssignmentId);
  if (picked) return picked;
  const inSection = targets.filter((b) => item.toSectionId && b.sectionId === item.toSectionId);
  const name = fold(item.toTeacherName);
  const named = (b) => { const t = fold(b.teacherName); return !!t && (t.includes(name) || name.includes(t)); };
  return (name && inSection.find(named)) || inSection[0] || null;
}

function checkClass(item, { assignment, assignments, grades }) {
  const sid = item.studentId;
  const inClass = (assignment.studentIds || []).includes(sid);
  if (item.type === "add") {
    if (inClass) return "Already in this class.";
    const other = (assignments || []).find((b) => b.id !== assignment.id && sameSubject(b, assignment) && (b.studentIds || []).includes(sid));
    return other ? `Already takes this subject this term (${other.sectionName || "another class"}).` : "";
  }
  if (item.type !== "remove" && item.type !== "move") return "Unknown change.";
  if (!inClass) return "Not in this class.";
  if (hasSubmitted(grades, assignment, sid)) return "Grade submitted: use DRP instead.";
  if (item.type === "move") {
    if (item.toAssignmentId) {
      const target = moveTargets(assignment, assignments).find((b) => b.id === item.toAssignmentId);
      if (!target) return PICK;
      if ((target.studentIds || []).includes(sid)) return "Already in that class.";
    } else if (!item.toSectionId || item.toSectionId === assignment.sectionId) {
      return PICK;
    }
  }
  return "";
}

/** "" when the line is allowed, else why not. ctx: { assignment, assignments, grades, items }. */
export function checkItem(item, ctx) {
  if (!["add", "remove", "move"].includes(item.type)) return "Unknown change.";
  if (String(item.reason || "").trim().length < MIN_REASON) return `Give a reason (at least ${MIN_REASON} characters).`;
  if ((ctx.items || []).some((x) => x.id !== item.id && x.studentId === item.studentId)) return "This student is already in another line.";
  return checkClass(item, ctx);
}

/**
 * What approving a line writes, from the classes and grades as they are now:
 * { result: "apply" | "skip" | "wait", note, ops: [{ type, path, data? }] }.
 * "wait": a move to a section with no class of this subject yet (nothing is written; the line
 * stays waiting until the registrar creates the class).
 */
export function planApprove(item, now) {
  let target = null;
  if (item.type === "move") {
    target = findTarget(item, now.assignment, now.assignments);
    if (!target) {
      const subject = now.assignment.subjectCode || now.assignment.subjectName || "this subject's";
      return { result: "wait", note: `No ${subject} class in ${item.toSectionName || "that section"} yet. Create it in Grading assignments, then approve.`, ops: [] };
    }
    item = { ...item, toAssignmentId: target.id };
  }
  const why = checkClass(item, now);
  if (why) return { result: "skip", note: why, ops: [] };
  const a = now.assignment;
  const sid = item.studentId;
  const ops = [];
  if (item.type === "add") {
    ops.push({ type: "update", path: `gradingAssignments/${a.id}`, data: { studentIds: [...(a.studentIds || []), sid] } });
    return { result: "apply", note: "", ops };
  }
  ops.push({ type: "update", path: `gradingAssignments/${a.id}`, data: { studentIds: (a.studentIds || []).filter((x) => x !== sid) } });
  (now.grades || []).filter((g) => g.assignmentId === a.id && g.studentId === sid && g.draft).forEach((g) => ops.push({ type: "delete", path: `grades/${g.id}` }));
  if (item.type === "move") {
    ops.push({ type: "update", path: `gradingAssignments/${target.id}`, data: { studentIds: [...(target.studentIds || []), sid] } });
  }
  return { result: "apply", note: "", ops };
}

/** The request's status from its lines: "done" when none is pending. */
export const requestStatus = (items) => ((items || []).some((x) => !x.decision || x.decision === "pending") ? "submitted" : "done");

/** "2 approved, 1 declined, 1 could not be made". */
export function decisionCounts(items) {
  const n = (d) => (items || []).filter((x) => x.decision === d).length;
  return [[n("approved"), "approved"], [n("declined"), "declined"], [n("skipped"), "could not be made"]]
    .filter(([c]) => c).map(([c, w]) => `${c} ${w}`).join(", ") || "nothing decided";
}

/**
 * One plain sentence for a change: "Move Bautista, Ana from BSC 1A to BSC 1B (GE 1 with Maria Reyes)."
 * cls: the request's class { subjectCode, sectionName }; target: the class a move goes to, or null.
 */
export function describe(item, cls, target) {
  const who = item.studentName || "this student";
  const subject = cls.subjectCode || cls.subjectName || "this subject";
  if (item.type === "add") return `Add ${who} to ${subject}, ${cls.sectionName}.`;
  if (item.type === "remove") return `Remove ${who} from ${subject}, ${cls.sectionName}.`;
  const where = target
    ? `${target.sectionName} (${subject}${target.teacherName ? ` with ${target.teacherName}` : ""})`
    : `${item.toSectionName || "another section"} (${subject}${item.toTeacherName ? ` with ${item.toTeacherName}` : ""}; no class there yet)`;
  return `Move ${who} from ${cls.sectionName} to ${where}.`;
}
