// ==========================================================
// gradesheet-export.js — Builds an Excel workbook for one year level
// in the school's class grade sheet layout (like BSC 3A):
//
//   Row 1: INSTRUCTOR - <section> | instructor above each subject block
//   Row 2: NO. | NAME | (subject) UNIT  FINAL GRADE  (grade × unit)  REMARKS … |
//          Total Grades | Total Units | GWA | STATUS (Complete/Incomplete)
//   Rows : one per student; a block is filled only if the student takes it.
//
// Formatting and formulas match the school's BSC sheets (BSC 1A/3A):
//   Calibri, bold wrapped headers, thin borders, red SAMPLE row,
//   grade × unit per subject, Total Grades = Σ(grade × unit),
//   Total Units = Σ units, GWA = Total Grades ÷ Total Units.
//
// Pure functions: no DOM or Firebase, so they're easy to test.
// ==========================================================

import {
  remarksFor, excelRemarksFormula, gwaHint, finalDiffers, scaleKey, toFinal, excelFinalFormula, finalLabel, finalHint, markCode,
} from "./grading-scale.js";

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const cmp = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });

/** Excel sheet names: max 31 characters, no : \ / ? * [ ], unique in the workbook. */
function sheetName(name, used) {
  let base = String(name || "Sheet").replace(/[:\\/?*[\]]/g, "-").trim().slice(0, 31) || "Sheet";
  let n = base;
  let i = 2;
  while (used.has(n.toLowerCase())) n = `${base.slice(0, 28)} (${i++})`;
  used.add(n.toLowerCase());
  return n;
}

/** Groups the school year's data into sections of one year level. */
export function sectionsForLevel({ yearLevel, assignments, students, schoolYear }) {
  const sections = new Map(); // sectionId → { id, name, assignments: [], studentIds: Set }
  const ensure = (id, name) => {
    if (!sections.has(id)) sections.set(id, { id, name, assignments: [], studentIds: new Set() });
    return sections.get(id);
  };
  assignments
    .filter((a) => a.yearLevel === yearLevel)
    .forEach((a) => {
      const s = ensure(a.sectionId, a.sectionName);
      s.assignments.push(a);
      (a.studentIds || []).forEach((id) => s.studentIds.add(id));
    });
  students.forEach((st, id) => {
    // A student now in another school year (promoted) is in this year's sheets only through its assignments
    if (schoolYear && st.schoolYear && st.schoolYear !== schoolYear) return;
    if (st.yearLevel === yearLevel && st.sectionId) ensure(st.sectionId, st.sectionName).studentIds.add(id);
  });
  return [...sections.values()]
    // Same subject order as the imported grade sheet; others follow by code
    .map((s) => ({ ...s, assignments: s.assignments.sort((x, y) =>
      (x.sheetOrder ?? 9999) - (y.sheetOrder ?? 9999) || cmp(x.subjectCode, y.subjectCode) || cmp(x.teacherName, y.teacherName)) }))
    .sort((a, b) => cmp(a.name, b.name));
}

/** Year levels that have something to export, with section counts. */
export function exportableLevels({ assignments, students, levels, schoolYear }) {
  return levels
    .map((yearLevel) => ({ yearLevel, sections: sectionsForLevel({ yearLevel, assignments, students, schoolYear }).length }))
    .filter((l) => l.sections > 0);
}

// ---------- Styled workbook (ExcelJS), matching the school's BSC grade sheet ----------
const THIN = { style: "thin" };
const BOX = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const SIDES = { left: THIN, right: THIN };
const SIDES_BOTTOM = { left: THIN, right: THIN, bottom: THIN };
const RED = { argb: "FFFF0000" };
const font = (size, bold = false, color) => ({ name: "Calibri", size, bold, ...(color ? { color } : {}) });
const LEFT_MID = { horizontal: "left", vertical: "middle" };
const LEFT_MID_WRAP = { horizontal: "left", vertical: "middle", wrapText: true };
const CENTER_WRAP = { horizontal: "center", vertical: "middle", wrapText: true };

/** Column width like the school's sheet: the subject column fits its name. */
const subjectWidth = (text) => Math.min(45, Math.max(18, Math.round(String(text).length * 0.94 * 10) / 10));

