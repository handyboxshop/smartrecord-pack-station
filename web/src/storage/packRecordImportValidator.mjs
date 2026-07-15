const TOP_LEVEL_FIELDS = [
  "id",
  "awb",
  "platform",
  "employeeId",
  "stationId",
  "startedAt",
  "endedAt",
  "durationSeconds",
  "status",
  "itemSummary",
  "sizeMb",
  "storage",
  "shareLink",
  "forceCloseReason",
  "video"
];

const RESERVED_FIELDS = [
  "awbNormalized",
  "recordSequence",
  "sourcePayloadJson",
  "createdAt",
  "updatedAt"
];

const STORAGE_FIELDS = ["targetId", "label", "provider", "host"];

const VIDEO_FIELDS = [
  "fileName",
  "relativePath",
  "bytes",
  "sizeMb",
  "contentType",
  "storageTargetId",
  "storageLabel",
  "storageHost",
  "storageMode",
  "mountedRequired",
  "simulated",
  "externalUrl",
  "customPath",
  "shareLink",
  "savedAt"
];

const TOP_LEVEL_FIELD_SET = new Set(TOP_LEVEL_FIELDS);
const RESERVED_FIELD_SET = new Set(RESERVED_FIELDS);
const STORAGE_FIELD_SET = new Set(STORAGE_FIELDS);
const VIDEO_FIELD_SET = new Set(VIDEO_FIELDS);
const SERIALIZATION_ERROR_CODES = new Set([
  "FIELD_UNDEFINED_VALUE",
  "FIELD_NOT_SERIALIZABLE"
]);

const INVALID_PROPERTY = Symbol("invalid-property");

export function validatePackRecordImport(input) {
  if (!Array.isArray(input)) {
    return {
      ok: false,
      inputRecordCount: 0,
      records: [],
      duplicateIdGroups: [],
      duplicateAwbGroups: [],
      batchIssues: [issue(
        "error",
        "BATCH_NOT_ARRAY",
        "Pack Record import input must be an array.",
        "$",
        null
      )]
    };
  }

  const inputRecordCount = input.length;
  const validatedRecords = [];
  const idIndexes = new Map();
  const awbIndexes = new Map();

  for (let inputIndex = 0; inputIndex < inputRecordCount; inputIndex += 1) {
    const validated = validateRecord(input[inputIndex], inputIndex, inputRecordCount);
    validatedRecords.push(validated.result);

    if (validated.duplicateId !== null) {
      appendIndex(idIndexes, validated.duplicateId, inputIndex);
    }
    if (validated.duplicateAwb !== null) {
      appendIndex(awbIndexes, validated.duplicateAwb, inputIndex);
    }
  }

  const duplicateIdGroups = buildDuplicateGroups(idIndexes, "id");
  const duplicateAwbGroups = buildDuplicateGroups(awbIndexes, "awb");
  const records = validatedRecords;

  return {
    ok: records.every((record) => record.importable)
      && duplicateIdGroups.length === 0
      && duplicateAwbGroups.length === 0,
    inputRecordCount,
    records,
    duplicateIdGroups,
    duplicateAwbGroups,
    batchIssues: []
  };
}

export function buildPackRecordImportDryRunReport(validationResult) {
  const records = validationResult.records;
  const validRecordCount = records.filter((record) => record.importable).length;
  const invalidRecordCount = records.length - validRecordCount;
  const ready = validationResult.ok === true;
  const duplicateIdGroupCount = validationResult.duplicateIdGroups.length;
  const duplicateAwbGroupCount = validationResult.duplicateAwbGroups.length;
  const inputRecordCount = validationResult.inputRecordCount;

  let perRecordErrorCount = 0;
  let warningCount = 0;
  for (const record of records) {
    for (const recordIssue of record.issues) {
      if (recordIssue.severity === "error") perRecordErrorCount += 1;
      if (recordIssue.severity === "warning") warningCount += 1;
    }
  }

  const batchErrorCount = validationResult.batchIssues.filter(
    (batchIssue) => batchIssue.severity === "error"
  ).length;

  return {
    mode: "dry-run",
    status: ready ? "ready" : "blocked",
    wouldWrite: false,
    inputRecordCount,
    validRecordCount,
    invalidRecordCount,
    plannedPackRecordRows: ready ? validRecordCount : 0,
    plannedVideoRows: ready
      ? records.filter((record) => record.importable && record.hasVideo).length
      : 0,
    errorCount: batchErrorCount
      + perRecordErrorCount
      + duplicateIdGroupCount
      + duplicateAwbGroupCount,
    warningCount,
    duplicateIdGroupCount,
    duplicateAwbGroupCount,
    recordSequenceFirst: inputRecordCount === 0 ? null : inputRecordCount - 1,
    recordSequenceLast: inputRecordCount === 0 ? null : 0
  };
}

