/** Tailwind is pre-built into css/tailwind.css (no CDN in production).
 *  Rebuild after adding new tw- classes:  npm install  then  npm run build:css
 *  Same settings the pages used before: "tw-" prefix, no preflight (so it doesn't clash with Bootstrap). */
module.exports = {
  prefix: "tw-",
  corePlugins: { preflight: false },
  content: ["./index.html", "./pages/**/*.html", "./js/**/*.js"],
  theme: { extend: {} },
  plugins: [],
};
