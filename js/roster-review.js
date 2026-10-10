// ==========================================================
// roster-review.js — Notifications → "Class list requests" (registrar and admin only):
// approve or decline each line of a teacher's class list request (see roster-requests.js).
// Approving reads the class again and makes the change at once, in the same audited save as
// the decision; a line that no longer fits is marked "could not be made" with the reason. A move to
// a section with no class of the subject yet waits (Approve is off) until that class is created.
// The teacher gets a notification once every line is decided.
// ==========================================================

import { db, collection, doc, getDoc, getDocs, query, where, serverTimestamp, onSnapshot } from "./firebase-config.js";
import { toast, escapeHtml, setBusy, errorMessage, commitOperations, timeAgo, toDate } from "./app.js";
import { yearTermText } from "./terms.js";
import { planApprove, requestStatus, decisionCounts, findTarget, describe } from "./roster-requests.js";

const els = {
  tab: document.getElementById("tabRosterItem"),
  count: document.getElementById("countRoster"),
  filter: document.getElementById("rosterFilter"),
  list: document.getElementById("rosterList"),
};

let me = null;
let requests = [];
let classes = null; // every grading assignment (to show where a move goes), or null while loading
let busy = false;

const DECISION = {
  pending: ["Waiting", "text-bg-warning"], approved: ["Approved", "badge-pass"],
  declined: ["Declined", "badge-fail"], skipped: ["Could not be made", "badge-none"],
};
const STATUS = { draft: "Draft", submitted: "Waiting for decision", done: "Decided", withdrawn: "Withdrawn" };
const who = () => me.displayName || me.username || "";
const time = (r) => toDate(r.submittedAt || r.updatedAt || r.createdAt)?.getTime() ?? 0;

function render() {
  // Keep notes being typed when the list is redrawn
  const notes = new Map([...els.list.querySelectorAll("[data-roster-req]")].map((b) => [b.dataset.rosterReq, b.querySelector("[data-roster-note]")?.value || ""]));
  draw();
  notes.forEach((v, id) => { const el = els.list.querySelector(`[data-roster-req="${CSS.escape(id)}"] [data-roster-note]`); if (el && v) el.value = v; });
}

