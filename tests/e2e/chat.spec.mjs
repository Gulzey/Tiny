import { test, expect } from '@playwright/test';

const server = 'http://127.0.0.1:8878';
const password = 'test-password';

test('create a local account, sign out, and sign back in', async ({ page }) => {
  const handle = `sam_${Date.now().toString(36)}`;
  await page.goto('/');
  await expect(page.getByLabel('Server URL', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /New to Tiny/ }).click();
  await expect(page.getByLabel('Server URL', { exact: true })).toHaveCount(0);
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Display name', { exact: true }).fill('Sam');
  await page
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toContainText('Sam');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByLabel('Voice input')).toBeVisible();
  await expect(settings.getByLabel('Voice output')).toBeVisible();
  await settings
    .getByRole('button', { name: 'Save voice settings', exact: true })
    .click();
  await expect(settings).not.toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Handle', { exact: true }).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Edit profile' }),
  ).toContainText('Sam');
});

async function login(page, handle) {
  // Each context represents a different PC with its own foreground app.
  const focus = await page.context().newCDPSession(page);
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto('/');
  await page.getByLabel(/^handle/i).fill(handle);
  await page.getByLabel(/^password/i).fill(password);
  await page.getByRole('button', { name: /^sign in/i }).click();
  await expect(page.getByRole('button', { name: /add friend/i })).toBeVisible();
}

test('friends, direct and group chats, live delivery, history, and profile updates', async ({
  browser,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const handles = [`alice_${suffix}`, `bob_${suffix}`, `charlie_${suffix}`];
  const users = [];
  for (const handle of handles) {
    const response = await request.post(`${server}/api/auth/local`, {
      data: { handle, password, create: true },
    });
    expect(response.ok()).toBeTruthy();
    users.push(await response.json());
  }
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const alice = await contextA.newPage();
  const bob = await contextB.newPage();
  try {
    await login(alice, handles[0]);
    await login(bob, handles[1]);
    await alice.getByRole('button', { name: /add friend/i }).click();
    await alice
      .getByRole('dialog')
      .getByLabel(/handle/i)
      .fill(handles[1]);
    await alice
      .getByRole('dialog')
      .getByRole('button', { name: /send request/i })
      .click();
    await expect(alice.getByRole('dialog')).not.toBeVisible();
    await bob.getByRole('button', { name: /Requests · 1 new/i }).click();
    await bob
      .getByRole('dialog')
      .getByRole('button', { name: 'Accept', exact: true })
      .click();
    await expect(
      bob.getByText(handles[0], { exact: true }).first(),
    ).toBeVisible();
    // Clicking a friend starts or opens its persistent direct conversation.
    await alice
      .getByRole('button', { name: new RegExp(handles[1]) })
      .first()
      .click();
    const text = `Hello <b>friend</b> ${suffix}`;
    await alice.getByRole('textbox', { name: /message/i }).fill(text);
    await alice.getByRole('button', { name: /^send/i }).click();
    await bob
      .getByRole('button', { name: new RegExp(handles[0]) })
      .first()
      .click();
    await expect(
      bob.getByRole('log').getByText(text, { exact: true }),
    ).toBeVisible();
    await bob
      .getByRole('textbox', { name: /message/i })
      .fill('Hello back, in real time');
    await bob.getByRole('button', { name: /^send/i }).click();
    await expect(
      alice
        .getByRole('log')
        .getByText('Hello back, in real time', { exact: true }),
    ).toBeVisible();
    expect(await bob.locator('b').filter({ hasText: 'friend' }).count()).toBe(
      0,
    );
    await bob.reload();
    await bob
      .getByRole('button', { name: new RegExp(handles[0]) })
      .first()
      .click();
    await expect(
      bob.getByRole('log').getByText(text, { exact: true }),
    ).toBeVisible();

    // Add a second friend, then create a group through the interface.
    await alice.getByRole('button', { name: /add friend/i }).click();
    await alice
      .getByRole('dialog')
      .getByLabel(/handle/i)
      .fill(handles[2]);
    await alice
      .getByRole('dialog')
      .getByRole('button', { name: /send request/i })
      .click();
    await request.patch(`${server}/api/friend-requests/${users[0].user.id}`, {
      headers: { Authorization: `Bearer ${users[2].token}` },
      data: { action: 'accept' },
    });
    await expect(
      alice.getByRole('button', { name: new RegExp(handles[2]) }).first(),
    ).toBeVisible();
    await alice.getByRole('button', { name: /new chat/i }).click();
    const dialog = alice.getByRole('dialog');
    await dialog
      .getByRole('checkbox', { name: new RegExp(handles[1]) })
      .check();
    await dialog
      .getByRole('checkbox', { name: new RegExp(handles[2]) })
      .check();
    await dialog.getByLabel(/group name/i).fill(`Garden ${suffix}`);
    await dialog.getByRole('button', { name: /create chat/i }).click();
    await expect(
      alice.getByText(`Garden ${suffix}`, { exact: true }).last(),
    ).toBeVisible();
    await alice
      .getByRole('textbox', { name: /message/i })
      .fill('A little group hello');
    await alice.getByRole('button', { name: /^send/i }).click();
    await bob
      .getByRole('button', { name: new RegExp(`Garden ${suffix}`) })
      .click();
    await expect(
      bob.getByRole('log').getByText('A little group hello', { exact: true }),
    ).toBeVisible();

    // Exercise the actual visible call controls as well as the engine fixture.
    await alice
      .getByRole('button', { name: 'Start call', exact: true })
      .click();
    await bob.getByRole('button', { name: /^Join call/ }).click();
    await expect(alice.locator('#call-panel')).toContainText('connected');
    await alice.getByRole('button', { name: 'Mute', exact: true }).click();
    await expect(
      alice.getByRole('button', { name: 'Unmute', exact: true }),
    ).toBeVisible();
    await alice
      .getByRole('button', { name: 'Share screen', exact: true })
      .click();
    await expect(
      alice.getByRole('button', { name: 'Stop sharing', exact: true }),
    ).toBeVisible();
    await expect(bob.locator('.call-media video')).toBeVisible();
    await alice
      .getByRole('button', { name: 'Stop sharing', exact: true })
      .click();
    await expect(bob.locator('.call-media video')).toHaveCount(0);
    await alice
      .getByRole('button', { name: 'Leave call', exact: true })
      .click();
    await bob.getByRole('button', { name: 'Leave call', exact: true }).click();
    await expect(alice.locator('#call-panel')).toBeHidden();

    await alice.getByRole('button', { name: /profile/i }).click();
    await alice
      .getByRole('dialog')
      .getByLabel(/display name/i)
      .fill('Alice in Tiny');
    await alice
      .getByRole('dialog')
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'tiny.gif',
        mimeType: 'image/gif',
        buffer: Buffer.from(
          'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          'base64',
        ),
      });
    await alice
      .getByRole('dialog')
      .getByRole('button', { name: /save/i })
      .click();
    await expect(
      bob.getByText('Alice in Tiny', { exact: true }).first(),
    ).toBeVisible();
    const state = await request.get(`${server}/api/state`, {
      headers: { Authorization: `Bearer ${users[0].token}` },
    });
    const stored = await state.json();
    expect(stored.user.displayName).toBe('Alice in Tiny');
    expect(stored.user.avatar).toMatch(/^data:image\/gif;base64,/);
    expect(
      stored.conversations.some((c) => c.isGroup && c.members.length === 3),
    ).toBe(true);
    await alice.screenshot({ path: 'test-results/tiny-chat.png' });
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
