import { I } from "../icons";
import { PanelHeader } from "../Shell";
import { AdminToggle } from "./admin-controls";
import { useApiData } from "../useApiData";
import { api } from "@/lib/api";

export function SSOView() {
  const envVars = useApiData(() => api.listEnvVars(), []);
  const ssoEnv = (envVars.data ?? []).filter(e => /SAML|OIDC|SSO|OAUTH/i.test(e.key));
  const configured = ssoEnv.length > 0;

  return (
    <div style={{ padding: "26px 28px 60px", maxWidth: 1080 }}>
        <p className="muted" style={{ fontSize: 13, marginBottom: 20 }}>
          {configured ? `${ssoEnv.length} SSO env var${ssoEnv.length === 1 ? "" : "s"} configured` : "No SSO configuration detected — log in via password until SSO env vars are added."}
        </p>

        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <I.shield size={16} style={{ color: configured ? "var(--green)" : "var(--silver-400)" }}/>
            <div className="h3" style={{ fontSize: 15 }}>Identity provider</div>
            <span className={`pill ${configured ? "good" : "muted"}`} style={{ marginLeft: "auto" }}>
              <span className="dot"></span>{configured ? "configured" : "not configured"}
            </span>
          </div>
          {ssoEnv.length === 0 && (
            <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>
              Add SSO-related env vars (e.g. <span className="mono">SAML_METADATA_URL</span>, <span className="mono">OIDC_ISSUER</span>) under Providers → Environment to enable SSO sign-in.
            </p>
          )}
          {ssoEnv.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: "10px 14px", fontSize: 12.5 }}>
              {ssoEnv.map(e => (
                <div key={e.id} style={{ display: "contents" }}>
                  <div className="muted mono" style={{ fontSize: 11.5 }}>{e.key}</div>
                  <div className="mono" style={{ fontSize: 11.5 }}>{e.valuePreview ?? "•••"}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <I.lock size={16} style={{ color: "var(--green)" }}/>
            <div className="h3" style={{ fontSize: 15 }}>Enforcement</div>
          </div>
          <AdminToggle label="Require SSO for all members" sub="Bypass disabled · break-glass via owner password reset only" on={configured}/>
          <AdminToggle label="MFA required" sub="Enforced even for SSO sessions when IdP supports it" on={false}/>
          <AdminToggle label="Allow remember device (30 days)" sub="Reduces step-up prompts for trusted devices" on={true}/>
        </div>

        <div className="card" style={{ padding: 0, overflow: "hidden", marginBottom: 16 }}>
          <PanelHeader title="Allowed email domains" sub="Members from these domains auto-join with the listed role"/>
          <div style={{ padding: 18, color: "var(--silver-300)", fontSize: 12.5 }}>
            Domain allow-listing is configured server-side via <span className="mono">PACKETAGENT_AUTO_JOIN_DOMAINS</span>.
          </div>
        </div>

        <div className="card" style={{ padding: 18 }}>
          <div className="h3" style={{ fontSize: 15, marginBottom: 14 }}>Session policy</div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Session lifetime, IP allow-list, and MFA enforcement are managed via deployment env vars
            (<span className="mono">PACKETAGENT_SESSION_*</span>). They surface here read-only.
          </p>
        </div>
    </div>
  );
}
