import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_HELP = `Tiny Server

Double-click Tiny-Server.exe to start. Keep its window open while friends use Tiny.
Press Ctrl+C to stop the server. No separate Node.js installation is required.

Settings: tiny-server.env beside Tiny-Server.exe (optional).
Saved data: %LOCALAPPDATA%\\Tiny Server\\tiny.sqlite by default.

Optional command-line switches:
  --host ADDRESS       Listening address (default: 127.0.0.1, this PC only)
  --port NUMBER        TCP port (default: 8787; 0 chooses an unused port)
  --data-dir FOLDER    Store tiny.sqlite in this folder
  --seed-demo          Add alice/bob/charlie test accounts, then start
  --seed-only          Add test accounts and exit without starting the server
  --no-pause           Exit immediately on errors, useful for automated checks
  --help              Show this help

Demo password: tiny-local-demo. Existing passwords are never changed.
No test accounts are added unless --seed-demo or --seed-only is selected.
To use other computers, the server must be reachable. Tiny does not configure
Windows Firewall, internet port forwarding, HTTPS, or TURN automatically.
`;

export function parseServerArguments(args) {
  const options = {};
  const valueOptions = {
    '--host': 'host',
    '--port': 'port',
    '--data-dir': 'dataDir',
  };
  const switches = {
    '--help': 'help',
    '--seed-demo': 'seedDemo',
    '--seed-only': 'seedOnly',
    '--no-pause': 'noPause',
  };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (switches[argument]) options[switches[argument]] = true;
    else if (valueOptions[argument]) {
      const value = args[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} needs a value. Use --help for examples.`);
      options[valueOptions[argument]] = value;
    } else
      throw new Error(
        `Unknown option: ${argument}. Use --help for available options.`,
      );
  }
  return options;
}

export function resolveServerSettings({
  options = {},
  env = process.env,
  executableDir = process.cwd(),
} = {}) {
  const portText = String(options.port ?? env.TINY_PORT ?? '8787');
  if (
    !/^\d+$/.test(portText) ||
    !Number.isSafeInteger(Number(portText)) ||
    Number(portText) > 65535
  )
    throw new Error('The server port must be a number between 0 and 65535.');
  const host = options.host ?? env.TINY_HOST ?? '127.0.0.1';
  if (typeof host !== 'string' || !host.trim() || /[\s/\\]/.test(host))
    throw new Error(
      'The listening address must be an IP address or hostname, without http:// or a port.',
    );
  let iceServers;
  try {
    iceServers = JSON.parse(env.TINY_ICE_SERVERS || '[]');
  } catch {
    throw new Error('TINY_ICE_SERVERS must contain a JSON array.');
  }
  if (
    !Array.isArray(iceServers) ||
    iceServers.some((server) => !server || !server.urls)
  )
    throw new Error(
      'TINY_ICE_SERVERS must contain an array of RTCIceServer objects.',
    );
  const defaultData = join(
    env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'Tiny Server',
  );
  const dbPath = options.dataDir
    ? join(resolve(executableDir, options.dataDir), 'tiny.sqlite')
    : env.TINY_DB
      ? resolve(executableDir, env.TINY_DB)
      : join(defaultData, 'tiny.sqlite');
  return {
    host,
    port: Number(portText),
    dbPath,
    iceServers,
    localAuth: env.TINY_LOCAL_AUTH !== 'false',
    allowedOrigins: env.TINY_ALLOWED_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // The standalone server serves the API. An optional www folder can provide
    // a separately built browser interface without affecting native clients.
    staticDir: join(executableDir, 'www'),
  };
}
