// ==========================================================
// Firebase connection and database choice
//
// ONE TIME: the school's Firebase connection is written below (BUILT_IN_CONFIG).
// Every device and account then uses it automatically: no setup per device.
// The easiest way: open the website, paste your Firebase config on the
// setup screen, click "Download firebase-config.js", put the file in js/, push.
//
// After that, the DATABASE is chosen by administrators inside the system
// (School settings → Database: Firebase Firestore, a Google Sheet or Supabase), for the
// whole school. Every device follows it automatically.
//
// The Firebase web config is meant to be public (every Firebase website sends
// it to the browser). Data is protected by sign-in and the security rules.
// Never put service-account / private keys here.
// ==========================================================

import {
  initializeApp,
  deleteApp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import * as FS from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import * as SH from "./sheets-db.js";
import { track, tracked, trackedSnapshot } from "./loading.js";
import { auditEntries } from "./audit.js";
import { createSupabaseDb, isSupabaseUrl, supabaseKeyProblem, cleanSupabaseUrl } from "./supabase-db.js";

// The school's Firebase connection: replace the YOUR_… values once (see above).
const BUILT_IN_CONFIG = {
  apiKey: "AIzaSyCpwy-9iKQxjsYhko4a52BTe4EBTFlvfxw",
  authDomain: "lunagococolleges.firebaseapp.com",
  projectId: "lunagococolleges",
  storageBucket: "lunagococolleges.firebasestorage.app",
  messagingSenderId: "1085690207408",
  appId: "1:1085690207408:web:5e1ae79feec4b85eb06f75",
  measurementId: "G-PFPJK6306W"
};

export const CONNECTION_KEY = "gs-firebase-connection";
export const CONFIG_FIELDS = [
  "apiKey",
  "authDomain",
  "projectId",
  "storageBucket",
  "messagingSenderId",
  "appId",
];
export const BACKENDS = {
  firestore: "Firebase Firestore",
  sheets: "Google Sheets",
  supabase: "Supabase",
};

export function isCompleteConfig(c) {
  return Boolean(
    c &&
    c.apiKey &&
    c.projectId &&
    c.appId &&
    c.authDomain &&
    !String(c.apiKey).startsWith("YOUR_") &&
    !String(c.projectId).startsWith("YOUR_"),
  );
}

export function isSheetsDatabaseUrl(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(
    String(url || "").trim(),
  );
}

export { isSupabaseUrl };

/** A valid database choice: Firestore unless the Sheet / Supabase details are complete. */
function normalizeChoice(c) {
  const sheetsUrl = String((c && c.sheetsUrl) || "").trim();
  const supabaseUrl = cleanSupabaseUrl(c && c.supabaseUrl);
  const supabaseKey = String((c && c.supabaseKey) || "").trim();
  const backend =
    c && c.backend === "sheets" && isSheetsDatabaseUrl(sheetsUrl)
      ? "sheets"
      : c && c.backend === "supabase" && isSupabaseUrl(supabaseUrl) && !supabaseKeyProblem(supabaseKey)
        ? "supabase"
        : "firestore";
  return {
    backend,
    sheetsUrl: backend === "sheets" ? sheetsUrl : "",
    supabaseUrl: backend === "supabase" ? supabaseUrl : "",
    supabaseKey: backend === "supabase" ? supabaseKey : "",
  };
}

// Devices no longer keep their own connection: the website's built-in one (above) is used
// everywhere. Remove anything older versions saved on this device.
try {
  localStorage.removeItem(CONNECTION_KEY);
} catch {}

/** Kept so older code keeps working; nothing is saved on the device any more. */
export function saveConnection() {}
export function clearConnection() {
  try {
    localStorage.removeItem(CONNECTION_KEY);
  } catch {}
}

// Ignore optional values that were left as placeholders
const builtIn = isCompleteConfig(BUILT_IN_CONFIG)
  ? Object.fromEntries(
      Object.entries(BUILT_IN_CONFIG).filter(
        ([, v]) => v && !String(v).startsWith("YOUR_"),
      ),
    )
  : null;

export const builtInAvailable = Boolean(builtIn);
/** "built-in" = the school's connection written in this file; null = not written yet */
export const connectionSource = builtIn ? "built-in" : null;
export const isConfigured = Boolean(builtIn);

// ---------- The school's database choice (set by administrators in School settings) ----------
// Kept in the school's Firebase at settings/connection: { backend, sheetsUrl, … }.
// Read through Firebase's public web address, so every device knows it before anyone
// signs in. Only administrators can change it (firestore.rules).
const CHOICE_CACHE = "gs-school-database";

async function readSchoolChoice() {
  if (!builtIn) return null;
  try {
    const c = JSON.parse(sessionStorage.getItem(CHOICE_CACHE) || "null");
    if (c && Date.now() - c.at < 60 * 1000) return c.choice; // this tab's copy, at most a minute old
  } catch {}
  try {
    const url =
      `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(builtIn.projectId)}` +
      `/databases/(default)/documents/settings/connection?key=${encodeURIComponent(builtIn.apiKey)}`;
    const res = await fetch(url, { cache: "no-store" });
    let choice;
    if (res.ok) {
      const f = (await res.json()).fields || {};
      const str = (k) => (f[k] && f[k].stringValue) || "";
      choice = {
        ...normalizeChoice({
          backend: str("backend"),
          sheetsUrl: str("sheetsUrl"),
          supabaseUrl: str("supabaseUrl"),
          supabaseKey: str("supabaseKey"),
        }),
        updatedAt: (f.updatedAt && f.updatedAt.timestampValue) || "",
        updatedBy: (f.updatedByName && f.updatedByName.stringValue) || "",
        adminUids: (
          (f.adminUids &&
            f.adminUids.arrayValue &&
            f.adminUids.arrayValue.values) ||
          []
        ).map((v) => v.stringValue),
      };
    } else if (res.status === 404) {
      choice = { missing: true }; // not chosen yet: the built-in default is used
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
    try {
      sessionStorage.setItem(
        CHOICE_CACHE,
        JSON.stringify({ at: Date.now(), choice }),
      );
    } catch {}
    return choice;
  } catch (err) {
    console.warn(
      "School database choice unavailable:",
      err && err.message ? err.message : err,
    );
    return null; // offline or rules not published: the built-in default is used
  }
}

export const schoolChoice = await readSchoolChoice();
/** "ok" | "not-set" | "unreachable" | "not-configured" */
export const schoolChoiceStatus = !builtIn
  ? "not-configured"
  : schoolChoice === null
    ? "unreachable"
    : schoolChoice.missing
      ? "not-set"
      : "ok";

const builtInDefault = normalizeChoice(builtIn);
const activeChoice =
  schoolChoice && !schoolChoice.missing ? schoolChoice : builtInDefault;

/** The connection every device uses: the built-in Firebase + the school's database choice. */
export const connectionConfig = builtIn
  ? {
      ...Object.fromEntries(
        CONFIG_FIELDS.filter((k) => builtIn[k]).map((k) => [k, builtIn[k]]),
      ),
      ...normalizeChoice(activeChoice),
    }
  : null;
/** "firestore" | "sheets" | "supabase" */
export const databaseBackend = connectionConfig ? connectionConfig.backend : "firestore";
export const sheetsDatabaseUrl =
  databaseBackend === "sheets" ? connectionConfig.sheetsUrl : "";
export const supabaseUrl =
  databaseBackend === "supabase" ? connectionConfig.supabaseUrl : "";
export const supabaseKey =
  databaseBackend === "supabase" ? connectionConfig.supabaseKey : "";
// Google Sheets and Supabase answer the same requests (sheets-db.js functions)
const useSheets = databaseBackend === "sheets" || databaseBackend === "supabase";

// Only the Firebase fields go to Firebase; a harmless placeholder keeps the SDK happy until connected
const firebaseConfig = connectionConfig
  ? Object.fromEntries(
      CONFIG_FIELDS.filter((k) => connectionConfig[k]).map((k) => [
        k,
        connectionConfig[k],
      ]),
    )
  : {
      apiKey: "not-configured",
      authDomain: "localhost",
      projectId: "not-configured",
      appId: "not-configured",
    };

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// People sign in with a username; Firebase Auth needs an email, so each
// username is stored behind an internal address on this domain.
export const USERNAME_EMAIL_DOMAIN = "gradingsystem.local";

// ---------- Firestore (default) ----------
// Keep a copy of the data on this device (IndexedDB). When a list is requested
// again, Firebase sends only what changed, so you're charged only for those reads.
function startFirestore() {
  try {
    return FS.initializeFirestore(app, {
      localCache: FS.persistentLocalCache({
        tabManager: FS.persistentMultipleTabManager(),
      }),
    });
  } catch (err) {
    console.warn(
      "Device cache unavailable, using memory only:",
      err?.code || err,
    );
    return FS.getFirestore(app);
  }
}

/**
 * Same as Firestore's getDocs (always up to date with the server), but read
 * through a short-lived listener. With the device cache, asking for the same
 * list again (within about 30 minutes) only costs reads for documents that
 * changed since last time, instead of the whole list.
 */
function firestoreGetDocs(q) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let fromCacheSnap = null;
    let unsubscribe = () => {};
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      setTimeout(() => unsubscribe(), 0);
      fn(value);
    };
    const timer = setTimeout(() => {
      // No answer from the server: use the device copy if there is one, else a normal read
      if (settled) return;
      if (fromCacheSnap) finish(resolve, fromCacheSnap);
      else {
        settled = true;
        setTimeout(() => unsubscribe(), 0);
        FS.getDocs(q).then(resolve, reject);
      }
    }, 15000);
    unsubscribe = FS.onSnapshot(
      q,
      { includeMetadataChanges: true },
      (snap) => {
        if (!snap.metadata.fromCache)
          finish(resolve, snap); // confirmed by the server
        else fromCacheSnap = snap;
      },
      (err) => finish(reject, err),
    );
  });
}

