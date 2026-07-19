import {
  normalizeSqliteEmail,
  normalizeUsername
} from "../domain/userIdentity.mjs";
import { PBKDF2_ITERATIONS } from "../domain/passwordCredentials.mjs";

const DEFAULT_MAX_USERS = 100000;
const DEFAULT_MAX_ISSUES = 10000;
const MAX_CONFIG_ENTRIES = 64;
const MAX_PASSWORD_ITERATIONS = 10_000_000;
const PASSWORD_HASH_ALGORITHM = "pbkdf2-sha256";
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;
const PRINTABLE_ASCII_PATTERN = /^[\x20-\x7e]+$/;
const LEGACY_EMAIL_PATTERN = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const USER_ID_PATTERN = /^USR-[A-Z0-9-]{1,60}$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PASSWORD_SALT_PATTERN = /^[\x20-\x7e]{1,512}$/;
const PASSWORD_HASH_PATTERN = /^[0-9a-f]{64}$/;

const USER_FIELDS = new Set([
  "id", "username", "email", "name", "roleId", "roleName",
  "modulePermissions", "employeeName", "employeeId", "active",
  "passwordSalt", "passwordHash"
]);
const MODULE_FIELDS = new Set([
  "id", "label", "section", "viewPermission", "editPermission"
]);
const ROLE_FIELDS = new Set(["id", "label", "modulePermissions"]);
const PERMISSION_FIELDS = new Set(["moduleId", "canView", "canEdit"]);
const PASSWORD_POLICY_FIELDS = new Set(["minLength", "hashAlgorithm", "iterations"]);

const ERROR_MESSAGES = Object.freeze({
  USER_IMPORT_READINESS_OPTIONS_INVALID: "User import readiness options are invalid.",
  USER_IMPORT_READINESS_INTERNAL_FAILED: "User import readiness analysis failed safely."
});

export class UserImportReadinessError extends Error {
  constructor(code) {
    super(ERROR_MESSAGES[code] ?? ERROR_MESSAGES.USER_IMPORT_READINESS_INTERNAL_FAILED);
    this.name = "UserImportReadinessError";
    this.code = Object.hasOwn(ERROR_MESSAGES, code) ? code : "USER_IMPORT_READINESS_INTERNAL_FAILED";
    Object.defineProperty(this, "stack", {
      configurable: true,
      value: `${this.name}: ${this.message}`,
      writable: true
    });
  }
}

export function createUserImportReadinessAnalyzer(options = {}) {
  const supplied = copyDataRecord(options);
  if (!supplied.ok || supplied.keys.some((key) => !["maxUsers", "maxIssues"].includes(key))) {
    throw new UserImportReadinessError("USER_IMPORT_READINESS_OPTIONS_INVALID");
  }
  const maxUsers = Object.hasOwn(supplied.values, "maxUsers")
    ? supplied.values.maxUsers
    : DEFAULT_MAX_USERS;
  const maxIssues = Object.hasOwn(supplied.values, "maxIssues")
    ? supplied.values.maxIssues
    : DEFAULT_MAX_ISSUES;
  requireAnalyzerLimits(maxUsers, maxIssues);
  const limits = Object.freeze({ maxUsers, maxIssues });
  return Object.freeze({
    analyze(users, options) {
      return analyzeSafely(users, options, limits);
    }
  });
}

export function analyzeUserImportReadiness(users, options) {
  return createUserImportReadinessAnalyzer().analyze(users, options);
}

function analyzeSafely(users, options, limits) {
  try {
    return analyzeContent(users, options, limits);
  } catch {
    throw new UserImportReadinessError("USER_IMPORT_READINESS_INTERNAL_FAILED");
  }
}

