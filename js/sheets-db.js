// ==========================================================
// sheets-db.js — The Firestore functions this system uses, backed by a
// Google Sheet through google-apps-script/Database.gs (or by Supabase
// through supabase/schema.sql, which answers the same requests).
//
// Pages keep calling collection(), doc(), getDocs(), writeBatch() … as
// before; firebase-config.js hands them these versions when the database
// is set to Google Sheets. Firebase is then used only for sign-in.
// ==========================================================

const MAX_PARALLEL = 4;        // Apps Script handles a limited number of requests at once
const POLL_MS = 30000;         // "live" updates are refreshed every 30 seconds
const POLL_HIDDEN_MS = 120000; // slower while the tab is in the background

// ---------- Values ----------
export class Timestamp {
  constructor(ms) { this._ms = ms; }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  static now() { return new Timestamp(Date.now()); }
  toDate() { return new Date(this._ms); }
  toMillis() { return this._ms; }
  get seconds() { return Math.floor(this._ms / 1000); }
  get nanoseconds() { return (this._ms % 1000) * 1e6; }
  isEqual(o) { return o instanceof Timestamp && o._ms === this._ms; }
}

export function serverTimestamp() {
  return { __serverTimestamp: true };
}

function encode(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
  if (v instanceof Date) return { __ts: v.toISOString() };
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : encode(x)));
  if (typeof v === "object") {
    if (v.__serverTimestamp === true) return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      const e = encode(x);
      if (e !== undefined) o[k] = e;
    }
    return o;
  }
  return v;
}

function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (keys.length === 1 && typeof v.__ts === "string") return new Timestamp(Date.parse(v.__ts));
    const o = {};
    keys.forEach((k) => (o[k] = decode(v[k])));
    return o;
  }
  return v;
}

// ---------- References and queries ----------
const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function autoId() {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

export function createSheetsDb({ url, getToken }) {
  return { type: "sheets-db", url, getToken };
}

export function collection(db, name) {
  return { type: "collection", db, id: name, path: name };
}

export function doc(a, b, c) {
  if (a && a.type === "collection") {
    const id = b || autoId();
    return { type: "doc", db: a.db, id, path: `${a.path}/${id}`, col: a.path };
  }
  const id = c || autoId();
  return { type: "doc", db: a, id, path: `${b}/${id}`, col: b };
}

export function documentId() { return "__name__"; }
export function where(field, op, value) { return { kind: "where", field, op, value }; }
export function orderBy(field, dir = "asc") { return { kind: "orderBy", field, dir }; }
export function limit(n) { return { kind: "limit", n }; }
export function query(base, ...constraints) {
  return { type: "query", db: base.db, path: base.path, constraints: [...(base.constraints || []), ...constraints] };
}

function querySpec(q) {
  const cs = q.constraints || [];
  return {
    collection: q.path,
    where: cs.filter((c) => c.kind === "where").map((c) => [c.field, c.op, encode(c.value)]),
    orderBy: cs.filter((c) => c.kind === "orderBy").map((c) => [c.field, c.dir]),
    limit: (cs.find((c) => c.kind === "limit") || {}).n || null,
  };
}

// ---------- Talking to the Apps Script ----------
let active = 0;
const waiting = [];
async function takeSlot() {
  if (active < MAX_PARALLEL) { active++; return; }
  await new Promise((resolve) => waiting.push(resolve));
  active++;
}
function releaseSlot() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

function dbError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.name = "FirebaseError";
  return e;
}

