// ==========================================================
// backup.js — Export all collections to one Excel file, and
// restore (import all) from that file.
//
// Each sheet = one collection. Column "_id" keeps the Firestore
// document id, so links between records survive a restore.
// Dates are written as ISO text, lists (studentIds) as JSON text.
// ==========================================================

import {
  db, collection, doc, getDoc, getDocs, getCountFromServer, databaseBackend, sheetsDatabaseUrl,
} from "./firebase-config.js";
import { Timestamp } from "./firebase-config.js";
import {
  initLayout, toast, escapeHtml, setBusy, errorMessage, commitOperations, loadSheetJs,
  formatDateTime, rememberSchool, DEFAULT_SCHOOL, getSchool, timeAgo,
} from "./app.js";
import { loadSheetsSettings, syncToSheets } from "./sheets-sync.js";
import { parseGrade, gradeRangeText, remarksFor } from "./grading-scale.js";

const BACKUP_VERSION = 1;

// Restore order matters: parents before children
const DATA_COLLECTIONS = [
  { name: "meta", label: "System setup marker" },
  { name: "settings", label: "School settings" },
  { name: "subjects", label: "Subjects" },
  { name: "curriculum", label: "Curriculum" },
  { name: "teachers", label: "Teachers" },
  { name: "sections", label: "Sections" },
  { name: "students", label: "Students" },
  { name: "gradingAssignments", label: "Grading assignments" },
  { name: "grades", label: "Grades" },
  { name: "gradeChangeRequests", label: "Grade change requests" },
  { name: "rosterRequests", label: "Class list requests" },
];
const ACCOUNT_COLLECTIONS = [
  { name: "users", label: "User accounts" },
  { name: "usernames", label: "Usernames" },
];
const ALL = [...DATA_COLLECTIONS, ...ACCOUNT_COLLECTIONS];
const isAccount = (name) => ACCOUNT_COLLECTIONS.some((c) => c.name === name);

// Field types for turning Excel cells back into Firestore values
const STRING_FIELDS = new Set([
  "studentId", "studentNumber", "teacherId", "subjectCode", "sectionName", "schoolYear", "username",
  "phone", "studentName", "teacherName", "subjectName", "displayName", "assignmentId", "gradeId",
  "teacherDocId", "subjectId", "sectionId", "uid", "requestedBy", "decidedBy",
]);
const NUMBER_FIELDS = new Set(["units", "finalGrade", "oldGrade", "newGrade"]);
const BOOLEAN_FIELDS = new Set(["active", "canApprove", "read", "reviewStarted"]);
const EMPTY_STRING_FIELDS = new Set(["email", "decisionNote", "logo", "address", "shortName", "website", "reason"]);

const els = {
  counts: document.getElementById("exportCounts"),
  exportAccounts: document.getElementById("exportAccounts"),
  btnExport: document.getElementById("btnExportAll"),
  lastBackup: document.getElementById("lastBackup"),
  file: document.getElementById("importFileAll"),
  plan: document.getElementById("importPlan"),
  planBody: document.getElementById("planBody"),
  importAccounts: document.getElementById("importAccounts"),
  replaceConfirm: document.getElementById("replaceConfirm"),
  confirmText: document.getElementById("confirmText"),
  progressWrap: document.getElementById("restoreProgressWrap"),
  progress: document.getElementById("restoreProgress"),
  log: document.getElementById("restoreLog"),
  btnBackupFirst: document.getElementById("btnBackupFirst"),
  btnRestore: document.getElementById("btnRestore"),
};

let me = null;
let counts = {};
let parsed = null; // { sheets: { name: rows[] }, about: {...}, problems: { name: msg } }
let running = false;

