/**
 * ==========================================================
 * College Grading System: GOOGLE SHEETS DATABASE (server)
 * ==========================================================
 * Makes this Google Sheet the system's database. Firebase is then used
 * only for sign-in. Every request is checked against the signed-in user
 * with the same role rules as firestore.rules.
 *
 * Each list is a tab (students, grades, …):
 *   column A  _id     record id
 *   column B  _json   the full record (hidden; this is the real data)
 *   columns C+        readable copies of each field, for viewing/filtering
 * Edit records through the grading system, not in the sheet: changes to the
 * readable columns are not read back, and editing _json can break a record.
 *
 * SETUP (about 3 minutes)
 *  1. Open the Google Sheet → Extensions → Apps Script. Delete the sample code
 *     and paste this whole file. Click Save.
 *  2. Deploy → New deployment → gear icon → Web app:
 *        Execute as:      Me
 *        Who has access:  Anyone
 *     Click Deploy → Authorize access → your account → (Advanced → Go to … →) Allow.
 *     Copy the Web app URL (ends with /exec).
 *  3. On the website: sign-in page → Connection setup → Database: Google Sheets →
 *     paste the URL → Test connection → Save and continue.
 *     (Or, when signed in: School settings → Firebase connection → Use Google Sheet…)
 *     The first Test also saves your Firebase API key in this script; nothing to edit.
 *  4. Create the administrator on the sign-in page, or here: choose the function
 *     "createDefaultAdmin" in the toolbar and click Run (admin / admin123, changed at
 *     first sign-in).
 *
 * "Anyone" only lets the website reach this script. Each request must carry
 * a valid Firebase sign-in, and the rules below decide what that user may do.
 * After editing this code: Deploy → Manage deployments → Edit → New version.
 *
 * Error "You do not have permission to call UrlFetchApp.fetch" (Filipino:
 * "Wala kang pahintulot na tumawag kay UrlFetchApp.fetch"): run "authorize"
 * once as in step 3b, then deploy a New version.
 */

// Optional. Leave as is: the key is saved automatically the first time you click
// Test on the website's connection screen. (Or paste your Firebase apiKey here.)
const FIREBASE_API_KEY = "PASTE-your-Firebase-apiKey-here";
const VERSION = 1;

// Default administrator, created by running "createDefaultAdmin" once (see below).
// Firebase needs passwords of at least 6 characters. The system asks for a new
// password at the first sign-in, so this one is only used once.
const DEFAULT_ADMIN_USERNAME = "admin";
const DEFAULT_ADMIN_PASSWORD = "admin123";
const USERNAME_EMAIL_DOMAIN = "gradingsystem.local"; // must match the website (don't change)

// ---------------------------------------------------------- one-time permission
/**
 * Run this once from the Apps Script editor (choose "authorize", click Run) to grant
 * the permissions the database needs. It only reads; nothing is changed.
 */
function authorize() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  UrlFetchApp.fetch("https://www.google.com/generate_204", { muteHttpExceptions: true });
  CacheService.getScriptCache().get("authorize-check");
  LockService.getScriptLock();
  Logger.log("Permissions granted for \"" + ss.getName() + "\". Now deploy a New version of the Web app.");
}

// ---------------------------------------------------------- default administrator
/**
 * Run once from the Apps Script editor (choose "createDefaultAdmin", click Run).
 * Creates the Firebase sign-in for DEFAULT_ADMIN_USERNAME / DEFAULT_ADMIN_PASSWORD and
 * the administrator record in this Sheet. Does nothing if an administrator was already set up.
 */
