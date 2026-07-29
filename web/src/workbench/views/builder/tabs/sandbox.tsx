import { useMemo, useState } from "react";
import { I } from "../../../icons";
import { api } from "@/lib/api";
import { useApiData } from "../../../useApiData";
import { ExecTable, SelectedExecPanel } from "../../sandbox";
import type { SandboxExecRecord } from "@/lib/types";

const EMPTY_EXECS: SandboxExecRecord[] = [];

export function SandboxBuilderTab({ appId, appName }: { appId: string | null; appName: string }) {
  const execs = useApiData(
    () => (appId ? api.listSandboxExecs({ appId, limit: 50 }) : Promise.resolve([])),
    [appId],
  );
  const runtimeHealth = useApiData(
    () => (appId ? api.getGeneratedAppRuntimeHealth(appId) : Promise.resolve(null)),
    [appId],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = execs.data ?? EMPTY_EXECS;
  const selected = useMemo(() => list.find((e) => e.id === selectedId) ?? null, [list, selectedId]);

  if (!appId) {
    return (
      <div style={{ padding: 22 }}>
        <div className="card muted" style={{ padding: 22, textAlign: "center" }}>
          Approve the draft first — sandbox executions are scoped to a saved app.
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12, gap: 8 }}>
        <div className="kicker">Sandbox runs · {appName}</div>
        <button
          type="button"
          className="btn btn-sm"
          style={{ marginLeft: "auto" }}
          onClick={() => {
            void execs.refresh();
            void runtimeHealth.refresh();
          }}
        >
          <I.refresh size={11} /> Refresh
        </button>
      </div>
      {runtimeHealth.data && (
        <div
          className="card"
          style={{
            padding: 14,
            marginBottom: 14,
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: 12,
          }}
        >
          <div>
            <div className="muted" style={{ fontSize: 10.5 }}>
              Runtime
            </div>
            <span
              className={`pill ${
                runtimeHealth.data.status === "healthy"
                  ? "good"
                  : runtimeHealth.data.status === "degraded"
                    ? "danger"
                    : "muted"
              }`}
            >
              {runtimeHealth.data.status}
            </span>
          </div>
          <RuntimeMetric
            label="Processes"
            value={`${runtimeHealth.data.processCount}/${runtimeHealth.data.maxProcesses}`}
          />
          <RuntimeMetric label="Requests" value={runtimeHealth.data.metrics.requests} />
          <RuntimeMetric
            label="Crashes / retries"
            value={`${runtimeHealth.data.metrics.crashes}/${runtimeHealth.data.metrics.retryAttempts}`}
          />
          {runtimeHealth.data.recentCrashes[0] && (
            <div
              style={{ gridColumn: "1 / -1", color: "var(--danger)", fontSize: 11.5 }}
              role="status"
            >
              Last runtime failure: {runtimeHealth.data.recentCrashes[0].reason} ·{" "}
              {new Date(runtimeHealth.data.recentCrashes[0].at).toLocaleString()}
            </div>
          )}
        </div>
      )}
      {runtimeHealth.error && (
        <div className="card" style={{ padding: 12, marginBottom: 14, color: "var(--danger)" }}>
          Runtime health unavailable: {runtimeHealth.error}
        </div>
      )}
      {execs.loading && (
        <div className="muted" style={{ padding: 12 }}>
          Loading…
        </div>
      )}
      {execs.error && (
        <div className="card" style={{ padding: 14, color: "var(--danger)" }}>
          {execs.error}
        </div>
      )}
      <ExecTable
        execs={list}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onCancel={async (id) => {
          await api.cancelSandboxExec(id).catch(() => {});
          void execs.refresh();
        }}
      />
      {selected && (
        <div style={{ marginTop: 14 }}>
          <SelectedExecPanel
            key={selected.id}
            exec={selected}
            onCancel={async () => {
              await api.cancelSandboxExec(selected.id).catch(() => {});
              void execs.refresh();
            }}
            onClose={() => setSelectedId(null)}
            onUpdate={() => {
              void execs.refresh();
            }}
          />
        </div>
      )}
    </div>
  );
}

function RuntimeMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 10.5 }}>
        {label}
      </div>
      <div className="mono" style={{ marginTop: 4, color: "var(--silver-100)" }}>
        {value}
      </div>
    </div>
  );
}
