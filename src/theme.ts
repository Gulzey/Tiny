type Theme = 'light' | 'dark';

const storageKey = 'tiny.theme';
let initialized = false;

function savedTheme(): Theme {
  try {
    return localStorage.getItem(storageKey) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function updateButton(button: HTMLButtonElement, theme: Theme): void {
  const dark = theme === 'dark';
  button.textContent = dark ? 'Light mode' : 'Dark mode';
  button.setAttribute('aria-label', dark ? 'Light mode' : 'Dark mode');
  button.setAttribute('aria-pressed', String(dark));
  button.title = dark
    ? 'Switch to the light theme'
    : 'Switch to the grey-blue dark theme';
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#18212c' : '#f5f3ec');
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    'button[data-theme-toggle]',
  )) {
    updateButton(button, theme);
  }
}

export function initTheme(): void {
  if (initialized) return;
  initialized = true;
  applyTheme(savedTheme());

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
    try {
      localStorage.setItem(storageKey, theme);
    } catch {
      // The theme still works when storage is unavailable.
    }
  });

  // Keep separate Tiny tabs consistent; no timers or background polling.
  window.addEventListener('storage', (event) => {
    if (event.key === storageKey || event.key === null)
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
