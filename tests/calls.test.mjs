import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(
  new URL('../src/calls.ts', import.meta.url),
  'utf8',
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
  },
});
const { TinyCalls } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

function track(kind = 'audio') {
  return {
    kind,
    enabled: true,
    stopped: false,
    onended: null,
    stop() {
      this.stopped = true;
    },
  };
}

function stream(item) {
  return {
    getTracks: () => [item],
    getAudioTracks: () => (item.kind === 'audio' ? [item] : []),
    getVideoTracks: () => (item.kind === 'video' ? [item] : []),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(t, devices = {}, peerConnection = class {}) {
  const oldMediaStream = Object.getOwnPropertyDescriptor(
    globalThis,
    'MediaStream',
  );
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const oldRTC = Object.getOwnPropertyDescriptor(
    globalThis,
    'RTCPeerConnection',
  );
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: devices },
  });
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    value: peerConnection,
  });
  const sent = [];
  const errors = [];
  const calls = new TinyCalls({
    send: (data) => sent.push(data),
    onChange() {},
    onError: (message) => errors.push(message),
  });
  Object.defineProperty(globalThis, 'MediaStream', {
    configurable: true,
    value: class {
      constructor(tracks = []) {
        this.tracks = tracks;
      }
      getTracks() {
        return this.tracks;
      }
      getVideoTracks() {
        return this.tracks.filter((item) => item.kind === 'video');
      }
      getAudioTracks() {
        return this.tracks.filter((item) => item.kind === 'audio');
      }
    },
  });
  t.after(() => {
    calls.destroy();
    if (oldMediaStream)
      Object.defineProperty(globalThis, 'MediaStream', oldMediaStream);
    else delete globalThis.MediaStream;
    if (oldNavigator)
      Object.defineProperty(globalThis, 'navigator', oldNavigator);
    else delete globalThis.navigator;
    if (oldRTC) Object.defineProperty(globalThis, 'RTCPeerConnection', oldRTC);
    else delete globalThis.RTCPeerConnection;
  });
  return { calls, sent, errors };
}

test('leaving while microphone permission is pending stops the late stream and never joins', async (t) => {
  const capture = deferred();
  const microphone = track();
  const { calls, sent } = fixture(t, { getUserMedia: () => capture.promise });
  const pending = calls.join('room-1');
  calls.leave();
  capture.resolve(stream(microphone));
  await pending;
  assert.equal(microphone.stopped, true);
  assert.equal(calls.state.conversationId, null);
  assert.equal(
    sent.some((event) => event.type === 'call:join'),
    false,
  );
});

test('mute controls the real microphone track and leaving releases it', async (t) => {
  const microphone = track();
  const { calls, sent } = fixture(t, {
    getUserMedia: async () => stream(microphone),
  });
  await calls.join('room-1');
  assert.equal(sent.at(-1).type, 'call:join');
  await calls.handle({
    type: 'call:joined',
    conversationId: 'room-1',
    peers: [],
  });
  assert.equal(calls.state.joining, false);
  calls.toggleMute();
  assert.equal(microphone.enabled, false);
  calls.toggleMute();
  assert.equal(microphone.enabled, true);
  calls.toggleDeafen();
  assert.equal(calls.state.deafened, true);
  calls.leave();
  assert.equal(microphone.stopped, true);
  assert.equal(calls.state.deafened, false);
  assert.equal(sent.at(-1).type, 'call:leave');
});

test('selected voice input is used when joining a call', async (t) => {
  const microphone = track();
  let constraints;
  const { calls } = fixture(t, {
    getUserMedia: async (requested) => {
      constraints = requested;
      return stream(microphone);
    },
  });
  assert.equal(await calls.setAudioInput('usb-headset-mic'), true);
  await calls.join('room-1');
  assert.deepEqual(constraints.audio.deviceId, { exact: 'usb-headset-mic' });
  assert.equal(constraints.audio.echoCancellation, true);
  assert.equal(constraints.audio.noiseSuppression, true);
});

test('permission denial clears joining state and presents an actionable error', async (t) => {
  const { calls, sent, errors } = fixture(t, {
    getUserMedia: async () => {
      throw new DOMException('Denied', 'NotAllowedError');
    },
  });
  await calls.join('room-1');
  assert.equal(calls.state.joining, false);
  assert.equal(calls.state.conversationId, null);
  assert.equal(
    sent.some((event) => event.type === 'call:join'),
    false,
  );
  assert.match(errors[0], /permission was denied/i);
});

