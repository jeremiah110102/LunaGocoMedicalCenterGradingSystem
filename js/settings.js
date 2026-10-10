// ==========================================================
// settings.js — School details (document: settings/school)
// Used by the sidebar, sign-in page, printed and emailed reports.
// ==========================================================

import {
  db, auth, doc, getDoc, setDoc, serverTimestamp, firebaseConfig, connectionSource,
  connectionConfig, databaseBackend, sheetsDatabaseUrl, BACKENDS, isSheetsDatabaseUrl,
  supabaseUrl, supabaseKey, isSupabaseUrl,
  schoolChoice, schoolChoiceStatus, saveSchoolChoice, readSchoolHistory, refreshSchoolChoice,
  addSchoolAdmins, isSchoolAdmin,
  collection, getDocs, query, where, Timestamp,
  reauthenticateWithCredential, EmailAuthProvider,
} from "./firebase-config.js";
import { grantUnlock, clearUnlock, testConnection } from "./connection.js";
import { SHEETS_SETTINGS, loadSheetsSettings, testSheets, isAppsScriptUrl } from "./sheets-sync.js";
import { supabaseKeyProblem, supabaseRequest, cleanSupabaseUrl } from "./supabase-db.js";
import {
  initLayout, toast, setBusy, errorMessage, clearErrors, fieldError, isValidEmail, logout, confirmDialog,
  getSecurity, rememberSecurity, AUTO_LOGOUT_CHOICES, autoLogoutLabel,
  getSchool, rememberSchool, letterheadHtml, signatureHtml, DEFAULT_SCHOOL, timeAgo,
  getDowntime, downtimeActive, downtimeText, toDate,
} from "./app.js";

// Small enough for a Firestore document and for one Excel cell in backups (max 32,767 characters)
const MAX_LOGO_CHARS = 30000;
const LOGO_SIZE = 160;

const els = {
  form: document.getElementById("settingsForm"),
  error: document.getElementById("settingsError"),
  saved: document.getElementById("settingsSaved"),
  btnSave: document.getElementById("btnSaveSettings"),
  name: document.getElementById("sName"),
  short: document.getElementById("sShort"),
  address: document.getElementById("sAddress"),
  phone: document.getElementById("sPhone"),
  email: document.getElementById("sEmail"),
  website: document.getElementById("sWebsite"),
  registrar: document.getElementById("sRegistrar"),
  registrarTitle: document.getElementById("sRegistrarTitle"),
  logoInput: document.getElementById("sLogo"),
  logoBox: document.getElementById("logoBox"),
  btnRemoveLogo: document.getElementById("btnRemoveLogo"),
  preview: document.getElementById("letterheadPreview"),
};

let logo = "";

function readForm() {
  return {
    schoolName: els.name.value.trim().replace(/\s+/g, " "),
    shortName: els.short.value.trim(),
    address: els.address.value.trim(),
    phone: els.phone.value.trim(),
    email: els.email.value.trim().toLowerCase(),
    website: els.website.value.trim(),
    registrarName: els.registrar.value.trim(),
    registrarTitle: els.registrarTitle.value.trim(),
    logo,
  };
}

function fillForm(s) {
  els.name.value = s.schoolName;
  els.short.value = s.shortName;
  els.address.value = s.address;
  els.phone.value = s.phone;
  els.email.value = s.email;
  els.website.value = s.website;
  els.registrar.value = s.registrarName;
  els.registrarTitle.value = s.registrarTitle;
  logo = s.logo || "";
  if (s.updatedAt) els.saved.textContent = `Last saved ${timeAgo(s.updatedAt)}${s.updatedByName ? ` by ${s.updatedByName}` : ""}`;
  renderLogo();
  renderPreview();
}

function renderLogo() {
  els.logoBox.innerHTML = logo ? `<img src="${logo}" alt="School logo">` : `<i class="bi bi-image text-secondary"></i>`;
  els.btnRemoveLogo.classList.toggle("d-none", !logo);
}

function renderPreview() {
  const s = readForm();
  els.preview.innerHTML = `
    ${letterheadHtml(s)}
    <div class="letterhead-sample">
      <div class="fw-semibold">Report of final grades</div>
      <div class="small text-secondary mb-3">School year 2026-2027</div>
      <div class="sample-lines"><span></span><span></span><span></span></div>
    </div>
    ${signatureHtml(s) || `<div class="small text-secondary mt-3">Add the registrar's name to print a signature line.</div>`}`;
}

