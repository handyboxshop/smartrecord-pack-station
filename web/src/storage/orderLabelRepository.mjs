import {
  SqliteStorageError,
  runInSqliteTransaction
} from "./sqliteDatabase.mjs";
import path from "node:path";

const MINIMUM_SCHEMA_VERSION = 3;
const LABEL_FILE_FIELDS = new Set([
  "fileName",
  "relativePath",
  "pageImageRelativePath",
  "originalRelativePath",
  "bytes",
  "contentType",
  "importedAt",
  "page",
  "labelIndex"
]);
const MAX_FILE_NAME_LENGTH = 255;
const MAX_RELATIVE_PATH_LENGTH = 2048;
const MAX_CONTENT_TYPE_LENGTH = 255;
const MEDIA_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:; *[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/;

export class OrderLabelRepositoryError extends SqliteStorageError {
  constructor(code, message) {
    super(code, message);
    this.name = "OrderLabelRepositoryError";
  }
}

export function createOrderLabelRepository(database, { now = () => new Date() } = {}) {
  validateDatabase(database);
  validateSchema(database);

  const statements = prepareStatements(database);

  function createOrder(order) {
    return inRepositoryTransaction(database, "ORDER_CREATE_FAILED", () => {
      return createOrderWithinTransaction(order);
    });
  }

  function createOrders(orders) {
    if (!Array.isArray(orders)) {
      throw repositoryError("ORDER_BATCH_INVALID", "An order array is required.");
    }
    return inRepositoryTransaction(database, "ORDER_BATCH_CREATE_FAILED", () => {
      return orders.map((order) => createOrderWithinTransaction(order));
    });
  }

  function getOrderByAwb(awb, { includeDeleted = false } = {}) {
    const normalizedAwb = normalizeAwb(awb);
    if (!normalizedAwb) return null;
    const row = includeDeleted
      ? statements.selectOrderIncludingDeleted.get(normalizedAwb)
      : statements.selectActiveOrder.get(normalizedAwb);
    return row ? hydrateOrder(row) : null;
  }

  function findAwbsByOrderNumber(orderNumber, { includeDeleted = false } = {}) {
    const cleanOrderNumber = cleanText(orderNumber);
    if (!cleanOrderNumber) return [];
    const rows = includeDeleted
      ? statements.selectAwbsByOrderNumberIncludingDeleted.all(cleanOrderNumber)
      : statements.selectActiveAwbsByOrderNumber.all(cleanOrderNumber);
    return rows.map((row) => row.awb);
  }

  function listOrders({ includeDeleted = false } = {}) {
    const rows = includeDeleted
      ? statements.selectOrdersIncludingDeleted.all()
      : statements.selectActiveOrders.all();
    return rows.map(hydrateOrder);
  }

  function updateOrder(awb, order) {
    return inRepositoryTransaction(database, "ORDER_UPDATE_FAILED", () => {
      return updateOrderWithinTransaction(awb, order);
    });
  }

  function softDeleteOrder(awb) {
    return softDeleteOrderAndLabels(awb).order;
  }

  function createLabel(label) {
    return inRepositoryTransaction(database, "LABEL_CREATE_FAILED", () => {
      return createLabelWithinTransaction(label);
    });
  }

  function getLabel(id, { includeDeleted = false } = {}) {
    const cleanId = requiredText(id, "LABEL_ID_REQUIRED", "A label id is required.");
    const row = includeDeleted
      ? statements.selectLabelIncludingDeleted.get(cleanId)
      : statements.selectActiveLabel.get(cleanId);
    return row ? mapLabel(row) : null;
  }

  function listLabels({ date = "", platform = "", includeDeleted = false, includeSkipped = false } = {}) {
    const filters = {
      date: cleanText(date),
      platform: cleanText(platform).toLowerCase(),
      includeDeleted: includeDeleted ? 1 : 0,
      includeSkipped: includeSkipped ? 1 : 0
    };
    return statements.selectLabels.all(filters).map(mapLabel);
  }

  function updateLabel(id, updates) {
    return inRepositoryTransaction(database, "LABEL_UPDATE_FAILED", () => {
      return updateLabelWithinTransaction(id, updates);
    });
  }

  function softDeleteLabel(id) {
    return inRepositoryTransaction(database, "LABEL_DELETE_FAILED", () => {
      const label = requireActiveLabel(id);
      const deletedAt = timestamp();
      statements.softDeleteLabel.run(deletedAt, deletedAt, label.id);
      return getLabel(label.id, { includeDeleted: true });
    });
  }

  function updateOrderAndLabels({ awb, order, labelUpdates = {} } = {}) {
    return inRepositoryTransaction(database, "ORDER_LABEL_UPDATE_FAILED", () => {
      const updatedOrder = updateOrderWithinTransaction(awb, order);
      const updatedLabels = updateLabelsForAwbWithinTransaction(updatedOrder.awb, labelUpdates);
      return { order: updatedOrder, labels: updatedLabels };
    });
  }

  function softDeleteOrderAndLabels(awb) {
    return inRepositoryTransaction(database, "ORDER_LABEL_DELETE_FAILED", () => {
      const order = softDeleteOrderWithinTransaction(awb);
      const deletedAt = order.deletedAt;
      statements.softDeleteLabelsByAwb.run(deletedAt, deletedAt, normalizeAwb(order.awb), order.awb);
      return {
        order,
        labels: statements.selectDeletedLabelsByAwb.all(
          normalizeAwb(order.awb),
          order.awb,
          deletedAt
        ).map(mapLabel)
      };
    });
  }

  function importAcceptedLabel({ order = null, label } = {}) {
    return inRepositoryTransaction(database, "ACCEPTED_LABEL_IMPORT_FAILED", () => {
      const storedOrder = order ? resolveAcceptedLabelOrder(order) : null;
      const storedLabel = createLabelWithinTransaction({
        ...label,
        orderAwb: label?.orderAwb ?? storedOrder?.awb ?? null
      });
      return { order: storedOrder, label: storedLabel };
    });
  }

  function resolveAcceptedLabelOrder(input) {
    const candidate = normalizeOrderInput(input);
    const existing = getOrderByAwb(candidate.awb);
    if (existing) {
      if (cleanText(existing.orderNumber) === candidate.orderNumber) {
        return { ...existing, orderState: "already_exists" };
      }
      throw repositoryError(
        "ORDER_AWB_CONFLICT",
        "The AWB already belongs to a different order number."
      );
    }
    const created = createOrderWithinTransaction(input);
    return { ...created, orderState: "created" };
  }

  function persistAcceptedSyncResults(orders) {
    if (!Array.isArray(orders)) {
      throw repositoryError("ACCEPTED_SYNC_RESULTS_INVALID", "An accepted sync result array is required.");
    }
    return inRepositoryTransaction(database, "ACCEPTED_SYNC_RESULTS_FAILED", () => {
      return orders.map((order) => createOrderWithinTransaction({ ...order, source: order?.source || "sync" }));
    });
  }

  function createOrderWithinTransaction(input) {
    const order = normalizeOrderInput(input);
    assertOrderIdentityAvailable(order.awb, order.orderNumber);
    const createdAt = timestamp(input?.createdAt || order.importedAt);
    const updatedAt = timestamp(input?.updatedAt || createdAt);

    try {
      statements.insertOrder.run(
        order.awb,
        order.awbNormalized,
        order.platform,
        order.buyer,
        order.orderNumber,
        order.carrier,
        order.importedAt,
        order.status,
        order.source,
        order.reviewRequired ? 1 : 0,
        order.labelFile?.fileName ?? null,
        order.labelFile?.relativePath ?? null,
        order.labelFile?.pageImageRelativePath ?? null,
        order.labelFile?.originalRelativePath ?? null,
        order.labelFile?.bytes ?? null,
        order.labelFile?.contentType ?? null,
        order.labelFile?.importedAt ?? null,
        order.labelFile?.page ?? null,
        order.labelFile?.labelIndex ?? null,
        order.draftCode,
        order.draftMessage,
        createdAt,
        updatedAt
      );
      insertItems(order.awb, order.items);
    } catch (cause) {
      if (cause instanceof OrderLabelRepositoryError) throw cause;
      throw repositoryError("ORDER_CREATE_FAILED", "The order could not be stored.", cause);
    }
    return getOrderByAwb(order.awb);
  }

  function updateOrderWithinTransaction(awb, input) {
    const existing = requireActiveOrder(awb);
    const order = normalizeOrderInput({ ...existing, ...input, awb: existing.awb });
    const updatedAt = timestamp(input?.updatedAt);
    statements.updateOrder.run(
      order.platform,
      order.buyer,
      order.orderNumber,
      order.carrier,
      order.importedAt,
      order.status,
      order.source,
      order.reviewRequired ? 1 : 0,
      order.labelFile?.fileName ?? null,
      order.labelFile?.relativePath ?? null,
      order.labelFile?.pageImageRelativePath ?? null,
      order.labelFile?.originalRelativePath ?? null,
      order.labelFile?.bytes ?? null,
      order.labelFile?.contentType ?? null,
      order.labelFile?.importedAt ?? null,
      order.labelFile?.page ?? null,
      order.labelFile?.labelIndex ?? null,
      order.draftCode,
      order.draftMessage,
      updatedAt,
      existing.awb
    );
    statements.deleteOrderItems.run(existing.awb);
    insertItems(existing.awb, order.items);
    return getOrderByAwb(existing.awb);
  }

  function softDeleteOrderWithinTransaction(awb) {
    const order = requireActiveOrder(awb);
    const deletedAt = timestamp();
    statements.softDeleteOrder.run(deletedAt, deletedAt, order.awb);
    return getOrderByAwb(order.awb, { includeDeleted: true });
  }

  function createLabelWithinTransaction(input) {
    const label = normalizeLabelInput(input);
    const idempotentLabel = findIdempotentImportedLabel(label);
    if (idempotentLabel) return idempotentLabel;
    if (statements.selectLabelIncludingDeleted.get(label.id)) {
      throw repositoryError("LABEL_ID_CONFLICT", "The label id already exists.");
    }
    const orderAwb = resolveOptionalOrderAssociation(label.orderAwb);
    const createdAt = timestamp(label.createdAt);
    const updatedAt = timestamp(input?.updatedAt || createdAt);
    try {
      statements.insertLabel.run(
        label.id,
        orderAwb,
        label.source,
        label.status,
        label.platform,
        label.date,
        label.fileName,
        label.relativePath,
        label.originalRelativePath,
        label.pageImageRelativePath,
        label.contentType,
        label.awb,
        label.awb ? normalizeAwb(label.awb) : null,
        label.orderNumber,
        label.customerName,
        label.carrier,
        label.page,
        label.labelIndex,
        label.printablePageKey,
        label.sizeBytes,
        createdAt,
        updatedAt
      );
    } catch (cause) {
      throw repositoryError("LABEL_CREATE_FAILED", "The label metadata could not be stored.", cause);
    }
    const stored = getLabel(label.id);
    return label.source === "connect-import"
      ? { ...stored, labelState: "created" }
      : stored;
  }

  function findIdempotentImportedLabel(label) {
    if (label.source !== "connect-import") return null;
    if (!label.printablePageKey) {
      throw repositoryError(
        "LABEL_PRINTABLE_PAGE_KEY_REQUIRED",
        "An imported label printable-page key is required."
      );
    }

    const active = statements.selectActiveLabelByPrintablePageKey.get(label.printablePageKey);
    if (active) {
      if (!samePrintableIdentity(active, label)) {
        throw repositoryError(
          "LABEL_PRINTABLE_IDENTITY_CONFLICT",
          "The printable-page key belongs to a different label identity."
        );
      }
      return { ...mapLabel(active), labelState: "already_exists" };
    }

    if (statements.selectDeletedLabelByPrintablePageKey.get(label.printablePageKey)) {
      throw repositoryError(
        "LABEL_PRINTABLE_IDENTITY_DELETED",
        "The printable-page identity belongs to a deleted label."
      );
    }
    return null;
  }

  function updateLabelWithinTransaction(id, updates = {}) {
    const existing = requireActiveLabel(id);
    const next = normalizeLabelInput({ ...existing, ...updates, id: existing.id });
    const orderAwb = resolveOptionalOrderAssociation(next.orderAwb);
    statements.updateLabel.run(
      orderAwb,
      next.source,
      next.status,
      next.platform,
      next.date,
      next.fileName,
      next.relativePath,
      next.originalRelativePath,
      next.pageImageRelativePath,
      next.contentType,
      next.awb,
      next.awb ? normalizeAwb(next.awb) : null,
      next.orderNumber,
      next.customerName,
      next.carrier,
      next.page,
      next.labelIndex,
      next.printablePageKey,
      next.sizeBytes,
      timestamp(updates?.updatedAt),
      existing.id
    );
    return getLabel(existing.id);
  }

  function updateLabelsForAwbWithinTransaction(awb, updates) {
    const normalizedAwb = normalizeAwb(awb);
    const rows = statements.selectActiveLabelsByAwb.all(normalizedAwb, awb);
    return rows.map((row) => updateLabelWithinTransaction(row.id, {
      ...updates,
      awb: updates?.awb ?? row.awb,
      orderAwb: updates?.orderAwb ?? row.order_awb
    }));
  }

  function insertItems(awb, items) {
    items.forEach((item, index) => {
      statements.insertOrderItem.run(awb, index, item.sku, item.name, item.qty, item.barcode);
    });
  }

  function hydrateOrder(row) {
    const items = statements.selectOrderItems.all(row.awb).map((item) => ({
      sku: item.sku,
      name: item.name,
      qty: Number(item.qty),
      barcode: item.barcode
    }));
    return {
      awb: row.awb,
      platform: row.platform,
      buyer: row.buyer,
      orderNumber: row.order_number,
      carrier: row.carrier,
      importedAt: row.imported_at,
      status: row.status,
      source: row.source,
      reviewRequired: Boolean(row.review_required),
      labelFile: hydrateLabelFile(row),
      draftCode: row.draft_code,
      draftMessage: row.draft_message,
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at
    };
  }

  function requireActiveOrder(awb) {
    const order = getOrderByAwb(awb);
    if (!order) throw repositoryError("ORDER_NOT_FOUND", "The active order was not found.");
    return order;
  }

  function requireActiveLabel(id) {
    const label = getLabel(id);
    if (!label) throw repositoryError("LABEL_NOT_FOUND", "The active label was not found.");
    return label;
  }

  function assertOrderIdentityAvailable(awb, orderNumber) {
    const existing = statements.selectOrderIncludingDeleted.get(normalizeAwb(awb));
    if (!existing) return;
    const existingOrderNumber = cleanText(existing.order_number);
    if (existingOrderNumber && orderNumber && existingOrderNumber === orderNumber) {
      throw repositoryError("ORDER_DUPLICATE_LABEL", "The AWB and order number already exist.");
    }
    if (existingOrderNumber && orderNumber && existingOrderNumber !== orderNumber) {
      throw repositoryError("ORDER_AWB_CONFLICT", "The AWB already belongs to a different order number.");
    }
    throw repositoryError("ORDER_ALREADY_EXISTS", "The AWB already exists.");
  }

  function resolveOptionalOrderAssociation(value) {
    const normalized = normalizeAwb(value);
    if (!normalized) return null;
    const order = getOrderByAwb(normalized);
    if (!order) throw repositoryError("ORDER_NOT_FOUND", "The associated active order was not found.");
    return order.awb;
  }

  function timestamp(value) {
    const date = value == null || value === "" ? now() : value;
    const parsed = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(parsed.getTime())) {
      throw repositoryError("REPOSITORY_TIMESTAMP_INVALID", "A valid repository timestamp is required.");
    }
    return parsed.toISOString();
  }

  return {
    createOrder,
    createOrders,
    getOrderByAwb,
    findAwbsByOrderNumber,
    listOrders,
    updateOrder,
    softDeleteOrder,
    createLabel,
    getLabel,
    listLabels,
    updateLabel,
    softDeleteLabel,
    updateOrderAndLabels,
    softDeleteOrderAndLabels,
    importAcceptedLabel,
    persistAcceptedSyncResults
  };
}

