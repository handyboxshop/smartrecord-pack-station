ALTER TABLE main.users ADD COLUMN username TEXT NULL CHECK (
  username IS NULL OR (
    length(username) BETWEEN 3 AND 64
    AND username = trim(username)
    AND instr(username, char(0)) = 0
    AND username NOT GLOB '*[^A-Za-z0-9._-]*'
    AND substr(username, 1, 1) GLOB '[A-Za-z0-9]'
    AND substr(username, -1, 1) GLOB '[A-Za-z0-9]'
  )
);

ALTER TABLE main.users ADD COLUMN username_normalized TEXT
GENERATED ALWAYS AS (
  CASE WHEN username IS NULL THEN NULL ELSE lower(username) END
) VIRTUAL;

CREATE UNIQUE INDEX main.users_username_normalized_unique
ON users (username_normalized)
WHERE username_normalized IS NOT NULL;

CREATE TRIGGER main.users_require_username_on_insert
BEFORE INSERT ON users
WHEN NEW.username IS NULL
BEGIN
  SELECT RAISE(ABORT, 'username is required');
END;

CREATE TRIGGER main.users_prevent_username_change
BEFORE UPDATE OF username ON users
WHEN OLD.username IS NOT NULL AND NEW.username IS NOT OLD.username
BEGIN
  SELECT RAISE(ABORT, 'username is immutable');
END;

CREATE TRIGGER main.users_prevent_tombstone_username_assignment
BEFORE UPDATE OF username ON users
WHEN OLD.deleted_at IS NOT NULL AND NEW.username IS NOT OLD.username
BEGIN
  SELECT RAISE(ABORT, 'user tombstones are immutable');
END;

CREATE TRIGGER main.users_prevent_identity_collision_on_insert
BEFORE INSERT ON users
WHEN lower(NEW.username) = lower(NEW.email)
  OR EXISTS (
    SELECT 1 FROM main.users AS existing
    WHERE existing.email_normalized = lower(NEW.username)
       OR existing.username_normalized = lower(NEW.email)
  )
BEGIN
  SELECT RAISE(ABORT, 'user identity collision');
END;

CREATE TRIGGER main.users_prevent_identity_collision_on_username_assignment
BEFORE UPDATE OF username ON users
WHEN NEW.username IS NOT NULL AND NEW.username IS NOT OLD.username AND (
  lower(NEW.username) = OLD.email_normalized
  OR EXISTS (
    SELECT 1 FROM main.users AS existing
    WHERE existing.id <> OLD.id
      AND (
        existing.email_normalized = lower(NEW.username)
        OR existing.username_normalized = lower(NEW.username)
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'user identity collision');
END;

ALTER TABLE main.user_audit_log_fields RENAME TO user_audit_log_fields_v4;

CREATE TABLE main.user_audit_log_fields (
  audit_sequence INTEGER NOT NULL,
  field_sequence INTEGER NOT NULL CHECK (field_sequence >= 0),
  field_name TEXT NOT NULL CHECK (
    instr(field_name, char(0)) = 0
    AND field_name IN ('username', 'name', 'email', 'role', 'employee', 'active', 'permissions', 'password', 'deleted')
  ),
  PRIMARY KEY (audit_sequence, field_name),
  UNIQUE (audit_sequence, field_sequence),
  FOREIGN KEY (audit_sequence) REFERENCES user_audit_logs(audit_sequence) ON DELETE RESTRICT
) STRICT;

INSERT INTO main.user_audit_log_fields (audit_sequence, field_sequence, field_name)
SELECT audit_sequence, field_sequence, field_name
FROM main.user_audit_log_fields_v4
ORDER BY audit_sequence, field_sequence;

DROP TABLE main.user_audit_log_fields_v4;

CREATE TRIGGER main.user_audit_log_fields_prevent_update
BEFORE UPDATE ON user_audit_log_fields
BEGIN
  SELECT RAISE(ABORT, 'audit log fields are append-only');
END;

CREATE TRIGGER main.user_audit_log_fields_prevent_delete
BEFORE DELETE ON user_audit_log_fields
BEGIN
  SELECT RAISE(ABORT, 'audit log fields are append-only');
END;
