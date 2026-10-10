// ==========================================================
// connection.js — Firebase connection helpers for the setup screen
// and School settings: read a pasted config, test it, verify an
// administrator's password, and build a link for other devices.
// ==========================================================

import { CONFIG_FIELDS, USERNAME_EMAIL_DOMAIN, isSheetsDatabaseUrl } from "./firebase-config.js";
import { isSupabaseUrl, supabaseKeyProblem, supabaseRequest, cleanSupabaseUrl } from "./supabase-db.js";
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
// Always the real Firestore here: these tests run on temporary apps, whatever this device uses
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Unlock handed from School settings to the setup screen after the admin re-enters their password
const UNLOCK_KEY = "gs-connection-unlock";
const UNLOCK_MINUTES = 10;

export function grantUnlock() {
  try { sessionStorage.setItem(UNLOCK_KEY, String(Date.now())); } catch {}
}
export function hasUnlock() {
  try {
    const t = Number(sessionStorage.getItem(UNLOCK_KEY) || 0);
    return t > 0 && Date.now() - t < UNLOCK_MINUTES * 60 * 1000;
  } catch {
    return false;
  }
}
export function clearUnlock() {
  try { sessionStorage.removeItem(UNLOCK_KEY); } catch {}
}

/** Reads Firebase's config snippet (JS or JSON) and returns the fields found. */
export function parseConfigText(text) {
  const out = {};
  const src = String(text || "");
  CONFIG_FIELDS.forEach((field) => {
    const m = src.match(new RegExp(`["']?${field}["']?\\s*:\\s*["'\`]([^"'\`]+)["'\`]`));
    if (m) out[field] = m[1].trim();
  });
  return out;
}

export function missingFields(cfg) {
  return ["apiKey", "authDomain", "projectId", "appId"].filter((k) => !cfg[k]);
}

// ---------- Share link (config travels in the #hash, which browsers never send to servers) ----------
function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function connectionLink(cfg) {
  const clean = {};
  CONFIG_FIELDS.forEach((k) => { if (cfg[k]) clean[k] = cfg[k]; });
  if (cfg.backend === "sheets" && cfg.sheetsUrl) { clean.backend = "sheets"; clean.sheetsUrl = cfg.sheetsUrl; }
  if (cfg.backend === "supabase" && cfg.supabaseUrl) {
    Object.assign(clean, { backend: "supabase", supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey });
  }
  const url = new URL("setup.html", location.href);
  url.search = "";
  url.hash = `connect=${toBase64Url(JSON.stringify(clean))}`;
  return url.toString();
}

export function configFromLink(hash = location.hash) {
  const m = /[#&]connect=([A-Za-z0-9_-]+)/.exec(hash || "");
  if (!m) return null;
  try {
    const cfg = JSON.parse(fromBase64Url(m[1]));
    return cfg && typeof cfg === "object" ? cfg : null;
  } catch {
    return null;
  }
}

// ---------- Google Sheets database (Apps Script) ----------
async function sheetsCall(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", body: JSON.stringify({ ...body, origin: location.origin }), redirect: "follow" });
  } catch {
    throw new Error("Couldn't reach the Google Sheets database. Check the Web app URL and your internet connection.");
  }
  let data;
  try { data = JSON.parse(await res.text()); }
  catch { throw new Error("The Apps Script didn't answer correctly. Deploy Database.gs as a Web app with \"Who has access: Anyone\" and use the URL ending in /exec."); }
  if (!data.ok) {
    // The copy script (SheetsCopy.gs) answers with "error" and talks about a sync key
    const wrongScript = !data.message && data.error && /sync key|SYNC_KEY/i.test(data.error);
    const e = new Error(wrongScript ? "This URL is the Google Sheets COPY script (SheetsCopy.gs), not the database. In your Google Sheet open Extensions → Apps Script, replace the code with google-apps-script/Database.gs, set FIREBASE_API_KEY, save, then Deploy → Manage deployments → Edit → Version: New version → Deploy, and test again." : data.message || data.error || "The Google Sheets database refused the request.");
    e.code = data.code;
    throw e;
  }
  return data;
}

