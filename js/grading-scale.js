// ==========================================================
// grading-scale.js — The school's grading scale (Setup and options).
//
//   percent  0 to 100; 75 and above is Passed (the default)
//   point1   1.00 to 5.00, 1.00 is the highest:
//              1.00–2.75 passing (steps of 0.25), 3.00 lowest passing,
//              4.00 conditional / incomplete, 5.00 failing
//   point5   the same, reversed: 5.00 is the highest:
//              5.00–3.25 passing, 3.00 lowest passing,
//              2.00 conditional / incomplete, 1.00 failing
//
// The same rules are in firestore.rules, Database.gs and schema.sql.
// app.js loads the school's choice (settings/options) before a page starts.
// ==========================================================

export const SCALES = {
  percent: {
    label: "Percentage: 0 to 100 (75 and above passes)",
    short: "0–100",
  },
  point1: {
    label: "1.00 to 5.00: 1.00 is the highest (3.00 lowest passing, 5.00 failing)",
    short: "1.00 highest",
  },
  point5: {
    label: "5.00 to 1.00: 5.00 is the highest (3.00 lowest passing, 1.00 failing)",
    short: "5.00 highest",
  },
};

// Final grade (GWA) scale. A 0–100 GWA is converted to 1.00–5.00 with this table
// (lowest percentage for each grade; below the last one = 5.00). The 4.00 row is
// optional (min null = not used). The 5.00-highest scale uses the mirror (6 − grade).
export const DEFAULT_TRANSMUTATION = [
  { grade: 1, min: 97 }, { grade: 1.25, min: 94 }, { grade: 1.5, min: 91 }, { grade: 1.75, min: 88 },
  { grade: 2, min: 85 }, { grade: 2.25, min: 82 }, { grade: 2.5, min: 79 }, { grade: 2.75, min: 76 },
  { grade: 3, min: 75 }, { grade: 4, min: null },
];

export const DEFAULT_OPTIONS = {
  gradingScale: "percent", allowConditional: true, sectionMove: "ask",
  finalScale: "same", transmutation: DEFAULT_TRANSMUTATION,
  auditKeepDays: 0, // audit trail: 0 = kept until deleted by hand
  combineClasses: "auto", // "auto": same subject + teacher in 2+ sections shown as one class in Enter grades; "off"
};

let opts = { ...DEFAULT_OPTIONS };

export function setGradingOptions(o) {
  opts = { ...DEFAULT_OPTIONS, ...(o || {}) };
  if (!SCALES[opts.gradingScale]) opts.gradingScale = "percent";
  if (!Array.isArray(opts.transmutation) || !opts.transmutation.length) opts.transmutation = DEFAULT_TRANSMUTATION;
}
export const gradingOptions = () => ({ ...opts });
export const scaleKey = () => opts.gradingScale;
export const isPointScale = () => opts.gradingScale !== "percent";

const STEPS = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3]; // point1 passing grades
const same = (a, b) => Math.abs(a - b) < 1e-9;

/** The grades that can be entered on a point scale, best first. */
export function allowedGrades(scale = opts.gradingScale, allowConditional = opts.allowConditional) {
  if (scale === "point1") return [...STEPS, ...(allowConditional ? [4] : []), 5];
  if (scale === "point5") return [...STEPS.map((v) => 6 - v), ...(allowConditional ? [2] : []), 1];
  return null;
}

const CONDITIONAL = { point1: 4, point5: 2 };

/** "Passed" | "Failed" | "Conditional" for one subject's grade. */
export function remarksFor(grade, scale = opts.gradingScale) {
  const n = Number(grade);
  if (scale === "point1") return same(n, 4) ? "Conditional" : n <= 3 ? "Passed" : "Failed";
  if (scale === "point5") return same(n, 2) ? "Conditional" : n >= 3 ? "Passed" : "Failed";
  return n >= 75 ? "Passed" : "Failed";
}

/** Passed / Failed for a general weighted average (already rounded to 2 decimals). */
export function gwaRemarks(gwa, scale = opts.gradingScale) {
  if (scale === "point1") return gwa <= 3 ? "Passed" : "Failed";
  if (scale === "point5") return gwa >= 3 ? "Passed" : "Failed";
  return gwa >= 75 ? "Passed" : "Failed";
}

/** Sorts better grades first (works for every scale). */
export function compareBest(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return opts.gradingScale === "point1" ? a - b : b - a;
}

