# Аудит реализации видеостриминга (Secure Relay)

Дядя, я провел полный аудит кода. Ситуация следующая: при переносе из `test/` в основную ветку вы не просто "где-то ошиблись", вы сломали архитектуру управления состоянием и забыли пробросить критические флаги инициализации. Основные тормоза и "рассыпание" видео связаны с тем, что энкодер и декодер живут своей жизнью, не синхронизируясь с настройками пользователя, а обратная связь по ключевым кадрам работает "вхолостую".

## 1. 🔴 ЗАБЫТЫЕ ПРАВКИ

Эти фрагменты кода есть в «тесте», но они испарились в «основе». Без них система работает в режиме «слепого полета».

### А. Сигнализация начальной ротации (`useSecureRelayCall.ts`)
В тесте при старте `startFallbackRecording` отправляется текущий стейт ротации. В основе этого нет.
*   **На что влияет:** Получатель видит перевернутую картинку до тех пор, пока вы вручную не нажмете кнопку поворота.
*   **Где:** `src/hooks/useSecureRelayCall.ts` внутрь `startFallbackRecording`.

### Б. Loopback Mode (`useSecureRelayCall.ts` и `server.ts`)
В основе забыли прокинуть флаг `loopback` в URL вебсокета и обработать собственные пинги.
*   **На что влияет:** Невозможно нормально тестировать задержки на одном устройстве, RTT всегда будет 0 или около того, адаптивный битрейт не включится.

### В. Отсутствие `targetFps` в статистике (`useSecureRelayCall.ts`)
В основе `stats` не содержит `targetFps`.
*   **На что влияет:** Вы не видите, когда GCC (Congestion Control) намеренно занижает FPS до 10 из-за плохой сети. Кажется, что это "фриз", хотя это штатная работа адаптации.

---

## 2. 🟡 ЛИШНИЙ КОД / ОШИБКИ ПЕРЕНОСА

Здесь вы добавили "отсебятину" или некорректно изменили логику теста.

### А. Архитектурная поломка ориентации (`useSecureRelayCall.ts`)
Это **самая грубая ошибка**. В тесте хук САМ хранит `remoteRotation/Mirror/FlipV` и обновляет декодеры. В основе вы вынесли эти переменные в аргументы хука.
*   **Ошибка:** Хук `useSecureRelayCall` в основе НЕ имеет `useEffect`, который следит за изменением этих пропсов. Если родительский компонент поменяет `remoteRotation`, хук об этом не узнает и `decoder.setRotation()` не вызовет. Видео так и останется не повернутым.
*   **Следствие:** Конфликт логики. В `H264Decoder` вы добавили "Always Vertical", который пытается фиксить поворот на уровне Canvas, но без внешнего сигнала ротации он делает это непредсказуемо.

### Б. Конфликтные константы звука (`useSecureRelayCall.ts`)
В комментариях написано `SAMPLE_RATE = 8000`, в коде `16000`. В `playAudioChunk` лишняя локальная переменная `nextPlayTime`, которая перекрывает `nextPlayTimeRef`.
*   **На что влияет:** Звук может "плыть" или иметь микро-паузы из-за неправильного планирования (drift).

---

## 3. 🛠 КАК ИСПРАВИТЬ

Замените/добавьте следующие блоки кода в основной проект:

### 1. Исправление `useSecureRelayCall.ts` (Синхронизация и стейт)

Добавьте `useEffect` для отслеживания изменений пропсов ориентации:
```typescript
  // Добавить в useSecureRelayCall.ts
  useEffect(() => {
    (Object.values(h264DecodersRef.current) as H264Decoder[]).forEach(d => {
      d.setRotation(remoteRotation);
      d.setMirror(remoteMirror);
      d.setFlipV(remoteFlipV);
    });
  }, [remoteRotation, remoteMirror, remoteFlipV]);
```

Исправьте `startFallbackRecording`, чтобы отправлять настройки сразу:
```typescript
  // Внутри startFallbackRecording
  const video = fallbackVideoRef.current;
  // ... (после создания адаптивного движка)
  if (wsRef.current?.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify({ 
      type: 'rotation', 
      value: remoteRotation, 
      mirror: remoteMirror, 
      sid: mySidRef.current 
    }));
  }
```

### 2. Исправление `AdaptiveH264Engine.ts` (Логирование затыка)

Верните детальное логирование в `loop`, чтобы понимать, ПОЧЕМУ дропаются кадры:
```typescript
  // Заменить блок в loop (AdaptiveH264Engine.ts)
  if (bufferedAmount > maxWsBuffer || isInternalQueuePanic) {
    this.droppedFrames++;
    // ... (статистика)
    if (this.onLog && this.frameId % 60 === 0) {
      let reason = "";
      if (bufferedAmount > maxWsBuffer) reason += `WS_BUF(\${Math.round(bufferedAmount/1024)}K > \${Math.round(maxWsBuffer/1024)}K) `;
      if (isInternalQueuePanic) reason += `Q_PANIC(\${this.sendQueue.length}f, \${Math.round(queueBytes/1024)}K) `;
      this.onLog(`Skipping frame: \${reason}`);
    }
    // ...
  }
```

### 3. Исправление `H264Decoder.ts` (Тайминги)

Верните `CATCH-UP` логи в `playNext`, иначе вы не узнаете, что буфер переполнен:
```typescript
    // В H264Decoder.ts -> playNext
    if (isPanic || isBufferLarge) {
      if (this.onLog && packet.frameId % 15 === 0) {
        this.onLog(`🚨 CATCH-UP: frame \${packet.frameId} is \${Math.round(now - targetPlayTime)}ms late. Buffer=\${this.jitterBuffer.length}. Playing immediately.`);
      }
    }
```

**Рекомендация:** Верните управление стейтом ориентации внутрь хука `useSecureRelayCall`, как это сделано в `test`. Это гарантирует, что поворот видео — это атомарная операция стриминга, а не внешняя переменная, которая может прийти с задержкой от React.