// Resize the logo in the browser so it stays small
function processLogo(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error("Choose an image file (PNG, JPG or WEBP)."));
    if (file.size > 5 * 1024 * 1024) return reject(new Error("That image is larger than 5 MB. Choose a smaller one."));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, LOGO_SIZE / Math.max(img.width || LOGO_SIZE, img.height || LOGO_SIZE));
      const w = Math.max(1, Math.round((img.width || LOGO_SIZE) * scale));
      const h = Math.max(1, Math.round((img.height || LOGO_SIZE) * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      // Try formats from best-looking to smallest
      const attempts = [
        () => canvas.toDataURL("image/png"),
        () => canvas.toDataURL("image/webp", 0.9),
        () => canvas.toDataURL("image/webp", 0.75),
        () => {
          const c2 = document.createElement("canvas");
          c2.width = w; c2.height = h;
          const x = c2.getContext("2d");
          x.fillStyle = "#ffffff"; x.fillRect(0, 0, w, h); x.drawImage(canvas, 0, 0);
          return c2.toDataURL("image/jpeg", 0.8);
        },
      ];
      for (const attempt of attempts) {
        const data = attempt();
        if (data.length <= MAX_LOGO_CHARS && data.startsWith("data:image/")) return resolve(data);
      }
      reject(new Error("This logo is too detailed to store. Try a simpler image or one with fewer colors."));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Couldn't read that image."));
    };
    img.src = url;
  });
}

async function onLogoChange() {
  const file = els.logoInput.files[0];
  if (!file) return;
  try {
    logo = await processLogo(file);
    renderLogo();
    renderPreview();
  } catch (err) {
    toast(err.message, "warning");
  } finally {
    els.logoInput.value = "";
  }
}

async function save(e, me) {
  e.preventDefault();
  clearErrors(els.form);
  els.error.classList.add("d-none");
  const data = readForm();
  let ok = true;
  if (!data.schoolName) { fieldError(els.name, "Enter the school name."); ok = false; }
  if (data.email && !isValidEmail(data.email)) { fieldError(els.email, "Enter a valid email address, or leave it empty."); ok = false; }
  if (!ok) return;

  setBusy(els.btnSave, true);
  try {
    await setDoc(doc(db, "settings", "school"), {
      ...data,
      updatedAt: serverTimestamp(),
      updatedByName: me.displayName || me.username,
    });
    rememberSchool(data);
    els.saved.textContent = "Saved just now";
    toast("School settings saved.");
  } catch (err) {
    els.error.textContent = errorMessage(err);
    els.error.classList.remove("d-none");
  } finally {
    setBusy(els.btnSave, false);
  }
}

async function init(me) {
  fillForm({ ...DEFAULT_SCHOOL, ...(await getSchool(true)) });
  els.form.addEventListener("input", renderPreview);
  els.form.addEventListener("submit", (e) => save(e, me));
  els.logoInput.addEventListener("change", onLogoChange);
  els.btnRemoveLogo.addEventListener("click", () => {
    logo = "";
    renderLogo();
    renderPreview();
  });
}

// ==========================================================
// Protected settings: Firebase connection and EmailJS keys.
// Unlocked for 10 minutes after the administrator re-enters their password.
// ==========================================================
const UNLOCK_MS = 10 * 60 * 1000;
let unlockTimer = null;
let unlockModal;
let emailCfg = { publicKey: "", serviceId: "", templateId: "" };
let sheetsCfg = {};

const sec = {
  unlockModalEl: document.getElementById("unlockModal"),
  unlockForm: document.getElementById("unlockForm"),
  unlockPassword: document.getElementById("unlockPassword"),
  btnUnlock: document.getElementById("btnUnlock"),
  connFacts: document.getElementById("connFacts"),
  emailStatus: document.getElementById("emailStatus"),
  emailForm: document.getElementById("emailSettingsForm"),
  emailError: document.getElementById("emailSettingsError"),
  ejPublicKey: document.getElementById("ejPublicKey"),
  ejServiceId: document.getElementById("ejServiceId"),
  ejTemplateId: document.getElementById("ejTemplateId"),
  btnSaveEmail: document.getElementById("btnSaveEmail"),
  sheetsStatus: document.getElementById("sheetsStatus"),
  sheetsForm: document.getElementById("sheetsForm"),
  sheetsError: document.getElementById("sheetsError"),
  sheetsTest: document.getElementById("sheetsTestResult"),
  sheetsUrl: document.getElementById("sheetsUrl"),
  sheetsKey: document.getElementById("sheetsKey"),
  sheetsAuto: document.getElementById("sheetsAuto"),
  btnSheetsTest: document.getElementById("btnSheetsTest"),
  btnSheetsSave: document.getElementById("btnSheetsSave"),
  sheetsOpen: document.getElementById("sheetsOpen"),
};

