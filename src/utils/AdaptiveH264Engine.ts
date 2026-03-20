import { obfuscateSplit } from './obfuscator';
import { encryptData } from './cryptoUtils';

// Crypto Worker для выноса шифрования из основного потока
let cryptoWorker: Worker | null = null;
let cryptoWorkerReady = false;
const pendingCryptoOps = new Map<number, {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
  data: Uint8Array;
  frameId: number;
}>();
let cryptoOpId = 0;

let cryptoWorkerInitPromise: Promise<void> | null = null;

function initCryptoWorker(): Promise<void> {
  if (cryptoWorkerInitPromise) return cryptoWorkerInitPromise;

  cryptoWorkerInitPromise = new Promise((resolve, reject) => {
    try {
      if (!cryptoWorker) {
        cryptoWorker = new Worker(new URL('../workers/cryptoWorker.ts', import.meta.url), { type: 'module' });
      }

      cryptoWorker.onmessage = (event) => {
        const { type, id, error } = event.data;

        if (type === 'KEY_READY') {
          cryptoWorkerReady = true;
          resolve();
        } else if (type === 'ENCRYPTED_VIDEO' || type === 'ENCRYPTED_AUDIO') {
          const pending = pendingCryptoOps.get(id);
          if (pending) {
            pendingCryptoOps.delete(id);
            pending.resolve(new Uint8Array(event.data.data));
          }
        } else if (type === 'ERROR') {
          const pending = pendingCryptoOps.get(id);
          if (pending) {
            pendingCryptoOps.delete(id);
            pending.reject(new Error(error));
          }
        }
      };

      cryptoWorker.onerror = (err) => {
        cryptoWorkerReady = false;
        reject(err);
      };
    } catch (e) {
      cryptoWorkerReady = false;
      resolve();
    }
  });
  return cryptoWorkerInitPromise;
}

async function encryptInWorker(key: CryptoKey, data: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  if (!cryptoWorker || !cryptoWorkerReady) {
    return encryptData(key, data) as Promise<Uint8Array>;
  }

  return new Promise((resolve, reject) => {
    const id = ++cryptoOpId;
    pendingCryptoOps.set(id, { resolve, reject, data, frameId: 0 });

    try {
      cryptoWorker!.postMessage({
        type: 'ENCRYPT_VIDEO',
        payload: data.buffer.slice(0),
        iv: iv.buffer.slice(0),
        id: id
      });
    } catch (postError) {
      pendingCryptoOps.delete(id);
      reject(postError);
      return;
    }
  });
}

export class AdaptiveH264Engine {
  private video: HTMLVideoElement;
  private onFrame: (data: string) => void;
  private getNetworkMetrics: () => { rtt: number, bufferedAmount: number };
  private onLog?: (msg: string) => void;
  private ws: WebSocket;
  private sharedSecret: CryptoKey | null = null;

  private isRunning: boolean = false;
  private lastFrameTime: number = 0;
  private pendingFrames: number = 0;
  private rafId: number | null = null;
  private errorCount: number = 0;
  private isRecovering: boolean = false;
  private pacerInterval: any = null;

  private currentFps: number = 20;
  private currentWidth: number = 0;
  private currentHeight: number = 0;
  private currentScale: number = 1.0;

  private encoder: VideoEncoder | null = null;
  private needsKeyframe: boolean = false;
  private isConfigured: boolean = false;

  private aiState: 'steady' | 'hold' | 'congested' | 'recovery' = 'steady';
  private lastRttSmoothed: number = 0;
  private readonly SMOOTHING_ALPHA = 0.1;

  private lastCongestionTs: number = 0;
  private readonly congestionCooldown: number = 1000;

  private pacerTokens: number = 0;
  private lastPacerRun: number = performance.now();

  private targetBitrate: number = 500_000;
  private lastConfiguredBitrate: number = 0;
  private minBitrate: number = 100_000; // Attempt 1: Lowered to 100kbps
  private maxBitrate: number = 4_000_000;
  private tokenBucketBytes: number = (500_000 / 8) * 0.2;
  private lastTokenUpdate: number = performance.now();
  private lastEncodeTs: number = performance.now(); // Watchdog tracking
  private sessionStartTime: number = performance.now();

