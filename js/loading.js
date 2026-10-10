// ==========================================================
// loading.js — Shows people that the system is working.
//
// firebase-config.js wraps every database read and save with track(),
// so a spinner appears on its own whenever something is being fetched:
// a circular, rotating blue → green ring with "Loading…" in the middle of
// the screen. It waits a short moment first, so quick answers don't make
// it flicker. It never blocks clicks.
// ==========================================================

const SHOW_MS = 150;

let pending = 0;
let showTimer = null;
let spinner = null;

function element() {
  if (spinner || !document.body) return spinner;
  spinner = document.createElement("div");
  spinner.className = "load-spinner";
  spinner.setAttribute("role", "status");
  spinner.innerHTML = '<span class="load-ring" aria-hidden="true"></span><span class="load-text">Loading…</span>';
  document.body.append(spinner);
  return spinner;
}

function start() {
  pending++;
  if (pending > 1) return;
  clearTimeout(showTimer);
  showTimer = setTimeout(() => {
    const el = element();
    if (el) el.classList.add("is-on");
    document.documentElement.setAttribute("aria-busy", "true");
  }, SHOW_MS);
}

function stop() {
  pending = Math.max(0, pending - 1);
  if (pending) return;
  clearTimeout(showTimer);
  document.documentElement.removeAttribute("aria-busy");
  if (spinner) spinner.classList.remove("is-on");
}

/** Shows the spinner until the promise settles; returns the same promise. */
export function track(promise) {
  start();
  Promise.resolve(promise).then(stop, stop);
  return promise;
}

/** Wraps an async function so each call shows the spinner. */
export function tracked(fn) {
  return function (...args) {
    return track(fn.apply(this, args));
  };
}

/** Wraps onSnapshot: the spinner shows until the first answer (or error) arrives. */
export function trackedSnapshot(onSnapshot) {
  return function (target, ...args) {
    const i = args.findIndex((a) => typeof a === "function");
    if (i < 0) return onSnapshot(target, ...args); // observer objects: not tracked
    let done = false;
    let finish = () => {};
    const first = new Promise((resolve) => { finish = resolve; });
    const once = (fn) => function (...a) {
      if (!done) { done = true; finish(); }
      return fn.apply(this, a);
    };
    const wrapped = args.map((a) => (typeof a === "function" ? once(a) : a));
    track(first);
    // Give up on the spinner after 15 seconds (e.g. offline), the listener keeps working
    setTimeout(() => { if (!done) { done = true; finish(); } }, 15000);
    const unsubscribe = onSnapshot(target, ...wrapped);
    return () => {
      if (!done) { done = true; finish(); }
      unsubscribe();
    };
  };
}