function setLocked(locked) {
  document.querySelectorAll("[data-locked]").forEach((el) => el.classList.toggle("d-none", !locked));
  document.querySelectorAll("[data-unlocked]").forEach((el) => el.classList.toggle("d-none", locked));
  document.querySelectorAll(".lock-badge").forEach((b) => {
    b.className = `badge lock-badge ${locked ? "badge-none" : "badge-pass"}`;
    b.innerHTML = locked ? `<i class="bi bi-lock me-1"></i>Locked` : `<i class="bi bi-unlock me-1"></i>Unlocked`;
  });
  if (locked) {
    clearUnlock();
    if (unlockTimer) clearTimeout(unlockTimer);
  }
}

// ---------- School database ----------
function renderConnection() {
  const c = connectionConfig || firebaseConfig;
  const facts = [
    ["Firebase project", `${escapeAttr(c.projectId)} <span class="small text-secondary d-block">built into the website (sign-in)</span>`],
    ["Records kept in", `${BACKENDS[databaseBackend]}${databaseBackend === "supabase" ? ` <span class="small text-secondary d-block">${escapeAttr(supabaseUrl)}</span>` : ""}`],
    ["Used by", "Every account and device"],
  ];
  if (schoolChoice && schoolChoice.updatedAt) {
    facts.push(["Last changed", `${escapeAttr(new Date(schoolChoice.updatedAt).toLocaleString())}${schoolChoice.updatedBy ? ` by ${escapeAttr(schoolChoice.updatedBy)}` : ""}`]);
  }
  document.getElementById("connFacts").innerHTML = facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
}

/** Connected / Disconnected / Configuration error, with the reason. */
export function databaseStatus(choiceStatus, test) {
  if (choiceStatus === "not-configured") return { label: "Configuration error", cls: "badge-fail", why: "The school's Firebase connection isn't written into the website yet." };
  if (!test) return { label: "Checking…", cls: "badge-none", why: "" };
  if (test.ok) {
    const note = choiceStatus === "unreachable" ? " (The school's choice couldn't be read, so this device used the website's default. Check that firestore.rules is published.)" : "";
    return { label: "Connected", cls: "badge-pass", why: test.message + note };
  }
  const offline = /couldn't reach|can't reach|network|internet|timed out|failed to fetch/i.test(test.message || "");
  return { label: offline ? "Disconnected" : "Configuration error", cls: "badge-fail", why: test.message };
}

function showDbStatus(st) {
  const b = document.getElementById("dbStatus");
  b.className = `badge ${st.cls}`;
  b.textContent = st.label;
  document.getElementById("dbStatusMsg").innerHTML = st.why ? `<span class="${st.cls === "badge-pass" ? "text-success" : "text-danger"}">${st.why}</span>` : "";
}

async function checkDatabase() {
  const btn = document.getElementById("btnDbCheck");
  showDbStatus(databaseStatus(schoolChoiceStatus, null));
  if (!connectionConfig) return showDbStatus(databaseStatus("not-configured", null));
  setBusy(btn, true, "Testing…");
  try { showDbStatus(databaseStatus(schoolChoiceStatus, await testConnection(withSignIn(connectionConfig)))); }
  catch (err) { showDbStatus(databaseStatus(schoolChoiceStatus, { ok: false, message: errorMessage(err) })); }
  finally { setBusy(btn, false); }
}

function describeChoice(x) {
  if (!x) return "—";
  if (x.backend === "sheets") return `Google Sheet ${x.sheet || ""}`.trim();
  if (x.backend === "supabase") return `Supabase ${x.sheet || ""}`.trim();
  return "Firebase Firestore";
}

async function loadDbHistory() {
  const body = document.getElementById("dbHistory");
  try {
    const rows = await readSchoolHistory();
    body.innerHTML = rows.length
      ? rows.map((h) => `<tr>
          <td class="small">${escapeAttr(h.at && h.at.toDate ? h.at.toDate().toLocaleString() : "—")}</td>
          <td class="small">${escapeAttr(h.byName || "—")}</td>
          <td class="small">${h.from ? `${escapeAttr(describeChoice(h.from))} → ` : "Set to "}<strong>${escapeAttr(describeChoice(h.to))}</strong>${h.reason ? `<div class="text-secondary">${escapeAttr(h.reason)}</div>` : ""}</td>
        </tr>`).join("")
      : `<tr><td colspan="3" class="text-secondary small">No changes recorded yet.</td></tr>`;
  } catch (err) {
    body.innerHTML = `<tr><td colspan="3" class="text-secondary small">History unavailable (${escapeAttr(err.code || err.message)}). Publish the latest firestore.rules.</td></tr>`;
  }
}

