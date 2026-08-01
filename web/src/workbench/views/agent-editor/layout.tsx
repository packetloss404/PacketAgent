import type { ReactNode } from "react";

export function Section({
  number,
  kicker,
  title,
  sub,
  children,
}: {
  number: string;
  kicker: string;
  title: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div className="card" style={{ padding: 22, marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <div className="kicker" style={{ marginBottom: 4 }}>
            {kicker}
          </div>
          <h2 className="h2" style={{ fontSize: 18 }}>
            {title}
          </h2>
          {sub && (
            <p className="muted" style={{ fontSize: 12.5, marginTop: 4, maxWidth: 480 }}>
              {sub}
            </p>
          )}
        </div>
        <span className="mono muted" style={{ fontSize: 10.5, letterSpacing: "0.12em" }}>
          § {number}
        </span>
      </div>
      {children}
    </div>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "block", marginBottom: 10 }}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}
