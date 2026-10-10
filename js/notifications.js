// ==========================================================
// notifications.js — Notification inbox and grade change approvals
//
// Collections:
//   notifications/{id}        { toUid, fromUid, fromName, type, title, message, requestId, read, createdAt }
//   gradeChangeRequests/{id}  { gradeId, student…, subject…, oldGrade, newGrade, reason, status, … }
//
// Flow: teacher sends a request (grading.js) → approvers get a notification
// → an approver accepts (grade is updated) or declines → requester is notified.
// ==========================================================

import {
  db, collection, doc, getDoc, getDocs, query, where, serverTimestamp,
} from "./firebase-config.js";
import { onSnapshot } from "./firebase-config.js";
import { remarksClass } from "./grading-scale.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, setBusy, errorMessage, commitOperations,
  clearErrors, fieldError, tableMessage, timeAgo, formatDateTime, formatGrade, toDate,
} from "./app.js";
import { initRosterReview } from "./roster-review.js";

const els = {
  btnMarkAll: document.getElementById("btnMarkAll"),
  countInbox: document.getElementById("countInbox"),
  countApprovals: document.getElementById("countApprovals"),
  tabApprovalsItem: document.getElementById("tabApprovalsItem"),
  tabMineItem: document.getElementById("tabMineItem"),
  inboxList: document.getElementById("inboxList"),
  approvalFilter: document.getElementById("approvalFilter"),
  approvalBody: document.getElementById("approvalBody"),
  mineBody: document.getElementById("mineBody"),
  modalEl: document.getElementById("decisionModal"),
  title: document.getElementById("decisionTitle"),
  body: document.getElementById("decisionBody"),
  error: document.getElementById("decisionError"),
  noteWrap: document.getElementById("decisionNoteWrap"),
  note: document.getElementById("decisionNote"),
  btnAccept: document.getElementById("btnAccept"),
  btnDecline: document.getElementById("btnDecline"),
};

let me = null;
let notifications = [];
let requests = new Map(); // id -> request (approver view: all; teacher view: their own)
let myRequests = [];
let modal;
let openRequestId = null;

const STATUS = {
  pending: { label: "Waiting for decision", cls: "text-bg-warning" },
  approved: { label: "Approved", cls: "badge-pass" },
  declined: { label: "Declined", cls: "badge-fail" },
  cancelled: { label: "Cancelled", cls: "badge-none" },
};
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.cls || "badge-none"}">${STATUS[s]?.label || escapeHtml(s)}</span>`;
const byNewest = (field) => (a, b) => (toDate(b[field])?.getTime() ?? Date.now()) - (toDate(a[field])?.getTime() ?? Date.now());
const isApprover = () => me.canApprove === true;

const NOTIF_ICON = {
  grade_change_request: { icon: "bi-hourglass-split", color: "#6e5810" },
  grade_change_approved: { icon: "bi-check-circle", color: "var(--green)" },
  grade_change_declined: { icon: "bi-x-circle", color: "var(--maroon)" },
  grade_reminder: { icon: "bi-alarm", color: "var(--maroon)" },
  roster_request_done: { icon: "bi-people", color: "var(--green)" },
};

function gradeChange(r) {
  return `<span class="text-nowrap">${formatGrade(r.oldGrade, r.oldRemarks)} <i class="bi bi-arrow-right mx-1 text-secondary"></i><strong>${formatGrade(r.newGrade, r.newRemarks)}</strong></span>`;
}

// ---------- Inbox ----------
function watchInbox() {
  onSnapshot(
    query(collection(db, "notifications"), where("toUid", "==", me.uid)),
    (snap) => {
      notifications = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest("createdAt"));
      renderInbox();
    },
    (err) => {
      els.inboxList.innerHTML = `<div class="empty-state text-danger">${escapeHtml(errorMessage(err))}</div>`;
    }
  );
}

function renderInbox() {
  const unread = notifications.filter((n) => !n.read).length;
  els.countInbox.textContent = unread;
  els.countInbox.classList.toggle("d-none", unread === 0);
  els.btnMarkAll.disabled = unread === 0;

  if (!notifications.length) {
    els.inboxList.innerHTML = `<div class="empty-state">No notifications yet. Updates about grade change requests will appear here.</div>`;
    return;
  }
  els.inboxList.innerHTML = notifications
    .map((n) => {
      const ic = NOTIF_ICON[n.type] || { icon: "bi-bell", color: "var(--ink-soft)" };
      const req = n.requestId ? requests.get(n.requestId) : null;
      const live = req && n.type === "grade_change_request" && req.status !== "pending" ? ` ${statusBadge(req.status)}` : "";
      return `
      <button type="button" class="list-group-item list-group-item-action notif-item${n.read ? "" : " unread"}" data-notif="${n.id}">
        <span class="notif-icon" style="color:${ic.color}"><i class="bi ${ic.icon}"></i></span>
        <span class="flex-grow-1 tw-min-w-0">
          <span class="d-flex justify-content-between gap-2">
            <span class="notif-title">${escapeHtml(n.title)}${live}</span>
            <span class="small text-secondary text-nowrap">${escapeHtml(timeAgo(n.createdAt))}</span>
          </span>
          <span class="d-block small text-secondary">${escapeHtml(n.message)}</span>
        </span>
        ${n.read ? "" : '<span class="unread-dot" aria-label="Unread"></span>'}
      </button>`;
    })
    .join("");
}

