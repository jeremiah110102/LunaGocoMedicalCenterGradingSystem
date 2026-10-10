// ==========================================================
// final-grades.js — General Weighted Average per student
//
//   GWA = Σ (Final Grade × Units) ÷ Σ Units
//
// Computed live from the grades collection for one school year and
// one year level at a time (a whole school at once is too much for one
// request), so it always reflects the latest saved grades.
// ==========================================================

import { db, collection, doc, getDoc, getDocs, query, where, documentId } from "./firebase-config.js";
import { buildStyledYearLevelWorkbook, yearLevelFileName } from "./gradesheet-export.js";
import {
  remarksFor, gwaRemarks, compareBest, remarksClass, gwaHint,
  toFinal, finalDiffers, finalRemarks, finalLabel, finalHint, markCode,
} from "./grading-scale.js";
import { hasLeft, statusLabel, statusBadge } from "./student-status.js";
import { TERMS, termOf, yearTermText } from "./terms.js";
import {
  initLayout, toast, escapeHtml, normalize, compareText, tableLoading, tableMessage,
  errorMessage, setBusy, loadSheetJs, YEAR_LEVELS, isValidEmail, clearErrors, fieldError,
  getSchool, cachedSchool, letterheadHtml, signatureHtml, loadExcelJs, downloadBuffer,
} from "./app.js";
// EmailJS keys are stored in Firebase (School settings → Email sending)
let EMAILJS = { publicKey: "", serviceId: "", templateId: "" };
let emailJsReady = false;
async function loadEmailSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "email"));
    if (snap.exists()) EMAILJS = { ...EMAILJS, ...snap.data() };
  } catch (err) {
    console.warn("Email settings:", err.code || err);
  }
  emailJsReady = Boolean(EMAILJS.publicKey && EMAILJS.serviceId && EMAILJS.templateId);
}


const els = {
  year: document.getElementById("fYear"),
  term: document.getElementById("fTerm"),
  level: document.getElementById("fLevel"),
  section: document.getElementById("fSection"),
  sort: document.getElementById("fSort"),
  search: document.getElementById("search"),
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  tally: document.getElementById("finalTally"),
  btnExport: document.getElementById("btnExport"),
  exportMenu: document.getElementById("exportMenu"),
  reportModalEl: document.getElementById("reportModal"),
  reportTitle: document.getElementById("reportTitle"),
  reportBody: document.getElementById("reportBody"),
  btnPrint: document.getElementById("btnPrint"),
  btnEmail: document.getElementById("btnEmail"),
  btnPrintAll: document.getElementById("btnPrintAll"),
  btnEmailAll: document.getElementById("btnEmailAll"),
  emailModalEl: document.getElementById("emailModal"),
  emailForm: document.getElementById("emailForm"),
  emailMode: document.getElementById("emailMode"),
  emailError: document.getElementById("emailError"),
  emailTo: document.getElementById("emailTo"),
  emailCc: document.getElementById("emailCc"),
  emailSubject: document.getElementById("emailSubject"),
  emailMessage: document.getElementById("emailMessage"),
  emailPreview: document.getElementById("emailPreview"),
  btnSendEmail: document.getElementById("btnSendEmail"),
  bulkModalEl: document.getElementById("bulkModal"),
  bulkSummary: document.getElementById("bulkSummary"),
  bulkMissing: document.getElementById("bulkMissing"),
  bulkCc: document.getElementById("bulkCc"),
  bulkSubject: document.getElementById("bulkSubject"),
  bulkMessage: document.getElementById("bulkMessage"),
  bulkProgressWrap: document.getElementById("bulkProgressWrap"),
  bulkProgress: document.getElementById("bulkProgress"),
  bulkLog: document.getElementById("bulkLog"),
  btnBulkSend: document.getElementById("btnBulkSend"),
  btnBulkClose: document.getElementById("btnBulkClose"),
};

let records = []; // one per student for the selected school year and year level
let allSections = []; // every section, for the school years and their year levels
let raw = { grades: [], students: new Map(), assignments: [] }; // the chosen term's data, kept for the grade sheet export
let full = null; // the whole school year's data (raw is cut from it by term)
let school = cachedSchool(); // refreshed from settings/school on load
const schoolLabel = () => school.schoolName || "Registrar's Office";
let reportModal;
let openRecord = null;

// ---------- Number helpers ----------
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const fmt2 = (n) => (n === null || n === undefined ? "—" : round2(n).toFixed(2));
const fmtUnits = (n) => String(round2(n));

// ---------- The computation ----------
/**
 * Builds one record per student:
 *   subjects  graded subjects with weighted = finalGrade × units
 *   pending   subjects the student is assigned to but has no grade yet
 *   totalUnits, totalWeighted, gwa, remarks
 */
