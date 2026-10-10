// ==========================================================
// subjects-import.js — Import subjects (plus their sections and
// teachers) from Excel.
//
// Understands two layouts:
//  A) Class grade sheet (e.g. "BSC 3A"): subjects run across the top in
//     blocks. Each block has a subject column written as "CODE - Name"
//     followed by a UNIT column; the instructor sits above the block and
//     the section is named in "INSTRUCTOR - BSC 3A" (or the sheet name).
//  B) Simple list: Subject Code | Subject Name | Units
//     (optional Instructor/Teacher and Section columns).
//
// From a class grade sheet it can also add the section, the teachers
// (instructors) and the students. The user only enters the School Year
// and Year Level; Student IDs are generated when the file has none.
// It then creates the grading assignments: each subject with its
// instructor, the section, and the students who take that subject.
// ==========================================================

import { db, collection, doc, getDocs, serverTimestamp } from "./firebase-config.js";
import { termOf } from "./terms.js";
import {
  toast, escapeHtml, setBusy, errorMessage, commitOperations, loadSheetJs, compareText,
  isValidSchoolYear, clearErrors, fieldError, YEAR_LEVELS, teacherCore, nextStudentNumbers, nextTeacherIds,
} from "./app.js";

const MAX_SUBJECTS = 2000;

// ---------- Pure parsing helpers (no DOM, easy to test) ----------
const text = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const key = (v) => text(v).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * How a subject is told apart: its code, or its name when there is no code
 * (subject codes are optional; subjects without one are matched by name).
 */
