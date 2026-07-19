import crypto from "node:crypto";
import {
  createPasswordCredentials,
  verifyPasswordCredentials
} from "./passwordCredentials.mjs";
import { normalizeLegacyEmail } from "./userIdentity.mjs";

export function createAuthService({ config, now = () => new Date(), idFactory, initialUsers = null } = {}) {
  if (!config?.auth) throw new Error("auth config is required");

  const seedUsers = Array.isArray(initialUsers) ? initialUsers : (config.auth.users || []);
  const users = new Map(seedUsers.map((user) => [normalizeLegacyEmail(user.email), { ...user }]));
  const auditLogs = [];
  const activityLogs = [];
  const sessions = new Map();
  const nextId = idFactory ?? (() => crypto.randomUUID());
  const iterations = config.auth.passwordPolicy?.iterations ?? 120000;
  const ttlMs = (config.auth.session?.ttlHours ?? 12) * 60 * 60 * 1000;

  function login({ email, password } = {}) {
    const user = users.get(normalizeLegacyEmail(email));
    if (!user || !user.active) return fail("INVALID_LOGIN", "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    if (!verifyPasswordCredentials(String(password ?? "").trim(), user, { iterations })) {
      return fail("INVALID_LOGIN", "อีเมลหรือรหัสผ่านไม่ถูกต้อง");
    }

    const token = crypto.randomBytes(32).toString("hex");
    const issuedAt = now();
    sessions.set(token, {
      token,
      userId: user.id,
      email: user.email,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlMs).toISOString()
    });

    const publicUser = toPublicUser(user, config);
    activityLogs.unshift(createActivityLog(publicUser, {
      action: "login",
      moduleId: "auth",
      details: "เข้าสู่ระบบ"
    }));
    return ok({
      token,
      expiresAt: sessions.get(token).expiresAt,
      user: publicUser
    });
  }

  function logout(token) {
    const current = getSession(token);
    if (current.ok) {
      activityLogs.unshift(createActivityLog(current.data.user, {
        action: "logout",
        moduleId: "auth",
        details: "ออกจากระบบ"
      }));
    }
    if (token) sessions.delete(token);
    return ok({ loggedOut: true });
  }

  function getSession(token) {
    const session = sessions.get(String(token ?? ""));
    if (!session) return fail("AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
    if (new Date(session.expiresAt).getTime() <= now().getTime()) {
      sessions.delete(session.token);
      return fail("SESSION_EXPIRED", "Session หมดอายุ กรุณาเข้าสู่ระบบใหม่");
    }
    const user = [...users.values()].find((candidate) => candidate.id === session.userId);
    if (!user || !user.active) return fail("AUTH_REQUIRED", "บัญชีนี้ถูกปิดใช้งาน");
    return ok({ session, user: toPublicUser(user, config) });
  }

  function requirePermission(token, permission) {
    const result = getSession(token);
    if (!result.ok) return result;
    if (!hasPermission(result.data.user, permission)) {
      return fail("FORBIDDEN", "บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้", result.data);
    }
    return result;
  }

  function listUsers(token) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;
    return ok({
      users: [...users.values()].map((user) => toPublicUser(user, config)),
      auditLogs: [...auditLogs],
      activityLogs: [...activityLogs]
    });
  }

  function listActivity(token, { email = "" } = {}) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;
    const normalizedEmail = normalizeLegacyEmail(email);
    const rows = normalizedEmail
      ? activityLogs.filter((log) => log.userEmail === normalizedEmail || log.targetEmail === normalizedEmail)
      : activityLogs;
    return ok(rows);
  }

  function createUser(token, input = {}) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;

    const email = normalizeLegacyEmail(input.email);
    const password = String(input.password ?? "");
    const role = findRole(config, input.roleId);
    if (!email) return fail("USER_EMAIL_REQUIRED", "กรุณากรอกอีเมล");
    if (users.has(email)) return fail("USER_EMAIL_EXISTS", "อีเมลนี้มีอยู่แล้ว");
    if (!role) return fail("ROLE_NOT_FOUND", "ไม่พบ role ที่เลือก");
    if (password.length < (config.auth.passwordPolicy?.minLength ?? 8)) {
      return fail("PASSWORD_TOO_SHORT", "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
    }

    const credentials = createPasswordCredentials(password, { iterations });
    const user = {
      id: `USR-${String(nextId()).replace(/[^a-zA-Z0-9]/g, "").slice(0, 10).toUpperCase()}`,
      email,
      name: String(input.name ?? "").trim() || email,
      roleId: role.id,
      roleName: role.id === "custom" ? String(input.roleName ?? "").trim() : null,
      modulePermissions: role.id === "custom"
        ? normalizeModulePermissions(config, input.modulePermissions)
        : buildRoleModulePermissions(config, role.id),
      employeeName: String(input.employeeName ?? "").trim() || null,
      employeeId: String(input.employeeId ?? "").trim() || null,
      active: input.active !== false,
      ...credentials
    };
    if (role.id === "custom" && !user.roleName) {
      return fail("CUSTOM_ROLE_NAME_REQUIRED", "กรุณาตั้งชื่อ custom role");
    }
    users.set(email, user);
    const publicUser = toPublicUser(user, config);
    auditLogs.unshift(createAuditLog(auth.data.user, publicUser, "create_user", `สร้างบัญชี ${user.email}`, userSnapshot(publicUser, config)));
    activityLogs.unshift(createActivityLog(auth.data.user, {
      action: "create_user",
      moduleId: "users",
      targetEmail: user.email,
      details: `สร้างบัญชี ${user.email}`
    }));
    return ok(toPublicUser(user, config), "สร้างบัญชีผู้ใช้สำเร็จ");
  }

  function updateUser(token, input = {}) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;

    const email = normalizeLegacyEmail(input.email);
    const user = users.get(email);
    if (!user) return fail("USER_NOT_FOUND", "ไม่พบบัญชีผู้ใช้นี้");
    const before = toPublicUser(user, config);
    const role = input.roleId ? findRole(config, input.roleId) : findRole(config, user.roleId);
    if (!role) return fail("ROLE_NOT_FOUND", "ไม่พบ role ที่เลือก");

    user.name = String(input.name ?? user.name).trim() || user.email;
    user.roleId = role.id;
    user.roleName = role.id === "custom" ? String(input.roleName ?? user.roleName ?? "").trim() : null;
    user.modulePermissions = role.id === "custom"
      ? normalizeModulePermissions(config, input.modulePermissions ?? user.modulePermissions)
      : buildRoleModulePermissions(config, role.id);
    if (role.id === "custom" && !user.roleName) {
      return fail("CUSTOM_ROLE_NAME_REQUIRED", "กรุณาตั้งชื่อ custom role");
    }
    user.employeeName = String(input.employeeName ?? user.employeeName ?? "").trim() || null;
    user.employeeId = String(input.employeeId ?? user.employeeId ?? "").trim() || null;
    user.active = input.active !== false;

    const password = String(input.password ?? "");
    if (password) {
      if (password.length < (config.auth.passwordPolicy?.minLength ?? 8)) {
        return fail("PASSWORD_TOO_SHORT", "รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร");
      }
      Object.assign(user, createPasswordCredentials(password, { iterations }));
    }
    users.set(email, user);
    const after = toPublicUser(user, config);
    const changes = diffUsers(before, after, Boolean(password), config);
    auditLogs.unshift(createAuditLog(auth.data.user, after, "update_user", `อัปเดตบัญชี ${user.email}`, changes));
    activityLogs.unshift(createActivityLog(auth.data.user, {
      action: "update_user",
      moduleId: "users",
      targetEmail: user.email,
      details: changes.length ? changes.map((change) => change.label).join(", ") : `อัปเดตบัญชี ${user.email}`
    }));
    return ok(after, "อัปเดตบัญชีผู้ใช้สำเร็จ");
  }

  function updateUserPermission(token, input = {}) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;

    const user = users.get(normalizeLegacyEmail(input.email));
    if (!user) return fail("USER_NOT_FOUND", "ไม่พบบัญชีผู้ใช้นี้");
    const before = toPublicUser(user, config);
    user.roleId = "custom";
    user.roleName = String(input.roleName ?? user.roleName ?? "Custom").trim();
    user.modulePermissions = normalizeModulePermissions(config, input.modulePermissions);
    users.set(user.email, user);
    const after = toPublicUser(user, config);
    const changes = diffUsers(before, after, false, config);
    auditLogs.unshift(createAuditLog(auth.data.user, after, "update_permission", `ปรับสิทธิ์รายเมนูของ ${user.email}`, changes));
    activityLogs.unshift(createActivityLog(auth.data.user, {
      action: "update_permission",
      moduleId: "users",
      targetEmail: user.email,
      details: changes.map((change) => change.label).join(", ") || `ปรับสิทธิ์ ${user.email}`
    }));
    return ok(after, "อัปเดต permission สำเร็จ");
  }

  function deleteUser(token, input = {}) {
    const auth = requirePermission(token, "users:manage");
    if (!auth.ok) return auth;
    if (!["owner", "admin"].includes(auth.data.user.roleId)) {
      return fail("DELETE_USER_FORBIDDEN", "ลบผู้ใช้งานได้เฉพาะ Owner/Admin");
    }

    const email = normalizeLegacyEmail(input.email);
    const user = users.get(email);
    if (!user) return fail("USER_NOT_FOUND", "ไม่พบบัญชีผู้ใช้นี้");
    const target = toPublicUser(user, config);
    if (target.email === auth.data.user.email) {
      return fail("DELETE_SELF_FORBIDDEN", "ไม่สามารถลบบัญชีตัวเองได้");
    }
    if (target.roleId === "owner") {
      return fail("DELETE_OWNER_FORBIDDEN", "ไม่สามารถลบผู้ใช้งาน role owner ได้");
    }

    users.delete(email);
    for (const [sessionToken, session] of sessions.entries()) {
      if (session.userId === user.id) sessions.delete(sessionToken);
    }
    const changes = [{ field: "deleted", label: "ลบผู้ใช้งาน", before: target.email, after: "deleted" }];
    auditLogs.unshift(createAuditLog(auth.data.user, target, "delete_user", `ลบบัญชี ${target.email}`, changes));
    activityLogs.unshift(createActivityLog(auth.data.user, {
      action: "delete_user",
      moduleId: "users",
      targetEmail: target.email,
      details: `ลบบัญชี ${target.email}`
    }));
    return ok({ email: target.email }, "ลบผู้ใช้งานสำเร็จ");
  }

  function recordActivity(token, activity = {}) {
    const auth = getSession(token);
    if (!auth.ok) return auth;
    const log = createActivityLog(auth.data.user, activity);
    activityLogs.unshift(log);
    return ok(log);
  }

  function listAllUsers() {
    return [...users.values()].map((user) => ({ ...user }));
  }

  return {
    login,
    logout,
    getSession,
    requirePermission,
    listUsers,
    listActivity,
    createUser,
    updateUser,
    updateUserPermission,
    deleteUser,
    recordActivity,
    listAllUsers
  };
}