  private sendQueue: { data: Uint8Array; enqueueTime: number }[] = [];
  private frameId: number = 0;
  private droppedFrames: number = 0;
  private droppedFramesWindow: number = 0;
  private droppedFramesRate: number = 0;
  private droppedFramesConsecutive: number = 0;
  private droppedWindowStart: number = performance.now();

  private lastAIUpdate: number = performance.now();
  private lastLogTime: number = 0;
  private lastRtt: number = 0;

  // CPU Metrics (Task 17)
  private encodeDurationLog: number[] = [];

  private bytesSentThisSecond: number = 0;
  private lastRateLog: number = 0;
  private lastPacerLog: number = 0;
  private lastCongestionUpdate: number = 0;
  private readonly CONGESTION_UPDATE_INTERVAL: number = 1000;

  private manualMode: boolean = false;
  private manualBitrate: number = 500_000;
  private lastAbrBitrate: number = 500_000;

  // PI Controller for RTT-based adaptation
  private rttTarget = 150; // target RTT in ms
  private errorIntegral = 0;
  private lastRttUpdateTs = 0;
  private readonly KP = 0.5;   // Proportional gain
  private readonly KI = 0.2;   // Integral gain
  private readonly MAX_INTEGRAL = 5000;

  // New GCC-inspired metrics
  private delayTrend: number = 0;
  private readonly OVERUSE_THRESHOLD: number = 80;
  private readonly NORMAL_THRESHOLD: number = 25;
  private rttHistory: number[] = [];
  private lastSmoothedRtt: number = 0;
  private lastUpdateTs: number = 0;
  private probingStartTs: number = 0;
  private isProbing: boolean = false;
  private lastSteadyIncrease: number = 0;

  constructor(
    video: HTMLVideoElement,
    onFrame: (data: string) => void,
    getNetworkMetrics: () => { rtt: number, bufferedAmount: number },
    ws: WebSocket,
    onLog?: (msg: string) => void,
    sharedSecret: CryptoKey | null = null
  ) {
    this.video = video;
    this.onFrame = onFrame;
    this.getNetworkMetrics = getNetworkMetrics;
    this.ws = ws;
    this.onLog = onLog;
    this.sharedSecret = sharedSecret;

    if (sharedSecret) {
      initCryptoWorker().catch(err => {
        if (this.onLog) this.onLog(`\u26A0\uFE0F Crypto Worker init failed: ${err}`);
      });
    }
    this.initEncoder();
  }

