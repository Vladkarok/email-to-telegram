import type { Context } from "grammy";

export async function helpHandler(ctx: Context): Promise<void> {
  await ctx.reply(
    `<b>📖 Help</b>

Use /start to open the management menu where you can:
• Browse chats where the bot is active
• Create email aliases per chat
• Manage allow rules (who can send mail)
• Pause, resume, or delete aliases
• Change render mode (plaintext / HTML / Markdown)

<b>Quick commands</b>
/start — open management menu
/listemail — list all your aliases

<b>Allow rules (also manageable from the menu)</b>
/allow add &lt;alias&gt; &lt;email_or_domain&gt;
/allow remove &lt;alias&gt; &lt;email_or_domain&gt;
/allow list &lt;alias&gt;

/help — show this message

💡 After creating an alias, add at least one allow rule — otherwise all mail is rejected.`,
    { parse_mode: "HTML" },
  );
}