export function toPublicRoles(config) {
  return (config.auth?.roles || []).map((role) => ({
    id: role.id,
    label: role.label,
    modulePermissions: buildRoleModulePermissions(config, role.id),
    permissions: permissionsFromModulePermissions(config, buildRoleModulePermissions(config, role.id))
  }));
}

export function toPublicModules(config) {
  return (config.auth?.modules || []).map((module) => ({ ...module }));
}

function toPublicUser(user, config) {
  const role = findRole(config, user.roleId);
  const modulePermissions = user.modulePermissions
    ? normalizeModulePermissions(config, user.modulePermissions)
    : buildRoleModulePermissions(config, user.roleId);
  const roleLabel = user.roleId === "custom" && user.roleName ? user.roleName : role?.label ?? user.roleId;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    roleId: user.roleId,
    roleName: user.roleName ?? null,
    roleLabel,
    modulePermissions,
    permissions: permissionsFromModulePermissions(config, modulePermissions),
    employeeName: user.employeeName || employeeNameForId(config, user.employeeId),
    employeeId: user.employeeId,
    active: user.active
  };
}

function hasPermission(user, permission) {
  return user.permissions.includes(permission);
}

function findRole(config, roleId) {
  return (config.auth?.roles || []).find((role) => role.id === roleId);
}

