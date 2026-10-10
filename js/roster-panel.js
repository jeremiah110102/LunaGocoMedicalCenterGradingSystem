// ==========================================================
// roster-panel.js — Enter grades → "Class list change": a teacher asks the registrar to add,
// remove or move students of one of their classes (see roster-requests.js).
//   1. choose what needs to change (Add / Remove / Move to another class)
//   2. pick the student, then (Move) the class the student belongs to: search "2B" or "Joseph",
//      or "Not in the list?" → a section and the teacher's name (no class there yet)
//   3. give a reason (tap one or write one); a one-sentence preview shows what the registrar reads
// The lines are kept in a draft the teacher can check and edit, then submitted; the registrar
// decides each line on the Notifications page. Nothing in the class changes before that.
// ==========================================================

import { db, collection, doc, getDocs, query, where, serverTimestamp } from "./firebase-config.js";
import { toast, confirmDialog, escapeHtml, setBusy, compareText, errorMessage, commitOperations } from "./app.js";
import { gradeText } from "./grading-scale.js";
import { termOf } from "./terms.js";
import { checkItem, moveTargets, findTarget, describe, MAX_ITEMS, MIN_REASON } from "./roster-requests.js";

const $ = (id) => document.getElementById(id);
const els = {
  btn: $("btnRoster"), badge: $("rosterBadge"), modalEl: $("rosterModal"), sub: $("rosterSub"),
  error: $("rosterError"), status: $("rosterStatus"), partWrap: $("rosterPartWrap"), part: $("rosterPart"),
  choose: $("rosterChoose"), steps: $("rosterSteps"), find: $("rosterFind"), students: $("rosterStudents"),
  targetStep: $("rosterTargetStep"), classFind: $("rosterClassFind"), classes: $("rosterClasses"),
  notListed: $("rosterNotListed"), other: $("rosterOther"), section: $("rosterSection"), teacherName: $("rosterTeacherName"),
  chips: $("rosterChips"), reason: $("rosterReason"), preview: $("rosterPreview"), addRow: $("rosterAddRow"),
  btnAdd: $("btnRosterAdd"), btnCancel: $("btnRosterCancel"), lineError: $("rosterLineError"),
  draftHead: $("rosterDraftHead"), lines: $("rosterLines"), btnWithdraw: $("btnRosterWithdraw"), btnSubmit: $("btnRosterSubmit"),
};

// Ready-made reasons for each kind of change (the teacher can edit them)
const REASONS = {
  add: ["Enrolled late, not yet in my list", "On the registrar's enrollment list for this class"],
  remove: ["Not my student, not enrolled in this class", "Dropped this subject", "Listed twice by mistake"],
  move: ["Not my student, belongs to another section", "Changed section this term", "Enrolled in another teacher's class"],
};

let me = null;
let getClass = () => null; // grading.js: { parts, rows, locked } of the open class
let modal = null;
let open = new Map(); // part id -> its open request (draft or submitted), or null
let partId = "";
let subjectClasses = []; // the part's subject in every section (same school year and term)
let yearStudents = []; // students of the part's school year
let yearSections = []; // sections of the part's school year
let busy = false;
// The change being written: { type, studentId, toAssignmentId, otherOpen }
let pick = { type: "", studentId: "", toAssignmentId: "", otherOpen: false };

const OPEN = ["draft", "submitted"];
const DECISION = {
  pending: ["Waiting", "text-bg-warning"], approved: ["Approved", "badge-pass"],
  declined: ["Declined", "badge-fail"], skipped: ["Could not be made", "badge-none"],
};
const who = () => me.displayName || me.username || "";
const newId = () => Math.random().toString(36).slice(2, 10);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const part = () => (getClass()?.parts || []).find((p) => p.id === partId) || null;
const req = () => open.get(partId) || null;
const editable = () => { const r = req(); return !getClass()?.locked && (!r || r.status === "draft"); };