/** Adds the current database's administrators to the allowed list (silently; allowed admins only). */
async function syncSchoolAdmins(me) {
  const uid = auth.currentUser && auth.currentUser.uid;
  if (!uid || me.role !== "admin" || schoolChoiceStatus !== "ok") return;
  if (!isSchoolAdmin(uid) && databaseBackend !== "firestore") return; // can't add itself; see notAllowedMessage
  try {
    const n = await addSchoolAdmins([uid, ...await currentAdminUids()]);
    if (n) console.info(`Allowed ${n} more administrator(s) to change the school's database.`);
  } catch (err) {
    console.warn("Couldn't update the list of allowed administrators:", err.code || err);
  }
}

/** Administrators listed in a Google Sheet database (read with this person's sign-in). */
async function sheetAdminUids(url) {
  try {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const res = await fetch(url, {
      method: "POST", redirect: "follow",
      body: JSON.stringify({ action: "adminUids", token, origin: location.origin }),
    });
    const data = JSON.parse(await res.text());
    return data.ok && Array.isArray(data.uids) ? data.uids : [];
  } catch {
    return [];
  }
}

/** Administrators listed in a Supabase database (read with this person's sign-in). */
async function supabaseAdminUids(cfg) {
  try {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
    const data = await supabaseRequest({ url: cfg.supabaseUrl, key: cfg.supabaseKey }, { action: "adminUids" }, token);
    return Array.isArray(data.uids) ? data.uids : [];
  } catch {
    return [];
  }
}

/** The connection plus this person's sign-in, so tests can check that the database accepts it. */
function withSignIn(cfg) {
  return { ...cfg, getToken: () => (auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null)) };
}

/** A clear explanation when the school's database can't be changed by this account. */
function notAllowedMessage(err) {
  const uid = auth.currentUser ? auth.currentUser.uid : "?";
  if (err && err.code === "permission-denied") {
    return `This account isn't on the list of administrators allowed to change the school's database (account ID ${uid}). ` +
      "Sign in with an administrator who changed it before, or in Firebase Console → Firestore Database → settings → connection, " +
      "add this ID to adminUids (or delete that document; the next administrator sign-in records the school's database again).";
  }
  return `Couldn't save the school's database (${(err && (err.code || err.message)) || "unknown error"}). Check that the latest firestore.rules is published.`;
}

/** Administrators of the current database (allowed to change the school's database). */
async function currentAdminUids() {
  try {
    const snap = await getDocs(query(collection(db, "users"), where("role", "==", "admin")));
    return snap.docs.filter((d) => d.data().active !== false).map((d) => d.id);
  } catch {
    return [];
  }
}

function escapeAttr(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderEmailStatus() {
  const on = emailCfg.publicKey && emailCfg.serviceId && emailCfg.templateId;
  sec.emailStatus.className = `badge ${on ? "badge-pass" : "badge-none"}`;
  sec.emailStatus.textContent = on ? "Direct sending on" : "Direct sending off";
}

async function loadEmailSettings() {
  try {
    const snap = await getDoc(doc(db, "settings", "email"));
    if (snap.exists()) emailCfg = { ...emailCfg, ...snap.data() };
  } catch (err) {
    console.warn("Email settings:", err.code || err);
  }
  renderEmailStatus();
}

async function unlock(e) {
  e.preventDefault();
  clearErrors(sec.unlockForm);
  const pw = sec.unlockPassword.value;
  if (!pw) { fieldError(sec.unlockPassword, "Enter your password."); return; }
  setBusy(sec.btnUnlock, true, "Checking…");
  try {
    const user = auth.currentUser;
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, pw));
    unlockModal.hide();
    grantUnlock(); // lets "Change connection" skip the second password prompt
    sec.ejPublicKey.value = emailCfg.publicKey || "";
    sec.ejServiceId.value = emailCfg.serviceId || "";
    sec.ejTemplateId.value = emailCfg.templateId || "";
    sec.sheetsUrl.value = sheetsCfg.url || "";
    sec.sheetsKey.value = sheetsCfg.key || "";
    sec.sheetsAuto.checked = !!sheetsCfg.autoSync;
    sec.sheetsTest.classList.add("d-none");
    setLocked(false);
    unlockTimer = setTimeout(() => { setLocked(true); toast("Protected settings locked again.", "info"); }, UNLOCK_MS);
  } catch (err) {
    const wrong = ["auth/wrong-password", "auth/invalid-credential", "auth/invalid-login-credentials"].includes(err.code);
    fieldError(sec.unlockPassword, wrong ? "That password is incorrect." : (err.code === "auth/too-many-requests" ? "Too many attempts. Wait a few minutes." : errorMessage(err)));
  } finally {
    setBusy(sec.btnUnlock, false);
  }
}