  private initEncoder() {
    try {
      this.encoder = new VideoEncoder({
        output: async (chunk, metadata) => {
          const startTime = performance.now();
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          try {
            let finalData: Uint8Array = data;
            if (this.onLog && this.frameId % 30 === 0) this.onLog(`✅ Encoded frame ${this.frameId} (size=${data.length})`);

            // Attempt 4: Stricter Frame Limiter (100KB)
            if (data.length > 250000) {
              if (this.onLog) this.onLog(`🚨 CRITICAL: Frame size too large (${Math.round(data.length / 1024)}KB). Dropping to prevent buffer bloat.`);
              this.needsKeyframe = true;
              this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.4);
              this.applyBitrateToParams();
              this.pendingFrames = Math.max(0, this.pendingFrames - 1);
              return;
            }

            if (this.sharedSecret) {
              const iv = crypto.getRandomValues(new Uint8Array(12));
              finalData = await encryptInWorker(this.sharedSecret, data, iv).catch(err => {
                return encryptData(this.sharedSecret, data) as Promise<Uint8Array>;
              });
            }

            const senderTs = Math.floor(performance.now() - this.sessionStartTime);
            const parts = await obfuscateSplit(finalData, this.frameId++, senderTs);
            for (const part of parts) {
              this.sendQueue.push({
                data: new Uint8Array(part),
                enqueueTime: performance.now()
              });
            }

            // Attempt 7: Precise Token Tracking (Subtract actual encoded size)
            this.tokenBucketBytes -= finalData.length;
            this.lastEncodeTs = performance.now(); // Reset watchdog

            this.encodeDurationLog.push(performance.now() - startTime);
            if (this.encodeDurationLog.length > 30) this.encodeDurationLog.shift();

          } catch (e) {
            // 
          } finally {
            this.pendingFrames = Math.max(0, this.pendingFrames - 1);
          }
        },
        error: (e) => {
          if (this.onLog) this.onLog(`❌ VideoEncoder error: ${e.message}`);
          this.handleEncoderError();
        }
      });
    } catch (e) {
      setTimeout(() => {
        if (this.isRunning && !this.encoder) this.initEncoder();
      }, 1000);
    }
  }

  private handleEncoderError() {
    if (this.isRecovering || this.errorCount > 3) return;
    this.isRecovering = true;
    this.errorCount++;
    this.pendingFrames = 0;

    setTimeout(async () => {
      try {
        if (this.encoder) { this.encoder.close(); this.encoder = null; }
        this.isConfigured = false;
        this.initEncoder();
        this.isRecovering = false;
      } catch (err) { }
    }, 1000);
  }

  private configureEncoder(width: number, height: number) {
    if (!this.encoder || width === 0 || height === 0) return;

    try {
      this.encoder.configure({
        codec: "avc1.42e01f", // Attempt 4: Baseline Profile
        width: width,
        height: height,
        bitrate: this.targetBitrate,
        bitrateMode: 'constant',
        latencyMode: "realtime",
        // @ts-ignore
        avc: { format: "annexb", key_frame_interval: 60 }
      });
      this.currentWidth = width;
      this.currentHeight = height;
      this.isConfigured = true;
      this.needsKeyframe = true;

      // ДОБАВИТЬ СБРОС СТАРЫХ КАДРОВ:
      if (this.sendQueue.length > 0) {
        this.sendQueue = [];
      }
      this.tokenBucketBytes = Math.max(this.tokenBucketBytes, 40000);

      if (this.onLog) this.onLog(`⚙️ Baseline Config: ${width}x${height} @ ${Math.round(this.targetBitrate / 1024)}k (Queue Flush + Boost)`);
    } catch (e) {
      if (this.onLog) this.onLog(`\u274C Encoder configuration failed: ${e}`);
    }
  }

  private applyBitrateToParams() {
    if (!this.encoder || !this.isConfigured) return;

    const diffRatio = Math.abs(this.targetBitrate - this.lastConfiguredBitrate) / (this.lastConfiguredBitrate || 1);
    if (diffRatio >= 0.05) {
      try {
        this.encoder.configure({
          codec: "avc1.42e01f", // Baseline Profile
          width: this.currentWidth,
          height: this.currentHeight,
          bitrate: this.targetBitrate,
          bitrateMode: 'constant',
          latencyMode: "realtime",
          // @ts-ignore
          avc: { format: "annexb", key_frame_interval: 60 }
        });
        this.lastConfiguredBitrate = this.targetBitrate;
      } catch (e) { }
    }

    const kbps = this.targetBitrate / 1024;
    if (kbps < 500) this.currentFps = 15;
    else if (kbps < 1000) this.currentFps = 24;
    else this.currentFps = 30;
  }

  private updateCongestionControl() {
    if (this.manualMode) return;

    const now = performance.now();
    const metrics = this.getNetworkMetrics();
    const buffered = metrics.bufferedAmount;
    const queueDelay = this.sendQueue.length > 0 ? now - this.sendQueue[0].enqueueTime : 0;

    let stateChanged = false;
    const oldBitrate = this.targetBitrate;

    // GCC Overuse Detection
    const isOveruse = this.delayTrend > this.OVERUSE_THRESHOLD || queueDelay > 180 || buffered > 400000;

    if (isOveruse) {
      if (this.aiState !== 'congested') {
        this.aiState = 'congested';
        // Attempt 7: Panic Bitrate Cut 50%
        this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
        stateChanged = true;
        if (this.onLog) this.onLog(`🚨 GCC Overuse: trend=${this.delayTrend.toFixed(1)}, qDelay=${Math.round(queueDelay)}ms, cutting to ${Math.round(this.targetBitrate / 1024)}k`);
      }
    } else {
      // Recovery or Steady
      if (this.aiState === 'congested') {
        this.aiState = 'recovery';
        stateChanged = true;
      }

      if (this.aiState === 'recovery') {
        // Attempt 7: Multiplicative Recovery (8% + fixed 10k)
        this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate * 1.08 + 10000);
        if (this.targetBitrate >= oldBitrate * 1.15) { // Exit recovery with larger margin
          this.aiState = 'steady';
        }
      } else if (this.aiState === 'steady') {
        // Attempt 7: Aggressive steady growth (25kbps every 400ms)
        if (now - this.lastSteadyIncrease > 400) {
          const rtt = this.getNetworkMetrics().rtt;
          const growth = rtt < 150 ? 25000 : 15000; // Attempt 6: Faster growth on low RTT
          this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate + growth);
          this.lastSteadyIncrease = now;
        }

        // Attempt 6: Frequent Probing (8s)
        if (!this.isProbing && now - this.probingStartTs > 8000) {
          this.isProbing = true;
          this.probingStartTs = now;
          if (this.onLog) this.onLog(`🔍 Probing network capacity (3.5x)...`);
        }

        if (this.isProbing) {
          if (now - this.probingStartTs < 250) {
            this.targetBitrate = Math.min(this.maxBitrate, oldBitrate * 3.5);
          } else {
            this.isProbing = false;
            this.probingStartTs = now; // Reset timer
          }
        }
      }
    }

    if (Math.abs(this.targetBitrate - oldBitrate) > 1000 || stateChanged) {
      this.applyBitrateToParams();
    }
  }

  public updateRTT(rtt: number) {
    const now = performance.now();
    this.lastRtt = rtt;

    // === NEW PROTECTION AGAINST ZOMBIE RTT (SPIKES) ===
    if (rtt > 2000) { // > 2s is likely a buffer artifact, not real network delay
      if (this.onLog) this.onLog(`🚨 EXTREME RTT SPIKE ${rtt}ms — resetting history`);
      this.rttHistory = [this.lastSmoothedRtt || 150]; // return to last normal
      return;
    }

    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();

    const sorted = [...this.rttHistory].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];

    // Hard Cap for the median used in GCC calculations
    const clampedRtt = Math.min(medianRtt, 800);

    // Smoothed RTT (EMA with 0.7/0.3 weight to filter spikes)
    // Attempt 6: Asymmetric RTT Smoothing (EMA)
    const prevSmoothed = this.lastSmoothedRtt || clampedRtt;
    if (clampedRtt < prevSmoothed) {
      this.lastSmoothedRtt = prevSmoothed * 0.5 + clampedRtt * 0.5; // Fast drop reaction
    } else {
      this.lastSmoothedRtt = prevSmoothed * 0.8 + clampedRtt * 0.2; // Slow rise reaction
    }

    // Delay Trend (Derivative)
    const dt = (now - this.lastUpdateTs) / 1000;
    if (dt >= 0.2) {
      this.delayTrend = (this.lastSmoothedRtt - prevSmoothed) / dt;
      this.lastUpdateTs = now;
      this.updateCongestionControl();
    }
  }

  public setManualMode(enabled: boolean) {
    this.manualMode = enabled;
    this.errorIntegral = 0; // Reset PI on mode toggle
    if (enabled) {
      this.lastAbrBitrate = this.targetBitrate;
      this.targetBitrate = this.manualBitrate;
      if (this.onLog) this.onLog(`🛠️ Manual mode enabled, bitrate fixed to ${Math.round(this.manualBitrate / 1024)}k`);
    } else {
      this.targetBitrate = this.lastAbrBitrate;
      if (this.onLog) this.onLog(`🔄 Auto mode (ABR) restored, target bitrate ${Math.round(this.targetBitrate / 1024)}k`);
    }
    this.applyBitrateToParams();
  }

  public setManualBitrate(bitrate: number) {
    this.manualBitrate = bitrate;

    if (this.manualMode) {
      // Safe transition: reset everything before re-configuring
      this.sendQueue = [];
      this.tokenBucketBytes = 0;
      this.targetBitrate = bitrate;

      if (this.encoder) {
        this.needsKeyframe = true;
        this.encoder.flush(); // flush the encoder queue to prevent deadlock
      }

      this.applyBitrateToParams();
      if (this.onLog) this.onLog(`🛠️ Manual bitrate → ${Math.round(bitrate / 1024)}k (queue cleared, forced I-frame)`);
    }
  }

  public getStats() {
    const { rtt, bufferedAmount } = this.getNetworkMetrics();
    const avgEncode = this.encodeDurationLog.length > 0
      ? this.encodeDurationLog.reduce((a, b) => a + b, 0) / this.encodeDurationLog.length
      : 0;

    return {
      fps: this.currentFps,
      droppedFrames: this.droppedFrames,
      droppedFramesRate: this.droppedFramesRate,
      state: this.aiState === 'congested' ? 'Overuse' : 'Normal',
      aiState: this.aiState,
      targetBitrate: Math.round(this.targetBitrate / 1024),
      rtt: rtt,
      bl: bufferedAmount,
      qDelay: this.sendQueue.length > 0 ? performance.now() - this.sendQueue[0].enqueueTime : 0,
      qLen: this.sendQueue.length,
      cpu: Math.round(avgEncode) // ms per frame
    };
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const now = performance.now();
    this.sessionStartTime = now;
    this.lastAIUpdate = now;
    this.lastTokenUpdate = now;
    this.lastPacerRun = now;
    this.lastCongestionTs = 0;
    this.aiState = 'steady';
    this.targetBitrate = 500_000;
    this.frameId = 0;
    this.applyBitrateToParams();
    if (this.onLog) this.onLog(`\uD83D\uDE80 Sender started: Fixed 1Mbps, GCC disabled, GOP=60`);
    this.pacerInterval = setInterval(() => this.runPacer(performance.now()), 10);
    this.rafId = requestAnimationFrame(this.loop);
  }

  public async stop() {
    this.isRunning = false;
    this.sendQueue = [];
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.pacerInterval) clearInterval(this.pacerInterval);
    this.pacerInterval = null;

    if (cryptoWorker) {
      cryptoWorker.postMessage({ type: 'CLEAR_KEY' });
    }

    if (this.encoder) {
      try { this.encoder.close(); } catch (e) { }
      this.encoder = null;
      this.isConfigured = false;
    }
  }

  public isRunningNow() {
    return this.isRunning;
  }

  public forceKeyframe() {
    this.needsKeyframe = true;
  }

  private loop = async (now: number) => {
    if (!this.isRunning) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.lastFrameTime = now;
      this.lastTokenUpdate = now;
      this.rafId = requestAnimationFrame(this.loop);
      return;
    }

    this.updateCongestionControl();

    const timeDeltaMs = now - this.lastTokenUpdate;
    if (timeDeltaMs > 0) {
      const tokensToAdd = (this.targetBitrate / 8) * (timeDeltaMs / 1000);
      const maxBurst = (this.targetBitrate / 8) * 1.5;
      this.tokenBucketBytes = Math.min(this.tokenBucketBytes + tokensToAdd, maxBurst);
      
      // ВОЗВРАЩАЕМ ПРОЩЕНИЕ ДОЛГА ИЗ ТЕСТА:
      const maxDebt = -this.targetBitrate / 40; 
      if (this.tokenBucketBytes < maxDebt) {
        this.tokenBucketBytes = maxDebt;
      }
      this.lastTokenUpdate = now;
    }

    const frameInterval = 1000 / this.currentFps;
    if (now - this.lastFrameTime >= frameInterval) {
      const { bufferedAmount } = this.getNetworkMetrics();
      const queueBytes = this.sendQueue.reduce((acc, q) => acc + q.data.length, 0);
      // Attempt 9: Increased Internal Queue Panic (60 frames)
      const isInternalQueuePanic = this.sendQueue.length > 60 || queueBytes > 512000;

      // resolution scaling
      this.currentScale = 1.0;

      const possessesTokens = this.tokenBucketBytes >= 0; // Task 17: Credit-based (allow until 0)

      if (bufferedAmount > 500000 || isInternalQueuePanic || !possessesTokens) {
        this.droppedFrames++;
        this.droppedFramesWindow++;
        this.droppedFramesConsecutive++;
        if (this.droppedFramesConsecutive >= 3) this.needsKeyframe = true;
        this.lastFrameTime = now;

        // Attempt 9: Increased Buffer Thresholds
        const panicThreshold = 512000; // 500KB
        if ((isInternalQueuePanic || bufferedAmount > panicThreshold) && now - this.lastCongestionTs > this.congestionCooldown) {
          if (this.onLog) {
            this.onLog(`🚨 Congestion Panic: qLen=${this.sendQueue.length}, wsBuf=${Math.round(bufferedAmount / 1024)}KB, soft reset!`);
          }
          this.sendQueue = [];

          // Attempt 7: Softened Congestion Panic (20KB reserve)
          this.tokenBucketBytes = 20480;

          // Attempt 7: Panic Bitrate Cut
          this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
          this.applyBitrateToParams();
          this.aiState = 'congested';
          this.lastCongestionTs = now;
        }
      } else {
        this.lastFrameTime = now;
        const success = await this.processFrame(now);
        if (success) this.droppedFramesConsecutive = 0;
      }
    }

    if (now - this.droppedWindowStart >= 1000) {
      this.droppedFramesRate = this.droppedFramesWindow;
      this.droppedFramesWindow = 0;
      this.droppedWindowStart = now;

      const kbps = Math.round((this.bytesSentThisSecond * 8) / 1024);
      this.bytesSentThisSecond = 0;

      if (this.onLog && this.isRunning) {
        const queueBytes = this.sendQueue.reduce((acc, q) => acc + q.data.length, 0);
        this.onLog(`📤 Send rate: ${kbps} kbps, buffer: ${this.sendQueue.length} frames (${Math.round(queueBytes / 1024)}KB), tokens=${Math.round(this.tokenBucketBytes / 1024)}KB`);
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private runPacer(now: number) {
    if (this.sendQueue.length > 0 && this.onLog && now - this.lastPacerLog > 1000) {
      this.onLog(`🏃 Pacer: queue=${this.sendQueue.length}, tokens=${Math.round(this.pacerTokens)}`);
      this.lastPacerLog = now;
    }

    if (this.sendQueue.length === 0 || this.ws?.readyState !== WebSocket.OPEN) return;

    const pacerDeltaMs = now - this.lastPacerRun;
    if (pacerDeltaMs <= 0) return;
    this.lastPacerRun = now;

    const bytesPerMs = (this.targetBitrate / 8) / 1000;
    const maxPacerBurst = Math.max(5000, bytesPerMs * 100); 
    const multiplier = this.sendQueue.length > 10 ? 1.8 : 1.1; // ВОЗВРАЩАЕМ ПЛАВНОСТЬ
    this.pacerTokens = Math.min(maxPacerBurst, this.pacerTokens + (bytesPerMs * multiplier) * pacerDeltaMs);

    let bytesSentThisTick = 0;
    const MAX_BYTES_PER_TICK = 131072;

    while (this.sendQueue.length > 0 && this.pacerTokens >= 0 && bytesSentThisTick < MAX_BYTES_PER_TICK) {
      const chunk = this.sendQueue[0].data;
      this.ws.send(chunk);
      this.pacerTokens -= chunk.length;
      this.bytesSentThisSecond += chunk.length;
      bytesSentThisTick += chunk.length;
      this.sendQueue.shift();
    }
  }

  private async processFrame(now: number): Promise<boolean> {
    if (this.onLog && this.frameId % 300 === 0) {
      this.onLog(`🎬 processFrame: pending=${this.pendingFrames}, queue=${this.sendQueue.length}, state=${this.aiState}`);
    }

    if (this.pendingFrames > 6 || this.video.paused || this.video.ended || this.video.readyState < 2) {
      if (this.onLog && this.frameId % 300 === 0 && this.pendingFrames > 6) {
        this.onLog(`⚠️ processFrame skipped: too many pending frames (${this.pendingFrames})`);
      }

      // Attempt 8: Encoder Watchdog Reset
      if (this.pendingFrames > 0 && now - this.lastEncodeTs > 2000) {
        if (this.onLog) this.onLog(`🚨 Encoder HANG detected (2s timeout), performing full reset!`);
        this.handleEncoderError(); // This performs reset
        this.lastEncodeTs = now;
      }

      return false;
    }
    if (!this.encoder) {
      this.initEncoder();
      if (!this.encoder) return false;
    }

    try {
      const timestamp = Math.round(performance.now() * 1000);
      const frame = new VideoFrame(this.video, { timestamp });

      const inputW = frame.displayWidth;
      const inputH = frame.displayHeight;
      const finalScale = this.currentScale;

      const targetW = Math.floor((inputW * finalScale) / 2) * 2;
      const targetH = Math.floor((inputH * finalScale) / 2) * 2;

      if (!this.isConfigured || targetW !== this.currentWidth || targetH !== this.currentHeight) {
        this.configureEncoder(targetW, targetH);
      }

      // Task 17: Don't force keyframe if congested (saves bits)
      if (this.frameId % 60 === 0 && this.aiState !== 'congested') {
        this.needsKeyframe = true;
      }

      // Attempt 5: Increased encodeQueueSize limit
      if (this.encoder.encodeQueueSize > 4) {
        frame.close();
        return false;
      }

      this.pendingFrames++;
      this.encoder.encode(frame, { keyFrame: this.needsKeyframe || this.frameId === 0 });
      this.needsKeyframe = false;
      frame.close();
      return true;
    } catch (e) {
      return false;
    }
  }
}
