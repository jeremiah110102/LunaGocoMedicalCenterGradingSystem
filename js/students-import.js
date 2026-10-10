// ==========================================================
// students-import.js — Import students from Excel / CSV
// Uses SheetJS (loaded only when the import dialog is opened).
// Every row is checked and previewed before anything is saved.
// ==========================================================

import {
  db, collection, doc, getDocs, query, where, serverTimestamp,
} from "./firebase-config.js";
import { similarStudents } from "./duplicates.js";
import {
  toast, escapeHtml, normalize, setBusy, compareText, errorMessage,
  commitOperations, isValidSchoolYear, YEAR_LEVELS, loadSheetJs, isValidEmail, nextStudentNumbers,
} from "./app.js";

const MAX_ROWS = 5000;
const TEMPLATE_HEADERS = ["Student ID", "Student Name", "School Year", "Year Level", "Section", "Email"];

// Header names people commonly use, mapped to our fields
const HEADER_ALIASES = {
  studentId: ["studentid", "studentno", "studentnumber", "idnumber", "idno", "id"],
  studentName: ["studentname", "name", "fullname", "completename"],
  schoolYear: ["schoolyear", "sy", "academicyear", "ay"],
  yearLevel: ["yearlevel", "year", "level", "yrlevel", "yrlvl"],
  section: ["section", "sectionname", "class"],
  email: ["email", "emailaddress", "studentemail", "mail", "eaddress"],
};

const els = {
  btnOpen: document.getElementById("btnImport"),
  modalEl: document.getElementById("importModal"),
  btnTemplate: document.getElementById("btnTemplate"),
  file: document.getElementById("importFile"),
  section: document.getElementById("importSection"),
  preview: document.getElementById("importPreview"),
  summary: document.getElementById("importSummary"),
  onlyErrors: document.getElementById("importOnlyErrors"),
  body: document.getElementById("importBody"),
  note: document.getElementById("importNote"),
  btnRun: document.getElementById("btnRunImport"),
};

let ctx; // { getSections, getStudents, onImported }
let modal;
let rawRows = []; // rows read from the file: { rowNum, studentId, studentName, schoolYear, yearLevel, sectionText }
let checked = []; // rawRows plus status

// ---------- Helpers ----------
function headerKey(h) {
  return normalize(h).replace(/[^a-z0-9]/g, "");
}

function mapHeaders(headers) {
  const map = {};
  headers.forEach((h, i) => {
    const key = headerKey(h);
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[field] === undefined && aliases.includes(key)) map[field] = i;
    }
  });
  return map;
}

// Accepts "1st Year", "1st", "1", "First Year", "Year 1", "I" …
function normalizeYearLevel(value) {
  const v = normalize(value);
  if (!v) return "";
  const words = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
  let n = Number((v.match(/\d/) || [])[0]);
  if (!n) {
    const w = v.replace(/year|yr|level|\./g, " ").trim().split(/\s+/)[0];
    n = words[w] || 0;
  }
  return YEAR_LEVELS[n - 1] || null; // null = not recognised
}

function cell(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function selectedSection() {
  return ctx.getSections().find((s) => s.id === els.section.value) || null;
}

function existingMode() {
  return els.modalEl.querySelector('input[name="importExisting"]:checked').value;
}

// ---------- Open / reset ----------
function fillSectionOptions() {
  const sorted = [...ctx.getSections()].sort(
    (a, b) => compareText(b.schoolYear, a.schoolYear) || YEAR_LEVELS.indexOf(a.yearLevel) - YEAR_LEVELS.indexOf(b.yearLevel) || compareText(a.sectionName, b.sectionName)
  );
  els.section.innerHTML =
    `<option value="">Use the columns in the file</option>` +
    sorted.map((s) => `<option value="${s.id}">${escapeHtml(s.sectionName)} (${escapeHtml(s.yearLevel)}, ${escapeHtml(s.schoolYear)})</option>`).join("");
}

function reset() {
  rawRows = [];
  checked = [];
  els.file.value = "";
  els.section.value = "";
  els.onlyErrors.checked = false;
  els.modalEl.querySelector("#existingSkip").checked = true;
  els.preview.classList.add("d-none");
  els.btnRun.disabled = true;
  els.btnRun.innerHTML = `<i class="bi bi-upload me-1"></i>Import students`;
  els.note.textContent = "Nothing is saved until you click Import.";
}

function open() {
  if (!ctx.getSections().length) {
    toast("Create at least one section before importing students.", "warning");
    return;
  }
  reset();
  fillSectionOptions();
  modal.show();
  loadSheetJs().catch(() => {}); // warm up in the background
}

// ---------- Template ----------
async function downloadTemplate() {
  setBusy(els.btnTemplate, true, "Preparing…");
  try {
    const XLSX = await loadSheetJs();
    const sections = [...ctx.getSections()].sort(
      (a, b) => compareText(b.schoolYear, a.schoolYear) || compareText(a.sectionName, b.sectionName)
    );
    const sample = sections[0];
    const rows = [
      TEMPLATE_HEADERS,
      ["20260001", "Juan Santos", sample?.schoolYear ?? "2026-2027", sample?.yearLevel ?? "1st Year", sample?.sectionName ?? "BSIT-1A", "juan.santos@example.com"],
      ["20260002", "Maria Cruz", sample?.schoolYear ?? "2026-2027", sample?.yearLevel ?? "1st Year", sample?.sectionName ?? "BSIT-1A", ""],
    ];
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 30 }, { wch: 13 }, { wch: 11 }, { wch: 14 }, { wch: 30 }];
    // Keep Student IDs as text so leading zeros survive
    for (let r = 1; r < rows.length; r++) {
      const ref = XLSX.utils.encode_cell({ r, c: 0 });
      ws[ref].t = "s";
      ws[ref].z = "@";
    }
    XLSX.utils.book_append_sheet(wb, ws, "Students");

    const ref = XLSX.utils.aoa_to_sheet([
      ["School Year", "Year Level", "Section"],
      ...sections.map((s) => [s.schoolYear, s.yearLevel, s.sectionName]),
    ]);
    ref["!cols"] = [{ wch: 13 }, { wch: 11 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, ref, "Sections (reference)");

    XLSX.writeFile(wb, "student-import-template.xlsx");
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnTemplate, false);
  }
}

