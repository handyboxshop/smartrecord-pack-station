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
        email: "owner@hyd.furniture",
        name: "Owner User",
        roleId: "owner",
        employeeId: "EMP-0012",
        active: true,
        passwordSalt: "0d20d915c10e0bee06d41fb6",
        passwordHash: "d1a9bb89a36c2a27706acbbff60152473c0bced738a0227225f600e221fb3d42"
      },
      {
        id: "USR-ADMIN",
        email: "admin@hyd.furniture",
        name: "System Admin",
        roleId: "admin",
        employeeId: "EMP-0012",
        active: true,
        passwordSalt: "0d20d915c10e0bee06d41fb6",
        passwordHash: "d1a9bb89a36c2a27706acbbff60152473c0bced738a0227225f600e221fb3d42"
      },
      {
        id: "USR-PACKER",
        email: "packer@hyd.furniture",
        name: "Pack Staff",
        roleId: "packer",
        employeeId: "EMP-0008",
        active: true,
        passwordSalt: "63a4f505ce5c329165829753",
        passwordHash: "68e146ccb72315ea2f724183bc716276626fe0acba3417893c6c990e1823a4d1"
      }
    ]
  }
};

test("login returns a session token and public user permissions", () => {
  const service = createService();

  const result = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });

  assert.equal(result.ok, true);
  assert.equal(typeof result.data.token, "string");
  assert.equal(result.data.user.email, "admin@hyd.furniture");
  assert.equal(result.data.user.employeeName, "สมชาย ป.");
  assert.equal(result.data.user.permissions.includes("users:manage"), true);
  assert.equal(result.data.user.passwordHash, undefined);
});

test("login tolerates copy-pasted whitespace around credentials", () => {
  const service = createService();

  const result = service.login({ email: " admin@hyd.furniture ", password: " SmartRecord@2026 " });

  assert.equal(result.ok, true);
  assert.equal(result.data.user.email, "admin@hyd.furniture");
});

test("login rejects an invalid password", () => {
  const service = createService();

  const result = service.login({ email: "admin@hyd.furniture", password: "wrong-password" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_LOGIN");
});

test("permission guard rejects users without a required permission", () => {
  const service = createService();
  const login = service.login({ email: "packer@hyd.furniture", password: "Pack@2026" });

  const result = service.listUsers(login.data.token);

  assert.equal(result.ok, false);
  assert.equal(result.code, "FORBIDDEN");
});

test("admin can create a user and password policy is enforced", () => {
  const service = createService();
  const login = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });

  const tooShort = service.createUser(login.data.token, {
    email: "new@hyd.furniture",
    roleId: "packer",
    password: "short"
  });
  assert.equal(tooShort.ok, false);
  assert.equal(tooShort.code, "PASSWORD_TOO_SHORT");

  const created = service.createUser(login.data.token, {
    email: "new@hyd.furniture",
    name: "New Packer",
    roleId: "packer",
    employeeName: "พนักงานใหม่",
    employeeId: "EMP-0099",
    password: "StrongPass2026"
  });
  assert.equal(created.ok, true);
  assert.equal(created.data.email, "new@hyd.furniture");
  assert.equal(created.data.roleId, "packer");
  assert.equal(created.data.employeeName, "พนักงานใหม่");
  assert.equal(created.data.employeeId, "EMP-0099");
  assert.equal(service.listUsers(login.data.token).data.users.length, 4);
  assert.equal(service.listUsers(login.data.token).data.auditLogs.length, 1);
});

test("custom role stores module permissions and normalizes edit to view", () => {
  const service = createService();
  const login = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });

  const missingName = service.createUser(login.data.token, {
    email: "custom@hyd.furniture",
    roleId: "custom",
    password: "StrongPass2026",
    modulePermissions: [{ moduleId: "reports", canView: false, canEdit: true }]
  });
  assert.equal(missingName.ok, false);
  assert.equal(missingName.code, "CUSTOM_ROLE_NAME_REQUIRED");

  const created = service.createUser(login.data.token, {
    email: "custom@hyd.furniture",
    name: "Custom Viewer",
    roleId: "custom",
    roleName: "หัวหน้าตรวจสอบ",
    password: "StrongPass2026",
    modulePermissions: [{ moduleId: "reports", canView: false, canEdit: true }]
  });

  assert.equal(created.ok, true);
  assert.equal(created.data.roleLabel, "หัวหน้าตรวจสอบ");
  assert.equal(created.data.permissions.includes("reports:view"), true);
  assert.equal(created.data.modulePermissions.find((item) => item.moduleId === "reports").canView, true);
});

test("user updates capture detailed audit changes and activity history", () => {
  const service = createService();
  const login = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });
  const created = service.createUser(login.data.token, {
    email: "history@hyd.furniture",
    name: "History User",
    roleId: "packer",
    password: "StrongPass2026"
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
  const activity = service.listActivity(login.data.token, { email: "admin@hyd.furniture" });
  assert.equal(activity.ok, true);
  assert.equal(activity.data.some((log) => log.action === "reports_view"), true);
});

test("admin can delete users and audit log records who deleted whom", () => {
  const service = createService();
  const login = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });
  const created = service.createUser(login.data.token, {
    email: "delete-me@hyd.furniture",
    name: "Delete Me",
    roleId: "packer",
    password: "StrongPass2026"
  });

  const deleted = service.deleteUser(login.data.token, { email: created.data.email });

  assert.equal(deleted.ok, true);
  const users = service.listUsers(login.data.token).data;
  assert.equal(users.users.some((user) => user.email === created.data.email), false);
  assert.equal(users.auditLogs[0].action, "delete_user");
  assert.equal(users.auditLogs[0].actorEmail, "admin@hyd.furniture");
  assert.equal(users.auditLogs[0].targetEmail, "delete-me@hyd.furniture");
  assert.equal(users.activityLogs.some((log) => log.action === "delete_user" && log.targetEmail === "delete-me@hyd.furniture"), true);
});

test("delete user guard blocks self delete, owner delete, and non admin roles", () => {
  const service = createService();
  const admin = service.login({ email: "admin@hyd.furniture", password: "SmartRecord@2026" });
  const packer = service.login({ email: "packer@hyd.furniture", password: "Pack@2026" });

  const selfDelete = service.deleteUser(admin.data.token, { email: "admin@hyd.furniture" });
  assert.equal(selfDelete.ok, false);
  assert.equal(selfDelete.code, "DELETE_SELF_FORBIDDEN");

  const ownerDelete = service.deleteUser(admin.data.token, { email: "owner@hyd.furniture" });
  assert.equal(ownerDelete.ok, false);
  assert.equal(ownerDelete.code, "DELETE_OWNER_FORBIDDEN");

  const nonAdminDelete = service.deleteUser(packer.data.token, { email: "admin@hyd.furniture" });
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
