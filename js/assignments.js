// ==========================================================
// assignments.js — Grading assignments (collection: gradingAssignments)
// Teacher + Subject + School Year + Year Level + Section + Students
// ==========================================================

import {
  db, collection, doc, addDoc, getDoc, getDocs, query, where,
  serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy, compareText,
  tableLoading, tableMessage, errorMessage, commitOperations, formatUnits, YEAR_LEVELS,
  subjectTakers, searchPicker, getOptions,
} from "./app.js";
import { combinedGroups, combineKey, combineOn } from "./combined.js";
import { programOf, curriculumId, planFromCurriculum } from "./curriculum-core.js";
import { isAttending, statusBadge } from "./student-status.js";
import { TERMS, termOf, yearTermText } from "./terms.js";
import { openNameList } from "./name-list.js";
import { moveInAssignments } from "./section-move.js";
import { studentFixes, planKeep, defaultKeep } from "./dup-classes.js";
import { gradeText } from "./grading-scale.js";

const assignmentsCol = collection(db, "gradingAssignments");

const els = {
  teacher: document.getElementById("teacherSelect"),
  subject: document.getElementById("subjectSelect"),
  subjectInfo: document.getElementById("subjectInfo"),
  year: document.getElementById("yearSelect"),
  term: document.getElementById("termSelect"),
  filterTerm: document.getElementById("filterTerm"),
  level: document.getElementById("levelSelect"),
  section: document.getElementById("sectionSelect"),
  studentList: document.getElementById("studentList"),
  otherStudent: document.getElementById("otherStudent"),
  btnPasteList: document.getElementById("btnPasteList"),
  selectedCount: document.getElementById("selectedCount"),
  btnSelectAll: document.getElementById("btnSelectAll"),
  btnDeselectAll: document.getElementById("btnDeselectAll"),
  btnSave: document.getElementById("btnSaveAssignment"),
  btnCancelEdit: document.getElementById("btnCancelEdit"),
  formTitle: document.getElementById("formTitle"),
  editNote: document.getElementById("editNote"),
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  dupWarning: document.getElementById("dupWarning"),
  studentSearch: document.getElementById("studentSearch"),
  sectionAssigned: document.getElementById("sectionAssigned"),
  filterYear: document.getElementById("filterYear"),
  filterSection: document.getElementById("filterSection"),
  filterTeacher: document.getElementById("filterTeacher"),
};

let teachers = [];
let subjects = [];
let sections = [];
let assignments = [];
let sectionStudents = []; // students shown in the checklist
let selected = new Set(); // student document ids
const yearStudents = new Map(); // school year -> its students (for "Add a student from another section")
let editing = null; // assignment being edited

