// ==========================================================
// students.js — Student CRUD (collection: students)
// Section is chosen from sections stored in Firestore.
// Bulk actions: select students, change their school year /
// year level / section together, or delete them.
// Students in a grading assignment can be selected and edited, but not deleted.
// ==========================================================

import {
  db,
  collection,
  doc,
  addDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  getDoc,
  query,
  where,
  serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout,
  toast,
  confirmDialog,
  escapeHtml,
  normalize,
  setBusy,
  compareText,
  tableLoading,
  tableMessage,
  errorMessage,
  clearErrors,
  fieldError,
  commitOperations,
  YEAR_LEVELS,
  isValidEmail,
  nextStudentNumbers,
  getOptions,
  getSchool,
} from "./app.js";
import { setupStudentImport } from "./students-import.js";
import { STATUSES, statusOf, statusBadge, hasLeft } from "./student-status.js";
import { openNameList } from "./name-list.js";
import { moveInAssignments } from "./section-move.js";
import { buildTranscript, transcriptHtml } from "./transcript.js";
import { similarStudents, duplicateGroups, planMerge } from "./duplicates.js";

const studentsCol = collection(db, "students");
const assignmentsCol = collection(db, "gradingAssignments");
const COLS = 7; // checkbox + 6 data columns
const $ = (id) => document.getElementById(id);

const els = {
  tbody: $("tbody"),
  count: $("count"),
  search: $("search"),
  filterSection: $("filterSection"),
  filterStatus: $("filterStatus"),
  noSections: $("noSections"),
  btnAdd: $("btnAdd"),
  btnImport: $("btnImport"),
  modalEl: $("formModal"),
  modalTitle: $("formModalTitle"),
  form: $("form"),
  formError: $("formError"),
  studentId: $("studentId"),
  studentName: $("studentName"),
  email: $("studentEmail"),
  status: $("studentStatus"),
  statusNote: $("studentStatusNote"),
  schoolYear: $("schoolYear"),
  yearLevel: $("yearLevel"),
  section: $("sectionSelect"),
  btnSave: $("btnSave"),
  // Bulk selection
  selectAll: $("selectAll"),
  bulkBar: $("bulkBar"),
  bulkCount: $("bulkCount"),
  btnBulkMove: $("btnBulkMove"),
  btnBulkDelete: $("btnBulkDelete"),
  btnBulkClear: $("btnBulkClear"),
  // Bulk change-section modal
  bulkModalEl: $("bulkModal"),
  bulkModalTitle: $("bulkModalTitle"),
  bulkForm: $("bulkForm"),
  bulkError: $("bulkError"),
  bulkNames: $("bulkNames"),
  bulkSchoolYear: $("bulkSchoolYear"),
  bulkYearLevel: $("bulkYearLevel"),
  bulkSection: $("bulkSectionSelect"),
  btnBulkSave: $("btnBulkSave"),
};

const BULK_IDS = [
  "selectAll",
  "bulkBar",
  "bulkCount",
  "btnBulkMove",
  "btnBulkDelete",
  "btnBulkClear",
  "bulkModal",
  "bulkModalTitle",
  "bulkForm",
  "bulkError",
  "bulkNames",
  "bulkSchoolYear",
  "bulkYearLevel",
  "bulkSectionSelect",
  "btnBulkSave",
];
let bulkReady = false;

let students = [];
let sections = [];
let assignmentCount = new Map(); // student doc id -> number of grading assignments
const selected = new Set(); // selected student doc ids
let listFilter = null; // student doc ids from "Paste list" (null = no list)
let listMissing = []; // names from the list that weren't found
let editingId = null;
let modal, bulkModal, formCascade, bulkCascade;

// ----- Moving students in grading assignments: section-move.js (also used by Grading assignments) -----

// ----- Grading assignment lock -----
function countAssignments(snap) {
  const map = new Map();
  snap.docs.forEach((d) =>
    (d.data().studentIds || []).forEach((id) =>
      map.set(id, (map.get(id) || 0) + 1),
    ),
  );
  return map;
}
const isLocked = (id) => (assignmentCount.get(id) || 0) > 0;
function lockNote(id) {
  const n = assignmentCount.get(id) || 0;
  return `In ${n} grading assignment${n === 1 ? "" : "s"}`;
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function loadAll() {
  tableLoading(els.tbody, COLS);
  try {
    const [secSnap, stuSnap, gaSnap] = await Promise.all([
      getDocs(collection(db, "sections")),
      getDocs(studentsCol),
      getDocs(assignmentsCol),
    ]);
    sections = secSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    students = stuSnap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => compareText(a.studentName, b.studentName));
    assignmentCount = countAssignments(gaSnap);

    // Drop selections for students that no longer exist
    for (const id of [...selected]) {
      if (!students.some((s) => s.id === id)) selected.delete(id);
    }

    els.noSections.classList.toggle("d-none", sections.length > 0);
    els.btnAdd.disabled = sections.length === 0;
    els.btnImport.disabled = sections.length === 0;
    fillSectionFilter();
    render();
  } catch (err) {
    tableMessage(
      els.tbody,
      COLS,
      `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`,
    );
  }
}

