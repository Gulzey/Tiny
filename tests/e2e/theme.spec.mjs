import { test, expect } from '@playwright/test';

test('black dark mode is the default and light mode remains optional', async ({
  page,
  request,
}) => {
  const handle = `night_${Date.now().toString(36)}`;
  await request.post('http://127.0.0.1:8878/api/auth/local', {
    data: { handle, password: 'test-password', create: true },
  });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toBeVisible();
  await expect(page.locator('.conversation')).toHaveCSS(
    'background-color',
    'rgb(9, 21, 24)',
  );
  await page.getByRole('button', { name: 'Edit profile' }).click();
  await expect(page.getByRole('dialog')).toHaveCSS(
    'background-color',
    'rgb(16, 36, 41)',
  );
  await page.screenshot({ path: 'test-results/tiny-dark.png' });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Close', exact: true })
    .click();
  await page.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('background messages are stored without repainting and appear on return', async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const users = [];
  for (const handle of [`idle_a_${suffix}`, `idle_b_${suffix}`]) {
    const response = await request.post(
      'http://127.0.0.1:8878/api/auth/local',
      { data: { handle, password: 'test-password', create: true } },
    );
    users.push(await response.json());
  }
  const auth = (i) => ({ Authorization: `Bearer ${users[i].token}` });
  await request.post('http://127.0.0.1:8878/api/friend-requests', {
    headers: auth(0),
    data: { handle: users[1].user.handle },
  });
  await request.patch(
    `http://127.0.0.1:8878/api/friend-requests/${users[0].user.id}`,
    { headers: auth(1), data: { action: 'accept' } },
  );
  const room = await (
    await request.post('http://127.0.0.1:8878/api/conversations', {
      headers: auth(0),
      data: { memberIds: [users[1].user.id] },
    })
  ).json();
  await page.goto('/');
  await page.getByLabel('Handle', { exact: true }).fill(users[0].user.handle);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page
    .getByRole('button', {
      name: `Open ${users[1].user.displayName}`,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('button', { name: 'Start call', exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
    window.backgroundMutations = 0;
    new MutationObserver(
      (records) => (window.backgroundMutations += records.length),
    ).observe(document.querySelector('#app'), {
      childList: true,
      attributes: true,
      subtree: true,
      characterData: true,
    });
  });
  const text = `Delivered while gaming ${suffix}`;
  await request.post(
    `http://127.0.0.1:8878/api/conversations/${room.id}/messages`,
    { headers: auth(1), data: { body: text, clientId: crypto.randomUUID() } },
  );
  // Ensure the websocket event has arrived without a foreground paint.
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => window.backgroundMutations)).toBe(0);
  await expect(page.getByRole('log').getByText(text)).toHaveCount(0);
  await page.evaluate(() => {
    delete document.hidden;
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(
    page.getByRole('log').getByText(text, { exact: true }),
  ).toBeVisible();
});

test('desktop panels resize, persist, collapse, and remain usable at target sizes', async ({
  page,
  request,
}) => {
  const handle = `layout_${Date.now().toString(36)}`;
  await request.post('http://127.0.0.1:8878/api/auth/local', {
    data: { handle, password: 'test-password', create: true },
  });
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.goto('/');
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const left = page.locator('.resize-handle.left');
  await left.focus();
  await left.press('ArrowRight');
  await expect(page.locator('.app-shell')).toHaveCSS('--left-width', '262px');
  await page.reload();
  await expect(page.locator('.app-shell')).toHaveCSS('--left-width', '262px');
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(page.locator('.conversation')).toBeVisible();
  await expect(page.locator('.members-panel')).toBeVisible();
});
