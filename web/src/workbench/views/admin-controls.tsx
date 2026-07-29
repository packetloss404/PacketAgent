export function AdminToggle({ label, sub, on }: { label: string; sub?: string; on: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "10px 0",
        gap: 12,
        borderTop: "1px solid var(--line)",
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--silver-50)" }}>{label}</div>
        {sub && (
          <div className="muted" style={{ fontSize: 11.5 }}>
            {sub}
          </div>
        )}
      </div>
      <div
        style={{
          width: 32,
          height: 18,
          borderRadius: 9,
          background: on ? "var(--green)" : "var(--bg-elev)",
          border: `1px solid ${on ? "var(--green)" : "var(--line-2)"}`,
          position: "relative",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: 6,
            background: on ? "var(--bg)" : "var(--silver-300)",
            position: "absolute",
            top: 2,
            left: on ? 17 : 2,
            transition: "left .15s",
          }}
        ></div>
      </div>
    </div>
  );
}

export function AdminField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="kicker" style={{ marginBottom: 4 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 13, color: "var(--silver-50)" }}>
        {value}
      </div>
    </div>
  );
}