// ---------- Remarks instead of a number (Enter grades) ----------
// Saved as { finalGrade: null, remarks: "Incomplete" | "Dropped" }. Not counted in the GWA.
export const MARKS = { INC: "Incomplete", DRP: "Dropped" };
const MARK_WORDS = { inc: "INC", incomplete: "INC", drp: "DRP", drop: "DRP", dropped: "DRP" };
/** "INC" / "DRP" for a remark saved instead of a number ("" for a normal grade). */
export function markCode(grade, remarks) {
  if (grade !== null && grade !== undefined && grade !== "") return "";
  return Object.keys(MARKS).find((k) => MARKS[k] === remarks) || "";
}
/** The remarks of a parsed grade (a number's Passed/Failed, or Incomplete/Dropped). */
export const parsedRemarks = (p) => (p.mark ? p.mark : remarksFor(p.value));
/** A saved grade as text: "1.75", "88", "INC", "DRP". */
export function gradeText(grade, remarks) {
  const code = markCode(grade, remarks);
  if (code) return code;
  if (grade === null || grade === undefined || grade === "") return "";
  return isPointScale() ? Number(grade).toFixed(2) : String(grade);
}

/** Reads what someone typed: { state: "empty" | "invalid" | "valid", value, mark? }. */
export function parseGrade(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { state: "empty" };
  const word = MARK_WORDS[text.toLowerCase()];
  if (word) return { state: "valid", value: null, mark: MARKS[word], code: word };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return { state: "invalid" };
  const n = Number(text);
  const allowed = allowedGrades();
  if (allowed) {
    const hit = allowed.find((v) => same(v, n));
    return hit === undefined ? { state: "invalid" } : { state: "valid", value: hit };
  }
  if (n < 0 || n > 100) return { state: "invalid" };
  return { state: "valid", value: Math.round(n * 100) / 100 };
}

/** The grades of a point scale in words: "1.00 to 3.00 in steps of 0.25, 4.00 or 5.00". */
function stepsText() {
  const c = opts.allowConditional;
  return opts.gradingScale === "point1"
    ? `1.00 to 3.00 in steps of 0.25${c ? ", 4.00" : ","} or 5.00`
    : `5.00 to 3.00 in steps of 0.25${c ? ", 2.00" : ","} or 1.00`;
}

/** What's wrong with a typed grade, shown under its box ("" when it's fine or empty). */
export function gradeProblem(raw) {
  const text = String(raw ?? "").trim();
  if (parseGrade(text).state !== "invalid") return "";
  const point = isPointScale();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return point ? "Type a grade from 1.00 to 5.00, or INC or DRP." : "Type a number from 0 to 100, or INC or DRP.";
  if (/\.\d{3,}$/.test(text)) return "Use at most 2 decimals.";
  const n = Number(text);
  if (!point) return "Grade must be between 0 and 100.";
  if (n >= 10) return "This school uses grades from 1.00 to 5.00, not 0 to 100.";
  if (n < 1 || n > 5) return "Grade must be from 1.00 to 5.00.";
  if (same(n, CONDITIONAL[opts.gradingScale]) && !opts.allowConditional) {
    return `${n.toFixed(2)} (conditional) isn't used at this school. Use ${stepsText()}.`;
  }
  return `${n.toFixed(2)} isn't on the grading scale. Use ${stepsText()}.`;
}

/** What a valid grade looks like, for error messages. */
export function gradeRangeText() {
  const allowed = allowedGrades();
  if (!allowed) return "a number from 0 to 100, INC or DRP";
  return `${allowed.map((v) => v.toFixed(2)).join(", ")}, INC or DRP`;
}

/** One line explaining the scale (Enter grades, reports). */
export function scaleHint() {
  const c = opts.allowConditional;
  if (opts.gradingScale === "point1") {
    return `Grades: 1.00 (highest) to 3.00 pass, in steps of 0.25${c ? "; 4.00 is conditional" : ""}; 5.00 is failed. Type INC for incomplete or DRP for dropped.`;
  }
  if (opts.gradingScale === "point5") {
    return `Grades: 5.00 (highest) to 3.00 pass, in steps of 0.25${c ? "; 2.00 is conditional" : ""}; 1.00 is failed. Type INC for incomplete or DRP for dropped.`;
  }
  return "Grades: 0 to 100. 75 and above is Passed. Type INC for incomplete or DRP for dropped.";
}