// ---------- The database the pages use ----------
const signInToken = () =>
  auth.currentUser ? auth.currentUser.getIdToken() : Promise.resolve(null);
export const db =
  databaseBackend === "supabase"
    ? createSupabaseDb({
        url: supabaseUrl,
        key: supabaseKey,
        projectId: firebaseConfig.projectId,
        getToken: signInToken,
      })
    : databaseBackend === "sheets"
      ? SH.createSheetsDb({ url: sheetsDatabaseUrl, getToken: signInToken })
      : startFirestore();

const pick = (name) => (useSheets ? SH[name] : FS[name]);
export const collection = pick("collection");
export const doc = pick("doc");
// ---------- Audit trail (Firebase): every save also records who changed what ----------
// Google Sheets and Supabase record it in the database itself (Database.gs / schema.sql).
let auditActor = { uid: "", name: "", role: "" };
/** Who is making changes (set by app.js once the signed-in profile is known). */
export function setAuditActor(actor) {
  auditActor = { uid: "", name: "", role: "", ...(actor || {}) };
}

/** Commits writes with their audit entries, in the same Firestore batch (all or nothing). */
async function commitAudited(database, ops) {
  if (!ops.length) return;
  const uid = auth.currentUser ? auth.currentUser.uid : "";
  // Old values (a record the user can't read counts as unknown)
  const befores = uid
    ? await Promise.all(ops.map((op) => FS.getDoc(op.ref).then((s) => (s.exists() ? s.data() : null), () => undefined)))
    : [];
  // ≤ 200 changes per batch, so changes + entries stay under Firestore's 500 limit
  for (let i = 0; i < ops.length; i += 200) {
    const part = ops.slice(i, i + 200);
    const batch = FS.writeBatch(database);
    part.forEach((op) => {
      if (op.type === "delete") batch.delete(op.ref);
      else if (op.type === "update") batch.update(op.ref, op.data);
      else batch.set(op.ref, op.data, op.options || {});
    });
    if (uid) {
      const entries = auditEntries(part.map((op, k) => ({
        type: op.type, col: op.ref.parent.id, id: op.ref.id, before: befores[i + k],
        data: op.data, merge: !!(op.options && op.options.merge),
      })), { ...auditActor, uid });
      entries.forEach((e) => batch.set(FS.doc(FS.collection(database, "auditLog")), { ...e, at: FS.serverTimestamp() }));
    }
    await batch.commit();
  }
}

