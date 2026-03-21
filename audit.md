# Master Audit Report

## 🔴 Критичные (Падения, блокировки, фундаментальные ошибки)

### 1. Бесконечный цикл I-кадров (Keyframe Death Loop)
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** Введено жесткое ограничение: если размер закодированного кадра > 250 КБ, он отбрасывается, запрашивается новый I-кадр и битрейт режется на 60%. При установленном "Infinite GOP" на разрешении 1080p любой I-кадр превышает 250 КБ. Это приводит к зацикливанию системы (сотни запросов I-кадров подряд) и остановке видео.
**Локация:** `AdaptiveH264Engine.ts` (метод `processEncodedFrame`)
**Решение:**
```typescript
// Заменить лимит в 250 КБ на адекватный для высоких битрейтов (например, 1.5 МБ)
if (data.length > 1500000) { 
  this.needsKeyframe = true;
  this.targetBitrate *= 0.4;
  return;
}
```

### 2. Зависание Pacer (Токены в глубоком минусе)
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** При отправке крупного I-кадра алгоритм Pacer вычитает его вес из `tokenBucketBytes`, уводя счетчик в космический минус (до -45848). Pacer полностью блокируется, очередь переполняется, возникает "RTT Panic", которая неверно ставит Pacer на паузу. Возникает deadlock, приводящий к падению `AbortError`.
**Локация:** `AdaptiveH264Engine.ts` (методы `runPacer` и логика в `loop`)
**Решение:**
```typescript
// Ограничить нарастание задолженности токенов
this.tokenBucketBytes = Math.max(-100000, this.tokenBucketBytes + tokensToAdd);

// Обязательно убрать паузу Pacer при высоких значениях RTT (isPacerPaused = true).
```

### 3. Мертвая блокировка декодера (Сломанный Catch-up)
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** Логика "догона" пытается найти ключевой кадр для сброса старых накопившихся кадров (`latestKeyIdx > 0`). Из-за Infinite GOP I-кадров в буфере почти никогда нет. Переменная остаётся `-1`, массив не очищается, задержка растёт до бесконечности, заставляя декодер перегреваться.
**Локация:** `H264Decoder.ts` (метод `playNext`)
**Решение:**
```typescript
if ((bufferDuration > 400 || this.jitterBuffer.length > 30) && latestKeyIdx === -1) {
    this.jitterBuffer = []; // Немедленно сбросить буфер
    if (this.onRequestKeyframe) this.onRequestKeyframe(true);
}
```

### 4. Игнорирование сигнала Backpressure
**Суть проблемы:** Сервер шлёт команду `backpressure`, но `AdaptiveH264Engine` игнорирует её благодаря жесткому кулдауну: `if (now - this.lastConfiguredTs < 2000) return;`. Сервер начинает молча дропать фреймы (512 КБ), безвозвратно ломая поток.
**Локация:** `AdaptiveH264Engine.ts` (метод `triggerBackpressure`)
**Решение:**
```typescript
// Переопределить кулдаун при backpressure и обнулять очередь Pacer
public triggerBackpressure() {
    this.pacerTokens = Math.min(this.pacerTokens, 0); 
    this.targetBitrate *= 0.7;
    this.applyBitrateToParams(true); // Форсируем применение в обход lastConfiguredTs
}
```

## 🟡 Сеть и Логика

### 1. Отсутствие TCP_NODELAY (Алгоритм Нейгла)
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** На сервере не отключен Nagle's Algorithm (остался закомментирован). Мелкие пакеты (Ping/Pong/Управление) искусственно задерживаются системой в ожидании накопления крупных видеокадров, вызывая фантомный RTT в сотни миллисекунд.
**Локация:** `server.ts` (обработчик WebSocket `connection`)
**Решение:**
```typescript
const rawSocket = (ws as any)._socket;
if (rawSocket) {
  rawSocket.setNoDelay(true); // Критически важно для Ping
  if (typeof rawSocket.setSendBufferSize === 'function') {
      try {
          rawSocket.setSendBufferSize(256 * 1024);
      } catch (e) {}
  }
}
```

### 2. Слишком низкие пороги буфера сокетов
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** Значения переполнения буфера ОС жестко захардкожены. На 10-50 Мбит/с каналах аудио отбрасывается уже при 16 КБ буфера сокета, а сервер начинает "тихий дроп" видео при 512 КБ, что критически мало.
**Локация:** `useSecureRelayCall.ts` и `server.ts`
**Решение:**
```typescript
// useSecureRelayCall.ts (Аудио транспорт)
if (buffered > 65536) return; // Вместо 16384

// server.ts (Реле видео)
const MAX_BUFFER = 5242880; // Расширить до 5 MB
if (isBinary && client.bufferedAmount > MAX_BUFFER) {
    // Безопасный дроп пакетов
}
```

### 3. Рассинхрон таймеров Pacer (Event Loop)
**🔥 Подтверждено несколькими аудитами**
**Суть проблемы:** Pacer завязан на нестабильный `setInterval(..., 5)`. При переходе вкладки мобильного браузера в фон или при нагрузке на UI, браузер группирует таймеры до 10-50 мс, провоцируя отправку мегабайта данных за один "тик", убивая Congestion Window протокола TCP.
**Локация:** `AdaptiveH264Engine.ts`
**Решение:**
```typescript
// Задействовать Web Worker для точного тиканья таймера или requestAnimationFrame
const pacerDeltaMs = Math.min(50, performance.now() - this.lastPacerRun);
// Использовать динамический лимит токенов, зависящий от времени между тиками
```

### 4. Некорректный сброс P-кадров в плеере
**Суть проблемы:** При "панике" декодер иногда отбрасывает дельта-кадры (P-frames) без немедленного запроса IDR-кадра (PLI). Потеря любого P-кадра ломает цепочку предсказаний H.264 до следующего I-кадра (фриз на несколько секунд).
**Локация:** `H264Decoder.ts` (методы `pushPacket` или `playNext`)
**Решение:**
```typescript
if (isPanic && packet.type === 'delta') {
    if (this.onRequestKeyframe) this.onRequestKeyframe(true);
    // Дроп возможен только в связке с ожиданием нового I-кадра
}
```

## 🟢 Оптимизация

### 1. Жесткий лимит `pendingFrames` душит FPS
**Суть проблемы:** Хардкодная проверка размера очереди на кодирование убивает фреймрейт. Система отбрасывает более 30% кадров до начала работы кодека даже при идеальном канале (50 Мбит/с).
**Локация:** `AdaptiveH264Engine.ts` (`processFrame`)
**Решение:**
```typescript
const maxPending = this.targetBitrate > 5000000 ? 30 : 15;
if (this.pendingFrames > maxPending || this.encoder.encodeQueueSize > 25) {
    return false;
}
```

### 2. Отключение WebSocket-компрессии (`perMessageDeflate`)
**Суть проблемы:** Попытка сжимать на лету уже кодированный и плотный H.264 видеопоток через встроенный `perMessageDeflate` создает 100% нагрузку на CPU сервера без какой-либо пользы в размере пакетов.
**Локация:** `server.ts`
**Решение:**
```typescript
const wss = new WebSocketServer({ 
    port: 8080, 
    perMessageDeflate: false 
});
```
