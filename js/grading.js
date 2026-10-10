// ==========================================================
// grading.js — Enter final grades (collection: grades)
// One grade document per Student + Grading Assignment.
// Remarks are always computed, never typed.
// ==========================================================

import {
  db, collection, doc, getDoc, getDocs, query, where, documentId, serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, setBusy, compareText,
  errorMessage, commitOperations, formatUnits, remarksFor, tableLoading,
  clearErrors, fieldError, formatGrade, getDowntime, downtimeActive, downtimeText, getOptions,
} from "./app.js";
import { parseGrade, remarksClass, scaleHint, gradeRangeText, parsedRemarks, gradeText, gradeProblem, compareBest } from "./grading-scale.js";
import { hasLeft, statusLabel, statusBadge } from "./student-status.js";
import { TERMS, termOf, yearTermText, termClosed, termDeadline, deadlineText } from "./terms.js";
import { combinedGroups, combinedView, combineOn } from "./combined.js";
import { matchNames, fold } from "./name-list.js";
import { initRosterPanel, refreshRoster, markRows as markRosterRows } from "./roster-panel.js";

const els = {
  select: document.getElementById("assignmentSelect"),
  sheet: document.getElementById("sheet"),
  sheetEmpty: document.getElementById("sheetEmpty"),
  title: document.getElementById("recordTitle"),
  sub: document.getElementById("recordSub"),
  meta: document.getElementById("recordMeta"),
  tally: document.getElementById("tally"),
  body: document.getElementById("gradeBody"),
  btnSave: document.getElementById("btnSaveGrades"),
  btnSubmit: document.getElementById("btnSubmitGrades"),
  foot: document.querySelector("#sheet .record-foot"),
  dirtyNote: document.getElementById("dirtyNote"),
  notice: document.getElementById("saveNotice"),
  cards: document.getElementById("classCards"),
  rowSearch: document.getElementById("rowSearch"),
  rowFilter: document.getElementById("rowFilter"),
  rowSort: document.getElementById("rowSort"),
  rowCount: document.getElementById("rowCount"),
  rowNone: document.getElementById("rowNone"),
  requestModalEl: document.getElementById("requestModal"),
  requestForm: document.getElementById("requestForm"),
  requestError: document.getElementById("requestError"),
  requestFacts: document.getElementById("requestFacts"),
  requestGrade: document.getElementById("requestGrade"),
  requestRemarks: document.getElementById("requestRemarks"),
  requestReason: document.getElementById("requestReason"),
  requestApprovers: document.getElementById("requestApprovers"),
  btnSendRequest: document.getElementById("btnSendRequest"),
};


let me = null; // signed-in user profile
let assignments = [];
let current = null; // selected assignment (or a combined class: current.parts = its assignments)
let combos = new Map(); // "combo:key" -> combined class (Setup and options → Combined classes)
let rows = []; // { studentDocId, studentNumber, studentName, gradeDoc, original, asg (its own assignment) }
let pendingByGrade = {}; // gradeId -> pending change request
let openSeq = 0; // the latest class being opened (an older one finishing late is ignored)

// ---------- Grade parsing (follows the school's grading scale: grading-scale.js) ----------
function remarksBadge(parsed) {
  if (parsed.state === "empty") return `<span class="badge badge-none">Not graded</span>`;
  if (parsed.state === "invalid") return `<span class="badge badge-fail">Check grade</span>`;
  const r = parsedRemarks(parsed);
  return `<span class="badge ${remarksClass(r)}">${r}</span>`;
}

// ---------- Assignment picker ----------
// Teacher downtime (School settings): teachers can only view grades while it's on
let closed = false;
// Term deadline (Setup and options): this class's term is closed for teachers
let termShut = false;
let shutText = "";

/** Re-reads the term deadlines; true if the current class's term is closed for teachers. */
async function checkTerm(force = false) {
  if (me.role !== "teacher" || !current) { termShut = false; shutText = ""; return false; }
  const o = await getOptions(force);
  termShut = termClosed(o, termOf(current));
  shutText = termShut ? termShutText(o) : "";
  els.btnSave.disabled = closed || termShut;
  els.btnSave.title = termShut ? termShutText(o) : closed ? "Grade entry is closed for teachers (downtime)." : "";
  return termShut;
}
function termShutText(o) {
  const dl = termDeadline(o, termOf(current));
  return `Grade entry for the ${termOf(current) || "school year"} is closed${dl ? ` (the last day was ${deadlineText(dl - 1)})` : ""}. Ask the registrar to enter late grades.`;
}

/** Re-reads the downtime setting; true (and the sheet turns read-only) if teachers are locked out. */
async function checkClosed() {
  if (me.role !== "teacher") return false;
  const d = await getDowntime();
  const now = downtimeActive(d);
  if (now !== closed) {
    closed = now;
    applyClosed();
    if (rows.length) renderRows();
  }
  if (closed) toast(downtimeText(d), "warning");
  return closed;
}

function applyClosed() {
  els.btnSave.disabled = closed || termShut;
  els.btnSave.title = closed ? "Grade entry is closed for teachers (downtime)." : shutText;
  updateSubmit(rows.length > 0 && hasUnsavedChanges());
}

/** Submit grades: on while there are drafts or unsaved grades and grade entry is open. Staff see it
 *  only when the class has a teacher's drafts. */
function updateSubmit(dirty) {
  if (!me || saving) return;
  const waiting = rows.some((r) => isDraft(r.gradeDoc));
  if (me.role !== "teacher") {
    els.btnSubmit.classList.toggle("d-none", !waiting);
    els.btnSubmit.disabled = false;
    return;
  }
  els.btnSubmit.disabled = closed || termShut || !(waiting || dirty);
  els.btnSubmit.title = closed || termShut ? els.btnSave.title : !(waiting || dirty) ? "Nothing to submit: every saved grade is submitted." : "";
}