function prepareStatements(database) {
  try {
    return {
      insertOrder: database.prepare(`
        INSERT INTO orders (
          awb, awb_normalized, platform, buyer, order_number, carrier,
          imported_at, status, source, review_required, label_file_name,
          label_relative_path, label_page_image_relative_path,
          label_original_relative_path, label_bytes, label_content_type,
          label_imported_at, label_page, label_index, draft_code,
          draft_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertOrderItem: database.prepare(`
        INSERT INTO order_items (order_awb, line_index, sku, name, qty, barcode)
        VALUES (?, ?, ?, ?, ?, ?)
      `),
      selectActiveOrder: database.prepare(`SELECT * FROM orders WHERE awb_normalized = ? AND deleted_at IS NULL`),
      selectOrderIncludingDeleted: database.prepare(`SELECT * FROM orders WHERE awb_normalized = ?`),
      selectOrderItems: database.prepare(`SELECT * FROM order_items WHERE order_awb = ? ORDER BY line_index`),
      selectActiveAwbsByOrderNumber: database.prepare(`
        SELECT awb FROM orders WHERE order_number = ? AND deleted_at IS NULL ORDER BY order_sequence
      `),
      selectAwbsByOrderNumberIncludingDeleted: database.prepare(`
        SELECT awb FROM orders WHERE order_number = ? ORDER BY order_sequence
      `),
      selectActiveOrders: database.prepare(`SELECT * FROM orders WHERE deleted_at IS NULL ORDER BY order_sequence DESC`),
      selectOrdersIncludingDeleted: database.prepare(`SELECT * FROM orders ORDER BY order_sequence DESC`),
      updateOrder: database.prepare(`
        UPDATE orders SET
          platform = ?, buyer = ?, order_number = ?, carrier = ?, imported_at = ?,
          status = ?, source = ?, review_required = ?, label_file_name = ?,
          label_relative_path = ?, label_page_image_relative_path = ?,
          label_original_relative_path = ?, label_bytes = ?, label_content_type = ?,
          label_imported_at = ?, label_page = ?, label_index = ?, draft_code = ?,
          draft_message = ?, updated_at = ?
        WHERE awb = ? AND deleted_at IS NULL
      `),
      deleteOrderItems: database.prepare(`DELETE FROM order_items WHERE order_awb = ?`),
      softDeleteOrder: database.prepare(`UPDATE orders SET deleted_at = ?, updated_at = ? WHERE awb = ? AND deleted_at IS NULL`),
      insertLabel: database.prepare(`
        INSERT INTO labels (
          id, order_awb, source, status, platform, date, file_name,
          relative_path, original_relative_path, page_image_relative_path,
          content_type, awb, awb_normalized, order_number, customer_name,
          carrier, page, label_index, printable_page_key, size_bytes,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      selectActiveLabel: database.prepare(`SELECT * FROM labels WHERE id = ? AND deleted_at IS NULL`),
      selectLabelIncludingDeleted: database.prepare(`SELECT * FROM labels WHERE id = ?`),
      selectActiveLabelByPrintablePageKey: database.prepare(`
        SELECT * FROM labels
        WHERE source = 'connect-import' AND printable_page_key = ? AND deleted_at IS NULL
      `),
      selectDeletedLabelByPrintablePageKey: database.prepare(`
        SELECT * FROM labels
        WHERE source = 'connect-import' AND printable_page_key = ? AND deleted_at IS NOT NULL
        ORDER BY label_sequence DESC LIMIT 1
      `),
      selectLabels: database.prepare(`
        SELECT * FROM labels
        WHERE (:includeDeleted = 1 OR deleted_at IS NULL)
          AND (:includeSkipped = 1 OR lower(trim(coalesce(status, ''))) <> 'skipped')
          AND (:date = '' OR date = :date)
          AND (:platform = '' OR lower(trim(platform)) = :platform)
        ORDER BY label_sequence DESC
      `),
      selectActiveLabelsByAwb: database.prepare(`
        SELECT * FROM labels
        WHERE (awb_normalized = ? OR order_awb = ?) AND deleted_at IS NULL
        ORDER BY label_sequence
      `),
      updateLabel: database.prepare(`
        UPDATE labels SET
          order_awb = ?, source = ?, status = ?, platform = ?, date = ?, file_name = ?,
          relative_path = ?, original_relative_path = ?, page_image_relative_path = ?,
          content_type = ?, awb = ?, awb_normalized = ?, order_number = ?,
          customer_name = ?, carrier = ?, page = ?, label_index = ?,
          printable_page_key = ?, size_bytes = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `),
      softDeleteLabel: database.prepare(`UPDATE labels SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`),
      softDeleteLabelsByAwb: database.prepare(`
        UPDATE labels SET deleted_at = ?, updated_at = ?
        WHERE (awb_normalized = ? OR order_awb = ?) AND deleted_at IS NULL
      `),
      selectDeletedLabelsByAwb: database.prepare(`
        SELECT * FROM labels
        WHERE (awb_normalized = ? OR order_awb = ?) AND deleted_at = ?
        ORDER BY label_sequence
      `)
    };
  } catch (cause) {
    throw repositoryError("ORDER_LABEL_REPOSITORY_PREPARE_FAILED", "The order-label repository could not be prepared.", cause);
  }
}

function normalizeOrderInput(input = {}) {
  const awb = requiredText(input.awb, "AWB_REQUIRED", "An AWB is required.");
  const status = requiredText(input.status || "ready", "ORDER_STATUS_REQUIRED", "An order status is required.");
  const source = requiredText(input.source || "manual", "ORDER_SOURCE_REQUIRED", "An order source is required.");
  const draftCode = optionalText(input.draftCode);
  const orderNumber = cleanText(input.orderNumber);
  const missingOrderNumberDraft = status === "draft"
    && source === "connect-import"
    && draftCode === "ORDER_NUMBER_REQUIRED";
  if (!orderNumber && !missingOrderNumberDraft) {
    throw repositoryError("ORDER_NUMBER_REQUIRED", "An order number is required.");
  }
  const items = normalizeItems(input.items);
  if (status !== "draft" && items.length === 0) {
    throw repositoryError("ITEM_DETAILS_REQUIRED", "A non-draft order requires at least one item.");
  }
  return {
    awb,
    awbNormalized: normalizeAwb(awb),
    platform: requiredText(input.platform, "PLATFORM_REQUIRED", "An order platform is required."),
    buyer: requiredText(input.buyer, "BUYER_REQUIRED", "An order buyer is required."),
    orderNumber,
    carrier: cleanText(input.carrier),
    importedAt: requiredTimestampText(input.importedAt, "ORDER_IMPORTED_AT_REQUIRED"),
    status,
    source,
    reviewRequired: Boolean(input.reviewRequired),
    labelFile: normalizeLabelFile(input.labelFile),
    draftCode,
    draftMessage: optionalText(input.draftMessage),
    items
  };
}

function normalizeItems(items) {
  if (!Array.isArray(items)) throw repositoryError("ORDER_ITEMS_INVALID", "Order items must be an array.");
  return items.map((item) => {
    const qty = Number(item?.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      throw repositoryError("ORDER_ITEM_QUANTITY_INVALID", "Order item quantity must be an integer from 1 to 999.");
    }
    return {
      sku: cleanText(item?.sku),
      name: requiredText(item?.name, "ORDER_ITEM_NAME_REQUIRED", "An order item name is required."),
      qty,
      barcode: requiredText(item?.barcode, "ORDER_ITEM_BARCODE_REQUIRED", "An order item barcode is required.")
    };
  });
}

function normalizeLabelInput(input = {}) {
  if (input.imageDataUrl != null) {
    throw repositoryError("LABEL_BINARY_CONTENT_FORBIDDEN", "Binary label content must remain outside SQLite.");
  }
  const source = optionalText(input.source);
  const sizeBytes = Number(input.sizeBytes ?? 0);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw repositoryError("LABEL_SIZE_INVALID", "Label size must be a non-negative integer.");
  }
  return {
    id: requiredText(input.id, "LABEL_ID_REQUIRED", "A label id is required."),
    orderAwb: optionalText(input.orderAwb),
    source,
    status: optionalText(input.status),
    platform: requiredText(input.platform, "PLATFORM_REQUIRED", "A label platform is required."),
    date: requiredText(input.date, "LABEL_DATE_REQUIRED", "A label date is required."),
    fileName: requiredRelativePath(input.fileName, "LABEL_FILE_NAME_REQUIRED", "A label file name is required."),
    relativePath: optionalRelativePath(input.relativePath),
    originalRelativePath: optionalRelativePath(input.originalRelativePath),
    pageImageRelativePath: optionalRelativePath(input.pageImageRelativePath),
    contentType: normalizeContentType(input.contentType),
    awb: optionalText(input.awb),
    orderNumber: optionalText(input.orderNumber),
    customerName: optionalText(input.customerName),
    carrier: optionalText(input.carrier),
    page: optionalPositiveInteger(input.page, "LABEL_PAGE_INVALID") ?? (source === "connect-import" ? 1 : null),
    labelIndex: optionalPositiveInteger(input.labelIndex, "LABEL_INDEX_INVALID") ?? (source === "connect-import" ? 1 : null),
    printablePageKey: optionalText(input.printablePageKey),
    sizeBytes,
    createdAt: requiredTimestampText(input.createdAt, "LABEL_CREATED_AT_REQUIRED")
  };
}

function mapLabel(row) {
  return {
    id: row.id,
    orderAwb: row.order_awb,
    source: row.source,
    status: row.status,
    platform: row.platform,
    date: row.date,
    fileName: row.file_name,
    relativePath: row.relative_path,
    originalRelativePath: row.original_relative_path,
    pageImageRelativePath: row.page_image_relative_path,
    contentType: row.content_type,
    awb: row.awb,
    orderNumber: row.order_number,
    customerName: row.customer_name,
    carrier: row.carrier,
    page: row.page == null ? null : Number(row.page),
    labelIndex: row.label_index == null ? null : Number(row.label_index),
    printablePageKey: row.printable_page_key,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at
  };
}

function hydrateLabelFile(row) {
  if (row.label_file_name == null) return null;
  const labelFile = { fileName: row.label_file_name };
  if (row.label_relative_path != null) labelFile.relativePath = row.label_relative_path;
  if (row.label_page_image_relative_path != null) {
    labelFile.pageImageRelativePath = row.label_page_image_relative_path;
  }
  if (row.label_original_relative_path != null) {
    labelFile.originalRelativePath = row.label_original_relative_path;
  }
  if (row.label_bytes != null) labelFile.bytes = Number(row.label_bytes);
  if (row.label_content_type != null) labelFile.contentType = row.label_content_type;
  if (row.label_imported_at != null) labelFile.importedAt = row.label_imported_at;
  if (row.label_page != null) labelFile.page = Number(row.label_page);
  if (row.label_index != null) labelFile.labelIndex = Number(row.label_index);
  return labelFile;
}

function validateDatabase(database) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function") {
    throw repositoryError("ORDER_LABEL_DATABASE_INVALID", "A valid SQLite database is required.");
  }
}

