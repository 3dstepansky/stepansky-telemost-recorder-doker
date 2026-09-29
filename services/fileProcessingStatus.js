export function shouldNotifyFileProcessingError({ code, signal, shuttingDown }) {
  if (shuttingDown && signal) return false;
  return code !== 0;
}