async function loadAssignments() {
  const isTeacher = me.role === "teacher";
  if (isTeacher && !me.teacherDocId) {
    els.select.innerHTML = `<option value="">Your account isn't linked to a teacher</option>`;
    els.select.disabled = true;
    els.sheetEmpty.innerHTML = `<div class="empty-state">Your account isn't linked to a teacher record yet. Ask an administrator to link it on the Users and roles page.</div>`;
    return;
  }
  try {
    // Teachers only see their own grading assignments
    const source = isTeacher
      ? query(collection(db, "gradingAssignments"), where("teacherDocId", "==", me.teacherDocId))
      : collection(db, "gradingAssignments");
    const snap = await getDocs(source);
    assignments = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (err) {
    els.select.innerHTML = `<option value="">Couldn't load assignments</option>`;
    toast(errorMessage(err), "danger");
    return;
  }

  if (!assignments.length) {
    els.select.innerHTML = `<option value="">No grading assignments yet</option>`;
    els.select.disabled = true;
    els.sheetEmpty.innerHTML = isTeacher
      ? `<div class="empty-state">No classes are assigned to you yet. The registrar creates grading assignments; they'll appear here.</div>`
      : `<div class="empty-state">Create a grading assignment first, then come back here to enter grades.
      <div class="mt-3"><a class="btn btn-primary btn-sm" href="assignments.html">Create a grading assignment</a></div></div>`;
    return;
  }

  // Combined classes: the same subject in 2+ sections (same teacher, school year and term)
  combos = new Map();
  const opts = await getOptions().catch(() => ({}));
  if (combineOn(opts)) {
    combinedGroups(assignments).forEach((parts, key) => {
      const v = combinedView(key, parts);
      combos.set(v.id, v);
    });
  }
  const comboOf = (teacher) => [...combos.values()].filter((v) => v.teacherName === teacher);

  // Group by teacher
  const byTeacher = {};
  assignments.forEach((a) => {
    if (!byTeacher[a.teacherName]) byTeacher[a.teacherName] = [];
    byTeacher[a.teacherName].push(a);
  });
  els.select.innerHTML =
    `<option value="">Select a grading assignment</option>` +
    Object.keys(byTeacher)
      .sort(compareText)
      .map(
        (teacher) =>
          `<optgroup label="${escapeHtml(teacher)}">` +
          comboOf(teacher)
            .map((v) => `<option value="${escapeHtml(v.id)}">${escapeHtml(v.subjectCode)} ${escapeHtml(v.subjectName)}, ${escapeHtml(v.sectionName)}, ${escapeHtml(yearTermText(v.schoolYear, termOf(v)))} (combined)</option>`)
            .join("") +
          byTeacher[teacher]
            .sort((a, b) => compareText(b.schoolYear, a.schoolYear) || compareText(a.subjectCode, b.subjectCode))
            .map(
              (a) =>
                `<option value="${a.id}">${escapeHtml(a.subjectCode)} ${escapeHtml(a.subjectName)}, ${escapeHtml(a.sectionName)}, ${escapeHtml(yearTermText(a.schoolYear, termOf(a)))}</option>`
            )
            .join("") +
          `</optgroup>`
      )
      .join("");

  if (isTeacher) {
    deadlineOpts = opts;
    try {
      // One read for every class's progress (the security rules let a teacher list only their own grades)
      const snap = await getDocs(query(collection(db, "grades"), where("teacherDocId", "==", me.teacherDocId)));
      snap.forEach((d) => {
        const g = d.data();
        setOf(graded, g.assignmentId).add(g.studentId);
        if (isDraft(g)) setOf(drafts, g.assignmentId).add(g.studentId);
      });
    } catch (err) {
      countsFailed = true;
    }
    renderCards();
    els.select.closest(".panel").classList.add("d-none");
    document.querySelector(".page-lede").textContent = "Pick one of your classes, type each student's final grade, and save. Saved grades stay editable until you click Submit grades (or the term's deadline passes). Remarks are calculated for you.";
    els.sheetEmpty.innerHTML = `<div class="empty-state">Pick a class above to open its class record.</div>`;
  }

  // A link to a class (Dashboard → Grade), else the class opened last time
  const fromUrl = new URLSearchParams(location.search).get("assignment");
  const last = readLast();
  const id = fromUrl && findView(fromUrl) ? fromUrl : last && findView(last) ? last : "";
  if (id) {
    els.select.value = id;
    // On phones the keyboard would pop up by itself, so only focus with a mouse / trackpad
    openAssignment(id, { focus: !matchMedia("(pointer: coarse)").matches });
  }
}

// ---------- The class opened last time (per account, this browser) ----------
const lastKey = () => `gs-last-class:${me.uid}`;
function readLast() {
  try { return localStorage.getItem(lastKey()); } catch (e) { return null; }
}
function writeLast(id) {
  try { if (id) localStorage.setItem(lastKey(), id); else localStorage.removeItem(lastKey()); } catch (e) { /* private mode: not remembered */ }
}

// ---------- Teachers: class cards with progress and deadline ----------
const graded = new Map(); // assignmentId -> students with a saved grade
const leftOut = new Map(); // assignmentId -> students who left without a grade (known once the class is opened)
const drafts = new Map(); // assignmentId -> students whose grade is saved but not submitted
let countsFailed = false;
let deadlineOpts = {};
const setOf = (map, key) => { if (!map.has(key)) map.set(key, new Set()); return map.get(key); };
const termRank = (v) => (TERMS.includes(termOf(v)) ? TERMS.indexOf(termOf(v)) : TERMS.length);

/** { done, total, waiting }: students graded out of those who still need a grade; waiting = not submitted. */
function progressOf(v) {
  let done = 0;
  let total = 0;
  let waiting = 0;
  partsOf(v).forEach((a) => {
    const g = graded.get(a.id) || new Set();
    const gone = leftOut.get(a.id) || new Set();
    const d = drafts.get(a.id) || new Set();
    (a.studentIds || []).forEach((sid) => {
      if (g.has(sid)) { done++; total++; if (d.has(sid)) waiting++; } else if (!gone.has(sid)) total++;
    });
  });
  return { done, total, waiting };
}

/** The term deadline in words: "2 days left (last day Oct 30, 2026)", "Closed (last day was Oct 1, 2026)"; null without one. */
function dueNote(v) {
  const term = termOf(v);
  const dl = termDeadline(deadlineOpts, term);
  if (dl === null || dl === undefined) return null;
  // The deadline is midnight after the last day chosen in Setup and options
  const last = deadlineText(dl - 1);
  if (termClosed(deadlineOpts, term)) return { cls: "closed", text: `Closed (last day was ${last})` };
  const days = Math.floor((dl - Date.now()) / 86400e3);
  if (days < 1) return { cls: "soon", text: `Today is the last day (${last})` };
  return { cls: days <= 3 ? "soon" : "", text: days <= 7 ? `${days} day${days === 1 ? "" : "s"} left (last day ${last})` : `Last day ${last}` };
}

function cardHtml(v) {
  const { done, total, waiting } = progressOf(v);
  // Progress couldn't be read at the start: known once the class has been opened
  const known = !countsFailed || partsOf(v).every((a) => leftOut.has(a.id));
  const state = total === 0 ? ["none", "No students"]
    : done >= total ? (waiting ? ["ready", "Ready to submit"] : ["done", "Complete"])
    : done === 0 ? ["new", "Not started"] : ["part", "In progress"];
  const due = dueNote(v);
  const pct = known && total ? Math.round((done / total) * 100) : 0;
  return `
    <button type="button" class="class-card" data-open-class="${escapeHtml(v.id)}"${current && current.id === v.id ? ` aria-current="true"` : ""}>
      <span class="class-card-top">
        <span class="class-card-code">${escapeHtml(v.subjectCode || v.subjectName)}</span>
        ${known ? `<span class="class-chip chip-${state[0]}">${state[1]}</span>` : ""}
      </span>
      <span class="class-card-name">${escapeHtml(v.subjectName)}</span>
      <span class="class-card-meta">${escapeHtml(v.sectionName)}${v.combined ? " (combined)" : ""} · ${escapeHtml(yearTermText(v.schoolYear, termOf(v)))}</span>
      <span class="class-card-bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
      <span class="class-card-count">${known ? `${done} of ${total} graded${waiting ? ` · ${waiting} not submitted` : ""}` : `${total} students`}</span>
      ${due ? `<span class="class-card-due ${due.cls}"><i class="bi bi-calendar-event me-1" aria-hidden="true"></i>${escapeHtml(due.text)}</span>` : ""}
    </button>`;
}

function renderCards() {
  if (me.role !== "teacher" || !assignments.length) return;
  // A combined class shows as one card (its parts open through it)
  const inCombo = new Set([...combos.values()].flatMap((v) => v.parts.map((p) => p.id)));
  const views = [...combos.values(), ...assignments.filter((a) => !inCombo.has(a.id))].sort((a, b) =>
    compareText(b.schoolYear, a.schoolYear) || termRank(a) - termRank(b) || compareText(a.subjectCode, b.subjectCode) || compareText(a.sectionName, b.sectionName));
  const latest = views[0].schoolYear;
  const now = views.filter((v) => v.schoolYear === latest);
  const older = views.filter((v) => v.schoolYear !== latest);
  const wasOpen = !!els.cards.querySelector("details[open]") || older.some((v) => current && current.id === v.id);
  els.cards.innerHTML = `
    <h2 class="class-cards-title">Your classes${latest ? `, ${escapeHtml(latest)}` : ""}</h2>
    <div class="class-grid">${now.map(cardHtml).join("")}</div>
    ${older.length ? `<details class="mt-3"${wasOpen ? " open" : ""}><summary>Earlier school years (${older.length})</summary><div class="class-grid mt-2">${older.map(cardHtml).join("")}</div></details>` : ""}`;
  els.cards.classList.remove("d-none");
}

/** Scroll only if the box is off screen or under the Save bar (which stays at the bottom). */
function showBox(input) {
  const r = input.getBoundingClientRect();
  const bottom = Math.min(innerHeight, els.foot.getBoundingClientRect().top) - 8;
  if (r.bottom > bottom) window.scrollBy({ top: r.bottom - bottom });
  else if (r.top < 8) window.scrollBy({ top: r.top - 8 });
}

/** Put the cursor in a grade box, scrolling only as needed. */
function moveTo(input) {
  input.focus({ preventScroll: true });
  input.select();
  showBox(input);
}

/** Focus the first empty grade (opening a class), scrolling only as needed. */
function focusFirstEmpty() {
  const input = [...els.body.querySelectorAll(".grade-input:not([readonly])")].find((i) => isShown(i) && !i.value.trim());
  const top = els.sheet.getBoundingClientRect().top;
  if (top < 0 || top > innerHeight * 0.6) els.sheet.scrollIntoView({ block: "start" });
  if (!input) return;
  input.focus({ preventScroll: true });
  showBox(input);
}

/** A grading assignment, or a combined class. */
const findView = (id) => assignments.find((a) => a.id === id) || combos.get(id) || null;
const partsOf = (v) => (v && v.combined ? v.parts : v ? [v] : []);

// ---------- Class record ----------
async function fetchStudents(ids) {
  const found = {};
  for (let i = 0; i < ids.length; i += 30) {
    const chunk = ids.slice(i, i + 30);
    const snap = await getDocs(query(collection(db, "students"), where(documentId(), "in", chunk)));
    snap.forEach((d) => (found[d.id] = d.data()));
  }
  return found;
}

// Whose grades to read: a teacher always reads their own (the rules allow nothing else)
const ownerOf = (a) => (me.role === "teacher" ? me.teacherDocId : a.teacherDocId);

async function openAssignment(id, { focus = false } = {}) {
  const seq = ++openSeq;
  current = findView(id);
  history.replaceState(null, "", id && current ? `?assignment=${encodeURIComponent(id)}` : location.pathname);
  writeLast(current ? id : "");
  renderCards();

  if (!current) {
    els.sheet.classList.add("d-none");
    els.sheetEmpty.classList.remove("d-none");
    rows = [];
    return;
  }

  els.sheetEmpty.classList.add("d-none");
  els.sheet.classList.remove("d-none");
  renderHeader();
  await checkTerm().catch(() => false);
  if (seq !== openSeq) return;
  tableLoading(els.body, 6, Math.min(Math.max((current.studentIds || []).length, 3), 8));
  els.tally.innerHTML = "";

  try {
    const parts = partsOf(current);
    const ids = [...new Set(parts.flatMap((a) => a.studentIds || []))];
    // teacherDocId filter lets the security rules confirm a teacher only reads their own grades
    const [students, gradeSnaps, reqSnaps] = await Promise.all([
      fetchStudents(ids),
      Promise.all(parts.map((a) => getDocs(query(collection(db, "grades"), where("assignmentId", "==", a.id), where("teacherDocId", "==", ownerOf(a)))))),
      Promise.all(parts.map((a) => getDocs(query(
        collection(db, "gradeChangeRequests"),
        where("assignmentId", "==", a.id),
        where("teacherDocId", "==", ownerOf(a)),
        where("status", "==", "pending")
      )).catch(() => ({ docs: [] })))),
    ]);
    if (seq !== openSeq) return; // another class was opened meanwhile
    pendingByGrade = {};
    reqSnaps.forEach((snap) => snap.docs.forEach((d) => (pendingByGrade[d.data().gradeId] = { id: d.id, ...d.data() })));
    const gradeOf = {}; // "assignmentId|studentId" -> grade
    gradeSnaps.forEach((snap) => snap.forEach((d) => (gradeOf[`${d.data().assignmentId}|${d.data().studentId}`] = { id: d.id, ...d.data() })));

    rows = parts
      .flatMap((asg) => (asg.studentIds || []).map((sid) => ({ asg, sid })))
      .map(({ asg, sid }) => {
        const s = students[sid];
        const g = gradeOf[`${asg.id}|${sid}`] || null;
        return {
          asg,
          studentDocId: sid,
          studentNumber: s?.studentId ?? g?.studentNumber ?? "—",
          studentName: s?.studentName ?? g?.studentName ?? "(student record not found)",
          gradeDoc: g,
          student: s || null,
          // Dropped / transferred out with no grade yet: nothing to enter
          left: !g && hasLeft(s),
          // Point scales show two decimals (1.50), as on report cards
          original: g ? gradeText(g.finalGrade, g.remarks) : "",
        };
      })
      .sort((a, b) => compareText(a.studentName, b.studentName));

    // Exact progress for this class's card
    parts.forEach((a) => {
      graded.set(a.id, new Set(rows.filter((r) => r.asg.id === a.id && r.gradeDoc).map((r) => r.studentDocId)));
      leftOut.set(a.id, new Set(rows.filter((r) => r.asg.id === a.id && r.left).map((r) => r.studentDocId)));
      drafts.set(a.id, new Set(rows.filter((r) => r.asg.id === a.id && isDraft(r.gradeDoc)).map((r) => r.studentDocId)));
    });
    if (viewClass !== current.id) resetView(); // another class: search and filter start cleared
    viewClass = current.id;
    renderRows();
    renderCards();
    if (focus) focusFirstEmpty();
    refreshRoster();
  } catch (err) {
    if (seq !== openSeq) return;
    els.body.innerHTML = `<tr><td colspan="6" class="empty-state text-danger">${escapeHtml(errorMessage(err))}</td></tr>`;
  }
}

function renderHeader() {
  const a = current;
  els.title.textContent = `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`;
  els.sub.textContent = `${a.combined ? "Combined class record" : "Class record"} for ${a.sectionName}, ${yearTermText(a.schoolYear, termOf(a))}`;
  const meta = [
    ["Teacher", a.teacherName],
    ["Subject", `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`],
    ["Units", formatUnits(a.units)],
    ["School Year", a.schoolYear],
    ...(termOf(a) ? [["Term", termOf(a)]] : []),
    ["Year Level", a.yearLevel],
    [a.combined ? "Sections" : "Section", a.combined ? a.parts.map((p) => `${p.sectionName} (${(p.studentIds || []).length})`).join(" + ") : a.sectionName],
  ];
  els.meta.innerHTML = meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
}

function renderRows() {
  els.body.removeAttribute("aria-busy");
  if (!rows.length) {
    els.body.innerHTML = `<tr><td colspan="6" class="empty-state">This assignment has no students. <a href="assignments.html">Edit the assignment</a> to add some.</td></tr>`;
    updateTally();
    return;
  }
  els.body.innerHTML = rows
    .map((r, i) => {
      const parsed = parseGrade(r.original);
      // Teachers can change their own saved grades until they submit them (Draft, then Submit);
      // after that, changes need approval. During downtime / after the term deadline: read-only.
      const locked = r.left || (me.role === "teacher" && ((!!r.gradeDoc && !isDraft(r.gradeDoc)) || closed || termShut));
      const pending = r.gradeDoc ? pendingByGrade[r.gradeDoc.id] : null;
      const extra = pending
        ? pendingCell(pending)
        : r.left
          ? ""
          : locked && r.gradeDoc && !isDraft(r.gradeDoc) && !closed
          ? `<button type="button" class="btn btn-link btn-sm p-0 ms-2 align-baseline" data-request="${i}"><i class="bi bi-pencil-square me-1"></i>Request change</button>`
          : "";
      return `
      <tr data-row="${i}">
        <td class="num text-secondary">${i + 1}</td>
        <td class="code-cell">${escapeHtml(r.studentNumber)}</td>
        <td>${escapeHtml(r.studentName)}${statusBadge(r.student, escapeHtml)}${current.combined ? `<div class="small text-secondary">${escapeHtml(r.asg.sectionName)}</div>` : ""}</td>
        <td class="grade-col">
          <div class="position-relative">
            <input type="text" inputmode="decimal" class="form-control form-control-sm grade-input${locked ? " grade-locked" : ""}" data-index="${i}"
                   value="${escapeHtml(r.original)}" maxlength="6" autocomplete="off" enterkeyhint="next" ${locked ? `readonly tabindex="-1" title="${r.left ? `${statusLabel(r.student)}: no grade is entered. Set the student back to Regular on the Students page to enter one.` : closed ? "Grade entry is closed for teachers (downtime)." : termShut && (!r.gradeDoc || isDraft(r.gradeDoc)) ? "Grade entry for this term is closed." : "Submitted. Use Request change to edit."}"` : ""}
                   aria-label="Final grade for ${escapeHtml(r.studentName)}${locked ? " (locked)" : ""}"${locked ? "" : ` aria-describedby="gm-${i}"`}>
            ${locked ? "" : `<select class="form-select form-select-sm mark-pick" data-mark="${i}" tabindex="-1" aria-label="Remark instead of a grade for ${escapeHtml(r.studentName)} (or type INC or DRP in the grade box)" title="INC (incomplete) or DRP (dropped)">
              <option value="">…</option><option value="INC">INC – Incomplete</option><option value="DRP">DRP – Dropped</option><option value="clear">Clear</option>
            </select>`}
          </div>
          ${locked ? "" : `<div class="grade-msg d-none" id="gm-${i}"></div>`}
        </td>
        <td data-remarks><span data-badge>${r.left ? "" : remarksBadge(parsed)}</span>${extra}</td>
        <td data-status>${statusHtml(rowState(r, null), r)}</td>
      </tr>`;
    })
    .join("");
  updateTally();
  applyView();
  markRosterRows();
}

// ---------- Find students: search, filter, sort ----------
// Rows are only hidden or moved (never redrawn), so grades typed in them stay.
const view = { q: "", filter: "all", sort: "name" };
let viewClass = null; // the class the search and filter belong to

/** A teacher's grade saved but not submitted yet (grades saved before drafts existed are submitted). */
const isDraft = (g) => !!g && g.draft === true;

/** What a row is now: "left" (dropped, no grade) | "fix" | "unsaved" | "saved" (draft) | "submitted" | "none". */
function rowState(r, input) {
  if (r.left) return "left";
  const value = input ? input.value : r.original;
  if (parseGrade(value).state === "invalid") return "fix";
  if (isDirty(r, value)) return "unsaved";
  return !r.gradeDoc ? "none" : isDraft(r.gradeDoc) ? "saved" : "submitted";
}

// Status column: icon and words (not colour alone)
const STATUS = {
  none: ["bi-circle", "No grade"],
  unsaved: ["bi-pencil-fill", "Unsaved"],
  fix: ["bi-exclamation-triangle-fill", "Check grade"],
  saved: ["bi-check-circle", "Saved"],
  submitted: ["bi-lock-fill", "Submitted"],
};
function statusHtml(state, r) {
  if (state === "left") return `<span class="row-status st-left"><i class="bi bi-slash-circle me-1" aria-hidden="true"></i>${escapeHtml(statusLabel(r.student))}</span>`;
  const [icon, text] = STATUS[state];
  return `<span class="row-status st-${state}"><i class="bi ${icon} me-1" aria-hidden="true"></i>${text}</span>`;
}

const STATE_ORDER = ["none", "fix", "unsaved", "saved", "submitted", "left"];
function compareRows(a, b) {
  const byName = compareText(a.r.studentName, b.r.studentName) || a.i - b.i;
  if (view.sort === "id") return compareText(a.r.studentNumber, b.r.studentNumber) || byName;
  if (view.sort === "todo") return STATE_ORDER.indexOf(rowState(a.r, a.input)) - STATE_ORDER.indexOf(rowState(b.r, b.input)) || byName;
  if (view.sort === "grade") {
    // numbers best first, then INC / DRP, then no grade
    const rank = (x) => { const p = parseGrade(x.input ? x.input.value : x.r.original); return p.state !== "valid" ? [2, null] : p.mark ? [1, null] : [0, p.value]; };
    const [ra, va] = rank(a);
    const [rb, vb] = rank(b);
    return ra - rb || (ra === 0 ? compareBest(va, vb) : 0) || byName;
  }
  return byName;
}

function applyView() {
  const trs = [...els.body.querySelectorAll("tr[data-row]")];
  if (!trs.length) {
    els.rowCount.textContent = "";
    els.rowNone.classList.add("d-none");
    return;
  }
  const words = fold(view.q).split(/\s+/).filter(Boolean);
  const items = trs.map((tr) => ({ tr, i: Number(tr.dataset.row), r: rows[Number(tr.dataset.row)], input: tr.querySelector(".grade-input") }));
  items.sort(compareRows).forEach(({ tr }) => els.body.appendChild(tr));
  let shown = 0;
  items.forEach(({ tr, r, input }) => {
    const text = fold(`${r.studentName} ${r.studentNumber}`);
    const show = words.every((w) => text.includes(w)) && (view.filter === "all" || rowState(r, input) === view.filter);
    tr.classList.toggle("row-hidden", !show);
    if (show) tr.firstElementChild.textContent = ++shown;
  });
  els.rowCount.textContent = shown === rows.length
    ? `${rows.length} student${rows.length === 1 ? "" : "s"}`
    : `Showing ${shown} of ${rows.length} students`;
  els.rowNone.classList.toggle("d-none", shown > 0);
}

/** Clear the search and the filter (the sort stays). */
function resetView() {
  view.q = "";
  view.filter = "all";
  els.rowSearch.value = "";
  els.rowFilter.value = "all";
}

const isShown = (input) => !input.closest("tr").classList.contains("row-hidden");

function isDirty(r, value) {
  const a = parseGrade(value);
  const b = parseGrade(r.original);
  if (a.state !== b.state) return true;
  if (a.state === "valid") return a.value !== b.value || (a.mark || "") !== (b.mark || "");
  return a.state === "invalid";
}

/**
 * The message under a grade box ("Grade must be between 0 and 100."). Shown when the box is
 * left with a wrong grade (or on Save: force), then kept up to date while it's being fixed;
 * not while someone is still typing ("1." on the way to "1.75").
 */
function showProblem(input, force) {
  const msg = document.getElementById(`gm-${input.dataset.index}`);
  if (!msg) return;
  const problem = gradeProblem(input.value);
  if (problem && !force && msg.classList.contains("d-none")) return;
  msg.textContent = problem;
  msg.classList.toggle("d-none", !problem);
  input.classList.toggle("is-invalid", !!problem);
  if (problem) input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
}

function onGradeInput(input) {
  const i = Number(input.dataset.index);
  const r = rows[i];
  const parsed = parseGrade(input.value);
  const tr = input.closest("tr");
  showProblem(input, false);
  tr.querySelector("[data-badge]").innerHTML = remarksBadge(parsed);
  tr.querySelector("[data-status]").innerHTML = statusHtml(rowState(r, input), r);
  tr.classList.toggle("row-dirty", isDirty(r, input.value));
  updateTally();
}

function currentValues() {
  return [...els.body.querySelectorAll(".grade-input")].map((inp) => ({
    input: inp,
    row: rows[Number(inp.dataset.index)],
    parsed: parseGrade(inp.value),
  }));
}

function updateTally() {
  const values = currentValues();
  const entered = values.filter((v) => v.parsed.state === "valid");
  const graded = entered.filter((v) => !v.parsed.mark); // numbers only (INC / DRP aren't averaged)
  const passed = graded.filter((v) => remarksFor(v.parsed.value) === "Passed").length;
  const conditional = graded.filter((v) => remarksFor(v.parsed.value) === "Conditional").length;
  const inc = entered.filter((v) => v.parsed.mark === "Incomplete").length;
  const drp = entered.filter((v) => v.parsed.mark === "Dropped").length;
  const avg = graded.length ? graded.reduce((s, v) => s + v.parsed.value, 0) / graded.length : null;
  const dirty = values.filter((v) => isDirty(v.row, v.input.value)).length;

  els.tally.innerHTML = `
    <span>Students <strong>${rows.length}</strong></span>
    <span>Graded <strong>${graded.length}</strong></span>
    <span class="text-success">Passed <strong>${passed}</strong></span>
    <span style="color:var(--maroon)">Failed <strong>${graded.length - passed - conditional}</strong></span>
    ${conditional ? `<span style="color:#8a5a00">Conditional <strong>${conditional}</strong></span>` : ""}
    ${inc ? `<span style="color:#6e5810">INC <strong>${inc}</strong></span>` : ""}
    ${drp ? `<span class="text-secondary">DRP <strong>${drp}</strong></span>` : ""}
    <span>Class average <strong>${avg === null ? "—" : avg.toFixed(2)}</strong></span>`;

  els.dirtyNote.textContent = dirty
    ? `${dirty} unsaved change${dirty === 1 ? "" : "s"}`
    : shutText || "No unsaved changes";
  els.dirtyNote.classList.toggle("fw-semibold", dirty > 0);
  els.foot.classList.toggle("has-changes", dirty > 0);
  updateSubmit(dirty > 0);
}

function hasUnsavedChanges() {
  return currentValues().some((v) => isDirty(v.row, v.input.value));
}

// ---------- Save grades ----------
// What happened on the last save when it wasn't simply "saved": stays until the next save or class
function showNotice(kind, html) {
  els.notice.className = `alert alert-${kind} save-notice mx-3 mb-0`;
  els.notice.innerHTML = html;
  els.notice.scrollIntoView({ block: "nearest" });
}
function clearNotice() {
  els.notice.className = "alert save-notice d-none mx-3 mb-0";
  els.notice.innerHTML = "";
}
const KEPT = "Your entries are still on this page; click <strong>Save grades</strong> to try again.";

/** Why a save failed, in words a teacher can act on. */
function saveErrorText(err) {
  if (err && err.code === "permission-denied") return "The database didn't accept these grades. Grade entry may have closed, or the class may have changed.";
  if (err && err.code === "not-found") return "A grade was removed by someone else while you were working.";
  return errorMessage(err);
}

/** The class(es) and their grades as they are now: another tab, device or the registrar may have changed them. */
async function readLatest(parts) {
  const asgs = new Map();
  const grades = new Map(); // "assignmentId|studentId" -> grade
  await Promise.all(parts.map(async (a) => {
    const snap = await getDoc(doc(db, "gradingAssignments", a.id));
    asgs.set(a.id, snap.exists() ? { id: a.id, ...snap.data() } : null);
    // Teachers may only read their own grades (the security rules check this filter)
    const q = me.role === "teacher"
      ? query(collection(db, "grades"), where("assignmentId", "==", a.id), where("teacherDocId", "==", me.teacherDocId))
      : query(collection(db, "grades"), where("assignmentId", "==", a.id));
    (await getDocs(q)).forEach((d) => grades.set(`${a.id}|${d.data().studentId}`, { id: d.id, ...d.data() }));
  }));
  return { asgs, grades };
}

let saving = false; // one save at a time (double-click, Enter then click)

/** Saves the typed grades. { ok: true } when everything typed was saved (or nothing needed saving). */
async function saveGrades() {
  if (!current || saving) return { ok: false };
  saving = true;
  clearNotice();
  let result = { ok: false };
  try {
    result = (await saveChanges()) || { ok: false };
  } catch (err) {
    showNotice("danger", `<strong>Not saved.</strong> ${escapeHtml(saveErrorText(err))} ${KEPT}`);
  } finally {
    saving = false;
    setBusy(els.btnSave, false);
    applyClosed();
  }
  return result;
}

// ---------- Grades typed while a save runs ----------
// A save (or submit) re-opens the class at the end; anything typed in the meantime must stay.
const rowKey = (r) => `${r.asg.id}|${r.studentDocId}`;
const snapshotTyped = () => new Map(currentValues().map((v) => [rowKey(v.row), v.input.value]));

/** Re-open the class, then put back grades typed since `before` (a snapshot from the start of the save). */
async function reloadKeepingTyped(before) {
  const typed = snapshotTyped();
  await openAssignment(current.id);
  let kept = 0;
  rows.forEach((r, i) => {
    const k = rowKey(r);
    if (!typed.has(k) || typed.get(k) === before.get(k)) return;
    const input = els.body.querySelector(`.grade-input[data-index="${i}"]`);
    if (!input || input.readOnly || !isDirty(r, typed.get(k))) return;
    input.value = typed.get(k);
    onGradeInput(input);
    kept++;
  });
  if (kept) applyView();
}

async function saveChanges() {
  // Without internet the save would wait (or fail) silently
  if (navigator.onLine === false) {
    showNotice("warning", `<strong>You're offline.</strong> Nothing was saved. Connect to the internet, then click <strong>Save grades</strong>. Your entries are still on this page.`);
    return { ok: false };
  }
  if (await checkClosed()) return { ok: false };
  if (await checkTerm(true)) {
    toast(termShutText(await getOptions()), "warning");
    renderRows();
    return { ok: false };
  }
  const before = snapshotTyped();
  const values = currentValues();

  const invalid = values.filter((v) => v.parsed.state === "invalid");
  if (invalid.length) {
    // A wrong grade hidden by the search or filter: show everyone so it can be fixed
    if (invalid.some((v) => !isShown(v.input))) { resetView(); applyView(); }
    invalid.forEach((v) => showProblem(v.input, true));
    toast(`${invalid.length} grade${invalid.length === 1 ? " needs" : "s need"} fixing. See the message under each red box.`, "warning");
    invalid[0].input.focus();
    return { ok: false };
  }

  const changed = values.filter((v) => isDirty(v.row, v.input.value));
  if (!changed.length) {
    toast("No changes to save.", "info");
    return { ok: true };
  }

  const cleared = changed.filter((v) => v.parsed.state === "empty" && v.row.gradeDoc);
  if (cleared.length) {
    const ok = await confirmDialog({
      title: "Clear saved grades?",
      message: `${cleared.length} previously saved grade(s) were emptied. Saving will delete them.`,
      confirmText: "Save and clear",
      variant: "warning",
    });
    if (!ok) return { ok: false };
  }

  // Each grade goes to the student's own grading assignment (a combined class has several)
  const shared = (a) => ({
    assignmentId: a.id,
    teacherDocId: a.teacherDocId,
    teacherId: a.teacherId,
    teacherName: a.teacherName,
    subjectId: a.subjectId,
    subjectCode: a.subjectCode,
    subjectName: a.subjectName,
    units: Number(a.units),
    schoolYear: a.schoolYear,
    term: termOf(a),
    yearLevel: a.yearLevel,
    sectionId: a.sectionId,
    sectionName: a.sectionName,
  });

  setBusy(els.btnSave, true);
  // Save against the class and grades as they are now, not as they were when the page opened
  const parts = partsOf(current);
  const latest = await readLatest(parts);
  if (parts.every((a) => !latest.asgs.get(a.id))) {
    showNotice("danger", `<strong>Not saved.</strong> This class was deleted while you were working. Copy your entries before leaving this page, and ask the registrar.`);
    return { ok: false };
  }
  if (me.role === "teacher" && parts.every((a) => (latest.asgs.get(a.id)?.teacherDocId ?? me.teacherDocId) !== me.teacherDocId)) {
    showNotice("danger", `<strong>Not saved.</strong> This class is now assigned to another teacher. Copy your entries before leaving this page, and ask the registrar.`);
    return { ok: false };
  }

  const typedText = (p) => gradeText(p.mark ? null : p.value, parsedRemarks(p));
  const taken = []; // saved from another tab or device meanwhile, with a different grade
  const gone = []; // no longer in this class (or its part was deleted / reassigned)
  let alreadySaved = 0; // saved elsewhere with the same grade: nothing to do
  const ops = [];
  changed.forEach(({ row, parsed }) => {
    const asg = latest.asgs.get(row.asg.id);
    if (!asg || (me.role === "teacher" && asg.teacherDocId !== me.teacherDocId) || !(asg.studentIds || []).includes(row.studentDocId)) {
      if (parsed.state !== "empty") gone.push({ row, typed: typedText(parsed) });
      return;
    }
    const now = latest.grades.get(`${asg.id}|${row.studentDocId}`) || null;
    const teacher = me.role === "teacher";
    // A teacher's draft submitted meanwhile (another tab or device) is locked now
    if (teacher && row.gradeDoc && now && !isDraft(now)) {
      taken.push({ row, saved: gradeText(now.finalGrade, now.remarks), typed: parsed.state === "empty" ? "nothing" : typedText(parsed), submitted: true });
      return;
    }
    // A teacher's draft changed meanwhile in another tab or device: not overwritten unseen
    if (teacher && row.gradeDoc && now && gradeText(now.finalGrade, now.remarks) !== row.original) {
      const saved = gradeText(now.finalGrade, now.remarks);
      if (parsed.state !== "empty" && !isDirty({ original: saved }, typedText(parsed))) { alreadySaved++; return; }
      taken.push({ row, saved, typed: parsed.state === "empty" ? "nothing" : typedText(parsed), changed: true });
      return;
    }
    if (parsed.state === "empty") {
      if (now) ops.push({ type: "delete", ref: doc(db, "grades", now.id) });
      return;
    }
    if (now && !row.gradeDoc) {
      const saved = gradeText(now.finalGrade, now.remarks);
      if (!isDirty({ original: saved }, typedText(parsed))) { alreadySaved++; return; }
      // Saved meanwhile from another tab or device: teachers don't overwrite it unseen
      if (teacher) { taken.push({ row, saved, typed: typedText(parsed), submitted: !isDraft(now) }); return; }
    }
    const record = {
      ...shared(asg),
      studentId: row.studentDocId,
      studentNumber: row.studentNumber,
      studentName: row.studentName,
      // INC / DRP: no number, the remark says it
      finalGrade: parsed.mark ? null : parsed.value,
      remarks: parsedRemarks(parsed),
      updatedAt: serverTimestamp(),
    };
    if (now) {
      // Grade exists for this Student + Assignment: update it. A registrar's correction of a
      // teacher's draft is final (the teacher can't overwrite it afterwards).
      ops.push({ type: "update", ref: doc(db, "grades", now.id), data: { ...record, ...(!teacher && isDraft(now) ? { draft: false } : {}) } });
    } else {
      // Deterministic id = one grade per Student + Assignment, never a duplicate.
      // A teacher's new grade is a draft until they submit it.
      ops.push({
        type: "set",
        ref: doc(db, "grades", `${asg.id}_${row.studentDocId}`),
        data: { ...record, ...(teacher ? { draft: true } : {}), createdAt: serverTimestamp() },
        options: { merge: true },
      });
    }
  });

  if (ops.length) await commitOperations(ops);
  const done = ops.length + alreadySaved;
  if (done) toast(`Grades saved for ${done} student${done === 1 ? "" : "s"}.`);

  if (taken.length || gone.length) {
    const li = (x, why) => `<li><strong>${escapeHtml(x.row.studentName)}</strong>: ${why}</li>`;
    showNotice("warning", `<strong>${taken.length + gone.length} grade${taken.length + gone.length === 1 ? " was" : "s were"} not saved.</strong>
      <ul class="mb-0 mt-1">
        ${taken.map((x) => li(x, x.changed
          ? `changed to <strong>${escapeHtml(x.saved)}</strong> in another tab or device (you typed ${escapeHtml(x.typed)}). It's shown now; change it again if it should be ${escapeHtml(x.typed)}.`
          : x.submitted
          ? `already submitted as <strong>${escapeHtml(x.saved)}</strong> from another tab or device (you typed ${escapeHtml(x.typed)}). If it should change, use <em>Request change</em>.`
          : `already saved as <strong>${escapeHtml(x.saved)}</strong> from another tab or device (you typed ${escapeHtml(x.typed)}). It's shown now; change it again if it should be ${escapeHtml(x.typed)}.`)).join("")}
        ${gone.map((x) => li(x, `no longer in this class (you typed ${escapeHtml(x.typed)}). Ask the registrar.`)).join("")}
      </ul>`);
  }
  // Show the class as it is now (units, students), with what was just saved
  parts.forEach((a) => { const fresh = latest.asgs.get(a.id); if (fresh) Object.assign(a, fresh); });
  keepOwnParts(latest);
  await reloadKeepingTyped(before);
  return { ok: !taken.length && !gone.length };
}

/** A combined class drops a part that was deleted or (for a teacher) moved to another teacher. */
function keepOwnParts(latest) {
  if (!current || !current.combined) return;
  current.parts = current.parts.filter((a) => latest.asgs.get(a.id) && (me.role !== "teacher" || latest.asgs.get(a.id).teacherDocId === me.teacherDocId));
  current.studentIds = [...new Set(current.parts.flatMap((a) => a.studentIds || []))];
  current.sectionName = current.parts.map((a) => a.sectionName).join(" + ");
}


// ---------- Submit grades ----------
// A teacher's saved grades stay drafts they can change. Submitting makes them final: after that a
// change needs an approved request. Grades still being typed are saved first. Staff can submit a
// teacher's drafts too.
async function submitGrades() {
  if (!current || saving) return;
  const teacher = me.role === "teacher";
  if (hasUnsavedChanges()) {
    const saved = await saveGrades();
    if (!saved.ok || hasUnsavedChanges()) {
      // Something wasn't saved (a wrong grade, a grade saved elsewhere, an error): it's on screen
      if (!els.notice.classList.contains("d-none")) els.notice.insertAdjacentHTML("beforeend", `<div class="mt-2 fw-semibold">Nothing was submitted. Check the list, then click <em>Submit grades</em> again.</div>`);
      return;
    }
  }
  const waiting = rows.filter((r) => isDraft(r.gradeDoc));
  if (!waiting.length) {
    toast("Nothing to submit: every saved grade is submitted.", "info");
    return;
  }
  const missing = rows.filter((r) => !r.left && !r.gradeDoc).length;
  const n = waiting.length;
  const ok = await confirmDialog({
    title: "Submit grades?",
    message: (teacher
      ? `Submit ${n} grade${n === 1 ? "" : "s"} for ${current.subjectCode || current.subjectName} · ${current.sectionName}? After submitting you can't change them here: a change then needs a request approved by an approver (Request change).`
      : `Submit ${n} of the teacher's draft grade${n === 1 ? "" : "s"} for ${current.subjectCode || current.subjectName} · ${current.sectionName}? The teacher can't change them after that.`) +
      (missing ? ` ${missing} student${missing === 1 ? " has" : "s have"} no grade yet; ${teacher ? "you can add and submit them later, until the deadline" : "the teacher can still add them"}.` : ""),
    confirmText: "Submit grades",
  });
  if (!ok) return;
  saving = true;
  clearNotice();
  setBusy(els.btnSubmit, true, "Submitting…");
  try {
    if (await checkClosed()) return;
    if (await checkTerm(true)) {
      toast(termShutText(await getOptions()), "warning");
      renderRows();
      return;
    }
    const before = snapshotTyped();
    // Only what is still a draft of a student still in the class (another tab, or the registrar,
    // may have changed things meanwhile)
    const latest = await readLatest(partsOf(current));
    const gone = [];
    const ops = [];
    waiting.forEach((r) => {
      const asg = latest.asgs.get(r.asg.id);
      if (!asg || (teacher && asg.teacherDocId !== me.teacherDocId) || !(asg.studentIds || []).includes(r.studentDocId)) { gone.push(r); return; }
      const g = latest.grades.get(rowKey(r));
      if (isDraft(g)) ops.push({ type: "update", ref: doc(db, "grades", g.id), data: { draft: false, submittedAt: serverTimestamp(), updatedAt: serverTimestamp() } });
    });
    if (ops.length) {
      await commitOperations(ops);
      toast(`Submitted ${ops.length} grade${ops.length === 1 ? "" : "s"}.`);
    } else if (!gone.length) {
      toast("Nothing to submit: these grades were already submitted.", "info");
    }
    if (gone.length) {
      showNotice("warning", `<strong>${gone.length} grade${gone.length === 1 ? " was" : "s were"} not submitted.</strong>
        <ul class="mb-0 mt-1">${gone.map((r) => `<li><strong>${escapeHtml(r.studentName)}</strong>: no longer in this class (or the class changed). Ask the registrar.</li>`).join("")}</ul>`);
    }
    partsOf(current).forEach((a) => { const fresh = latest.asgs.get(a.id); if (fresh) Object.assign(a, fresh); });
    keepOwnParts(latest);
    await reloadKeepingTyped(before);
  } catch (err) {
    showNotice("danger", `<strong>Not submitted.</strong> ${escapeHtml(saveErrorText(err))} The saved grades are still drafts; click <strong>Submit grades</strong> to try again.`);
  } finally {
    saving = false;
    setBusy(els.btnSubmit, false);
    applyClosed();
  }
}