async function saveEmail(e, me) {
  e.preventDefault();
  sec.emailError.classList.add("d-none");
  const data = {
    publicKey: sec.ejPublicKey.value.trim(),
    serviceId: sec.ejServiceId.value.trim(),
    templateId: sec.ejTemplateId.value.trim(),
  };
  const filled = Object.values(data).filter(Boolean).length;
  if (filled > 0 && filled < 3) {
    sec.emailError.textContent = "Fill in all three values, or clear all three to turn direct sending off.";
    sec.emailError.classList.remove("d-none");
    return;
  }
  setBusy(sec.btnSaveEmail, true);
  try {
    await setDoc(doc(db, "settings", "email"), { ...data, updatedAt: serverTimestamp(), updatedByName: me.displayName || me.username });
    emailCfg = data;
    renderEmailStatus();
    toast(filled ? "Email settings saved. Reports can now be sent directly." : "Direct email sending turned off.");
  } catch (err) {
    sec.emailError.textContent = errorMessage(err);
    sec.emailError.classList.remove("d-none");
  } finally {
    setBusy(sec.btnSaveEmail, false);
  }
}

// ---------- Database: Firebase or a Google Sheet ----------
const dbEls = {
  current: document.getElementById("dbCurrent"),
  btnUseSheets: document.getElementById("btnUseSheets"),
  btnUseFirestore: document.getElementById("btnUseFirestore"),
  modalEl: document.getElementById("dbModal"),
  form: document.getElementById("dbForm"),
  url: document.getElementById("dbSheetsUrl"),
  result: document.getElementById("dbTestResult"),
  btnTest: document.getElementById("btnDbTest"),
  btnSwitch: document.getElementById("btnDbSwitch"),
};
let dbModal;
let currentAdminName = "";

function renderDatabase() {
  const sheets = databaseBackend === "sheets";
  const supa = databaseBackend === "supabase";
  dbEls.current.textContent = BACKENDS[databaseBackend] || BACKENDS.firestore;
  dbEls.btnUseSheets.innerHTML = sheets
    ? '<i class="bi bi-table me-1"></i>Change Google Sheet…'
    : '<i class="bi bi-table me-1"></i>Use Google Sheet…';
  supaEls.btnUse.innerHTML = supa
    ? '<i class="bi bi-lightning-charge me-1"></i>Change Supabase project…'
    : '<i class="bi bi-lightning-charge me-1"></i>Use Supabase…';
  dbEls.btnUseFirestore.classList.toggle("d-none", databaseBackend === "firestore");
}

function dbResult(level, text) {
  const icon = { ok: "bi-check-circle", warning: "bi-exclamation-triangle", error: "bi-x-circle", info: "bi-info-circle" }[level];
  dbEls.result.className = `test-result ${level} mb-3`;
  dbEls.result.innerHTML = `<i class="bi ${icon} me-2"></i><span>${escapeAttr(text)}</span>`;
}

/** Checks the pasted link; returns the connection to save, or null. */
async function checkSheetsUrl() {
  clearErrors(dbEls.form);
  const url = dbEls.url.value.trim();
  if (/docs\.google\.com\/spreadsheets/i.test(url)) {
    fieldError(dbEls.url, "That's the Sheet's normal address. The system needs the Web app URL from Extensions → Apps Script → Deploy (it ends with /exec).");
    return null;
  }
  if (!isSheetsDatabaseUrl(url)) {
    fieldError(dbEls.url, "Paste the Web app URL: it starts with https://script.google.com/macros/s/ and ends with /exec.");
    return null;
  }
  const cfg = { ...(connectionConfig || firebaseConfig), backend: "sheets", sheetsUrl: url };
  dbResult("info", "Contacting your Google Sheet…");
  const r = await testConnection(cfg);
  dbResult(r.level, r.message);
  return r.ok ? cfg : null;
}

async function testSheetsUrl() {
  setBusy(dbEls.btnTest, true, "Testing…");
  try { await checkSheetsUrl(); } finally { setBusy(dbEls.btnTest, false); }
}

async function switchToSheets(e) {
  e.preventDefault();
  setBusy(dbEls.btnSwitch, true, "Checking…");
  try {
    const cfg = await checkSheetsUrl();
    if (!cfg) return;
    try {
      await saveSchoolChoice({
        backend: "sheets", sheetsUrl: cfg.sheetsUrl, byName: currentAdminName,
        // Firebase can't see roles inside a Sheet: remember this Sheet's administrators too
        adminUids: [...await currentAdminUids(), ...await sheetAdminUids(cfg.sheetsUrl)],
        reason: "Switched to a Google Sheet",
      });
    } catch (err) {
      dbResult("error", notAllowedMessage(err));
      return;
    }
    refreshSchoolChoice();
    ["gs-role", "gs-name", "gs-school", "gs-school-full"].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    toast("The whole school now uses the Google Sheet. Every device follows automatically. Sign in again.");
    setTimeout(() => logout(), 1200);
  } finally {
    setBusy(dbEls.btnSwitch, false);
  }
}

