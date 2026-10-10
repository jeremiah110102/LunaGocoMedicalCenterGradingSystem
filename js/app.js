// ==========================================================
// app.js — shared layout and helpers used by every page
// ==========================================================

import {
  db, auth, isConfigured, writeBatch, doc, getDoc, updateDoc, updateDocQuiet, setAuditActor, serverTimestamp, USERNAME_EMAIL_DOMAIN, clearDeviceCache,
  schoolChoiceStatus, saveSchoolChoice, databaseBackend as activeBackend, sheetsDatabaseUrl as activeSheetsUrl,
  supabaseUrl as activeSupabaseUrl, supabaseKey as activeSupabaseKey,
  onAuthStateChanged, signOut, updatePassword, reauthenticateWithCredential, EmailAuthProvider,
  collection, query, where, getDocs, limit, Timestamp,
} from "./firebase-config.js";
import { setGradingOptions, DEFAULT_OPTIONS } from "./grading-scale.js";
import { termOf } from "./terms.js";
// Same SDK file firebase-config.js uses, so it shares the same Firestore instance
import { onSnapshot } from "./firebase-config.js";

export const YEAR_LEVELS = ["1st Year", "2nd Year", "3rd Year", "4th Year", "5th Year"];

// ---------- Roles ----------
export const ROLES = {
  admin: { label: "Administrator", description: "Full access, including user accounts" },
  registrar: { label: "Registrar", description: "Academic setup, assignments and all grades" },
  teacher: { label: "Teacher", description: "Enters grades for their own classes only" },
};

// Which roles may open each page
const PAGE_ROLES = {
  dashboard: ["admin", "registrar", "teacher"],
  subjects: ["admin", "registrar"],
  curriculum: ["admin", "registrar"],
  teachers: ["admin", "registrar"],
  sections: ["admin", "registrar"],
  students: ["admin", "registrar"],
  assignments: ["admin", "registrar"],
  grading: ["admin", "registrar", "teacher"],
  "final-grades": ["admin", "registrar"],
  notifications: ["admin", "registrar", "teacher"],
  settings: ["admin"],
  options: ["admin"],
  audit: ["admin"],
  backup: ["admin"],
  users: ["admin"],
};

// UI hints only (to avoid menu flicker). Security lives in Firestore rules.
const UI_KEYS = { role: "gs-role", name: "gs-name" };

export function rememberUi(profile) {
  try {
    localStorage.setItem(UI_KEYS.role, profile.role);
    localStorage.setItem(UI_KEYS.name, profile.displayName || profile.username);
  } catch {}
}

function forgetUi() {
  try {
    localStorage.removeItem(UI_KEYS.role);
    localStorage.removeItem(UI_KEYS.name);
  } catch {}
}

function firstAuthState() {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (user) => {
      stop();
      resolve(user);
    });
  });
}

/** Loads the signed-in user's profile from users/{uid}. Returns null if missing. */
export async function loadProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? { uid, ...snap.data() } : null;
}

function goToLogin(reason) {
  forgetUi();
  const next = location.pathname.split("/").pop();
  const params = new URLSearchParams({ next });
  if (reason) params.set("reason", reason);
  location.replace(`login.html?${params}`);
}

export async function logout(reason = "") {
  // Opened on another device: still online there, so don't mark the account signed out
  if (auth.currentUser && reason !== "elsewhere") await markSignedOut(auth.currentUser.uid);
  if (auth.currentUser) await releaseSession(auth.currentUser.uid);
  forgetUi();
  try { localStorage.removeItem(SCHOOL_FULL_KEY); } catch {}
  await signOut(auth);
  await clearDeviceCache(); // the next person on this computer can't see cached records
  location.replace(reason ? `login.html?reason=${encodeURIComponent(reason)}` : "login.html");
}

function fillUserBox(profile) {
  const name = profile.displayName || profile.username;
  const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set("userName", name);
  set("userInitials", initials);
  set("userRole", ROLES[profile.role]?.label || profile.role);
}

/**
 * Runs on every page:
 *  - checks Firebase is configured
 *  - requires a signed-in, active user (otherwise → login)
 *  - checks the user's role may open this page
 * Resolves to the user's profile, or null if the page should not load.
 */
export async function initLayout(pageKey) {
  // Close the mobile menu before leaving so it doesn't flash on the next page
  document.querySelectorAll("#sidebar .side-link").forEach((link) =>
    link.addEventListener("click", () => {
      const oc = window.bootstrap && bootstrap.Offcanvas.getInstance(document.getElementById("sidebar"));
      if (oc) oc.hide();
    })
  );

  // Not connected to Firebase on this device yet → setup screen
  if (!isConfigured) {
    location.replace("setup.html");
    return null;
  }

  const user = await firstAuthState();
  if (!user) { goToLogin(); return null; }

  let profile;
  try {
    profile = await loadProfile(user.uid);
  } catch (err) {
    console.error(err);
    profile = null;
  }
  if (!profile || profile.active === false) {
    await signOut(auth);
    goToLogin(profile ? "disabled" : "noprofile");
    return null;
  }

  rememberUi(profile);
  document.documentElement.dataset.role = profile.role;
  fillUserBox(profile);
  setAuditActor({ uid: profile.uid, name: profile.displayName || profile.username, role: profile.role }); // audit trail
  const schoolOptions = await getOptions();
  setGradingOptions(schoolOptions); // the school's grading scale, before the page starts
  if (profile.role === "admin") maybeCleanAudit(schoolOptions); // old audit trail entries, in the background

  watchUnread(profile.uid);
  startPresence(profile.uid);
  if (profile.role === "teacher") showDowntimeNotice();
  getSchool().catch(() => {}); // refresh branding in the background
  document.getElementById("btnSignOut")?.addEventListener("click", logout);
  document.getElementById("btnChangePassword")?.addEventListener("click", openChangePassword);

  // The school's database choice isn't recorded yet: the first administrator records the
  // current one, so every device keeps using it and only administrators can change it.
  if (profile.role === "admin" && schoolChoiceStatus === "not-set") {
    saveSchoolChoice({
      backend: activeBackend, sheetsUrl: activeSheetsUrl,
      supabaseUrl: activeSupabaseUrl, supabaseKey: activeSupabaseKey,
      byName: profile.displayName || profile.username,
      reason: "Recorded automatically at the first administrator sign-in",
    }).catch((err) => console.warn("Couldn't record the school's database:", err.code || err));
  }

  // Sign-in security (School settings → Sign-in security)
  const security = await getSecurity();
  if (security.singleSession) {
    const current = profile.activeSession;
    if (!current || !current.id) {
      await claimSession(profile.uid).catch((err) => console.warn("Session:", err.code || err));
    } else if (current.id !== mySession(profile.uid)) {
      await logout("elsewhere"); // the account was opened on another device
      return null;
    }
    watchSession(profile.uid);
  }
  startIdleTimer(security.autoLogoutMinutes);

  // An account with a default or temporary password must choose its own first
  if (profile.mustChangePassword) openChangePassword({ forced: true, uid: profile.uid });

  const allowed = PAGE_ROLES[pageKey] || [];
  if (!allowed.includes(profile.role)) {
    location.replace("dashboard.html");
    return null;
  }
  return profile;
}

