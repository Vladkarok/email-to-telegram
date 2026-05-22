import { describe, expect, it } from "vitest";
import {
  isImageContentType,
  isInlinePhoto,
  TELEGRAM_PHOTO_MAX_BYTES,
} from "../../../src/email/imageTypes.js";

describe("isImageContentType", () => {
  it("accepts supported image mime types with mixed case and parameters", () => {
    expect(isImageContentType("IMAGE/PNG; charset=binary")).toBe(true);
    expect(isImageContentType("image/jpeg")).toBe(true);
  });

  it("rejects non-image mime types", () => {
    expect(isImageContentType("application/pdf")).toBe(false);
  });
});

describe("isInlinePhoto", () => {
  it("treats an image within the Telegram photo limit as inline", () => {
    expect(isInlinePhoto("image/png", 1024)).toBe(true);
    expect(isInlinePhoto("image/jpeg", TELEGRAM_PHOTO_MAX_BYTES)).toBe(true);
  });

  it("excludes an image over the Telegram photo limit so it falls back to a link", () => {
    expect(isInlinePhoto("image/png", TELEGRAM_PHOTO_MAX_BYTES + 1)).toBe(false);
  });

  it("keeps prior behavior for an image of unknown size", () => {
    expect(isInlinePhoto("image/png", null)).toBe(true);
    expect(isInlinePhoto("image/png", undefined)).toBe(true);
  });

  it("is never inline for a non-image attachment", () => {
    expect(isInlinePhoto("application/pdf", 1024)).toBe(false);
  });
});
