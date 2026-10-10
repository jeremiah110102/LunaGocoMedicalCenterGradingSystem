// ==========================================================
// dashboard.js — Firestore counts + setup progress
// ==========================================================

import { db, collection, doc, getDocs, query, where, orderBy, limit, getCountFromServer, setDoc, serverTimestamp } from "./firebase-config.js";
import { initLayout, escapeHtml, errorMessage, tableMessage, tableLoading, compareText, toast, getSchool, getOptions, YEAR_LEVELS } from "./app.js";
import { summarizeSubmissions, reminderText } from "./tracker.js";
import { hasLeft } from "./student-status.js";
import { TERMS, termOf, yearTermText, termDeadline } from "./terms.js";
import { maybeAutoSync } from "./sheets-sync.js";

const STATS = [
  { key: "subjects", label: "Subjects", icon: "bi-journal-bookmark", href: "subjects.html" },
  { key: "teachers", label: "Teachers", icon: "bi-person-badge", href: "teachers.html" },
  { key: "sections", label: "Sections", icon: "bi-collection", href: "sections.html" },
  { key: "students", label: "Students", icon: "bi-people", href: "students.html" },
  { key: "gradingAssignments", label: "Grading Assignments", icon: "bi-diagram-3", href: "assignments.html" },
];

const STEPS = [
  { label: "Create subjects", hint: "Subject code, name and units", key: "subjects", href: "subjects.html" },
  { label: "Create teachers", hint: "Teacher ID and name", key: "teachers", href: "teachers.html" },
  { label: "Create sections", hint: "School year, year level and section", key: "sections", href: "sections.html" },
  { label: "Create students", hint: "Enroll each student in a section", key: "students", href: "students.html" },
  { label: "Create grading assignments", hint: "Teacher + subject + section + students", key: "gradingAssignments", href: "assignments.html" },
  { label: "Enter and save grades", hint: "Final grade per student, remarks are automatic", key: "grades", href: "grading.html" },
];

const statsEl = document.getElementById("stats");
const checklistEl = document.getElementById("checklist");
const recentEl = document.getElementById("recent");

function renderStats(counts) {
  statsEl.innerHTML = STATS.map(
    (s) => `
    <div class="col-6 col-md-4 col-xl">
      <a class="card stat-card" href="${s.href}">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <span class="stat-label">${s.label}</span>
            <i class="bi ${s.icon} stat-icon" aria-hidden="true"></i>
          </div>
          <div class="stat-value">${counts ? counts[s.key] : '<span class="placeholder col-4 rounded"></span>'}</div>
        </div>
      </a>
    </div>`
  ).join("");
}

function renderChecklist(counts) {
  checklistEl.innerHTML = STEPS.map((step, i) => {
    const done = counts && counts[step.key] > 0;
    return `
      <li class="${done ? "done" : ""}">
        <span class="step-dot" aria-hidden="true">${done ? '<i class="bi bi-check-lg"></i>' : i + 1}</span>
        <div class="flex-grow-1">
          <a href="${step.href}" class="fw-semibold text-decoration-none">${step.label}</a>
          <div class="small text-secondary">${step.hint}</div>
        </div>
        <span class="small ${done ? "text-success" : "text-secondary"}">${counts ? (done ? `${counts[step.key]} saved` : "Not started") : ""}</span>
      </li>`;
  }).join("");
}

async function loadCounts() {
  renderStats(null);
  renderChecklist(null);
  const keys = [...STATS.map((s) => s.key), "grades"];
  const results = await Promise.all(keys.map((k) => getCountFromServer(collection(db, k))));
  const counts = {};
  keys.forEach((k, i) => (counts[k] = results[i].data().count));
  renderStats(counts);
  renderChecklist(counts);
}

async function loadRecent() {
  tableLoading(recentEl, 5);
  const snap = await getDocs(query(collection(db, "gradingAssignments"), orderBy("createdAt", "desc"), limit(5)));
  if (snap.empty) {
    tableMessage(recentEl, 5, `No grading assignments yet. <a href="assignments.html">Create one</a> once subjects, teachers, sections and students are in place.`);
    return;
  }
  recentEl.removeAttribute("aria-busy");
  recentEl.innerHTML = snap.docs
    .map((d) => {
      const a = d.data();
      return `
      <tr>
        <td><span class="code-cell">${escapeHtml(a.subjectCode)}</span><div class="small text-secondary">${escapeHtml(a.subjectName)}</div></td>
        <td>${escapeHtml(a.teacherName)}</td>
        <td><span class="badge badge-count">${escapeHtml(a.sectionName)}</span><div class="small text-secondary">${escapeHtml(a.schoolYear)}</div></td>
        <td class="num">${(a.studentIds || []).length}</td>
        <td class="text-end"><a class="btn btn-sm btn-success" href="grading.html?assignment=${d.id}">Grade</a></td>
      </tr>`;
    })
    .join("");
}

