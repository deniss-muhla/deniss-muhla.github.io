import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CvPage } from "../cv/CvPage";
import "../styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CvPage />
  </StrictMode>,
);