// ---------- Change my password ----------
function openChangePassword(options = {}) {
  const forced = options && options.forced === true;
  let el = document.getElementById("passwordModal");
  if (!el) {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<div class="modal fade" id="passwordModal" tabindex="-1" aria-labelledby="passwordModalTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-centered">
          <form class="modal-content" id="passwordForm" novalidate>
            <div class="modal-header">
              <h2 class="modal-title fs-5" id="passwordModalTitle">Change my password</h2>
              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
              <div class="alert alert-danger d-none py-2" data-error role="alert"></div>
              <div class="mb-3">
                <label for="pwCurrent" class="form-label required">Current password</label>
                <input type="password" class="form-control" id="pwCurrent" autocomplete="current-password">
                <div class="invalid-feedback"></div>
              </div>
              <div class="mb-3">
                <label for="pwNew" class="form-label required">New password</label>
                <input type="password" class="form-control" id="pwNew" autocomplete="new-password">
                <div class="invalid-feedback"></div>
                <div class="form-text">At least 8 characters.</div>
              </div>
              <div class="mb-1">
                <label for="pwConfirm" class="form-label required">Confirm new password</label>
                <input type="password" class="form-control" id="pwConfirm" autocomplete="new-password">
                <div class="invalid-feedback"></div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="submit" class="btn btn-primary" data-save>Change password</button>
            </div>
          </form>
        </div>
      </div>`
    );
    el = document.getElementById("passwordModal");
    el.addEventListener("shown.bs.modal", () => el.querySelector("#pwCurrent").focus());
    el.querySelector("form").addEventListener("submit", submitChangePassword);
  }
  // Forced: can't be closed until a new password is saved
  el.dataset.forced = forced ? "1" : "";
  el.dataset.uid = forced ? options.uid || "" : "";
  el.querySelectorAll('[data-bs-dismiss="modal"]').forEach((b) => b.classList.toggle("d-none", forced));
  el.querySelector(".modal-title").textContent = forced ? "Choose a new password" : "Change my password";
  let note = el.querySelector("[data-forced-note]");
  if (!note) {
    el.querySelector(".modal-body").insertAdjacentHTML("afterbegin", '<div class="alert alert-warning py-2 small" data-forced-note></div>');
    note = el.querySelector("[data-forced-note]");
  }
  note.textContent = "This account still has its default password. Choose your own password to continue. Enter the default password as the current password.";
  note.classList.toggle("d-none", !forced);
  el.querySelector("form").reset();
  clearErrors(el.querySelector("form"));
  el.querySelector("[data-error]").classList.add("d-none");
  const existing = bootstrap.Modal.getInstance(el);
  if (existing) existing.dispose();
  new bootstrap.Modal(el, forced ? { backdrop: "static", keyboard: false } : {}).show();
}

async function submitChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const el = document.getElementById("passwordModal");
  const cur = form.querySelector("#pwCurrent");
  const nw = form.querySelector("#pwNew");
  const cf = form.querySelector("#pwConfirm");
  const errBox = form.querySelector("[data-error]");
  clearErrors(form);
  errBox.classList.add("d-none");

  let ok = true;
  if (!cur.value) { fieldError(cur, "Enter your current password."); ok = false; }
  const pwProblem = passwordProblem(nw.value);
  if (pwProblem) { fieldError(nw, pwProblem); ok = false; }
  if (cf.value !== nw.value) { fieldError(cf, "Passwords don't match."); ok = false; }
  if (!pwProblem && nw.value === cur.value) { fieldError(nw, "Choose a password different from the current one."); ok = false; }
  if (!ok) return;

  const btn = form.querySelector("[data-save]");
  setBusy(btn, true);
  try {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, cur.value));
    await updatePassword(user, nw.value);
    if (el.dataset.forced && el.dataset.uid) {
      // Clear the "must change password" mark on the account
      await updateDoc(doc(db, "users", el.dataset.uid), { mustChangePassword: false, updatedAt: serverTimestamp() });
      el.dataset.forced = "";
    }
    bootstrap.Modal.getInstance(el).hide();
    toast("Password changed.");
  } catch (err) {
    if (["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(err.code)) {
      fieldError(cur, "Current password is incorrect.");
    } else {
      errBox.textContent = authErrorMessage(err);
      errBox.classList.remove("d-none");
    }
  } finally {
    setBusy(btn, false);
  }
}

export function passwordProblem(pw) {
  if (!pw) return "Enter a password.";
  if (pw.length < 8) return "Use at least 8 characters.";
  return null;
}

export function authErrorMessage(err) {
  console.error(err);
  switch (err?.code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect username or password.";
    case "auth/too-many-requests":
      return "Too many attempts. Wait a few minutes, then try again.";
    case "auth/network-request-failed":
      return "Can't reach Firebase. Check your internet connection.";
    case "auth/operation-not-allowed":
      return "Email/Password sign-in is turned off. Enable it in Firebase Console > Authentication > Sign-in method.";
    case "auth/weak-password":
      return "That password is too weak. Use at least 8 characters.";
    case "auth/email-already-in-use":
      return "That username is already taken.";
    default:
      return errorMessage(err);
  }
}

// ---------- Toasts ----------
export function toast(message, type = "success") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container position-fixed bottom-0 end-0 p-3";
    document.body.appendChild(container);
  }
  const styles = {
    success: { cls: "text-bg-success", icon: "bi-check-circle" },
    danger: { cls: "text-bg-danger", icon: "bi-exclamation-octagon" },
    warning: { cls: "text-bg-warning", icon: "bi-exclamation-triangle" },
    info: { cls: "text-bg-dark", icon: "bi-info-circle" },
  };
  const s = styles[type] || styles.info;
  const el = document.createElement("div");
  el.className = `toast align-items-center border-0 ${s.cls}`;
  el.setAttribute("role", type === "danger" ? "alert" : "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body d-flex gap-2 align-items-start"><i class="bi ${s.icon}"></i><span>${escapeHtml(message)}</span></div>
      <button type="button" class="btn-close ${type === "warning" ? "" : "btn-close-white"} me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  container.appendChild(el);
  const t = bootstrap.Toast.getOrCreateInstance(el, { delay: type === "danger" ? 7000 : 3500 });
  el.addEventListener("hidden.bs.toast", () => el.remove());
  t.show();
}

// ---------- Confirm dialog ----------
export function confirmDialog({ title = "Please confirm", message = "", confirmText = "Delete", variant = "danger", cancelText = "Cancel" } = {}) {
  return new Promise((resolve) => {
    let el = document.getElementById("confirmModal");
    if (!el) {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div class="modal fade" id="confirmModal" tabindex="-1" aria-labelledby="confirmModalTitle" aria-hidden="true">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header"><h2 class="modal-title fs-5" id="confirmModalTitle"></h2>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
              <div class="modal-body" data-message style="white-space:pre-line"></div>
              <div class="modal-footer">
                <button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal" data-cancel>Cancel</button>
                <button type="button" class="btn" data-confirm></button>
              </div>
            </div>
          </div>
        </div>`
      );
      el = document.getElementById("confirmModal");
    }
    el.querySelector(".modal-title").textContent = title;
    el.querySelector("[data-message]").textContent = message;
    el.querySelector("[data-cancel]").textContent = cancelText;
    const btn = el.querySelector("[data-confirm]");
    btn.textContent = confirmText;
    btn.className = `btn btn-${variant}`;

    const modal = bootstrap.Modal.getOrCreateInstance(el);
    let confirmed = false;
    const onClick = () => {
      confirmed = true;
      modal.hide();
    };
    btn.addEventListener("click", onClick);
    el.addEventListener(
      "hidden.bs.modal",
      () => {
        btn.removeEventListener("click", onClick);
        resolve(confirmed);
      },
      { once: true }
    );
    modal.show();
  });
}