function compute({ grades, students, assignments, schoolYear, termOnly = false }) {
  const byId = new Map();

  const ensure = (id, fallback = {}) => {
    if (!byId.has(id)) {
      const s = students.get(id);
      // A student now in another school year (promoted, or moved on): this year's section
      // comes from this year's grade or grading assignment
      const here = s && (!schoolYear || s.schoolYear === schoolYear) ? s : null;
      byId.set(id, {
        id,
        studentNumber: s?.studentId ?? fallback.studentNumber ?? "—",
        studentName: s?.studentName ?? fallback.studentName ?? "(student record not found)",
        yearLevel: here?.yearLevel ?? fallback.yearLevel ?? s?.yearLevel ?? "",
        sectionId: here?.sectionId ?? fallback.sectionId ?? s?.sectionId ?? "",
        sectionName: here?.sectionName ?? fallback.sectionName ?? s?.sectionName ?? "",
        email: s?.email ?? "",
        student: s || null,
        // Dropped / transferred out: unfinished subjects say so instead of "Not graded"
        left: hasLeft(s),
        pendingLabel: hasLeft(s) ? statusLabel(s) : "Not graded",
        subjects: [],
        pending: [],
      });
    }
    return byId.get(id);
  };

  // Everyone enrolled in this school year appears, even without grades yet
  // (for one term: only students with subjects in that term)
  if (!termOnly) students.forEach((s, id) => { if (!schoolYear || s.schoolYear === schoolYear) ensure(id); });

  const gradedKeys = new Set();
  const aById = new Map(assignments.map((a) => [a.id, a]));
  const sectionOf = (a) => (a ? { yearLevel: a.yearLevel, sectionId: a.sectionId, sectionName: a.sectionName } : {});
  grades.forEach((g) => {
    const units = Number(g.units) || 0;
    // INC / DRP: a remark instead of a number (not counted in the units or the GWA)
    const mark = markCode(g.finalGrade, g.remarks);
    const grade = mark ? null : Number(g.finalGrade);
    const fromA = sectionOf(aById.get(g.assignmentId));
    const rec = ensure(g.studentId, { ...g, yearLevel: g.yearLevel ?? fromA.yearLevel, sectionId: g.sectionId ?? fromA.sectionId, sectionName: g.sectionName ?? fromA.sectionName });
    rec.subjects.push({
      assignmentId: g.assignmentId,
      subjectCode: g.subjectCode,
      subjectName: g.subjectName,
      teacherName: g.teacherName,
      units,
      finalGrade: grade,
      mark,
      weighted: mark ? 0 : grade * units,
      remarks: mark ? g.remarks : remarksFor(grade),
    });
    gradedKeys.add(`${g.assignmentId}|${g.studentId}`);
  });

  // Assigned but not yet graded → Incomplete
  assignments.forEach((a) => {
    (a.studentIds || []).forEach((sid) => {
      if (gradedKeys.has(`${a.id}|${sid}`)) return;
      const rec = ensure(sid, sectionOf(a));
      rec.pending.push({
        subjectCode: a.subjectCode,
        subjectName: a.subjectName,
        teacherName: a.teacherName,
        units: Number(a.units) || 0,
      });
    });
  });

  byId.forEach((rec) => {
    rec.subjects.sort((x, y) => compareText(x.subjectCode, y.subjectCode));
    rec.pending.sort((x, y) => compareText(x.subjectCode, y.subjectCode));
    const counted = rec.subjects.filter((s) => !s.mark);
    rec.totalUnits = counted.reduce((n, s) => n + s.units, 0);
    rec.totalWeighted = counted.reduce((n, s) => n + s.weighted, 0);
    rec.incSubjects = rec.subjects.filter((s) => s.mark === "INC").length;
    rec.gwa = rec.totalUnits > 0 ? rec.totalWeighted / rec.totalUnits : null;
    // Final grade on the scale chosen in Setup and options (the GWA itself when it's the same scale)
    rec.final = rec.gwa === null ? null : toFinal(round2(rec.gwa));
    rec.failedSubjects = rec.subjects.filter((s) => s.remarks === "Failed").length;

    if (!rec.subjects.length && !rec.pending.length) rec.remarks = "No subjects";
    else if (rec.pending.length) rec.remarks = rec.left ? statusLabel(rec.student) : "Incomplete";
    else if (rec.incSubjects) rec.remarks = "Incomplete";
    else if (!counted.length) rec.remarks = "Dropped"; // every subject dropped
    else rec.remarks = finalDiffers() ? finalRemarks(rec.final) : gwaRemarks(round2(rec.gwa));
  });

  return [...byId.values()];
}

