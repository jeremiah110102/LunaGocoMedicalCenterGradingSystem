// ==========================================================
// options.js — Setup and options (administrators)
// Document: settings/options { gradingScale, allowConditional, sectionMove,
//                              finalScale, transmutation }
//
// The grading scale can only change while no grades are saved: grades
// already entered on one scale would be wrong on another.
// ==========================================================

import { db, doc, setDoc, serverTimestamp, collection, getCountFromServer, Timestamp } from "./firebase-config.js";
import { TERMS, deadlineMs, deadlineText } from "./terms.js";
import { initLayout, toast, setBusy, errorMessage, getOptions, rememberOptions } from "./app.js";
import {
  SCALES, allowedGrades, remarksFor, remarksClass, gwaRemarks, DEFAULT_TRANSMUTATION, finalScaleKey,
} from "./grading-scale.js";

const els = {
  scaleForm: document.getElementById("scaleForm"),
  scaleStatus: document.getElementById("scaleStatus"),
  scaleLocked: document.getElementById("scaleLocked"),
  cond: document.getElementById("scConditional"),
  condWrap: document.getElementById("condWrap"),
  condValue: document.getElementById("condValue"),
  table: document.getElementById("scaleTable"),
  gwa: document.getElementById("scaleGwa"),
  scaleSaved: document.getElementById("scaleSaved"),
  btnScale: document.getElementById("btnSaveScale"),
  moveForm: document.getElementById("moveForm"),
  moveSaved: document.getElementById("moveSaved"),
  btnMove: document.getElementById("btnSaveMove"),
  finalForm: document.getElementById("finalForm"),
  finalStatus: document.getElementById("finalStatus"),
  fsSameNote: document.getElementById("fsSameNote"),
  fsPercent: document.getElementById("fsPercent"),
  fsPercentOff: document.getElementById("fsPercentOff"),
  transWrap: document.getElementById("transWrap"),
  transTo: document.getElementById("transTo"),
  transTable: document.getElementById("transTable"),
  btnTransReset: document.getElementById("btnTransReset"),
  finalError: document.getElementById("finalError"),
  finalSaved: document.getElementById("finalSaved"),
  btnFinal: document.getElementById("btnSaveFinal"),
};
let trans = []; // the conversion table being edited

let me = null;
let saved = null;      // the options as saved
let gradeCount = null; // grades saved in the system (null = unknown)

const chosenScale = () => (document.querySelector('input[name="scale"]:checked') || {}).value || "percent";
const chosenFinal = () => (document.querySelector('input[name="finalScale"]:checked') || {}).value || "same";
const chosenMove = () => (document.querySelector('input[name="sectionMove"]:checked') || {}).value || "ask";

function meaning(scale, v) {
  if (scale === "percent") return "";
  const best = scale === "point1" ? 1 : 5;
  const r = remarksFor(v, scale);
  if (v === best) return "Highest / excellent";
  if (r === "Conditional") return "Conditional / incomplete";
  if (r === "Failed") return "Failing";
  if (v === 3) return "Lowest passing grade";
  return "Passing (very good to fair)";
}

/** The table of grades for the scale being looked at. */
function renderScale() {
  const scale = chosenScale();
  const point = scale !== "percent";
  els.condWrap.classList.toggle("d-none", !point);
  els.condValue.textContent = scale === "point5" ? "2.00" : "4.00";
  const badge = (r) => `<span class="badge ${remarksClass(r)}">${r}</span>`;
  if (!point) {
    els.table.innerHTML = `
      <tr><td>75 to 100</td><td>Passing</td><td>${badge("Passed")}</td></tr>
      <tr><td>0 to 74.99</td><td>Below passing</td><td>${badge("Failed")}</td></tr>`;
  } else {
    els.table.innerHTML = allowedGrades(scale, els.cond.checked)
      .map((v) => `<tr><td class="fw-semibold">${v.toFixed(2)}</td><td>${meaning(scale, v)}</td><td>${badge(remarksFor(v, scale))}</td></tr>`)
      .join("");
  }
  els.gwa.textContent = scale === "percent"
    ? "General weighted average: 75.00 and above is Passed."
    : `General weighted average: ${scale === "point1" ? "3.00 or lower (better)" : "3.00 or higher (better)"} is Passed, e.g. ${scale === "point1" ? "1.85" : "4.15"} → ${gwaRemarks(scale === "point1" ? 1.85 : 4.15, scale)}.`;
  renderLock();
}

