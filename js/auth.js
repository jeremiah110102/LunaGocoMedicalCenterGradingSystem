// ==========================================================
// auth.js — Sign in with username + password, and first-run
// creation of the administrator account.
// ==========================================================

import {
  db, auth, isConfigured, doc, getDoc, writeBatch, serverTimestamp, databaseBackend,
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
} from "./firebase-config.js";
import {
  rememberUi, loadProfile, authErrorMessage, passwordProblem, setBusy,
  clearErrors, fieldError, errorMessage, USERNAME_PATTERN, cleanUsername, usernameEmail,
  getSchool, cachedSchool, applyBranding, escapeHtml,
  getSecurity, claimSession, mySession, confirmDialog, timeAgo, autoLogoutLabel,
} from "./app.js";

const els = {
  loading: document.getElementById("loadingState"),
  reason: document.getElementById("reasonAlert"),
  configAlert: document.getElementById("config-alert"),
  signinForm: document.getElementById("signinForm"),
  signinError: document.getElementById("signinError"),
  username: document.getElementById("loginUsername"),
  password: document.getElementById("loginPassword"),
  btnSignin: document.getElementById("btnSignin"),
  setupForm: document.getElementById("setupForm"),
  setupError: document.getElementById("setupError"),
  setupName: document.getElementById("setupName"),
  setupUsername: document.getElementById("setupUsername"),
  setupPassword: document.getElementById("setupPassword"),
  setupConfirm: document.getElementById("setupConfirm"),
  btnSetup: document.getElementById("btnSetup"),
};

const REASONS = {
  disabled: "This account is disabled. Ask an administrator to turn it back on.",
  noprofile: "This account has been removed. Ask an administrator for access.",
  elsewhere: "You were signed out because your account was opened on another device.",
  idle: "You were signed out because there was no activity for a while.",
};

function destination() {
  const next = new URLSearchParams(location.search).get("next") || "";
  // Only allow our own page names
  return /^[a-z-]+\.html$/.test(next) && next !== "login.html" ? next : "dashboard.html";
}

function show(which) {
  els.loading.classList.add("d-none");
  els.signinForm.classList.toggle("d-none", which !== "signin");
  els.setupForm.classList.toggle("d-none", which !== "setup");
  const focus = which === "signin" ? els.username : els.setupName;
  focus?.focus();
}

function showError(box, message) {
  box.textContent = message;
  box.classList.remove("d-none");
}

function firstAuthState() {
  return new Promise((resolve) => {
    const stop = onAuthStateChanged(auth, (u) => { stop(); resolve(u); });
  });
}

// ---------- Sign in ----------
async function signin(e) {
  e.preventDefault();
  clearErrors(els.signinForm);
  els.signinError.classList.add("d-none");

  const username = cleanUsername(els.username.value);
  const password = els.password.value;
  let ok = true;
  if (!username) { fieldError(els.username, "Enter your username."); ok = false; }
  if (!password) { fieldError(els.password, "Enter your password."); ok = false; }
  if (!ok) return;

  setBusy(els.btnSignin, true, "Signing in…");
  try {
    const lookup = await getDoc(doc(db, "usernames", username));
    if (!lookup.exists()) {
      showError(els.signinError, "Incorrect username or password.");
      return;
    }
    const cred = await signInWithEmailAndPassword(auth, lookup.data().authEmail, password);
    const profile = await loadProfile(cred.user.uid);
    if (!profile || profile.active === false) {
      await signOut(auth);
      showError(els.signinError, profile ? REASONS.disabled : REASONS.noprofile);
      return;
    }
    // One device at a time: ask before signing out the other device
    const security = await getSecurity(true);
    if (security.singleSession) {
      const other = profile.activeSession;
      if (other && other.id && other.id !== mySession(cred.user.uid)) {
        const ok = await confirmDialog({
          title: "Your account is open on another device",
          message: `It's signed in on ${other.device || "another device"}${other.at ? `, ${timeAgo(other.at)}` : ""}. ` +
            "Sign out the other device and continue here?",
          confirmText: "Sign out the other device and continue",
          variant: "primary",
        });
        if (!ok) {
          await signOut(auth);
          showError(els.signinError, "Sign-in cancelled. Your account stays open on the other device.");
          return;
        }
      }
      await claimSession(cred.user.uid);
    }
    rememberUi(profile);
    location.replace(destination());
  } catch (err) {
    showError(els.signinError, authErrorMessage(err));
  } finally {
    setBusy(els.btnSignin, false);
  }
}

