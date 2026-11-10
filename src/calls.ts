export interface CallPeer {
  peerId: string;
  userId: string;
  state: string;
  audio: MediaStream | null;
  screen: MediaStream | null;
  iceState: string;
  route: string;
}

interface Peer {
  pc: RTCPeerConnection;
  view: CallPeer;
  video: RTCRtpTransceiver;
  channel: RTCDataChannel;
  remoteVideo: MediaStream | null;
  remoteAudio: MediaStream | null;
  remoteSharing: boolean;
  wantsVideo: boolean;
  videoUpdate: Promise<void>;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  allowNegotiation: boolean;
  candidates: RTCIceCandidateInit[];
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  recoveryAttempts: number;
}

interface Options {
  send: (data: any) => void;
  onChange: () => void;
  onError: (message: string) => void;
  refreshIce?: () => Promise<RTCIceServer[]>;
}

/** One small mesh call. The server only relays signaling; media uses WebRTC. */
export class TinyCalls {
  readonly state = {
    conversationId: null as string | null,
    joining: false,
    muted: false,
    deafened: false,
    sharing: false,
    peers: [] as CallPeer[],
    localScreen: null as MediaStream | null,
  };

  private peers = new Map<string, Peer>();
  private iceServers: RTCIceServer[] = [];
  private forceRelay = false;
  private microphone: MediaStream | null = null;
  private peerId = '';
  private generation = 0;
  private sharingPending = false;
  private backgrounded = false;

  constructor(private options: Options) {}

  configure(iceServers: RTCIceServer[], forceRelay = false) {
    this.iceServers = iceServers;
    this.forceRelay = forceRelay;
    for (const peer of this.peers.values())
      peer.pc.setConfiguration({
        ...peer.pc.getConfiguration(),
        iceServers,
        iceTransportPolicy: forceRelay ? 'relay' : 'all',
      });
  }

  setBackgrounded(backgrounded: boolean) {
    if (this.backgrounded === backgrounded) return;
    this.backgrounded = backgrounded;
    for (const peer of this.peers.values()) this.notifyVideoPreference(peer);
  }

  private changed() {
    this.state.peers = [...this.peers.values()].map((peer) => peer.view);
    this.options.onChange();
  }

  private error(error: unknown, feature = 'Microphone') {
    const name = error instanceof DOMException ? error.name : '';
    const message =
      name === 'NotAllowedError' || name === 'PermissionDeniedError'
        ? `${feature} permission was denied or the picker was cancelled. Allow access in your browser or system settings, then try again.`
        : name === 'NotFoundError' || name === 'DevicesNotFoundError'
          ? `No ${feature.toLowerCase()} device is available.`
          : name === 'NotReadableError'
            ? `${feature} is busy or unavailable. Check whether another app is using it.`
            : error instanceof Error
              ? error.message
              : `${feature} is unavailable.`;
    this.options.onError(message);
  }