export function subjectKeyOf(code, name) {
  const c = String(code ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  return c || `~${String(name ?? "").trim().replace(/\s+/g, " ").toUpperCase()}`;
}

/** What to show for a subject key: the code, or the name for subjects without a code. */
export function subjectLabel(key) {
  return String(key || "").startsWith("~") ? String(key).slice(1) : String(key || "");
}

/** "CLJ 2 - Human Rights Education" → { code: "CLJ 2", name: "Human Rights Education" } */
export function splitSubject(value) {
  const t = text(value);
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(t);
  if (!m) return null;
  return { code: m[1].trim().toUpperCase(), name: m[2].trim() };
}

/** A cell starting with "IRREG", "Irreg.", "IRREGULAR" or "Iregular" (any case) → the student doesn't take that subject */
export function isIrregTag(value) {
  return /^[^a-z0-9]*irr?eg(ular)?\b/i.test(text(value));
}

/** "1", "1st", "1st Year", "First Year", "I", "Year 1" → "1st Year" (or "" if unclear) */
export function normalizeYearLevel(value) {
  const v = text(value).toLowerCase();
  if (!v) return "";
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
  const digits = v.match(/\d+/);
  const n = digits ? Number(digits[0]) : words[v.replace(/year|yr|level|\./g, " ").trim().split(/\s+/)[0]] || 0;
  return YEAR_LEVELS[n - 1] || ""; // 6th, 10th, 21st… are not valid year levels
}

/** "batong bakal" → "Batong Bakal" (only when typed all in lowercase) */
function tidyName(name) {
  const t = text(name);
  return t && t === t.toLowerCase() ? t.replace(/(^|[\s\-'(])([a-z])/g, (m, p, c) => p + c.toUpperCase()) : t;
}

function toUnits(v) {
  if (v === null || v === undefined || text(v) === "") return { error: "Units are empty" };
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return { error: `Units "${text(v)}" isn't a number` };
  if (n <= 0) return { error: "Units must be greater than 0" };
  return { value: Math.round(n * 100) / 100 };
}

/** "BSC 3A" → "3rd Year" (first digit 1–5 in the name), or "" if unclear */
export function detectYearLevel(sectionName) {
  const m = /([1-5])/.exec(String(sectionName || ""));
  return m ? YEAR_LEVELS[Number(m[1]) - 1] : "";
}

const UNIT_HEADERS = ["unit", "units", "creditunit", "creditunits", "credits", "noofunits"];
const CODE_HEADERS = ["subjectcode", "code", "coursecode", "subjcode"];
const NAME_HEADERS = ["subjectname", "description", "descriptivetitle", "subjecttitle", "title", "coursename", "coursetitle"];
const SUBJECT_HEADERS = ["subject", "course", "subjects"];
const TEACHER_HEADERS = ["instructor", "teacher", "faculty", "professor", "instructorname", "teachername"];
const SECTION_HEADERS = ["section", "sectionname", "class", "block"];

// ---------- Simple template (one row per subject per student) ----------
//   Proctor | <name>
//   section | year | student no | student name | subject code | subject | unit
// Blank section/year/student cells mean "same as the row above".
// A blank or IRREG subject/unit means the student doesn't take it (irregular).
const SIMPLE = {
  section: ["section", "sectionname", "block", "class"],
  year: ["year", "yearlevel", "yrlevel", "level", "yr"],
  studentNo: ["studentno", "studentnumber", "studentid", "idno", "idnumber", "srcode", "lrn"],
  studentName: ["studentname", "nameofstudent", "fullname", "name", "studentsname"],
  code: ["subjectcode", "code", "coursecode", "subjcode"],
  subject: ["subject", "subjectname", "description", "descriptivetitle", "subjecttitle", "course"],
  unit: ["unit", "units", "creditunit", "creditunits", "credits"],
  proctor: ["proctor", "instructor", "teacher", "faculty", "adviser", "advisor"],
};

export function parseSimpleSheet(rows, sheetName) {
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = (rows[h] || []).map(key);
    const idx = {};
    for (const [field, names] of Object.entries(SIMPLE)) idx[field] = header.findIndex((k) => names.includes(k));
    // Needs a student name, a unit, and a subject (code or name), all in one header row
    if (idx.studentName < 0 || idx.unit < 0 || (idx.code < 0 && idx.subject < 0)) continue;
    // A plain "Name" column is the student only when student details are there too
    if (header[idx.studentName] === "name" && idx.section < 0 && idx.year < 0 && idx.studentNo < 0) continue;
    // "subject" and "subject name" columns must not be the student name column
    if (idx.subject === idx.studentName) idx.subject = -1;

    // Proctor written above the header: "Proctor | NAME" or "Proctor: NAME"
    let sheetProctor = "";
    for (let r = 0; r < h && !sheetProctor; r++) {
      const row = rows[r] || [];
      for (let c = 0; c < row.length; c++) {
        const m = /^proctor\s*[:\-–]?\s*(.*)$/i.exec(text(row[c]));
        if (!m) continue;
        sheetProctor = m[1] || text(row.slice(c + 1).find((v) => text(v) !== "") ?? "");
        break;
      }
    }
    sheetProctor = tidyName(sheetProctor);
    const yearValues = {};   // section → { raw year text → count }
    const numberOwners = {}; // student no → Set of student name cores

    const subjects = new Map();  // section|code → subject item
    const students = new Map();  // section|name core → student
    const carry = { section: "", year: "", no: "", name: "" };
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      if (row.every((v) => text(v) === "")) continue;
      const cell = (i) => (i >= 0 ? text(row[i]) : "");
      // Carry values down from the row above when blank
      if (cell(idx.section)) carry.section = cell(idx.section).toUpperCase();
      if (cell(idx.year)) carry.year = cell(idx.year);
      if (cell(idx.studentName)) { carry.name = cell(idx.studentName); carry.no = cell(idx.studentNo); }
      else if (cell(idx.studentNo)) carry.no = cell(idx.studentNo);
      if (!carry.name || NOT_A_STUDENT.test(carry.name)) continue;

      const section = (carry.section || text(sheetName).toUpperCase()).replace(/\s+/g, " ");
      const yearLevel = normalizeYearLevel(carry.year);
      const proctor = tidyName(cell(idx.proctor)) || sheetProctor;
      const sKey = `${section}|${studentCore(carry.name)}`;
      if (cell(idx.studentName)) {
        if (!yearValues[section]) yearValues[section] = {};
        yearValues[section][carry.year] = (yearValues[section][carry.year] || 0) + 1;
        if (carry.no) {
          if (!numberOwners[carry.no]) numberOwners[carry.no] = new Set();
          numberOwners[carry.no].add(studentCore(carry.name));
        }
      }
      if (!students.has(sKey)) {
        students.set(sKey, { name: carry.name, core: studentCore(carry.name), studentId: carry.no, section, yearLevel, subjects: [], irregular: [], sheet: sheetName, row: r + 1, errors: [] });
      }
      const st = students.get(sKey);

      // Subject: code column, or "CODE - Name" in the subject column
      const rawCode = cell(idx.code), rawSubject = cell(idx.subject), rawUnit = cell(idx.unit);
      let code = rawCode.toUpperCase(), name = rawSubject;
      if (!code && rawSubject) {
        const split = splitSubject(rawSubject);
        if (split) { code = split.code; name = split.name; }
      } else if (code && rawSubject) {
        const split = splitSubject(rawSubject);
        if (split && split.code === code) name = split.name; // "GE 1 - Understanding the Self" with code GE 1
      }
      const tagged = [rawCode, rawSubject, rawUnit].some(isIrregTag);
      const blank = (!code && !rawSubject) || rawUnit === "";
      if (tagged || blank) {
        // Irregular: the student doesn't take this subject
        const label = code && !isIrregTag(rawCode) ? code : (rawSubject && !isIrregTag(rawSubject) ? rawSubject : "IRREG");
        if (!st.irregular.includes(label)) st.irregular.push(label);
        continue;
      }
      const units = toUnits(rawUnit);
      const key = subjectKeyOf(code, name);
      const sk = `${section}|${key}`;
      if (!subjects.has(sk)) {
        const errors = [];
        if (!name) errors.push(`Subject ${code} has no name`);
        if (units.error) errors.push(units.error);
        subjects.set(sk, { code, name, units: units.value ?? null, instructor: proctor, section, yearLevel, sheet: sheetName, row: r + 1, errors });
      } else {
        const prev = subjects.get(sk);
        if (!prev.errors.length && units.value !== undefined && prev.units !== units.value) {
          prev.errors.push(`Different units for ${code || name} (${prev.units} on row ${prev.row}, ${units.value} on row ${r + 1})`);
        }
        if (!prev.instructor && proctor) prev.instructor = proctor;
      }
      if ((code || name) && !st.subjects.includes(key)) st.subjects.push(key);
    }
    // ---- Fix-ups, each explained in a warning ----
    const warnings = [];
    const sectionLevel = {};
    for (const [section, counts] of Object.entries(yearValues)) {
      const valid = {};
      const invalid = [];
      for (const [raw, n] of Object.entries(counts)) {
        const lvl = normalizeYearLevel(raw);
        if (lvl) valid[lvl] = (valid[lvl] || 0) + n;
        else if (raw) invalid.push(raw);
      }
      const ranked = Object.entries(valid).sort((a, b) => b[1] - a[1]);
      sectionLevel[section] = ranked[0]?.[0] || "";
      const distinct = Object.keys(counts).filter(Boolean);
      if (invalid.length || ranked.length > 1) {
        const shown = distinct.length > 4 ? `${distinct.slice(0, 3).join(", ")} … ${distinct[distinct.length - 1]}` : distinct.join(", ");
        warnings.push(
          `${section}: the year column has different values (${shown})${invalid.length ? `, and ${invalid.length} aren't valid year levels (only 1st to 5th)` : ""}. ` +
          (sectionLevel[section]
            ? `The whole section is set to ${sectionLevel[section]}; change it below if needed. In Excel, copy the cell instead of dragging, or hold Ctrl while dragging, so it doesn't count up.`
            : `Choose the year level below.`)
        );
      }
    }
    const shared = Object.entries(numberOwners).filter(([, owners]) => owners.size > 1);
    if (shared.length) {
      const firstOwner = {};
      students.forEach((st) => {
        if (!st.studentId || !numberOwners[st.studentId] || numberOwners[st.studentId].size < 2) return;
        if (!firstOwner[st.studentId]) { firstOwner[st.studentId] = st.name; return; } // first one keeps it
        st.studentId = "";
        st.sharedNo = true;
      });
      warnings.push(
        `Student no ${shared.map(([no, o]) => `"${no}" is written for ${o.size} different students`).join("; ")}. ` +
        `${shared.length === 1 ? `${firstOwner[shared[0][0]]} keeps it; the others` : "The first student keeps each number; the others"} ` +
        `get the next numbers after the last student no in the system.`
      );
    }
    const subjectsOut = [...subjects.values()].map((it) => ({ ...it, yearLevel: sectionLevel[it.section] || it.yearLevel }));
    const studentsOut = [...students.values()].map((st) => ({ ...st, yearLevel: sectionLevel[st.section] || st.yearLevel }));
    return { subjects: subjectsOut, students: studentsOut, warnings };
  }
  return null;
}

/** Reads one sheet (array of rows) and returns the subjects found, each with its instructor and section. */
export function subjectsFromRows(rows, sheetName) {
  const simple = parseSimpleSheet(rows, sheetName);
  if (simple) return simple.subjects;
  const found = [];
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = (rows[h] || []).map(key);
    const unitCols = header.map((k, i) => (UNIT_HEADERS.includes(k) ? i : -1)).filter((i) => i >= 0);
    if (!unitCols.length) continue;

    const codeIdx = header.findIndex((k) => CODE_HEADERS.includes(k));
    const nameIdx = header.findIndex((k) => NAME_HEADERS.includes(k));
    const plainNameIdx = header.indexOf("name");
    const subjectIdx = header.findIndex((k) => SUBJECT_HEADERS.includes(k));
    const teacherIdx = header.findIndex((k) => TEACHER_HEADERS.includes(k));
    const sectionIdx = header.findIndex((k) => SECTION_HEADERS.includes(k));

    // ----- Layout B: simple list -----
    if (unitCols.length === 1 && (codeIdx >= 0 || subjectIdx >= 0)) {
      const u = unitCols[0];
      const nIdx = nameIdx >= 0 ? nameIdx : plainNameIdx;
      for (let r = h + 1; r < rows.length; r++) {
        const row = rows[r] || [];
        if (row.every((c) => text(c) === "")) continue;
        let code = "", name = "";
        if (codeIdx >= 0) {
          code = text(row[codeIdx]).toUpperCase();
          name = nIdx >= 0 ? text(row[nIdx]) : "";
        }
        if ((!code || !name) && subjectIdx >= 0) {
          const split = splitSubject(row[subjectIdx]);
          if (split) { code = code || split.code; name = name || split.name; }
          else if (!name) name = text(row[subjectIdx]);
        }
        if (!code && !name && text(row[u]) === "") continue;
        const units = toUnits(row[u]);
        const errors = [];
        if (!name && !code) errors.push("Subject name is empty");
        if (!name && code) name = code; // a code alone: use it as the name too
        if (units.error) errors.push(units.error);
        found.push({
          code, name, units: units.value ?? null,
          instructor: teacherIdx >= 0 ? text(row[teacherIdx]) : "",
          section: sectionIdx >= 0 ? text(row[sectionIdx]).toUpperCase() : "",
          sheet: sheetName, row: r + 1, errors,
        });
      }
      return found;
    }

    // ----- Layout A: class grade sheet (blocks across the top) -----
    // Section: "INSTRUCTOR - BSC 3A" in the row above the header, else the sheet name
    let section = "";
    for (const cell of (h > 0 ? rows[h - 1] : []) || []) {
      const m = /^instructors?\s*[-–:]\s*(.+)$/i.exec(text(cell));
      if (m) { section = m[1].trim().toUpperCase(); break; }
    }
    if (!section) section = text(sheetName).toUpperCase();

    for (const u of unitCols) {
      const subjCol = u - 1;
      if (subjCol < 0) continue;
      let hit = null;
      for (let r = h + 1; r < rows.length; r++) {
        const v = text((rows[r] || [])[subjCol]);
        if (v && !isIrregTag(v)) { hit = { r, v }; break; }
      }
      if (!hit) continue;
      const split = splitSubject(hit.v);
      const units = toUnits((rows[hit.r] || [])[u]);
      const instructor = h > 0 ? text((rows[h - 1] || [])[subjCol]) : "";
      const errors = [];
      if (units.error) errors.push(units.error);
      found.push({
        code: split ? split.code : "", // no "CODE - " part: the subject has no code
        name: split ? split.name : hit.v,
        units: units.value ?? null,
        instructor: /^instructors?\b/i.test(instructor) ? "" : instructor,
        section,
        sheet: sheetName,
        row: hit.r + 1,
        errors,
      });
    }
    if (found.length) return found;
  }
  return found;
}

const NAME_HEADERS_STUDENT = ["name", "studentname", "fullname", "nameofstudent", "studentsname", "names"];
const ID_HEADERS_STUDENT = ["studentid", "studentno", "studentnumber", "idnumber", "idno", "lrn", "srcode"];
const NOT_A_STUDENT = /^(sample|total|totals|average|prepared|noted|checked|approved|certified|submitted|legend|note)\b/i;

/** "Alcovera, John Mark R." → "alcovera john mark r" (used to spot the same student) */
export function studentCore(name) {
  return text(name).toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

/** Students listed in a class grade sheet, with the subjects each one has in the file. */
export function studentsFromRows(rows, sheetName) {
  const simple = parseSimpleSheet(rows, sheetName);
  if (simple) return simple.students;
  for (let h = 0; h < Math.min(rows.length, 15); h++) {
    const header = (rows[h] || []).map(key);
    const unitCols = header.map((k, i) => (UNIT_HEADERS.includes(k) ? i : -1)).filter((i) => i >= 0);
    if (!unitCols.length) continue;
    const isList = unitCols.length === 1 && (header.some((k) => CODE_HEADERS.includes(k)) || header.some((k) => SUBJECT_HEADERS.includes(k)));
    if (isList) return [];
    const nameIdx = header.findIndex((k) => NAME_HEADERS_STUDENT.includes(k));
    if (nameIdx < 0) return [];
    const idIdx = header.findIndex((k) => ID_HEADERS_STUDENT.includes(k));

    let section = "";
    for (const cell of (h > 0 ? rows[h - 1] : []) || []) {
      const m = /^instructors?\s*[-–:]\s*(.+)$/i.exec(text(cell));
      if (m) { section = m[1].trim().toUpperCase(); break; }
    }
    if (!section) section = text(sheetName).toUpperCase();

    // Subject key for each block (from the first row that names it): code, or name without a code
    const blockCode = {};
    unitCols.forEach((u) => {
      for (let r = h + 1; r < rows.length; r++) {
        const v = text((rows[r] || [])[u - 1]);
        if (!v || isIrregTag(v)) continue;
        const split = splitSubject(v);
        blockCode[u] = split ? subjectKeyOf(split.code, split.name) : subjectKeyOf("", v);
        break;
      }
    });

    const students = [];
    for (let r = h + 1; r < rows.length; r++) {
      const row = rows[r] || [];
      const name = text(row[nameIdx]);
      if (!name || NOT_A_STUDENT.test(name) || !/[a-z]/i.test(name)) continue;
      // A student takes a subject when its block has a subject or unit filled in.
      // Blank subject and unit, or an IRREG tag anywhere in the block, means they don't.
      const subjects = [];
      const irregular = [];
      unitCols.forEach((u) => {
        const own = splitSubject(row[u - 1]);
        const code = (own && own.code) || blockCode[u];
        if (!code) return;
        const block = [row[u - 1], row[u], row[u + 1], row[u + 3]]; // subject, unit, final grade, remarks
        if (block.some(isIrregTag)) { irregular.push(code); return; }
        if (text(row[u - 1]) === "" && text(row[u]) === "") return;
        subjects.push(code);
      });
      students.push({
        name,
        core: studentCore(name),
        studentId: idIdx >= 0 ? text(row[idIdx]) : "",
        section,
        subjects,
        irregular,
        sheet: sheetName,
        row: r + 1,
        errors: [],
      });
    }
    return students;
  }
  return [];
}

/** Flags a student listed twice in the file (the first listing is kept). */
export function mergeStudents(list) {
  const seen = new Map();
  return list.map((s) => {
    const prev = seen.get(s.core);
    if (prev) return { ...s, errors: [`Listed twice (also ${prev.section}, row ${prev.row}); the first is used`] };
    seen.set(s.core, s);
    return s;
  });
}

/** Next student numbers after the last one in the system (see nextStudentNumbers in app.js). */
export function nextStudentIds(existingIds, schoolYear, count, avoid = []) {
  return nextStudentNumbers(existingIds, count, schoolYear, avoid);
}

/** Combines all sheets, keeping the first copy of each subject (code, or name) and flagging conflicts. */
export function mergeSubjects(items) {
  const byCode = new Map();
  const out = [];
  for (const it of items) {
    it.skey = it.skey || subjectKeyOf(it.code, it.name);
    if (it.errors.length) { out.push(it); continue; }
    const prev = byCode.get(it.skey);
    if (!prev) {
      byCode.set(it.skey, it);
      it.sheets = [it.sheet];
      out.push(it);
    } else if (prev.name === it.name && prev.units === it.units) {
      if (!prev.sheets.includes(it.sheet)) prev.sheets.push(it.sheet);
      if (!prev.instructor && it.instructor) prev.instructor = it.instructor;
    } else {
      it.errors.push(`Same ${it.code ? "code" : "subject"} as ${prev.sheet} but different ${prev.units !== it.units ? `units (${prev.units} vs ${it.units})` : "name"}; the first one is used`);
      out.push(it);
    }
  }
  return out;
}

/** Unique sections named in the file, with a suggested year level. */
export function collectSections(items) {
  const map = new Map();
  items.forEach((it) => {
    if (!it.section) return;
    if (!map.has(it.section)) map.set(it.section, { name: it.section, detected: it.yearLevel || detectYearLevel(it.section), fromFile: Boolean(it.yearLevel) });
  });
  return [...map.values()].sort((a, b) => compareText(a.name, b.name));
}

/** Unique instructors (matched by name without ranks/credentials) and the subjects they teach. */
export function collectTeachers(items) {
  const map = new Map();
  items.forEach((it) => {
    if (!it.instructor) return;
    const core = teacherCore(it.instructor);
    if (!core) return;
    if (!map.has(core)) map.set(core, { name: it.instructor, core, subjects: [] });
    const t = map.get(core);
    const shown = it.code || it.name;
    const label = it.section ? `${shown} (${it.section})` : shown;
    if (shown && !t.subjects.includes(label)) t.subjects.push(label);
  });
  return [...map.values()].sort((a, b) => compareText(a.core, b.core));
}

/** Next free IDs in the T001 style, after the highest existing one. */
// The next teacher IDs: nextTeacherIds in app.js (also used by the Teachers page)
export { nextTeacherIds };

// ---------- UI ----------
const els = {
  btnOpen: document.getElementById("btnSubjImportOpen"),
  modalEl: document.getElementById("subjImportModal"),
  file: document.getElementById("subjImportFile"),
  btnTemplate: document.getElementById("btnSubjTemplate"),
  extrasStep: document.getElementById("subjExtrasStep"),
  existingNum: document.getElementById("subjExistingNum"),
  makeTeachers: document.getElementById("subjMakeTeachers"),
  makeSections: document.getElementById("subjMakeSections"),
  makeStudents: document.getElementById("subjMakeStudents"),
  makeAssignments: document.getElementById("subjMakeAssignments"),
  assignBlock: document.getElementById("subjAssignBlock"),
  assignBody: document.getElementById("subjAssignBody"),
  studentsBlock: document.getElementById("subjStudentsBlock"),
  studentsBody: document.getElementById("subjStudentsBody"),
  sectionInputs: document.getElementById("subjSectionInputs"),
  schoolYear: document.getElementById("subjSchoolYear"),
  term: document.getElementById("subjTerm"),
  schoolYearList: document.getElementById("subjSchoolYearList"),
  yearLevel: document.getElementById("subjYearLevel"),
  preview: document.getElementById("subjImportPreview"),
  summary: document.getElementById("subjImportSummary"),
  source: document.getElementById("subjImportSource"),
  body: document.getElementById("subjImportBody"),
  sectionsBlock: document.getElementById("subjSectionsBlock"),
  sectionsBody: document.getElementById("subjSectionsBody"),
  teachersBlock: document.getElementById("subjTeachersBlock"),
  teachersBody: document.getElementById("subjTeachersBody"),
  note: document.getElementById("subjImportNote"),
  btnRun: document.getElementById("btnSubjImport"),
};

let ctx; // { getSubjects, onImported, cascade }
let modal;
let parsed = [];          // subjects from the file
let fileSections = [];    // [{ name, detected }]
let fileTeachers = [];    // [{ name, core, subjects }]
let fileStudents = [];    // [{ name, core, studentId, section, subjects }]
let dbTeachers = [];
let dbStudents = [];
let dbAssignments = [];
let studentPlan = [];
let studentMatches = [];  // every file student, matched to saved records (even when not adding students)
let fileItems = [];       // subjects per sheet, with instructor and section
let assignPlan = [];
let fileWarnings = [];      // notes about fixes made while reading the file
let dbSections = [];
let checked = [];
let sectionPlan = [];
let teacherPlan = [];
let levelOverrides = {};  // section name -> year level chosen in the table

const existingMode = () => els.modalEl.querySelector('input[name="subjExisting"]:checked').value;

function reset() {
  parsed = []; fileSections = []; fileTeachers = []; fileStudents = []; checked = []; sectionPlan = []; teacherPlan = []; studentPlan = [];
  studentMatches = []; fileItems = []; assignPlan = []; fileWarnings = [];
  levelOverrides = {};
  els.file.value = "";
  els.modalEl.querySelector("#subjExistingSkip").checked = true;
  els.makeTeachers.checked = true;
  els.makeSections.checked = true;
  els.makeStudents.checked = true;
  els.makeAssignments.checked = true;
  els.yearLevel.value = "";
  clearErrors(els.modalEl);
  els.extrasStep.classList.add("d-none");
  els.existingNum.textContent = "2";
  els.preview.classList.add("d-none");
  els.btnRun.disabled = true;
  els.btnRun.innerHTML = `<i class="bi bi-upload me-1"></i>Import`;
  els.note.textContent = "Nothing is saved until you click Import.";
}

async function loadReference() {
  const [t, s, st, ga] = await Promise.all([
    getDocs(collection(db, "teachers")),
    getDocs(collection(db, "sections")),
    getDocs(collection(db, "students")),
    getDocs(collection(db, "gradingAssignments")),
  ]);
  dbAssignments = ga.docs.map((d) => ({ id: d.id, ...d.data() }));
  dbTeachers = t.docs.map((d) => ({ id: d.id, ...d.data() }));
  dbStudents = st.docs.map((d) => ({ id: d.id, ...d.data() }));
  dbSections = s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const years = [...new Set(dbSections.map((x) => x.schoolYear))].sort((a, b) => compareText(b, a));
  const now = new Date().getFullYear();
  const suggestions = [...new Set([...years, `${now}-${now + 1}`, `${now - 1}-${now}`])];
  els.schoolYearList.innerHTML = suggestions.map((y) => `<option value="${escapeHtml(y)}"></option>`).join("");
  if (!els.schoolYear.value) els.schoolYear.value = years[0] || (new Date().getMonth() >= 5 ? `${now}-${now + 1}` : `${now - 1}-${now}`);
}

async function downloadTemplate() {
  setBusy(els.btnTemplate, true, "Preparing…");
  try {
    const XLSX = await loadSheetJs();
    const headers = ["section", "year", "student no", "student name", "subject code", "subject", "unit"];
    const cols = [{ wch: 12 }, { wch: 9 }, { wch: 14 }, { wch: 30 }, { wch: 15 }, { wch: 44 }, { wch: 7 }];

    // Blank template: Proctor on top, then the column headers
    const blank = XLSX.utils.aoa_to_sheet([[], ["Proctor", ""], headers]);
    blank["!cols"] = cols;

    // Filled example: name once, then as many subject rows as needed
    const example = XLSX.utils.aoa_to_sheet([
      [],
      ["Proctor", "SHIELA MARIE Y. EDULZURA, RGC"],
      headers,
      ["BSC 1A", "1st Year", "20260001", "Abordo, Christian S.", "GE 1", "Understanding the Self", 3],
      ["", "", "", "", "GE 2", "Reading In Philippine History", 3],
      ["", "", "", "", "PE 1", "Physical Education 1", 2],
      ["", "", "", "", "NSTP 1", "National Service Training Program 1", "IRREG"],
      ["BSC 1A", "1st Year", "20260002", "Aceron, Ron Ron P.", "GE 1", "Understanding the Self", 3],
      ["", "", "", "", "GE 2", "Reading In Philippine History", ""],
      ["", "", "", "", "PE 1", "Physical Education 1", 2],
    ]);
    example["!cols"] = cols;

    const help = XLSX.utils.aoa_to_sheet([
      ["How to fill in the template"],
      [],
      ["Proctor", "Write the proctor's name next to the word Proctor. They become the teacher for these subjects."],
      ["section", "Section name, e.g. BSC 1A. One sheet can hold one or more sections."],
      ["year", "Year level: 1, 1st, 1st Year or First Year (2, 3, 4, 5 the same way)."],
      ["student no", "Optional. Left blank, Student IDs are created from the school year (2026-2027 → 20260001…)."],
      ["student name", "Write it on the student's first row, then add one row per subject below it."],
      ["subject code", "e.g. GE 1"],
      ["subject", "e.g. Understanding the Self"],
      ["unit", "Number of units, e.g. 3"],
      [],
      ["Blank cells", "Blank section, year, student no or student name = same as the row above."],
      ["Irregular", "If the subject or unit is blank, or says IRREG / Irreg / IRREGULAR / Iregular, the student does NOT take that subject."],
      ["School year", "Typed in the import window when you import the file."],
    ]);
    help["!cols"] = [{ wch: 16 }, { wch: 100 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, blank, "Template");
    XLSX.utils.book_append_sheet(wb, example, "Example");
    XLSX.utils.book_append_sheet(wb, help, "How to fill in");
    XLSX.writeFile(wb, "class-list-template.xlsx");
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnTemplate, false);
  }
}

async function readFile() {
  const file = els.file.files[0];
  parsed = []; fileSections = []; fileTeachers = []; fileStudents = [];
  els.btnRun.disabled = true;
  if (!file) { els.preview.classList.add("d-none"); return; }
  els.preview.classList.remove("d-none");
  els.summary.innerHTML = `<span class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>Reading ${escapeHtml(file.name)}…</span>`;
  els.body.innerHTML = "";
  els.source.textContent = "";
  try {
    const XLSX = await loadSheetJs();
    const [wb] = await Promise.all([file.arrayBuffer().then((buf) => XLSX.read(buf, { type: "array" })), loadReference()]);
    const all = [];
    const used = [];
    const studentsAll = [];
    fileWarnings = [];
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: "", blankrows: true });
      const simple = parseSimpleSheet(rows, name);
      if (simple?.warnings.length) fileWarnings.push(...simple.warnings.map((w) => (wb.SheetNames.length > 1 ? `${name}: ${w}` : w)));
      const items = subjectsFromRows(rows, name);
      const studs = studentsFromRows(rows, name);
      if (items.length) used.push(`${name} (${items.length} subjects${studs.length ? `, ${studs.length} students` : ""})`);
      all.push(...items);
      studentsAll.push(...studs);
    }
    fileStudents = mergeStudents(studentsAll);
    all.forEach((i) => { i.skey = subjectKeyOf(i.code, i.name); });
    fileItems = all.filter((i) => !i.errors.length && i.section);
    const noCode = [...new Set(all.filter((i) => !i.code && i.name).map((i) => i.name))];
    if (noCode.length) {
      fileWarnings.push(`${noCode.length} subject${noCode.length === 1 ? " has" : "s have"} no subject code: ${noCode.join(", ")}. ` +
        "They're imported without one (matched by name). You can add codes later on the Subjects page.");
    }
    if (!all.length) {
      els.summary.innerHTML = "";
      els.body.innerHTML = `<tr><td colspan="5" class="empty-state text-danger">No subjects found. The file needs a UNIT column next to subjects written as "CODE - Name", or columns named Subject Code, Subject Name and Units.</td></tr>`;
      return;
    }
    if (all.length > MAX_SUBJECTS) {
      els.body.innerHTML = `<tr><td colspan="5" class="empty-state text-danger">Found ${all.length} subjects; import up to ${MAX_SUBJECTS} at a time.</td></tr>`;
      return;
    }
    parsed = mergeSubjects(all);
    fileSections = collectSections(all.filter((i) => !i.errors.length));
    fileTeachers = collectTeachers(all.filter((i) => !i.errors.length));
    els.source.textContent = `Read from: ${used.join(", ")}`;

    // Step 2 only appears when the file names sections or instructors
    const hasExtras = fileSections.length > 0 || fileTeachers.length > 0 || fileStudents.length > 0;
    els.extrasStep.classList.toggle("d-none", !hasExtras);
    els.existingNum.textContent = hasExtras ? "3" : "2";
    els.makeTeachers.closest(".form-check").classList.toggle("d-none", !fileTeachers.length);
    els.makeSections.closest(".form-check").classList.toggle("d-none", !fileSections.length);
    els.makeStudents.closest(".form-check").classList.toggle("d-none", !fileStudents.length);
    els.makeAssignments.closest(".form-check").classList.toggle("d-none", !(fileStudents.length && fileItems.some((i) => i.instructor)));
    const firstDetected = fileSections.find((s) => s.detected)?.detected || "";
    if (!els.yearLevel.value && firstDetected) els.yearLevel.value = firstDetected;
    syncSectionInputs();
    validate();
  } catch (err) {
    els.summary.innerHTML = "";
    els.body.innerHTML = `<tr><td colspan="5" class="empty-state text-danger">${escapeHtml(errorMessage(err))}</td></tr>`;
  }
}

