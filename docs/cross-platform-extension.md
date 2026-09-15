# Архитектурное руководство по расширению Telemost Recorder на внешние платформы (Cross-Platform Extension)

## 1. Executive Summary

### 1.1. Текущие возможности Telemost Recorder
Система `telemost-recorder` представляет собой специализированный сервис записи и транскрибации видеоконференций. В текущем виде система оптимизирована для работы с сервисом **Яндекс.Телемост** и обеспечивает:
* **Перехват отдельных WebRTC-аудиопотоков (Per-track Audio Capture)**: Через инжекцию JavaScript в headless-браузер (Playwright/Puppeteer) с помощью `page.evaluateOnNewDocument` перехватываются вызовы `window.RTCPeerConnection`. Каждый входящий `MediaStreamTrack` записывается в изолированный файл (`tracks/<trackId>.webm`).
* **Параллельная запись микшированного потока**: Запись общего суммарного аудио встречи (`meeting_audio.webm`) для резервного использования.
* **Регистрация временных событий (Track Events & Meeting Clock)**: Формирование NDJSON-журнала (`meta/track_events.ndjson`) с отметками времени добавления/удаления треков, переключения активного спикера и подключения участников (`meetingClock`).
* **Атрибуция спикеров и сопоставление метаданных**: Модуль `services/speakerAttribution.js` связывает WebRTC-треки с DOM-элементами карточек участников, извлекая `participantId`, `displayName` и уровень достоверности (`confidence`).
* **Мульти-трековое и резервное распознавание (ASR Pipeline)**: Модуль `services/perTrackTranscription.js` выполняет распознавание речи по отдельным трекам участников через AssemblyAI / Groq, производит объединение реплик (`mergeTrackUtterances`), расчёт достоверности атрибуции (`enrichUtteranceConfidence`) и устранение дубликатов при переподключениях (`resolveParticipantTracks`).
* **Сессионный реестр биометрических профилей**: Внутрипамяточный сервис `VoiceprintSession` (`services/voiceprintSession.js`) хранит сопоставления участников и WebRTC-треков на протяжении всей сессии.

### 1.2. Платформонезависимые компоненты (Переиспользуемый стек)
При расширении системы на внешние платформы видеоконференций **без изменений** переиспользуется весь аналитический и распознавательный контур:
1. `services/speakerAttribution.js` — бизнес-логика нормализации метаданных, расчёта часов встречи (`createMeetingClock`), выбора лучшего мета-кандидата (`pickBestMetadata`).
2. `services/perTrackTranscription.js` — алгоритм объединения временных отрезков реплик, ASR-интеграция, маппинг смещений записей треков (`track_recording_offset_ms`) и маппинг спикеров при аварийном переключении (`applyMixedTrackEventSpeakerRemap`).
3. `services/voiceprintSession.js` — реестр участников встречи, треков и биометрических метаданных.
4. `services/transcribe.js` & `services/vectorize.js` — ASR-клиенты и векторный анализ.
5. **Единый schema-контракт вывода (`utterance`)**:
   ```json
   {
     "speaker": "Иван Иванов",
     "original_speaker_label": "Спикер A",
     "text": "Коллеги, добрый день.",
     "start": 1.5,
     "end": 4.2,
     "trackId": "track-meet-102",
     "participantId": "p-google-883",
     "displayName": "Иван Иванов",
     "speaker_provenance": "dom-active-speaker",
     "speaker_confidence": 0.95,
     "needs_human_review": false,
     "merged_tracks": []
   }
   ```

### 1.3. Цели мультиплатформенной адаптации
Главная задача архитектурного расширения — вынести браузерно-специфичный код подключения и парсинга DOM из `recorder.js` в модульную систему **Platform Adapters** (платформенных адаптеров). Это позволит изолировать особенности каждой видеоплатформы (Google Meet, Zoom, Microsoft Teams, Jitsi Meet, LiveKit) и предоставлять ядру системы унифицированный интерфейс управления треками и метаданными.

---

## 2. Общая адаптерная архитектура (Platform Adapter Architecture)