async function markRead(ids) {
  if (!ids.length) return;
  await commitOperations(ids.map((id) => ({ type: "update", ref: doc(db, "notifications", id), data: { read: true, readAt: serverTimestamp() } })));
}

async function markAllRead() {
  setBusy(els.btnMarkAll, true, "Marking…");
  try {
    await markRead(notifications.filter((n) => !n.read).map((n) => n.id));
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    setBusy(els.btnMarkAll, false);
  }
}

async function onInboxClick(e) {
  const item = e.target.closest("[data-notif]");
  if (!item) return;
  const n = notifications.find((x) => x.id === item.dataset.notif);
  if (!n) return;
  if (!n.read) markRead([n.id]).catch((err) => console.warn(err));
  if (n.requestId) openDecision(n.requestId);
}

// ---------- Approvals (approvers) ----------
function watchAllRequests() {
  onSnapshot(
    collection(db, "gradeChangeRequests"),
    (snap) => {
      requests = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      renderApprovals();
      renderInbox();
      if (openRequestId && els.modalEl.classList.contains("show")) renderDecision(requests.get(openRequestId));
    },
    (err) => tableMessage(els.approvalBody, 7, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`)
  );
}

function renderApprovals() {
  const all = [...requests.values()];
  const pending = all.filter((r) => r.status === "pending" && r.requestedBy !== me.uid).length;
  els.countApprovals.textContent = pending;
  els.countApprovals.classList.toggle("d-none", pending === 0);

  const status = els.approvalFilter.value;
  const list = all.filter((r) => !status || r.status === status).sort(byNewest("requestedAt"));
  if (!list.length) {
    tableMessage(els.approvalBody, 7, status === "pending" ? "Nothing is waiting for your approval." : "No requests to show.");
    return;
  }
  els.approvalBody.innerHTML = list
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.studentName)}<div class="small text-secondary">${escapeHtml(r.studentNumber)}</div></td>
        <td><span class="code-cell">${escapeHtml(r.subjectCode)}</span><div class="small text-secondary">${escapeHtml(r.sectionName)}, ${escapeHtml(r.schoolYear)}</div></td>
        <td>${escapeHtml(r.requestedByName)}<div class="small text-secondary">${escapeHtml(timeAgo(r.requestedAt))}</div></td>
        <td class="num">${gradeChange(r)}</td>
        <td class="reason-cell" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</td>
        <td>${statusBadge(r.status)}${r.decidedByName ? `<div class="small text-secondary">by ${escapeHtml(r.decidedByName)}</div>` : ""}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm ${r.status === "pending" && r.requestedBy !== me.uid ? "btn-primary" : "btn-outline-secondary"}" data-open="${r.id}">
            ${r.status === "pending" && r.requestedBy !== me.uid ? "Review" : "View"}
          </button>
        </td>
      </tr>`
    )
    .join("");
}

// ---------- My requests (teachers) ----------
function watchMyRequests() {
  if (!me.teacherDocId) {
    tableMessage(els.mineBody, 6, "Your account isn't linked to a teacher record.");
    return;
  }
  onSnapshot(
    query(collection(db, "gradeChangeRequests"), where("teacherDocId", "==", me.teacherDocId)),
    (snap) => {
      myRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byNewest("requestedAt"));
      if (!isApprover()) {
        myRequests.forEach((r) => requests.set(r.id, r));
        renderInbox();
      }
      renderMine();
      if (openRequestId && els.modalEl.classList.contains("show") && requests.has(openRequestId)) renderDecision(requests.get(openRequestId));
    },
    (err) => tableMessage(els.mineBody, 6, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`)
  );
}

function renderMine() {
  if (!myRequests.length) {
    tableMessage(els.mineBody, 6, `No requests yet. To change a submitted grade, open <a href="grading.html">Enter grades</a> and click <strong>Request change</strong>.`);
    return;
  }
  els.mineBody.innerHTML = myRequests
    .map(
      (r) => `
      <tr>
        <td>${escapeHtml(r.studentName)}<div class="small text-secondary">${escapeHtml(r.studentNumber)}</div></td>
        <td><span class="code-cell">${escapeHtml(r.subjectCode)}</span><div class="small text-secondary">${escapeHtml(r.sectionName)}</div></td>
        <td class="num">${gradeChange(r)}</td>
        <td class="reason-cell" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</td>
        <td>${statusBadge(r.status)}${r.decisionNote ? `<div class="small text-secondary reason-cell" title="${escapeHtml(r.decisionNote)}">“${escapeHtml(r.decisionNote)}”</div>` : ""}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-open="${r.id}">View</button>
          ${r.status === "pending" && r.requestedBy === me.uid ? `<button class="btn btn-sm btn-outline-danger ms-1" data-cancel="${r.id}">Cancel</button>` : ""}
        </td>
      </tr>`
    )
    .join("");
}

async function cancelRequest(id) {
  const r = requests.get(id) || myRequests.find((x) => x.id === id);
  if (!r) return;
  const ok = await confirmDialog({
    title: "Cancel this request?",
    message: `Your request to change ${r.studentName}'s ${r.subjectCode} grade to ${formatGrade(r.newGrade, r.newRemarks)} will be withdrawn.`,
    confirmText: "Cancel request",
  });
  if (!ok) return;
  try {
    await commitOperations([{ type: "update", ref: doc(db, "gradeChangeRequests", id), data: { status: "cancelled", decidedAt: serverTimestamp() } }]);
    toast("Request cancelled.");
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

// ---------- Decision dialog ----------
async function openDecision(id) {
  openRequestId = id;
  clearErrors(els.modalEl);
  els.error.classList.add("d-none");
  els.note.value = "";
  let r = requests.get(id);
  if (!r) {
    try {
      const snap = await getDoc(doc(db, "gradeChangeRequests", id));
      if (!snap.exists()) {
        toast("This request no longer exists. Its grading assignment may have been deleted.", "warning");
        return;
      }
      r = { id: snap.id, ...snap.data() };
    } catch (err) {
      toast(errorMessage(err), "danger");
      return;
    }
  }
  renderDecision(r);
  modal.show();
}

function renderDecision(r) {
  if (!r) return;
  const canDecide = isApprover() && r.status === "pending" && r.requestedBy !== me.uid;
  els.title.textContent = canDecide ? "Review grade change" : "Grade change request";
  const facts = [
    ["Student", `${r.studentName} (${r.studentNumber})`],
    ["Subject", `${r.subjectCode ? `${r.subjectCode} - ` : ""}${r.subjectName}`],
    ["Section", `${r.sectionName}, ${r.yearLevel}, ${r.schoolYear}`],
    ["Teacher", r.teacherName],
    ["Requested by", `${r.requestedByName}, ${formatDateTime(r.requestedAt)}`],
  ];
  const remarks = (rem) => `<span class="badge ${remarksClass(rem)}">${rem}</span>`;

  els.body.innerHTML = `
    <div class="grade-change-box">
      <div>
        <div class="small text-secondary">Current grade</div>
        <div class="gc-value">${formatGrade(r.oldGrade, r.oldRemarks)}</div>${remarks(r.oldRemarks)}
      </div>
      <i class="bi bi-arrow-right gc-arrow" aria-hidden="true"></i>
      <div>
        <div class="small text-secondary">Requested grade</div>
        <div class="gc-value">${formatGrade(r.newGrade, r.newRemarks)}</div>${remarks(r.newRemarks)}
      </div>
      <div class="ms-auto text-end">${statusBadge(r.status)}</div>
    </div>
    <div class="mt-3">
      <div class="small fw-semibold text-secondary mb-1">Reason</div>
      <div class="reason-box">${escapeHtml(r.reason)}</div>
    </div>
    <dl class="request-facts mt-3 mb-0">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapeHtml(v)}</dd></div>`).join("")}</dl>
    ${r.status !== "pending" && r.status !== "cancelled" ? `
      <div class="decision-box mt-3 ${r.status}">
        <strong>${r.status === "approved" ? "Approved" : "Declined"}</strong> by ${escapeHtml(r.decidedByName || "—")}, ${escapeHtml(formatDateTime(r.decidedAt))}
        ${r.decisionNote ? `<div class="mt-1">“${escapeHtml(r.decisionNote)}”</div>` : ""}
      </div>` : ""}
    ${r.status === "cancelled" ? `<div class="decision-box mt-3">Cancelled by the teacher.</div>` : ""}
    ${isApprover() && r.status === "pending" && r.requestedBy === me.uid ? `<div class="small text-secondary mt-3">You sent this request, so another approver must decide it.</div>` : ""}`;

  els.noteWrap.classList.toggle("d-none", !canDecide);
  els.btnAccept.classList.toggle("d-none", !canDecide);
  els.btnDecline.classList.toggle("d-none", !canDecide);
}

async function decide(approve) {
  const r = requests.get(openRequestId);
  if (!r || r.status !== "pending") {
    toast("This request was already decided.", "info");
    return;
  }
  clearErrors(els.modalEl);
  els.error.classList.add("d-none");
  const note = els.note.value.trim();
  if (!approve && note.length < 5) {
    fieldError(els.note, "Tell the teacher why the change is declined (at least 5 characters).");
    els.note.focus();
    return;
  }

  const btn = approve ? els.btnAccept : els.btnDecline;
  setBusy(btn, true, approve ? "Accepting…" : "Declining…");
  els.btnAccept.disabled = els.btnDecline.disabled = true;
  try {
    const who = me.displayName || me.username;
    const ops = [
      {
        type: "update",
        ref: doc(db, "gradeChangeRequests", r.id),
        data: {
          status: approve ? "approved" : "declined",
          decidedBy: me.uid,
          decidedByName: who,
          decidedAt: serverTimestamp(),
          decisionNote: note,
        },
      },
    ];
    if (approve) {
      // The security rules check this update against the approved request
      ops.push({
        type: "update",
        ref: doc(db, "grades", r.gradeId),
        data: {
          finalGrade: r.newGrade,
          remarks: r.newRemarks,
          lastChangeRequestId: r.id,
          lastChangedByName: who,
          updatedAt: serverTimestamp(),
        },
      });
    }
    ops.push({
      type: "set",
      ref: doc(collection(db, "notifications")),
      data: {
        toUid: r.requestedBy,
        fromUid: me.uid,
        fromName: who,
        type: approve ? "grade_change_approved" : "grade_change_declined",
        title: approve ? "Grade change approved" : "Grade change declined",
        message: approve
          ? `${who} approved changing ${r.studentName}'s ${r.subjectCode} grade from ${formatGrade(r.oldGrade, r.oldRemarks)} to ${formatGrade(r.newGrade, r.newRemarks)}.`
          : `${who} declined changing ${r.studentName}'s ${r.subjectCode} grade to ${formatGrade(r.newGrade, r.newRemarks)}.${note ? ` Note: ${note}` : ""}`,
        requestId: r.id,
        read: false,
        createdAt: serverTimestamp(),
      },
    });
    // My own notifications about this request are now handled
    notifications
      .filter((n) => n.requestId === r.id && !n.read)
      .forEach((n) => ops.push({ type: "update", ref: doc(db, "notifications", n.id), data: { read: true, readAt: serverTimestamp() } }));

    await commitOperations(ops);
    modal.hide();
    toast(approve ? `Approved. ${r.studentName}'s grade is now ${formatGrade(r.newGrade, r.newRemarks)}.` : "Request declined. The teacher has been notified.");
  } catch (err) {
    els.error.textContent =
      err.code === "not-found"
        ? "The grade this request refers to no longer exists, so it can't be changed."
        : errorMessage(err);
    els.error.classList.remove("d-none");
  } finally {
    setBusy(btn, false);
    els.btnAccept.disabled = els.btnDecline.disabled = false;
  }
}