// ==========================================================
// Paste grades: names + grades copied from the teacher's Excel class record.
// Each line is matched to a student of this class (like Paste list); the grades
// fill the grade boxes, and nothing is saved until "Save grades".
// ==========================================================
let pasteModal = null;
let pasteResults = [];
const pe = {
  el: document.getElementById("pasteModal"), text: document.getElementById("pasteText"),
  step1: document.getElementById("pasteStep1"), step2: document.getElementById("pasteStep2"),
  summary: document.getElementById("pasteSummary"), body: document.getElementById("pasteBody"),
  back: document.getElementById("pasteBack"), find: document.getElementById("pasteFind"), apply: document.getElementById("pasteApply"),
};

/** "Cruz, Juan A.<TAB>1.75" → { name, grade }. The grade is the last cell (or last word). */
export function splitPasteLine(raw) {
  const cells = String(raw ?? "").split("\t").map((c) => c.trim()).filter(Boolean);
  let name, grade;
  if (cells.length >= 2) {
    grade = cells[cells.length - 1];
    name = cells.slice(0, -1).join(" ");
  } else {
    const m = /^(.*?)[\s,;]+(inc|drp|incomplete|dropped|\d{1,3}(?:\.\d{1,2})?)\s*$/i.exec(String(raw ?? "").trim());
    if (!m) return { name: String(raw ?? "").trim(), grade: "" };
    [, name, grade] = m;
  }
  name = name.replace(/^\s*\d{1,3}\s*[.)]\s+/, "").replace(/\s+/g, " ").trim();
  return { name, grade };
}

