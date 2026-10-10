// ==========================================================
// subjects.js — Subject CRUD (collection: subjects)
// ==========================================================

import {
  db, collection, doc, addDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy,
  tableLoading, tableMessage, errorMessage, clearErrors, fieldError, commitOperations,
} from "./app.js";
import { setupSubjectImport } from "./subjects-import.js";

const subjectsCol = collection(db, "subjects");

const els = {
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  btnAdd: document.getElementById("btnAdd"),
  modalEl: document.getElementById("formModal"),
  modalTitle: document.getElementById("formModalTitle"),
  form: document.getElementById("form"),
  formError: document.getElementById("formError"),
  code: document.getElementById("subjectCode"),
  name: document.getElementById("subjectName"),
  units: document.getElementById("units"),
  btnSave: document.getElementById("btnSave"),
};

let subjects = [];
let editingId = null;
let modal;

async function loadSubjects() {
  tableLoading(els.tbody, 4);
  try {
    const snap = await getDocs(query(subjectsCol, orderBy("subjectCode")));
    subjects = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  } catch (err) {
    tableMessage(els.tbody, 4, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

function render() {
  const term = normalize(els.search.value);
  const rows = subjects.filter((s) => !term || normalize(`${s.subjectCode} ${s.subjectName}`).includes(term));
  els.count.textContent = subjects.length;

  if (!subjects.length) {
    tableMessage(els.tbody, 4, `No subjects yet. Add your first subject to start building grading assignments.`);
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, 4, `No subjects match “${escapeHtml(els.search.value)}”.`);
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map(
      (s) => `
      <tr>
        <td class="code-cell">${escapeHtml(s.subjectCode) || '<span class="text-secondary fw-normal" title="This subject has no code">—</span>'}</td>
        <td>${escapeHtml(s.subjectName)}</td>
        <td class="num">${escapeHtml(s.units)}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-edit="${s.id}"><i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-outline-danger ms-1" data-delete="${s.id}"><i class="bi bi-trash me-1"></i>Delete</button>
        </td>
      </tr>`
    )
    .join("");
}

function openForm(subject = null) {
  editingId = subject ? subject.id : null;
  clearErrors(els.form);
  els.formError.classList.add("d-none");
  els.modalTitle.textContent = subject ? "Edit subject" : "Add subject";
  els.code.value = subject?.subjectCode ?? "";
  els.name.value = subject?.subjectName ?? "";
  els.units.value = subject?.units ?? "";
  modal.show();
}

function readForm() {
  clearErrors(els.form);
  const data = {
    subjectCode: els.code.value.trim().toUpperCase(),
    subjectName: els.name.value.trim(),
    units: null,
  };
  let ok = true;

  // The subject code is optional (some subjects have none)
  if (!data.subjectName) { fieldError(els.name, "Enter a subject name."); ok = false; }

  const rawUnits = els.units.value.trim();
  const units = Number(rawUnits);
  if (rawUnits === "") {
    fieldError(els.units, "Enter the number of units."); ok = false;
  } else if (!Number.isFinite(units)) {
    fieldError(els.units, "Units must be a number."); ok = false;
  } else if (units <= 0) {
    fieldError(els.units, "Units must be greater than 0."); ok = false;
  } else {
    data.units = Math.round(units * 100) / 100;
  }
  return ok ? data : null;
}

async function save(e) {
  e.preventDefault();
  const data = readForm();
  if (!data) return;

  setBusy(els.btnSave, true);
  els.formError.classList.add("d-none");
  try {
    // Subject codes must be unique
    const dup = data.subjectCode
      ? await getDocs(query(subjectsCol, where("subjectCode", "==", data.subjectCode)))
      : { docs: [] }; // no code: nothing to compare
    if (dup.docs.some((d) => d.id !== editingId)) {
      fieldError(els.code, `Subject code ${data.subjectCode} already exists.`);
      return;
    }

    if (editingId) {
      const before = subjects.find((s) => s.id === editingId);
      await updateDoc(doc(db, "subjects", editingId), { ...data, updatedAt: serverTimestamp() });

      // Keep denormalized copies in assignments and grades in sync
      const changed =
        before.subjectCode !== data.subjectCode ||
        before.subjectName !== data.subjectName ||
        Number(before.units) !== data.units;
      if (changed) await cascade(editingId, data);
      toast("Subject updated.");
    } else {
      await addDoc(subjectsCol, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      toast("Subject added.");
    }
    modal.hide();
    await loadSubjects();
  } catch (err) {
    els.formError.textContent = errorMessage(err);
    els.formError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

async function cascade(subjectId, data) {
  const patch = {
    subjectCode: data.subjectCode,
    subjectName: data.subjectName,
    units: data.units,
    updatedAt: serverTimestamp(),
  };
  const [aSnap, gSnap] = await Promise.all([
    getDocs(query(collection(db, "gradingAssignments"), where("subjectId", "==", subjectId))),
    getDocs(query(collection(db, "grades"), where("subjectId", "==", subjectId))),
  ]);
  const ops = [...aSnap.docs, ...gSnap.docs].map((d) => ({ type: "update", ref: d.ref, data: patch }));
  if (ops.length) await commitOperations(ops);
}

async function remove(id) {
  const s = subjects.find((x) => x.id === id);
  if (!s) return;
  try {
    const used = await getDocs(query(collection(db, "gradingAssignments"), where("subjectId", "==", id)));
    if (!used.empty) {
      toast(`${s.subjectCode || s.subjectName} is used in ${used.size} grading assignment(s). Delete those assignments first.`, "warning");
      return;
    }
    const ok = await confirmDialog({
      title: "Delete subject?",
      message: `${s.subjectCode ? `${s.subjectCode} – ` : ""}${s.subjectName} will be removed permanently.`,
      confirmText: "Delete subject",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "subjects", id));
    toast("Subject deleted.");
    await loadSubjects();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

function init() {
  modal = new bootstrap.Modal(els.modalEl);
  els.modalEl.addEventListener("shown.bs.modal", () => els.code.focus());
  els.btnAdd.addEventListener("click", () => openForm());
  els.form.addEventListener("submit", save);
  els.search.addEventListener("input", render);
  els.tbody.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");
    if (editBtn) openForm(subjects.find((s) => s.id === editBtn.dataset.edit));
    if (delBtn) remove(delBtn.dataset.delete);
  });
  setupSubjectImport({
    getSubjects: () => subjects,
    onImported: loadSubjects,
    cascade,
  });
  loadSubjects();
}

initLayout("subjects").then((user) => {
  if (user) init(user);
  else tableMessage(els.tbody, 4, "Connect Firebase and sign in to load subjects.");
});
