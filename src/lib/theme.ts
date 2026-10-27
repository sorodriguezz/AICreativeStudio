export type ThemePref = "system" | "light" | "dark";

const KEY = "aics.theme";

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* sin almacenamiento: se aplica sólo en esta sesión */
  }
}
