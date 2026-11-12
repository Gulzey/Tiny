import './style.css';
import './v3.css';
import './v4.css';
import { TinyCalls, type AudioProcessing } from './calls';
import { initTheme, createThemeToggle } from './theme';
import { createActivityPolicy } from './activity';
import tinyLogo from './assets/tiny-logo.svg';
import { checkForUpdates, startUpdater } from './updater';

initTheme();

type User = {
  id: string;
  handle: string;
  displayName: string;
  avatar?: string | null;
  banner?: string | null;
  presenceMode?: 'online' | 'afk' | 'dnd';
  friendsSince?: string | null;
};
type Message = {
  id: number;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
};
type Conversation = {
  id: string;
  title: string;
  isGroup: boolean;
  members: User[];
  lastMessage?: Message;
  callParticipants?: { userId: string; peerId: string }[];
};
type FriendRequest = { user: User; createdAt: string };
type State = {
  user: User;
  friends: User[];
  friendRequests: {
    incoming: FriendRequest[];
    outgoing: FriendRequest[];
  };
  conversations: Conversation[];
};

const root = document.querySelector<HTMLDivElement>('#app')!;
const productionServer = 'https://tinybros.duckdns.org';
const tauriClient = location.hostname === 'tauri.localhost';
const forceRelayTest =
  new URLSearchParams(location.search).get('tiny-force-relay') === '1';
const serverUrl =
  import.meta.env.DEV && import.meta.env.VITE_TINY_SERVER_URL
    ? new URL(import.meta.env.VITE_TINY_SERVER_URL).origin
    : productionServer;
const audioInputKey = `tiny.audio-input:${serverUrl}`;
const audioOutputKey = `tiny.audio-output:${serverUrl}`;
const audioSettingsKey = `tiny.audio-settings:${serverUrl}`;
let audioInputId = localStorage.getItem(audioInputKey) || '';
let audioOutputId = localStorage.getItem(audioOutputKey) || '';
let audioSettings: AudioProcessing & { outputVolume: number } = {
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  outputVolume: 1,
};
try {
  audioSettings = {
    ...audioSettings,
    ...JSON.parse(localStorage.getItem(audioSettingsKey) || '{}'),
  };
} catch {
  /* Keep safe defaults when preferences are damaged. */
}
const tokenStorage = tauriClient ? localStorage : sessionStorage;
let token = tokenStorage.getItem(`tiny.token:${serverUrl}`) || '';
let data: State | null = null;
let selected = '';
let messages: Message[] = [];
let hasMore = false;
let socket: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let reconnectAttempt = 0;
let connection = 'Connecting';
let online = new Set<string>();
let authCreate = false;
let destroyed = false;
let messageGeneration = 0;
let stateLoading = false;
let stateAgain = false;
let sending = false;
let pendingClientId = '';
let pendingBody = '';
let pendingConversation = '';
let currentDraft = '';
const drafts = new Map<string, string>();
const scrollPositions = new Map<string, number>();
let conversationFilter = '';
let rightCollapsed = false;
let leftWidth = 250;
let rightWidth = 240;
const mutedConversations = new Map<string, number>();
const hiddenConversations = new Set<string>();
const mediaNodes = new Map<string, HTMLMediaElement>();
let calls: TinyCalls;
let paintPending = false;
let forcePaint = false;
const pausedAvatars = new WeakMap<HTMLImageElement, string>();
const activity = createActivityPolicy((active) => {
  syncBackgroundMedia(active);
  if (active && data) {
    if (paintPending) {
      paintPending = false;
      renderSidebar();
      renderHeader();
      renderMessages();
    }
    renderCall();
  }
});
document.addEventListener('keydown', (event) => {
  if (!data || event.defaultPrevented) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    document.querySelector<HTMLInputElement>('.sidebar-top input')?.focus();
  }
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    if (!document.querySelector('dialog[open]')) openSettings();
  }
});
function deferPaint(): boolean {
  if (forcePaint || activity.active) return false;
  paintPending = true;
  return true;
}
function syncBackgroundMedia(active: boolean): void {
  calls?.setBackgrounded(!active);
  for (const img of document.querySelectorAll<HTMLImageElement>(
    '.avatar img',
  )) {
    if (!active && img.src.startsWith('data:image/gif')) {
      pausedAvatars.set(img, img.src);
      img.removeAttribute('src');
    } else if (active && pausedAvatars.has(img)) {
      img.src = pausedAvatars.get(img)!;
      pausedAvatars.delete(img);
    }
  }
  if (!active) {
    for (const node of mediaNodes.values()) {
      if (node instanceof HTMLVideoElement) {
        node.pause();
        node.srcObject = null;
      }
    }
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}
function button(
  label: string,
  action: () => unknown,
  className = 'button',
): HTMLButtonElement {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', () => {
    void Promise.resolve(action()).catch(showError);
  });
  return node;
}
function controlIcon(
  kind: 'microphone' | 'headphones' | 'settings',
  crossed = false,
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('control-icon');
  const paths = {
    microphone:
      '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7"/>',
    headphones:
      '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><path d="M4 13h3v7H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 1-2Zm16 0h-3v7h2a2 2 0 0 0 2-2v-3a2 2 0 0 0-1-2Z"/>',
    settings:
      '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5L9 6.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4L5 11a7 7 0 0 0 0 2l-2.1 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.5 3.1h5l.5-3.1a8 8 0 0 0 1.7-1l2.4 1 2-3.4L19 13a7 7 0 0 0 0-1Z"/>',
  };
  svg.innerHTML = paths[kind];
  if (crossed) {
    const slash = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'path',
    );
    slash.setAttribute('d', 'M3 3l18 18');
    slash.classList.add('control-slash');
    svg.append(slash);
  }
  return svg;
}
function input(
  label: string,
  name: string,
  type = 'text',
  value = '',
): { wrapper: HTMLLabelElement; field: HTMLInputElement } {
  const wrapper = el('label', 'field', label);
  const field = el('input');
  field.name = name;
  field.type = type;
  field.value = value;
  wrapper.append(field);
  return { wrapper, field };
}
function avatar(user: User, size = ''): HTMLElement {
  const box = el('span', `avatar ${size}`);
  if (user.avatar) {
    const img = el('img');
    if (!activity.active && user.avatar.startsWith('data:image/gif'))
      pausedAvatars.set(img, user.avatar);
    else img.src = user.avatar;
    img.decoding = 'async';
    img.alt = '';
    box.append(img);
  } else
    box.textContent = (user.displayName || user.handle)
      .slice(0, 1)
      .toUpperCase();
  return box;
}
function profileBanner(user: User): HTMLElement {
  const banner = el('div', `profile-banner ${user.banner ? 'has-image' : ''}`);
  if (user.banner) {
    const image = el('img');
    image.src = user.banner;
    image.alt = '';
    image.decoding = 'async';
    banner.append(image);
  }
  return banner;
}
function brand(): HTMLElement {
  const box = el('div', 'brand');
  const logo = el('img');
  logo.src = tinyLogo;
  logo.alt = '';
  box.append(logo, el('span', '', 'tiny'));
  return box;
}
function showError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  const host = document.querySelector('#notices');
  if (!host) return;
  const notice = el('div', 'notice');
  notice.setAttribute('role', 'alert');
  notice.append(
    el('span', '', text),
    button('Dismiss', () => notice.remove(), 'text-button'),
  );
  host.append(notice);
  while (host.childElementCount > 3) host.firstElementChild?.remove();
}
async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${serverUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error(
      'Tiny is temporarily offline. Check your internet connection and try again.',
    );
  }
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && data) void signOut(false);
    const requestError = new Error(
      result.error || result.message || `Request failed (${response.status}).`,
    );
    Object.assign(requestError, { status: response.status });
    throw requestError;
  }
  return result as T;
}
function send(event: unknown): void {
  if (!socket || socket.readyState !== WebSocket.OPEN)
    throw new Error(
      'Tiny is reconnecting. Wait for Connected before joining a call.',
    );
  socket.send(JSON.stringify(event));
}
async function refreshIce(): Promise<RTCIceServer[]> {
  const rtc = await api<{ iceServers: RTCIceServer[] }>('/api/rtc/config');
  return rtc.iceServers || [];
}
function newCallEngine(): void {
  calls = new TinyCalls({
    send,
    onChange: renderCall,
    onError: showError,
    refreshIce,
  });
  void calls.setAudioInput(audioInputId);
  void calls.setAudioProcessing(audioSettings);
  calls.setBackgrounded(!activity.active);
}
newCallEngine();