function validateRecord(record, inputIndex, inputRecordCount) {
  const recordPath = `$[${inputIndex}]`;
  const recordSequence = inputRecordCount - 1 - inputIndex;

  if (!isPlainObject(record)) {
    const issues = [issue(
      "error",
      "RECORD_NOT_PLAIN_OBJECT",
      "Pack Record entries must be plain objects.",
      recordPath,
      inputIndex
    )];
    return {
      result: recordResult(inputIndex, recordSequence, null, null, null, false, issues),
      duplicateId: null,
      duplicateAwb: null
    };
  }

  try {
    if (containsCircularReference(record)) {
      const issues = [issue(
        "error",
        "RECORD_NOT_SERIALIZABLE",
        "Pack Record contains a circular reference and is not JSON serializable.",
        recordPath,
        inputIndex
      )];
      return {
        result: recordResult(
          inputIndex,
          recordSequence,
          stringFieldOrNull(record, "id"),
          stringFieldOrNull(record, "awb"),
          validNormalizedAwb(record),
          isPlainObject(fieldValue(record, "video")),
          issues
        ),
        duplicateId: null,
        duplicateAwb: null
      };
    }

    const serializationIssues = scanJsonCompatibility(record, recordPath, inputIndex);
    const serializationIssuePaths = new Set(
      serializationIssues
        .filter((recordIssue) => SERIALIZATION_ERROR_CODES.has(recordIssue.code))
        .map((recordIssue) => recordIssue.path)
    );

    if (serializationIssues.length === 0) {
      try {
        JSON.stringify(record);
      } catch {
        const issues = [issue(
          "error",
          "RECORD_NOT_SERIALIZABLE",
          "Pack Record cannot be represented as JSON.",
          recordPath,
          inputIndex
        )];
        return {
          result: recordResult(
            inputIndex,
            recordSequence,
            stringFieldOrNull(record, "id"),
            stringFieldOrNull(record, "awb"),
            validNormalizedAwb(record),
            isPlainObject(fieldValue(record, "video")),
            issues
          ),
          duplicateId: null,
          duplicateAwb: null
        };
      }
    }

    const validationIssues = [];
    const idPath = `${recordPath}.id`;
    const awbPath = `${recordPath}.awb`;
    let duplicateId = null;
    let duplicateAwb = null;

    const rawId = fieldValue(record, "id");
    if (!hasOwn(record, "id")) {
      validationIssues.push(issue("error", "ID_REQUIRED", "Pack Record id is required.", idPath, inputIndex));
    } else if (!serializationIssuePaths.has(idPath)) {
      if (typeof rawId !== "string") {
        validationIssues.push(issue("error", "ID_INVALID_TYPE", "Pack Record id must be a string.", idPath, inputIndex));
      } else if (rawId.trim() === "") {
        validationIssues.push(issue("error", "ID_EMPTY", "Pack Record id must not be empty.", idPath, inputIndex));
      } else {
        duplicateId = rawId;
      }
    }

    const rawAwb = fieldValue(record, "awb");
    if (!hasOwn(record, "awb")) {
      validationIssues.push(issue("error", "AWB_REQUIRED", "Pack Record awb is required.", awbPath, inputIndex));
    } else if (!serializationIssuePaths.has(awbPath)) {
      if (typeof rawAwb !== "string") {
        validationIssues.push(issue("error", "AWB_INVALID_TYPE", "Pack Record awb must be a string.", awbPath, inputIndex));
      } else if (rawAwb.trim() === "") {
        validationIssues.push(issue("error", "AWB_EMPTY", "Pack Record awb must not be empty.", awbPath, inputIndex));
      } else {
        duplicateAwb = String(rawAwb).trim();
      }
    }

    validateOptionalString(record, "platform", "PLATFORM_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateOptionalString(record, "employeeId", "EMPLOYEE_ID_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateOptionalString(record, "stationId", "STATION_ID_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);

    const startedAtValid = validateOptionalTimestamp(
      record,
      "startedAt",
      "STARTED_AT_INVALID_TIMESTAMP",
      recordPath,
      inputIndex,
      serializationIssuePaths,
      validationIssues
    );
    const endedAtValid = validateOptionalTimestamp(
      record,
      "endedAt",
      "ENDED_AT_INVALID_TIMESTAMP",
      recordPath,
      inputIndex,
      serializationIssuePaths,
      validationIssues
    );
    if (startedAtValid && endedAtValid) {
      const startedAt = fieldValue(record, "startedAt");
      const endedAt = fieldValue(record, "endedAt");
      if (Date.parse(endedAt) < Date.parse(startedAt)) {
        validationIssues.push(issue(
          "error",
          "ENDED_AT_BEFORE_STARTED_AT",
          "Pack Record endedAt must not be earlier than startedAt.",
          `${recordPath}.endedAt`,
          inputIndex
        ));
      }
    }

    validateOptionalSafeInteger(
      record,
      "durationSeconds",
      "DURATION_SECONDS",
      recordPath,
      inputIndex,
      serializationIssuePaths,
      validationIssues
    );

    const statusPath = `${recordPath}.status`;
    const status = fieldValue(record, "status");
    if (!serializationIssuePaths.has(statusPath) && status !== "pass" && status !== "warn") {
      validationIssues.push(issue(
        "error",
        "STATUS_INVALID",
        'Pack Record status must be exactly "pass" or "warn".',
        statusPath,
        inputIndex
      ));
    }

    validateOptionalString(record, "itemSummary", "ITEM_SUMMARY_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateOptionalFiniteNumber(record, "sizeMb", "SIZE_MB", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateStorage(record, recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateOptionalString(record, "shareLink", "SHARE_LINK_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateOptionalString(record, "forceCloseReason", "FORCE_CLOSE_REASON_INVALID_TYPE", recordPath, inputIndex, serializationIssuePaths, validationIssues);
    validateVideo(record, recordPath, inputIndex, serializationIssuePaths, validationIssues);

    const unknownWarnings = buildUnknownWarnings(record, recordPath, inputIndex, serializationIssuePaths);
    const reservedWarnings = buildReservedWarnings(record, recordPath, inputIndex, serializationIssuePaths);
    const errors = [...serializationIssues, ...validationIssues].sort(compareErrorIssues);
    const issues = [
      ...errors,
      ...unknownWarnings.sort(compareIssuePaths),
      ...reservedWarnings.sort(compareIssuePaths)
    ];
    const rawAwbValue = typeof rawAwb === "string" ? rawAwb : null;
    const result = recordResult(
      inputIndex,
      recordSequence,
      typeof rawId === "string" ? rawId : null,
      rawAwbValue,
      duplicateAwb,
      isPlainObject(fieldValue(record, "video")),
      issues
    );

    return { result, duplicateId, duplicateAwb };
  } catch {
    const issues = [issue(
      "error",
      "RECORD_NOT_SERIALIZABLE",
      "Pack Record cannot be inspected safely as JSON.",
      recordPath,
      inputIndex
    )];
    return {
      result: recordResult(inputIndex, recordSequence, null, null, null, false, issues),
      duplicateId: null,
      duplicateAwb: null
    };
  }
}

function recordResult(inputIndex, recordSequence, id, awb, awbNormalized, hasVideo, issues) {
  return {
    inputIndex,
    recordSequence,
    id,
    awb,
    awbNormalized,
    hasVideo,
    importable: !issues.some((recordIssue) => recordIssue.severity === "error"),
    issues
  };
}

function validateOptionalString(record, field, code, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, field)) return;
  const path = `${recordPath}.${field}`;
  if (serializationPaths.has(path)) return;
  const value = fieldValue(record, field);
  if (value !== null && typeof value !== "string") {
    issues.push(issue("error", code, `Pack Record ${field} must be a string or null.`, path, inputIndex));
  }
}

function validateOptionalTimestamp(record, field, code, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, field)) return false;
  const path = `${recordPath}.${field}`;
  if (serializationPaths.has(path)) return false;
  const value = fieldValue(record, field);
  if (value === null) return false;
  if (!isIsoTimestampWithTimezone(value)) {
    issues.push(issue(
      "error",
      code,
      `Pack Record ${field} must be an ISO 8601 timestamp with a timezone or null.`,
      path,
      inputIndex
    ));
    return false;
  }
  return true;
}

