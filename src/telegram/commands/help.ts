import type { Context } from "grammy";

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>📖 Commands</b>

<b>Alias management</b>
/newemail [name] — create a new email alias
/listemail — list aliases for this chat
/deleteemail &lt;name&gt; — delete an alias
/pauseemail &lt;name&gt; — pause delivery
/resumeemail &lt;name&gt; — resume delivery
/settings &lt;name&gt; — change render mode

<b>Allow rules</b>
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
/allow list &lt;alias&gt;

<b>Info</b>
/help — show this message

Mail is only accepted from allowed senders. Add at least one allow rule after creating an alias.`,
    { parse_mode: "HTML" },
  );
}
