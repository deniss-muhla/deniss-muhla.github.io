import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { HomePage } from "../home/HomePage";
import "../styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HomePage />
  </StrictMode>,
);
