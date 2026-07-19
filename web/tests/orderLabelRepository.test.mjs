import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  closeSqliteDatabase,
  openSqliteDatabase,
  runSqliteForeignKeyCheck,
  runSqliteQuickCheck
} from "../src/storage/sqliteDatabase.mjs";
import { runSqliteMigrations } from "../src/storage/migrate.mjs";
import {
  OrderLabelRepositoryError,
  createOrderLabelRepository
} from "../src/storage/orderLabelRepository.mjs";

const FIXED_TIME = "2026-07-16T08:00:00.000Z";

test("migration 003 applies after existing migrations and remains idempotent", async (t) => {
  const { database } = await migratedDatabase(t);
  const migrations = database.prepare(`
    SELECT version, name, checksum_sha256 FROM schema_migrations ORDER BY version
  `).all();

  assert.deepEqual(migrations.map((row) => [row.version, row.name]), [
    [1, "001_storage_foundation.sql"],
    [2, "002_pack_records.sql"],
    [3, "003_orders_labels.sql"],
    [4, "004_users.sql"],
    [5, "005_usernames.sql"]
  ]);
  assert.equal(migrations.every((migration) => /^[a-f0-9]{64}$/.test(migration.checksum_sha256)), true);
  assert.equal(database.prepare("PRAGMA user_version").get().user_version, 5);

  const repeated = await runSqliteMigrations(database, { now: fixedNow });
  assert.deepEqual(repeated, { applied: [], currentVersion: 5, latestSupportedVersion: 5 });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count, 5);

  const strictTables = new Map(database.prepare("PRAGMA table_list").all().map((row) => [row.name, row.strict]));
  assert.equal(strictTables.get("orders"), 1);
  assert.equal(strictTables.get("order_items"), 1);
  assert.equal(strictTables.get("labels"), 1);
  const repository = createOrderLabelRepository(database, { now: fixedNow });
  repository.createOrder(sampleOrder({ awb: "SPX-STRICT-1", orderNumber: "ORDER-STRICT-1" }));
  assert.throws(() => database.prepare(`
    INSERT INTO order_items (order_awb, line_index, sku, name, qty, barcode)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("SPX-STRICT-1", 1, "SKU", "Invalid type", "not-an-integer", "BAR"));
  assert.deepEqual(runSqliteQuickCheck(database), { ok: true, messages: ["ok"] });
  assert.deepEqual(runSqliteForeignKeyCheck(database), { ok: true, violations: [] });
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
});

test("migration 003 enforces relative paths through direct SQL", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectLabel(database, { id: "PATH-VALID-FILE", file_name: "label final.png" });
  insertDirectLabel(database, {
    id: "PATH-VALID-NESTED",
    relative_path: "local-nas/labels/2026-07/label final.png"
  });

  const invalidPaths = [
    "/absolute/label.png",
    "C:\\absolute\\label.png",
    "C:drive-relative.pdf",
    "\\\\server\\share\\label.png",
    "\\leading-backslash.png",
    "../label.png",
    "nested/../../label.png",
    "nested\\..\\label.png",
    ""
  ];
  invalidPaths.forEach((relativePath, index) => {
    assert.throws(
      () => insertDirectLabel(database, {
        id: `PATH-INVALID-${index}`,
        relative_path: relativePath
      }),
      /CHECK constraint failed/
    );
  });

  for (const [index, column] of [
    "file_name",
    "original_relative_path",
    "page_image_relative_path"
  ].entries()) {
    assert.throws(
      () => insertDirectLabel(database, {
        id: `PATH-INVALID-COLUMN-${index}`,
        [column]: "mixed\\..\\escape.png"
      }),
      /CHECK constraint failed/
    );
  }

  for (const column of [
    "label_file_name",
    "label_relative_path",
    "label_page_image_relative_path",
    "label_original_relative_path"
  ]) {
    assert.throws(
      () => insertDirectOrder(database, {
        awb: `ORDER-PATH-${column}`,
        awb_normalized: `ORDER-PATH-${column}`,
        label_file_name: "label.pdf",
        [column]: "mixed\\..\\escape.pdf"
      }),
      /CHECK constraint failed/
    );
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
});

test("migration 003 rejects unsafe content types through direct SQL", async (t) => {
  const { database } = await migratedDatabase(t);
  const accepted = [
    "application/pdf",
    "image/png",
    "application/octet-stream",
    "application/vnd.smartrecord.label+json",
    "application/problem+json",
    "application/x.smartrecord-v1",
    "image/svg+xml",
    "text/plain; charset=utf-8",
    "application/pdf; version=1.7",
    "x!#$%&'*+-.^_`|~/x!#$%&'*+-.^_`|~"
  ];
  accepted.forEach((contentType, index) => {
    insertDirectLabel(database, {
      id: `CONTENT-TYPE-VALID-LABEL-${index}`,
      content_type: contentType
    });
    insertDirectOrder(database, {
      awb: `CONTENT-TYPE-VALID-ORDER-${index}`,
      awb_normalized: `CONTENT-TYPE-VALID-ORDER-${index}`,
      label_file_name: "label.pdf",
      label_content_type: contentType
    });
  });

  const rejected = [
    "text@/plain",
    "text/pl?ain",
    "text:custom/plain",
    "text/plain/extra",
    "text/(plain)",
    "text\\plain",
    "text/=plain",
    "text/pla[in]",
    "data:image/png;base64,c2VjcmV0",
    "DATA:image/png;base64,c2VjcmV0",
    `application/${"x".repeat(300)}`,
    "text/plain\rpayload",
    "text/plain\npayload",
    "text/plain\0payload",
    "text/plain\tpayload",
    "text/plain\u001fpayload",
    "",
    "/plain",
    "text/",
    "text /plain",
    "text/ plain"
  ];
  rejected.forEach((contentType, index) => {
    assert.throws(
      () => insertDirectLabel(database, {
        id: `CONTENT-TYPE-INVALID-LABEL-${index}`,
        content_type: contentType
      }),
      /CHECK constraint failed/
    );
    assert.throws(
      () => insertDirectOrder(database, {
        awb: `CONTENT-TYPE-INVALID-ORDER-${index}`,
        awb_normalized: `CONTENT-TYPE-INVALID-ORDER-${index}`,
        label_file_name: "label.pdf",
        label_content_type: contentType
      }),
      /CHECK constraint failed/
    );
  });

  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM labels WHERE id GLOB 'CONTENT-TYPE-INVALID-LABEL-*'"
  ).get().count, 0);
  assert.equal(database.prepare(
    "SELECT COUNT(*) AS count FROM orders WHERE awb GLOB 'CONTENT-TYPE-INVALID-ORDER-*'"
  ).get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, accepted.length);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, accepted.length);
});