// ---------- Loading reference data ----------
async function loadReferenceData() {
  const [tSnap, subSnap, secSnap] = await Promise.all([
    getDocs(collection(db, "teachers")),
    getDocs(collection(db, "subjects")),
    getDocs(collection(db, "sections")),
  ]);
  teachers = tSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.teacherName, b.teacherName));
  subjects = subSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.subjectCode, b.subjectCode));
  sections = secSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  els.teacher.innerHTML =
    `<option value="">${teachers.length ? "Select teacher" : "No teachers yet. Add one on the Teachers page."}</option>` +
    teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.teacherName)} (${escapeHtml(t.teacherId)})</option>`).join("");

  els.subject.innerHTML =
    `<option value="">${subjects.length ? "Select subject" : "No subjects yet. Add one on the Subjects page."}</option>` +
    subjects
      .map((s) => `<option value="${s.id}">${escapeHtml(s.subjectCode)} - ${escapeHtml(s.subjectName)} (${escapeHtml(formatUnits(s.units))})</option>`)
      .join("");

  const years = [...new Set(sections.map((s) => s.schoolYear))].sort((a, b) => compareText(b, a));
  els.year.innerHTML =
    `<option value="">${years.length ? "Select school year" : "No sections yet. Add one on the Sections page."}</option>` +
    years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
}

async function loadAssignments() {
  tableLoading(els.tbody, 8);
  try {
    const snap = await getDocs(assignmentsCol);
    assignments = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort(
        (a, b) =>
          compareText(b.schoolYear, a.schoolYear) ||
          compareText(a.sectionName, b.sectionName) ||
          compareText(a.subjectCode, b.subjectCode)
      );
    fillListFilters();
    renderAssignments();
  } catch (err) {
    tableMessage(els.tbody, 8, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

// ---------- Cascading selects ----------
function showSubjectInfo() {
  const s = subjects.find((x) => x.id === els.subject.value);
  if (!s) {
    els.subjectInfo.classList.add("d-none");
    return;
  }
  els.subjectInfo.innerHTML = `
    <div><span class="text-secondary">Subject code:</span> <strong>${escapeHtml(s.subjectCode)}</strong></div>
    <div><span class="text-secondary">Subject name:</span> <strong>${escapeHtml(s.subjectName)}</strong></div>
    <div><span class="text-secondary">Units:</span> <strong>${escapeHtml(formatUnits(s.units))}</strong></div>`;
  els.subjectInfo.classList.remove("d-none");
}

function fillLevels(selectedLevel = "") {
  const year = els.year.value;
  const levels = YEAR_LEVELS.filter((l) => sections.some((s) => s.schoolYear === year && s.yearLevel === l));
  els.level.innerHTML =
    `<option value="">Select year level</option>` + levels.map((l) => `<option value="${l}">${l}</option>`).join("");
  els.level.disabled = !year;
  els.level.value = levels.includes(selectedLevel) ? selectedLevel : "";
}

function fillSections(selectedId = "") {
  const list = sections
    .filter((s) => s.schoolYear === els.year.value && s.yearLevel === els.level.value)
    .sort((a, b) => compareText(a.sectionName, b.sectionName));
  els.section.innerHTML =
    `<option value="">Select section</option>` +
    list.map((s) => `<option value="${s.id}">${escapeHtml(s.sectionName)}</option>`).join("");
  els.section.disabled = !els.level.value;
  els.section.value = list.some((s) => s.id === selectedId) ? selectedId : "";
}

// ---------- What the chosen section already has ----------
/** The term chosen in the form ("" = no term). */
const formTerm = () => (els.term && TERMS.includes(els.term.value) ? els.term.value : "");
const sectionAssignments = () =>
  assignments.filter((a) => a.sectionId === els.section.value && a.schoolYear === els.year.value && termOf(a) === formTerm())
    .sort((a, b) => compareText(a.subjectCode, b.subjectCode));

/** "Already assigned to BSC 1A": each subject with its teacher, and an Edit button. */
function renderSectionAssigned() {
  const list = els.section.value ? sectionAssignments() : [];
  els.sectionAssigned.classList.toggle("d-none", !els.section.value);
  if (!els.section.value) return;
  const name = sections.find((s) => s.id === els.section.value)?.sectionName || "this section";
  els.sectionAssigned.innerHTML = list.length
    ? `<div class="small text-secondary mt-2 mb-1">Already assigned to ${escapeHtml(name)}${formTerm() ? `, ${escapeHtml(formTerm())}` : ""} (${list.length}):</div>
       <div class="d-flex flex-wrap gap-1">${list.map((a) => `<button type="button" class="btn btn-sm btn-light border py-0" data-edit="${a.id}" title="Edit: ${escapeHtml(a.teacherName)}, ${(a.studentIds || []).length} students"><span class="fw-semibold">${escapeHtml(a.subjectCode || a.subjectName)}</span> <span class="text-secondary">${escapeHtml(a.teacherName)}</span></button>`).join("")}</div>`
    : `<div class="small text-secondary mt-2">No subjects assigned to ${escapeHtml(name)}${formTerm() ? ` for the ${escapeHtml(formTerm())}` : ""} yet.</div>`;
}

/** Marks subjects the chosen section already has ("✓ assigned · teacher"). */
function refreshSubjectOptions() {
  const have = new Map();
  if (els.section.value) sectionAssignments().forEach((a) => { if (!have.has(a.subjectId)) have.set(a.subjectId, a); });
  [...els.subject.options].forEach((o) => {
    const s = subjects.find((x) => x.id === o.value);
    if (!s) return;
    const a = have.get(s.id);
    o.textContent = `${s.subjectCode} - ${s.subjectName} (${formatUnits(s.units)})${a ? `  ✓ assigned · ${a.teacherName}` : ""}`;
  });
}

// ---------- Students checklist ----------
async function loadSectionStudents() {
  const sectionId = els.section.value;
  sectionStudents = [];
  if (!editing) selected = new Set();

  if (!sectionId) {
    els.studentList.innerHTML = `<div class="empty-state">No section selected yet.</div>`;
    updateSelectionUi();
    fillOtherStudents();
    return;
  }

  els.studentList.innerHTML = `<div class="empty-state"><span class="spinner-border spinner-border-sm me-2"></span>Loading students…</div>`;
  els.studentSearch.value = "";
  try {
    // Students that belong to School Year + Year Level + Section
    const snap = await getDocs(
      query(
        collection(db, "students"),
        where("schoolYear", "==", els.year.value),
        where("yearLevel", "==", els.level.value),
        where("sectionId", "==", sectionId)
      )
    );
    sectionStudents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Editing, same section: keep students from other sections (irregular, or moved since)
    const sameSection = !!editing && sectionId === editing.sectionId && els.year.value === editing.schoolYear;
    if (sameSection) {
      const missing = editing.studentIds.filter((id) => !sectionStudents.some((s) => s.id === id));
      const extra = await Promise.all(missing.map((id) => getDoc(doc(db, "students", id))));
      extra.filter((d) => d.exists()).forEach((d) => sectionStudents.push({ id: d.id, ...d.data(), other: true }));
    }
    sectionStudents.sort((a, b) => compareText(a.studentName, b.studentName));
    // New assignment, or an assignment moved to another section: start with the whole section ticked
    // (students who already take the subject, dropped, transferred out or graduated are left out)
    selected = sameSection ? new Set(editing.studentIds || []) : new Set(sectionStudents.filter(isAttending).map((s) => s.id));
    fillOtherStudents();
    renderStudents();
  } catch (err) {
    els.studentList.innerHTML = `<div class="empty-state text-danger">${escapeHtml(errorMessage(err))}</div>`;
  }
}

// ---------- Irregular students: from another section of the same school year ----------
async function loadYearStudents(year) {
  if (!yearStudents.has(year)) {
    const snap = await getDocs(query(collection(db, "students"), where("schoolYear", "==", year)));
    yearStudents.set(year, snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.studentName, b.studentName)));
  }
  return yearStudents.get(year);
}

// ---------- Paste a list (the teacher's masterlist): tick those students ----------
async function pasteList() {
  if (!els.section.value) return;
  const year = els.year.value;
  const sectionName = sections.find((s) => s.id === els.section.value)?.sectionName || "this section";
  let pool;
  try {
    pool = [...await loadYearStudents(year)];
  } catch (err) {
    toast(errorMessage(err), "danger");
    return;
  }
  // Students already listed (e.g. from another school year's record) can be matched too
  sectionStudents.forEach((s) => { if (!pool.some((x) => x.id === s.id)) pool.push(s); });
  const inSection = (s) => sectionStudents.some((x) => x.id === s.id);
  openNameList({
    title: `Tick students from a list: ${sectionName}`,
    students: pool,
    describe: (s) => inSection(s) ? escapeHtml(s.sectionName) : `<span class="badge badge-none">other section: ${escapeHtml(s.sectionName)}</span>`,
    extraHtml: (results) => {
      const others = results.filter((r) => r.status === "found" && !inSection(r.student)).map((r) => r.student);
      return `<div class="form-check mb-2">
          <input class="form-check-input" type="checkbox" id="nameListOnly" checked>
          <label class="form-check-label" for="nameListOnly">Untick students who aren't on the list</label>
        </div>
        ${others.length ? `<div class="alert alert-warning py-2 small">
          <div class="fw-semibold mb-1">${others.length} student${others.length === 1 ? " is" : "s are"} on the list but in another section:</div>
          <div class="mb-2">${others.map((s) => `${escapeHtml(s.studentName)} <span class="text-secondary">(${escapeHtml(s.sectionName)})</span>`).join(", ")}</div>
          <div class="form-check"><input class="form-check-input" type="radio" name="listOther" id="listOtherMove" checked>
            <label class="form-check-label" for="listOtherMove"><strong>Change their section to ${escapeHtml(sectionName)}</strong> (their section is wrong; the masterlist is right)</label></div>
          <div class="form-check"><input class="form-check-input" type="radio" name="listOther" id="listOtherAdd">
            <label class="form-check-label" for="listOtherAdd">Keep their section; add them to this class only (irregular)</label></div>
        </div>` : ""}`;
    },
    applyText: (n) => `Tick ${n} student${n === 1 ? "" : "s"}`,
    onApply: (found, results, root) => {
      const others = found.filter((s) => !inSection(s));
      if (others.length && root.querySelector("#listOtherMove")?.checked) {
        // Change their section first (after this dialog closes, since it may ask about their grading assignments)
        root.addEventListener("hidden.bs.modal", () => fixSections(others, found, results, root.querySelector("#nameListOnly")?.checked), { once: true });
        return;
      }
      tickFound(found, results, root.querySelector("#nameListOnly")?.checked);
    },
  });

  /** The masterlist is right: move these students to the chosen section, then tick the list. */
  async function fixSections(others, found, results, only) {
    const section = sections.find((s) => s.id === els.section.value);
    if (!section) return;
    try {
      await commitOperations(others.map((s) => ({
        type: "update",
        ref: doc(db, "students", s.id),
        data: { schoolYear: section.schoolYear, yearLevel: section.yearLevel, sectionId: section.id, sectionName: section.sectionName, updatedAt: serverTimestamp() },
      })));
      const note = await moveInAssignments(
        others.map((s) => ({ id: s.id, name: s.studentName, fromSectionId: s.sectionId, fromSchoolYear: s.schoolYear, to: section })),
      ).catch((err) => ` Grading assignments weren't changed: ${errorMessage(err)}`);
      // Now they belong to this section
      const moved = new Map(others.map((s) => [s.id, { ...s, schoolYear: section.schoolYear, yearLevel: section.yearLevel, sectionId: section.id, sectionName: section.sectionName }]));
      yearStudents.delete(section.schoolYear);
      sectionStudents = sectionStudents.filter((s) => !moved.has(s.id));
      moved.forEach((s) => sectionStudents.push(s));
      const fresh = found.map((s) => moved.get(s.id) || s);
      // Grading assignments may have changed (the students joined this section's classes)
      const keep = { editing, selected: new Set(selected) };
      const snap = await getDocs(assignmentsCol);
      assignments = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) =>
        compareText(b.schoolYear, a.schoolYear) || compareText(a.sectionName, b.sectionName) || compareText(a.subjectCode, b.subjectCode));
      editing = keep.editing;
      selected = keep.selected;
      renderAssignments();
      tickFound(fresh, results, only, `${others.length} student${others.length === 1 ? "" : "s"} moved to ${section.sectionName}.${note}`);
    } catch (err) {
      toast(errorMessage(err), "danger");
    }
  }

  function tickFound(found, results, only, before = "") {
      const taken = takenHere();
      let added = 0;
      found.forEach((s) => {
        if (!inSection(s)) { sectionStudents.push({ ...s, other: true }); added++; }
      });
      sectionStudents.sort((a, b) => compareText(a.studentName, b.studentName));
      const ids = new Set(found.map((s) => s.id));
      if (only) [...selected].forEach((id) => { if (!ids.has(id)) selected.delete(id); });
      const blocked = found.filter((s) => taken.has(s.id) && !alreadyHere(s.id));
      found.forEach((s) => { if (!blocked.includes(s)) selected.add(s.id); });
      els.studentSearch.value = "";
      renderStudents();
      fillOtherStudents();
      const missing = results.filter((r) => r.status !== "found").length;
      toast(`${before ? `${before} ` : ""}${found.length - blocked.length} student${found.length - blocked.length === 1 ? "" : "s"} ticked` +
        (added ? `, ${added} from other sections added` : "") +
        (blocked.length ? `. ${blocked.length} already take${blocked.length === 1 ? "s" : ""} this subject (${blocked.map((s) => s.studentName).join(", ")})` : "") +
        (missing ? `. ${missing} name${missing === 1 ? "" : "s"} not matched` : "") + ". Save the assignment to keep it.", blocked.length || missing ? "warning" : "info");
  }
}

