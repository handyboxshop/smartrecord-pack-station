import assert from "node:assert/strict";
import test from "node:test";
import { createAuthService } from "../src/domain/authService.mjs";

const config = {
  employees: {
    list: [
      { id: "EMP-0012", name: "สมชาย ป." },
      { id: "EMP-0008", name: "อนุชา ส." }
    ]
  },
  auth: {
    passwordPolicy: {
      minLength: 8,
      iterations: 120000
    },
    session: {
      ttlHours: 12
    },
    modules: [
      { id: "pack", label: "Pack Station", section: "ปฏิบัติการ", viewPermission: "pack:use", editPermission: "pack:use" },
      { id: "reports", label: "Reports", section: "ตรวจสอบ", viewPermission: "reports:view", editPermission: "reports:view" },
      { id: "users", label: "Users", section: "จัดการ", viewPermission: "users:manage", editPermission: "users:manage" }
    ],
    roles: [
      {
        id: "owner",
        label: "Owner",
        modulePermissions: [
          { moduleId: "pack", canView: true, canEdit: true },
          { moduleId: "reports", canView: true, canEdit: true },
          { moduleId: "users", canView: true, canEdit: true }
        ]
      },
      {
        id: "admin",
        label: "Admin",
        modulePermissions: [
          { moduleId: "pack", canView: true, canEdit: true },
          { moduleId: "reports", canView: true, canEdit: true },
          { moduleId: "users", canView: true, canEdit: true }
        ]
      },
      {
        id: "packer",
        label: "Packer",
        modulePermissions: [
          { moduleId: "pack", canView: true, canEdit: true },
          { moduleId: "reports", canView: false, canEdit: false },
          { moduleId: "users", canView: false, canEdit: false }
        ]
      },
      {
        id: "custom",
        label: "Custom",
        modulePermissions: [
          { moduleId: "pack", canView: false, canEdit: false },
          { moduleId: "reports", canView: false, canEdit: false },
          { moduleId: "users", canView: false, canEdit: false }
        ]
      }
    ],
    users: [
      {
        id: "USR-OWNER",
        email: "owner@example.local",
        name: "Owner User",
        roleId: "owner",
        employeeId: "EMP-0012",
        active: true,
        passwordSalt: "a1b2c3d4e5f60718293a4b5c",
        passwordHash: "20ae66f94a80e326b9b3c3089487c37b0ff71ddb68cffd9e832a249ac58be2a6"
      },
      {
        id: "USR-ADMIN",
        email: "admin@example.local",
        name: "System Admin",
        roleId: "admin",
        employeeId: "EMP-0012",
        active: true,
        passwordSalt: "a1b2c3d4e5f60718293a4b5c",
        passwordHash: "20ae66f94a80e326b9b3c3089487c37b0ff71ddb68cffd9e832a249ac58be2a6"
      },
      {
        id: "USR-PACKER",
        email: "packer@example.local",
        name: "Pack Staff",
        roleId: "packer",
        employeeId: "EMP-0008",
        active: true,
        passwordSalt: "f2e1d0c9b8a7968574635241",
        passwordHash: "af968ea315cc602ebc820d8d249372dc9676b677311c85dfe34b7f3051b4039d"
      }
    ]
  }
};

test("login returns a session token and public user permissions", () => {
  const service = createService();

  const result = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });

  assert.equal(result.ok, true);
  assert.equal(typeof result.data.token, "string");
  assert.equal(result.data.user.email, "admin@example.local");
  assert.equal(result.data.user.employeeName, "สมชาย ป.");
  assert.equal(result.data.user.permissions.includes("users:manage"), true);
  assert.equal(result.data.user.passwordHash, undefined);
});

test("login tolerates copy-pasted whitespace around credentials", () => {
  const service = createService();

  const result = service.login({ email: " admin@example.local ", password: " TestAdmin@Local " });

  assert.equal(result.ok, true);
  assert.equal(result.data.user.email, "admin@example.local");
});

test("login rejects an invalid password", () => {
  const service = createService();

  const result = service.login({ email: "admin@example.local", password: "wrong-password" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_LOGIN");
});

test("permission guard rejects users without a required permission", () => {
  const service = createService();
  const login = service.login({ email: "packer@example.local", password: "TestPacker@Local" });

  const result = service.listUsers(login.data.token);

  assert.equal(result.ok, false);
  assert.equal(result.code, "FORBIDDEN");
});

test("admin can create a user and password policy is enforced", () => {
  const service = createService();
  const login = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });

  const tooShort = service.createUser(login.data.token, {
    email: "new@example.local",
    roleId: "packer",
    password: "short"
  });
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, "PASSWORD_TOO_SHORT");

  const created = service.createUser(login.data.token, {
    email: "new@example.local",
    name: "New Packer",
    roleId: "packer",
    employeeName: "พนักงานใหม่",
    employeeId: "EMP-0099",
    password: "ExampleStrongPass123!"
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.email, "new@example.local");
  assert.equal(created.data.roleId, "packer");
  assert.equal(created.data.employeeName, "พนักงานใหม่");
  assert.equal(created.data.employeeId, "EMP-0099");
  assert.equal(service.listUsers(login.data.token).data.users.length, 4);
  assert.equal(service.listUsers(login.data.token).data.auditLogs.length, 1);
});