/** The scale can't change while grades exist. */
function renderLock() {
  const changing = saved && chosenScale() !== saved.gradingScale;
  const blocked = changing && gradeCount !== 0;
  els.scaleLocked.classList.toggle("d-none", !blocked);
  if (blocked) {
    els.scaleLocked.innerHTML = gradeCount === null
      ? "Checking whether any grades are saved…"
      : `<strong>${gradeCount} grade${gradeCount === 1 ? " is" : "s are"} saved on the current scale (${SCALES[saved.gradingScale].short}).</strong> ` +
        "The grading scale can only change while no grades are saved, because existing grades would be wrong on another scale. " +
        "Download a full backup first (Backup and restore), then delete the grades, or keep the current scale.";
  }
  els.btnScale.disabled = blocked;
}

function renderStatus() {
  els.scaleStatus.className = "badge badge-pass";
  els.scaleStatus.textContent = SCALES[saved.gradingScale].short;
}

async function save(patch, btn, savedEl, message) {
  setBusy(btn, true);
  try {
    const data = { ...saved, ...patch };
    await setDoc(doc(db, "settings", "options"), {
      gradingScale: data.gradingScale, allowConditional: !!data.allowConditional, sectionMove: data.sectionMove,
      finalScale: data.finalScale || "same", transmutation: data.transmutation || DEFAULT_TRANSMUTATION,
      auditKeepDays: Number(data.auditKeepDays) || 0,
      termDeadlines: savedDeadlines(data.termDeadlines),
      combineClasses: data.combineClasses === "off" ? "off" : "auto",
      updatedAt: serverTimestamp(), updatedByName: me.displayName || me.username,
    });
    saved = data;
    rememberOptions(data);
    savedEl.textContent = "Saved just now. Every device follows within about 5 minutes (right away on this one).";
    toast(message);
    return true;
  } catch (err) {
    toast(errorMessage(err), "danger");
    return false;
  } finally {
    setBusy(btn, false);
  }
}

// ---------- Term deadlines ----------
/** Deadlines to save: { term: Timestamp } (terms without a date are left out). */
function savedDeadlines(map) {
  const out = {};
  Object.entries(map || {}).forEach(([term, v]) => {
    const ms = deadlineMs(v);
    if (TERMS.includes(term) && ms !== null) out[term] = Timestamp.fromMillis(ms);
  });
  return out;
}
const tm = {
  form: document.getElementById("termForm"),
  table: document.getElementById("termTable"),
  status: document.getElementById("termStatus"),
  error: document.getElementById("termError"),
  saved: document.getElementById("termSaved"),
  btn: document.getElementById("btnSaveTerms"),
};
const dateValue = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function renderTerms() {
  const dl = saved.termDeadlines || {};
  const closedNow = TERMS.filter((t) => { const ms = deadlineMs(dl[t]); return ms !== null && Date.now() >= ms; });
  tm.status.className = closedNow.length ? "badge text-bg-warning" : "badge badge-pass";
  tm.status.textContent = closedNow.length ? `Closed: ${closedNow.join(", ")}` : "All terms open";
  tm.table.innerHTML = TERMS.map((t) => {
    const ms = deadlineMs(dl[t]);
    const state = ms === null ? `<span class="badge badge-pass">Open</span>`
      : Date.now() >= ms ? `<span class="badge text-bg-warning">Closed (last day was ${deadlineText(ms - 1)})</span>`
        : `<span class="badge badge-pass">Open through ${deadlineText(ms - 1)}</span>`;
    return `<tr>
      <td class="fw-semibold">${t}</td>
      <td><div class="d-flex gap-2 align-items-center">
        <input type="date" class="form-control form-control-sm" style="max-width:11rem" data-term="${t}" value="${ms === null ? "" : dateValue(ms - 1)}" aria-label="${t}: last day teachers can add grades">
        <button type="button" class="btn btn-link btn-sm p-0" data-clear="${t}">Clear</button>
      </div></td>
      <td>${state}</td>
    </tr>`;
  }).join("");
}
function initTerms() {
  if (!tm.form) return;
  renderTerms();
  tm.table.addEventListener("click", (e) => {
    const b = e.target.closest("[data-clear]");
    if (b) tm.table.querySelector(`[data-term="${b.dataset.clear}"]`).value = "";
  });
  tm.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    tm.error.textContent = "";
    const map = {};
    for (const input of tm.table.querySelectorAll("[data-term]")) {
      if (!input.value) continue;
      const [y, m, d] = input.value.split("-").map(Number);
      if (!y || !m || !d) { tm.error.textContent = `Check the date for ${input.dataset.term}.`; return; }
      // Open through the whole chosen day: closes at midnight after it
      map[input.dataset.term] = new Date(y, m - 1, d + 1, 0, 0, 0).getTime();
    }
    const names = Object.keys(map);
    if (await save({ termDeadlines: map }, tm.btn, tm.saved, names.length ? `Deadlines saved: ${names.join(", ")}.` : "No term deadlines: every term is open.")) renderTerms();
  });
}

