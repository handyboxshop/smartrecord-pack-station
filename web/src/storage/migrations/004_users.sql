CREATE TABLE users (
  user_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (
    length(id) BETWEEN 5 AND 64
    AND instr(id, char(0)) = 0
    AND id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND id GLOB 'USR-*'
    AND substr(id, 5) NOT GLOB '*[^A-Z0-9-]*'
  ),
  email TEXT NOT NULL CHECK (
    length(email) BETWEEN 1 AND 320
    AND email = trim(email)
    AND instr(email, char(0)) = 0
    AND email NOT GLOB '*[^ -~]*'
  ),
  email_normalized TEXT GENERATED ALWAYS AS (lower(email)) STORED UNIQUE,
  name TEXT NOT NULL CHECK (
    length(trim(name)) BETWEEN 1 AND 200
    AND instr(name, char(0)) = 0
    AND name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  ),
  role_id TEXT NOT NULL CHECK (
    length(role_id) BETWEEN 1 AND 64
    AND instr(role_id, char(0)) = 0
    AND role_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  role_name TEXT NULL CHECK (role_name IS NULL OR (
    length(trim(role_name)) BETWEEN 1 AND 200
    AND instr(role_name, char(0)) = 0
    AND role_name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  )),
  employee_name TEXT NULL CHECK (employee_name IS NULL OR (
    length(trim(employee_name)) BETWEEN 1 AND 200
    AND instr(employee_name, char(0)) = 0
    AND employee_name NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  )),
  employee_id TEXT NULL CHECK (employee_id IS NULL OR (
    length(trim(employee_id)) BETWEEN 1 AND 128
    AND instr(employee_id, char(0)) = 0
    AND employee_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  )),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  password_salt TEXT NOT NULL CHECK (
    length(password_salt) BETWEEN 1 AND 512
    AND instr(password_salt, char(0)) = 0
    AND password_salt NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
  ),
  password_hash TEXT NOT NULL CHECK (
    length(password_hash) = 64
    AND instr(password_hash, char(0)) = 0
    AND password_hash = lower(password_hash)
    AND password_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL CHECK (
    length(created_at) = 24
    AND instr(created_at, char(0)) = 0
    AND created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND CAST(substr(created_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(created_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(created_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(created_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(created_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at
    AND date(substr(created_at, 1, 10), '+0 days') IS NOT NULL
    AND date(substr(created_at, 1, 10), '+0 days') = substr(created_at, 1, 10)
  ),
  updated_at TEXT NOT NULL CHECK (
    length(updated_at) = 24
    AND instr(updated_at, char(0)) = 0
    AND updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND CAST(substr(updated_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(updated_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(updated_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(updated_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(updated_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) = updated_at
    AND date(substr(updated_at, 1, 10), '+0 days') IS NOT NULL
    AND date(substr(updated_at, 1, 10), '+0 days') = substr(updated_at, 1, 10)
  ),
  deleted_at TEXT NULL CHECK (deleted_at IS NULL OR (
    length(deleted_at) = 24
    AND instr(deleted_at, char(0)) = 0
    AND deleted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND CAST(substr(deleted_at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(deleted_at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(deleted_at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(deleted_at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(deleted_at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', deleted_at) = deleted_at
    AND date(substr(deleted_at, 1, 10), '+0 days') IS NOT NULL
    AND date(substr(deleted_at, 1, 10), '+0 days') = substr(deleted_at, 1, 10)
  )),
  CHECK (
    (role_id = 'custom' AND role_name IS NOT NULL)
    OR (role_id <> 'custom' AND role_name IS NULL)
  ),
  CHECK (updated_at >= created_at),
  CHECK (deleted_at IS NULL OR active = 0),
  CHECK (deleted_at IS NULL OR (deleted_at >= created_at AND updated_at >= deleted_at))
) STRICT;

CREATE TABLE user_module_permissions (
  user_id TEXT NOT NULL CHECK (
    length(user_id) BETWEEN 5 AND 64
    AND instr(user_id, char(0)) = 0
    AND user_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND user_id GLOB 'USR-*'
    AND substr(user_id, 5) NOT GLOB '*[^A-Z0-9-]*'
  ),
  permission_sequence INTEGER NOT NULL CHECK (permission_sequence >= 0),
  module_id TEXT NOT NULL CHECK (
    length(module_id) BETWEEN 1 AND 64
    AND instr(module_id, char(0)) = 0
    AND module_id NOT GLOB '*[^A-Za-z0-9._-]*'
  ),
  can_view INTEGER NOT NULL CHECK (can_view IN (0, 1)),
  can_edit INTEGER NOT NULL CHECK (can_edit IN (0, 1)),
  PRIMARY KEY (user_id, module_id),
  UNIQUE (user_id, permission_sequence),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
  CHECK (can_edit = 0 OR can_view = 1)
) STRICT;

CREATE TABLE user_audit_logs (
  audit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL CHECK (
    event_code IN ('create_user', 'update_user', 'update_permission', 'delete_user')
  ),
  actor_user_id TEXT NOT NULL CHECK (
    length(actor_user_id) BETWEEN 5 AND 64
    AND instr(actor_user_id, char(0)) = 0
    AND actor_user_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND actor_user_id GLOB 'USR-*'
    AND substr(actor_user_id, 5) NOT GLOB '*[^A-Z0-9-]*'
  ),
  subject_user_id TEXT NOT NULL CHECK (
    length(subject_user_id) BETWEEN 5 AND 64
    AND instr(subject_user_id, char(0)) = 0
    AND subject_user_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND subject_user_id GLOB 'USR-*'
    AND substr(subject_user_id, 5) NOT GLOB '*[^A-Z0-9-]*'
  ),
  at TEXT NOT NULL CHECK (
    length(at) = 24
    AND instr(at, char(0)) = 0
    AND at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND CAST(substr(at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%fZ', at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', at) = at
    AND date(substr(at, 1, 10), '+0 days') IS NOT NULL
    AND date(substr(at, 1, 10), '+0 days') = substr(at, 1, 10)
  ),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE user_audit_log_fields (
  audit_sequence INTEGER NOT NULL,
  field_sequence INTEGER NOT NULL CHECK (field_sequence >= 0),
  field_name TEXT NOT NULL CHECK (
    instr(field_name, char(0)) = 0
    AND field_name IN ('name', 'email', 'role', 'employee', 'active', 'permissions', 'password', 'deleted')
  ),
  PRIMARY KEY (audit_sequence, field_name),
  UNIQUE (audit_sequence, field_sequence),
  FOREIGN KEY (audit_sequence) REFERENCES user_audit_logs(audit_sequence) ON DELETE RESTRICT
) STRICT;

CREATE TABLE user_activity_logs (
  activity_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_code TEXT NOT NULL CHECK (
    event_code IN (
      'login', 'logout', 'create_user', 'update_user', 'update_permission', 'delete_user',
      'storage_test', 'settings_prepack_image_update', 'pack_start', 'pack_scan',
      'pack_scan_rejected', 'pack_close_pass', 'pack_force_close', 'reports_view',
      'video_upload', 'connection_test', 'connection_save', 'orders_sync', 'orders_import',
      'orders_manual_create', 'orders_label_import', 'orders_manual_update',
      'orders_manual_delete', 'label_save'
    )
  ),
  actor_user_id TEXT NOT NULL CHECK (
    length(actor_user_id) BETWEEN 5 AND 64
    AND instr(actor_user_id, char(0)) = 0
    AND actor_user_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND actor_user_id GLOB 'USR-*'
    AND substr(actor_user_id, 5) NOT GLOB '*[^A-Z0-9-]*'
  ),
  subject_user_id TEXT NULL CHECK (subject_user_id IS NULL OR (
    length(subject_user_id) BETWEEN 5 AND 64
    AND instr(subject_user_id, char(0)) = 0
    AND subject_user_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || ']*')
    AND subject_user_id GLOB 'USR-*'
    AND substr(subject_user_id, 5) NOT GLOB '*[^A-Z0-9-]*'
  )),
  module_id TEXT NOT NULL CHECK (
    instr(module_id, char(0)) = 0
    AND module_id IN ('auth', 'users', 'settings', 'pack', 'reports', 'connect', 'labels')
  ),
  at TEXT NOT NULL CHECK (
    length(at) = 24
    AND instr(at, char(0)) = 0
    AND at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
    AND CAST(substr(at, 6, 2) AS INTEGER) BETWEEN 1 AND 12
    AND CAST(substr(at, 9, 2) AS INTEGER) BETWEEN 1 AND 31
    AND CAST(substr(at, 12, 2) AS INTEGER) BETWEEN 0 AND 23
    AND CAST(substr(at, 15, 2) AS INTEGER) BETWEEN 0 AND 59
    AND CAST(substr(at, 18, 2) AS INTEGER) BETWEEN 0 AND 59
    AND strftime('%Y-%m-%dT%H:%M:%fZ', at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', at) = at
    AND date(substr(at, 1, 10), '+0 days') IS NOT NULL
    AND date(substr(at, 1, 10), '+0 days') = substr(at, 1, 10)
  ),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
  FOREIGN KEY (subject_user_id) REFERENCES users(id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX user_audit_logs_actor_index
ON user_audit_logs (actor_user_id, audit_sequence DESC);

CREATE INDEX user_audit_logs_subject_index
ON user_audit_logs (subject_user_id, audit_sequence DESC);

CREATE INDEX user_activity_logs_actor_index
ON user_activity_logs (actor_user_id, activity_sequence DESC);

CREATE INDEX user_activity_logs_subject_index
ON user_activity_logs (subject_user_id, activity_sequence DESC);

CREATE TRIGGER users_prevent_physical_delete
BEFORE DELETE ON users
BEGIN
  SELECT RAISE(ABORT, 'users are soft-deleted');
END;

CREATE TRIGGER users_prevent_identity_update
BEFORE UPDATE OF id, email ON users
WHEN NEW.id <> OLD.id OR NEW.email <> OLD.email
BEGIN
  SELECT RAISE(ABORT, 'user identity is immutable');
END;

CREATE TRIGGER users_prevent_tombstone_mutation
BEFORE UPDATE ON users
WHEN OLD.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'user tombstones are immutable');
END;

CREATE TRIGGER user_module_permissions_prevent_tombstone_insert
BEFORE INSERT ON user_module_permissions
WHEN EXISTS (
  SELECT 1 FROM users WHERE id = NEW.user_id AND deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned user permissions are immutable');
END;

CREATE TRIGGER user_module_permissions_prevent_tombstone_update
BEFORE UPDATE ON user_module_permissions
WHEN EXISTS (
  SELECT 1 FROM users
  WHERE deleted_at IS NOT NULL AND id IN (OLD.user_id, NEW.user_id)
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned user permissions are immutable');
END;

CREATE TRIGGER user_module_permissions_prevent_tombstone_delete
BEFORE DELETE ON user_module_permissions
WHEN EXISTS (
  SELECT 1 FROM users WHERE id = OLD.user_id AND deleted_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned user permissions are immutable');
END;

CREATE TRIGGER user_audit_logs_prevent_update
BEFORE UPDATE ON user_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;

CREATE TRIGGER user_audit_logs_prevent_delete
BEFORE DELETE ON user_audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit logs are append-only');
END;

CREATE TRIGGER user_audit_log_fields_prevent_update
BEFORE UPDATE ON user_audit_log_fields
BEGIN
  SELECT RAISE(ABORT, 'audit log fields are append-only');
END;

CREATE TRIGGER user_audit_log_fields_prevent_delete
BEFORE DELETE ON user_audit_log_fields
BEGIN
  SELECT RAISE(ABORT, 'audit log fields are append-only');
END;

CREATE TRIGGER user_activity_logs_prevent_update
BEFORE UPDATE ON user_activity_logs
BEGIN
  SELECT RAISE(ABORT, 'activity logs are append-only');
END;

CREATE TRIGGER user_activity_logs_prevent_delete
BEFORE DELETE ON user_activity_logs
BEGIN
  SELECT RAISE(ABORT, 'activity logs are append-only');
END;