// ---------- Read file ----------
async function readFile() {
  const file = els.file.files[0];
  rawRows = [];
  checked = [];
  els.btnRun.disabled = true;
  if (!file) {
    els.preview.classList.add("d-none");
    return;
  }

  els.preview.classList.remove("d-none");
  els.summary.innerHTML = `<span class="small text-secondary"><span class="spinner-border spinner-border-sm me-1"></span>Reading ${escapeHtml(file.name)}…</span>`;
  els.body.innerHTML = "";

  try {
    const XLSX = await loadSheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    // raw:false returns text as shown in Excel (keeps "2026-2027" as typed)
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "", blankrows: false });

    // Find the header row within the first 10 rows
    let headerIndex = -1;
    let map = {};
    for (let i = 0; i < Math.min(grid.length, 10); i++) {
      const m = mapHeaders(grid[i]);
      if (m.studentName !== undefined) {
        headerIndex = i;
        map = m;
        break;
      }
    }
    if (headerIndex === -1) {
      showFileError("Couldn't find the header row. The first sheet needs at least a Student Name column. Download the template to see the expected layout.");
      return;
    }

    const dataRows = grid.slice(headerIndex + 1);
    if (dataRows.length > MAX_ROWS) {
      showFileError(`This file has ${dataRows.length} rows. Import up to ${MAX_ROWS} at a time by splitting the file.`);
      return;
    }

    const get = (row, field) => (map[field] === undefined ? "" : cell(row[map[field]]));
    rawRows = dataRows
      .map((row, i) => ({
        rowNum: headerIndex + i + 2, // Excel row number
        studentId: get(row, "studentId"),
        studentName: get(row, "studentName"),
        schoolYear: get(row, "schoolYear"),
        yearLevel: get(row, "yearLevel"),
        sectionText: get(row, "section"),
        email: get(row, "email").toLowerCase(),
      }))
      .filter((r) => r.studentId || r.studentName || r.sectionText);

    if (!rawRows.length) {
      showFileError("The file has a header row but no students under it.");
      return;
    }
    if (map.section === undefined && !els.section.value) {
      toast("The file has no Section column. Choose a section in step 3 to put every student in it.", "info");
    }
    validate();
  } catch (err) {
    showFileError(errorMessage(err));
  }
}

function showFileError(message) {
  els.summary.innerHTML = "";
  els.body.innerHTML = `<tr><td colspan="7" class="empty-state text-danger">${escapeHtml(message)}</td></tr>`;
  els.btnRun.disabled = true;
}

