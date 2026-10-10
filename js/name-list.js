// ==========================================================
// name-list.js — Find many students at once from a pasted list
//
// Paste a class list (one student per line, e.g. copied from the teacher's
// masterlist in Excel): "Dela Peña, Cloui Miles Tabin". Each line is matched
// to a student, ignoring capitals, accents (ñ = n), extra spaces and
// punctuation; a shortened middle name ("Fonte, Daniella Grace M.") matches
// the full one, and a Student ID on the line matches too.
// Used by Grading assignments (tick the list) and Students (select the list).
// ==========================================================

import { escapeHtml } from "./app.js";

/** "Dela Peña, Cloui M." → "dela pena cloui m" */
export const fold = (s) =>
  String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9,]+/g, " ").replace(/\s*,\s*/g, ", ").replace(/\s+/g, " ").trim();

/** { last, given: [tokens], all: [tokens] } of a name ("Surname, Given names" or "Given names Surname"). */
function parts(name) {
  const f = fold(name);
  const i = f.indexOf(",");
  const words = (x) => x.replace(/,/g, " ").split(" ").filter(Boolean);
  if (i >= 0) return { last: words(f.slice(0, i)).join(" "), given: words(f.slice(i + 1)), all: words(f) };
  return { last: "", given: [], all: words(f) };
}

/** Given names agree word by word; an initial ("M") matches a word starting with it; one may be longer. */
function givenMatch(a, b) {
  if (!a.length || !b.length || a[0] !== b[0]) return false;
  for (let k = 1; k < Math.min(a.length, b.length); k++) {
    const x = a[k], y = b[k];
    if (x === y) continue;
    if ((x.length === 1 && y.startsWith(x)) || (y.length === 1 && x.startsWith(y))) continue;
    return false;
  }
  return true;
}

/** The lines of a pasted list: spreadsheet cells, numbering ("12." "12)") and blank lines are cleaned up. */
export function listLines(text) {
  return String(text ?? "").split(/\r?\n/)
    .map((line) => {
      // Copied from Excel: cells are separated by tabs; keep the cells that have letters or an ID
      const cells = line.split("\t").map((c) => c.trim()).filter(Boolean);
      return cells.join(" ").replace(/^\s*\d{1,3}\s*[.)]\s+/, "").replace(/\s+/g, " ").trim();
    })
    .filter((line) => /[A-Za-zÀ-ÿ]|\d{4,}/.test(line));
}

/**
 * Matches each line to the students: [{ line, status: "found" | "many" | "missing", student, candidates }].
 * A student found by an earlier line isn't used again (the same name twice is reported).
 */
export function matchNames(lines, students) {
  const prepared = students.map((s) => ({ s, f: fold(s.studentName), p: parts(s.studentName), id: String(s.studentId ?? "").trim().toLowerCase() }));
  const used = new Set();
  return lines.map((line) => {
    const f = fold(line);
    // 1) A Student ID on the line
    const idTok = (line.match(/\b[\w-]*\d{4,}[\w-]*\b/) || [])[0];
    const p = parts(idTok ? line.replace(idTok, "") : line);
    let hits = idTok ? prepared.filter((x) => x.id && x.id === idTok.toLowerCase()) : [];
    // 2) The same name
    const nameOnly = idTok ? fold(line.replace(idTok, "")) : f;
    if (!hits.length) hits = prepared.filter((x) => x.f === nameOnly);
    // 3) Same surname, given names agree (initials, shorter or longer)
    if (!hits.length && p.last) hits = prepared.filter((x) => x.p.last === p.last && givenMatch(p.given, x.p.given));
    // 4) The same words in any order (with or without the comma)
    if (!hits.length && p.all.length > 1) {
      const key = [...p.all].sort().join(" ");
      hits = prepared.filter((x) => [...x.p.all].sort().join(" ") === key);
    }
    const free = hits.filter((x) => !used.has(x.s.id));
    if (free.length === 1) {
      used.add(free[0].s.id);
      return { line, status: "found", student: free[0].s };
    }
    if (free.length > 1) return { line, status: "many", candidates: free.map((x) => x.s) };
    if (hits.length) return { line, status: "missing", note: "already matched by another line" };
    return { line, status: "missing" };
  });
}

