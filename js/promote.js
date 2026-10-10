// ==========================================================
// promote.js — Promote to next school year (Sections page)
//
// Moves each section's students to a section of the next school year and
// the next year level (BSC 1A 2026-2027 → BSC 2A 2027-2028), creating the
// sections that don't exist yet. The highest year level can be marked
// Graduated instead. Dropped, transferred out and graduated students stay.
// Last school year's grading assignments and grades are not touched.
// ==========================================================

import { db, collection, doc, getDocs, query, where, serverTimestamp } from "./firebase-config.js";
import { toast, confirmDialog, escapeHtml, setBusy, compareText, errorMessage, commitOperations, YEAR_LEVELS, isValidSchoolYear, clearErrors, fieldError } from "./app.js";
import { statusOf } from "./student-status.js";
import { moveInAssignments } from "./section-move.js";

/** "2026-2027" → "2027-2028" */
export function nextSchoolYear(sy) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(sy || "").trim());
  return m ? `${Number(m[1]) + 1}-${Number(m[2]) + 1}` : "";
}

/** "BSC 1A" (1st Year) → "BSC 2A": the year number in the name goes up by one. */
export function nextSectionName(name, levelIndex) {
  const from = String(levelIndex + 1);
  const to = String(levelIndex + 2);
  const re = new RegExp(`(^|\\D)${from}(?=\\D|$)`);
  return re.test(name) ? String(name).replace(re, `$1${to}`) : String(name);
}

