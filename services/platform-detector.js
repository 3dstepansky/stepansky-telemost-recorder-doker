/**
 * services/platform-detector.js
 * Определение платформы встречи по переданному URL.
 * Поддерживаемые платформы:
 * - telemost (Яндекс.Телемост)
 * - google-meet (Google Meet)
 * - zoom (Zoom Video Communications)
 * - teams (Microsoft Teams)
 */

export function detectPlatform(url) {
  if (!url || typeof url !== 'string') {
    return { platform: 'unknown', valid: false, error: 'Empty or invalid URL' };
  }

  const cleanUrl = url.trim();

  // 1. Яндекс.Телемост
  // Форматы: https://telemost.yandex.ru/j/1234567890, telemost.yandex.ru/j/1234567890
  const telemostMatch = cleanUrl.match(/(?:https?:\/\/)?telemost\.yandex\.ru\/j\/([a-zA-Z0-9_-]+)/i);
  if (telemostMatch) {
    return {
      platform: 'telemost',
      displayName: 'Яндекс.Телемост',
      icon: '🟣',
      meetingId: telemostMatch[1],
      normalizedUrl: cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`,
      valid: true
    };
  }

  // 2. Google Meet
  // Форматы: https://meet.google.com/abc-defg-hij, meet.google.com/abc-defg-hij
  const meetMatch = cleanUrl.match(/(?:https?:\/\/)?meet\.google\.com\/([a-zA-Z0-9_-]+)/i);
  if (meetMatch) {
    const meetingCode = meetMatch[1].replace(/[^a-zA-Z0-9-]/g, '');
    return {
      platform: 'google-meet',
      displayName: 'Google Meet',
      icon: '🟢',
      meetingId: meetingCode,
      normalizedUrl: `https://meet.google.com/${meetingCode}`,
      valid: true
    };
  }

  // 3. Zoom
  // Форматы: https://zoom.us/j/1234567890?pwd=xxx, https://us04web.zoom.us/j/1234567890, https://zoom.us/wc/join/1234567890
  const zoomMatch = cleanUrl.match(/(?:https?:\/\/)?[a-zA-Z0-9.-]*zoom\.us\/(?:j|wc\/join|w)\/([0-9]+)/i);
  if (zoomMatch) {
    const meetingId = zoomMatch[1];
    // Извлекаем пароль, если есть
    let pwd = '';
    try {
      const parsedUrl = new URL(cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`);
      pwd = parsedUrl.searchParams.get('pwd') || '';
    } catch (e) {}

    const webClientUrl = pwd 
      ? `https://zoom.us/wc/join/${meetingId}?pwd=${pwd}`
      : `https://zoom.us/wc/join/${meetingId}`;

    return {
      platform: 'zoom',
      displayName: 'Zoom',
      icon: '🔵',
      meetingId: meetingId,
      pwd: pwd,
      normalizedUrl: webClientUrl,
      originalUrl: cleanUrl,
      valid: true
    };
  }

  // 4. Microsoft Teams
  // Форматы: teams.microsoft.com/l/meetup-join/..., teams.live.com/meet/...
  const teamsMatch = cleanUrl.match(/(?:https?:\/\/)?teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/([a-zA-Z0-9%._-]+)/i);
  if (teamsMatch) {
    return {
      platform: 'teams',
      displayName: 'Microsoft Teams',
      icon: '🟦',
      meetingId: teamsMatch[1],
      normalizedUrl: cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`,
      valid: true
    };
  }

  return {
    platform: 'unknown',
    displayName: 'Неизвестная платформа',
    icon: '❓',
    meetingId: null,
    normalizedUrl: cleanUrl,
    valid: false,
    error: 'Ссылка не поддерживается. Поддерживаются: Яндекс.Телемост, Google Meet, Zoom.'
  };
}
