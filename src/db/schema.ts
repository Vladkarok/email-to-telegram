// Schema split into domain files under ./schema/.
// This shim preserves the existing import surface — all consumers continue to
// import from "../db/schema.js" without any changes.
export * from "./schema/index.js";
