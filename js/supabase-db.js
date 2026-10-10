// ==========================================================
// supabase-db.js — Supabase as the school's database.
//
// The pages keep using the same functions (collection(), getDocs(),
// writeBatch() …) from sheets-db.js; only the transport differs: each
// request goes to the Postgres function public.gs_request in your Supabase
// project (supabase/schema.sql), which checks the Firebase sign-in and the
// role rules. Firebase is then used only for sign-in.
// ==========================================================

/** https://<project>.supabase.co (or a self-hosted address), without a path. */
export function isSupabaseUrl(url) {
  return /^https:\/\/[a-z0-9.-]+(:\d+)?\/?$/i.test(String(url || "").trim());
}

export function cleanSupabaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function jwtPayload(token) {
  try {
    const part = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(part + "===".slice((part.length + 3) % 4)));
  } catch {
    return null;
  }
}

/** What's wrong with a pasted Supabase key ("" when it's a key meant for websites). */
export function supabaseKeyProblem(key) {
  const k = String(key || "").trim();
  if (!k) return "Paste the publishable key (sb_publishable_…) or the anon public key.";
  if (/^sb_secret_/.test(k)) return "That's the SECRET key: it bypasses every rule and must never be put on a website. Use the publishable key (sb_publishable_…) instead.";
  if (/^sb_publishable_/.test(k)) return "";
  const p = k.startsWith("eyJ") ? jwtPayload(k) : null;
  if (p && p.role === "service_role") return "That's the service_role key: it bypasses every rule and must never be put on a website. Use the anon public key or the publishable key instead.";
  if (p && p.role === "anon") return "";
  return "This doesn't look like a Supabase key. Copy the publishable key (sb_publishable_…) or the anon public key from Project Settings → API Keys.";
}

function dbError(code, message) {
  const e = new Error(message);
  e.code = code;
  e.name = "FirebaseError"; // the pages' error messages already handle these codes
  return e;
}

/**
 * Sends one request ({ action, … }, the same ones as the Google Sheets database) to
 * public.gs_request. token = the Firebase sign-in token, or null when signed out.
 */
export async function supabaseRequest({ url, key, projectId }, body, token) {
  let res;
  try {
    res = await fetch(`${cleanSupabaseUrl(url)}/rest/v1/rpc/gs_request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: String(key || "").trim(),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ body }),
    });
  } catch {
    throw dbError("unavailable", "Can't reach the Supabase database. Check the Project URL and your internet connection.");
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = (data && (data.message || data.msg || data.error)) || `HTTP ${res.status}`;
    if (res.status === 404 || (data && data.code === "PGRST202")) {
      throw dbError("failed-precondition", "The Supabase project isn't set up yet: open its SQL Editor, paste supabase/schema.sql from the project, and click Run. Then test again.");
    }
    if ((res.status === 401 || res.status === 403) && token) {
      throw dbError("unauthenticated", `Supabase didn't accept your Firebase sign-in (${msg}). In Supabase open Authentication → Sign In / Providers → Third-party Auth → Add provider → Firebase, and enter the Firebase Project ID${projectId ? ` "${projectId}"` : ""}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw dbError("failed-precondition", `Supabase refused the key (${msg}). Copy the publishable key (or anon public key) again from Project Settings → API Keys.`);
    }
    throw dbError("internal", `The Supabase database refused the request: ${msg}`);
  }
  if (!data || typeof data !== "object") throw dbError("internal", "The Supabase database didn't answer correctly. Run supabase/schema.sql again in its SQL Editor.");
  if (!data.ok) throw dbError(data.code || "internal", data.message || "The Supabase database refused the request.");
  return data;
}

/** The db object handed to sheets-db.js functions (collection(db, …), writeBatch(db) …). */
export function createSupabaseDb({ url, key, projectId, getToken }) {
  const cfg = { url, key, projectId };
  return {
    type: "supabase-db",
    url,
    getToken,
    send: async (body) => supabaseRequest(cfg, body, await getToken()),
  };
}
