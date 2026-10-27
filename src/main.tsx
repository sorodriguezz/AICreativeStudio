import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import App from "./App";
import { applyTheme, readTheme } from "./lib/theme";
import "./styles.css";

applyTheme(readTheme());

async function boot() {
  // En `pnpm dev` dentro de un navegador normal no hay Tauri: usamos un backend simulado.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    const { installMock } = await import("./lib/mock");
    installMock();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
