import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import * as planApi from "../src/storage/userImportPlan.mjs";
import * as importerApi from "../src/storage/userImporter.mjs";
import * as verifierApi from "../src/storage/userImportVerifier.mjs";

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
function user(overrides = {}) {
  return {
    id: "USR-ONE", username: "Synthetic.User", email: " MixedCase@Example.test ",
    name: "Synthetic User", roleId: "packer", active: true,
    passwordSalt: "SENSITIVE-SALT-MARKER", passwordHash: "a".repeat(64),
    ...overrides
  };
}
function options(overrides = {}) {
  return { roles: roles(), modules: modules(), usernameAssignments: {}, sourceManifestSha256: "b".repeat(64), ...overrides };
}

test("public modules expose approved APIs and no raw-row accessor", () => {
  assert.deepEqual(Object.keys(importerApi), ["UserImportError", "importUsers"]);
  assert.deepEqual(Object.keys(verifierApi), ["UserImportVerificationError", "verifyUserImport"]);
  assert.equal("getUserImportPlanRows" in planApi, false);
  assert.equal(Object.values(planApi).some((value) => value?.name === "getUserImportPlanRows"), false);
});

test("plan has an exact safe, frozen, inspection-resistant public surface", () => {
  const plan = planApi.createUserImportPlan([user()], options());
  const expectedKeys = ["status", "sourceManifestSha256", "userCount", "permissionCount"];
  assert.deepEqual(Object.keys(plan), expectedKeys);
  assert.deepEqual(Reflect.ownKeys(plan), expectedKeys);
  assert.equal(Object.isFrozen(plan), true);
  const surface = `${JSON.stringify(plan)}\n${inspect(plan, { showHidden: true })}\n${inspect(Object.getOwnPropertyDescriptors(plan))}`;
  assert.doesNotMatch(surface, /USR-ONE|Synthetic|MixedCase|SENSITIVE|aaaaaaaa/);
  assert.deepEqual({ ...plan }, {
    status: "ready", sourceManifestSha256: "b".repeat(64), userCount: 1, permissionCount: 2
  });
});

test("configured roles derive permissions and username assignments satisfy inactive users", () => {
  const source = user({ active: false });
  delete source.username;
  const plan = planApi.createUserImportPlan([source], options({ usernameAssignments: { "USR-ONE": "assigned.user" } }));
  assert.equal(plan.userCount, 1);
  assert.equal(plan.permissionCount, 2);
});

test("custom roles and explicit permissions use the shared readiness contract", () => {
  const plan = planApi.createUserImportPlan([user({
    roleId: "custom", roleName: "  Returns Team  ", employeeName: "  Operator  ",
    employeeId: "  EMP-1  ", modulePermissions: permissions([true, false], [true, true])
  })], options());
  assert.equal(plan.status, "ready");
});

test("plan creation does not mutate inputs or hash, verify, or replace credentials", () => {
  const source = user();
  const original = structuredClone(source);
  const configuration = options();
  const originalConfiguration = structuredClone(configuration);
  planApi.createUserImportPlan([source], configuration);
  assert.deepEqual(source, original);
  assert.deepEqual(configuration, originalConfiguration);
});

test("planning consumes one descriptor-only defensive snapshot and never revisits hostile input", () => {
  let getTrapCalls = 0;
  const guard = (value) => {
    if (!value || typeof value !== "object") return value;
    const target = Array.isArray(value)
      ? value.map(guard)
      : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, guard(child)]));
    return new Proxy(target, { get() { getTrapCalls += 1; throw new Error("raw property read"); } });
  };
  const guardedUsers = guard([user()]);
  const guardedOptions = guard(options());
  const plan = planApi.createUserImportPlan(guardedUsers, guardedOptions);
  assert.equal(plan.userCount, 1);
  assert.equal(plan.permissionCount, 2);
  assert.equal(getTrapCalls, 0);
});

test("legacy no-at-sign email remains supported by planning", () => {
  const plan = planApi.createUserImportPlan([user({ email: "legacy.login" })], options());
  assert.equal(plan.status, "ready");
});

test("invalid plans use fixed safe errors with no cause or sensitive inspection surface", () => {
  const marker = "SECRET-PLAN-MARKER";
  assert.throws(() => planApi.createUserImportPlan([user({ passwordHash: marker })], options()), (error) => {
    assert.equal(error.code, "USERS_IMPORT_CREDENTIAL_FAILED");
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error), ["name", "code"]);
    const surface = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${inspect(error)}`;
    assert.doesNotMatch(surface, /SECRET|PLAN-MARKER|SENSITIVE-SALT/);
    return true;
  });
});

test("disposal is idempotent and invalidates import and verification", () => {
  const plan = planApi.createUserImportPlan([user()], options());
  assert.equal(planApi.disposeUserImportPlan(plan), true);
  assert.equal(planApi.disposeUserImportPlan(plan), true);
  assert.equal(planApi.disposeUserImportPlan({}), false);
  assert.throws(() => importerApi.importUsers({}, plan), { code: "USERS_IMPORT_USAGE_INVALID" });
  assert.throws(() => verifierApi.verifyUserImport({}, plan, { importedAt: "2026-01-01T00:00:00.000Z" }), {
    code: "USERS_IMPORT_USAGE_INVALID"
  });
});
