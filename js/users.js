// ==========================================================
// users.js — User accounts and roles (admin only)
// Collections: users/{uid}, usernames/{username}
//
// New sign-in accounts are created through a second Firebase app
// instance, so the administrator stays signed in.
// ==========================================================

import { createLogin } from "./accounts.js";
import {
  db, app, collection, doc, getDoc, getDocs, serverTimestamp, onSnapshot,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy, compareText,
  tableLoading, tableMessage, errorMessage, clearErrors, fieldError, commitOperations,
  ROLES, USERNAME_PATTERN, cleanUsername, usernameEmail, passwordProblem, authErrorMessage,
  isOnline, timeAgo, toDate, searchPicker,
} from "./app.js";

const els = {
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  filterRole: document.getElementById("filterRole"),
  roleGuide: document.getElementById("roleGuide"),
  btnAdd: document.getElementById("btnAdd"),
  modalEl: document.getElementById("formModal"),
  modalTitle: document.getElementById("formModalTitle"),
  form: document.getElementById("form"),
  formError: document.getElementById("formError"),
  username: document.getElementById("username"),
  displayName: document.getElementById("displayName"),
  role: document.getElementById("role"),
  teacherWrap: document.getElementById("teacherLinkWrap"),
  teacher: document.getElementById("teacherLink"),
  passwordFields: document.getElementById("passwordFields"),
  password: document.getElementById("password"),
  passwordConfirm: document.getElementById("passwordConfirm"),
  active: document.getElementById("active"),
  canApprove: document.getElementById("canApprove"),
  btnSave: document.getElementById("btnSave"),
  resetModalEl: document.getElementById("resetModal"),
  resetForm: document.getElementById("resetForm"),
  resetFor: document.getElementById("resetFor"),
  resetError: document.getElementById("resetError"),
  resetPassword: document.getElementById("resetPassword"),
  resetConfirm: document.getElementById("resetConfirm"),
  btnReset: document.getElementById("btnReset"),
  onlineList: document.getElementById("onlineList"),
  onlineCount: document.getElementById("onlineCount"),
};
const COLS = 7;

let me = null;
let users = [];
let teachers = [];
let editing = null;
let resetting = null;
let modal, resetModal;

// ---------- Load ----------
// Users are watched live, so "Online now" and "Last active" stay current
let stopUsers = null;
let usersReady = null;
let teachersLoaded = false;

// Live updates don't redraw the table while one of its menus is open (that would close it)
function refresh() {
  if (!teachersLoaded) return;
  renderGuide();
  if (els.tbody.querySelector(".dropdown-menu.show")) renderOnline();
  else render();
}

