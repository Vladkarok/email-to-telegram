import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn((): { appMode: string } => ({ appMode: "self-hosted" }));
vi.mock("../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindAliasByLocalPart = vi.fn();
vi.mock("../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAliasByLocalPart(...args),
  findAliasByLocalPartAndDomainId: vi.fn(),
}));

const mockFindHostedInboundBlock = vi.fn();
vi.mock("../../src/db/repos/hostedInboundBlocks.js", () => ({
  findHostedInboundBlock: (...args: unknown[]): unknown => mockFindHostedInboundBlock(...args),
}));

const mockReserveBuckets = vi.fn();
vi.mock("../../src/db/repos/hostedOnboardingAttempts.js", () => ({
  hostedOnboardingWindowStart: (): string => "2026-11-22",
  reserveHostedRateLimitBucketsInTransaction: (...args: unknown[]): unknown =>
    mockReserveBuckets(...args),
}));

const { isHostedMode } = await import("../../src/hostedMode.js");
const { hasActiveHostedUser } = await import("../../src/billing/limits.js");
const { findAliasForInbound } = await import("../../src/email/inboundRouting.js");
const { findHostedInboundRejection } = await import("../../src/abuse/hostedInboundBlocklist.js");
const { reserveHostedAliasCreateAttempt } = await import("../../src/abuse/hostedAliasCreation.js");
const { assertAliasNotImpersonation } = await import("../../src/abuse/aliasImpersonationGuard.js");

const savedAppMode = process.env["APP_MODE"];

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env["APP_MODE"];
  mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
  mockFindAliasByLocalPart.mockResolvedValue(null);
  mockFindHostedInboundBlock.mockResolvedValue(null);
  mockReserveBuckets.mockResolvedValue(true);
});

afterEach(() => {
  if (savedAppMode === undefined) delete process.env["APP_MODE"];
  else process.env["APP_MODE"] = savedAppMode;
});

type Mode = "env hosted" | "env self-hosted" | "config hosted" | "config self-hosted" | "no config";

const MODES: Array<[Mode, boolean]> = [
  ["env hosted", true],
  ["env self-hosted", false],
  ["config hosted", true],
  ["config self-hosted", false],
  ["no config", false],
];

function enter(mode: Mode): void {
  switch (mode) {
    case "env hosted":
      // The env wins over a config that says otherwise.
      process.env["APP_MODE"] = "hosted";
      mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
      return;
    case "env self-hosted":
      process.env["APP_MODE"] = "self-hosted";
      mockLoadConfig.mockReturnValue({ appMode: "hosted" });
      return;
    case "config hosted":
      mockLoadConfig.mockReturnValue({ appMode: "hosted" });
      return;
    case "config self-hosted":
      mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
      return;
    case "no config":
      mockLoadConfig.mockImplementation(() => {
        throw new Error("Invalid configuration");
      });
  }
}

describe("isHostedMode", () => {
  it.each(MODES)("%s -> %s", (mode, hosted) => {
    enter(mode);
    expect(isHostedMode()).toBe(hosted);
  });

  it("does not read the config when APP_MODE is set explicitly", () => {
    enter("env hosted");
    isHostedMode();
    enter("env self-hosted");
    isHostedMode();
    expect(mockLoadConfig).not.toHaveBeenCalled();
  });
});

// Each former copy of the predicate, observed through its own behaviour.
describe.each(MODES)("the hosted-only checks follow isHostedMode: %s", (mode, hosted) => {
  beforeEach(() => enter(mode));

  it("plan limits", async () => {
    // Hosted needs an owner row; self-hosted treats everyone as active.
    await expect(hasActiveHostedUser({} as never, null)).resolves.toBe(!hosted);
  });

  it("inbound domain routing", async () => {
    await findAliasForInbound({} as never, { localPart: "inbox", recipientDomain: null });
    expect(mockFindAliasByLocalPart).toHaveBeenCalledTimes(hosted ? 0 : 1);
  });

  it("inbound blocklist", async () => {
    await findHostedInboundRejection({} as never, { userId: 1n, envelopeFrom: "a@example.com" });
    expect(mockFindHostedInboundBlock).toHaveBeenCalledTimes(hosted ? 1 : 0);
  });

  it("alias creation throttling", async () => {
    await reserveHostedAliasCreateAttempt({} as never, 1n);
    expect(mockReserveBuckets).toHaveBeenCalledTimes(hosted ? 1 : 0);
  });

  it("alias impersonation guard", () => {
    const check = (): void => assertAliasNotImpersonation("admin");
    if (hosted) expect(check).toThrow();
    else expect(check).not.toThrow();
  });
});
