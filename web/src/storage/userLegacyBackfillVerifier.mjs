const PLAN_OPERATION = Symbol.for("smartrecord.userLegacyBackfill.operation.v1");
const MESSAGES = Object.freeze({
  USERS_BACKFILL_PLAN_INVALID: "Legacy Users backfill plan is invalid.",
  USERS_BACKFILL_DATABASE_CHANGED: "Legacy Users backfill database changed.",
  USERS_BACKFILL_SCHEMA_REQUIRED: "Legacy Users backfill requires the approved SQLite schema.",
  USERS_BACKFILL_STORED_DATA_INVALID: "Stored Users data is invalid.",
  USERS_BACKFILL_INTERNAL_FAILED: "Legacy Users backfill failed safely."
});

export class UserLegacyBackfillVerificationError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : "USERS_BACKFILL_INTERNAL_FAILED";
    super(MESSAGES[safeCode]); this.name = "UserLegacyBackfillVerificationError"; this.code = safeCode;
    Object.defineProperty(this, "stack", { value: `${this.name}: ${MESSAGES[safeCode]}`, writable: false });
    Object.freeze(this);
  }
}

/**
 * Verify a legacy username plan in a read snapshot without mutating the database.
 * @param {object} database Open caller-owned SQLite handle; this function never closes it.
 * @param {object} plan Live plan returned by createUserLegacyBackfillPlan.
 * @returns {object} A deeply frozen, bounded, JSON-safe aggregate verification report.
 * @throws {UserLegacyBackfillVerificationError} A sanitized error with no stored values.
 */
export function verifyUserLegacyBackfill(database, plan) {
  try {
    const operation = plan?.[PLAN_OPERATION];
    if (typeof operation !== "function") throw new UserLegacyBackfillVerificationError("USERS_BACKFILL_PLAN_INVALID");
    return operation.call(plan, "verify", database);
  } catch (error) {
    if (error instanceof UserLegacyBackfillVerificationError) throw error;
    throw new UserLegacyBackfillVerificationError(error?.code);
  }
}
