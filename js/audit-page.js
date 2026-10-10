// ==========================================================
// audit-page.js — Audit trail (administrators)
// Collection: auditLog (see audit.js). Newest first, 200 at a time.
// ==========================================================

import { db, collection, getDocs, query, where, orderBy, limit } from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy, compareText,
  tableLoading, tableMessage, errorMessage, formatDateTime, toDate, getOptions, deleteAuditOlderThan,
} from "./app.js";
import { AUDIT_LISTS } from "./audit.js";

const PAGE = 200;
const auditCol = collection(db, "auditLog");

const els = {
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  keepNote: document.getElementById("keepNote"),
  list: document.getElementById("fList"),
  action: document.getElementById("fAction"),
  who: document.getElementById("fWho"),
  from: document.getElementById("fFrom"),
  to: document.getElementById("fTo"),
  search: document.getElementById("fSearch"),
  loadedNote: document.getElementById("loadedNote"),
  btnMore: document.getElementById("btnMore"),
  delOlder: document.getElementById("delOlder"),
  btnDelete: document.getElementById("btnDelete"),
  modalEl: document.getElementById("auditModalEl") || document.getElementById("auditModal"),
  modalTitle: document.getElementById("auditModalTitle"),
  modalBody: document.getElementById("auditModalBody"),
};

let entries = [];  // loaded so far, newest first
let reachedEnd = false;
let modal;

const ACTIONS = {
  create: ["Added", "badge-pass"],
  update: ["Edited", "badge-cond"],
  save: ["Saved", "badge-cond"],
  delete: ["Deleted", "badge-fail"],
};

// ---------- Values ----------
/** "studentName" → "Student name" */
function fieldName(k) {
  const special = { studentId: "Student ID", teacherId: "Teacher ID", studentIds: "Students", teacherDocId: "Teacher (record)", subjectId: "Subject (record)", sectionId: "Section (record)", finalGrade: "Final grade", uid: "Account", canApprove: "Can approve grade changes" };
  if (special[k]) return special[k];
  const s = String(k).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function showValue(v) {
  if (v === undefined) return `<span class="text-secondary">—</span>`;
  if (v === null || v === "") return `<span class="text-secondary">(empty)</span>`;
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "string" && ISO.test(v)) return escapeHtml(formatDateTime(new Date(v)));
  if (Array.isArray(v)) {
    if (!v.length) return `<span class="text-secondary">(none)</span>`;
    return `<span class="text-secondary small">${v.length} item${v.length === 1 ? "" : "s"}:</span> ${escapeHtml(v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", "))}`;
  }
  if (typeof v === "object") return `<code class="small">${escapeHtml(JSON.stringify(v))}</code>`;
  return escapeHtml(String(v));
}

const plain = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One line: "Student name: Abordo → Abordo S., +2 more" */
function changeSummary(e) {
  const keys = [...new Set([...Object.keys(e.before || {}), ...Object.keys(e.after || {})])];
  if (e.col === "auditLog") return `<span class="text-secondary">Old audit trail entries deleted</span>`;
  if (!keys.length) return "";
  const first = keys.slice(0, 2).map((k) => {
    const b = (e.before || {})[k];
    const a = (e.after || {})[k];
    const cut = (x) => { const t = Array.isArray(x) ? `${x.length} items` : plain(x); return t.length > 28 ? `${t.slice(0, 28)}…` : t; };
    if (e.action === "update") return `<strong>${escapeHtml(fieldName(k))}</strong>: ${escapeHtml(cut(b))} → ${escapeHtml(cut(a))}`;
    return `<strong>${escapeHtml(fieldName(k))}</strong>: ${escapeHtml(cut(e.action === "delete" ? b : a))}`;
  });
  return first.join("<br>") + (keys.length > 2 ? `<div class="text-secondary">+${keys.length - 2} more</div>` : "");
}