// ---------- Validate every row ----------
function validate() {
  if (!rawRows.length) return;
  const sections = ctx.getSections();
  const existingById = new Map(ctx.getStudents().map((s) => [s.studentId, s]));
  const forced = selectedSection();
  const mode = existingMode();
  const seen = new Map();

  checked = rawRows.map((r) => {
    const out = { ...r, errors: [], status: "new", section: null };

    // Blank Student ID: gets the next number after the last one in the system (filled in below)
    if (!r.studentName) out.errors.push("Student Name is empty");
    if (r.email && !isValidEmail(r.email)) out.errors.push(`Email "${r.email}" isn't valid`);

    if (r.studentId) {
      if (seen.has(r.studentId)) out.errors.push(`Same Student ID as row ${seen.get(r.studentId)}`);
      else seen.set(r.studentId, r.rowNum);
    }

    // Resolve the section
    if (forced) {
      out.section = forced;
    } else {
      const level = normalizeYearLevel(r.yearLevel);
      if (!r.schoolYear) out.errors.push("School Year is empty");
      else if (!isValidSchoolYear(r.schoolYear)) out.errors.push("School Year should look like 2026-2027");
      if (!r.sectionText) out.errors.push("Section is empty");
      if (level === null) out.errors.push(`Year Level "${r.yearLevel}" not recognised`);

      if (r.schoolYear && r.sectionText) {
        const matches = sections.filter(
          (s) => s.schoolYear === r.schoolYear && normalize(s.sectionName) === normalize(r.sectionText)
        );
        if (!matches.length) {
          out.errors.push(`Section ${r.sectionText} doesn't exist for ${r.schoolYear}`);
        } else if (level && matches[0].yearLevel !== level) {
          out.errors.push(`${matches[0].sectionName} is ${matches[0].yearLevel}, not ${level}`);
        } else {
          out.section = matches[0];
        }
      }
    }

    // New, update or skip?
    const existing = existingById.get(r.studentId);
    if (!out.errors.length && existing) {
      out.existing = existing;
      // An empty Email cell never erases an email that's already saved
      const same =
        existing.studentName === r.studentName &&
        existing.sectionId === out.section.id &&
        (!r.email || (existing.email || "") === r.email);
      if (mode === "skip") out.status = "skip";
      else out.status = same ? "unchanged" : "update";
    }
    if (out.errors.length) out.status = "error";
    // Same person already in the system under another Student ID? (a warning, not an error)
    if (out.status === "new" && r.studentName) {
      out.twins = similarStudents(r.studentName, ctx.getStudents()).filter((s) => s.studentId !== r.studentId);
    }
    return out;
  });

  // Next numbers for new students without a Student ID
  const needIds = checked.filter((r) => r.status === "new" && !r.studentId);
  if (needIds.length) {
    const inFile = checked.filter((r) => r.studentId).map((r) => r.studentId);
    const sy = forced?.schoolYear || needIds[0].section?.schoolYear || "";
    nextStudentNumbers(ctx.getStudents().map((s) => s.studentId), needIds.length, sy, inFile)
      .forEach((id, i) => { needIds[i].studentId = id; needIds[i].generated = true; });
  }

  render();
}

function statusBadge(r) {
  switch (r.status) {
    case "new": return `<span class="badge badge-pass">New</span>${r.twins && r.twins.length ? `<div class="small mt-1 text-warning-emphasis"><i class="bi bi-exclamation-triangle me-1"></i>Possible duplicate of ${r.twins.map((t) => escapeHtml(`${t.studentId} – ${t.studentName}`)).join(", ")}</div>` : ""}`;
    case "update": return `<span class="badge text-bg-warning">Update</span>`;
    case "skip": return `<span class="badge badge-none">Already exists, skip</span>`;
    case "unchanged": return `<span class="badge badge-none">No changes</span>`;
    default: return `<span class="badge badge-fail">Error</span><div class="small mt-1" style="color:var(--maroon)">${r.errors.map(escapeHtml).join("<br>")}</div>`;
  }
}

function render() {
  const count = (s) => checked.filter((r) => r.status === s).length;
  const n = { new: count("new"), update: count("update"), skip: count("skip") + count("unchanged"), error: count("error") };
  const toWrite = n.new + n.update;

  els.summary.innerHTML = `
    <span class="badge badge-count">${checked.length} rows</span>
    <span class="badge badge-pass">${n.new} new</span>
    ${n.update ? `<span class="badge text-bg-warning">${n.update} to update</span>` : ""}
    ${n.skip ? `<span class="badge badge-none">${n.skip} skipped</span>` : ""}
    ${n.error ? `<span class="badge badge-fail">${n.error} with errors</span>` : ""}
    ${checked.some((r) => r.twins && r.twins.length) ? `<span class="badge text-bg-warning">${checked.filter((r) => r.twins && r.twins.length).length} possible duplicate${checked.filter((r) => r.twins && r.twins.length).length === 1 ? "" : "s"}</span>` : ""}`;

  const forced = selectedSection();
  const rows = els.onlyErrors.checked ? checked.filter((r) => r.status === "error") : checked;
  els.body.innerHTML = rows.length
    ? rows
        .map(
          (r) => `
      <tr class="${r.status === "error" ? "import-row-error" : ""}">
        <td class="num text-secondary">${r.rowNum}</td>
        <td class="code-cell">${escapeHtml(r.studentId) || '<span class="text-secondary">—</span>'}${r.generated ? '<div class="small text-secondary fw-normal">next no.</div>' : ""}</td>
        <td>${escapeHtml(r.studentName) || '<span class="text-secondary">—</span>'}${r.email ? `<div class="small text-secondary">${escapeHtml(r.email)}</div>` : ""}</td>
        <td>${escapeHtml(forced ? forced.schoolYear : r.section?.schoolYear ?? r.schoolYear)}</td>
        <td>${escapeHtml(forced ? forced.yearLevel : r.section?.yearLevel ?? r.yearLevel)}</td>
        <td>${escapeHtml(forced ? forced.sectionName : r.section?.sectionName ?? r.sectionText)}</td>
        <td>${statusBadge(r)}</td>
      </tr>`
        )
        .join("")
    : `<tr><td colspan="7" class="empty-state">No rows with problems.</td></tr>`;

  els.btnRun.disabled = toWrite === 0;
  els.btnRun.innerHTML = `<i class="bi bi-upload me-1"></i>${toWrite ? `Import ${toWrite} student${toWrite === 1 ? "" : "s"}` : "Import students"}`;
  els.note.textContent = n.error
    ? `${n.error} row${n.error === 1 ? "" : "s"} with errors will be left out. Fix the file and choose it again to include them.`
    : "Nothing is saved until you click Import.";
}

