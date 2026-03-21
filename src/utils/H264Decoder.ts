export interface VideoPacket {
  frameId: number;
  receiveTime: number;
  senderTs: number;
  raw: Uint8Array;
  type: 'key' | 'delta';
}

export class H264Decoder {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private decoder: VideoDecoder | null = null;
  private jitterBuffer: VideoPacket[] = [];
  private targetDelay = 50; // Audit Recommendation: Lower latency for TCP
  // Fixed large value to handle RTT spikes

  private isPlaying = false;
  private onLog?: (msg: string) => void;
  private onRequestKeyframe?: (isPanic: boolean) => void;
  private isConfigured = false;
  private rotation: number = 0;
  private mirror: boolean = false;
  private flipV: boolean = false;

  private currentRtt: number = 0;
  private estimatedOneWay: number = 0;
  private rttHistory: number[] = [];
  private lastRttSmoothed: number = 0;

  // Adaptive Jitter Buffer (Task 18 & Jitter Fix)
  private readonly MAX_DELAY = 2000;
  private readonly MIN_DELAY = /Android/i.test(navigator.userAgent) ? 250 : 150;
  private readonly CATCH_UP_THRESHOLD = 600;

  private firstSenderTs = -1;
  private firstPlayoutTime = -1;
  private lastBufferEmptyTime = 0;
  private dropThreshold = 2000;

  // Statistical Jitter tracking (Task 17)
  private jitterLog: number[] = [];
  private lastReceiveTime = 0;
  private lastSenderTs = 0;

