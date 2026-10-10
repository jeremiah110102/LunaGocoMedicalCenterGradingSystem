// ==========================================================
// terms.js — The term (semester) of a grading assignment
//
// Each grading assignment (and its grades) can belong to a term of the school
// year. "" = not set (whole school year), which is how older records are read.
// Final grades shows the GWA for one term or for the whole school year.
// A student can take a subject only once per school year and term.
// ==========================================================

export const TERMS = ["1st Semester", "2nd Semester", "Summer"];

/** The term of an assignment or grade ("" = not set). */
export const termOf = (x) => (x && TERMS.includes(x.term) ? x.term : "");
/** Text for a term ("" reads as the whole school year). */
export const termText = (t) => t || "Whole school year";
/** "2026-2027, 1st Semester" or "2026-2027". */
export const yearTermText = (schoolYear, term) => (term ? `${schoolYear}, ${term}` : schoolYear || "");

/** <option> list for a term dropdown. */
export function termOptions(selected = "", blank = "No term (whole school year)") {
  return [`<option value="">${blank}</option>`, ...TERMS.map((t) => `<option${t === selected ? " selected" : ""}>${t}</option>`)].join("");
}

// ---------- Term deadlines (Setup and options → Term deadlines) ----------
// settings/options.termDeadlines = { "1st Semester": <date and time>, … }. After a term's
// deadline, teachers can't add grades for that term's classes (the database rules check it too).

/** A saved date in any form (Firestore / Sheets / Supabase / the local cache) → milliseconds, or null. */
export function deadlineMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") { const t = Date.parse(v); return Number.isNaN(t) ? null : t; }
  if (typeof v.toMillis === "function") return v.toMillis();
  if (typeof v.toDate === "function") return v.toDate().getTime();
  if (typeof v.__ts === "string") return Date.parse(v.__ts);
  if (typeof v._ms === "number") return v._ms;
  if (typeof v.seconds === "number") return v.seconds * 1000;
  return null;
}
/** The deadline of a term (ms), or null when it has none. */
export const termDeadline = (options, term) => deadlineMs(((options || {}).termDeadlines || {})[term || ""]);
/** True when the term's grade entry is closed for teachers. */
export function termClosed(options, term, now = Date.now()) {
  const dl = termDeadline(options, term);
  return dl !== null && now >= dl;
}
/** "Oct 30, 2026" */
export const deadlineText = (ms) => new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