// ---------- Teacher view: only their own classes ----------
async function loadTeacherView(me) {
  document.getElementById("checklistCol").classList.add("d-none");
  const recentCol = document.getElementById("recentCol");
  recentCol.classList.remove("col-lg-7");
  recentCol.classList.add("col-12");
  document.getElementById("recentTitle").textContent = "My classes";
  const manage = document.getElementById("recentManage");
  manage.textContent = "Enter grades";
  manage.href = "grading.html";
  document.querySelector(".page-lede").textContent = "Your grading assignments and how many grades you've saved.";

  if (!me.teacherDocId) {
    statsEl.innerHTML = `<div class="col-12"><div class="alert alert-info mb-0">Your account isn't linked to a teacher record yet. Ask an administrator to link it on the Users and roles page.</div></div>`;
    tableMessage(recentEl, 5, "No classes to show.");
    return;
  }

  tableLoading(recentEl, 5, 3);
  const [aSnap, gSnap] = await Promise.all([
    getDocs(query(collection(db, "gradingAssignments"), where("teacherDocId", "==", me.teacherDocId))),
    getDocs(query(collection(db, "grades"), where("teacherDocId", "==", me.teacherDocId))),
  ]);
  const mine = aSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const grades = gSnap.docs.map((d) => d.data());
  const totalStudents = mine.reduce((n, a) => n + (a.studentIds || []).length, 0);
  const passed = grades.filter((g) => g.remarks === "Passed").length;
  const gradedBy = {};
  grades.forEach((g) => (gradedBy[g.assignmentId] = (gradedBy[g.assignmentId] || 0) + 1));

  const cards = [
    { label: "My classes", value: mine.length, icon: "bi-diagram-3" },
    { label: "Students", value: totalStudents, icon: "bi-people" },
    { label: "Grades saved", value: grades.length, icon: "bi-check2-square" },
    { label: "Still to grade", value: Math.max(totalStudents - grades.length, 0), icon: "bi-hourglass-split" },
    { label: "Passed", value: passed, icon: "bi-award" },
  ];
  statsEl.innerHTML = cards.map((c) => `
    <div class="col-6 col-md-4 col-xl">
      <a class="card stat-card" href="grading.html">
        <div class="card-body">
          <div class="d-flex justify-content-between align-items-start mb-2">
            <span class="stat-label">${c.label}</span>
            <i class="bi ${c.icon} stat-icon" aria-hidden="true"></i>
          </div>
          <div class="stat-value">${c.value}</div>
        </div>
      </a>
    </div>`).join("");

  if (!mine.length) {
    tableMessage(recentEl, 5, "No classes are assigned to you yet. The registrar creates grading assignments; they'll appear here.");
    return;
  }
  mine.sort((a, b) => compareText(b.schoolYear, a.schoolYear) || compareText(a.subjectCode, b.subjectCode));
  recentEl.removeAttribute("aria-busy");
  recentEl.innerHTML = mine.map((a) => {
    const total = (a.studentIds || []).length;
    const done = gradedBy[a.id] || 0;
    return `
      <tr>
        <td><span class="code-cell">${escapeHtml(a.subjectCode)}</span><div class="small text-secondary">${escapeHtml(a.subjectName)}</div></td>
        <td>${done} of ${total} graded</td>
        <td><span class="badge badge-count">${escapeHtml(a.sectionName)}</span><div class="small text-secondary">${escapeHtml(a.schoolYear)}</div></td>
        <td class="num">${total}</td>
        <td class="text-end"><a class="btn btn-sm btn-success" href="grading.html?assignment=${a.id}">Grade</a></td>
      </tr>`;
  }).join("");
  // Column header reads "Teacher" for staff; for a teacher it shows progress
  const th = recentEl.closest("table").querySelector("thead th:nth-child(2)");
  if (th) th.textContent = "Progress";
}

// ---------- Grade submission tracker (admin + registrar) ----------
const tr = {
  panel: document.getElementById("trackPanel"), year: document.getElementById("trackYear"), term: document.getElementById("trackTerm"),
  level: document.getElementById("trackLevel"), section: document.getElementById("trackSection"),
  show: document.getElementById("trackShow"), body: document.getElementById("trackBody"), tally: document.getElementById("trackTally"),
  note: document.getElementById("trackNote"),
};
let trackData = { assignments: [], grades: [], teachers: new Map(), options: {}, left: new Set() };
const reminded = new Set(); // assignment ids reminded during this visit
let trackSections = []; // every section: the school years and their year levels