// ---------- Loading ----------
async function loadPage(more = false) {
  if (!more) { entries = []; reachedEnd = false; tableLoading(els.tbody, 6, 6); }
  setBusy(els.btnMore, true, "Loading…");
  try {
    const last = entries[entries.length - 1];
    const parts = [orderBy("at", "desc"), limit(PAGE)];
    if (more && last && last.at) parts.unshift(where("at", "<", last.at));
    const snap = await getDocs(query(auditCol, ...parts));
    const got = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    entries = entries.concat(got);
    reachedEnd = got.length < PAGE;
    fillFilters();
    render();
  } catch (err) {
    tableMessage(els.tbody, 6, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  } finally {
    setBusy(els.btnMore, false);
    els.btnMore.classList.toggle("d-none", reachedEnd);
  }
}

function fillFilters() {
  const keep = (el, html) => { const v = el.value; el.innerHTML = html; el.value = [...el.options].some((o) => o.value === v) ? v : ""; };
  const lists = [...new Set(entries.map((e) => e.col))].sort((a, b) => compareText(AUDIT_LISTS[a] || a, AUDIT_LISTS[b] || b));
  keep(els.list, `<option value="">All</option>` + lists.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(AUDIT_LISTS[c] || c)}</option>`).join(""));
  const people = new Map();
  entries.forEach((e) => people.set(e.byUid, e.byName || e.byUid || "(unknown)"));
  keep(els.who, `<option value="">Everyone</option>` + [...people].sort((a, b) => compareText(a[1], b[1])).map(([id, n]) => `<option value="${escapeHtml(id)}">${escapeHtml(n)}</option>`).join(""));
}

function filtered() {
  const term = normalize(els.search.value);
  const from = els.from.value ? new Date(`${els.from.value}T00:00:00`) : null;
  const to = els.to.value ? new Date(`${els.to.value}T23:59:59.999`) : null;
  return entries.filter((e) => {
    const at = toDate(e.at);
    return (!els.list.value || e.col === els.list.value) &&
      (!els.action.value || e.action === els.action.value) &&
      (!els.who.value || e.byUid === els.who.value) &&
      (!from || (at && at >= from)) && (!to || (at && at <= to)) &&
      (!term || normalize(`${e.label} ${e.byName} ${AUDIT_LISTS[e.col] || e.col} ${JSON.stringify(e.before || {})} ${JSON.stringify(e.after || {})}`).includes(term));
  });
}

function render() {
  const rows = filtered();
  els.count.textContent = rows.length === entries.length ? entries.length : `${rows.length} of ${entries.length}`;
  els.loadedNote.textContent = entries.length
    ? `Showing the newest ${entries.length} change${entries.length === 1 ? "" : "s"}${reachedEnd ? " (all of them)" : ""}. Filters apply to the changes loaded.`
    : "";
  if (!entries.length) return tableMessage(els.tbody, 6, "No changes recorded yet. Changes made from now on appear here.");
  if (!rows.length) return tableMessage(els.tbody, 6, "No changes match these filters. Try Load older.");
  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows.map((e) => {
    const [label, cls] = ACTIONS[e.action] || [e.action, "badge-none"];
    const at = toDate(e.at);
    return `<tr>
      <td class="text-nowrap small">${at ? escapeHtml(formatDateTime(at)) : "—"}</td>
      <td><span class="fw-semibold">${escapeHtml(e.byName || "(unknown)")}</span>${e.byRole ? `<div class="small text-secondary text-capitalize">${escapeHtml(e.byRole)}</div>` : ""}</td>
      <td><span class="badge ${cls}">${escapeHtml(label)}</span></td>
      <td><div class="small text-secondary">${escapeHtml(AUDIT_LISTS[e.col] || e.col)}</div>${escapeHtml(e.label || e.docId || "")}</td>
      <td class="small">${changeSummary(e)}</td>
      <td class="text-end"><button type="button" class="btn btn-sm btn-outline-secondary" data-view="${escapeHtml(e.id)}"><i class="bi bi-eye me-1"></i>View</button></td>
    </tr>`;
  }).join("");
}

// ---------- Old and new values ----------
function openEntry(id) {
  const e = entries.find((x) => x.id === id);
  if (!e) return;
  const [label, cls] = ACTIONS[e.action] || [e.action, "badge-none"];
  const at = toDate(e.at);
  els.modalTitle.innerHTML = `<span class="badge ${cls} me-2">${escapeHtml(label)}</span>${escapeHtml(AUDIT_LISTS[e.col] || e.col)}`;
  const keys = [...new Set([...Object.keys(e.before || {}), ...Object.keys(e.after || {})])].sort((a, b) => compareText(fieldName(a), fieldName(b)));
  const showOld = e.action === "update" || e.action === "delete";
  const showNew = e.action !== "delete";
  els.modalBody.innerHTML = `
    <dl class="request-facts mb-3">
      <div><dt>Record</dt><dd>${escapeHtml(e.label || e.docId || "—")}</dd></div>
      <div><dt>When</dt><dd>${at ? escapeHtml(formatDateTime(at)) : "—"}</dd></div>
      <div><dt>Who</dt><dd>${escapeHtml(e.byName || "(unknown)")}${e.byRole ? ` <span class="text-secondary text-capitalize">(${escapeHtml(e.byRole)})</span>` : ""}</dd></div>
    </dl>
    ${e.action === "save" ? `<p class="small text-secondary">This account couldn't read the record before saving, so only the new values are known.</p>` : ""}
    ${keys.length ? `<div class="table-responsive"><table class="table table-sm align-middle mb-0">
      <thead><tr><th>Field</th>${showOld ? "<th>Old value</th>" : ""}${showNew ? "<th>New value</th>" : ""}</tr></thead>
      <tbody>${keys.map((k) => `<tr>
        <td class="fw-semibold small">${escapeHtml(fieldName(k))}</td>
        ${showOld ? `<td class="small${e.action === "update" ? " audit-old" : ""}">${showValue((e.before || {})[k])}</td>` : ""}
        ${showNew ? `<td class="small${e.action === "update" ? " audit-new" : ""}">${showValue((e.after || {})[k])}</td>` : ""}
      </tr>`).join("")}</tbody></table></div>` : `<p class="text-secondary mb-0">No field details.</p>`}`;
  modal.show();
}

// ---------- Deleting old entries ----------
async function deleteOld() {
  const days = Number(els.delOlder.value);
  const what = days ? `older than ${els.delOlder.options[els.delOlder.selectedIndex].text.replace("older than ", "")}` : "in the audit trail";
  const ok = await confirmDialog({
    title: "Delete audit trail entries?",
    message: `All entries ${what} will be deleted for good. A note that you deleted them is kept.`,
    confirmText: "Delete entries",
  });
  if (!ok) return;
  setBusy(els.btnDelete, true, "Deleting…");
  try {
    const n = await deleteAuditOlderThan(days);
    toast(n ? `${n} entr${n === 1 ? "y" : "ies"} deleted.` : "Nothing to delete.");
    await loadPage();
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnDelete, false);
  }
}

async function init() {
  modal = new bootstrap.Modal(document.getElementById("auditModal"));
  [els.list, els.action, els.who, els.from, els.to].forEach((el) => el.addEventListener("change", render));
  els.search.addEventListener("input", render);
  els.btnMore.addEventListener("click", () => loadPage(true));
  els.btnDelete.addEventListener("click", deleteOld);
  els.tbody.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-view]");
    if (b) openEntry(b.dataset.view);
  });
  const o = await getOptions();
  const keep = Number(o.auditKeepDays) || 0;
  els.keepNote.textContent = keep ? `Entries older than ${keep} days are deleted automatically.` : "Entries are kept until you delete them.";
  await loadPage();
}

initLayout("audit").then((user) => { if (user) init(); });