function sectionLabel(s) {
  return `${s.sectionName} (${s.yearLevel}, ${s.schoolYear})`;
}

function fillSectionFilter() {
  const current = els.filterSection.value;
  const sorted = [...sections].sort(
    (a, b) =>
      compareText(b.schoolYear, a.schoolYear) ||
      compareText(a.sectionName, b.sectionName),
  );
  els.filterSection.innerHTML =
    `<option value="">All sections</option>` +
    sorted
      .map(
        (s) =>
          `<option value="${s.id}">${escapeHtml(sectionLabel(s))}</option>`,
      )
      .join("");
  if (sections.some((s) => s.id === current)) els.filterSection.value = current;
}

function visibleRows() {
  const term = normalize(els.search.value);
  const sectionId = els.filterSection.value;
  const status = els.filterStatus ? els.filterStatus.value : "all";
  return students.filter(
    (s) =>
      (!sectionId || s.sectionId === sectionId) &&
      (status === "all" || statusOf(s) === status) &&
      (!listFilter || listFilter.has(s.id)) &&
      (!term ||
        normalize(`${s.studentId} ${s.studentName} ${s.email || ""}`).includes(
          term,
        )),
  );
}

function renderListNote() {
  const note = $("listFilterNote");
  if (!note) return;
  note.classList.toggle("d-none", !listFilter);
  if (!listFilter) return;
  note.innerHTML = `<span><i class="bi bi-list-check me-1" aria-hidden="true"></i>Showing the <strong>${listFilter.size}</strong> student${listFilter.size === 1 ? "" : "s"} from your list` +
    (listMissing.length ? ` · <span class="text-danger">${listMissing.length} not found: ${escapeHtml(listMissing.slice(0, 8).join("; "))}${listMissing.length > 8 ? "; …" : ""}</span>` : "") +
    `</span><button type="button" class="btn btn-sm btn-link py-0 ms-auto" id="btnClearList">Show all students</button>`;
}

function pasteList() {
  openNameList({
    title: "Find students from a list",
    students,
    describe: (s) => escapeHtml(`${s.sectionName}, ${s.schoolYear}`) + statusBadge(s, escapeHtml),
    extraHtml: () => `
      <div class="d-flex flex-wrap gap-3 mb-2 small">
        <span class="fw-semibold">Then:</span>
        <div class="form-check"><input class="form-check-input" type="radio" name="listThen" id="listThenMove" checked><label class="form-check-label" for="listThenMove">Change their section now</label></div>
        <div class="form-check"><input class="form-check-input" type="radio" name="listThen" id="listThenSelect"><label class="form-check-label" for="listThenSelect">Only select them</label></div>
      </div>`,
    applyText: (n, root) => root.querySelector("#listThenSelect")?.checked
      ? `Show and select ${n} student${n === 1 ? "" : "s"}`
      : `Change section of ${n} student${n === 1 ? "" : "s"}…`,
    onApply: (found, results, root) => {
      const thenMove = !root.querySelector("#listThenSelect")?.checked;
      listFilter = new Set(found.map((s) => s.id));
      listMissing = results.filter((r) => r.status !== "found").map((r) => r.line);
      selected.clear();
      found.forEach((s) => selected.add(s.id));
      els.search.value = "";
      els.filterSection.value = "";
      if (els.filterStatus) els.filterStatus.value = "all";
      render();
      if (thenMove && bulkReady) {
        // Open "Change section" for them once this dialog has closed
        $("nameListModal").addEventListener("hidden.bs.modal", () => openBulkForm(), { once: true });
      } else {
        toast(`${found.length} student${found.length === 1 ? "" : "s"} selected. Use Change section or Set status for all of them at once.`, "info");
      }
    },
  });
}