// ---------- Save to Firestore ----------
async function runImport() {
  const rows = checked.filter((r) => r.status === "new" || r.status === "update");
  if (!rows.length) return;

  setBusy(els.btnRun, true, `Importing ${rows.length}…`);
  try {
    // Re-check IDs against Firestore right before writing (another user may have added some)
    const fresh = new Map();
    const ids = [...new Set(rows.map((r) => r.studentId))];
    for (let i = 0; i < ids.length; i += 30) {
      const snap = await getDocs(query(collection(db, "students"), where("studentId", "in", ids.slice(i, i + 30))));
      snap.forEach((d) => fresh.set(d.data().studentId, { id: d.id, ...d.data() }));
    }

    // Re-number blank-ID students against the latest saved numbers
    const generated = rows.filter((r) => r.generated);
    if (generated.length) {
      const all = await getDocs(collection(db, "students"));
      const inFile = rows.filter((r) => !r.generated).map((r) => r.studentId);
      nextStudentNumbers(all.docs.map((d) => d.data().studentId), generated.length, generated[0].section?.schoolYear, inFile)
        .forEach((id, i) => (generated[i].studentId = id));
    }

    const ops = [];
    let created = 0, updated = 0, skipped = 0;
    const renamed = [];

    for (const r of rows) {
      const s = r.section;
      const data = {
        studentId: r.studentId,
        studentName: r.studentName,
        schoolYear: s.schoolYear,
        yearLevel: s.yearLevel,
        sectionId: s.id,
        sectionName: s.sectionName,
        updatedAt: serverTimestamp(),
      };
      if (r.email) data.email = r.email;
      const existing = fresh.get(r.studentId);
      if (!existing) {
        ops.push({ type: "set", ref: doc(collection(db, "students")), data: { email: "", ...data, createdAt: serverTimestamp() } });
        created++;
      } else if (existingMode() === "update") {
        ops.push({ type: "update", ref: doc(db, "students", existing.id), data });
        if (existing.studentName !== r.studentName) renamed.push({ id: existing.id, name: r.studentName });
        updated++;
      } else {
        skipped++;
      }
    }

    // Grades keep a copy of the student's name
    for (const { id, name } of renamed) {
      const g = await getDocs(query(collection(db, "grades"), where("studentId", "==", id)));
      g.forEach((d) => ops.push({ type: "update", ref: d.ref, data: { studentName: name, updatedAt: serverTimestamp() } }));
    }

    await commitOperations(ops);

    const parts = [];
    if (created) parts.push(`${created} added`);
    if (updated) parts.push(`${updated} updated`);
    if (skipped) parts.push(`${skipped} skipped (already exist)`);
    toast(`Import finished: ${parts.join(", ")}.`);
    modal.hide();
    await ctx.onImported();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnRun, false);
    if (!els.modalEl.classList.contains("show")) return;
    render();
  }
}

// ---------- Public ----------
export function setupStudentImport(context) {
  ctx = context;
  modal = new bootstrap.Modal(els.modalEl);
  els.btnOpen.addEventListener("click", open);
  els.btnTemplate.addEventListener("click", downloadTemplate);
  els.file.addEventListener("change", readFile);
  els.section.addEventListener("change", validate);
  els.onlyErrors.addEventListener("change", render);
  els.modalEl.querySelectorAll('input[name="importExisting"]').forEach((r) => r.addEventListener("change", validate));
  els.btnRun.addEventListener("click", runImport);
}
