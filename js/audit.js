// ==========================================================
// audit.js — Audit trail entries (collection: auditLog)
//
// Each change saved in the system gets one entry:
//   { at, byUid, byName, byRole, action, col, docId, label, before, after }
// action: "create" | "update" | "delete" | "save" (old values unknown)
// before / after hold only the fields that changed (all fields when a
// record is added or deleted).
//
// With Firebase the website writes the entries (firebase-config.js, in the
// same save as the change). With Google Sheets or Supabase the database does
// it (Database.gs / schema.sql) with the same rules as here.
// ==========================================================

/** Lists that aren't recorded: the audit trail itself and notifications. */
export const AUDIT_SKIP = new Set(["auditLog", "notifications"]);
/** Changes that are only background noise (sign-in device, "last active", time stamps). */
const NOISE = new Set(["activeSession", "lastSeen", "updatedAt", "createdAt"]);

/** Friendly names for the lists. */
export const AUDIT_LISTS = {
  students: "Student",
  teachers: "Teacher",
  subjects: "Subject",
  sections: "Section",
  gradingAssignments: "Grading assignment",
  curriculum: "Curriculum",
  grades: "Grade",
  gradeChangeRequests: "Grade change request",
  rosterRequests: "Class list request",
  users: "User account",
  usernames: "Username",
  settings: "Settings",
  meta: "System",
  auditLog: "Audit trail",
};

/** A short description of the record ("GE 1 · BSC 1A · Juan Cruz"). */
export function auditLabel(col, d, id) {
  d = d || {};
  const j = (...p) => p.filter((x) => x !== undefined && x !== null && String(x).trim() !== "").join(" · ");
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
    case "settings": return { school: "School details", security: "Sign-in security", email: "Email sending", downtime: "Teacher downtime", options: "Setup and options", sheets: "Google Sheets copy" }[id] || id;
    default: return id || "";
  }
}

/** A value made safe and small for the audit trail (no images, no huge text, dates as text). */
export function auditValue(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === "string") {
    if (v.startsWith("data:image")) return "[image]";
    return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  if (typeof v !== "object") return v;
  if (typeof v._methodName === "string" || v.__serverTimestamp === true) return "(time of saving)"; // set by the database
  if (typeof v.toDate === "function") { try { return v.toDate().toISOString(); } catch { return String(v); } }
  if (v instanceof Date) return v.toISOString();
  if (typeof v.__ts === "string") return v.__ts;
  if (Array.isArray(v)) {
    const list = v.slice(0, 100).map(auditValue);
    return v.length > 100 ? [...list, `… and ${v.length - 100} more`] : list;
  }
  const o = {};
  Object.keys(v).forEach((k) => { o[k] = auditValue(v[k]); });
  return o;
}

const same = (a, b) => JSON.stringify(auditValue(a) ?? null) === JSON.stringify(auditValue(b) ?? null);

/**
 * Audit entries for a set of writes. Each write:
 *   { type: "set" | "update" | "delete", col, id, before (object | null | undefined = unknown), data, merge }
 * actor: { uid, name, role }. Returns the entries to save (without "at": the caller adds it).
 */
export function auditEntries(writes, actor) {
  const out = [];
  let auditDeletes = 0;
  for (const w of writes) {
    if (w.col === "auditLog" && w.type === "delete") { auditDeletes++; continue; }
    if (AUDIT_SKIP.has(w.col)) continue;
    const known = w.before !== undefined;
    const before = w.before || null;
    let after;
    if (w.type === "delete") after = null;
    else if (w.type === "update" || (w.type === "set" && w.merge)) after = { ...(before || {}), ...(w.data || {}) };
    else after = { ...(w.data || {}) };
    if (w.type === "delete" && known && !before) continue; // deleting something that wasn't there

    const action = w.type === "delete" ? "delete" : !known ? "save" : before ? "update" : "create";
    const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter((k) => !NOISE.has(k));
    const changed = action === "update" ? keys.filter((k) => !same(before[k], after[k])) : keys;
    if (action === "update" && !changed.length) continue; // only background noise changed
    const pick = (obj) => {
      if (!obj) return {};
      const o = {};
      changed.forEach((k) => { if (k in obj) o[k] = auditValue(obj[k]); });
      return o;
    };
    out.push({
      byUid: actor.uid || "", byName: actor.name || "", byRole: actor.role || "",
      action, col: w.col, docId: w.id,
      label: auditLabel(w.col, after || before, w.id),
      before: action === "create" || action === "save" ? {} : pick(before),
      after: action === "delete" ? {} : pick(after),
    });
  }
  if (auditDeletes) {
    out.push({
      byUid: actor.uid || "", byName: actor.name || "", byRole: actor.role || "",
      action: "delete", col: "auditLog", docId: "",
      label: `${auditDeletes} audit trail entr${auditDeletes === 1 ? "y" : "ies"}`, before: {}, after: {},
    });
  }
  return out;
}
