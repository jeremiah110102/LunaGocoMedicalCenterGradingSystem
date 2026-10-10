/**
 * ==========================================================
 * College Grading System → Google Sheets copy
 * ==========================================================
 * Receives a copy of the grading system's data and writes it into
 * this Google Sheet: one tab per list (students, grades, …) plus an
 * "About" tab with the last sync time. It's a one-way copy: edits made
 * in the sheet are NOT sent back, and the next sync replaces them.
 *
 * SETUP (about 5 minutes)
 *  1. Create a new Google Sheet (sheets.new) and name it, e.g. "Grading System copy".
 *  2. Extensions → Apps Script. Delete what's there and paste this whole file.
 *  3. Change SYNC_KEY below to your own long secret (letters and numbers, 20+ characters).
 *  4. Click Save, then Deploy → New deployment → gear icon → Web app:
 *       Description:      Grading System sync
 *       Execute as:       Me
 *       Who has access:   Anyone
 *     Click Deploy, allow the permissions, and copy the Web app URL (ends with /exec).
 *  5. In the grading system: School settings → Google Sheets copy → unlock with your
 *     password → paste the Web app URL and the same SYNC_KEY → Test → Save.
 *
 * "Anyone" only means the system can reach this script without a Google sign-in.
 * Nothing is written unless the request carries your SYNC_KEY, and the sheet itself
 * stays private to you (share it from the Share button if others should see it).
 * If you change the code later, use Deploy → Manage deployments → Edit → New version.
 */

const SYNC_KEY = "CHANGE-ME-to-a-long-secret";

function doPost(e) {
  const reply = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: "The request couldn't be read." });
  }
  if (SYNC_KEY.indexOf("CHANGE-ME") === 0 || SYNC_KEY.length < 12) {
    return reply({ ok: false, error: "Set your own SYNC_KEY in the Apps Script (at least 12 characters), save, and deploy a new version." });
  }
  if (body.key !== SYNC_KEY) {
    return reply({ ok: false, error: "Wrong sync key. It must match SYNC_KEY in the Apps Script exactly." });
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (body.action === "test") {
    return reply({ ok: true, name: ss.getName(), url: ss.getUrl() });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    return reply({ ok: false, error: "Another sync is still running. Try again in a minute." });
  }
  try {
    const counts = {};
    (body.tables || []).forEach(function (t) {
      const sheet = ss.getSheetByName(t.name) || ss.insertSheet(t.name);
      sheet.clear();
      const width = Math.max(1, t.headers.length);
      const fit = function (row) {
        const r = row.slice(0, width);
        while (r.length < width) r.push("");
        return r;
      };
      const data = [fit(t.headers)].concat((t.rows || []).map(fit));
      sheet.getRange(1, 1, data.length, width).setValues(data);
      sheet.getRange(1, 1, 1, width).setFontWeight("bold").setBackground("#eef0f4");
      sheet.setFrozenRows(1);
      if (width > 1) sheet.setFrozenColumns(Math.min(2, width));
      counts[t.name] = (t.rows || []).length;
    });

    // "About" tab first: when and by whom, and how many records
    const about = ss.getSheetByName("About") || ss.insertSheet("About", 0);
    about.clear();
    const info = [
      ["College Grading System copy", ""],
      ["School", body.school || ""],
      ["Last synced", body.syncedAt || ""],
      ["Synced by", body.syncedBy || ""],
      ["", ""],
      ["Tab", "Records"],
    ]
      .concat(Object.keys(counts).map(function (k) { return [k, counts[k]]; }))
      .concat([
        ["", ""],
        ["This is a read-only copy. Edits here are NOT sent back to the grading system;", ""],
        ["the next sync replaces this sheet's contents.", ""],
      ]);
    about.getRange(1, 1, info.length, 2).setValues(info);
    about.getRange(1, 1).setFontWeight("bold").setFontSize(14);
    about.getRange(6, 1, 1, 2).setFontWeight("bold");
    about.setColumnWidth(1, 260);
    ss.setActiveSheet(about);
    ss.moveActiveSheet(1);

    // Remove the empty starter tab if it's still there
    const starter = ss.getSheetByName("Sheet1");
    if (starter && starter.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(starter);

    return reply({ ok: true, counts: counts, url: ss.getUrl() });
  } catch (err) {
    return reply({ ok: false, error: String((err && err.message) || err) });
  } finally {
    lock.releaseLock();
  }
}

function doGet() {
  return ContentService.createTextOutput("Grading System sync is ready.");
}