### 2.1. Концепция Platform Adapter
Платформенный адаптер (Platform Adapter) — это абстрактный класс/интерфейс, реализующий специфичную для каждой целевой видеоплатформы логику:
* Инжекция WebRTC/AudioContext-перехватчиков в Chromium.
* Парсинг DOM-дерева и обработка MutationObserver для получения имен участников.
* Генерация стандартизированных событий жизненного цикла треков и участников.

```
+-----------------------------------------------------------------------+
|                         telemost-recorder Core                        |
|   (speakerAttribution.js, perTrackTranscription.js, VoiceprintSession) |
+-----------------------------------------------------------------------+
                                   ^
                                   | Unified Adapter Interface
+----------------------------------+------------------------------------+
|                                  |                                    |
v                                  v                                    v
+------------------+     +-------------------+                +-------------------+
| GoogleMeetAdapter|     |  JitsiMeetAdapter |                |  LiveKitAdapter   |
+------------------+     +-------------------+                +-------------------+
| Intercepts SDP & |     | Uses Native JS    |                | Uses LiveKit JS   |
| DOM MutationObs  |     | APP.conference API|                | SDK / Egress API  |
+------------------+     +-------------------+                +-------------------+
```

### 2.2. Интерфейс `PlatformAdapter` (JavaScript Specification)

Каждый адаптер должен наследоваться от базового класса или реализовывать следующий контракт:

```javascript
/**
 * Abstract Platform Adapter Interface
 */
export class PlatformAdapter {
  constructor(options = {}) {
    this.options = options;
    this.eventEmitter = null;
  }

  /**
   * Инициализация адаптера на странице Playwright/Puppeteer.
   * Вызывается до загрузки DOM (через evaluateOnNewDocument).
   * @param {import('puppeteer').Page} page
   */
  async injectCaptureHooks(page) {
    throw new Error('injectCaptureHooks() must be implemented');
  }

  /**
   * Подключение к браузерным событиям страницы после загрузки DOM.
   * @param {import('puppeteer').Page} page
   */
  async attachListeners(page) {
    throw new Error('attachListeners() must be implemented');
  }

  /**
   * Извлечение WebRTC-аудиопотоков участников.
   * @returns {Promise<Array<{ trackId: string, stream: MediaStream }>>}
   */
  async captureAudioTracks() {
    throw new Error('captureAudioTracks() must be implemented');
  }

  /**
   * Сопоставление trackId с метаданными участника встречи.
   * @param {string} trackId 
   * @returns {Promise<{ participantId: string|null, displayName: string|null, provenance: string, confidence: number }>}
   */
  async resolveParticipantMetadata(trackId) {
    throw new Error('resolveParticipantMetadata() must be implemented');
  }

  /**
   * Получение отображаемого имени участника по его внутреннему ID платформы.
   * @param {string} participantId 
   * @returns {Promise<string|null>}
   */
  async getDisplayName(participantId) {
    throw new Error('getDisplayName() must be implemented');
  }

  /**
   * Подписка на событие генерации метаданных треков.
   * @param {Function} callback 
   */
  onTrackEvent(callback) {
    this.onTrackEventCallback = callback;
  }

  /**
   * Отправка стандартизированного события в ядро recorder.js
   * @param {string} eventType ('track-added'|'track-removed'|'active-speaker-changed'|'participant-joined'|'participant-left')
   * @param {Object} payload 
   */
  emitTrackEvent(eventType, payload) {
    if (this.onTrackEventCallback) {
      this.onTrackEventCallback({
        type: eventType,
        timestamp: Date.now(),
        ...payload,
      });
    }
  }
}
```

### 2.3. Единый контракт событий (NDJSON Track Events Schema)
Адаптеры транслируют события платформы в единый формат NDJSON (`meta/track_events.ndjson`):

```json
{"event":"track-added","timestamp":1700000000100,"monoMs":1250,"trackId":"tr-101","participantId":"usr-42","displayName":"Алексей Смирнов","provenance":"dom-active-speaker","confidence":0.95}
{"event":"active-speaker-changed","timestamp":1700000005200,"monoMs":6350,"trackId":"tr-101","participantId":"usr-42","displayName":"Алексей Смирнов"}
{"event":"track-removed","timestamp":1700000040000,"monoMs":41150,"trackId":"tr-101","participantId":"usr-42"}
```

