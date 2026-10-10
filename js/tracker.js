// ==========================================================
// tracker.js — Grade submission tracker (Dashboard, admin + registrar)
// How many grades each class has, what's missing, and the reminder text.
// ==========================================================

import { deadlineText } from "./terms.js";

/**
 * One row per grading assignment: { asg, total, entered, missing, inc, drp },
 * most missing first (then teacher, then subject). A grade counts as entered when its
 * student is still in the class; INC and DRP count as entered. leftIds = students who
 * dropped or transferred out: without a grade they can't get one, so they aren't counted.
 */
export function summarizeSubmissions(assignments, grades, leftIds = new Set()) {
  const byAsg = new Map();
  (grades || []).forEach((g) => {
    if (!byAsg.has(g.assignmentId)) byAsg.set(g.assignmentId, []);
    byAsg.get(g.assignmentId).push(g);
  });
  const rows = (assignments || []).map((asg) => {
    const all = new Set(asg.studentIds || []);
    const mine = (byAsg.get(asg.id) || []).filter((g) => all.has(g.studentId));
    const graded = new Set(mine.map((g) => g.studentId));
    const ids = new Set([...all].filter((id) => graded.has(id) || !leftIds.has(id)));
    const mark = (r) => mine.filter((g) => (g.finalGrade === null || g.finalGrade === undefined) && g.remarks === r).length;
    const total = ids.size;
    const entered = graded.size;
    return { asg, total, entered, missing: Math.max(total - entered, 0), inc: mark("Incomplete"), drp: mark("Dropped") };
  });
  const cmp = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
  return rows.sort((x, y) => y.missing - x.missing || cmp(x.asg.teacherName, y.asg.teacherName) || cmp(x.asg.subjectCode, y.asg.subjectCode));
}

/**
 * "GE 1 · BSC 1A: 4 grades missing, deadline Oct 30, 2026" (no deadline part without one).
 * deadlineMs is when entry closes (midnight after the last day), so the date shown is the last day.
 */
export function reminderText(asg, missing, deadlineMs) {
  const what = `${asg.subjectCode || asg.subjectName} · ${asg.sectionName}: ${missing} grade${missing === 1 ? "" : "s"} missing`;
  return deadlineMs === null || deadlineMs === undefined ? what : `${what}, deadline ${deadlineText(deadlineMs - 1)}`;
}