// ---------- Wire up ----------
function init(profile) {
  me = profile;
  modal = new bootstrap.Modal(els.modalEl);
  els.modalEl.addEventListener("hidden.bs.modal", () => (openRequestId = null));

  if (isApprover()) {
    els.tabApprovalsItem.classList.remove("d-none");
    watchAllRequests();
  }
  if (me.role === "teacher") {
    els.tabMineItem.classList.remove("d-none");
    watchMyRequests();
  }
  initRosterReview(me);
  watchInbox();

  els.btnMarkAll.addEventListener("click", markAllRead);
  els.inboxList.addEventListener("click", onInboxClick);
  els.approvalFilter.addEventListener("change", renderApprovals);
  document.addEventListener("click", (e) => {
    const open = e.target.closest("[data-open]");
    const cancel = e.target.closest("[data-cancel]");
    if (open) openDecision(open.dataset.open);
    if (cancel) cancelRequest(cancel.dataset.cancel);
  });
  els.btnAccept.addEventListener("click", () => decide(true));
  els.btnDecline.addEventListener("click", () => {
    if (els.note.value.trim().length < 5) {
      fieldError(els.note, "Tell the teacher why the change is declined (at least 5 characters).");
      els.note.focus();
      return;
    }
    decide(false);
  });

  // Deep links: notifications.html?request=ID or ?tab=approvals
  const params = new URLSearchParams(location.search);
  if (params.get("tab") === "approvals" && isApprover()) bootstrap.Tab.getOrCreateInstance(document.getElementById("tab-approvals")).show();
  if (params.get("request")) openDecision(params.get("request"));
}

initLayout("notifications").then((user) => {
  if (user) init(user);
  else els.inboxList.innerHTML = `<div class="empty-state">Connect Firebase and sign in to see notifications.</div>`;
});