function createDefaultAdmin() {
  if (!apiKey()) throw new Error("The database doesn't know your Firebase API key yet. First open the website's connection screen, choose Google Sheets, paste this script's Web app URL and click Test (that saves the key). Then run createDefaultAdmin again.");
  const password = String(DEFAULT_ADMIN_PASSWORD);
  if (password.length < 6) throw new Error("Firebase requires passwords of at least 6 characters (\"123\" is too short). Set DEFAULT_ADMIN_PASSWORD to e.g. \"admin123\", save, and run again.");
  const username = String(DEFAULT_ADMIN_USERNAME).trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new Error("DEFAULT_ADMIN_USERNAME must be 3 to 30 lowercase letters, numbers, dot, dash or underscore.");

  const ctx = { uid: null, cache: {}, me: null };
  if (loadCol(ctx, "meta").map.setup) {
    Logger.log("Nothing changed: an administrator was already set up in this Sheet. Sign in with that account.");
    return;
  }
  const email = username + "@" + USERNAME_EMAIL_DOMAIN;
  const firebase = function (path, payload) {
    const res = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/" + path + "?key=" + encodeURIComponent(apiKey()), {
      method: "post", contentType: "application/json", payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    let d = {};
    try { d = JSON.parse(res.getContentText() || "{}"); } catch (e) { d = {}; }
    return { status: res.getResponseCode(), data: d, error: (d.error && d.error.message) || "" };
  };

  // Create the sign-in (or reuse it if this username already exists with the same password)
  let r = firebase("accounts:signUp", { email: email, password: password, returnSecureToken: true });
  if (r.status !== 200 && /EMAIL_EXISTS/.test(r.error)) {
    r = firebase("accounts:signInWithPassword", { email: email, password: password, returnSecureToken: true });
    if (r.status !== 200) {
      throw new Error("The username \"" + username + "\" already has a sign-in with a different password. Put that password in DEFAULT_ADMIN_PASSWORD, or choose another DEFAULT_ADMIN_USERNAME, save, and run again.");
    }
  }
  if (r.status !== 200) {
    if (/OPERATION_NOT_ALLOWED/.test(r.error)) throw new Error("Email/Password sign-in is turned off. Firebase Console → Authentication → Sign-in method → enable Email/Password, then run again.");
    if (/WEAK_PASSWORD/.test(r.error)) throw new Error("Firebase says the password is too weak. Use at least 6 characters.");
    throw new Error(keyProblem(r.error, r.status) || "Firebase refused: " + (r.error || "HTTP " + r.status));
  }

  const uid = r.data.localId;
  const now = { __ts: new Date().toISOString() };
  const users = {};
  users[uid] = {
    username: username, displayName: "Administrator", role: "admin", canApprove: true, teacherDocId: null,
    active: true, authEmail: email, mustChangePassword: true, createdAt: now, updatedAt: now,
  };
  const usernames = {};
  usernames[username] = { uid: uid, authEmail: email };
  persist(ctx, "users", users);
  persist(ctx, "usernames", usernames);
  persist(ctx, "meta", { setup: { adminUid: uid, createdAt: now } }); // last: marks setup as done
  Logger.log("Administrator created. Sign in with username \"" + username + "\" and password \"" + password +
    "\". You'll be asked to choose a new password right away.");
}

// ---------------------------------------------------------- entry points
function doGet() {
  return ContentService.createTextOutput("Grading System database is running (version " + VERSION + ").");
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, code: "invalid-argument", message: "The request couldn't be read." });
  }
  try {
    if (body.action === "ping") {
      // Fails here (and is explained below) if the "external service" permission is missing
      UrlFetchApp.fetch("https://www.google.com/generate_204", { muteHttpExceptions: true });
      let keyProblemText = "";
      const props = PropertiesService.getScriptProperties();
      if (!apiKey() && /^AIza[\w-]{20,}$/.test(String(body.apiKey || ""))) {
        props.setProperty("FIREBASE_API_KEY", body.apiKey); // first Test from the website
        const check = lookupToken("connection-test", body.origin);
        if (/API key not valid|API_KEY_INVALID/i.test(check.error)) props.deleteProperty("FIREBASE_API_KEY");
      }
      if (apiKey()) {
        // A made-up token: a working key answers "INVALID_ID_TOKEN"; a blocked key answers differently
        const probe = lookupToken("connection-test", body.origin);
        keyProblemText = keyProblem(probe.error, probe.status);
      }
      return reply({
        keyProblem: keyProblemText,
        ok: true,
        version: VERSION,
        name: SpreadsheetApp.getActiveSpreadsheet().getName(),
        apiKeyConfigured: !!apiKey(),
        keyMatches: body.apiKey ? body.apiKey === apiKey() : null,
      });
    }
    const ctx = makeContext(body.token, body.origin);
    switch (body.action) {
      case "get": return reply({ ok: true, doc: getOne(ctx, body.path) });
      case "query": return reply({ ok: true, docs: runQuery(ctx, body.collection, body.where || [], body.orderBy || [], body.limit) });
      case "count": return reply({ ok: true, count: runQuery(ctx, body.collection, body.where || [], [], null).length });
      // IDs of the active administrators (no names or other details), so the website can
      // let them change the school's database even though Firebase can't read this Sheet
      case "adminUids": {
        const users = loadCol(ctx, "users");
        return reply({ ok: true, uids: users.ids.filter(function (id) { const u = users.map[id]; return u && u.role === "admin" && u.active === true; }) });
      }
      case "commit": commit(ctx, body.ops || []); return reply({ ok: true });
      default: return reply({ ok: false, code: "invalid-argument", message: "Unknown action." });
    }
  } catch (err) {
    if (err && err.code) return reply({ ok: false, code: err.code, message: err.message });
    const text = String((err && err.message) || err);
    if (/UrlFetchApp|external_request|pahintulot|permission|authorization/i.test(text)) {
      return reply({
        ok: false,
        code: "failed-precondition",
        message: "The database script needs one more Google permission. In the Google Sheet open Extensions → Apps Script, choose the function \"authorize\" in the toolbar, click Run, and allow the permissions. Then Deploy → Manage deployments → Edit → Version: New version → Deploy, and test again.",
      });
    }
    return reply({ ok: false, code: "internal", message: text });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  throw e;
}
function isPlaceholder(v) {
  return !v || String(v).indexOf("PASTE") === 0;
}