function syncSectionInputs() {
  const needed = (els.makeSections.checked && fileSections.length) || (els.makeStudents.checked && fileStudents.length) || (els.makeAssignments.checked && fileItems.length);
  els.sectionInputs.classList.toggle("d-none", !needed);
}

function levelFor(section) {
  if (levelOverrides[section.name]) return levelOverrides[section.name];
  if (section.fromFile) return section.detected; // the "year" column in the file
  return fileSections.length > 1 ? section.detected || els.yearLevel.value : els.yearLevel.value;
}

function validate() {
  // Subjects
  const existing = new Map(ctx.getSubjects().map((s) => [subjectKeyOf(s.subjectCode, s.subjectName), s]));
  const mode = existingMode();
  const order = { error: 0, update: 1, new: 2, skip: 3, same: 4 };
  checked = parsed.map((it) => {
    if (it.errors.length) return { ...it, status: "error" };
    const ex = existing.get(it.skey);
    if (!ex) return { ...it, status: "new" };
    const same = ex.subjectName === it.name && Number(ex.units) === it.units;
    if (same) return { ...it, existing: ex, status: "same" };
    return { ...it, existing: ex, status: mode === "update" ? "update" : "skip" };
  }).sort((a, b) => order[a.status] - order[b.status] || compareText(a.code || a.name, b.code || b.name));

  // Sections (matched by school year + name)
  const sy = els.schoolYear.value.trim();
  sectionPlan = els.makeSections.checked
    ? fileSections.map((s) => {
        const found = dbSections.find((d) => d.schoolYear === sy && String(d.sectionName).toUpperCase() === s.name);
        return { ...s, schoolYear: sy, yearLevel: found ? found.yearLevel : levelFor(s), existing: found || null, status: found ? "same" : "new" };
      })
    : [];

  // Teachers (matched by name without ranks/credentials)
  const byCore = new Map(dbTeachers.map((t) => [teacherCore(t.teacherName), t]));
  const newOnes = fileTeachers.filter((t) => !byCore.has(t.core));
  const ids = nextTeacherIds(dbTeachers.map((t) => t.teacherId), newOnes.length);
  let n = 0;
  teacherPlan = els.makeTeachers.checked
    ? fileTeachers.map((t) => {
        const ex = byCore.get(t.core);
        return ex ? { ...t, existing: ex, teacherId: ex.teacherId, status: "same" } : { ...t, teacherId: ids[n++], status: "new" };
      })
    : [];

  // Students: placed in their section for this school year
  studentMatches = planStudents(sy);
  studentPlan = els.makeStudents.checked ? studentMatches : [];

  // Grading assignments: subject + instructor + section + the students who take it
  assignPlan = els.makeAssignments.checked ? planAssignments(sy) : [];
  render();
}