const $ = (id) => document.getElementById(id);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function setupPromote({ getSections, getStudentCount = () => 1, onDone }) {
  const els = {
    btn: $("btnPromote"), modalEl: $("promoteModal"), form: $("promoteForm"), from: $("promoteFrom"), to: $("promoteTo"),
    body: $("promoteBody"), error: $("promoteError"), summary: $("promoteSummary"), run: $("btnRunPromote"),
  };
  if (!els.btn || !els.modalEl) return;
  const modal = new bootstrap.Modal(els.modalEl);
  let rows = []; // { section, level, students: [...], movable: [...] }
  let yearStudents = [];

  const levelIdx = (l) => YEAR_LEVELS.indexOf(l);
  const toYear = () => els.to.value.trim();

  async function open() {
    const years = [...new Set(getSections().map((s) => s.schoolYear))].sort((a, b) => compareText(b, a));
    if (!years.length) { toast("Create sections first.", "warning"); return; }
    els.from.innerHTML = years.map((y) => `<option value="${escapeHtml(y)}">${escapeHtml(y)}</option>`).join("");
    // Start from the latest school year that has students (a new, empty year is usually the target)
    const withStudents = years.find((y) => getSections().some((s) => s.schoolYear === y && getStudentCount(s.id) > 0));
    els.from.value = withStudents || years[0];
    els.to.value = nextSchoolYear(els.from.value);
    modal.show();
    await loadYear();
  }

  async function loadYear() {
    clearErrors(els.form);
    els.error.classList.add("d-none");
    els.body.innerHTML = `<tr><td colspan="3" class="empty-state"><span class="spinner-border spinner-border-sm me-2"></span>Loading students…</td></tr>`;
    const from = els.from.value;
    try {
      const snap = await getDocs(query(collection(db, "students"), where("schoolYear", "==", from)));
      yearStudents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (err) {
      els.body.innerHTML = `<tr><td colspan="3" class="text-danger">${escapeHtml(errorMessage(err))}</td></tr>`;
      return;
    }
    const sections = getSections()
      .filter((s) => s.schoolYear === from)
      .sort((a, b) => levelIdx(a.yearLevel) - levelIdx(b.yearLevel) || compareText(a.sectionName, b.sectionName));
    const topLevel = Math.max(-1, ...sections.map((s) => levelIdx(s.yearLevel)));
    rows = sections.map((section) => {
      const students = yearStudents.filter((st) => st.sectionId === section.id);
      // Dropped, transferred out and graduated students stay where they are
      const movable = students.filter((st) => !["dropped", "transferred", "graduated"].includes(statusOf(st)));
      const li = levelIdx(section.yearLevel);
      return { section, li, students, movable, graduateByDefault: li >= 3 && li === topLevel };
    });
    draw();
  }

  /** The choices for one row: an existing section of the next year/level, a new one, graduate or skip. */
  function choices(row) {
    const to = toYear();
    const nextLevel = YEAR_LEVELS[row.li + 1];
    const list = [];
    let def = "skip";
    if (nextLevel) {
      const suggested = nextSectionName(row.section.sectionName, row.li);
      const existing = getSections()
        .filter((s) => s.schoolYear === to && s.yearLevel === nextLevel)
        .sort((a, b) => compareText(a.sectionName, b.sectionName));
      const same = existing.find((s) => s.sectionName.toLowerCase() === suggested.toLowerCase());
      existing.forEach((s) => list.push([s.id, `${s.sectionName} (${nextLevel}, ${to})`]));
      if (!same) list.push([`new:${suggested}`, `Create ${suggested} (${nextLevel}, ${to})`]);
      def = same ? same.id : `new:${suggested}`;
    }
    list.push(["graduate", "Mark as Graduated (they stay in this section)"]);
    list.push(["skip", "Don't move them"]);
    if (row.graduateByDefault || !nextLevel) def = "graduate";
    return { list, def };
  }

  function draw() {
    if (!rows.length) {
      els.body.innerHTML = `<tr><td colspan="3" class="empty-state">No sections in ${escapeHtml(els.from.value)}.</td></tr>`;
      summarize();
      return;
    }
    els.body.innerHTML = rows.map((row, i) => {
      const { list, def } = choices(row);
      const stay = row.students.length - row.movable.length;
      return `<tr>
        <td><span class="fw-semibold">${escapeHtml(row.section.sectionName)}</span> <span class="text-secondary small">${escapeHtml(row.section.yearLevel)}</span></td>
        <td class="num">${row.movable.length}${stay ? `<div class="small text-secondary">${stay} stay (dropped, transferred or graduated)</div>` : ""}</td>
        <td><select class="form-select form-select-sm" data-row="${i}" aria-label="Move ${escapeHtml(row.section.sectionName)} to">
          ${list.map(([v, t]) => `<option value="${escapeHtml(v)}"${v === def ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}
        </select></td>
      </tr>`;
    }).join("");
    summarize();
  }

  /** What will happen, from the current choices. */
  function plan() {
    const out = { moves: [], graduate: [], create: new Map(), toExisting: 0 };
    els.body.querySelectorAll("[data-row]").forEach((sel) => {
      const row = rows[Number(sel.dataset.row)];
      const v = sel.value;
      if (!row.movable.length || v === "skip") return;
      if (v === "graduate") { out.graduate.push(...row.movable); return; }
      let target;
      if (v.startsWith("new:")) {
        const name = v.slice(4);
        const level = YEAR_LEVELS[row.li + 1];
        const key = `${name.toLowerCase()}|${level}`;
        if (!out.create.has(key)) out.create.set(key, { ref: doc(collection(db, "sections")), sectionName: name, yearLevel: level });
        const c = out.create.get(key);
        target = { id: c.ref.id, sectionName: c.sectionName, yearLevel: c.yearLevel, schoolYear: toYear() };
      } else {
        target = getSections().find((s) => s.id === v);
        out.toExisting++;
      }
      if (target) row.movable.forEach((st) => out.moves.push({ student: st, to: target }));
    });
    return out;
  }

  function summarize() {
    const p = plan();
    els.summary.textContent = p.moves.length || p.graduate.length
      ? `${plural(p.moves.length, "student")} to promote` + (p.graduate.length ? `, ${p.graduate.length} graduating` : "") +
        (p.create.size ? `, ${plural(p.create.size, "new section")}` : "")
      : "Nothing to do with these choices.";
    els.run.disabled = !(p.moves.length || p.graduate.length);
  }

  async function run(e) {
    e.preventDefault();
    clearErrors(els.form);
    els.error.classList.add("d-none");
    const from = els.from.value;
    const to = toYear();
    if (!isValidSchoolYear(to)) { fieldError(els.to, "Use consecutive years, for example 2027-2028."); return; }
    if (to === from) { fieldError(els.to, "Choose a different school year."); return; }
    const p = plan();
    if (!p.moves.length && !p.graduate.length) return;
    modal.hide();
    const ok = await confirmDialog({
      title: `Promote to ${to}?`,
      message:
        (p.moves.length ? `• ${plural(p.moves.length, "student")} move to their ${to} sections\n` : "") +
        (p.create.size ? `• ${plural(p.create.size, "section")} will be created: ${[...p.create.values()].map((c) => c.sectionName).join(", ")}\n` : "") +
        (p.graduate.length ? `• ${plural(p.graduate.length, "student")} will be marked Graduated\n` : "") +
        `\n${from}'s grading assignments and grades are kept as that year's record.`,
      confirmText: "Promote",
      variant: "primary",
    });
    if (!ok) { modal.show(); return; }
    setBusy(els.run, true, "Promoting…");
    try {
      const ops = [];
      p.create.forEach((c) => ops.push({
        type: "set", ref: c.ref,
        data: { schoolYear: to, yearLevel: c.yearLevel, sectionName: c.sectionName, createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
      }));
      p.moves.forEach(({ student, to: t }) => ops.push({
        type: "update", ref: doc(db, "students", student.id),
        data: { schoolYear: t.schoolYear, yearLevel: t.yearLevel, sectionId: t.id, sectionName: t.sectionName, updatedAt: serverTimestamp() },
      }));
      p.graduate.forEach((st) => ops.push({
        type: "update", ref: doc(db, "students", st.id),
        data: { status: "graduated", statusNote: `Graduated, school year ${from}`, updatedAt: serverTimestamp() },
      }));
      await commitOperations(ops);
      // Sections that already had grading assignments in the new school year: add the students to them
      let note = "";
      if (p.toExisting) {
        note = await moveInAssignments(p.moves.map(({ student, to: t }) => ({
          id: student.id, name: student.studentName, fromSectionId: student.sectionId, fromSchoolYear: student.schoolYear, to: t,
        }))).catch((err) => ` Grading assignments weren't changed: ${errorMessage(err)}`);
      }
      toast(`Promoted to ${to}: ${plural(p.moves.length, "student")} moved` +
        (p.graduate.length ? `, ${p.graduate.length} graduated` : "") +
        (p.create.size ? `, ${plural(p.create.size, "section")} created` : "") + `.${note}`);
      await onDone?.();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(els.run, false);
    }
  }

  els.btn.addEventListener("click", open);
  els.from.addEventListener("change", () => { els.to.value = nextSchoolYear(els.from.value); loadYear(); });
  els.to.addEventListener("input", () => { if (rows.length) draw(); });
  els.body.addEventListener("change", summarize);
  els.form.addEventListener("submit", run);
}
