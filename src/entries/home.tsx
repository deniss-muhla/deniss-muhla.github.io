import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Page } from "../page/Page";
import "../styles/global-variants.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