function validateOptionalSafeInteger(record, field, codePrefix, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, field)) return;
  const path = `${recordPath}.${field}`;
  if (serializationPaths.has(path)) return;
  const value = fieldValue(record, field);
  if (value === null) return;
  if (typeof value !== "number") {
    issues.push(issue("error", `${codePrefix}_INVALID_TYPE`, `Pack Record ${field} must be a number or null.`, path, inputIndex));
  } else if (!Number.isFinite(value)) {
    issues.push(issue("error", `${codePrefix}_NOT_FINITE`, `Pack Record ${field} must be finite.`, path, inputIndex));
  } else if (value < 0) {
    issues.push(issue("error", `${codePrefix}_NEGATIVE`, `Pack Record ${field} must not be negative.`, path, inputIndex));
  } else if (!Number.isSafeInteger(value)) {
    issues.push(issue("error", `${codePrefix}_NOT_SAFE_INTEGER`, `Pack Record ${field} must be a safe integer.`, path, inputIndex));
  }
}

function validateOptionalFiniteNumber(record, field, codePrefix, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, field)) return;
  const path = `${recordPath}.${field}`;
  if (serializationPaths.has(path)) return;
  const value = fieldValue(record, field);
  if (value === null) return;
  if (typeof value !== "number") {
    issues.push(issue("error", `${codePrefix}_INVALID_TYPE`, `Pack Record ${field} must be a number or null.`, path, inputIndex));
  } else if (!Number.isFinite(value)) {
    issues.push(issue("error", `${codePrefix}_NOT_FINITE`, `Pack Record ${field} must be finite.`, path, inputIndex));
  } else if (value < 0) {
    issues.push(issue("error", `${codePrefix}_NEGATIVE`, `Pack Record ${field} must not be negative.`, path, inputIndex));
  }
}

