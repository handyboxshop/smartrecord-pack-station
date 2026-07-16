CREATE TABLE orders (
  order_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  awb TEXT NOT NULL UNIQUE,
  awb_normalized TEXT NOT NULL UNIQUE CHECK (length(awb_normalized) > 0),
  platform TEXT NOT NULL,
  buyer TEXT NOT NULL,
  order_number TEXT NOT NULL,
  carrier TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL,
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  label_file_name TEXT NULL CHECK (
    label_file_name IS NULL OR (
      length(trim(label_file_name)) > 0
      AND substr(trim(label_file_name), 1, 1) NOT IN ('/', char(92))
      AND trim(label_file_name) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(label_file_name), char(92), '/') || '/', '/../') = 0
    )
  ),
  label_relative_path TEXT NULL CHECK (
    label_relative_path IS NULL OR (
      length(trim(label_relative_path)) > 0
      AND substr(trim(label_relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(label_relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(label_relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  label_page_image_relative_path TEXT NULL CHECK (
    label_page_image_relative_path IS NULL OR (
      length(trim(label_page_image_relative_path)) > 0
      AND substr(trim(label_page_image_relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(label_page_image_relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(label_page_image_relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  label_original_relative_path TEXT NULL CHECK (
    label_original_relative_path IS NULL OR (
      length(trim(label_original_relative_path)) > 0
      AND substr(trim(label_original_relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(label_original_relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(label_original_relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  label_bytes INTEGER NULL CHECK (label_bytes IS NULL OR label_bytes >= 0),
  label_content_type TEXT NULL CHECK (
    label_content_type IS NULL OR (
      length(label_content_type) BETWEEN 1 AND 255
      AND label_content_type = trim(label_content_type)
      AND lower(label_content_type) NOT LIKE 'data:%'
      AND instr(label_content_type, ',') = 0
      AND instr(label_content_type, char(0)) = 0
      AND label_content_type NOT GLOB (
        '*[' || char(1) || '-' || char(31) || char(127) || ']*'
      )
      AND instr(label_content_type, '/') > 1
      AND instr(label_content_type, '/') < CASE
        WHEN instr(label_content_type, ';') > 0 THEN instr(label_content_type, ';') - 1
        ELSE length(label_content_type)
      END
      AND instr(substr(label_content_type, 1, instr(label_content_type, '/') - 1), ' ') = 0
      AND substr(label_content_type, 1, instr(label_content_type, '/') - 1)
        NOT GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~-]*'
      AND instr(substr(
        label_content_type,
        instr(label_content_type, '/') + 1,
        (CASE
          WHEN instr(label_content_type, ';') > 0 THEN instr(label_content_type, ';') - 1
          ELSE length(label_content_type)
        END) - instr(label_content_type, '/')
      ), ' ') = 0
      AND substr(
        label_content_type,
        instr(label_content_type, '/') + 1,
        (CASE
          WHEN instr(label_content_type, ';') > 0 THEN instr(label_content_type, ';') - 1
          ELSE length(label_content_type)
        END) - instr(label_content_type, '/')
      ) NOT GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~-]*'
      AND instr(substr(
        label_content_type,
        instr(label_content_type, '/') + 1,
        (CASE
          WHEN instr(label_content_type, ';') > 0 THEN instr(label_content_type, ';') - 1
          ELSE length(label_content_type)
        END) - instr(label_content_type, '/')
      ), '/') = 0
    )
  ),
  label_imported_at TEXT NULL,
  label_page INTEGER NULL CHECK (label_page IS NULL OR label_page > 0),
  label_index INTEGER NULL CHECK (label_index IS NULL OR label_index > 0),
  draft_code TEXT NULL,
  draft_message TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  CHECK (
    label_file_name IS NOT NULL OR (
      label_relative_path IS NULL
      AND label_page_image_relative_path IS NULL
      AND label_original_relative_path IS NULL
      AND label_bytes IS NULL
      AND label_content_type IS NULL
      AND label_imported_at IS NULL
      AND label_page IS NULL
      AND label_index IS NULL
    )
  )
) STRICT;

CREATE INDEX orders_order_number_active_index
ON orders (order_number, order_sequence)
WHERE deleted_at IS NULL;

CREATE TABLE order_items (
  order_awb TEXT NOT NULL,
  line_index INTEGER NOT NULL CHECK (line_index >= 0),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INTEGER NOT NULL CHECK (qty >= 1 AND qty <= 999),
  barcode TEXT NOT NULL,
  PRIMARY KEY (order_awb, line_index),
  FOREIGN KEY (order_awb) REFERENCES orders(awb) ON DELETE RESTRICT
) STRICT;

CREATE TABLE labels (
  label_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  order_awb TEXT NULL,
  source TEXT NULL,
  status TEXT NULL,
  platform TEXT NOT NULL,
  date TEXT NOT NULL,
  file_name TEXT NOT NULL CHECK (
    length(trim(file_name)) > 0
    AND substr(trim(file_name), 1, 1) NOT IN ('/', char(92))
    AND trim(file_name) NOT GLOB '[A-Za-z]:*'
    AND instr('/' || replace(trim(file_name), char(92), '/') || '/', '/../') = 0
  ),
  relative_path TEXT NULL CHECK (
    relative_path IS NULL OR (
      length(trim(relative_path)) > 0
      AND substr(trim(relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  original_relative_path TEXT NULL CHECK (
    original_relative_path IS NULL OR (
      length(trim(original_relative_path)) > 0
      AND substr(trim(original_relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(original_relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(original_relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  page_image_relative_path TEXT NULL CHECK (
    page_image_relative_path IS NULL OR (
      length(trim(page_image_relative_path)) > 0
      AND substr(trim(page_image_relative_path), 1, 1) NOT IN ('/', char(92))
      AND trim(page_image_relative_path) NOT GLOB '[A-Za-z]:*'
      AND instr('/' || replace(trim(page_image_relative_path), char(92), '/') || '/', '/../') = 0
    )
  ),
  content_type TEXT NULL CHECK (
    content_type IS NULL OR (
      length(content_type) BETWEEN 1 AND 255
      AND content_type = trim(content_type)
      AND lower(content_type) NOT LIKE 'data:%'
      AND instr(content_type, ',') = 0
      AND instr(content_type, char(0)) = 0
      AND content_type NOT GLOB (
        '*[' || char(1) || '-' || char(31) || char(127) || ']*'
      )
      AND instr(content_type, '/') > 1
      AND instr(content_type, '/') < CASE
        WHEN instr(content_type, ';') > 0 THEN instr(content_type, ';') - 1
        ELSE length(content_type)
      END
      AND instr(substr(content_type, 1, instr(content_type, '/') - 1), ' ') = 0
      AND substr(content_type, 1, instr(content_type, '/') - 1)
        NOT GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~-]*'
      AND instr(substr(
        content_type,
        instr(content_type, '/') + 1,
        (CASE
          WHEN instr(content_type, ';') > 0 THEN instr(content_type, ';') - 1
          ELSE length(content_type)
        END) - instr(content_type, '/')
      ), ' ') = 0
      AND substr(
        content_type,
        instr(content_type, '/') + 1,
        (CASE
          WHEN instr(content_type, ';') > 0 THEN instr(content_type, ';') - 1
          ELSE length(content_type)
        END) - instr(content_type, '/')
      ) NOT GLOB '*[^A-Za-z0-9!#$%&''*+.^_`|~-]*'
      AND instr(substr(
        content_type,
        instr(content_type, '/') + 1,
        (CASE
          WHEN instr(content_type, ';') > 0 THEN instr(content_type, ';') - 1
          ELSE length(content_type)
        END) - instr(content_type, '/')
      ), '/') = 0
    )
  ),
  awb TEXT NULL,
  awb_normalized TEXT NULL,
  order_number TEXT NULL,
  customer_name TEXT NULL,
  carrier TEXT NULL,
  page INTEGER NULL CHECK (page IS NULL OR page > 0),
  label_index INTEGER NULL CHECK (label_index IS NULL OR label_index > 0),
  printable_page_key TEXT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NULL,
  FOREIGN KEY (order_awb) REFERENCES orders(awb) ON DELETE RESTRICT,
  CHECK (
    (awb IS NULL AND awb_normalized IS NULL)
    OR (
      awb IS NOT NULL
      AND awb_normalized IS NOT NULL
      AND length(trim(awb_normalized)) > 0
    )
  )
) STRICT;

CREATE INDEX labels_active_listing_index
ON labels (label_sequence DESC)
WHERE deleted_at IS NULL;

CREATE INDEX labels_awb_active_index
ON labels (awb_normalized, label_sequence)
WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX labels_connect_printable_page_active_unique
ON labels (printable_page_key)
WHERE source = 'connect-import'
  AND printable_page_key IS NOT NULL
  AND deleted_at IS NULL;