// ---------- Small utilities ----------
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalize(value) {
  return String(value ?? "").toLowerCase().trim();
}

export function compareText(a, b) {
  return String(a ?? "").localeCompare(String(b ?? ""), undefined, { numeric: true, sensitivity: "base" });
}

export function formatUnits(units) {
  const n = Number(units);
  return `${n} ${n === 1 ? "Unit" : "Units"}`;
}

export function isValidSchoolYear(value) {
  const m = /^(\d{4})-(\d{4})$/.exec(String(value).trim());
  return !!m && Number(m[2]) === Number(m[1]) + 1;
}

export function setBusy(button, busy, busyText = "Saving…") {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>${busyText}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function tableMessage(tbody, colspan, html) {
  tbody.removeAttribute("aria-busy");
  tbody.innerHTML = `<tr><td colspan="${colspan}" class="empty-state">${html}</td></tr>`;
}

// Skeleton rows keep the table's height steady while Firestore loads
export function tableLoading(tbody, colspan, rows = 4) {
  const widths = [6, 9, 4, 7, 5, 8];
  tbody.innerHTML = Array.from({ length: rows }, (_, r) =>
    `<tr class="skeleton-row" aria-hidden="true">${Array.from({ length: colspan }, (_, c) =>
      `<td><span class="placeholder rounded col-${widths[(r + c) % widths.length]}"></span></td>`
    ).join("")}</tr>`
  ).join("");
  tbody.setAttribute("aria-busy", "true");
}

export function errorMessage(err) {
  console.error(err);
  if (!err) return "Something went wrong.";
  // Same words for every database (Firestore, Google Sheets, Supabase)
  if (err.code === "permission-denied") return "You don't have permission to make this change. If you should, ask an administrator to check your account and the database rules.";
  if (err.code === "unavailable") {
    // Google Sheets / Supabase say which setting to check; Firestore's own text is technical
    return /Google Sheets|Supabase/.test(err.message || "") ? err.message : "Can't reach the database. Check your internet connection and try again.";
  }
  // fetch() without a connection: "Failed to fetch" (Chrome), "NetworkError…" (Firefox), "Load failed" (Safari)
  if (err instanceof TypeError && /fetch|network|load failed/i.test(err.message || "")) return "Can't reach the database. Check your internet connection and try again.";
  if (err.code === "failed-precondition") return "Firestore needs an index for this query. Open the browser console for the link to create it.";
  return err.message || "Something went wrong.";
}

// ---------- Form validation helpers ----------
export function clearErrors(form) {
  form.querySelectorAll(".is-invalid").forEach((el) => el.classList.remove("is-invalid"));
}

export function fieldError(input, message) {
  input.classList.add("is-invalid");
  const fb = input.parentElement.querySelector(".invalid-feedback");
  if (fb) fb.textContent = message;
}

// ---------- Batched writes (Firestore allows 500 per batch) ----------
export async function commitOperations(ops) {
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db);
    ops.slice(i, i + 450).forEach((op) => {
      if (op.type === "delete") batch.delete(op.ref);
      else if (op.type === "update") batch.update(op.ref, op.data);
      else batch.set(op.ref, op.data, op.options || {});
    });
    await batch.commit();
  }
}

// Remarks follow the school's grading scale (Setup and options → Grading scale)
export { remarksFor } from "./grading-scale.js";

