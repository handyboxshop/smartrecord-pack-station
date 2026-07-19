export const INITIAL_OWNER_ROLE_ID = "owner";
export const INITIAL_OWNER_ROLE_NAME = null;

const MODULE_IDS = ["pack", "reports", "connect", "labels", "settings", "users"];

export const INITIAL_OWNER_MODULE_PERMISSIONS = Object.freeze(MODULE_IDS.map((moduleId) => Object.freeze({
  moduleId,
  canView: true,
  canEdit: true
})));

export function createInitialOwnerModulePermissions() {
  return INITIAL_OWNER_MODULE_PERMISSIONS.map((permission) => ({ ...permission }));
}