function buildRoleModulePermissions(config, roleId) {
  const role = findRole(config, roleId);
  return normalizeModulePermissions(config, role?.modulePermissions ?? role?.permissions ?? []);
}

function normalizeModulePermissions(config, source = []) {
  const modules = config.auth?.modules || [];
  return modules.map((module) => {
    const sourcePermission = source.find((permission) => {
      return permission.moduleId === module.id || permission.moduleKey === module.id || permission === module.viewPermission;
    });
    const canEdit = Boolean(sourcePermission?.canEdit);
    const canView = Boolean(sourcePermission?.canView || canEdit || sourcePermission === module.viewPermission);
    return {
      moduleId: module.id,
      canView,
      canEdit: canView ? canEdit : false
    };
  });
}

function permissionsFromModulePermissions(config, modulePermissions) {
  const modules = config.auth?.modules || [];
  return [...new Set(modulePermissions.flatMap((permission) => {
    const module = modules.find((item) => item.id === permission.moduleId);
    if (!module) return [];
    const values = [];
    if (permission.canView && module.viewPermission) values.push(module.viewPermission);
    if (permission.canEdit && module.editPermission) values.push(module.editPermission);
    return values;
  }))];
}

function createAuditLog(actor, target, action, details, changes = []) {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    actorEmail: actor.email,
    actorName: actor.name,
    targetEmail: target.email,
    action,
    details,
    changes
  };
}