---

## 3. Платформенно-специфичные модули интеграции

### 3.1. Google Meet

#### DOM / API точки подключения
Google Meet использует WebRTC (Plan B в старых версиях, Unified Plan в современных) и динамически генерируемый HTML/Shadow DOM.
* **WebRTC**: Обезличенный перехват через monkey-patching `window.RTCPeerConnection.prototype.addTrack` и `ontrack`.
* **DOM-селекторы**: Использование `aria-label` и HTML5 атрибутов:
  - Панель участников: `div[data-participant-id]`
  - Плашка говорящего спикера: `div[data-self-name]`, `div[aria-label*="speaking"]`
  - Индикатор микрофона: `div[data-is-muted]`

#### Идентификация участников (`participantId`, `displayName`)
* **`participantId`**: Извлекается из атрибута `data-participant-id` или из SDP `msid` / SSRC идентификаторов WebRTC-соединения.
* **`displayName`**: Извлекается из DOM-элемента карточки видео/аудио потока (`div[data-self-name]` или текстового узла с именем внутри плитки участника).
* **Связывание трека с именем**: Отслеживание активности индикатора громкости (`SVG` / Waveform элемент в плитке спикера) через `MutationObserver`. При изменении атрибута активности микрофона треку сопоставляется `displayName` видимого спикера.

#### Технические ограничения
1. **Обфускация CSS-классов**: Google Meet постоянно меняет рандомизированные CSS-классы (например, `.ZW4Tcd`, `.Ah9uF`). Нельзя завязываться на имена классов — необходимо использовать стабильные атрибуты (`aria-label`, `data-participant-id`, `role`, `data-initial-participant-id`).
2. **CSP (Content Security Policy)**: Ограничивает прямое подключение внешних WebSocket/Worker скриптов в контексте страницы. Решается инжекцией через `page.evaluateOnNewDocument` в Playwright/Puppeteer.
3. **WebRTC Renegotiation**: Google Meet динамически добавляет и удаляет треки в рамках одного PeerConnection при включении/выключении микрофонов участниками.

#### Рекомендуемый подход
Сочетание перехвата `RTCPeerConnection` в `evaluateOnNewDocument` с параллельным мониторингом DOM через `MutationObserver` для отслеживания `aria-label` активного спикера.

