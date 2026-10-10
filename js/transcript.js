// ==========================================================
// transcript.js — A student's permanent record (Students → Record)
// Every school year and term with its subjects, the term GWA and a cumulative
// GWA. INC / DRP are listed but not counted, as in Final grades.
// ==========================================================

import { TERMS, termOf } from "./terms.js";
import { markCode, remarksFor, toFinal, finalDiffers, finalLabel } from "./grading-scale.js";
import { escapeHtml, letterheadHtml, signatureHtml } from "./app.js";

const termRank = (t) => (TERMS.includes(t) ? TERMS.indexOf(t) : TERMS.length); // no term last
const weighted = (subjects) => {
  const counted = subjects.filter((s) => !s.mark && typeof s.finalGrade === "number");
  const units = counted.reduce((n, s) => n + s.units, 0);
  return { units, gwa: units > 0 ? counted.reduce((n, s) => n + s.finalGrade * s.units, 0) / units : null };
};

/**
 * { periods: [{ schoolYear, term, subjects, units, gwa }], units, gwa } from a student's grades.
 * Periods: oldest school year first, then 1st Semester, 2nd Semester, Summer, no term.
 */
export function buildTranscript(grades) {
  const byKey = new Map();
  (grades || []).forEach((g) => {
    const term = termOf(g);
    const key = `${g.schoolYear}|${term}`;
    if (!byKey.has(key)) byKey.set(key, { schoolYear: g.schoolYear, term, subjects: [] });
    const mark = markCode(g.finalGrade, g.remarks);
    const grade = mark ? null : Number(g.finalGrade);
    byKey.get(key).subjects.push({
      subjectCode: g.subjectCode || "", subjectName: g.subjectName || "", units: Number(g.units) || 0,
      finalGrade: grade, mark, remarks: mark ? g.remarks : g.remarks || remarksFor(grade),
    });
  });
  const periods = [...byKey.values()]
    .sort((a, b) => String(a.schoolYear).localeCompare(String(b.schoolYear)) || termRank(a.term) - termRank(b.term))
    .map((p) => {
      p.subjects.sort((x, y) => x.subjectCode.localeCompare(y.subjectCode, undefined, { numeric: true }));
      return { ...p, ...weighted(p.subjects) };
    });
  return { periods, ...weighted(periods.flatMap((p) => p.subjects)) };
}

const f2 = (n) => (n === null || n === undefined ? "—" : (Math.round((n + Number.EPSILON) * 100) / 100).toFixed(2));

/** A printable page (own styles, opened in a new window to print). */
export function transcriptHtml(student, t, school) {
  const fin = finalDiffers();
  const gwaText = (g) => (g === null ? "—" : fin ? `${f2(g)} (${finalLabel()}: ${f2(toFinal(Math.round(g * 100) / 100))})` : f2(g));
  const period = (p) => `
    <h3>${escapeHtml(p.schoolYear)}${p.term ? ` · ${escapeHtml(p.term)}` : ""}</h3>
    <table>
      <thead><tr><th>Code</th><th>Subject</th><th class="n">Units</th><th class="n">Grade</th><th>Remarks</th></tr></thead>
      <tbody>${p.subjects.map((s) => `<tr><td>${escapeHtml(s.subjectCode)}</td><td>${escapeHtml(s.subjectName)}</td><td class="n">${s.units}</td><td class="n">${s.mark || f2(s.finalGrade)}</td><td>${escapeHtml(s.remarks)}</td></tr>`).join("")}</tbody>
      <tfoot><tr><td colspan="2">Term GWA</td><td class="n">${p.units}</td><td class="n" colspan="2">${gwaText(p.gwa)}</td></tr></tfoot>
    </table>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Record – ${escapeHtml(student.studentName)}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1f2a44;margin:24px;font-size:13px}
  .letterhead{display:flex;gap:12px;align-items:center;border-bottom:2px solid #1f2a44;padding-bottom:8px;margin-bottom:12px}
  .letterhead-logo{height:56px}.letterhead-name{font-size:18px;font-weight:bold}.letterhead-line{font-size:12px;color:#56617a}
  h2{font-size:16px;margin:8px 0 2px}h3{font-size:14px;margin:18px 0 4px}
  .meta{color:#56617a;margin-bottom:8px}
  table{width:100%;border-collapse:collapse}th,td{border-bottom:1px solid #dde1e8;padding:4px 6px;text-align:left}
  th{background:#f4f5f7;font-size:12px}.n{text-align:right;white-space:nowrap}tfoot td{font-weight:bold;border-top:2px solid #1f2a44}
  .total{margin-top:16px;font-size:15px;font-weight:bold}.signature-block{margin-top:40px;width:240px;text-align:center}
  .signature-line{border-top:1px solid #1f2a44;padding-top:4px;font-weight:bold}.small{font-size:11px}.text-secondary{color:#56617a}
  @media print{body{margin:12mm}h3{break-after:avoid}table{break-inside:auto}tr{break-inside:avoid}}
</style></head><body>
  ${letterheadHtml(school)}
  <h2>Permanent record of grades</h2>
  <div class="meta">${escapeHtml(student.studentName)} · Student ID ${escapeHtml(student.studentId)}${student.sectionName ? ` · Now: ${escapeHtml(student.sectionName)}, ${escapeHtml(student.yearLevel || "")} ${escapeHtml(student.schoolYear || "")}` : ""}</div>
  ${t.periods.length ? t.periods.map(period).join("") : "<p>No grades saved yet.</p>"}
  <div class="total">Cumulative GWA: ${gwaText(t.gwa)} <span class="small text-secondary">(${t.units} units; INC and DRP not counted)</span></div>
  ${signatureHtml(school)}
</body></html>`;
}