function pasteStep(two) {
  pe.step1.classList.toggle("d-none", two);
  pe.step2.classList.toggle("d-none", !two);
  pe.back.classList.toggle("d-none", !two);
  pe.find.classList.toggle("d-none", two);
  pe.apply.classList.toggle("d-none", !two);
}

function pasteRowState(r) {
  if (r.status !== "found") return r.status;
  const input = els.body.querySelector(`.grade-input[data-index="${r.index}"]`);
  if (!input || input.readOnly) return "locked";
  if (r.parsed.state !== "valid") return "badgrade";
  return parseGrade(input.value).state === "valid" && !isDirty({ original: input.value }, gradeText(r.parsed.mark ? null : r.parsed.value, parsedRemarks(r.parsed))) ? "same" : "ok";
}

function drawPaste() {
  const states = pasteResults.map(pasteRowState);
  const n = (st) => states.filter((x) => x === st).length;
  pe.summary.innerHTML = `
    <span class="badge badge-pass">${n("ok")} grade${n("ok") === 1 ? "" : "s"} to fill</span>
    ${n("same") ? `<span class="badge badge-none">${n("same")} already the same</span>` : ""}
    ${n("badgrade") ? `<span class="badge badge-fail">${n("badgrade")} grade${n("badgrade") === 1 ? "" : "s"} to check</span>` : ""}
    ${n("locked") ? `<span class="badge text-bg-secondary">${n("locked")} locked (saved or closed)</span>` : ""}
    ${n("many") ? `<span class="badge text-bg-warning">${n("many")} with more than one match</span>` : ""}
    ${n("missing") ? `<span class="badge badge-fail">${n("missing")} not found</span>` : ""}`;
  const label = { ok: "", same: "already this grade", badgrade: `not a valid grade (use ${gradeRangeText()})`, locked: "locked: submitted grades change through Request change", missing: "not in this class" };
  pe.body.innerHTML = pasteResults.map((r, i) => {
    const st = states[i];
    const cls = st === "ok" ? "" : st === "same" ? "text-secondary" : st === "many" ? "table-warning" : "table-danger";
    const who = r.status === "found"
      ? `${escapeHtml(rows[r.index].studentName)}${current.combined ? ` <span class="small text-secondary">${escapeHtml(rows[r.index].asg.sectionName)}</span>` : ""}`
      : r.status === "many"
        ? `<select class="form-select form-select-sm d-inline-block w-auto" data-pchoose="${i}"><option value="">Choose…</option>${r.candidates.map((c) => `<option value="${c.id}">${escapeHtml(`${c.studentId} – ${c.studentName}`)}</option>`).join("")}</select>`
        : "";
    return `<tr class="${cls}">
      <td class="small text-secondary">${i + 1}</td>
      <td>${escapeHtml(r.line)}</td>
      <td>${who}${label[st] ? `<div class="small">${escapeHtml(st === "missing" && r.twice ? "listed twice: the first line is used" : label[st])}</div>` : ""}</td>
      <td class="fw-semibold">${escapeHtml(r.grade || "—")}${r.parsed.state === "valid" ? ` <span class="small fw-normal">${remarksBadge(r.parsed)}</span>` : ""}</td>
    </tr>`;
  }).join("");
  const ok = n("ok");
  pe.apply.textContent = `Fill ${ok} grade${ok === 1 ? "" : "s"}`;
  pe.apply.disabled = !ok;
}