test("migration 003 enforces nullable Label AWB pairs through direct SQL", async (t) => {
  const { database } = await migratedDatabase(t);
  insertDirectLabel(database, { id: "AWB-PAIR-NULL", awb: null, awb_normalized: null });
  insertDirectLabel(database, { id: "AWB-PAIR-VALID", awb: "SPX-PAIR", awb_normalized: "SPX-PAIR" });

  for (const row of [
    { id: "AWB-PAIR-MISSING-NORMALIZED", awb: "SPX-MISSING", awb_normalized: null },
    { id: "AWB-PAIR-MISSING-ORIGINAL", awb: null, awb_normalized: "SPX-ORPHAN" },
    { id: "AWB-PAIR-EMPTY-NORMALIZED", awb: "SPX-EMPTY", awb_normalized: "" }
  ]) {
    assert.throws(() => insertDirectLabel(database, row), /CHECK constraint failed/);
  }
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 2);
});

test("orders and deterministic item order round-trip without losing contract fields", async (t) => {
  const { repository } = await repositoryFixture(t);
  const order = sampleOrder({
    awb: "  SPX-ROUNDTRIP-1  ",
    labelFile: {
      fileName: "label.pdf",
      relativePath: "local-nas/labels/2026-07/label.pdf",
      pageImageRelativePath: "local-nas/labels/2026-07/page-1.png",
      originalRelativePath: "local-nas/labels/2026-07/label.pdf",
      bytes: 4200,
      contentType: "application/pdf",
      importedAt: FIXED_TIME,
      page: 1,
      labelIndex: 1
    },
    reviewRequired: true,
    items: [
      { sku: "SKU-B", name: "Second", qty: 2, barcode: "BAR-B" },
      { sku: "SKU-A", name: "First", qty: 1, barcode: "BAR-A" }
    ]
  });

  const created = repository.createOrder(order);
  assert.equal(created.awb, "SPX-ROUNDTRIP-1");
  assert.equal(created.orderNumber, order.orderNumber);
  assert.equal(created.reviewRequired, true);
  assert.deepEqual(created.labelFile, order.labelFile);
  assert.deepEqual(created.items, order.items);
  assert.deepEqual(repository.getOrderByAwb(" SPX-ROUNDTRIP-1 "), created);
});