// ---------- First administrator ----------
async function setup(e) {
  e.preventDefault();
  clearErrors(els.setupForm);
  els.setupError.classList.add("d-none");

  const displayName = els.setupName.value.trim().replace(/\s+/g, " ");
  const username = cleanUsername(els.setupUsername.value);
  const password = els.setupPassword.value;
  let ok = true;
  if (!displayName) { fieldError(els.setupName, "Enter your full name."); ok = false; }
  if (!USERNAME_PATTERN.test(username)) { fieldError(els.setupUsername, "Use 3 to 30 lowercase letters, numbers, dot, dash or underscore."); ok = false; }
  const pwProblem = passwordProblem(password);
  if (pwProblem) { fieldError(els.setupPassword, pwProblem); ok = false; }
  if (els.setupConfirm.value !== password) { fieldError(els.setupConfirm, "Passwords don't match."); ok = false; }
  if (!ok) return;

  setBusy(els.btnSetup, true, "Creating account…");
  const authEmail = usernameEmail(username);
  try {
    let cred;
    try {
      cred = await createUserWithEmailAndPassword(auth, authEmail, password);
    } catch (err) {
      // A previous attempt may have created the login but not the profile
      if (err.code === "auth/email-already-in-use") cred = await signInWithEmailAndPassword(auth, authEmail, password);
      else throw err;
    }
    const uid = cred.user.uid;
    const profile = {
      username,
      displayName,
      role: "admin",
      canApprove: true,
      teacherDocId: null,
      active: true,
      authEmail,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "meta", "setup"), { adminUid: uid, createdAt: serverTimestamp() });
    batch.set(doc(db, "users", uid), profile);
    batch.set(doc(db, "usernames", username), { uid, authEmail });
    await batch.commit();

    rememberUi(profile);
    location.replace("dashboard.html");
  } catch (err) {
    await signOut(auth).catch(() => {});
    if (err.code === "permission-denied") {
      // Find out which: setup already done, or the database didn't accept this sign-in
      let done = false;
      try { done = (await getDoc(doc(db, "meta", "setup"))).exists(); } catch {}
      showError(els.setupError, done
        ? "Setup was already completed. Reload the page and sign in with the administrator account."
        : `The database refused to create the administrator: ${err.message || err.code}. ` +
          (databaseBackend === "sheets"
            ? "With the Google Sheets database, run Test on the connection screen (Connection settings below) to see what to fix."
            : databaseBackend === "supabase"
            ? "With the Supabase database, check that supabase/schema.sql was run and Firebase is added under Authentication → Third-party Auth in Supabase."
            : "Check that firestore.rules is published in Firebase Console → Firestore Database → Rules."));
    } else if (err.code && !String(err.code).startsWith("auth/")) {
      // Database problems (e.g. the Google Sheet's script) come with their own explanation
      showError(els.setupError, err.message || errorMessage(err));
    } else {
      showError(els.setupError, authErrorMessage(err));
    }
  } finally {
    setBusy(els.btnSetup, false);
  }
}

// ---------- Show / hide password ----------
document.querySelectorAll("[data-toggle-pw]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.togglePw);
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    btn.innerHTML = `<i class="bi ${showing ? "bi-eye" : "bi-eye-slash"}"></i>`;
    btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  });
});

// ---------- Start ----------
async function init() {
  if (!isConfigured) {
    location.replace("setup.html");
    return;
  }

  const reason = new URLSearchParams(location.search).get("reason");
  if (REASONS[reason]) {
    els.reason.textContent = REASONS[reason];
    els.reason.classList.remove("d-none");
  }

  // Already signed in? Go straight in.
  const user = await firstAuthState();
  if (user) {
    try {
      const profile = await loadProfile(user.uid);
      if (profile && profile.active !== false) {
        rememberUi(profile);
        location.replace(destination());
        return;
      }
    } catch (err) {
      console.error(err);
    }
    await signOut(auth);
  }

  try {
    const setupDone = (await getDoc(doc(db, "meta", "setup"))).exists();
    show(setupDone ? "signin" : "setup");
  } catch (err) {
    show("signin");
    showError(els.signinError, errorMessage(err));
  }
}

// School name and logo (settings/school is readable before sign-in)
function showSchool(s) {
  applyBranding(s);
  const el = document.getElementById("loginSchool");
  if (el && s.schoolName) {
    el.innerHTML = `<strong>${escapeHtml(s.schoolName)}</strong>${s.address ? `<br>${escapeHtml(s.address)}` : ""}`;
  }
}
showSchool(cachedSchool());
if (isConfigured) getSchool().then(showSchool);

els.signinForm.addEventListener("submit", signin);
els.setupForm.addEventListener("submit", setup);
init();
