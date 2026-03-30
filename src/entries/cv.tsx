import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { VariantSwitcher } from "../variants/VariantSwitcher";
import { V1CvPage } from "../variants/v1/CvPage";
import { V2CvPage } from "../variants/v2/CvPage";
import { V3CvPage } from "../variants/v3/CvPage";
import { V4CvPage } from "../variants/v4/CvPage";
import { V5CvPage } from "../variants/v5/CvPage";
import "../styles/global-variants.css";

const pages = [V1CvPage, V2CvPage, V3CvPage, V4CvPage, V5CvPage];

function App() {
  const [v, setV] = useState(() => {
    const s = localStorage.getItem("dm-variant");
    return s ? Math.min(Math.max(Number(s), 1), 5) : 1;
  });

  const onChange = (n: number) => {
    setV(n);
    localStorage.setItem("dm-variant", String(n));
  };

  const Page = pages[v - 1];

  return (
    <>
      <VariantSwitcher current={v} onChange={onChange} />
      <Page />
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
