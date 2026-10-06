// The notice path's bounded transactions; the helper lives with the DB layer
// so the delivery path's marker write can use it too.
export { withBoundedTransaction } from "../db/boundedTransaction.js";