// ---------- Usernames ----------
export const USERNAME_PATTERN = /^[a-z0-9._-]{3,30}$/;

export function cleanUsername(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** Internal sign-in address for a username. A suffix makes a fresh address (used for password resets). */
export function usernameEmail(username, suffix = "") {
  return `${username}${suffix ? "." + suffix : ""}@${USERNAME_EMAIL_DOMAIN}`;
}

// ---------- SheetJS (Excel) loaded on demand ----------
const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js";
let sheetJsPromise = null;
export function loadSheetJs() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = SHEETJS_URL;
      s.onload = () => resolve(window.XLSX);
      s.onerror = () => {
        sheetJsPromise = null;
        reject(new Error("Couldn't load the Excel library. Check your internet connection and try again."));
      };
      document.head.appendChild(s);
    });
  }
  return sheetJsPromise;
}

// ---------- Email ----------
export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value ?? "").trim());
}

// ---------- Notifications badge (live) ----------
let unreadStop = null;
function watchUnread(uid) {
  if (unreadStop) unreadStop();
  const q = query(collection(db, "notifications"), where("toUid", "==", uid), where("read", "==", false));
  unreadStop = onSnapshot(
    q,
    (snap) => {
      const n = snap.size;
      ["notifBadge", "notifBadgeTop"].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = n > 99 ? "99+" : String(n);
        el.classList.toggle("d-none", n === 0);
      });
    },
    (err) => console.warn("Notification badge:", err.code || err)
  );
}

// ---------- Dates ----------
export function toDate(ts) {
  if (!ts) return null;
  if (ts.toDate) return ts.toDate();
  return ts instanceof Date ? ts : new Date(ts);
}

export function timeAgo(ts) {
  const d = toDate(ts);
  if (!d) return "just now";
  const sec = Math.round((Date.now() - d.getTime()) / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? "" : "s"} ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
  return formatDateTime(d);
}