// ---------- The dialog ----------
let modal = null;
function elements() {
  let el = document.getElementById("nameListModal");
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal fade" id="nameListModal" tabindex="-1" aria-labelledby="nameListTitle" aria-hidden="true">
        <div class="modal-dialog modal-lg modal-dialog-scrollable modal-fullscreen-sm-down">
          <div class="modal-content">
            <div class="modal-header">
              <h2 class="modal-title fs-5" id="nameListTitle">Find students from a list</h2>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <div id="nameListStep1">
                <label for="nameListText" class="form-label">Paste the names, one per line <span class="text-secondary fw-normal">(e.g. copied from the teacher's masterlist in Excel)</span></label>
                <textarea class="form-control font-monospace small" id="nameListText" rows="12" spellcheck="false" placeholder="Ahorro, Justine Ashley Raymundo&#10;Alcantara, Kristine Mae Claveria&#10;Alegre, Edher Ayala A."></textarea>
                <div class="form-text">Capitals, accents (ñ), extra spaces and numbering don't matter. A shortened middle name ("Fonte, Daniella Grace M.") still matches. Student IDs work too.</div>
              </div>
              <div id="nameListStep2" class="d-none">
                <div class="d-flex flex-wrap gap-2 mb-2 small" id="nameListSummary"></div>
                <div id="nameListExtra"></div>
                <div class="table-responsive"><table class="table table-sm align-middle mb-0">
                  <thead><tr><th class="text-secondary">#</th><th>From the list</th><th>Student found</th></tr></thead>
                  <tbody id="nameListBody"></tbody>
                </table></div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary me-auto d-none" id="nameListBack"><i class="bi bi-arrow-left me-1"></i>Edit the list</button>
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" id="nameListFind"><i class="bi bi-search me-1"></i>Find students</button>
              <button type="button" class="btn btn-primary d-none" id="nameListApply"></button>
            </div>
          </div>
        </div>
      </div>`);
    el = document.getElementById("nameListModal");
  }
  if (!modal) modal = bootstrap.Modal.getOrCreateInstance(el);
  const $ = (id) => el.querySelector(`#${id}`);
  return { el, title: $("nameListTitle"), text: $("nameListText"), step1: $("nameListStep1"), step2: $("nameListStep2"), summary: $("nameListSummary"), extra: $("nameListExtra"), body: $("nameListBody"), back: $("nameListBack"), find: $("nameListFind"), apply: $("nameListApply") };
}

/**
 * Opens the dialog.
 *  students     the students to search (e.g. the school year's)
 *  describe(s)  small text after a found student (e.g. "BSC 1A" or "other section: BSC 1B")
 *  extraHtml(results)  options shown above the results (checkboxes …), optional
 *  applyText(n, root)  the apply button's text (root = the dialog, to read the options)
 *  onApply(found, results, root)  found = matched students; root = the dialog (to read extra options)
 */
export function openNameList({ title = "Find students from a list", students, describe = () => "", extraHtml = () => "", applyText = (n) => `Select ${n}`, onApply }) {
  const e = elements();
  e.title.textContent = title;
  let results = [];
  const showStep = (two) => {
    e.step1.classList.toggle("d-none", two);
    e.step2.classList.toggle("d-none", !two);
    e.back.classList.toggle("d-none", !two);
    e.find.classList.toggle("d-none", two);
    e.apply.classList.toggle("d-none", !two);
  };
  const found = () => results.filter((r) => r.status === "found").map((r) => r.student);
  const draw = () => {
    const n = (st) => results.filter((r) => r.status === st).length;
    e.summary.innerHTML = `
      <span class="badge badge-pass">${n("found")} found</span>
      ${n("many") ? `<span class="badge text-bg-warning">${n("many")} with more than one match</span>` : ""}
      ${n("missing") ? `<span class="badge badge-fail">${n("missing")} not found</span>` : ""}
      <span class="text-secondary">${results.length} name${results.length === 1 ? "" : "s"} in the list</span>`;
    // Keep the options the user already chose when the list is redrawn
    const kept = new Map([...e.extra.querySelectorAll("input[id]")].map((x) => [x.id, x.checked]));
    e.extra.innerHTML = extraHtml(results);
    kept.forEach((on, id) => { const x = e.extra.querySelector(`#${CSS.escape(id)}`); if (x) x.checked = on; });
    e.body.innerHTML = results.map((r, i) => `
      <tr class="${r.status === "missing" ? "table-danger" : r.status === "many" ? "table-warning" : ""}">
        <td class="text-secondary small">${i + 1}</td>
        <td>${escapeHtml(r.line)}</td>
        <td>${r.status === "found"
          ? `<span class="code-cell">${escapeHtml(r.student.studentId)}</span> ${escapeHtml(r.student.studentName)} <span class="small text-secondary">${describe(r.student)}</span>`
          : r.status === "many"
            ? `<span class="small">More than one student matches. Choose:</span> <select class="form-select form-select-sm d-inline-block w-auto" data-choose="${i}"><option value="">—</option>${r.candidates.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(`${c.studentId} – ${c.studentName}`)}</option>`).join("")}</select>`
            : `<span class="text-danger small"><i class="bi bi-x-circle me-1"></i>Not found${r.note ? ` (${escapeHtml(r.note)})` : ""}</span>`}</td>
      </tr>`).join("");
    label();
  };
  const label = () => {
    const count = found().length;
    e.apply.textContent = applyText(count, e.el);
    e.apply.disabled = !count;
  };
  e.extra.onchange = label;
  e.body.onchange = (ev) => {
    const sel = ev.target.closest("[data-choose]");
    if (!sel) return;
    const r = results[Number(sel.dataset.choose)];
    const pick = r.candidates.find((c) => c.id === sel.value);
    if (pick) Object.assign(r, { status: "found", student: pick });
    draw();
  };
  e.find.onclick = () => {
    const lines = listLines(e.text.value);
    if (!lines.length) { e.text.focus(); return; }
    results = matchNames(lines, students);
    showStep(true);
    draw();
  };
  e.back.onclick = () => showStep(false);
  e.apply.onclick = async () => {
    e.apply.disabled = true;
    try {
      const done = await onApply(found(), results, e.el);
      if (done !== false) modal.hide();
    } finally {
      e.apply.disabled = false;
    }
  };
  showStep(false);
  e.el.addEventListener("shown.bs.modal", () => e.text.focus(), { once: true });
  modal.show();
}