/** The Firebase API key in use: pasted above, or saved from the website's first Test. */
function apiKey() {
  if (!isPlaceholder(FIREBASE_API_KEY)) return FIREBASE_API_KEY;
  return PropertiesService.getScriptProperties().getProperty("FIREBASE_API_KEY") || "";
}

/** Run this from the editor if you ever connect a different Firebase project. */
function forgetApiKey() {
  PropertiesService.getScriptProperties().deleteProperty("FIREBASE_API_KEY");
  Logger.log("Saved API key removed. The next Test on the website saves the new one.");
}

// ---------------------------------------------------------- sign-in check
/** Calls Firebase's sign-in check (accounts:lookup) with FIREBASE_API_KEY. */
function lookupToken(idToken, origin) {
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ idToken: idToken }),
    muteHttpExceptions: true,
  };
  // If the API key is restricted to your website, the site's address is passed on
  if (origin && /^https?:\/\//.test(origin)) options.headers = { Referer: origin + "/" };
  const res = UrlFetchApp.fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(apiKey()), options);
  let data = {};
  try { data = JSON.parse(res.getContentText() || "{}"); } catch (e) { data = {}; }
  return { status: res.getResponseCode(), data: data, error: (data.error && data.error.message) || "" };
}

/** Problems with FIREBASE_API_KEY itself (not with one user's sign-in), explained. */
function keyProblem(error, status) {
  if (/API key not valid|API_KEY_INVALID/i.test(error)) {
    return "FIREBASE_API_KEY in the database Apps Script isn't valid. Copy the apiKey again from Firebase Console → Project settings → Your apps, paste it, save, and deploy a New version.";
  }
  if (/referer|referrer|REFERRER_BLOCKED|blocked|not authorized to use this API|PERMISSION_DENIED/i.test(error) || status === 403) {
    return "Your Firebase API key only allows your website, so the Google Sheet's script can't check sign-ins with it. Fix it in Google Cloud Console → APIs & Services → Credentials: either (a) open the \"Browser key (auto created by Firebase)\" and set Application restrictions to None (keep the API restrictions), or (b) click Create credentials → API key, restrict it to the Identity Toolkit API only, and put that new key in FIREBASE_API_KEY. Save, deploy a New version, and test again.";
  }
  if (/CONFIGURATION_NOT_FOUND/i.test(error)) {
    return "Authentication isn't set up in this Firebase project. Open Firebase Console → Authentication → Get started and enable Email/Password.";
  }
  return "";
}

/** Returns the Firebase uid for a valid sign-in token, or null if signed out. Cached ~30 minutes. */
function verifyToken(token, origin) {
  if (!token) return null;
  if (!apiKey()) fail("failed-precondition", "The database doesn't know your Firebase API key yet. On the website's connection screen click Test once (it saves the key), then try again.");
  const cache = CacheService.getScriptCache();
  const key = "t:" + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const hit = cache.get(key);
  if (hit) return hit;
  const r = lookupToken(token, origin);
  if (r.status !== 200) {
    const problem = keyProblem(r.error, r.status);
    if (problem) fail("failed-precondition", problem);
    // Expired or not from this Firebase project
    fail("unauthenticated", "The Google Sheet database couldn't confirm your sign-in (" + (r.error || "HTTP " + r.status) + "). Sign out and in again. If it keeps happening, check that FIREBASE_API_KEY in the script is from the same Firebase project as the website.");
  }
  const uid = r.data.users && r.data.users[0] && r.data.users[0].localId;
  if (uid) cache.put(key, uid, 1800);
  return uid || null;
}

function makeContext(token, origin) {
  const ctx = { uid: verifyToken(token, origin), cache: {}, me: null };
  if (ctx.uid) ctx.me = loadCol(ctx, "users").map[ctx.uid] || null;
  return ctx;
}

// ---------------------------------------------------------- storage
function loadCol(ctx, name) {
  if (ctx.cache[name]) return ctx.cache[name];
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  const col = { name: name, map: {}, ids: [], row: {} };
  if (sheet && sheet.getLastRow() > 1) {
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    values.forEach(function (v, i) {
      const id = String(v[0]);
      if (!id) return;
      let data = {};
      try { data = JSON.parse(v[1]); } catch (err) { data = {}; }
      col.map[id] = data;
      col.ids.push(id);
      col.row[id] = i + 2;
    });
  }
  ctx.cache[name] = col;
  return col;
}

function parsePath(path) {
  const parts = String(path || "").split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail("invalid-argument", "Bad record path: " + path);
  return { col: parts[0], id: parts[1] };
}