// ---------- Loading ----------
async function loadSchoolYears() {
  try {
    const snap = await getDocs(collection(db, "sections"));
    allSections = snap.docs.map((d) => d.data());
    const years = [...new Set(allSections.map((s) => s.schoolYear))].sort((a, b) => compareText(b, a));
    if (!years.length) {
      els.year.innerHTML = `<option value="">No school years yet</option>`;
      els.year.disabled = true;
      tableMessage(els.tbody, 9, `No sections exist yet. <a href="sections.html">Create sections</a>, students and grades first.`);
      return;
    }
    els.year.innerHTML = years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
    const fromUrl = new URLSearchParams(location.search).get("sy");
    els.year.value = years.includes(fromUrl) ? fromUrl : years[0];
    fillLevels(new URLSearchParams(location.search).get("level"));
    await loadYear();
  } catch (err) {
    tableMessage(els.tbody, 9, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

/** The year levels that have sections in the chosen school year. */
const levelsOfYear = (sy) => YEAR_LEVELS.filter((l) => allSections.some((s) => s.schoolYear === sy && s.yearLevel === l));

/** Fills the Year Level list for the chosen school year, keeping `keep` when it has sections. */
function fillLevels(keep = els.level.value) {
  const levels = levelsOfYear(els.year.value);
  els.level.innerHTML = levels.length
    ? levels.map((l) => `<option value="${l}">${l}</option>`).join("")
    : `<option value="">No year levels</option>`;
  els.level.value = levels.includes(keep) ? keep : levels[0] || "";
  els.level.disabled = !levels.length;
}

/**
 * One year level's data: its grades and students, and the school year's grading assignments
 * (few, and they show which subjects this level's irregular students take in another level).
 * Those other-level subjects' grades are read class by class, so their GWA is complete.
 */
async function fetchLevel(sy, level) {
  const [gSnap, sSnap, aSnap] = await Promise.all([
    getDocs(query(collection(db, "grades"), where("schoolYear", "==", sy), where("yearLevel", "==", level))),
    getDocs(query(collection(db, "students"), where("schoolYear", "==", sy), where("yearLevel", "==", level))),
    getDocs(query(collection(db, "gradingAssignments"), where("schoolYear", "==", sy))),
  ]);
  const students = new Map(sSnap.docs.map((d) => [d.id, d.data()]));
  const grades = gSnap.docs.map((d) => d.data());
  const yearAssignments = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const own = yearAssignments.filter((a) => a.yearLevel === level);
  const elsewhere = yearAssignments.filter((a) => a.yearLevel !== level && (a.studentIds || []).some((id) => students.has(id)));
  const extra = await Promise.all(
    elsewhere.map((a) => getDocs(query(collection(db, "grades"), where("assignmentId", "==", a.id))))
  );
  extra.forEach((snap) => snap.docs.forEach((d) => {
    const g = d.data();
    if (students.has(g.studentId)) grades.push(g);
  }));
  const assignments = [...own, ...elsewhere];
  // Students who had subjects this year but are now in another school year (promoted),
  // and other levels' irregular students in this level's classes
  const missing = [...new Set([...grades.map((g) => g.studentId), ...own.flatMap((a) => a.studentIds || [])])]
    .filter((id) => id && !students.has(id));
  for (let i = 0; i < missing.length; i += 30) {
    const snap = await getDocs(query(collection(db, "students"), where(documentId(), "in", missing.slice(i, i + 30))));
    snap.docs.forEach((d) => students.set(d.id, d.data()));
  }
  return { grades, students, assignments, schoolYear: sy, yearLevel: level };
}

async function loadYear() {
  const sy = els.year.value;
  const level = els.level.value;
  records = [];
  full = null;
  els.btnExport.disabled = true;
  els.btnPrintAll.disabled = true;
  els.btnEmailAll.disabled = true;
  els.tally.classList.add("d-none");
  if (!sy) return;
  const q = new URLSearchParams(location.search);
  q.set("sy", sy);
  if (level) q.set("level", level); else q.delete("level");
  history.replaceState(null, "", `?${q}`);
  fillExportMenu();
  if (!level) {
    tableMessage(els.tbody, 9, `No sections exist for ${escapeHtml(sy)} yet.`);
    return;
  }
  tableLoading(els.tbody, 9, 6);

  try {
    const data = await fetchLevel(sy, level);
    // The year or level was changed while this one was loading: that one wins
    if (els.year.value !== sy || els.level.value !== level) return;
    full = data;
    fillTerms();
    applyTerm();
  } catch (err) {
    tableMessage(els.tbody, 9, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

// ---------- Term (semester) ----------
/** "all" = whole school year, "" = assignments with no term, or a term name. */
const chosenTerm = () => (els.term ? els.term.value : "all");
/** "2026-2027", or "2026-2027, 1st Semester" when a term is chosen. */
const periodText = () => (chosenTerm() === "all" ? els.year.value : yearTermText(els.year.value, termLabel()));

/** The chosen term for titles ("" = whole school year). */
const termLabel = () => (chosenTerm() === "all" ? "" : chosenTerm() || "No term set");

function fillTerms() {
  if (!els.term) return;
  const keep = new URLSearchParams(location.search).get("term") ?? els.term.value;
  const present = new Set(full.assignments.map(termOf));
  const list = TERMS.filter((t) => present.has(t));
  if (list.length && present.has("")) list.push("");
  els.term.innerHTML = `<option value="all">Whole school year</option>` +
    list.map((t) => `<option value="${escapeHtml(t)}">${t ? escapeHtml(t) : "No term set"}</option>`).join("");
  els.term.value = list.includes(keep) ? keep : "all";
  els.term.disabled = !list.length;
}

/** A level's data cut to the chosen term ("all" = the whole school year). */
function forTerm(data, t = chosenTerm()) {
  if (t === "all") return data;
  const aById = new Map(data.assignments.map((a) => [a.id, a]));
  return {
    ...data,
    termOnly: true,
    assignments: data.assignments.filter((a) => termOf(a) === t),
    // The assignment says the term (older grades have no copy of it)
    grades: data.grades.filter((g) => termOf(aById.get(g.assignmentId) || g) === t),
  };
}

function applyTerm() {
  const t = chosenTerm();
  raw = forTerm(full, t);
  const q = new URLSearchParams(location.search);
  if (t === "all") q.delete("term"); else q.set("term", t);
  history.replaceState(null, "", `?${q}`);
  records = compute(raw);
  fillExportMenu();
  fillFilters();
  render();
}

function fillFilters() {
  fillSections();
}

function fillSections() {
  const keep = els.section.value;
  const level = els.level.value;
  const sections = new Map();
  records
    .filter((r) => r.sectionId && (!level || r.yearLevel === level))
    .forEach((r) => sections.set(r.sectionId, r.sectionName));
  const list = [...sections.entries()].sort((a, b) => compareText(a[1], b[1]));
  els.section.innerHTML = `<option value="">All sections</option>` + list.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join("");
  els.section.value = sections.has(keep) ? keep : "";
}

// ---------- Table ----------
function visibleRecords() {
  const term = normalize(els.search.value);
  const rows = records.filter(
    (r) =>
      (!els.level.value || r.yearLevel === els.level.value) &&
      (!els.section.value || r.sectionId === els.section.value) &&
      (!term || normalize(`${r.studentNumber} ${r.studentName}`).includes(term))
  );
  const byName = (a, b) => compareText(a.studentName, b.studentName);
  const sorters = {
    name: byName,
    section: (a, b) => compareText(a.sectionName, b.sectionName) || byName(a, b),
    gwa: (a, b) => compareBest(a.gwa, b.gwa) || byName(a, b), // best GWA first, on any scale
  };
  return rows.sort(sorters[els.sort.value] || byName);
}

/** GWA cell: the final grade first when it's on another scale, with the GWA beside it. */
function gwaHtml(r) {
  if (r.gwa === null) return "—";
  return finalDiffers()
    ? `<strong>${fmt2(r.final)}</strong> <span class="small text-secondary">(${fmt2(r.gwa)})</span>`
    : fmt2(r.gwa);
}

function remarksBadge(remarks) {
  const cls = remarksClass(remarks);
  return `<span class="badge ${cls}">${remarks}</span>`;
}

function render() {
  const rows = visibleRecords();
  els.count.textContent = rows.length;
  renderTally(rows);
  els.btnExport.disabled = rows.length === 0;
  els.btnPrintAll.disabled = rows.length === 0;
  els.btnEmailAll.disabled = rows.length === 0;

  if (!records.length) {
    tableMessage(els.tbody, 9, `No students are enrolled in ${escapeHtml(els.level.value)} for ${escapeHtml(els.year.value)} yet.`);
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, 9, "No students match your filters.");
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map(
      (r) => `
      <tr>
        <td class="code-cell">${escapeHtml(r.studentNumber)}</td>
        <td>${escapeHtml(r.studentName)}${statusBadge(r.student, escapeHtml)}${r.email ? ` <i class="bi bi-envelope text-secondary" title="${escapeHtml(r.email)}"></i>` : ""}</td>
        <td><span class="badge badge-count">${escapeHtml(r.sectionName || "—")}</span></td>
        <td class="num">${r.subjects.length}${r.pending.length ? `<span class="text-secondary"> / ${r.subjects.length + r.pending.length}</span>` : ""}</td>
        <td class="num">${fmtUnits(r.totalUnits)}</td>
        <td class="num">${fmt2(r.totalWeighted)}</td>
        <td class="num gwa-cell">${gwaHtml(r)}${(r.pending.length || r.incSubjects) && r.gwa !== null ? '<span class="text-secondary" title="Partial: some subjects are not graded yet">*</span>' : ""}</td>
        <td>${remarksBadge(r.remarks)}</td>
        <td class="text-end"><button class="btn btn-sm btn-outline-secondary" data-view="${r.id}"><i class="bi bi-file-text me-1"></i>View</button></td>
      </tr>`
    )
    .join("");
}

function renderTally(rows) {
  if (!rows.length) {
    els.tally.classList.add("d-none");
    return;
  }
  const count = (rem) => rows.filter((r) => r.remarks === rem).length;
  const complete = rows.filter((r) => r.remarks === "Passed" || r.remarks === "Failed");
  const avg = complete.length ? complete.reduce((n, r) => n + r.gwa, 0) / complete.length : null;
  els.tally.innerHTML = `
    <span>Students <strong>${rows.length}</strong></span>
    <span class="text-success">Passed <strong>${count("Passed")}</strong></span>
    <span style="color:var(--maroon)">Failed <strong>${count("Failed")}</strong></span>
    <span>Incomplete <strong>${count("Incomplete")}</strong></span>
    ${rows.some((r) => r.left) ? `<span>Dropped / transferred out <strong>${rows.filter((r) => r.left).length}</strong></span>` : ""}
    <span>Average GWA <strong>${avg === null ? "—" : fmt2(avg)}${avg !== null && finalDiffers() ? ` (${fmt2(toFinal(round2(avg)))})` : ""}</strong></span>`;
  els.tally.classList.remove("d-none");
}

// ---------- Student report ----------
function reportHtml(r) {
  const meta = [
    ["Student ID", r.studentNumber],
    ["Student Name", r.studentName],
    ["School Year", els.year.value],
    ...(termLabel() ? [["Term", termLabel()]] : []),
    ["Year Level", r.yearLevel || "—"],
    ["Section", r.sectionName || "—"],
  ];
  const subjectRows = r.subjects
    .map(
      (s) => `
      <tr>
        <td class="code-cell">${escapeHtml(s.subjectCode)}</td>
        <td>${escapeHtml(s.subjectName)}<div class="small text-secondary">${escapeHtml(s.teacherName || "")}</div></td>
        <td class="num">${fmtUnits(s.units)}</td>
        <td class="num">${s.mark || fmt2(s.finalGrade)}</td>
        <td>${remarksBadge(s.remarks)}</td>
      </tr>`
    )
    .join("");
  const pendingRows = r.pending
    .map(
      (s) => `
      <tr class="row-pending">
        <td class="code-cell">${escapeHtml(s.subjectCode)}</td>
        <td>${escapeHtml(s.subjectName)}<div class="small text-secondary">${escapeHtml(s.teacherName || "")}</div></td>
        <td class="num">${fmtUnits(s.units)}</td>
        <td class="num text-secondary">—</td>
        <td><span class="badge badge-none">${escapeHtml(r.pendingLabel)}</span></td>
      </tr>`
    )
    .join("");

  const noGrades = r.gwa === null ? `<p class="mb-0 text-secondary">No grades have been saved for this student yet.</p>` : "<div></div>";

  return `
    <section class="class-record">
      ${school.schoolName ? `<div class="record-letterhead">${letterheadHtml(school)}</div>` : ""}
      <div class="record-head">
        <h3 class="record-title">Report of final grades</h3>
        <p class="record-sub">School year ${escapeHtml(periodText())}</p>
        <dl class="record-meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
      </div>
      <div class="table-responsive">
        <table class="table table-stack table-registry mb-0">
          <thead><tr><th>Code</th><th>Subject</th><th class="num">Units</th><th class="num">Final Grade</th><th>Remarks</th></tr></thead>
          <tbody>${subjectRows}${pendingRows || ""}${!subjectRows && !pendingRows ? `<tr><td colspan="5" class="empty-state">No subjects assigned for this school year.</td></tr>` : ""}</tbody>
          <tfoot>
            <tr class="totals-row">
              <td colspan="2">Total</td>
              <td class="num">${fmtUnits(r.totalUnits)}</td>
              <td></td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="gwa-foot">
        ${noGrades}
        <div class="gwa-result">
          <div class="small text-secondary">${finalDiffers() ? escapeHtml(finalLabel()) : "General Weighted Average"}</div>
          <div class="gwa-value">${r.gwa === null ? "—" : fmt2(finalDiffers() ? r.final : r.gwa)}</div>
          ${finalDiffers() && r.gwa !== null ? `<div class="small text-secondary">GWA ${fmt2(r.gwa)}</div>` : ""}
          ${remarksBadge(r.remarks)}
        </div>
      </div>
      ${school.registrarName ? `<div class="report-sign">${signatureHtml(school)}</div>` : ""}
    </section>`;
}

function openReport(id) {
  openRecord = records.find((r) => r.id === id);
  if (!openRecord) return;
  els.reportTitle.textContent = `${openRecord.studentName} – final grades`;
  els.reportBody.innerHTML = reportHtml(openRecord);
  reportModal.show();
}

// ---------- Printing ----------
function printReports(list) {
  if (!list.length) return;
  const css = (p) => new URL(p, location.href).href;
  const w = window.open("", "_blank");
  if (!w) {
    toast("Allow pop-ups for this site to print reports.", "warning");
    return;
  }
  const title = list.length === 1 ? `Final grades – ${list[0].studentName}` : `Final grades – ${periodText()} (${list.length} students)`;
  w.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css">
    <link rel="stylesheet" href="${css("../css/style.css")}">
    <style>
      /* Always half of an A4 sheet, landscape: A5 landscape (210 × 148 mm), one report per page */
      @page{size:A5 landscape;margin:6mm}
      html{font-size:9.5px}
      body{background:#fff;padding:0;margin:0}
      .class-record{box-shadow:none;border:0;margin:0}
      .record-letterhead{padding:0 0 .3rem}
      .letterhead-logo{width:34px;height:34px}
      .record-head{padding:.3rem 0 .4rem}
      .record-title{font-size:1.35rem;margin:0}
      .record-sub{margin:0 0 .25rem}
      .record-meta{gap:.15rem 1.2rem}
      .table{margin:0}
      .table td,.table th{padding:.15rem .4rem}
      .table td .small{display:none} /* teacher names: keeps it on one half sheet */
      .gwa-foot{padding:.4rem 0}
      .gwa-value{font-size:1.9rem}
      .report-sign{padding:.2rem 0 0}
      .print-page{break-after:page;page-break-after:always}
      .print-page:last-child{break-after:auto;page-break-after:auto}
    </style>
    </head><body>${list.map((r) => `<div class="print-page">${reportHtml(r)}</div>`).join("")}
    <script>window.addEventListener("load",function(){setTimeout(function(){window.print();},300);});<\/script>
    </body></html>`);
  w.document.close();
}

// ---------- Email content ----------
function firstName(name) {
  return String(name || "").split(/\s+/)[0] || "";
}

function defaultMessage(r) {
  return `Good day, ${firstName(r.studentName)}.\n\nHere are your final grades for school year ${periodText()}.`;
}

function defaultSubject(r) {
  return `Final grades – ${r.studentName} – SY ${periodText()}`;
}

/** Email-safe HTML (inline styles only; email apps ignore stylesheets). */
function emailHtml(r, message) {
  const sy = escapeHtml(periodText());
  const td = "padding:8px 10px;border-bottom:1px solid #dde1e8;";
  const num = td + "text-align:right;white-space:nowrap;";
  const badge = (rem) => {
    const c = { Passed: ["#e5f0ea", "#2f6b4f"], Failed: ["#f6e6e8", "#8c2f39"], Incomplete: ["#fbf3d9", "#6e5810"], Conditional: ["#fdf0dc", "#8a5a00"] }[rem] || ["#eef0f4", "#56617a"];
    return `<span style="background:${c[0]};color:${c[1]};padding:2px 8px;border-radius:10px;font-size:12px;font-weight:bold">${rem}</span>`;
  };
  const rows = r.subjects.map((s) => `
    <tr>
      <td style="${td}font-weight:bold">${escapeHtml(s.subjectCode)}</td>
      <td style="${td}">${escapeHtml(s.subjectName)}</td>
      <td style="${num}">${fmtUnits(s.units)}</td>
      <td style="${num}">${s.mark || fmt2(s.finalGrade)}</td>
      <td style="${td}">${badge(s.remarks)}</td>
    </tr>`).join("");
  const pending = r.pending.map((s) => `
    <tr style="color:#56617a">
      <td style="${td}font-weight:bold">${escapeHtml(s.subjectCode)}</td>
      <td style="${td}">${escapeHtml(s.subjectName)}</td>
      <td style="${num}">${fmtUnits(s.units)}</td>
      <td style="${num}">—</td>
      <td style="${td}">${badge(r.pendingLabel)}</td>
    </tr>`).join("");
  const meta = [
    ["Student ID", r.studentNumber], ["Student Name", r.studentName],
    ["Year Level", r.yearLevel || "—"], ["Section", r.sectionName || "—"],
  ].map(([k, v]) => `<td style="padding:4px 16px 4px 0;font-size:13px"><div style="color:#56617a">${k}</div><div style="font-weight:bold">${escapeHtml(v)}</div></td>`).join("");

  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1f2a44;max-width:680px;line-height:1.45">
  ${message ? `<p style="white-space:pre-line;margin:0 0 18px">${escapeHtml(message)}</p>` : ""}
  <div style="background:#14203a;border-top:3px solid #c9a227;color:#ffffff;padding:14px 18px">
    ${school.schoolName ? `<div style="font-size:12px;color:#c9a227;font-weight:bold;letter-spacing:.02em;margin-bottom:2px">${escapeHtml(school.schoolName)}</div>` : ""}
    <div style="font-size:18px;font-weight:bold">Report of final grades</div>
    <div style="font-size:13px;color:#c9cfdc">School year ${sy}</div>
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin:12px 0"><tr>${meta}</tr></table>
  <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font-size:14px">
    <thead><tr style="background:#f4f5f7;color:#56617a;font-size:12px">
      <th style="${td}text-align:left">Code</th><th style="${td}text-align:left">Subject</th>
      <th style="${td}text-align:right">Units</th><th style="${td}text-align:right">Final Grade</th>
      <th style="${td}text-align:left">Remarks</th>
    </tr></thead>
    <tbody>${rows}${pending}</tbody>
    <tfoot><tr style="font-weight:bold;background:#f8f9fb">
      <td style="${td}border-top:2px solid #1f2a44" colspan="2">Total</td>
      <td style="${num}border-top:2px solid #1f2a44">${fmtUnits(r.totalUnits)}</td>
      <td style="${td}border-top:2px solid #1f2a44"></td>
      <td style="${td}border-top:2px solid #1f2a44"></td>
    </tr></tfoot>
  </table>
  ${r.gwa === null ? `<p>No grades have been saved yet.</p>` : `
  <p style="margin:16px 0 6px;font-size:22px;font-weight:bold">General Weighted Average: ${fmt2(r.gwa)}${finalDiffers() ? ` &nbsp;·&nbsp; ${escapeHtml(finalLabel())}: ${fmt2(r.final)}` : ""} &nbsp;${badge(r.remarks)}</p>`}
  <p style="font-size:12px;color:#56617a;margin-top:24px;border-top:1px solid #dde1e8;padding-top:10px">${escapeHtml(schoolLabel())}${school.address ? `<br>${escapeHtml(school.address)}` : ""}${[school.phone, school.email, school.website].filter(Boolean).length ? `<br>${escapeHtml([school.phone, school.email, school.website].filter(Boolean).join(" | "))}` : ""}<br>This report was generated by the College Grading System. Please contact the registrar about any corrections.</p>
</div>`;
}

/** Plain-text version for the "open in email app" route. */
function emailText(r, message) {
  const lines = [];
  if (message) lines.push(message, "");
  lines.push("REPORT OF FINAL GRADES", `School Year: ${periodText()}`, `Student: ${r.studentName} (${r.studentNumber})`,
    `Year Level / Section: ${r.yearLevel || "—"} / ${r.sectionName || "—"}`, "");
  r.subjects.forEach((s) =>
    lines.push(`${s.subjectCode ? `${s.subjectCode} – ` : ""}${s.subjectName}`, `   ${s.mark || fmt2(s.finalGrade)}, ${fmtUnits(s.units)} units  (${s.remarks})`));
  r.pending.forEach((s) => lines.push(`${s.subjectCode ? `${s.subjectCode} – ` : ""}${s.subjectName}`, `   ${fmtUnits(s.units)} units – ${r.left ? r.pendingLabel.toLowerCase() : "not graded yet"}`));
  lines.push("", `Total units: ${fmtUnits(r.totalUnits)}`);
  if (r.gwa !== null) lines.push(`General Weighted Average: ${fmt2(r.gwa)}`);
  if (r.gwa !== null && finalDiffers()) lines.push(`${finalLabel()}: ${fmt2(r.final)}`);
  lines.push(`Remarks: ${r.remarks}`, "", schoolLabel());
  if (school.address) lines.push(school.address);
  const contact = [school.phone, school.email, school.website].filter(Boolean).join(" | ");
  if (contact) lines.push(contact);
  return lines.join("\n");
}

async function sendViaEmailJs({ to, cc, subject, html, toName }) {
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      service_id: EMAILJS.serviceId,
      template_id: EMAILJS.templateId,
      user_id: EMAILJS.publicKey,
      template_params: { to_email: to, cc_email: cc || "", to_name: toName, from_name: schoolLabel(), subject, message_html: html },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")) || `HTTP ${res.status}`;
    throw new Error(`EmailJS refused the email: ${detail}`);
  }
}

// ---------- Email one student ----------
let emailModal, bulkModal;
let emailingRecord = null;

function openEmail(r) {
  emailingRecord = r;
  const ef = els.emailForm;
  clearErrors(ef);
  els.emailError.classList.add("d-none");
  els.emailTo.value = r.email || "";
  els.emailCc.value = "";
  els.emailSubject.value = defaultSubject(r);
  els.emailMessage.value = defaultMessage(r);
  els.emailMode.innerHTML = emailJsReady
    ? `<i class="bi bi-lightning-charge me-1"></i>Sends directly from the system.`
    : `<i class="bi bi-box-arrow-up-right me-1"></i>Opens your email app (Gmail, Outlook…) with this report filled in, ready to send.
       An administrator can turn on direct sending in School settings → Email sending.`;
  els.btnSendEmail.innerHTML = emailJsReady
    ? `<i class="bi bi-send me-1"></i>Send email`
    : `<i class="bi bi-box-arrow-up-right me-1"></i>Open in email app`;
  updateEmailPreview();
  // Open after the report dialog has fully closed (Bootstrap dialogs don't stack)
  if (els.reportModalEl.classList.contains("show")) {
    els.reportModalEl.addEventListener("hidden.bs.modal", () => emailModal.show(), { once: true });
    reportModal.hide();
  } else {
    emailModal.show();
  }
  if (!r.email) setTimeout(() => toast("This student has no email saved. Type one in, or add it on the Students page.", "info"), 300);
}

function updateEmailPreview() {
  if (emailingRecord) els.emailPreview.innerHTML = emailHtml(emailingRecord, els.emailMessage.value.trim());
}

async function submitEmail(e) {
  e.preventDefault();
  const r = emailingRecord;
  clearErrors(els.emailForm);
  els.emailError.classList.add("d-none");
  const to = els.emailTo.value.trim();
  const cc = els.emailCc.value.trim();
  const subject = els.emailSubject.value.trim();
  const message = els.emailMessage.value.trim();
  let ok = true;
  if (!isValidEmail(to)) { fieldError(els.emailTo, "Enter a valid email address."); ok = false; }
  if (cc && !isValidEmail(cc)) { fieldError(els.emailCc, "Enter a valid email address, or leave it empty."); ok = false; }
  if (!subject) { fieldError(els.emailSubject, "Enter a subject."); ok = false; }
  if (!ok) return;

  if (!emailJsReady) {
    const params = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(emailText(r, message).replace(/\n/g, "\r\n"))}`];
    if (cc) params.unshift(`cc=${encodeURIComponent(cc)}`);
    const a = document.createElement("a");
    a.href = `mailto:${encodeURIComponent(to)}?${params.join("&")}`;
    a.click();
    emailModal.hide();
    toast("Your email app should open with the report. Review it and click Send there.", "info");
    return;
  }

  setBusy(els.btnSendEmail, true, "Sending…");
  try {
    await sendViaEmailJs({ to, cc, subject, html: emailHtml(r, message), toName: r.studentName });
    emailModal.hide();
    toast(`Final grades emailed to ${to}.`);
  } catch (err) {
    els.emailError.textContent = errorMessage(err);
    els.emailError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSendEmail, false);
  }
}

// ---------- Email all listed students ----------
let bulkRunning = false;

function openBulk() {
  const rows = visibleRecords().filter((r) => r.subjects.length || r.pending.length);
  const withEmail = rows.filter((r) => isValidEmail(r.email));
  const without = rows.filter((r) => !isValidEmail(r.email));
  els.bulkLog.innerHTML = "";
  els.bulkProgressWrap.classList.add("d-none");
  els.bulkProgress.style.width = "0%";
  clearErrors(els.bulkModalEl);
  els.bulkSubject.value = "Final grades – {name} – SY {sy}";
  els.bulkMessage.value = `Good day.\n\nHere are your final grades for school year {sy}.`;
  els.bulkCc.value = "";

  if (!emailJsReady) {
    els.bulkSummary.innerHTML = `Sending to many students at once needs EmailJS. An administrator can set it up in <strong>School settings → Email sending</strong> (free, about 10 minutes; steps are in the README).
      Until then, use <strong>View → Email report</strong> to send one student at a time from your email app.`;
    els.bulkMissing.innerHTML = "";
    els.btnBulkSend.disabled = true;
  } else {
    els.bulkSummary.innerHTML = `<strong>${withEmail.length}</strong> of ${rows.length} listed student${rows.length === 1 ? "" : "s"} have an email address and will each get their own report.`;
    els.bulkMissing.innerHTML = without.length
      ? `<span style="color:#6e5810">No email saved for: ${without.slice(0, 12).map((r) => escapeHtml(r.studentName)).join(", ")}${without.length > 12 ? ` and ${without.length - 12} more` : ""}. Add emails on the Students page to include them.</span>`
      : "";
    els.btnBulkSend.disabled = withEmail.length === 0;
  }
  els.btnBulkSend.innerHTML = `<i class="bi bi-send me-1"></i>Send ${withEmail.length && emailJsReady ? withEmail.length : ""} email${withEmail.length === 1 ? "" : "s"}`;
  els.btnBulkSend.dataset.count = withEmail.length;
  bulkModal.show();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendBulk() {
  const recipients = visibleRecords().filter((r) => (r.subjects.length || r.pending.length) && isValidEmail(r.email));
  clearErrors(els.bulkModalEl);
  const cc = els.bulkCc.value.trim();
  const subjectT = els.bulkSubject.value.trim();
  if (cc && !isValidEmail(cc)) { fieldError(els.bulkCc, "Enter a valid email address, or leave it empty."); return; }
  if (!subjectT) { fieldError(els.bulkSubject, "Enter a subject."); return; }
  bulkRunning = true;
  els.btnBulkSend.disabled = true;
  els.btnBulkClose.disabled = true;
  els.bulkProgressWrap.classList.remove("d-none");
  const fill = (t, r) => t.replace(/\{name\}/g, r.studentName).replace(/\{sy\}/g, periodText());
  let sent = 0;
  const failed = [];

  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    els.bulkLog.textContent = `Sending ${i + 1} of ${recipients.length}: ${r.studentName}…`;
    try {
      await sendViaEmailJs({
        to: r.email, cc, toName: r.studentName,
        subject: fill(subjectT, r),
        html: emailHtml(r, fill(els.bulkMessage.value.trim(), r)),
      });
      sent++;
    } catch (err) {
      failed.push(`${r.studentName} (${r.email}): ${errorMessage(err)}`);
    }
    els.bulkProgress.style.width = `${Math.round(((i + 1) / recipients.length) * 100)}%`;
    if (i < recipients.length - 1) await sleep(1100); // stay under EmailJS's rate limit
  }

  bulkRunning = false;
  els.btnBulkClose.disabled = false;
  els.bulkLog.innerHTML = `<div class="text-success fw-semibold">${sent} email${sent === 1 ? "" : "s"} sent.</div>` +
    (failed.length ? `<div class="mt-2" style="color:var(--maroon)">${failed.length} not sent:<br>${failed.map(escapeHtml).join("<br>")}</div>` : "");
  toast(failed.length ? `${sent} sent, ${failed.length} failed. See the list in the dialog.` : `${sent} final grade report${sent === 1 ? "" : "s"} emailed.`, failed.length ? "warning" : "success");
}

// ---------- Export ----------
async function exportExcel() {
  const rows = visibleRecords();
  if (!rows.length) return;
  setBusy(els.btnExport, true, "Preparing…");
  try {
    const XLSX = await loadSheetJs();
    const summary = [
      ["Student ID", "Student Name", "Year Level", "Section", "Subjects Graded", "Subjects Not Graded", "Total Units", "Σ Grade × Units", "GWA", ...(finalDiffers() ? [finalLabel()] : []), "Remarks"],
      ...rows.map((r) => [
        r.studentNumber, r.studentName, r.yearLevel, r.sectionName,
        r.subjects.length, r.pending.length, round2(r.totalUnits), round2(r.totalWeighted),
        r.gwa === null ? "" : round2(r.gwa), ...(finalDiffers() ? [r.final === null ? "" : r.final] : []), r.remarks,
      ]),
    ];
    const details = [
      ["Student ID", "Student Name", "Section", "Subject Code", "Subject Name", "Teacher", "Units", "Final Grade", "Grade × Units", "Remarks"],
      ...rows.flatMap((r) => [
        ...r.subjects.map((s) => [r.studentNumber, r.studentName, r.sectionName, s.subjectCode, s.subjectName, s.teacherName, s.units, s.mark || s.finalGrade, s.mark ? "" : round2(s.weighted), s.remarks]),
        ...r.pending.map((s) => [r.studentNumber, r.studentName, r.sectionName, s.subjectCode, s.subjectName, s.teacherName, s.units, "", "", r.pendingLabel]),
      ]),
    ];
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet(summary);
    ws1["!cols"] = [14, 28, 10, 12, 10, 12, 10, 14, 8, 12].map((w) => ({ wch: w }));
    const ws2 = XLSX.utils.aoa_to_sheet(details);
    ws2["!cols"] = [14, 28, 12, 12, 30, 24, 7, 11, 13, 11].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws1, "Final Grades");
    XLSX.utils.book_append_sheet(wb, ws2, "Subject Details");

    const parts = [els.year.value, termLabel(), els.level.value, els.section.selectedOptions[0]?.value ? els.section.selectedOptions[0].text : ""].filter(Boolean);
    XLSX.writeFile(wb, `final-grades-${parts.join("-").replace(/\s+/g, "")}.xlsx`);
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnExport, false);
  }
}

// ---------- Grade sheets by year level (school's class grade sheet layout) ----------
/** The year levels with sections this school year, and how many sections each has. */
function levelsWithSections() {
  const sy = els.year.value;
  return levelsOfYear(sy).map((yearLevel) => ({
    yearLevel,
    sections: allSections.filter((s) => s.schoolYear === sy && s.yearLevel === yearLevel).length,
  }));
}

function fillExportMenu() {
  const levels = levelsWithSections();
  const levelItems = levels.map((l) => `
    <li><button type="button" class="dropdown-item d-flex justify-content-between gap-3" data-export="${escapeHtml(l.yearLevel)}">
      <span><i class="bi bi-file-earmark-spreadsheet me-2"></i>${escapeHtml(l.yearLevel)}</span>
      <span class="text-secondary small">${l.sections} section${l.sections === 1 ? "" : "s"}</span>
    </button></li>`).join("");
  els.exportMenu.innerHTML = `
    <li><h6 class="dropdown-header">Grade sheets by year level</h6></li>
    ${levelItems || '<li><span class="dropdown-item-text small text-secondary">No grading assignments yet</span></li>'}
    ${levels.length > 1 ? `<li><button type="button" class="dropdown-item" data-export="all-levels"><i class="bi bi-files me-2"></i>All year levels (one file each)</button></li>` : ""}
    <li><hr class="dropdown-divider"></li>
    <li><button type="button" class="dropdown-item" data-export="list"><i class="bi bi-list-columns-reverse me-2"></i>Current list only (summary)</button></li>`;
}

async function writeYearLevel(ExcelJS, yearLevel) {
  // The level on screen is loaded already; another level is read now, one level at a time
  const shown = full && full.yearLevel === yearLevel && full.schoolYear === els.year.value;
  const data = shown ? raw : forTerm(await fetchLevel(els.year.value, yearLevel));
  const { workbook, sections } = buildStyledYearLevelWorkbook(ExcelJS, {
    schoolYear: els.year.value,
    term: termLabel(),
    yearLevel,
    assignments: data.assignments,
    grades: data.grades,
    students: data.students,
    records: shown ? records : compute(data),
    school,
  });
  downloadBuffer(await workbook.xlsx.writeBuffer(), yearLevelFileName(els.year.value, yearLevel, termLabel()));
  return sections;
}

async function exportYearLevel(yearLevel) {
  setBusy(els.btnExport, true, "Preparing…");
  try {
    const ExcelJS = await loadExcelJs();
    const sections = await writeYearLevel(ExcelJS, yearLevel);
    toast(`${yearLevel} grade sheets downloaded: ${sections} section${sections === 1 ? "" : "s"}, one sheet each, plus a summary.`);
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnExport, false);
  }
}

async function exportAllLevels() {
  setBusy(els.btnExport, true, "Preparing…");
  try {
    const ExcelJS = await loadExcelJs();
    const levels = levelsWithSections();
    for (const l of levels) {
      await writeYearLevel(ExcelJS, l.yearLevel);
      await new Promise((r) => setTimeout(r, 700)); // browsers block downloads fired all at once
    }
    toast(`${levels.length} files downloaded, one per year level. If some are missing, allow multiple downloads for this site.`);
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnExport, false);
  }
}

// ---------- Wire up ----------
function init() {
  const hint = document.getElementById("gwaHint");
  if (hint) hint.textContent = finalDiffers() ? `${finalHint()} A final grade of 3.00 or better is Passed.` : gwaHint();
  const th = document.getElementById("gwaHead");
  if (th && finalDiffers()) th.textContent = "Final grade (GWA)";
  reportModal = new bootstrap.Modal(els.reportModalEl);
  els.year.addEventListener("change", () => { fillLevels(); loadYear(); });
  els.term?.addEventListener("change", () => full && applyTerm());
  els.level.addEventListener("change", () => { els.section.value = ""; loadYear(); });
  els.section.addEventListener("change", render);
  els.sort.addEventListener("change", render);
  els.search.addEventListener("input", render);
  els.exportMenu.addEventListener("click", (e) => {
    const item = e.target.closest("[data-export]");
    if (!item) return;
    const what = item.dataset.export;
    if (what === "list") exportExcel();
    else if (what === "all-levels") exportAllLevels();
    else exportYearLevel(what);
  });
  els.btnPrint.addEventListener("click", () => openRecord && printReports([openRecord]));
  els.btnPrintAll.addEventListener("click", () => printReports(visibleRecords()));
  els.btnEmail.addEventListener("click", () => openRecord && openEmail(openRecord));
  els.btnEmailAll.addEventListener("click", openBulk);
  emailModal = new bootstrap.Modal(els.emailModalEl);
  bulkModal = new bootstrap.Modal(els.bulkModalEl);
  els.emailForm.addEventListener("submit", submitEmail);
  els.emailMessage.addEventListener("input", updateEmailPreview);
  els.btnBulkSend.addEventListener("click", sendBulk);
  // Don't let the dialog close in the middle of a bulk send
  els.bulkModalEl.addEventListener("hide.bs.modal", (e) => { if (bulkRunning) e.preventDefault(); });
  els.tbody.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-view]");
    if (btn) openReport(btn.dataset.view);
  });
  getSchool().then((s) => (school = s));
  loadEmailSettings();
  loadSchoolYears();
}

initLayout("final-grades").then((user) => {
  if (user) init(user);
  else tableMessage(els.tbody, 9, "Connect Firebase and sign in to load final grades.");
});