function renderLogin(): void {
  root.replaceChildren();
  const page = el('main', 'login-page');
  const aside = el('section', 'welcome');
  aside.append(
    brand(),
    el('span', 'eyebrow', 'VOICE · CHAT · PLAY'),
    el('h1', '', 'Your friends.\nOne click away.'),
    el(
      'p',
      'welcome-copy',
      'A small place for your people. Drop a message, catch up on a call, or share what you’re making.',
    ),
  );
  const illustration = el('div', 'little-world');
  illustration.setAttribute('aria-hidden', 'true');
  illustration.append(
    el('span', 'world-stem'),
    el('span', 'world-orb orb-one'),
    el('span', 'world-orb orb-two'),
    el('span', 'world-orb orb-three'),
    el('span', 'world-note', 'hello, you.'),
  );
  aside.append(illustration, el('p', 'quiet', 'Made for a few good friends.'));
  const panel = el('section', 'login-panel');
  panel.append(
    el('span', 'pill', 'TINY NETWORK'),
    el('h2', '', authCreate ? 'Create your account.' : 'Jump back in.'),
    el(
      'p',
      'muted',
      authCreate
        ? 'Create a test account on your Tiny server.'
        : 'Sign in to Tiny.',
    ),
  );
  const form = el('form', 'login-form');
  const handle = input('Handle', 'handle');
  handle.field.required = true;
  handle.field.autocomplete = 'username';
  handle.field.placeholder = 'e.g. alice';
  handle.field.pattern = '[a-zA-Z0-9_]{3,24}';
  const password = input('Password', 'password', 'password');
  password.field.setAttribute('aria-label', 'Password');
  password.field.required = true;
  password.field.autocomplete = authCreate
    ? 'new-password'
    : 'current-password';
  password.field.minLength = authCreate ? 12 : 8;
  const reveal = button(
    'Show',
    () => {
      const hidden = password.field.type === 'password';
      password.field.type = hidden ? 'text' : 'password';
      reveal.textContent = hidden ? 'Hide' : 'Show';
      reveal.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    },
    'password-toggle',
  );
  reveal.setAttribute('aria-label', 'Show password');
  password.wrapper.classList.add('password-field');
  password.wrapper.append(reveal);
  const display = input('Display name', 'displayName');
  display.field.maxLength = 48;
  if (authCreate) display.field.required = true;
  form.append(handle.wrapper, password.wrapper);
  if (authCreate) form.append(display.wrapper);
  const submit = el(
    'button',
    'button primary wide',
    authCreate ? 'Create account' : 'Sign in',
  );
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      token = '';
      const config = await api<{
        localAuth: boolean;
        registrationEnabled: boolean;
      }>('/api/config');
      if (!config.localAuth)
        throw new Error('Password sign-in is disabled on this server.');
      if (authCreate && !config.registrationEnabled)
        throw new Error('New account registration is temporarily closed.');
      const result = await api<{ token: string; user: User }>(
        '/api/auth/local',
        'POST',
        {
          handle: handle.field.value.trim(),
          password: password.field.value,
          displayName: display.field.value.trim(),
          create: authCreate,
        },
      );
      token = result.token;
      tokenStorage.setItem(`tiny.token:${serverUrl}`, token);
      calls.configure(await refreshIce(), forceRelayTest);
      await enterApp();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  panel.append(
    form,
    button(
      authCreate
        ? 'Already have an account? Sign in'
        : 'New to Tiny? Create an account',
      () => {
        authCreate = !authCreate;
        renderLogin();
      },
      'text-button login-switch',
    ),
  );
  const demo = el('div', 'demo-note');
  demo.append(
    el('strong', '', 'Trying Tiny with test accounts?'),
    el(
      'p',
      '',
      'After running npm run seed, use alice, bob, or charlie with password tiny-local-demo. These are local test accounts, not Google or mobile sign-in.',
    ),
  );
  panel.append(demo);
  page.append(aside, panel);
  const notices = el('div', 'notices');
  notices.id = 'notices';
  root.append(page, notices);
}
function renderStartup(
  title = 'Opening Tinycord',
  detail = 'Restoring your secure session…',
  retry?: () => void,
): void {
  root.replaceChildren();
  const page = el('main', 'startup-page');
  const logo = el('img');
  logo.src = tinyLogo;
  logo.alt = '';
  const card = el('section', 'startup-card');
  card.append(logo, el('h1', '', title), el('p', 'muted', detail));
  if (retry) card.append(button('Try again', retry, 'button primary'));
  page.append(card);
  const notices = el('div', 'notices');
  notices.id = 'notices';
  root.append(page, notices);
}