function auditedBatch(database) {
  const ops = [];
  const batch = {
    set(ref, data, options) { ops.push({ type: "set", ref, data, options }); return batch; },
    update(ref, data) { ops.push({ type: "update", ref, data }); return batch; },
    delete(ref) { ops.push({ type: "delete", ref }); return batch; },
    commit: () => track(commitAudited(database, ops)),
  };
  return batch;
}

// Reads and saves show the loading bar (loading.js) while they run
export const addDoc = useSheets
  ? tracked(SH.addDoc)
  : async (colRef, data) => {
      const ref = FS.doc(colRef);
      await auditedBatch(db).set(ref, data).commit();
      return ref;
    };
export const setDoc = useSheets ? tracked(SH.setDoc) : (ref, data, options) => auditedBatch(db).set(ref, data, options).commit();
export const getDoc = tracked(pick("getDoc"));
export const updateDoc = useSheets ? tracked(SH.updateDoc) : (ref, data) => auditedBatch(db).update(ref, data).commit();
export const deleteDoc = useSheets ? tracked(SH.deleteDoc) : (ref) => auditedBatch(db).delete(ref).commit();
// Background saves that shouldn't show the spinner (e.g. "last active" every few minutes)
export const updateDocQuiet = pick("updateDoc");
export const query = pick("query");
export const where = pick("where");
export const orderBy = pick("orderBy");
export const limit = pick("limit");
export const documentId = pick("documentId");
export const serverTimestamp = pick("serverTimestamp");
export const writeBatch = (database) => {
  if (!useSheets) return auditedBatch(database);
  const batch = SH.writeBatch(database);
  const commit = batch.commit.bind(batch);
  batch.commit = () => track(commit());
  return batch;
};
export const getCountFromServer = tracked(pick("getCountFromServer"));
export const onSnapshot = trackedSnapshot(pick("onSnapshot"));
export const Timestamp = pick("Timestamp");
export const getDocs = tracked(useSheets ? SH.getDocs : firestoreGetDocs);
// The real Firestore getter (for temporary connection tests on the setup screen)
export const getFirestore = FS.getFirestore;