function render() {
  renderListNote();
  const rows = visibleRows();
  els.count.textContent = students.length;

  if (!students.length) {
    tableMessage(
      els.tbody,
      COLS,
      sections.length
        ? "No students yet. Add a student and enroll them in a section."
        : "No students yet.",
    );
    updateBulkUI();
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, COLS, "No students match your filters.");
    updateBulkUI();
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map((s) => {
      const locked = isLocked(s.id);
      const note = locked ? escapeHtml(lockNote(s.id)) : "";
      const checkbox = bulkReady
        ? `<input class="form-check-input" type="checkbox" data-select="${s.id}"
             ${selected.has(s.id) ? "checked" : ""}
             aria-label="Select ${escapeHtml(s.studentName)}">`
        : "";
      return `
      <tr class="${selected.has(s.id) ? "table-active" : ""}">
        <td class="check-col">${checkbox}</td>
        <td class="code-cell">${escapeHtml(s.studentId)}</td>
        <td>
          ${escapeHtml(s.studentName)}${statusBadge(s, escapeHtml)}
          ${s.statusNote ? `<div class="small text-secondary">${escapeHtml(s.statusNote)}</div>` : ""}
          ${s.email ? `<div class="small text-secondary">${escapeHtml(s.email)}</div>` : ""}
          ${locked ? `<div class="small text-secondary"><i class="bi bi-lock me-1" aria-hidden="true"></i>${note}</div>` : ""}
        </td>
        <td>${escapeHtml(s.schoolYear)}</td>
        <td>${escapeHtml(s.yearLevel)}</td>
        <td><span class="badge badge-count">${escapeHtml(s.sectionName)}</span></td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-record="${s.id}" title="Permanent record: every school year and term"><i class="bi bi-journal-text me-1"></i>Record</button>
          <button class="btn btn-sm btn-outline-secondary ms-1" data-edit="${s.id}"><i class="bi bi-pencil me-1"></i>Edit</button>
          ${
            locked
              ? `<span class="d-inline-block ms-1" tabindex="0" title="${note}. Remove them from those assignments first.">
                 <button class="btn btn-sm btn-outline-danger" disabled style="pointer-events:none"><i class="bi bi-trash me-1"></i>Delete</button>
               </span>`
              : `<button class="btn btn-sm btn-outline-danger ms-1" data-delete="${s.id}"><i class="bi bi-trash me-1"></i>Delete</button>`
          }
        </td>
      </tr>`;
    })
    .join("");
  updateBulkUI();
}