function openPaste() {
  if (!rows.length) return;
  pasteResults = [];
  pasteStep(false);
  pasteModal.show();
}

function matchPaste() {
  const lines = pe.text.value.split(/\r?\n/).filter((l) => l.trim());
  const parts = lines.map(splitPasteLine).filter((x) => x.name && (/[A-Za-zÀ-ÿ]/.test(x.name) || /\d{4,}/.test(x.name)));
  if (!parts.length) { pe.text.focus(); return; }
  const people = rows.map((r, i) => ({ id: String(i), studentId: r.studentNumber, studentName: r.studentName }));
  const matched = matchNames(parts.map((x) => x.name), people);
  pasteResults = matched.map((m, i) => ({
    line: lines.length === parts.length ? lines[i].replace(/\t+/g, "  ").trim() : `${parts[i].name}  ${parts[i].grade}`,
    grade: parts[i].grade,
    parsed: parseGrade(parts[i].grade),
    status: m.status,
    index: m.status === "found" ? Number(m.student.id) : null,
    candidates: m.candidates,
    twice: !!m.note, // the same student on an earlier line
  }));
  pasteStep(true);
  drawPaste();
}

function applyPaste() {
  let filled = 0;
  pasteResults.forEach((r) => {
    if (pasteRowState(r) !== "ok") return;
    const input = els.body.querySelector(`.grade-input[data-index="${r.index}"]`);
    input.value = gradeText(r.parsed.mark ? null : r.parsed.value, parsedRemarks(r.parsed));
    onGradeInput(input);
    filled++;
  });
  pasteModal.hide();
  toast(`${filled} grade${filled === 1 ? "" : "s"} filled in. Check them, then click Save grades.`, "info");
}

