import { obfuscateSplit } from './obfuscator';
import { encryptData } from './cryptoUtils';

let cryptoOpId = 0;


export class AdaptiveH264Engine {
  private video: HTMLVideoElement;
  private onFrame: (data: string) => void;
  private getNetworkMetrics: () => { rtt: number, bufferedAmount: number };
  private onLog?: (msg: string) => void;
  private ws: WebSocket;
  private sharedSecret: CryptoKey | null = null;
  private enableSafeTailDrop: boolean = true;
  private enableScalablePacing: boolean = true;

  // Crypto Worker (Moved from module level to instance level)
  private cryptoWorker: Worker | null = null;
  private cryptoWorkerReady = false;
  private cryptoOpId = 0;
  private pendingCryptoOps = new Map<number, { 
    resolve: (data: Uint8Array) => void; 
    reject: (err: Error) => void;
    data: Uint8Array;
    frameId: number;
  }>();
  
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
  private minBitrate: number = 300_000;
  private maxBitrate: number = 4_000_000;
  private tokenBucketBytes: number = (500_000 / 8) * 0.2; 
  private lastTokenUpdate: number = performance.now();
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
  private readonly CONGESTION_UPDATE_INTERVAL: number = 1000;
  
  // Gradient tracking for bufferedAmount (Phase 3)
  private lastBufferedAmount: number = 0;
  private bufferedGradient: number = 0;
  private lastCongestionUpdate: number = 0;
  private lastPendingReset: number = performance.now();

  private manualMode: boolean = false;
  private manualBitrate: number = 500_000;
  private lastAbrBitrate: number = 500_000;

  private totalQueueBytes: number = 0;

  // PI Controller for RTT-based adaptation (Phase 2.1)
  private readonly rttTarget = 150; 
  private readonly bufferTarget = 40000; 
  private errorIntegral = 0;
  private readonly KP = 0.6;   
  private readonly KI = 0.2;   
  private readonly MAX_INTEGRAL = 800000;
  private lastPiUpdateTs = 0; // Renamed to avoid collision

  // Network Metrics Tracking
  private rttHistory: number[] = [];
  private delayTrend: number = 0; 
  private lastUpdateTs = 0;
  private minRtt: number = Infinity;
  private lastError: number = 0; // Task: For incremental PI logic

  constructor(
    video: HTMLVideoElement, 
    onFrame: (data: string) => void,
    getNetworkMetrics: () => { rtt: number, bufferedAmount: number },
    ws: WebSocket,
    onLog?: (msg: string) => void,
    sharedSecret: CryptoKey | null = null,
    options?: { enableSafeTailDrop?: boolean, enableScalablePacing?: boolean }
  ) {
    this.video = video;
    this.onFrame = onFrame;
    this.getNetworkMetrics = getNetworkMetrics;
    this.ws = ws;
    this.onLog = onLog;
    this.sharedSecret = sharedSecret;
    this.enableSafeTailDrop = options?.enableSafeTailDrop ?? true;
    this.enableScalablePacing = options?.enableScalablePacing ?? true;
    
    if (sharedSecret) {
      this.initCryptoWorker().catch(err => {
        if (this.onLog) this.onLog(`\u26A0\uFE0F Crypto Worker init failed: ${err}`);
      });
    }
    this.initEncoder();
  }

  private initCryptoWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.cryptoWorker = new Worker(new URL('../workers/cryptoWorker.ts', import.meta.url), { type: 'module' });
        
        this.cryptoWorker.onmessage = (event) => {
          const { type, id, error } = event.data;
          
          if (type === 'KEY_READY') {
            this.cryptoWorkerReady = true;
            resolve();
          } else if (type === 'KEY_CLEARED') {
            this.cryptoWorkerReady = false;
          } else if (type === 'ENCRYPTED_VIDEO' || type === 'ENCRYPTED_AUDIO') {
            const pending = this.pendingCryptoOps.get(id);
            if (pending) {
              this.pendingCryptoOps.delete(id);
              try {
                const encrypted = new Uint8Array(event.data.data);
                const iv = event.data.iv ? new Uint8Array(event.data.iv) : new Uint8Array(0);
                const result = new Uint8Array(iv.length + encrypted.length);
                if (iv.length > 0) result.set(iv, 0);
                result.set(encrypted, iv.length);
                pending.resolve(result);
              } catch (e: any) {
                pending.reject(e);
              }
            }
          } else if (type === 'ERROR') {
            if (this.onLog) this.onLog(`\u274C Crypto Worker Error: ${error}`);
            const pending = this.pendingCryptoOps.get(id);
            if (pending) {
              this.pendingCryptoOps.delete(id);
              pending.reject(new Error(error || 'Unknown worker error'));
            }
          }
        };
        
