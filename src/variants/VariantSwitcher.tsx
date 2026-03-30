import type { CSSProperties } from "react";

const bar: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  zIndex: 9999,
  display: "flex",
  justifyContent: "center",
  gap: 2,
  padding: "6px 8px",
  background: "#181926",
  borderBottom: "1px solid #363a4f",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: "0.72rem",
};

const btnBase: CSSProperties = {
  padding: "4px 16px",
  border: "none",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: "inherit",
  letterSpacing: "0.05em",
};

const labels = ["Geometry", "Editorial", "Grid", "Diagram", "Void"];

type Props = {
  current: number;
  onChange: (v: number) => void;
};

export function VariantSwitcher({ current, onChange }: Props) {
  return (
    <div style={bar}>
      {labels.map((label, i) => {
        const active = current === i + 1;
        return (
          <button
            key={i}
            style={{
              ...btnBase,
              background: active ? "#363a4f" : "transparent",
              color: active ? "#cad3f5" : "#6e738d",
            }}
            onClick={() => onChange(i + 1)}
          >
            {i + 1} {label}
          </button>
        );
      })}
    </div>
  );
}