function analyzeContent(users, options, limits) {
  const collector = createIssueCollector(limits.maxIssues);
  const userArray = copyDataArray(users, { maximumLength: limits.maxUsers });
  if (!userArray.ok) {
    collector.add("error", "USERS_INPUT_INVALID", null, null);
    return buildReport({ collector, maxIssues: limits.maxIssues });
  }
  if (userArray.limitExceeded) {
    collector.add("error", "USERS_LIMIT_EXCEEDED", null, null);
    return buildReport({ collector, maxIssues: limits.maxIssues });
  }

  const inputUserCount = userArray.values.length;
  const optionRecord = copyDataRecord(options);
  let rolesInput;
  let modulesInput;
  let passwordPolicyInput;
  let assignmentsInput = {};
  if (!optionRecord.ok || optionRecord.keys.some((key) => ![
    "roles", "modules", "passwordPolicy", "usernameAssignments"
  ].includes(key))) {
    collector.add("error", "CONFIG_ROLES_INVALID", null, "roles");
    collector.add("error", "CONFIG_MODULES_INVALID", null, "modules");
    collector.add("error", "CONFIG_PASSWORD_POLICY_INVALID", null, "passwordPolicy");
    collector.add("error", "USERNAME_ASSIGNMENTS_INVALID", null, "usernameAssignments");
  } else {
    rolesInput = optionRecord.values.roles;
    modulesInput = optionRecord.values.modules;
    passwordPolicyInput = optionRecord.values.passwordPolicy;
    if (Object.hasOwn(optionRecord.values, "usernameAssignments")) {
      assignmentsInput = optionRecord.values.usernameAssignments;
    }
  }

  const modules = validateModules(modulesInput);
  if (!modules.ok) collector.add("error", "CONFIG_MODULES_INVALID", null, "modules");
  const roles = validateRoles(rolesInput, modules);
  if (!roles.ok) collector.add("error", "CONFIG_ROLES_INVALID", null, "roles");
  if (!validatePasswordPolicy(passwordPolicyInput)) {
    collector.add("error", "CONFIG_PASSWORD_POLICY_INVALID", null, "passwordPolicy");
  }
  const assignments = validateAssignments(assignmentsInput);
  if (!assignments.ok) {
    collector.add("error", "USERNAME_ASSIGNMENTS_INVALID", null, "usernameAssignments");
  }
  if (inputUserCount === 0) {
    collector.add("error", "USERS_INPUT_EMPTY", null, null);
  }

  const records = userArray.values.map((value, userIndex) => validateUser({
    value,
    userIndex,
    modules,
    roles,
    assignments,
    collector
  }));

  if (assignments.ok) {
    const knownIds = new Set(records.filter((record) => record.idValid).map((record) => record.id));
    for (const assignmentId of assignments.keys) {
      if (!knownIds.has(assignmentId)) {
        collector.add("error", "USERNAME_ASSIGNMENT_UNKNOWN_USER", null, "usernameAssignments");
      }
    }
  }

  markDuplicates(records, "id", "idComparable", "USER_ID_DUPLICATE", "id", collector);
  markDuplicates(records, "emailNormalized", "emailValid", "USER_EMAIL_DUPLICATE", "email", collector);
  markUsernameDuplicates(records, collector);
  markIdentityCollisions(records, collector);

  const activeUserCount = records.filter((record) => record.active === true).length;
  const inactiveUserCount = records.filter((record) => record.active === false).length;
  const legacyEmailCount = records.filter((record) => record.emailLegacy).length;
  const requiredUsernameAssignmentCount = records.filter((record) => !record.usernameValid).length;
  const userErrorIndexes = collector.userErrorIndexes;
  const importableUserCount = records.filter((record) => !userErrorIndexes.has(record.userIndex)).length;

  return buildReport({
    collector,
    maxIssues: limits.maxIssues,
    inputUserCount,
    importableUserCount,
    activeUserCount,
    inactiveUserCount,
    legacyEmailCount,
    requiredUsernameAssignmentCount
  });
}