/** One line explaining how the GWA passes (Final grades, exports). */
export function gwaHint() {
  if (opts.gradingScale === "point1") return "A GWA of 3.00 or better (lower) is Passed.";
  if (opts.gradingScale === "point5") return "A GWA of 3.00 or better (higher) is Passed.";
  return "75.00 and above is Passed.";
}

/** Excel formula for the remarks of the grade in cell `ref` (grade sheet export). */
export function excelRemarksFormula(ref) {
  if (opts.gradingScale === "point1") return `IF(${ref}="","",IF(${ref}=4,"Conditional",IF(${ref}<=3,"Passed","Failed")))`;
  if (opts.gradingScale === "point5") return `IF(${ref}="","",IF(${ref}=2,"Conditional",IF(${ref}>=3,"Passed","Failed")))`;
  return `IF(${ref}="","",IF(${ref}>=75,"Passed","Failed"))`;
}

/** Badge colour class for a remark. */
export function remarksClass(remarks) {
  return { Passed: "badge-pass", Failed: "badge-fail", Conditional: "badge-cond", Incomplete: "text-bg-warning", Dropped: "text-bg-secondary", "Transferred out": "text-bg-secondary" }[remarks] || "badge-none";
}

// ---------- Final grade (GWA) on another scale (Setup and options → Final grade) ----------

/** The final grade's scale. Point grades can't be turned back into percentages. */
export function finalScaleKey(o = opts) {
  const f = o.finalScale;
  if (!f || f === "same" || !SCALES[f]) return o.gradingScale;
  if (o.gradingScale !== "percent" && f === "percent") return o.gradingScale;
  return f;
}
export const finalDiffers = () => finalScaleKey() !== opts.gradingScale;

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The conversion table in use, best grade first (rows switched off are left out). */
export function transmutationRows(table = opts.transmutation) {
  return (table || DEFAULT_TRANSMUTATION)
    .filter((r) => r && typeof r.min === "number" && !Number.isNaN(r.min))
    .sort((a, b) => b.min - a.min);
}

/** Converts a GWA (or grade) from the grading scale to the final grade's scale. */
export function toFinal(value, o = opts) {
  if (value === null || value === undefined) return null;
  const from = o.gradingScale;
  const to = finalScaleKey(o);
  if (from === to) return value;
  if (from === "percent") {
    const v = round2(value);
    const row = transmutationRows(o.transmutation).find((r) => v >= r.min);
    const g = row ? row.grade : 5;
    return to === "point5" ? 6 - g : g;
  }
  return round2(6 - value); // 1.00-highest ↔ 5.00-highest
}

/** Passed / Conditional / Failed for a final grade on the final scale. */
export function finalRemarks(final) {
  const to = finalScaleKey();
  const v = round2(final);
  if ((to === "point1" && v === 4) || (to === "point5" && v === 2)) return "Conditional";
  return gwaRemarks(v, to);
}

/** Excel formula giving the final grade from the GWA in cell `ref`. */
export function excelFinalFormula(ref) {
  const to = finalScaleKey();
  if (opts.gradingScale === to) return null;
  if (opts.gradingScale !== "percent") return `IF(${ref}="","",6-${ref})`;
  const rows = transmutationRows();
  const g = (x) => (to === "point5" ? 6 - x : x);
  let f = String(g(5));
  for (let i = rows.length - 1; i >= 0; i--) f = `IF(ROUND(${ref},2)>=${rows[i].min},${g(rows[i].grade)},${f})`;
  return `IF(${ref}="","",${f})`;
}

/** Header label for the final grade column. */
export function finalLabel() {
  return { percent: "Final grade (0–100)", point1: "Final grade (1.00–5.00)", point5: "Final grade (5.00–1.00)" }[finalScaleKey()];
}

/** One line explaining how the final grade is found (Final grades page, exports). */
export function finalHint() {
  if (!finalDiffers()) return "";
  if (opts.gradingScale !== "percent") return `The final grade is the GWA on the ${SCALES[finalScaleKey()].short} scale (6 − GWA).`;
  const rows = transmutationRows();
  const g = (x) => (finalScaleKey() === "point5" ? 6 - x : x).toFixed(2);
  const last = rows[rows.length - 1];
  return `The final grade converts the GWA: ${rows.map((r) => `${r.min}+ = ${g(r.grade)}`).join(", ")}, below ${last ? last.min : 75} = ${g(5)}.`;
}
