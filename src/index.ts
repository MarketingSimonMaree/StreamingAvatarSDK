import { Room, RoomEvent, VideoPresets } from "livekit-client";
import protobuf from "protobufjs";
import { convertFloat32ToS16PCM, sleep } from "./utils";

export interface StreamingAvatarApiConfig {
  token: string;
  basePath?: string;
}

export enum AvatarQuality {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
}
export interface StartAvatarRequest {
  quality?: AvatarQuality;
  avatarName: string;
  voice?: { voiceId?: string };
  knowledgeId?: string;
}

export interface StartAvatarResponse {
  session_id: string,
  access_token: string,
  url: string,
  is_paid: boolean,
  session_duration_limit: number
}

export interface StartSessionRequest {
  sessionId: string;
}

export interface SpeakRequest {
  text: string;
  sessionId: string;
}

export interface InterruptRequest {
  sessionId: string;
}

export interface StopAvatarRequest {
  sessionId: string;
}

export interface CommonRequest {
  [key: string]: any;
}

// event types --------------------------------
export enum StreamingEvents {
  AVATAR_START_TALKING = 'avatar_start_talking',
  AVATAR_STOP_TALKING = 'avatar_stop_talking',
  AVATAR_TALKING_MESSAGE = 'avatar_talking_message',
  AVATAR_END_MESSAGE = 'avatar_end_message',
  USER_TALKING_MESSAGE = 'user_talking_message',
  USER_END_MESSAGE = 'user_end_message',
  USER_START = 'user_start',
  USER_STOP = 'user_stop',
  USER_SILENCE = 'user_silence',
  STREAM_READY = 'stream_ready',
  STREAM_DISCONNECTED = 'stream_disconnected',
}
export type EventHandler = (...args: any[]) => void;
export interface EventData {
  [key: string]: unknown;
  task_id: string;
}

export interface StreamingStartTalkingEvent extends EventData {
  type: StreamingEvents.AVATAR_START_TALKING;
}

export interface StreamingStopTalkingEvent extends EventData {
  type: StreamingEvents.AVATAR_STOP_TALKING;
}

export interface StreamingTalkingMessageEvent extends EventData {
  type: StreamingEvents.AVATAR_TALKING_MESSAGE;
  message: string;
}

export interface StreamingTalkingEndEvent extends EventData {
  type: StreamingEvents.AVATAR_END_MESSAGE;
}

export interface UserTalkingMessageEvent extends EventData {
  type: StreamingEvents.USER_TALKING_MESSAGE;
  message: string;
}

export interface UserTalkingEndEvent extends EventData {
  type: StreamingEvents.USER_END_MESSAGE;
}

type StreamingEventTypes =
  | StreamingStartTalkingEvent
  | StreamingStopTalkingEvent
  | StreamingTalkingMessageEvent
  | StreamingTalkingEndEvent
  | UserTalkingMessageEvent
  | UserTalkingEndEvent;

interface WebsocketBaseEvent {
  [key: string]: unknown;
}
interface UserStartTalkingEvent extends WebsocketBaseEvent {
  event_type: StreamingEvents.USER_START;
}
interface UserStopTalkingEvent extends WebsocketBaseEvent {
  event_type: StreamingEvents.USER_STOP;
}
interface UserSilenceEvent extends WebsocketBaseEvent {
  event_type: StreamingEvents.USER_SILENCE;
  silence_times: number;
  count_down: number;
}

type StreamingWebSocketEventTypes = UserStartTalkingEvent | UserStopTalkingEvent | UserSilenceEvent;

class APIError extends Error {
  public status: number;
  public responseText: string;

  constructor(message: string, status: number, responseText: string) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.responseText = responseText;
  }
}

class StreamingAvatar {
  public room: Room | null = null;
  public mediaStream: MediaStream | null = null;

  private readonly token: string;
  private readonly basePath: string;
  private eventTarget = new EventTarget();
  private audioContext: AudioContext | null = null;
  private webSocket: WebSocket = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private mediaStreamAudioSource: MediaStreamAudioSourceNode | null = null;
  private mediaDevicesStream: MediaStream | null = null;
  private audioRawFrame: protobuf.Type | undefined;
  private sessionId: string | null = null;