/** One readable cell: dates as text, lists as JSON, and formula-looking text kept as text. */
function cellOf(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (typeof v.__ts === "string") return v.__ts.replace("T", " ").replace(/\.\d+Z$/, "");
    return JSON.stringify(v);
  }
  if (typeof v === "string") {
    const s = v.length > 45000 ? v.slice(0, 45000) + "…" : v;
    return /^[=+@-]/.test(s) && !/^-?\d/.test(s) ? "'" + s : s;
  }
  return v;
}

function persist(ctx, name, changes) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, 2).setValues([["_id", "_json"]]);
    sheet.setFrozenRows(1);
    sheet.hideColumns(2);
  }
  const before = loadCol(ctx, name);
  let header = sheet.getRange(1, 1, 1, Math.max(2, sheet.getLastColumn())).getValues()[0].map(String);
  if (header[0] !== "_id" || header[1] !== "_json") header = ["_id", "_json"];
  Object.keys(changes).forEach(function (id) {
    const d = changes[id];
    if (d) Object.keys(d).forEach(function (k) { if (header.indexOf(k) < 0) header.push(k); });
  });
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");

  const rowFor = function (id, d) {
    return header.map(function (h, i) { return i === 0 ? id : i === 1 ? JSON.stringify(d) : cellOf(d[h]); });
  };
  const ids = Object.keys(changes);
  const deletes = ids.filter(function (id) { return !changes[id] && before.row[id]; });
  const updates = ids.filter(function (id) { return changes[id] && before.row[id]; });
  const inserts = ids.filter(function (id) { return changes[id] && !before.row[id]; });

  if (deletes.length > 20 || updates.length > 50) {
    // Many changes: rewrite the tab in one go (much faster than row by row)
    const all = {};
    before.ids.forEach(function (id) { all[id] = before.map[id]; });
    ids.forEach(function (id) { if (changes[id]) all[id] = changes[id]; else delete all[id]; });
    const rows = Object.keys(all).map(function (id) { return rowFor(id, all[id]); });
    const last = sheet.getLastRow();
    if (last > 1) sheet.getRange(2, 1, last - 1, sheet.getMaxColumns()).clearContent();
    if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  } else {
    updates.forEach(function (id) {
      sheet.getRange(before.row[id], 1, 1, header.length).setValues([rowFor(id, changes[id])]);
    });
    if (inserts.length) {
      const rows = inserts.map(function (id) { return rowFor(id, changes[id]); });
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
    }
    deletes.map(function (id) { return before.row[id]; })
      .sort(function (a, b) { return b - a; })
      .forEach(function (r) { sheet.deleteRow(r); });
  }
  delete ctx.cache[name];
}

// ---------------------------------------------------------- rules (same as firestore.rules)
function rulesFor(ctx, after) {
  const me = ctx.me;
  const active = !!(ctx.uid && me && me.active === true);
  const role = me ? me.role : null;
  return {
    uid: ctx.uid,
    signedIn: !!ctx.uid,
    active: active,
    isAdmin: active && role === "admin",
    isStaff: active && (role === "admin" || role === "registrar"),
    isTeacher: active && role === "teacher",
    isApprover: active && me.canApprove === true,
    myTeacher: me ? me.teacherDocId : null,
    before: function (col, id) { return loadCol(ctx, col).map[id] || null; },
    after: function (col, id) {
      if (after && after[col] && Object.prototype.hasOwnProperty.call(after[col], id)) return after[col][id];
      return loadCol(ctx, col).map[id] || null;
    },
  };
}