function conversationTitle(conversation: Conversation): string {
  return conversation.isGroup
    ? conversation.title
    : conversation.members.find((u) => u.id !== data?.user.id)?.displayName ||
        conversation.title;
}
function conversationUser(conversation: Conversation): User {
  return (
    conversation.members.find((u) => u.id !== data?.user.id) ||
    conversation.members[0]
  );
}
function userById(id: string): User | undefined {
  return data?.user.id === id
    ? data.user
    : data?.friends.find((u) => u.id === id) ||
        data?.conversations.flatMap((c) => c.members).find((u) => u.id === id);
}
function presenceInfo(user: User): { label: string; className: string } {
  if (!online.has(user.id)) return { label: 'Offline', className: 'offline' };
  if (user.presenceMode === 'dnd')
    return { label: 'Do Not Disturb', className: 'dnd' };
  if (user.presenceMode === 'afk') return { label: 'AFK', className: 'afk' };
  return { label: 'Online', className: 'online' };
}
async function refreshState(): Promise<void> {
  if (stateLoading) {
    stateAgain = true;
    return;
  }
  stateLoading = true;
  const requestToken = token;
  const requestServerUrl = serverUrl;
  try {
    const nextData = await api<State>('/api/state');
    if (destroyed || token !== requestToken || serverUrl !== requestServerUrl)
      return;
    data = nextData;
    renderSidebar();
    renderHeader();
    const area = document.querySelector<HTMLElement>('#message-area');
    const scrollTop = area?.scrollTop;
    renderMessages(false, false);
    if (area && scrollTop !== undefined) area.scrollTop = scrollTop;
    renderCall();
  } finally {
    stateLoading = false;
    if (stateAgain) {
      stateAgain = false;
      void refreshState().catch(showError);
    }
  }
}
async function enterApp(initialData?: State): Promise<void> {
  destroyed = false;
  data = initialData || (await api<State>('/api/state'));
  restoreLayout();
  const remembered = localStorage.getItem(accountKey('last-conversation'));
  selected = data.conversations.some((item) => item.id === remembered)
    ? remembered!
    : data.conversations[0]?.id || '';
  renderApp();
  connect();
  if (selected) void selectConversation(selected, false).catch(showError);
}
function accountKey(name: string): string {
  return `tiny.v3:${serverUrl}:${data?.user.id || 'guest'}:${name}`;
}
function restoreLayout(): void {
  leftWidth = Math.max(
    190,
    Math.min(
      380,
      Number(localStorage.getItem(accountKey('left-width'))) || 250,
    ),
  );
  rightWidth = Math.max(
    190,
    Math.min(
      360,
      Number(localStorage.getItem(accountKey('right-width'))) || 240,
    ),
  );
  rightCollapsed = localStorage.getItem(accountKey('right-collapsed')) === '1';
  try {
    const saved = JSON.parse(localStorage.getItem(accountKey('mutes')) || '{}');
    for (const [id, until] of Object.entries(saved))
      mutedConversations.set(id, Number(until));
    for (const id of JSON.parse(
      localStorage.getItem(accountKey('hidden')) || '[]',
    ))
      hiddenConversations.add(id);
  } catch {
    /* Ignore damaged local preferences. */
  }
}
function saveLayout(): void {
  localStorage.setItem(accountKey('left-width'), String(leftWidth));
  localStorage.setItem(accountKey('right-width'), String(rightWidth));
  localStorage.setItem(
    accountKey('right-collapsed'),
    rightCollapsed ? '1' : '0',
  );
}
function saveConversationPreferences(): void {
  localStorage.setItem(
    accountKey('mutes'),
    JSON.stringify(Object.fromEntries(mutedConversations)),
  );
  localStorage.setItem(
    accountKey('hidden'),
    JSON.stringify([...hiddenConversations]),
  );
}
function renderApp(): void {
  forcePaint = true;
  root.replaceChildren();
  const shell = el('main', 'app-shell');
  shell.classList.toggle(
    'has-conversation',
    Boolean(selected) && window.innerWidth >= 760,
  );
  shell.style.setProperty('--left-width', `${leftWidth}px`);
  shell.style.setProperty(
    '--right-width',
    rightCollapsed ? '0px' : `${rightWidth}px`,
  );
  const rail = el('nav', 'nav-rail');
  rail.setAttribute('aria-label', 'Tiny navigation');
  const home = button(
    '',
    () => {
      selected = '';
      renderAll();
    },
    'rail-logo',
  );
  home.append(brand());
  rail.append(
    home,
    button(
      'Friends',
      () => {
        selected = '';
        renderAll();
      },
      'rail-button friends-icon',
    ),
  );
  const requests = button('!', openFriendRequests, 'rail-button');
  requests.title = 'Message and friend requests';
  requests.setAttribute('aria-label', 'Message and friend requests');
  const compose = button('+', openNewChat, 'rail-button');
  compose.title = 'Start a conversation';
  compose.setAttribute('aria-label', 'Start a conversation');
  rail.append(requests, compose);
  for (const group of data?.conversations.filter((item) => item.isGroup) ||
    []) {
    const groupButton = button(
      conversationTitle(group).slice(0, 1).toUpperCase(),
      () => selectConversation(group.id),
      `rail-button group-rail-button ${selected === group.id ? 'selected' : ''}`,
    );
    groupButton.title = conversationTitle(group);
    groupButton.setAttribute('aria-label', `Open ${conversationTitle(group)}`);
    rail.append(groupButton);
  }
  const sidebar = el('aside', 'sidebar');
  sidebar.id = 'sidebar';
  const main = el('section', 'conversation');
  main.setAttribute('aria-label', 'Conversation');
  const header = el('header', 'conversation-header');
  header.id = 'conversation-header';
  const content = el('div', 'message-area');
  content.id = 'message-area';
  const call = el('section', 'call-panel');
  call.id = 'call-panel';
  call.hidden = true;
  const composer = el('div', 'composer-host');
  composer.id = 'composer-host';
  main.append(header, call, content, composer);
  const leftDivider = createResizeHandle('left');
  const rightDivider = createResizeHandle('right');
  const members = el('aside', 'members-panel');
  members.id = 'members-panel';
  shell.append(rail, sidebar, leftDivider, main, rightDivider, members);
  const notices = el('div', 'notices');
  notices.id = 'notices';
  root.append(shell, notices);
  renderSidebar();
  renderHeader();
  renderMessages();
  renderComposer();
  renderCall();
  renderMembers();
  forcePaint = false;
  if (!activity.active) syncBackgroundMedia(false);
}
function renderAll(): void {
  renderSidebar();
  renderHeader();
  renderMessages();
  renderComposer();
  renderMembers();
}
function createResizeHandle(side: 'left' | 'right'): HTMLDivElement {
  const handle = el('div', `resize-handle ${side}`);
  handle.tabIndex = 0;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  const reset = () => {
    if (side === 'left') leftWidth = 250;
    else rightWidth = 240;
    applyLayout();
  };
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return reset();
    const delta = event.key === 'ArrowRight' ? 12 : -12;
    if (side === 'left')
      leftWidth = Math.max(190, Math.min(380, leftWidth + delta));
    else rightWidth = Math.max(190, Math.min(360, rightWidth - delta));
    applyLayout();
  });
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing');
    const start = event.clientX,
      initial = side === 'left' ? leftWidth : rightWidth;
    const move = (next: PointerEvent) => {
      if (side === 'left')
        leftWidth = Math.max(
          190,
          Math.min(380, initial + next.clientX - start),
        );
      else
        rightWidth = Math.max(
          190,
          Math.min(360, initial + start - next.clientX),
        );
      applyLayout(false);
    };
    const up = () => {
      document.body.classList.remove('resizing');
      handle.removeEventListener('pointermove', move);
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
  });
  return handle;
}
function applyLayout(save = true): void {
  const shell = document.querySelector<HTMLElement>('.app-shell');
  shell?.style.setProperty('--left-width', `${leftWidth}px`);
  shell?.style.setProperty(
    '--right-width',
    rightCollapsed ? '0px' : `${rightWidth}px`,
  );
  if (save) saveLayout();
}
function renderSidebar(): void {
  if (deferPaint()) return;
  const sidebar = document.querySelector('#sidebar');
  if (!sidebar || !data) return;
  sidebar.replaceChildren();
  const top = el('div', 'sidebar-top');
  const search = el('input');
  search.type = 'search';
  search.placeholder = 'Search chats';
  search.value = conversationFilter;
  search.setAttribute('aria-label', 'Search conversations');
  search.addEventListener('input', () => {
    conversationFilter = search.value;
    for (const row of sidebar.querySelectorAll<HTMLElement>('.chat-row'))
      row.hidden = !row.textContent
        ?.toLowerCase()
        .includes(conversationFilter.toLowerCase());
  });
  top.append(search);
  const status = el(
    'span',
    `connection ${connection === 'Connected' ? 'connected' : ''}`,
    connection,
  );
  status.setAttribute('role', 'status');
  top.append(status);
  const profile = button('', openProfile, 'profile-button');
  const name = el('span', 'profile-names');
  name.append(
    el('strong', '', data.user.displayName),
    el('span', 'quiet', `@${data.user.handle}`),
  );
  const ownPresence = presenceInfo(data.user);
  const ownPresenceDot = el('span', `presence ${ownPresence.className}`);
  ownPresenceDot.title = ownPresence.label;
  profile.append(
    avatar(data.user),
    name,
    ownPresenceDot,
    el('span', 'profile-edit', 'Edit'),
  );
  profile.setAttribute('aria-label', 'Edit profile');
  sidebar.append(top);
  const chatHeading = el('div', 'list-heading');
  chatHeading.append(
    el('h2', '', 'Conversations'),
    button('New chat', openNewChat, 'text-button'),
  );
  sidebar.append(chatHeading);
  const chats = el('nav', 'chat-list');
  chats.setAttribute('aria-label', 'Conversations');
  for (const conversation of [...data.conversations]
    .filter((item) => !hiddenConversations.has(item.id))
    .sort((a, b) =>
      String(b.lastMessage?.createdAt || '').localeCompare(
        String(a.lastMessage?.createdAt || ''),
      ),
    )) {
    const row = button(
      '',
      () => selectConversation(conversation.id),
      `chat-row ${selected === conversation.id ? 'selected' : ''}`,
    );
    if ((mutedConversations.get(conversation.id) || 0) > Date.now())
      row.classList.add('muted');
    if (conversation.isGroup)
      row.append(el('span', 'avatar group-avatar', '✳'));
    else row.append(avatar(conversationUser(conversation)));
    const copy = el('span', 'chat-copy');
    copy.append(
      el('strong', '', conversationTitle(conversation)),
      el(
        'span',
        'chat-preview',
        conversation.lastMessage?.body || 'Say a little hello',
      ),
    );
    row.append(copy);
    if (conversation.callParticipants?.length)
      row.append(el('span', 'call-dot', '●'));
    row.setAttribute('aria-label', `Open ${conversationTitle(conversation)}`);
    row.hidden = !conversationTitle(conversation)
      .toLowerCase()
      .includes(conversationFilter.toLowerCase());
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openConversationMenu(event, conversation);
    });
    chats.append(row);
  }
  if (!data.conversations.length)
    chats.append(
      el('p', 'sidebar-empty', 'A conversation starts with a hello.'),
    );
  sidebar.append(chats);
  const friendHeading = el('div', 'list-heading');
  friendHeading.append(
    el('h2', '', `Friends · ${data.friends.length}`),
    button('Add friend', openAddFriend, 'text-button'),
  );
  sidebar.append(friendHeading);
  const pendingCount = data.friendRequests?.incoming.length || 0;
  const sentCount = data.friendRequests?.outgoing.length || 0;
  if (pendingCount || sentCount)
    sidebar.append(
      button(
        pendingCount
          ? `Requests · ${pendingCount} new`
          : `Requests · ${sentCount} sent`,
        openFriendRequests,
        `request-summary ${pendingCount ? 'has-incoming' : ''}`,
      ),
    );
  const friends = el('div', 'friend-list');
  for (const friend of data.friends) {
    const row = button('', () => createChat([friend.id]), 'friend-row');
    row.append(avatar(friend, 'small'), el('span', '', friend.displayName));
    const state = presenceInfo(friend);
    const presence = el('span', `presence ${state.className}`);
    presence.title = state.label;
    row.append(presence);
    row.setAttribute(
      'aria-label',
      `Chat with ${friend.displayName} @${friend.handle}`,
    );
    friends.append(row);
  }
  if (!data.friends.length)
    friends.append(el('p', 'sidebar-empty', 'Add a friend by their handle.'));
  sidebar.append(friends);
  const bottom = el('div', 'sidebar-bottom');
  const actions = el('div', 'dock-actions');
  const mic = button('', () => calls.toggleMute(), 'dock-button');
  mic.setAttribute(
    'aria-label',
    calls.state.muted ? 'Unmute microphone' : 'Mute microphone',
  );
  mic.append(controlIcon('microphone', calls.state.muted));
  const deafen = button('', () => calls.toggleDeafen(), 'dock-button');
  deafen.setAttribute(
    'aria-label',
    calls.state.deafened ? 'Undeafen' : 'Deafen',
  );
  deafen.append(controlIcon('headphones', calls.state.deafened));
  const settings = button('', openSettings, 'dock-button');
  settings.setAttribute('aria-label', 'Settings');
  settings.title = 'Settings (Ctrl+,)';
  settings.append(controlIcon('settings'));
  mic.title = mic.getAttribute('aria-label') || '';
  deafen.title = deafen.getAttribute('aria-label') || '';
  mic.classList.toggle('active-danger', calls.state.muted);
  deafen.classList.toggle('active-danger', calls.state.deafened);
  mic.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void openAudioDeviceMenu(event, 'input');
  });
  deafen.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    void openAudioDeviceMenu(event, 'output');
  });
  actions.append(mic, deafen, settings);
  bottom.append(profile, actions);
  sidebar.append(bottom);
}
function renderHeader(): void {
  if (deferPaint()) return;
  const header = document.querySelector('#conversation-header');
  if (!header || !data) return;
  header.replaceChildren();
  const conversation = data.conversations.find((c) => c.id === selected);
  if (!conversation) {
    header.append(el('span', 'quiet', 'YOUR LITTLE CORNER'));
    return;
  }
  const copy = el('div', 'header-copy');
  const back = button(
    'Back',
    () => {
      selected = '';
      renderApp();
    },
    'mobile-back',
  );
  copy.append(
    el('h1', '', conversationTitle(conversation)),
    el(
      'p',
      'quiet',
      conversation.isGroup
        ? conversation.members.map((u) => u.displayName).join(', ')
        : `@${conversationUser(conversation).handle}`,
    ),
  );
  const headerAvatar = conversation.isGroup
    ? el('span', 'avatar group-avatar', '✦')
    : avatar(conversationUser(conversation), 'small');
  headerAvatar.classList.add('header-avatar');
  header.append(back, headerAvatar, copy);
  const active = conversation.callParticipants?.length || 0;
  const start = button(
    active ? `Join call · ${active}` : 'Start call',
    () => joinCall(conversation.id),
    'button call-button',
  );
  start.disabled =
    !!calls.state.conversationId ||
    calls.state.joining ||
    connection !== 'Connected';
  header.append(start);
  header.append(
    button(
      rightCollapsed ? 'Show people' : 'Hide people',
      () => {
        rightCollapsed = !rightCollapsed;
        applyLayout();
        document
          .querySelector('#members-panel')
          ?.classList.toggle('drawer-open', !rightCollapsed);
        renderHeader();
      },
      'text-button members-toggle',
    ),
  );
}
function renderMembers(): void {
  const panel = document.querySelector<HTMLElement>('#members-panel');
  if (!panel || !data) return;
  panel.replaceChildren();
  const conversation = data.conversations.find((item) => item.id === selected);
  if (!conversation) {
    panel.append(el('h2', '', 'Friends'));
    for (const friend of data.friends) panel.append(userRow(friend));
    if (!data.friends.length)
      panel.append(el('p', 'muted', 'Your friends will appear here.'));
    return;
  }
  if (!conversation.isGroup) {
    const user = conversationUser(conversation);
    const card = el('section', 'profile-card');
    const state = presenceInfo(user);
    card.append(
      profileBanner(user),
      avatar(user, 'large'),
      el('h2', '', user.displayName),
      el('p', 'muted', `@${user.handle}`),
      el('span', `presence-label ${state.className}`, state.label),
    );
    if (user.friendsSince)
      card.append(
        el(
          'p',
          'muted',
          `Friends since ${new Date(user.friendsSince).toLocaleDateString()}`,
        ),
      );
    card.append(
      button('View profile', () => openUserProfile(user), 'button subtle'),
      button('Remove friend', () => removeFriend(user), 'text-button danger'),
    );
    panel.append(card);
    return;
  }
  panel.append(el('h2', '', `Members · ${conversation.members.length}`));
  const sorted = [...conversation.members].sort(
    (a, b) =>
      Number(online.has(b.id)) - Number(online.has(a.id)) ||
      a.displayName.localeCompare(b.displayName),
  );
  for (const user of sorted) panel.append(userRow(user));
}
function userRow(user: User): HTMLButtonElement {
  const state = presenceInfo(user);
  const row = button('', () => openUserProfile(user), 'member-row');
  row.append(
    avatar(user, 'small'),
    el('span', '', user.displayName),
    el('span', `presence ${state.className}`),
  );
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openUserMenu(event, user);
  });
  return row;
}
function openUserProfile(user: User): void {
  if (!data) return;
  const { body } = modal('Profile');
  const card = el('section', 'profile-card');
  const state = presenceInfo(user);
  card.append(
    profileBanner(user),
    avatar(user, 'large'),
    el('h2', '', user.displayName),
    el('p', 'muted', `@${user.handle}`),
    el('p', `presence-label ${state.className}`, state.label),
  );
  const friend = data.friends.some((item) => item.id === user.id);
  if (user.id !== data.user.id) {
    if (friend)
      card.append(
        button('Message', () => createChat([user.id]), 'button primary'),
        button('Remove friend', () => removeFriend(user), 'button danger'),
      );
    else
      card.append(
        button(
          'Add friend',
          () => sendFriendRequest(user.handle),
          'button primary',
        ),
      );
  }
  body.append(card);
}
async function sendFriendRequest(handle: string): Promise<void> {
  await api('/api/friend-requests', 'POST', { handle });
  await refreshState();
}
async function removeFriend(user: User): Promise<void> {
  if (
    !confirm(
      `Remove ${user.displayName} from your friends? Your message history will stay.`,
    )
  )
    return;
  await api(`/api/friends/${encodeURIComponent(user.id)}`, 'DELETE');
  await refreshState();
}
async function joinCall(conversationId: string): Promise<void> {
  calls.configure(await refreshIce(), forceRelayTest);
  await calls.join(conversationId);
}
async function selectConversation(
  id: string,
  openMobileView = true,
): Promise<void> {
  if (selected) {
    drafts.set(selected, currentDraft);
    const oldArea = document.querySelector<HTMLElement>('#message-area');
    if (oldArea) scrollPositions.set(selected, oldArea.scrollTop);
  }
  selected = id;
  if (openMobileView)
    document.querySelector('.app-shell')?.classList.add('has-conversation');
  localStorage.setItem(accountKey('last-conversation'), id);
  currentDraft = drafts.get(id) || '';
  messages = [];
  hasMore = false;
  renderSidebar();
  renderHeader();
  renderMessages(true);
  renderComposer();
  renderMembers();
  const generation = ++messageGeneration;
  try {
    const result = await api<{ messages: Message[]; hasMore: boolean }>(
      `/api/conversations/${id}/messages`,
    );
    if (generation !== messageGeneration) return;
    messages = [
      ...new Map(
        [...result.messages, ...messages].map((message) => [
          message.id,
          message,
        ]),
      ).values(),
    ].sort((a, b) => a.id - b.id);
    hasMore = result.hasMore;
    renderMessages();
    const area = document.querySelector<HTMLElement>('#message-area');
    if (area && scrollPositions.has(id))
      area.scrollTop = scrollPositions.get(id)!;
  } catch (error) {
    if (generation === messageGeneration) {
      renderMessages();
      showError(error);
    }
  }
}
async function loadOlder(): Promise<void> {
  if (!selected || !messages.length) return;
  const id = selected;
  const area = document.querySelector<HTMLElement>('#message-area')!;
  const previousHeight = area.scrollHeight;
  const result = await api<{ messages: Message[]; hasMore: boolean }>(
    `/api/conversations/${id}/messages?before=${encodeURIComponent(messages[0].id)}`,
  );
  if (id !== selected) return;
  messages = [...result.messages, ...messages];
  hasMore = result.hasMore;
  renderMessages(false, false);
  area.scrollTop = area.scrollHeight - previousHeight;
}
function renderMessages(loading = false, scroll = true): void {
  if (deferPaint()) return;
  const area = document.querySelector<HTMLElement>('#message-area');
  if (!area || !data) return;
  area.replaceChildren();
  if (!selected) {
    const welcome = el('div', 'empty-state');
    welcome.append(
      el('span', 'empty-symbol', '✳'),
      el('span', 'eyebrow', 'ROOM FOR YOUR PEOPLE'),
      el('h2', '', `Hey, ${data.user.displayName}.`),
      el(
        'p',
        '',
        'Pick a friend to catch up, or start a small group. Your messages will be right here when you come back.',
      ),
      button('Start a conversation', openNewChat, 'button primary'),
    );
    area.append(welcome);
    return;
  }
  if (loading) {
    area.append(el('p', 'loading', 'Opening your conversation…'));
    return;
  }
  if (hasMore)
    area.append(
      button('Load earlier messages', loadOlder, 'text-button load-more'),
    );
  if (!messages.length) {
    const empty = el('div', 'empty-state compact');
    empty.append(
      el('span', 'empty-symbol', '✳'),
      el('h2', '', 'A fresh little conversation.'),
      el('p', '', 'Say hello. You’re in good company.'),
    );
    area.append(empty);
  }
  const log = el('div', 'message-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-label', 'Messages');
  let previous: Message | undefined;
  for (const message of messages) {
    const user = userById(message.senderId);
    const date = new Date(message.createdAt);
    const previousDate = previous ? new Date(previous.createdAt) : null;
    if (!previousDate || previousDate.toDateString() !== date.toDateString()) {
      const separator = el(
        'div',
        'date-separator',
        Number.isNaN(date.valueOf())
          ? ''
          : date.toLocaleDateString([], {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            }),
      );
      log.append(separator);
    }
    const grouped = Boolean(
      previous &&
      previous.senderId === message.senderId &&
      date.valueOf() - new Date(previous.createdAt).valueOf() < 5 * 60_000,
    );
    const row = el(
      'article',
      `message ${message.senderId === data.user.id ? 'own' : ''} ${grouped ? 'grouped' : ''}`,
    );
    row.dataset.messageId = String(message.id);
    if (user) {
      const avatarButton = button(
        '',
        () => openUserProfile(user),
        'avatar-button',
      );
      avatarButton.append(avatar(user, 'small'));
      row.append(avatarButton);
    }
    const content = el('div', 'message-content');
    const meta = el('div', 'message-meta');
    const time = el(
      'time',
      '',
      Number.isNaN(date.valueOf())
        ? ''
        : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    time.dateTime = message.createdAt;
    time.title = date.toLocaleString();
    const sender = button(
      user?.displayName || 'Friend',
      () => user && openUserProfile(user),
      'message-sender',
    );
    meta.append(sender, time);
    if (message.editedAt) meta.append(el('span', 'edited-label', '(edited)'));
    content.append(
      meta,
      el(
        'p',
        `message-body ${message.deletedAt ? 'deleted' : ''}`,
        message.deletedAt ? 'Message deleted' : message.body,
      ),
    );
    row.append(content);
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openMessageMenu(event, message, user);
    });
    log.append(row);
    previous = message;
  }
  area.append(log);
  if (scroll) area.scrollTop = area.scrollHeight;
}
function renderComposer(): void {
  const host = document.querySelector('#composer-host');
  if (!host) return;
  host.replaceChildren();
  if (!selected) return;
  const form = el('form', 'composer');
  const textarea = el('textarea');
  textarea.name = 'message';
  textarea.setAttribute('aria-label', 'Message');
  textarea.placeholder = 'A little message…';
  textarea.rows = 1;
  textarea.maxLength = 4000;
  textarea.value = currentDraft;
  const resizeComposer = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(160, textarea.scrollHeight)}px`;
  };
  requestAnimationFrame(resizeComposer);
  textarea.addEventListener('input', () => {
    currentDraft = textarea.value;
    resizeComposer();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  const submit = el('button', 'button primary', sending ? 'Sending…' : 'Send');
  submit.type = 'submit';
  submit.setAttribute('aria-label', 'Send message');
  submit.disabled = sending;
  form.append(textarea, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = textarea.value.trim();
    if (!body || sending) return;
    const conversationId = selected;
    if (pendingBody !== body || pendingConversation !== conversationId) {
      pendingClientId = crypto.randomUUID();
      pendingBody = body;
      pendingConversation = conversationId;
    }
    sending = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    try {
      const message = await api<Message>(
        `/api/conversations/${conversationId}/messages`,
        'POST',
        { body, clientId: pendingClientId },
      );
      receiveMessage(message);
      pendingBody = '';
      pendingClientId = '';
      pendingConversation = '';
      drafts.delete(conversationId);
      if (selected === conversationId && textarea.value.trim() === body) {
        currentDraft = '';
        textarea.value = '';
      }
    } catch (error) {
      showError(error);
    } finally {
      sending = false;
      submit.disabled = false;
      submit.textContent = 'Send';
      if (selected === conversationId) textarea.focus();
      else renderComposer();
    }
  });
  host.append(
    form,
    el('p', 'composer-hint', 'Enter to send · Shift + Enter for a new line'),
  );
}
function receiveMessage(message: Message): void {
  if (!data) return;
  const conversation = data.conversations.find(
    (c) => c.id === message.conversationId,
  );
  if (conversation) conversation.lastMessage = message;
  if (
    message.conversationId === selected &&
    !messages.some((m) => m.id === message.id)
  ) {
    messages.push(message);
    if (!activity.active && messages.length > 500) {
      messages = messages.slice(-500);
      hasMore = true;
    }
    renderMessages();
  }
  renderSidebar();
}
function updateMessage(message: Message): void {
  const index = messages.findIndex((item) => item.id === message.id);
  if (index >= 0) messages[index] = message;
  if (data) {
    const conversation = data.conversations.find(
      (item) => item.id === message.conversationId,
    );
    if (conversation?.lastMessage?.id === message.id)
      conversation.lastMessage = message;
  }
  renderMessages(false, false);
  renderSidebar();
}
function openMessageMenu(
  event: MouseEvent,
  message: Message,
  user?: User,
): void {
  if (!data) return;
  const own = message.senderId === data.user.id;
  const items: MenuItem[] = [];
  if (!message.deletedAt)
    items.push(
      {
        label: 'Reply',
        action: () => {
          const box =
            document.querySelector<HTMLTextAreaElement>('.composer textarea');
          if (box) {
            box.value = `@${user?.handle || 'friend'} `;
            box.focus();
            currentDraft = box.value;
          }
        },
      },
      {
        label: 'Copy message text',
        action: () => navigator.clipboard.writeText(message.body),
      },
    );
  items.push({
    label: 'Copy message ID',
    action: () => navigator.clipboard.writeText(String(message.id)),
  });
  if (user)
    items.push({
      label: 'View sender profile',
      action: () => openUserProfile(user),
    });
  if (own && !message.deletedAt)
    items.push(
      {
        label: 'Edit message',
        action: async () => {
          const body = prompt('Edit message', message.body)?.trim();
          if (!body || body === message.body) return;
          updateMessage(
            await api<Message>(`/api/messages/${message.id}`, 'PATCH', {
              body,
            }),
          );
        },
      },
      {
        label: 'Delete message',
        danger: true,
        action: async () => {
          if (!confirm('Delete this message?')) return;
          updateMessage(
            await api<Message>(`/api/messages/${message.id}`, 'DELETE'),
          );
        },
      },
    );
  openContextMenu(event, items);
}

function connect(): void {
  if (destroyed || !token) return;
  connection = 'Connecting';
  renderSidebar();
  renderHeader();
  const url = new URL('/ws', serverUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(url);
  const current = socket;
  current.addEventListener('open', () =>
    current.send(JSON.stringify({ type: 'auth', token })),
  );
  current.addEventListener('message', (event) => {
    if (socket !== current || destroyed) return;
    let packet: any;
    try {
      packet = JSON.parse(event.data);
    } catch {
      return;
    }
    if (packet.type === 'ready') {
      reconnectAttempt = 0;
      connection = 'Connected';
      renderSidebar();
      renderHeader();
      void refreshState().catch(showError);
      if (selected) void selectConversation(selected, false).catch(showError);
    }
    if (packet.type === 'state') void refreshState().catch(showError);
    if (packet.type === 'message') receiveMessage(packet.message);
    if (packet.type === 'message:update') updateMessage(packet.message);
    if (packet.type === 'presence') {
      online = new Set(packet.userIds);
      renderSidebar();
      renderMembers();
    }
    if (packet.type === 'call:state' && data) {
      const conversation = data.conversations.find(
        (c) => c.id === packet.conversationId,
      );
      if (conversation) conversation.callParticipants = packet.participants;
      renderHeader();
      renderSidebar();
    }
    if (packet.type === 'error')
      showError(packet.message || 'The server could not complete that action.');
    void Promise.resolve(calls.handle(packet)).catch(showError);
  });
  current.addEventListener('close', (event) => {
    if (socket !== current || destroyed) return;
    calls.leave();
    connection = 'Reconnecting';
    online.clear();
    renderSidebar();
    renderHeader();
    if (event.code === 4001 || event.code === 4401) {
      void signOut(false);
      return;
    }
    reconnectTimer = setTimeout(
      connect,
      Math.min(15000, 750 * 2 ** reconnectAttempt++),
    );
  });
  current.addEventListener('error', () => {
    connection = 'Server unavailable';
    renderSidebar();
  });
}
async function signOut(revoke = true): Promise<void> {
  if (revoke) {
    try {
      await api('/api/logout', 'POST', {});
    } catch {
      /* Clear local session even when server is offline. */
    }
  }
  destroyed = true;
  clearTimeout(reconnectTimer);
  calls.destroy();
  socket?.close();
  socket = null;
  tokenStorage.removeItem(`tiny.token:${serverUrl}`);
  authCreate = false;
  messageGeneration++;
  token = '';
  data = null;
  selected = '';
  messages = [];
  currentDraft = '';
  drafts.clear();
  mediaNodes.clear();
  newCallEngine();
  renderLogin();
}

function modal(title: string): {
  dialog: HTMLDialogElement;
  body: HTMLDivElement;
  close: () => void;
} {
  const dialog = el('dialog', 'modal');
  const heading = el('div', 'modal-heading');
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  heading.append(el('h2', '', title), button('Close', close, 'text-button'));
  const body = el('div', 'modal-body');
  dialog.append(heading, body);
  root.append(dialog);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) {
      const bounds = dialog.getBoundingClientRect();
      if (
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        close();
    }
  });
  dialog.showModal();
  return { dialog, body, close };
}
type MenuItem = { label: string; action: () => unknown; danger?: boolean };
async function openAudioDeviceMenu(
  event: MouseEvent,
  kind: 'input' | 'output',
): Promise<void> {
  if (!navigator.mediaDevices?.enumerateDevices) {
    showError('Audio device selection is unavailable in this window.');
    return;
  }
  const outputSupported = supportsAudioOutputSelection();
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
    (device) =>
      device.kind === (kind === 'input' ? 'audioinput' : 'audiooutput'),
  );
  const selected = kind === 'input' ? audioInputId : audioOutputId;
  const items: MenuItem[] = [
    {
      label: `${selected ? '' : '✓ '}Windows default ${kind === 'input' ? 'microphone' : 'output'}`,
      action: async () => {
        if (kind === 'input') {
          if (await calls.setAudioInput('')) {
            audioInputId = '';
            localStorage.setItem(audioInputKey, '');
          }
        } else await selectAudioOutput('');
      },
    },
  ];
  if (!(kind === 'output' && !outputSupported)) {
    for (const [index, device] of devices.entries())
      items.push({
        label: `${device.deviceId === selected ? '✓ ' : ''}${device.label || `${kind === 'input' ? 'Microphone' : 'Output'} ${index + 1}`}`,
        action: async () => {
          if (kind === 'input') {
            if (await calls.setAudioInput(device.deviceId)) {
              audioInputId = device.deviceId;
              localStorage.setItem(audioInputKey, device.deviceId);
            }
          } else await selectAudioOutput(device.deviceId);
        },
      });
  }
  items.push({
    label: 'Voice & Audio settings…',
    action: openSettings,
  });
  openContextMenu(event, items);
}
function openContextMenu(event: MouseEvent, items: MenuItem[]): void {
  document.querySelector('.context-menu')?.remove();
  const menu = el('div', 'context-menu');
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  for (const item of items) {
    const option = button(
      item.label,
      () => {
        menu.remove();
        return item.action();
      },
      `context-item ${item.danger ? 'danger' : ''}`,
    );
    option.setAttribute('role', 'menuitem');
    menu.append(option);
  }
  root.append(menu);
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - bounds.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - bounds.height - 8))}px`;
  menu.querySelector<HTMLButtonElement>('button')?.focus();
  const close = (next: Event) => {
    if (!menu.contains(next.target as Node)) menu.remove();
  };
  setTimeout(() => addEventListener('pointerdown', close, { once: true }), 0);
  menu.addEventListener('keydown', (key) => {
    if (key.key === 'Escape') menu.remove();
    const options = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (key.key === 'ArrowDown') {
      key.preventDefault();
      options[(index + 1) % options.length]?.focus();
    }
    if (key.key === 'ArrowUp') {
      key.preventDefault();
      options[(index - 1 + options.length) % options.length]?.focus();
    }
  });
}
function openConversationMenu(
  event: MouseEvent,
  conversation: Conversation,
): void {
  const muted = (mutedConversations.get(conversation.id) || 0) > Date.now();
  const mute = (duration: number) => {
    mutedConversations.set(
      conversation.id,
      duration === Infinity ? Number.MAX_SAFE_INTEGER : Date.now() + duration,
    );
    saveConversationPreferences();
    renderSidebar();
  };
  openContextMenu(event, [
    {
      label: 'Open conversation',
      action: () => selectConversation(conversation.id),
    },
    ...(muted
      ? [
          {
            label: 'Unmute conversation',
            action: () => {
              mutedConversations.delete(conversation.id);
              saveConversationPreferences();
              renderSidebar();
            },
          },
        ]
      : [
          { label: 'Mute for 1 hour', action: () => mute(3_600_000) },
          { label: 'Mute for 8 hours', action: () => mute(28_800_000) },
          { label: 'Mute for 24 hours', action: () => mute(86_400_000) },
          { label: 'Mute indefinitely', action: () => mute(Infinity) },
        ]),
    {
      label: 'Close from sidebar',
      action: () => {
        hiddenConversations.add(conversation.id);
        saveConversationPreferences();
        renderSidebar();
      },
    },
    {
      label: 'Delete from my account',
      danger: true,
      action: async () => {
        if (
          !confirm(
            `Remove ${conversationTitle(conversation)} from your conversations? Other participants keep their history.`,
          )
        )
          return;
        await api(`/api/conversations/${conversation.id}`, 'DELETE');
        hiddenConversations.delete(conversation.id);
        if (selected === conversation.id) {
          selected = '';
          messages = [];
        }
        await refreshState();
        renderAll();
      },
    },
  ]);
}
function openUserMenu(event: MouseEvent, user: User): void {
  if (!data) return;
  const friend = data.friends.some((item) => item.id === user.id);
  openContextMenu(event, [
    { label: 'View profile', action: () => openUserProfile(user) },
    { label: 'Message', action: () => createChat([user.id]) },
    friend
      ? {
          label: 'Remove friend',
          action: () => removeFriend(user),
          danger: true,
        }
      : { label: 'Add friend', action: () => sendFriendRequest(user.handle) },
  ]);
}
function openAddFriend(): void {
  const { body, close } = modal('Send a friend request');
  body.append(
    el(
      'p',
      'muted',
      'Find someone by their exact handle on this Tiny server. Adding a friend connects both test accounts.',
    ),
  );
  const form = el('form', 'stack');
  const handle = input('Friend handle', 'friendHandle');
  handle.field.required = true;
  handle.field.placeholder = 'e.g. bob';
  const submit = el('button', 'button primary', 'Send request');
  submit.type = 'submit';
  form.append(handle.wrapper, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api('/api/friend-requests', 'POST', {
        handle: handle.field.value.trim(),
      });
      await refreshState();
      close();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  body.append(form);
  handle.field.focus();
}
function openFriendRequests(): void {
  if (!data) return;
  const { body, close } = modal('Friend requests');
  const section = (
    title: string,
    items: FriendRequest[],
    incoming: boolean,
  ) => {
    body.append(el('h3', 'request-heading', title));
    const list = el('div', 'request-list');
    if (!items.length) list.append(el('p', 'muted', 'Nothing here right now.'));
    for (const request of items) {
      const row = el('div', 'request-row');
      const identity = el('div', 'request-person');
      identity.append(
        avatar(request.user, 'small'),
        el('strong', '', request.user.displayName),
        el('span', 'quiet', `@${request.user.handle}`),
      );
      const actions = el('div', 'request-actions');
      const act = async (action: 'accept' | 'decline' | 'cancel') => {
        await api(`/api/friend-requests/${request.user.id}`, 'PATCH', {
          action,
        });
        close();
        await refreshState();
      };
      if (incoming)
        actions.append(
          button('Accept', () => act('accept'), 'button primary small-button'),
          button('Decline', () => act('decline'), 'button small-button'),
        );
      else
        actions.append(
          button('Cancel', () => act('cancel'), 'button small-button'),
        );
      row.append(identity, actions);
      list.append(row);
    }
    body.append(list);
  };
  section('Incoming', data.friendRequests?.incoming || [], true);
  section('Sent', data.friendRequests?.outgoing || [], false);
}
function openNewChat(): void {
  if (!data) return;
  const { body, close } = modal('A new conversation');
  if (!data.friends.length) {
    body.append(
      el('p', 'muted', 'Add a friend first, then start a conversation.'),
      button(
        'Add friend',
        () => {
          close();
          openAddFriend();
        },
        'button primary',
      ),
    );
    return;
  }
  body.append(
    el('p', 'muted', 'Choose one friend, or up to three for a small group.'),
  );
  const form = el('form', 'stack');
  const checks: HTMLInputElement[] = [];
  const list = el('div', 'choose-friends');
  for (const friend of data.friends) {
    const label = el('label', 'choose-friend');
    const check = el('input');
    check.type = 'checkbox';
    check.value = friend.id;
    check.name = 'members';
    checks.push(check);
    label.append(
      check,
      avatar(friend, 'small'),
      el('span', '', `${friend.displayName} @${friend.handle}`),
    );
    list.append(label);
  }
  const title = input('Group name', 'groupName');
  title.field.maxLength = 60;
  title.field.placeholder = 'e.g. The little things';
  const submit = el('button', 'button primary', 'Create chat');
  submit.type = 'submit';
  form.append(list, title.wrapper, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const ids = checks.filter((c) => c.checked).map((c) => c.value);
    if (!ids.length || ids.length > 3) {
      showError('Choose between one and three friends.');
      return;
    }
    if (ids.length > 1 && !title.field.value.trim()) {
      showError('Give your group a name.');
      title.field.focus();
      return;
    }
    submit.disabled = true;
    try {
      await createChat(ids, title.field.value.trim());
      close();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  body.append(form);
}
async function createChat(memberIds: string[], title?: string): Promise<void> {
  const conversation = await api<Conversation>('/api/conversations', 'POST', {
    memberIds,
    ...(title ? { title } : {}),
  });
  await refreshState();
  await selectConversation(conversation.id);
}
function openProfile(): void {
  if (!data) return;
  const user = data.user;
  const { body, close } = modal('Make it yours');
  const form = el('form', 'stack');
  const preview = el('div', 'profile-preview');
  preview.append(avatar(user, 'large'));
  const bannerPreview = el('div', 'banner-preview');
  bannerPreview.append(profileBanner(user));
  const display = input(
    'Display name',
    'displayName',
    'text',
    user.displayName,
  );
  display.field.required = true;
  display.field.maxLength = 48;
  const file = input('Profile picture', 'avatar', 'file');
  file.field.accept = 'image/png,image/jpeg,image/gif';
  const bannerFile = input('Profile banner', 'banner', 'file');
  bannerFile.field.accept = 'image/png,image/jpeg,image/gif';
  let image: string | null | undefined;
  let bannerImage: string | null | undefined;
  let readingAvatar = false;
  let readingBanner = false;
  file.field.addEventListener('change', async () => {
    const selectedFile = file.field.files?.[0];
    if (!selectedFile) return;
    if (
      !['image/png', 'image/jpeg', 'image/gif'].includes(selectedFile.type) ||
      selectedFile.size > 10 * 1024 * 1024
    ) {
      file.field.value = '';
      showError('Choose a PNG, JPEG, or GIF picture up to 10 MB.');
      return;
    }
    try {
      readingAvatar = true;
      submit.disabled = true;
      image = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new Error('Could not read that picture.'));
        reader.readAsDataURL(selectedFile);
      });
      preview.replaceChildren(avatar({ ...user, avatar: image }, 'large'));
      readingAvatar = false;
      submit.disabled = false;
    } catch (error) {
      readingAvatar = false;
      submit.disabled = false;
      showError(error);
    }
  });
  bannerFile.field.addEventListener('change', async () => {
    const selectedFile = bannerFile.field.files?.[0];
    if (!selectedFile) return;
    if (
      !['image/png', 'image/jpeg', 'image/gif'].includes(selectedFile.type) ||
      selectedFile.size > 10 * 1024 * 1024
    ) {
      bannerFile.field.value = '';
      showError('Choose a PNG, JPEG, or GIF banner up to 10 MB.');
      return;
    }
    try {
      readingBanner = true;
      submit.disabled = true;
      bannerImage = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error('Could not read that banner.'));
        reader.readAsDataURL(selectedFile);
      });
      bannerPreview.replaceChildren(
        profileBanner({ ...user, banner: bannerImage }),
      );
    } catch (error) {
      showError(error);
    } finally {
      readingBanner = false;
      submit.disabled = false;
    }
  });
  const remove = button(
    'Remove picture',
    () => {
      image = null;
      file.field.value = '';
      preview.replaceChildren(avatar({ ...user, avatar: null }, 'large'));
    },
    'text-button',
  );
  const submit = el('button', 'button primary', 'Save profile');
  submit.type = 'submit';
  form.append(
    bannerPreview,
    preview,
    display.wrapper,
    file.wrapper,
    bannerFile.wrapper,
    el(
      'p',
      'quiet',
      'PNG, JPEG, or GIF · up to 10 MB. Animated GIFs are supported.',
    ),
    remove,
    button(
      'Remove banner',
      () => {
        bannerImage = null;
        bannerFile.field.value = '';
        bannerPreview.replaceChildren(profileBanner({ ...user, banner: null }));
      },
      'text-button',
    ),
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readingAvatar || readingBanner) return;
    submit.disabled = true;
    try {
      await api('/api/me', 'PATCH', {
        displayName: display.field.value.trim(),
        ...(image === undefined ? {} : { avatar: image }),
        ...(bannerImage === undefined ? {} : { banner: bannerImage }),
      });
      await refreshState();
      renderMessages(false, false);
      close();
    } catch (error) {
      showError(error);
    } finally {
      submit.disabled = false;
    }
  });
  body.append(form);
}

