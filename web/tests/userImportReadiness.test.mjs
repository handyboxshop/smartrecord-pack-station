import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  UserImportReadinessError,
  analyzeUserImportReadiness,
  createUserImportReadinessAnalyzer
} from "../src/storage/userImportReadiness.mjs";

function modules() {
  return [
    { id: "pack", label: "Pack", section: "Ops", viewPermission: "pack:use", editPermission: "pack:use" },
    { id: "users", label: "Users", section: "Admin", viewPermission: "users:manage", editPermission: "users:manage" }
  ];
}

function permissions(pack = [true, true], users = [false, false]) {
  return [
    { moduleId: "pack", canView: pack[0], canEdit: pack[1] },
    { moduleId: "users", canView: users[0], canEdit: users[1] }
  ];
}

function roles() {
  return [
    { id: "packer", label: "Packer", modulePermissions: permissions() },
    { id: "custom", label: "Custom", modulePermissions: permissions([false, false]) }
  ];
}

function options(overrides = {}) {
  return { roles: roles(), modules: modules(), usernameAssignments: {}, ...overrides };
}

function user(index = 1, overrides = {}) {
  return {
    id: `USR-${index}`,
    username: `user-${index}`,
    email: `user-${index}@example.test`,
    name: `Synthetic User ${index}`,
    roleId: "packer",
    active: true,
    passwordSalt: `synthetic-salt-${index}`,
    passwordHash: String(index % 10).repeat(64),
    ...overrides
  };
}