function teacherTarget(instructor) {
  const core = teacherCore(instructor);
  const planned = teacherPlan.find((t) => t.core === core);
  if (planned) return { core, name: planned.status === "same" ? planned.existing.teacherName : planned.name, existing: planned.existing || null };
  const ex = dbTeachers.find((t) => teacherCore(t.teacherName) === core);
  return ex ? { core, name: ex.teacherName, existing: ex } : null;
}

function subjectTarget(skey) {
  const row = checked.find((r) => r.skey === skey);
  if (!row || row.status === "error") return null;
  const useFile = row.status === "new" || row.status === "update";
  return {
    code: row.code,
    name: useFile ? row.name : row.existing.subjectName,
    units: useFile ? row.units : Number(row.existing.units),
    existing: row.existing || null,
  };
}

function planAssignments(sy) {
  const seen = new Set();
  const plan = [];
  const position = {}; // section → next column position (keeps the sheet's subject order)
  for (const it of fileItems) {
    const k = `${it.section}|${it.skey}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const sheetOrder = (position[it.section] = (position[it.section] ?? -1) + 1);
    const errors = [];
    const subject = subjectTarget(it.skey);
    if (!subject) errors.push("The subject has an error above");
    let teacher = null;
    if (!it.instructor) errors.push("No instructor named for this subject");
    else {
      teacher = teacherTarget(it.instructor);
      if (!teacher) errors.push("Instructor isn't a saved teacher. Tick Teachers to add them.");
    }
    const section = sectionTarget(it.section, sy);
    if (!section) errors.push(`Section ${it.section} doesn't exist for ${sy || "this school year"}. Tick Sections.`);
    // Students who have this subject in the file, and will exist after the import
    const students = studentMatches.filter((s) =>
      s.section === it.section && s.subjects.includes(it.skey) &&
      (s.status === "same" || (s.status === "new" && els.makeStudents.checked)));
    if (!students.length && !errors.length) errors.push("No students for this subject. Tick Students to add them.");

    const entry = { key: k, sheetOrder, skey: it.skey, code: it.code, subjectName: subject?.name || it.name, section: it.section, instructor: it.instructor, teacher, subject, sectionInfo: section, students, errors };
    if (errors.length) { plan.push({ ...entry, status: "error" }); continue; }

    // Already saved? Only possible when teacher, subject and section all exist.
    const ex = teacher.existing && subject.existing && section.existing
      ? dbAssignments.find((a) => a.teacherDocId === teacher.existing.id && a.subjectId === subject.existing.id && a.schoolYear === sy && termOf(a) === termOf({ term: els.term ? els.term.value : "" }) && a.sectionId === section.existing.id)
      : null;
    if (ex) {
      const have = new Set(ex.studentIds || []);
      const missing = students.filter((s) => !(s.existing && have.has(s.existing.id)));
      const status = missing.length ? "add" : ex.sheetOrder === undefined ? "order" : "same";
      plan.push({ ...entry, existing: ex, missing, status });
    } else {
      plan.push({ ...entry, status: "new" });
    }
  }
  const order = { error: 0, add: 1, new: 2, order: 3, same: 4 };
  return plan.sort((a, b) => order[a.status] - order[b.status] || compareText(a.section, b.section) || compareText(a.code || a.subjectName, b.code || b.subjectName));
}

