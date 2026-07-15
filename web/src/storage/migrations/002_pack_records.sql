CREATE TABLE pack_records (
  id TEXT PRIMARY KEY,
  record_sequence INTEGER NOT NULL UNIQUE CHECK (record_sequence >= 0),
  awb TEXT NOT NULL,
  awb_normalized TEXT NOT NULL CHECK (length(awb_normalized) > 0),
  platform TEXT NULL,
  employee_id TEXT NULL,
  station_id TEXT NULL,
  started_at TEXT NULL,
  ended_at TEXT NULL,
  duration_seconds INTEGER NULL CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  status TEXT NOT NULL CHECK (status IN ('pass', 'warn')),
  item_summary TEXT NULL,
  size_mb REAL NULL CHECK (size_mb IS NULL OR size_mb >= 0),
  storage_target_id TEXT NULL,
  storage_label TEXT NULL,
  storage_provider TEXT NULL,
  storage_host TEXT NULL,
  share_link TEXT NULL,
  force_close_reason TEXT NULL,
  source_payload_json TEXT NULL CHECK (source_payload_json IS NULL OR json_valid(source_payload_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX pack_records_awb_normalized_unique
ON pack_records (awb_normalized);

CREATE TABLE pack_record_videos (
  record_id TEXT PRIMARY KEY,
  file_name TEXT NULL,
  relative_path TEXT NULL,
  bytes INTEGER NULL CHECK (bytes IS NULL OR bytes >= 0),
  size_mb REAL NULL CHECK (size_mb IS NULL OR size_mb >= 0),
  content_type TEXT NULL,
  storage_target_id TEXT NULL,
  storage_label TEXT NULL,
  storage_host TEXT NULL,
  storage_mode TEXT NULL,
  mounted_required INTEGER NULL CHECK (mounted_required IS NULL OR mounted_required IN (0, 1)),
  simulated INTEGER NULL CHECK (simulated IS NULL OR simulated IN (0, 1)),
  external_url TEXT NULL,
  custom_path TEXT NULL,
  share_link TEXT NULL,
  saved_at TEXT NULL,
  FOREIGN KEY (record_id) REFERENCES pack_records(id) ON DELETE CASCADE
);
