# Отчет по аудиту системы видеостриминга (H.264 / PCM Relay)

Этот отчет содержит сравнение тестовой (рабочей) версии из `test/` и основной версии из `dgocker/`. Найдены критические расхождения, влияющие на плавность звука, задержку видео и стабильность при сетевых всплесках.

## 🔴 ЗАБЫТЫЕ ПРАВКИ (Критично)

1.  **Синхронизация и планировщик Аудио (`useSecureRelayCall.ts`)**:
    *   **Проблема**: В основной версии переменная `nextPlayTime` (строка 333) объявлена локально, но не используется. Вместо нее используется `nextPlayTimeRef.current`. При этом `nextPlayTimeRef.current` не изолирован для каждого цикла воспроизведения, что может приводить к накоплению задержки или "заиканию" при переподключении. В тесте используется замыкание (closure), которое гарантирует плавность.
    *   **Влияние**: Прерывистый или запаздывающий звук.

2.  **Защита от "Zombie RTT" (`AdaptiveH264Engine.ts`)**:
    *   **Проблема**: В тесте (строки 446-461) реализована проверка `rtt > 500 && this.bufferedGradient > 0`. Если RTT растет, а буфер пуст — это ложный всплеск (потери TCP), который нужно игнорировать. В основе эта логика упрощена или отсутствует.
    *   **Влияние**: Необоснованное падение битрейта и "рассыпание" картинки при малейших потерях пакетов.

3.  **Ограничение долга токенов (Debt Capping) (`AdaptiveH264Engine.ts`)**:
    *   **Проблема**: В тесте добавлена проверка `maxDebt = -this.targetBitrate / 40`. Если энкодер выдал огромный кадр, мы "прощаем" долг быстрее, чтобы видео не замирало на 5-6 секунд. В основе этого нет.
    *   **Влияние**: Видео "виснет" после резких движений в кадре.

4.  **Параметр Loopback (`useSecureRelayCall.ts`)**:
    *   **Проблема**: В URL WebSocket не пробрасывается `${isLoopback ? '&loopback=true' : ''}`.
    *   **Влияние**: Невозможность корректного тестирования "на себе".

## 🟡 ЛИШНИЙ КОД / ОШИБКИ ПЕРЕНОСА

1.  **Разделение ответственности по Orientation**:
    *   В основе `remoteRotation`, `remoteMirror` передаются как пропсы, но хук `useSecureRelayCall` не имеет `useEffect` слушателей для системных событий ориентации, которые есть в тесте. Кроме того, в тесте хук сам управляет этими состояниями, что делает его более автономным и надежным.

2.  **Лишние логи/Отсебятина в комментариях**:
    *   В основе много комментариев вида `// Attempt 4: Baseline Profile`, которых нет в тесте. Логи `addLog` в `H264Decoder` вырезаны, что затрудняет диагностику "лагов" на стороне клиента.

---

## 🛠 КАК ИСПРАВИТЬ

### 1. Исправляем планировщик аудио в `useSecureRelayCall.ts`

**Заменить блок `playAudioChunk` (примерно строки 331–389) на:**

```typescript
  const playAudioChunk = (chunk: ArrayBuffer | Uint8Array, senderTs: number = 0) => {
    if (!receiverAudioContextRef.current) {
      receiverAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    }

    audioJitterBufferRef.current.push({ data: chunk, senderTs });
    if (audioJitterBufferRef.current.length > 150) audioJitterBufferRef.current.shift();

    if (!(receiverAudioContextRef.current as any)._isLoopStarted) {
      (receiverAudioContextRef.current as any)._isLoopStarted = true;
      let nextPlayTime = 0; // Используем локальную переменную в замыкании
      
      const playLoop = () => {
        if (isCleanedUpRef.current) return;
        
        const ctx = receiverAudioContextRef.current!;
        if (audioJitterBufferRef.current.length > 0) {
          const packet = audioJitterBufferRef.current[0];
          const firstDecoder = Object.values(h264DecodersRef.current)[0];
          const stats = firstDecoder?.getStats();
          
          if (stats && stats.firstPlayoutTime > 0) {
            const videoOffset = packet.senderTs - stats.firstSenderTs;
            const targetPlayTime = stats.firstPlayoutTime + videoOffset + stats.targetDelay;
            const now = performance.now();

            if (now < targetPlayTime - 10) {
              setTimeout(playLoop, 10);
              return;
            }
            if (now - targetPlayTime > (stats.dropThreshold || 500)) {
               audioJitterBufferRef.current.shift();
               setTimeout(playLoop, 5);
               return;
            }
          }

          if (ctx.state === 'suspended') ctx.resume();

          const audioBuffer = ctx.createBuffer(1, packet.data.byteLength, SAMPLE_RATE);
          const pcm8 = new Uint8Array(packet.data);
          const f32 = new Float32Array(pcm8.length);
          for (let i = 0; i < pcm8.length; i++) f32[i] = (pcm8[i] / 127.5) - 1.0;
          audioBuffer.copyToChannel(f32, 0);

          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(ctx.destination);

          const currentTime = ctx.currentTime;
          if (nextPlayTime < currentTime) {
            nextPlayTime = currentTime + 0.04;
          }
          
          source.start(nextPlayTime);
          nextPlayTime += audioBuffer.duration;
          audioJitterBufferRef.current.shift();
          
          const delay = audioJitterBufferRef.current.length > 10 ? 5 : 15;
          setTimeout(playLoop, delay);
          return;
        }
        setTimeout(playLoop, 20);
      };
      playLoop();
    }
  };
```

### 2. Защита от всплесков RTT в `AdaptiveH264Engine.ts`

**В методе `updateRTT(rtt: number)` заменить логику обработки всплеска (строки 426+) на:**

```typescript
    if (rtt > 500 && this.bufferedGradient > 0) { 
      if (this.onLog) this.onLog(`🚨 EXTREME RTT SPIKE ${rtt}ms + Buffer Growth — dropping bitrate by 50% and flushing queue`);
      this.targetBitrate = Math.max(this.minBitrate, this.targetBitrate * 0.5);
      this.sendQueue = []; 
      this.applyBitrateToParams();
      this.rttHistory = [this.lastSmoothed rtt || 200]; 
      return;
    } else if (rtt > 500) {
      if (this.onLog) this.onLog(`⚠️ RTT Spike ${rtt}ms but buffer draining (TCP loss). Ignoring.`);
      this.rttHistory = [this.lastSmoothedRtt || 200]; 
      return;
    }
```

### 3. Долг токенов (Debt Capping) в `AdaptiveH264Engine.ts`

**В методе `loop` (строка 581) добавить:**

```typescript
      const maxDebt = -this.targetBitrate / 40; // Максимум 0.2 сек долга
      if (this.tokenBucketBytes < maxDebt) {
        this.tokenBucketBytes = maxDebt;
      }
```

### 4. Исправление `requestKeyframe` и логирования в `H264Decoder.ts`

**Вернуть логи в `pushPacket` (строка 153+) и убрать `senderId` из запроса, если сервер его не ждет (по аналогии с тестом):**

```typescript
        if (Math.abs(newTarget - this.targetDelay) > 40) {
          if (this.onLog) {
            this.onLog(`📊 Adapting targetDelay to ${Math.round(this.targetDelay)}ms (p95=${Math.round(p95)}ms, RTT=${Math.round(this.currentRtt)}ms)`);
          }
        }
```