type AudioSinkElement = HTMLMediaElement & {
  setSinkId?: (deviceId: string) => Promise<void>;
};

function supportsAudioOutputSelection(): boolean {
  return (
    typeof (HTMLMediaElement.prototype as AudioSinkElement).setSinkId ===
    'function'
  );
}

async function applyAudioOutput(node: HTMLMediaElement): Promise<void> {
  if (!(node instanceof HTMLAudioElement)) return;
  node.volume = Math.max(0, Math.min(1, audioSettings.outputVolume));
  const sink = node as AudioSinkElement;
  if (!sink.setSinkId) return;
  await sink.setSinkId(audioOutputId);
}

async function selectAudioOutput(deviceId: string): Promise<void> {
  const selected = String(deviceId || '');
  if (selected && !supportsAudioOutputSelection())
    throw new Error(
      'Speaker selection is unavailable in this browser. Tiny will use the Windows default output.',
    );
  const previous = audioOutputId;
  audioOutputId = selected;
  try {
    await Promise.all([...mediaNodes.values()].map(applyAudioOutput));
    localStorage.setItem(audioOutputKey, selected);
  } catch (error) {
    audioOutputId = previous;
    throw new Error(
      error instanceof Error
        ? `Could not use that speaker: ${error.message}`
        : 'Could not use that speaker.',
    );
  }
}

