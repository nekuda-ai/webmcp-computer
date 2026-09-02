import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/base.css";
import "./styles/desktop.css";
import "./styles/screensaver.css";

function start(): void {
  const root = document.getElementById("root");
  if (!root) throw new Error("webmcp-computer: root element not found");

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

start();
