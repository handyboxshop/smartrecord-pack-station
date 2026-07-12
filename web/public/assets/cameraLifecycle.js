export async function settleAuthenticatedCameraRequest({
  openCameraStream,
  isCurrent,
  onStream,
  onError,
  startTimer
}) {
  try {
    const stream = await openCameraStream();
    if (!isCurrent()) {
      stream?.getTracks?.().forEach((track) => track.stop());
      return false;
    }
    onStream(stream);
  } catch (error) {
    if (!isCurrent()) return false;
    onError(error);
  }
  if (!isCurrent()) return false;
  startTimer();
  return true;
}
