export async function fetchPrintableLabelImage({
  printUrl = "",
  imageDataUrl = "",
  authToken = "",
  fetchImpl = fetch,
  urlApi = URL
} = {}) {
  const url = String(printUrl || "").trim();
  if (url) {
    const headers = authToken ? { Authorization: `Bearer ${authToken}` } : {};
    const response = await fetchImpl(url, { headers });
    if (!response?.ok) throw new Error("LABEL_IMAGE_FETCH_FAILED");

    const blob = await response.blob();
    const contentType = String(blob?.type || response.headers?.get?.("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) throw new Error("LABEL_IMAGE_NOT_PRINTABLE");

    const objectUrl = urlApi.createObjectURL(blob);
    let disposed = false;
    return {
      src: objectUrl,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        urlApi.revokeObjectURL(objectUrl);
      }
    };
  }

  const dataUrl = String(imageDataUrl || "").trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    return { src: dataUrl, dispose: () => {} };
  }

  throw new Error("LABEL_IMAGE_NOT_AVAILABLE");
}

export function renderPrintableLabelWindow(printWindow, html, dispose) {
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  let released = false;
  const releaseImage = () => {
    if (released) return;
    released = true;
    dispose();
  };
  printWindow.addEventListener("afterprint", releaseImage, { once: true });
  printWindow.addEventListener("beforeunload", releaseImage, { once: true });
}
