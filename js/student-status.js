// ==========================================================
// student-status.js — A student's enrollment status (Students page)
//
//   ""           Regular (the default; older records have no status)
//   irregular    Irregular: takes subjects with other sections too
//   dropped      Dropped / withdrew: no new grades; unfinished subjects show "Dropped"
//   transferred  Transferred out to another school: same as dropped
//   graduated    Graduated / finished: kept for the record
//
// Saved grades are never deleted when the status changes.
// ==========================================================

export const STATUSES = {
  "": "Regular",
  irregular: "Irregular",
  dropped: "Dropped",
  transferred: "Transferred out",
  graduated: "Graduated",
};

/** The student's status key ("" = Regular). */
export const statusOf = (s) => (s && STATUSES[s.status] && s.status) || "";
export const statusLabel = (s) => STATUSES[statusOf(s)];
/** Dropped or transferred out: no longer attending, so no new grades. */
export const hasLeft = (s) => ["dropped", "transferred"].includes(statusOf(s));
/** Still attending this school year (new grading assignments tick them). */
export const isAttending = (s) => !hasLeft(s) && statusOf(s) !== "graduated";

const CLASS = { irregular: "text-bg-info", dropped: "text-bg-danger", transferred: "text-bg-warning", graduated: "text-bg-success" };

/** A small badge for any status but Regular ("" for Regular). */
export function statusBadge(s, escape = (x) => x) {
  const k = statusOf(s);
  if (!k) return "";
  const note = s.statusNote ? ` title="${escape(s.statusNote)}"` : "";
  return `<span class="badge ${CLASS[k]} ms-1"${note}>${escape(STATUSES[k])}</span>`;
}
