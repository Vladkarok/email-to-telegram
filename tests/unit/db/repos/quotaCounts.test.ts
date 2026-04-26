import util from "node:util";
import { describe, expect, it } from "vitest";
import { countActiveAliasesByOrganization } from "../../../../src/db/repos/aliases.js";
import { countAllowRulesByOrganization } from "../../../../src/db/repos/allowRules.js";

describe("quota count query filters", () => {
  it("excludes deleted aliases from organization alias counts", async () => {
    let whereArg: unknown;
    const db = {
      select: () => ({
        from: () => ({
          where: (arg: unknown) => {
            whereArg = arg;
            return Promise.resolve([{ count: 0 }]);
          },
        }),
      }),
    };

    await countActiveAliasesByOrganization(db as never, "org-1");

    expect(util.inspect(whereArg, { depth: 8 })).toContain("deleted");
  });

  it("excludes deleted aliases from organization allow-rule counts", async () => {
    let whereArg: unknown;
    const db = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: (arg: unknown) => {
              whereArg = arg;
              return Promise.resolve([{ count: 0 }]);
            },
          }),
        }),
      }),
    };

    await countAllowRulesByOrganization(db as never, "org-1");

    expect(util.inspect(whereArg, { depth: 8 })).toContain("deleted");
  });
});