async function fillOtherStudents() {
  const box = els.otherStudent;
  if (!box) return;
  const year = els.year.value;
  const reset = (text) => { box.innerHTML = `<option value="">${escapeHtml(text)}</option>`; box.disabled = true; };
  if (!els.section.value || !year) return reset("+ Add a student from another section (irregular)");
  try {
    await loadYearStudents(year);
    if (els.year.value !== year) return; // changed while loading
    const here = new Set(sectionStudents.map((s) => s.id));
    const others = yearStudents.get(year).filter((s) => !here.has(s.id) && isAttending(s));
    box.innerHTML = `<option value="">+ Add a student from another section (irregular)</option>` +
      others.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(`${s.studentId} – ${s.studentName} (${s.sectionName}${s.status === "irregular" ? ", irregular" : ""})`)}</option>`).join("");
    box.disabled = !others.length;
  } catch {
    reset("+ Add a student from another section (irregular)");
  }
}

function addOtherStudent() {
  const id = els.otherStudent.value;
  if (!id) return;
  const s = (yearStudents.get(els.year.value) || []).find((x) => x.id === id);
  els.otherStudent.value = "";
  if (!s || sectionStudents.some((x) => x.id === id)) return;
  sectionStudents.push({ ...s, other: true });
  sectionStudents.sort((a, b) => compareText(a.studentName, b.studentName));
  if (!takenHere().has(id)) selected.add(id);
  renderStudents();
  fillOtherStudents();
  toast(takenHere().has(id) ? `${s.studentName} already takes this subject this school year, so they can't be added.` : `${s.studentName} (${s.sectionName}) added. Save the assignment to keep it.`, takenHere().has(id) ? "warning" : "info");
}

/**
 * Students in another grading assignment of the chosen subject, same school year.
 * When editing, students already in this assignment aren't blocked (only shown with a note),
 * so old duplicates are never removed by surprise.
 */
function takenHere() {
  if (!els.subject.value || !els.year.value) return new Map();
  return subjectTakers(assignments, els.subject.value, els.year.value, editing?.id, formTerm());
}
const alreadyHere = (id) =>
  !!editing && els.subject.value === editing.subjectId && els.year.value === editing.schoolYear && formTerm() === termOf(editing) &&
  (editing.studentIds || []).includes(id);
const takenNote = (a) => `Already takes ${a.subjectCode || a.subjectName} with ${a.teacherName}${a.sectionName ? ` (${a.sectionName})` : ""}`;

/** Students shown in the checklist (the "Find a student" box narrows it). */
function visibleStudents() {
  const term = normalize(els.studentSearch.value);
  return term ? sectionStudents.filter((s) => normalize(`${s.studentId} ${s.studentName}`).includes(term)) : sectionStudents;
}

function renderStudents() {
  const taken = takenHere();
  taken.forEach((_, id) => { if (!alreadyHere(id)) selected.delete(id); }); // a subject only once a school year
  els.studentSearch.disabled = !sectionStudents.length;
  if (!sectionStudents.length) {
    els.studentList.innerHTML = `<div class="empty-state">No students are enrolled in this section yet. <a href="students.html">Add students</a></div>`;
    updateSelectionUi();
    return;
  }
  const shown = visibleStudents();
  if (!shown.length) {
    els.studentList.innerHTML = `<div class="empty-state">No student matches “${escapeHtml(els.studentSearch.value)}”.</div>`;
    updateSelectionUi();
    return;
  }
  els.studentList.innerHTML = shown
    .map(
      (s) => `
      <label class="student-item${taken.has(s.id) && !alreadyHere(s.id) ? " text-secondary" : ""}" for="stu-${s.id}">
        <input class="form-check-input" type="checkbox" id="stu-${s.id}" value="${s.id}" ${selected.has(s.id) ? "checked" : ""} ${taken.has(s.id) && !alreadyHere(s.id) ? "disabled" : ""}>
        <span class="student-num">${escapeHtml(s.studentId)}</span>
        <span class="flex-grow-1">${escapeHtml(s.studentName)}${taken.has(s.id) ? `<div class="small${alreadyHere(s.id) ? " text-warning-emphasis" : ""}"><i class="bi ${alreadyHere(s.id) ? "bi-exclamation-triangle" : "bi-slash-circle"} me-1" aria-hidden="true"></i>${escapeHtml(takenNote(taken.get(s.id)))}${alreadyHere(s.id) ? " too: untick one of the two" : ""}</div>` : ""}</span>
        ${statusBadge(s, escapeHtml)}
        ${s.other ? `<span class="badge badge-none" title="Not in this section">${s.schoolYear === els.year.value ? "" : "Now in "}${escapeHtml(s.sectionName)}</span>` : ""}
      </label>`
    )
    .join("");
  updateSelectionUi();
}

function updateSelectionUi() {
  const total = sectionStudents.length;
  if (els.btnPasteList) els.btnPasteList.disabled = !els.section.value;
  const fc = document.getElementById("btnFromCurriculum");
  if (fc) { fc.disabled = !els.section.value || !!editing; fc.title = editing ? "Finish or cancel the edit first" : els.section.value ? "" : "Choose a school year, year level and section first"; }
  els.btnSelectAll.disabled = total === 0;
  els.btnDeselectAll.disabled = total === 0;
  els.selectedCount.textContent = els.section.value
    ? `${selected.size} of ${total} student${total === 1 ? "" : "s"} selected`
    : "Choose a section to load its students.";
}

// ---------- Save ----------
function validate() {
  const checks = [
    [els.teacher, "Select a teacher."],
    [els.subject, "Select a subject."],
    [els.year, "Select a school year."],
    [els.level, "Select a year level."],
    [els.section, "Select a section."],
  ];
  for (const [el, msg] of checks) {
    if (!el.value) {
      toast(msg, "warning");
      el.focus();
      return false;
    }
  }
  if (selected.size === 0) {
    toast("Select at least one student for this assignment.", "warning");
    return false;
  }
  return true;
}

