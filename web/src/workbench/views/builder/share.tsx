import { useEffect, useRef, useState } from "react";
import { I } from "../../icons";
import { api } from "@/lib/api";

export function SharePopover({ appId }: { appId: string | null }) {
  const [open, setOpen] = useState(false);
  const [hostInfo, setHostInfo] = useState<{ lanIps: string[]; port: number } | null>(null);
  const [hostInfoError, setHostInfoError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!hostInfo && !hostInfoError) {
      api
        .getHostInfo()
        .then((info) => {
          if (!cancelled) setHostInfo(info);
        })
        .catch((err: Error) => {
          if (!cancelled) setHostInfoError(err.message || "couldn't load network info");
        });
    }
    const onDown = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (event.target instanceof Node && wrapperRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, hostInfo, hostInfoError]);

  useEffect(() => {
    if (!copiedKey) return;
    const handle = window.setTimeout(() => setCopiedKey(null), 2000);
    return () => window.clearTimeout(handle);
  }, [copiedKey]);

  const firstLanIp = hostInfo?.lanIps[0] ?? null;
  const lanShareable = Boolean(firstLanIp && appId);

  const mintTokenUrl = async (): Promise<{ localUrl: string; lanUrl: string | null } | null> => {
    if (!appId) return null;
    try {
      const { token } = await api.createPreviewToken(appId);
      const previewPath = `/api/app/generated-apps/${encodeURIComponent(appId)}/preview/?token=${encodeURIComponent(token)}`;
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const local = `${origin}${previewPath}`;
      const lan =
        firstLanIp && hostInfo ? `http://${firstLanIp}:${hostInfo.port}${previewPath}` : null;
      return { localUrl: local, lanUrl: lan };
    } catch {
      return null;
    }
  };

  const copyText = async (text: string) => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const tmp = document.createElement("textarea");
    tmp.value = text;
    tmp.style.position = "fixed";
    tmp.style.opacity = "0";
    document.body.appendChild(tmp);
    tmp.select();
    document.execCommand("copy");
    document.body.removeChild(tmp);
  };

  const copyLocal = async () => {
    try {
      const urls = await mintTokenUrl();
      const target = urls?.localUrl ?? (typeof window !== "undefined" ? window.location.href : "");
      await copyText(target);
      setCopiedKey("local");
    } catch {
      setCopiedKey(null);
    }
  };

  const copyLan = async () => {
    try {
      const urls = await mintTokenUrl();
      if (!urls?.lanUrl) {
        setCopiedKey(null);
        return;
      }
      await copyText(urls.lanUrl);
      setCopiedKey("lan");
    } catch {
      setCopiedKey(null);
    }
  };

  const ShareIcon = I.share ?? I.link;

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="btn-ghost"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          background: "var(--panel)",
          border: "1px solid var(--line-2)",
          borderRadius: 8,
          fontSize: 11.5,
          color: "var(--silver-100)",
          cursor: "pointer",
        }}
      >
        <ShareIcon size={12} />
        <span>Share</span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Share preview"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 280,
            background: "var(--panel)",
            border: "1px solid var(--line-2)",
            borderRadius: 8,
            padding: 12,
            zIndex: 20,
            boxShadow: "0 8px 24px rgba(0,0,0,0.25)",
            color: "var(--silver-100)",
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <ShareOptionButton
            label="Copy link to this device"
            hint="Link expires in 1 hour · works in incognito on this device"
            copied={copiedKey === "local"}
            onClick={() => {
              void copyLocal();
            }}
          />
          {hostInfo === null && hostInfoError === null && (
            <div className="muted" style={{ fontSize: 11 }}>
              Loading network info…
            </div>
          )}
          {lanShareable ? (
            <ShareOptionButton
              label="Copy link for your network"
              hint={`Link expires in 1 hour · valid on any device on your network (http://${firstLanIp})`}
              copied={copiedKey === "lan"}
              onClick={() => {
                void copyLan();
              }}
            />
          ) : hostInfo && (hostInfo.lanIps.length === 0 || !appId) ? (
            <div className="muted" style={{ fontSize: 11, fontStyle: "italic" }}>
              {appId
                ? "(your computer isn't on a network)"
                : "(save the draft first to share over your network)"}
            </div>
          ) : null}
          <div
            style={{
              borderTop: "1px solid var(--line)",
              paddingTop: 8,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <div style={{ fontWeight: 500, fontSize: 12 }}>Download as Docker bundle</div>
            <div className="muted" style={{ fontSize: 11 }}>
              Switch to the Publish tab to generate a Docker Compose bundle.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ShareOptionButton({
  label,
  hint,
  copied,
  onClick,
}: {
  label: string;
  hint?: string;
  copied: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: "left",
        background: "transparent",
        border: "1px solid var(--line)",
        borderRadius: 6,
        padding: "8px 10px",
        cursor: "pointer",
        color: "var(--silver-100)",
        display: "flex",
        flexDirection: "column",
        gap: 2,
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
      >
        <span style={{ fontSize: 12, fontWeight: 500 }}>{label}</span>
        {copied && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: "var(--green)",
              background: "rgba(184,242,92,0.18)",
              padding: "2px 8px",
              borderRadius: 12,
            }}
          >
            ✓ Copied
          </span>
        )}
      </div>
      {hint && (
        <span className="muted" style={{ fontSize: 10.5 }}>
          {hint}
        </span>
      )}
    </button>
  );
}