// The school's grading scale (Setup and options → settings/options), as in firestore.rules
function gradingOf(r) {
  const o = r.before("settings", "options") || {};
  const scale = o.gradingScale === "point1" || o.gradingScale === "point5" ? o.gradingScale : "percent";
  return { scale: scale, cond: o.allowConditional !== false };
}
function isGrade(n, r) {
  if (typeof n !== "number") return false;
  const g = gradingOf(r);
  const steps = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3];
  if (g.scale === "point1") return steps.concat(g.cond ? [4] : [], [5]).indexOf(n) >= 0;
  if (g.scale === "point5") return steps.map(function (v) { return 6 - v; }).concat(g.cond ? [2] : [], [1]).indexOf(n) >= 0;
  return n >= 0 && n <= 100;
}
/** A remark instead of a number: INC (Incomplete) or DRP (Dropped); the grade is then null. */
function isMark(grade, remarks) {
  return (grade === null || grade === undefined) && (remarks === "Incomplete" || remarks === "Dropped");
}
function validGradeRecord(d, r) {
  return !!d && (isMark(d.finalGrade, d.remarks) || (isGrade(d.finalGrade, r) && d.remarks === remarksOf(d.finalGrade, r)));
}
/** Term deadline (Setup and options → Term deadlines): after it, teachers can't add that term's grades. */
function termOpen(r, a) {
  const o = r.before("settings", "options") || {};
  const dl = (o.termDeadlines || {})[(a && a.term) || ""];
  const at = dl && typeof dl === "object" && dl.__ts ? Date.parse(dl.__ts) : null;
  return !at || Date.now() < at;
}
function remarksOf(n, r) {
  const scale = gradingOf(r).scale;
  if (scale === "point1") return n === 4 ? "Conditional" : n <= 3 ? "Passed" : "Failed";
  if (scale === "point5") return n === 2 ? "Conditional" : n >= 3 ? "Passed" : "Failed";
  return n >= 75 ? "Passed" : "Failed";
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function onlyKeysChanged(before, after, allowed) {
  const keys = {};
  Object.keys(before || {}).forEach(function (k) { keys[k] = 1; });
  Object.keys(after || {}).forEach(function (k) { keys[k] = 1; });
  return Object.keys(keys).every(function (k) { return same((before || {})[k], (after || {})[k]) || allowed.indexOf(k) >= 0; });
}
function firstSetup(r) { return !r.before("meta", "setup") && !!r.after("meta", "setup"); }

function canRead(r, col, id, data) {
  switch (col) {
    case "meta": return id === "setup";
    case "usernames": return true; // single look-ups only (listing is blocked in runQuery)
    case "users": return (r.signedIn && (r.uid === id || r.isAdmin)) || (r.active && data.canApprove === true);
    case "settings": return id === "school" || ((id === "security" || id === "downtime" || id === "options") && r.signedIn) || (id === "email" && r.isStaff) || r.isAdmin;
    case "subjects": case "teachers": case "sections": case "students": case "gradingAssignments": case "curriculum": return r.active;
    case "grades": return r.isStaff || (r.isTeacher && data.teacherDocId === r.myTeacher);
    case "gradeChangeRequests": return r.isStaff || r.isApprover || (r.isTeacher && data.teacherDocId === r.myTeacher);
    case "rosterRequests": return r.isStaff || (r.isTeacher && data.teacherDocId === r.myTeacher);
    case "notifications": return r.signedIn && data.toUid === r.uid;
    default: return r.isAdmin;
  }
}

function canWrite(r, op, col, id, before, after) {
  switch (col) {
    case "meta":
      if (id !== "setup") return r.isAdmin;
      return op === "create" && r.signedIn && after.adminUid === r.uid;
    case "usernames":
      if (op === "create") return r.isAdmin || (r.signedIn && firstSetup(r) && after.uid === r.uid);
      return r.isAdmin;
    case "users":
      if (op === "create") return r.isAdmin || (r.signedIn && r.uid === id && firstSetup(r) && after.role === "admin" && after.active === true);
      if (op === "update") {
        // Everyone may record their own active device and "last active" time, and clear their own "must change password" mark
        // the "must change password" mark may stay as it is, or be cleared, but never switched on
        const markOk = same(before.mustChangePassword, after.mustChangePassword) || after.mustChangePassword === false;
        return r.isAdmin || (r.signedIn && r.uid === id && markOk &&
          onlyKeysChanged(before, after, ["activeSession", "mustChangePassword", "updatedAt", "lastSeen"]));
      }
      return r.isAdmin;
    case "settings":
      return r.isAdmin;
    case "subjects": case "teachers": case "sections": case "students": case "gradingAssignments": case "curriculum":
      return r.isStaff;
    case "grades": {
      const valid = validGradeRecord(after, r);
      if (op === "create") return (r.isStaff || (teacherOwnsNew(r, after, id) && !teachersLocked(r) && draftFlagOk(after))) && valid;
      // A teacher changes their own draft; an approver changes only the grade itself
      // (the class, units and student stay as they are)
      if (op === "update") return r.isStaff || (teacherDraft(r, before) && draftStaysInClass(r, before, after, id) && valid) ||
        (r.isApprover && valid && approvedChange(r, id, after) &&
        onlyKeysChanged(before, after, ["finalGrade", "remarks", "lastChangeRequestId", "lastChangedByName", "updatedAt"]));
      return r.isStaff || teacherDraft(r, before);
    }
    case "gradeChangeRequests": {
      if (op === "create") {
        if (r.isAdmin) return true;
        const g = after && r.before("grades", after.gradeId);
        return r.isTeacher && !teachersLocked(r) && after.teacherDocId === r.myTeacher && !!g && g.teacherDocId === r.myTeacher &&
          after.requestedBy === r.uid && after.status === "pending" &&
          (isMark(after.newGrade, after.newRemarks) || (isGrade(after.newGrade, r) && after.newRemarks === remarksOf(after.newGrade, r))) &&
          typeof after.reason === "string" && after.reason.length >= 10;
      }
      if (op === "update") {
        if (r.isAdmin) return true;
        const decide = r.isApprover && before.status === "pending" && before.requestedBy !== r.uid &&
          (after.status === "approved" || after.status === "declined") && after.decidedBy === r.uid &&
          onlyKeysChanged(before, after, ["status", "decidedBy", "decidedByName", "decidedAt", "decisionNote"]);
        const cancel = r.active && before.requestedBy === r.uid && before.status === "pending" && after.status === "cancelled" &&
          onlyKeysChanged(before, after, ["status", "decidedAt"]);
        return decide || cancel;
      }
      return r.isStaff;
    }
    case "rosterRequests": {
      // Class list requests (as in firestore.rules): a teacher drafts and submits for their own
      // class, and may withdraw until the registrar decides the first line; only staff decide.
      if (r.isStaff) return true;
      if (!r.isTeacher || teachersLocked(r)) return false;
      const itemsOk = function (d) { return !!d && Array.isArray(d.items) && d.items.length <= 50; };
      if (op === "create") {
        const a = after && r.before("gradingAssignments", after.assignmentId);
        return itemsOk(after) && after.teacherDocId === r.myTeacher && !!a && a.teacherDocId === r.myTeacher &&
          after.requestedBy === r.uid && (after.status === "draft" || after.status === "submitted") && after.reviewStarted === false;
      }
      const own = !!before && before.teacherDocId === r.myTeacher && before.requestedBy === r.uid;
      if (op === "update") {
        if (!own || !itemsOk(after)) return false;
        const fixed = ["assignmentId", "teacherDocId", "requestedBy", "reviewStarted"].every(function (k) { return same(before[k], after[k]); });
        if (!fixed) return false;
        if (before.status === "draft") return ["draft", "submitted", "withdrawn"].indexOf(after.status) >= 0;
        return before.status === "submitted" && after.status === "withdrawn" && before.reviewStarted === false && same(before.items, after.items);
      }
      return own && before.status === "draft";
    }
    case "auditLog":
      // Entries are written by this script with each change; administrators may delete old ones
      return op === "delete" && r.isAdmin;
    case "notifications":
      if (op === "create") return r.active && after.fromUid === r.uid && after.read === false;
      if (op === "update") return r.signedIn && before.toUid === r.uid && onlyKeysChanged(before, after, ["read", "readAt"]);
      return r.signedIn && before.toUid === r.uid;
    default:
      return r.isAdmin;
  }
}

/** Teacher downtime (School settings): teachers can't add grades or change requests. */
function teachersLocked(r) {
  const d = r.before("settings", "downtime");
  if (!d || d.teachersLocked !== true) return false;
  const until = d.until && typeof d.until === "object" && d.until.__ts ? Date.parse(d.until.__ts) : null;
  return !until || Date.now() < until;
}

/**
 * Draft, then Submit (as in firestore.rules): a teacher may change or clear their own grade while
 * it is a draft (saved, not submitted yet), until the term deadline or downtime. Submitted
 * grades, and grades saved before drafts existed (no draft field), stay locked.
 */
function teacherDraft(r, b) {
  if (!r.isTeacher || teachersLocked(r) || !b || b.draft !== true || b.teacherDocId !== r.myTeacher) return false;
  const a = r.before("gradingAssignments", b.assignmentId);
  return !!a && a.teacherDocId === r.myTeacher && termOpen(r, a) && inSchoolYear(a);
}
/**
 * A draft belongs to its school year: from Aug 1 of the year it ends ("2026-2027" → Aug 1, 2027)
 * it is locked for good, even if the same term's deadline is set again for a later school year.
 * School years written another way aren't limited by this.
 */
function inSchoolYear(a) {
  const m = /^[^-]*-(\d{4})$/.exec(String(a.schoolYear || ""));
  return !m || Date.now() < Date.UTC(Number(m[1]), 7, 1);
}
/** The changed draft still belongs to the same student and class. */
function draftStaysInClass(r, b, d, id) {
  if (!d || d.teacherDocId !== r.myTeacher || d.assignmentId !== b.assignmentId || d.studentId !== b.studentId) return false;
  const a = r.before("gradingAssignments", d.assignmentId);
  return !!a && (a.studentIds || []).indexOf(d.studentId) >= 0 && matchesClass(d, a, id) && draftFlagOk(d);
}
function draftFlagOk(d) { return d.draft === undefined || typeof d.draft === "boolean"; }

function teacherOwnsNew(r, d, id) {
  if (!r.isTeacher || !d || d.teacherDocId !== r.myTeacher) return false;
  const a = r.before("gradingAssignments", d.assignmentId);
  return !!a && a.teacherDocId === r.myTeacher && (a.studentIds || []).indexOf(d.studentId) >= 0 && termOpen(r, a) &&
    matchesClass(d, a, id);
}
/**
 * A teacher's grade must belong to its class exactly (as in firestore.rules): one record per
 * student and class (id = assignmentId_studentId), with the class's subject, units, school year,
 * term and section. Final grades / GWA use these copies, so they can't be made up.
 */
function matchesClass(d, a, id) {
  const v = function (x) { return x === undefined ? null : x; };
  return id === d.assignmentId + "_" + d.studentId &&
    same(v(d.subjectId), v(a.subjectId)) && same(v(d.units), v(a.units)) && same(v(d.schoolYear), v(a.schoolYear)) &&
    (d.term || "") === (a.term || "") && same(v(d.sectionId), v(a.sectionId));
}
function approvedChange(r, gradeId, d) {
  const req = d && d.lastChangeRequestId ? r.after("gradeChangeRequests", d.lastChangeRequestId) : null;
  const g = function (v) { return v === undefined ? null : v; };
  return !!req && req.status === "approved" && req.gradeId === gradeId && g(req.newGrade) === g(d.finalGrade) &&
    g(req.newRemarks) === g(d.remarks) && req.decidedBy === r.uid;
}

// ---------------------------------------------------------- audit trail (same as js/audit.js)
const AUDIT_NOISE = ["activeSession", "lastSeen", "updatedAt", "createdAt"];

function auditValue(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") {
    if (v.indexOf("data:image") === 0) return "[image]";
    return v.length > 300 ? v.slice(0, 300) + "…" : v;
  }
  if (typeof v !== "object") return v;
  if (typeof v.__ts === "string") return v.__ts;
  if (Array.isArray(v)) {
    const list = v.slice(0, 100).map(auditValue);
    if (v.length > 100) list.push("… and " + (v.length - 100) + " more");
    return list;
  }
  const o = {};
  Object.keys(v).forEach(function (k) { o[k] = auditValue(v[k]); });
  return o;
}