export function formatDateTime(ts) {
  const d = toDate(ts);
  if (!d) return "—";
  return d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A grade for messages: "1.75", or INC / DRP when a remark was saved instead of a number. */
export function formatGrade(n, remarks = "") {
  if (n === null || n === undefined || n === "") return remarks === "Incomplete" ? "INC" : remarks === "Dropped" ? "DRP" : "—";
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

// ---------- School settings (settings/school) ----------
const SCHOOL_KEY = "gs-school";
let schoolPromise = null;

export const DEFAULT_SCHOOL = {
  schoolName: "",
  shortName: "",
  address: "",
  phone: "",
  email: "",
  website: "",
  registrarName: "",
  registrarTitle: "Registrar",
  logo: "",
};

export function cachedSchool() {
  try {
    return { ...DEFAULT_SCHOOL, ...(JSON.parse(localStorage.getItem(SCHOOL_KEY) || "null") || {}) };
  } catch {
    return { ...DEFAULT_SCHOOL };
  }
}

const SCHOOL_FULL_KEY = "gs-school-full";
// Re-read school settings at most every 5 minutes, so a new or changed school name shows up
// on every device soon (one small read)
const SCHOOL_MAX_AGE = 5 * 60 * 1000;

/** Loads the school settings (readable before sign-in, for the login page). Cached for 5 minutes. */
export function getSchool(force = false) {
  if (!schoolPromise || force) {
    if (!force) {
      try {
        const saved = JSON.parse(localStorage.getItem(SCHOOL_FULL_KEY) || "null");
        // A copy saved before the school's name was set isn't trusted: read it again now
        const named = saved && saved.data && (saved.data.schoolName || saved.data.shortName);
        if (saved && named && Date.now() - saved.at < SCHOOL_MAX_AGE) {
          const school = { ...DEFAULT_SCHOOL, ...saved.data };
          applyBranding(school);
          schoolPromise = Promise.resolve(school);
          return schoolPromise;
        }
      } catch {}
    }
    schoolPromise = getDoc(doc(db, "settings", "school"))
      .then((snap) => {
        const data = snap.exists() ? snap.data() : {};
        const school = { ...DEFAULT_SCHOOL, ...data };
        try {
          const { updatedAt, ...plain } = data; // timestamps don't store well; not needed here
          localStorage.setItem(SCHOOL_FULL_KEY, JSON.stringify({ at: Date.now(), data: plain }));
        } catch {}
        rememberSchool(school);
        return school;
      })
      .catch((err) => {
        console.warn("School settings:", err.code || err);
        schoolPromise = null; // try again on the next page
        const school = cachedSchool();
        applyBranding(school);
        return school;
      });
  }
  return schoolPromise;
}

export function rememberSchool(school) {
  try {
    const { updatedAt, ...plain } = school;
    const prev = JSON.parse(localStorage.getItem(SCHOOL_FULL_KEY) || "null");
    if (prev) localStorage.setItem(SCHOOL_FULL_KEY, JSON.stringify({ at: prev.at, data: { ...prev.data, ...plain } }));
  } catch {}
  try {
    localStorage.setItem(SCHOOL_KEY, JSON.stringify({
      schoolName: school.schoolName || "",
      shortName: school.shortName || "",
      logo: school.logo || "",
    }));
  } catch {}
  applyBranding(school);
}

export function applyBranding(school) {
  // The school's full name (School settings) is the main name; AcadLink only until it's set.
  // The narrow phone top bar uses the short name when there is one.
  const label = school.schoolName || school.shortName;
  const name = document.getElementById("brandName");
  const sub = document.getElementById("brandSub");
  const topbar = document.getElementById("topbarTitle");
  const seal = document.getElementById("brandSeal");
  if (name) name.textContent = label || "AcadLink";
  if (sub) sub.textContent = "Grading System";
  if (topbar) topbar.textContent = school.shortName || label || "AcadLink Grading System";
  if (seal) {
    if (school.logo) {
      seal.innerHTML = `<img src="${school.logo}" alt="">`;
      seal.classList.add("has-logo");
      seal.classList.remove("is-default");
    } else {
      // No school logo uploaded: the system's own logo (AcadLink)
      seal.innerHTML = `<img src="${new URL("../icons/acadlink-mark.png", import.meta.url).href}" alt="">`;
      seal.classList.add("has-logo", "is-default");
    }
  }
}

/** Letterhead HTML used on printed reports and previews. */
export function letterheadHtml(school) {
  const s = { ...DEFAULT_SCHOOL, ...school };
  const contact = [s.phone, s.email, s.website].filter(Boolean).map(escapeHtml).join(" &nbsp;|&nbsp; ");
  return `
    <div class="letterhead">
      ${s.logo ? `<img class="letterhead-logo" src="${s.logo}" alt="">` : ""}
      <div>
        <div class="letterhead-name">${escapeHtml(s.schoolName || "Your school name")}</div>
        ${s.address ? `<div class="letterhead-line">${escapeHtml(s.address).replace(/\n/g, "<br>")}</div>` : ""}
        ${contact ? `<div class="letterhead-line">${contact}</div>` : ""}
      </div>
    </div>`;
}

export function signatureHtml(school) {
  const s = { ...DEFAULT_SCHOOL, ...school };
  if (!s.registrarName) return "";
  return `
    <div class="signature-block">
      <div class="signature-line">${escapeHtml(s.registrarName)}</div>
      <div class="small text-secondary">${escapeHtml(s.registrarTitle || "Registrar")}</div>
    </div>`;
}

// ---------- Mobile-friendly tables ----------
// On phones, .table-stack tables become cards (see style.css). Each cell needs
// its column name as data-label; this fills them in for every table, including
// rows rendered later, so page scripts don't have to.
function labelTable(table) {
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  table.querySelectorAll("tbody tr, tfoot tr").forEach((tr) => {
    let col = 0;
    [...tr.children].forEach((td) => {
      const span = Number(td.getAttribute("colspan") || 1);
      if (!td.hasAttribute("data-label")) {
        const label = span > 1 ? "" : heads[col] || "";
        td.setAttribute("data-label", label);
        const hasButtons = !!td.querySelector("button, .btn");
        if (span > 1) td.classList.add("td-full");
        else if (hasButtons && (!label || /^actions?$/i.test(label))) td.classList.add("td-actions");
      }
      col += span;
    });
  });
}

let labelQueued = false;
function labelAllTables() {
  labelQueued = false;
  document.querySelectorAll("table.table-stack").forEach(labelTable);
}
function queueLabels() {
  if (labelQueued) return;
  labelQueued = true;
  requestAnimationFrame(labelAllTables);
}
if (typeof MutationObserver !== "undefined") {
  new MutationObserver((mutations) => {
    if (mutations.some((m) => m.addedNodes.length)) queueLabels();
  }).observe(document.documentElement, { childList: true, subtree: true });
}
document.addEventListener("DOMContentLoaded", queueLabels);
queueLabels();

// ---------- Names ----------
/**
 * The part of a person's name used to spot duplicates: drops ranks/titles in
 * front (F03, PSSg, DR., Prof.…) and credentials after the comma.
 * "F02 HANNAH CHELSEA PADUA, Rcrim" → "hannah chelsea padua"
 */
export function teacherCore(name) {
  let t = String(name ?? "").replace(/\s+/g, " ").trim().split(",")[0];
  const prefix = /^(dr|prof|engr|atty|mr|mrs|ms|miss|sir|maam|ma'am|hon|rev|fr|sr|f\d+|p?ss?g|pcpl|pmsg|psms|pems|pmaj|pcapt|plt|pltcol|pcol|pbgen|pat|pfc|sgt|cpl|ssg|msg|lt|capt|maj|col)\.?\s+/i;
  while (prefix.test(t)) t = t.replace(prefix, "");
  return t.toLowerCase().replace(/[^a-z\s]/g, "").replace(/\s+/g, " ").trim();
}

// ---------- ExcelJS (styled Excel files) loaded on demand ----------
const EXCELJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js";
let excelJsPromise = null;
export function loadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (!excelJsPromise) {
    excelJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = EXCELJS_URL;
      s.onload = () => (window.ExcelJS ? resolve(window.ExcelJS) : reject(new Error("The Excel library didn't load.")));
      s.onerror = () => {
        excelJsPromise = null;
        reject(new Error("Couldn't load the Excel library. Check your internet connection and try again."));
      };
      document.head.appendChild(s);
    });
  }
  return excelJsPromise;
}

