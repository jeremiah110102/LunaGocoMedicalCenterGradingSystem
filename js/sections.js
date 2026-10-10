// ==========================================================
// sections.js — Section CRUD (collection: sections)
// ==========================================================

import {
  db, collection, doc, addDoc, getDocs, updateDoc, deleteDoc,
  query, where, serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy, compareText,
  tableLoading, tableMessage, errorMessage, clearErrors, fieldError, commitOperations,
  YEAR_LEVELS, isValidSchoolYear,
} from "./app.js";
import { setupPromote } from "./promote.js";

const sectionsCol = collection(db, "sections");

const els = {
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  filterYear: document.getElementById("filterYear"),
  btnAdd: document.getElementById("btnAdd"),
  modalEl: document.getElementById("formModal"),
  modalTitle: document.getElementById("formModalTitle"),
  form: document.getElementById("form"),
  formError: document.getElementById("formError"),
  schoolYear: document.getElementById("schoolYear"),
  schoolYearList: document.getElementById("schoolYearList"),
  yearLevel: document.getElementById("yearLevel"),
  sectionName: document.getElementById("sectionName"),
  btnSave: document.getElementById("btnSave"),
};

let sections = [];
let studentCounts = {};
let editingId = null;
let modal;

function sortSections(list) {
  return list.sort(
    (a, b) =>
      compareText(b.schoolYear, a.schoolYear) ||
      YEAR_LEVELS.indexOf(a.yearLevel) - YEAR_LEVELS.indexOf(b.yearLevel) ||
      compareText(a.sectionName, b.sectionName)
  );
}

