import { isTauri } from '@tauri-apps/api/core';
import {
  check,
  type Update,
  type DownloadEvent,
} from '@tauri-apps/plugin-updater';

type Options = { busy: () => boolean };
let options: Options = { busy: () => false };
let operation: Promise<void> | null = null;
let candidate: Update | null = null;
let downloaded = 0;
let total = 0;

function host(): HTMLElement {
  let node = document.querySelector<HTMLElement>('#update-strip');
  if (!node) {
    node = document.createElement('aside');
    node.id = 'update-strip';
    node.className = 'update-strip';
    node.hidden = true;
    node.setAttribute('aria-live', 'polite');
    document.body.prepend(node);
  }
  return node;
}

function show(text: string, action?: { label: string; run: () => void }): void {
  const node = host();
  node.hidden = false;
  const message = document.createElement('span');
  message.textContent = text;
  node.replaceChildren(message);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'update-action';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    node.append(button);
  }
}

function hide(): void {
  host().hidden = true;
}

function progress(event: DownloadEvent): void {
  if (event.event === 'Started') {
    downloaded = 0;
    total = event.data.contentLength || 0;
  } else if (event.event === 'Progress') downloaded += event.data.chunkLength;
  const percent = total
    ? Math.min(99, Math.floor((downloaded / total) * 100))
    : null;
  show(
    `Downloading Tiny ${candidate?.version || ''}${percent === null ? '…' : ` · ${percent}%`}`,
  );
}

async function install(): Promise<void> {
  if (!candidate) return;
  if (options.busy()) {
    show('Update ready. Finish the call or message draft before restarting.', {
      label: 'Try again',
      run: () => void install(),
    });
    return;
  }
  show(`Installing Tiny ${candidate.version}…`);
  await candidate.install({ restartAfterInstall: true });
}

async function run(manual: boolean): Promise<void> {
  if (!isTauri()) {
    if (manual) show('Updates are available in the installed Windows app.');
    return;
  }
  if (operation) return operation;
  operation = (async () => {
    try {
      if (manual) show('Checking for updates…');
      if (candidate) await candidate.close().catch(() => {});
      candidate = await check({ timeout: 15_000 });
      if (!candidate) {
        if (manual) show('Tiny is up to date.', { label: 'Close', run: hide });
        else hide();
        return;
      }
      show(`Tiny ${candidate.version} is available. Starting download…`);
      await candidate.download(progress, { timeout: 120_000 });
      const notes = candidate.body?.trim();
      show(
        `Tiny ${candidate.version} is ready${notes ? ` · ${notes.slice(0, 140)}` : ''}`,
        { label: 'Restart to update', run: () => void install() },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const updateWasFound = Boolean(candidate);
      await candidate?.close().catch(() => {});
      candidate = null;
      if (manual || updateWasFound)
        show(`Update unavailable: ${message}`, {
          label: 'Retry',
          run: () => void checkForUpdates(true),
        });
      else hide();
    } finally {
      operation = null;
    }
  })();
  return operation;
}

export function checkForUpdates(manual = true): Promise<void> {
  return run(manual);
}

export function startUpdater(next: Options): void {
  options = next;
  void run(false);
}