  async join(conversationId: string) {
    this.leave();
    const generation = this.generation;
    this.state.conversationId = conversationId;
    this.state.joining = true;
    this.changed();
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof RTCPeerConnection === 'undefined'
      ) {
        throw new Error(
          'Voice calls need microphone support and a secure connection. Use localhost or HTTPS in a current browser.',
        );
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.microphone = stream;
      stream.getAudioTracks().forEach((track) => {
        track.onended = () => {
          if (generation !== this.generation) return;
          this.leave();
          this.options.onError(
            'Microphone access ended. Check your device and join again.',
          );
        };
      });
      this.options.send({ type: 'call:join', conversationId });
    } catch (error) {
      if (generation !== this.generation) return;
      this.leave();
      this.error(error);
    }
  }

  leave() {
    const conversationId = this.state.conversationId;
    this.generation++;
    this.sharingPending = false;
    this.state.conversationId = null;
    this.state.joining = false;
    this.stopSharing();
    for (const peer of this.peers.values()) {
      if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer);
      peer.pc.onconnectionstatechange = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.onicecandidate = null;
      peer.channel.close();
      peer.pc.close();
    }
    this.peers.clear();
    this.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.microphone = null;
    this.state.muted = false;
    this.state.deafened = false;
    if (conversationId) {
      try {
        this.options.send({ type: 'call:leave', conversationId });
      } catch {
        // A closed socket already removes us from the server's call.
      }
    }
    this.changed();
  }

  cancelJoin() {
    if (this.state.joining) this.leave();
  }

  toggleMute() {
    if (!this.microphone) return;
    this.state.muted = !this.state.muted;
    this.microphone
      .getAudioTracks()
      .forEach((track) => (track.enabled = !this.state.muted));
    this.changed();
  }

  toggleDeafen() {
    if (!this.state.conversationId) return;
    this.state.deafened = !this.state.deafened;
    this.changed();
  }

  async shareScreen() {
    if (
      !this.state.conversationId ||
      this.state.joining ||
      this.state.sharing ||
      this.sharingPending
    )
      return;
    const generation = this.generation;
    this.sharingPending = true;
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error(
          'Screen sharing is unavailable in this window. Open Tiny in a current Chrome or Edge browser on localhost or HTTPS.',
        );
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 10, max: 10 },
        },
        audio: false,
      });
      if (generation !== this.generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        throw new Error('No screen was selected.');
      }
      track.contentHint = 'detail';
      this.state.localScreen = stream;
      this.state.sharing = true;
      track.onended = () => this.stopSharing();
      await Promise.all(
        [...this.peers.values()].map(async (peer) => {
          await this.updateScreenSender(peer);
          this.notifySharing(peer);
        }),
      );
      this.changed();
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopSharing();
      this.error(error, 'Screen sharing');
    } finally {
      if (generation === this.generation) this.sharingPending = false;
    }
  }

  stopSharing() {
    const stream = this.state.localScreen;
    this.state.localScreen = null;
    this.state.sharing = false;
    stream?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    for (const peer of this.peers.values()) {
      void this.updateScreenSender(peer).catch(() => {});
      this.notifySharing(peer);
    }
    this.changed();
  }

  private notifySharing(peer: Peer) {
    if (peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify({ sharing: this.state.sharing }));
    }
  }

  private notifyVideoPreference(peer: Peer) {
    if (peer.channel.readyState === 'open') {
      peer.channel.send(JSON.stringify({ receiveVideo: !this.backgrounded }));
    }
  }

  private updateScreenSender(peer: Peer) {
    // Serialize track changes so a late share operation cannot undo a newer
    // stop or background preference. Read the current preference when it runs.
    const update = peer.videoUpdate.then(async () => {
      if (peer.pc.signalingState === 'closed') return;
      const track =
        peer.wantsVideo && this.state.sharing
          ? (this.state.localScreen?.getVideoTracks()[0] ?? null)
          : null;
      await peer.video.sender.replaceTrack(track);
      if (track) await this.limitScreenBitrate(peer);
    });
    peer.videoUpdate = update.catch(() => {});
    return update;
  }

  private async limitScreenBitrate(peer: Peer) {
    try {
      const parameters = peer.video.sender.getParameters();
      if (!parameters.encodings?.length) return;
      for (const encoding of parameters.encodings) {
        encoding.maxBitrate = 1_200_000;
        encoding.maxFramerate = 10;
      }
      await peer.video.sender.setParameters(parameters);
    } catch {
      // Some system webviews do not expose sender quality controls.
      // Capture is still limited to 720p at 10 fps.
    }
  }

  private signal(peerId: string, fields: object) {
    if (!this.state.conversationId) return;
    this.options.send({
      type: 'signal',
      conversationId: this.state.conversationId,
      to: peerId,
      ...fields,
    });
  }

  private createPeer(peerId: string, userId: string, offer: boolean) {
    const existing = this.peers.get(peerId);
    if (existing) return existing;
    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: this.iceServers.length ? 2 : 0,
      iceTransportPolicy: this.forceRelay ? 'relay' : 'all',
    });
    this.microphone
      ?.getAudioTracks()
      .forEach((track) => pc.addTrack(track, this.microphone!));
    // Reserve video from the first offer so screen changes need only replaceTrack.
    const video = pc.addTransceiver('video', {
      direction: 'sendrecv',
      streams: [new MediaStream()],
    });
    const channel = pc.createDataChannel('tiny-media', {
      negotiated: true,
      id: 0,
    });
    const peer: Peer = {
      pc,
      video,
      channel,
      view: {
        peerId,
        userId,
        state: 'connecting',
        audio: null,
        screen: null,
        iceState: 'new',
        route: 'Selecting route',
      },
      remoteVideo: null,
      remoteAudio: null,
      remoteSharing: false,
      wantsVideo: true,
      videoUpdate: Promise.resolve(),
      makingOffer: false,
      ignoreOffer: false,
      settingAnswer: false,
      allowNegotiation: offer,
      candidates: [],
      recoveryTimer: null,
      recoveryAttempts: 0,
    };
    this.peers.set(peerId, peer);
    if (this.state.sharing) {
      void this.updateScreenSender(peer).catch((error) =>
        this.error(error, 'Screen sharing'),
      );
    }
    channel.onopen = () => {
      this.notifySharing(peer);
      this.notifyVideoPreference(peer);
    };
    channel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (typeof data.sharing === 'boolean') {
          peer.remoteSharing = data.sharing;
          peer.view.screen = data.sharing ? peer.remoteVideo : null;
          this.changed();
        }
        if (
          typeof data.receiveVideo === 'boolean' &&
          data.receiveVideo !== peer.wantsVideo
        ) {
          peer.wantsVideo = data.receiveVideo;
          void this.updateScreenSender(peer).catch((error) =>
            this.error(error, 'Screen sharing'),
          );
        }
      } catch {
        /* Ignore unrelated or malformed control data. */
      }
    };
    pc.onicecandidate = (event) => {
      if (event.candidate && this.peers.get(peerId) === peer)
        this.signal(peerId, { candidate: event.candidate.toJSON() });
    };
    pc.ontrack = (event) => {
      if (event.track.kind === 'audio') {
        if (!peer.remoteAudio) peer.remoteAudio = new MediaStream();
        if (!peer.remoteAudio.getTracks().includes(event.track))
          peer.remoteAudio.addTrack(event.track);
        peer.view.audio = peer.remoteAudio;
        event.track.onended = () => {
          peer.remoteAudio?.removeTrack(event.track);
          if (!peer.remoteAudio?.getAudioTracks().length)
            peer.view.audio = null;
          this.changed();
        };
      } else {
        const stream = new MediaStream([event.track]);
        peer.remoteVideo = stream;
        if (peer.remoteSharing) peer.view.screen = stream;
        event.track.onended = () => {
          peer.view.screen = null;
          this.changed();
        };
      }
      this.changed();
    };
    pc.onconnectionstatechange = () => {
      if (this.peers.get(peerId) !== peer) return;
      peer.view.state = pc.connectionState;
      this.changed();
      if (pc.connectionState === 'connected') {
        peer.recoveryAttempts = 0;
        if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer);
        peer.recoveryTimer = null;
        void this.limitScreenBitrate(peer);
        void this.updateRoute(peer);
      }
      if (pc.connectionState === 'failed')
        this.scheduleRecovery(peerId, peer, 0);
      if (pc.connectionState === 'disconnected')
        this.scheduleRecovery(peerId, peer, 4000);
    };
    pc.oniceconnectionstatechange = () => {
      if (this.peers.get(peerId) !== peer) return;
      peer.view.iceState = pc.iceConnectionState;
      this.changed();
      if (['connected', 'completed'].includes(pc.iceConnectionState)) {
        void this.updateRoute(peer);
      }
    };
    pc.onnegotiationneeded = () => {
      if (peer.allowNegotiation) void this.negotiate(peerId, peer);
    };
    this.changed();
    if (offer) void this.negotiate(peerId, peer);
    return peer;
  }

  private scheduleRecovery(peerId: string, peer: Peer, delay: number) {
    if (peer.recoveryTimer || peer.recoveryAttempts >= 2) {
      if (peer.recoveryAttempts >= 2)
        this.options.onError(
          'A call route failed after retrying. The host should verify TURN is reachable, then leave and rejoin the call.',
        );
      return;
    }
    peer.recoveryTimer = setTimeout(async () => {
      peer.recoveryTimer = null;
      if (
        this.peers.get(peerId) !== peer ||
        peer.pc.signalingState === 'closed' ||
        ['connected', 'completed'].includes(peer.pc.iceConnectionState)
      )
        return;
      peer.recoveryAttempts++;
      peer.view.route = `Retrying connection (${peer.recoveryAttempts}/2)`;
      try {
        const refreshed = await this.options.refreshIce?.();
        if (refreshed) this.configure(refreshed, this.forceRelay);
      } catch {
        // A direct route can still recover while the API is temporarily offline.
      }
      peer.pc.restartIce();
      this.changed();
      void this.negotiate(peerId, peer);
    }, delay);
  }

  private async updateRoute(peer: Peer) {
    try {
      const stats = await peer.pc.getStats();
      let pair: any;
      stats.forEach((report) => {
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          (report.nominated || report.selected)
        )
          pair = report;
      });
      const local = pair ? stats.get(pair.localCandidateId) : null;
      const remote = pair ? stats.get(pair.remoteCandidateId) : null;
      const types = [local?.candidateType, remote?.candidateType].filter(
        Boolean,
      );
      peer.view.route = types.includes('relay')
        ? 'TURN relay'
        : types.length
          ? `Direct · ${types.join(' / ')}`
          : 'Connected';
      this.changed();
    } catch {
      peer.view.route = 'Connected';
    }
  }

  private async negotiate(peerId: string, peer: Peer) {
    if (
      peer.makingOffer ||
      peer.pc.signalingState !== 'stable' ||
      this.peers.get(peerId) !== peer
    )
      return;
    try {
      peer.makingOffer = true;
      await peer.pc.setLocalDescription();
      if (this.peers.get(peerId) === peer)
        this.signal(peerId, {
          description: peer.pc.localDescription!.toJSON(),
        });
    } catch (error) {
      if (this.peers.get(peerId) === peer) this.error(error, 'Call');
    } finally {
      peer.makingOffer = false;
    }
  }

  async handle(data: any) {
    if (data.type === 'ready') {
      this.peerId = data.peerId;
      return;
    }
    if (data.type === 'error' && this.state.joining) {
      this.leave();
      this.options.onError(data.message || 'Could not join the call.');
      return;
    }
    if (
      !this.state.conversationId ||
      data.conversationId !== this.state.conversationId
    )
      return;
    if (data.type === 'call:joined') {
      if (!this.microphone) return;
      this.state.joining = false;
      for (const item of data.peers)
        this.createPeer(item.peerId, item.userId, true);
      this.changed();
    } else if (data.type === 'call:peer-joined') {
      if (data.peerId !== this.peerId)
        this.createPeer(data.peerId, data.userId, false);
    } else if (data.type === 'call:peer-left') {
      const peer = this.peers.get(data.peerId);
      if (peer) {
        this.peers.delete(data.peerId);
        if (peer.recoveryTimer) clearTimeout(peer.recoveryTimer);
        peer.channel.close();
        peer.pc.close();
        this.changed();
      }
    } else if (data.type === 'signal') {
      const peer = this.peers.get(data.from);
      if (!peer) return;
      try {
        if (data.description) {
          const ready =
            !peer.makingOffer &&
            (peer.pc.signalingState === 'stable' || peer.settingAnswer);
          const collision = data.description.type === 'offer' && !ready;
          const polite = this.peerId.localeCompare(data.from) > 0;
          peer.ignoreOffer = !polite && collision;
          if (peer.ignoreOffer) return;
          peer.settingAnswer = data.description.type === 'answer';
          await peer.pc.setRemoteDescription(data.description);
          peer.settingAnswer = false;
          for (const candidate of peer.candidates.splice(0))
            await peer.pc.addIceCandidate(candidate);
          if (data.description.type === 'offer') {
            await peer.pc.setLocalDescription();
            this.signal(data.from, {
              description: peer.pc.localDescription!.toJSON(),
            });
          }
          peer.allowNegotiation = true;
        } else if (data.candidate && !peer.ignoreOffer) {
          if (peer.pc.remoteDescription)
            await peer.pc.addIceCandidate(data.candidate);
          else peer.candidates.push(data.candidate);
        }
      } catch (error) {
        peer.settingAnswer = false;
        if (this.peers.get(data.from) === peer && !peer.ignoreOffer)
          this.error(error, 'Call');
      }
    }
  }

  destroy() {
    this.leave();
  }
}