/** Saves an ArrayBuffer as a file download. */
export function downloadBuffer(buffer, fileName, type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
  const url = URL.createObjectURL(new Blob([buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------- Student numbers ----------
/**
 * Next student numbers after the last (highest) one in the system.
 * Keeps the format: "20250150" → "20250151"; "000123" → "000124"; "BSN-0042" → "BSN-0043".
 * With no numbered students yet, starts from the school year: 2026-2027 → 20260001.
 * `avoid`: numbers typed in the file being imported; they're skipped, not counted from.
 */
export function nextStudentNumbers(existingIds, count, schoolYear = "", avoid = []) {
  let best = null; // { prefix, num (BigInt), width }
  for (const raw of existingIds) {
    const m = /^(\D*?)(\d+)$/.exec(String(raw ?? "").trim());
    if (!m) continue;
    const num = BigInt(m[2]);
    if (!best || num > best.num || (num === best.num && m[1] > best.prefix)) best = { prefix: m[1], num, width: m[2].length };
  }
  if (!best) {
    const year = /^\d{4}/.exec(String(schoolYear))?.[0];
    best = year ? { prefix: "", num: BigInt(`${year}0000`), width: 8 } : { prefix: "", num: 0n, width: 1 };
  }
  const taken = new Set([...existingIds, ...avoid].map((v) => String(v ?? "").trim()));
  const out = [];
  let n = best.num;
  while (out.length < count) {
    n += 1n;
    const id = `${best.prefix}${n.toString().padStart(best.width, "0")}`;
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

/**
 * The next teacher IDs after the last one in the system (T001, T002, …; any other numbered
 * style the school uses, like FAC-0012, is continued the same way). avoid = ids also in use.
 */
export function nextTeacherIds(existingIds, count = 1, avoid = []) {
  const ids = (existingIds || []).map((v) => String(v ?? "").trim().toUpperCase());
  const numbered = ids.some((id) => /\d+$/.test(id));
  // No numbered teacher IDs yet: start at T001
  return nextStudentNumbers(numbered ? ids : [...ids, "T000"], count, "", avoid.map((v) => String(v ?? "").trim().toUpperCase()));
}

// ---------- Sign-in security: one device at a time, automatic sign-out ----------
const SESSION_KEY = "gs-session";          // this device's session { uid, id }
const ACTIVITY_KEY = "gs-last-activity";   // last click/keypress/scroll, shared by tabs
// ---------- Setup and options (settings/options) ----------
const OPTIONS_CACHE = "gs-options";

/** The school's options (grading scale, section moves). Re-read at most every 5 minutes. */
export async function getOptions(force = false) {
  try {
    const c = JSON.parse(localStorage.getItem(OPTIONS_CACHE) || "null");
    if (!force && c && Date.now() - c.at < 5 * 60 * 1000) return { ...DEFAULT_OPTIONS, ...c.data };
  } catch {}
  try {
    const snap = await getDoc(doc(db, "settings", "options"));
    const { updatedAt, ...data } = snap.exists() ? snap.data() : {};
    rememberOptions(data);
    return { ...DEFAULT_OPTIONS, ...data };
  } catch (err) {
    console.warn("Setup and options:", err.code || err);
    try {
      const c = JSON.parse(localStorage.getItem(OPTIONS_CACHE) || "null");
      if (c) return { ...DEFAULT_OPTIONS, ...c.data };
    } catch {}
    return { ...DEFAULT_OPTIONS };
  }
}

export function rememberOptions(data) {
  try { localStorage.setItem(OPTIONS_CACHE, JSON.stringify({ at: Date.now(), data })); } catch {}
  setGradingOptions({ ...DEFAULT_OPTIONS, ...data });
}

const SECURITY_CACHE = "gs-security";

export const AUTO_LOGOUT_CHOICES = [
  [0, "Off"], [1, "1 minute"], [5, "5 minutes"], [10, "10 minutes"], [30, "30 minutes"],
  [60, "1 hour"], [300, "5 hours"], [1440, "24 hours"],
];
export const DEFAULT_SECURITY = { singleSession: true, autoLogoutMinutes: 0 };

export function autoLogoutLabel(minutes) {
  const found = AUTO_LOGOUT_CHOICES.find(([m]) => m === Number(minutes));
  return found ? found[1] : `${minutes} minutes`;
}

/** settings/security, cached for 5 minutes. */
export async function getSecurity(force = false) {
  try {
    const c = JSON.parse(localStorage.getItem(SECURITY_CACHE) || "null");
    if (!force && c && Date.now() - c.at < 5 * 60 * 1000) return { ...DEFAULT_SECURITY, ...c.data };
  } catch {}
  try {
    const snap = await getDoc(doc(db, "settings", "security"));
    const { updatedAt, ...data } = snap.exists() ? snap.data() : {};
    rememberSecurity(data);
    return { ...DEFAULT_SECURITY, ...data };
  } catch (err) {
    console.warn("Security settings:", err.code || err);
    return { ...DEFAULT_SECURITY };
  }
}

export function rememberSecurity(data) {
  try { localStorage.setItem(SECURITY_CACHE, JSON.stringify({ at: Date.now(), data })); } catch {}
}

/** "Chrome on Windows", "Safari on iPhone"… */
export function deviceLabel() {
  const ua = navigator.userAgent || "";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : "a device";
  return `${browser} on ${os}`;
}

export function mySession(uid) {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    return s && s.uid === uid ? s.id : null;
  } catch {
    return null;
  }
}

// ---------- Teacher downtime (School settings → Teacher downtime) ----------
// While it's on, teachers can't enter grades or send change requests (the database
// rules refuse them too); administrators and registrars keep full access.

/** The downtime setting ({ teachersLocked, until, message }), read fresh. */
export async function getDowntime() {
  try {
    const snap = await getDoc(doc(db, "settings", "downtime"));
    return snap.exists() ? snap.data() : {};
  } catch (err) {
    console.warn("Teacher downtime:", err.code || err);
    return {};
  }
}

/** Is grade entry closed for teachers right now? */
export function downtimeActive(d) {
  if (!d || d.teachersLocked !== true) return false;
  const until = toDate(d.until);
  return !until || Date.now() < until.getTime();
}

export function downtimeText(d) {
  const until = toDate(d && d.until);
  return `Grade entry is closed for teachers${until ? ` until ${formatDateTime(until)}` : " for now"}.` +
    (d && d.message ? ` ${d.message}` : "");
}

async function showDowntimeNotice() {
  const box = document.getElementById("config-alert");
  if (!box) return;
  const d = await getDowntime();
  if (!downtimeActive(d)) return;
  box.innerHTML = `<div class="alert alert-warning d-flex align-items-start gap-2 mb-3" role="status">
      <i class="bi bi-cone-striped mt-1" aria-hidden="true"></i>
      <div><strong>Downtime.</strong> ${escapeHtml(downtimeText(d))} You can still view your classes and grades.</div>
    </div>`;
}

// ---------- Who is online (Users and roles page) ----------
// While the system is open on screen, each account records "last active" about every
// 5 minutes (a background save, no spinner). Someone active within the last 7 minutes
// counts as online.
const PRESENCE_KEY = "gs-seen";
const PRESENCE_EVERY_MS = 5 * 60 * 1000;
export const ONLINE_WINDOW_MS = 7 * 60 * 1000;

function currentPageName() {
  const link = document.querySelector("#sidebar .side-link.active span");
  return link ? link.textContent.trim() : "";
}

async function markSeen(uid, force = false) {
  if (document.hidden) return;
  let last = 0;
  try {
    const s = JSON.parse(localStorage.getItem(PRESENCE_KEY) || "null");
    if (s && s.uid === uid) last = s.at;
  } catch {}
  // Shared by every page and tab on this device, so moving between pages doesn't add saves
  if (!force && Date.now() - last < PRESENCE_EVERY_MS - 15000) return;
  try { localStorage.setItem(PRESENCE_KEY, JSON.stringify({ uid, at: Date.now() })); } catch {}
  await updateDocQuiet(doc(db, "users", uid), {
    lastSeen: { at: serverTimestamp(), device: deviceLabel(), page: currentPageName() },
  }).catch((err) => console.warn("Last active:", err.code || err));
}

function startPresence(uid) {
  markSeen(uid);
  setInterval(() => markSeen(uid), 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) markSeen(uid); });
}

/** On sign-out: shows the account as offline right away. */
async function markSignedOut(uid) {
  try { localStorage.removeItem(PRESENCE_KEY); } catch {}
  await updateDocQuiet(doc(db, "users", uid), {
    lastSeen: { at: serverTimestamp(), device: deviceLabel(), page: "", signedOut: true },
  }).catch(() => {});
}

/** Is this user online now? (active in the last few minutes and not signed out) */
export function isOnline(user) {
  const s = user && user.lastSeen;
  const d = s ? toDate(s.at) : null;
  return !!(d && !s.signedOut && Date.now() - d.getTime() < ONLINE_WINDOW_MS);
}

/** Makes this device the account's active one (other devices then sign out). */
export async function claimSession(uid) {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const id = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ uid, id })); } catch {}
  await updateDoc(doc(db, "users", uid), { activeSession: { id, device: deviceLabel(), at: serverTimestamp() } });
  return id;
}

