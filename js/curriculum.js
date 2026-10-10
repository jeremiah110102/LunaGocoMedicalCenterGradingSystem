// ==========================================================
// curriculum.js — Curriculum page (admin + registrar)
// Each program's subjects per year level and term (collection: curriculum).
// Grading assignments → Add from curriculum uses these to create a section's classes.
// ==========================================================

import { db, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy, compareText,
  tableLoading, tableMessage, errorMessage, clearErrors, fieldError, formatUnits, YEAR_LEVELS,
} from "./app.js";
import { TERMS } from "./terms.js";
import { programOf, curriculumId } from "./curriculum-core.js";

const $ = (id) => document.getElementById(id);
const els = {
  form: $("curForm"), title: $("curFormTitle"), btnNew: $("btnCurNew"), program: $("curProgram"), programList: $("curProgramList"),
  level: $("curLevel"), term: $("curTerm"), search: $("curSearch"), subjects: $("curSubjects"), count: $("curCount"),
  error: $("curError"), btnSave: $("btnCurSave"), body: $("curBody"), total: $("curTotal"),
};
let subjects = [];
let list = [];
let chosen = new Set();
let editingId = null;

const termName = (t) => t || "No term";

function renderSubjects() {
  const term = normalize(els.search.value);
  const shown = subjects.filter((s) => !term || normalize(`${s.subjectCode} ${s.subjectName}`).includes(term));
  els.subjects.innerHTML = shown.length
    ? shown.map((s) => `
      <label class="student-item" for="cs-${s.id}">
        <input class="form-check-input" type="checkbox" id="cs-${s.id}" value="${escapeHtml(s.id)}" ${chosen.has(s.id) ? "checked" : ""}>
        <span class="student-num">${escapeHtml(s.subjectCode)}</span>
        <span class="flex-grow-1">${escapeHtml(s.subjectName)} <span class="small text-secondary">(${escapeHtml(formatUnits(s.units))})</span></span>
      </label>`).join("")
    : `<div class="empty-state">${subjects.length ? "No subject matches." : 'No subjects yet. <a href="subjects.html">Add subjects</a> first.'}</div>`;
  els.count.textContent = `${chosen.size} selected`;
}

function render() {
  els.total.textContent = list.length;
  if (!list.length) { tableMessage(els.body, 5, "No curriculum saved yet. Fill in the form to add the first one."); return; }
  const code = (id) => subjects.find((s) => s.id === id)?.subjectCode || "(deleted subject)";
  els.body.removeAttribute("aria-busy");
  els.body.innerHTML = list.map((c) => `
    <tr>
      <td class="fw-semibold">${escapeHtml(c.program)}</td>
      <td>${escapeHtml(c.yearLevel)}</td>
      <td>${escapeHtml(termName(c.term))}</td>
      <td><span class="badge badge-count">${(c.subjectIds || []).length}</span> <span class="small text-secondary">${escapeHtml((c.subjectIds || []).map(code).join(", "))}</span></td>
      <td class="text-end text-nowrap">
        <button class="btn btn-sm btn-outline-secondary" data-edit="${escapeHtml(c.id)}"><i class="bi bi-pencil me-1"></i>Edit</button>
        <button class="btn btn-sm btn-outline-danger ms-1" data-delete="${escapeHtml(c.id)}"><i class="bi bi-trash me-1"></i>Delete</button>
      </td>
    </tr>`).join("");
}

function resetForm(c = null) {
  editingId = c ? c.id : null;
  clearErrors(els.form);
  els.error.textContent = "";
  els.program.value = c?.program || "";
  els.level.value = c?.yearLevel || YEAR_LEVELS[0];
  els.term.value = c?.term || "";
  chosen = new Set(c?.subjectIds || []);
  els.search.value = "";
  els.title.textContent = c ? `Edit ${c.program} · ${c.yearLevel} · ${termName(c.term)}` : "Add or edit a curriculum";
  els.btnNew.classList.toggle("d-none", !c);
  renderSubjects();
}

