import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { listPendingRawEmails, writePendingRawEmailMeta } from "../../../src/storage/disk.js";

const tempDirs: string[] = [];

describe("pending raw email metadata", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes metadata and discovers it during recovery scans", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-disk-"));
    tempDirs.push(root);

    const rawEmailPath = join(root, "2026-04-07", "message.eml");
    await writePendingRawEmailMeta(rawEmailPath, {
      localPart: "alerts",
      envelopeFrom: "sender@example.com",
      correlationId: "req-1",
    });

    const pending = await listPendingRawEmails(root);

    expect(pending).toEqual([
      expect.objectContaining({
        rawEmailPath,
        localPart: "alerts",
        envelopeFrom: "sender@example.com",
        correlationId: "req-1",
      }),
    ]);
  });

  it("skips corrupt metadata files instead of aborting the whole scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "email-to-telegram-disk-"));
    tempDirs.push(root);

    const dayDir = join(root, "2026-04-07");
    await mkdir(dayDir, { recursive: true });
    await writeFile(join(dayDir, "broken.eml.pending.json"), "{not json");
    await writePendingRawEmailMeta(join(dayDir, "ok.eml"), {
      localPart: "alerts",
      envelopeFrom: null,
    });

    const pending = await listPendingRawEmails(root);

    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      rawEmailPath: join(dayDir, "ok.eml"),
      localPart: "alerts",
      envelopeFrom: null,
    });
  });
});