function createActivityLog(user, activity = {}) {
  return {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    userEmail: user.email,
    userName: user.name,
    roleLabel: user.roleLabel,
    moduleId: activity.moduleId || "system",
    action: activity.action || "activity",
    targetId: activity.targetId || "",
    targetEmail: normalizeLegacyEmail(activity.targetEmail || ""),
    details: String(activity.details || "").trim()
  };
}

function userSnapshot(user, config) {
  return [
    { field: "name", label: "ชื่อ", after: user.name },
    { field: "email", label: "อีเมล", after: user.email },
    { field: "role", label: "Role", after: user.roleLabel },
    { field: "employee", label: "พนักงาน", after: formatEmployee(user) },
    { field: "active", label: "สถานะ", after: user.active ? "Active" : "Disabled" },
    { field: "permissions", label: "สิทธิ์", after: summarizeModulePermissions(user.modulePermissions, config) }
  ];
}

function diffUsers(before, after, passwordChanged, config) {
  const changes = [];
  addChange(changes, "name", "ชื่อ", before.name, after.name);
  addChange(changes, "role", "Role", before.roleLabel, after.roleLabel);
  addChange(changes, "employee", "พนักงาน", formatEmployee(before), formatEmployee(after));
  addChange(changes, "active", "สถานะ", before.active ? "Active" : "Disabled", after.active ? "Active" : "Disabled");
  addChange(changes, "permissions", "สิทธิ์", summarizeModulePermissions(before.modulePermissions, config), summarizeModulePermissions(after.modulePermissions, config));
  if (passwordChanged) changes.push({ field: "password", label: "เปลี่ยนรหัสผ่าน", before: "ไม่แสดง", after: "เปลี่ยนแล้ว" });
  return changes;
}

function addChange(changes, field, label, before, after) {
  if (String(before) === String(after)) return;
  changes.push({ field, label, before, after });
}

function formatEmployee(user) {
  if (!user.employeeId && !user.employeeName) return "-";
  if (user.employeeName && user.employeeId) return `${user.employeeName} (${user.employeeId})`;
  return user.employeeName || user.employeeId;
}

function employeeNameForId(config, employeeId) {
  if (!employeeId) return "";
  return config.employees?.list?.find((employee) => employee.id === employeeId)?.name || "";
}

function summarizeModulePermissions(modulePermissions = [], config = {}) {
  return modulePermissions
    .filter((permission) => permission.canView)
    .map((permission) => {
      const module = (config.auth?.modules || []).find((item) => item.id === permission.moduleId);
      return `${module?.label || permission.moduleId} (${permission.canEdit ? "แก้ไข" : "ดู"})`;
    })
    .join(", ") || "ไม่มีสิทธิ์";
}

function ok(data, message = "") {
  return { ok: true, data, message };
}

function fail(code, message, data = null) {
  return { ok: false, code, message, data };
}