test('server rejection releases microphone capture', async (t) => {
  const microphone = track();
  const { calls, errors } = fixture(t, {
    getUserMedia: async () => stream(microphone),
  });
  await calls.join('room-1');
  await calls.handle({ type: 'error', message: 'This call is full.' });
  assert.equal(microphone.stopped, true);
  assert.equal(calls.state.conversationId, null);
  assert.deepEqual(errors, ['This call is full.']);
});

test('stop sharing ends the captured video track and clears the local preview', async (t) => {
  const microphone = track();
  const screen = track('video');
  const { calls } = fixture(t, {
    getUserMedia: async () => stream(microphone),
    getDisplayMedia: async () => stream(screen),
  });
  await calls.join('room-1');
  await calls.handle({
    type: 'call:joined',
    conversationId: 'room-1',
    peers: [],
  });
  await calls.shareScreen();
  assert.equal(calls.state.sharing, true);
  assert.equal(calls.state.localScreen.getVideoTracks()[0], screen);
  calls.stopSharing();
  assert.equal(screen.stopped, true);
  assert.equal(calls.state.sharing, false);
  assert.equal(calls.state.localScreen, null);
});

test('leaving while the screen picker is pending releases any late screen capture', async (t) => {
  const capture = deferred();
  const microphone = track();
  const screen = track('video');
  const { calls } = fixture(t, {
    getUserMedia: async () => stream(microphone),
    getDisplayMedia: () => capture.promise,
  });
  await calls.join('room-1');
  await calls.handle({
    type: 'call:joined',
    conversationId: 'room-1',
    peers: [],
  });
  const pending = calls.shareScreen();
  calls.leave();
  capture.resolve(stream(screen));
  await pending;
  assert.equal(screen.stopped, true);
  assert.equal(calls.state.localScreen, null);
  assert.equal(calls.state.sharing, false);
});

function fakePeerConnections() {
  const connections = [];
  class PeerConnection {
    signalingState = 'stable';
    connectionState = 'new';
    iceConnectionState = 'new';
    remoteDescription = null;
    localDescription = null;
    addedCandidates = [];
    restartCount = 0;
    replacements = [];
    messages = [];
    audioSender = {
      track: null,
      replaceTrack: async (track) => {
        this.audioSender.track = track;
      },
    };
    sender = {
      track: null,
      replaceTrack: async (track) => {
        this.sender.track = track;
        this.replacements.push(track);
      },
      getParameters: () => ({ encodings: [] }),
    };
    channel = {
      readyState: 'connecting',
      send: (data) => this.messages.push(JSON.parse(data)),
      close: () => {
        this.channel.readyState = 'closed';
      },
    };
    constructor() {
      connections.push(this);
    }
    addTrack(track) {
      this.audio = track;
      this.audioSender.track = track;
      return this.audioSender;
    }
    getSenders() {
      return [this.audioSender, this.sender];
    }
    addTransceiver() {
      return { sender: this.sender };
    }
    createDataChannel() {
      return this.channel;
    }
    async setRemoteDescription(description) {
      this.remoteDescription = description;
    }
    async addIceCandidate(candidate) {
      this.addedCandidates.push(candidate);
    }
    async setLocalDescription() {
      this.localDescription = {
        type: this.remoteDescription?.type === 'offer' ? 'answer' : 'offer',
        sdp: 'test-sdp',
        toJSON() {
          return { type: this.type, sdp: this.sdp };
        },
      };
    }
    restartIce() {
      this.restartCount++;
    }
    async getStats() {
      return new Map();
    }
    close() {
      this.signalingState = 'closed';
    }
  }
  return { connections, PeerConnection };
}

test('ICE candidates arriving before the remote offer are queued and then applied', async (t) => {
  const microphone = track();
  const { connections, PeerConnection } = fakePeerConnections();
  const { calls, sent, errors } = fixture(
    t,
    { getUserMedia: async () => stream(microphone) },
    PeerConnection,
  );
  await joinWithPeer(calls);
  await calls.handle({
    type: 'signal',
    conversationId: 'room-1',
    from: 'remote',
    candidate: { candidate: 'candidate:early', sdpMLineIndex: 0 },
  });
  assert.equal(connections[0].addedCandidates.length, 0);
  await calls.handle({
    type: 'signal',
    conversationId: 'room-1',
    from: 'remote',
    description: { type: 'offer', sdp: 'remote-offer' },
  });
  assert.deepEqual(connections[0].addedCandidates, [
    { candidate: 'candidate:early', sdpMLineIndex: 0 },
  ]);
  assert.equal(sent.at(-1).description.type, 'answer');
  assert.deepEqual(errors, []);
});

