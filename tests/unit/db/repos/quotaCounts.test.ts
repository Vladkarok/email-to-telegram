import util from "node:util";
import { describe, expect, it } from "vitest";
import { countActiveAliasesByUser } from "../../../../src/db/repos/aliases.js";
import { countAllowRulesByUser } from "../../../../src/db/repos/allowRules.js";

describe("quota count query filters", () => {
  it("excludes deleted aliases from user alias counts", async () => {
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

    await countActiveAliasesByUser(db as never, 1n);

    expect(util.inspect(whereArg, { depth: 8 })).toContain("deleted");
  });

  it("excludes deleted aliases from user allow-rule counts", async () => {
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

    await countAllowRulesByUser(db as never, 1n);

    expect(util.inspect(whereArg, { depth: 8 })).toContain("deleted");
  });
});
