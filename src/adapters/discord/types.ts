'use strict';

export interface RpcConnectionState {
  client: any | null;
  ready: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connecting: Promise<void> | null;
  activeToolKey: string | null;
  lastSentActivitySignature: string | null;
  lastCleared: boolean;
  connectionAttempt: number;
  // Failed connects back off (15 s doubling to 60 s); callers outside the
  // reconnect timer must not connect before this time.
  nextConnectAtMs: number;
  reconnectDelayMs: number;
}