test('a failed ICE route triggers a bounded ICE restart', async (t) => {
  const microphone = track();
  const { connections, PeerConnection } = fakePeerConnections();
  const { calls } = fixture(
    t,
    { getUserMedia: async () => stream(microphone) },
    PeerConnection,
  );
  await calls.handle({ type: 'ready', peerId: 'local' });
  await calls.join('room-1');
  await calls.handle({
    type: 'call:joined',
    conversationId: 'room-1',
    peers: [{ peerId: 'remote', userId: 'remote' }],
  });
  const peer = connections[0];
  peer.connectionState = 'failed';
  peer.onconnectionstatechange();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(peer.restartCount, 1);
  assert.match(calls.state.peers[0].route, /Retrying/);
});

async function joinWithPeer(calls, peerId = 'remote') {
  await calls.handle({ type: 'ready', peerId: 'local' });
  await calls.join('room-1');
  await calls.handle({
    type: 'call:joined',
    conversationId: 'room-1',
    peers: [],
  });
  await calls.handle({
    type: 'call:peer-joined',
    conversationId: 'room-1',
    peerId,
    userId: peerId,
  });
}

test('changing voice input during a call replaces the live sender', async (t) => {
  const original = track();
  const replacement = track();
  let captures = 0;
  const { connections, PeerConnection } = fakePeerConnections();
  const { calls } = fixture(
    t,
    {
      getUserMedia: async () =>
        stream(captures++ === 0 ? original : replacement),
    },
    PeerConnection,
  );
  await joinWithPeer(calls);
  assert.equal(await calls.setAudioInput('headset-microphone'), true);
  assert.equal(connections[0].audioSender.track, replacement);
  assert.equal(original.stopped, true);
  assert.equal(replacement.stopped, false);
});

async function flushVideoChanges() {
  // Track updates use a promise queue, never a background timer.
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('background video preference is sent on channel open and focus changes without muting audio', async (t) => {
  const microphone = track();
  const { connections, PeerConnection } = fakePeerConnections();
  const { calls } = fixture(
    t,
    { getUserMedia: async () => stream(microphone) },
    PeerConnection,
  );
  calls.setBackgrounded(true);
  await joinWithPeer(calls);
  const peer = connections[0];
  peer.channel.readyState = 'open';
  peer.channel.onopen();
  assert.deepEqual(peer.messages, [
    { sharing: false },
    { receiveVideo: false },
  ]);
  calls.setBackgrounded(true);
  assert.equal(peer.messages.length, 2);
  calls.setBackgrounded(false);
  assert.deepEqual(peer.messages.at(-1), { receiveVideo: true });
  assert.equal(microphone.enabled, true);
  assert.equal(microphone.stopped, false);
  assert.equal(calls.state.conversationId, 'room-1');
});

test('a recipient background preference pauses only its video sender and survives re-sharing', async (t) => {
  const microphone = track();
  const screens = [track('video'), track('video')];
  let captureIndex = 0;
  const { connections, PeerConnection } = fakePeerConnections();
  const { calls } = fixture(
    t,
    {
      getUserMedia: async () => stream(microphone),
      getDisplayMedia: async () => stream(screens[captureIndex++]),
    },
    PeerConnection,
  );
  await joinWithPeer(calls);
  await calls.handle({
    type: 'call:peer-joined',
    conversationId: 'room-1',
    peerId: 'other',
    userId: 'other',
  });
  const [background, foreground] = connections;
  for (const peer of connections) {
    peer.channel.readyState = 'open';
    peer.channel.onopen();
  }
  background.channel.onmessage({
    data: JSON.stringify({ receiveVideo: false }),
  });
  await calls.shareScreen();
  assert.equal(background.sender.track, null);
  assert.equal(foreground.sender.track, screens[0]);
  assert.equal(screens[0].stopped, false);
  assert.equal(microphone.enabled, true);
  assert.equal(microphone.stopped, false);
  assert.deepEqual(background.messages.at(-1), { sharing: true });

  background.channel.onmessage({
    data: JSON.stringify({ receiveVideo: true }),
  });
  await flushVideoChanges();
  assert.equal(background.sender.track, screens[0]);
  background.channel.onmessage({
    data: JSON.stringify({ receiveVideo: false }),
  });
  calls.stopSharing();
  await calls.shareScreen();
  assert.equal(background.sender.track, null);
  assert.equal(foreground.sender.track, screens[1]);
  assert.equal(screens[0].stopped, true);
  assert.equal(screens[1].stopped, false);
  assert.equal(calls.state.sharing, true);

  background.channel.onmessage({
    data: JSON.stringify({ receiveVideo: true }),
  });
  await flushVideoChanges();
  assert.equal(background.sender.track, screens[1]);
  assert.equal(microphone.enabled, true);
});
