import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { registerPwa } from "./pwa";

registerPwa(
  () => window.dispatchEvent(new Event("quota-pwa-update")),
  () => window.dispatchEvent(new Event("quota-pwa-offline"))
);

createRoot(document.getElementById("root")!).render(
  <StrictMode><App /></StrictMode>
);
