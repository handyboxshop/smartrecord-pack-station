export function parseHttpRange(rangeHeader, totalBytes) {
  const total = Number(totalBytes);
  if (!Number.isInteger(total) || total < 0) return fail("INVALID_TOTAL_BYTES");
  if (!rangeHeader) return ok({ ranged: false, start: 0, end: Math.max(total - 1, 0) });

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return fail("INVALID_RANGE");

  let start;
  let end;
  const [, rawStart, rawEnd] = match;

  if (rawStart === "" && rawEnd === "") return fail("INVALID_RANGE");
  if (rawStart === "") {
    const suffixLength = Number(rawEnd);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return fail("INVALID_RANGE");
    start = Math.max(total - suffixLength, 0);
    end = Math.max(total - 1, 0);
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? Math.max(total - 1, 0) : Number(rawEnd);
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= total) {
    return fail("RANGE_NOT_SATISFIABLE");
  }

  return ok({ ranged: true, start, end: Math.min(end, Math.max(total - 1, 0)) });
}

function ok(data) {
  return { ok: true, data };
}

function fail(code) {
  return { ok: false, code };
}
