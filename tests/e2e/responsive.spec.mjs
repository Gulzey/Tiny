import { test, expect } from '@playwright/test';

const api = 'http://127.0.0.1:8878';
const password = 'test-password';

async function account(request, handle) {
  const response = await request.post(`${api}/api/auth/local`, {
    data: { handle, password, create: true, displayName: handle },
  });
  return response.json();
}

async function restore(page, token) {
  await page.addInitScript(
    ({ token }) => {
      sessionStorage.setItem('tiny.token:http://127.0.0.1:8878', token);
      window.__tinySawLogin = false;
      new MutationObserver(() => {
        if (document.querySelector('.login-page')) window.__tinySawLogin = true;
      }).observe(document, { childList: true, subtree: true });
    },
    { token },
  );
}

test('valid sessions restore through the splash without flashing login', async ({
  page,
  request,
}) => {
  const user = await account(request, `restore_${Date.now().toString(36)}`);
  await restore(page, user.token);
  await page.goto('/');
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toBeVisible();
  expect(await page.evaluate(() => window.__tinySawLogin)).toBe(false);
});

test('login and registration fill the viewport without overflow', async ({
  page,
}) => {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1366, height: 768 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    const geometry = await page.evaluate(() => ({
      rootHeight: document.querySelector('#app').getBoundingClientRect().height,
      viewportHeight: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
    }));
    expect(
      Math.abs(geometry.rootHeight - geometry.viewportHeight),
    ).toBeLessThan(2);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/tiny-v04-login-mobile.png' });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.screenshot({ path: 'test-results/tiny-v04-login-desktop.png' });
});

test('mobile layout navigates from conversations to chat without overflow', async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const alice = await account(request, `mobile_a_${suffix}`);
  const bob = await account(request, `mobile_b_${suffix}`);
  await request.post(`${api}/api/friend-requests`, {
    headers: { Authorization: `Bearer ${alice.token}` },
    data: { handle: bob.user.handle },
  });
  await request.patch(`${api}/api/friend-requests/${alice.user.id}`, {
    headers: { Authorization: `Bearer ${bob.token}` },
    data: { action: 'accept' },
  });
  const room = await request.post(`${api}/api/conversations`, {
    headers: { Authorization: `Bearer ${alice.token}` },
    data: { memberIds: [bob.user.id] },
  });
  const conversation = await room.json();
  await restore(page, alice.token);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('.sidebar')).toBeVisible();
  await page
    .getByRole('button', { name: new RegExp(bob.user.displayName, 'i') })
    .first()
    .click();
  await expect(page.locator('.conversation')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.composer-host')
      .evaluate((node) =>
        Math.abs(node.getBoundingClientRect().bottom - innerHeight),
      ),
  ).toBeLessThan(2);
  await page.screenshot({ path: 'test-results/tiny-v04-chat-mobile.png' });
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(
    await page
      .locator('.composer-host')
      .evaluate((node) =>
        Math.abs(node.getBoundingClientRect().bottom - innerHeight),
      ),
  ).toBeLessThan(2);
  expect(conversation.id).toBeTruthy();
});

test('audio controls expose real device settings and saved processing options', async ({
  page,
  request,
}) => {
  const user = await account(request, `audio_${Date.now().toString(36)}`);
  await restore(page, user.token);
  await page.goto('/');
  const microphone = page.getByRole('button', { name: 'Mute microphone' });
  await microphone.click({ button: 'right' });
  await expect(page.getByRole('menu')).toContainText('Voice & Audio settings');
  await page.getByRole('menuitem', { name: /Voice & Audio settings/ }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByLabel('Noise suppression')).toBeChecked();
  await settings.getByLabel('Noise suppression').uncheck();
  await settings.getByRole('button', { name: 'Test microphone' }).click();
  await expect(
    settings.getByRole('button', { name: 'Stop microphone test' }),
  ).toBeVisible();
  await settings.getByRole('button', { name: 'Stop microphone test' }).click();
  await settings.getByRole('button', { name: 'Save voice settings' }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(
      localStorage.getItem('tiny.audio-settings:http://127.0.0.1:8878'),
    ),
  );
  expect(saved.noiseSuppression).toBe(false);
});