function codes(report) {
  return report.issues.map((issue) => issue.code);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test("valid synthetic snapshots have the exact ready report contract", () => {
  const ready = analyzeUserImportReadiness([user()], options());
  assert.deepEqual(ready, {
    ok: true,
    status: "ready",
    inputUserCount: 1,
    importableUserCount: 1,
    activeUserCount: 1,
    inactiveUserCount: 0,
    legacyEmailCount: 0,
    requiredUsernameAssignmentCount: 0,
    errorCount: 0,
    warningCount: 0,
    omittedIssueCount: 0,
    issueLimitReached: false,
    issues: []
  });
});

test("empty snapshots are blocked with exactly one batch issue", () => {
  assert.deepEqual(analyzeUserImportReadiness([], options()), {
    ok: false,
    status: "blocked",
    inputUserCount: 0,
    importableUserCount: 0,
    activeUserCount: 0,
    inactiveUserCount: 0,
    legacyEmailCount: 0,
    requiredUsernameAssignmentCount: 0,
    errorCount: 1,
    warningCount: 0,
    omittedIssueCount: 0,
    issueLimitReached: false,
    issues: [{ severity: "error", code: "USERS_INPUT_EMPTY", userIndex: null, field: null }]
  });
});

test("analyzer construction is bounded, stable, and private", () => {
  for (const invalid of [null, [], { maxUsers: -1 }, { maxIssues: 1.5 }, { extra: 1 }]) {
    assert.throws(() => createUserImportReadinessAnalyzer(invalid), (error) => {
      assert.equal(error instanceof UserImportReadinessError, true);
      assert.equal(error.code, "USER_IMPORT_READINESS_OPTIONS_INVALID");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(`${error.message}\n${error.stack}\n${inspect(error)}\n${JSON.stringify(error)}`, /extra|1\.5/);
      return true;
    });
  }
  assert.deepEqual(codes(createUserImportReadinessAnalyzer({ maxUsers: 0 }).analyze([], options())), ["USERS_INPUT_EMPTY"]);
});

test("non-array users and maximum-user bounds return blocked reports", () => {
  assert.deepEqual(codes(analyzeUserImportReadiness({}, options())), ["USERS_INPUT_INVALID"]);
  const report = createUserImportReadinessAnalyzer({ maxUsers: 1 }).analyze([user(1), user(2)], options());
  assert.deepEqual(codes(report), ["USERS_LIMIT_EXCEEDED"]);
  assert.equal(report.inputUserCount, 0);
});

test("Users bounds are applied before any indexed descriptor is inspected", () => {
  const marker = "SECRET-OVERSIZED-USERS-MARKER";
  let indexedInspections = 0;
  const oversized = new Proxy(new Array(2), {
    getOwnPropertyDescriptor(target, property) {
      if (property !== "length") {
        indexedInspections += 1;
        throw new Error(marker);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });
  const report = createUserImportReadinessAnalyzer({ maxUsers: 1 }).analyze(oversized, options());
  assert.deepEqual(codes(report), ["USERS_LIMIT_EXCEEDED"]);
  assert.equal(indexedInspections, 0);
  assert.doesNotMatch(`${JSON.stringify(report)} ${inspect(report)}`, /SECRET|OVERSIZED|MARKER/);
});

test("role and module bounds are applied before indexed descriptors are inspected", () => {
  const boundedProxy = (marker, calls) => new Proxy(new Array(65), {
    getOwnPropertyDescriptor(target, property) {
      if (property !== "length") {
        calls.count += 1;
        throw new Error(marker);
      }
      return Reflect.getOwnPropertyDescriptor(target, property);
    }
  });
  const roleCalls = { count: 0 };
  const roleReport = analyzeUserImportReadiness([user()], options({
    roles: boundedProxy("SECRET-ROLE-BOUND", roleCalls)
  }));
  assert.ok(codes(roleReport).includes("CONFIG_ROLES_INVALID"));
  assert.equal(roleCalls.count, 0);

  const moduleCalls = { count: 0 };
  const moduleReport = analyzeUserImportReadiness([user()], options({
    modules: boundedProxy("SECRET-MODULE-BOUND", moduleCalls)
  }));
  assert.ok(codes(moduleReport).includes("CONFIG_MODULES_INVALID"));
  assert.equal(moduleCalls.count, 0);
  assert.doesNotMatch(`${JSON.stringify([roleReport, moduleReport])} ${inspect([roleReport, moduleReport])}`, /SECRET|BOUND/);
});

test("valid Users, role, and module arrays remain supported at exact configured maxima", () => {
  const usersAtMaximum = createUserImportReadinessAnalyzer({ maxUsers: 2 }).analyze([user(1), user(2)], options());
  assert.equal(usersAtMaximum.ok, true);

  const rolesAtMaximum = Array.from({ length: 64 }, (_, index) => ({
    id: `role-${index}`,
    label: `Role ${index}`,
    modulePermissions: permissions()
  }));
  assert.equal(analyzeUserImportReadiness([user(1, { roleId: "role-0" })], options({ roles: rolesAtMaximum })).ok, true);

  const modulesAtMaximum = Array.from({ length: 64 }, (_, index) => ({
    id: `module-${index}`,
    label: `Module ${index}`,
    section: "Synthetic",
    viewPermission: `module-${index}:view`,
    editPermission: `module-${index}:edit`
  }));
  const permissionsAtMaximum = modulesAtMaximum.map((module) => ({
    moduleId: module.id,
    canView: false,
    canEdit: false
  }));
  const maximumRole = [{ id: "maximum", label: "Maximum", modulePermissions: permissionsAtMaximum }];
  assert.equal(analyzeUserImportReadiness([user(1, { roleId: "maximum" })], options({
    modules: modulesAtMaximum,
    roles: maximumRole
  })).ok, true);
});

test("missing and valid PBKDF2-SHA256 policies preserve readiness", () => {
  assert.equal(analyzeUserImportReadiness([user()], options()).ok, true);
  assert.equal(analyzeUserImportReadiness([user()], options({
    passwordPolicy: { minLength: 8, hashAlgorithm: "pbkdf2-sha256", iterations: 120000 }
  })).ok, true);
  assert.equal(analyzeUserImportReadiness([user()], options({
    passwordPolicy: { iterations: 1 }
  })).ok, true);
  assert.equal(analyzeUserImportReadiness([user()], options({
    passwordPolicy: { iterations: 10_000_000 }
  })).ok, true);
});

test("unsupported algorithms and malformed password-policy numbers block", () => {
  assert.deepEqual(codes(analyzeUserImportReadiness([user()], options({
    passwordPolicy: { hashAlgorithm: "argon2id" }
  }))), ["CONFIG_PASSWORD_POLICY_INVALID"]);
  for (const iterations of ["120000", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, 10_000_001]) {
    assert.deepEqual(codes(analyzeUserImportReadiness([user()], options({
      passwordPolicy: { iterations }
    }))), ["CONFIG_PASSWORD_POLICY_INVALID"]);
  }
  for (const minLength of ["8", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(codes(analyzeUserImportReadiness([user()], options({
      passwordPolicy: { minLength }
    }))), ["CONFIG_PASSWORD_POLICY_INVALID"]);
  }
});

test("hostile password-policy objects block privately without getter execution", () => {
  const marker = "SECRET-PASSWORD-POLICY-MARKER";
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "iterations", {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(marker); }
  });
  const symbolPolicy = { iterations: 120000 };
  symbolPolicy[Symbol(marker)] = marker;
  const policies = [
    accessor,
    symbolPolicy,
    Object.assign(Object.create({ polluted: marker }), { iterations: 120000 }),
    { iterations: 120000, unknownPolicyField: marker }
  ];
  for (const passwordPolicy of policies) {
    const report = analyzeUserImportReadiness([user()], options({ passwordPolicy }));
    assert.deepEqual(codes(report), ["CONFIG_PASSWORD_POLICY_INVALID"]);
    const surface = `${JSON.stringify(report)}\n${inspect(report)}`;
    assert.doesNotMatch(surface, /SECRET|PASSWORD-POLICY|MARKER|polluted|unknownPolicyField|120000/);
  }
  assert.equal(getterCalls, 0);
});

test("non-plain records, accessors, symbols, prototypes, and unknown fields are rejected without getter access", () => {
  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "id", { enumerable: true, get() { getterCalls += 1; return "USR-SECRET"; } });
  const symbolRecord = user(2);
  symbolRecord[Symbol("private")] = "secret";
  const reports = [
    analyzeUserImportReadiness([null], options()),
    analyzeUserImportReadiness([Object.assign(Object.create({ inherited: true }), user(1))], options()),
    analyzeUserImportReadiness([accessor], options()),
    analyzeUserImportReadiness([symbolRecord], options()),
    analyzeUserImportReadiness([user(3, { token: "secret-token" })], options())
  ];
  assert.equal(getterCalls, 0);
  assert.ok(reports.slice(0, 4).every((report) => codes(report).includes("USER_SHAPE_INVALID")));
  assert.ok(codes(reports[4]).includes("USER_FIELD_UNKNOWN"));
  assert.doesNotMatch(JSON.stringify(reports), /secret|token|private|inherited/);
});

test("caller inputs are neither mutated nor retained", () => {
  const users = [user()];
  const config = options();
  const beforeUsers = clone(users);
  const beforeConfig = clone(config);
  const report = analyzeUserImportReadiness(users, config);
  assert.deepEqual(users, beforeUsers);
  assert.deepEqual(config, beforeConfig);
  users[0].name = "Changed later";
  assert.doesNotMatch(JSON.stringify(report), /Changed later|Synthetic User/);
});

test("invalid and duplicate IDs block both duplicate records", () => {
  const report = analyzeUserImportReadiness([
    user(1),
    user(2, { id: "USR-1", username: "user-2" }),
    user(3, { id: "bad" })
  ], options());
  assert.equal(report.issues.filter((issue) => issue.code === "USER_ID_DUPLICATE").length, 2);
  assert.ok(codes(report).includes("USER_ID_INVALID"));
  assert.equal(report.importableUserCount, 0);
});

test("strict modern email, accepted legacy email, and hostile identities are classified", () => {
  const legacy = analyzeUserImportReadiness([user(1, { email: "legacy.user-1" })], options());
  assert.equal(legacy.ok, true);
  assert.equal(legacy.legacyEmailCount, 1);
  assert.deepEqual(codes(legacy), ["USER_EMAIL_LEGACY"]);
  for (const email of ["a@@b", "a b@example.test", "ผู้ใช้@example.test", "a\0b@example.test", "a\nb@example.test", ".legacy", "legacy..id"]) {
    assert.ok(codes(analyzeUserImportReadiness([user(1, { email })], options())).includes("USER_EMAIL_INVALID"));
  }
});

test("normalized duplicate emails mark every affected record", () => {
  const report = analyzeUserImportReadiness([
    user(1, { email: "Same@Example.Test" }),
    user(2, { email: "same@example.test" })
  ], options());
  assert.deepEqual(report.issues.filter((issue) => issue.code === "USER_EMAIL_DUPLICATE").map((issue) => issue.userIndex), [0, 1]);
});

test("username readiness applies to active and inactive users", () => {
  const report = analyzeUserImportReadiness([
    user(1, { username: undefined, active: true }),
    user(2, { username: undefined, active: false })
  ], options());
  assert.equal(report.activeUserCount, 1);
  assert.equal(report.inactiveUserCount, 1);
  assert.equal(report.requiredUsernameAssignmentCount, 2);
  assert.equal(report.issues.filter((issue) => issue.code === "USER_USERNAME_REQUIRED").length, 2);
});

test("source and operator assignment usernames are accepted only under the exact contract", () => {
  const assignedUser = user(2);
  delete assignedUser.username;
  const ready = analyzeUserImportReadiness([user(1), assignedUser], options({
    usernameAssignments: { "USR-2": "assigned-2" }
  }));
  assert.equal(ready.ok, true);
  for (const username of [" ab", "ab", "a@b", "ผู้ใช้", "a b", "ab\0c", "abc-"]) {
    const candidate = user(1);
    delete candidate.username;
    const report = analyzeUserImportReadiness([candidate], options({ usernameAssignments: { "USR-1": username } }));
    assert.ok(codes(report).includes("USERNAME_ASSIGNMENT_INVALID"));
  }
});

test("assignment maps reject unknown IDs, bad values, and source conflicts", () => {
  assert.ok(codes(analyzeUserImportReadiness([user()], options({
    usernameAssignments: { "USR-UNKNOWN": "unknown-user" }
  }))).includes("USERNAME_ASSIGNMENT_UNKNOWN_USER"));
  assert.ok(codes(analyzeUserImportReadiness([user()], options({
    usernameAssignments: { "USR-1": 42 }
  }))).includes("USERNAME_ASSIGNMENTS_INVALID"));
  assert.ok(codes(analyzeUserImportReadiness([user()], options({
    usernameAssignments: { "USR-1": "different-user" }
  }))).includes("USERNAME_ASSIGNMENT_CONFLICT"));
  assert.ok(codes(analyzeUserImportReadiness([user()], options({
    usernameAssignments: { "USR-1": "USER-1" }
  }))).includes("USERNAME_ASSIGNMENT_CONFLICT"));
});

test("assignment conflicts do not hide safe cross-record identity findings", () => {
  const report = analyzeUserImportReadiness([
    user(1, { username: "shared-login" }),
    user(2, { username: "SHARED-LOGIN" })
  ], options({ usernameAssignments: { "USR-1": "different-login" } }));
  assert.ok(codes(report).includes("USERNAME_ASSIGNMENT_CONFLICT"));
  assert.deepEqual(report.issues.filter((issue) => issue.code === "USER_USERNAME_DUPLICATE").map((issue) => issue.userIndex), [0, 1]);
});

test("normalized duplicate usernames and cross-namespace collisions mark all records", () => {
  const duplicate = analyzeUserImportReadiness([
    user(1, { username: "Same.User" }),
    user(2, { username: "same.user" })
  ], options());
  assert.deepEqual(duplicate.issues.filter((issue) => issue.code === "USER_USERNAME_DUPLICATE").map((issue) => issue.userIndex), [0, 1]);

  const collision = analyzeUserImportReadiness([
    user(1, { username: "other-user", email: "login-name" }),
    user(2, { username: "LOGIN-NAME", email: "other@example.test" })
  ], options());
  assert.deepEqual(collision.issues.filter((issue) => issue.code === "USER_IDENTITY_COLLISION").map((issue) => issue.userIndex), [0, 1]);
});

test("credentials are validated without hashing, verification, or disclosure", () => {
  const secret = "SECRET-CREDENTIAL-MARKER";
  const report = analyzeUserImportReadiness([
    user(1, { passwordSalt: `bad\n${secret}`, passwordHash: secret }),
    user(2, { passwordSalt: "ok", passwordHash: "A".repeat(64) })
  ], options());
  assert.equal(report.issues.filter((issue) => issue.code === "USER_CREDENTIALS_INVALID").length, 2);
  assert.doesNotMatch(`${JSON.stringify(report)} ${inspect(report)}`, /SECRET|bad|AAAA/);
});

test("configured and custom roles enforce role names and derivable permissions", () => {
  assert.ok(codes(analyzeUserImportReadiness([user(1, { roleName: "Arbitrary" })], options())).includes("USER_ROLE_INVALID"));
  assert.ok(codes(analyzeUserImportReadiness([user(1, { roleId: "custom" })], options())).includes("USER_ROLE_INVALID"));
  assert.equal(analyzeUserImportReadiness([user(1, { roleId: "custom", roleName: "Reviewer" })], options()).ok, true);
  assert.ok(codes(analyzeUserImportReadiness([user(1, { roleId: "missing" })], options())).includes("USER_ROLE_INVALID"));
});

test("explicit permission snapshots require every configured module and valid booleans", () => {
  const invalidSnapshots = [
    permissions().slice(0, 1),
    [...permissions(), { moduleId: "unknown", canView: false, canEdit: false }],
    [permissions()[0], permissions()[0]],
    permissions([false, true]),
    [{ moduleId: "pack", canView: "yes", canEdit: false }, permissions()[1]],
    ["pack:view", "users:view"]
  ];
  for (const modulePermissions of invalidSnapshots) {
    const report = analyzeUserImportReadiness([user(1, { modulePermissions })], options());
    assert.ok(codes(report).includes("USER_PERMISSIONS_INVALID"));
  }
});

test("employee fields honor optional SQLite-compatible boundaries", () => {
  for (const overrides of [
    { employeeName: "x".repeat(201) },
    { employeeId: "x".repeat(129) },
    { employeeId: "bad\nvalue" },
    { employeeName: 1 }
  ]) {
    assert.ok(codes(analyzeUserImportReadiness([user(1, overrides)], options())).includes("USER_EMPLOYEE_INVALID"));
  }
  assert.equal(analyzeUserImportReadiness([user(1, { employeeName: null, employeeId: null })], options()).ok, true);
  assert.equal(analyzeUserImportReadiness([user(1, { employeeName: " spaced " })], options()).ok, true);
});

test("issue ordering is deterministic and collection remains bounded", () => {
  const left = analyzeUserImportReadiness([user(1, { active: "yes", name: "" })], options({ usernameAssignments: { Z: "valid-z" } }));
  const reorderedOptions = { usernameAssignments: { Z: "valid-z" }, modules: modules(), roles: roles() };
  const right = analyzeUserImportReadiness([user(1, { name: "", active: "yes" })], reorderedOptions);
  assert.deepEqual(left, right);

  const limited = createUserImportReadinessAnalyzer({ maxIssues: 2 }).analyze([{}, {}], options());
  assert.equal(limited.issues.length, 2);
  assert.equal(limited.issueLimitReached, true);
  assert.ok(limited.omittedIssueCount > 0);
  assert.ok(codes(limited).includes("ISSUE_LIMIT_REACHED"));
});

test("reports are new, deeply frozen, JSON serializable, and contain no raw values", () => {
  const secret = "SECRET-IDENTITY-MARKER";
  const first = analyzeUserImportReadiness([user(1, { email: secret, name: secret })], options());
  const second = analyzeUserImportReadiness([user(1, { email: secret, name: secret })], options());
  assert.notEqual(first, second);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.issues), true);
  assert.ok(first.issues.every(Object.isFrozen));
  const surface = `${JSON.stringify(first)}\n${inspect(first)}`;
  assert.doesNotMatch(surface, /SECRET|IDENTITY|Synthetic|USR-|example\.test|salt|[0-9a-f]{64}/);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test("invalid config inputs block safely without exposing supplied values", () => {
  const secret = "SECRET-CONFIG-ROLE";
  const report = analyzeUserImportReadiness([user()], {
    roles: [{ id: secret }],
    modules: [{ get id() { throw new Error(secret); } }],
    usernameAssignments: Object.create({ polluted: true })
  });
  assert.ok(codes(report).includes("CONFIG_ROLES_INVALID"));
  assert.ok(codes(report).includes("CONFIG_MODULES_INVALID"));
  assert.ok(codes(report).includes("USERNAME_ASSIGNMENTS_INVALID"));
  assert.doesNotMatch(`${JSON.stringify(report)} ${inspect(report)}`, /SECRET|polluted/);
});