function validateStorage(record, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, "storage")) return;
  const storagePath = `${recordPath}.storage`;
  if (serializationPaths.has(storagePath)) return;
  const storage = fieldValue(record, "storage");
  if (storage === null) return;
  if (!isPlainObject(storage)) {
    issues.push(issue(
      "error",
      "STORAGE_INVALID_TYPE",
      "Pack Record storage must be a plain object or null.",
      storagePath,
      inputIndex
    ));
    return;
  }

  for (const field of STORAGE_FIELDS) {
    if (!hasOwn(storage, field)) continue;
    const path = `${storagePath}.${field}`;
    if (serializationPaths.has(path)) continue;
    const value = fieldValue(storage, field);
    if (value !== null && typeof value !== "string") {
      issues.push(issue(
        "error",
        `STORAGE_${toCodeName(field)}_INVALID_TYPE`,
        `Pack Record storage.${field} must be a string or null.`,
        path,
        inputIndex
      ));
    }
  }
}

function validateVideo(record, recordPath, inputIndex, serializationPaths, issues) {
  if (!hasOwn(record, "video")) return;
  const videoPath = `${recordPath}.video`;
  if (serializationPaths.has(videoPath)) return;
  const video = fieldValue(record, "video");
  if (video === null) return;
  if (!isPlainObject(video)) {
    issues.push(issue(
      "error",
      "VIDEO_INVALID_TYPE",
      "Pack Record video must be a plain object or null.",
      videoPath,
      inputIndex
    ));
    return;
  }

  for (const field of [
    "fileName",
    "relativePath",
    "contentType",
    "storageTargetId",
    "storageLabel",
    "storageHost",
    "storageMode",
    "externalUrl",
    "customPath",
    "shareLink"
  ]) {
    const path = `${videoPath}.${field}`;
    if (!hasOwn(video, field) || serializationPaths.has(path)) continue;
    const value = fieldValue(video, field);
    if (value !== null && typeof value !== "string") {
      issues.push(issue(
        "error",
        `VIDEO_${toCodeName(field)}_INVALID_TYPE`,
        `Pack Record video.${field} must be a string or null.`,
        path,
        inputIndex
      ));
    }
  }

  validateOptionalSafeInteger(video, "bytes", "VIDEO_BYTES", videoPath, inputIndex, serializationPaths, issues);
  validateOptionalFiniteNumber(video, "sizeMb", "VIDEO_SIZE_MB", videoPath, inputIndex, serializationPaths, issues);

  for (const field of ["mountedRequired", "simulated"]) {
    const path = `${videoPath}.${field}`;
    if (!hasOwn(video, field) || serializationPaths.has(path)) continue;
    const value = fieldValue(video, field);
    if (value !== null && typeof value !== "boolean") {
      issues.push(issue(
        "error",
        `VIDEO_${toCodeName(field)}_INVALID_TYPE`,
        `Pack Record video.${field} must be a boolean or null.`,
        path,
        inputIndex
      ));
    }
  }

  validateOptionalTimestamp(
    video,
    "savedAt",
    "VIDEO_SAVED_AT_INVALID_TIMESTAMP",
    videoPath,
    inputIndex,
    serializationPaths,
    issues
  );
}