function validateUser({ value, userIndex, modules, roles, assignments, collector }) {
  const record = {
    userIndex,
    id: null,
    idComparable: false,
    idValid: false,
    emailNormalized: null,
    emailValid: false,
    emailLegacy: false,
    usernameNormalized: null,
    usernameCandidates: [],
    usernameValid: false,
    active: null
  };
  const source = copyDataRecord(value);
  if (!source.ok) {
    collector.add("error", "USER_SHAPE_INVALID", userIndex, null);
    return record;
  }
  if (source.keys.some((key) => !USER_FIELDS.has(key))) {
    collector.add("error", "USER_FIELD_UNKNOWN", userIndex, null);
  }

  const data = source.values;
  if (typeof data.id === "string") {
    record.id = data.id;
    record.idComparable = true;
    record.idValid = USER_ID_PATTERN.test(data.id);
  }
  if (!record.idValid) {
    collector.add("error", "USER_ID_INVALID", userIndex, "id");
  }

  validateEmail(data.email, record, collector);
  validateUsername(data, record, assignments, collector);

  if (!validRequiredText(data.name, 200)) {
    collector.add("error", "USER_NAME_INVALID", userIndex, "name");
  }
  if (!PASSWORD_SALT_PATTERN.test(typeof data.passwordSalt === "string" ? data.passwordSalt : "")
      || !PASSWORD_HASH_PATTERN.test(typeof data.passwordHash === "string" ? data.passwordHash : "")) {
    collector.add("error", "USER_CREDENTIALS_INVALID", userIndex, null);
  }
  if (typeof data.active === "boolean") {
    record.active = data.active;
  } else {
    collector.add("error", "USER_ACTIVE_INVALID", userIndex, "active");
  }

  const role = roles.ok && typeof data.roleId === "string" ? roles.byId.get(data.roleId) : null;
  if (!role || !validateRoleName(data.roleName, role.id)) {
    collector.add("error", "USER_ROLE_INVALID", userIndex, "roleId");
  }

  const hasPermissions = Object.hasOwn(data, "modulePermissions");
  if (hasPermissions) {
    if (!validatePermissionSnapshot(data.modulePermissions, modules).ok) {
      collector.add("error", "USER_PERMISSIONS_INVALID", userIndex, "modulePermissions");
    }
  } else if (!role || !role.permissionsValid || !modules.ok) {
    collector.add("error", "USER_PERMISSIONS_INVALID", userIndex, "modulePermissions");
  }

  if (!validOptionalCompatibleText(data.employeeName, 200)
      || !validOptionalCompatibleText(data.employeeId, 128)) {
    collector.add("error", "USER_EMPLOYEE_INVALID", userIndex, null);
  }
  return record;
}

function validateEmail(value, record, collector) {
  if (typeof value !== "string") {
    collector.add("error", "USER_EMAIL_INVALID", record.userIndex, "email");
    return;
  }
  const email = value.trim();
  if (!email || email.length > 320 || !PRINTABLE_ASCII_PATTERN.test(email) || /\s/.test(email)) {
    collector.add("error", "USER_EMAIL_INVALID", record.userIndex, "email");
    return;
  }
  const atCount = [...email].filter((character) => character === "@").length;
  if (atCount === 0) {
    if (!validLegacyEmail(email)) {
      collector.add("error", "USER_EMAIL_INVALID", record.userIndex, "email");
      return;
    }
    record.emailNormalized = email.toLowerCase();
    record.emailValid = true;
    record.emailLegacy = true;
    collector.add("warning", "USER_EMAIL_LEGACY", record.userIndex, "email");
    return;
  }
  try {
    const normalized = normalizeSqliteEmail(value);
    record.emailNormalized = normalized.emailNormalized;
    record.emailValid = true;
  } catch {
    collector.add("error", "USER_EMAIL_INVALID", record.userIndex, "email");
  }
}

