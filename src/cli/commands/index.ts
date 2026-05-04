import type { OperatorCommand } from "../dispatcher.js";
import { migrateCommand } from "./migrate.js";
import { rewrapCommand } from "./rewrap.js";
import { backfillCommand } from "./backfill.js";
import { exportCommand } from "./export.js";
import { deleteCommand } from "./delete.js";
import { setOrganizationPlanCommand } from "./setOrganizationPlan.js";
import { setUserPlanCommand } from "./setUserPlan.js";
import { addMemberCommand } from "./addMember.js";

/** Ordered list of operator commands. First match wins. */
export const commands: readonly OperatorCommand[] = [
  migrateCommand,
  rewrapCommand,
  backfillCommand,
  exportCommand,
  deleteCommand,
  setOrganizationPlanCommand,
  setUserPlanCommand,
  addMemberCommand,
];