function watchUsers() {
  if (stopUsers) return usersReady;
  usersReady = new Promise((resolve) => {
    stopUsers = onSnapshot(collection(db, "users"), (snap) => {
      users = snap.docs.map((d) => ({ uid: d.id, ...d.data() })).sort((a, b) => compareText(a.username, b.username));
      refresh();
      resolve();
    }, (err) => {
      tableMessage(els.tbody, COLS, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
      els.onlineList.innerHTML = `<span class="small text-secondary">Unavailable.</span>`;
      resolve();
    });
  });
  return usersReady;
}

/**
 * Keeps each teacher record's userUid = the active teacher account linked to it, so the
 * registrar's grade tracker can send that teacher a reminder (the registrar can't read
 * user accounts). Writes only the teachers that differ.
 */
async function syncTeacherLinks() {
  const want = new Map();
  users.forEach((u) => {
    if (u.role === "teacher" && u.teacherDocId && u.active !== false) want.set(u.teacherDocId, u.uid);
  });
  const ops = teachers
    .filter((t) => (t.userUid || null) !== (want.get(t.id) || null))
    .map((t) => ({ type: "update", ref: doc(db, "teachers", t.id), data: { userUid: want.get(t.id) || null } }));
  if (!ops.length) return;
  await commitOperations(ops);
  teachers.forEach((t) => { t.userUid = want.get(t.id) || null; });
}

async function loadAll() {
  if (!users.length) tableLoading(els.tbody, COLS);
  try {
    const tSnap = await getDocs(collection(db, "teachers"));
    teachers = tSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => compareText(a.teacherName, b.teacherName));
    teachersLoaded = true;
    await watchUsers();
    renderGuide();
    render();
    syncTeacherLinks().catch((err) => console.warn("Teacher links:", err.code || err));
  } catch (err) {
    tableMessage(els.tbody, COLS, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

// ---------- Who is online ----------
function lastActive(u) {
  if (isOnline(u)) {
    const where = u.lastSeen.page ? ` · ${escapeHtml(u.lastSeen.page)}` : "";
    return `<span class="online-badge"><span class="online-dot" aria-hidden="true"></span>Online</span><div class="small text-secondary">${escapeHtml(u.lastSeen.device || "")}${where}</div>`;
  }
  const at = u.lastSeen ? toDate(u.lastSeen.at) : null;
  if (!at) return `<span class="small text-secondary">No activity yet</span>`;
  return `<span class="small" title="${escapeHtml(at.toLocaleString())}">${escapeHtml(timeAgo(at))}</span>${u.lastSeen.signedOut ? '<div class="small text-secondary">Signed out</div>' : ""}`;
}

function renderOnline() {
  const online = users.filter((u) => u.active !== false && isOnline(u))
    .sort((a, b) => compareText(a.displayName || a.username, b.displayName || b.username));
  els.onlineCount.textContent = online.length;
  els.onlineList.innerHTML = online.length
    ? online.map((u) => `
        <div class="online-person">
          <span class="online-dot" aria-hidden="true"></span>
          <span class="fw-semibold">${escapeHtml(u.displayName || u.username)}</span>
          <span class="badge badge-role-${escapeHtml(u.role)}">${escapeHtml(ROLES[u.role]?.label || u.role)}</span>
          ${u.uid === me.uid ? '<span class="badge badge-count">You</span>' : ""}
          <span class="small text-secondary">${escapeHtml(u.lastSeen.page || "")}${u.lastSeen.device ? ` · ${escapeHtml(u.lastSeen.device)}` : ""}</span>
        </div>`).join("")
    : `<span class="small text-secondary">No one else is using the system right now.</span>`;
}

function renderGuide() {
  const approvers = users.filter((u) => u.canApprove && u.active !== false).length;
  els.roleGuide.innerHTML = Object.entries(ROLES)
    .map(([key, r]) => {
      const n = users.filter((u) => u.role === key).length;
      return `
      <div class="col-md-4">
        <div class="role-card">
          <div class="d-flex justify-content-between align-items-center mb-1">
            <span class="badge badge-role-${key}">${r.label}</span>
            <span class="small fw-semibold">${n} user${n === 1 ? "" : "s"}</span>
          </div>
          <div class="small">${r.description}</div>
        </div>
      </div>`;
    })
    .join("") + `
      <div class="col-12">
        <div class="role-card d-flex flex-wrap align-items-center gap-2">
          <span class="badge badge-approver"><i class="bi bi-patch-check me-1"></i>Approver</span>
          <span class="small">${approvers
            ? `${approvers} active user${approvers === 1 ? " receives" : "s receive"} teachers' grade change requests. Turn on <strong>Can approve grade changes</strong> when editing a user to add more.`
            : `<span style="color:var(--maroon)">No one can approve grade changes yet, so teachers can't send change requests. Edit a user and turn on <strong>Can approve grade changes</strong>.</span>`}</span>
        </div>
      </div>`;
}

function teacherName(id) {
  const t = teachers.find((x) => x.id === id);
  return t ? `${t.teacherName} (${t.teacherId})` : null;
}

function render() {
  renderOnline();
  const term = normalize(els.search.value);
  const role = els.filterRole.value;
  const rows = users.filter(
    (u) => (!role || u.role === role) && (!term || normalize(`${u.username} ${u.displayName}`).includes(term))
  );
  els.count.textContent = users.length;
  if (!rows.length) {
    tableMessage(els.tbody, COLS, "No users match your filters.");
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows
    .map((u) => {
      const isMe = u.uid === me.uid;
      const linked = u.role === "teacher"
        ? teacherName(u.teacherDocId) ?? `<span style="color:var(--maroon)">Not linked</span>`
        : `<span class="text-secondary">—</span>`;
      return `
      <tr class="${u.active === false ? "row-inactive" : ""}">
        <td class="code-cell">${escapeHtml(u.username)} ${isMe ? '<span class="badge badge-count ms-1">You</span>' : ""}</td>
        <td>${escapeHtml(u.displayName)}</td>
        <td><span class="badge badge-role-${escapeHtml(u.role)}">${escapeHtml(ROLES[u.role]?.label || u.role)}</span>${u.canApprove ? ' <span class="badge badge-approver" title="Receives grade change requests"><i class="bi bi-patch-check me-1"></i>Approver</span>' : ""}</td>
        <td>${u.role === "teacher" && teacherName(u.teacherDocId) ? escapeHtml(teacherName(u.teacherDocId)) : linked}</td>
        <td>${u.active === false ? '<span class="badge badge-fail">Disabled</span>' : '<span class="badge badge-pass">Active</span>'}</td>
        <td>${lastActive(u)}</td>
        <td class="text-end text-nowrap">
          <button class="btn btn-sm btn-outline-secondary" data-edit="${u.uid}"><i class="bi bi-pencil me-1"></i>Edit</button>
          <button class="btn btn-sm btn-outline-secondary ms-1" data-reset="${u.uid}" ${isMe ? 'disabled title="Use Password in the sidebar to change your own password"' : ""}><i class="bi bi-key me-1"></i>Reset password</button>
          <button class="btn btn-sm btn-outline-danger ms-1" data-delete="${u.uid}" ${isMe ? 'disabled title="You can\'t delete your own account"' : ""}><i class="bi bi-trash me-1"></i>Delete</button>
        </td>
      </tr>`;
    })
    .join("");
}

// ---------- Add / edit ----------
function fillTeacherOptions(selectedId = "") {
  els.teacher.innerHTML =
    `<option value="">${teachers.length ? "Select teacher" : "No teachers yet. Add one on the Teachers page."}</option>` +
    teachers
      .map((t) => {
        const taken = users.find((u) => u.role === "teacher" && u.teacherDocId === t.id && u.uid !== editing?.uid);
        return `<option value="${t.id}" ${taken ? "disabled" : ""}>${escapeHtml(t.teacherName)} (${escapeHtml(t.teacherId)})${taken ? ` – linked to ${escapeHtml(taken.username)}` : ""}</option>`;
      })
      .join("");
  els.teacher.value = selectedId;
}

function syncRoleFields() {
  els.teacherWrap.classList.toggle("d-none", els.role.value !== "teacher");
}

function openForm(user = null) {
  editing = user;
  clearErrors(els.form);
  els.formError.classList.add("d-none");
  els.modalTitle.textContent = user ? "Edit user" : "Add user";
  els.username.value = user?.username ?? "";
  els.displayName.value = user?.displayName ?? "";
  els.role.value = user?.role ?? "";
  els.active.checked = user ? user.active !== false : true;
  els.canApprove.checked = !!user?.canApprove;
  els.password.value = "";
  els.passwordConfirm.value = "";
  els.passwordFields.classList.toggle("d-none", !!user);
  fillTeacherOptions(user?.teacherDocId ?? "");
  syncRoleFields();

  // You can't lock yourself out
  const isMe = user?.uid === me.uid;
  els.role.disabled = isMe;
  els.active.disabled = isMe;
  modal.show();
}

function activeAdminsExcept(uid) {
  return users.filter((u) => u.role === "admin" && u.active !== false && u.uid !== uid).length;
}

function readForm() {
  clearErrors(els.form);
  const data = {
    username: cleanUsername(els.username.value),
    displayName: els.displayName.value.trim().replace(/\s+/g, " "),
    role: els.role.value,
    teacherDocId: els.role.value === "teacher" ? els.teacher.value || null : null,
    active: els.active.checked,
    canApprove: els.canApprove.checked,
  };
  let ok = true;
  if (!USERNAME_PATTERN.test(data.username)) { fieldError(els.username, "Use 3 to 30 lowercase letters, numbers, dot, dash or underscore."); ok = false; }
  if (!data.displayName) { fieldError(els.displayName, "Enter the user's full name."); ok = false; }
  if (!ROLES[data.role]) { fieldError(els.role, "Select a role."); ok = false; }
  if (data.role === "teacher" && !data.teacherDocId) { fieldError(els.teacher, "Link this account to a teacher record."); ok = false; }

  if (!editing) {
    const problem = passwordProblem(els.password.value);
    if (problem) { fieldError(els.password, problem); ok = false; }
    if (els.passwordConfirm.value !== els.password.value) { fieldError(els.passwordConfirm, "Passwords don't match."); ok = false; }
  }

  // Always keep at least one active administrator
  if (editing && editing.role === "admin" && editing.active !== false && (data.role !== "admin" || !data.active)) {
    if (activeAdminsExcept(editing.uid) === 0) {
      fieldError(els.role, "This is the only active administrator. Add another administrator first.");
      ok = false;
    }
  }
  return ok ? data : null;
}

async function save(e) {
  e.preventDefault();
  const data = readForm();
  if (!data) return;

  setBusy(els.btnSave, true);
  els.formError.classList.add("d-none");
  try {
    const usernameChanged = !editing || editing.username !== data.username;
    if (usernameChanged) {
      const taken = await getDoc(doc(db, "usernames", data.username));
      if (taken.exists()) {
        fieldError(els.username, `The username ${data.username} is already taken.`);
        return;
      }
    }

    if (editing) {
      const ops = [{ type: "update", ref: doc(db, "users", editing.uid), data: { ...data, updatedAt: serverTimestamp() } }];
      if (usernameChanged) {
        ops.push({ type: "delete", ref: doc(db, "usernames", editing.username) });
        ops.push({ type: "set", ref: doc(db, "usernames", data.username), data: { uid: editing.uid, authEmail: editing.authEmail } });
      }
      await commitOperations(ops);
      toast(usernameChanged ? `User updated. They now sign in as ${data.username}.` : "User updated.");
    } else {
      const { uid, authEmail } = await createLogin(data.username, els.password.value);
      await commitOperations([
        {
          type: "set",
          ref: doc(db, "users", uid),
          data: { ...data, authEmail, createdAt: serverTimestamp(), updatedAt: serverTimestamp() },
        },
        { type: "set", ref: doc(db, "usernames", data.username), data: { uid, authEmail } },
      ]);
      toast(`User ${data.username} added.`);
    }
    modal.hide();
    await loadAll();
  } catch (err) {
    els.formError.textContent = err.code?.startsWith("auth/") ? authErrorMessage(err) : errorMessage(err);
    els.formError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

// ---------- Reset password ----------
// Without a server, one user can't change another user's Firebase password.
// Instead we create a fresh login with the new password and move the profile to it.
// The old login is left without a profile, so it can no longer access anything.
function openReset(user) {
  resetting = user;
  els.resetForm.reset();
  clearErrors(els.resetForm);
  els.resetError.classList.add("d-none");
  els.resetFor.innerHTML = `Set a new password for <strong>${escapeHtml(user.displayName)}</strong> (${escapeHtml(user.username)}).`;
  resetModal.show();
}

async function submitReset(e) {
  e.preventDefault();
  clearErrors(els.resetForm);
  els.resetError.classList.add("d-none");
  const pw = els.resetPassword.value;
  const problem = passwordProblem(pw);
  let ok = true;
  if (problem) { fieldError(els.resetPassword, problem); ok = false; }
  if (els.resetConfirm.value !== pw) { fieldError(els.resetConfirm, "Passwords don't match."); ok = false; }
  if (!ok) return;

  const u = resetting;
  setBusy(els.btnReset, true, "Resetting…");
  try {
    const { uid: newUid, authEmail } = await createLogin(u.username, pw, true);
    const { uid: oldUid, ...profile } = u;
    await commitOperations([
      { type: "set", ref: doc(db, "users", newUid), data: { ...profile, authEmail, updatedAt: serverTimestamp() } },
      { type: "set", ref: doc(db, "usernames", u.username), data: { uid: newUid, authEmail } },
      { type: "delete", ref: doc(db, "users", oldUid) },
    ]);
    resetModal.hide();
    toast(`Password reset for ${u.username}. They can sign in with the new password now.`);
    await loadAll();
  } catch (err) {
    els.resetError.textContent = err.code?.startsWith("auth/") ? authErrorMessage(err) : errorMessage(err);
    els.resetError.classList.remove("d-none");
  } finally {
    setBusy(els.btnReset, false);
  }
}

// ---------- Delete ----------
async function remove(user) {
  if (user.uid === me.uid) return;
  if (user.role === "admin" && user.active !== false && activeAdminsExcept(user.uid) === 0) {
    toast("This is the only active administrator. Add another administrator first.", "warning");
    return;
  }
  const ok = await confirmDialog({
    title: "Delete user?",
    message: `${user.displayName} (${user.username}) will no longer be able to sign in. Grades they entered are kept.`,
    confirmText: "Delete user",
  });
  if (!ok) return;
  try {
    await commitOperations([
      { type: "delete", ref: doc(db, "users", user.uid) },
      { type: "delete", ref: doc(db, "usernames", user.username) },
    ]);
    toast("User deleted.");
    await loadAll();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

// ---------- Wire up ----------
function init(profile) {
  me = profile;
  searchPicker(els.teacher, { title: "Link to a teacher", placeholder: "Type a teacher's name or ID" });
  modal = new bootstrap.Modal(els.modalEl);
  resetModal = new bootstrap.Modal(els.resetModalEl);
  els.modalEl.addEventListener("shown.bs.modal", () => (editing ? els.displayName : els.username).focus());
  els.resetModalEl.addEventListener("shown.bs.modal", () => els.resetPassword.focus());
  els.username.addEventListener("input", () => {
    const pos = els.username.selectionStart;
    els.username.value = els.username.value.toLowerCase();
    els.username.setSelectionRange(pos, pos);
  });
  els.role.addEventListener("change", syncRoleFields);
  setInterval(refresh, 60 * 1000); // "Online" turns into "5 min ago" without reloading
  els.btnAdd.addEventListener("click", () => openForm());
  els.form.addEventListener("submit", save);
  els.resetForm.addEventListener("submit", submitReset);
  els.search.addEventListener("input", render);
  els.filterRole.addEventListener("change", render);
  els.tbody.addEventListener("click", (e) => {
    const find = (attr) => users.find((u) => u.uid === e.target.closest(`[${attr}]`)?.getAttribute(attr));
    if (e.target.closest("[data-edit]")) openForm(find("data-edit"));
    if (e.target.closest("[data-reset]")) openReset(find("data-reset"));
    if (e.target.closest("[data-delete]")) remove(find("data-delete"));
  });
  loadAll();
}

initLayout("users").then((user) => { if (user) init(user); });