// ==========================================================
// Grade change requests (teachers)
// Saved grades are locked for teachers. To change one, they send a
// request with a reason; approvers accept or decline it on the
// Notifications page.
// ==========================================================
let requestModal;
let requestingIndex = null;
let approversCache = null;

async function loadApprovers() {
  if (approversCache) return approversCache;
  const snap = await getDocs(query(collection(db, "users"), where("canApprove", "==", true)));
  approversCache = snap.docs
    .map((d) => ({ uid: d.id, ...d.data() }))
    .filter((u) => u.active !== false && u.uid !== me.uid);
  return approversCache;
}

function pendingCell(req) {
  return `<div class="request-chip mt-1" title="${escapeHtml(req.reason)}">
      <i class="bi bi-hourglass-split me-1"></i>Change to <strong>${formatGrade(req.newGrade, req.newRemarks)}</strong> waiting for approval
    </div>`;
}

async function openRequest(index) {
  requestingIndex = index;
  const r = rows[index];
  const a = r.asg;
  const ef = els.requestForm;
  clearErrors(ef);
  els.requestError.classList.add("d-none");
  els.requestGrade.value = "";
  els.requestReason.value = "";
  els.requestRemarks.innerHTML = "";
  els.requestFacts.innerHTML = [
    ["Student", `${r.studentName} (${r.studentNumber})`],
    ["Subject", `${a.subjectCode ? `${a.subjectCode} - ` : ""}${a.subjectName}`],
    ["Section", `${a.sectionName}, ${a.schoolYear}`],
    ["Current grade", `${formatGrade(r.gradeDoc.finalGrade, r.gradeDoc.remarks)} (${r.gradeDoc.remarks})`],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
  els.requestApprovers.textContent = "Checking who can approve…";
  els.btnSendRequest.disabled = true;
  requestModal.show();

  try {
    const approvers = await loadApprovers();
    if (!approvers.length) {
      els.requestApprovers.innerHTML = `<span style="color:var(--maroon)">No one is set up to approve grade changes yet. Ask an administrator to tag an approver on the Users and roles page.</span>`;
      return;
    }
    els.requestApprovers.innerHTML = `<i class="bi bi-bell me-1"></i>Will notify: ${approvers.map((a) => escapeHtml(a.displayName || a.username)).join(", ")}`;
    els.btnSendRequest.disabled = false;
  } catch (err) {
    els.requestApprovers.innerHTML = `<span style="color:var(--maroon)">${escapeHtml(errorMessage(err))}</span>`;
  }
}

function onRequestGradeInput() {
  const p = parseGrade(els.requestGrade.value);
  els.requestGrade.classList.toggle("is-invalid", p.state === "invalid");
  els.requestRemarks.innerHTML = p.state === "empty" ? "" : `New remarks: ${remarksBadge(p)}`;
}

async function submitRequest(e) {
  e.preventDefault();
  const r = rows[requestingIndex];
  const a = r.asg;
  clearErrors(els.requestForm);
  els.requestError.classList.add("d-none");
  const p = parseGrade(els.requestGrade.value);
  const reason = els.requestReason.value.trim().replace(/\s+\n/g, "\n");
  let ok = true;
  if (p.state !== "valid") { fieldError(els.requestGrade, `Enter ${gradeRangeText()}.`); ok = false; }
  else if (parsedRemarks(p) === r.gradeDoc.remarks && (p.mark ? true : p.value === Number(r.gradeDoc.finalGrade))) { fieldError(els.requestGrade, "That's the same as the current grade."); ok = false; }
  if (reason.length < 10) { fieldError(els.requestReason, "Explain the reason in at least 10 characters."); ok = false; }
  if (!ok) return;
  if (await checkClosed()) { requestModal.hide(); return; }

  setBusy(els.btnSendRequest, true, "Sending…");
  try {
    const approvers = await loadApprovers();
    if (!approvers.length) throw new Error("No one is set up to approve grade changes yet.");

    // Don't stack requests for the same grade
    const existing = await getDocs(query(
      collection(db, "gradeChangeRequests"),
      where("gradeId", "==", r.gradeDoc.id),
      where("teacherDocId", "==", a.teacherDocId),
      where("status", "==", "pending")
    ));
    if (!existing.empty) {
      els.requestError.textContent = "There's already a pending request for this grade. Wait for a decision, or cancel it on the Notifications page.";
      els.requestError.classList.remove("d-none");
      return;
    }

    const requestRef = doc(collection(db, "gradeChangeRequests"));
    const g0 = r.gradeDoc.finalGrade;
    const oldGrade = g0 === null || g0 === undefined ? null : Number(g0);
    const request = {
      gradeId: r.gradeDoc.id,
      assignmentId: a.id,
      studentId: r.studentDocId,
      studentNumber: r.studentNumber,
      studentName: r.studentName,
      subjectId: a.subjectId,
      subjectCode: a.subjectCode,
      subjectName: a.subjectName,
      units: Number(a.units),
      schoolYear: a.schoolYear,
      yearLevel: a.yearLevel,
      sectionName: a.sectionName,
      teacherDocId: a.teacherDocId,
      teacherName: a.teacherName,
      oldGrade,
      oldRemarks: oldGrade === null ? r.gradeDoc.remarks : remarksFor(oldGrade),
      newGrade: p.mark ? null : p.value,
      newRemarks: parsedRemarks(p),
      reason,
      status: "pending",
      requestedBy: me.uid,
      requestedByName: me.displayName || me.username,
      requestedAt: serverTimestamp(),
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      decisionNote: "",
    };
    const who = me.displayName || me.username;
    const ops = [{ type: "set", ref: requestRef, data: request }];
    approvers.forEach((a) =>
      ops.push({
        type: "set",
        ref: doc(collection(db, "notifications")),
        data: {
          toUid: a.uid,
          fromUid: me.uid,
          fromName: who,
          type: "grade_change_request",
          title: "Grade change needs your approval",
          message: `${who} asks to change ${r.studentName}'s ${a.subjectCode} grade from ${formatGrade(oldGrade, r.gradeDoc.remarks)} to ${formatGrade(p.mark ? null : p.value, parsedRemarks(p))}.`,
          requestId: requestRef.id,
          read: false,
          createdAt: serverTimestamp(),
        },
      })
    );
    await commitOperations(ops);
    requestModal.hide();
    toast(`Request sent to ${approvers.length} approver${approvers.length === 1 ? "" : "s"}. You'll be notified of the decision.`);
    await reloadKeepingTyped(new Map()); // grades typed (not saved) in other rows stay
  } catch (err) {
    els.requestError.textContent = errorMessage(err);
    els.requestError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSendRequest, false);
  }
}

