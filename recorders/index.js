/**
 * recorders/index.js
 * Фабрика рекордеров для автоматического выбора драйвера по URL встречи
 */

import { detectPlatform } from '../services/platform-detector.js';
import { TelemostRecorder } from './telemost.js';
import { GoogleMeetRecorder } from './google-meet.js';
import { ZoomRecorder } from './zoom.js';

export function createRecorder(url, options = {}) {
  const detection = detectPlatform(url);

  const recorderOptions = {
    ...options,
    joinUrl: url,
    detectedPlatform: detection
  };

  switch (detection.platform) {
    case 'google-meet':
      return new GoogleMeetRecorder(recorderOptions);

    case 'zoom':
      return new ZoomRecorder(recorderOptions);

    case 'telemost':
    default:
      // По умолчанию используем Телемост драйвер
      return new TelemostRecorder(recorderOptions);
  }
}

export { TelemostRecorder, GoogleMeetRecorder, ZoomRecorder };
