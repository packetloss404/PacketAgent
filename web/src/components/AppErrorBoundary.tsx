import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    console.error("PacketAgent UI rendering failed; showing the recovery boundary.");
  }

  render() {
    return this.state.failed ? <AppErrorFallback /> : this.props.children;
  }
}

export function AppErrorFallback() {
  return (
    <main
      role="alert"
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--bg)",
        color: "var(--silver-100)",
      }}
    >
      <section className="card" style={{ width: "min(100%, 520px)", padding: 24 }}>
        <div className="kicker">PacketAgent recovery</div>
        <h1 className="h1" style={{ marginTop: 8, fontSize: 26 }}>
          The workbench could not finish rendering
        </h1>
        <p className="muted" style={{ margin: "12px 0 20px", lineHeight: 1.6 }}>
          Your server-side Workers keep their durable state. Reload the workbench to retry, or
          return to the start page.
        </p>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => window.location.reload()}
          >
            Reload workbench
          </button>
          <a className="btn" href="/">
            Return home
          </a>
        </div>
      </section>
    </main>
  );
}
