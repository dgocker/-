# Аудит системы видеостриминга (Secure Relay + Custom H.264)
## Отчет: audit5.md

Данный аудит сравнивает основную версию кода (`/-/src/`) с эталонной тестовой версией (`/test/src/`), в которой стриминг работает идеально. Цель — выявить причины лагов, фризов и артефактов в основной версии.

---

### 1. 🔴 ЗАБЫТЫЕ ПРАВКИ (Forgotten Fixes)
Эти изменения присутствуют в `test/`, но были пропущены при переносе в основную ветку.

#### 1.1. Отсутствие расширенного логирования в `H264Decoder.ts`
В тестовой версии добавлены критически важные логи для отладки джиттер-буфера и механизмов восстановления. Без них невозможно понять, в чем причина фризов на стороне клиента.

**Файл:** [H264Decoder.ts](file:///home/deck/Games/antig/-/src/utils/H264Decoder.ts)

**Что исправить (добавить логи):**
```typescript
// В методе playNext
if (this.onLog) {
  this.onLog(`📊 Adapting targetDelay to ${Math.round(this.targetDelay)}ms (p95=${Math.round(p95)}ms, RTT=${Math.round(this.currentRtt)}ms)`);
}

// В блоке Fast Recovery
if (this.onLog) {
  this.onLog(`🚀 FAST RECOVERY: Skipping ${latestKeyIdx} frames to latest keyframe (bufferDuration=${Math.round(bufferDuration)}ms)`);
}

// При чтении кадра
if (this.onLog && packet.frameId % 30 === 0) {
  this.onLog(`▶ Playing frame ${packet.frameId}: delay=${Math.round(now - targetPlayTime)}ms, targetDelay=${this.targetDelay}, buffer=${this.jitterBuffer.length}`);
}
```

#### 1.2. Обработка сенсора ориентации в `useSecureRelayCall.ts`
В `test/` есть `useEffect`, который отслеживает изменение ориентации устройства. В основной версии он полностью отсутствует, что приводит к некорректному отображению видео при повороте экрана.

**Файл:** [useSecureRelayCall.ts](file:///home/deck/Games/antig/-/src/hooks/useSecureRelayCall.ts)

**Код для восстановления:**
```typescript
useEffect(() => {
  const handler = () => {
    const angle = screen.orientation?.angle ?? (window.orientation as number) ?? 0;
    addLog(`📱 Device orientation changed: ${angle}deg`);
  };

  window.addEventListener('orientationchange', handler);
  if (screen.orientation) {
    screen.orientation.addEventListener('change', handler);
  }
  
  return () => {
    window.removeEventListener('orientationchange', handler);
    if (screen.orientation) {
      screen.orientation.removeEventListener('change', handler);
    }
  };
}, [addLog]);
```

#### 1.3. Синхронизация состояния ориентации
В `main` переменные `remoteRotation`, `remoteMirror` приходят как пропсы, но при получении сообщения `rotation` через WebSocket обновляется только декодер, а состояние пропсов (управляемое родителем) остается старым. Это может вызвать "прыжки" картинки.

**Файл:** [useSecureRelayCall.ts](file:///home/deck/Games/antig/-/src/hooks/useSecureRelayCall.ts) (обработчик `onmessage`)

**Что исправить:**
В тестовой версии используются локальные `useState` для этих параметров, что позволяет корректно реагировать на сигналы от удаленного пира.

---

### 2. 🟡 ЛИШНИЙ КОД / ОШИБКИ ПЕРЕНОСА (Transfer Errors)
Ошибки, допущенные при копировании или избыточные конструкции, мешающие работе.

#### 2.1. Конфликт переменных `nextPlayTime` в аудио-движке
В основной версии в `playAudioChunk` объявлена локальная переменная `let nextPlayTime = 0`, но фактически используется `nextPlayTimeRef.current`. Это создает путаницу и потенциальные баги при инициализации очереди.

**Файл:** [useSecureRelayCall.ts](file:///home/deck/Games/antig/-/src/hooks/useSecureRelayCall.ts) (строка ~333)

**Рекомендация:** Удалить `let nextPlayTime = 0` внутри `playLoop` и использовать логику замыкания из `test/` для максимальной плавности.

#### 2.2. Некорректные комментарии и путаница с SampleRate
В `main` комментарий гласит: `Reduced from 16000 to save bandwidth`, хотя в коде стоит `16000`. В другом месте (`startPCMAudioSender`) комментарий говорит про `8 kHz / 256 samples`, хотя код настроен на `16 kHz / 1024 samples`. 
**Риск:** Разработчик, ориентируясь на комментарии, может выставить неверные параметры в смежных модулях, что приведет к "роботизированному" звуку или лагам из-за несовпадения буферов.

#### 2.3. Избыточность `senderId` в `requestKeyframe`
В `main` через WebSocket отправляется `{ type: 'requestKeyframe', senderId }`. Поскольку сервер просто транслирует это сообщение всем в комнате, это может привести к тому, что ВСЕ участники будут генерировать ключевые кадры одновременно, забивая канал (особенно при микро-зависаниях у одного из участников).

**Исправление:** Реализовать фильтрацию по `senderId` на стороне приемника или вернуться к упрощенной схеме из `test/`, если это Peer-to-Peer.

---

### 3. 🏁 ЗАКЛЮЧЕНИЕ И РЕКОМЕНДАЦИИ
Основная причина лагов — **отсутствие обратной связи (логов)** в декодере и **недоработки в синхронизации ориентации**. В `AdaptiveH264Engine.ts` основные механизмы (Pacer, Congestion Control) перенесены верно, но в `H264Decoder.ts` механизмы Catch-up работают "вслепую".

**Первоочередные действия:**
1. Вернуть все `addLog` и `onLog` вызовы в `H264Decoder.ts` из тестовой версии.
2. Восстановить `useEffect` для отслеживания ориентации.
3. Исправить SampleRate комментарии, чтобы они соответствовали коду (16000 Гц).
4. Проверить, не вызывается ли `forceKeyframe` слишком часто из-за широковещательных сообщений.

Данные правки приведут `main` в полное соответствие с идеально работающим `test`.
