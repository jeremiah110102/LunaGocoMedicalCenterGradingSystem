// ==========================================================
// teachers.js — Teacher CRUD (collection: teachers)
// ==========================================================

import {
  db, collection, doc, addDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, serverTimestamp,
} from "./firebase-config.js";
import {
  initLayout, toast, confirmDialog, escapeHtml, normalize, setBusy,
  tableLoading, tableMessage, errorMessage, clearErrors, fieldError, commitOperations,
  USERNAME_PATTERN, cleanUsername, passwordProblem, authErrorMessage, nextTeacherIds,
} from "./app.js";
import { createLogin, suggestUsername, availableUsername, usernameTaken, generatePassword } from "./accounts.js";

const teachersCol = collection(db, "teachers");

const els = {
  tbody: document.getElementById("tbody"),
  count: document.getElementById("count"),
  search: document.getElementById("search"),
  btnAdd: document.getElementById("btnAdd"),
  modalEl: document.getElementById("formModal"),
  modalTitle: document.getElementById("formModalTitle"),
  form: document.getElementById("form"),
  formError: document.getElementById("formError"),
  teacherId: document.getElementById("teacherId"),
  teacherIdHelp: document.getElementById("teacherIdHelp"),
  teacherName: document.getElementById("teacherName"),
  btnSave: document.getElementById("btnSave"),
};

let me = null;
let teachers = [];
let accountsByTeacher = {}; // teacher doc id → linked user (administrators only)
let assignmentCounts = {};
let editingId = null;
let modal;

async function loadTeachers() {
  tableLoading(els.tbody, 5);
  try {
    const [tSnap, aSnap] = await Promise.all([
      getDocs(query(teachersCol, orderBy("teacherName"))),
      getDocs(collection(db, "gradingAssignments")),
    ]);
    teachers = tSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    accountsByTeacher = {};
    if (me?.role === "admin") {
      const uSnap = await getDocs(collection(db, "users"));
      uSnap.forEach((d) => {
        const u = { uid: d.id, ...d.data() };
        if (u.role === "teacher" && u.teacherDocId) accountsByTeacher[u.teacherDocId] = u;
      });
    }
    assignmentCounts = {};
    aSnap.forEach((d) => {
      const key = d.data().teacherDocId;
      assignmentCounts[key] = (assignmentCounts[key] || 0) + 1;
    });
    render();
  } catch (err) {
    tableMessage(els.tbody, 5, `<span class="text-danger">${escapeHtml(errorMessage(err))}</span>`);
  }
}

function render() {
  const term = normalize(els.search.value);
  const rows = teachers.filter((t) => !term || normalize(`${t.teacherId} ${t.teacherName}`).includes(term));
  els.count.textContent = teachers.length;

  if (!teachers.length) {
    tableMessage(els.tbody, 5, "No teachers yet. Add a teacher so you can assign them to subjects.");
    return;
  }
  if (!rows.length) {
    tableMessage(els.tbody, 5, `No teachers match “${escapeHtml(els.search.value)}”.`);
    return;
  }

  els.tbody.removeAttribute("aria-busy");
  els.tbody.innerHTML = rows.map((t) => {
    const acct = accountsByTeacher[t.id];
    const isAdmin = me?.role === "admin";
    const accountCell = !isAdmin
      ? '<span class="text-secondary small">—</span>'
      : acct
        ? `<span class="badge ${acct.active === false ? "badge-fail" : "badge-approver"}"><i class="bi bi-person-check me-1"></i>${escapeHtml(acct.username)}${acct.active === false ? " (disabled)" : ""}</span>`
        : '<span class="text-secondary small">No account</span>';
    const accountItem = !isAdmin
      ? `<li><span class="dropdown-item-text small text-secondary"><i class="bi bi-person-plus me-2"></i>Accounts: administrators only</span></li>`
      : acct
        ? `<li><a class="dropdown-item" href="users.html"><i class="bi bi-person-check me-2"></i>Account: ${escapeHtml(acct.username)}</a></li>`
        : `<li><button type="button" class="dropdown-item" data-account="${t.id}"><i class="bi bi-person-plus me-2"></i>Create account</button></li>`;
    return `
      <tr>
        <td class="code-cell">${escapeHtml(t.teacherId)}</td>
        <td>${escapeHtml(t.teacherName)}</td>
        <td class="num">${assignmentCounts[t.id] || 0}</td>
        <td>${accountCell}</td>
        <td class="text-end">
          <div class="dropdown">
            <button type="button" class="btn btn-sm btn-outline-secondary btn-more" data-bs-toggle="dropdown" aria-expanded="false"
                    data-bs-popper-config='{"strategy":"fixed"}' aria-label="More actions for ${escapeHtml(t.teacherName)}">
              <i class="bi bi-three-dots"></i>
            </button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm">
              <li><button type="button" class="dropdown-item" data-edit="${t.id}"><i class="bi bi-pencil me-2"></i>Edit</button></li>
              ${accountItem}
              <li><hr class="dropdown-divider"></li>
              <li><button type="button" class="dropdown-item text-danger" data-delete="${t.id}"><i class="bi bi-trash me-2"></i>Delete</button></li>
            </ul>
          </div>
        </td>
      </tr>`;
  }).join("");
}