function auditLabel(col, d, id) {
  d = d || {};
  const j = function () { return Array.prototype.slice.call(arguments).filter(function (x) { return x !== undefined && x !== null && String(x).trim() !== ""; }).join(" · "); };
  switch (col) {
    case "students": return j(d.studentName, d.studentId);
    case "teachers": return j(d.teacherName, d.teacherId);
    case "subjects": return j(d.subjectCode, d.subjectName);
    case "sections": return j(d.sectionName, d.yearLevel, d.schoolYear);
    case "gradingAssignments": return j(d.subjectCode, d.sectionName, d.teacherName, d.schoolYear, d.term);
    case "curriculum": return j(d.program, d.yearLevel, d.term);
    case "grades": return j(d.studentName, d.subjectCode, d.sectionName);
    case "gradeChangeRequests": return j(d.studentName, d.subjectCode, d.status);
    case "rosterRequests": return j(d.subjectCode, d.sectionName, d.status);
    case "users": return j(d.displayName, d.username, d.role);
    case "settings": return ({ school: "School details", security: "Sign-in security", email: "Email sending", downtime: "Teacher downtime", options: "Setup and options", sheets: "Google Sheets copy" })[id] || id;
    default: return id || "";
  }
}

/** Audit entries for the planned writes of one commit. */
function auditEntries(planned, ctx, nowIso) {
  const me = ctx.me || {};
  const who = { byUid: ctx.uid || "", byName: me.displayName || me.username || "", byRole: me.role || "" };
  const out = [];
  let auditDeletes = 0;
  planned.forEach(function (p) {
    if (p.col === "auditLog") { if (p.type === "delete" && p.before) auditDeletes++; return; }
    if (p.col === "notifications") return;
    if (p.type === "delete" && !p.before) return;
    const action = p.type === "delete" ? "delete" : p.before ? "update" : "create";
    const seen = {};
    Object.keys(p.before || {}).concat(Object.keys(p.after || {})).forEach(function (k) { seen[k] = 1; });
    const changed = Object.keys(seen).filter(function (k) {
      if (AUDIT_NOISE.indexOf(k) >= 0) return false;
      return action !== "update" || !same((p.before || {})[k], (p.after || {})[k]);
    });
    if (action === "update" && !changed.length) return; // only background noise changed
    const pick = function (obj) {
      const o = {};
      if (obj) changed.forEach(function (k) { if (Object.prototype.hasOwnProperty.call(obj, k)) o[k] = auditValue(obj[k]); });
      return o;
    };
    out.push(Object.assign({ at: { __ts: nowIso } }, who, {
      action: action, col: p.col, docId: p.id, label: auditLabel(p.col, p.after || p.before, p.id),
      before: action === "create" ? {} : pick(p.before),
      after: action === "delete" ? {} : pick(p.after),
    }));
  });
  if (auditDeletes) {
    out.push(Object.assign({ at: { __ts: nowIso } }, who, {
      action: "delete", col: "auditLog", docId: "", label: auditDeletes + " audit trail entr" + (auditDeletes === 1 ? "y" : "ies"), before: {}, after: {},
    }));
  }
  return out;
}