  constructor(canvas: HTMLCanvasElement, onLog?: (msg: string) => void, onRequestKeyframe?: (isPanic: boolean) => void) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.onLog = onLog;
    this.onRequestKeyframe = onRequestKeyframe;
    this.initDecoder();
  }

  private initDecoder() {
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          let angle = this.rotation;

          // Attempt 9: Always Vertical Fix
          if (angle === 0 && frame.displayWidth > frame.displayHeight) {
            angle = 90;
          }

          const isRotated = angle === 90 || angle === 270;
          const displayW = isRotated ? frame.displayHeight : frame.displayWidth;
          const displayH = isRotated ? frame.displayWidth : frame.displayHeight;

          if (this.canvas.width !== displayW || this.canvas.height !== displayH) {
            this.canvas.width = displayW;
            this.canvas.height = displayH;
          }

          this.ctx.save();
          this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
          this.ctx.rotate((angle * Math.PI) / 180);
          if (this.mirror || this.flipV) {
            this.ctx.scale(this.mirror ? -1 : 1, this.flipV ? -1 : 1);
          }
          this.ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2);
          this.ctx.restore();
          frame.close();
        },
        error: (e) => {
          if (this.onLog) this.onLog(`\u274C Decoder error callback: ${e.message}`);
        }
      });
    } catch (e: any) {
      if (this.onLog) this.onLog(`❌ Decoder init exception: ${e.message}`);
    }
  }

  private configure() {
    if (!this.decoder) return;
    try {
      this.decoder.configure({
        codec: "avc1.42e01f", // Attempt 4: Baseline Profile
        optimizeForLatency: true
      });
      this.isConfigured = true;
    } catch (e: any) {
      if (this.onLog) this.onLog(`❌ Decoder configuration failed: ${e.message}`);
    }
  }

  private isKeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i < Math.min(data.length - 4, 500); i++) {
      if (data[i] === 0 && data[i + 1] === 0) {
        let offset = 0;
        if (data[i + 2] === 1) offset = 3;
        else if (data[i + 2] === 0 && data[i + 3] === 1) offset = 4;
        if (offset > 0) {
          const nalType = data[i + offset] & 0x1F;
          if (nalType === 5 || nalType === 7 || nalType === 8) return true;
        }
      }
    }
    return false;
  }

  public pushPacket(binary: Uint8Array, frameId: number, fps: number, senderTs: number) {
    if (!this.decoder) return;
    if (!this.isConfigured) this.configure();

    const now = performance.now();
    const type = this.isKeyFrame(binary) ? 'key' : 'delta';

    // Automatic Keyframe Request: Если ждем I-Frame, но получаем дельту — просим ключевой кадр.
    if (this.firstSenderTs === -1 && type === 'delta' && frameId % 30 === 0) {
      if (this.onRequestKeyframe) this.onRequestKeyframe(false);
    }

    if (type === 'key' && this.onLog) {
      this.onLog(`🔑 Keyframe detected: frameId=${frameId}, size=${binary.length}`);
    } else if (frameId % 60 === 0 && this.onLog) {
      this.onLog(`📦 Delta frame: frameId=${frameId}, size=${binary.length}`);
    }

    // Adaptive Jitter Logic (Jitter = variance in arrival time)
    if (this.lastSenderTs > 0) {
      const expectedArrive = this.lastReceiveTime + (senderTs - this.lastSenderTs);
      const jitter = Math.max(0, now - expectedArrive);
      this.jitterLog.push(jitter);
      if (this.jitterLog.length > 100) this.jitterLog.shift();

      if (this.jitterLog.length >= 10 && this.jitterLog.length % 10 === 0) {
        const sorted = [...this.jitterLog].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];

        const multiplier = /Android/i.test(navigator.userAgent) ? 1.8 : 1.3;
        
        const newTarget = Math.min(800, Math.max(this.MIN_DELAY, this.estimatedOneWay + 40 + (p95 * multiplier)));
        this.targetDelay = this.targetDelay * 0.95 + newTarget * 0.05;
      }
    }

    this.lastReceiveTime = now;
    this.lastSenderTs = senderTs;

    const packet: VideoPacket = { frameId, receiveTime: now, senderTs, raw: binary, type };
    this.jitterBuffer.push(packet);
    this.jitterBuffer.sort((a, b) => a.frameId - b.frameId);

    // FIX: VFR Support (start on 1 frame, don't wait for 3 because at 5fps 3 frames takes 600ms!)
    if (!this.isPlaying && this.jitterBuffer.length >= 1) {
      this.isPlaying = true;
      
      // ✅ КРИТИЧЕСКИ ВАЖНО: Восстановление после микро-разрывов (gap > 3s)
      if (this.lastBufferEmptyTime > 0 && now - this.lastBufferEmptyTime > 3000) {
        if (this.onLog) {
          this.onLog(`🔄 Buffer empty for >3s, resetting sync (firstSenderTs=${this.firstSenderTs})`);
        }
        this.firstSenderTs = -1;
        this.firstPlayoutTime = -1;
      }
      this.lastBufferEmptyTime = 0;
      
      if (this.onLog) this.onLog(`▶️ Starting playback, buffer: ${this.jitterBuffer.length}`);
      requestAnimationFrame(this.playNext);
    }
  }

  private playNext = (now: number) => {
    if (!this.decoder) {
      this.isPlaying = false;
      return;
    }

    if (this.jitterBuffer.length === 0) {
      if (this.isPlaying) {
        this.isPlaying = false;
        // FIX: Muted warning because dropping to 0 buffer is perfectly normal 
        // behavior when running at Variable Frame Rate (e.g. 5fps).
        // if (this.onLog) this.onLog(`\u26A0\uFE0F Buffer empty, stopping playback`);
        this.lastBufferEmptyTime = now;
      }
      return; // Выходим молча, pushPacket сам вызовет requestAnimationFrame, когда придут данные
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`\u25B6\uFE06 Resuming playback`);
    }

    const packet = this.jitterBuffer[0];
    
    // Fast Recovery: Если буфер слишком большой, прыгаем до свежего keyframe
    const firstPacket = this.jitterBuffer[0];
    const lastPacket = this.jitterBuffer[this.jitterBuffer.length - 1];
    const bufferDuration = lastPacket.senderTs - firstPacket.senderTs;

    // Phase 3: Relaxed jump threshold (800ms) to allow more jitter on 4G/5G.
    if (bufferDuration > 800 || this.jitterBuffer.length > 45) {
      let latestKeyIdx = -1;
      for (let i = this.jitterBuffer.length - 1; i >= 0; i--) {
        if (this.jitterBuffer[i].type === 'key') {
          latestKeyIdx = i;
          break;
        }
      }
      
      if (latestKeyIdx > 0) {
        if (this.onLog) this.onLog(`\u23E9 Hard Reset: skipping ${latestKeyIdx} frames, duration=${bufferDuration}ms`);
        this.jitterBuffer.splice(0, latestKeyIdx);
        this.firstSenderTs = -1;
        requestAnimationFrame(this.playNext);
        return;
      } else if (latestKeyIdx === -1) {
        if (this.onLog) this.onLog(`\u23E9 Panic Reset: NO KEYFRAME IN BUFFER. Dropping all ${this.jitterBuffer.length} frames.`);
        this.jitterBuffer = [];
        this.firstSenderTs = -1;
        if (this.onRequestKeyframe) this.onRequestKeyframe(true);
        return;
      }
    }

    if (this.firstSenderTs === -1) {
      if (packet.type !== 'key') {
        this.jitterBuffer.shift();
        requestAnimationFrame(this.playNext);
        return;
      }
      this.firstSenderTs = packet.senderTs;
      this.firstPlayoutTime = now;
    }

    const videoTimeOffset = packet.senderTs - this.firstSenderTs;
    const targetPlayTime = this.firstPlayoutTime + videoTimeOffset + this.targetDelay;

    this.dropThreshold = Math.max(800, this.targetDelay * 1.5 + this.currentRtt);
    const isPanic = now - targetPlayTime > this.dropThreshold;
    const isBufferLarge = this.jitterBuffer.length > 15;

    if (isPanic || isBufferLarge) {
      // В панике или при большом буфере не ждем, декодируем сразу
    } else if (now < targetPlayTime) {
      requestAnimationFrame(this.playNext);
      return;
    }

    this.jitterBuffer.shift();

    try {
      const chunk = new EncodedVideoChunk({
        type: packet.type,
        timestamp: videoTimeOffset * 1000,
        data: packet.raw
      });
      if (this.onLog && Math.random() < 0.01) { // Log 1% of frames to avoid spam
      this.onLog(`🎬 Playing frame ${packet.frameId}, gap=${Math.round(now - packet.receiveTime)}ms`);
    }
    this.decoder.decode(chunk);
    } catch (e: any) {
      if (this.onLog) this.onLog(`❌ Decode error: ${e.message}`);
      this.firstSenderTs = -1;
    }

    // Если буфер все еще большой, закидываем кадры чуть быстрее (но не блокируем поток)
    if (this.jitterBuffer.length > 5) {
      setTimeout(() => this.playNext(performance.now()), 4);
    } else {
      requestAnimationFrame(this.playNext);
    }
  };

  public getStats() {
    return {
      targetDelay: Math.round(this.targetDelay),
      bufferLength: this.jitterBuffer.length,
      firstSenderTs: this.firstSenderTs,
      firstPlayoutTime: this.firstPlayoutTime,
      dropThreshold: this.dropThreshold
    };
  }

  public setRotation(degrees: number) {
    this.rotation = degrees % 360;

    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.onLog) this.onLog(`🔄 Applied rotation: ${this.rotation}° (mirror=${this.mirror})`);
  }

  public setMirror(enabled: boolean) {
    this.mirror = enabled;
  }

  public setFlipV(enabled: boolean) {
    this.flipV = enabled;
  }

  public updateRTT(rtt: number) {
    this.rttHistory.push(Math.max(20, rtt));
    if (this.rttHistory.length > 7) this.rttHistory.shift();

    const sorted = [...this.rttHistory].sort((a, b) => a - b);
    let median = sorted[Math.floor(sorted.length / 2)];

    // Protection against Zombie RTT
    if (median > 2000) {
      median = this.currentRtt || 150;
      this.rttHistory = [median];
    }

    const clamped = Math.min(median, 5000);
    this.lastRttSmoothed = this.lastRttSmoothed
      ? this.lastRttSmoothed * 0.7 + clamped * 0.3
      : clamped;

    this.currentRtt = this.lastRttSmoothed;
    this.estimatedOneWay = Math.min(this.currentRtt / 2, 400); // hard cap 400ms one-way
  }

  public destroy() {
    this.isPlaying = false;
    this.jitterBuffer = [];
    if (this.decoder) {
      try { this.decoder.close(); } catch (e) { }
      this.decoder = null;
    }
  }
}