test("normalized duplicate AWBs preserve stable duplicate and conflict codes", async (t) => {
  const { repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-DUP-1", orderNumber: "ORDER-1" }));

  assertRepositoryCode(
    () => repository.createOrder(sampleOrder({ awb: " SPX-DUP-1 ", orderNumber: "ORDER-1" })),
    "ORDER_DUPLICATE_LABEL"
  );
  assertRepositoryCode(
    () => repository.createOrder(sampleOrder({ awb: "SPX-DUP-1", orderNumber: "ORDER-2" })),
    "ORDER_AWB_CONFLICT"
  );
});

test("the same order number can own multiple AWBs", async (t) => {
  const { repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-MULTI-1", orderNumber: "ORDER-MULTI" }));
  repository.createOrder(sampleOrder({ awb: "SPX-MULTI-2", orderNumber: "ORDER-MULTI" }));

  assert.deepEqual(repository.findAwbsByOrderNumber("ORDER-MULTI"), ["SPX-MULTI-1", "SPX-MULTI-2"]);
  assert.deepEqual(repository.listOrders().map((order) => order.awb), ["SPX-MULTI-2", "SPX-MULTI-1"]);
});

test("accepted order batches commit atomically and roll back completely on failure", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrders([
    sampleOrder({ awb: "SPX-BATCH-1", orderNumber: "ORDER-BATCH-1" }),
    sampleOrder({ awb: "SPX-BATCH-2", orderNumber: "ORDER-BATCH-2" })
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 2);

  assertRepositoryCode(
    () => repository.createOrders([
      sampleOrder({ awb: "SPX-BATCH-3", orderNumber: "ORDER-BATCH-3" }),
      sampleOrder({ awb: "SPX-BATCH-1", orderNumber: "ORDER-BATCH-CONFLICT" })
    ]),
    "ORDER_AWB_CONFLICT"
  );
  assert.equal(repository.getOrderByAwb("SPX-BATCH-3"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 2);
});

test("order updates replace items atomically and soft deletion keeps physical rows", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-UPDATE-1" }));
  const updated = repository.updateOrder("SPX-UPDATE-1", {
    buyer: "Updated buyer",
    items: [{ sku: "NEW", name: "Replacement", qty: 3, barcode: "NEW-BAR" }]
  });

  assert.equal(updated.buyer, "Updated buyer");
  assert.deepEqual(updated.items, [{ sku: "NEW", name: "Replacement", qty: 3, barcode: "NEW-BAR" }]);
  const deleted = repository.softDeleteOrder("SPX-UPDATE-1");
  assert.ok(deleted.deletedAt);
  assert.equal(repository.getOrderByAwb("SPX-UPDATE-1"), null);
  assert.equal(repository.getOrderByAwb("SPX-UPDATE-1", { includeDeleted: true }).awb, "SPX-UPDATE-1");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 1);
});

test("manual and imported label metadata round-trip without storing binary contents", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const manual = repository.createLabel(sampleManualLabel());
  const imported = repository.createLabel(sampleImportedLabel({ status: "manual-required" }));
  const ready = repository.createLabel(sampleImportedLabel({
    id: "LBL-READY",
    awb: "AWB-READY",
    printablePageKey: "AWB-READY|ORDER-READY|1|1",
    status: "ready"
  }));

  assert.equal(manual.source, null);
  assert.equal(manual.status, null);
  assert.equal(imported.status, "manual-required");
  assert.equal(imported.relativePath, "local-nas/labels/2026-07/page-1.png");
  assert.equal(ready.status, "ready");
  assert.equal(Object.hasOwn(manual, "imageDataUrl"), false);
  assert.equal(database.prepare("PRAGMA table_info(labels)").all().some((row) => row.name === "image_data_url"), false);
  assertRepositoryCode(
    () => repository.createLabel({ ...sampleManualLabel({ id: "LBL-BINARY" }), imageDataUrl: "data:image/png;base64,secret" }),
    "LABEL_BINARY_CONTENT_FORBIDDEN"
  );
  for (const relativePath of ["/private/customer/label.png", "C:\\customer\\label.png", "../customer/label.png"]) {
    assertRepositoryCode(
      () => repository.createLabel(sampleManualLabel({ id: `LBL-PATH-${relativePath.length}`, relativePath })),
      "LABEL_PATH_INVALID",
      { messageMustNotMatch: /private|customer|C:\\/ }
    );
  }
  assertRepositoryCode(
    () => repository.createOrder(sampleOrder({
      awb: "SPX-INVALID-LABEL-PATH",
      orderNumber: "ORDER-INVALID-LABEL-PATH",
      labelFile: { relativePath: "/private/customer/label.pdf" }
    })),
    "LABEL_PATH_INVALID",
    { messageMustNotMatch: /private|customer/ }
  );
});

test("order label-file metadata is allowlisted, scalar, and binary-free", async (t) => {
  const { repository } = await repositoryFixture(t);
  const rejected = [
    { imageDataUrl: "data:image/png;base64,secret" },
    { rawPayload: { customer: "secret" } },
    { sourcePayload: { source: "secret" } },
    { customer: { name: "secret" } },
    { base64: "c2VjcmV0" },
    { type: "Buffer", data: [1, 2, 3] }
  ];

  rejected.forEach((labelFile, index) => {
    assertRepositoryCode(
      () => repository.createOrder(sampleOrder({
        awb: `SPX-LABEL-FILE-INVALID-${index}`,
        orderNumber: `ORDER-LABEL-FILE-INVALID-${index}`,
        labelFile
      })),
      "ORDER_LABEL_FILE_INVALID"
    );
  });
  assertRepositoryCode(
    () => repository.createOrder(sampleOrder({
      awb: "SPX-LABEL-FILE-BUFFER",
      orderNumber: "ORDER-LABEL-FILE-BUFFER",
      labelFile: Buffer.from("secret")
    })),
    "ORDER_LABEL_FILE_INVALID"
  );
});

test("Orders and Labels reject unsafe content types without partial writes or disclosure", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const rejected = [
    "data:image/png;base64,c2VjcmV0",
    "DATA:image/png;base64,c2VjcmV0",
    `data:image/png;base64,${"A".repeat(5000)}`,
    "",
    "/plain",
    "text/",
    "text /plain",
    "text/ plain",
    "text/plain\r\nX-Injected: value",
    "text/plain\0payload",
    "text/plain\tpayload",
    "text/plain\u001fpayload",
    `application/${"x".repeat(300)}`,
    "text/plain; charset",
    "text/plain; charset=\"utf-8\"",
    "text/plain,payload"
  ];

  rejected.forEach((contentType, index) => {
    const orderAwb = `CONTENT-TYPE-ORDER-${index}`;
    const labelId = `CONTENT-TYPE-LABEL-${index}`;
    assertSanitizedRepositoryError(
      () => repository.createOrder(sampleOrder({
        awb: orderAwb,
        orderNumber: `CONTENT-TYPE-ORDER-NUMBER-${index}`,
        labelFile: { fileName: "label.pdf", contentType }
      })),
      "LABEL_CONTENT_TYPE_INVALID",
      contentType
    );
    assertSanitizedRepositoryError(
      () => repository.createLabel(sampleManualLabel({ id: labelId, contentType })),
      "LABEL_CONTENT_TYPE_INVALID",
      contentType
    );

    assert.equal(repository.getOrderByAwb(orderAwb), null);
    assert.equal(repository.getLabel(labelId), null);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 0);
  });
});