/** On sign-out: clear the account's active session if it's this device's. */
async function releaseSession(uid) {
  const id = mySession(uid);
  try { localStorage.removeItem(SESSION_KEY); } catch {}
  if (!id) return;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists() && snap.data().activeSession && snap.data().activeSession.id === id) {
      await updateDoc(doc(db, "users", uid), { activeSession: null });
    }
  } catch {}
}

/** Signs this device out when the account is opened on another device. */
function watchSession(uid) {
  onSnapshot(doc(db, "users", uid), (snap) => {
    const current = snap.exists() ? snap.data().activeSession : null;
    const mine = mySession(uid);
    if (current && current.id && mine && current.id !== mine) {
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      logout("elsewhere");
    }
  }, () => {});
}

// Automatic sign-out after no activity
function markActivity() {
  try { localStorage.setItem(ACTIVITY_KEY, String(Date.now())); } catch {}
}
function lastActivity() {
  return Number(localStorage.getItem(ACTIVITY_KEY) || 0) || Date.now();
}
function idleWarning(secondsLeft) {
  let box = document.getElementById("idleWarning");
  if (secondsLeft === null) { if (box) box.remove(); return; }
  if (!box) {
    document.body.insertAdjacentHTML("beforeend", `
      <div id="idleWarning" class="idle-warning shadow" role="alertdialog" aria-live="assertive" aria-labelledby="idleWarningText">
        <i class="bi bi-hourglass-split fs-4"></i>
        <div class="flex-grow-1"><div class="fw-semibold">Still there?</div><div class="small" id="idleWarningText"></div></div>
        <button type="button" class="btn btn-sm btn-primary">Stay signed in</button>
      </div>`);
    box = document.getElementById("idleWarning");
    box.querySelector("button").addEventListener("click", () => { markActivity(); idleWarning(null); });
  }
  box.querySelector("#idleWarningText").textContent = `You'll be signed out in ${secondsLeft} second${secondsLeft === 1 ? "" : "s"} because there's been no activity.`;
}

function startIdleTimer(minutes) {
  minutes = Number(minutes) || 0;
  if (!minutes) return;
  const limit = minutes * 60 * 1000;
  // Closed the laptop or left the tab longer than the limit: sign out right away
  const stored = Number(localStorage.getItem(ACTIVITY_KEY) || 0);
  if (stored && Date.now() - stored > limit) { logout("idle"); return; }
  markActivity();
  let lastMark = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastMark > 5000) { lastMark = now; markActivity(); }
    idleWarning(null);
  };
  ["pointerdown", "keydown", "scroll", "touchstart", "wheel", "mousemove"].forEach((ev) =>
    document.addEventListener(ev, onActivity, { passive: true, capture: true }));
  const warnBefore = Math.min(60000, Math.max(15000, limit * 0.25));
  let signingOut = false;
  setInterval(() => {
    if (signingOut) return;
    const idle = Date.now() - lastActivity(); // includes activity in other tabs
    if (idle >= limit) { signingOut = true; idleWarning(null); logout("idle"); }
    else if (idle >= limit - warnBefore) idleWarning(Math.ceil((limit - idle) / 1000));
    else idleWarning(null);
  }, 1000);
}

// ---------- One grading assignment per student, per subject, per school year and term ----------
/**
 * Students who already take a subject in a school year (and term), from a list of grading assignments:
 * Map student doc id → the assignment they're in. exceptId = the assignment being edited.
 * term: "" = no term; undefined = any term. A subject can be taken again in another term (a retake).
 */
export function subjectTakers(assignments, subjectId, schoolYear, exceptId = null, term = undefined) {
  const takers = new Map();
  (assignments || []).forEach((a) => {
    if (a.id === exceptId || a.subjectId !== subjectId || a.schoolYear !== schoolYear) return;
    if (term !== undefined && termOf(a) !== term) return;
    (a.studentIds || []).forEach((id) => { if (!takers.has(id)) takers.set(id, a); });
  });
  return takers;
}