function sectionTarget(name, sy) {
  const planned = sectionPlan.find((s) => s.name === name);
  if (planned) return { name, yearLevel: planned.yearLevel, existing: planned.existing };
  const found = dbSections.find((d) => d.schoolYear === sy && String(d.sectionName).toUpperCase() === name);
  return found ? { name, yearLevel: found.yearLevel, existing: found } : null;
}

function planStudents(sy) {
  const sameYear = dbStudents.filter((d) => d.schoolYear === sy);
  const byCore = new Map(sameYear.map((d) => [studentCore(d.studentName), d]));
  const byId = new Map(dbStudents.map((d) => [String(d.studentId), d]));
  const plan = fileStudents.map((s) => {
    if (s.errors.length) return { ...s, status: "error" };
    const target = sectionTarget(s.section, sy);
    if (!target) return { ...s, status: "error", errors: [`Section ${s.section} doesn't exist for ${sy || "this school year"}. Tick Sections to add it.`] };
    const ex = byCore.get(s.core);
    if (ex) return { ...s, target, existing: ex, studentId: ex.studentId, status: "same" };
    if (s.studentId && byId.has(s.studentId)) {
      // Taken by someone else: use the next number instead
      return { ...s, target, status: "new", takenNo: s.studentId, takenBy: byId.get(s.studentId).studentName, studentId: "" };
    }
    return { ...s, target, status: "new" };
  });
  // Generate IDs for new students without one
  const needIds = plan.filter((p) => p.status === "new" && !p.studentId);
  const inFile = plan.filter((p) => p.studentId).map((p) => p.studentId);
  const ids = nextStudentIds(dbStudents.map((d) => d.studentId), sy, needIds.length, inFile);
  needIds.forEach((p, i) => { p.studentId = ids[i]; p.generated = true; });
  return plan;
}

