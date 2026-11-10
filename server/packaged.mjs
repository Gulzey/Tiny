import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { isSea } from 'node:sea';
import { createTinyServer } from './app.mjs';
import { openDatabase, seedDatabase } from './database.mjs';
import {
  parseServerArguments,
  resolveServerSettings,
  SERVER_HELP,
} from './runtime.mjs';

async function main() {
  const options = parseServerArguments(process.argv.slice(2));
  if (options.help) {
    console.log(SERVER_HELP);
    return;
  }
  const executableDir = isSea() ? dirname(process.execPath) : process.cwd();
  const settingsFile = join(executableDir, 'tiny-server.env');
  if (existsSync(settingsFile)) process.loadEnvFile(settingsFile);
  const settings = resolveServerSettings({ options, executableDir });
  if (options.seedOnly) {
    const db = openDatabase(settings.dbPath);
    try {
      await seedDatabase(db);
    } finally {
      db.close();
    }
    console.log(`Test accounts are ready in ${settings.dbPath}`);
    console.log('alice / bob / charlie — initial password: tiny-local-demo');
    return;
  }
  const app = createTinyServer(settings);
  try {
    if (options.seedDemo) {
      await seedDatabase(app.db);
      console.log(
        'Added demo accounts: alice / bob / charlie — initial password: tiny-local-demo',
      );
    }
    await app.listen();
  } catch (error) {
    await app.close();
    if (error.code === 'EADDRINUSE')
      throw new Error(
        `Port ${settings.port} is already in use. Close the other Tiny server or change TINY_PORT in tiny-server.env.`,
      );
    throw error;
  }
  const address = app.server.address();
  const port = address.port;
  const displayHost = ['0.0.0.0', '::'].includes(settings.host)
    ? '127.0.0.1'
    : settings.host;
  const localAddress = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`;
  console.log('\nTiny Server is running. Keep this window open.');
  console.log(`Server address on this PC: ${localAddress}`);
  console.log(`Database: ${settings.dbPath}`);
  console.log(`Optional settings file: ${settingsFile}`);
  if (['127.0.0.1', 'localhost', '::1'].includes(settings.host)) {
    console.log(
      'Only this PC can connect. For trusted LAN testing, set TINY_HOST=0.0.0.0 in tiny-server.env and restart.',
    );
  } else {
    const lanAddresses = Object.values(networkInterfaces())
      .flat()
      .filter(
        (item) =>
          item &&
          item.family === 'IPv4' &&
          !item.internal &&
          !item.address.startsWith('169.254.'),
      )
      .map((item) => `http://${item.address}:${port}`);
    if (lanAddresses.length)
      console.log(
        `Possible LAN addresses: ${[...new Set(lanAddresses)].join(', ')}`,
      );
    console.log(
      'Other PCs need a reachable address and permitted firewall rules. HTTP is for trusted LAN testing; use HTTPS for remote packaged clients.',
    );
  }
  console.log(
    settings.localAuth
      ? 'Password sign-in is enabled. No Google, email, or phone provider is configured.'
      : 'Password sign-in is disabled. Existing sessions stay valid until logout or expiry.',
  );
  console.log(
    'No internet exposure, HTTPS, firewall changes, or call relay is set up automatically.',
  );
  console.log('Press Ctrl+C to stop.\n');
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK'])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      console.log('Stopping Tiny Server…');
      try {
        await app.close();
        process.exit(0);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    });
}

main().catch((error) => {
  console.error(`Tiny Server could not start: ${error.message}`);
  process.exitCode = 1;
  // Keep a double-clicked console open on errors. Piped/automated runs exit.
  if (isSea() && process.stdin.isTTY && !process.argv.includes('--no-pause')) {
    console.log('Press Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  }
});