async function load() {
  tableLoading(els.body, 5);
  try {
    const [subSnap, curSnap, secSnap] = await Promise.all([
      getDocs(collection(db, "subjects")), getDocs(collection(db, "curriculum")), getDocs(collection(db, "sections")),
    ]);
    subjects = subSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.subjectCode, b.subjectCode));
    list = curSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) =>
      compareText(a.program, b.program) || YEAR_LEVELS.indexOf(a.yearLevel) - YEAR_LEVELS.indexOf(b.yearLevel) ||
      (TERMS.indexOf(a.term) + 99) % 99 - (TERMS.indexOf(b.term) + 99) % 99);
    const programs = [...new Set([...secSnap.docs.map((d) => programOf(d.data().sectionName)), ...list.map((c) => c.program)].filter(Boolean))].sort(compareText);
    els.programList.innerHTML = programs.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");
    renderSubjects();
    render();
  } catch (err) {
    tableMessage(els.body, 5, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

async function save(e) {
  e.preventDefault();
  clearErrors(els.form);
  els.error.textContent = "";
  const program = els.program.value.trim().toUpperCase().replace(/\s+/g, " ");
  const yearLevel = els.level.value;
  const term = TERMS.includes(els.term.value) ? els.term.value : "";
  let ok = true;
  if (!program) { fieldError(els.program, "Enter the program, for example BSC."); ok = false; }
  if (!chosen.size) { els.error.textContent = "Tick at least one subject."; ok = false; }
  if (!ok) return;
  const id = curriculumId(program, yearLevel, term);
  // Saving under another program / level / term than the one being edited
  if (list.some((c) => c.id === id) && id !== editingId) {
    const go = await confirmDialog({
      title: "Replace the saved curriculum?",
      message: `${program} · ${yearLevel} · ${termName(term)} is already saved. Replace its subjects with these ${chosen.size}?`,
      confirmText: "Replace", variant: "primary",
    });
    if (!go) return;
  }
  setBusy(els.btnSave, true);
  try {
    const subjectIds = subjects.filter((s) => chosen.has(s.id)).map((s) => s.id); // subject-code order
    await setDoc(doc(db, "curriculum", id), { program, yearLevel, term, subjectIds, updatedAt: serverTimestamp() });
    if (editingId && editingId !== id) await deleteDoc(doc(db, "curriculum", editingId));
    toast(`Curriculum saved: ${program} · ${yearLevel} · ${termName(term)} (${subjectIds.length} subjects).`);
    resetForm();
    await load();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnSave, false);
  }
}

async function remove(id) {
  const c = list.find((x) => x.id === id);
  if (!c) return;
  const ok = await confirmDialog({
    title: "Delete this curriculum?",
    message: `${c.program} · ${c.yearLevel} · ${termName(c.term)} will be removed. Grading assignments already created from it stay.`,
    confirmText: "Delete",
  });
  if (!ok) return;
  try {
    await deleteDoc(doc(db, "curriculum", id));
    if (editingId === id) resetForm();
    toast("Curriculum deleted.");
    await load();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

function init() {
  els.level.innerHTML = YEAR_LEVELS.map((l) => `<option>${l}</option>`).join("");
  els.term.innerHTML = `<option value="">No term (whole school year)</option>` + TERMS.map((t) => `<option>${t}</option>`).join("");
  els.subjects.addEventListener("change", (e) => {
    if (e.target.type !== "checkbox") return;
    e.target.checked ? chosen.add(e.target.value) : chosen.delete(e.target.value);
    els.count.textContent = `${chosen.size} selected`;
  });
  els.search.addEventListener("input", renderSubjects);
  els.form.addEventListener("submit", save);
  els.btnNew.addEventListener("click", () => resetForm());
  els.body.addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-delete]");
    if (ed) { resetForm(list.find((c) => c.id === ed.dataset.edit)); window.scrollTo({ top: 0, behavior: "smooth" }); }
    if (del) remove(del.dataset.delete);
  });
  resetForm();
  load();
}

initLayout("curriculum").then((user) => {
  if (user) init();
  else tableMessage(els.body, 5, "Connect Firebase and sign in to load the curriculum.");
});
