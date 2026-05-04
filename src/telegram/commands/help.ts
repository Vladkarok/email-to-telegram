import type { Context } from "grammy";
import { settingsHelpText, safetyDisclaimerText } from "../renderModeGuidance.js";

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>📖 Help</b>

<b>Menu</b>
/start — open the management menu

<b>Aliases</b>
/newemail — create a new email alias
/newemail &lt;alias&gt; — create one immediately with a specific name
/listemail — list all your aliases
/pauseemail &lt;alias&gt; — pause an alias
/resumeemail &lt;alias&gt; — resume a paused alias
/deleteemail &lt;alias&gt; — delete an alias
/settings &lt;alias&gt; — change render mode, body dedup, or privacy mode

${settingsHelpText()}

<b>Allow rules</b>
Only senders matching an allow rule can deliver mail to an alias.
/allow list &lt;alias&gt;
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;

<b>Billing (hosted only)</b>
/billing — workspace billing status with Upgrade and Manage Billing buttons
/plan — show your current plan and limits
/usage — show this month's accepted/delivered/failed/rejected counts and quotas
/upgrade — choose a plan and get a Stripe checkout link
/portal — open the Stripe billing portal to manage your subscription

/help — show this message

${safetyDisclaimerText()}

💡 After creating an alias, add at least one allow rule — otherwise all mail is rejected.`,
    { parse_mode: "HTML" },
  );
}