// ---------- Database: Supabase ----------
const supaEls = {
  btnUse: document.getElementById("btnUseSupabase"),
  modalEl: document.getElementById("supaModal"),
  form: document.getElementById("supaForm"),
  url: document.getElementById("supaUrl"),
  key: document.getElementById("supaKey"),
  result: document.getElementById("supaTestResult"),
  btnTest: document.getElementById("btnSupaTest"),
  btnSwitch: document.getElementById("btnSupaSwitch"),
};
let supaModal;

function supaResult(level, text) {
  const icon = { ok: "bi-check-circle", warning: "bi-exclamation-triangle", error: "bi-x-circle", info: "bi-info-circle" }[level];
  supaEls.result.className = `test-result ${level} mb-3`;
  supaEls.result.innerHTML = `<i class="bi ${icon} me-2"></i><span>${escapeAttr(text)}</span>`;
}

/** Checks the pasted Project URL and key; returns the connection to save, or null. */
async function checkSupabase() {
  clearErrors(supaEls.form);
  const url = cleanSupabaseUrl(supaEls.url.value);
  const key = supaEls.key.value.trim();
  let bad = false;
  if (!isSupabaseUrl(url)) {
    fieldError(supaEls.url, "Paste the Project URL, like https://abcdefgh.supabase.co (no path after it).");
    bad = true;
  }
  const keyProblem = supabaseKeyProblem(key);
  if (keyProblem) {
    fieldError(supaEls.key, keyProblem);
    bad = true;
  }
  if (bad) return null;
  const cfg = { ...(connectionConfig || firebaseConfig), backend: "supabase", supabaseUrl: url, supabaseKey: key };
  supaResult("info", "Contacting Supabase…");
  const r = await testConnection(withSignIn(cfg));
  supaResult(r.level, r.message);
  return r.ok ? cfg : null;
}

async function testSupabase() {
  setBusy(supaEls.btnTest, true, "Testing…");
  try { await checkSupabase(); } finally { setBusy(supaEls.btnTest, false); }
}

async function switchToSupabase(e) {
  e.preventDefault();
  setBusy(supaEls.btnSwitch, true, "Checking…");
  try {
    const cfg = await checkSupabase();
    if (!cfg) return;
    try {
      await saveSchoolChoice({
        backend: "supabase", supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey, byName: currentAdminName,
        // Firebase can't see roles inside Supabase: remember its administrators too
        adminUids: [...await currentAdminUids(), ...await supabaseAdminUids(cfg)],
        reason: "Switched to Supabase",
      });
    } catch (err) {
      supaResult("error", notAllowedMessage(err));
      return;
    }
    refreshSchoolChoice();
    ["gs-role", "gs-name", "gs-school", "gs-school-full"].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
    toast("The whole school now uses Supabase. Every device follows automatically. Sign in again.");
    setTimeout(() => logout(), 1200);
  } finally {
    setBusy(supaEls.btnSwitch, false);
  }
}

async function switchToFirestore() {
  const ok = await confirmDialog({
    title: "Switch the school back to Firebase?",
    message: `Every account and device will read and save records in Firebase Firestore again (they follow automatically). Records saved only in ${databaseBackend === "supabase" ? "Supabase" : "the Google Sheet"} won't appear there until you import a backup. You'll be signed out.`,
    confirmText: "Switch to Firebase",
    variant: "primary",
  });
  if (!ok) return;
  try {
    await saveSchoolChoice({ backend: "firestore", byName: currentAdminName, adminUids: await currentAdminUids(), reason: "Switched back to Firebase Firestore" });
  } catch (err) {
    toast(notAllowedMessage(err), "danger");
    return;
  }
  refreshSchoolChoice();
  ["gs-role", "gs-name", "gs-school", "gs-school-full"].forEach((k) => { try { localStorage.removeItem(k); } catch {} });
  toast("The whole school now uses Firebase. Every device follows automatically. Sign in again.");
  setTimeout(() => logout(), 900);
}

// ---------- Google Sheets copy ----------
function renderSheetsStatus() {
  const on = sheetsCfg.url && sheetsCfg.key;
  const last = sheetsCfg.lastSyncAt?.toDate ? sheetsCfg.lastSyncAt.toDate() : null;
  sec.sheetsStatus.className = `badge ${on ? "badge-pass" : "badge-none"}`;
  sec.sheetsStatus.textContent = on ? (last ? `Last copy ${timeAgo(last)}` : "Set up, not copied yet") : "Not set up";
  sec.sheetsOpen.classList.toggle("d-none", !sheetsCfg.sheetUrl);
  if (sheetsCfg.sheetUrl) sec.sheetsOpen.href = sheetsCfg.sheetUrl;
}

