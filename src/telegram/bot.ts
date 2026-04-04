import { Bot } from "grammy";
import { getDb } from "../db/client.js";
import { authMiddleware } from "./middleware/auth.js";
import { startHandler } from "./commands/start.js";
import { newemailHandler } from "./commands/newemail.js";
import { listemailHandler } from "./commands/listemail.js";
import { deleteemailHandler } from "./commands/deleteemail.js";
import { pauseemailHandler } from "./commands/pauseemail.js";
import { resumeemailHandler } from "./commands/resumeemail.js";
import { settingsHandler } from "./commands/settings.js";
import { allowHandler } from "./commands/allow.js";
import { helpHandler } from "./commands/help.js";
import { updateAliasRenderMode } from "../db/repos/aliases.js";
import { getLogger } from "../utils/logger.js";

export function createBot(token: string): Bot {
  const bot = new Bot(token);
  const logger = getLogger();

  // Global error handler
  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx.update }, "Bot error");
  });

  // /start is exempt from auth (lets new users register themselves)
  bot.command("start", startHandler);

  // All other commands require auth
  bot.use(authMiddleware);

  bot.command("newemail", newemailHandler);
  bot.command("listemail", listemailHandler);
  bot.command("deleteemail", deleteemailHandler);
  bot.command("pauseemail", pauseemailHandler);
  bot.command("resumeemail", resumeemailHandler);
  bot.command("settings", settingsHandler);
  bot.command("allow", allowHandler);
  bot.command("help", helpHandler);

  // Inline keyboard callback: set_mode:<aliasId>:<mode>
  bot.callbackQuery(/^set_mode:(.+):(.+)$/, async (ctx) => {
    const [, aliasId, mode] = ctx.match;
    const validModes = ["plaintext", "html", "markdown"];
    if (!validModes.includes(mode)) {
      await ctx.answerCallbackQuery("Invalid mode");
      return;
    }
    await updateAliasRenderMode(getDb(), aliasId, mode as "plaintext" | "html" | "markdown");
    await ctx.answerCallbackQuery(`✅ Mode set to ${mode}`);
    await ctx.editMessageText(`⚙️ Render mode updated to <b>${mode}</b>.`, { parse_mode: "HTML" });
  });

  return bot;
}
