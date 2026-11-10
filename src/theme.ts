type Theme = 'light' | 'dark';

const storageKey = 'tiny.theme';
const versionKey = 'tiny.theme.version';
const themeVersion = '2';
let initialized = false;

function savedTheme(): Theme {
  try {
    // The new black design replaces the old default once. Future choices persist.
    if (localStorage.getItem(versionKey) !== themeVersion) return 'dark';
    return localStorage.getItem(storageKey) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(storageKey, theme);
    localStorage.setItem(versionKey, themeVersion);
  } catch {
    // Theme selection still works when persistent storage is unavailable.
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function updateButton(button: HTMLButtonElement, theme: Theme): void {
  const dark = theme === 'dark';
  button.textContent = dark ? 'Light mode' : 'Dark mode';
  button.setAttribute('aria-label', dark ? 'Light mode' : 'Dark mode');
  button.setAttribute('aria-pressed', String(dark));
  button.title = dark
    ? 'Switch to the light theme'
    : 'Switch to the black theme';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#08090b' : '#f3f4f6');
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    'button[data-theme-toggle]',
  )) {
    updateButton(button, theme);
  }
}

export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  const theme = savedTheme();
  saveTheme(theme);
  applyTheme(theme);

  // One delegated handler survives view changes without retaining removed buttons.
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      !target.closest('button[data-theme-toggle]')
    )
      return;
    const theme: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    saveTheme(theme);
  });

  // Keep separate Tiny tabs consistent; no timers or background polling.
  window.addEventListener('storage', (event) => {
    if (
      event.key === storageKey ||
      event.key === versionKey ||
      event.key === null
    )
      applyTheme(savedTheme());
  });
}

export function createThemeToggle(): HTMLButtonElement {
  initTheme();
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'text-button theme-toggle';
  button.dataset.themeToggle = '';
  updateButton(button, currentTheme());
  return button;
}
