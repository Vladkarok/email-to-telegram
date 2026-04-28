import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListOrganizationMembershipsForUser = vi.fn();
vi.mock("../../../src/db/repos/organizationMembers.js", () => ({
  addOrganizationMember: vi.fn(),
  listOrganizationMembershipsForUser: (...args: unknown[]): unknown =>
    mockListOrganizationMembershipsForUser(...args),
}));

const mockFindOrganizationById = vi.fn();
vi.mock("../../../src/db/repos/organizations.js", () => ({
  createOrganization: vi.fn(),
  findOrganizationById: (...args: unknown[]): unknown => mockFindOrganizationById(...args),
}));

const { getBillingOrganizationForUser, getPrimaryOrganizationForUser } =
  await import("../../../src/tenant/currentOrganization.js");

describe("current organization selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindOrganizationById.mockImplementation((_db, organizationId: string) =>
      Promise.resolve({ id: organizationId }),
    );
  });

  it("prefers owner/admin memberships over member memberships for the primary org", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      membership("org-member", "member", "2026-01-01T00:00:00Z"),
      membership("org-admin", "admin", "2026-02-01T00:00:00Z"),
    ]);

    await expect(getPrimaryOrganizationForUser({} as never, 123n)).resolves.toEqual({
      id: "org-admin",
    });
  });

  it("uses oldest membership within the same role as the deterministic tie-breaker", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      membership("org-newer", "owner", "2026-02-01T00:00:00Z"),
      membership("org-older", "owner", "2026-01-01T00:00:00Z"),
    ]);

    await expect(getPrimaryOrganizationForUser({} as never, 123n)).resolves.toEqual({
      id: "org-older",
    });
  });

  it("returns only owner/admin orgs for billing management", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      membership("org-member", "member", "2026-01-01T00:00:00Z"),
      membership("org-admin", "admin", "2026-02-01T00:00:00Z"),
    ]);

    await expect(getBillingOrganizationForUser({} as never, 123n)).resolves.toEqual({
      id: "org-admin",
    });
  });

  it("returns null for billing management when the user is only a member", async () => {
    mockListOrganizationMembershipsForUser.mockResolvedValue([
      membership("org-member", "member", "2026-01-01T00:00:00Z"),
    ]);

    await expect(getBillingOrganizationForUser({} as never, 123n)).resolves.toBeNull();
    expect(mockFindOrganizationById).not.toHaveBeenCalled();
  });
});

function membership(organizationId: string, role: "owner" | "admin" | "member", createdAt: string) {
  return {
    organizationId,
    userId: 123n,
    role,
    createdAt: new Date(createdAt),
  };
}
