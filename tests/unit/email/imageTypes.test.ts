import { describe, expect, it } from "vitest";
import { isImageContentType } from "../../../src/email/imageTypes.js";

describe("isImageContentType", () => {
  it("accepts supported image mime types with mixed case and parameters", () => {
    expect(isImageContentType("IMAGE/PNG; charset=binary")).toBe(true);
    expect(isImageContentType("image/jpeg")).toBe(true);
  });

  it("rejects non-image mime types", () => {
    expect(isImageContentType("application/pdf")).toBe(false);
  });
});