async function saveAssignment() {
  if (!validate()) return;

  const teacher = teachers.find((t) => t.id === els.teacher.value);
  const subject = subjects.find((s) => s.id === els.subject.value);
  const section = sections.find((s) => s.id === els.section.value);
  // Keep student ids in a stable, readable order
  const studentIds = sectionStudents.filter((s) => selected.has(s.id)).map((s) => s.id);

  setBusy(els.btnSave, true);
  try {
    // Duplicate check: Teacher + Subject + School Year + Section
    const dup = await getDocs(
      query(
        assignmentsCol,
        where("teacherDocId", "==", teacher.id),
        where("subjectId", "==", subject.id),
        where("schoolYear", "==", els.year.value),
        where("sectionId", "==", section.id)
      )
    );
    if (dup.docs.some((d) => d.id !== editing?.id && termOf(d.data()) === formTerm())) {
      toast("This grading assignment already exists.", "danger");
      return;
    }

    // A student takes a subject only once a school year: not in two grading assignments
    // for the same subject (e.g. the same subject with another teacher or section). Read fresh.
    const same = await getDocs(query(assignmentsCol, where("subjectId", "==", subject.id), where("schoolYear", "==", els.year.value)));
    const taken = subjectTakers(same.docs.map((d) => ({ id: d.id, ...d.data() })), subject.id, els.year.value, editing?.id, formTerm());
    const when = yearTermText(els.year.value, formTerm());
    const clash = studentIds.filter((id) => taken.has(id) && !alreadyHere(id)); // newly added only
    if (clash.length) {
      const name = (id) => sectionStudents.find((s) => s.id === id)?.studentName || "A student";
      const lines = clash.map((id) => `• ${name(id)}: ${takenNote(taken.get(id))}`).join("\n");
      if (clash.length === studentIds.length) {
        await confirmDialog({
          title: "Already taking this subject",
          message: `Every selected student already takes ${subject.subjectCode} in ${when}:\n${lines}\n\nA student can take a subject only once a term (or once a school year when there's no term). Edit the existing grading assignment instead.`,
          confirmText: "OK",
          variant: "primary",
        });
        return;
      }
      const ok = await confirmDialog({
        title: "Some students already take this subject",
        message: `${clash.length} selected student${clash.length === 1 ? " already takes" : "s already take"} ${subject.subjectCode} in ${when}:\n${lines}\n\nA student can take a subject only once a term (or once a school year when there's no term), so ${clash.length === 1 ? "this student is" : "they're"} left out.`,
        confirmText: `Save without ${clash.length === 1 ? "this student" : "them"}`,
        variant: "primary",
      });
      if (!ok) return;
      clash.forEach((id) => selected.delete(id));
      studentIds.splice(0, studentIds.length, ...studentIds.filter((id) => !clash.includes(id)));
    }

    if (editing) {
      const removed = editing.studentIds.filter((id) => !studentIds.includes(id));
      // Teacher, subject, school year and section can change too; saved grades keep copies of them
      const fields = {
        teacherDocId: teacher.id, teacherId: teacher.teacherId, teacherName: teacher.teacherName,
        subjectId: subject.id, subjectCode: subject.subjectCode, subjectName: subject.subjectName, units: Number(subject.units),
        schoolYear: section.schoolYear, term: formTerm(), yearLevel: section.yearLevel, sectionId: section.id, sectionName: section.sectionName,
      };
      const moved = Object.keys(fields).filter((k) => String(editing[k] ?? "") !== String(fields[k] ?? ""));
      const ops = [{ type: "update", ref: doc(db, "gradingAssignments", editing.id), data: { ...fields, studentIds, updatedAt: serverTimestamp() } }];
      const gSnap = removed.length || moved.length
        ? await getDocs(query(collection(db, "grades"), where("assignmentId", "==", editing.id)))
        : { docs: [] };

      const kept = gSnap.docs.filter((d) => !removed.includes(d.data().studentId));
      if (moved.length && kept.length) {
        const what = [
          editing.teacherDocId !== teacher.id && `teacher ${teacher.teacherName}`,
          editing.subjectId !== subject.id && `subject ${subject.subjectCode}`,
          (editing.sectionId !== section.id || editing.schoolYear !== section.schoolYear) && `section ${section.sectionName}, ${section.schoolYear}`,
          termOf(editing) !== formTerm() && `term ${formTerm() || "(none)"}`,
        ].filter(Boolean).join(", ");
        const ok = await confirmDialog({
          title: "Move the saved grades too?",
          message: `${kept.length} student${kept.length === 1 ? " has" : "s have"} a saved grade in this assignment. The grade${kept.length === 1 ? "" : "s"} will stay and now count for ${what || "the new details"}.` +
            (editing.teacherDocId !== teacher.id ? `\n\n${teacher.teacherName} will see and manage these grades; ${editing.teacherName} won't any more.` : ""),
          confirmText: "Save changes",
          variant: "primary",
        });
        if (!ok) return;
        kept.forEach((d) => ops.push({ type: "update", ref: d.ref, data: { ...fields, updatedAt: serverTimestamp() } }));
      }

      if (removed.length) {
        const orphanGrades = gSnap.docs.filter((d) => removed.includes(d.data().studentId));
        if (orphanGrades.length) {
          const ok = await confirmDialog({
            title: "Remove graded students?",
            message: `${orphanGrades.length} removed student(s) already have a saved grade in this assignment. Their grades will be deleted.`,
            confirmText: "Remove and delete grades",
          });
          if (!ok) return;
          orphanGrades.forEach((d) => ops.push({ type: "delete", ref: d.ref }));
        }
      }
      await commitOperations(ops);
      toast("Grading assignment updated.");
    } else {
      await addDoc(assignmentsCol, {
        teacherDocId: teacher.id,
        teacherId: teacher.teacherId,
        teacherName: teacher.teacherName,

        subjectId: subject.id,
        subjectCode: subject.subjectCode,
        subjectName: subject.subjectName,
        units: Number(subject.units),

        schoolYear: section.schoolYear,
        term: formTerm(),
        yearLevel: section.yearLevel,

        sectionId: section.id,
        sectionName: section.sectionName,

        studentIds,

        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      toast("Grading assignment saved.");
    }
    // Keep the school year, level and section: ready for the next subject of this section
    const keep = { year: els.year.value, level: els.level.value, section: els.section.value, name: section.sectionName };
    resetForm();
    await loadAssignments();
    els.year.value = keep.year;
    fillLevels(keep.level);
    fillSections(keep.section);
    renderSectionAssigned();
    refreshSubjectOptions();
    await loadSectionStudents();
    els.subject.focus();
    toast(`Saved. Choose the next subject for ${keep.name}.`, "info");
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnSave, false);
  }
}

function resetForm() {
  editing = null;
  selected = new Set();
  sectionStudents = [];
  [els.teacher, els.subject, els.year].forEach((el) => { el.value = ""; el.disabled = false; });
  fillLevels();
  fillSections();
  showSubjectInfo();
  renderSectionAssigned();
  refreshSubjectOptions();
  els.studentSearch.value = "";
  els.studentSearch.disabled = true;
  els.formTitle.textContent = "New assignment";
  els.btnCancelEdit.classList.add("d-none");
  els.editNote.classList.add("d-none");
  els.btnSave.innerHTML = `<i class="bi bi-save me-1"></i>Save assignment`;
  els.studentList.innerHTML = `<div class="empty-state">No section selected yet.</div>`;
  updateSelectionUi();
  fillOtherStudents();
}

async function startEdit(id) {
  const a = assignments.find((x) => x.id === id);
  if (!a) return;
  editing = a;
  selected = new Set(a.studentIds || []);

  els.teacher.value = a.teacherDocId;
  els.subject.value = a.subjectId;
  els.year.value = a.schoolYear;
  if (els.term) els.term.value = termOf(a);
  fillLevels(a.yearLevel);
  fillSections(a.sectionId);
  showSubjectInfo();
  renderSectionAssigned();
  refreshSubjectOptions();

  els.formTitle.textContent = "Edit assignment";
  els.btnCancelEdit.classList.remove("d-none");
  els.editNote.classList.remove("d-none");
  els.btnSave.innerHTML = `<i class="bi bi-save me-1"></i>Update assignment`;
  window.scrollTo({ top: 0, behavior: "smooth" });
  await loadSectionStudents();
}

// ---------- Existing assignments table ----------
/** Warns about students already in two grading assignments of the same subject and school year. */
let studentInfo = null; // student doc id → { name, number }, loaded only when there are duplicates
let loadingStudents = false;

async function loadStudentInfo() {
  if (studentInfo || loadingStudents) return;
  loadingStudents = true;
  try {
    const snap = await getDocs(collection(db, "students"));
    studentInfo = new Map(snap.docs.map((d) => [d.id, { name: d.data().studentName || "", number: d.data().studentId || "", sectionId: d.data().sectionId || "" }]));
  } catch (err) {
    console.warn("Student names:", err.code || err);
    studentInfo = new Map();
  } finally {
    loadingStudents = false;
  }
  renderDuplicates();
}

// Grades checked for duplicates: those of the classes in the warning, or every grade after
// "Check for duplicate grades" (finds two records in one class, a grade left behind in a class
// the student was taken out of, a grade of a deleted class). Keep here never deletes a grade unasked.
let dupGrades = null;
let dupGradesFor = "";
let dupScanAll = false;
const gradeDocs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
async function readGrades(ids) {
  const snaps = await Promise.all(ids.map((id) => getDocs(query(collection(db, "grades"), where("assignmentId", "==", id)))));
  return snaps.flatMap(gradeDocs);
}
const currentFixes = () => studentFixes(assignments, dupGrades || []);
async function loadDupGrades() {
  const ids = [...new Set(studentFixes(assignments, []).flatMap((fix) => fix.places.map((p) => p.assignmentId)))].sort();
  const key = dupScanAll ? "*" : ids.join(",");
  if (dupGradesFor === key) return;
  dupGradesFor = key;
  dupGrades = null;
  try {
    dupGrades = dupScanAll ? gradeDocs(await getDocs(collection(db, "grades"))) : await readGrades(ids);
  } catch (err) {
    toast(errorMessage(err), "danger");
    dupGrades = [];
  }
  if (dupGradesFor === key) renderDuplicates();
}

/** Check for duplicate grades: reads every grade and lists what it finds. */
async function checkDupGrades() {
  const btn = document.getElementById("btnCheckDupGrades");
  if (btn) btn.disabled = true;
  dupScanAll = true;
  dupGradesFor = "";
  try {
    await loadDupGrades();
  } finally {
    if (btn) btn.disabled = false;
  }
  const n = currentFixes().length;
  if (n && dupHidden()) setDupHidden(false);
  renderDuplicates();
  toast(n ? `${n} student${n === 1 ? " has" : "s have"} a duplicate class or grade: see the list above.` : "No duplicate classes or grades found.", n ? "warning" : "success");
}

const dupWhere = (a) => `${a.teacherName}, ${a.sectionName}`;
const placeWhere = (p) => (p.assignment ? dupWhere(p.assignment) : "a deleted grading assignment");
const gradeLabel = (g) => `${gradeText(g.finalGrade, g.remarks) || "an empty grade"}${g.draft ? " (draft)" : " (submitted)"}`;

/**
 * The fixes of these students as the database is now: re-reads each student's grades and every
 * class those grades or the shown fix name, so nothing saved meanwhile is deleted unseen.
 */
async function readFresh(fixes) {
  const sids = [...new Set(fixes.map((fix) => fix.studentId))];
  const grades = (await Promise.all(sids.map((sid) => getDocs(query(collection(db, "grades"), where("studentId", "==", sid)))))).flatMap(gradeDocs);
  // Only the subjects of these fixes: the shown classes, the classes of the student's grades, and
  // classes of the subject the student is in now (joined meanwhile)
  const subjects = new Set(fixes.map((fix) => fix.key.split("|")[0]));
  const loaded = new Map(assignments.map((a) => [a.id, a]));
  const ofSubject = (g) => { const a = loaded.get(g.assignmentId); return a ? subjects.has(a.subjectId) : !g.subjectId || subjects.has(g.subjectId); };
  const ids = [...new Set([...fixes.flatMap((fix) => fix.places.map((p) => p.assignmentId)), ...grades.filter(ofSubject).map((g) => g.assignmentId)])];
  assignments.forEach((a) => { if (subjects.has(a.subjectId) && sids.some((sid) => (a.studentIds || []).includes(sid)) && !ids.includes(a.id)) ids.push(a.id); });
  const fresh = (await Promise.all(ids.map((id) => getDoc(doc(db, "gradingAssignments", id))))).filter((d) => d.exists()).map((d) => ({ id: d.id, ...d.data() }));
  const keys = new Set(fixes.map((fix) => fix.key));
  const freshFixes = new Map(studentFixes(fresh, grades).filter((x) => keys.has(x.key)).map((x) => [x.key, x]));
  return { fresh, freshFixes };
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Re-reads, then writes the keeps (several may touch one class). A keep is skipped when the
 * student is no longer duplicated, or when it would now delete other grades than the ones the
 * person agreed to (`deletes`: grade ids), or (`safeOnly`) when it is no longer safe.
 */
async function commitKeeps(choices, { safeOnly = false } = {}) {
  const { fresh, freshFixes } = await readFresh(choices.map(({ fix }) => fix));
  const ops = new Map(); // path -> op (a class touched twice keeps both removals)
  let done = 0;
  let changed = 0;
  choices.forEach(({ fix, keepId, deletes }) => {
    const now = freshFixes.get(fix.key);
    if (!now) return; // fixed meanwhile
    if (!now.keepable.includes(keepId) || (safeOnly && !now.safe)) { changed++; return; }
    const plan = planKeep(now, keepId);
    if (deletes && !sameSet(plan.deletedGrades.map((g) => g.id), deletes)) { changed++; return; }
    plan.ops.forEach((op) => {
      if (op.type === "update") {
        const a = fresh.find((x) => `gradingAssignments/${x.id}` === op.path);
        a.studentIds = (a.studentIds || []).filter((id) => id !== now.studentId);
        ops.set(op.path, { ...op, data: { studentIds: a.studentIds } });
      } else ops.set(op.path, op);
    });
    done++;
  });
  if (ops.size) {
    await commitOperations([...ops.values()].map((op) => {
      const [col, id] = op.path.split("/");
      return { type: op.type, ref: doc(db, col, id), data: op.data };
    }));
  }
  return { done, changed };
}

const studentName = (id) => (studentInfo && studentInfo.get(id) && studentInfo.get(id).name) || "this student";
const ownSection = (sid) => (studentInfo && studentInfo.get(sid) && studentInfo.get(sid).sectionId) || "";

async function afterKeep() {
  dupGradesFor = "";
  await loadAssignments();
}

async function keepClass(fixKey, keepId) {
  const shown = currentFixes().find((x) => x.key === fixKey);
  if (!shown) return;
  // Ask about the classes and grades as they are now (someone may have fixed or changed them meanwhile)
  let fix;
  try {
    fix = (await readFresh([shown])).freshFixes.get(fixKey);
  } catch (err) {
    toast(errorMessage(err), "danger");
    return;
  }
  if (!fix || !fix.keepable.includes(keepId)) {
    toast(fix ? "This changed meanwhile: check the list again." : "Already fixed: nothing to change.", "info");
    await afterKeep();
    return;
  }
  const plan = planKeep(fix, keepId);
  const kept = fix.places.find((p) => p.assignmentId === keepId);
  const leaving = fix.places.filter((p) => p.assignmentId !== keepId && p.enrolled && p.assignment);
  const stays = kept.grades.filter((g) => !plan.deletedGrades.includes(g));
  const lost = plan.deletedGrades.map((g) => {
    const p = fix.places.find((x) => x.grades.includes(g));
    const where = p.assignmentId === keepId ? `a second record in ${placeWhere(p)}`
      : p.enrolled ? placeWhere(p)
      : p.assignment ? `${placeWhere(p)}, a class the student is no longer in` : placeWhere(p);
    return `${gradeLabel(g)} in ${where}`;
  });
  const parts = [`${studentName(fix.studentId)} stays in ${dupWhere(kept.assignment)} for ${fix.subjectCode}`];
  if (leaving.length) parts.push(` and is taken out of ${leaving.map(placeWhere).join(" and ")}`);
  parts.push(".");
  if (lost.length) {
    parts.push(` ${lost.length === 1 ? "This grade" : `These ${lost.length} grades`} will be deleted: ${lost.join("; ")}.`);
    parts.push(stays.length ? ` The grade ${gradeLabel(stays[0])} in ${dupWhere(kept.assignment)} stays.` : ` No grade stays: the teacher of ${dupWhere(kept.assignment)} enters it.`);
  } else parts.push(" No grade is deleted.");
  const ok = await confirmDialog({
    title: lost.length ? `Keep one class and delete ${lost.length === 1 ? "a grade" : `${lost.length} grades`}?` : "Remove the duplicate class?",
    message: parts.join(""),
    confirmText: lost.length ? `Keep and delete ${lost.length === 1 ? "the other grade" : `${lost.length} grades`}` : "Keep here",
    variant: lost.length ? "danger" : "warning",
  });
  if (!ok) return;
  try {
    const { done, changed } = await commitKeeps([{ fix, keepId, deletes: plan.deletedGrades.map((g) => g.id) }]);
    toast(done ? `${studentName(fix.studentId)} now has one ${fix.subjectCode} class and grade.` : changed ? "This changed meanwhile: nothing was saved. Check the list again." : "Already fixed: nothing to change.", done ? "success" : "info");
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
  await afterKeep();
}

async function fixAllSafe() {
  const safe = currentFixes().filter((x) => x.safe);
  if (!safe.length) return;
  const extra = safe.reduce((n, fix) => n + planKeep(fix, defaultKeep(fix, ownSection(fix.studentId))).deletedGrades.length, 0);
  const ok = await confirmDialog({
    title: "Remove all safe duplicates?",
    message: `${safe.length} student${safe.length === 1 ? "" : "s"} will stay in one class for each subject (the class with the submitted grade, else the one with a grade, else the student's own section).` +
      (extra ? ` ${extra} extra record${extra === 1 ? "" : "s"} of the same grade will be deleted; no grade value is lost.` : " No grade is deleted.") +
      " Students with different grades stay listed.",
    confirmText: "Remove duplicates",
    variant: "warning",
  });
  if (!ok) return;
  try {
    const { done, changed } = await commitKeeps(safe.map((fix) => ({ fix, keepId: defaultKeep(fix, ownSection(fix.studentId)) })), { safeOnly: true });
    toast(done ? `Fixed ${done} duplicate${done === 1 ? "" : "s"}.${changed ? ` ${changed} changed meanwhile and stay listed.` : ""}` : changed ? "These changed meanwhile: nothing was saved. Check the list again." : "Already fixed: nothing to change.", done ? "success" : "info");
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
  await afterKeep();
}

// Hide / Show for the warning, remembered on this device
const DUP_HIDDEN_KEY = "gs-dup-warning-hidden";
function dupHidden() {
  try { return localStorage.getItem(DUP_HIDDEN_KEY) === "1"; } catch { return false; }
}
function setDupHidden(hidden) {
  try { hidden ? localStorage.setItem(DUP_HIDDEN_KEY, "1") : localStorage.removeItem(DUP_HIDDEN_KEY); } catch {}
  renderDuplicates();
}

function renderDuplicates() {
  if (!els.dupWarning) return;
  const fixes = currentFixes();
  els.dupWarning.classList.toggle("d-none", !fixes.length);
  if (!fixes.length) {
    loadDupGrades(); // grade-only duplicates show once the grades are in
    return;
  }
  // One group per subject, school year and term
  const groups = new Map();
  fixes.forEach((fix) => {
    const k = `${fix.subjectCode}|${fix.schoolYear}|${fix.term}`;
    if (!groups.has(k)) groups.set(k, { subjectCode: fix.subjectCode, schoolYear: fix.schoolYear, term: fix.term, fixes: [] });
    groups.get(k).fixes.push(fix);
  });
  if (dupHidden()) {
    // Collapsed: one line, so the problem isn't forgotten
    els.dupWarning.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2">
      <span><i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i><strong>${fixes.length} student${fixes.length === 1 ? " has" : "s have"}</strong> a subject twice in a school year (two classes or two grades).</span>
      <button type="button" class="btn btn-sm btn-outline-dark py-0 ms-auto" data-dup-toggle aria-expanded="false"><i class="bi bi-eye me-1" aria-hidden="true"></i>Show</button>
    </div>`;
    return;
  }
  if (!studentInfo) loadStudentInfo();
  loadDupGrades();
  const where = (p) => escapeHtml(placeWhere(p));
  const gradeHtml = (g) => `<strong>${escapeHtml(gradeText(g.finalGrade, g.remarks) || "empty")}</strong>${g.draft ? " (draft)" : ""}`;
  const studentLine = (fix) => {
    const s = studentInfo && studentInfo.get(fix.studentId);
    const name = s ? `<strong>${escapeHtml(s.name || "(no name)")}</strong>${s.number ? ` <span class="text-secondary">${escapeHtml(s.number)}</span>` : ""}` : `<span class="text-secondary">${studentInfo ? "(student record not found)" : "Loading name…"}</span>`;
    const place = (p) => {
      const gone = !p.assignment ? "" : !p.enrolled ? ` <span class="text-secondary">(no longer in this class)</span>` : "";
      const grade = !dupGrades ? `<span class="text-secondary">checking grades…</span>`
        : !p.grades.length ? `<span class="text-secondary">no grade</span>`
        : p.grades.length === 1 ? `grade ${gradeHtml(p.grades[0])}`
        : `<span class="text-danger">${p.grades.length} grade records</span>: ${p.grades.map(gradeHtml).join(", ")}`;
      const keep = fix.keepable.includes(p.assignmentId) ? ` <button type="button" class="btn btn-sm btn-outline-dark py-0 ms-1" data-keep="${escapeHtml(p.assignmentId)}" data-fix="${escapeHtml(fix.key)}">Keep here</button>` : "";
      return `<span class="d-inline-block me-2">${where(p)}${gone} — ${grade}${keep}</span>`;
    };
    const note = dupGrades && !fix.safe ? `<div class="text-secondary">Different grades are saved: Keep here deletes the grades outside the class you keep and any second record in it (it asks first, naming each one).</div>` : "";
    return { sort: s ? s.name : "~", html: `<li class="mb-1">${name}: ${fix.places.map(place).join(" ")}${note}</li>` };
  };
  const safeCount = dupGrades ? fixes.filter((x) => x.safe).length : 0;
  els.dupWarning.innerHTML = `<div class="d-flex flex-wrap align-items-center gap-2 mb-2">
      <span class="fw-semibold"><i class="bi bi-exclamation-triangle me-1" aria-hidden="true"></i>Some students have the same subject twice in a school year (two classes or two grades)</span>
      ${safeCount ? `<button type="button" class="btn btn-sm btn-dark py-0 ms-auto" id="btnFixSafeDups">Remove all safe duplicates (${safeCount})</button>` : ""}
      <button type="button" class="btn btn-sm btn-outline-dark py-0${safeCount ? "" : " ms-auto"}" data-dup-toggle aria-expanded="true"><i class="bi bi-eye-slash me-1" aria-hidden="true"></i>Hide</button>
    </div>
    ${[...groups.values()].map((d) => {
      const students = d.fixes.map(studentLine).sort((x, y) => compareText(x.sort, y.sort));
      const n = students.length;
      const classes = [...new Map(d.fixes.flatMap((fix) => fix.places.filter((p) => p.assignment).map((p) => [p.assignmentId, p.assignment]))).values()];
      return `<div class="dup-group mb-2">
        <div><strong>${escapeHtml(d.subjectCode)}</strong>, ${escapeHtml(yearTermText(d.schoolYear, d.term))}: ${n} student${n === 1 ? "" : "s"}</div>
        <div class="d-flex flex-wrap gap-1 my-1">${classes.map((a) => `<button type="button" class="btn btn-sm btn-outline-dark py-0" data-edit="${escapeHtml(a.id)}" title="Edit this grading assignment"><i class="bi bi-pencil me-1" aria-hidden="true"></i>${escapeHtml(dupWhere(a))}</button>`).join("")}</div>
        <details${n <= 10 ? " open" : ""}><summary class="small">Show the ${n} student${n === 1 ? "" : "s"}</summary>
          <ul class="small mb-0 ps-3 mt-1">${students.map((x) => x.html).join("")}</ul>
        </details>
      </div>`;
    }).join("")}
    <div class="small">Their units count twice in the GWA. Click <strong>Keep here</strong> beside the class each student should stay in (a grade is never deleted without asking), or edit a grading assignment.${dupScanAll ? "" : ` Grades in other classes are checked with <strong>Check for duplicate grades</strong>.`}</div>`;
}

/** School year, section and teacher filters above the list (kept when possible). */
function fillListFilters() {
  const fill = (el, values, all) => {
    const keep = el.value;
    el.innerHTML = `<option value="">${all}</option>` + values.map(([v, label]) => `<option value="${escapeHtml(v)}">${escapeHtml(label)}</option>`).join("");
    el.value = values.some(([v]) => v === keep) ? keep : "";
  };
  const years = [...new Set(assignments.map((a) => a.schoolYear))].sort((a, b) => compareText(b, a));
  fill(els.filterYear, years.map((y) => [y, y]), "All school years");
  const inYear = assignments.filter((a) => !els.filterYear.value || a.schoolYear === els.filterYear.value);
  const secs = new Map(), tchs = new Map();
  inYear.forEach((a) => { secs.set(a.sectionId, a.sectionName); tchs.set(a.teacherDocId, a.teacherName); });
  fill(els.filterSection, [...secs].sort((a, b) => compareText(a[1], b[1])), "All sections");
  fill(els.filterTeacher, [...tchs].sort((a, b) => compareText(a[1], b[1])), "All teachers");
}

let combineEnabled = true; // Setup and options → Combined classes
function renderAssignments() {
  const groups = combineEnabled ? combinedGroups(assignments) : new Map();
  renderDuplicates();
  renderSectionAssigned();
  const term = normalize(els.search.value);
  const rows = assignments.filter(
    (a) =>
      (!els.filterYear.value || a.schoolYear === els.filterYear.value) &&
      (!els.filterTerm || els.filterTerm.value === "all" || termOf(a) === els.filterTerm.value) &&
      (!els.filterSection.value || a.sectionId === els.filterSection.value) &&
      (!els.filterTeacher.value || a.teacherDocId === els.filterTeacher.value) &&
      (!term || normalize(`${a.teacherName} ${a.subjectCode} ${a.subjectName} ${a.sectionName} ${a.schoolYear} ${termOf(a)}`).includes(term))
  );
  const filtered = rows.length !== assignments.length;
  els.count.textContent = filtered ? `${rows.length} of ${assignments.length}` : assignments.length;

  if (!assignments.length) {
    tableMessage(els.tbody, 8, "No grading assignments yet. Fill in the form above to create the first one.");
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, 8, "No assignments match these filters.");
    return;
  }
  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map(
      (a) => `
      <tr>
        <td>${escapeHtml(a.teacherName)}</td>
        <td><span class="code-cell">${escapeHtml(a.subjectCode)}</span><div class="small text-secondary">${escapeHtml(a.subjectName)}</div></td>
        <td class="num">${escapeHtml(a.units)}</td>
        <td>${escapeHtml(a.schoolYear)}${termOf(a) ? `<div class="small text-secondary">${escapeHtml(termOf(a))}</div>` : ""}</td>
        <td>${escapeHtml(a.yearLevel)}</td>
        <td><span class="badge badge-count">${escapeHtml(a.sectionName)}</span>${groups.has(combineKey(a)) ? `<div class="small text-secondary mt-1" title="Shown as one class in Enter grades (Setup and options → Combined classes)"><i class="bi bi-intersect me-1" aria-hidden="true"></i>Combined with ${escapeHtml(groups.get(combineKey(a)).filter((x) => x.id !== a.id).map((x) => x.sectionName).join(", "))}</div>` : ""}</td>
        <td class="num">${(a.studentIds || []).length}</td>
        <td class="text-end text-nowrap">
          <a class="btn btn-sm btn-success" href="grading.html?assignment=${a.id}"><i class="bi bi-pencil-square me-1"></i>Grade</a>
          <button class="btn btn-sm btn-outline-secondary ms-1" data-edit="${a.id}"><i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-outline-danger ms-1" data-delete="${a.id}"><i class="bi bi-trash me-1"></i>Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

async function removeAssignment(id) {
  const a = assignments.find((x) => x.id === id);
  if (!a) return;
  try {
    const gSnap = await getDocs(query(collection(db, "grades"), where("assignmentId", "==", id)));
    const ok = await confirmDialog({
      title: "Delete grading assignment?",
      message:
        `${a.subjectCode} for ${a.sectionName} (${a.teacherName}) will be removed` +
        (gSnap.size ? `, along with ${gSnap.size} saved grade(s).` : "."),
      confirmText: "Delete assignment",
    });
    if (!ok) return;
    const ops = gSnap.docs.map((d) => ({ type: "delete", ref: d.ref }));
    // Change requests for this assignment no longer make sense
    const rSnap = await getDocs(query(collection(db, "gradeChangeRequests"), where("assignmentId", "==", id)));
    rSnap.forEach((d) => ops.push({ type: "delete", ref: d.ref }));
    ops.push({ type: "delete", ref: doc(db, "gradingAssignments", id) });
    await commitOperations(ops);
    if (editing?.id === id) resetForm();
    toast("Grading assignment deleted.");
    await loadAssignments();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

// ---------- Add from curriculum: a section's classes in one click ----------
const cu = {
  el: document.getElementById("curModal"), program: document.getElementById("curProgramIn"), term: document.getElementById("curTermIn"),
  for: document.getElementById("curFor"), missing: document.getElementById("curMissing"), wrap: document.getElementById("curWrap"),
  rows: document.getElementById("curRows"), skipped: document.getElementById("curSkipped"), summary: document.getElementById("curSummary"),
  create: document.getElementById("btnCurCreate"),
};
let curModal = null;
let curPlan = { create: [], skipped: [] };
let curStudents = [];

const curSection = () => sections.find((s) => s.id === els.section.value) || null;

async function openFromCurriculum() {
  const section = curSection();
  if (!section) return;
  cu.term.innerHTML = `<option value="">No term (whole school year)</option>` + TERMS.map((t) => `<option>${t}</option>`).join("");
  cu.term.value = formTerm();
  cu.program.value = programOf(section.sectionName);
  cu.for.textContent = `For ${section.sectionName} · ${section.yearLevel} · ${section.schoolYear}`;
  curModal.show();
  await loadCurriculumPlan();
}

async function loadCurriculumPlan() {
  const section = curSection();
  const program = cu.program.value.trim().toUpperCase();
  const term = TERMS.includes(cu.term.value) ? cu.term.value : "";
  cu.rows.innerHTML = `<tr><td colspan="3" class="empty-state"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</td></tr>`;
  cu.missing.classList.add("d-none");
  cu.skipped.textContent = "";
  try {
    const [curSnap, stuSnap, aSnap] = await Promise.all([
      program ? getDoc(doc(db, "curriculum", curriculumId(program, section.yearLevel, term))) : Promise.resolve(null),
      getDocs(query(collection(db, "students"), where("schoolYear", "==", section.schoolYear), where("sectionId", "==", section.id))),
      getDocs(assignmentsCol),
    ]);
    const curriculum = curSnap && curSnap.exists() ? curSnap.data() : null;
    curStudents = stuSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const all = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    curPlan = planFromCurriculum({ curriculum, section, term, assignments: all, sectionStudents: curStudents });
    if (!curriculum) {
      cu.missing.innerHTML = `No curriculum saved for <strong>${escapeHtml(program || "(no program)")} · ${escapeHtml(section.yearLevel)} · ${escapeHtml(term || "No term")}</strong>. Add it on the <a href="curriculum.html">Curriculum</a> page${program ? "" : ", and type the program above"}.`;
      cu.missing.classList.remove("d-none");
    }
    drawCurriculumPlan();
  } catch (err) {
    cu.rows.innerHTML = `<tr><td colspan="3" class="text-danger">${escapeHtml(errorMessage(err))}</td></tr>`;
  }
}

function drawCurriculumPlan() {
  const subj = (id) => subjects.find((s) => s.id === id);
  const name = (id) => curStudents.find((s) => s.id === id)?.studentName || id;
  cu.wrap.classList.toggle("d-none", !curPlan.create.length);
  cu.rows.innerHTML = curPlan.create.map((c, i) => {
    const s = subj(c.subjectId);
    return `<tr>
      <td><span class="code-cell">${escapeHtml(s?.subjectCode || "?")}</span> ${escapeHtml(s?.subjectName || "(deleted subject)")}</td>
      <td class="num">${c.studentIds.length}${c.leftOut.length ? `<div class="small text-secondary" title="${escapeHtml(c.leftOut.map(name).join(", "))}">${c.leftOut.length} already take it</div>` : ""}</td>
      <td><select class="form-select form-select-sm" data-cur="${i}" ${s ? "" : "disabled"}><option value="">Choose the teacher (or leave empty to skip)</option>${teachers.map((t) => `<option value="${t.id}">${escapeHtml(t.teacherName)} (${escapeHtml(t.teacherId)})</option>`).join("")}</select></td>
    </tr>`;
  }).join("");
  cu.rows.querySelectorAll("[data-cur]").forEach((sel) => searchPicker(sel, { title: "Choose a teacher", placeholder: "Type a teacher's name or ID" }));
  cu.skipped.innerHTML = curPlan.skipped.length
    ? `<i class="bi bi-info-circle me-1"></i>Already assigned to this section${cu.term.value ? ` for the ${escapeHtml(cu.term.value)}` : ""}, skipped: ${curPlan.skipped.map((x) => escapeHtml(subj(x.subjectId)?.subjectCode || "?")).join(", ")}`
    : "";
  curSummaryUpdate();
}

function curSummaryUpdate() {
  const n = [...cu.rows.querySelectorAll("[data-cur]")].filter((s) => s.value).length;
  cu.summary.textContent = curPlan.create.length ? `${n} of ${curPlan.create.length} subjects have a teacher` : "";
  cu.create.textContent = `Create ${n} class${n === 1 ? "" : "es"}`;
  cu.create.disabled = !n;
}

async function createFromCurriculum() {
  const section = curSection();
  const term = TERMS.includes(cu.term.value) ? cu.term.value : "";
  const picks = [...cu.rows.querySelectorAll("[data-cur]")].filter((s) => s.value).map((s) => ({ row: curPlan.create[Number(s.dataset.cur)], teacher: teachers.find((t) => t.id === s.value) }));
  if (!section || !picks.length) return;
  setBusy(cu.create, true, "Creating…");
  try {
    const ops = picks.map(({ row, teacher }) => {
      const subject = subjects.find((x) => x.id === row.subjectId);
      return {
        type: "set",
        ref: doc(assignmentsCol),
        data: {
          teacherDocId: teacher.id, teacherId: teacher.teacherId, teacherName: teacher.teacherName,
          subjectId: subject.id, subjectCode: subject.subjectCode, subjectName: subject.subjectName, units: Number(subject.units),
          schoolYear: section.schoolYear, term, yearLevel: section.yearLevel, sectionId: section.id, sectionName: section.sectionName,
          studentIds: row.studentIds, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
        },
      };
    });
    await commitOperations(ops);
    curModal.hide();
    toast(`${ops.length} class${ops.length === 1 ? "" : "es"} created for ${section.sectionName}.`);
    if (els.term) els.term.value = term;
    await loadAssignments();
    renderSectionAssigned();
    refreshSubjectOptions();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(cu.create, false);
  }
}

// ---------- Wire up ----------
async function init() {
  combineEnabled = combineOn(await getOptions().catch(() => ({})));
  // Search pop-ups instead of long dropdowns
  searchPicker(els.section, { title: "Choose a section", placeholder: "Type a section name" });
  searchPicker(els.subject, { title: "Choose a subject", placeholder: "Type a subject code or name" });
  searchPicker(els.teacher, { title: "Choose a teacher", placeholder: "Type a teacher's name or ID" });
  els.subject.addEventListener("change", () => { showSubjectInfo(); if (sectionStudents.length) renderStudents(); });
  els.year.addEventListener("change", () => { fillLevels(); fillSections(); loadSectionStudents(); });
  els.level.addEventListener("change", () => { fillSections(); loadSectionStudents(); });
  els.section.addEventListener("change", loadSectionStudents);

  els.studentList.addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
    updateSelectionUi();
  });
  els.btnSelectAll.addEventListener("click", () => { visibleStudents().filter((s) => isAttending(s) || s.other).forEach((s) => selected.add(s.id)); renderStudents(); });
  els.btnPasteList?.addEventListener("click", pasteList);
  if (cu.el) {
    curModal = new bootstrap.Modal(cu.el);
    document.getElementById("btnFromCurriculum")?.addEventListener("click", openFromCurriculum);
    cu.term.addEventListener("change", loadCurriculumPlan);
    cu.program.addEventListener("change", loadCurriculumPlan);
    cu.rows.addEventListener("change", curSummaryUpdate);
    cu.create.addEventListener("click", createFromCurriculum);
  }
  if (els.otherStudent) {
    searchPicker(els.otherStudent, { title: "Add a student from another section", placeholder: "Type a student's name or ID" });
    els.otherStudent.addEventListener("change", addOtherStudent);
  }
  els.btnDeselectAll.addEventListener("click", () => { visibleStudents().forEach((s) => selected.delete(s.id)); renderStudents(); });
  els.studentSearch.addEventListener("input", renderStudents);
  els.section.addEventListener("change", () => { renderSectionAssigned(); refreshSubjectOptions(); });
  els.level.addEventListener("change", () => { renderSectionAssigned(); refreshSubjectOptions(); });
  els.year.addEventListener("change", () => { renderSectionAssigned(); refreshSubjectOptions(); });
  els.sectionAssigned.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit]");
    if (btn) startEdit(btn.dataset.edit);
  });
  els.term?.addEventListener("change", () => { renderSectionAssigned(); refreshSubjectOptions(); if (sectionStudents.length) renderStudents(); });
  els.filterTerm?.addEventListener("change", renderAssignments);
  [els.filterYear, els.filterSection, els.filterTeacher].forEach((el) => el.addEventListener("change", () => {
    if (el === els.filterYear) fillListFilters();
    renderAssignments();
  }));
  els.btnSave.addEventListener("click", saveAssignment);
  els.btnCancelEdit.addEventListener("click", resetForm);
  els.search.addEventListener("input", renderAssignments);
  document.getElementById("btnCheckDupGrades")?.addEventListener("click", checkDupGrades);
  // Edit buttons in the duplicates warning
  els.dupWarning?.addEventListener("click", (e) => {
    if (e.target.closest("[data-dup-toggle]")) { setDupHidden(!dupHidden()); return; }
    if (e.target.closest("#btnFixSafeDups")) { fixAllSafe(); return; }
    const keep = e.target.closest("[data-keep]");
    if (keep) { keepClass(keep.dataset.fix, keep.dataset.keep); return; }
    const btn = e.target.closest("[data-edit]");
    if (!btn) return;
    startEdit(btn.dataset.edit);
    document.getElementById("formTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  els.tbody.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");
    if (editBtn) startEdit(editBtn.dataset.edit);
    if (delBtn) removeAssignment(delBtn.dataset.delete);
  });

  try {
    await loadReferenceData();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
  await loadAssignments();
}

initLayout("assignments").then((user) => {
  if (user) init(user);
  else tableMessage(els.tbody, 8, "Connect Firebase and sign in to load grading assignments.");
});