// ---------- Combined classes ----------
function initCombine() {
  const form = document.getElementById("combineForm");
  if (!form) return;
  const status = document.getElementById("combineStatus");
  const show = () => {
    const on = saved.combineClasses !== "off";
    status.className = on ? "badge badge-pass" : "badge badge-none";
    status.textContent = on ? "On" : "Off";
  };
  (document.querySelector(`input[name="combine"][value="${saved.combineClasses === "off" ? "off" : "auto"}"]`) || {}).checked = true;
  show();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (document.querySelector('input[name="combine"]:checked') || {}).value === "off" ? "off" : "auto";
    if (await save({ combineClasses: v }, document.getElementById("btnSaveCombine"), document.getElementById("combineSaved"),
      v === "off" ? "Combined classes are off: each section is its own class in Enter grades." : "Combined classes are on.")) show();
  });
}

// ---------- Audit trail: how long entries are kept ----------
const ak = {
  form: document.getElementById("auditForm"),
  status: document.getElementById("auditStatus"),
  manual: document.getElementById("akManual"),
  auto: document.getElementById("akAuto"),
  preset: document.getElementById("akPreset"),
  customWrap: document.getElementById("akCustomWrap"),
  days: document.getElementById("akDays"),
  error: document.getElementById("akError"),
  saved: document.getElementById("auditSaved"),
  btn: document.getElementById("btnSaveAudit"),
};

function renderAuditStatus() {
  const d = Number(saved.auditKeepDays) || 0;
  ak.status.className = "badge badge-pass";
  ak.status.textContent = d ? `Deleted after ${d} days` : "Kept until deleted";
}

function syncAuditForm() {
  const custom = ak.preset.value === "custom";
  ak.customWrap.classList.toggle("d-none", !custom);
  ak.customWrap.classList.toggle("d-inline-flex", custom);
  ak.preset.disabled = !ak.auto.checked;
  ak.days.disabled = !ak.auto.checked;
}

function initAuditKeep() {
  const d = Number(saved.auditKeepDays) || 0;
  (d ? ak.auto : ak.manual).checked = true;
  if (d) {
    const preset = [...ak.preset.options].some((o) => o.value === String(d));
    ak.preset.value = preset ? String(d) : "custom";
    ak.days.value = d;
  } else {
    ak.preset.value = "90";
  }
  renderAuditStatus();
  syncAuditForm();
  [ak.manual, ak.auto, ak.preset].forEach((el) => el.addEventListener("change", syncAuditForm));
  ak.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    ak.error.textContent = "";
    let days = 0;
    if (ak.auto.checked) {
      days = ak.preset.value === "custom" ? Math.round(Number(ak.days.value)) : Number(ak.preset.value);
      if (!(days >= 1 && days <= 3650)) { ak.error.textContent = "Enter a number of days from 1 to 3650."; return; }
    }
    if (await save({ auditKeepDays: days }, ak.btn, ak.saved, days ? `Audit trail entries older than ${days} days will be deleted automatically.` : "Audit trail entries are kept until you delete them.")) renderAuditStatus();
  });
}

// ---------- Final grade (GWA) ----------
const fmt = (n) => Number(n).toFixed(2);

function renderFinalStatus() {
  const key = finalScaleKey(saved);
  els.finalStatus.className = "badge badge-pass";
  els.finalStatus.textContent = key === saved.gradingScale ? "Same as grading scale" : SCALES[key].short;
}

function renderFinal() {
  const grading = chosenScale();
  const pointGrading = grading !== "percent";
  els.fsSameNote.textContent = `· ${SCALES[grading].short}`;
  els.fsPercent.disabled = pointGrading;
  els.fsPercentOff.classList.toggle("d-none", !pointGrading);
  if (pointGrading && chosenFinal() === "percent") document.getElementById("fsSame").checked = true;
  const to = chosenFinal();
  const showTable = grading === "percent" && (to === "point1" || to === "point5");
  els.transWrap.classList.toggle("d-none", !showTable);
  if (!showTable) return;
  const g = (x) => fmt(to === "point5" ? 6 - x : x);
  els.transTo.textContent = to === "point5" ? "5.00–1.00" : "1.00–5.00";
  const enabled = trans.filter((r) => typeof r.min === "number");
  els.transTable.innerHTML = trans.map((r, i) => {
    const on = typeof r.min === "number";
    const optional = r.grade === 4;
    const prev = enabled[enabled.indexOf(r) - 1];
    const upTo = !on ? "" : prev ? fmt(prev.min - 0.01) : "100.00";
    return `<tr>
      <td class="fw-semibold">${g(r.grade)}${optional ? `<div class="form-check form-switch small fw-normal mb-0"><input class="form-check-input" type="checkbox" role="switch" data-cond id="transCond" ${on ? "checked" : ""}><label class="form-check-label" for="transCond">use (conditional)</label></div>` : ""}</td>
      <td><input type="number" class="form-control form-control-sm" style="max-width:7rem" min="0" max="100" step="0.01" data-i="${i}" value="${on ? r.min : ""}" ${on ? "" : "disabled"} aria-label="Lowest GWA for ${g(r.grade)}"></td>
      <td class="small text-secondary">${upTo}</td>
    </tr>`;
  }).join("") + `<tr><td class="fw-semibold">${g(5)}</td><td colspan="2" class="small text-secondary">below ${enabled.length ? fmt(enabled[enabled.length - 1].min) : "75.00"} (failing)</td></tr>`;
}