test("valid media types and unrelated safe metadata round-trip for Orders and Labels", async (t) => {
  const { repository } = await repositoryFixture(t);
  const accepted = [
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "text/plain",
    "application/octet-stream",
    "application/vnd.smartrecord.label+json",
    "application/problem+json",
    "application/x.smartrecord-v1",
    "image/svg+xml",
    "text/plain; charset=utf-8",
    "application/pdf; version=1.7",
    "x!#$%&'*+-.^_`|~/x!#$%&'*+-.^_`|~"
  ];

  accepted.forEach((contentType, index) => {
    const fileName = `c2VjcmV0 ใบปะหน้า final.v${index}.pdf`;
    const relativePath = `labels/2026/${fileName}`;
    const order = repository.createOrder(sampleOrder({
      awb: `CONTENT-TYPE-VALID-ORDER-${index}`,
      orderNumber: `CONTENT-TYPE-VALID-NUMBER-${index}`,
      labelFile: {
        fileName,
        relativePath,
        bytes: 4200,
        contentType,
        importedAt: FIXED_TIME,
        page: 1,
        labelIndex: 2
      }
    }));
    const label = repository.createLabel(sampleManualLabel({
      id: `CONTENT-TYPE-VALID-LABEL-${index}`,
      fileName,
      relativePath,
      contentType,
      page: 1,
      labelIndex: 2
    }));

    assert.deepEqual(order.labelFile, {
      fileName,
      relativePath,
      bytes: 4200,
      contentType,
      importedAt: FIXED_TIME,
      page: 1,
      labelIndex: 2
    });
    assert.equal(label.fileName, fileName);
    assert.equal(label.relativePath, relativePath);
    assert.equal(label.contentType, contentType);
    assert.equal(label.page, 1);
    assert.equal(label.labelIndex, 2);
  });
});