// ----- Cascading dropdowns: School Year → Year Level → Section -----
// Used by both the single-student form and the bulk change-section form.
function makeCascade(yearEl, levelEl, sectionEl) {
  function fillYears(sel = "") {
    const years = [...new Set(sections.map((s) => s.schoolYear))].sort((a, b) =>
      compareText(b, a),
    );
    yearEl.innerHTML =
      `<option value="">Select school year</option>` +
      years
        .map(
          (y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`,
        )
        .join("");
    yearEl.value = years.includes(sel) ? sel : "";
  }
  function fillLevels(sel = "") {
    const year = yearEl.value;
    const levels = YEAR_LEVELS.filter((l) =>
      sections.some((s) => s.schoolYear === year && s.yearLevel === l),
    );
    levelEl.innerHTML =
      `<option value="">Select year level</option>` +
      levels.map((l) => `<option value="${l}">${l}</option>`).join("");
    levelEl.disabled = !year;
    levelEl.value = levels.includes(sel) ? sel : "";
  }
  function fillSections(sel = "") {
    const year = yearEl.value;
    const level = levelEl.value;
    const list = sections
      .filter((s) => s.schoolYear === year && s.yearLevel === level)
      .sort((a, b) => compareText(a.sectionName, b.sectionName));
    sectionEl.innerHTML =
      `<option value="">Select section</option>` +
      list
        .map(
          (s) =>
            `<option value="${s.id}">${escapeHtml(s.sectionName)}</option>`,
        )
        .join("");
    sectionEl.disabled = !level;
    sectionEl.value = list.some((s) => s.id === sel) ? sel : "";
  }
  yearEl.addEventListener("change", () => {
    fillLevels();
    fillSections();
  });
  levelEl.addEventListener("change", () => fillSections());

  return {
    set(year = "", level = "", sectionId = "") {
      fillYears(year);
      fillLevels(level);
      fillSections(sectionId);
    },
    selected: () => sections.find((s) => s.id === sectionEl.value),
    validate() {
      let ok = true;
      if (!yearEl.value) {
        fieldError(yearEl, "Select a school year.");
        ok = false;
      }
      if (!levelEl.value) {
        fieldError(levelEl, "Select a year level.");
        ok = false;
      }
      if (!sectionEl.value) {
        fieldError(sectionEl, "Select a section.");
        ok = false;
      }
      return ok;
    },
  };
}

// ----- Selection and bulk bar -----
function updateBulkUI() {
  if (!bulkReady) return;
  const visible = visibleRows();
  const checkedVisible = visible.filter((s) => selected.has(s.id)).length;

  els.selectAll.disabled = visible.length === 0;
  els.selectAll.checked =
    visible.length > 0 && checkedVisible === visible.length;
  els.selectAll.indeterminate =
    checkedVisible > 0 && checkedVisible < visible.length;

  // Delete only applies to selected students without grading assignments
  const lockedCount = [...selected].filter(isLocked).length;
  const deletable = selected.size - lockedCount;
  els.bulkBar.classList.toggle("d-none", selected.size === 0);
  els.bulkCount.textContent =
    `${plural(selected.size, "student")} selected` +
    (lockedCount
      ? ` (${lockedCount} in a grading assignment, can't be deleted)`
      : "");
  els.btnBulkDelete.disabled = deletable === 0;
  els.btnBulkDelete.innerHTML =
    `<i class="bi bi-trash me-1"></i>Delete selected` +
    (lockedCount && deletable ? ` (${deletable})` : "");
  els.btnBulkDelete.title =
    deletable === 0 ? "Students in a grading assignment can't be deleted." : "";
}

function toggleSelectAll() {
  const visible = visibleRows();
  if (els.selectAll.checked) visible.forEach((s) => selected.add(s.id));
  else visible.forEach((s) => selected.delete(s.id));
  render();
}

function clearSelection() {
  selected.clear();
  render();
}

// Re-reads grading assignments right before a bulk delete, so nobody
// added to an assignment in the meantime gets deleted.
async function splitByFreshLock(list) {
  const fresh = countAssignments(await getDocs(assignmentsCol));
  const allowed = list.filter((s) => !fresh.get(s.id));
  return { allowed, blocked: list.length - allowed.length };
}

// ----- Bulk change of school year / year level / section -----
function openBulkForm() {
  const chosen = students.filter((s) => selected.has(s.id));
  if (!chosen.length) return;

  clearErrors(els.bulkForm);
  els.bulkError.classList.add("d-none");
  els.bulkModalTitle.textContent = `Change section of ${plural(chosen.length, "student")}`;
  els.bulkNames.innerHTML = chosen
    .map(
      (s) => `<li>${escapeHtml(s.studentId)} – ${escapeHtml(s.studentName)}
      <span class="text-secondary">(${escapeHtml(s.sectionName)}, ${escapeHtml(s.yearLevel)}, ${escapeHtml(s.schoolYear)})</span></li>`,
    )
    .join("");

  // If everyone shares a school year / year level, start from it
  const first = chosen[0];
  const sameYear = chosen.every((s) => s.schoolYear === first.schoolYear);
  const sameLevel =
    sameYear && chosen.every((s) => s.yearLevel === first.yearLevel);
  bulkCascade.set(
    sameYear ? first.schoolYear : "",
    sameLevel ? first.yearLevel : "",
    "",
  );
  bulkModal.show();
}

async function bulkSave(e) {
  e.preventDefault();
  clearErrors(els.bulkForm);
  els.bulkError.classList.add("d-none");
  if (!bulkCascade.validate()) return;
  const section = bulkCascade.selected();
  if (!section) return;

  const chosen = students.filter((s) => selected.has(s.id));
  const targets = chosen.filter((s) => s.sectionId !== section.id);
  const already = chosen.length - targets.length;
  if (!targets.length) {
    els.bulkError.textContent = `All selected students are already in ${sectionLabel(section)}.`;
    els.bulkError.classList.remove("d-none");
    return;
  }

  setBusy(els.btnBulkSave, true);
  try {
    const patch = {
      schoolYear: section.schoolYear,
      yearLevel: section.yearLevel,
      sectionId: section.id,
      sectionName: section.sectionName,
      updatedAt: serverTimestamp(),
    };
    await commitOperations(
      targets.map((s) => ({
        type: "update",
        ref: doc(db, "students", s.id),
        data: patch,
      })),
    );
    bulkModal.hide();
    const note = await moveInAssignments(
      targets.map((s) => ({ id: s.id, name: s.studentName, fromSectionId: s.sectionId, fromSchoolYear: s.schoolYear, to: section })),
    ).catch((err) => ` Grading assignments weren't changed: ${errorMessage(err)}`);
    toast(
      `${plural(targets.length, "student")} moved to ${sectionLabel(section)}.` +
        (already ? ` (${already} already in that section)` : "") + note,
    );
    selected.clear();
    await loadAll();
  } catch (err) {
    els.bulkError.textContent = errorMessage(err);
    els.bulkError.classList.remove("d-none");
  } finally {
    setBusy(els.btnBulkSave, false);
  }
}

// ----- Duplicate students: find and merge -----
let dupModal = null;
const studentLine = (s) => `${escapeHtml(s.studentId)} – ${escapeHtml(s.studentName)} <span class="text-secondary">(${escapeHtml(s.sectionName)}, ${escapeHtml(s.schoolYear)})</span>${statusBadge(s, escapeHtml)}`;

function openDuplicates() {
  dupModal = dupModal || new bootstrap.Modal($("dupModal"));
  const groups = duplicateGroups(students);
  $("dupList").innerHTML = groups.length
    ? groups.map((g, gi) => `
      <div class="border rounded p-2 mb-2" data-group="${gi}">
        ${g.map((s, i) => `<div class="form-check">
          <input class="form-check-input" type="radio" name="keep-${gi}" id="keep-${gi}-${i}" value="${escapeHtml(s.id)}" ${i === 0 ? "checked" : ""}>
          <label class="form-check-label" for="keep-${gi}-${i}">Keep ${studentLine(s)}${assignmentCount.get(s.id) ? ` <span class="small text-secondary">· ${assignmentCount.get(s.id)} class${assignmentCount.get(s.id) === 1 ? "" : "es"}</span>` : ""}</label>
        </div>`).join("")}
        <div class="text-end"><button type="button" class="btn btn-sm btn-outline-primary" data-merge="${gi}"><i class="bi bi-intersect me-1"></i>Merge into the one to keep</button></div>
      </div>`).join("")
    : `<div class="empty-state"><i class="bi bi-check2-circle text-success me-1"></i>No duplicate students found.</div>`;
  $("dupList").dataset.groups = JSON.stringify(groups.map((g) => g.map((s) => s.id)));
  dupModal.show();
}

async function mergeGroup(gi) {
  const ids = JSON.parse($("dupList").dataset.groups || "[]")[gi] || [];
  const keepId = ($(`dupList`).querySelector(`input[name="keep-${gi}"]:checked`) || {}).value;
  const keep = students.find((s) => s.id === keepId);
  const drops = ids.filter((id) => id !== keepId).map((id) => students.find((s) => s.id === id)).filter(Boolean);
  if (!keep || !drops.length) return;
  dupModal.hide();
  try {
    // Read fresh: every class and grade of these records
    const [aSnap, ...gSnaps] = await Promise.all([
      getDocs(assignmentsCol),
      ...[keep, ...drops].map((s) => getDocs(query(collection(db, "grades"), where("studentId", "==", s.id)))),
    ]);
    let assignments = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const grades = gSnaps.flatMap((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const plans = [];
    for (const drop of drops) {
      const plan = planMerge(keep, drop, assignments, grades);
      plans.push(plan);
      // later merges see this one's classes
      plan.ops.filter((o) => o.path.startsWith("gradingAssignments/")).forEach((o) => {
        const a = assignments.find((x) => `gradingAssignments/${x.id}` === o.path);
        if (a) a.studentIds = o.data.studentIds;
      });
      grades.forEach((g) => { if (g.studentId === drop.id) g.studentId = keep.id; });
    }
    const moved = plans.reduce((n, p) => n + p.moved, 0);
    const conflicts = plans.flatMap((p) => p.conflicts);
    const ok = await confirmDialog({
      title: `Merge into ${keep.studentName}?`,
      message: `Keep: ${keep.studentId} – ${keep.studentName} (${keep.sectionName})\n` +
        drops.map((d) => `Remove: ${d.studentId} – ${d.studentName} (${d.sectionName})`).join("\n") +
        `\n\n• ${moved} grade${moved === 1 ? "" : "s"} move to the kept record, and its classes are updated.` +
        (conflicts.length ? `\n• Both records have a grade in ${conflicts.length} class${conflicts.length === 1 ? "" : "es"}; the kept record's grade stays:\n${conflicts.map((c) => `   ${c.subjectCode}: keeps ${c.keptGrade}, removes ${c.droppedGrade}`).join("\n")}` : "") +
        `\n\nThis can't be undone (the audit trail records it).`,
      confirmText: "Merge",
      variant: "warning",
    });
    if (!ok) { dupModal.show(); return; }
    // Paths → references; a grade moved twice in one merge is written once
    const ops = plans.flatMap((p) => p.ops).map((o) => {
      const [col, id] = o.path.split("/");
      return { type: o.type, ref: doc(db, col, id), ...(o.data ? { data: o.type === "update" ? { ...o.data, updatedAt: serverTimestamp() } : o.data } : {}) };
    });
    await commitOperations(ops);
    drops.forEach((d) => selected.delete(d.id));
    toast(`Merged into ${keep.studentName}: ${moved} grade${moved === 1 ? "" : "s"} moved` + (conflicts.length ? `, ${conflicts.length} duplicate grade${conflicts.length === 1 ? "" : "s"} removed` : "") + ".");
    await loadAll();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

// ----- Permanent record (transcript) -----
let recordModal = null;
async function openRecord(id) {
  const s = students.find((x) => x.id === id);
  if (!s || !$("recordModal")) return;
  recordModal = recordModal || new bootstrap.Modal($("recordModal"));
  $("recordModalTitle").textContent = `Permanent record: ${s.studentName}`;
  $("recordNote").textContent = "Loading grades…";
  $("btnRecordPrint").disabled = true;
  $("recordFrame").srcdoc = "";
  recordModal.show();
  try {
    const [gSnap, school] = await Promise.all([
      getDocs(query(collection(db, "grades"), where("studentId", "==", id))),
      getSchool().catch(() => ({})),
    ]);
    const t = buildTranscript(gSnap.docs.map((d) => d.data()));
    $("recordFrame").srcdoc = transcriptHtml(s, t, school);
    $("recordNote").textContent = `${t.periods.length} term${t.periods.length === 1 ? "" : "s"} · ${t.units} units counted`;
    $("btnRecordPrint").disabled = false;
  } catch (err) {
    $("recordNote").textContent = errorMessage(err);
  }
}

// ----- Bulk status (dropped, graduated, ...) -----
let statusModal = null;
function openStatusForm() {
  const chosen = students.filter((s) => selected.has(s.id));
  if (!chosen.length) return;
  $("statusModalTitle").textContent = `Set status of ${plural(chosen.length, "student")}`;
  $("statusNames").innerHTML = chosen
    .map((s) => `<li>${escapeHtml(s.studentId)} – ${escapeHtml(s.studentName)} <span class="text-secondary">(${escapeHtml(STATUSES[statusOf(s)])})</span></li>`)
    .join("");
  const first = statusOf(chosen[0]);
  $("bulkStatus").value = chosen.every((s) => statusOf(s) === first) ? first : "";
  $("bulkStatusNote").value = "";
  statusModal.show();
}

async function statusSave(e) {
  e.preventDefault();
  const status = $("bulkStatus").value in STATUSES ? $("bulkStatus").value : "";
  const statusNote = status ? $("bulkStatusNote").value.trim().replace(/\s+/g, " ") : "";
  const targets = students.filter((s) => selected.has(s.id));
  if (!targets.length) return;
  setBusy($("btnStatusSave"), true);
  try {
    await commitOperations(targets.map((s) => ({
      type: "update",
      ref: doc(db, "students", s.id),
      data: { status, statusNote, updatedAt: serverTimestamp() },
    })));
    statusModal.hide();
    toast(`${plural(targets.length, "student")} set to ${STATUSES[status]}.` +
      (hasLeft({ status }) ? " Their saved grades are kept; they get no new grades." : ""));
    selected.clear();
    await loadAll();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy($("btnStatusSave"), false);
  }
}

async function bulkDelete() {
  const chosen = students.filter((s) => selected.has(s.id));
  const targets = chosen.filter((s) => !isLocked(s.id));
  const lockedCount = chosen.length - targets.length;
  if (!targets.length) {
    toast(
      "The selected students are in grading assignments and can't be deleted.",
      "warning",
    );
    return;
  }

  const ok = await confirmDialog({
    title: `Delete ${plural(targets.length, "student")}?`,
    message:
      `${plural(targets.length, "student")} will be removed permanently.` +
      (lockedCount
        ? ` ${lockedCount} in a grading assignment will be kept.`
        : ""),
    confirmText: "Delete students",
  });
  if (!ok) return;

  setBusy(els.btnBulkDelete, true);
  try {
    const { allowed, blocked } = await splitByFreshLock(targets);
    for (let i = 0; i < allowed.length; i += 20) {
      await Promise.all(
        allowed
          .slice(i, i + 20)
          .map((s) => deleteDoc(doc(db, "students", s.id))),
      );
    }
    const kept = lockedCount + blocked;
    toast(
      `${plural(allowed.length, "student")} deleted.` +
        (kept ? ` ${kept} kept because they are in a grading assignment.` : ""),
      kept ? "warning" : undefined,
    );
    selected.clear();
    await loadAll();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnBulkDelete, false);
  }
}

// ----- Single student add / edit -----
function openForm(student = null) {
  editingId = student ? student.id : null;
  clearErrors(els.form);
  els.formError.classList.add("d-none");
  els.modalTitle.textContent = student ? "Edit student" : "Add student";
  els.studentId.value = student?.studentId ?? "";
  els.studentName.value = student?.studentName ?? "";
  els.email.value = student?.email ?? "";
  if (els.status) {
    els.status.value = statusOf(student);
    els.statusNote.value = student?.statusNote ?? "";
  }

  // Pre-fill from the current section filter when adding
  const preset = student
    ? sections.find((s) => s.id === student.sectionId)
    : sections.find((s) => s.id === els.filterSection.value);
  const next = nextStudentNumbers(
    students.map((s) => s.studentId),
    1,
    preset?.schoolYear || "",
  )[0];
  els.studentId.placeholder = student ? "" : `Next: ${next}`;
  $("studentIdHelp").textContent = student
    ? "Each student needs a unique Student ID."
    : `Leave blank to use the next number after the last one in the system (${next}).`;
  formCascade.set(
    preset?.schoolYear ?? "",
    preset?.yearLevel ?? "",
    preset?.id ?? "",
  );
  modal.show();
}

function readForm() {
  clearErrors(els.form);
  const data = {
    studentId: els.studentId.value.trim(),
    studentName: els.studentName.value.trim().replace(/\s+/g, " "),
    email: els.email.value.trim().toLowerCase(),
  };
  if (els.status) {
    data.status = els.status.value in STATUSES ? els.status.value : "";
    data.statusNote = data.status ? els.statusNote.value.trim().replace(/\s+/g, " ") : "";
  }
  let ok = true;
  if (!data.studentId && editingId) {
    fieldError(els.studentId, "Enter a student ID.");
    ok = false;
  }
  if (!data.studentName) {
    fieldError(els.studentName, "Enter the student's name.");
    ok = false;
  }
  if (data.email && !isValidEmail(data.email)) {
    fieldError(els.email, "Enter a valid email address, or leave it empty.");
    ok = false;
  }
  if (!formCascade.validate()) ok = false;
  const section = formCascade.selected();
  if (!ok || !section) return null;

  return {
    ...data,
    schoolYear: section.schoolYear,
    yearLevel: section.yearLevel,
    sectionId: section.id,
    sectionName: section.sectionName,
  };
}

async function save(e) {
  e.preventDefault();
  const data = readForm();
  if (!data) return;

  setBusy(els.btnSave, true);
  els.formError.classList.add("d-none");
  try {
    if (!data.studentId) {
      // Next number after the last student no in the system (read fresh)
      const all = await getDocs(studentsCol);
      data.studentId = nextStudentNumbers(
        all.docs.map((d) => d.data().studentId),
        1,
        data.schoolYear,
      )[0];
    }
    const dup = await getDocs(
      query(studentsCol, where("studentId", "==", data.studentId)),
    );
    if (dup.docs.some((d) => d.id !== editingId)) {
      fieldError(els.studentId, `Student ID ${data.studentId} already exists.`);
      return;
    }
    // The same person entered twice? (same surname and first name, ignoring accents and capitals)
    const prev = editingId ? students.find((s) => s.id === editingId) : null;
    const twins = !prev || prev.studentName !== data.studentName ? similarStudents(data.studentName, students, editingId) : [];
    if (twins.length) {
      modal.hide();
      const go = await confirmDialog({
        title: "Possible duplicate student",
        message: `This looks like a student already in the system:\n${twins.map((t) => `• ${t.studentId} – ${t.studentName} (${t.sectionName}, ${t.schoolYear})`).join("\n")}\n\nSave anyway? If it's the same person, cancel and edit the existing record instead (or use Find duplicates to merge).`,
        confirmText: "Save anyway",
        cancelText: "Go back",
        variant: "warning",
      });
      if (!go) { modal.show(); return; }
    }

    if (editingId) {
      const before = students.find((s) => s.id === editingId);
      await updateDoc(doc(db, "students", editingId), {
        ...data,
        updatedAt: serverTimestamp(),
      });
      if (
        before.studentId !== data.studentId ||
        before.studentName !== data.studentName
      ) {
        // Grades keep a copy of the student's number and name
        const gSnap = await getDocs(
          query(collection(db, "grades"), where("studentId", "==", editingId)),
        );
        const patch = {
          studentNumber: data.studentId,
          studentName: data.studentName,
          updatedAt: serverTimestamp(),
        };
        await commitOperations(
          gSnap.docs.map((d) => ({ type: "update", ref: d.ref, data: patch })),
        );
      }
      let note = "";
      if (before.sectionId !== data.sectionId) {
        modal.hide();
        note = await moveInAssignments([{
          id: editingId, name: data.studentName, fromSectionId: before.sectionId, fromSchoolYear: before.schoolYear,
          to: sections.find((s) => s.id === data.sectionId),
        }]).catch((err) => ` Grading assignments weren't changed: ${errorMessage(err)}`);
      }
      toast(`Student updated.${note}`);
    } else {
      await addDoc(studentsCol, {
        ...data,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      toast(`Student added with Student ID ${data.studentId}.`);
    }
    modal.hide();
    await loadAll();
  } catch (err) {
    els.formError.textContent = errorMessage(err);
    els.formError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

async function remove(id) {
  const s = students.find((x) => x.id === id);
  if (!s) return;
  try {
    const used = await getDocs(
      query(assignmentsCol, where("studentIds", "array-contains", id)),
    );
    if (!used.empty) {
      toast(
        `${s.studentName} is in ${used.size} grading assignment(s), so they can't be deleted. If the student dropped or transferred out, click Edit and set their Status instead: their grades are kept.`,
        "warning",
      );
      await loadAll();
      return;
    }
    const ok = await confirmDialog({
      title: "Delete student?",
      message: `${s.studentId} – ${s.studentName} will be removed permanently.`,
      confirmText: "Delete student",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "students", id));
    selected.delete(id);
    toast("Student deleted.");
    await loadAll();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

function init() {
  modal = new bootstrap.Modal(els.modalEl);
  formCascade = makeCascade(els.schoolYear, els.yearLevel, els.section);
  els.modalEl.addEventListener("shown.bs.modal", () => els.studentId.focus());
  els.btnAdd.addEventListener("click", () => openForm());
  els.form.addEventListener("submit", save);
  els.search.addEventListener("input", render);
  els.filterSection.addEventListener("change", render);
  els.filterStatus?.addEventListener("change", render);
  $("btnPasteList")?.addEventListener("click", pasteList);
  $("btnFindDups")?.addEventListener("click", openDuplicates);
  $("dupList")?.addEventListener("click", (e) => { const b = e.target.closest("[data-merge]"); if (b) mergeGroup(Number(b.dataset.merge)); });
  $("btnRecordPrint")?.addEventListener("click", () => { const w = $("recordFrame").contentWindow; w.focus(); w.print(); });
  $("listFilterNote")?.addEventListener("click", (e) => {
    if (!e.target.closest("#btnClearList")) return;
    listFilter = null;
    listMissing = [];
    render();
  });
  if ($("statusModal") && $("btnBulkStatus")) {
    statusModal = new bootstrap.Modal($("statusModal"));
    $("btnBulkStatus").addEventListener("click", openStatusForm);
    $("statusForm").addEventListener("submit", statusSave);
  }

  // Bulk actions (skipped if students.html doesn't have the bulk elements)
  const missing = BULK_IDS.filter((id) => !$(id));
  bulkReady = missing.length === 0;
  if (!bulkReady) {
    console.warn(
      "Bulk actions are off. Missing in students.html:",
      missing.join(", "),
    );
  } else {
    bulkModal = new bootstrap.Modal(els.bulkModalEl);
    bulkCascade = makeCascade(
      els.bulkSchoolYear,
      els.bulkYearLevel,
      els.bulkSection,
    );
    els.bulkModalEl.addEventListener("shown.bs.modal", () =>
      els.bulkSchoolYear.focus(),
    );
    els.selectAll.addEventListener("change", toggleSelectAll);
    els.btnBulkMove.addEventListener("click", openBulkForm);
    els.btnBulkDelete.addEventListener("click", bulkDelete);
    els.btnBulkClear.addEventListener("click", clearSelection);
    els.bulkForm.addEventListener("submit", bulkSave);
  }

  els.tbody.addEventListener("change", (e) => {
    const box = e.target.closest("[data-select]");
    if (!box || box.disabled) return;
    if (box.checked) selected.add(box.dataset.select);
    else selected.delete(box.dataset.select);
    box.closest("tr").classList.toggle("table-active", box.checked);
    updateBulkUI();
  });
  els.tbody.addEventListener("click", (e) => {
    const recBtn = e.target.closest("[data-record]");
    if (recBtn) openRecord(recBtn.dataset.record);
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");
    if (editBtn) openForm(students.find((s) => s.id === editBtn.dataset.edit));
    if (delBtn) remove(delBtn.dataset.delete);
  });

  setupStudentImport({
    getSections: () => sections,
    getStudents: () => students,
    onImported: loadAll,
  });
  loadAll();
}

initLayout("students").then((user) => {
  if (user) init(user);
  else
    tableMessage(
      els.tbody,
      COLS,
      "Connect Firebase and sign in to load students.",
    );
});