function validateSchema(database) {
  try {
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version);
    const foreignKeys = Number(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys);
    if (!Number.isInteger(version) || version < MINIMUM_SCHEMA_VERSION) {
      throw repositoryError("ORDER_LABEL_SCHEMA_REQUIRED", "SQLite schema version 3 or later is required.");
    }
    if (foreignKeys !== 1) {
      throw repositoryError("ORDER_LABEL_FOREIGN_KEYS_REQUIRED", "SQLite foreign keys must be enabled.");
    }
  } catch (cause) {
    if (cause instanceof OrderLabelRepositoryError) throw cause;
    throw repositoryError("ORDER_LABEL_SCHEMA_CHECK_FAILED", "The order-label schema could not be verified.", cause);
  }
}

function inRepositoryTransaction(database, code, callback) {
  try {
    return runInSqliteTransaction(database, callback);
  } catch (cause) {
    if (cause instanceof OrderLabelRepositoryError) throw cause;
    throw repositoryError(code, "The repository transaction failed and was rolled back.", cause);
  }
}

function requiredText(value, code, message) {
  const text = cleanText(value);
  if (!text) throw repositoryError(code, message);
  return text;
}

function requiredTimestampText(value, code) {
  const text = cleanText(value);
  if (!text || Number.isNaN(new Date(text).getTime())) {
    throw repositoryError(code, "A valid timestamp is required.");
  }
  return new Date(text).toISOString();
}