async function testSheetsDatabase(cfg) {
  if (!isSheetsDatabaseUrl(cfg.sheetsUrl)) return fail("Enter the Google Sheets database Web app URL (starts with https://script.google.com/macros/s/ and ends with /exec).");
  let ping;
  try { ping = await sheetsCall(cfg.sheetsUrl, { action: "ping", apiKey: cfg.apiKey }); }
  catch (err) { return fail(err.message); }
  if (ping.version === undefined) return fail("This URL is the Google Sheets COPY script (SheetsCopy.gs), not the database. In your Google Sheet open Extensions → Apps Script, replace the code with google-apps-script/Database.gs, set FIREBASE_API_KEY, save, then Deploy → Manage deployments → Edit → Version: New version → Deploy, and test again.");
  if (!ping.apiKeyConfigured) return fail("The Google Sheet's script couldn't save your Firebase API key: Firebase didn't accept it. Check the apiKey in the Firebase config above (Firebase Console → Project settings → Your apps), then Test again.");
  if (ping.keyProblem) return fail(ping.keyProblem);
  try { await sheetsCall(cfg.sheetsUrl, { action: "get", path: "meta/setup" }); }
  catch (err) { return fail(err.message); }
  if (ping.keyMatches === false) {
    // Allowed: a second key made just for the script, as long as it's from the same Firebase project
    return { ok: true, level: "warning", message: `Connected to the Google Sheet "${ping.name}". The script uses a different API key than the website; that's fine if it's a second key from the same Firebase project (${cfg.projectId}).` };
  }
  return { ok: true, level: "ok", message: `Connected. Sign-in uses Firebase project ${cfg.projectId}; data is stored in the Google Sheet "${ping.name}".` };
}

// ---------- Supabase database (supabase/schema.sql) ----------
const supabaseOf = (cfg) => ({ url: cfg.supabaseUrl, key: cfg.supabaseKey, projectId: cfg.projectId });

/**
 * Checks the Project URL and key, that schema.sql was run, and (when cfg.getToken gives
 * a Firebase sign-in) that Supabase accepts Firebase sign-ins (Third-party Auth).
 */
async function testSupabaseDatabase(cfg) {
  if (!isSupabaseUrl(cfg.supabaseUrl)) return fail("Enter the Supabase Project URL, like https://abcdefgh.supabase.co (Project Settings → API Keys / Data API).");
  const keyProblem = supabaseKeyProblem(cfg.supabaseKey);
  if (keyProblem) return fail(keyProblem);
  const host = cleanSupabaseUrl(cfg.supabaseUrl).replace(/^https:\/\//, "");
  try {
    const ping = await supabaseRequest(supabaseOf(cfg), { action: "ping" }, null);
    if (ping.version === undefined) return fail("The Supabase project answered, but not like the grading system's database. Run supabase/schema.sql in its SQL Editor and test again.");
    await supabaseRequest(supabaseOf(cfg), { action: "get", path: "meta/setup" }, null);
  } catch (err) {
    return fail(err.message);
  }
  const token = cfg.getToken ? await cfg.getToken().catch(() => null) : null;
  if (!token) {
    return { ok: true, level: "warning", message: `Connected to Supabase (${host}). Make sure Firebase (project ${cfg.projectId}) is added in Supabase → Authentication → Third-party Auth, or no one will be able to sign in.` };
  }
  try {
    const me = await supabaseRequest(supabaseOf(cfg), { action: "ping" }, token);
    if (!me.signedIn) return fail(`Supabase received your sign-in but couldn't confirm it came from Firebase project ${cfg.projectId}. Check the Project ID under Authentication → Third-party Auth → Firebase in Supabase.`);
  } catch (err) {
    return fail(err.message);
  }
  return { ok: true, level: "ok", message: `Connected. Sign-in uses Firebase project ${cfg.projectId}; data is stored in Supabase (${host}).` };
}

// ---------- Test a connection ----------
const fail = (message) => ({ ok: false, level: "error", message });
const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("timeout"), { code: "timeout" })), ms));

/**
 * Checks the API key with Firebase Authentication, then reads one public
 * document from Firestore. Returns { ok, level: "ok" | "warning" | "error", message }.
 */