// ---------- Wire up ----------
async function init(profile) {
  me = profile;
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) document.getElementById("keyHint").textContent = "Keys: Enter or ↓ next student · Shift+Enter or ↑ previous · ⌘S save";
  els.dirtyNote.textContent = "No unsaved changes";
  document.getElementById("scaleHint").textContent = scaleHint();
  if (me.role === "teacher") {
    closed = downtimeActive(await getDowntime());
    applyClosed();
  }
  // Class list change requests (teachers): add, remove or move students, approved by the registrar
  initRosterPanel(me, () => (current ? { parts: partsOf(current), rows, locked: closed } : null));
  if (me.role === "teacher") {
    const help = els.select.parentElement.querySelector(".form-text");
    if (help) help.textContent = "These are the classes assigned to you.";
  }
  els.select.addEventListener("change", async () => {
    if (saving) {
      els.select.value = current ? current.id : "";
      toast("Wait until the grades are saved, then open another class.", "info");
      return;
    }
    if (rows.length && hasUnsavedChanges()) {
      const ok = await confirmDialog({
        title: "Discard unsaved grades?",
        message: "You have grades that haven't been saved. Switching assignments will discard them.",
        confirmText: "Discard changes",
        variant: "warning",
      });
      if (!ok) {
        els.select.value = current ? current.id : "";
        return;
      }
    }
    clearNotice();
    openAssignment(els.select.value, { focus: true });
  });
  // A class card opens its class the same way (asks first about unsaved grades)
  els.cards.addEventListener("click", (e) => {
    const card = e.target.closest("[data-open-class]");
    if (!card) return;
    if (current && current.id === card.dataset.openClass) { focusFirstEmpty(); return; }
    els.select.value = card.dataset.openClass;
    els.select.dispatchEvent(new Event("change"));
  });

  els.body.addEventListener("input", (e) => {
    if (e.target.classList.contains("grade-input")) onGradeInput(e.target);
  });
  // Leaving a box (Tab, Enter, a click elsewhere) says what's wrong with its grade
  els.body.addEventListener("focusout", (e) => {
    if (e.target.classList.contains("grade-input") && !e.target.readOnly) showProblem(e.target, true);
  });
  // The small "…" menu: INC / DRP without typing letters (phones show a number keypad)
  els.body.addEventListener("change", (e) => {
    const pick = e.target.closest("[data-mark]");
    if (!pick) return;
    const input = els.body.querySelector(`.grade-input[data-index="${pick.dataset.mark}"]`);
    if (input && pick.value) {
      input.value = pick.value === "clear" ? "" : pick.value;
      onGradeInput(input);
    }
    pick.value = "";
    // Back to the grade box: arrow keys on a focused menu would change its value
    if (input) input.focus({ preventScroll: true });
  });
  // Keys in a grade box: Enter / Down = next student, Shift+Enter / Up = previous.
  // They only move the cursor (locked grades are skipped); none of them changes a grade.
  els.body.addEventListener("keydown", (e) => {
    if (!e.target.classList.contains("grade-input") || e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const back = (e.key === "Enter" && e.shiftKey) || e.key === "ArrowUp";
    const fwd = (e.key === "Enter" && !e.shiftKey) || e.key === "ArrowDown";
    if (!back && !fwd) return;
    e.preventDefault();
    // Next / previous editable box from here (this box may be a locked one that was clicked)
    const all = [...els.body.querySelectorAll(".grade-input")].filter(isShown);
    const at = all.indexOf(e.target);
    const to = (fwd ? all.slice(at + 1) : all.slice(0, at).reverse()).find((i) => !i.readOnly);
    if (to) moveTo(to);
    else if (fwd && e.key === "Enter") els.btnSave.focus(); // after the last student: Save
  });
  // Ctrl+S / Cmd+S saves (instead of the browser's "Save page"), not while a dialog is open
  document.addEventListener("keydown", (e) => {
    // e.code: the S key on any keyboard layout
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.code !== "KeyS" && String(e.key).toLowerCase() !== "s")) return;
    e.preventDefault();
    if (current && !document.querySelector(".modal.show")) saveGrades();
  });
  els.btnSave.addEventListener("click", saveGrades);
  if (me.role === "teacher") els.btnSubmit.classList.remove("d-none");
  els.btnSubmit.addEventListener("click", submitGrades);
  els.rowSearch.addEventListener("input", () => { view.q = els.rowSearch.value; applyView(); });
  els.rowFilter.addEventListener("change", () => { view.filter = els.rowFilter.value; applyView(); });
  els.rowSort.addEventListener("change", () => { view.sort = els.rowSort.value; applyView(); });
  document.getElementById("rowShowAll").addEventListener("click", () => { resetView(); applyView(); els.rowSearch.focus(); });
  if (pe.el) {
    pasteModal = new bootstrap.Modal(pe.el);
    pe.el.addEventListener("shown.bs.modal", () => { if (!pasteResults.length) pe.text.focus(); });
    document.getElementById("btnPasteGrades")?.addEventListener("click", openPaste);
    pe.find.addEventListener("click", matchPaste);
    pe.back.addEventListener("click", () => pasteStep(false));
    pe.apply.addEventListener("click", applyPaste);
    pe.body.addEventListener("change", (e) => {
      const sel = e.target.closest("[data-pchoose]");
      if (!sel || sel.value === "") return;
      Object.assign(pasteResults[Number(sel.dataset.pchoose)], { status: "found", index: Number(sel.value) });
      drawPaste();
    });
  }
  requestModal = new bootstrap.Modal(els.requestModalEl);
  els.requestModalEl.addEventListener("shown.bs.modal", () => els.requestGrade.focus());
  els.requestGrade.addEventListener("input", onRequestGradeInput);
  els.requestForm.addEventListener("submit", submitRequest);
  els.body.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-request]");
    if (btn) openRequest(Number(btn.dataset.request));
  });

  window.addEventListener("beforeunload", (e) => {
    if (rows.length && hasUnsavedChanges()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  loadAssignments();
}

initLayout("grading").then((user) => {
  if (user) init(user);
  else els.select.innerHTML = `<option value="">Connect Firebase and sign in to load assignments</option>`;
});
