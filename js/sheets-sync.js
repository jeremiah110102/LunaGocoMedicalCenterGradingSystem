// ==========================================================
// sheets-sync.js — Copies the database into a Google Sheet through
// the Apps Script in google-apps-script/SheetsCopy.gs (one tab per list).
//
// Settings (administrators only) live in settings/sheets:
//   { url, key, autoSync, lastSyncAt, lastSyncBy, lastCounts, sheetUrl }
// It's a one-way copy: Firebase stays the real database.
// ==========================================================

import { db, collection, doc, getDoc, getDocs, setDoc, serverTimestamp, databaseBackend } from "./firebase-config.js";

// What goes into the sheet (tab name → collection). Passwords, sign-in details,
// email keys and the sync key are never included.
const TABLES = [
  { tab: "Subjects", name: "subjects" },
  { tab: "Teachers", name: "teachers" },
  { tab: "Sections", name: "sections" },
  { tab: "Students", name: "students" },
  { tab: "Grading assignments", name: "gradingAssignments" },
  { tab: "Grades", name: "grades" },
  { tab: "Grade change requests", name: "gradeChangeRequests" },
  { tab: "Class list requests", name: "rosterRequests" },
  { tab: "Users", name: "users", drop: ["authEmail"] },
  { tab: "School", name: "settings", onlyIds: ["school"] },
];

// Readable column order for the main tabs; any other fields follow
const COLUMN_ORDER = {
  subjects: ["subjectCode", "subjectName", "units"],
  teachers: ["teacherId", "teacherName"],
  sections: ["schoolYear", "yearLevel", "sectionName"],
  students: ["studentId", "studentName", "schoolYear", "yearLevel", "sectionName", "email"],
  gradingAssignments: ["schoolYear", "yearLevel", "sectionName", "subjectCode", "subjectName", "units", "teacherId", "teacherName"],
  grades: ["schoolYear", "yearLevel", "sectionName", "studentNumber", "studentName", "subjectCode", "subjectName", "units", "finalGrade", "remarks", "teacherName"],
  gradeChangeRequests: ["status", "schoolYear", "sectionName", "studentNumber", "studentName", "subjectCode", "oldGrade", "newGrade", "reason", "requestedByName", "decidedByName", "decisionNote"],
  rosterRequests: ["status", "schoolYear", "term", "sectionName", "subjectCode", "teacherName", "requestedByName", "items"],
  users: ["username", "displayName", "role", "active", "canApprove", "teacherDocId"],
};

export const SHEETS_SETTINGS = doc(db, "settings", "sheets");
const DAY = 24 * 60 * 60 * 1000;

export function isAppsScriptUrl(url) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec\/?$/.test(String(url || "").trim());
}

/** One sheet cell: dates as text, lists as JSON, and text that looks like a formula kept as text. */
export function toSheetCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value?.toDate === "function") return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string") {
    const s = value.length > 49000 ? value.slice(0, 49000) + "…" : value; // Sheets cell limit is 50,000
    return /^[=+@]/.test(s) ? `'${s}` : s; // never let data run as a formula in the sheet
  }
  return value;
}

/** Builds { name, headers, rows } for one collection. */
export function buildTable(tab, docs, { drop = [], name } = {}) {
  const order = COLUMN_ORDER[name] || [];
  const keys = [];
  docs.forEach((d) => Object.keys(d.data).forEach((k) => {
    if (!drop.includes(k) && !keys.includes(k)) keys.push(k);
  }));
  keys.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
  const headers = ["_id", ...keys];
  const rows = docs.map((d) => [d.id, ...keys.map((k) => toSheetCell(d.data[k]))]);
  return { name: tab, headers, rows };
}

export async function loadSheetsSettings() {
  const snap = await getDoc(SHEETS_SETTINGS);
  return snap.exists() ? snap.data() : {};
}

async function post(url, payload) {
  let res;
  try {
    // text/plain keeps this a "simple" request, which Apps Script accepts from any website
    res = await fetch(url, { method: "POST", body: JSON.stringify(payload), redirect: "follow" });
  } catch {
    throw new Error("Couldn't reach the Google Apps Script. Check the Web app URL and your internet connection.");
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("The Apps Script didn't answer correctly. Deploy it as a Web app with \"Who has access: Anyone\", and use the URL ending in /exec.");
  }
  if (!data.ok) {
    if (data.code && data.message) throw new Error("This URL is the Google Sheets DATABASE script (Database.gs), not the copy script. For the copy feature, use SheetsCopy.gs in a separate Google Sheet.");
    throw new Error(data.error || "The Google Sheet refused the sync.");
  }
  return data;
}

/** Checks the URL and key without writing anything. Returns { name, url } of the sheet. */
export async function testSheets({ url, key }) {
  if (!isAppsScriptUrl(url)) throw new Error("That isn't an Apps Script Web app URL. It should start with https://script.google.com/macros/s/ and end with /exec.");
  if (!key) throw new Error("Enter the sync key.");
  return post(url.trim(), { action: "test", key });
}

/**
 * Sends a full copy to the Google Sheet.
 * onStep(text) reports progress. Returns { counts, url }.
 */
export async function syncToSheets({ me, school = {}, onStep = () => {} }) {
  const cfg = await loadSheetsSettings();
  if (!cfg.url || !cfg.key) throw new Error("Set up the Google Sheets copy first in School settings → Google Sheets copy.");

  onStep("Reading records…");
  const snaps = await Promise.all(TABLES.map((t) => getDocs(collection(db, t.name))));
  const tables = TABLES.map((t, i) => {
    let docs = snaps[i].docs.map((d) => ({ id: d.id, data: d.data() }));
    if (t.onlyIds) docs = docs.filter((d) => t.onlyIds.includes(d.id));
    return buildTable(t.tab, docs, { drop: t.drop, name: t.name });
  });

  const total = tables.reduce((n, t) => n + t.rows.length, 0);
  onStep(`Sending ${total} records to Google Sheets…`);
  const result = await post(cfg.url, {
    action: "sync",
    key: cfg.key,
    school: school.schoolName || "",
    syncedAt: new Date().toLocaleString(),
    syncedBy: me ? (me.displayName || me.username) : "",
    tables,
  });

  await setDoc(SHEETS_SETTINGS, {
    ...cfg,
    lastSyncAt: serverTimestamp(),
    lastSyncBy: me ? (me.displayName || me.username) : "",
    lastCounts: result.counts || {},
    sheetUrl: result.url || cfg.sheetUrl || "",
  });
  return { counts: result.counts || {}, url: result.url, total };
}

/** Daily automatic copy: runs when an administrator opens the Dashboard and the last copy is over a day old. */
export async function maybeAutoSync({ me, school, onDone }) {
  if (me?.role !== "admin" || databaseBackend === "sheets") return;
  let cfg;
  try { cfg = await loadSheetsSettings(); } catch { return; }
  if (!cfg.autoSync || !cfg.url || !cfg.key) return;
  const last = cfg.lastSyncAt?.toDate ? cfg.lastSyncAt.toDate().getTime() : 0;
  if (Date.now() - last < DAY) return;
  try {
    const r = await syncToSheets({ me, school });
    onDone?.(null, r);
  } catch (err) {
    onDone?.(err);
  }
}