/** Year Level list for the chosen school year (one level loads at a time: a whole school is too much for one request). */
function fillTrackLevels() {
  const sy = tr.year.value;
  const keep = tr.level.value;
  const levels = YEAR_LEVELS.filter((l) => trackSections.some((s) => s.schoolYear === sy && s.yearLevel === l));
  tr.level.innerHTML = levels.length ? levels.map((l) => `<option value="${l}">${l}</option>`).join("") : `<option value="">No year levels</option>`;
  tr.level.value = levels.includes(keep) ? keep : levels[0] || "";
  tr.level.disabled = !levels.length;
}

/** Section list for the loaded year level. */
function fillTrackSections() {
  const keep = tr.section.value;
  const list = [...new Map(trackData.assignments.map((a) => [a.sectionId, a.sectionName])).entries()]
    .filter(([id]) => id)
    .sort((a, b) => compareText(a[1], b[1]));
  tr.section.innerHTML = `<option value="">All sections</option>` + list.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("");
  tr.section.value = list.some(([id]) => id === keep) ? keep : "";
}

async function loadTracker(me) {
  if (!tr.panel) return;
  tr.panel.classList.remove("d-none");
  const secSnap = await getDocs(collection(db, "sections"));
  trackSections = secSnap.docs.map((d) => d.data());
  const years = [...new Set(trackSections.map((s) => s.schoolYear))].sort((a, b) => compareText(b, a));
  if (!years.length) { tr.panel.classList.add("d-none"); return; }
  tr.year.innerHTML = years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
  tr.year.value = years[0];
  fillTrackLevels();
  tr.year.addEventListener("change", () => { fillTrackLevels(); loadTrackYear(); });
  tr.level.addEventListener("change", () => { tr.section.value = ""; loadTrackYear(); });
  tr.section.addEventListener("change", renderTracker);
  tr.term.addEventListener("change", renderTracker);
  tr.show.addEventListener("change", renderTracker);
  tr.body.addEventListener("click", (e) => {
    const b = e.target.closest("[data-remind]");
    if (b) remind(me, b.dataset.remind, b);
  });
  await loadTrackYear();
}