function buildUnknownWarnings(record, recordPath, inputIndex, serializationPaths) {
  const warnings = [];
  for (const field of sortedEnumerableKeys(record)) {
    if (TOP_LEVEL_FIELD_SET.has(field) || RESERVED_FIELD_SET.has(field)) continue;
    appendUnknownWarning(warnings, `${recordPath}${pathSegment(field)}`, inputIndex, serializationPaths);
  }

  const storage = fieldValue(record, "storage");
  if (isPlainObject(storage)) {
    for (const field of sortedEnumerableKeys(storage)) {
      if (STORAGE_FIELD_SET.has(field)) continue;
      appendUnknownWarning(warnings, `${recordPath}.storage${pathSegment(field)}`, inputIndex, serializationPaths);
    }
  }

  const video = fieldValue(record, "video");
  if (isPlainObject(video)) {
    for (const field of sortedEnumerableKeys(video)) {
      if (VIDEO_FIELD_SET.has(field)) continue;
      appendUnknownWarning(warnings, `${recordPath}.video${pathSegment(field)}`, inputIndex, serializationPaths);
    }
  }
  return warnings;
}

function appendUnknownWarning(warnings, path, inputIndex, serializationPaths) {
  if (serializationPaths.has(path)) return;
  warnings.push(issue(
    "warning",
    "UNKNOWN_FIELD",
    "Field is not mapped by the Pack Record importer.",
    path,
    inputIndex
  ));
}

function buildReservedWarnings(record, recordPath, inputIndex, serializationPaths) {
  const warnings = [];
  for (const field of RESERVED_FIELDS) {
    if (!hasOwn(record, field)) continue;
    const path = `${recordPath}.${field}`;
    if (serializationPaths.has(path)) continue;
    warnings.push(issue(
      "warning",
      "DERIVED_FIELD_IGNORED",
      "Importer-owned field is ignored during Pack Record validation.",
      path,
      inputIndex
    ));
  }
  return warnings;
}

