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
  private firstFrameFed: boolean = false;
  private isConfigured: boolean = false;

  private aiState: 'steady' | 'hold' | 'congested' | 'recovery' = 'steady';
  private lastRttSmoothed: number = 0;
  private readonly SMOOTHING_ALPHA = 0.1;

  private lastCongestionTs: number = 0;
  private readonly congestionCooldown: number = 1000;

  private pacerTokens: number = 0;
  private lastPacerTick: number = 0;
  private lastPacerRun: number = performance.now();

  private targetBitrate: number = 600_000;
  private lastConfiguredBitrate: number = 0;
  private lastConfiguredTs: number = 0;
  // Жесткий лимит безопасности для аппаратных энкодеров Apple/Android
  private minBitrate: number = 150_000;
  private maxBitrate: number = 3_000_000; // Raised for 50Mbps support
  private tokenBucketBytes: number = (500_000 / 8) * 0.2;
  private lastTokenUpdate: number = performance.now();
  private lastEncodeTs: number = performance.now(); // Watchdog tracking
  private sessionStartTime: number = performance.now();

  private sendQueue: { data: Uint8Array; enqueueTime: number }[] = [];
  private frameId: number = 0;
  private timerId: any = null; // Support for setInterval
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
  private lastKeyframeSentTs: number = 0;
  private readonly KEYFRAME_COOLDOWN = 2000;
  private readonly CONGESTION_UPDATE_INTERVAL: number = 200; // Быстрая реакция (5 раз в сек)

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
  private lastRemoteJitter: number = 0;

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

          // ✅ ПРАВКА 1: Уменьшаем pendingFrames СРАЗУ! 
          // Кодек свою работу сделал, он не виноват, если дальше шифрование займет время.
          this.pendingFrames = Math.max(0, this.pendingFrames - 1);

          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          // Task 17 Refined: Don't drop large I-frames. Raised to 1.5MB for 1080p high-quality.
          if (data.length > 1500000) {
            if (this.onLog) this.onLog(`\u26A0\uFE0F Frame too large (${Math.round(data.length / 1024)}KB), dropping`);
            // Здесь больше не нужен this.pendingFrames--, мы сделали это выше
            return;
          }
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
    if (data.length > 1500000) {
      if (this.onLog) this.onLog(`🚨 CRITICAL: Frame size too large (${Math.round(data.length / 1024)}KB). Dropping to prevent buffer bloat.`);
      this.needsKeyframe = true;
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.4);
      this.applyBitrateToParams();
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
        // FIX: Hardware safety (Task 29). Some Androids hang if bitrate is too low.
        // Set configuration floor to 150k; Pacer will still limit output to minBitrate.
        bitrate: Math.max(150000, this.targetBitrate),
        bitrateMode: 'variable',
        latencyMode: "realtime",
        // @ts-ignore
        // Phase 2: Infinite GOP (3000s) to prevent periodic 1.5MB I-frame spikes blocking the TCP pipe.
        avc: { format: "annexb", key_frame_interval: 3000 }
      });
      this.currentWidth = width;
      this.currentHeight = height;
      this.isConfigured = true;
      this.needsKeyframe = true;

      // ✅ ПРАВКА: Сбрасываем счетчик, так как аппаратный чип уничтожил старые кадры при реконфигурации
      this.pendingFrames = 0;

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

  private applyBitrateToParams(force: boolean = false) {
    if (!this.encoder || !this.isConfigured) return;

    // FIX: I-Frame Storm & Encoder Hang Mitigation (Task 25).
    // Changing resolutions forces huge I-Frames and can hang Android hardware.
    // Даем энкодеру минимум 3 секунды на то, чтобы прийти в себя после смены качества
    const now = performance.now();
    if (!force && now - this.lastConfiguredTs < 3000) return;

    const kbps = this.targetBitrate / 1024;

    // ✅ ИСПРАВЛЕНИЕ: Добавляем "гистерезис" (запас хода), 
    // чтобы разрешение не прыгало туда-сюда при битрейте вокруг 200kbps.
    if (kbps < 180) {
      this.currentFps = 15; 
      this.currentScale = 0.5; // Уверенно плохая сеть -> 360p
    } else if (kbps > 250) {
      this.currentFps = 30;
      this.currentScale = 1.0; // Уверенно хорошая сеть -> 720p
    }
    // Если kbps болтается между 180 и 250, МЫ НИЧЕГО НЕ МЕНЯЕМ. 
    // Остается тот масштаб, который был. Это спасет iPhone от зависания.

    // Применяем настройки только если битрейт изменился значимо (40%) или масштаб изменился
    const diffRatio = Math.abs(this.targetBitrate - this.lastConfiguredBitrate) / (this.lastConfiguredBitrate || 1);

    if (diffRatio >= 0.4 || !this.isConfigured) {
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
    // Phase 3: Higher RTT tolerance for mobile (1000ms instead of 600ms).
    const isHighRtt = this.lastSmoothedRtt > 1000;
    const isOveruse = this.delayTrend > 25 || isBufferGrowing || isHighRtt;

    if (isOveruse) {
      if (this.aiState !== 'congested' || now - this.lastCongestionTs > 300) {
        this.aiState = 'congested';
        // Dynamic cut factor
        let cutFactor = 0.85;
        if (this.lastSmoothedRtt > 1500) cutFactor = 0.6;
        if (this.lastSmoothedRtt > 3000) cutFactor = 0.3;

        this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * cutFactor);
        this.lastCongestionTs = now;
        stateChanged = true;
      }
    } else {
      // Выход из пробки только если пинг упал ниже 400 и прошло 1.5 секунды
      if (this.aiState === 'congested' && now - this.lastCongestionTs > 1500 && this.lastSmoothedRtt < 400) {
        this.aiState = 'steady';
        stateChanged = true;
      }

      if (this.aiState === 'steady' && this.lastSmoothedRtt < 900) {
        if (now - this.lastSteadyIncrease > 400) {
          // Phase 3: Exponential growth (+10%) to leverage 50Mbps links quickly
          const growth = this.targetBitrate * 0.10;
          this.targetBitrate = Math.min(this.maxBitrate, this.targetBitrate + Math.max(20000, growth));
          this.lastSteadyIncrease = now;
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

    // Жёсткое ограничение битрейта сверху
    this.targetBitrate = Math.min(this.targetBitrate, this.maxBitrate);

    if (Math.abs(this.targetBitrate - oldBitrate) > 5000 || stateChanged) {
      this.applyBitrateToParams();
    }
  }

  public updateRTT(rtt: number) {
    const now = performance.now();
    this.lastRtt = rtt;

    // Экстренный тормоз: доверяем RTT. Если пинг > 2500мс.
    // FIX: Режем только на 25% (0.75), так как на скоростном интернете это чаще всего временный Bufferbloat от наших же данных, а не смерть сети.
    if (rtt > 2500 && now - this.lastCongestionTs > 500) {
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.75);
      // FIX: На время жесткой паники запрещаем Pacer-у слать что-либо, но без глубоких минусов.
      this.pacerTokens = Math.max(-5000, this.pacerTokens);
      this.tokenBucketBytes = 40000; // Reset debt to allow restart! (Task 27)

      this.applyBitrateToParams();
      this.aiState = 'congested';
      this.lastCongestionTs = now;
      if (this.onLog) this.onLog(`🚨 RTT Panic (${Math.round(rtt)}ms): Dropping to ${Math.round(this.targetBitrate / 1024)}k and pausing Pacer`);
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

  public updateRemoteJitter(jitter: number) {
    this.lastRemoteJitter = jitter;

    // Если пакеты начали приходить неравномерно (jitter > 1500мс),
    // значит буферы маршрутизаторов переполняются, скоро начнется дроп пакетов.
    if (jitter > 1500 && this.aiState !== 'congested') {
      if (this.onLog) this.onLog(`⚠️ Высокий Jitter (${Math.round(jitter)}ms): превентивное снижение битрейта`);

      this.aiState = 'congested';
      this.lastCongestionTs = performance.now();
      // Срезаем битрейт на 20%, не дожидаясь паники по RTT
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.8);
      this.applyBitrateToParams();
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
      this.targetBitrate = Math.min(bitrate, this.maxBitrate);

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
    if (this.onLog) this.onLog(`🔥 ЗАПУСК ENGINE: ВЕРСИЯ С ANTI-DPI И MIN BITRATE 150k`);
    const now = performance.now();
    this.sessionStartTime = now;
    this.lastPacerRun = performance.now();

    // Switch to setInterval to prevent browser freezing in background tabs
    this.timerId = setInterval(() => {
      this.loop().catch(() => { });
    }, 1000 / 30); // Target 30fps baseline

    // (Рекурсивный таймаут для джиттеринга 10-35мс)
    const pacerLoop = () => {
      if (!this.isRunning) return;
      this.runPacer();
      this.pacerInterval = setTimeout(pacerLoop, 10 + Math.random() * 25);
    };
    pacerLoop();
    this.lastAIUpdate = now;
    this.lastTokenUpdate = now;
    this.lastCongestionTs = 0;
    this.aiState = 'steady';
    this.targetBitrate = 400_000; // Безопасный старт без перегрузки роутера. Алгоритм сам поднимет до 1+ Mbps через пару секунд.
    this.frameId = 0;
    this.applyBitrateToParams();
    if (this.onLog) this.onLog(`\uD83D\uDE80 Sender started: Probing mode (1Mbps start), GOP=Infinite`);
  }

  public async stop() {
    this.isRunning = false;
    this.sendQueue = [];
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    if (this.pacerInterval) clearTimeout(this.pacerInterval);
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
    this.firstFrameFed = false;
  }

  public isRunningNow() {
    return this.isRunning;
  }

  public forceKeyframe() {
    const now = performance.now();
    if (now - this.lastKeyframeSentTs > this.KEYFRAME_COOLDOWN) {
      this.needsKeyframe = true;
    }
  }

  private loop = async () => {
    if (!this.isRunning) return;
    const now = performance.now();
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.lastFrameTime = now;
      this.lastTokenUpdate = now;
      return;
    }

    this.updateCongestionControl();

    // Reset keyframe flag if within cooldown to prevent storm
    if (this.needsKeyframe && now - this.lastKeyframeSentTs < this.KEYFRAME_COOLDOWN) {
      if (this.frameId % 30 === 0 && this.onLog) {
        this.onLog(`🛡️ Keyframe suppressed (cooldown: ${Math.round(this.KEYFRAME_COOLDOWN - (now - this.lastKeyframeSentTs))}ms remaining)`);
      }
      this.needsKeyframe = false;
    }

    const timeDeltaMs = now - this.lastTokenUpdate;
    if (timeDeltaMs > 0) {
      const tokensToAdd = (this.targetBitrate / 8) * (timeDeltaMs / 1000);
      const maxBurst = (this.targetBitrate / 8) * 0.5;
      this.tokenBucketBytes = Math.min(this.tokenBucketBytes + tokensToAdd, maxBurst);

      // СТАЛО (разрешаем уходить в минус на размер 4 секундного битрейта, чтобы I-кадры не сталлили движок на старте):
      const maxDebt = Math.max(-100000, -(this.targetBitrate / 8) * 4);
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

      // FIX: Умный сброс очереди. Нельзя делать slice массива фрагментов, это ломает H.264 кадр!
      // Если очередь слишком большая, сбрасываем её полностью
      if (this.sendQueue.length > 2000) {
        if (this.onLog) this.onLog(`🚨 Queue panic: queue too large (${this.sendQueue.length} parts). Soft reset.`);

        this.sendQueue = []; // Очищаем полностью
        this.pacerTokens = Math.max(0, this.pacerTokens); // Сбрасываем долг пейсера, чтобы сразу слать

        // Режем битрейт не так радикально (на 30%, а не на 50%)
        this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.7);
        this.applyBitrateToParams(true);

        // МЫ ОБЯЗАНЫ запросить Keyframe, т.к. старые кадры удалены!
        // Но уважаем кулдаун, чтобы не убить процессор.
        if (now - this.lastKeyframeSentTs > this.KEYFRAME_COOLDOWN) {
          this.needsKeyframe = true;
        }
      }

      const isInternalQueuePanic = this.sendQueue.length > 2000 || queueBytes > 5120000;

      // Resolution scaling based on bitrate is now handled in applyBitrateToParams


      // FIX: Увеличиваем толерантность буфера, чтобы он мог вместить хотя бы один полный I-кадр без паники
      const maxWsBuffer = Math.max(32768, (this.targetBitrate / 8) * 2.5);

      if (bufferedAmount > maxWsBuffer || isInternalQueuePanic) {
        this.droppedFrames++;
        this.droppedFramesWindow++;
        this.droppedFramesConsecutive++;

        // Запрашиваем новый Keyframe только если мы не в кулдауне
        if (this.droppedFramesConsecutive >= 3 && now - this.lastKeyframeSentTs > this.KEYFRAME_COOLDOWN) {
          this.needsKeyframe = true;
        }

        if ((isInternalQueuePanic || bufferedAmount > maxWsBuffer * 1.5) && now - this.lastCongestionTs > this.congestionCooldown) {
          if (this.onLog) {
            this.onLog(`🚨 Congestion Panic: qLen=${this.sendQueue.length}, wsBuf=${Math.round(bufferedAmount / 1024)}KB. Slashing bitrate!`);
          }

          // ❌ УДАЛЕНО: this.sendQueue = []; <-- ЭТО УБИВАЛО КАДРЫ!
          // Оставляем очередь в покое, Пейсер сам её разгребет.

          this.tokenBucketBytes = 20000;
          // Режем битрейт для БУДУЩИХ кадров, чтобы разгрузить сеть
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
  };

  private runPacer() {
    const now = performance.now();
    if (this.lastPacerTick === 0) this.lastPacerTick = now;
    const deltaMs = now - this.lastPacerTick;
    this.lastPacerTick = now;

    if (deltaMs <= 0) return;

    const bytesPerMs = (this.targetBitrate / 8) / 1000;
    let currentBytesPerMs = bytesPerMs;

    // 🚀 АНТИ-УДУШЬЕ СОХРАНЕНО (Dynamic Boost)
    if (this.sendQueue.length > 20) currentBytesPerMs = bytesPerMs * 1.5;
    if (this.sendQueue.length > 50) currentBytesPerMs = bytesPerMs * 3.0;
    if (this.sendQueue.length > 100) currentBytesPerMs = bytesPerMs * 5.0;

    // ✅ ПРЕДОХРАНИТЕЛЬ ОТ 10-СЕКУНДНОЙ ЗАДЕРЖКИ (Ограничиваем Форсаж)
    currentBytesPerMs = Math.min(currentBytesPerMs, 875);

    const tokensPerTick = currentBytesPerMs * deltaMs;
    this.pacerTokens += tokensPerTick;

    const maxPacerBurst = Math.max(15000, currentBytesPerMs * 40);

    // ✅ ДАЕМ ПЕЙСЕРУ ДЫШАТЬ ПОСЛЕ I-FRAMES (Долг до 100 КБ)
    const maxPacerDebt = -100000;

    if (this.pacerTokens > maxPacerBurst) {
      this.pacerTokens = maxPacerBurst;
    }

    let bytesSentThisTick = 0;

    // 🎲 Burst Randomization: Рандомизируем размер отправки за такт
    const MAX_BYTES_PER_TICK = 32000 + Math.floor(Math.random() * 64000);

    while (this.sendQueue.length > 0 && this.pacerTokens > 0 && bytesSentThisTick < MAX_BYTES_PER_TICK) {
      const packet = this.sendQueue.shift()!;
      this.ws.send(packet.data);
      this.pacerTokens -= packet.data.length;
      bytesSentThisTick += packet.data.length;

      // Не забываем счетчик для логов
      this.bytesSentThisSecond += packet.data.length;
    }

    if (this.pacerTokens < maxPacerDebt) {
      this.pacerTokens = maxPacerDebt;
    }
  }

  private async processFrame(now: number): Promise<boolean> {
    if (this.onLog && this.frameId % 300 === 0) {
      this.onLog(`🎬 processFrame: pending=${this.pendingFrames}, queue=${this.sendQueue.length}, state=${this.aiState}`);
    }

    // FIX: Removed strict encoding skip (Task 30). 
    // It was causing sudden FPS drops. Now we let the Pacer handle it via queue pruning.

    const maxPending = 30;
    if (this.pendingFrames > maxPending || this.video.paused || this.video.ended || this.video.readyState < 3 || this.video.videoWidth === 0) {
      if (this.onLog && this.frameId % 300 === 0 && this.pendingFrames > (maxPending - 2)) {
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

      // Синхронный контроль первого кадра
      if (!this.firstFrameFed) {
        this.needsKeyframe = true;
      }

      // Attempt 5: Increased encodeQueueSize limit for high-FPS support
      if (this.encoder.encodeQueueSize > 10) {
        frame.close();
        return false;
      }

      const isKey = this.needsKeyframe || !this.firstFrameFed;
      if (isKey) {
        this.lastKeyframeSentTs = now;
      }

      this.pendingFrames++;
      this.encoder.encode(frame, { keyFrame: isKey });
      this.firstFrameFed = true; // Устанавливаем флаг строго синхронно!
      this.needsKeyframe = false;
      frame.close();
      return true;
    } catch (e) {
      return false;
    }
  }

  public triggerBackpressure(bufferedAmount: number) {
    if (this.onLog) this.onLog(`🚨 Backpressure received: server buffer=${Math.round(bufferedAmount / 1024)}KB. Slashing bitrate.`);
    this.aiState = 'congested';
    this.lastCongestionTs = performance.now();
    this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.7);
    this.pacerTokens = Math.min(this.pacerTokens, 0);
    this.applyBitrateToParams(true);
  }
}