export async function testConnection(cfg) {
  const missing = missingFields(cfg);
  if (missing.length) return fail(`Missing: ${missing.join(", ")}.`);

  // 1) API key: valid, and allowed on this website?
  try {
    const origin = /^https?:/.test(location.origin) ? location.origin : "http://localhost";
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${encodeURIComponent(cfg.apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: `connection-test@${USERNAME_EMAIL_DOMAIN}`, continueUri: origin }),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body?.error?.message || `HTTP ${res.status}`;
      if (/API key not valid|API_KEY_INVALID/i.test(msg)) return fail("The API key isn't valid. Copy it again from Firebase Console → Project settings.");
      if (/referer|referrer|blocked/i.test(msg)) return fail(`This API key isn't allowed on this website (${location.host || "local file"}). Add it to the key's website restrictions in Google Cloud Console.`);
      if (/CONFIGURATION_NOT_FOUND/i.test(msg)) return fail("Authentication isn't set up in this project. In Firebase Console open Authentication → Get started, then enable Email/Password.");
      if (!/OPERATION_NOT_ALLOWED|INVALID_IDENTIFIER|INVALID_EMAIL/i.test(msg)) return fail(`Firebase refused the API key: ${msg}`);
    }
  } catch {
    return fail("Couldn't reach Firebase. Check the internet connection and try again.");
  }

  // 2) Database: Google Sheets, or Firestore for this project
  if (cfg.backend === "sheets") return testSheetsDatabase(cfg);
  if (cfg.backend === "supabase") return testSupabaseDatabase(cfg);
  const tmp = initializeApp(Object.fromEntries(CONFIG_FIELDS.filter((k) => cfg[k]).map((k) => [k, cfg[k]])), `connection-test-${Date.now()}`);
  try {
    await Promise.race([getDoc(doc(getFirestore(tmp), "meta", "setup")), timeout(12000)]);
    return { ok: true, level: "ok", message: `Connected to ${cfg.projectId}. Sign-in and the database both answered.` };
  } catch (err) {
    if (err.code === "permission-denied") {
      return { ok: true, level: "warning", message: `Connected to ${cfg.projectId}, but the database refused access. Publish firestore.rules in Firebase Console → Firestore Database → Rules.` };
    }
    if (err.code === "timeout" || err.code === "unavailable" || err.code === "not-found") {
      return fail("The database didn't answer. Check the Project ID, and make sure a Firestore database exists (Firebase Console → Firestore Database → Create database).");
    }
    return fail(err.message || "The connection test failed.");
  } finally {
    deleteApp(tmp).catch(() => {});
  }
}

// ---------- Verify an administrator against a given connection ----------
/** Signs in on a temporary, in-memory app and checks the account is an active administrator. */
export async function verifyAdmin(cfg, username, password) {
  const fbOnly = Object.fromEntries(CONFIG_FIELDS.filter((k) => cfg[k]).map((k) => [k, cfg[k]]));
  const tmp = initializeApp(fbOnly, `admin-check-${Date.now()}`);
  try {
    const tauth = initializeAuth(tmp, { persistence: inMemoryPersistence });
    const name = String(username).trim().toLowerCase();
    let lookup, profile;
    if (cfg.backend === "sheets") {
      const l = await sheetsCall(cfg.sheetsUrl, { action: "get", path: `usernames/${name}` });
      if (!l.doc) return { ok: false, message: "Incorrect username or password." };
      const cred = await signInWithEmailAndPassword(tauth, l.doc.data.authEmail, password);
      const token = await cred.user.getIdToken();
      const p = await sheetsCall(cfg.sheetsUrl, { action: "get", path: `users/${cred.user.uid}`, token });
      profile = p.doc ? p.doc.data : null;
    } else if (cfg.backend === "supabase") {
      const l = await supabaseRequest(supabaseOf(cfg), { action: "get", path: `usernames/${name}` }, null);
      if (!l.doc) return { ok: false, message: "Incorrect username or password." };
      const cred = await signInWithEmailAndPassword(tauth, l.doc.data.authEmail, password);
      const token = await cred.user.getIdToken();
      const p = await supabaseRequest(supabaseOf(cfg), { action: "get", path: `users/${cred.user.uid}` }, token);
      profile = p.doc ? p.doc.data : null;
    } else {
      const tdb = getFirestore(tmp);
      lookup = await getDoc(doc(tdb, "usernames", name));
      if (!lookup.exists()) return { ok: false, message: "Incorrect username or password." };
      const cred = await signInWithEmailAndPassword(tauth, lookup.data().authEmail, password);
      const snap = await getDoc(doc(tdb, "users", cred.user.uid));
      profile = snap.exists() ? snap.data() : null;
    }
    await signOut(tauth);
    if (!profile || profile.active === false) return { ok: false, message: "This account can't sign in." };
    if (profile.role !== "admin") return { ok: false, message: "Only an administrator can change the connection." };
    return { ok: true };
  } catch (err) {
    if (["auth/invalid-credential", "auth/invalid-login-credentials", "auth/wrong-password", "auth/user-not-found"].includes(err.code)) {
      return { ok: false, message: "Incorrect username or password." };
    }
    if (err.code === "auth/too-many-requests") return { ok: false, message: "Too many attempts. Wait a few minutes, then try again." };
    return { ok: false, message: err.message || "Couldn't verify the account." };
  } finally {
    deleteApp(tmp).catch(() => {});
  }
}

export function maskKey(key) {
  const k = String(key || "");
  return k.length <= 8 ? "••••" : `${k.slice(0, 4)}••••••••${k.slice(-4)}`;
}