test("custom role stores module permissions and normalizes edit to view", () => {
  const service = createService();
  const login = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });

  const missingName = service.createUser(login.data.token, {
    email: "custom@example.local",
    roleId: "custom",
    password: "ExampleStrongPass123!",
    modulePermissions: [{ moduleId: "reports", canView: false, canEdit: true }]
  });
  assert.equal(missingName.ok, false);
  assert.equal(missingName.code, "CUSTOM_ROLE_NAME_REQUIRED");

  const created = service.createUser(login.data.token, {
    email: "custom@example.local",
    name: "Custom Viewer",
    roleId: "custom",
    roleName: "หัวหน้าตรวจสอบ",
    password: "ExampleStrongPass123!",
    modulePermissions: [{ moduleId: "reports", canView: false, canEdit: true }]
  });

  assert.equal(created.ok, true);
  assert.equal(created.data.roleLabel, "หัวหน้าตรวจสอบ");
  assert.equal(created.data.permissions.includes("reports:view"), true);
  assert.equal(created.data.modulePermissions.find((item) => item.moduleId === "reports").canView, true);
});

test("user updates capture detailed audit changes and activity history", () => {
  const service = createService();
  const login = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });
  const created = service.createUser(login.data.token, {
    email: "history@example.local",
    name: "History User",
    roleId: "packer",
    password: "ExampleStrongPass123!"
  });

  const updated = service.updateUser(login.data.token, {
    email: created.data.email,
    name: "History Auditor",
    roleId: "custom",
    roleName: "ดูรายงานอย่างเดียว",
    modulePermissions: [{ moduleId: "reports", canView: true, canEdit: false }],
    active: false
  });
  assert.equal(updated.ok, true);

  const users = service.listUsers(login.data.token).data;
  assert.equal(users.auditLogs.length, 2);
  assert.equal(users.auditLogs[0].action, "update_user");
  assert.equal(users.auditLogs[0].changes.some((change) => change.field === "name"), true);
  assert.equal(users.auditLogs[0].changes.some((change) => change.field === "permissions"), true);

  service.recordActivity(login.data.token, {
    action: "reports_view",
    moduleId: "reports",
    details: "เปิดดูรายงาน"
  });
  const activity = service.listActivity(login.data.token, { email: "admin@example.local" });
  assert.equal(activity.ok, true);
  assert.equal(activity.data.some((log) => log.action === "reports_view"), true);
});

test("admin can delete users and audit log records who deleted whom", () => {
  const service = createService();
  const login = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });
  const created = service.createUser(login.data.token, {
    email: "delete-me@example.local",
    name: "Delete Me",
    roleId: "packer",
    password: "ExampleStrongPass123!"
  });

  const deleted = service.deleteUser(login.data.token, { email: created.data.email });

  assert.equal(deleted.ok, true);
  const users = service.listUsers(login.data.token).data;
  assert.equal(users.users.some((user) => user.email === created.data.email), false);
  assert.equal(users.auditLogs[0].action, "delete_user");
  assert.equal(users.auditLogs[0].actorEmail, "admin@example.local");
  assert.equal(users.auditLogs[0].targetEmail, "delete-me@example.local");
  assert.equal(users.activityLogs.some((log) => log.action === "delete_user" && log.targetEmail === "delete-me@example.local"), true);
});

test("delete user guard blocks self delete, owner delete, and non admin roles", () => {
  const service = createService();
  const admin = service.login({ email: "admin@example.local", password: "TestAdmin@Local" });
  const packer = service.login({ email: "packer@example.local", password: "TestPacker@Local" });

  const selfDelete = service.deleteUser(admin.data.token, { email: "admin@example.local" });
  assert.equal(selfDelete.ok, false);
  assert.equal(selfDelete.code, "DELETE_SELF_FORBIDDEN");

  const ownerDelete = service.deleteUser(admin.data.token, { email: "owner@example.local" });
  assert.equal(ownerDelete.ok, false);
  assert.equal(ownerDelete.code, "DELETE_OWNER_FORBIDDEN");

  const nonAdminDelete = service.deleteUser(packer.data.token, { email: "admin@example.local" });
  assert.equal(nonAdminDelete.ok, false);
  assert.equal(nonAdminDelete.code, "FORBIDDEN");
});

function createService() {
  let id = 0;
  return createAuthService({
    config: structuredClone(config),
    idFactory: () => `id-${++id}`,
    now: () => new Date(Date.UTC(2026, 5, 22, 8, 0, 0))
  });
}