// ---------- Saving the school's database choice (administrators) ----------
// The choice and its history always live in the school's Firebase (Firestore), even when
// the records themselves are in a Google Sheet or Supabase.
const homeDb = () => (useSheets ? FS.getFirestore(app) : db);

function shortSummary(c) {
  return {
    backend: c.backend,
    sheet:
      c.backend === "sheets" && c.sheetsUrl
        ? `…${String(c.sheetsUrl)
            .replace(/\/exec\/?$/, "")
            .slice(-8)}`
        : c.backend === "supabase" && c.supabaseUrl
          ? String(c.supabaseUrl).replace(/^https:\/\//, "")
          : "",
  };
}

/**
 * Sets the database for the whole school. adminUids = administrators allowed to change it
 * (needed when the records are in a Google Sheet, where Firestore can't see the roles).
 */
export async function saveSchoolChoice({
  backend,
  sheetsUrl = "",
  supabaseUrl: sbUrl = "",
  supabaseKey: sbKey = "",
  byName = "",
  adminUids = [],
  reason = "",
}) {
  const uid = auth.currentUser ? auth.currentUser.uid : "";
  const next = normalizeChoice({ backend, sheetsUrl, supabaseUrl: sbUrl, supabaseKey: sbKey });
  const roster = [
    ...new Set(
      [
        ...((schoolChoice && schoolChoice.adminUids) || []),
        ...adminUids,
        uid,
      ].filter(Boolean),
    ),
  ];
  const batch = FS.writeBatch(homeDb());
  batch.set(FS.doc(homeDb(), "settings", "connection"), {
    ...next,
    adminUids: roster,
    updatedAt: FS.serverTimestamp(),
    updatedByName: byName,
    updatedByUid: uid,
  });
  batch.set(FS.doc(FS.collection(homeDb(), "connectionHistory")), {
    at: FS.serverTimestamp(),
    byName,
    byUid: uid,
    reason: String(reason).slice(0, 120),
    from:
      schoolChoice && !schoolChoice.missing
        ? shortSummary(schoolChoice)
        : null,
    to: shortSummary(next),
  });
  await batch.commit();
  try {
    sessionStorage.removeItem(CHOICE_CACHE);
  } catch {}
}

/**
 * Keeps the list of administrators allowed to change the school's database up to date
 * (adds the given accounts). Only someone already allowed can do this (firestore.rules).
 */
export async function addSchoolAdmins(uids) {
  const add = [...new Set((uids || []).filter(Boolean))];
  const have = new Set((schoolChoice && schoolChoice.adminUids) || []);
  const missing = add.filter((u) => !have.has(u));
  if (!missing.length || !schoolChoice || schoolChoice.missing) return 0;
  await FS.updateDoc(FS.doc(homeDb(), "settings", "connection"), {
    adminUids: FS.arrayUnion(...missing),
  });
  try {
    sessionStorage.removeItem(CHOICE_CACHE);
  } catch {}
  return missing.length;
}

/** Is this account on the list of administrators allowed to change the school's database? */
export function isSchoolAdmin(uid) {
  return !!(
    uid &&
    schoolChoice &&
    !schoolChoice.missing &&
    (schoolChoice.adminUids || []).includes(uid)
  );
}

/** Administrators: the latest changes, newest first. */
export async function readSchoolHistory() {
  const snap = await FS.getDocs(
    FS.query(
      FS.collection(homeDb(), "connectionHistory"),
      FS.orderBy("at", "desc"),
      FS.limit(50),
    ),
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Forget this tab's copy of the choice (next page load reads it fresh). */
export function refreshSchoolChoice() {
  try {
    sessionStorage.removeItem(CHOICE_CACHE);
  } catch {}
}

/** Erases this device's copy of the data (used when signing out). */
export async function clearDeviceCache() {
  if (useSheets) return; // nothing is cached on the device with Google Sheets or Supabase
  try {
    await FS.terminate(db);
    await FS.clearIndexedDbPersistence(db);
  } catch (err) {
    console.warn("Couldn't clear the device cache:", err?.code || err);
  }
}

export {
  firebaseConfig,
  initializeApp,
  deleteApp,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
};
