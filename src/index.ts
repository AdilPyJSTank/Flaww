import { loadConfig, enabledPlatforms } from './config';
import { log } from './logger';
import { env } from './env';
import { prisma } from './db';
import { bot, registerHandlers } from './telegram/bot';
import { notify } from './telegram/card';
import { createApp } from './server';

async function main() {
  const cfg = await loadConfig();
  registerHandlers(cfg);

  // grammY needs to know who it is before handling webhook updates. On Cloud
  // Run this happens once per cold start, so keep it cheap.
  await bot.init();

  const server = createApp(cfg);
  const port = Number(env.PORT);

  server.listen(port, '0.0.0.0', async () => {
    log.info({ port, platforms: enabledPlatforms(cfg) }, 'flaww listening');

    // Register the webhook on boot so a redeploy to a new URL self-heals.
    if (env.PUBLIC_URL) {
      const target = `${env.PUBLIC_URL.replace(/\/$/, '')}/telegram/${env.TELEGRAM_WEBHOOK_SECRET}`;
      try {
        await bot.api.setWebhook(target, {
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ['message'],
          drop_pending_updates: false,
        });
        log.info({ target: target.replace(env.TELEGRAM_WEBHOOK_SECRET, '***') }, 'webhook registered');
      } catch (err) {
        log.error({ err: String(err) }, 'webhook registration failed');
      }
    } else {
      log.warn('PUBLIC_URL not set — webhook not registered, Telegram will not reach this instance');
    }

    await notify(
      `🟢 <b>flaww is up</b>\n` +
        enabledPlatforms(cfg)
          .map((p) => `• ${p}`)
          .join('\n') +
        `\nmodel: <code>${cfg.screening.model}</code>` +
        (env.DRY_RUN ? '\n\n⚠️ <b>DRY_RUN</b> — screening and pinging only, nothing will be posted.' : ''),
    );
  });

  // Cloud Run sends SIGTERM and gives ~10s before SIGKILL. Finish in-flight
  // requests rather than dropping a half-published reply.
  const shutdown = (signal: string) => {
    log.info({ signal }, 'shutting down');
    server.close(() => {
      void prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(0), 9_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch(async (err) => {
  log.fatal({ err: String(err) }, 'fatal');
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