function statusBadge(r) {
  switch (r.status) {
    case "new": return `<span class="badge badge-pass">New</span>`;
    case "update": return `<span class="badge text-bg-warning">Update</span><div class="small text-secondary mt-1">Now: ${escapeHtml(r.existing.subjectName)}, ${escapeHtml(r.existing.units)} units</div>`;
    case "skip": return `<span class="badge badge-none">Exists, skip</span><div class="small text-secondary mt-1">Saved as ${escapeHtml(r.existing.units)} units</div>`;
    case "same": return `<span class="badge badge-none">Already saved</span>`;
    default: return `<span class="badge badge-fail">Error</span><div class="small mt-1" style="color:var(--maroon)">${r.errors.map(escapeHtml).join("<br>")}</div>`;
  }
}

function render() {
  const n = (s) => checked.filter((r) => r.status === s).length;
  const subjWrite = n("new") + n("update");
  const secWrite = sectionPlan.filter((s) => s.status === "new").length;
  const teachWrite = teacherPlan.filter((t) => t.status === "new").length;
  const studWrite = studentPlan.filter((t) => t.status === "new").length;
  const studErr = studentPlan.filter((t) => t.status === "error").length;
  const asgWrite = assignPlan.filter((a) => a.status === "new" || a.status === "add" || a.status === "order").length;
  const asgErr = assignPlan.filter((a) => a.status === "error").length;

  els.summary.innerHTML = `
    <span class="badge badge-count">${checked.length} subjects</span>
    <span class="badge badge-pass">${n("new")} new</span>
    ${n("update") ? `<span class="badge text-bg-warning">${n("update")} to update</span>` : ""}
    ${n("skip") + n("same") ? `<span class="badge badge-none">${n("skip") + n("same")} already saved</span>` : ""}
    ${n("error") ? `<span class="badge badge-fail">${n("error")} with errors</span>` : ""}
    ${sectionPlan.length ? `<span class="badge badge-count">${secWrite} new section${secWrite === 1 ? "" : "s"}</span>` : ""}
    ${teacherPlan.length ? `<span class="badge badge-count">${teachWrite} new teacher${teachWrite === 1 ? "" : "s"}</span>` : ""}
    ${studentPlan.length ? `<span class="badge badge-count">${studWrite} new student${studWrite === 1 ? "" : "s"}</span>` : ""}
    ${studErr ? `<span class="badge badge-fail">${studErr} student${studErr === 1 ? "" : "s"} with errors</span>` : ""}
    ${assignPlan.length ? `<span class="badge badge-count">${asgWrite} grading assignment${asgWrite === 1 ? "" : "s"}</span>` : ""}
    ${asgErr ? `<span class="badge badge-fail">${asgErr} assignment${asgErr === 1 ? "" : "s"} can't be made</span>` : ""}`;

  els.body.innerHTML = checked.map((r) => `
    <tr class="${r.status === "error" ? "import-row-error" : ""}">
      <td class="code-cell">${escapeHtml(r.code) || '<span class="text-warning-emphasis" title="No subject code">no code</span>'}</td>
      <td>${escapeHtml(r.name) || '<span class="text-secondary">—</span>'}</td>
      <td class="num">${r.units ?? "—"}</td>
      <td class="small">${escapeHtml(r.instructor) || '<span class="text-secondary">—</span>'}</td>
      <td>${statusBadge(r)}</td>
    </tr>`).join("");

  // Sections table (year level can be changed per section)
  els.sectionsBlock.classList.toggle("d-none", !sectionPlan.length);
  els.sectionsBody.innerHTML = sectionPlan.map((s) => `
    <tr>
      <td class="code-cell">${escapeHtml(s.name)}</td>
      <td>${escapeHtml(s.schoolYear) || '<span style="color:var(--maroon)">Enter school year</span>'}</td>
      <td>${s.status === "new"
        ? `<select class="form-select form-select-sm" data-level="${escapeHtml(s.name)}" aria-label="Year level for ${escapeHtml(s.name)}" style="min-width:8rem">
             <option value="">Select</option>${YEAR_LEVELS.map((l) => `<option ${l === s.yearLevel ? "selected" : ""}>${l}</option>`).join("")}
           </select>`
        : escapeHtml(s.yearLevel)}</td>
      <td>${s.status === "new" ? `<span class="badge badge-pass">New</span>` : `<span class="badge badge-none">Already saved</span>`}</td>
    </tr>`).join("");

  // Students table
  els.studentsBlock.classList.toggle("d-none", !studentPlan.length);
  const names = (list) => (list || []).map(subjectLabel);
  const subjText = (s) => {
    const taking = s.subjects.length === 0 ? "None" : s.subjects.length <= 3 ? names(s.subjects).join(", ") : `${s.subjects.length} subjects`;
    return (s.irregular || []).length ? `${taking} · IRREG: ${names(s.irregular).join(", ")}` : taking;
  };
  const subjTitle = (s) => `Takes: ${names(s.subjects).join(", ") || "none"}${(s.irregular || []).length ? `\nIRREG (not taking): ${names(s.irregular).join(", ")}` : ""}`;
  els.studentsBody.innerHTML = studentPlan.map((s) => `
    <tr class="${s.status === "error" ? "import-row-error" : ""}">
      <td class="code-cell">${escapeHtml(s.studentId) || "—"}${s.generated
        ? `<div class="small text-secondary fw-normal">${s.takenNo ? `next no. (${escapeHtml(s.takenNo)} belongs to ${escapeHtml(s.takenBy)})` : s.sharedNo ? "next no. (same no. as another student)" : "next no."}</div>`
        : ""}</td>
      <td>${escapeHtml(s.status === "same" ? s.existing.studentName : s.name)}</td>
      <td>${escapeHtml(s.section)}</td>
      <td class="small" title="${escapeHtml(subjTitle(s))}">${escapeHtml(subjText(s))}</td>
      <td>${s.status === "new" ? `<span class="badge badge-pass">New</span>`
        : s.status === "same" ? `<span class="badge badge-none">Already saved</span>`
        : `<span class="badge badge-fail">Error</span><div class="small mt-1" style="color:var(--maroon)">${s.errors.map(escapeHtml).join("<br>")}</div>`}</td>
    </tr>`).join("");

  // Grading assignments table
  els.assignBlock.classList.toggle("d-none", !assignPlan.length);
  els.assignBody.innerHTML = assignPlan.map((a) => `
    <tr class="${a.status === "error" ? "import-row-error" : ""}">
      <td><span class="code-cell">${escapeHtml(a.code) || '<span class="text-warning-emphasis">no code</span>'}</span></td>
      <td>${escapeHtml(a.section)}</td>
      <td class="small">${escapeHtml(a.teacher?.name || a.instructor || "—")}</td>
      <td class="num" title="${escapeHtml(a.students.map((s) => s.name).join(", "))}">${a.students.length}</td>
      <td>${a.status === "new" ? `<span class="badge badge-pass">New</span>`
        : a.status === "add" ? `<span class="badge text-bg-warning">Add ${a.missing.length} student${a.missing.length === 1 ? "" : "s"}</span><div class="small text-secondary mt-1">Assignment already saved</div>`
        : a.status === "order" ? `<span class="badge badge-none">Already saved</span><div class="small text-secondary mt-1">Subject order from the sheet will be saved</div>`
        : a.status === "same" ? `<span class="badge badge-none">Already saved</span>`
        : `<span class="badge badge-fail">Can't make</span><div class="small mt-1" style="color:var(--maroon)">${a.errors.map(escapeHtml).join("<br>")}</div>`}</td>
    </tr>`).join("");

  // Teachers table
  els.teachersBlock.classList.toggle("d-none", !teacherPlan.length);
  els.teachersBody.innerHTML = teacherPlan.map((t) => `
    <tr>
      <td class="code-cell">${escapeHtml(t.teacherId)}</td>
      <td>${escapeHtml(t.status === "same" ? t.existing.teacherName : t.name)}</td>
      <td class="small">${t.subjects.map(escapeHtml).join(", ")}</td>
      <td>${t.status === "new" ? `<span class="badge badge-pass">New</span>` : `<span class="badge badge-none">Already saved</span>`}</td>
    </tr>`).join("");

  const parts = [];
  if (subjWrite) parts.push(`${subjWrite} subject${subjWrite === 1 ? "" : "s"}`);
  if (secWrite) parts.push(`${secWrite} section${secWrite === 1 ? "" : "s"}`);
  if (teachWrite) parts.push(`${teachWrite} teacher${teachWrite === 1 ? "" : "s"}`);
  if (studWrite) parts.push(`${studWrite} student${studWrite === 1 ? "" : "s"}`);
  if (asgWrite) parts.push(`${asgWrite} assignment${asgWrite === 1 ? "" : "s"}`);
  els.btnRun.disabled = parts.length === 0;
  els.btnRun.innerHTML = `<i class="bi bi-upload me-1"></i>${parts.length ? `Import ${parts.join(", ")}` : "Import"}`;
  renderWarnings();
  els.note.textContent = n("error")
    ? `${n("error")} subject${n("error") === 1 ? "" : "s"} with errors will be left out.`
    : n("skip")
      ? `${n("skip")} existing code${n("skip") === 1 ? " has" : "s have"} different details. Choose "Update" to change them.`
      : "Nothing is saved until you click Import.";
}

function renderWarnings() {
  const box = document.getElementById("subjImportWarnings");
  if (!box) return;
  box.classList.toggle("d-none", !fileWarnings.length);
  box.innerHTML = fileWarnings.length
    ? `<div class="fw-semibold mb-1"><i class="bi bi-exclamation-triangle me-1"></i>Please check</div><ul class="mb-0 ps-3">${fileWarnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`
    : "";
}

function checkSectionInputs() {
  clearErrors(els.sectionInputs);
  const newSections = sectionPlan.filter((s) => s.status === "new");
  const needsYear = (els.makeSections.checked && fileSections.length) || (els.makeStudents.checked && studentPlan.some((s) => s.status === "new")) || (els.makeAssignments.checked && assignPlan.length);
  if (!needsYear) return true;
  let ok = true;
  const sy = els.schoolYear.value.trim();
  if (!sy) { fieldError(els.schoolYear, "Enter the school year."); ok = false; }
  else if (!isValidSchoolYear(sy)) { fieldError(els.schoolYear, "Use consecutive years, for example 2026-2027."); ok = false; }
  const missingLevel = newSections.filter((s) => !s.yearLevel);
  if (missingLevel.length) {
    if (!els.yearLevel.value) fieldError(els.yearLevel, "Select the year level.");
    else toast(`Choose a year level for ${missingLevel.map((s) => s.name).join(", ")}.`, "warning");
    ok = false;
  }
  if (!ok) els.extrasStep.scrollIntoView({ behavior: "smooth", block: "center" });
  return ok;
}

async function runImport() {
  if (!checkSectionInputs()) return;
  const subjRows = checked.filter((r) => r.status === "new" || r.status === "update");
  setBusy(els.btnRun, true, "Importing…");
  try {
    // Re-read the latest records so nothing is duplicated
    const [sSnap, tSnap, secSnap, stSnap, gaSnap] = await Promise.all([
      getDocs(collection(db, "subjects")),
      getDocs(collection(db, "teachers")),
      getDocs(collection(db, "sections")),
      getDocs(collection(db, "students")),
      getDocs(collection(db, "gradingAssignments")),
    ]);
    const freshAssignments = gaSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const freshStudents = stSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const freshSubjects = new Map(sSnap.docs.map((d) => [subjectKeyOf(d.data().subjectCode, d.data().subjectName), { id: d.id, ...d.data() }]));
    const freshTeachers = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const freshSections = secSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ops = [];
    const counts = { subjects: 0, updated: 0, sections: 0, teachers: 0, students: 0, assignments: 0, assignmentsUpdated: 0, skippedTwice: 0 };
    // Document ids of everything, saved or created now, for linking assignments
    const teacherIds = {};  // name core → { id, teacherId, teacherName }
    const subjectIds = {};  // code → { id, subjectCode, subjectName, units }
    const studentIds = {};  // name core → student doc id (this school year)
    freshTeachers.forEach((t) => (teacherIds[teacherCore(t.teacherName)] = { id: t.id, teacherId: t.teacherId, teacherName: t.teacherName }));
    freshSubjects.forEach((v, code) => (subjectIds[code] = { id: v.id, subjectCode: v.subjectCode, subjectName: v.subjectName, units: Number(v.units) }));
    const sectionIds = {}; // section name → { id, yearLevel } for placing students
    const updated = [];

    // Teachers
    if (els.makeTeachers.checked) {
      const cores = new Set(freshTeachers.map((t) => teacherCore(t.teacherName)));
      const toAdd = fileTeachers.filter((t) => !cores.has(t.core));
      const ids = nextTeacherIds(freshTeachers.map((t) => t.teacherId), toAdd.length);
      toAdd.forEach((t, i) => {
        const ref = doc(collection(db, "teachers"));
        ops.push({ type: "set", ref, data: { teacherId: ids[i], teacherName: t.name, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
        teacherIds[t.core] = { id: ref.id, teacherId: ids[i], teacherName: t.name };
        counts.teachers++;
      });
    }

    // Sections
    const sy = els.schoolYear.value.trim();
    freshSections
      .filter((d) => d.schoolYear === sy)
      .forEach((d) => (sectionIds[String(d.sectionName).toUpperCase()] = { id: d.id, yearLevel: d.yearLevel }));
    if (els.makeSections.checked) {
      for (const s of sectionPlan.filter((x) => x.status === "new")) {
        if (sectionIds[s.name]) continue; // added meanwhile
        const ref = doc(collection(db, "sections"));
        ops.push({ type: "set", ref, data: { schoolYear: s.schoolYear, yearLevel: s.yearLevel, sectionName: s.name, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
        sectionIds[s.name] = { id: ref.id, yearLevel: s.yearLevel };
        counts.sections++;
      }
    }

    // Subjects
    for (const r of subjRows) {
      const data = { subjectCode: r.code, subjectName: r.name, units: r.units };
      const ex = freshSubjects.get(r.skey);
      if (!ex) {
        const ref = doc(collection(db, "subjects"));
        ops.push({ type: "set", ref, data: { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() } });
        subjectIds[r.skey] = { id: ref.id, ...data };
        counts.subjects++;
      } else if (existingMode() === "update") {
        ops.push({ type: "update", ref: doc(db, "subjects", ex.id), data: { ...data, updatedAt: serverTimestamp() } });
        subjectIds[r.skey] = { id: ex.id, ...data };
        updated.push({ id: ex.id, data });
        counts.updated++;
      }
    }

    // Students
    freshStudents.filter((d) => d.schoolYear === sy).forEach((d) => (studentIds[studentCore(d.studentName)] = d.id));
    if (els.makeStudents.checked) {
      const sameYear = new Set(freshStudents.filter((d) => d.schoolYear === sy).map((d) => studentCore(d.studentName)));
      const usedIds = new Set(freshStudents.map((d) => String(d.studentId)));
      const toAdd = studentPlan.filter((p) => p.status === "new" && !sameYear.has(p.core) && sectionIds[p.section]);
      // Re-number generated IDs against the latest records
      const needIds = toAdd.filter((p) => p.generated || usedIds.has(String(p.studentId)));
      const ids = nextStudentIds([...usedIds], sy, needIds.length, toAdd.filter((p) => !needIds.includes(p)).map((p) => p.studentId));
      needIds.forEach((p, i) => (p.studentId = ids[i]));
      toAdd.forEach((p) => {
        const sec = sectionIds[p.section];
        const ref = doc(collection(db, "students"));
        studentIds[p.core] = ref.id;
        ops.push({
          type: "set",
          ref,
          data: {
            studentId: p.studentId,
            studentName: p.name,
            email: "",
            schoolYear: sy,
            yearLevel: sec.yearLevel,
            sectionId: sec.id,
            sectionName: p.section,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          },
        });
        counts.students++;
      });
    }

    // Grading assignments
    if (els.makeAssignments.checked) {
      // A student takes a subject only once a school year and term: who already takes what (subject|year → student → assignment)
      const term = termOf({ term: els.term ? els.term.value : "" });
      const takers = new Map();
      const take = (subjectId, studentId, assignmentKey) => {
        const k = `${subjectId}|${sy}`;
        if (!takers.has(k)) takers.set(k, new Map());
        if (!takers.get(k).has(studentId)) takers.get(k).set(studentId, assignmentKey);
      };
      freshAssignments.filter((g) => g.schoolYear === sy && termOf(g) === term).forEach((g) => (g.studentIds || []).forEach((id) => take(g.subjectId, id, g.id)));
      const takenElsewhere = (subjectId, studentId, assignmentKey) => {
        const owner = (takers.get(`${subjectId}|${sy}`) || new Map()).get(studentId);
        return owner !== undefined && owner !== assignmentKey;
      };
      for (const a of assignPlan.filter((x) => x.status === "new" || x.status === "add" || x.status === "order")) {
        const teacher = teacherIds[a.teacher.core];
        const subject = subjectIds[a.skey];
        const section = sectionIds[a.section];
        if (!teacher || !subject || !section) continue;
        const ex = freshAssignments.find((g) => g.teacherDocId === teacher.id && g.subjectId === subject.id && g.schoolYear === sy && termOf(g) === term && g.sectionId === section.id);
        const key = ex ? ex.id : `new:${teacher.id}|${subject.id}|${section.id}`;
        const wanted = [...new Set(a.students.map((s) => studentIds[s.core]).filter(Boolean))];
        // Leave out students already in another grading assignment of this subject (e.g. another instructor)
        const ids = wanted.filter((id) => !takenElsewhere(subject.id, id, key));
        counts.skippedTwice += wanted.length - ids.length;
        ids.forEach((id) => take(subject.id, id, key));
        if (!ids.length) continue;
        if (ex) {
          const merged = [...new Set([...(ex.studentIds || []), ...ids])];
          if (merged.length === (ex.studentIds || []).length) {
            // No new students: just remember the sheet's subject order for exports
            if (ex.sheetOrder === undefined) ops.push({ type: "update", ref: doc(db, "gradingAssignments", ex.id), data: { sheetOrder: a.sheetOrder } });
            continue;
          }
          ops.push({ type: "update", ref: doc(db, "gradingAssignments", ex.id), data: { studentIds: merged, ...(ex.sheetOrder === undefined ? { sheetOrder: a.sheetOrder } : {}), updatedAt: serverTimestamp() } });
          counts.assignmentsUpdated++;
        } else {
          ops.push({
            type: "set",
            ref: doc(collection(db, "gradingAssignments")),
            data: {
              teacherDocId: teacher.id,
              teacherId: teacher.teacherId,
              teacherName: teacher.teacherName,
              subjectId: subject.id,
              subjectCode: subject.subjectCode,
              subjectName: subject.subjectName,
              units: Number(subject.units),
              schoolYear: sy,
              term,
              yearLevel: section.yearLevel,
              sectionId: section.id,
              sectionName: a.section,
              studentIds: ids,
              sheetOrder: a.sheetOrder, // column position in the grade sheet, for exports
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            },
          });
          counts.assignments++;
        }
      }
    }

    await commitOperations(ops);
    for (const u of updated) await ctx.cascade(u.id, u.data);

    const parts = [];
    if (counts.subjects) parts.push(`${counts.subjects} subject${counts.subjects === 1 ? "" : "s"} added`);
    if (counts.updated) parts.push(`${counts.updated} updated`);
    if (counts.sections) parts.push(`${counts.sections} section${counts.sections === 1 ? "" : "s"}`);
    if (counts.teachers) parts.push(`${counts.teachers} teacher${counts.teachers === 1 ? "" : "s"}`);
    if (counts.students) parts.push(`${counts.students} student${counts.students === 1 ? "" : "s"}`);
    if (counts.assignments) parts.push(`${counts.assignments} grading assignment${counts.assignments === 1 ? "" : "s"}`);
    if (counts.assignmentsUpdated) parts.push(`students added to ${counts.assignmentsUpdated} existing assignment${counts.assignmentsUpdated === 1 ? "" : "s"}`);
    if (counts.skippedTwice) parts.push(`${counts.skippedTwice} student enrolment${counts.skippedTwice === 1 ? "" : "s"} left out because the student already takes that subject this school year`);
    toast(`Import finished: ${parts.join(", ") || "nothing new"}.`);
    modal.hide();
    await ctx.onImported();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnRun, false);
    if (els.modalEl.classList.contains("show")) render();
  }
}

export function setupSubjectImport(context) {
  ctx = context;
  modal = new bootstrap.Modal(els.modalEl);
  els.btnOpen.addEventListener("click", () => { reset(); modal.show(); loadSheetJs().catch(() => {}); });
  els.btnTemplate.addEventListener("click", downloadTemplate);
  els.file.addEventListener("change", readFile);
  els.modalEl.querySelectorAll('input[name="subjExisting"]').forEach((r) => r.addEventListener("change", () => parsed.length && validate()));
  els.makeTeachers.addEventListener("change", () => parsed.length && validate());
  els.makeSections.addEventListener("change", () => { syncSectionInputs(); if (parsed.length) validate(); });
  els.makeStudents.addEventListener("change", () => { syncSectionInputs(); if (parsed.length) validate(); });
  els.makeAssignments.addEventListener("change", () => { syncSectionInputs(); if (parsed.length) validate(); });
  els.schoolYear.addEventListener("input", () => parsed.length && validate());
  els.term?.addEventListener("change", () => parsed.length && validate());
  els.yearLevel.addEventListener("change", () => {
    levelOverrides = {}; // the main choice applies to every new section again
    if (parsed.length) validate();
  });
  els.sectionsBody.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-level]");
    if (!sel) return;
    levelOverrides[sel.dataset.level] = sel.value;
    validate();
  });
  els.btnRun.addEventListener("click", runImport);
}