// ---------------------------------------------------------- reads
function getOne(ctx, path) {
  const p = parsePath(path);
  const data = loadCol(ctx, p.col).map[p.id];
  if (!data) return null;
  if (!canRead(rulesFor(ctx, null), p.col, p.id, data)) fail("permission-denied", "You don't have access to this record.");
  return { id: p.id, data: data };
}

function fieldValue(d, field) { return field === "__name__" ? d.id : d.data[field]; }
function sortKey(v) { return v && typeof v === "object" && typeof v.__ts === "string" ? v.__ts : v; }
function compare(a, b) {
  a = sortKey(a); b = sortKey(b);
  if (a === b) return 0;
  if (a === undefined || a === null) return 1;
  if (b === undefined || b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
function matches(d, w) {
  const v = fieldValue(d, w[0]);
  const op = w[1], val = w[2];
  switch (op) {
    case "==": return v !== undefined && same(v, val);
    case "!=": return v !== undefined && !same(v, val);
    case "in": return v !== undefined && (val || []).some(function (x) { return same(v, x); });
    case "not-in": return v !== undefined && !(val || []).some(function (x) { return same(v, x); });
    case "array-contains": return Array.isArray(v) && v.some(function (x) { return same(x, val); });
    case "<": return v !== undefined && compare(v, val) < 0;
    case "<=": return v !== undefined && compare(v, val) <= 0;
    case ">": return v !== undefined && compare(v, val) > 0;
    case ">=": return v !== undefined && compare(v, val) >= 0;
    default: fail("invalid-argument", "Unsupported filter: " + op);
  }
}

function runQuery(ctx, col, where, orderBy, limitN) {
  const r = rulesFor(ctx, null);
  if ((col === "usernames" || col === "settings" || col === "meta") && !r.isAdmin) fail("permission-denied", "You can't list " + col + ".");
  const c = loadCol(ctx, col);
  let docs = c.ids.map(function (id) { return { id: id, data: c.map[id] }; })
    .filter(function (d) { return where.every(function (w) { return matches(d, w); }); })
    .filter(function (d) { return canRead(r, col, d.id, d.data); });
  if (orderBy.length) {
    docs.sort(function (x, y) {
      for (let i = 0; i < orderBy.length; i++) {
        const o = compare(fieldValue(x, orderBy[i][0]), fieldValue(y, orderBy[i][0]));
        if (o) return orderBy[i][1] === "desc" ? -o : o;
      }
      return 0;
    });
  }
  if (limitN) docs = docs.slice(0, limitN);
  return docs;
}

// ---------------------------------------------------------- writes (all-or-nothing)
function resolveServerTimes(v, nowIso) {
  if (Array.isArray(v)) return v.map(function (x) { return resolveServerTimes(x, nowIso); });
  if (v && typeof v === "object") {
    if (v.__serverTimestamp === true) return { __ts: nowIso };
    const o = {};
    Object.keys(v).forEach(function (k) { o[k] = resolveServerTimes(v[k], nowIso); });
    return o;
  }
  return v;
}

function commit(ctx, ops) {
  if (!ops.length) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) fail("unavailable", "The database is busy. Try again in a moment.");
  try {
    // Read fresh data inside the lock
    ctx.cache = {};
    if (ctx.uid) ctx.me = loadCol(ctx, "users").map[ctx.uid] || null;
    const nowIso = new Date().toISOString();
    const after = {};
    const planned = ops.map(function (op) {
      const p = parsePath(op.path);
      const current = after[p.col] && Object.prototype.hasOwnProperty.call(after[p.col], p.id)
        ? after[p.col][p.id]
        : loadCol(ctx, p.col).map[p.id] || null;
      const data = op.data ? resolveServerTimes(op.data, nowIso) : null;
      let next;
      if (op.type === "delete") next = null;
      else if (op.type === "update") {
        if (!current) fail("not-found", "No record to update: " + op.path);
        next = Object.assign({}, current, data);
      } else if (op.type === "set") {
        next = op.merge && current ? Object.assign({}, current, data) : Object.assign({}, data);
      } else fail("invalid-argument", "Unknown write: " + op.type);
      if (!after[p.col]) after[p.col] = {};
      after[p.col][p.id] = next;
      return { type: op.type, col: p.col, id: p.id, before: current, after: next };
    });
    const r = rulesFor(ctx, after);
    planned.forEach(function (p) {
      if (p.type === "delete" && !p.before) return; // deleting something missing is fine
      const kind = p.type === "delete" ? "delete" : p.before ? "update" : "create";
      if (!canWrite(r, kind, p.col, p.id, p.before, p.after)) {
        fail("permission-denied", "Not allowed: " + kind + " in " + p.col + ".");
      }
    });
    // Audit trail: who added / edited / deleted what, with the old and new values
    const entries = auditEntries(planned, ctx, nowIso);
    if (entries.length) {
      if (!after.auditLog) after.auditLog = {};
      entries.forEach(function (e) { after.auditLog[Utilities.getUuid().replace(/-/g, "")] = e; });
    }
    Object.keys(after).forEach(function (col) { persist(ctx, col, after[col]); });
  } finally {
    lock.releaseLock();
  }
}