// ---------- Counts ----------
async function loadCounts() {
  els.counts.innerHTML = ALL.map((c) => `<li><span>${c.label}</span><span class="placeholder col-2 rounded"></span></li>`).join("");
  const results = await Promise.all(
    ALL.map((c) => getCountFromServer(collection(db, c.name)).then((r) => r.data().count).catch(() => null))
  );
  counts = {};
  ALL.forEach((c, i) => (counts[c.name] = results[i]));
  els.counts.innerHTML = ALL.map(
    (c) => `<li class="${isAccount(c.name) ? "account-row" : ""}"><span>${c.label}</span><strong>${counts[c.name] ?? "—"}</strong></li>`
  ).join("");
  syncAccountRows();
  try {
    const last = localStorage.getItem("gs-last-backup");
    if (last) els.lastBackup.textContent = `Last downloaded from this browser: ${formatDateTime(new Date(last))}`;
  } catch {}
}

function syncAccountRows() {
  els.counts.querySelectorAll(".account-row").forEach((li) => li.classList.toggle("text-secondary", !els.exportAccounts.checked));
}

// ---------- Export ----------
function toCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  return value;
}

function sheetFromDocs(docs) {
  const keys = [];
  docs.forEach((d) => Object.keys(d.data()).forEach((k) => { if (!keys.includes(k)) keys.push(k); }));
  const header = ["_id", ...keys];
  const rows = docs.map((d) => {
    const data = d.data();
    return [d.id, ...keys.map((k) => toCell(data[k]))];
  });
  return [header, ...rows];
}