function optionalText(value) {
  const text = cleanText(value);
  return text || null;
}

function optionalPositiveInteger(value, code) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw repositoryError(code, "A positive integer is required.");
  }
  return number;
}

function normalizeAwb(value) {
  return cleanText(value);
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalizeLabelFile(value) {
  if (value == null) return null;
  if (!isPlainRecord(value)) {
    throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file metadata must be a plain object.");
  }
  const unknownKey = Object.keys(value).find((key) => !LABEL_FILE_FIELDS.has(key));
  if (unknownKey) {
    throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file metadata contains an unsupported field.");
  }

  const labelFile = {};
  for (const field of ["relativePath", "originalRelativePath", "pageImageRelativePath"]) {
    if (Object.hasOwn(value, field)) {
      labelFile[field] = requiredMetadataPath(value[field], MAX_RELATIVE_PATH_LENGTH, "LABEL_PATH_INVALID");
    }
  }
  labelFile.fileName = requiredMetadataPath(value.fileName, MAX_FILE_NAME_LENGTH, "LABEL_PATH_INVALID");
  if (Object.hasOwn(value, "bytes")) {
    if (typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0) {
      throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file bytes must be a non-negative safe integer.");
    }
    labelFile.bytes = value.bytes;
  }
  if (Object.hasOwn(value, "contentType")) {
    labelFile.contentType = normalizeContentType(value.contentType, { allowAbsent: false });
  }
  if (Object.hasOwn(value, "importedAt")) {
    if (typeof value.importedAt !== "string") {
      throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file importedAt must be a timestamp string.");
    }
    labelFile.importedAt = requiredTimestampText(value.importedAt, "ORDER_LABEL_FILE_INVALID");
  }
  for (const field of ["page", "labelIndex"]) {
    if (!Object.hasOwn(value, field)) continue;
    if (typeof value[field] !== "number" || !Number.isSafeInteger(value[field]) || value[field] < 1) {
      throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file page values must be positive safe integers.");
    }
    labelFile[field] = value[field];
  }
  return labelFile;
}

function optionalRelativePath(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw repositoryError("LABEL_PATH_INVALID", "Label filesystem paths must be relative.");
  }
  const filePath = value.trim();
  if (!filePath) return null;
  assertRelativePath(filePath, MAX_RELATIVE_PATH_LENGTH, "LABEL_PATH_INVALID");
  return filePath;
}

