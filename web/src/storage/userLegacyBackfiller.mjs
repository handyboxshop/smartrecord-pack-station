const PLAN_OPERATION = Symbol.for("smartrecord.userLegacyBackfill.operation.v1");
const MESSAGES = Object.freeze({
  USERS_BACKFILL_PLAN_INVALID: "Legacy Users backfill plan is invalid.",
  USERS_BACKFILL_DATABASE_CHANGED: "Legacy Users backfill database changed.",
  USERS_BACKFILL_TRANSACTION_FAILED: "Legacy Users backfill transaction failed safely.",
  USERS_BACKFILL_ROLLBACK_FAILED: "Legacy Users backfill rollback failed; inspect the database before retrying.",
  USERS_BACKFILL_COMMIT_OUTCOME_UNKNOWN: "Legacy Users backfill commit outcome is unknown; verify before retrying.",
  USERS_BACKFILL_SCHEMA_REQUIRED: "Legacy Users backfill requires the approved SQLite schema.",
  USERS_BACKFILL_STORED_DATA_INVALID: "Stored Users data is invalid.",
  USERS_BACKFILL_INTERNAL_FAILED: "Legacy Users backfill failed safely."
});

export class UserLegacyBackfillError extends Error {
  constructor(code, transactionState = "not-started") {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : "USERS_BACKFILL_INTERNAL_FAILED";
    super(MESSAGES[safeCode]); this.name = "UserLegacyBackfillError"; this.code = safeCode;
    Object.defineProperties(this, { stack: { value: `${this.name}: ${MESSAGES[safeCode]}`, writable: false }, transactionState: { value: transactionState, enumerable: false, writable: false } });
    Object.freeze(this);
  }
}

/**
 * Backfill approved legacy usernames with one BEGIN IMMEDIATE transaction and CAS updates.
 * @param {object} database Open caller-owned SQLite handle; this function never closes it.
 * @param {object} plan Live plan returned by createUserLegacyBackfillPlan.
 * @returns {object} A deeply frozen, bounded, JSON-safe committed/already-complete aggregate.
 * @throws {UserLegacyBackfillError} A sanitized error describing safe transaction state only.
 */
export function backfillLegacyUsernames(database, plan) {
  try {
    const operation = plan?.[PLAN_OPERATION];
    if (typeof operation !== "function") throw new UserLegacyBackfillError("USERS_BACKFILL_PLAN_INVALID");
    return operation.call(plan, "backfill", database);
  } catch (error) {
    if (error instanceof UserLegacyBackfillError) throw error;
    throw new UserLegacyBackfillError(error?.code, error?.transactionState);
  }
}