async function loadSheets() {
  try { sheetsCfg = await loadSheetsSettings(); } catch (err) { console.warn("Sheets settings:", err.code || err); }
  renderSheetsStatus();
}

function sheetsResult(level, text) {
  const icon = { ok: "bi-check-circle", error: "bi-x-circle", info: "bi-info-circle" }[level];
  sec.sheetsTest.className = `test-result ${level} mb-3`;
  sec.sheetsTest.innerHTML = `<i class="bi ${icon} me-2"></i><span>${escapeAttr(text)}</span>`;
}

async function testSheetsSettings() {
  sec.sheetsError.classList.add("d-none");
  setBusy(sec.btnSheetsTest, true, "Testing…");
  sheetsResult("info", "Contacting your Google Sheet…");
  try {
    const r = await testSheets({ url: sec.sheetsUrl.value, key: sec.sheetsKey.value.trim() });
    sheetsResult("ok", `Connected to the Google Sheet "${r.name}". Click Save.`);
    sheetsCfg.sheetUrl = r.url;
    return r;
  } catch (err) {
    sheetsResult("error", err.message);
    return null;
  } finally {
    setBusy(sec.btnSheetsTest, false);
  }
}

async function saveSheets(e, me) {
  e.preventDefault();
  sec.sheetsError.classList.add("d-none");
  const url = sec.sheetsUrl.value.trim();
  const key = sec.sheetsKey.value.trim();
  if ((url || key) && !(url && key)) {
    sec.sheetsError.textContent = "Fill in both the Web app URL and the sync key, or clear both to turn the copy off.";
    sec.sheetsError.classList.remove("d-none");
    return;
  }
  if (url && !isAppsScriptUrl(url)) {
    sec.sheetsError.textContent = "The Web app URL should start with https://script.google.com/macros/s/ and end with /exec.";
    sec.sheetsError.classList.remove("d-none");
    return;
  }
  setBusy(sec.btnSheetsSave, true);
  try {
    if (url) {
      const ok = await testSheetsSettings(); // only save settings that work
      if (!ok) return;
    }
    const data = {
      ...sheetsCfg,
      url, key,
      autoSync: url ? sec.sheetsAuto.checked : false,
      updatedAt: serverTimestamp(),
      updatedByName: me.displayName || me.username,
    };
    if (!url) { data.sheetUrl = ""; }
    await setDoc(SHEETS_SETTINGS, data);
    sheetsCfg = { ...data, updatedAt: null };
    renderSheetsStatus();
    toast(url ? "Google Sheets copy saved. Use Backup and restore → Sync now for the first copy." : "Google Sheets copy turned off.");
  } catch (err) {
    sec.sheetsError.textContent = errorMessage(err);
    sec.sheetsError.classList.remove("d-none");
  } finally {
    setBusy(sec.btnSheetsSave, false);
  }
}

// ---------- Sign-in security ----------
const secu = {
  form: document.getElementById("securityForm"),
  single: document.getElementById("secSingle"),
  idle: document.getElementById("secIdle"),
  status: document.getElementById("securityStatus"),
  saved: document.getElementById("securitySaved"),
  btn: document.getElementById("btnSaveSecurity"),
};

function securityStatus(cfg) {
  const parts = [];
  if (cfg.singleSession) parts.push("One device");
  if (cfg.autoLogoutMinutes) parts.push(`Auto sign-out: ${autoLogoutLabel(cfg.autoLogoutMinutes)}`);
  secu.status.className = `badge ${parts.length ? "badge-pass" : "badge-none"}`;
  secu.status.textContent = parts.length ? parts.join(" · ") : "Off";
}

async function initSecurity(me) {
  secu.idle.innerHTML = AUTO_LOGOUT_CHOICES.map(([m, label]) => `<option value="${m}">${label}</option>`).join("");
  const cfg = await getSecurity(true);
  secu.single.checked = !!cfg.singleSession;
  secu.idle.value = String(cfg.autoLogoutMinutes || 0);
  securityStatus(cfg);
  secu.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = { singleSession: secu.single.checked, autoLogoutMinutes: Number(secu.idle.value) || 0 };
    setBusy(secu.btn, true);
    try {
      await setDoc(doc(db, "settings", "security"), { ...data, updatedAt: serverTimestamp(), updatedByName: me.displayName || me.username });
      rememberSecurity(data);
      securityStatus(data);
      secu.saved.textContent = "Saved just now. Applies on each device when a page is next opened.";
      toast("Sign-in security saved.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(secu.btn, false);
    }
  });
}

