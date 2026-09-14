// Sets the theme before the first paint so the page never flashes the wrong one.
// Loaded as an external script on purpose: the server's content security policy
// allows no inline scripts. src/theme.ts owns the same storage key and rules.
(function () {
  var stored = null;
  try {
    stored = localStorage.getItem("afk.theme");
  } catch (e) {}
  var dark =
    stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
})();
