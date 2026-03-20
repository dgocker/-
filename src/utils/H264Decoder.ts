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
  private targetDelay = 600; // FIX BUG-008: Reduced from 2000ms for faster startup

  private isPlaying = false;
  private onLog?: (msg: string) => void;
  private isConfigured = false;
  private rotation: number = 0; 
  private mirror: boolean = false;
  private flipV: boolean = false;
  private onRequestKeyframe?: () => void;
  private enableDynamicJitter: boolean = true;
  
  private currentRtt: number = 0;
  private estimatedOneWay: number = 0;
  private rttHistory: number[] = [];
  private lastRttSmoothed: number = 0;
  
  private audioContext: AudioContext | null = null;
  private firstAudioContextTime: number = -1;
  
  // Adaptive Jitter Buffer (Task 18 & Jitter Fix)
  private readonly MAX_DELAY = 10000; 
  private readonly MIN_DELAY = 100;
  private readonly CATCH_UP_THRESHOLD = 2000;

  private firstSenderTs = -1;
  private firstPlayoutTime = -1;
  private lastBufferEmptyTime = 0;
  
  // Statistical Jitter tracking (Task 17)
  private jitterLog: number[] = [];
  private lastReceiveTime = 0;
  private lastSenderTs = 0;
  private framesReceived = 0; // Fix: track frames for initial safety window

  constructor(canvas: HTMLCanvasElement, onLog?: (msg: string) => void, onRequestKeyframe?: () => void, options?: { enableDynamicJitter?: boolean }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.onLog = onLog;
    this.onRequestKeyframe = onRequestKeyframe;
    this.enableDynamicJitter = options?.enableDynamicJitter ?? true;
    this.initDecoder();
  }

  private initDecoder() {
    try {
      this.decoder = new VideoDecoder({
        output: (frame) => {
          try {
            // Always target portrait orientation
            const isLandscape = frame.displayWidth > frame.displayHeight;
            let angle = this.rotation;
            
            // If the source is landscape, we automatically rotate it to be portrait
            // unless the user has already manually rotated it.
            if (isLandscape && angle === 0) {
              angle = 90; 
            }

            const isRotated = angle === 90 || angle === 270;
            const targetWidth = isRotated ? frame.displayHeight : frame.displayWidth;
            const targetHeight = isRotated ? frame.displayWidth : frame.displayHeight;

            if (this.canvas.width !== targetWidth || this.canvas.height !== targetHeight) {
              this.canvas.width = targetWidth;
              this.canvas.height = targetHeight;
            }

            this.ctx.save();
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.translate(this.canvas.width / 2, this.canvas.height / 2);
            this.ctx.rotate((angle * Math.PI) / 180);
            this.ctx.scale(this.mirror ? -1 : 1, this.flipV ? -1 : 1);
            
            // Draw centered
            this.ctx.drawImage(frame, -frame.displayWidth / 2, -frame.displayHeight / 2);
            this.ctx.restore();
          } finally {
            frame.close();
          }
        },
        error: (e) => {
          if (this.onLog) this.onLog(`\u274C Decoder: ${e.message}`);
          this.onRequestKeyframe?.();
          this.firstSenderTs = -1;
        }
      });
    } catch (e) { }
  }

  private configure(codecStr?: string) {
    if (!this.decoder) return;
    
    let codec = codecStr || "avc1.42e01f";
    // Phase 1.1: SDP Munging / Profile Patching (iOS 4200xx -> Android 42e01f)
    if (codec.startsWith("avc1.4200")) {
      codec = "avc1.42e01f";
    }

    try {
      this.decoder.configure({
        codec: codec,
        optimizeForLatency: true,
        // @ts-ignore
        avc: { format: "annexb" }
      });
      this.isConfigured = true;
      if (this.onLog) this.onLog(`\u2699\uFE0F Decoder configured: ${codec} (annexb)`);
    } catch (e: any) {
      if (this.onLog) this.onLog(`\u274C Decoder configuration failed (${codec}): ${e.message}`);
    }
  }

  private isKeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i < Math.min(data.length - 4, 100); i++) {
        if (data[i] === 0 && data[i+1] === 0) {
            let offset = 0;
            if (data[i+2] === 1) offset = 3;
            else if (data[i+2] === 0 && data[i+3] === 1) offset = 4;
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

    // Auto-Keyframe on Join: Request keyframe if we get deltas before the first keyframe
    if (this.firstSenderTs === -1 && type === 'delta' && frameId % 30 === 0) {
      if (this.onRequestKeyframe) this.onRequestKeyframe();
    }
    this.framesReceived++;

    // Adaptive Jitter Logic (Jitter = variance in arrival time)
    if (this.lastSenderTs > 0) {
      const expectedArrive = this.lastReceiveTime + (senderTs - this.lastSenderTs);
      const jitter = Math.max(0, now - expectedArrive);
      this.jitterLog.push(jitter);
      if (this.jitterLog.length > 100) this.jitterLog.shift();
      
      if (this.jitterLog.length >= 10 && this.jitterLog.length % 10 === 0) {
        const sorted = [...this.jitterLog].sort((a, b) => a - b);
        const p95 = sorted[Math.floor(sorted.length * 0.95)];
        
        // --- Phase 4 Fix: Android needs higher multiplier (1.8x vs 1.3x) ---
        const isAndroid = /Android/i.test(navigator.userAgent);
        const multiplier = isAndroid ? 1.8 : 1.3;
        
        // FIX BUG-009: Initial Zero-RTT Bias floor
        const floor = this.framesReceived < 100 ? 500 : this.MIN_DELAY;
        
        let dynamicMultiplier = multiplier;
        if (this.enableDynamicJitter) {
          // Phase 4: Combined multiplier (base * dynamic)
          dynamicMultiplier = multiplier * (0.8 + Math.tanh(p95 / 100) * 0.7);
        }

        const newTarget = Math.min(800, Math.max(floor, this.estimatedOneWay + 60 + (p95 * dynamicMultiplier)));
        
        if (Math.abs(newTarget - this.targetDelay) > 20) {
          this.targetDelay = newTarget;
          if (this.onLog) {
            this.onLog(`📊 Adapting targetDelay to ${Math.round(this.targetDelay)}ms (p95=${Math.round(p95)}ms, RTT=${Math.round(this.currentRtt)}ms, frames=${this.framesReceived})`);
          }
        }
      }
    }

    this.lastReceiveTime = now;
    this.lastSenderTs = senderTs;

    const packet: VideoPacket = { frameId, receiveTime: now, senderTs, raw: binary, type };
    this.jitterBuffer.push(packet);
    this.jitterBuffer.sort((a, b) => a.frameId - b.frameId);

    if (!this.isPlaying && this.jitterBuffer.length >= 1) { 
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`\u25B6\uFE0F Starting playback, buffer: ${this.jitterBuffer.length}`);
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
        if (this.onLog) this.onLog(`\u26A0\uFE0F Buffer empty, stopping playback`);
        this.lastBufferEmptyTime = now;
      } else {
        if (this.lastBufferEmptyTime > 0 && now - this.lastBufferEmptyTime > 3000) {
          if (this.onLog) {
            this.onLog(`🔄 Buffer empty for 3s, resetting sync (firstSenderTs=${this.firstSenderTs}, firstPlayoutTime=${Math.round(this.firstPlayoutTime)})`);
          }
          this.firstSenderTs = -1;
          this.firstPlayoutTime = -1;
          this.lastBufferEmptyTime = 0;
        }
      }
      requestAnimationFrame(this.playNext);
      return;
    }

    if (!this.isPlaying) {
      this.isPlaying = true;
      this.lastBufferEmptyTime = 0;
      if (this.onLog) this.onLog(`\u25B6\uFE06 Resuming playback`);
    }

    const packet = this.jitterBuffer[0];
    
    // === Phase 3: Fast Recovery ===
    // If buffer is very large (> 1s of video), skip to the latest keyframe
    const bufferDuration = this.jitterBuffer.length * (1000 / 30); // Rough estimate
    if (bufferDuration > 1000) {
      let latestKeyIdx = -1;
      for (let i = this.jitterBuffer.length - 1; i >= 0; i--) {
        if (this.jitterBuffer[i].type === 'key') {
          latestKeyIdx = i;
          break;
        }
      }
      
      if (latestKeyIdx > 0) {
        if (this.onLog) {
          this.onLog(`\uD83D\uDE80 FAST RECOVERY: Skipping ${latestKeyIdx} frames to latest keyframe (bufferDuration=${Math.round(bufferDuration)}ms)`);
        }
        // When fast recovery triggers, also request a fresh keyframe
        this.onRequestKeyframe?.();
        
        this.jitterBuffer.splice(0, latestKeyIdx);
        this.firstSenderTs = -1; // Reset sync to the new keyframe
        requestAnimationFrame(this.playNext);
        return;
      }
    }

    if (this.firstSenderTs === -1) {
      if (packet.type !== 'key') {
        if (this.onLog && packet.frameId % 30 === 0) {
           this.onLog(`⏭️ Waiting for KeyFrame, dropping delta frame ${packet.frameId}`);
        }
        this.jitterBuffer.shift();
        requestAnimationFrame(this.playNext);
        return;
      }
      this.onLog?.(`✨ Synchronized! First KeyFrame received (frameId=${packet.frameId}, ts=${packet.senderTs})`);
      this.firstSenderTs = packet.senderTs;
      this.firstPlayoutTime = now;
      if (this.audioContext) {
        this.firstAudioContextTime = this.audioContext.currentTime;
      }
    }

    // Phase 3.1: Sync to AudioContext.currentTime if available
    const videoTimeOffsetMs = packet.senderTs - this.firstSenderTs;
    let isLate = false;
    let shouldWait = false;

    if (this.audioContext && this.firstAudioContextTime !== -1) {
      const currentAudioTime = this.audioContext.currentTime;
      const targetAudioTime = this.firstAudioContextTime + (videoTimeOffsetMs / 1000) + (this.targetDelay / 1000);
      
      const delayS = currentAudioTime - targetAudioTime;
      if (delayS > 0.5) isLate = true; // Late by > 500ms
      else if (currentAudioTime < targetAudioTime) shouldWait = true;
    } else {
      const targetPlayTime = this.firstPlayoutTime + videoTimeOffsetMs + this.targetDelay;
      
      // === Phase 3: Adaptive Catch-up ===
      // If delay is huge or buffer is large, play immediately to catch up.
      const dropThreshold = Math.max(800, this.targetDelay * 1.5 + this.currentRtt); 
      const isPanic = now - targetPlayTime > dropThreshold;
      const isBufferLarge = this.jitterBuffer.length > 20;
      
      if (isPanic || isBufferLarge) {
        if (this.onLog && packet.frameId % 30 === 0) {
          this.onLog(`\uD83D\uDEA8 CATCH-UP: frame ${packet.frameId} is ${Math.round(now - targetPlayTime)}ms late. Buffer=${this.jitterBuffer.length}.`);
        }
        // In panic or large buffer, we don't wait.
      } else if (now < targetPlayTime) {
        requestAnimationFrame(this.playNext);
        return;
      }
    }

    if (isLate) {
      if (this.onLog) this.onLog(`⏭️ Skipping frame ${packet.frameId} (LATE)`);
      this.jitterBuffer.shift();
      requestAnimationFrame(this.playNext);
      return;
    }

    if (shouldWait) {
      requestAnimationFrame(this.playNext);
      return;
    }

    this.jitterBuffer.shift();
    
    try {
      const chunk = new EncodedVideoChunk({
        type: packet.type,
        timestamp: videoTimeOffsetMs * 1000, 
        data: packet.raw
      });
      if (this.onLog && packet.frameId % 30 === 0) {
        this.onLog(`\u25B6\uFE0F Playing frame ${packet.frameId}: targetDelay=${this.targetDelay}`);
      }
      this.decoder.decode(chunk);
    } catch (e: any) {
      if (this.onLog) this.onLog(`\u274C Decode error on frame ${packet.frameId}: ${e.message}`);
      this.onRequestKeyframe?.();
      // Only reset sync if it's been more than a few frames
      if (this.framesReceived > 5) {
        this.firstSenderTs = -1;
      }
    }
    
    // === Phase 4: Multi-frame playback for faster catch-up ===
    if (this.jitterBuffer.length > 10) {
      setTimeout(() => this.playNext(performance.now()), 0);
    } else {
      requestAnimationFrame(this.playNext);
    }
  };

  public getStats() {
    return {
      targetDelay: Math.round(this.targetDelay),
      bufferLength: this.jitterBuffer.length,
      firstSenderTs: this.firstSenderTs,
      firstPlayoutTime: this.firstPlayoutTime
    };
  }

  public setAudioContext(ctx: AudioContext) {
    this.audioContext = ctx;
    this.firstAudioContextTime = -1;
  }

  public setRotation(degrees: number) {
    this.rotation = degrees % 360;
    // Rotation is now handled by CSS or outside the renderer to save CPU/GPU cycles
    if (this.onLog) this.onLog(`🔄 Rotation updated (OOB): ${this.rotation}°`);
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
    
    // === Phase 3: RTT Median Filtering ===
    const sorted = [...this.rttHistory].sort((a,b)=>a-b);
    let median = sorted[Math.floor(sorted.length/2)];
    
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
    this.estimatedOneWay = Math.min(this.currentRtt / 2, 400); 
  }

  public async destroy() {
    this.isPlaying = false;
    this.jitterBuffer = [];
    if (this.decoder) {
      try { 
        await this.decoder.flush();
        this.decoder.close(); 
      } catch (e) {}
      this.decoder = null;
    }
  }
}