function openSettings(): void {
  const { dialog, body, close } = modal('Settings');
  const account = el('section', 'settings-section');
  const statusLabel = el('label', 'field', 'Status');
  const statusSelect = el('select');
  for (const [value, label] of [
    ['online', 'Online'],
    ['afk', 'AFK'],
    ['dnd', 'Do Not Disturb'],
  ]) {
    const option = el('option');
    option.value = value;
    option.textContent = label;
    statusSelect.append(option);
  }
  statusSelect.value = data?.user.presenceMode || 'online';
  statusSelect.addEventListener('change', async () => {
    statusSelect.disabled = true;
    try {
      await api('/api/me', 'PATCH', { presenceMode: statusSelect.value });
      await refreshState();
    } catch (error) {
      showError(error);
    } finally {
      statusSelect.disabled = false;
    }
  });
  statusLabel.append(statusSelect);
  account.append(el('h3', '', 'Account'), statusLabel);
  const appearance = el('section', 'settings-section');
  appearance.append(
    el('h3', '', 'Appearance'),
    createThemeToggle(),
    button(
      'Reset layout to default',
      () => {
        leftWidth = 250;
        rightWidth = 240;
        rightCollapsed = false;
        applyLayout();
        renderMembers();
      },
      'button subtle',
    ),
  );
  const copy = el(
    'p',
    'muted',
    'Choose the devices Tiny uses for voice calls. Changes apply immediately to an active call.',
  );
  const form = el('form', 'stack voice-settings');
  const inputLabel = el('label', 'field', 'Voice input');
  const inputSelect = el('select');
  inputSelect.name = 'audioInput';
  const outputLabel = el('label', 'field', 'Voice output');
  const outputSelect = el('select');
  outputSelect.name = 'audioOutput';
  const processingBox = el('div', 'audio-processing');
  const processingInputs = new Map<keyof AudioProcessing, HTMLInputElement>();
  for (const [key, label] of [
    ['noiseSuppression', 'Noise suppression'],
    ['echoCancellation', 'Echo cancellation'],
    ['autoGainControl', 'Automatic gain control'],
  ] as const) {
    const row = el('label', 'toggle-row');
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = audioSettings[key];
    processingInputs.set(key, toggle);
    row.append(toggle, el('span', '', label));
    processingBox.append(row);
  }
  const outputVolumeLabel = el('label', 'field', 'Output volume');
  const outputVolume = el('input');
  outputVolume.type = 'range';
  outputVolume.min = '0';
  outputVolume.max = '100';
  outputVolume.value = String(Math.round(audioSettings.outputVolume * 100));
  outputVolume.addEventListener('input', () => {
    const volume = Number(outputVolume.value) / 100;
    for (const node of mediaNodes.values())
      if (node instanceof HTMLAudioElement) node.volume = volume;
  });
  outputVolumeLabel.append(outputVolume);
  const meterLabel = el('label', 'field', 'Microphone level');
  const meter = el('progress', 'input-meter');
  meter.max = 100;
  meter.value = 0;
  meterLabel.append(meter);
  const monitorRow = el('label', 'toggle-row');
  const monitor = el('input');
  monitor.type = 'checkbox';
  monitor.disabled = true;
  monitorRow.append(monitor, el('span', '', 'Hear microphone during test'));
  let testStream: MediaStream | null = null;
  let testAudio: HTMLAudioElement | null = null;
  let testContext: AudioContext | null = null;
  let meterFrame = 0;
  const stopTest = () => {
    cancelAnimationFrame(meterFrame);
    testAudio?.pause();
    if (testAudio) testAudio.srcObject = null;
    testAudio = null;
    void testContext?.close();
    testContext = null;
    testStream?.getTracks().forEach((track) => track.stop());
    testStream = null;
    meter.value = 0;
    monitor.checked = false;
    monitor.disabled = true;
    testButton.textContent = 'Test microphone';
  };
  const testButton = button(
    'Test microphone',
    async () => {
      if (testStream) {
        stopTest();
        return;
      }
      testStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(inputSelect.value
            ? { deviceId: { exact: inputSelect.value } }
            : {}),
          noiseSuppression: processingInputs.get('noiseSuppression')!.checked,
          echoCancellation: processingInputs.get('echoCancellation')!.checked,
          autoGainControl: processingInputs.get('autoGainControl')!.checked,
        },
        video: false,
      });
      testContext = new AudioContext();
      const analyser = testContext.createAnalyser();
      analyser.fftSize = 256;
      testContext.createMediaStreamSource(testStream).connect(analyser);
      const values = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(values);
        meter.value = Math.min(100, (Math.max(...values) / 255) * 120);
        meterFrame = requestAnimationFrame(draw);
      };
      draw();
      monitor.disabled = false;
      testButton.textContent = 'Stop microphone test';
    },
    'button subtle',
  );
  monitor.addEventListener('change', () => {
    if (!testStream) return;
    if (!testAudio) {
      testAudio = new Audio();
      testAudio.srcObject = testStream;
      testAudio.volume = 0.35;
    }
    if (monitor.checked) void testAudio.play().catch(showError);
    else testAudio.pause();
  });
  dialog.addEventListener('close', stopTest, { once: true });
  const help = el('p', 'quiet', 'Loading available audio devicesâ€¦');
  const refresh = button('Refresh devices', async () => {
    refresh.disabled = true;
    try {
      const permission = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      permission.getTracks().forEach((track) => track.stop());
      await loadDevices();
    } catch (error) {
      showError(error);
    } finally {
      refresh.disabled = false;
    }
  });
  const save = el('button', 'button primary', 'Save voice settings');
  save.type = 'submit';

  const fill = (
    select: HTMLSelectElement,
    devices: MediaDeviceInfo[],
    selected: string,
    fallback: string,
  ) => {
    select.replaceChildren();
    const defaultOption = el('option');
    defaultOption.value = '';
    defaultOption.textContent = fallback;
    select.append(defaultOption);
    devices.forEach((device, index) => {
      const option = el('option');
      option.value = device.deviceId;
      option.textContent = device.label || `${fallback} ${index + 1}`;
      select.append(option);
    });
    if (selected && !devices.some((device) => device.deviceId === selected)) {
      const unavailable = el('option');
      unavailable.value = selected;
      unavailable.textContent = 'Previously selected device (unavailable)';
      select.append(unavailable);
    }
    select.value = selected;
  };

  const loadDevices = async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error('Audio device selection is unavailable in this window.');
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter((device) => device.kind === 'audioinput');
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    for (const [key, toggle] of processingInputs)
      toggle.disabled = supported[key] === false;
    fill(inputSelect, inputs, audioInputId, 'Windows default microphone');
    fill(outputSelect, outputs, audioOutputId, 'Windows default speaker');
    outputSelect.disabled = !supportsAudioOutputSelection();
    if (outputSelect.disabled) outputSelect.value = '';
    help.textContent = supportsAudioOutputSelection()
      ? inputs.some((device) => device.label)
        ? 'Tiny remembers these choices on this PC.'
        : 'Use Refresh devices to allow access and show device names.'
      : 'This browser does not support speaker selection; Windows default output will be used.';
  };

  inputLabel.append(inputSelect);
  outputLabel.append(outputSelect);
  form.append(
    inputLabel,
    outputLabel,
    outputVolumeLabel,
    processingBox,
    meterLabel,
    monitorRow,
    testButton,
    help,
    refresh,
    save,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      const nextProcessing: AudioProcessing = {
        noiseSuppression: processingInputs.get('noiseSuppression')!.checked,
        echoCancellation: processingInputs.get('echoCancellation')!.checked,
        autoGainControl: processingInputs.get('autoGainControl')!.checked,
      };
      await calls.setAudioProcessing(nextProcessing, false);
      if (!(await calls.setAudioInput(inputSelect.value))) return;
      audioInputId = inputSelect.value;
      localStorage.setItem(audioInputKey, audioInputId);
      await selectAudioOutput(outputSelect.value);
      audioSettings = {
        ...nextProcessing,
        outputVolume: Number(outputVolume.value) / 100,
      };
      localStorage.setItem(audioSettingsKey, JSON.stringify(audioSettings));
      await Promise.all([...mediaNodes.values()].map(applyAudioOutput));
      stopTest();
      close();
    } catch (error) {
      if (!(error instanceof DOMException)) showError(error);
    } finally {
      save.disabled = false;
    }
  });
  body.append(
    account,
    appearance,
    copy,
    form,
    button('Check for updates', () => checkForUpdates(), 'text-button'),
    button('Sign out', () => signOut(), 'text-button danger'),
  );
  void loadDevices().catch(showError);
}

