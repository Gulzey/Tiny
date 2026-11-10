import './style.css';
import { TinyCalls } from './calls';
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
};
type Message = {
  id: number;
  conversationId: string;
  senderId: string;
  body: string;
  createdAt: string;
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
let audioInputId = localStorage.getItem(audioInputKey) || '';
let audioOutputId = localStorage.getItem(audioOutputKey) || '';
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
    throw new Error(
      result.error || result.message || `Request failed (${response.status}).`,
    );
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
  password.field.required = true;
  password.field.autocomplete = authCreate
    ? 'new-password'
    : 'current-password';
  password.field.minLength = authCreate ? 12 : 8;
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
async function enterApp(): Promise<void> {
  destroyed = false;
  data = await api<State>('/api/state');
  renderApp();
  connect();
}
function renderApp(): void {
  forcePaint = true;
  root.replaceChildren();
  const shell = el('main', 'app-shell');
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
  shell.append(sidebar, main);
  const notices = el('div', 'notices');
  notices.id = 'notices';
  root.append(shell, notices);
  renderSidebar();
  renderHeader();
  renderMessages();
  renderComposer();
  renderCall();
  forcePaint = false;
  if (!activity.active) syncBackgroundMedia(false);
}
function renderSidebar(): void {
  if (deferPaint()) return;
  const sidebar = document.querySelector('#sidebar');
  if (!sidebar || !data) return;
  sidebar.replaceChildren();
  const top = el('div', 'sidebar-top');
  top.append(brand());
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
  profile.append(avatar(data.user), name, el('span', 'profile-edit', 'Edit'));
  profile.setAttribute('aria-label', 'Edit profile');
  sidebar.append(top, profile);
  const chatHeading = el('div', 'list-heading');
  chatHeading.append(
    el('h2', '', 'Conversations'),
    button('New chat', openNewChat, 'text-button'),
  );
  sidebar.append(chatHeading);
  const chats = el('nav', 'chat-list');
  chats.setAttribute('aria-label', 'Conversations');
  for (const conversation of [...data.conversations].sort((a, b) =>
    String(b.lastMessage?.createdAt || '').localeCompare(
      String(a.lastMessage?.createdAt || ''),
    ),
  )) {
    const row = button(
      '',
      () => selectConversation(conversation.id),
      `chat-row ${selected === conversation.id ? 'selected' : ''}`,
    );
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
    const presence = el(
      'span',
      `presence ${online.has(friend.id) ? 'online' : ''}`,
    );
    presence.title = online.has(friend.id) ? 'Online' : 'Offline';
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
  bottom.append(
    createThemeToggle(),
    button('Settings', openSettings, 'text-button'),
    button('Check updates', () => checkForUpdates(), 'text-button'),
    button('Sign out', () => signOut(), 'text-button'),
  );
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
  header.append(copy);
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
}
async function joinCall(conversationId: string): Promise<void> {
  calls.configure(await refreshIce(), forceRelayTest);
  await calls.join(conversationId);
}
async function selectConversation(id: string): Promise<void> {
  if (selected) drafts.set(selected, currentDraft);
  selected = id;
  currentDraft = drafts.get(id) || '';
  messages = [];
  hasMore = false;
  renderSidebar();
  renderHeader();
  renderMessages(true);
  renderComposer();
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
  for (const message of messages) {
    const user = userById(message.senderId);
    const row = el(
      'article',
      `message ${message.senderId === data.user.id ? 'own' : ''}`,
    );
    row.dataset.messageId = String(message.id);
    if (user) row.append(avatar(user, 'small'));
    const content = el('div', 'message-content');
    const meta = el('div', 'message-meta');
    const date = new Date(message.createdAt);
    const time = el(
      'time',
      '',
      Number.isNaN(date.valueOf())
        ? ''
        : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    );
    time.dateTime = message.createdAt;
    time.title = date.toLocaleString();
    meta.append(el('strong', '', user?.displayName || 'Friend'), time);
    content.append(meta, el('p', 'message-body', message.body));
    row.append(content);
    log.append(row);
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
  textarea.addEventListener('input', () => {
    currentDraft = textarea.value;
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
      if (selected) void selectConversation(selected).catch(showError);
    }
    if (packet.type === 'state') void refreshState().catch(showError);
    if (packet.type === 'message') receiveMessage(packet.message);
    if (packet.type === 'presence') {
      online = new Set(packet.userIds);
      renderSidebar();
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
  let image: string | null | undefined;
  let readingAvatar = false;
  file.field.addEventListener('change', async () => {
    const selectedFile = file.field.files?.[0];
    if (!selectedFile) return;
    if (
      !['image/png', 'image/jpeg', 'image/gif'].includes(selectedFile.type) ||
      selectedFile.size > 2 * 1024 * 1024
    ) {
      file.field.value = '';
      showError('Choose a PNG, JPEG, or GIF picture up to 2 MB.');
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
    preview,
    display.wrapper,
    file.wrapper,
    el(
      'p',
      'quiet',
      'PNG, JPEG, or GIF · up to 2 MB. Animated GIFs are supported.',
    ),
    remove,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (readingAvatar) return;
    submit.disabled = true;
    try {
      await api('/api/me', 'PATCH', {
        displayName: display.field.value.trim(),
        ...(image === undefined ? {} : { avatar: image }),
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
  const { body, close } = modal('Settings');
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
  form.append(inputLabel, outputLabel, help, refresh, save);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      if (!(await calls.setAudioInput(inputSelect.value))) return;
      audioInputId = inputSelect.value;
      localStorage.setItem(audioInputKey, audioInputId);
      await selectAudioOutput(outputSelect.value);
      close();
    } catch (error) {
      if (!(error instanceof DOMException)) showError(error);
    } finally {
      save.disabled = false;
    }
  });
  body.append(copy, form);
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
  renderLogin();
  if (!token) return;
  try {
    await api('/api/config');
    calls.configure(await refreshIce(), forceRelayTest);
    await enterApp();
  } catch (error) {
    showError(error);
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