function validateUsername(data, record, assignments, collector) {
  const sourcePresent = Object.hasOwn(data, "username");
  const assignedPresent = assignments.ok && record.idValid && assignments.values.has(record.id);
  const source = sourcePresent ? normalizeUsernameSafely(data.username) : null;
  const assigned = assignedPresent ? normalizeUsernameSafely(assignments.values.get(record.id)) : null;

  for (const candidate of [source, assigned]) {
    if (candidate && !record.usernameCandidates.includes(candidate.usernameNormalized)) {
      record.usernameCandidates.push(candidate.usernameNormalized);
    }
  }

  if (sourcePresent && !source) {
    collector.add("error", "USER_USERNAME_INVALID", record.userIndex, "username");
  }
  if (assignedPresent && !assigned) {
    collector.add("error", "USERNAME_ASSIGNMENT_INVALID", record.userIndex, "username");
  }
  if (sourcePresent && assignedPresent) {
    if (!source || !assigned
        || source.username !== assigned.username
        || source.usernameNormalized !== assigned.usernameNormalized) {
      collector.add("error", "USERNAME_ASSIGNMENT_CONFLICT", record.userIndex, "username");
      return;
    }
    collector.add("warning", "USERNAME_ASSIGNMENT_REDUNDANT", record.userIndex, "username");
    record.usernameNormalized = source.usernameNormalized;
    record.usernameValid = true;
    return;
  }
  const selected = source ?? assigned;
  if (selected && !(sourcePresent && !source) && !(assignedPresent && !assigned)) {
    record.usernameNormalized = selected.usernameNormalized;
    record.usernameValid = true;
    return;
  }
  collector.add("error", "USER_USERNAME_REQUIRED", record.userIndex, "username");
}

function normalizeUsernameSafely(value) {
  try {
    if (typeof value !== "string" || value !== value.trim()) return null;
    return normalizeUsername(value);
  } catch {
    return null;
  }
}

function validLegacyEmail(value) {
  return LEGACY_EMAIL_PATTERN.test(value)
    && !value.startsWith(".")
    && !value.endsWith(".")
    && !value.includes("..");
}

function validateModules(value) {
  const array = copyDataArray(value, { maximumLength: MAX_CONFIG_ENTRIES });
  if (!array.ok || array.limitExceeded || array.values.length < 1) {
    return { ok: false, ids: new Set() };
  }
  const ids = new Set();
  for (const item of array.values) {
    const module = copyDataRecord(item);
    if (!module.ok || module.keys.some((key) => !MODULE_FIELDS.has(key))) return { ok: false, ids: new Set() };
    const data = module.values;
    if (!SAFE_IDENTIFIER_PATTERN.test(typeof data.id === "string" ? data.id : "") || ids.has(data.id)) {
      return { ok: false, ids: new Set() };
    }
    if (!validRequiredText(data.label, 200) || !validRequiredText(data.section, 200)
        || !validRequiredText(data.viewPermission, 200) || !validRequiredText(data.editPermission, 200)) {
      return { ok: false, ids: new Set() };
    }
    ids.add(data.id);
  }
  return { ok: true, ids };
}

function validateRoles(value, modules) {
  const array = copyDataArray(value, { maximumLength: MAX_CONFIG_ENTRIES });
  const invalid = { ok: false, byId: new Map() };
  if (!array.ok || array.limitExceeded || array.values.length < 1 || !modules.ok) return invalid;
  const byId = new Map();
  for (const item of array.values) {
    const role = copyDataRecord(item);
    if (!role.ok || role.keys.some((key) => !ROLE_FIELDS.has(key))) return invalid;
    const data = role.values;
    if (!SAFE_IDENTIFIER_PATTERN.test(typeof data.id === "string" ? data.id : "")
        || byId.has(data.id) || !validRequiredText(data.label, 200)) return invalid;
    const permissionsValid = validatePermissionSnapshot(data.modulePermissions, modules).ok;
    if (!permissionsValid) return invalid;
    byId.set(data.id, { id: data.id, permissionsValid });
  }
  return { ok: true, byId };
}

function validatePermissionSnapshot(value, modules) {
  const array = copyDataArray(value, { maximumLength: MAX_CONFIG_ENTRIES });
  if (!modules.ok || !array.ok || array.limitExceeded || array.values.length !== modules.ids.size) {
    return { ok: false };
  }
  const seen = new Set();
  for (const item of array.values) {
    const permission = copyDataRecord(item);
    if (!permission.ok || permission.keys.some((key) => !PERMISSION_FIELDS.has(key))) return { ok: false };
    const data = permission.values;
    if (typeof data.moduleId !== "string" || !modules.ids.has(data.moduleId) || seen.has(data.moduleId)
        || typeof data.canView !== "boolean" || typeof data.canEdit !== "boolean"
        || (data.canEdit && !data.canView)) return { ok: false };
    seen.add(data.moduleId);
  }
  return { ok: seen.size === modules.ids.size };
}

