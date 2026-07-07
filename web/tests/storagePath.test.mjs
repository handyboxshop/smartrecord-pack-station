import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describeStorageTarget, resolveStorageRoot, verifyStorageDestination } from "../src/domain/storagePath.mjs";

const rootDir = path.resolve("/tmp/smartrecord-test-root");
const storageTarget = {
  id: "local-cloud-sync",
  label: "Cloud Sync",
  provider: "cloud-sync",
  host: "cloud sync folder",
  localPath: "local-nas/cloud-sync"
};
const nasStorageTarget = {
  id: "main-nas",
  label: "NAS หลัก",
  provider: "nas",
  host: "192.0.2.40",
  localPath: "local-nas/videos"
};
const localMachineTarget = {
  id: "local-machine",
  label: "เก็บที่เครื่องนี้",
  provider: "local",
  host: "localhost",
  localPath: "local-nas/this-machine"
};
const customNasStorageTarget = {
  id: "custom-nas",
  label: "NAS กำหนดเอง",
  provider: "nas",
  host: "กรอก path เอง",
  localPath: "local-nas/custom-nas"
};

test("storage root uses target localPath by default", () => {
  const result = resolveStorageRoot({ rootDir, storageTarget });

  assert.equal(result.ok, true);
  assert.equal(result.data.storageRoot, path.join(rootDir, "local-nas/cloud-sync"));
});

test("storage root accepts project-local custom paths", () => {
  const result = resolveStorageRoot({ rootDir, storageTarget, customPath: "local-nas/custom-videos" });

  assert.equal(result.ok, true);
  assert.equal(result.data.storageRoot, path.join(rootDir, "local-nas/custom-videos"));
});

test("storage root accepts external website URLs for cloud sync targets", () => {
  const result = resolveStorageRoot({
    rootDir,
    storageTarget,
    customPath: "https://drive.google.com/drive/folders/demo"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.storageRoot, path.join(rootDir, "local-nas/cloud-sync"));
  assert.equal(result.data.externalUrl, "https://drive.google.com/drive/folders/demo");
});

test("storage root rejects external website URLs for non-cloud targets", () => {
  const result = resolveStorageRoot({
    rootDir,
    storageTarget: nasStorageTarget,
    customPath: "https://drive.google.com/drive/folders/demo"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CUSTOM_STORAGE_URL");
});

test("storage root accepts absolute custom paths for local station storage", () => {
  const customPath = path.join(rootDir, "absolute-custom");
  const result = resolveStorageRoot({ rootDir, storageTarget, customPath });

  assert.equal(result.ok, true);
  assert.equal(result.data.storageRoot, customPath);
});

test("storage root rejects traversal outside the selected path", () => {
  const result = resolveStorageRoot({ rootDir, storageTarget, customPath: "../outside" });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CUSTOM_STORAGE_PATH");
});

test("storage root rejects machine root path", () => {
  const result = resolveStorageRoot({ rootDir, storageTarget, customPath: path.parse(rootDir).root });

  assert.equal(result.ok, false);
  assert.equal(result.code, "CUSTOM_STORAGE_PATH_TOO_BROAD");
});

test("storage verification creates and removes a probe file", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-storage-"));
  const result = await verifyStorageDestination({
    fs,
    rootDir: tempRoot,
    storageTarget,
    customPath: "verified-storage"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.writable, true);
  assert.equal(result.data.storageRoot, path.join(tempRoot, "verified-storage"));
  const files = await fs.readdir(result.data.storageRoot);
  assert.deepEqual(files, []);
});

test("storage verification accepts website URL only as cloud sync external destination", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-cloud-sync-"));
  const result = await verifyStorageDestination({
    fs,
    rootDir: tempRoot,
    storageTarget,
    customPath: "https://drive.google.com/drive/folders/demo"
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.destinationType, "website-url");
  assert.equal(result.data.externalUrl, "https://drive.google.com/drive/folders/demo");
  assert.equal(result.data.storageRoot, path.join(tempRoot, "local-nas/cloud-sync"));
});

test("local-machine target writes to a real local folder", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-local-machine-"));
  const result = await verifyStorageDestination({
    fs,
    rootDir: tempRoot,
    storageTarget: localMachineTarget,
    customPath: ""
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.writable, true);
  assert.equal(result.data.mountedRequired, false);
  assert.equal(result.data.targetMode, "local-machine");
  assert.equal(result.data.storageRoot, path.join(tempRoot, "local-nas/this-machine"));
});

test("main-nas with project fallback is marked simulated and mounted required", () => {
  const profile = describeStorageTarget({
    rootDir,
    storageTarget: nasStorageTarget
  });

  assert.equal(profile.targetMode, "nas-simulated");
  assert.equal(profile.mountedRequired, true);
  assert.equal(profile.simulated, true);
  assert.equal(profile.actualWritePath, path.join(rootDir, "local-nas/videos"));
});

test("main-nas storage test still writes only to local fallback until NAS is mounted", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "smartrecord-main-nas-"));
  const result = await verifyStorageDestination({
    fs,
    rootDir: tempRoot,
    storageTarget: nasStorageTarget,
    customPath: ""
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.writable, true);
  assert.equal(result.data.mountedRequired, true);
  assert.equal(result.data.simulated, true);
  assert.match(result.data.message, /NAS ยังไม่ mount จริง/);
  assert.equal(result.data.storageRoot, path.join(tempRoot, "local-nas/videos"));
});

test("custom nas rejects ip address as non-writable mounted path", () => {
  const result = resolveStorageRoot({
    rootDir,
    storageTarget: customNasStorageTarget,
    customPath: "192.0.2.40"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_CUSTOM_STORAGE_PATH");
});
