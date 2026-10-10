// ==========================================================
// accounts.js — Creating sign-in accounts without signing the
// administrator out (a second, in-memory Firebase app is used).
// Shared by Users and roles and the Teachers page.
// ==========================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  initializeAuth, inMemoryPersistence, createUserWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { app, db, doc, getDoc } from "./firebase-config.js";
import { usernameEmail, USERNAME_PATTERN, teacherCore } from "./app.js";

let secondaryAuth = null;
function getSecondaryAuth() {
  if (!secondaryAuth) {
    // app.options is the same config the main app was started with
    const app2 = initializeApp(app.options, "user-admin");
    secondaryAuth = initializeAuth(app2, { persistence: inMemoryPersistence });
  }
  return secondaryAuth;
}

/** Creates a Firebase Auth login and returns { uid, authEmail }. */
export async function createLogin(username, password, forceFresh = false) {
  const a = getSecondaryAuth();
  let authEmail = usernameEmail(username, forceFresh ? Date.now().toString(36) : "");
  let cred;
  try {
    cred = await createUserWithEmailAndPassword(a, authEmail, password);
  } catch (err) {
    // An old login with this address may still exist (e.g. a deleted user). Use a fresh address.
    if (err.code !== "auth/email-already-in-use") throw err;
    authEmail = usernameEmail(username, Date.now().toString(36));
    cred = await createUserWithEmailAndPassword(a, authEmail, password);
  }
  await signOut(a);
  return { uid: cred.user.uid, authEmail };
}

export async function usernameTaken(username) {
  return (await getDoc(doc(db, "usernames", username))).exists();
}

/**
 * Suggests a username from a teacher's name:
 * "F03 RIO G. ALVEYRA, RCrim" → "ralveyra" (first initial + last name).
 */
export function suggestUsername(name) {
  const parts = teacherCore(name).split(" ").filter(Boolean);
  if (!parts.length) return "";
  const last = parts[parts.length - 1];
  let u = parts.length > 1 ? `${parts[0][0]}${last}` : last;
  // Two-word surnames ("dela cruz", "de guzman") read better kept together
  if (parts.length >= 3 && /^(de|dela|del|delos|san|santa|sta|van|von|da|di|le|la)$/.test(parts[parts.length - 2])) {
    u = `${parts[0][0]}${parts[parts.length - 2]}${last}`;
  }
  u = u.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30);
  return USERNAME_PATTERN.test(u) ? u : (u + "user").slice(0, 30);
}

/** First free username: ralveyra, ralveyra2, ralveyra3… */
export async function availableUsername(base) {
  if (!base) return "";
  if (!(await usernameTaken(base))) return base;
  for (let i = 2; i < 50; i++) {
    const candidate = `${base.slice(0, 28)}${i}`;
    if (!(await usernameTaken(candidate))) return candidate;
  }
  return "";
}

/** Easy-to-read random password (no look-alike characters), e.g. "Kite-7Rmz-Pq4w". */
export function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const pick = (n) => {
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    return [...buf].map((v) => chars[v % chars.length]).join("");
  };
  return `${pick(4)}-${pick(4)}-${pick(4)}`;
}