function validateAssignments(value) {
  const object = copyDataRecord(value);
  if (!object.ok) return { ok: false, keys: [], values: new Map() };
  const values = new Map();
  const keys = [...object.keys].sort();
  for (const key of keys) {
    if (typeof object.values[key] !== "string") return { ok: false, keys: [], values: new Map() };
    values.set(key, object.values[key]);
  }
  return { ok: true, keys, values };
}

function validatePasswordPolicy(value) {
  if (value === undefined) return true;
  const policy = copyDataRecord(value);
  if (!policy.ok || policy.keys.some((key) => !PASSWORD_POLICY_FIELDS.has(key))) return false;
  const data = policy.values;
  const hashAlgorithm = Object.hasOwn(data, "hashAlgorithm")
    ? data.hashAlgorithm
    : PASSWORD_HASH_ALGORITHM;
  const iterations = Object.hasOwn(data, "iterations")
    ? data.iterations
    : PBKDF2_ITERATIONS;
  if (hashAlgorithm !== PASSWORD_HASH_ALGORITHM
      || !Number.isSafeInteger(iterations)
      || iterations < 1
      || iterations > MAX_PASSWORD_ITERATIONS) return false;
  if (Object.hasOwn(data, "minLength")
      && (!Number.isSafeInteger(data.minLength) || data.minLength < 1)) return false;
  return true;
}

function markDuplicates(records, valueField, validField, code, issueField, collector) {
  const groups = new Map();
  for (const record of records) {
    if (!record[validField]) continue;
    const value = record[valueField];
    const group = groups.get(value) ?? [];
    group.push(record.userIndex);
    groups.set(value, group);
  }
  for (const indexes of groups.values()) {
    if (indexes.length < 2) continue;
    for (const userIndex of indexes) collector.add("error", code, userIndex, issueField);
  }
}

function markUsernameDuplicates(records, collector) {
  const groups = new Map();
  for (const record of records) {
    for (const identity of record.usernameCandidates) {
      const indexes = groups.get(identity) ?? new Set();
      indexes.add(record.userIndex);
      groups.set(identity, indexes);
    }
  }
  for (const indexes of groups.values()) {
    if (indexes.size < 2) continue;
    for (const userIndex of indexes) {
      collector.add("error", "USER_USERNAME_DUPLICATE", userIndex, "username");
    }
  }
}

function markIdentityCollisions(records, collector) {
  const emails = new Map();
  const usernames = new Map();
  for (const record of records) {
    if (record.emailValid) addIndex(emails, record.emailNormalized, record.userIndex);
    for (const identity of record.usernameCandidates) addIndex(usernames, identity, record.userIndex);
  }
  const affected = new Set();
  for (const [identity, emailIndexes] of emails) {
    const usernameIndexes = usernames.get(identity);
    if (!usernameIndexes) continue;
    for (const index of emailIndexes) affected.add(index);
    for (const index of usernameIndexes) affected.add(index);
  }
  for (const userIndex of [...affected].sort((left, right) => left - right)) {
    collector.add("error", "USER_IDENTITY_COLLISION", userIndex, null);
  }
}

function addIndex(map, key, index) {
  const values = map.get(key) ?? [];
  values.push(index);
  map.set(key, values);
}

function validateRoleName(value, roleId) {
  if (roleId === "custom") return validCompatibleText(value, 200);
  return value === undefined || value === null;
}

function validRequiredText(value, maximumLength) {
  return typeof value === "string"
    && value === value.trim()
    && value.length >= 1
    && value.length <= maximumLength
    && !CONTROL_PATTERN.test(value);
}

function validCompatibleText(value, maximumLength) {
  if (typeof value !== "string" || CONTROL_PATTERN.test(value)) return false;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= maximumLength;
}

function validOptionalCompatibleText(value, maximumLength) {
  return value === undefined || value === null || validCompatibleText(value, maximumLength);
}

function copyDataRecord(value) {
  try {
    if (!value || Array.isArray(value) || typeof value !== "object") return { ok: false };
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return { ok: false };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) return { ok: false };
    const values = Object.create(null);
    const keys = ownKeys;
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!("value" in descriptor)) return { ok: false };
      values[key] = descriptor.value;
    }
    return { ok: true, keys, values };
  } catch {
    return { ok: false };
  }
}