async function loadSections() {
  tableLoading(els.tbody, 5);
  try {
    const [secSnap, stuSnap] = await Promise.all([getDocs(sectionsCol), getDocs(collection(db, "students"))]);
    sections = sortSections(secSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
    studentCounts = {};
    stuSnap.forEach((d) => {
      const sid = d.data().sectionId;
      studentCounts[sid] = (studentCounts[sid] || 0) + 1;
    });
    fillYearOptions();
    render();
  } catch (err) {
    tableMessage(els.tbody, 5, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

function fillYearOptions() {
  const years = [...new Set(sections.map((s) => s.schoolYear))].sort((a, b) => compareText(b, a));
  const current = els.filterYear.value;
  els.filterYear.innerHTML =
    `<option value="">All school years</option>` +
    years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
  if (years.includes(current)) els.filterYear.value = current;

  // Suggest existing years plus the current/next academic year
  const now = new Date().getFullYear();
  const suggestions = new Set([...years, `${now}-${now + 1}`, `${now + 1}-${now + 2}`]);
  els.schoolYearList.innerHTML = [...suggestions].map((y) => `<option value="${escapeHtml(y)}"></option>`).join("");
}

function render() {
  const term = normalize(els.search.value);
  const year = els.filterYear.value;
  const rows = sections.filter(
    (s) => (!year || s.schoolYear === year) && (!term || normalize(`${s.sectionName} ${s.yearLevel} ${s.schoolYear}`).includes(term))
  );
  els.count.textContent = sections.length;

  if (!sections.length) {
    tableMessage(els.tbody, 5, "No sections yet. Add a section, then enroll students into it.");
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, 5, "No sections match your filters.");
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map(
      (s) => `
      <tr>
        <td>${escapeHtml(s.schoolYear)}</td>
        <td>${escapeHtml(s.yearLevel)}</td>
        <td class="code-cell">${escapeHtml(s.sectionName)}</td>
        <td class="num">${studentCounts[s.id] || 0}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-edit="${s.id}"><i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-outline-danger ms-1" data-delete="${s.id}"><i class="bi bi-trash me-1"></i>Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

function openForm(section = null) {
  editingId = section ? section.id : null;
  clearErrors(els.form);
  els.formError.classList.add("d-none");
  els.modalTitle.textContent = section ? "Edit section" : "Add section";
  els.schoolYear.value = section?.schoolYear ?? (els.filterYear.value || "");
  els.yearLevel.value = section?.yearLevel ?? "";
  els.sectionName.value = section?.sectionName ?? "";
  modal.show();
}

function readForm() {
  clearErrors(els.form);
  const data = {
    schoolYear: els.schoolYear.value.trim(),
    yearLevel: els.yearLevel.value,
    sectionName: els.sectionName.value.trim().toUpperCase().replace(/\s+/g, " "),
  };
  let ok = true;
  if (!data.schoolYear) { fieldError(els.schoolYear, "Enter the school year."); ok = false; }
  else if (!isValidSchoolYear(data.schoolYear)) { fieldError(els.schoolYear, "Use consecutive years, for example 2026-2027."); ok = false; }
  if (!data.yearLevel) { fieldError(els.yearLevel, "Select a year level."); ok = false; }
  if (!data.sectionName) { fieldError(els.sectionName, "Enter a section name."); ok = false; }
  return ok ? data : null;
}

async function save(e) {
  e.preventDefault();
  const data = readForm();
  if (!data) return;

  setBusy(els.btnSave, true);
  els.formError.classList.add("d-none");
  try {
    // A section name can only exist once per school year
    const dup = await getDocs(
      query(sectionsCol, where("schoolYear", "==", data.schoolYear), where("sectionName", "==", data.sectionName))
    );
    if (dup.docs.some((d) => d.id !== editingId)) {
      fieldError(els.sectionName, `${data.sectionName} already exists for ${data.schoolYear}.`);
      return;
    }

    if (editingId) {
      const before = sections.find((s) => s.id === editingId);
      await updateDoc(doc(db, "sections", editingId), { ...data, updatedAt: serverTimestamp() });
      const changed =
        before.schoolYear !== data.schoolYear || before.yearLevel !== data.yearLevel || before.sectionName !== data.sectionName;
      if (changed) await cascade(editingId, data);
      toast("Section updated.");
    } else {
      await addDoc(sectionsCol, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      toast("Section added.");
    }
    modal.hide();
    await loadSections();
  } catch (err) {
    els.formError.textContent = errorMessage(err);
    els.formError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

// Keep students, assignments and grades consistent with the section
async function cascade(sectionId, data) {
  const patch = { ...data, updatedAt: serverTimestamp() };
  const snaps = await Promise.all(
    ["students", "gradingAssignments", "grades"].map((name) =>
      getDocs(query(collection(db, name), where("sectionId", "==", sectionId)))
    )
  );
  const ops = snaps.flatMap((s) => s.docs).map((d) => ({ type: "update", ref: d.ref, data: patch }));
  if (ops.length) await commitOperations(ops);
}

async function remove(id) {
  const s = sections.find((x) => x.id === id);
  if (!s) return;
  try {
    const [stu, asg] = await Promise.all([
      getDocs(query(collection(db, "students"), where("sectionId", "==", id))),
      getDocs(query(collection(db, "gradingAssignments"), where("sectionId", "==", id))),
    ]);
    if (!stu.empty || !asg.empty) {
      const parts = [];
      if (!stu.empty) parts.push(`${stu.size} student(s)`);
      if (!asg.empty) parts.push(`${asg.size} grading assignment(s)`);
      toast(`${s.sectionName} still has ${parts.join(" and ")}. Move or delete them first.`, "warning");
      return;
    }
    const ok = await confirmDialog({
      title: "Delete section?",
      message: `${s.sectionName} (${s.yearLevel}, ${s.schoolYear}) will be removed permanently.`,
      confirmText: "Delete section",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "sections", id));
    toast("Section deleted.");
    await loadSections();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

function init() {
  modal = new bootstrap.Modal(els.modalEl);
  els.modalEl.addEventListener("shown.bs.modal", () => els.schoolYear.focus());
  els.btnAdd.addEventListener("click", () => openForm());
  setupPromote({ getSections: () => sections, getStudentCount: (id) => studentCounts[id] || 0, onDone: loadSections });
  els.form.addEventListener("submit", save);
  els.search.addEventListener("input", render);
  els.filterYear.addEventListener("change", render);
  els.tbody.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");
    if (editBtn) openForm(sections.find((s) => s.id === editBtn.dataset.edit));
    if (delBtn) remove(delBtn.dataset.delete);
  });
  loadSections();
}

initLayout("sections").then((user) => {
  if (user) init(user);
  else tableMessage(els.tbody, 5, "Connect Firebase and sign in to load sections.");
});