test("all compound and update write paths enforce the shared content-type boundary", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const rejectedContentType = "data:image/png;base64,WRITE_PATH_SECRET";
  const baselineOrder = repository.createOrder(sampleOrder({
    awb: "CONTENT-TYPE-BASELINE-ORDER",
    orderNumber: "CONTENT-TYPE-BASELINE-NUMBER",
    labelFile: { fileName: "baseline.pdf", contentType: "application/pdf" }
  }));
  const baselineLabel = repository.createLabel(sampleManualLabel({
    id: "CONTENT-TYPE-BASELINE-LABEL",
    contentType: "image/png"
  }));

  assertSanitizedRepositoryError(
    () => repository.updateOrder(baselineOrder.awb, {
      labelFile: { ...baselineOrder.labelFile, contentType: rejectedContentType }
    }),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assertSanitizedRepositoryError(
    () => repository.updateLabel(baselineLabel.id, { contentType: rejectedContentType }),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assert.deepEqual(repository.getOrderByAwb(baselineOrder.awb), baselineOrder);
  assert.deepEqual(repository.getLabel(baselineLabel.id), baselineLabel);

  assertSanitizedRepositoryError(
    () => repository.createOrders([
      sampleOrder({ awb: "CONTENT-TYPE-BATCH-FIRST", orderNumber: "CONTENT-TYPE-BATCH-FIRST" }),
      sampleOrder({
        awb: "CONTENT-TYPE-BATCH-SECOND",
        orderNumber: "CONTENT-TYPE-BATCH-SECOND",
        labelFile: { fileName: "batch.pdf", contentType: rejectedContentType }
      })
    ]),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assert.equal(repository.getOrderByAwb("CONTENT-TYPE-BATCH-FIRST"), null);
  assert.equal(repository.getOrderByAwb("CONTENT-TYPE-BATCH-SECOND"), null);

  assertSanitizedRepositoryError(
    () => repository.persistAcceptedSyncResults([
      sampleOrder({ awb: "CONTENT-TYPE-SYNC-FIRST", orderNumber: "CONTENT-TYPE-SYNC-FIRST" }),
      sampleOrder({
        awb: "CONTENT-TYPE-SYNC-SECOND",
        orderNumber: "CONTENT-TYPE-SYNC-SECOND",
        labelFile: { fileName: "sync.pdf", contentType: rejectedContentType }
      })
    ]),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assert.equal(repository.getOrderByAwb("CONTENT-TYPE-SYNC-FIRST"), null);
  assert.equal(repository.getOrderByAwb("CONTENT-TYPE-SYNC-SECOND"), null);

  assertSanitizedRepositoryError(
    () => repository.importAcceptedLabel({
      order: sampleOrder({
        awb: "CONTENT-TYPE-ACCEPTED-ORDER",
        orderNumber: "CONTENT-TYPE-ACCEPTED-NUMBER"
      }),
      label: sampleImportedLabel({
        id: "CONTENT-TYPE-ACCEPTED-LABEL",
        awb: "CONTENT-TYPE-ACCEPTED-ORDER",
        orderNumber: "CONTENT-TYPE-ACCEPTED-NUMBER",
        printablePageKey: "CONTENT-TYPE-ACCEPTED-ORDER|CONTENT-TYPE-ACCEPTED-NUMBER|1|1",
        contentType: rejectedContentType
      })
    }),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assert.equal(repository.getOrderByAwb("CONTENT-TYPE-ACCEPTED-ORDER"), null);
  assert.equal(repository.getLabel("CONTENT-TYPE-ACCEPTED-LABEL"), null);

  const idempotent = repository.createLabel(sampleImportedLabel({
    id: "CONTENT-TYPE-IDEMPOTENT-LABEL",
    awb: "CONTENT-TYPE-IDEMPOTENT-AWB",
    orderNumber: "CONTENT-TYPE-IDEMPOTENT-ORDER",
    printablePageKey: "CONTENT-TYPE-IDEMPOTENT-AWB|CONTENT-TYPE-IDEMPOTENT-ORDER|1|1"
  }));
  assertSanitizedRepositoryError(
    () => repository.importAcceptedLabel({
      label: sampleImportedLabel({
        id: "CONTENT-TYPE-IDEMPOTENT-RETRY",
        awb: idempotent.awb,
        orderNumber: idempotent.orderNumber,
        printablePageKey: idempotent.printablePageKey,
        contentType: rejectedContentType
      })
    }),
    "LABEL_CONTENT_TYPE_INVALID",
    rejectedContentType
  );
  assert.equal(repository.getLabel("CONTENT-TYPE-IDEMPOTENT-RETRY"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 2);
});

test("imported label retries are idempotent only for the same printable identity", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const order = sampleOrder({ awb: "SPX-LABEL-1", orderNumber: "ORDER-100" });
  const createdResult = repository.importAcceptedLabel({ order, label: sampleImportedLabel() });
  const repeatedResult = repository.importAcceptedLabel({
    order,
    label: sampleImportedLabel({ id: "LBL-IMPORTED-RETRY" })
  });
  const created = createdResult.label;
  const repeated = repeatedResult.label;

  assert.equal(createdResult.order.orderState, "created");
  assert.equal(repeatedResult.order.orderState, "already_exists");
  assert.equal(created.labelState, "created");
  assert.equal(repeated.labelState, "already_exists");
  assert.equal(repeated.id, created.id);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);

  assertRepositoryCode(
    () => repository.importAcceptedLabel({
      label: sampleImportedLabel({
        id: "LBL-IMPORTED-CONFLICT",
        awb: "SPX-DIFFERENT",
        printablePageKey: created.printablePageKey
      })
    }),
    "LABEL_PRINTABLE_IDENTITY_CONFLICT"
  );

  database.exec(`
    CREATE TRIGGER fail_unrelated_label_insert
    BEFORE INSERT ON labels
    WHEN NEW.id = 'LBL-UNRELATED-FAILURE'
    BEGIN
      SELECT RAISE(ABORT, 'unrelated constraint');
    END
  `);
  assertRepositoryCode(
    () => repository.importAcceptedLabel({
      label: sampleImportedLabel({
        id: "LBL-UNRELATED-FAILURE",
        awb: "SPX-UNRELATED",
        orderNumber: "ORDER-UNRELATED",
        printablePageKey: "SPX-UNRELATED|ORDER-UNRELATED|1|1"
      })
    }),
    "LABEL_CREATE_FAILED"
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
});

test("labels support optional order association and deterministic filters", async (t) => {
  const { repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-LABEL-ORDER" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-FIRST",
    orderAwb: "SPX-LABEL-ORDER",
    awb: "SPX-LABEL-ORDER",
    platform: "shopee",
    date: "2026-07-15",
    printablePageKey: "SPX-LABEL-ORDER|ORDER-100|1|1"
  }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-SECOND",
    awb: "SPX-UNASSOCIATED",
    platform: "lazada",
    date: "2026-07-16",
    printablePageKey: "SPX-UNASSOCIATED|ORDER-200|1|1"
  }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-SKIPPED",
    awb: "SPX-SKIPPED",
    status: "skipped",
    printablePageKey: "SPX-SKIPPED|ORDER-300|1|1"
  }));

  assert.deepEqual(repository.listLabels().map((label) => label.id), ["LBL-SECOND", "LBL-FIRST"]);
  assert.deepEqual(repository.listLabels({ platform: "SHOPEE" }).map((label) => label.id), ["LBL-FIRST"]);
  assert.deepEqual(repository.listLabels({ date: "2026-07-16" }).map((label) => label.id), ["LBL-SECOND"]);
  assert.equal(repository.getLabel("LBL-FIRST").orderAwb, "SPX-LABEL-ORDER");
  assert.equal(repository.getLabel("LBL-SECOND").orderAwb, null);
  assert.equal(repository.listLabels({ includeSkipped: true }).length, 3);
});

test("label soft deletion hides metadata without physical deletion", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createLabel(sampleManualLabel());
  const deleted = repository.softDeleteLabel("LBL-MANUAL");

  assert.ok(deleted.deletedAt);
  assert.equal(repository.getLabel("LBL-MANUAL"), null);
  assert.equal(repository.getLabel("LBL-MANUAL", { includeDeleted: true }).id, "LBL-MANUAL");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
});

test("order and related-label updates commit in one transaction", async (t) => {
  const { repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-CROSS-UPDATE" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-CROSS-UPDATE",
    orderAwb: "SPX-CROSS-UPDATE",
    awb: "SPX-CROSS-UPDATE",
    printablePageKey: "SPX-CROSS-UPDATE|ORDER-100|1|1"
  }));

  const result = repository.updateOrderAndLabels({
    awb: "SPX-CROSS-UPDATE",
    order: { buyer: "Updated cross-domain buyer" },
    labelUpdates: { customerName: "Updated cross-domain buyer", carrier: "Updated carrier" }
  });
  assert.equal(result.order.buyer, "Updated cross-domain buyer");
  assert.equal(result.labels[0].customerName, "Updated cross-domain buyer");
  assert.equal(result.labels[0].carrier, "Updated carrier");
});

