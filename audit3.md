# Аудит системы видеозвонков (WebRTC/WebSocket Relay)

В ходе анализа была проведена полная сверка исходного кода тестовой версии (папка `test/`) и основной версии приложения. Выявлены критические логические расхождения, влияющие на производительность, задержки (лагание) и стабильность воспроизведения.

---

## 🔴 1. ЗАБЫТЫЕ ПРАВКИ (Forgotten Fixes)
*Критически важный код из "теста", который не был перенесен или был утерян в "основе".*

### 1.1. Отсутствие поддержки Loopback (WebSocket & Server)
*   **Проблема**: В основной версии в файле `server.ts` отсутствует обработка параметра `loopback`. Сервер всегда исключает отправителя из рассылки: `if (client !== ws ...)`. В тестовой версии это реализовано так: `if ((client !== ws || isLoopback) ...)`.
*   **На что влияет**: Невозможность корректного тестирования "на самом себе" (Loopback). Клиент не получает свои же пакеты, RTT не замеряется через пинги, адаптивный битрейт (ABR) работает некорректно или вообще не стартует.
  
### 1.2. Пропуск сигнализации ориентации при старте
*   **Проблема**: В `useSecureRelayCall.ts` (основа) метод `startFallbackRecording` не отправляет начальное сообщение `rotation`. В "тесте" сразу после старта движка идет: `ws.send(JSON.stringify({ type: 'rotation', ... }))`.
*   **На что влияет**: Удаленный участник видит "черный экран" или видео в неправильной ориентации до тех пор, пока отправитель вручную не нажмет кнопку поворота.

### 1.3. Отсутствие синхронизации состояния ориентации (UI Sync)
*   **Проблема**: В `onmessage` основной версии при получении типа `rotation` обновляются только декодеры. В тестовой версии также обновляется локальный стейт: `setRemoteRotation(msg.value); setRemoteMirror(msg.mirror);`.
*   **На что влияет**: Рассинхрон UI-компонентов и реального отображения на канвасе. Если интерфейс зависит от этих стейтов, он будет показывать неактуальные данные.

### 1.4. Логика перезапуска при смене поддержки WebM
*   **Проблема**: В `setRemoteSupportsWebM` основной версии забыт блок перезапуска: `if (changed && connectionState === 'connected') { startRecording(); }`.
*   **На что влияет**: Если тип стриминга (WebM vs H.264) должен переключиться "на лету" (например, при переподключении), основной код продолжит слать данные старым методом, что приведет к ошибкам декодирования.

---

## 🟡 2. ЛИШНИЙ КОД / ОШИБКИ ПЕРЕНОСА (Transfer Errors)
*Различия в реализации, которые ломают логику или добавляют мусор.*

### 2.1. Ошибка в именовании и области видимости `nextPlayTime` (Аудио)
*   **Проблема**: В `useSecureRelayCall.ts` основной версии внутри `playAudioChunk` объявлена локальная переменная `let nextPlayTime = 0;` (строка 333), которая **не используется**. Вместо нее используется `nextPlayTimeRef.current`. В тестовой версии это была переменная замыкания, которая сбрасывалась при перезапуске цикла.
*   **На что влияет**: Потенциальный джиттер звука. Если `nextPlayTimeRef` не был сброшен в ноль при старте нового "замеса" аудио-пакетов, первый пакет может попытаться воспроизвестись слишком далеко в будущем или в прошлом относительно `ctx.currentTime`.

### 2.2. Избыточность в `requestKeyframe`
*   **Проблема**: В основной версии клиент шлет `senderId` в JSON-сообщении запроса ключа. Тестовая версия шлет просто `{ type: 'requestKeyframe' }`. 
*   **На что влияет**: Если сервер или удаленные клиенты ожидают формат из "теста", они могут игнорировать запросы со встроенным `senderId`, либо наоборот — лишние данные в маленьких служебных пакетах могут вызвать задержки при обработке на слабом CPU.

### 2.3. Игнорирование RTT-апдейтов от PING в Loopback
*   **Проблема**: В `onmessage` основной версии отсутствует блок `else if (isLoopback)` для обработки собственных пингов как понгов.
*   **На что влияет**: В режиме петли (Loopback) график RTT будет "лежать на нуле", и движок `AdaptiveH264Engine` будет ошибочно считать, что сеть идеальна, задирая битрейт до максимума, что приводит к лагам.

---

## 🛠 3. КАК ИСПРАВИТЬ (Code Snippets)

### [FIX 1] Исправляем Loopback на сервере (`server.ts`)
Замените блок обработки сообщений:
```typescript
// В server.ts
ws.on('message', (message, isBinary) => {
  const roomClients = rooms.get(roomId);
  if (roomClients) {
    // ... сборка relayedMessage ...
    const queryParams = new URL(request.url || '', `http://${request.headers.host}`).searchParams;
    const isLoopback = queryParams.get('loopback') === 'true';

    roomClients.forEach((client) => {
      if ((client !== ws || isLoopback) && client.readyState === WebSocket.OPEN) {
        client.send(relayedMessage, { binary: isBinary });
      }
    });
  }
});
```

### [FIX 2] Добавляем сигнализацию поворота при старте (`useSecureRelayCall.ts`)
В методе `startFallbackRecording` после `adaptiveEngineRef.current.start()` добавьте:
```typescript
if (wsRef.current?.readyState === WebSocket.OPEN) {
  wsRef.current.send(JSON.stringify({ 
    type: 'rotation', 
    value: remoteRotation, 
    mirror: remoteMirror, 
    sid: mySidRef.current 
  }));
}
```

### [FIX 3] Восстанавливаем замер RTT в Loopback (`useSecureRelayCall.ts`)
В `ws.onmessage` для строковых сообщений:
```typescript
if (msg.type === 'ping') {
  if (msg.sid !== mySidRef.current) {
    ws.send(JSON.stringify({ type: 'pong', ts: msg.ts, sid: msg.sid }));
  } else if (isLoopback) { // <-- ЭТОГО НЕ ХВАТАЛО
    const rtt = Math.max(0, performance.now() - msg.ts);
    rttRef.current = rtt;
    setStats(prev => ({ ...prev, rtt }));
    if (adaptiveEngineRef.current) adaptiveEngineRef.current.updateRTT(rtt);
    (Object.values(h264DecodersRef.current) as H264Decoder[]).forEach(d => d.updateRTT(rtt));
  }
  return;
}
```

### [FIX 4] Удаляем "мусор" и чиним синхронизацию аудио (`useSecureRelayCall.ts`)
В блоке `playAudioChunk` удалите лишнюю строку 333 и убедитесь, что `nextPlayTimeRef.current` сбрасывается в 0 при пересоздании контекста (это уже есть в `cleanupPCMAudio`, но проверьте вызов в `initAudioContexts`).
