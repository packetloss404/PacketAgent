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
          onClick={() => void execs.refresh()}
        >
          <I.refresh size={11} /> Refresh
        </button>
      </div>
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