// ---------- Teacher downtime ----------
const dt = {
  form: document.getElementById("downtimeForm"),
  on: document.getElementById("dtOn"),
  until: document.getElementById("dtUntil"),
  message: document.getElementById("dtMessage"),
  status: document.getElementById("downtimeStatus"),
  saved: document.getElementById("downtimeSaved"),
  btn: document.getElementById("btnSaveDowntime"),
};

/** Date → value for <input type="datetime-local"> (local time). */
function localInputValue(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function downtimeStatus(d) {
  const active = downtimeActive(d);
  dt.status.className = `badge ${active ? "badge-fail" : "badge-pass"}`;
  dt.status.textContent = active ? "Closed for teachers" : "Teachers can enter grades";
  dt.saved.textContent = active ? downtimeText(d) : d.teachersLocked ? "The reopening time has passed, so teachers can enter grades again." : "";
}

async function initDowntime(me) {
  const d = await getDowntime();
  dt.on.checked = d.teachersLocked === true;
  const until = toDate(d.until);
  dt.until.value = until ? localInputValue(until) : "";
  dt.message.value = d.message || "";
  downtimeStatus(d);
  dt.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearErrors(dt.form);
    const untilDate = dt.until.value ? new Date(dt.until.value) : null;
    if (dt.on.checked && untilDate && untilDate.getTime() <= Date.now()) {
      fieldError(dt.until, "Pick a time in the future, or leave it empty.");
      return;
    }
    const data = {
      teachersLocked: dt.on.checked,
      until: dt.on.checked && untilDate ? Timestamp.fromDate(untilDate) : null,
      message: dt.message.value.trim().slice(0, 200),
    };
    setBusy(dt.btn, true);
    try {
      await setDoc(doc(db, "settings", "downtime"), { ...data, updatedAt: serverTimestamp(), updatedByName: me.displayName || me.username });
      downtimeStatus(data);
      toast(data.teachersLocked ? "Grade entry is now closed for teachers." : "Teachers can enter grades again.");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(dt.btn, false);
    }
  });
}

function initProtected(me) {
  unlockModal = new bootstrap.Modal(sec.unlockModalEl);
  sec.unlockModalEl.addEventListener("shown.bs.modal", () => sec.unlockPassword.focus());
  sec.unlockModalEl.addEventListener("hidden.bs.modal", () => { sec.unlockPassword.value = ""; });
  document.querySelectorAll("[data-unlock]").forEach((b) => b.addEventListener("click", () => unlockModal.show()));
  sec.unlockForm.addEventListener("submit", unlock);
  sec.emailForm.addEventListener("submit", (e) => saveEmail(e, me));
  sec.btnSheetsTest.addEventListener("click", testSheetsSettings);
  currentAdminName = me.displayName || me.username;
  dbModal = new bootstrap.Modal(dbEls.modalEl);
  dbEls.modalEl.addEventListener("shown.bs.modal", () => dbEls.url.focus());
  dbEls.btnUseSheets.addEventListener("click", () => {
    clearErrors(dbEls.form);
    dbEls.result.classList.add("d-none");
    dbEls.url.value = sheetsDatabaseUrl || "";
    dbModal.show();
  });
  dbEls.btnTest.addEventListener("click", testSheetsUrl);
  dbEls.form.addEventListener("submit", switchToSheets);
  dbEls.btnUseFirestore.addEventListener("click", switchToFirestore);
  supaModal = new bootstrap.Modal(supaEls.modalEl);
  supaEls.modalEl.addEventListener("shown.bs.modal", () => supaEls.url.focus());
  supaEls.btnUse.addEventListener("click", () => {
    clearErrors(supaEls.form);
    supaEls.result.classList.add("d-none");
    supaEls.url.value = supabaseUrl || "";
    supaEls.key.value = supabaseKey || "";
    document.getElementById("supaProjectId").textContent = (connectionConfig || firebaseConfig).projectId;
    supaModal.show();
  });
  supaEls.btnTest.addEventListener("click", testSupabase);
  supaEls.form.addEventListener("submit", switchToSupabase);
  renderDatabase();
  renderConnection();
  checkDatabase();
  loadDbHistory();
  syncSchoolAdmins(me);
  document.getElementById("btnDbCheck").addEventListener("click", checkDatabase);
  sec.sheetsForm.addEventListener("submit", (e) => saveSheets(e, me));
  setLocked(true);
  loadEmailSettings();
  loadSheets();
}

initLayout("settings").then((user) => {
  if (user) {
    init(user);
    initProtected(user);
    initSecurity(user);
    initDowntime(user);
  }
});