test("a real SQLite failure rolls back both order and label updates", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-CROSS-ROLLBACK", buyer: "Original buyer" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-CROSS-ROLLBACK",
    orderAwb: "SPX-CROSS-ROLLBACK",
    awb: "SPX-CROSS-ROLLBACK",
    customerName: "Original customer",
    printablePageKey: "SPX-CROSS-ROLLBACK|ORDER-100|1|1"
  }));
  database.exec(`
    CREATE TRIGGER fail_cross_domain_label_update
    BEFORE UPDATE ON labels
    WHEN NEW.customer_name = 'blocked'
    BEGIN
      SELECT RAISE(ABORT, 'private customer payload and /absolute/path');
    END
  `);

  assertRepositoryCode(
    () => repository.updateOrderAndLabels({
      awb: "SPX-CROSS-ROLLBACK",
      order: { buyer: "Must roll back" },
      labelUpdates: { customerName: "blocked" }
    }),
    "ORDER_LABEL_UPDATE_FAILED",
    { messageMustNotMatch: /private|customer payload|absolute|path/i }
  );
  assert.equal(repository.getOrderByAwb("SPX-CROSS-ROLLBACK").buyer, "Original buyer");
  assert.equal(repository.getLabel("LBL-CROSS-ROLLBACK").customerName, "Original customer");
});

test("repository errors never expose raw database causes", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const secretMarker = "SECRET_CUSTOMER_MARKER_/absolute/private/path";
  repository.createOrder(sampleOrder({ awb: "SPX-PRIVATE-ERROR" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-PRIVATE-ERROR",
    orderAwb: "SPX-PRIVATE-ERROR",
    awb: "SPX-PRIVATE-ERROR",
    printablePageKey: "SPX-PRIVATE-ERROR|ORDER-100|1|1"
  }));
  database.exec(`
    CREATE TRIGGER fail_with_secret_marker
    BEFORE UPDATE ON labels
    BEGIN
      SELECT RAISE(ABORT, '${secretMarker}');
    END
  `);

  let caught;
  assert.throws(
    () => repository.updateOrderAndLabels({
      awb: "SPX-PRIVATE-ERROR",
      order: { buyer: "Must roll back" },
      labelUpdates: { customerName: "Must fail" }
    }),
    (error) => {
      caught = error;
      return error instanceof OrderLabelRepositoryError
        && error.code === "ORDER_LABEL_UPDATE_FAILED";
    }
  );

  const publicRepresentations = [
    caught.message,
    caught.stack,
    JSON.stringify(caught),
    inspect(caught, { depth: 10 })
  ];
  let cause = caught.cause;
  while (cause) {
    publicRepresentations.push(cause.message, cause.stack, inspect(cause, { depth: 10 }));
    cause = cause.cause;
  }
  publicRepresentations.forEach((value) => assert.doesNotMatch(String(value || ""), /SECRET_CUSTOMER_MARKER/));
  assert.equal(caught.cause, undefined);
  assert.equal(repository.getOrderByAwb("SPX-PRIVATE-ERROR").buyer, "Sample buyer");
});

test("order and associated labels are soft-deleted atomically", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-CROSS-DELETE" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-CROSS-DELETE",
    orderAwb: "SPX-CROSS-DELETE",
    awb: null,
    printablePageKey: "SPX-CROSS-DELETE|ORDER-100|1|1"
  }));

  const result = repository.softDeleteOrderAndLabels("SPX-CROSS-DELETE");
  assert.ok(result.order.deletedAt);
  assert.equal(result.labels.length, 1);
  assert.equal(repository.getOrderByAwb("SPX-CROSS-DELETE"), null);
  assert.equal(repository.getLabel("LBL-CROSS-DELETE"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
});

test("public softDeleteOrder is the authoritative atomic Order and Label deletion", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-PUBLIC-DELETE" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-PUBLIC-DELETE",
    orderAwb: "SPX-PUBLIC-DELETE",
    awb: "SPX-PUBLIC-DELETE",
    printablePageKey: "SPX-PUBLIC-DELETE|ORDER-100|1|1"
  }));

  const deleted = repository.softDeleteOrder("SPX-PUBLIC-DELETE");
  const deletedLabel = repository.getLabel("LBL-PUBLIC-DELETE", { includeDeleted: true });
  assert.ok(deleted.deletedAt);
  assert.equal(deletedLabel.deletedAt, deleted.deletedAt);
  assert.equal(repository.getOrderByAwb("SPX-PUBLIC-DELETE"), null);
  assert.equal(repository.getLabel("LBL-PUBLIC-DELETE"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
  assertRepositoryCode(() => repository.softDeleteOrder("SPX-PUBLIC-DELETE"), "ORDER_NOT_FOUND");
});