  constructor({
    token,
    basePath = "https://api.heygen.com",
  }: StreamingAvatarApiConfig) {
    this.token = token;
    this.basePath = basePath;
  }

  public async createStartAvatar(requestData: StartAvatarRequest): Promise<any> {
    const sessionInfo = await this.newSession(requestData);
    this.sessionId = sessionInfo.session_id;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      },
    });

    this.room = room;
    this.mediaStream = null;

    room.on(RoomEvent.DataReceived, (roomMessage) => {
      let eventMsg: StreamingEventTypes | null = null;
      try {
        const messageString = new TextDecoder().decode(
          roomMessage as ArrayBuffer,
        );
        eventMsg = JSON.parse(messageString) as StreamingEventTypes;
      } catch (e) {
        console.error(e);
      }
      if (!eventMsg) {
        return;
      }
      this.emit(eventMsg.type, eventMsg);
    });

    // Create a new MediaStream to hold tracks
    const mediaStream = new MediaStream();
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === "video" || track.kind === "audio") {
        mediaStream.addTrack(track.mediaStreamTrack);

        const hasVideoTrack = mediaStream.getVideoTracks().length > 0;
        const hasAudioTrack = mediaStream.getAudioTracks().length > 0;
        if (
          hasVideoTrack &&
          hasAudioTrack &&
          !this.mediaStream
        ) {
          this.mediaStream = mediaStream;
          this.emit(StreamingEvents.STREAM_READY, this.mediaStream);
        }
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track) => {
      const mediaTrack = track.mediaStreamTrack;
      if (mediaTrack) {
        mediaStream.removeTrack(mediaTrack);
      }
    });

    room.on(RoomEvent.Disconnected, (reason) => {
      this.emit(StreamingEvents.STREAM_DISCONNECTED, reason);
    });

    try {
      await room.prepareConnection(sessionInfo.url, sessionInfo.access_token);
    } catch (error) {}

    await this.startSession({ sessionId: sessionInfo.session_id });

    await room.connect(sessionInfo.url, sessionInfo.access_token);

    // try to connect websocket. it's a basic/optional requirement.
    await this.connectWebSocket();
    await this.loadAudioRawFrame();
    // todo, start voice chat
    try {
      await this.startVoiceChat();
    } catch (e) {
      //
    }

    return sessionInfo;
  }

  public async startVoiceChat () {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return;
    }

    this.audioContext = new window.AudioContext({
      latencyHint: 'interactive',
      sampleRate: 16000,
    });
    try {
      const devicesStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      this.mediaDevicesStream = devicesStream;

      this.mediaStreamAudioSource = this.audioContext?.createMediaStreamSource(devicesStream);
      this.scriptProcessor = this.audioContext?.createScriptProcessor(512, 1, 1);

      this.mediaStreamAudioSource.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.audioContext?.destination);

      this.scriptProcessor.onaudioprocess = (event) => {
        if (!this.webSocket) {
          return;
        }
        const audioData = event.inputBuffer.getChannelData(0);
        const pcmS16Array = convertFloat32ToS16PCM(audioData);
        const pcmByteArray = new Uint8Array(pcmS16Array.buffer);
        const frame = this.audioRawFrame?.create({
          audio: {
            audio: Array.from(pcmByteArray),
            sampleRate: 16000,
            numChannels: 1,
          },
        });
        const encodedFrame = new Uint8Array(this.audioRawFrame?.encode(frame).finish());
        this.webSocket?.send(encodedFrame);
      };

      // sleep 2s. though room has been connected, but the stream may not be ready.
      await sleep(2000);
    } catch (e) {
      console.error(e)
    }
  }
  public closeVoiceChat () {
    try {
      if (this.audioContext) {
        this.audioContext = null;
      }
      if (this.scriptProcessor) {
        this.scriptProcessor.disconnect();
        this.scriptProcessor = null;
      }
      if (this.mediaStreamAudioSource) {
        this.mediaStreamAudioSource.disconnect();
        this.mediaStreamAudioSource = null;
      }
      if (this.mediaDevicesStream) {
        this.mediaDevicesStream?.getTracks()?.forEach((track) => track.stop());
        this.mediaDevicesStream = null;
      }
    } catch (e) {}
  }

  public async newSession(
    requestData: StartAvatarRequest,
  ): Promise<StartAvatarResponse> {
    return this.request("/v1/streaming.new", {
      avatar_name: requestData.avatarName,
      quality: requestData.quality,
      knowledge_base_id: requestData.knowledgeId,
      voice: {
        voice_id: requestData.voice?.voiceId,
      },
      version: "v2",
      video_encoding: "H264",
    });
  }
  public async startSession(requestData: { sessionId: string }): Promise<any> {
    return this.request("/v1/streaming.start", {
      session_id: requestData.sessionId,
    });
  }
  public async speak(requestData: SpeakRequest): Promise<any> {
    // try to use websocket first
    if (this.webSocket && this.audioRawFrame) {
      const frame = this.audioRawFrame?.create({
        text: {
          text: requestData.text,
        },
      });
      const encodedFrame = new Uint8Array(this.audioRawFrame?.encode(frame).finish());
      this.webSocket?.send(encodedFrame);
      return;
    }
    return this.request("/v1/streaming.task", {
      text: requestData.text,
      session_id: requestData.sessionId,
      task_mode: 'async',
      task_type: 'talk',
    });
  }

  public async startListening(requestData: {sessionId: string}): Promise<any> {
    return this.request("/v1/streaming.start_listening", {
      session_id: requestData.sessionId,
    });
  }
  public async stopListening(requestData: {sessionId: string}): Promise<any> {
    return this.request("/v1/streaming.stop_listening", {
      session_id: requestData.sessionId,
    });
  }
  public async interrupt(requestData: InterruptRequest): Promise<any> {
    return this.request("/v1/streaming.interrupt", {
      session_id: requestData.sessionId,
    });
  }

  public async stopAvatar(requestData: StopAvatarRequest): Promise<any> {
    // clear some resources
    this.closeVoiceChat();
    return this.request("/v1/streaming.stop", {
      session_id: requestData.sessionId,
    });
  }

  public on(eventType: string, listener: EventHandler): this {
    this.eventTarget.addEventListener(eventType, listener);
    return this;
  }

  public off(eventType: string, listener: EventHandler): this {
    this.eventTarget.removeEventListener(eventType, listener);
    return this;
  }

  private async request(path: string, params: CommonRequest, config?: any): Promise<any> {
    try {
      const response = await fetch(this.getRequestUrl(path), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new APIError(
          `API request failed with status ${response.status}`,
          response.status,
          errorText
        );
      }

      const jsonData = await response.json();
      return jsonData.data
    } catch (error) {
      throw error;
    }
  }

  private emit(eventType: string, detail?: any) {
    const event = new CustomEvent(eventType, { detail });
    this.eventTarget.dispatchEvent(event);
  }
  private getRequestUrl(endpoint: string): string {
    return `${this.basePath}${endpoint}`;
  }
  private async connectWebSocket () {
    this.webSocket = new WebSocket(`wss://api.heygen.com/v1/ws/streaming.chat?session_id=${this.sessionId}&session_token=${this.token}`);
    this.webSocket.addEventListener('message', (event) => {
      let eventData: StreamingWebSocketEventTypes | null = null;
      try {
        eventData = JSON.parse(event.data);
      } catch (e) {
        console.error(e);
      }
      if (!eventData) {
        return;
      }
      this.emit(eventData.event_type, eventData);
    });
    this.webSocket.addEventListener('close', (event) => {
      console.log('WebSocket closed.', event.code, event.reason);
      this.webSocket = null;
    });
    return new Promise((resolve, reject) => {
      this.webSocket?.addEventListener('error', (event) => {
        console.error('WebSocket failed:', event);
        this.webSocket = null;
        reject(event);
      });
      this.webSocket?.addEventListener('open', () => {
        console.log('WebSocket established.');
        resolve(true);
      });
    });
  }
  private async loadAudioRawFrame () {
    if (!this.audioRawFrame) {
      protobuf.load('https://static.heygen.ai/static/streaming.proto', (err, root) => {
        if (err) {
          throw err;
        }
        this.audioRawFrame = root?.lookupType('pipecat.Frame');
      });
    }
  }
}

export default StreamingAvatar;