/**
 * Builds the styled workbook for one year level with ExcelJS.
 * Returns the ExcelJS workbook; call workbook.xlsx.writeBuffer() to download it.
 *
 * grades: [{ assignmentId, studentId, finalGrade }], students: Map(id → student),
 * records: Final grades page records (Summary sheet), school: settings.
 */
export function buildStyledYearLevelWorkbook(ExcelJS, { schoolYear, term = "", yearLevel, assignments, grades, students, records, school = {} }) {
  const gradeOf = new Map(grades.map((g) => [`${g.assignmentId}|${g.studentId}`, Number(g.finalGrade)]));
  // INC / DRP saved instead of a number
  const markOf = new Map(grades.filter((g) => markCode(g.finalGrade, g.remarks)).map((g) => [`${g.assignmentId}|${g.studentId}`, { code: markCode(g.finalGrade, g.remarks), remarks: g.remarks }]));
  const sections = sectionsForLevel({ yearLevel, assignments, students, schoolYear });
  const wb = new ExcelJS.Workbook();
  wb.creator = school.schoolName || "College Grading System";
  wb.created = new Date();
  const used = new Set();
  const colName = (n) => { let s = ""; n += 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

  // ---------- Summary sheet ----------
  const sum = wb.addWorksheet(sheetName("Summary", used), { views: [{ zoomScale: 115 }] });
  const levelRecords = (records || [])
    .filter((r) => r.yearLevel === yearLevel)
    .sort((a, b) => cmp(a.sectionName, b.sectionName) || cmp(a.studentName, b.studentName));
  sum.columns = [8, 12, 14, 32, 10, 14, 12, 10, 13].map((w) => ({ width: w }));
  sum.getCell("A1").value = school.schoolName || "Final grades";
  sum.getCell("A1").font = font(14, true);
  sum.getCell("A2").value = `Final grades, ${yearLevel}, school year ${schoolYear}${term ? `, ${term}` : ""}`;
  sum.getCell("A2").font = font(12, true);
  // With a final grade on another scale (Setup and options), it gets its own column after the GWA
  const FIN = finalDiffers();
  const head = ["NO.", "SECTION", "STUDENT ID", "NAME", "SUBJECTS", "Total Grades", "Total Units", "GWA", ...(FIN ? [finalLabel().toUpperCase()] : []), "REMARKS"];
  const hr = sum.getRow(4);
  hr.height = 32;
  head.forEach((h, i) => {
    const c = hr.getCell(i + 1);
    c.value = h; c.font = font(12, true); c.border = BOX; c.alignment = LEFT_MID_WRAP;
  });
  levelRecords.forEach((r, i) => {
    const row = sum.getRow(5 + i);
    const vals = [i + 1, r.sectionName, r.studentNumber, r.studentName, r.subjects.length + r.pending.length,
      round2(r.totalWeighted), round2(r.totalUnits), r.gwa === null ? "" : round2(r.gwa),
      ...(FIN ? [r.gwa === null ? "" : toFinal(round2(r.gwa))] : []), r.remarks];
    vals.forEach((v, ci) => {
      const c = row.getCell(ci + 1);
      c.value = v;
      c.font = font(ci === 3 ? 11 : 12, ci === 3 || ci === 7);
      c.border = i === levelRecords.length - 1 ? SIDES_BOTTOM : SIDES;
      c.alignment = LEFT_MID;
      if (ci === 5 || ci === 7) c.numFmt = "0.00";
    });
  });
  const note = sum.getRow(6 + levelRecords.length);
  note.getCell(1).value = `GWA = Total Grades ÷ Total Units, where each subject's grade is multiplied by its units. ${FIN ? `${finalHint()} A final grade of 3.00 or better is Passed.` : gwaHint()}`;
  note.getCell(1).font = font(10, false, { argb: "FF555555" });

  // ---------- One grade sheet per section ----------
  for (const sec of sections) {
    const ws = wb.addWorksheet(sheetName(sec.name, used), { views: [{ zoomScale: 130 }] });
    const blocks = sec.assignments;
    const B0 = 3;                          // first block column (C), 1-based
    const T0 = B0 + blocks.length * 5;     // Total Grades column
    const col = (c) => colName(c - 1);     // 1-based → letter

    // Column widths
    ws.getColumn(1).width = 6.3;
    ws.getColumn(2).width = 30;
    blocks.forEach((a, i) => {
      const s = B0 + i * 5;
      ws.getColumn(s).width = subjectWidth(`${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`);
      ws.getColumn(s + 1).width = 9.1;
      ws.getColumn(s + 2).width = 13;
      ws.getColumn(s + 3).width = 13;
      ws.getColumn(s + 4).width = 16.4;
    });
    [9.1, 13, 9.1, 24, ...(FIN ? [14] : [])].forEach((w, i) => (ws.getColumn(T0 + i).width = w));

    // Row 1: instructors
    const r1 = ws.getRow(1);
    r1.height = 45;
    r1.getCell(1).border = BOX; r1.getCell(1).alignment = LEFT_MID;
    Object.assign(r1.getCell(2), { value: `INSTRUCTOR - ${sec.name}`, font: font(11, true), border: BOX, alignment: LEFT_MID_WRAP });
    blocks.forEach((a, i) => {
      const s = B0 + i * 5;
      ws.mergeCells(1, s, 1, s + 4);
      Object.assign(ws.getCell(1, s), { value: a.teacherName || "", font: font(11, true), border: BOX, alignment: CENTER_WRAP });
    });
    ws.mergeCells(1, T0, 1, T0 + (FIN ? 4 : 3));
    ws.getCell(1, T0).border = BOX;

    // Row 2: column headers
    const r2 = ws.getRow(2);
    r2.height = 47.25;
    const hdr = (c, v, size = 12) => Object.assign(r2.getCell(c), { value: v, font: font(size, true), border: BOX, alignment: LEFT_MID_WRAP });
    hdr(1, "NO.", 11);
    hdr(2, "NAME", 11);
    blocks.forEach((a, i) => {
      const s = B0 + i * 5;
      hdr(s, null, 14);
      hdr(s + 1, "UNIT");
      hdr(s + 2, "FINAL GRADE");
      hdr(s + 3, null);
      hdr(s + 4, "REMARKS  (Passed/Failed)");
    });
    hdr(T0, "Total Grades");
    hdr(T0 + 1, "Total Units");
    hdr(T0 + 2, "GWA");
    hdr(T0 + 3, "STATUS (Complete/Incomplete)");
    if (FIN) hdr(T0 + 4, finalLabel().toUpperCase());

    // Row 3: SAMPLE row in red, like the school's template
    const r3 = ws.getRow(3);
    const red = (c, v, size = 12, extra = {}) => Object.assign(r3.getCell(c), { value: v, font: font(size, true, RED), border: BOX, alignment: { horizontal: "left", vertical: "middle", ...extra } });
    red(1, null);
    red(2, "SAMPLE", 12, { wrapText: true });
    const sampleX = [], sampleU = [];
    const SAMPLE = { point1: 1.75, point5: 4.25 }[scaleKey()] ?? 90; // a passing grade on the school's scale
    blocks.forEach((a, i) => {
      const s = B0 + i * 5;
      const units = Number(a.units) || 0;
      red(s, `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`, 11);
      red(s + 1, units);
      red(s + 2, SAMPLE);
      red(s + 3, { formula: `${col(s + 2)}3*${col(s + 1)}3`, result: SAMPLE * units });
      red(s + 4, "Passed");
      sampleX.push(`${col(s + 3)}3`); sampleU.push(`${col(s + 1)}3`);
    });
    const sampleTU = blocks.reduce((n, a) => n + (Number(a.units) || 0), 0);
    red(T0, { formula: `SUM(${sampleX.join(",")})`, result: SAMPLE * sampleTU });
    red(T0 + 1, { formula: `SUM(${sampleU.join(",")})`, result: sampleTU });
    red(T0 + 2, { formula: `IF(${col(T0 + 1)}3=0,"",${col(T0)}3/${col(T0 + 1)}3)`, result: sampleTU ? SAMPLE : "" });
    red(T0 + 3, null);
    if (FIN) red(T0 + 4, { formula: excelFinalFormula(`${col(T0 + 2)}3`), result: sampleTU ? toFinal(SAMPLE) : "" });

    // Students from row 4
    const list = [...sec.studentIds]
      .map((id) => ({ id, s: students.get(id) }))
      .filter((x) => x.s)
      .sort((a, b) => cmp(a.s.studentName, b.s.studentName));

    list.forEach((x, i) => {
      const R = 4 + i;
      const row = ws.getRow(R);
      const border = i === list.length - 1 ? SIDES_BOTTOM : SIDES;
      const put = (c, v, f, align = { horizontal: "left" }) => Object.assign(row.getCell(c), { value: v, font: f, border, alignment: align });
      put(1, i + 1, font(11), LEFT_MID);
      put(2, x.s.studentName, font(11, true), { vertical: "middle" });

      let totalX = 0, totalU = 0, nGrades = 0, nUnits = 0;
      const xRefs = [], uRefs = [], gRefs = [];
      blocks.forEach((a, bi) => {
        const s = B0 + bi * 5;
        const U = `${col(s + 1)}${R}`, G = `${col(s + 2)}${R}`;
        xRefs.push(`${col(s + 3)}${R}`); gRefs.push(G);
        const taking = (a.studentIds || []).includes(x.id);
        const mark = taking ? markOf.get(`${a.id}|${x.id}`) : null;
        if (mark?.code !== "DRP") uRefs.push(U); // a dropped subject's units don't count
        if (!taking) {
          // Not taking this subject: blank block (keeps the side borders)
          for (let c = s; c < s + 5; c++) put(c, null, font(c === s ? 11 : 12), c === s ? { vertical: "middle" } : { horizontal: "left" });
          return;
        }
        const units = Number(a.units) || 0;
        const grade = mark ? NaN : gradeOf.get(`${a.id}|${x.id}`);
        const graded = Number.isFinite(grade);
        if (mark) {
          put(s, `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`, font(11), { vertical: "middle" });
          put(s + 1, units, font(12));
          put(s + 2, mark.code, font(12, true));
          put(s + 3, { formula: `IF(ISNUMBER(${G}),${G}*${U},0)`, result: 0 }, font(12));
          put(s + 4, mark.remarks, font(12));
          if (mark.code === "INC") { totalU += units; nUnits++; }
          return;
        }
        totalU += units; nUnits++;
        if (graded) { totalX += grade * units; nGrades++; }
        put(s, `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`, font(11), { vertical: "middle" });
        put(s + 1, units, font(12));
        put(s + 2, graded ? grade : null, font(12));
        put(s + 3, { formula: `IF(ISNUMBER(${G}),${G}*${U},0)`, result: graded ? round2(grade * units) : 0 }, font(12));
        put(s + 4, { formula: excelRemarksFormula(G), result: graded ? remarksFor(grade) : "" }, font(12));
      });

      const TG = `${col(T0)}${R}`, TU = `${col(T0 + 1)}${R}`;
      put(T0, { formula: `SUM(${xRefs.join(",")})`, result: round2(totalX) }, font(12, true), LEFT_MID);
      put(T0 + 1, { formula: `SUM(${uRefs.join(",")})`, result: totalU }, font(12, true));
      const gwaCell = put(T0 + 2, { formula: `IF(${TU}=0,"",${TG}/${TU})`, result: totalU ? totalX / totalU : "" }, font(12, true));
      gwaCell.numFmt = "0.00";
      put(T0 + 3, {
        formula: `IF(COUNT(${gRefs.join(",")})=COUNT(${uRefs.join(",")}),"Complete","Incomplete")`,
        result: nGrades === nUnits ? "Complete" : "Incomplete",
      }, font(12));
      if (FIN) {
        const fin = put(T0 + 4, { formula: excelFinalFormula(`${col(T0 + 2)}${R}`), result: totalU ? toFinal(round2(totalX / totalU)) : "" }, font(12, true));
        fin.numFmt = "0.00";
      }
    });
  }
  return { workbook: wb, sections: sections.length };
}

export function yearLevelFileName(schoolYear, yearLevel, term = "") {
  return `Final-Grades-${schoolYear}${term ? `-${String(term).replace(/\s+/g, "-")}` : ""}-${String(yearLevel).replace(/\s+/g, "-")}.xlsx`;
}