        this.cryptoWorker.onerror = (err) => {
          this.cryptoWorkerReady = false;
          reject(err);
        };
        
        // Task: Actually send the INIT_KEY message!
        if (this.sharedSecret) {
          crypto.subtle.exportKey('raw', this.sharedSecret).then(raw => {
            this.cryptoWorker?.postMessage({
              type: 'INIT_KEY',
              keyData: raw
            });
          }).catch(err => reject(err));
        } else {
          resolve();
        }
      } catch (e) {
        this.cryptoWorkerReady = false;
        resolve(); 
      }
    });
  }

  private async encryptInWorker(key: CryptoKey, data: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
    if (!this.cryptoWorker || !this.cryptoWorkerReady) {
      return encryptData(key, data) as Promise<Uint8Array>;
    }
    
    return new Promise((resolve, reject) => {
      const id = ++this.cryptoOpId;
      
      // Fallback timeout: 500ms to avoid encoder hang
      const timeoutId = setTimeout(() => {
        if (this.pendingCryptoOps.has(id)) {
           this.pendingCryptoOps.delete(id);
            if (this.onLog) this.onLog(`🚨 Encryption Worker timeout (id=${id}), falling back to main thread`);
            encryptData(key, data).then(resolve).catch(reject);
        }
      }, 500);

      this.pendingCryptoOps.set(id, { 
        resolve: (val: Uint8Array) => { clearTimeout(timeoutId); resolve(val); }, 
        reject: (err: any) => { clearTimeout(timeoutId); reject(err); }, 
        data, 
        frameId: 0 
      });
      
      try {
        const payload = new Uint8Array(data).buffer;
        const ivBuffer = new Uint8Array(iv).buffer;
        this.cryptoWorker!.postMessage({
          type: 'ENCRYPT_VIDEO',
          payload: payload,
          iv: ivBuffer,
          id: id
        }, [payload, ivBuffer]);
      } catch (postError) {
        clearTimeout(timeoutId);
        this.pendingCryptoOps.delete(id);
        reject(postError);
        return;
      }
    });
  }

  private initEncoder() {
    try {
      this.encoder = new VideoEncoder({
        output: async (chunk, metadata) => {
          const startTime = performance.now();
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          
          const currentFrameId = this.frameId;
          
          try {
            if (this.onLog && currentFrameId % 30 === 0) {
              this.onLog(`✅ Encoded frame ${currentFrameId} (size=${data.length})`);
            }

            let finalData: Uint8Array = data;
            if (this.sharedSecret) {
              const iv = crypto.getRandomValues(new Uint8Array(12));
              finalData = await this.encryptInWorker(this.sharedSecret, data, iv).catch(err => {
                return encryptData(this.sharedSecret, data);
              });
            }
          
            const senderTs = Math.floor(performance.now() - this.sessionStartTime);
            const parts = await obfuscateSplit(finalData, currentFrameId, senderTs);
            
            // Increment frameId only after processing completes to ensure some sequentiality?
            // Actually, increment it in processFrame to be safer.
            // this.frameId++;
            for (const part of parts) {
              const u8Part = new Uint8Array(part);
              this.totalQueueBytes += u8Part.length;
              this.sendQueue.push({
                data: u8Part,
                enqueueTime: performance.now()
              });
            }
            
            this.encodeDurationLog.push(performance.now() - startTime);
            if (this.encodeDurationLog.length > 30) this.encodeDurationLog.shift();
            
            // Fixed: Subtract from token budget
            this.tokenBucketBytes -= finalData.length;
            this.pacerTokens -= finalData.length; // Keep them somewhat in sync
            
          } catch (e) {
             // 
          } finally {
            this.pendingFrames = Math.max(0, this.pendingFrames - 1);
            this.lastPendingReset = performance.now();
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
      } catch (err) {}
    }, 1000);
  }

  private configureEncoder(width: number, height: number) {
    if (!this.encoder || width === 0 || height === 0) return;
    
    try {
      this.encoder.configure({
        codec: "avc1.42e01f", 
        width: width,
        height: height,
        bitrate: this.targetBitrate,
        bitrateMode: 'variable', // Phase 4: Use VBR for better iOS compatibility
        latencyMode: "realtime",
        // @ts-ignore
        avc: { format: "annexb", key_frame_interval: 60 } // GOP: 60 (2s at 30fps)
      });
      this.currentWidth = width;
      this.currentHeight = height;
      this.isConfigured = true;
      this.needsKeyframe = true;

      // === Phase 4: Clean queue and boost tokens on resolution change ===
      if (this.sendQueue.length > 5) {
        if (this.onLog) this.onLog(`\uD83E\uDDF9 Clearing sendQueue (${this.sendQueue.length} parts) for new resolution`);
        this.sendQueue = [];
      }
      // Give 40KB boost for the first I-frame to pass through the pacer instantly
      this.tokenBucketBytes = Math.max(this.tokenBucketBytes, 40000); 

      if (this.onLog) this.onLog(`\u2699\uFE0F Baseline Profile Config: ${width}x${height} @ ${Math.round(this.targetBitrate/1024)}k`);
    } catch (e) {
      if (this.onLog) this.onLog(`\u274C Encoder configuration failed: ${e}`);
    }
  }

  private applyBitrateToParams() {
    if (!this.encoder || !this.isConfigured) return;
    
    const diffRatio = Math.abs(this.targetBitrate - this.lastConfiguredBitrate) / (this.lastConfiguredBitrate || 1);
    if (diffRatio >= 0.20) {
      try {
        this.encoder.configure({
          codec: "avc1.42e01f", // Constrained Baseline
          width: this.currentWidth,
          height: this.currentHeight,
          bitrate: this.targetBitrate,
          bitrateMode: 'constant',
          latencyMode: "realtime",
          // @ts-ignore
          avc: { format: "annexb", key_frame_interval: 60 }
        });
        this.lastConfiguredBitrate = this.targetBitrate;
        // Logic removed: forcing Keyframe on every bitrate change induces bufferbloat
        // this.needsKeyframe = true; 
      } catch (e) { }
    }

    const kbps = this.targetBitrate / 1024;
    // === Phase 4: More conservative FPS for mobile stability ===
    if (kbps < 300) this.currentFps = 10;
    else if (kbps < 600) this.currentFps = 15;
    else if (kbps < 1200) this.currentFps = 24;
    else this.currentFps = 30;
  }

  private updateCongestionControl() {
    if (this.manualMode) return; 

    const now = performance.now();
    
    const dt = (now - this.lastPiUpdateTs) / 1000;
    if (dt < 0.1) return; // Limit update frequency to 10Hz
    this.lastPiUpdateTs = now;

    const metrics = this.getNetworkMetrics();
    const buffered = metrics.bufferedAmount;

    // === Phase 3: Buffered Gradient (Derivative) ===
    const dtGrad = Math.max(1, now - this.lastCongestionUpdate);
    if (dtGrad > 100) {
      const currentGradient = (buffered - this.lastBufferedAmount) / dtGrad;
      this.bufferedGradient = this.bufferedGradient * 0.8 + currentGradient * 0.2;
      this.lastBufferedAmount = buffered;
      this.lastCongestionUpdate = now;
    }
    const rtt = this.lastRttSmoothed || metrics.rtt || 150;
    
    // Phase 2.1 FIX: error = target - measured
    const measuredDelay = Math.max(0, rtt - this.minRtt);
    
    // Buffer penalty (negative only, to slow down if buffer bloats)
    const bufferPenalty = buffered > this.bufferTarget 
      ? Math.min(100000, Math.pow((buffered - this.bufferTarget) / 10000, 2) * 500) 
      : 0;

    const error = (this.rttTarget - rtt) - bufferPenalty;
    
    // FIX: VELOCITY PI CONTROLLER
    // Use the incremental form: delta = Kp * (e(t) - e(t-1)) + Ki * e(t) * dt
    // This prevents the "double penalty" where adding Kp*e(t) to the bitrate 
    // effectively makes Kp an integral gain.
    const deltaError = error - this.lastError;
    this.lastError = error;

    const adjustment = (this.KP * deltaError) + (this.KI * error * dt);
    
    // Sensitivity threshold (10%) to prevent micro-fluctuations
    const threshold = 1000; // Lower threshold since adjustment is now a proper delta
    const oldBitrate = this.targetBitrate;

    if (Math.abs(adjustment) > 0) {
      // Scale up more safely than we scale down
      const finalAdjustment = adjustment > 0 ? adjustment * 0.5 : adjustment;
      
      // === Phase 3: GCC Overuse Detection (Gradient based) ===
      const isBufferGrowing = this.bufferedGradient > 0.5 && buffered > 100000;
      if (isBufferGrowing && this.aiState !== 'congested') {
        this.aiState = 'congested';
        this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.8);
        if (this.onLog) this.onLog(`\uD83D\uDEA8 GCC Buffer Growing: grad=${this.bufferedGradient.toFixed(1)}, cutting bitrate.`);
      } else {
        this.targetBitrate = Math.max(this.minBitrate, Math.min(this.maxBitrate, this.targetBitrate + finalAdjustment));
        this.aiState = finalAdjustment < 0 ? 'congested' : 'steady';
      }
      
      // NEW: Proactive Bitrate Penalty based on buffer pressure
      const maxWsBuffer = Math.max(800000, (this.targetBitrate / 8) * 1.5);
      const bufferPressure = Math.min(1.0, buffered / maxWsBuffer);
      if (bufferPressure > 0.3) {
          const penalty = (bufferPressure - 0.3) * 0.6; // Max 42% reduction at 100% buffer
          this.targetBitrate *= (1.0 - penalty);
          this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate);
      }
      
      if (Math.abs(this.targetBitrate - oldBitrate) > 20000 && this.onLog) {
         this.onLog(`📊 Velocity PI ABR: ${this.aiState.toUpperCase()}, RTT=${Math.round(rtt)}ms, qDelay=${Math.round(measuredDelay)}ms, error=${Math.round(error)}, TRG=${Math.round(this.targetBitrate/1024)}k`);
      }
    }

    if (Math.abs(this.targetBitrate - oldBitrate) > 1000 || adjustment !== 0) {
      this.applyBitrateToParams();
    }
  }

  public updateRTT(rtt: number) {
    const now = performance.now();
    this.lastRtt = rtt;
    
    // === Phase 3: Protection against Zombie RTT spikes ===
    if (rtt > 500 && this.bufferedGradient > 0) { 
      if (this.onLog) this.onLog(`\uD83D\uDEA8 RTT SPIKE + Buffer Growth (${rtt}ms) \u2014 Emergency bitrate cut`);
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
      this.sendQueue = []; // Clear stale queue
      this.totalQueueBytes = 0;
      this.applyBitrateToParams();
      this.rttHistory = [this.lastRttSmoothed || 200]; 
      return;
    } else if (rtt > 500) {
      if (this.onLog) this.onLog(`\u26A0\uFE0F RTT Spike ${rtt}ms but buffer draining. Ignoring.`);
      this.rttHistory = [this.lastRttSmoothed || 200];
      return;
    }

    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();
    
    const sorted = [...this.rttHistory].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];

    const clampedRtt = medianRtt; 

    if (this.totalQueueBytes === 0 && this.getNetworkMetrics().bufferedAmount < 10000) {
      this.minRtt = Math.min(this.minRtt, clampedRtt);
    }

    // Smoothed RTT (EMA with 0.7/0.3 weight to filter spikes)
    const prevSmoothed = this.lastRttSmoothed || clampedRtt;
    this.lastRttSmoothed = prevSmoothed * 0.7 + clampedRtt * 0.3;
    
    // Delay Trend (Derivative)
    const dt = (now - this.lastUpdateTs) / 1000;
    if (dt >= 0.2) {
      this.delayTrend = (this.lastRttSmoothed - prevSmoothed) / dt;
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
      if (this.onLog) this.onLog(`🛠️ Manual mode enabled, bitrate fixed to ${Math.round(this.manualBitrate/1024)}k`);
    } else {
      this.targetBitrate = this.lastAbrBitrate;
      if (this.onLog) this.onLog(`🔄 Auto mode (ABR) restored, target bitrate ${Math.round(this.targetBitrate/1024)}k`);
    }
    this.applyBitrateToParams();
  }

  public setManualBitrate(bitrate: number) {
    this.manualBitrate = bitrate;
    
    if (this.manualMode) {
      // Safe transition: reset everything before re-configuring
      this.sendQueue = [];
      this.totalQueueBytes = 0;
      this.tokenBucketBytes = 0;
      this.targetBitrate = bitrate;
      
      if (this.encoder) {
        this.needsKeyframe = true;
        this.encoder.flush(); // flush the encoder queue to prevent deadlock
      }
      
      this.applyBitrateToParams();
      if (this.onLog) this.onLog(`🛠️ Manual bitrate → ${Math.round(bitrate/1024)}k (queue cleared, forced I-frame)`);
    }
  }

  public getStats() {
    const { rtt, bufferedAmount } = this.getNetworkMetrics();
    const avgEncode = this.encodeDurationLog.length > 0 
      ? this.encodeDurationLog.reduce((a,b)=>a+b, 0) / this.encodeDurationLog.length 
      : 0;

    return {
      fps: this.currentFps,
      droppedFrames: this.droppedFrames,
      droppedFramesRate: this.droppedFramesRate,
      state: this.aiState === 'congested' ? 'Overuse' : (this.aiState === 'steady' ? 'Normal' : this.aiState),
      aiState: this.aiState,
      targetBitrate: Math.max(0, Math.round(this.targetBitrate / 1024)),
      bitrate: this.targetBitrate,
      rtt: rtt || this.lastRttSmoothed,
      bl: bufferedAmount,
      qDelay: this.sendQueue.length > 0 ? performance.now() - this.sendQueue[0].enqueueTime : 0,
      qLen: this.sendQueue.length,
      qBytes: this.totalQueueBytes,
      cpu: Math.round(avgEncode),
      delta: this.bufferedGradient, 
      threshold: 0.5,
      scale: this.currentScale,
      quality: this.currentScale
    };
  }

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    const now = performance.now();
    
    // Phase 4: Annex B Diagnostics
    // NOTE: This code snippet appears to be intended for an H264Decoder class,
    // as it references 'binary', 'frameId', 'this.isKeyFrame', and 'this.framesReceived'
    // which are not defined in this AdaptiveH264Engine (sender) context.
    // Inserting it here would cause syntax errors.
    // The instruction mentions "adding diagnostics to H264Decoder.ts" but the provided
    // document is AdaptiveH264Engine.ts.
    // Therefore, this specific code block cannot be faithfully applied to this file.
    this.sessionStartTime = now;
    this.lastAIUpdate = now;
    this.lastTokenUpdate = now;
    this.lastPacerRun = now;
    this.lastCongestionTs = 0;
    this.aiState = 'steady';
    this.targetBitrate = 500_000;
    this.errorIntegral = 0;
    this.lastError = 0; // Fix: Reset last error for PI
    this.minRtt = Infinity;
    this.frameId = 0;
    this.sendQueue = []; // Fix: Clear old queue
    this.totalQueueBytes = 0;
    this.tokenBucketBytes = (500_000 / 8) * 0.5; // Start with half second credit
    this.pacerTokens = this.tokenBucketBytes; // Initialize pacer tokens too!
    this.cryptoOpId = 0; 
    
    if (this.sharedSecret) {
      // Export key to raw format for the worker
      crypto.subtle.exportKey('raw', this.sharedSecret).then(raw => {
        if (this.cryptoWorker) { // Changed cryptoWorker to this.cryptoWorker
          this.cryptoWorker.postMessage({ type: 'INIT_KEY', keyData: raw });
        }
      });
    }

    this.applyBitrateToParams();
    if (this.onLog) this.onLog(`🚀 Sender started: PI ABR initialized, target=500k`);
    this.pacerInterval = setInterval(() => this.runPacer(performance.now()), 10);
    this.rafId = requestAnimationFrame(this.loop);
  }

  public async stop() {
    this.isRunning = false;
    this.sendQueue = [];
    this.totalQueueBytes = 0;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    if (this.pacerInterval) clearInterval(this.pacerInterval);
    this.pacerInterval = null;
    
    if (this.cryptoWorker) {
      this.cryptoWorker.postMessage({ type: 'CLEAR_KEY' });
      this.cryptoWorker.terminate(); // Properly terminate worker to free resources
      this.cryptoWorker = null;
    }

    if (this.encoder) {
      try { 
        await this.encoder.flush(); // Phase 1.3: Await flush before close
        this.encoder.close(); 
      } catch (e) {}
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
      const maxBurst = (this.targetBitrate / 8) * 2.0; 
      this.tokenBucketBytes = Math.min(this.tokenBucketBytes + tokensToAdd, maxBurst);

      // NEW: DEBT CAPPING (Credit-based recovery)
      const maxDebt = -this.targetBitrate / 40; // Max 0.2 second of debt
      if (this.tokenBucketBytes < maxDebt) {
        this.tokenBucketBytes = maxDebt;
      }

      this.lastTokenUpdate = now;
    }
    
    // === Phase 3: Encoder Watchdog ===
    if (this.pendingFrames > 0 && now - this.lastPendingReset > 1500) { 
      if (this.onLog) this.onLog(`\uD83D\uDEA8 Watchdog: Encoder stuck for 1.5s. Force resetting...`);
      this.handleEncoderError(); 
      this.lastPendingReset = now;
    }

    const frameInterval = 1000 / this.currentFps;
    if (now - this.lastFrameTime >= frameInterval) {
      const { bufferedAmount } = this.getNetworkMetrics();
      const queueBytes = this.totalQueueBytes;
      
      // Increased thresholds for Phase 3
      const isInternalQueuePanic = this.sendQueue.length > 80 || queueBytes > 1024000;
      
      // resolution scaling
      this.currentScale = 1.0;
      
      const possessesTokens = this.tokenBucketBytes >= 0; 
      
      if (bufferedAmount > 400000 || isInternalQueuePanic || !possessesTokens) { 
        this.droppedFrames++;
        this.droppedFramesWindow++;
        this.droppedFramesConsecutive++;
        if (this.droppedFramesConsecutive >= 3) this.needsKeyframe = true;
        this.lastFrameTime = now;
        
        // Phase 3: Aggressive queue clearing
        if ((bufferedAmount > 800000 || isInternalQueuePanic) && now - this.lastCongestionTs > this.congestionCooldown) {
          if (this.onLog) {
            this.onLog(`\uD83D\uDEA8 CRITICAL Congestion: clearing send queue (WS: ${Math.round(bufferedAmount/1024)}KB, Q: ${this.sendQueue.length})`);
          }
          this.sendQueue = [];
          this.totalQueueBytes = 0;
          this.pendingFrames = 0; // Fix: Reset pending frames on congestion
          this.tokenBucketBytes = 20000; 
          this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
          this.errorIntegral = 0; 
          this.applyBitrateToParams();
          this.aiState = 'congested';
          this.lastCongestionTs = now;
          this.needsKeyframe = true; // Force I-frame after congestion
        }
      } else {
        this.lastFrameTime = now;
        const success = await this.processFrame(now);
        if (success) {
          this.droppedFramesConsecutive = 0;
          this.lastPendingReset = now; // Activity OK
        }
      }
    }

    if (now - this.droppedWindowStart >= 1000) {
      this.droppedFramesRate = this.droppedFramesWindow;
      this.droppedFramesWindow = 0;
      this.droppedWindowStart = now;
      
      const kbps = Math.round((this.bytesSentThisSecond * 8) / 1024);
      this.bytesSentThisSecond = 0;
      
      if (this.onLog && this.isRunning) {
        const queueBytes = this.totalQueueBytes;
        this.onLog(`📤 Send rate: ${kbps} kbps, buffer: ${this.sendQueue.length} frames (${Math.round(queueBytes/1024)}KB), tokens=${Math.round(this.tokenBucketBytes/1024)}KB`);
      }
    }
    this.rafId = requestAnimationFrame(this.loop);
  };

  private getMaxBytesPerTick(): number {
    if (!this.enableScalablePacing) return 131072; // Default 128KB
    // Scale send limit by current bitrate (64KB to 256KB range)
    return Math.min(262144, Math.max(65536, (this.targetBitrate / 8) * 0.5));
  }

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
    const maxPacerBurst = Math.max(1500, bytesPerMs * 250); // 250ms burst
    
    // Phase 4 Fix: Don't use a fixed 1.5M floor, it chokes slow connections
    const multiplier = this.sendQueue.length > 15 ? 1.5 : 1.1; 
    const effectiveRate = this.targetBitrate * multiplier;
    this.pacerTokens = Math.min(maxPacerBurst, this.pacerTokens + (effectiveRate / 8 / 1000) * pacerDeltaMs);
    
    let bytesSentThisTick = 0;
    const MAX_BYTES_PER_TICK = this.getMaxBytesPerTick();

    while (this.sendQueue.length > 0 && this.pacerTokens >= 0 && bytesSentThisTick < MAX_BYTES_PER_TICK) {
      const chunk = this.sendQueue[0].data;

      // Tail-Drop P-frames logic
      const isPFrame = chunk.length < 5000; // Heuristic for P-frame in H.264
      if (this.enableSafeTailDrop && this.sendQueue.length > 40 && isPFrame) {
        this.totalQueueBytes -= chunk.length;
        this.sendQueue.shift();
        this.droppedFrames++;
        continue;
      }

      this.ws.send(chunk);
      this.pacerTokens -= chunk.length;
      this.bytesSentThisSecond += chunk.length;
      bytesSentThisTick += chunk.length;
      this.totalQueueBytes -= chunk.length;
      this.sendQueue.shift();
    }
  }
  
  private async processFrame(now: number): Promise<boolean> {
    if (this.onLog && this.frameId % 300 === 0) {
      this.onLog(`🎬 processFrame: pending=${this.pendingFrames}, queue=${this.sendQueue.length}, state=${this.aiState}`);
    }
    
    if (this.pendingFrames > 3 || this.video.paused || this.video.ended || this.video.readyState < 2) {
      if (this.onLog && (this.frameId % 300 === 0 || this.pendingFrames > 3)) {
         this.onLog(`⚠️ processFrame skipped: pending=${this.pendingFrames}, state=${this.video.readyState}, paused=${this.video.paused}`);
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
      
      try {
        const inputW = frame.displayWidth;
        const inputH = frame.displayHeight;
        const finalScale = this.currentScale;
        
        const targetW = Math.floor((inputW * finalScale) / 2) * 2;
        const targetH = Math.floor((inputH * finalScale) / 2) * 2;
        
        if (!this.isConfigured || targetW !== this.currentWidth || targetH !== this.currentHeight) {
          this.configureEncoder(targetW, targetH);
        }
        
        // Task 17: Don't force keyframe if congested (saves bits)
        if (this.frameId % 60 === 0) {
          this.needsKeyframe = true;
        }

        if (this.encoder.encodeQueueSize > 2) {
            return false;
        }

        this.pendingFrames++;
        this.encoder.encode(frame, { keyFrame: this.needsKeyframe || this.frameId === 0 });
        this.frameId++; // Increment frameId here (sync)
        this.needsKeyframe = false;
        return true;
      } finally {
        frame.close(); // Phase 1.3: Robust frame closing
      }
    } catch (e) {
      return false;
    }
  }
}
