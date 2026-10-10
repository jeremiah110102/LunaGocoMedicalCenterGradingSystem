// ==========================================================
// setup.js — The school's connection, written into the website once.
//
// • No connection yet: anyone can enter one (it only affects this device).
// • A working connection exists: an administrator must sign in first
//   (or come from School settings, where they re-entered their password).
// • A connection link (setup.html#connect=…) pre-fills the values.
// ==========================================================

import {
  isConfigured, connectionConfig, CONFIG_FIELDS, isSheetsDatabaseUrl, BACKENDS, isSupabaseUrl,
} from "./firebase-config.js";
import { supabaseKeyProblem, cleanSupabaseUrl } from "./supabase-db.js";
import { parseConfigText, missingFields, testConnection } from "./connection.js";
import { escapeHtml, setBusy, clearErrors, fieldError, cachedSchool, applyBranding } from "./app.js";

const LABELS = {
  apiKey: "API key",
  authDomain: "Auth domain",
  projectId: "Project ID",
  storageBucket: "Storage bucket",
  messagingSenderId: "Messaging sender ID",
  appId: "App ID",
};

const els = {
  loading: document.getElementById("loadingState"),
  verifyForm: document.getElementById("verifyForm"),
  verifyError: document.getElementById("verifyError"),
  verifyUsername: document.getElementById("verifyUsername"),
  verifyPassword: document.getElementById("verifyPassword"),
  btnVerify: document.getElementById("btnVerify"),
  currentProject: document.getElementById("currentProject"),
  connectForm: document.getElementById("connectForm"),
  connectTitle: document.getElementById("connectTitle"),
  linkNotice: document.getElementById("linkNotice"),
  brokenNotice: document.getElementById("brokenNotice"),
  configText: document.getElementById("configText"),
  fieldsDetails: document.getElementById("fieldsDetails"),
  fieldGrid: document.getElementById("fieldGrid"),
  testResult: document.getElementById("testResult"),
  btnTest: document.getElementById("btnTest"),
  btnSave: document.getElementById("btnSaveConnection"),
  btnDisconnect: document.getElementById("btnDisconnect"),
  linkBack: document.getElementById("linkBack"),
};


// ---------- Fields ----------
function buildFields() {
  els.fieldGrid.innerHTML = CONFIG_FIELDS.map(
    (k) => `
    <div class="col-sm-6">
      <label for="f-${k}" class="form-label small mb-1${["storageBucket", "messagingSenderId"].includes(k) ? "" : " required"}">${LABELS[k]}</label>
      <input type="text" class="form-control form-control-sm font-monospace" id="f-${k}" data-field="${k}" autocomplete="off" spellcheck="false" autocapitalize="none">
      <div class="invalid-feedback"></div>
    </div>`
  ).join("");
}

function setFields(cfg) {
  CONFIG_FIELDS.forEach((k) => {
    const input = document.getElementById(`f-${k}`);
    if (input && cfg[k] !== undefined) input.value = cfg[k];
  });
  if (cfg.backend !== undefined || cfg.sheetsUrl !== undefined) {
    const backend = ["sheets", "supabase"].includes(cfg.backend) ? cfg.backend : "firestore";
    document.getElementById({ sheets: "beSheets", supabase: "beSupabase", firestore: "beFirestore" }[backend]).checked = true;
    document.getElementById("sheetsDbUrl").value = backend === "sheets" ? cfg.sheetsUrl || "" : "";
    document.getElementById("supabaseDbUrl").value = backend === "supabase" ? cfg.supabaseUrl || "" : "";
    document.getElementById("supabaseDbKey").value = backend === "supabase" ? cfg.supabaseKey || "" : "";
    syncBackend();
  }
}

function selectedBackend() {
  return document.querySelector('input[name="backend"]:checked').value;
}

function syncBackend() {
  document.getElementById("sheetsUrlWrap").classList.toggle("d-none", selectedBackend() !== "sheets");
  document.getElementById("supabaseWrap").classList.toggle("d-none", selectedBackend() !== "supabase");
}

function readFields() {
  const cfg = {};
  CONFIG_FIELDS.forEach((k) => {
    const v = document.getElementById(`f-${k}`).value.trim();
    if (v) cfg[k] = v;
  });
  if (selectedBackend() === "sheets") {
    cfg.backend = "sheets";
    cfg.sheetsUrl = document.getElementById("sheetsDbUrl").value.trim();
  }
  if (selectedBackend() === "supabase") {
    cfg.backend = "supabase";
    cfg.supabaseUrl = cleanSupabaseUrl(document.getElementById("supabaseDbUrl").value);
    cfg.supabaseKey = document.getElementById("supabaseDbKey").value.trim();
  }
  return cfg;
}

function onPaste() {
  const found = parseConfigText(els.configText.value);
  if (Object.keys(found).length) {
    setFields(found);
    const missing = missingFields({ ...readFields(), ...found });
    showResult(
      missing.length ? "warning" : "info",
      missing.length
        ? `Found ${Object.keys(found).length} values. Still missing: ${missing.map((m) => LABELS[m]).join(", ")}.`
        : `Found all values for project ${escapeHtml(found.projectId)}. Click Test connection.`
    );
  }
}