/** Loads the open requests of the class's parts, then marks the button and the rows. */
export async function refreshRoster() {
  const view = getClass();
  if (!view || !me || me.role !== "teacher") return;
  els.btn.classList.remove("d-none");
  const parts = view.parts;
  try {
    const snaps = await Promise.all(parts.map((p) => getDocs(query(collection(db, "rosterRequests"), where("teacherDocId", "==", me.teacherDocId), where("assignmentId", "==", p.id)))));
    open = new Map(parts.map((p, i) => [p.id, snaps[i].docs.map((d) => ({ id: d.id, ...d.data() })).find((r) => OPEN.includes(r.status)) || null]));
  } catch (err) {
    console.warn("Class list requests:", err.code || err);
    open = new Map();
  }
  markRows();
}

function pendingLines() {
  return [...open.values()].filter(Boolean).flatMap((r) => (r.items || []).filter((x) => x.decision === "pending").map((x) => ({ ...x, request: r })));
}

/** Marks the rows of students in a pending line (call after the rows are drawn). */
export function markRows() {
  const lines = pendingLines();
  const reqs = [...open.values()].filter(Boolean);
  els.badge.classList.toggle("d-none", !reqs.length);
  els.badge.textContent = reqs.some((r) => r.status === "submitted") ? `${lines.length} waiting` : reqs.length ? "Draft" : "";
  document.querySelectorAll("[data-roster-mark]").forEach((x) => x.remove());
  const rows = getClass()?.rows || [];
  lines.filter((x) => x.type !== "add").forEach((x) => {
    const i = rows.findIndex((r) => r.studentDocId === x.studentId && r.asg.id === x.request.assignmentId);
    const cell = i >= 0 && document.querySelector(`#gradeBody tr[data-row="${i}"] td:nth-child(3)`);
    if (!cell) return;
    const text = `${x.type === "remove" ? "Removal" : "Move"} ${x.request.status === "draft" ? "in your draft" : "requested"}`;
    cell.insertAdjacentHTML("beforeend", ` <span class="badge text-bg-light border" data-roster-mark>${escapeHtml(text)}</span>`);
  });
}