/** Checks the table: numbers from 0 to 100, each lower than the one above. */
function checkTrans() {
  const rows = trans.filter((r) => typeof r.min === "number");
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i].min;
    if (!(m >= 0 && m <= 100)) return "Each GWA must be a number from 0 to 100.";
    if (i && m >= rows[i - 1].min) return "Each row must start lower than the row above it.";
  }
  return "";
}

async function init(profile) {
  me = profile;
  saved = await getOptions(true);
  document.querySelector(`input[name="scale"][value="${saved.gradingScale}"]`).checked = true;
  document.querySelector(`input[name="sectionMove"][value="${saved.sectionMove}"]`).checked = true;
  els.cond.checked = saved.allowConditional !== false;
  renderStatus();
  renderScale();

  document.querySelectorAll('input[name="scale"]').forEach((r) => r.addEventListener("change", () => { renderScale(); renderFinal(); }));

  // Final grade
  trans = (saved.transmutation || DEFAULT_TRANSMUTATION).map((r) => ({ ...r }));
  if (!trans.some((r) => r.grade === 4)) trans.push({ grade: 4, min: null });
  const fs = document.querySelector(`input[name="finalScale"][value="${saved.finalScale || "same"}"]`) || document.getElementById("fsSame");
  fs.checked = true;
  renderFinalStatus();
  renderFinal();
  initAuditKeep();
  initTerms();
  initCombine();
  document.querySelectorAll('input[name="finalScale"]').forEach((r) => r.addEventListener("change", renderFinal));
  els.transTable.addEventListener("change", (e) => {
    if (e.target.matches("[data-cond]")) {
      const row = trans.find((r) => r.grade === 4);
      const three = trans.find((r) => r.grade === 3);
      row.min = e.target.checked ? Math.max(0, (three && typeof three.min === "number" ? three.min : 75) - 5) : null;
    } else if (e.target.matches("[data-i]")) {
      trans[Number(e.target.dataset.i)].min = e.target.value === "" ? NaN : Number(e.target.value);
    }
    renderFinal();
  });
  els.btnTransReset.addEventListener("click", () => {
    trans = DEFAULT_TRANSMUTATION.map((r) => ({ ...r }));
    renderFinal();
  });
  els.finalForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.finalError.classList.add("d-none");
    const problem = checkTrans();
    if (problem) {
      els.finalError.textContent = problem;
      els.finalError.classList.remove("d-none");
      return;
    }
    const finalScale = chosenFinal();
    const transmutation = trans.map((r) => ({ grade: r.grade, min: typeof r.min === "number" && !Number.isNaN(r.min) ? r.min : null }));
    if (await save({ finalScale, transmutation }, els.btnFinal, els.finalSaved, "Final grade setting saved.")) renderFinalStatus();
  });
  els.cond.addEventListener("change", renderScale);

  els.scaleForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const scale = chosenScale();
    if (scale !== saved.gradingScale) {
      // Count again right before saving
      try { gradeCount = (await getCountFromServer(collection(db, "grades"))).data().count; } catch (err) { toast(errorMessage(err), "danger"); return; }
      if (gradeCount) { renderLock(); return; }
    }
    if (await save({ gradingScale: scale, allowConditional: els.cond.checked }, els.btnScale, els.scaleSaved, "Grading scale saved.")) renderStatus();
  });
  els.moveForm.addEventListener("submit", (e) => {
    e.preventDefault();
    save({ sectionMove: chosenMove() }, els.btnMove, els.moveSaved, "Saved.");
  });

  try {
    gradeCount = (await getCountFromServer(collection(db, "grades"))).data().count;
  } catch (err) {
    console.warn("Grade count:", err.code || err);
  }
  renderLock();
}

initLayout("options").then((user) => { if (user) init(user); });
