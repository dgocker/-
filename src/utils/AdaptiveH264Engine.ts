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
        cryptoWorkerInitPromise = null; // FIX: allow retry
        reject(err);
      };
    } catch (e) {
      cryptoWorkerReady = false;
      cryptoWorkerInitPromise = null; // FIX: allow retry
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

  private targetBitrate: number = 600_000;
  private lastConfiguredBitrate: number = 0;
  private lastConfiguredTs: number = 0;
  private minBitrate: number = 80_000;    // FIX: iOS WebCodecs freezes silently at <60k. 80k is safe floor.
  private maxBitrate: number = 2_500_000; // Было 4_000_000
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
  private realFps: number = 0;
  private framesProcessedThisSecond: number = 0;

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
  private lastBufferedAmount: number = 0;
  private bufferedGradient: number = 0;
  private lastPendingReset: number = performance.now(); // FIX: Watchdog refinement

  // PI Controller for RTT-based adaptation
  private rttTarget = 150; // target RTT in ms
  private errorIntegral = 0;
  private lastRttUpdateTs = 0;
  private readonly KP = 0.5;   // Proportional gain
  private readonly KI = 0.2;   // Integral gain
  private readonly MAX_INTEGRAL = 5000;

  // New GCC-inspired metrics
  private delayTrend: number = 0;
  private readonly OVERUSE_THRESHOLD: number = 10; // Было 80
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
    if (this.encoder) {
      try {
        this.encoder.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    try {
      this.encoder = new VideoEncoder({
        output: (chunk, metadata) => {
          const startTime = performance.now();
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          // Делегируем в отдельный метод, чтобы не блокировать поток энкодера
          this.processEncodedFrame(data, startTime);
        },
        error: (e) => {
          if (this.onLog) this.onLog(`❌ VideoEncoder error: ${e.message}`);
          this.handleEncoderError();
        }
      });
    } catch (e) {
      if (this.onLog) this.onLog(`❌ Encoder init exception: ${e}`);
      setTimeout(() => {
        if (this.isRunning && !this.encoder) this.initEncoder();
      }, 1000);
    }
  }

  // === ДОБАВЛЯЕМ МЕТОД ИЗ ТЕСТА ===
  private async processEncodedFrame(data: Uint8Array, startTime: number) {
    if (data.length > 250000) {
      if (this.onLog) this.onLog(`🚨 CRITICAL: Frame size too large (${Math.round(data.length / 1024)}KB). Dropping to prevent buffer bloat.`);
      this.needsKeyframe = true;
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.4);
      this.applyBitrateToParams();
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
      return;
    }

    try {
      let finalData: Uint8Array = data;
      if (this.onLog && this.frameId % 30 === 0) this.onLog(`✅ Encoded frame ${this.frameId} (size=${data.length})`);

      this.tokenBucketBytes -= data.length;
      this.lastEncodeTs = performance.now();

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

      this.encodeDurationLog.push(performance.now() - startTime);
      if (this.encodeDurationLog.length > 30) this.encodeDurationLog.shift();

    } catch (e) {
      if (this.onLog) this.onLog(`❌ VideoEncoder output processing error: ${e}`);
    } finally {
      this.pendingFrames = Math.max(0, this.pendingFrames - 1);
    }
  }

  private handleEncoderError() {
    if (this.isRecovering) return;
    this.isRecovering = true;
    this.pendingFrames = 0;

    setTimeout(async () => {
      try {
        if (this.encoder) { this.encoder.close(); this.encoder = null; }
        this.isConfigured = false;
        this.initEncoder();
        this.isRecovering = false;
      } catch (err) {
        this.isRecovering = false;
      }
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
        bitrateMode: 'variable',
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

    // FIX: I-Frame Storm Mitigation. Enforce 10s cooldown between configurations!
    // Changing resolutions forces huge I-Frames, which destroy ultra-low bitrate networks.
    const now = performance.now();
    if (now - this.lastConfiguredTs < 10000) return; 

    const kbps = this.targetBitrate / 1024;
    
    // Динамическое понижение FPS и разрешения при экстремальном падении
    if (kbps < 100) {
      this.currentFps = 5; // Слайдшоу для выживания
      this.currentScale = 0.2; // Сильное мыло, но сеть не упадет
    } else if (kbps < 300) {
      this.currentFps = 10;
      this.currentScale = 0.3;
    } else if (kbps < 600) {
      this.currentFps = 15;
      this.currentScale = 0.5;
    } else if (kbps < 1200) {
      this.currentFps = 24;
      this.currentScale = 0.75;
    } else {
      this.currentFps = 30;
      this.currentScale = this.lastSmoothedRtt > 800 ? 0.75 : 1.0;
    }

    // Применяем настройки только если битрейт изменился значимо
    const diffRatio = Math.abs(this.targetBitrate - this.lastConfiguredBitrate) / (this.lastConfiguredBitrate || 1);
    
    // FIX: Only trigger reconfiguration flag here to prevent double-configuration and I-Frame storm.
    // The actual configure is safely done in processFrame(), which prevents the recursive storm.
    if (diffRatio >= 0.25 || (this.targetBitrate < 100000 && diffRatio >= 0.15)) {
      this.lastConfiguredBitrate = this.targetBitrate;
      this.lastConfiguredTs = now; 
      
      this.isConfigured = false; 
    }
  }

  private updateCongestionControl() {
    if (this.manualMode) return;

    const now = performance.now();
    const metrics = this.getNetworkMetrics();
    const buffered = metrics.bufferedAmount;

    const dt = Math.max(1, now - this.lastCongestionUpdate);
    if (dt > 100) {
      const currentGradient = (buffered - this.lastBufferedAmount) / dt;
      this.bufferedGradient = this.bufferedGradient * 0.8 + currentGradient * 0.2;
      this.lastBufferedAmount = buffered;
      this.lastCongestionUpdate = now;
    }

    const queueDelay = this.sendQueue.length > 0 ? now - this.sendQueue[0].enqueueTime : 0;

    // FIX: Снижаем допустимый лимит буфера для штрафа до 16 КБ (защита от OS Bufferbloat)
    const maxWsBuffer = Math.max(16384, (this.targetBitrate / 8) * 0.5);
    const bufferPressure = Math.min(1.0, buffered / maxWsBuffer);
    if (bufferPressure > 0.3) {
      const penalty = (bufferPressure - 0.3) * 0.6;
      this.targetBitrate *= (1.0 - penalty);
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate);
    }

    let stateChanged = false;
    const oldBitrate = this.targetBitrate;

    const isBufferGrowing = this.bufferedGradient > 0.5 && buffered > 50000;

    // Четкое условие перегрузки: доверяем RTT
    const isOveruse = this.delayTrend > 20 || isBufferGrowing || this.lastSmoothedRtt > 600;

    if (isOveruse) {
      if (this.aiState !== 'congested' || now - this.lastCongestionTs > 1000) {
        this.aiState = 'congested';
        // Multiplicative Decrease: Жестко рубим
        const cutFactor = this.lastSmoothedRtt > 1000 ? 0.6 : 0.8;
        this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * cutFactor);
        this.lastCongestionTs = now;
        stateChanged = true;
      }
    } else {
      // Состояния recovery больше нет! Ждем 1.5 сек после пробки и переходим в steady
      if (this.aiState === 'congested' && now - this.lastCongestionTs > 1500) {
        this.aiState = 'steady';
        stateChanged = true;
      }

      if (this.aiState === 'steady') {
        if (now - this.lastSteadyIncrease > 500) {
          // Additive Increase: Линейный рост по 5-15 кбит/с (НЕ умножение)
          const growth = this.lastSmoothedRtt < 150 ? 15000 : 5000;
          this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate + growth);
          this.lastSteadyIncrease = now;
        }

        if (!this.isProbing && now - this.probingStartTs > 12000) {
          this.isProbing = true;
          this.probingStartTs = now;
        }

        if (this.isProbing) {
          if (now - this.probingStartTs < 250) {
            this.targetBitrate = Math.min(this.maxBitrate, oldBitrate * 1.10); // Максимум +10%
          } else {
            this.isProbing = false;
            this.probingStartTs = now;
          }
        }
      }
    }

    if (Math.abs(this.targetBitrate - oldBitrate) > 5000 || stateChanged) {
      this.applyBitrateToParams();
    }
  }

  public updateRTT(rtt: number) {
    const now = performance.now();
    this.lastRtt = rtt;

    // Экстренный тормоз: доверяем RTT. Если пинг > 1200мс (для мобилок это край), режем битрейт.
    if (rtt > 1200 && now - this.lastCongestionTs > 1000) {
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
      // FIX: DO NOT clear sendQueue here! Clearing queue loses I-frames, inducing requestKeyframe storms.
      this.applyBitrateToParams();
      this.aiState = 'congested';
      this.lastCongestionTs = now;
      if (this.onLog) this.onLog(`🚨 RTT Panic (${Math.round(rtt)}ms): Halving bitrate to ${Math.round(this.targetBitrate / 1024)}k`);
    }

    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();

    const sorted = [...this.rttHistory].sort((a, b) => a - b);
    let medianRtt = sorted[Math.floor(sorted.length / 2)];

    // Ограничиваем сверху, но не сбрасываем историю!
    const clampedRtt = Math.min(medianRtt, 3000);

    const prevSmoothed = this.lastSmoothedRtt || clampedRtt;
    if (clampedRtt < prevSmoothed) {
      this.lastSmoothedRtt = prevSmoothed * 0.5 + clampedRtt * 0.5; // Быстрая реакция на улучшение
    } else {
      this.lastSmoothedRtt = prevSmoothed * 0.8 + clampedRtt * 0.2; // Плавная реакция на ухудшение
    }

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
      fps: this.realFps,
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
    this.targetBitrate = 600_000;
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

    // Reset ABR and PI controller state
    this.errorIntegral = 0;
    this.rttHistory = [];
    this.lastSmoothedRtt = 0;
    this.lastRttSmoothed = 0;
    this.delayTrend = 0;
    this.tokenBucketBytes = (500_000 / 8) * 0.2;

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
      const maxBurst = (this.targetBitrate / 8) * 0.5;
      this.tokenBucketBytes = Math.min(this.tokenBucketBytes + tokensToAdd, maxBurst);

      // СТАЛО (разрешаем уходить в минус на размер 4 секундного битрейта, чтобы I-кадры не сталлили движок на старте):
      const maxDebt = -(this.targetBitrate / 8) * 4; 
      if (this.tokenBucketBytes < maxDebt) {
        this.tokenBucketBytes = maxDebt;
      }
      this.lastTokenUpdate = now;
    }

    // Watchdog for pending frames to prevent permanent freeze (ИЗ ТЕСТА)
    if (this.pendingFrames > 0 && now - this.lastPendingReset > 1500) {
      if (this.onLog) this.onLog(`🚨 Watchdog: Encoder stuck with ${this.pendingFrames} frames. Force resetting encoder...`);
      this.handleEncoderError();
      this.lastPendingReset = now;
    }

    const frameInterval = 1000 / this.currentFps;
    if (now - this.lastFrameTime >= frameInterval) {
      // ИСПРАВЛЕНИЕ rAF
      if (now - this.lastFrameTime > frameInterval * 2) {
        this.lastFrameTime = now;
      } else {
        this.lastFrameTime += frameInterval;
      }

      const { bufferedAmount } = this.getNetworkMetrics();
      const queueBytes = this.sendQueue.reduce((acc, q) => acc + q.data.length, 0);
      // FIX: Increase queue panic thresholds. 200 frames is ~8s of 24fps data.
      const isInternalQueuePanic = this.sendQueue.length > 200 || queueBytes > 5120000;

      // Resolution scaling based on bitrate is now handled in applyBitrateToParams


      const maxWsBuffer = Math.max(16384, (this.targetBitrate / 8) * 1.5);
      if (bufferedAmount > maxWsBuffer || isInternalQueuePanic) {
        this.droppedFrames++;
        this.droppedFramesWindow++;
        this.droppedFramesConsecutive++;
        if (this.droppedFramesConsecutive >= 3) this.needsKeyframe = true;

        if ((isInternalQueuePanic || bufferedAmount > maxWsBuffer * 1.5) && now - this.lastCongestionTs > this.congestionCooldown) {
          if (this.onLog) {
            this.onLog(`🚨 Congestion Panic: qLen=${this.sendQueue.length}, wsBuf=${Math.round(bufferedAmount / 1024)}KB, soft reset!`);
          }
          this.sendQueue = [];
          this.tokenBucketBytes = 20000;
          this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
          this.applyBitrateToParams();
          this.aiState = 'congested';
          this.lastCongestionTs = now;
        }
      } else {
        const success = await this.processFrame(now);
        if (success) {
          this.framesProcessedThisSecond++;
          this.droppedFramesConsecutive = 0;
          this.lastPendingReset = now; // ✅ КРИТИЧЕСКИ ВАЖНО: сброс таймера зависания
        }
      }
    }

    if (now - this.droppedWindowStart >= 1000) {
      this.realFps = this.framesProcessedThisSecond;
      this.framesProcessedThisSecond = 0;
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

    // Снижаем максимальный Burst (залп) до 30-40 мс (что примерно равно 1 кадру при 24 fps).
    // Это сделает отправку по сети максимально "ровной" струйкой.
    const maxPacerBurst = Math.max(2000, bytesPerMs * 30); // Запас на 30мс

    // СТАЛО (убираем ускорение, вводим легкое торможение при заторе):
    const multiplier = this.sendQueue.length > 30 ? 0.9 : 1.0;

    this.pacerTokens = Math.min(maxPacerBurst, this.pacerTokens + (bytesPerMs * multiplier) * pacerDeltaMs);

    let bytesSentThisTick = 0;
    // Снижаем лимит на один цикл таймера (разгружаем Event Loop и сокет)
    const MAX_BYTES_PER_TICK = 16384; 

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

    // FIX: Enforce Strict Token Bucket. If we have no tokens, skip encoding to naturally drop FPS
    // Always allow I-frames or at least 1 frame per second to keep connection alive
    const forceAlive = this.frameId === 0 || this.needsKeyframe || this.frameId % 30 === 0;
    if (this.tokenBucketBytes <= 0 && !forceAlive) {
      return false; // rate limiting!
    }

    if (this.pendingFrames > 8 || this.video.paused || this.video.ended || this.video.readyState < 3 || this.video.videoWidth === 0) {
      if (this.onLog && this.frameId % 300 === 0 && this.pendingFrames > 6) {
        this.onLog(`⚠️ processFrame skipped: too many pending frames (${this.pendingFrames})`);
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
      if (this.frameId % 90 === 0 && this.aiState !== 'congested') {
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