test("public softDeleteOrder rolls back when related Label deletion fails", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-PUBLIC-DELETE-ROLLBACK" }));
  repository.createLabel(sampleImportedLabel({
    id: "LBL-PUBLIC-DELETE-ROLLBACK",
    orderAwb: "SPX-PUBLIC-DELETE-ROLLBACK",
    awb: "SPX-PUBLIC-DELETE-ROLLBACK",
    printablePageKey: "SPX-PUBLIC-DELETE-ROLLBACK|ORDER-100|1|1"
  }));
  database.exec(`
    CREATE TRIGGER fail_related_label_delete
    BEFORE UPDATE OF deleted_at ON labels
    WHEN NEW.id = 'LBL-PUBLIC-DELETE-ROLLBACK'
    BEGIN
      SELECT RAISE(ABORT, 'must roll back');
    END
  `);

  assertRepositoryCode(
    () => repository.softDeleteOrder("SPX-PUBLIC-DELETE-ROLLBACK"),
    "ORDER_LABEL_DELETE_FAILED"
  );
  assert.equal(repository.getOrderByAwb("SPX-PUBLIC-DELETE-ROLLBACK").deletedAt, null);
  assert.equal(repository.getLabel("LBL-PUBLIC-DELETE-ROLLBACK").deletedAt, null);
});

test("soft-deleted identities cannot be reused", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createOrder(sampleOrder({ awb: "SPX-DELETED-IDENTITY", orderNumber: "ORDER-DELETED" }));
  repository.softDeleteOrder("SPX-DELETED-IDENTITY");
  assertRepositoryCode(
    () => repository.createOrder(sampleOrder({ awb: "SPX-DELETED-IDENTITY", orderNumber: "ORDER-DELETED" })),
    "ORDER_DUPLICATE_LABEL"
  );

  repository.createLabel(sampleImportedLabel({
    id: "LBL-DELETED-IDENTITY",
    awb: "SPX-LABEL-DELETED",
    printablePageKey: "SPX-LABEL-DELETED|ORDER-100|1|1"
  }));
  repository.softDeleteLabel("LBL-DELETED-IDENTITY");
  assertRepositoryCode(
    () => repository.createLabel(sampleImportedLabel({
      id: "LBL-DELETED-IDENTITY",
      awb: "SPX-NEW-ID",
      orderNumber: "ORDER-NEW-ID",
      printablePageKey: "SPX-NEW-ID|ORDER-NEW-ID|1|1"
    })),
    "LABEL_ID_CONFLICT"
  );
  assertRepositoryCode(
    () => repository.createLabel(sampleImportedLabel({
      id: "LBL-DELETED-PRINTABLE-RETRY",
      awb: "SPX-LABEL-DELETED",
      printablePageKey: "SPX-LABEL-DELETED|ORDER-100|1|1"
    })),
    "LABEL_PRINTABLE_IDENTITY_DELETED"
  );
  assertRepositoryCode(() => repository.softDeleteLabel("LBL-DELETED-IDENTITY"), "LABEL_NOT_FOUND");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
});

test("accepted label drafts persist order and label metadata atomically", async (t) => {
  const { repository } = await repositoryFixture(t);
  const result = repository.importAcceptedLabel({
    order: sampleOrder({
      awb: "SPX-DRAFT-1",
      orderNumber: "",
      status: "draft",
      source: "connect-import",
      draftCode: "ORDER_NUMBER_REQUIRED",
      draftMessage: "Review required",
      items: []
    }),
    label: sampleImportedLabel({
      id: "LBL-DRAFT-1",
      awb: "SPX-DRAFT-1",
      orderNumber: "",
      status: "manual-required",
      printablePageKey: "SPX-DRAFT-1||1|1"
    })
  });

  assert.equal(result.order.status, "draft");
  assert.equal(result.order.orderNumber, "");
  assert.deepEqual(result.order.items, []);
  assert.equal(result.order.draftCode, "ORDER_NUMBER_REQUIRED");
  assert.equal(result.label.orderAwb, "SPX-DRAFT-1");
});

test("blank order numbers remain rejected outside the exact accepted-draft contract", async (t) => {
  const { repository } = await repositoryFixture(t);
  for (const order of [
    sampleOrder({ awb: "SPX-BLANK-READY", orderNumber: "" }),
    sampleOrder({
      awb: "SPX-BLANK-DRAFT-WRONG-CODE",
      orderNumber: "",
      status: "draft",
      source: "connect-import",
      draftCode: "SKU_REQUIRED",
      items: []
    }),
    sampleOrder({
      awb: "SPX-BLANK-DRAFT-WRONG-SOURCE",
      orderNumber: "",
      status: "draft",
      source: "manual",
      draftCode: "ORDER_NUMBER_REQUIRED",
      items: []
    })
  ]) {
    assertRepositoryCode(() => repository.createOrder(order), "ORDER_NUMBER_REQUIRED");
  }
});

test("an accepted label failure rolls back its real blank-order-number draft", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  repository.createLabel(sampleManualLabel({ id: "LBL-ACCEPTED-CONFLICT" }));

  assertRepositoryCode(
    () => repository.importAcceptedLabel({
      order: sampleOrder({
        awb: "SPX-ACCEPTED-ROLLBACK",
        orderNumber: "",
        status: "draft",
        source: "connect-import",
        draftCode: "ORDER_NUMBER_REQUIRED",
        items: []
      }),
      label: sampleImportedLabel({
        id: "LBL-ACCEPTED-CONFLICT",
        awb: "SPX-ACCEPTED-ROLLBACK",
        orderNumber: "",
        printablePageKey: "SPX-ACCEPTED-ROLLBACK||1|1"
      })
    }),
    "LABEL_ID_CONFLICT"
  );
  assert.equal(repository.getOrderByAwb("SPX-ACCEPTED-ROLLBACK"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM labels").get().count, 1);
});

test("accepted sync results use business tables and do not persist transient connection state", async (t) => {
  const { database, repository } = await repositoryFixture(t);
  const stored = repository.persistAcceptedSyncResults([
    sampleOrder({ awb: "SPX-SYNC-1", orderNumber: "ORDER-SYNC-1", source: undefined }),
    sampleOrder({ awb: "SPX-SYNC-2", orderNumber: "ORDER-SYNC-2", source: undefined })
  ]);

  assert.deepEqual(stored.map((order) => order.source), ["sync", "sync"]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM orders").get().count, 2);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM order_items").get().count, 2);
  const tableNames = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  assert.equal(tableNames.some((name) => /sync|connection/i.test(name)), false);
});