function scanJsonCompatibility(value, rootPath, inputIndex) {
  const issues = [];
  scanJsonValue(value, rootPath, inputIndex, issues);
  const seen = new Set();
  return issues.filter((recordIssue) => {
    const key = `${recordIssue.code}\u0000${recordIssue.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function scanJsonValue(value, path, inputIndex, issues) {
  if (value === undefined) {
    issues.push(issue("error", "FIELD_UNDEFINED_VALUE", "JSON fields cannot contain undefined.", path, inputIndex));
    return;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    if (!isKnownNumericPath(path)) {
      issues.push(issue("error", "FIELD_NOT_SERIALIZABLE", "JSON numbers must be finite.", path, inputIndex));
    }
    return;
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    issues.push(issue("error", "FIELD_NOT_SERIALIZABLE", "Field value cannot be represented in JSON.", path, inputIndex));
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const itemPath = `${path}[${index}]`;
      if (!hasOwn(value, index)) {
        issues.push(issue("error", "FIELD_UNDEFINED_VALUE", "JSON arrays cannot contain empty slots.", itemPath, inputIndex));
      } else {
        scanJsonValue(fieldValue(value, index), itemPath, inputIndex, issues);
      }
    }
    scanEnumerableSymbolKeys(value, path, inputIndex, issues);
    return;
  }
  if (!isPlainObject(value)) {
    issues.push(issue("error", "FIELD_NOT_SERIALIZABLE", "Field value must be compatible with parsed JSON.", path, inputIndex));
    return;
  }

  for (const key of sortedEnumerableKeys(value)) {
    const childPath = `${path}${pathSegment(key)}`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      issues.push(issue("error", "FIELD_NOT_SERIALIZABLE", "JSON fields must be data properties.", childPath, inputIndex));
      continue;
    }
    scanJsonValue(descriptor.value, childPath, inputIndex, issues);
  }
  scanEnumerableSymbolKeys(value, path, inputIndex, issues);
}

function scanEnumerableSymbolKeys(value, path, inputIndex, issues) {
  const symbols = Object.getOwnPropertySymbols(value)
    .filter((symbol) => Object.getOwnPropertyDescriptor(value, symbol)?.enumerable)
    .sort((left, right) => String(left).localeCompare(String(right)));
  for (const symbol of symbols) {
    issues.push(issue(
      "error",
      "FIELD_NOT_SERIALIZABLE",
      "JSON objects cannot contain symbol keys.",
      `${path}[${String(symbol)}]`,
      inputIndex
    ));
  }
}

function containsCircularReference(value) {
  return visitForCircularReference(value, new WeakSet());
}

function visitForCircularReference(value, ancestors) {
  if (value === null || typeof value !== "object") return false;
  if (!Array.isArray(value) && !isPlainObject(value)) return false;
  if (ancestors.has(value)) return true;

  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (hasOwn(value, index) && visitForCircularReference(fieldValue(value, index), ancestors)) return true;
    }
  } else {
    for (const key of sortedEnumerableKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && visitForCircularReference(descriptor.value, ancestors)) return true;
    }
  }
  ancestors.delete(value);
  return false;
}

function buildDuplicateGroups(indexMap, field) {
  const code = field === "id" ? "DUPLICATE_RECORD_ID" : "DUPLICATE_AWB_NORMALIZED";
  const groups = [];
  for (const [value, indexes] of indexMap) {
    if (indexes.length < 2) continue;
    const firstIndex = indexes[0];
    groups.push(issue(
      "error",
      code,
      field === "id"
        ? "Pack Record id is duplicated within the import batch."
        : "Normalized Pack Record awb is duplicated within the import batch.",
      `$[${firstIndex}].${field}`,
      firstIndex,
      { value, indexes: [...indexes] }
    ));
  }
  return groups.sort((left, right) => left.recordIndex - right.recordIndex);
}

function appendIndex(indexMap, value, index) {
  const indexes = indexMap.get(value);
  if (indexes) indexes.push(index);
  else indexMap.set(value, [index]);
}

function issue(severity, code, message, path, recordIndex, details = {}) {
  return { severity, code, message, path, recordIndex, details };
}

function compareErrorIssues(left, right) {
  const leftKey = errorOrderKey(left.path);
  const rightKey = errorOrderKey(right.path);
  if (leftKey.rank !== rightKey.rank) return leftKey.rank - rightKey.rank;
  if (leftKey.subrank !== rightKey.subrank) return leftKey.subrank - rightKey.subrank;
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}

function errorOrderKey(path) {
  const relativePath = path.replace(/^\$\[\d+\]\.?/, "");
  if (relativePath === path || relativePath === "") return { rank: -1, subrank: -1 };
  const first = relativePath.match(/^[^.\[]+/)?.[0] ?? "";
  const rank = TOP_LEVEL_FIELDS.indexOf(first);
  if (rank === -1) {
    return { rank: RESERVED_FIELD_SET.has(first) ? 200 : 100, subrank: 100 };
  }
  if (first === "storage") {
    const nested = relativePath.slice("storage.".length).match(/^[^.\[]+/)?.[0];
    const nestedRank = STORAGE_FIELDS.indexOf(nested);
    return { rank, subrank: nestedRank === -1 ? 100 : nestedRank };
  }
  if (first === "video") {
    const nested = relativePath.slice("video.".length).match(/^[^.\[]+/)?.[0];
    const nestedRank = VIDEO_FIELDS.indexOf(nested);
    return { rank, subrank: nestedRank === -1 ? 100 : nestedRank };
  }
  return { rank, subrank: 0 };
}

function compareIssuePaths(left, right) {
  return left.path.localeCompare(right.path) || left.code.localeCompare(right.code);
}

function isKnownNumericPath(path) {
  return /^\$\[\d+\]\.(?:durationSeconds|sizeMb|video\.(?:bytes|sizeMb))$/.test(path);
}

function isIsoTimestampWithTimezone(value) {
  if (typeof value !== "string") return false;
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/
  );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (offsetHour > 23 || offsetMinute > 59) return false;
  return Number.isFinite(Date.parse(value));
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function fieldValue(value, field) {
  if (!hasOwn(value, field)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor && "value" in descriptor ? descriptor.value : INVALID_PROPERTY;
}

function stringFieldOrNull(record, field) {
  const value = fieldValue(record, field);
  return typeof value === "string" ? value : null;
}

function validNormalizedAwb(record) {
  const value = fieldValue(record, "awb");
  return typeof value === "string" && value.trim() !== "" ? String(value).trim() : null;
}

function sortedEnumerableKeys(value) {
  return Object.keys(value).sort((left, right) => left.localeCompare(right));
}

function pathSegment(field) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(field) ? `.${field}` : `[${JSON.stringify(field)}]`;
}

function toCodeName(field) {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}