// ---------- Loading ----------
async function openPanel() {
  const view = getClass();
  if (!view) return;
  const parts = view.parts;
  partId = parts.find((p) => open.get(p.id))?.id || parts[0].id;
  els.partWrap.classList.toggle("d-none", parts.length < 2);
  els.part.innerHTML = parts.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.sectionName)}</option>`).join("");
  els.part.value = partId;
  showError("");
  resetPick("");
  await loadPart();
  modal.show();
}

async function loadPart() {
  const p = part();
  els.sub.textContent = `${p.subjectCode || p.subjectName}, ${p.sectionName}. Nothing changes until the registrar approves.`;
  try {
    const [classes, students, sections] = await Promise.all([
      getDocs(query(collection(db, "gradingAssignments"), where("subjectId", "==", p.subjectId), where("schoolYear", "==", p.schoolYear))),
      getDocs(query(collection(db, "students"), where("schoolYear", "==", p.schoolYear))),
      getDocs(query(collection(db, "sections"), where("schoolYear", "==", p.schoolYear))),
    ]);
    subjectClasses = classes.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => termOf(a) === termOf(p));
    yearStudents = students.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.studentName, b.studentName));
    yearSections = sections.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.sectionName, b.sectionName));
  } catch (err) {
    subjectClasses = [p];
    yearStudents = [];
    yearSections = [];
    showError(errorMessage(err));
  }
  render();
}

function ctx(items) {
  const p = part();
  const fresh = subjectClasses.find((a) => a.id === p.id) || p;
  const grades = (getClass()?.rows || []).filter((r) => r.asg.id === p.id && r.gradeDoc).map((r) => r.gradeDoc);
  return { assignment: fresh, assignments: subjectClasses.some((a) => a.id === p.id) ? subjectClasses : [fresh, ...subjectClasses], grades, items: items || req()?.items || [] };
}

function showError(text) {
  els.error.textContent = text;
  els.error.classList.toggle("d-none", !text);
}

const draftGradeOf = (sid) => {
  const g = ctx().grades.find((x) => x.studentId === sid && x.draft);
  return g ? gradeText(g.finalGrade, g.remarks) || "an empty grade" : "";
};

// ---------- The change being written ----------
function resetPick(type) {
  pick = { type, studentId: "", toAssignmentId: "", otherOpen: false };
  els.find.value = "";
  els.classFind.value = "";
  els.reason.value = "";
  els.teacherName.value = "";
  els.lineError.textContent = "";
}

/** The line the form describes now (not yet checked). */
function currentItem() {
  const sid = pick.studentId;
  const s = yearStudents.find((x) => x.id === sid) || {};
  const row = (getClass()?.rows || []).find((r) => r.asg.id === partId && r.studentDocId === sid);
  const item = {
    id: newId(), type: pick.type, studentId: sid,
    studentName: s.studentName || row?.studentName || "", studentNumber: s.studentId || row?.studentNumber || "",
    toAssignmentId: "", toSectionId: "", toSectionName: "", toTeacherName: "",
    reason: els.reason.value.trim(), draftGrade: pick.type === "add" || !sid ? "" : draftGradeOf(sid),
    decision: "pending", note: "",
  };
  if (pick.type === "move") {
    const cls = !pick.otherOpen && subjectClasses.find((a) => a.id === pick.toAssignmentId);
    if (cls) {
      Object.assign(item, { toAssignmentId: cls.id, toSectionId: cls.sectionId || "", toSectionName: cls.sectionName || "", toTeacherName: cls.teacherName || "" });
    } else if (pick.otherOpen && els.section.value) {
      const sec = yearSections.find((x) => x.id === els.section.value) || {};
      Object.assign(item, { toSectionId: els.section.value, toSectionName: sec.sectionName || "", toTeacherName: els.teacherName.value.trim() });
    }
  }
  return item;
}

function studentPool(type, c) {
  const inClass = new Set(c.assignment.studentIds || []);
  const rowsOf = new Map((getClass()?.rows || []).filter((r) => r.asg.id === partId).map((r) => [r.studentDocId, r]));
  return type === "add"
    ? yearStudents.filter((s) => !inClass.has(s.id))
    : [...inClass].map((id) => yearStudents.find((s) => s.id === id) || { id, studentName: rowsOf.get(id)?.studentName || "(student record not found)", studentId: rowsOf.get(id)?.studentNumber || "" })
      .sort((a, b) => compareText(a.studentName, b.studentName));
}

function drawStudents() {
  const c = ctx();
  const q = els.find.value.trim().toLowerCase();
  const pool = studentPool(pick.type, c).filter((s) => !q || `${s.studentName} ${s.studentId}`.toLowerCase().includes(q));
  const shown = pool.slice(0, 60);
  els.students.innerHTML = shown.map((s) => {
    // Only what is wrong with the student itself (the class and the reason come later)
    const probe = { id: "?", type: pick.type, studentId: s.id, reason: "x".repeat(MIN_REASON), toSectionId: "?" };
    const why = checkItem(probe, { ...c, items: [] });
    const on = pick.studentId === s.id;
    return `<button type="button" class="roster-person" data-roster-student="${escapeHtml(s.id)}" aria-pressed="${on}"${why ? " disabled" : ""}>
      <span>${escapeHtml(s.studentName || "(no name)")}</span><span class="rp-sub">${escapeHtml(s.studentId || "")}${pick.type === "add" && s.sectionName ? `, ${escapeHtml(s.sectionName)}` : ""}</span>
      ${why ? `<span class="rp-why">${escapeHtml(why)}</span>` : ""}</button>`;
  }).join("") + (pool.length > shown.length ? `<div class="roster-empty">${pool.length - shown.length} more: type a name to find them.</div>` : "")
    || `<div class="roster-empty">${q ? "No student matches. Check the spelling or search by student ID." : pick.type === "add" ? "Every student of this school year is already in this class." : "This class has no students."}</div>`;
}

function drawClasses() {
  const c = ctx();
  const q = els.classFind.value.trim().toLowerCase();
  const targets = moveTargets(c.assignment, c.assignments)
    .filter((a) => !q || `${a.sectionName} ${a.teacherName}`.toLowerCase().includes(q))
    .sort((a, b) => compareText(a.sectionName, b.sectionName));
  const subject = c.assignment.subjectCode || c.assignment.subjectName;
  els.classes.innerHTML = targets.map((a) => {
    const already = pick.studentId && (a.studentIds || []).includes(pick.studentId);
    const on = !pick.otherOpen && pick.toAssignmentId === a.id;
    return `<button type="button" class="roster-person" data-roster-class="${escapeHtml(a.id)}" aria-pressed="${on}"${already ? " disabled" : ""}>
      <span><strong>${escapeHtml(a.sectionName)}</strong></span><span class="rp-sub">${escapeHtml(subject)}${a.teacherName ? ` with ${escapeHtml(a.teacherName)}` : ""}</span>
      ${already ? `<span class="rp-why">Already in that class.</span>` : ""}</button>`;
  }).join("") || `<div class="roster-empty">${q ? `No ${escapeHtml(subject)} class matches "${escapeHtml(els.classFind.value.trim())}".` : `No other section has a ${escapeHtml(subject)} class this term.`} Use <strong>Not in the list?</strong> below.</div>`;
  els.other.hidden = !pick.otherOpen;
  els.notListed.setAttribute("aria-expanded", String(pick.otherOpen));
  if (pick.otherOpen && !els.section.options.length) {
    const own = c.assignment.sectionId;
    const has = new Map(moveTargets(c.assignment, c.assignments).map((a) => [a.sectionId, a]));
    els.section.innerHTML = `<option value="">Choose a section</option>` + yearSections.filter((s) => s.id !== own)
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.sectionName)}${has.has(s.id) ? ` (has ${escapeHtml(subject)}${has.get(s.id).teacherName ? ` with ${escapeHtml(has.get(s.id).teacherName)}` : ""})` : ""}</option>`).join("");
  }
}