function requiredRelativePath(value, code, message) {
  if (typeof value !== "string" || !value.trim()) throw repositoryError(code, message);
  const filePath = value.trim();
  assertRelativePath(filePath, MAX_FILE_NAME_LENGTH, "LABEL_PATH_INVALID");
  return filePath;
}

function requiredMetadataPath(value, maximumLength, code) {
  if (typeof value !== "string" || !value.trim()) {
    throw repositoryError("ORDER_LABEL_FILE_INVALID", "Label file paths must be non-empty strings.");
  }
  const filePath = value.trim();
  assertRelativePath(filePath, maximumLength, code);
  return filePath;
}

function normalizeContentType(value, { allowAbsent = true } = {}) {
  if (value == null) {
    if (allowAbsent) return null;
    throw repositoryError("LABEL_CONTENT_TYPE_INVALID", "A valid bounded label content type is required.");
  }
  if (
    typeof value !== "string"
    || value.length > MAX_CONTENT_TYPE_LENGTH
    || /[^\x20-\x7E]/.test(value)
  ) {
    throw repositoryError("LABEL_CONTENT_TYPE_INVALID", "A valid bounded label content type is required.");
  }
  const contentType = value.trim();
  if (
    !contentType
    || contentType.length > MAX_CONTENT_TYPE_LENGTH
    || /^data:/i.test(contentType)
    || contentType.includes(",")
    || !MEDIA_TYPE_PATTERN.test(contentType)
  ) {
    throw repositoryError("LABEL_CONTENT_TYPE_INVALID", "A valid bounded label content type is required.");
  }
  return contentType;
}

function assertRelativePath(filePath, maximumLength, code) {
  const segments = filePath.split(/[\\/]+/);
  if (
    filePath.length > maximumLength
    || /^data:/i.test(filePath)
    || /^[A-Za-z]:/.test(filePath)
    || path.posix.isAbsolute(filePath)
    || path.win32.isAbsolute(filePath)
    || segments.includes("..")
  ) {
    throw repositoryError(code, "Label filesystem paths must be relative.");
  }
}

function isPlainRecord(value) {
  if (!value || Array.isArray(value) || typeof value !== "object") return false;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function samePrintableIdentity(row, label) {
  return normalizedPrintableText(row.awb) === normalizedPrintableText(label.awb)
    && normalizedPrintableText(row.order_number) === normalizedPrintableText(label.orderNumber)
    && Number(row.page) === Number(label.page)
    && Number(row.label_index) === Number(label.labelIndex);
}

function normalizedPrintableText(value) {
  return cleanText(value).toUpperCase();
}

function repositoryError(code, message) {
  return new OrderLabelRepositoryError(code, message);
}