function openForm(teacher = null) {
  editingId = teacher ? teacher.id : null;
  clearErrors(els.form);
  els.formError.classList.add("d-none");
  els.modalTitle.textContent = teacher ? "Edit teacher" : "Add teacher";
  els.teacherId.value = teacher?.teacherId ?? "";
  els.teacherName.value = teacher?.teacherName ?? "";
  // Adding: blank = the next number after the last teacher ID in the system
  const next = nextTeacherIds(teachers.map((t) => t.teacherId))[0];
  els.teacherId.placeholder = teacher ? "" : `Next: ${next}`;
  els.teacherIdHelp.textContent = teacher
    ? "Each teacher needs a unique Teacher ID."
    : `Leave blank to use the next number after the last one in the system (${next}).`;
  modal.show();
}

function readForm() {
  clearErrors(els.form);
  const data = {
    teacherId: els.teacherId.value.trim().toUpperCase(),
    teacherName: els.teacherName.value.trim().replace(/\s+/g, " "),
  };
  let ok = true;
  if (!data.teacherId && editingId) { fieldError(els.teacherId, "Enter a teacher ID."); ok = false; }
  if (!data.teacherName) { fieldError(els.teacherName, "Enter the teacher's name."); ok = false; }
  return ok ? data : null;
}

async function save(e) {
  e.preventDefault();
  const data = readForm();
  if (!data) return;

  setBusy(els.btnSave, true);
  els.formError.classList.add("d-none");
  try {
    if (!data.teacherId) {
      // Next number after the last teacher ID in the system (read fresh, in case someone just added one)
      const all = await getDocs(teachersCol);
      data.teacherId = nextTeacherIds(all.docs.map((d) => d.data().teacherId))[0];
    }
    const dup = await getDocs(query(teachersCol, where("teacherId", "==", data.teacherId)));
    if (dup.docs.some((d) => d.id !== editingId)) {
      fieldError(els.teacherId, `Teacher ID ${data.teacherId} already exists.`);
      return;
    }

    if (editingId) {
      const before = teachers.find((t) => t.id === editingId);
      await updateDoc(doc(db, "teachers", editingId), { ...data, updatedAt: serverTimestamp() });
      if (before.teacherId !== data.teacherId || before.teacherName !== data.teacherName) {
        await cascade(editingId, data);
      }
      toast("Teacher updated.");
    } else {
      await addDoc(teachersCol, { ...data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      toast(`Teacher added with Teacher ID ${data.teacherId}.`);
    }
    modal.hide();
    await loadTeachers();
  } catch (err) {
    els.formError.textContent = errorMessage(err);
    els.formError.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

// Update the teacher's copied details in assignments and grades
async function cascade(teacherDocId, data) {
  const patch = { teacherId: data.teacherId, teacherName: data.teacherName, updatedAt: serverTimestamp() };
  const [aSnap, gSnap] = await Promise.all([
    getDocs(query(collection(db, "gradingAssignments"), where("teacherDocId", "==", teacherDocId))),
    getDocs(query(collection(db, "grades"), where("teacherDocId", "==", teacherDocId))),
  ]);
  const ops = [...aSnap.docs, ...gSnap.docs].map((d) => ({ type: "update", ref: d.ref, data: patch }));
  if (ops.length) await commitOperations(ops);
}

async function remove(id) {
  const t = teachers.find((x) => x.id === id);
  if (!t) return;
  try {
    const used = await getDocs(query(collection(db, "gradingAssignments"), where("teacherDocId", "==", id)));
    if (!used.empty) {
      toast(`${t.teacherName} has ${used.size} grading assignment(s). Delete those assignments first.`, "warning");
      return;
    }
    if (accountsByTeacher[id]) {
      toast(`${t.teacherName} has a sign-in account (${accountsByTeacher[id].username}). Delete it in Users and roles first.`, "warning");
      return;
    }
    const ok = await confirmDialog({
      title: "Delete teacher?",
      message: `${t.teacherId} – ${t.teacherName} will be removed permanently.`,
      confirmText: "Delete teacher",
    });
    if (!ok) return;
    await deleteDoc(doc(db, "teachers", id));
    toast("Teacher deleted.");
    await loadTeachers();
  } catch (err) {
    toast(errorMessage(err), "danger");
  }
}

// ---------- Teacher sign-in account (administrators) ----------
let accountModal;
let accountTeacher = null;
const acc = {
  modalEl: document.getElementById("accountModal"),
  form: document.getElementById("accountForm"),
  forText: document.getElementById("accountFor"),
  error: document.getElementById("accountError"),
  username: document.getElementById("accUsername"),
  password: document.getElementById("accPassword"),
  btnGen: document.getElementById("btnGenPassword"),
  step: document.getElementById("accountStep"),
  done: document.getElementById("accountDone"),
  doneText: document.getElementById("accountDoneText"),
  doneUsername: document.getElementById("doneUsername"),
  donePassword: document.getElementById("donePassword"),
  btnCreate: document.getElementById("btnCreateAccount"),
  btnCancel: document.getElementById("btnAccountCancel"),
  btnCopy: document.getElementById("btnCopyAccount"),
  btnDone: document.getElementById("btnAccountDone"),
};

function showAccountStep(done) {
  acc.step.classList.toggle("d-none", done);
  acc.done.classList.toggle("d-none", !done);
  acc.btnCreate.classList.toggle("d-none", done);
  acc.btnCancel.classList.toggle("d-none", done);
  acc.btnCopy.classList.toggle("d-none", !done);
  acc.btnDone.classList.toggle("d-none", !done);
}

async function openAccount(teacherId) {
  accountTeacher = teachers.find((t) => t.id === teacherId);
  if (!accountTeacher) return;
  clearErrors(acc.form);
  acc.error.classList.add("d-none");
  showAccountStep(false);
  acc.forText.innerHTML = `Teacher: <strong>${escapeHtml(accountTeacher.teacherName)}</strong> (${escapeHtml(accountTeacher.teacherId)})`;
  acc.password.value = generatePassword();
  acc.username.value = suggestUsername(accountTeacher.teacherName);
  accountModal.show();
  // Pick a free username in the background (ralveyra → ralveyra2 if taken)
  const base = acc.username.value;
  try {
    const free = await availableUsername(base);
    if (free && acc.username.value === base) acc.username.value = free;
  } catch {}
}

async function createAccount(e) {
  e.preventDefault();
  const t = accountTeacher;
  if (!t) return;
  clearErrors(acc.form);
  acc.error.classList.add("d-none");
  const username = cleanUsername(acc.username.value);
  const password = acc.password.value;
  let ok = true;
  if (!USERNAME_PATTERN.test(username)) { fieldError(acc.username, "Use 3 to 30 lowercase letters, numbers, dot, dash or underscore."); ok = false; }
  const problem = passwordProblem(password);
  if (problem) { fieldError(acc.password, problem); ok = false; }
  if (!ok) return;

  setBusy(acc.btnCreate, true, "Creating…");
  try {
    if (await usernameTaken(username)) {
      fieldError(acc.username, `The username ${username} is already taken.`);
      return;
    }
    // Re-check that nobody linked this teacher in the meantime
    const uSnap = await getDocs(query(collection(db, "users"), where("teacherDocId", "==", t.id)));
    if (!uSnap.empty) {
      acc.error.textContent = `This teacher is already linked to ${uSnap.docs[0].data().username}.`;
      acc.error.classList.remove("d-none");
      return;
    }
    const { uid, authEmail } = await createLogin(username, password);
    await commitOperations([
      {
        type: "set",
        ref: doc(db, "users", uid),
        data: {
          username,
          displayName: t.teacherName,
          role: "teacher",
          teacherDocId: t.id,
          active: true,
          canApprove: false,
          authEmail,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
      },
      { type: "set", ref: doc(db, "usernames", username), data: { uid, authEmail } },
      // The grade tracker reminds teachers through this link (Dashboard)
      { type: "update", ref: doc(db, "teachers", t.id), data: { userUid: uid } },
    ]);
    acc.doneText.textContent = `Account created and linked to ${t.teacherName}.`;
    acc.doneUsername.textContent = username;
    acc.donePassword.textContent = password;
    showAccountStep(true);
    loadTeachers();
  } catch (err) {
    acc.error.textContent = err.code?.startsWith("auth/") ? authErrorMessage(err) : errorMessage(err);
    acc.error.classList.remove("d-none");
  } finally {
    setBusy(acc.btnCreate, false);
  }
}

async function copyAccount() {
  const details = `Grading System sign-in\nTeacher: ${accountTeacher?.teacherName}\nUsername: ${acc.doneUsername.textContent}\nPassword: ${acc.donePassword.textContent}\nSign in at: ${new URL("login.html", location.href).href}`;
  try {
    await navigator.clipboard.writeText(details);
    toast("Sign-in details copied.");
  } catch {
    toast("Couldn't copy automatically. Write the details down from the window.", "warning");
  }
}

function init(profile) {
  me = profile;
  accountModal = new bootstrap.Modal(acc.modalEl);
  acc.modalEl.addEventListener("shown.bs.modal", () => acc.username.focus());
  acc.form.addEventListener("submit", createAccount);
  acc.btnGen.addEventListener("click", () => { acc.password.value = generatePassword(); });
  acc.btnCopy.addEventListener("click", copyAccount);
  acc.username.addEventListener("input", () => {
    const pos = acc.username.selectionStart;
    acc.username.value = acc.username.value.toLowerCase();
    acc.username.setSelectionRange(pos, pos);
  });
  modal = new bootstrap.Modal(els.modalEl);
  els.modalEl.addEventListener("shown.bs.modal", () => els.teacherId.focus());
  els.btnAdd.addEventListener("click", () => openForm());
  els.form.addEventListener("submit", save);
  els.search.addEventListener("input", render);
  els.tbody.addEventListener("click", (e) => {
    const editBtn = e.target.closest("[data-edit]");
    const delBtn = e.target.closest("[data-delete]");
    const accBtn = e.target.closest("[data-account]");
    if (editBtn) openForm(teachers.find((t) => t.id === editBtn.dataset.edit));
    if (delBtn) remove(delBtn.dataset.delete);
    if (accBtn) openAccount(accBtn.dataset.account);
  });
  loadTeachers();
}

initLayout("teachers").then((user) => {
  if (user) init(user);
  else tableMessage(els.tbody, 5, "Connect Firebase and sign in to load teachers.");
});