function copyDataArray(value, { maximumLength = Number.MAX_SAFE_INTEGER } = {}) {
  try {
    if (!Array.isArray(value)) return { ok: false };
    const initialLengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (!initialLengthDescriptor || !("value" in initialLengthDescriptor)
        || !Number.isSafeInteger(initialLengthDescriptor.value)
        || initialLengthDescriptor.value < 0) return { ok: false };
    const length = initialLengthDescriptor.value;
    if (length > maximumLength) return { ok: true, limitExceeded: true, length };
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key === "symbol")) return { ok: false };
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== length) {
      return { ok: false };
    }
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) return { ok: false };
      values.push(descriptor.value);
    }
    if (ownKeys.some((key) => !isExpectedArrayKey(key, length))) return { ok: false };
    return { ok: true, limitExceeded: false, values };
  } catch {
    return { ok: false };
  }
}

function isExpectedArrayKey(key, length) {
  if (key === "length") return true;
  if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function createIssueCollector(maximumStoredIssues) {
  const issues = [];
  const userErrorIndexes = new Set();
  let errorCount = 0;
  let warningCount = 0;
  let totalIssueCount = 0;
  return {
    issues,
    userErrorIndexes,
    get errorCount() { return errorCount; },
    get warningCount() { return warningCount; },
    get totalIssueCount() { return totalIssueCount; },
    add(severity, code, userIndex, field) {
      totalIssueCount += 1;
      if (severity === "error") errorCount += 1;
      else warningCount += 1;
      if (severity === "error" && userIndex !== null) userErrorIndexes.add(userIndex);
      if (issues.length >= maximumStoredIssues) return;
      issues.push({ severity, code, userIndex, field });
    }
  };
}

function buildReport({
  collector,
  maxIssues,
  inputUserCount = 0,
  importableUserCount = 0,
  activeUserCount = 0,
  inactiveUserCount = 0,
  legacyEmailCount = 0,
  requiredUsernameAssignmentCount = 0
}) {
  const sorted = [...collector.issues].sort(compareIssues);
  const limitReached = collector.totalIssueCount > maxIssues;
  let issues = [...sorted];
  let omittedIssueCount = 0;
  let extraLimitError = 0;
  if (limitReached) {
    extraLimitError = 1;
    if (maxIssues === 0) {
      issues = [];
      omittedIssueCount = collector.totalIssueCount;
    } else {
      const visibleCount = maxIssues - 1;
      issues = [
        ...sorted.slice(0, visibleCount),
        { severity: "error", code: "ISSUE_LIMIT_REACHED", userIndex: null, field: null }
      ];
      omittedIssueCount = collector.totalIssueCount - visibleCount;
    }
  }
  const errorCount = collector.errorCount + extraLimitError;
  const warningCount = collector.warningCount;
  const ok = errorCount === 0;
  return deepFreeze({
    ok,
    status: ok ? "ready" : "blocked",
    inputUserCount,
    importableUserCount,
    activeUserCount,
    inactiveUserCount,
    legacyEmailCount,
    requiredUsernameAssignmentCount,
    errorCount,
    warningCount,
    omittedIssueCount,
    issueLimitReached: limitReached,
    issues
  });
}

function compareIssues(left, right) {
  const severity = (left.severity === "error" ? 0 : 1) - (right.severity === "error" ? 0 : 1);
  if (severity) return severity;
  const code = left.code.localeCompare(right.code);
  if (code) return code;
  const leftIndex = left.userIndex === null ? -1 : left.userIndex;
  const rightIndex = right.userIndex === null ? -1 : right.userIndex;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return String(left.field ?? "").localeCompare(String(right.field ?? ""));
}

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

function requireAnalyzerLimits(maxUsers, maxIssues) {
  if (!Number.isSafeInteger(maxUsers) || maxUsers < 0
      || !Number.isSafeInteger(maxIssues) || maxIssues < 0) {
    throw new UserImportReadinessError("USER_IMPORT_READINESS_OPTIONS_INVALID");
  }
}