function draw() {
  const waiting = requests.filter((r) => r.status === "submitted");
  const lines = waiting.reduce((n, r) => n + (r.items || []).filter((x) => x.decision === "pending").length, 0);
  els.count.textContent = lines;
  els.count.classList.toggle("d-none", !lines);
  const status = els.filter.value;
  const list = requests.filter((r) => r.status !== "draft" && (!status || r.status === status))
    .sort((a, b) => (status === "submitted" ? time(a) - time(b) : time(b) - time(a)));
  if (!list.length) {
    els.list.innerHTML = `<div class="empty-state">${status === "submitted" ? "No class list request is waiting for a decision." : "No requests to show."}</div>`;
    return;
  }
  els.list.innerHTML = list.map((r) => {
    const open = r.status === "submitted";
    const pending = (r.items || []).filter((x) => x.decision === "pending").length;
    return `<div class="border-top px-3 py-3" data-roster-req="${escapeHtml(r.id)}">
      <div class="d-flex flex-wrap align-items-baseline gap-2 mb-2">
        <strong>${escapeHtml(r.subjectCode || r.subjectName)}, ${escapeHtml(r.sectionName)}</strong>
        <span class="text-secondary small">${escapeHtml(yearTermText(r.schoolYear, r.term))} · ${escapeHtml(r.teacherName || r.requestedByName || "")} · ${escapeHtml(timeAgo(r.submittedAt || r.updatedAt))}</span>
        <span class="badge ${open ? "text-bg-warning" : "badge-none"} ms-auto">${escapeHtml(STATUS[r.status] || r.status)}</span>
      </div>
      <div class="table-responsive"><table class="table table-sm table-registry mb-2">
        <thead><tr><th>Change</th><th>Reason</th><th>Decision</th><th class="text-end"></th></tr></thead>
        <tbody>${(r.items || []).map((x) => {
          const [label, cls] = DECISION[x.decision] || DECISION.pending;
          const can = open && x.decision === "pending";
          // Where a move goes now: the picked class, or this subject's class in the picked section
          const own = (classes || []).find((a) => a.id === r.assignmentId) || r;
          const target = x.type === "move" && classes ? findTarget(x, own, classes) : null;
          const waits = can && x.type === "move" && classes && !target;
          const subject = r.subjectCode || r.subjectName || "this subject";
          return `<tr>
            <td>${escapeHtml(describe(x, r, target))}<div class="small text-secondary">${escapeHtml(x.studentNumber || "")}</div>${x.draftGrade ? `<div class="small text-secondary">Draft grade ${escapeHtml(x.draftGrade)} is deleted when approved.</div>` : ""}
              ${waits ? `<div class="small text-danger">No ${escapeHtml(subject)} class in ${escapeHtml(x.toSectionName || "that section")} yet. <a href="assignments.html">Create it in Grading assignments</a>, then approve.</div>` : ""}</td>
            <td class="small">${escapeHtml(x.reason || "")}</td>
            <td><span class="badge ${cls}">${label}</span>${x.decidedByName ? `<div class="small text-secondary">by ${escapeHtml(x.decidedByName)}</div>` : ""}${x.note ? `<div class="small text-secondary">“${escapeHtml(x.note)}”</div>` : ""}</td>
            <td class="text-end text-nowrap">${can ? `<button type="button" class="btn btn-sm btn-primary py-0" data-roster-approve="${escapeHtml(x.id)}"${waits ? ` disabled title="Create the class first"` : ""}>Approve</button>
              <button type="button" class="btn btn-sm btn-outline-danger py-0 ms-1" data-roster-decline="${escapeHtml(x.id)}">Decline</button>` : ""}</td>
          </tr>`;
        }).join("")}</tbody>
      </table></div>
      ${open ? `<div class="d-flex flex-wrap align-items-end gap-2">
        <div class="flex-grow-1"><label class="form-label small mb-1" for="rn-${escapeHtml(r.id)}">Note to the teacher <span class="text-secondary">(required to decline)</span></label>
          <input type="text" class="form-control form-control-sm" id="rn-${escapeHtml(r.id)}" data-roster-note maxlength="500"></div>
        ${pending > 1 ? `<button type="button" class="btn btn-sm btn-primary" data-roster-approve-all>Approve all (${pending})</button>` : ""}
      </div>` : ""}
    </div>`;
  }).join("");
}

/** Reads the class, the move target, the subject's classes and the student's grades as they are now. */
async function readNow(r, item) {
  const a = await getDoc(doc(db, "gradingAssignments", r.assignmentId));
  if (!a.exists()) return null;
  const assignment = { id: a.id, ...a.data() };
  const [classes, grades] = await Promise.all([
    getDocs(query(collection(db, "gradingAssignments"), where("subjectId", "==", assignment.subjectId), where("schoolYear", "==", assignment.schoolYear))),
    getDocs(query(collection(db, "grades"), where("assignmentId", "==", assignment.id), where("studentId", "==", item.studentId))),
  ]);
  const assignments = classes.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { assignment, assignments: assignments.some((x) => x.id === assignment.id) ? assignments : [assignment, ...assignments], grades: grades.docs.map((d) => ({ id: d.id, ...d.data() })) };
}