#### Ссылки на открытые решения
* **Vexa (Open-Source Meeting Bot)**: [https://github.com/vexa-ai/vexa](https://github.com/vexa-ai/vexa)
* **ScreenApp Meeting Bot**: [https://github.com/screenappai/meeting-bot](https://github.com/screenappai/meeting-bot)
* **Recall.ai Open-Source Meeting Bot Architecture**: [https://github.com/recallai/meeting-bot](https://github.com/recallai/meeting-bot)

---

### 3.2. Zoom (Zoom Web Client & Web SDK)

#### DOM / API точки подключения
Zoom Web Client (**не** нативное приложение Zoom) существенно отличается от стандартных WebRTC-приложений:
* **Отсутствие стандартного `RTCPeerConnection`**: Zoom Web Client использует проприетарный протокол поверх WebSockets/WebTransport и декодирует аудио через WebAssembly (Wasm).
* **Точка подключения**: Перехват аудио осуществляется на уровне **`AudioContext`** и **`AudioWorkletNode`** Web Audio API, либо через перехват `AudioNode.prototype.connect`.

#### Идентификация участников (`participantId`, `displayName`)
* Zoom отрисовывает имена участников и сетку видео с помощью HTML5 `<canvas>`.
* **`displayName`**: Извлекается из DOM списка участников (Participant Side Panel: `div.navigation-item-name` или `span.participants-item__display-name`), если открыта боковая панель, либо с помощью OCR/Canvas Hooking.
* **`participantId`**: Извлекается из параметров Web SDK (события `user-added`, `active-speaker`) или аттрибутов элементов DOM-списка участников.

#### Технические ограничения
1. **Использование WebAssembly и SharedArrayBuffer**: Прямой перехват WebRTC-треков невозможно выполнить через `RTCPeerConnection`. Аудиопоток декодируется внутри Wasm-модуля Zoom.
2. **COOP / COEP Политики (Cross-Origin Isolation)**: Требуется поддержка `SharedArrayBuffer` в браузерном окружении.
3. **Canvas-рендеринг**: Имена участников не всегда присутствуют в DOM-дереве в виде текста — они могут быть отрисованы напрямую на холсте `<canvas>`.

#### Рекомендуемый подход
1. **Браузерный бот (Web Client)**: Перехват `AudioContext` в JavaScript (`window.AudioContext.prototype.createMediaStreamDestination`) для получения суммарного аудио или отдельных каналов AudioWorklet, совпадение по активности из боковой панели участников (`div.participants-item`).
2. **Аварийный режим (Graceful Fallback)**: Использование смешанного аудио (Mixed Audio) с акустической диаризацией (AssemblyAI / PyAnnote), так как per-track захват в Zoom Web без применения виртуального аудиокабеля или модификации Wasm крайне трудоёмок.
3. **Native / Headless Runner**: Запуск Zoom Linux Client внутри Docker контейнера с Xvfb + PulseAudio (Virtual Audio Cable) для сбора суммарного аудио с виртуальной системы.

#### Ссылки на открытые решения
* **ScreenApp Zoom Bot**: [https://github.com/screenappai/meeting-bot](https://github.com/screenappai/meeting-bot)
* **Recall.ai Cross-Platform Architecture**: [https://github.com/recallai/meeting-bot](https://github.com/recallai/meeting-bot)

---

### 3.3. Microsoft Teams (Web Client)

#### DOM / API точки подключения
Microsoft Teams Web Client построена на базе React/Angular и стандартного WebRTC Chromium.
* **WebRTC**: Перехват через `window.RTCPeerConnection.prototype.addTrack`.
* **DOM-селекторы**: Использование тестовых ID `data-tid`:
  - Карточка участника: `div[data-tid="calling-participant-stream"]`
  - Активный спикер: `div[data-tid="active-speaker-tile"]`
  - Имя участника: `span[data-tid="thread-tile-name"]`, `div[data-tid="author-name"]`

#### Идентификация участников (`participantId`, `displayName`)
* **`participantId`**: Уникальный идентификатор Azure AD (Object ID / MRI вида `8:orgid:a1b2c3d4...`), передаваемый в SDP-описании WebRTC или аттрибутах DOM.
* **`displayName`**: Текстовые элементы внутри `data-tid="calling-participant-stream"` или всплывающие атрибуты `aria-label`.

#### Технические ограничения
1. **Строгая аутентификация и Guest Lobby**: Teams требует прохождения ожидания в лобби (Lobby) и подтверждения организатором встречи.
2. **Многослойные Iframe и Shadow DOM**: Отдельные элементы управления видеопотоками размещаются внутри изолированных iframe.
3. **Динамические обновления HTML-шаблонов**: Частое изменение атрибутов компонентов при обновлениях MS Teams Web.

#### Рекомендуемый подход
Инжекция скрипта перехвата `RTCPeerConnection` до загрузки ресурсов Teams (`evaluateOnNewDocument`) и использование селекторов на базе `data-tid` атрибутов с отслеживанием списка участников в боковой панели.

#### Ссылки на открытые решения
* **ScreenApp Teams Bot**: [https://github.com/screenappai/meeting-bot](https://github.com/screenappai/meeting-bot)
* **Recall.ai Engine**: [https://github.com/recallai/meeting-bot](https://github.com/recallai/meeting-bot)

---

### 3.4. Jitsi Meet

#### DOM / API точки подключения
Jitsi Meet — полностью открытая платформой с официальным JavaScript API (`lib-jitsi-meet` и глобальный объект `APP` на странице).
* **API Подключения**: Глобальные объекты `window.APP.conference` и `window.JitsiMeetJS`.
* **События**:
  - `APP.conference.getAudioTracks()` — доступ к audio MediaStreamTracks.
  - `JitsiMeetJS.events.conference.TRACK_ADDED` — событие добавления трека.
  - `JitsiMeetJS.events.conference.DOMINANT_SPEAKER_CHANGED` — событие смены говорящего участника.

#### Идентификация участников (`participantId`, `displayName`)
* **`participantId`**: Метод `track.getParticipantId()` или `participant.getId()`.
* **`displayName`**: Метод `participant.getDisplayName()` или `APP.conference.getParticipantDisplayName(id)`.
* **Связывание**: Прямое и детерминированное 1:1 связывание `trackId` $\rightarrow$ `participantId` $\rightarrow$ `displayName` без необходимости анализа DOM!

#### Технические ограничения
Практически отсутствуют. Платформа предоставляет полный прозрачный access к WebRTC-потокам и событийно-ориентированный JS API.

#### Рекомендуемый подход
Прямая интеграция с `window.APP.conference` через инжекцию слушателей событий без модификации `RTCPeerConnection`. Сам адаптер получается наиболее компактным и надежным.

#### Ссылки на открытые решения
* **Официальный репозиторий Jitsi Meet**: [https://github.com/jitsi/jitsi-meet](https://github.com/jitsi/jitsi-meet)

---

### 3.5. LiveKit

#### DOM / API точки подключения
LiveKit — современная Open-Source WebRTC инфраструктура (SFU).
* **Client API**: `LiveKit Client SDK` (классы `Room`, `RemoteParticipant`, `RemoteTrackPublication`).
* **Server API**: `LiveKit Egress Service` — специализированный сервис записи на стороне медиа-сервера SFU.

#### Идентификация участников (`participantId`, `displayName`)
* **`participantId`**: `participant.identity` или `participant.sid`.
* **`displayName`**: `participant.name` или пользовательские `participant.metadata` (JSON).
* **Трек**: `trackPublication.trackSid` напрямую связан с `participant.identity`.

#### Технические ограничения
* При использовании клиентского браузерного бота ограничений нет.
* При использовании **LiveKit Egress (Server-side)** браузер вообще не требуется! Сервер Egress сам записывает отдельные аудиодорожки спикеров прямо из SFU-узла в файлы S3 / local disk.

#### Рекомендуемый подход
1. **Для веб-бота**: Подписка на события `RoomEvent.TrackSubscribed` и `RoomEvent.ActiveSpeakersChanged` в LiveKit JS SDK.
2. **Для серверной инфраструктуры**: Использование нативного **LiveKit Egress** (Track Egress / Composite Egress), что полностью исключает накладные расходы на запуск Chrome/Puppeteer.

#### Ссылки на открытые решения
* **LiveKit Egress Service**: [https://github.com/livekit/egress](https://github.com/livekit/egress)
* **LiveKit Documentation & Ecosystem**: [https://livekit.io](https://livekit.io)
* **plugNmeet (Open Source Meeting System on LiveKit)**: [https://github.com/mynaparrot/plugNmeet-server](https://github.com/mynaparrot/plugNmeet-server)

---

## 4. Матрица совместимости платформ (Platform Compatibility Matrix)

| Платформа | Метод захвата треков | Metadata Source (Имена) | Сложность разработки | Лицензия / Цена Cloud-решений |
|---|---|---|---|---|
| **Яндекс.Телемост** | `RTCPeerConnection` Intercept | DOM Selectors (`data-participant-id`) | **Низкая** (Реализовано) | Open-Source / Внутренний бот |
| **Jitsi Meet** | Native JS API (`APP.conference`) | JS API (`participant.getDisplayName()`) | **Низкая** | Open-Source / Free self-hosted |
| **LiveKit** | LiveKit SDK / Server Egress | SDK Metatada (`participant.identity`) | **Низкая (Egress)** | Apache-2.0 / Free self-hosted |
| **Google Meet** | `RTCPeerConnection` Intercept | DOM Selectors + MutationObserver | **Средняя** | Open-Source бота или Cloud (~$0.05/мин) |
| **Microsoft Teams** | `RTCPeerConnection` Intercept | DOM Selectors (`data-tid`) | **Средняя / Высокая** | Cloud SDK (Recall.ai ~$0.08/мин) |
| **Zoom Web Client** | AudioContext / AudioWorklet Hook | Canvas OCR / Side Panel DOM | **Высокая** | Cloud SDK (Recall.ai ~$0.05-0.10/мин) |

---

## 5. Стратегия аварийного переключения (Fallback Strategy)

### 5.1. Условия активации Fallback
Режим **Graceful Degradation** (переход с Per-track на Mixed Diarization) автоматически включается в следующих случаях:
1. Адаптер платформы не может изолировать индивидуальные WebRTC-треки участников (например, в Zoom Web Client при невозможности перехвата Wasm-модуля).
2. Браузерная политика безопасности (CSP/CORS) заблокировала monkey-patching `RTCPeerConnection`.
3. Платформа транслирует аудио всех участников единым сфокусированным SFU-миксом (Single Audio Stream).
4. Произошел сбой записи индивидуальных треков (`usedPerTrack = false`).

### 5.2. Graceful Degradation до Mixed Diarization
При активированном Fallback процесс записи и обработки перестраивается следующим образом:

```
[Target Platform (Zoom / Fallback)]
               │
               ▼
   Запись единого микшированного аудио
        (meeting_audio.webm)
               │
               ▼
┌──────────────────────────────────────────────┐
│  ASR Pipeline (AssemblyAI / PyAnnote / Groq) │
│  — Включение акустической диаризации          │
│  — Получение "Speaker A", "Speaker B"        │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  services/perTrackTranscription.js            │
│  applyMixedTrackEventSpeakerRemap()          │
│  — Сопоставление с DOM-событиями спикеров    │
│  — Ассоциация "Speaker A" -> "Иван Иванов"   │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│  services/voiceprintSession.js               │
│  — Идентификация по голосу (Voiceprints)     │
└──────────────────────────────────────────────┘
```

### 5.3. Алгоритм гибридного атрибутирования спикеров (Acoustic + DOM Alignment)
1. **Первичный маппинг**: Функция `applyMixedTrackEventSpeakerRemap` сопоставляет интервалы активности из `meta/track_events.ndjson` (события `active-speaker-changed` из DOM) с временными границами реплик акустической диаризации AssemblyAI/PyAnnote (при пересечении по времени > 0.5 сек).
2. **Вторичный маппинг (Global Speaker Label Remap)**: Если `Speaker A` хотя бы раз совпал по времени с активным DOM-спикером "Иван Иванов", метка `Speaker A` глобально заменяется на "Иван Иванов" для всех его реплик в файле.
3. **Voiceprint Matching**: Использование сохраненных в `VoiceprintSession` эмбеддингов голоса участников для окончательной разметки неизвестных отрезков.

---

## 6. Варианты развертывания (Deployment Options)

### 6.1. Self-Hosted / Open-Source решения

#### 1. Custom Puppeteer/Playwright Adapter Framework (Текущий подход)
* **Принцип**: Собственная библиотека ботов на базе Node.js, Playwright и `PlatformAdapter`.
* **Плюсы**: Нулевая стоимость лицензий, полный контроль над кодом, хранение данных On-Premise, единый пайплайн для всех платформ.
* **Минусы**: Требует поддержки DOM-селекторов при обновлениях Google Meet/Teams.

#### 2. LiveKit + Egress (Серверная запись)
* **Принцип**: Для встреч, проходящих на базе LiveKit / plugNmeet, задействуется Go-сервис **LiveKit Egress** (`https://github.com/livekit/egress`).
* **Плюсы**: Идеальное качество per-track записи, отсутствие накладных расходов на Chrome браузеры (снижение нагрузки на CPU до 80%).
* **Минусы**: Работает только для платформ на базе LiveKit.

#### 3. Jitsi Meet + Jibri
* **Принцип**: Использование **Jibri** (Jitsi Broadcasting Infrastructure) — официального сервиса записи Jitsi на базе headless Chrome и ALSA/FFmpeg.
* **Плюсы**: Официальный стандарт Jitsi.

#### 4. Vexa (Open-Source Meeting Bot Infrastructure)
* **Репозиторий**: [https://github.com/vexa-ai/vexa](https://github.com/vexa-ai/vexa)
* **Описание**: Открытая платформа ботов для видеоконференций (Google Meet, Zoom, Teams), поддерживающая транскрибацию в реальном времени.

### 6.2. Managed Cloud SDK / API

#### 1. Recall.ai
* **Сайт**: [https://www.recall.ai](https://www.recall.ai) | **Open-Source примеры**: [https://github.com/recallai/meeting-bot](https://github.com/recallai/meeting-bot)
* **Описание**: Универсальный API для подключения ботов к Zoom, Google Meet, Microsoft Teams, Webex. Возвращает готовые raw WebRTC аудиопотоки участников или готовое микшированное аудио.
* **Стоимость**: ~$0.05 – $0.10 за минуту записи.
* **Когда выгодно**: Для Zoom и Microsoft Teams, чтобы не тратить ресурсы разработки на поддержку Canvas OCR и постоянных изменений DOM.

---

### 6.3. Сравнительный анализ: Self-Hosted vs Cloud SDK

| Критерий | Self-Hosted (Puppeteer + Adapters) | LiveKit Egress (Native SFU) | Managed Cloud API (Recall.ai) |
|---|---|---|---|
| **Стоимость эксплуатации** | Только стоимость серверов (CPU/RAM) | Минимальная (только bandwidth/CPU) | Пай-пер-минута ($3.00–$6.00 / час встречи) |
| **Приватность данных** | 100% On-Premise / Compliance | 100% On-Premise | Данные проходят через стороннее облако |
| **Сложность поддержки** | Высокая (реакция на изменения DOM) | Низкая | Нулевая (поддержка на стороне провайдера) |
| **Качество Per-Track** | Высокое (для WebRTC платформ) | Идеальное | Высокое |
| **Рекомендуемая сфера** | Telemost, Jitsi, Google Meet | LiveKit, plugNmeet | Zoom, MS Teams (корпоративный контур) |

---

## 7. Рекомендации по приоритету реализации (Roadmap & Priorities)

### Фаза 1: Рефакторинг ядра и Jitsi Adapter (Срок: 1-2 недели)
1. Выделение базового класса `PlatformAdapter` из `recorder.js`.
2. Создание `TelemostAdapter` путем инкапсуляции текущего кода Яндекс.Телемост.
3. Реализация `JitsiMeetAdapter` с использованием нативного JS API (`APP.conference`). Jitsi служит эталонным адаптером с наименьшими трудозатратами.

### Фаза 2: Google Meet Adapter (Срок: 2-3 недели)
1. Реализация `GoogleMeetAdapter`.
2. Внедрение перехвата `RTCPeerConnection` для Google Meet.
3. Настройка `MutationObserver` для парсинга `aria-label` спикеров и плашек активного голоса.
4. Покрытие тестами алгоритма атрибуции в условиях динамической смены DOM-селекторов.

### Фаза 3: Microsoft Teams Web Adapter (Срок: 3 недели)
1. Реализация `TeamsAdapter` для Microsoft Teams Web Client.
2. Поддержка извлечения `data-tid` атрибутов участников.
3. Обработка сценариев входа через Guest Lobby и авторизацию.

### Фаза 4: LiveKit / Native Egress Integration (Срок: 2 недели)
1. Создание `LiveKitAdapter` для прямых подключений к веб-приложениям на базе LiveKit.
2. Реализация коннектора для **LiveKit Egress Service** (прямое чтение треков с сервера без участия Chromium).

### Фаза 5: Zoom Web Adapter & Fallback Enhancement (Срок: 3-4 недели)
1. Реализация `ZoomWebAdapter` на базе перехвата Web Audio API (`AudioContext`/`AudioWorklet`).
2. Оптимизация алгоритма **Graceful Degradation** (`applyMixedTrackEventSpeakerRemap`) для Zoom на случай отсутствия раздельных WebRTC треков.
3. Исследование целесообразности гибридного подключения Recall.ai API исключительно для сложных сессий Zoom.
