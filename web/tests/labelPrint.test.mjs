import assert from "node:assert/strict";
import test from "node:test";
import { fetchPrintableLabelImage, renderPrintableLabelWindow } from "../public/assets/labelPrint.js";

test("browser print fetches a label through the authenticated flow and revokes its object URL", async () => {
  const requests = [];
  const revoked = [];
  const result = await fetchPrintableLabelImage({
    printUrl: "/api/labels/file/LBL-SYNTHETIC",
    authToken: "synthetic-session-token",
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        blob: async () => new Blob(["synthetic image"], { type: "image/png" })
      };
    },
    urlApi: {
      createObjectURL: () => "blob:synthetic-label",
      revokeObjectURL: (url) => revoked.push(url)
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/labels/file/LBL-SYNTHETIC");
  assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-session-token");
  assert.equal(result.src, "blob:synthetic-label");
  result.dispose();
  result.dispose();
  assert.deepEqual(revoked, ["blob:synthetic-label"]);
});

test("browser print installs Blob URL cleanup after the final document replacement", () => {
  const calls = [];
  const listeners = new Map();
  const printWindow = {
    document: {
      open: () => calls.push("document.open"),
      write: (html) => {
        calls.push("document.write");
        assert.match(html, /window\.onafterprint = \(\) => window\.close\(\)/);
      },
      close: () => calls.push("document.close")
    },
    addEventListener: (type, listener, options) => {
      assert.deepEqual(calls.slice(0, 3), ["document.open", "document.write", "document.close"]);
      assert.deepEqual(options, { once: true });
      calls.push(`listen:${type}`);
      listeners.set(type, listener);
    }
  };
  let disposals = 0;

  renderPrintableLabelWindow(
    printWindow,
    "<script>window.onafterprint = () => window.close();</script>",
    () => { disposals += 1; }
  );

  listeners.get("afterprint")();
  listeners.get("beforeunload")();
  assert.equal(disposals, 1);
});

test("browser print returns a sanitized failure for a missing or non-image response", async () => {
  await assert.rejects(
    fetchPrintableLabelImage({
      printUrl: "/api/labels/file/LBL-MISSING",
      fetchImpl: async () => ({ ok: false })
    }),
    /LABEL_IMAGE_FETCH_FAILED/
  );

  await assert.rejects(
    fetchPrintableLabelImage({
      printUrl: "/api/labels/file/LBL-PDF",
      fetchImpl: async () => ({
        ok: true,
        headers: new Headers({ "content-type": "application/pdf" }),
        blob: async () => new Blob(["synthetic pdf"], { type: "application/pdf" })
      })
    }),
    /LABEL_IMAGE_NOT_PRINTABLE/
  );
});