/** Decides lines one by one; each save re-reads the request and the class first. */
async function decide(reqId, itemIds, approve, note) {
  let made = 0, skipped = 0, declined = 0, waiting = 0;
  for (const itemId of itemIds) {
    const snap = await getDoc(doc(db, "rosterRequests", reqId));
    if (!snap.exists()) throw new Error("This request no longer exists.");
    const r = { id: snap.id, ...snap.data() };
    const item = (r.items || []).find((x) => x.id === itemId);
    if (r.status !== "submitted" || !item || item.decision !== "pending") continue; // decided meanwhile
    const ops = [];
    let decision = "declined";
    let lineNote = note;
    if (approve) {
      const now = await readNow(r, item);
      const plan = now ? planApprove(item, now) : { result: "skip", note: "The class was deleted.", ops: [] };
      if (plan.result === "wait") { waiting++; continue; } // no class there yet: the line stays waiting
      decision = plan.result === "apply" ? "approved" : "skipped";
      lineNote = plan.result === "apply" ? note : plan.note;
      plan.ops.forEach((op) => {
        const [col, id] = op.path.split("/");
        ops.push({ type: op.type, ref: doc(db, col, id), data: op.type === "update" ? { ...op.data, updatedAt: serverTimestamp() } : op.data });
      });
      decision === "approved" ? made++ : skipped++;
    } else declined++;
    const items = r.items.map((x) => (x.id === itemId ? { ...x, decision, note: lineNote || "", decidedBy: me.uid, decidedByName: who(), decidedAt: new Date().toISOString() } : x));
    const status = requestStatus(items);
    ops.push({ type: "update", ref: doc(db, "rosterRequests", r.id), data: { items, status, reviewStarted: true, updatedAt: serverTimestamp(), ...(status === "done" ? { doneAt: serverTimestamp() } : {}) } });
    if (status === "done") {
      ops.push({
        type: "set",
        ref: doc(collection(db, "notifications")),
        data: {
          toUid: r.requestedBy, fromUid: me.uid, fromName: who(), type: "roster_request_done",
          title: "Class list request decided",
          message: `${who()} decided your class list request for ${r.subjectCode}, ${r.sectionName}: ${decisionCounts(items)}.`,
          rosterRequestId: r.id, read: false, createdAt: serverTimestamp(),
        },
      });
    }
    await commitOperations(ops);
  }
  return { made, skipped, declined, waiting };
}

async function onClick(e) {
  const box = e.target.closest("[data-roster-req]");
  if (!box || busy) return;
  const btn = e.target.closest("[data-roster-approve], [data-roster-decline], [data-roster-approve-all]");
  if (!btn) return;
  const reqId = box.dataset.rosterReq;
  const r = requests.find((x) => x.id === reqId);
  const noteEl = box.querySelector("[data-roster-note]");
  const note = noteEl ? noteEl.value.trim() : "";
  const approve = !btn.hasAttribute("data-roster-decline");
  if (!approve && note.length < 5) {
    noteEl.classList.add("is-invalid");
    noteEl.focus();
    toast("Tell the teacher why the change is declined (at least 5 characters).", "warning");
    return;
  }
  const ids = btn.hasAttribute("data-roster-approve-all")
    ? (r.items || []).filter((x) => x.decision === "pending").map((x) => x.id)
    : [btn.dataset.rosterApprove || btn.dataset.rosterDecline];
  busy = true;
  setBusy(btn, true, approve ? "Approving…" : "Declining…");
  try {
    const { made, skipped, declined, waiting } = await decide(reqId, ids, approve, note);
    const parts = [made && `${made} change${made === 1 ? "" : "s"} made`, skipped && `${skipped} could not be made (see the note)`,
      waiting && `${waiting} still waiting for a class to be created`, declined && "declined; the teacher will be notified"].filter(Boolean);
    toast(parts.length ? parts.join(", ") + "." : "Already decided.", skipped || waiting ? "warning" : "success");
  } catch (err) {
    toast(errorMessage(err), "danger");
  } finally {
    busy = false;
    setBusy(btn, false);
  }
}

/** Shows the tab and listens for requests (registrar and admin only). */
export function initRosterReview(profile) {
  if (!els.tab || !["admin", "registrar"].includes(profile.role)) return;
  me = profile;
  els.tab.classList.remove("d-none");
  els.filter.addEventListener("change", render);
  els.list.addEventListener("click", onClick);
  els.list.addEventListener("input", (e) => e.target.classList.remove("is-invalid"));
  onSnapshot(
    collection(db, "rosterRequests"),
    (snap) => { requests = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    (err) => { els.list.innerHTML = `<div class="empty-state text-danger">${escapeHtml(errorMessage(err))}</div>`; }
  );
  // Every class, so a move shows the class it goes to (and waits while there is none)
  onSnapshot(
    collection(db, "gradingAssignments"),
    (snap) => { classes = snap.docs.map((d) => ({ id: d.id, ...d.data() })); render(); },
    (err) => console.warn("Classes:", err.code || err)
  );
  if (new URLSearchParams(location.search).get("tab") === "roster") bootstrap.Tab.getOrCreateInstance(document.getElementById("tab-roster")).show();
}
