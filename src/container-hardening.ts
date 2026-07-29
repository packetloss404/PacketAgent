export interface ContainerHardeningControls {
  user: string;
  nonRoot: boolean;
  readOnlyRoot: boolean;
  capabilitiesDropped: boolean;
  noNewPrivileges: boolean;
  processLimit: number | null;
  init: boolean;
}

export interface LiveContainerHardeningProbe {
  uid: number;
  gid: number;
  capEff: string;
  noNewPrivs: string;
  pidsMax: string;
  rootWriteDenied: boolean;
}

export function composeServiceHardening(value: unknown): ContainerHardeningControls {
  const service = asRecord(value);
  const user = typeof service.user === "string" ? service.user.trim() : "";
  const capDrop = stringList(service.cap_drop);
  const securityOpt = stringList(service.security_opt);
  const processLimit = positiveInteger(service.pids_limit);
  return {
    user,
    nonRoot: isNonRootIdentity(user),
    readOnlyRoot: service.read_only === true,
    capabilitiesDropped: capDrop.some((entry) => entry.toUpperCase() === "ALL"),
    noNewPrivileges: securityOpt.some((entry) =>
      /^no-new-privileges(?:(?::|=)true)?$/i.test(entry),
    ),
    processLimit,
    init: service.init === true,
  };
}

export function dockerInspectionHardening(value: unknown): ContainerHardeningControls {
  const inspection = asRecord(value);
  const config = asRecord(inspection.Config);
  const hostConfig = asRecord(inspection.HostConfig);
  return composeServiceHardening({
    user: config.User,
    read_only: hostConfig.ReadonlyRootfs,
    cap_drop: hostConfig.CapDrop,
    security_opt: hostConfig.SecurityOpt,
    pids_limit: hostConfig.PidsLimit,
    init: hostConfig.Init,
  });
}

export function containerHardeningControlsPass(
  controls: ContainerHardeningControls,
  expectedProcessLimit: number,
): boolean {
  return (
    controls.nonRoot &&
    controls.readOnlyRoot &&
    controls.capabilitiesDropped &&
    controls.noNewPrivileges &&
    controls.processLimit === expectedProcessLimit &&
    controls.init
  );
}

export function liveContainerHardeningProbePass(
  probe: LiveContainerHardeningProbe,
  expectedProcessLimit: number,
): boolean {
  return (
    Number.isSafeInteger(probe.uid) &&
    probe.uid > 0 &&
    Number.isSafeInteger(probe.gid) &&
    probe.gid >= 0 &&
    /^[0]+$/.test(probe.capEff) &&
    probe.noNewPrivs === "1" &&
    probe.pidsMax === String(expectedProcessLimit) &&
    probe.rootWriteDenied
  );
}

export function parseComposeService(
  composeJson: string,
  serviceName: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(composeJson);
  } catch {
    throw new Error("Docker Compose returned invalid JSON");
  }
  const root = asRecord(parsed);
  const services = asRecord(root.services);
  const service = asRecord(services[serviceName]);
  if (Object.keys(service).length === 0) {
    throw new Error(`Docker Compose output did not contain service ${serviceName}`);
  }
  return service;
}

export function isNonRootIdentity(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === "root") return false;
  const user = normalized.split(":")[0] ?? "";
  return user !== "0" && user !== "root";
}

function positiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry.trim()] : []))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
