/**
 * A scenario user in the board's real LiveKit call, as a Node participant
 * (@livekit/rtc-node) — no browser needed. It joins through Lucent's own token
 * route (so admission, host, guest waiting, removal and lock are the
 * product's), publishes a silent microphone track (the host can only mute a
 * published track), speaks the call's data protocol (meeting-room/
 * callProtocol.ts: lucent.chat, lucent.reaction, lucent.line to the
 * transcript keeper), and records what LiveKit tells it.
 */
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { sleep } from "./api.mjs";

const enc = new TextEncoder();
const dec = new TextDecoder();

export class CallParticipant {
  constructor(person, boardId) {
    this.person = person;
    this.boardId = boardId;
    this.roomName = `board-${boardId}`;
    this.room = null;
    this.data = []; // {topic, from, payload, at}
    this.events = []; // {type, ..., at}
    this.host = false;
    this.connected = false;
    this.tokenAnswers = [];
  }

  /** Ask Lucent for a call token. Returns the HTTP answer (200 / 202 waiting / 403). */
  async requestToken() {
    const r = await this.person.try("POST", "/api/livekit/token", {
      boardId: this.boardId,
      room: this.roomName,
    });
    this.tokenAnswers.push({ status: r.status, body: r.data, at: Date.now() });
    return r;
  }

  /**
   * Join: token (waiting in the lobby while a host decides, if a guest), then
   * connect and publish a silent mic. Resolves to the final token answer.
   */
  async join({ waitTimeoutMs = 60_000, publishMic = true } = {}) {
    let r = await this.requestToken();
    const end = Date.now() + waitTimeoutMs;
    while (r.status === 202 && Date.now() < end) {
      await sleep(1500);
      r = await this.requestToken();
    }
    if (r.status !== 200) return r;
    this.host = !!r.data.host;
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      let body = null;
      try {
        body = JSON.parse(dec.decode(payload));
      } catch {
        body = dec.decode(payload);
      }
      this.data.push({ topic, from: participant?.identity ?? null, payload: body, at: Date.now() });
    });
    room.on(RoomEvent.Disconnected, (reason) => {
      this.connected = false;
      this.events.push({ type: "disconnected", reason, at: Date.now() });
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      this.events.push({
        type: "attributes",
        identity: participant?.identity,
        changed,
        at: Date.now(),
      });
    });
    room.on(RoomEvent.RoomMetadataChanged, (metadata) => {
      this.events.push({ type: "metadata", metadata, at: Date.now() });
    });
    room.on(RoomEvent.TrackMuted, (participant, publication) => {
      this.events.push({
        type: "muted",
        identity: participant?.identity,
        source: publication?.source,
        at: Date.now(),
      });
    });
    room.on(RoomEvent.ParticipantConnected, (p) =>
      this.events.push({ type: "joined", identity: p.identity, at: Date.now() }),
    );
    room.on(RoomEvent.ParticipantDisconnected, (p) =>
      this.events.push({ type: "left", identity: p.identity, at: Date.now() }),
    );
    await room.connect(r.data.url, r.data.token, { autoSubscribe: false, dynacast: false });
    this.connected = true;
    if (publishMic) {
      this.source = new AudioSource(48_000, 1);
      const track = LocalAudioTrack.createAudioTrack("microphone", this.source);
      const opts = new TrackPublishOptions();
      opts.source = TrackSource.SOURCE_MICROPHONE;
      await room.localParticipant.publishTrack(track, opts);
      // A few frames of silence so the track is live, not merely announced.
      for (let i = 0; i < 5; i++) {
        await this.source.captureFrame(new AudioFrame(new Int16Array(480), 48_000, 1, 480));
      }
    }
    return r;
  }

  get identity() {
    return this.person.id;
  }

  remoteIdentities() {
    return this.room ? [...this.room.remoteParticipants.values()].map((p) => p.identity) : [];
  }

  async publish(topic, payload, destination) {
    if (!this.connected) throw new Error(`${this.person.name} is not in the call`);
    await this.room.localParticipant.publishData(enc.encode(JSON.stringify(payload)), {
      reliable: true,
      topic,
      ...(destination ? { destination_identities: [destination] } : {}),
    });
  }

  chat(text) {
    return this.publish("lucent.chat", { v: 1, id: `c_${Date.now()}_${Math.random()}`, text, at: Date.now() });
  }
  react(emoji) {
    return this.publish("lucent.reaction", { v: 1, emoji });
  }
  /** One finished line of speech, sent to the device keeping the transcript. */
  line(text, keeperIdentity) {
    return this.publish(
      "lucent.line",
      { v: 1, id: `l_${this.person.id}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`, text, at: Date.now() },
      keeperIdentity,
    );
  }

  /** Lucent's call/state route (hand, capture, …) — needs to be in the room. */
  state(body) {
    return this.person.try("POST", `/api/boards/${this.boardId}/call/state`, body);
  }

  async leave() {
    if (this.room) {
      try {
        await this.room.disconnect();
      } catch {}
    }
    this.connected = false;
  }
}