function renderCall(): void {
  if (deferPaint()) return;
  const maybePanel = document.querySelector<HTMLElement>('#call-panel');
  if (!maybePanel || !data) return;
  const panel: HTMLElement = maybePanel;
  const state = calls.state;
  panel.hidden = !state.conversationId && !state.joining;
  renderHeader();
  if (panel.hidden) {
    panel.replaceChildren();
    for (const node of mediaNodes.values()) {
      node.srcObject = null;
      node.remove();
    }
    mediaNodes.clear();
    return;
  }
  let controls = panel.querySelector('.call-controls');
  if (!controls) {
    controls = el('div', 'call-controls');
    panel.append(controls);
  }
  controls.replaceChildren();
  const conversation = data.conversations.find(
    (c) => c.id === state.conversationId,
  );
  const title = el('div', 'call-info');
  title.append(
    el(
      'strong',
      '',
      state.joining
        ? 'Opening your microphone…'
        : `In a call · ${conversation ? conversationTitle(conversation) : 'Friends'}`,
    ),
    el(
      'span',
      'quiet',
      state.sharing
        ? 'Your screen is being shared.'
        : `${state.peers.length + 1} ${state.peers.length === 0 ? 'person' : 'people'} · ${state.muted ? 'microphone muted' : 'microphone on'}`,
    ),
  );
  controls.append(title);
  controls.append(
    button(
      state.muted ? 'Unmute' : 'Mute',
      () => calls.toggleMute(),
      'button small-button',
    ),
  );
  controls.append(
    button(
      state.deafened ? 'Undeafen' : 'Deafen',
      () => calls.toggleDeafen(),
      'button small-button',
    ),
  );
  controls.append(
    state.sharing
      ? button('Stop sharing', () => calls.stopSharing(), 'button stop-share')
      : button(
          'Share screen',
          () => calls.shareScreen(),
          'button small-button',
        ),
  );
  for (const control of controls.querySelectorAll('button'))
    control.disabled = state.joining;
  controls.append(button('Leave call', () => calls.leave(), 'button danger'));
  const participants = el('div', 'call-participants');
  participants.append(el('span', '', 'You'));
  for (const peer of state.peers)
    participants.append(
      el('span', '', userById(peer.userId)?.displayName || 'Friend'),
    );
  panel.querySelector('.call-participants')?.remove();
  panel.append(participants);
  panel.querySelector('.call-diagnostics')?.remove();
  if (state.peers.length) {
    const diagnostics = el('details', 'call-diagnostics');
    diagnostics.append(el('summary', '', 'Connection details'));
    for (const peer of state.peers)
      diagnostics.append(
        el(
          'p',
          'quiet',
          `${userById(peer.userId)?.displayName || 'Friend'}: ${peer.route} · ICE ${peer.iceState}`,
        ),
      );
    panel.append(diagnostics);
  }
  let media = panel.querySelector<HTMLElement>('.call-media');
  if (!media) {
    media = el('div', 'call-media');
    panel.append(media);
  }
  const wanted = new Set<string>();
  function attach(
    key: string,
    stream: MediaStream,
    video: boolean,
    local = false,
  ): void {
    wanted.add(key);
    let node = mediaNodes.get(key);
    if (!node) {
      node = el(video ? 'video' : 'audio');
      node.autoplay = true;
      if (video) {
        (node as HTMLVideoElement).playsInline = true;
        node.controls = true;
      }
      node.muted = local;
      mediaNodes.set(key, node);
      media!.append(node);
      if (!video && !local) void applyAudioOutput(node).catch(showError);
    }
    if (node.srcObject !== stream) {
      node.srcObject = stream;
      void node.play().catch(() => {
        if (!panel.querySelector('.enable-playback'))
          panel.append(
            button(
              'Enable call playback',
              async () => {
                await Promise.all(
                  [...mediaNodes.values()].map((n) => n.play()),
                );
                panel.querySelector('.enable-playback')?.remove();
              },
              'button enable-playback',
            ),
          );
      });
    }
    if (!video && !local) node.muted = state.deafened;
  }
  if (state.localScreen) attach('local-screen', state.localScreen, true, true);
  for (const peer of state.peers) {
    if (peer.audio) attach(`audio:${peer.peerId}`, peer.audio, false);
    if (peer.screen) attach(`screen:${peer.peerId}`, peer.screen, true);
  }
  for (const [key, node] of mediaNodes)
    if (!wanted.has(key)) {
      node.srcObject = null;
      node.remove();
      mediaNodes.delete(key);
    }
}

window.addEventListener('beforeunload', () => {
  activity.dispose();
  calls.destroy();
});
async function bootstrap(): Promise<void> {
  if (!token) {
    renderLogin();
    return;
  }
  renderStartup();
  try {
    const [iceServers, initialData] = await Promise.all([
      refreshIce(),
      api<State>('/api/state'),
    ]);
    calls.configure(iceServers, forceRelayTest);
    await enterApp(initialData);
  } catch (error) {
    if ((error as Error & { status?: number }).status === 401) {
      tokenStorage.removeItem(`tiny.token:${serverUrl}`);
      token = '';
      renderLogin();
      return;
    }
    renderStartup(
      'Tinycord could not connect',
      error instanceof Error ? error.message : 'Check your connection.',
      () => void bootstrap(),
    );
  }
}
void bootstrap();
startUpdater({
  busy: () =>
    calls.state.joining ||
    Boolean(calls.state.conversationId) ||
    sending ||
    Boolean(currentDraft.trim()) ||
    [...drafts.values()].some((draft) => Boolean(draft.trim())),
});