function showResult(level, html) {
  const icon = { ok: "bi-check-circle", warning: "bi-exclamation-triangle", error: "bi-x-circle", info: "bi-info-circle" }[level];
  els.testResult.className = `test-result ${level}`;
  els.testResult.innerHTML = `<i class="bi ${icon} me-2"></i><span>${html}</span>`;
}

function validate() {
  clearErrors(els.connectForm);
  const cfg = readFields();
  const missing = missingFields(cfg);
  missing.forEach((k) => fieldError(document.getElementById(`f-${k}`), "Required"));
  if (missing.length) {
    els.fieldsDetails.open = true;
    showResult("error", `Missing: ${missing.map((m) => LABELS[m]).join(", ")}. Paste the whole config block from Firebase.`);
    return null;
  }
  if (cfg.backend === "sheets" && !isSheetsDatabaseUrl(cfg.sheetsUrl)) {
    fieldError(document.getElementById("sheetsDbUrl"), "Paste the Web app URL of Database.gs (starts with https://script.google.com/macros/s/ and ends with /exec).");
    showResult("error", "Enter the Google Sheets database URL, or choose Firebase Firestore.");
    return null;
  }
  if (cfg.backend === "supabase") {
    const keyProblem = supabaseKeyProblem(cfg.supabaseKey);
    if (!isSupabaseUrl(cfg.supabaseUrl)) fieldError(document.getElementById("supabaseDbUrl"), "Paste the Project URL, like https://abcdefgh.supabase.co.");
    if (keyProblem) fieldError(document.getElementById("supabaseDbKey"), keyProblem);
    if (!isSupabaseUrl(cfg.supabaseUrl) || keyProblem) {
      showResult("error", "Enter the Supabase Project URL and publishable key, or choose Firebase Firestore.");
      return null;
    }
  }
  return cfg;
}

// ---------- Actions ----------
async function runTest() {
  const cfg = validate();
  if (!cfg) return null;
  setBusy(els.btnTest, true, "Testing…");
  showResult("info", "Contacting Firebase…");
  try {
    const result = await testConnection(cfg);
    showResult(result.level, escapeHtml(result.message));
    return result;
  } finally {
    setBusy(els.btnTest, false);
  }
}

/** The website file with the school's connection written in. */
export function buildConfigFile(template, cfg) {
  const lines = CONFIG_FIELDS.filter((k) => cfg[k]).map((k) => `  ${k}: ${JSON.stringify(String(cfg[k]).trim())},`);
  if (cfg.backend === "sheets" && cfg.sheetsUrl) {
    lines.push(`  backend: "sheets",`, `  sheetsUrl: ${JSON.stringify(String(cfg.sheetsUrl).trim())},`);
  }
  if (cfg.backend === "supabase" && cfg.supabaseUrl) {
    lines.push(
      `  backend: "supabase",`,
      `  supabaseUrl: ${JSON.stringify(String(cfg.supabaseUrl).trim())},`,
      `  supabaseKey: ${JSON.stringify(String(cfg.supabaseKey || "").trim())},`,
    );
  }
  const block = `const BUILT_IN_CONFIG = {\n${lines.join("\n")}\n};`;
  const out = template.replace(/const BUILT_IN_CONFIG = \{[\s\S]*?\n\};/, block);
  if (out === template) throw new Error("Couldn't find the connection block in firebase-config.js.");
  return out;
}

// Create the file (tested first): no device keeps a connection of its own
async function save(e) {
  e.preventDefault();
  const result = await runTest();
  if (!result || !result.ok) return;
  const cfg = readFields();
  setBusy(els.btnSave, true, "Preparing…");
  try {
    const res = await fetch(new URL("../js/firebase-config.js", location.href), { cache: "no-store" });
    const file = buildConfigFile(await res.text(), cfg);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([file], { type: "text/javascript" }));
    a.download = "firebase-config.js";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    document.getElementById("fileSteps").classList.remove("d-none");
    showResult("ok", "firebase-config.js downloaded with your school's connection. Follow the last step below.");
  } catch (err) {
    showResult("error", escapeHtml(err.message || "Couldn't create the file."));
  } finally {
    setBusy(els.btnSave, false);
  }
}

function showInfo() {
  const c = connectionConfig || {};
  const facts = [
    ["Firebase project", c.projectId || "—"],
    ["Records kept in", BACKENDS[c.backend] || BACKENDS.firestore],
    ["Set up on", "The whole school (every account and device)"],
  ];
  document.getElementById("infoFacts").innerHTML = facts.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`).join("");
  els.loading.classList.add("d-none");
  document.getElementById("infoState").classList.remove("d-none");
}

function showConnectForm() {
  buildFields();
  els.connectTitle.textContent = "Write the school's connection into the website (one time)";
  [els.verifyForm, els.linkNotice, els.brokenNotice, els.btnDisconnect, els.linkBack].forEach((el) => el && el.classList.add("d-none"));
  els.loading.classList.add("d-none");
  els.connectForm.classList.remove("d-none");
}

function init() {
  try { applyBranding(cachedSchool()); } catch {}
  els.configText.addEventListener("input", onPaste);
  els.btnTest.addEventListener("click", runTest);
  els.connectForm.addEventListener("submit", save);
  document.querySelectorAll('input[name="backend"]').forEach((r) => r.addEventListener("change", syncBackend));
  if (isConfigured) return showInfo();
  showConnectForm();
}

init();
