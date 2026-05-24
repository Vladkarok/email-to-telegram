import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hostedDocs = [
  "docs/hosted/README.md",
  "docs/hosted/acceptable-use.md",
  "docs/hosted/privacy-and-data-requests.md",
  "docs/hosted/pricing-and-terms.md",
  "docs/hosted/launch-checklist.md",
];

describe("hosted public policy drafts", () => {
  it("keeps a hosted docs index with required public contact guidance", () => {
    const index = readDoc("docs/hosted/README.md");

    expect(index).toContain("Required Public Contacts");
    expect(index).toContain("abuse reports");
    expect(index).toContain("general support");
    expect(index).toContain("privacy, export, and erasure requests");
  });

  it("reports placeholder contacts that block publication for any doc bundle", () => {
    expect(
      findPublicationPlaceholders({
        "acceptable-use.md": "Report abuse to <abuse@example.com>.",
        "privacy.md": "Send data requests to <privacy@example.com>.",
        "terms.md": "Contact <support@example.com> or <abuse@example.com>.",
        "ready.md": "Contact support@example.test.",
      }),
    ).toEqual([
      {
        path: "acceptable-use.md",
        placeholders: ["<abuse@example.com>"],
      },
      {
        path: "privacy.md",
        placeholders: ["<privacy@example.com>"],
      },
      {
        path: "terms.md",
        placeholders: ["<abuse@example.com>", "<support@example.com>"],
      },
    ]);
  });

  it("can validate a publish-ready hosted doc bundle once real contacts are substituted", () => {
    const publishableDocs = Object.fromEntries(
      hostedDocs.map((path) => [
        path,
        readDoc(path)
          .replaceAll("<abuse@example.com>", "abuse@example.test")
          .replaceAll("<support@example.com>", "support@example.test")
          .replaceAll("<privacy@example.com>", "privacy@example.test"),
      ]),
    );

    expect(findPublicationPlaceholders(publishableDocs)).toEqual([]);
  });
});

function readDoc(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function findPublicationPlaceholders(
  docs: Record<string, string> = Object.fromEntries(
    hostedDocs.map((path) => [path, readDoc(path)]),
  ),
): Array<{ path: string; placeholders: string[] }> {
  return Object.entries(docs)
    .map(([path, content]) => ({
      path,
      placeholders: [
        "<abuse@example.com>",
        "<support@example.com>",
        "<privacy@example.com>",
      ].filter((placeholder) => content.includes(placeholder)),
    }))
    .filter((entry) => entry.placeholders.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
}