async function migratedDatabase(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "smartrecord-orders-labels-"));
  const databasePath = path.join(directory, "repository.sqlite");
  const database = await openSqliteDatabase(databasePath);
  t.after(async () => {
    closeSqliteDatabase(database);
    await rm(directory, { recursive: true, force: true });
  });
  await runSqliteMigrations(database, { now: fixedNow });
  return { database, databasePath, directory };
}

async function repositoryFixture(t) {
  const fixture = await migratedDatabase(t);
  return {
    ...fixture,
    repository: createOrderLabelRepository(fixture.database, { now: fixedNow })
  };
}

function sampleOrder(overrides = {}) {
  return {
    awb: "SPX-ORDER-1",
    platform: "Shopee",
    buyer: "Sample buyer",
    orderNumber: "ORDER-100",
    carrier: "SPX",
    importedAt: FIXED_TIME,
    status: "ready",
    source: "manual",
    reviewRequired: false,
    labelFile: null,
    draftCode: null,
    draftMessage: null,
    items: [{ sku: "SKU-1", name: "Sample item", qty: 1, barcode: "SKU-1" }],
    ...overrides
  };
}

function sampleManualLabel(overrides = {}) {
  return {
    id: "LBL-MANUAL",
    platform: "shopee",
    date: "2026-07-16",
    fileName: "manual-label.png",
    sizeBytes: 1200,
    createdAt: FIXED_TIME,
    ...overrides
  };
}

function sampleImportedLabel(overrides = {}) {
  return {
    id: "LBL-IMPORTED",
    source: "connect-import",
    status: "imported",
    platform: "shopee",
    date: "2026-07-16",
    fileName: "shipping-label.pdf",
    relativePath: "local-nas/labels/2026-07/page-1.png",
    originalRelativePath: "local-nas/labels/2026-07/shipping-label.pdf",
    pageImageRelativePath: "local-nas/labels/2026-07/page-1.png",
    contentType: "image/png",
    awb: "SPX-LABEL-1",
    orderNumber: "ORDER-100",
    customerName: "Sample customer",
    carrier: "SPX",
    page: 1,
    labelIndex: 1,
    printablePageKey: "SPX-LABEL-1|ORDER-100|1|1",
    sizeBytes: 4200,
    createdAt: FIXED_TIME,
    ...overrides
  };
}

function insertDirectLabel(database, overrides = {}) {
  const label = {
    id: "DIRECT-LABEL",
    platform: "custom",
    date: "2026-07-16",
    file_name: "label.png",
    relative_path: null,
    original_relative_path: null,
    page_image_relative_path: null,
    awb: null,
    awb_normalized: null,
    size_bytes: 0,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    ...overrides
  };
  const columns = Object.keys(label);
  return database.prepare(`
    INSERT INTO labels (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => label[column]));
}

function insertDirectOrder(database, overrides = {}) {
  const order = {
    awb: "DIRECT-ORDER",
    awb_normalized: "DIRECT-ORDER",
    platform: "custom",
    buyer: "Direct buyer",
    order_number: "DIRECT-ORDER-NUMBER",
    carrier: "",
    imported_at: FIXED_TIME,
    status: "ready",
    source: "manual",
    review_required: 0,
    label_file_name: null,
    label_relative_path: null,
    label_page_image_relative_path: null,
    label_original_relative_path: null,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    ...overrides
  };
  const columns = Object.keys(order);
  return database.prepare(`
    INSERT INTO orders (${columns.join(", ")})
    VALUES (${columns.map(() => "?").join(", ")})
  `).run(...columns.map((column) => order[column]));
}

function fixedNow() {
  return new Date(FIXED_TIME);
}

function assertRepositoryCode(fn, code, { messageMustNotMatch = null } = {}) {
  let caught;
  assert.throws(fn, (error) => {
    caught = error;
    return error instanceof OrderLabelRepositoryError && error.code === code;
  });
  if (messageMustNotMatch) assert.doesNotMatch(caught.message, messageMustNotMatch);
}

function assertSanitizedRepositoryError(fn, code, rejectedValue) {
  let caught;
  assert.throws(fn, (error) => {
    caught = error;
    return error instanceof OrderLabelRepositoryError && error.code === code;
  });
  assert.equal(caught.message, "A valid bounded label content type is required.");
  assert.equal(caught.cause, undefined);

  const publicRepresentations = [
    caught.message,
    caught.stack,
    JSON.stringify(caught),
    inspect(caught, { depth: 10 })
  ];
  if (rejectedValue) {
    publicRepresentations.forEach((value) => {
      assert.equal(String(value || "").includes(rejectedValue), false);
    });
  }
}
