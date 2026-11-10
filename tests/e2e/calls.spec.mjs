import { test, expect } from '@playwright/test';

const server = 'http://127.0.0.1:8878';
test('denied microphone permission leaves no active call', async ({ page }) => {
  await page.goto('/tests/e2e/harness.html');
  const result = await page.evaluate(async () => {
    const { TinyCalls } = await import('/src/calls.ts');
    const sent = [];
    const errors = [];
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied for test', 'NotAllowedError');
    };
    const calls = new TinyCalls({
      send: (data) => sent.push(data),
      onChange: () => {},
      onError: (error) => errors.push(error),
    });
    await calls.join('permission-test');
    const state = calls.state;
    calls.destroy();
    return {
      errors,
      sent,
      conversationId: state.conversationId,
      joining: state.joining,
    };
  });
  expect(result.errors.join(' ')).toMatch(/microphone|permission/i);
  expect(result.sent.some((frame) => frame.type === 'call:join')).toBe(false);
  expect(result.conversationId).toBeNull();
  expect(result.joining).toBe(false);
});
test('three real WebRTC peers exchange audio, share a screen, stop, and release devices', async ({
  browser,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const accounts = [];
  for (let i = 0; i < 3; i++) {
    const result = await request.post(`${server}/api/auth/local`, {
      data: {
        handle: `rtc${i}_${suffix}`,
        password: 'test-password',
        create: true,
      },
    });
    expect(result.ok()).toBeTruthy();
    accounts.push(await result.json());
  }
  const auth = (i) => ({ Authorization: `Bearer ${accounts[i].token}` });
  for (let i = 1; i < 3; i++) {
    expect(
      (
        await request.post(`${server}/api/friends`, {
          headers: auth(0),
          data: { handle: accounts[i].user.handle },
        })
      ).ok(),
    ).toBeTruthy();
  }
  const roomResponse = await request.post(`${server}/api/conversations`, {
    headers: auth(0),
    data: {
      memberIds: accounts.slice(1).map((a) => a.user.id),
      title: 'Call test',
    },
  });
  expect(roomResponse.ok()).toBeTruthy();
  const room = await roomResponse.json();
  const contexts = await Promise.all(accounts.map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  try {
    for (let i = 0; i < pages.length; i++) {
      await pages[i].addInitScript(() => {
        const NativePeer = window.RTCPeerConnection;
        window.testConnections = [];
        window.RTCPeerConnection = class extends NativePeer {
          constructor(...args) {
            super(...args);
            window.testConnections.push(this);
          }
        };
      });
      await pages[i].goto('/tests/e2e/harness.html');
      await pages[i].evaluate(
        async ({ token }) => {
          const { TinyCalls } = await import('/src/calls.ts');
          window.callErrors = [];
          const socket = new WebSocket('ws://127.0.0.1:8878/ws');
          window.testSocket = socket;
          window.testCalls = new TinyCalls({
            send: (data) => socket.send(JSON.stringify(data)),
            onChange: () => {},
            onError: (error) => window.callErrors.push(error),
          });
          window.testCalls.configure([]);
          await new Promise((resolve, reject) => {
            socket.onopen = () =>
              socket.send(JSON.stringify({ type: 'auth', token }));
            socket.onerror = reject;
            socket.onmessage = (event) => {
              const data = JSON.parse(event.data);
              window.testCalls.handle(data);
              if (data.type === 'ready') resolve();
            };
          });
          const share = document.createElement('button');
          share.id = 'test-share';
          share.textContent = 'Test screen sharing';
          share.onclick = () => window.testCalls.shareScreen();
          document.body.append(share);
        },
        { token: accounts[i].token },
      );
      await pages[i].evaluate((id) => window.testCalls.join(id), room.id);
      await expect
        .poll(() => pages[i].evaluate(() => window.testCalls.state.joining))
        .toBe(false);
    }
    for (const page of pages) {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.testCalls.state.peers.filter(
                (p) =>
                  p.state === 'connected' && p.audio?.getAudioTracks().length,
              ).length,
          ),
        )
        .toBe(2);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const reports = await Promise.all(
              window.testConnections.map((pc) => pc.getStats()),
            );
            return reports.filter((report) =>
              [...report.values()].some(
                (s) =>
                  s.type === 'inbound-rtp' &&
                  s.kind === 'audio' &&
                  s.packetsReceived > 0,
              ),
            ).length;
          }),
        )
        .toBe(2);
      expect(await page.evaluate(() => window.callErrors)).toEqual([]);
    }
    await pages[0].evaluate(() => window.testCalls.toggleMute());
    expect(await pages[0].evaluate(() => window.testCalls.state.muted)).toBe(
      true,
    );
    await pages[0].evaluate(() => window.testCalls.toggleMute());
    await pages[0].click('#test-share');
    await expect
      .poll(() => pages[0].evaluate(() => window.testCalls.state.sharing))
      .toBe(true);
    for (const page of pages.slice(1)) {
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.testCalls.state.peers.filter((p) =>
                p.screen
                  ?.getVideoTracks()
                  .some((t) => !t.muted && t.readyState === 'live'),
              ).length,
          ),
        )
        .toBe(1);
      await expect
        .poll(() =>
          page.evaluate(async () => {
            const reports = await Promise.all(
              window.testConnections.map((pc) => pc.getStats()),
            );
            return reports.some((report) =>
              [...report.values()].some(
                (s) =>
                  s.type === 'inbound-rtp' &&
                  s.kind === 'video' &&
                  s.bytesReceived > 0,
              ),
            );
          }),
        )
        .toBe(true);
    }
    // A player tabbing into a game should keep audio without receiving screen video.
    await pages[1].evaluate(() => window.testCalls.setBackgrounded(true));
    await expect
      .poll(() =>
        pages[0].evaluate(
          () =>
            window.testConnections.filter((pc) =>
              pc.getSenders().some((sender) => sender.track?.kind === 'video'),
            ).length,
        ),
      )
      .toBe(1);
    const audioBefore = await pages[1].evaluate(async () => {
      const reports = await Promise.all(
        window.testConnections.map((pc) => pc.getStats()),
      );
      return reports.reduce(
        (total, report) =>
          total +
          [...report.values()]
            .filter((s) => s.type === 'inbound-rtp' && s.kind === 'audio')
            .reduce((n, s) => n + (s.packetsReceived || 0), 0),
        0,
      );
    });
    await expect
      .poll(() =>
        pages[1].evaluate(async () => {
          const reports = await Promise.all(
            window.testConnections.map((pc) => pc.getStats()),
          );
          return reports.reduce(
            (total, report) =>
              total +
              [...report.values()]
                .filter((s) => s.type === 'inbound-rtp' && s.kind === 'audio')
                .reduce((n, s) => n + (s.packetsReceived || 0), 0),
            0,
          );
        }),
      )
      .toBeGreaterThan(audioBefore);
    await pages[1].evaluate(() => window.testCalls.setBackgrounded(false));
    await expect
      .poll(() =>
        pages[0].evaluate(
          () =>
            window.testConnections.filter((pc) =>
              pc.getSenders().some((sender) => sender.track?.kind === 'video'),
            ).length,
        ),
      )
      .toBe(2);
    await pages[0].evaluate(() => {
      window.sharedTracks = window.testCalls.state.localScreen.getTracks();
      window.testCalls.stopSharing();
    });
    await expect
      .poll(() => pages[0].evaluate(() => window.testCalls.state.sharing))
      .toBe(false);
    expect(
      await pages[0].evaluate(() =>
        window.sharedTracks.every((t) => t.readyState === 'ended'),
      ),
    ).toBe(true);
    for (const page of pages)
      await page.evaluate(() => window.testCalls.leave());
    for (const page of pages) {
      expect(
        await page.evaluate(() => window.testCalls.state.conversationId),
      ).toBeNull();
      expect(
        await page.evaluate(() => window.testCalls.state.peers.length),
      ).toBe(0);
    }
  } finally {
    for (const context of contexts) await context.close();
  }
});