/** Subjects a student takes more than once in the same school year and term (data saved before this check). */
export function duplicateEnrollments(assignments) {
  const groups = new Map(); // subject|year → { assignments, count per student }
  (assignments || []).forEach((a) => {
    const key = `${a.subjectId}|${a.schoolYear}|${termOf(a)}`;
    if (!groups.has(key)) groups.set(key, { list: [], seen: new Map() });
    const g = groups.get(key);
    g.list.push(a);
    (a.studentIds || []).forEach((id) => g.seen.set(id, (g.seen.get(id) || 0) + 1));
  });
  const out = [];
  groups.forEach((g) => {
    const twice = [...g.seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
    if (!twice.length) return;
    const involved = g.list.filter((a) => (a.studentIds || []).some((id) => twice.includes(id)));
    out.push({ subjectCode: involved[0].subjectCode, subjectName: involved[0].subjectName, schoolYear: involved[0].schoolYear, term: termOf(involved[0]), studentIds: twice, assignments: involved });
  });
  return out;
}

// ---------- Audit trail: deleting old entries (Setup and options → Audit trail) ----------
/** Deletes audit trail entries older than `days` (0 = all), 300 at a time. Returns how many. */
export async function deleteAuditOlderThan(days) {
  const auditCol = collection(db, "auditLog");
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const parts = [limit(300)];
    if (days > 0) parts.unshift(where("at", "<", Timestamp.fromDate(new Date(Date.now() - days * 86400000))));
    const snap = await getDocs(query(auditCol, ...parts));
    if (!snap.size) break;
    await commitOperations(snap.docs.map((d) => ({ type: "delete", ref: doc(db, "auditLog", d.id) })));
    total += snap.size;
    if (snap.size < 300) break;
  }
  return total;
}

const AUDIT_CLEAN_KEY = "gs-audit-cleaned";
/** Automatic deleting: at most twice a day, when an administrator opens a page. */
async function maybeCleanAudit(options) {
  const days = Number(options && options.auditKeepDays) || 0;
  if (days <= 0) return; // kept until deleted by hand
  try {
    const last = Number(localStorage.getItem(AUDIT_CLEAN_KEY) || 0);
    if (Date.now() - last < 12 * 3600 * 1000) return;
    localStorage.setItem(AUDIT_CLEAN_KEY, String(Date.now()));
  } catch { return; }
  try {
    const n = await deleteAuditOlderThan(days);
    if (n) console.info(`Audit trail: deleted ${n} entries older than ${days} days.`);
  } catch (err) {
    console.warn("Audit trail cleanup:", err.code || err);
  }
}

// ---------- Search pop-up for long dropdowns (teacher, subject, section…) ----------
let pickerModal = null;
function pickerElements() {
  let el = document.getElementById("pickerModal");
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", `
      <div class="modal fade" id="pickerModal" tabindex="-1" aria-labelledby="pickerTitle" aria-hidden="true">
        <div class="modal-dialog modal-dialog-scrollable modal-fullscreen-sm-down">
          <div class="modal-content">
            <div class="modal-header flex-column align-items-stretch gap-2">
              <div class="d-flex align-items-center">
                <h2 class="modal-title fs-5 flex-grow-1" id="pickerTitle">Choose</h2>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
              </div>
              <input type="search" class="form-control" id="pickerSearch" autocomplete="off" spellcheck="false">
              <div class="small text-secondary" id="pickerCount"></div>
            </div>
            <div class="modal-body p-0"><div class="list-group list-group-flush picker-list" id="pickerList" role="listbox"></div></div>
          </div>
        </div>
      </div>`);
    el = document.getElementById("pickerModal");
  }
  if (!pickerModal) pickerModal = bootstrap.Modal.getOrCreateInstance(el);
  return { el, title: el.querySelector("#pickerTitle"), search: el.querySelector("#pickerSearch"), list: el.querySelector("#pickerList"), count: el.querySelector("#pickerCount") };
}

/**
 * Turns a <select> into a button that opens a pop-up with a search box and the list.
 * The select stays (hidden) and keeps its value and "change" events, so page code is unchanged.
 */
export function searchPicker(sel, { title = "Choose", placeholder = "Type to search…" } = {}) {
  if (!sel || sel.dataset.picker) return;
  sel.dataset.picker = "1";
  sel.classList.add("d-none");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "form-select text-start picker-btn";
  btn.setAttribute("aria-haspopup", "dialog");
  sel.insertAdjacentElement("afterend", btn);
  const label = sel.id ? document.querySelector(`label[for="${sel.id}"]`) : null;
  if (label) {
    if (!btn.id) btn.id = `${sel.id}Btn`;
    label.setAttribute("for", btn.id);
  }

  const sync = () => {
    const o = sel.options[sel.selectedIndex];
    btn.textContent = o ? o.textContent : "";
    btn.classList.toggle("picker-empty", !sel.value);
    btn.classList.toggle("is-invalid", sel.classList.contains("is-invalid")); // error shown on the field
    btn.disabled = sel.disabled;
  };
  // Keep the button in step when page code sets .value or rebuilds the options
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
  Object.defineProperty(sel, "value", { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); sync(); } });
  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "class"] });
  sel.addEventListener("change", sync);
  sync();

  btn.addEventListener("click", () => {
    const p = pickerElements();
    const options = [...sel.options].filter((o) => o.value !== "");
    p.title.textContent = title;
    p.search.placeholder = placeholder;
    p.search.value = "";
    const choose = (value) => {
      sel.value = value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      pickerModal.hide();
      btn.focus();
    };
    const draw = () => {
      const term = normalize(p.search.value);
      const shown = options.filter((o) => !term || normalize(o.textContent).includes(term));
      p.count.textContent = term ? `${shown.length} of ${options.length}` : `${options.length} to choose from`;
      p.list.innerHTML = shown.length
        ? shown.map((o) => `<button type="button" role="option" class="list-group-item list-group-item-action${o.value === sel.value ? " active" : ""}" data-value="${escapeHtml(o.value)}" ${o.disabled ? "disabled" : ""}>${escapeHtml(o.textContent)}</button>`).join("")
        : `<div class="p-3 text-secondary small">Nothing matches “${escapeHtml(p.search.value)}”.</div>`;
    };
    p.list.onclick = (e) => { const b = e.target.closest("[data-value]"); if (b && !b.disabled) choose(b.dataset.value); };
    p.search.oninput = draw;
    p.search.onkeydown = (e) => {
      if (e.key === "Enter") { e.preventDefault(); const first = p.list.querySelector("[data-value]:not([disabled])"); if (first) choose(first.dataset.value); }
      if (e.key === "ArrowDown") { e.preventDefault(); const first = p.list.querySelector("[data-value]:not([disabled])"); if (first) first.focus(); }
    };
    draw();
    p.el.addEventListener("shown.bs.modal", () => p.search.focus(), { once: true });
    pickerModal.show();
  });
}