async function exportAll(button = els.btnExport) {
  setBusy(button, true, "Preparing backup…");
  try {
    const XLSX = await loadSheetJs();
    const list = els.exportAccounts.checked ? ALL : DATA_COLLECTIONS;
    const snaps = await Promise.all(list.map((c) => getDocs(collection(db, c.name))));

    const wb = XLSX.utils.book_new();
    const now = new Date();
    const about = [
      ["College Grading System backup"],
      [],
      ["Created", now.toISOString()],
      ["Created by", me.displayName || me.username],
      ["Backup version", BACKUP_VERSION],
      [],
      ["Sheet", "Records"],
      ...list.map((c, i) => [c.name, snaps[i].size]),
      [],
      ["Keep this file private: it contains student records and grades."],
      ["Restore it on the Backup and restore page. Don't rename sheets or the _id column."],
    ];
    const aboutWs = XLSX.utils.aoa_to_sheet(about);
    aboutWs["!cols"] = [{ wch: 26 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, aboutWs, "About");

    list.forEach((c, i) => {
      const aoa = snaps[i].empty ? [["_id"]] : sheetFromDocs(snaps[i].docs);
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = aoa[0].map((h) => ({ wch: Math.min(Math.max(String(h).length + 2, 12), 40) }));
      XLSX.utils.book_append_sheet(wb, ws, c.name);
    });

    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
    XLSX.writeFile(wb, `grading-system-backup-${stamp}.xlsx`);
    try { localStorage.setItem("gs-last-backup", now.toISOString()); } catch {}
    els.lastBackup.textContent = `Last downloaded from this browser: ${formatDateTime(now)}`;
    const total = snaps.reduce((n, s) => n + s.size, 0);
    toast(`Backup downloaded: ${total} records in ${list.length} sheets.`);
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(button, false);
  }
}

// ---------- Import: read & check the file ----------
function fromCell(key, value) {
  if (value === "" || value === null || value === undefined) return EMPTY_STRING_FIELDS.has(key) ? "" : null;
  if (/At$/.test(key)) {
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d) ? null : Timestamp.fromDate(d);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (BOOLEAN_FIELDS.has(key)) {
    if (typeof value === "boolean") return value;
    return String(value).trim().toUpperCase() === "TRUE";
  }
  if (NUMBER_FIELDS.has(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (STRING_FIELDS.has(key)) return String(value);
  if (typeof value === "string") {
    const t = value.trim();
    if ((t.startsWith("[") && t.endsWith("]")) || (t.startsWith("{") && t.endsWith("}"))) {
      try { return JSON.parse(t); } catch {}
    }
  }
  return value;
}

function rowToDoc(row) {
  const data = {};
  Object.entries(row).forEach(([k, v]) => {
    if (k.startsWith("_") || k.startsWith("__EMPTY")) return;
    data[k] = fromCell(k, v);
  });
  return data;
}

function checkGrade(data) {
  const g = data.finalGrade;
  // INC / DRP: a remark saved instead of a number
  if ((g === null || g === undefined) && (data.remarks === "Incomplete" || data.remarks === "Dropped")) {
    data.finalGrade = null;
    return null;
  }
  // Must fit the school's grading scale (Setup and options)
  if (typeof g !== "number" || parseGrade(String(g)).state !== "valid") return `finalGrade must be ${gradeRangeText()}`;
  if (data.remarks !== remarksFor(g)) return "remarks must match finalGrade";
  return null;
}

async function readBackup() {
  const file = els.file.files[0];
  parsed = null;
  els.plan.classList.add("d-none");
  els.log.innerHTML = "";
  if (!file) return;

  try {
    const XLSX = await loadSheetJs();
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
    const known = wb.SheetNames.filter((n) => ALL.some((c) => c.name === n));
    if (!known.length) {
      toast("This file isn't a grading system backup. Use a file made with Download full backup.", "danger");
      return;
    }
    const sheets = {};
    const problems = {};
    const invalidRows = {};
    for (const c of ALL) {
      const ws = wb.Sheets[c.name];
      if (!ws) continue;
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
      const header = (XLSX.utils.sheet_to_json(ws, { header: 1, range: 0 })[0] || []).map(String);
      if (!header.includes("_id")) {
        problems[c.name] = "Missing the _id column";
        continue;
      }
      const ids = new Set();
      const docs = [];
      const bad = [];
      rows.forEach((row, i) => {
        const id = String(row._id ?? "").trim();
        if (!id) return; // blank line
        if (id.includes("/")) { bad.push(`row ${i + 2}: invalid _id`); return; }
        if (ids.has(id)) { bad.push(`row ${i + 2}: duplicate _id ${id}`); return; }
        ids.add(id);
        const data = rowToDoc(row);
        if (c.name === "grades") {
          const problem = checkGrade(data);
          if (problem) { bad.push(`row ${i + 2}: ${problem}`); return; }
        }
        docs.push({ id, data });
      });
      sheets[c.name] = docs;
      if (bad.length) invalidRows[c.name] = bad;
    }
    const extra = wb.SheetNames.filter((n) => n !== "About" && !ALL.some((c) => c.name === n));
    parsed = { sheets, problems, invalidRows, extra, fileName: file.name };
    renderPlan();
    els.plan.classList.remove("d-none");
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

function selectedCollections() {
  if (!parsed) return [];
  return ALL.filter((c) => parsed.sheets[c.name] && (els.importAccounts.checked || !isAccount(c.name)));
}

function mode() {
  return document.querySelector('input[name="importMode"]:checked').value;
}

function renderPlan() {
  const rows = ALL.map((c) => {
    const inFile = parsed.sheets[c.name];
    let status;
    if (parsed.problems[c.name]) status = `<span class="badge badge-fail">${escapeHtml(parsed.problems[c.name])}</span>`;
    else if (!inFile) status = `<span class="badge badge-none">Not in file</span>`;
    else if (isAccount(c.name) && !els.importAccounts.checked) status = `<span class="badge badge-none">Skipped (accounts off)</span>`;
    else if (parsed.invalidRows[c.name]) status = `<span class="badge text-bg-warning" title="${escapeHtml(parsed.invalidRows[c.name].slice(0, 10).join("\n"))}">${parsed.invalidRows[c.name].length} row(s) will be skipped</span>`;
    else status = `<span class="badge badge-pass">Ready</span>`;
    return `<tr>
      <td>${escapeHtml(c.label)}<div class="small text-secondary">${c.name}</div></td>
      <td class="num">${inFile ? inFile.length : "—"}</td>
      <td class="num">${counts[c.name] ?? "—"}</td>
      <td>${status}</td>
    </tr>`;
  }).join("");
  els.planBody.innerHTML = rows + (parsed.extra.length
    ? `<tr><td colspan="4" class="small text-secondary">Ignored sheets: ${parsed.extra.map(escapeHtml).join(", ")}</td></tr>` : "");
  updateRestoreButton();
}

function updateRestoreButton() {
  const replace = mode() === "replace";
  els.replaceConfirm.classList.toggle("d-none", !replace);
  const total = selectedCollections().reduce((n, c) => n + parsed.sheets[c.name].length, 0);
  const confirmed = !replace || els.confirmText.value.trim().toUpperCase() === "RESTORE";
  els.btnRestore.disabled = running || !parsed || total === 0 || !confirmed;
  els.btnRestore.innerHTML = `<i class="bi bi-upload me-1"></i>${replace ? "Replace with" : "Import"} ${total} record${total === 1 ? "" : "s"}`;
}

// ---------- Import: write ----------
async function restore() {
  if (!parsed || running) return;
  const list = selectedCollections();
  const replace = mode() === "replace";
  const myUsername = me.username;

  running = true;
  updateRestoreButton();
  els.btnBackupFirst.disabled = true;
  els.file.disabled = true;
  els.progressWrap.classList.remove("d-none");
  els.progress.style.width = "0%";
  const log = [];
  const say = (html) => { log.push(html); els.log.innerHTML = log.join("<br>"); };

  try {
    // 1) Replace: delete current records (children first), keeping your own account
    const deletes = [];
    if (replace) {
      say("Reading current records…");
      for (const c of [...list].reverse()) {
        const snap = await getDocs(collection(db, c.name));
        snap.forEach((d) => {
          if (c.name === "meta") return; // the setup marker is never removed
          if (c.name === "users" && d.id === me.uid) return;
          if (c.name === "usernames" && d.id === myUsername) return;
          deletes.push({ type: "delete", ref: d.ref });
        });
      }
    }

    // 2) Writes in parent → child order
    const writes = [];
    let skippedSelf = 0;
    for (const c of list) {
      for (const { id, data } of parsed.sheets[c.name]) {
        // The setup marker can only be created once; keep the existing one
        if (c.name === "meta" && (await getDoc(doc(db, "meta", id))).exists()) continue;
        if ((c.name === "users" && id === me.uid) || (c.name === "usernames" && id === myUsername)) {
          skippedSelf++;
          continue;
        }
        writes.push({ type: "set", ref: doc(db, c.name, id), data });
      }
    }

    const all = [...deletes, ...writes];
    say(`${replace ? "Deleting and restoring" : "Importing"}… 0 of ${all.length} operations`);
    const CHUNK = 400;
    for (let i = 0; i < all.length; i += CHUNK) {
      await commitOperations(all.slice(i, i + CHUNK));
      const done = Math.min(i + CHUNK, all.length);
      els.progress.style.width = `${Math.round((done / all.length) * 100)}%`;
      log[log.length - 1] = `${replace ? "Deleting and restoring" : "Importing"}… ${done} of ${all.length} operations`;
      els.log.innerHTML = log.join("<br>");
    }

    const summary = list.map((c) => `${c.label}: ${parsed.sheets[c.name].length}`).join(", ");
    say(`<span class="text-success fw-semibold">Done.</span> ${escapeHtml(summary)}.` +
      (replace ? ` Removed ${deletes.length} old record(s) first.` : "") +
      (skippedSelf ? " Your own account was kept as it is." : ""));
    const skipped = Object.entries(parsed.invalidRows).filter(([n]) => list.some((c) => c.name === n));
    if (skipped.length) {
      say(`<span style="color:#6e5810">Skipped rows: ${skipped.map(([n, rows]) => `${n} (${rows.length})`).join(", ")}.</span>`);
    }
    toast("Import finished.");

    // Refresh branding if school settings were restored
    const school = parsed.sheets.settings?.find((d) => d.id === "school");
    if (school && list.some((c) => c.name === "settings")) rememberSchool({ ...DEFAULT_SCHOOL, ...school.data });
  } catch (err) {
    say(`<span style="color:var(--maroon)">Stopped: ${escapeHtml(errorMessage(err))}</span>`);
    say("Some records may already have been written. Fix the problem and import again (Merge is safe to repeat).");
    toast("Import stopped. See the details on the page.", "danger");
  } finally {
    running = false;
    els.btnBackupFirst.disabled = false;
    els.file.disabled = false;
    els.confirmText.value = "";
    await loadCounts();
    if (parsed) renderPlan();
  }
}

// ---------- Copy to Google Sheets ----------
const gs = {
  status: document.getElementById("gsStatus"),
  info: document.getElementById("gsInfo"),
  counts: document.getElementById("gsCounts"),
  progress: document.getElementById("gsProgressWrap"),
  step: document.getElementById("gsStep"),
  btn: document.getElementById("btnGsSync"),
  open: document.getElementById("gsOpen"),
  setup: document.getElementById("gsSetup"),
};

function renderSheets(cfg) {
  const ready = cfg.url && cfg.key;
  const last = cfg.lastSyncAt?.toDate ? cfg.lastSyncAt.toDate() : null;
  gs.btn.disabled = !ready;
  gs.setup.textContent = ready ? "Change in School settings" : "Set up in School settings";
  gs.open.classList.toggle("d-none", !cfg.sheetUrl);
  if (cfg.sheetUrl) gs.open.href = cfg.sheetUrl;
  gs.status.className = `badge ${ready ? (last ? "badge-pass" : "badge-count") : "badge-none"}`;
  gs.status.textContent = ready ? (last ? `Copied ${timeAgo(last)}` : "Not copied yet") : "Not set up";
  gs.info.innerHTML = ready
    ? (last
      ? `Last copy: <strong>${escapeHtml(formatDateTime(last))}</strong>${cfg.lastSyncBy ? ` by ${escapeHtml(cfg.lastSyncBy)}` : ""}.${cfg.autoSync ? " A new copy is made automatically once a day." : ""}`
      : "Ready. Click Sync now for the first copy.")
    : "Keep a copy of every record in a Google Sheet you own. Set it up in School settings → Google Sheets copy (about 5 minutes).";
  const counts = cfg.lastCounts || {};
  gs.counts.innerHTML = Object.keys(counts).length
    ? Object.entries(counts).map(([k, v]) => `<span class="badge badge-count me-1 mb-1">${escapeHtml(k)}: ${v}</span>`).join("")
    : "";
}

async function loadSheets() {
  if (databaseBackend === "sheets") {
    gs.status.className = "badge badge-pass";
    gs.status.textContent = "Not needed";
    gs.info.innerHTML = "Your database already is a Google Sheet, so there's nothing to copy. Use the Download full backup above for an extra copy.";
    gs.btn.classList.add("d-none");
    gs.setup.classList.add("d-none");
    gs.open.classList.add("d-none");
    return;
  }
  try { renderSheets(await loadSheetsSettings()); }
  catch (err) { gs.info.textContent = errorMessage(err); }
}

async function syncSheetsNow() {
  setBusy(gs.btn, true, "Copying…");
  gs.progress.classList.remove("d-none");
  try {
    const school = await getSchool();
    const r = await syncToSheets({ me, school, onStep: (t) => (gs.step.textContent = t) });
    gs.step.textContent = "";
    toast(`Copied ${r.total} records to Google Sheets.`);
    await loadSheets();
  } catch (err) {
    gs.step.textContent = "";
    toast(err.message || errorMessage(err), "danger");
  } finally {
    gs.progress.classList.add("d-none");
    setBusy(gs.btn, false);
  }
}

// ---------- Wire up ----------
function init(profile) {
  me = profile;
  els.exportAccounts.addEventListener("change", syncAccountRows);
  els.btnExport.addEventListener("click", () => exportAll(els.btnExport));
  els.btnBackupFirst.addEventListener("click", () => exportAll(els.btnBackupFirst));
  els.file.addEventListener("change", readBackup);
  els.importAccounts.addEventListener("change", () => parsed && renderPlan());
  document.querySelectorAll('input[name="importMode"]').forEach((r) => r.addEventListener("change", updateRestoreButton));
  els.confirmText.addEventListener("input", updateRestoreButton);
  els.btnRestore.addEventListener("click", restore);
  gs.btn.addEventListener("click", syncSheetsNow);
  loadSheets();
  window.addEventListener("beforeunload", (e) => {
    if (running) { e.preventDefault(); e.returnValue = ""; }
  });
  loadCounts();
}

initLayout("backup").then((user) => { if (user) init(user); });
