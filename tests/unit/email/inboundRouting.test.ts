import { beforeEach, describe, expect, it, vi } from "vitest";

const mockLoadConfig = vi.fn(() => ({ appMode: "self-hosted" }));
vi.mock("../../../src/config.js", () => ({
  loadConfig: (): unknown => mockLoadConfig(),
}));

const mockFindAliasByLocalPart = vi.fn();
const mockFindAliasByLocalPartAndDomainId = vi.fn();
vi.mock("../../../src/db/repos/aliases.js", () => ({
  findAliasByLocalPart: (...args: unknown[]): unknown => mockFindAliasByLocalPart(...args),
  findAliasByLocalPartAndDomainId: (...args: unknown[]): unknown =>
    mockFindAliasByLocalPartAndDomainId(...args),
}));

const mockFindInboundDomainByDomain = vi.fn();
vi.mock("../../../src/db/repos/inboundDomains.js", () => ({
  findInboundDomainByDomain: (...args: unknown[]): unknown =>
    mockFindInboundDomainByDomain(...args),
}));

const { findAliasForInbound } = await import("../../../src/email/inboundRouting.js");

describe("inbound routing", () => {
  beforeEach(() => {
    delete process.env["APP_MODE"];
    mockLoadConfig.mockReturnValue({ appMode: "self-hosted" });
    mockFindAliasByLocalPart.mockReset();
    mockFindAliasByLocalPartAndDomainId.mockReset();
    mockFindInboundDomainByDomain.mockReset();
  });

  it("uses legacy local-part routing outside hosted mode", async () => {
    mockFindAliasByLocalPart.mockResolvedValueOnce({ id: "alias-1" });

    await expect(
      findAliasForInbound({} as never, {
        localPart: "alerts",
        recipientDomain: "inbox.example.com",
      }),
    ).resolves.toEqual({ id: "alias-1" });

    expect(mockFindAliasByLocalPart).toHaveBeenCalledWith(expect.anything(), "alerts");
    expect(mockFindInboundDomainByDomain).not.toHaveBeenCalled();
  });

  it("uses active inbound domain routing in hosted mode", async () => {
    process.env["APP_MODE"] = "hosted";
    mockFindInboundDomainByDomain.mockResolvedValueOnce({
      id: "domain-1",
      domain: "inbox.example.com",
      status: "active",
    });
    mockFindAliasByLocalPartAndDomainId.mockResolvedValueOnce({ id: "alias-1" });

    await expect(
      findAliasForInbound({} as never, {
        localPart: "alerts",
        recipientDomain: "inbox.example.com",
      }),
    ).resolves.toEqual({ id: "alias-1" });

    expect(mockFindInboundDomainByDomain).toHaveBeenCalledWith(
      expect.anything(),
      "inbox.example.com",
    );
    expect(mockFindAliasByLocalPartAndDomainId).toHaveBeenCalledWith(
      expect.anything(),
      "alerts",
      "domain-1",
    );
    expect(mockFindAliasByLocalPart).not.toHaveBeenCalled();
  });

  it("rejects missing or disabled hosted recipient domains", async () => {
    process.env["APP_MODE"] = "hosted";
    await expect(
      findAliasForInbound({} as never, {
        localPart: "alerts",
      }),
    ).resolves.toBeNull();

    mockFindInboundDomainByDomain.mockResolvedValueOnce({
      id: "domain-1",
      domain: "inbox.example.com",
      status: "disabled",
    });
    await expect(
      findAliasForInbound({} as never, {
        localPart: "alerts",
        recipientDomain: "inbox.example.com",
      }),
    ).resolves.toBeNull();

    expect(mockFindAliasByLocalPartAndDomainId).not.toHaveBeenCalled();
  });
});