function drawChips() {
  els.chips.innerHTML = (REASONS[pick.type] || []).map((t) => `<button type="button" class="roster-chip" data-roster-reason>${escapeHtml(t)}</button>`).join("");
}

/** The sentence the registrar will read, once the form says enough. */
function drawPreview() {
  const item = currentItem();
  const ready = item.studentId && (item.type !== "move" || item.toAssignmentId || item.toSectionId);
  els.preview.hidden = !ready;
  els.addRow.hidden = !pick.type;
  if (!ready) return;
  const p = part();
  const target = item.type === "move" ? findTarget(item, ctx().assignment, ctx().assignments) : null;
  els.preview.textContent = describe(item, p, target);
}

function drawForm() {
  els.choose.querySelectorAll("[data-roster-type]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.rosterType === pick.type)));
  els.steps.hidden = !pick.type;
  els.targetStep.hidden = pick.type !== "move";
  if (!pick.type) { els.preview.hidden = true; els.addRow.hidden = true; return; }
  drawStudents();
  if (pick.type === "move") drawClasses();
  drawPreview();
}

// ---------- The draft ----------
function render() {
  const r = req();
  const canEdit = editable();
  const locked = getClass()?.locked;
  const p = part();
  els.status.innerHTML = !r ? ""
    : r.status === "draft" ? `<span class="badge text-bg-secondary">Draft</span> Only you can see it until you submit it.`
    : `<span class="badge text-bg-warning">Submitted</span> ${r.reviewStarted ? "The registrar is deciding it." : "Waiting for the registrar. You can still withdraw it."}`;
  if (locked) els.status.insertAdjacentHTML("beforeend", ` <span class="text-danger">Requests are closed during downtime.</span>`);
  els.choose.hidden = !canEdit;
  if (canEdit) drawForm();
  const items = r?.items || [];
  els.draftHead.textContent = !items.length ? "Your draft" : `${r.status === "draft" ? "Your draft" : "Sent to the registrar"}: ${plural(items.length, "change")}`;
  const c = ctx();
  els.lines.innerHTML = items.map((x) => {
    const [label, cls] = DECISION[x.decision] || DECISION.pending;
    const target = x.type === "move" ? findTarget(x, c.assignment, c.assignments) : null;
    const problem = r.status === "draft" ? checkItem(x, c) : "";
    return `<li class="roster-line">
      <span class="rl-text">${escapeHtml(describe(x, p, target))}</span>
      <span class="rl-meta">${escapeHtml(x.reason || "")}${x.draftGrade ? ` Draft grade ${escapeHtml(x.draftGrade)} is deleted when approved.` : ""}</span>
      ${problem ? `<span class="rl-problem">${escapeHtml(problem)}</span>` : ""}
      ${x.note ? `<span class="rl-meta">Registrar: “${escapeHtml(x.note)}”</span>` : ""}
      <span class="rl-side">${r.status === "draft" ? "" : `<span class="badge ${cls}">${label}</span>`}
        ${canEdit ? `<button type="button" class="btn btn-sm btn-link text-danger p-0" data-roster-del="${escapeHtml(x.id)}">Delete</button>` : ""}</span>
    </li>`;
  }).join("") || `<li class="roster-empty">No changes yet. Choose what needs to change above.</li>`;
  els.btnSubmit.classList.toggle("d-none", !(canEdit && items.length));
  els.btnSubmit.innerHTML = `<i class="bi bi-send me-1" aria-hidden="true"></i>Submit request${items.length ? ` (${items.length})` : ""}`;
  els.btnWithdraw.classList.toggle("d-none", !(r && !locked && (r.status === "draft" || !r.reviewStarted)));
  els.btnWithdraw.textContent = r && r.status === "draft" ? "Discard draft" : "Withdraw";
}

/** Writes the request (creates it the first time). */
async function save(data) {
  const r = req();
  const p = part();
  if (r) {
    await commitOperations([{ type: "update", ref: doc(db, "rosterRequests", r.id), data: { ...data, updatedAt: serverTimestamp() } }]);
    open.set(p.id, { ...r, ...data });
  } else {
    const ref = doc(collection(db, "rosterRequests"));
    const full = {
      assignmentId: p.id, teacherDocId: me.teacherDocId, teacherName: p.teacherName || "",
      subjectId: p.subjectId || "", subjectCode: p.subjectCode || "", subjectName: p.subjectName || "",
      sectionId: p.sectionId || "", sectionName: p.sectionName || "", yearLevel: p.yearLevel || "",
      schoolYear: p.schoolYear || "", term: termOf(p),
      requestedBy: me.uid, requestedByName: who(), status: "draft", reviewStarted: false, items: [],
      ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    };
    await commitOperations([{ type: "set", ref, data: full }]);
    open.set(p.id, { id: ref.id, ...full });
  }
}

async function run(btn, label, fn) {
  if (busy) return;
  busy = true;
  showError("");
  setBusy(btn, true, label);
  try {
    await fn();
  } catch (err) {
    showError(errorMessage(err));
  } finally {
    setBusy(btn, false);
    busy = false;
    render();
    markRows();
  }
}

function addLine() {
  els.lineError.textContent = "";
  if (!pick.studentId) { els.lineError.textContent = "Choose the student first."; return; }
  const items = req()?.items || [];
  if (items.length >= MAX_ITEMS) { els.lineError.textContent = `A request can have up to ${MAX_ITEMS} changes. Submit this one first.`; return; }
  const item = currentItem();
  const why = checkItem(item, ctx(items));
  if (why) { els.lineError.textContent = why; return; }
  run(els.btnAdd, "Adding…", async () => {
    await save({ items: [...items, item] });
    resetPick("");
  });
}

function deleteLine(id) {
  const items = (req()?.items || []).filter((x) => x.id !== id);
  run(els.btnAdd, "Saving…", () => save({ items }));
}

async function submit() {
  const r = req();
  if (!r || !(r.items || []).length) return;
  const c = ctx();
  const bad = r.items.map((x) => checkItem(x, c)).filter(Boolean);
  if (bad.length) { showError(`Fix or delete the ${bad.length === 1 ? "change" : plural(bad.length, "change")} marked in red first.`); return; }
  const ok = await confirmDialog({
    title: "Submit this request?",
    message: `${plural(r.items.length, "change")} for ${r.subjectCode}, ${r.sectionName} go to the registrar. You can't edit them after submitting; you can withdraw the request until the registrar starts deciding it.`,
    confirmText: "Submit request",
  });
  if (!ok) return;
  run(els.btnSubmit, "Submitting…", async () => {
    await save({ status: "submitted", submittedAt: serverTimestamp() });
    toast("Request submitted. You'll get a notification when it's decided.");
  });
}

async function withdraw() {
  const r = req();
  if (!r) return;
  const ok = await confirmDialog({
    title: r.status === "draft" ? "Discard this draft?" : "Withdraw this request?",
    message: `The ${plural(r.items.length, "change")} for ${r.subjectCode}, ${r.sectionName} won't go to the registrar.`,
    confirmText: r.status === "draft" ? "Discard draft" : "Withdraw request",
  });
  if (!ok) return;
  run(els.btnWithdraw, "Withdrawing…", async () => {
    await commitOperations([{ type: "update", ref: doc(db, "rosterRequests", r.id), data: { status: "withdrawn", updatedAt: serverTimestamp() } }]);
    open.set(partId, null);
    toast(r.status === "draft" ? "Draft discarded." : "Request withdrawn.");
  });
}

/** Wires the button and the panel (teachers only). getClassFn() → { parts, rows, locked }. */
export function initRosterPanel(profile, getClassFn) {
  if (!els.btn || profile.role !== "teacher") return;
  me = profile;
  getClass = getClassFn;
  modal = new bootstrap.Modal(els.modalEl);
  els.btn.addEventListener("click", openPanel);
  els.part.addEventListener("change", () => { partId = els.part.value; resetPick(""); loadPart(); });
  els.choose.addEventListener("click", (e) => {
    const t = e.target.closest("[data-roster-type]");
    if (t) { resetPick(t.dataset.rosterType); drawChips(); drawForm(); els.find.focus(); return; }
    const s = e.target.closest("[data-roster-student]");
    if (s && !s.disabled) { pick.studentId = s.dataset.rosterStudent; drawForm(); return; }
    const c = e.target.closest("[data-roster-class]");
    if (c && !c.disabled) { pick.toAssignmentId = c.dataset.rosterClass; pick.otherOpen = false; drawForm(); return; }
    if (e.target.closest("#rosterNotListed")) { pick.otherOpen = !pick.otherOpen; pick.toAssignmentId = ""; drawForm(); if (pick.otherOpen) els.section.focus(); return; }
    const chip = e.target.closest("[data-roster-reason]");
    if (chip) { els.reason.value = chip.textContent; drawPreview(); els.reason.focus(); }
  });
  els.find.addEventListener("input", drawStudents);
  els.classFind.addEventListener("input", drawClasses);
  els.section.addEventListener("change", drawPreview);
  els.teacherName.addEventListener("input", drawPreview);
  els.reason.addEventListener("input", () => { els.lineError.textContent = ""; });
  els.btnAdd.addEventListener("click", addLine);
  els.btnCancel.addEventListener("click", () => { resetPick(""); drawForm(); });
  els.btnSubmit.addEventListener("click", submit);
  els.btnWithdraw.addEventListener("click", withdraw);
  els.lines.addEventListener("click", (e) => {
    const del = e.target.closest("[data-roster-del]");
    if (del) deleteLine(del.dataset.rosterDel);
  });
  els.modalEl.addEventListener("hidden.bs.modal", () => { els.section.innerHTML = ""; });
}