async function loadTrackYear() {
  const sy = tr.year.value;
  const level = tr.level.value;
  trackData = { assignments: [], grades: [], teachers: new Map(), options: {}, left: new Set() };
  fillTrackSections();
  if (!level) { tableMessage(tr.body, 6, `No sections for ${escapeHtml(sy)} yet.`); tr.tally.innerHTML = ""; return; }
  tableLoading(tr.body, 6, 4);
  try {
    const [aSnap, gSnap, tSnap, options, sSnap] = await Promise.all([
      getDocs(query(collection(db, "gradingAssignments"), where("schoolYear", "==", sy), where("yearLevel", "==", level))),
      getDocs(query(collection(db, "grades"), where("schoolYear", "==", sy), where("yearLevel", "==", level))),
      getDocs(collection(db, "teachers")),
      getOptions().catch(() => ({})),
      getDocs(query(collection(db, "students"), where("schoolYear", "==", sy))),
    ]);
    // The year or level was changed while this one was loading: that one wins
    if (tr.year.value !== sy || tr.level.value !== level) return;
    trackData = {
      assignments: aSnap.docs.map((d) => ({ id: d.id, ...d.data() })),
      grades: gSnap.docs.map((d) => d.data()),
      teachers: new Map(tSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])),
      options,
      // Dropped / transferred out: no grade can be entered for them, so they aren't "missing"
      left: new Set(sSnap.docs.filter((d) => hasLeft(d.data())).map((d) => d.id)),
    };
    const present = new Set(trackData.assignments.map(termOf));
    const keep = tr.term.value;
    tr.term.innerHTML = `<option value="all">All terms</option>` + [...TERMS, ""].filter((t) => present.has(t))
      .map((t) => `<option value="${escapeHtml(t)}">${t ? escapeHtml(t) : "No term"}</option>`).join("");
    tr.term.value = [...tr.term.options].some((o) => o.value === keep) ? keep : "all";
    fillTrackSections();
    renderTracker();
  } catch (err) {
    tableMessage(tr.body, 6, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

function renderTracker() {
  const t = tr.term.value;
  const sec = tr.section.value;
  const list = trackData.assignments.filter((a) => (t === "all" || termOf(a) === t) && (!sec || a.sectionId === sec));
  const rows = summarizeSubmissions(list, trackData.grades, trackData.left);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const entered = rows.reduce((n, r) => n + r.entered, 0);
  const behind = rows.filter((r) => r.missing > 0);
  tr.tally.innerHTML = `
    <span>Classes <strong>${rows.length}</strong></span>
    <span class="text-success">Complete <strong>${rows.length - behind.length}</strong></span>
    <span style="color:var(--maroon)">With missing grades <strong>${behind.length}</strong></span>
    <span>Grades entered <strong>${entered} of ${total}</strong></span>
    <span>INC <strong>${rows.reduce((n, r) => n + r.inc, 0)}</strong></span>`;
  const shown = tr.show.value === "all" ? rows : behind;
  if (!rows.length) { tableMessage(tr.body, 6, `No grading assignments for ${escapeHtml(yearTermText(tr.year.value, t === "all" ? "" : t))}.`); return; }
  if (!shown.length) { tableMessage(tr.body, 6, `<i class="bi bi-check2-circle text-success me-1"></i>Every class has all its grades.`); return; }
  tr.body.removeAttribute("aria-busy");
  tr.body.innerHTML = shown.map((r) => {
    const a = r.asg;
    const teacher = trackData.teachers.get(a.teacherDocId);
    const linked = !!(teacher && teacher.userUid);
    const action = r.missing === 0
      ? `<span class="badge badge-pass">Complete</span>`
      : reminded.has(a.id)
        ? `<button class="btn btn-sm btn-outline-secondary" disabled><i class="bi bi-check2 me-1"></i>Sent</button>`
        : `<span class="d-inline-block" tabindex="0" ${linked ? "" : 'title="No account linked: an administrator links one on Users and roles"'}><button class="btn btn-sm btn-outline-primary" data-remind="${escapeHtml(a.id)}" ${linked ? "" : 'disabled style="pointer-events:none"'}><i class="bi bi-bell me-1"></i>Remind</button></span>`;
    return `<tr>
      <td>${escapeHtml(a.teacherName)}</td>
      <td><span class="code-cell">${escapeHtml(a.subjectCode)}</span> <span class="badge badge-count">${escapeHtml(a.sectionName)}</span>${termOf(a) ? `<div class="small text-secondary">${escapeHtml(termOf(a))}</div>` : ""}</td>
      <td class="num">${r.entered} of ${r.total}</td>
      <td class="num ${r.missing ? "fw-semibold" : "text-secondary"}" ${r.missing ? 'style="color:var(--maroon)"' : ""}>${r.missing}</td>
      <td class="num">${r.inc || "—"}</td>
      <td class="text-end text-nowrap">${action}</td>
    </tr>`;
  }).join("");
}

async function remind(me, assignmentId, btn) {
  const row = summarizeSubmissions(trackData.assignments.filter((a) => a.id === assignmentId), trackData.grades, trackData.left)[0];
  if (!row) return;
  const teacher = trackData.teachers.get(row.asg.teacherDocId);
  if (!teacher?.userUid) return;
  btn.disabled = true;
  try {
    await setDoc(doc(collection(db, "notifications")), {
      toUid: teacher.userUid,
      fromUid: me.uid,
      fromName: me.displayName || me.username,
      type: "grade_reminder",
      title: "Grades still missing",
      message: reminderText(row.asg, row.missing, termDeadline(trackData.options, termOf(row.asg))),
      read: false,
      createdAt: serverTimestamp(),
    });
    reminded.add(assignmentId);
    toast(`Reminder sent to ${row.asg.teacherName}.`);
    renderTracker();
  } catch (err) {
    btn.disabled = false;
    toast(errorMessage(err), "danger");
  }
}

async function init(me) {
  try {
    if (me.role === "teacher") await loadTeacherView(me);
    else await Promise.all([loadCounts(), loadRecent(), loadTracker(me)]);
  } catch (err) {
    statsEl.innerHTML = `<div class="col-12"><div class="alert alert-danger mb-0">${escapeHtml(errorMessage(err))}</div></div>`;
    tableMessage(recentEl, 5, "Couldn't load assignments.");
  }
}

initLayout("dashboard").then((user) => {
  if (user) {
    init(user);
    // Daily Google Sheets copy (administrators, when switched on in School settings)
    getSchool().then((school) => maybeAutoSync({
      me: user,
      school,
      onDone: (err, r) => err
        ? toast(`The daily Google Sheets copy didn't work: ${err.message}`, "warning")
        : toast(`Daily copy to Google Sheets done (${r.total} records).`, "info"),
    }));
  }
  else {
    renderStats({ subjects: 0, teachers: 0, sections: 0, students: 0, gradingAssignments: 0 });
    renderChecklist(null);
    tableMessage(recentEl, 5, "Connect Firebase and sign in to load assignments.");
  }
});
