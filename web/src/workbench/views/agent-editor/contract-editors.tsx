import type {
  AgentInputField,
  AgentInputFieldType,
  AgentMemoryEntry,
  AvailableTool,
} from "@/lib/types";
import { I } from "../../icons";
import { lines } from "./helpers";
import { Field } from "./layout";

const FIELD_TYPES: AgentInputFieldType[] = ["string", "number", "boolean", "url", "enum"];

// ─── ToolPicker ─────────────────────────────────────────────────────────────
export function ToolPicker({
  tools,
  enabled,
  onChange,
}: {
  tools: AvailableTool[];
  enabled: string[];
  onChange: (next: string[]) => void;
}) {
  const enabledSet = new Set(enabled);
  if (tools.length === 0) {
    return (
      <div
        className="card muted"
        style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
      >
        — tool registry empty —
      </div>
    );
  }
  const groups: Record<"read" | "write" | "exec", AvailableTool[]> = {
    read: [],
    write: [],
    exec: [],
  };
  for (const t of tools) groups[t.side].push(t);
  const toggle = (name: string) => {
    if (enabledSet.has(name)) onChange(enabled.filter((n) => n !== name));
    else onChange([...enabled, name]);
  };
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))",
        gap: 10,
      }}
    >
      {(["read", "write", "exec"] as const).map((side) => (
        <div key={side} className="card" style={{ padding: 12 }}>
          <div className="kicker" style={{ marginBottom: 8, color: "var(--green)" }}>
            {side.toUpperCase()} · {groups[side].length}
          </div>
          {groups[side].length === 0 ? (
            <p className="mono muted" style={{ fontSize: 11 }}>
              — none —
            </p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {groups[side].map((t) => (
                <label
                  key={t.name}
                  style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}
                >
                  <input
                    type="checkbox"
                    checked={enabledSet.has(t.name)}
                    onChange={() => toggle(t.name)}
                    style={{ marginTop: 2, accentColor: "var(--green)" }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      className="mono"
                      style={{ fontSize: 11.5, color: "var(--silver-100)", display: "block" }}
                    >
                      {t.name}
                    </span>
                    <span className="muted" style={{ fontSize: 10.5, lineHeight: 1.4 }}>
                      {t.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function MemoryEditor({
  memory,
  onChange,
}: {
  memory: AgentMemoryEntry[];
  onChange: (next: AgentMemoryEntry[]) => void;
}) {
  const update = (index: number, patch: Partial<AgentMemoryEntry>) =>
    onChange(
      memory.map((entry, candidate) => (candidate === index ? { ...entry, ...patch } : entry)),
    );
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {memory.length === 0 && (
        <div className="card muted" style={{ padding: "12px 14px", fontSize: 12 }}>
          — no saved context · secrets belong in credential references —
        </div>
      )}
      {memory.map((entry, index) => (
        <div
          key={entry.id}
          className="card"
          style={{
            padding: 10,
            display: "grid",
            gridTemplateColumns: "minmax(120px, 0.35fr) minmax(0, 1fr) auto",
            gap: 8,
            alignItems: "start",
          }}
        >
          <input
            className="field"
            value={entry.label}
            maxLength={80}
            aria-label={`Memory ${index + 1} label`}
            onChange={(event) => update(index, { label: event.target.value })}
          />
          <textarea
            className="field"
            value={entry.content}
            maxLength={1_000}
            rows={2}
            aria-label={`Memory ${index + 1} content`}
            onChange={(event) => update(index, { content: event.target.value })}
          />
          <button
            type="button"
            className="btn btn-sm"
            style={{ color: "var(--danger)" }}
            aria-label={`Remove memory ${index + 1}`}
            onClick={() => onChange(memory.filter((_, candidate) => candidate !== index))}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          type="button"
          className="btn btn-sm"
          disabled={memory.length >= 12}
          onClick={() =>
            onChange([...memory, { id: `memory_${Date.now()}`, label: "Context", content: "" }])
          }
        >
          <I.plus size={11} /> Add memory
        </button>
      </div>
    </div>
  );
}

// ─── InputSchemaEditor ──────────────────────────────────────────────────────
export function InputSchemaEditor({
  schema,
  onChange,
}: {
  schema: AgentInputField[];
  onChange: (next: AgentInputField[]) => void;
}) {
  const update = (index: number, patch: Partial<AgentInputField>) =>
    onChange(schema.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  const remove = (index: number) => onChange(schema.filter((_, i) => i !== index));
  const add = () =>
    onChange([
      ...schema,
      {
        key: `field_${schema.length + 1}`,
        label: `Field ${schema.length + 1}`,
        type: "string",
        required: false,
      },
    ]);

  return (
    <div>
      {schema.length === 0 ? (
        <div
          className="card muted"
          style={{ padding: "12px 14px", textAlign: "center", fontSize: 12 }}
        >
          — empty schema · add a field to capture per-run parameters —
        </div>
      ) : (
        <div className="card" style={{ overflow: "hidden", padding: 0 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Key</th>
                <th>Label</th>
                <th>Type</th>
                <th>Req</th>
                <th>Options</th>
                <th>Default</th>
                <th>Example</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {schema.map((f, index) => (
                <tr key={index}>
                  <td>
                    <input
                      className="field mono"
                      style={{ fontSize: 11, padding: "5px 8px" }}
                      placeholder="key"
                      value={f.key}
                      onChange={(e) =>
                        update(index, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })
                      }
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="Label"
                      value={f.label}
                      onChange={(e) => update(index, { label: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="field mono"
                      style={{ fontSize: 11, padding: "5px 8px" }}
                      value={f.type}
                      onChange={(e) => {
                        const type = e.target.value as AgentInputFieldType;
                        update(index, {
                          type,
                          options:
                            type === "enum"
                              ? f.options && f.options.length > 0
                                ? f.options
                                : ["option_a"]
                              : undefined,
                        });
                      }}
                    >
                      {FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={f.required}
                      onChange={(e) => update(index, { required: e.target.checked })}
                      style={{ accentColor: "var(--green)" }}
                    />
                  </td>
                  <td>
                    {f.type === "enum" ? (
                      <textarea
                        className="field mono"
                        style={{
                          fontSize: 11,
                          padding: "5px 8px",
                          minHeight: 50,
                          minWidth: 140,
                          resize: "none",
                        }}
                        placeholder="one per line"
                        rows={2}
                        value={(f.options ?? []).join("\n")}
                        onChange={(e) => update(index, { options: lines(e.target.value) })}
                      />
                    ) : (
                      <span className="mono muted" style={{ fontSize: 11 }}>
                        —
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="—"
                      value={f.defaultValue ?? ""}
                      onChange={(e) => update(index, { defaultValue: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="field"
                      style={{ fontSize: 12, padding: "5px 8px" }}
                      placeholder="first run"
                      value={f.exampleValue ?? ""}
                      onChange={(e) => update(index, { exampleValue: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="btn btn-sm"
                      style={{ padding: "3px 6px", color: "var(--danger)" }}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <button type="button" onClick={add} className="btn btn-sm">
          <I.plus size={11} /> Add field
        </button>
      </div>
    </div>
  );
}

export function RunInputControl({
  field: f,
  value,
  onChange,
}: {
  field: AgentInputField;
  value: string;
  onChange: (next: string) => void;
}) {
  if (f.type === "enum") {
    return (
      <Field label={`${f.label}${f.required ? " *" : ""}`}>
        <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">— select —</option>
          {(f.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  if (f.type === "boolean") {
    return (
      <label
        className="mono"
        style={{
          fontSize: 12,
          color: "var(--silver-200)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <input
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          style={{ accentColor: "var(--green)" }}
        />
        {f.label}
      </label>
    );
  }
  return (
    <Field label={`${f.label}${f.required ? " *" : ""}`}>
      <input
        className="field"
        type={f.type === "number" ? "number" : f.type === "url" ? "url" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.description}
      />
    </Field>
  );
}