async function call(db, body) {
  // Other databases with the same requests (Supabase: supabase-db.js) bring their own transport
  if (db.send) return db.send(body);
  await takeSlot();
  try {
    const token = await db.getToken();
    let res;
    try {
      // text/plain keeps this a simple request, which Apps Script accepts from any website
      res = await fetch(db.url, {
        method: "POST",
        body: JSON.stringify({ ...body, token, origin: location.origin }),
        redirect: "follow",
      });
    } catch {
      throw dbError("unavailable", "Can't reach the Google Sheets database. Check your internet connection.");
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw dbError("unavailable", "The Google Sheets database didn't answer correctly. Check that its Apps Script is deployed as a Web app with access for Anyone.");
    }
    if (!data.ok) {
      // The copy script (SheetsCopy.gs) answers with "error" and talks about a sync key
      if (!data.message && data.error && /sync key|SYNC_KEY/i.test(data.error)) throw dbError("failed-precondition", "This URL is the Google Sheets COPY script (SheetsCopy.gs), not the database. In your Google Sheet open Extensions → Apps Script, replace the code with google-apps-script/Database.gs, set FIREBASE_API_KEY, save, then Deploy → Manage deployments → Edit → Version: New version → Deploy, and test again.");
      throw dbError(data.code || "internal", data.message || data.error || "The Google Sheets database refused the request.");
    }
    return data;
  } finally {
    releaseSlot();
  }
}

// ---------- Snapshots ----------
const META = { fromCache: false, hasPendingWrites: false };

function docSnapshot(ref, raw) {
  let cached;
  return {
    id: ref.id,
    ref,
    metadata: META,
    exists: () => raw !== null && raw !== undefined,
    data: () => (raw ? (cached || (cached = decode(raw))) : undefined),
  };
}

function querySnapshot(q, docs) {
  const base = collection(q.db, q.path);
  const list = docs.map((d) => docSnapshot(doc(base, d.id), d.data));
  return { docs: list, size: list.length, empty: list.length === 0, forEach: (fn) => list.forEach(fn), metadata: META, query: q };
}

// ---------- Reads ----------
export async function getDoc(ref) {
  const r = await call(ref.db, { action: "get", path: ref.path });
  return docSnapshot(ref, r.doc ? r.doc.data : null);
}

export async function getDocs(q) {
  const r = await call(q.db, { action: "query", ...querySpec(q) });
  return querySnapshot(q, r.docs || []);
}

export async function getCountFromServer(q) {
  const r = await call(q.db, { action: "count", ...querySpec(q) });
  return { data: () => ({ count: r.count }) };
}

// ---------- Writes ----------
const writeOp = (type, ref, data, options) => ({
  type,
  path: ref.path,
  ...(data !== undefined ? { data: encode(data) } : {}),
  merge: !!(options && options.merge),
});

async function commitOps(db, ops) {
  if (ops.length) await call(db, { action: "commit", ops });
}

export async function setDoc(ref, data, options) { await commitOps(ref.db, [writeOp("set", ref, data, options)]); }
export async function updateDoc(ref, data) { await commitOps(ref.db, [writeOp("update", ref, data)]); }
export async function deleteDoc(ref) { await commitOps(ref.db, [writeOp("delete", ref)]); }
export async function addDoc(colRef, data) {
  const ref = doc(colRef);
  await setDoc(ref, data);
  return ref;
}

export function writeBatch(db) {
  const ops = [];
  const batch = {
    set(ref, data, options) { ops.push(writeOp("set", ref, data, options)); return batch; },
    update(ref, data) { ops.push(writeOp("update", ref, data)); return batch; },
    delete(ref) { ops.push(writeOp("delete", ref)); return batch; },
    commit() { return commitOps(db, ops); },
  };
  return batch;
}

// ---------- "Live" updates (refreshed every 30 seconds) ----------
export function onSnapshot(target, a, b, c) {
  let next = a, error = b;
  if (a && typeof a === "object" && typeof a !== "function") { next = b; error = c; } // (target, options, next, error)
  let stopped = false;
  let timer = null;
  const run = async () => {
    if (stopped) return;
    try {
      const snap = target.type === "doc" ? await getDoc(target) : await getDocs(target);
      if (!stopped) next(snap);
    } catch (err) {
      if (!stopped && error) error(err);
    } finally {
      if (!stopped) timer = setTimeout(run, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
    }
  };
  run();
  return () => { stopped = true; clearTimeout(timer); };
}
