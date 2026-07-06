const state = {
  config: null,
  authToken: localStorage.getItem("smartrecord.authToken") || "",
  currentUser: null,
  users: [],
  auditLogs: [],
  activityLogs: [],
  editingUserEmail: "",
  editingImportedAwb: "",
  session: null,
  record: null,
  records: [],
  syncedOrders: [],
  labels: [],
  labelSummary: { total: 0, filtered: 0 },
  labelSearchQuery: "",
  detectedPrinters: readStoredDetectedPrinters(),
  selectedOrderIds: new Set(),
  activeLabelPreviewId: "",
  pendingLabelAutoPrint: false
};

const el = {
  app: document.querySelector("#app"),
  loginScreen: document.querySelector("#loginScreen"),
  loginForm: document.querySelector("#loginForm"),
  loginEmail: document.querySelector("#loginEmail"),
  loginPassword: document.querySelector("#loginPassword"),
  loginError: document.querySelector("#loginError"),
  loginHint: document.querySelector("#loginHint"),
  loginBtn: document.querySelector("#loginBtn"),
  loginBtnText: document.querySelector("#loginBtnText"),
  loginSpinner: document.querySelector("#loginSpinner"),
  passwordToggle: document.querySelector("#passwordToggle"),
  clock: document.querySelector("#clock"),
  stationId: document.querySelector("#stationId"),
  currentUser: document.querySelector("#currentUser"),
  userAvatar: document.querySelector("#userAvatar"),
  roleBadge: document.querySelector("#roleBadge"),
  userChipBtn: document.querySelector("#userChipBtn"),
  userDropdown: document.querySelector("#userDropdown"),
  dropdownName: document.querySelector("#dropdownName"),
  dropdownEmail: document.querySelector("#dropdownEmail"),
  logoutBtn: document.querySelector("#logoutBtn"),
  hamburgerBtn: document.querySelector("#hamburgerBtn"),
  tabList: document.querySelector("#tabList"),
  tabs: document.querySelectorAll(".tab"),
  views: document.querySelectorAll(".view"),
  stages: document.querySelectorAll(".stage"),
  scanPanel: document.querySelector("#scanPanel"),
  packPanel: document.querySelector("#packPanel"),
  prePackGuideImg: document.querySelector("#prePackGuideImg"),
  webcamVideo: document.querySelector("#webcamVideo"),
  noCamMsg: document.querySelector("#noCamMsg"),
  recBadge: document.querySelector("#recBadge"),
  recTimer: document.querySelector("#recTimer"),
  uploadPanel: document.querySelector("#uploadPanel"),
  uploadOrderLine: document.querySelector("#uploadOrderLine"),
  uploadFill: document.querySelector("#uploadFill"),
  uploadPct: document.querySelector("#uploadPct"),
  uploadSteps: document.querySelector("#uploadSteps"),
  completePanel: document.querySelector("#completePanel"),
  completeTitle: document.querySelector("#completeTitle"),
  startForm: document.querySelector("#startForm"),
  awbInput: document.querySelector("#awbInput"),
  deviceSummary: document.querySelector("#deviceSummary"),
  openSettingsBtn: document.querySelector("#openSettingsBtn"),
  settingsDialog: document.querySelector("#settingsDialog"),
  closeSettingsBtn: document.querySelector("#closeSettingsBtn"),
  cancelSettingsBtn: document.querySelector("#cancelSettingsBtn"),
  storageCardGroup: document.querySelector("#storageCardGroup"),
  storageCustomWrap: document.querySelector("#storageCustomWrap"),
  customPathLabel: document.querySelector("#customPathLabel"),
  customStoragePathInput: document.querySelector("#customStoragePathInput"),
  storageHint: document.querySelector("#storageHint"),
  prePackImageSettings: document.querySelector("#prePackImageSettings"),
  prePackImagePreview: document.querySelector("#prePackImagePreview"),
  prePackImageInput: document.querySelector("#prePackImageInput"),
  uploadPrePackImageBtn: document.querySelector("#uploadPrePackImageBtn"),
  prePackImageStatus: document.querySelector("#prePackImageStatus"),
  cameraSelect: document.querySelector("#cameraSelect"),
  cameraPermissionStatus: document.querySelector("#cameraPermissionStatus"),
  cameraStatus: document.querySelector("#cameraStatus"),
  cameraPreviewWrap: document.querySelector("#cameraPreviewWrap"),
  settingsCameraPreview: document.querySelector("#settingsCameraPreview"),
  printerDriverSelect: document.querySelector("#printerDriverSelect"),
  printerStatus: document.querySelector("#printerStatus"),
  searchPrinterBtn: document.querySelector("#searchPrinterBtn"),
  scannerModeSelect: document.querySelector("#scannerModeSelect"),
  scannerTestInput: document.querySelector("#scannerTestInput"),
  scannerStatus: document.querySelector("#scannerStatus"),
  testCameraBtn: document.querySelector("#testCameraBtn"),
  saveSettingsBtn: document.querySelector("#saveSettingsBtn"),
  scanForm: document.querySelector("#scanForm"),
  scanInput: document.querySelector("#scanInput"),
  itemList: document.querySelector("#itemList"),
  itemCount: document.querySelector("#itemCount"),
  progressText: document.querySelector("#progressText"),
  progressFill: document.querySelector("#progressFill"),
  activeAwb: document.querySelector("#activeAwb"),
  activePlatform: document.querySelector("#activePlatform"),
  activeStation: document.querySelector("#activeStation"),
  employeeId: document.querySelector("#employeeId"),
  startedAt: document.querySelector("#startedAt"),
  sessionStatus: document.querySelector("#sessionStatus"),
  scanNextBtn: document.querySelector("#scanNextBtn"),
  closeBtn: document.querySelector("#closeBtn"),
  receipt: document.querySelector("#receipt"),
  nextOrderBtn: document.querySelector("#nextOrderBtn"),
  reportsBody: document.querySelector("#reportsBody"),
  reportsEmpty: document.querySelector("#reportsEmpty"),
  reportSearch: document.querySelector("#reportSearch"),
  statusFilter: document.querySelector("#statusFilter"),
  platformFilter: document.querySelector("#platformFilter"),
  employeeFilter: document.querySelector("#employeeFilter"),
  reportDayFilter: document.querySelector("#reportDayFilter"),
  reportMonthFilter: document.querySelector("#reportMonthFilter"),
  reportYearFilter: document.querySelector("#reportYearFilter"),
  statTotal: document.querySelector("#statTotal"),
  statPass: document.querySelector("#statPass"),
  statWarn: document.querySelector("#statWarn"),
  statSize: document.querySelector("#statSize"),
  reportSummary: document.querySelector("#reportSummary"),
  refreshReportsBtn: document.querySelector("#refreshReportsBtn"),
  connectCards: document.querySelector("#connectCards"),
  syncPlatform: document.querySelector("#syncPlatform"),
  syncStatus: document.querySelector("#syncStatus"),
  syncOrdersBtn: document.querySelector("#syncOrdersBtn"),
  syncOrderList: document.querySelector("#syncOrderList"),
  syncCount: document.querySelector("#syncCount"),
  manualOrderForm: document.querySelector("#manualOrderForm"),
  manualAwbInput: document.querySelector("#manualAwbInput"),
  manualOrderNumberInput: document.querySelector("#manualOrderNumberInput"),
  manualPlatformSelect: document.querySelector("#manualPlatformSelect"),
  manualBuyerInput: document.querySelector("#manualBuyerInput"),
  manualItemCountInput: document.querySelector("#manualItemCountInput"),
  clearManualOrderBtn: document.querySelector("#clearManualOrderBtn"),
  labelImportForm: document.querySelector("#labelImportForm"),
  labelFileInput: document.querySelector("#labelFileInput"),
  labelImportBtn: document.querySelector("#labelImportBtn"),
  clearLabelImportBtn: document.querySelector("#clearLabelImportBtn"),
  labelImportStatus: document.querySelector("#labelImportStatus"),
  labelImportPreview: document.querySelector("#labelImportPreview"),
  selectedCount: document.querySelector("#selectedCount"),
  selectAllOrdersBtn: document.querySelector("#selectAllOrdersBtn"),
  clearOrderSelectionBtn: document.querySelector("#clearOrderSelectionBtn"),
  importOrdersBtn: document.querySelector("#importOrdersBtn"),
  importSummary: document.querySelector("#importSummary"),
  importSkippedList: document.querySelector("#importSkippedList"),
  importConfirmDialog: document.querySelector("#importConfirmDialog"),
  importConfirmText: document.querySelector("#importConfirmText"),
  editImportedOrderDialog: document.querySelector("#editImportedOrderDialog"),
  editImportedOrderForm: document.querySelector("#editImportedOrderForm"),
  editImportedAwb: document.querySelector("#editImportedAwb"),
  editImportedPlatform: document.querySelector("#editImportedPlatform"),
  editImportedOrderNumber: document.querySelector("#editImportedOrderNumber"),
  editImportedBuyer: document.querySelector("#editImportedBuyer"),
  editImportedSku: document.querySelector("#editImportedSku"),
  editImportedBarcode: document.querySelector("#editImportedBarcode"),
  editImportedProductName: document.querySelector("#editImportedProductName"),
  editImportedQty: document.querySelector("#editImportedQty"),
  editImportedCarrier: document.querySelector("#editImportedCarrier"),
  saveImportedOrderBtn: document.querySelector("#saveImportedOrderBtn"),
  goPackBtn: document.querySelector("#goPackBtn"),
  labelLibraryUploadForm: document.querySelector("#labelLibraryUploadForm"),
  labelUploadDropZone: document.querySelector("#labelUploadDropZone"),
  labelLibraryFileInput: document.querySelector("#labelLibraryFileInput"),
  labelLibraryUploadBtn: document.querySelector("#labelLibraryUploadBtn"),
  clearLabelLibraryBtn: document.querySelector("#clearLabelLibraryBtn"),
  labelUploadFileName: document.querySelector("#labelUploadFileName"),
  labelLibraryStatus: document.querySelector("#labelLibraryStatus"),
  labelLibraryPreview: document.querySelector("#labelLibraryPreview"),
  labelDateFilter: document.querySelector("#labelDateFilter"),
  labelSearchInput: document.querySelector("#labelSearchInput"),
  clearLabelDateBtn: document.querySelector("#clearLabelDateBtn"),
  labelPlatformFilter: document.querySelector("#labelPlatformFilter"),
  refreshLabelsBtn: document.querySelector("#refreshLabelsBtn"),
  labelFilterHint: document.querySelector("#labelFilterHint"),
  labelForm: document.querySelector("#labelForm"),
  labelPlatformSelect: document.querySelector("#labelPlatformSelect"),
  labelDateInput: document.querySelector("#labelDateInput"),
  labelImageInput: document.querySelector("#labelImageInput"),
  labelPreviewWrap: document.querySelector("#labelPreviewWrap"),
  labelPreviewImg: document.querySelector("#labelPreviewImg"),
  saveLabelBtn: document.querySelector("#saveLabelBtn"),
  labelCount: document.querySelector("#labelCount"),
  labelList: document.querySelector("#labelList"),
  labelPrintDialog: document.querySelector("#labelPrintDialog"),
  labelPrintDialogTitle: document.querySelector("#labelPrintDialogTitle"),
  labelPrintPreviewImg: document.querySelector("#labelPrintPreviewImg"),
  labelPrintMeta: document.querySelector("#labelPrintMeta"),
  labelPrintNowBtn: document.querySelector("#labelPrintNowBtn"),
  refreshUsersBtn: document.querySelector("#refreshUsersBtn"),
  userForm: document.querySelector("#userForm"),
  userFormTitle: document.querySelector("#userFormTitle"),
  userNameInput: document.querySelector("#userNameInput"),
  userEmailInput: document.querySelector("#userEmailInput"),
  userEmployeeNameInput: document.querySelector("#userEmployeeNameInput"),
  userEmployeeIdInput: document.querySelector("#userEmployeeIdInput"),
  employeeNameOptions: document.querySelector("#employeeNameOptions"),
  employeeIdOptions: document.querySelector("#employeeIdOptions"),
  userRoleSelect: document.querySelector("#userRoleSelect"),
  customRoleNameRow: document.querySelector("#customRoleNameRow"),
  customRoleNameInput: document.querySelector("#customRoleNameInput"),
  permissionMatrix: document.querySelector("#permissionMatrix"),
  userPasswordInput: document.querySelector("#userPasswordInput"),
  userActiveInput: document.querySelector("#userActiveInput"),
  resetUserFormBtn: document.querySelector("#resetUserFormBtn"),
  submitUserBtn: document.querySelector("#submitUserBtn"),
  userCount: document.querySelector("#userCount"),
  userList: document.querySelector("#userList"),
  auditCount: document.querySelector("#auditCount"),
  auditList: document.querySelector("#auditList"),
  activityUserFilter: document.querySelector("#activityUserFilter"),
  refreshActivityBtn: document.querySelector("#refreshActivityBtn"),
  activityCount: document.querySelector("#activityCount"),
  activityList: document.querySelector("#activityList"),
  forceCloseDialog: document.querySelector("#forceCloseDialog"),
  forceReason: document.querySelector("#forceReason"),
  missingText: document.querySelector("#missingText"),
  warningDialog: document.querySelector("#warningDialog"),
  warningTitle: document.querySelector("#warningTitle"),
  warningMessage: document.querySelector("#warningMessage"),
  recordDetailDialog: document.querySelector("#recordDetailDialog"),
  detailAwb: document.querySelector("#detailAwb"),
  detailVideoPlayer: document.querySelector("#detailVideoPlayer"),
  detailReceipt: document.querySelector("#detailReceipt"),
  detailShareLink: document.querySelector("#detailShareLink"),
  copyDetailLinkBtn: document.querySelector("#copyDetailLinkBtn"),
  toast: document.querySelector("#toast")
};

let mediaStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingDiagnostics = resetRecordingDiagnostics();
let recTimerId = null;
let recSeconds = 0;
let deviceSettings = null;
let settingsCameraStream = null;
let labelImageDataUrl = "";
const deviceConnection = {
  cameraPermission: "unknown",
  cameraTestOk: false
};

boot();

async function boot() {
  tickClock();
  setInterval(tickClock, 1000);
  const configResult = await api("/api/config");
  if (!configResult.ok || !configResult.data) {
    showStartupError(configResult.message || "ไม่สามารถโหลดค่าตั้งต้นของระบบได้");
    return;
  }
  state.config = configResult.data;
  el.stationId.textContent = state.config.station.defaultStationId;
  el.employeeId.textContent = state.config.employees.defaultEmployeeId;
  applyPrePackGuideImage();
  loadDeviceSettings();
  renderSettingsControls();
  renderLabelPlatformOptions();
  clearLabelLibraryUpload();
  bindEvents();
  renderConnectCards();
  await restoreSession();
}

function bindEvents() {
  el.loginForm.addEventListener("submit", login);
  el.passwordToggle?.addEventListener("click", () => {
    const isPassword = el.loginPassword.type === "password";
    el.loginPassword.type = isPassword ? "text" : "password";
    el.passwordToggle.textContent = "👁";
    el.passwordToggle.setAttribute("aria-label", isPassword ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน");
  });
  el.userChipBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = !el.userDropdown.classList.contains("hidden");
    el.userDropdown.classList.toggle("hidden", isOpen);
    el.userChipBtn.setAttribute("aria-expanded", String(!isOpen));
  });
  document.addEventListener("click", () => {
    el.userDropdown?.classList.add("hidden");
    el.userChipBtn?.setAttribute("aria-expanded", "false");
  });
  el.logoutBtn.addEventListener("click", logout);

  // hamburger — mobile nav toggle
  el.hamburgerBtn?.addEventListener("click", (event) => {
    event.stopPropagation();
    const isOpen = el.tabList.classList.toggle("open");
    el.hamburgerBtn.setAttribute("aria-expanded", String(isOpen));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#mainNav")) {
      el.tabList?.classList.remove("open");
      el.hamburgerBtn?.setAttribute("aria-expanded", "false");
    }
  });

  el.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchView(tab.dataset.view);
      // close mobile menu after selecting a tab
      el.tabList?.classList.remove("open");
      el.hamburgerBtn?.setAttribute("aria-expanded", "false");
    });
  });

  el.startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await startSession(el.awbInput.value);
  });

  document.querySelectorAll("[data-demo-awb]").forEach((button) => {
    button.addEventListener("click", async () => {
      el.awbInput.value = button.dataset.demoAwb;
      await startSession(button.dataset.demoAwb);
    });
  });

  el.scanForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await scanCode(el.scanInput.value);
    el.scanInput.value = "";
  });

  el.scanNextBtn.addEventListener("click", async () => {
    const next = state.session?.items.find((item) => item.scannedQty < item.qty);
    if (next) await scanCode(next.barcode);
  });

  el.closeBtn.addEventListener("click", closeCurrentSession);
  el.nextOrderBtn.addEventListener("click", resetFlow);
  el.refreshReportsBtn.addEventListener("click", loadReports);
  el.reportSearch.addEventListener("input", renderReports);
  el.statusFilter.addEventListener("change", renderReports);
  el.platformFilter.addEventListener("change", renderReports);
  el.employeeFilter.addEventListener("change", renderReports);
  el.reportDayFilter.addEventListener("change", renderReports);
  el.reportMonthFilter.addEventListener("change", renderReports);
  el.reportYearFilter.addEventListener("change", renderReports);
  el.syncOrdersBtn.addEventListener("click", syncOrders);
  el.manualOrderForm.addEventListener("submit", createManualOrder);
  el.clearManualOrderBtn.addEventListener("click", clearManualOrderForm);
  el.labelImportForm?.addEventListener("submit", importLabelOrder);
  el.clearLabelImportBtn?.addEventListener("click", clearLabelImport);
  el.labelLibraryUploadForm?.addEventListener("submit", importLabelFromLabelsPage);
  el.clearLabelLibraryBtn?.addEventListener("click", clearLabelLibraryUpload);
  el.labelLibraryFileInput?.addEventListener("change", updateLabelUploadFileName);
  el.labelUploadDropZone?.addEventListener("dragover", (event) => {
    event.preventDefault();
    el.labelUploadDropZone.classList.add("dragover");
  });
  el.labelUploadDropZone?.addEventListener("dragleave", () => {
    el.labelUploadDropZone.classList.remove("dragover");
  });
  el.labelUploadDropZone?.addEventListener("drop", (event) => {
    event.preventDefault();
    el.labelUploadDropZone.classList.remove("dragover");
    const [file] = [...(event.dataTransfer?.files || [])];
    if (!file) return;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    el.labelLibraryFileInput.files = dataTransfer.files;
    updateLabelUploadFileName();
  });
  el.labelDateFilter?.addEventListener("change", loadLabels);
  el.labelSearchInput?.addEventListener("input", (event) => {
    state.labelSearchQuery = String(event.target.value || "");
    renderLabels();
  });
  el.labelPlatformFilter?.addEventListener("change", loadLabels);
  el.clearLabelDateBtn?.addEventListener("click", () => {
    el.labelDateFilter.value = "";
    loadLabels();
  });
  el.refreshLabelsBtn?.addEventListener("click", loadLabels);
  el.labelPrintNowBtn?.addEventListener("click", printActiveLabel);
  el.importOrdersBtn.addEventListener("click", confirmAndImportSelectedOrders);
  el.editImportedOrderForm?.addEventListener("submit", saveImportedOrder);
  el.selectAllOrdersBtn.addEventListener("click", () => selectAllSyncedOrders(true));
  el.clearOrderSelectionBtn.addEventListener("click", () => selectAllSyncedOrders(false));
  el.goPackBtn.addEventListener("click", () => switchView("pack"));
  el.labelImageInput?.addEventListener("change", handleLabelImagePreview);
  el.labelForm?.addEventListener("submit", submitLabel);
  el.refreshUsersBtn.addEventListener("click", loadUsers);
  el.userForm.addEventListener("submit", createUser);
  el.userEmployeeNameInput.addEventListener("input", syncEmployeeFromName);
  el.userEmployeeIdInput.addEventListener("input", syncEmployeeFromId);
  el.userEmployeeNameInput.addEventListener("change", syncEmployeeFromName);
  el.userEmployeeIdInput.addEventListener("change", syncEmployeeFromId);
  el.activityUserFilter.addEventListener("change", loadActivityLogs);
  el.refreshActivityBtn.addEventListener("click", loadActivityLogs);
  el.userRoleSelect.addEventListener("change", () => {
    const role = selectedRole();
    renderPermissionMatrix(role?.modulePermissions || [], el.userRoleSelect.value !== "custom");
    el.customRoleNameRow.classList.toggle("hidden", el.userRoleSelect.value !== "custom");
  });
  el.resetUserFormBtn.addEventListener("click", resetUserForm);
  el.copyDetailLinkBtn.addEventListener("click", copyDetailLink);
  el.openSettingsBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    el.userDropdown?.classList.add("hidden");
    el.settingsDialog.showModal();
    updateCameraPermissionStatus();
    refreshCameraDevices();
  });
  el.closeSettingsBtn?.addEventListener("click", closeSettingsDialog);
  el.cancelSettingsBtn?.addEventListener("click", closeSettingsDialog);
  el.storageCardGroup?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-target-id]");
    if (!card) return;
    deviceSettings.storageTargetId = card.dataset.targetId;
    renderStorageCards();
    updateCustomPathUI();
    updateStorageHint();
    updateDeviceSummary();
  });
  el.customStoragePathInput.addEventListener("input", () => {
    deviceSettings.customStoragePath = el.customStoragePathInput.value.trim();
    updateStorageHint();
    updateDeviceSummary();
  });
  el.cameraSelect.addEventListener("change", () => {
    deviceSettings.cameraDeviceId = el.cameraSelect.value;
    updateDeviceSummary();
  });
  el.printerDriverSelect.addEventListener("change", () => {
    deviceSettings.printerDriverId = el.printerDriverSelect.value;
    updatePrinterStatus();
    updateDeviceSummary();
  });
  el.searchPrinterBtn?.addEventListener("click", discoverPrinters);
  el.prePackImageInput?.addEventListener("change", previewSelectedPrePackImage);
  el.uploadPrePackImageBtn?.addEventListener("click", uploadPrePackImage);
  el.scannerModeSelect.addEventListener("change", () => {
    deviceSettings.scannerMode = el.scannerModeSelect.value;
    updateDeviceSummary();
  });
  el.testCameraBtn.addEventListener("click", testCamera);
  el.saveSettingsBtn.addEventListener("click", saveDeviceSettings);
  el.scannerTestInput.addEventListener("input", handleScannerTest);

  el.forceCloseDialog.addEventListener("close", async () => {
    if (el.forceCloseDialog.returnValue !== "confirm") return;
    await forceClose();
  });
  el.importConfirmDialog.addEventListener("close", async () => {
    if (el.importConfirmDialog.returnValue !== "confirm") return;
    await importSelectedOrders();
  });
}

async function restoreSession() {
  if (!state.authToken) {
    showLogin("กรุณาเข้าสู่ระบบก่อนใช้งาน");
    return;
  }
  const result = await api("/api/auth/me");
  if (!result.ok) {
    localStorage.removeItem("smartrecord.authToken");
    state.authToken = "";
    showLogin(result.message || "Session หมดอายุ กรุณา login ใหม่");
    return;
  }
  state.currentUser = result.data.user;
  await enterApp();
}

async function login(event) {
  event.preventDefault();
  setLoginLoading(true);
  el.loginError?.classList.add("hidden");
  try {
    const result = await api("/api/auth/login", {
      email: el.loginEmail.value.trim(),
      password: el.loginPassword.value.trim()
    });
    if (!result.ok) {
      showLoginError(result.message || "Login ไม่สำเร็จ");
      return;
    }
    state.authToken = result.data.token;
    state.currentUser = result.data.user;
    localStorage.setItem("smartrecord.authToken", state.authToken);
    el.loginPassword.value = "";
    await enterApp();
    toast(`ยินดีต้อนรับ ${state.currentUser.name}`);
  } finally {
    setLoginLoading(false);
  }
}

async function logout() {
  await api("/api/auth/logout", {});
  localStorage.removeItem("smartrecord.authToken");
  state.authToken = "";
  state.currentUser = null;
  state.session = null;
  state.record = null;
  stopCamera();
  el.userDropdown?.classList.add("hidden");
  showLogin("ออกจากระบบแล้ว");
}

async function enterApp() {
  el.loginScreen.classList.add("hidden");
  el.app.classList.remove("authLocked");
  const name = state.currentUser.name || "User";
  const roleId = state.currentUser.roleId || "";
  const roleLabel = state.currentUser.roleLabel || roleId;
  el.currentUser.textContent = name;
  if (el.userAvatar) el.userAvatar.textContent = name.charAt(0).toUpperCase();
  if (el.dropdownName) el.dropdownName.textContent = name;
  if (el.dropdownEmail) el.dropdownEmail.textContent = state.currentUser.email || "";
  if (el.roleBadge) {
    el.roleBadge.textContent = roleLabel;
    el.roleBadge.className = `roleBadge ${roleId}`;
  }
  applyPermissions();
  renderUserFormOptions();
  updateDeviceSummary();
  const firstView = firstAllowedView();
  switchView(firstView);
  if (can("reports:view")) await loadReports();
  if (can("users:manage")) await loadUsers();
}

function showLogin(message = "") {
  el.app.classList.add("authLocked");
  el.loginScreen.classList.remove("hidden");
  el.loginError?.classList.add("hidden");
  el.loginHint.textContent = message || "";
  setTimeout(() => el.loginEmail.focus(), 50);
}

function showStartupError(message) {
  state.authToken = "";
  state.currentUser = null;
  localStorage.removeItem("smartrecord.authToken");
  showLogin(message);
  showLoginError(message);
}

function showLoginError(message) {
  if (!el.loginError) {
    el.loginHint.textContent = message;
    return;
  }
  el.loginError.textContent = message;
  el.loginError.classList.remove("hidden");
}

function setLoginLoading(isLoading) {
  if (el.loginBtn) el.loginBtn.disabled = isLoading;
  el.loginBtnText?.classList.toggle("hidden", isLoading);
  el.loginSpinner?.classList.toggle("hidden", !isLoading);
}

function applyPermissions() {
  el.tabs.forEach((tab) => {
    const permission = tab.dataset.permission;
    tab.classList.toggle("hidden", Boolean(permission && !can(permission)));
  });
  el.openSettingsBtn?.classList.toggle("hidden", !can("settings:manage"));
  const canManageAssets = canManageSystemAssets();
  el.prePackImageSettings?.classList.toggle("hidden", !canManageAssets);
  if (el.uploadPrePackImageBtn) el.uploadPrePackImageBtn.disabled = !canManageAssets;
}

function firstAllowedView() {
  const tab = [...el.tabs].find((item) => !item.classList.contains("hidden"));
  return tab?.dataset.view || "pack";
}

function can(permission) {
  return (state.currentUser?.permissions || []).includes(permission);
}

function renderConnectCards() {
  const platforms = [
    { id: "shopee", name: "Shopee", fields: ["Partner ID", "Partner Key", "Shop ID", "Access Token"] },
    { id: "lazada", name: "Lazada", fields: ["App Key", "App Secret", "Access Token"] },
    { id: "tiktok", name: "TikTok Shop", fields: ["App Key", "App Secret", "Access Token", "Shop Cipher"] },
    { id: "3pl", name: "3PL / คลัง", fields: ["Endpoint URL", "API Key / Bearer Token"] }
  ];
  el.connectCards.innerHTML = platforms.map((platform) => `
    <article class="connectCard" data-platform="${platform.id}">
      <div class="connectCardHead">
        <div>
          <h3>${platform.name}</h3>
          <p class="muted" id="connectStatus-${platform.id}">ยังไม่ได้บันทึก</p>
        </div>
        <span class="platformBadge">${platform.id.toUpperCase()}</span>
      </div>
      <div class="credentialFields">
        ${platform.fields.map((field) => `
          <label>
            <span>${field}</span>
            <input type="${field.toLowerCase().includes("key") || field.toLowerCase().includes("token") || field.toLowerCase().includes("secret") ? "password" : "text"}" placeholder="${field}">
          </label>
        `).join("")}
      </div>
      <div class="connectActions">
        <button type="button" class="secondary" data-action="test" data-platform="${platform.id}">ทดสอบ</button>
        <button type="button" data-action="save" data-platform="${platform.id}">บันทึก</button>
      </div>
      <p class="connectResult" id="connectResult-${platform.id}"></p>
    </article>
  `).join("");

  el.connectCards.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const platform = button.dataset.platform;
      if (button.dataset.action === "test") await testConnection(platform);
      if (button.dataset.action === "save") await saveConnection(platform);
    });
  });
}

async function testConnection(platform) {
  const result = await api("/api/connect/test", { platform });
  const output = document.querySelector(`#connectResult-${platform}`);
  output.textContent = result.data.message;
  output.classList.toggle("error", !result.data.ok);
  toast(result.data.message);
}

async function saveConnection(platform) {
  const result = await api("/api/connect/save", { platform });
  if (!result.ok) {
    toast(result.message);
    return;
  }
  document.querySelector(`#connectStatus-${platform}`).textContent = "บันทึกแล้ว";
  document.querySelector(`#connectResult-${platform}`).textContent = "บันทึก credential mock เรียบร้อย";
  toast(`บันทึก ${platform.toUpperCase()} แล้ว`);
}

async function syncOrders() {
  const result = await api("/api/orders/sync", {
    platform: el.syncPlatform.value,
    status: el.syncStatus.value
  });
  if (!result.ok) {
    if (isDuplicateOrderCode(result.code)) {
      showWarningDialog("ห้ามสแกน/นำเข้าซ้ำ", result.message || "ออเดอร์นี้อยู่ใน ORDER_DB แล้ว");
    }
    toast(result.message);
    return;
  }
  state.syncedOrders = result.data.orders;
  state.selectedOrderIds = new Set();
  renderSyncOrders();
}

function renderSyncOrders() {
  el.syncCount.textContent = `${state.syncedOrders.length} ออเดอร์`;
  el.syncOrderList.innerHTML = state.syncedOrders.map((order) => {
    const itemCount = order.itemLines || order.items || 0;
    const platform = order.platformLabel || platformName(order.platform);
    const rowTag = order.alreadyIn ? "article" : "button";
    const rowType = order.alreadyIn ? "" : ' type="button"';
    const rowInteractive = order.alreadyIn ? "" : ' role="button" tabindex="0"';
    const importedActions = order.alreadyIn ? `
      <span class="syncRowButtons">
        <button type="button" class="secondary" data-edit-imported="${escapeHtml(order.awb)}">แก้ไข</button>
        <button type="button" class="dangerButton" data-delete-imported="${escapeHtml(order.awb)}">ลบ</button>
      </span>
    ` : "";
    return `
      <${rowTag}${rowType} class="syncOrderRow ${order.alreadyIn ? "already" : ""}" data-awb="${escapeHtml(order.awb)}"${rowInteractive}>
        <span class="syncCheck">${order.draft ? "รอแก้ไข" : (order.alreadyIn ? "นำเข้าแล้ว" : "")}</span>
        <span class="syncOrderBody">
          <span class="syncOrderTop">
            <b>${escapeHtml(order.awb)}</b>
            <span class="syncPlatform">${escapeHtml(platform)}</span>
          </span>
          <span class="syncOrderFields">
            ${syncField("เลขออเดอร์", order.orderNumber || "-")}
            ${syncField("ลูกค้า", order.buyer || "ไม่พบชื่อลูกค้า")}
            ${syncField("SKU", productSkuText(order.productName, order.sku))}
            ${syncField("ขนส่ง", order.carrier || "-")}
            ${syncField("จำนวน", `${itemCount || "-"} รายการ`)}
            ${syncField("วันที่นำเข้า", formatOptionalDateTime(order.importedAt))}
          </span>
        </span>
        <span class="syncRowActions">
          <em>${escapeHtml(order.draft ? "draft" : (order.status || "ready"))}</em>
          ${importedActions}
        </span>
      </${rowTag}>
    `;
  }).join("");
  el.syncOrderList.querySelectorAll(".syncOrderRow:not(.already)").forEach((row) => {
    row.addEventListener("click", () => toggleOrderSelection(row.dataset.awb));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleOrderSelection(row.dataset.awb);
      }
    });
  });
  el.syncOrderList.querySelectorAll("[data-edit-imported]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      openImportedOrderEditor(button.dataset.editImported);
    });
  });
  el.syncOrderList.querySelectorAll("[data-delete-imported]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await deleteImportedOrder(button.dataset.deleteImported);
    });
  });
  updateImportButton();
}

function syncField(label, value) {
  return `
    <span class="syncField">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
    </span>
  `;
}

function toggleOrderSelection(awb) {
  if (state.selectedOrderIds.has(awb)) {
    state.selectedOrderIds.delete(awb);
  } else {
    state.selectedOrderIds.add(awb);
  }
  el.syncOrderList.querySelectorAll(".syncOrderRow").forEach((row) => {
    const selected = state.selectedOrderIds.has(row.dataset.awb);
    row.classList.toggle("selected", selected);
    if (!row.classList.contains("already")) row.querySelector(".syncCheck").textContent = selected ? "✓" : "";
  });
  updateImportButton();
}

function updateImportButton() {
  el.selectedCount.textContent = `เลือก ${state.selectedOrderIds.size} รายการ`;
  el.importOrdersBtn.disabled = state.selectedOrderIds.size === 0;
}

function selectAllSyncedOrders(doSelect) {
  state.syncedOrders.filter((order) => !order.alreadyIn).forEach((order) => {
    if (doSelect) state.selectedOrderIds.add(order.awb);
    else state.selectedOrderIds.delete(order.awb);
  });
  el.syncOrderList.querySelectorAll(".syncOrderRow").forEach((row) => {
    const selected = state.selectedOrderIds.has(row.dataset.awb);
    row.classList.toggle("selected", selected);
    if (!row.classList.contains("already")) row.querySelector(".syncCheck").textContent = selected ? "✓" : "";
  });
  updateImportButton();
}

function confirmAndImportSelectedOrders() {
  const count = state.selectedOrderIds.size;
  if (count === 0) return;
  const threshold = state.config?.integrations?.bulkImportConfirmThreshold ?? 5;
  if (count < threshold) {
    importSelectedOrders();
    return;
  }
  el.importConfirmText.textContent = `คุณกำลังจะนำเข้าออเดอร์ ${count} รายการ ต้องการดำเนินการต่อหรือไม่?`;
  el.importConfirmDialog.showModal();
}

async function importSelectedOrders() {
  const originalLabel = el.importOrdersBtn.textContent;
  el.importOrdersBtn.disabled = true;
  el.importOrdersBtn.textContent = "กำลังนำเข้า...";
  el.importSkippedList.classList.add("hidden");
  try {
    const result = await api("/api/orders/import", {
      awbs: Array.from(state.selectedOrderIds)
    });
    if (!result.ok) {
      toast(result.message);
      return;
    }
    el.importSummary.textContent = `นำเข้า ${result.data.importedCount} ออเดอร์แล้ว: ${result.data.imported.map((item) => item.awb).join(", ") || "-"}`;
    if (result.data.skipped?.length) {
      const reasonLabel = { already_in_order_db: "นำเข้าไปแล้ว", not_found: "ไม่พบออเดอร์นี้ใน sync pool" };
      el.importSkippedList.textContent = `ข้าม ${result.data.skipped.length} รายการ: ${result.data.skipped.map((item) => `${item.awb} (${reasonLabel[item.reason] || item.reason})`).join(", ")}`;
      el.importSkippedList.classList.remove("hidden");
    }
    toast(`นำเข้า ${result.data.importedCount} ออเดอร์สำเร็จ`);
    await syncOrders();
  } finally {
    el.importOrdersBtn.textContent = originalLabel;
    el.importOrdersBtn.disabled = state.selectedOrderIds.size === 0;
  }
}

function renderLabelPlatformOptions() {
  const platforms = state.config?.labelPrint?.enabledPlatforms || [];
  if (!el.labelPlatformSelect) return;
  el.labelPlatformSelect.innerHTML = platforms.map((platform) => `
    <option value="${escapeHtml(platform)}">${escapeHtml(platformName(platform))}</option>
  `).join("");
}

function handleLabelImagePreview() {
  const file = el.labelImageInput.files?.[0];
  if (!file) {
    labelImageDataUrl = "";
    el.labelPreviewWrap.classList.add("hidden");
    return;
  }
  const maxMb = state.config.labelPrint?.maxImageSizeMb;
  if (maxMb && file.size > maxMb * 1024 * 1024) {
    toast(`ไฟล์รูปใหญ่เกิน ${maxMb} MB`);
    el.labelImageInput.value = "";
    labelImageDataUrl = "";
    el.labelPreviewWrap.classList.add("hidden");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    labelImageDataUrl = String(reader.result || "");
    el.labelPreviewImg.src = labelImageDataUrl;
    el.labelPreviewWrap.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
}

async function submitLabel(event) {
  event.preventDefault();
  if (!labelImageDataUrl) {
    toast("กรุณาอัปโหลดรูปใบปะหน้า");
    return;
  }
  el.saveLabelBtn.disabled = true;
  try {
    const result = await api("/api/labels", {
      platform: el.labelPlatformSelect.value,
      date: el.labelDateInput.value,
      imageDataUrl: labelImageDataUrl,
      fileName: el.labelImageInput.files?.[0]?.name || "label.jpg"
    });
    if (!result.ok) {
      toast(result.message);
      return;
    }
    el.labelForm.reset();
    labelImageDataUrl = "";
    el.labelPreviewWrap.classList.add("hidden");
    renderLabelPlatformOptions();
    toast("บันทึกใบปะหน้าแล้ว");
    await loadLabels();
  } finally {
    el.saveLabelBtn.disabled = false;
  }
}

async function loadLabels() {
  const params = new URLSearchParams();
  if (el.labelDateFilter?.value) params.set("date", el.labelDateFilter.value);
  if (el.labelPlatformFilter?.value) params.set("platform", el.labelPlatformFilter.value);
  const query = params.toString();
  const result = await api(`/api/labels${query ? `?${query}` : ""}`);
  if (!result.ok) {
    toast(result.message);
    return;
  }
  state.labels = result.data.labels || [];
  state.labelSummary = {
    total: Number(result.data.total ?? state.labels.length),
    filtered: Number(result.data.filtered ?? state.labels.length)
  };
  renderLabels();
}

function renderLabels() {
  const total = state.labelSummary.total || 0;
  const searchQuery = String(state.labelSearchQuery || "").trim().toLowerCase();
  const visibleLabels = state.labels.filter((label) => {
    if (!searchQuery) return true;
    const haystack = [
      label.awb,
      label.orderNumber,
      label.carrier
    ].filter(Boolean).join(" ").toLowerCase();
    return haystack.includes(searchQuery);
  });
  const filtered = visibleLabels.length;
  el.labelCount.textContent = `แสดง ${filtered} / ทั้งหมด ${total} ใบปะหน้า`;
  el.labelFilterHint.textContent = [el.labelSearchInput?.value?.trim() || "", el.labelDateFilter?.value || "", platformName(el.labelPlatformFilter?.value || "")]
    .filter(Boolean)
    .join(" · ") || "พร้อมพิมพ์จากใบปะหน้าที่อัปโหลดแล้ว";

  el.labelList.innerHTML = visibleLabels.length ? visibleLabels.map((label) => {
    const imageSrc = resolveLabelPreviewSrc(label);
    return `
      <article class="labelCard" data-label-id="${escapeHtml(label.id)}">
        <button type="button" class="labelCardPreviewBtn" data-view-label="${escapeHtml(label.id)}" ${imageSrc ? "" : "disabled"}>
          ${imageSrc
            ? `<img class="labelCardThumb" src="${escapeHtml(imageSrc)}" alt="ใบปะหน้า ${escapeHtml(label.awb || label.orderNumber || label.id)}">`
            : `<div class="labelCardThumb labelCardThumbEmpty">ไม่มีภาพตัวอย่าง</div>`}
        </button>
        <div class="labelCardBody">
          <div class="labelCardHead">
            <b>${escapeHtml(label.awb || "-")}</b>
            <span class="labelStatusBadge ${escapeHtml(normalizeLabelStatus(label.status))}">${escapeHtml(labelStatusText(label.status))}</span>
          </div>
          <div class="labelMetaGrid">
            ${labelMetaRow("ลูกค้า", label.customerName || "-")}
            ${labelMetaRow("เลขออเดอร์", label.orderNumber || "-")}
            ${labelMetaRow("ขนส่ง", label.carrier || "-")}
            ${labelMetaRow("วันที่", label.date || "-")}
            ${labelMetaRow("แพลตฟอร์ม", platformName(label.platform) || "-")}
          </div>
          <div class="labelCardActions">
            <button type="button" class="secondary" data-view-label="${escapeHtml(label.id)}" ${imageSrc ? "" : "disabled"}>🔍 ดู</button>
            <button type="button" data-print-label="${escapeHtml(label.id)}" ${imageSrc ? "" : "disabled"}>🖨 ปริ้น</button>
          </div>
        </div>
      </article>
    `;
  }).join("") : `<div class="empty">ยังไม่มีใบปะหน้าที่ตรงกับตัวกรองนี้</div>`;

  el.labelList.querySelectorAll("[data-view-label]").forEach((button) => {
    button.addEventListener("click", () => openLabelPrintDialog(button.dataset.viewLabel));
  });
  el.labelList.querySelectorAll("[data-print-label]").forEach((button) => {
    button.addEventListener("click", () => openLabelPrintDialog(button.dataset.printLabel, { autoPrint: true }));
  });
}

function labelMetaRow(label, value) {
  return `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
}

function normalizeLabelStatus(status) {
  return String(status || "imported").trim().toLowerCase();
}

function labelStatusText(status) {
  const normalized = normalizeLabelStatus(status);
  if (normalized === "imported") return "พร้อมพิมพ์";
  if (normalized === "ready") return "พร้อมพิมพ์";
  if (normalized === "manual-required") return "ต้องกรอกเลขออเดอร์";
  if (normalized === "skipped") return "ข้าม";
  return normalized || "-";
}

function resolveLabelPreviewSrc(label) {
  return label.imageDataUrl || label.imageUrl || "";
}

function openLabelPrintDialog(labelId, { autoPrint = false } = {}) {
  const label = state.labels.find((item) => item.id === labelId);
  if (!label) {
    toast("ไม่พบใบปะหน้าที่ต้องการ");
    return;
  }
  const imageSrc = resolveLabelPreviewSrc(label);
  if (!imageSrc) {
    toast("ใบปะหน้านี้ยังไม่มีไฟล์สำหรับพิมพ์");
    return;
  }

  state.activeLabelPreviewId = label.id;
  state.pendingLabelAutoPrint = autoPrint;
  el.labelPrintDialogTitle.textContent = label.awb || label.orderNumber || "ใบปะหน้า";
  el.labelPrintPreviewImg.src = imageSrc;
  el.labelPrintMeta.innerHTML = `
    ${syncField("AWB", label.awb || "-")}
    ${syncField("ลูกค้า", label.customerName || "-")}
    ${syncField("เลขออเดอร์", label.orderNumber || "-")}
    ${syncField("ขนส่ง", label.carrier || "-")}
    ${syncField("วันที่", label.date || "-")}
    ${syncField("สถานะ", labelStatusText(label.status))}
  `;
  if (el.labelPrintDialog.open) el.labelPrintDialog.close();
  el.labelPrintDialog.showModal();
  if (autoPrint) {
    setTimeout(() => {
      if (state.pendingLabelAutoPrint && el.labelPrintDialog.open) printActiveLabel();
    }, 120);
  }
}

function printActiveLabel() {
  const label = state.labels.find((item) => item.id === state.activeLabelPreviewId);
  if (!label) {
    toast("ไม่พบใบปะหน้าที่ต้องการพิมพ์");
    return;
  }
  state.pendingLabelAutoPrint = false;
  const imageSrc = resolveLabelPreviewSrc(label);
  if (!imageSrc) {
    toast("ใบปะหน้านี้ยังไม่มีไฟล์สำหรับพิมพ์");
    return;
  }
  const printWindow = window.open("", "_blank", "width=900,height=1200");
  if (!printWindow) {
    toast("เบราว์เซอร์บล็อกหน้าต่าง Print กรุณาอนุญาต pop-up");
    return;
  }
  const title = escapeHtml(label.awb || label.orderNumber || label.id);
  printWindow.document.write(`
    <html>
      <head>
        <title>Print ${title}</title>
        <style>
          @page {
            size: auto;
            margin: 0;
          }
          html, body {
            margin: 0;
            padding: 0;
            background: #fff;
            width: 100%;
            height: 100%;
            overflow: hidden;
          }
          .sheet {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100vh;
            display: flex;
            align-items: flex-start;
            justify-content: center;
            overflow: hidden;
            page-break-after: avoid;
          }
          img {
            display: block;
            width: auto;
            max-width: 100%;
            height: 100vh;
            max-height: 100vh;
            object-fit: contain;
            object-position: top center;
            margin: 0;
            padding: 0;
            page-break-inside: avoid;
          }
        </style>
      </head>
      <body>
        <div class="sheet">
          <img src="${escapeHtml(imageSrc)}" onload="window.print()" />
        </div>
        <script>
          window.onafterprint = () => window.close();
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

async function createManualOrder(event) {
  event.preventDefault();
  const result = await api("/api/orders/manual", {
    awb: el.manualAwbInput.value,
    orderNumber: el.manualOrderNumberInput.value,
    platform: el.manualPlatformSelect.value,
    buyer: el.manualBuyerInput.value,
    items: Number(el.manualItemCountInput.value)
  });
  if (!result.ok) {
    toast(result.message);
    return;
  }

  el.importSummary.textContent = `นำเข้าแบบฟอร์มแล้ว: ${result.data.awb} · ${result.data.platform} · ${result.data.itemLines} รายการ`;
  el.awbInput.value = result.data.awb;
  toast(`นำเข้า ${result.data.awb} สำเร็จ พร้อมยิงหน้า Pack Station`);
  clearManualOrderForm();
  await syncOrders();
}

function clearManualOrderForm() {
  el.manualOrderForm.reset();
  el.manualItemCountInput.value = "1";
}

function prefillManualOrderFormFromParsed(parsed = {}) {
  const platform = normalizePlatformValue(parsed.platform || parsed.platformLabel || "custom");
  el.manualAwbInput.value = parsed.awb || "";
  el.manualOrderNumberInput.value = parsed.orderNumber || "";
  el.manualPlatformSelect.value = platform;
  el.manualBuyerInput.value = parsed.customerName || "ไม่พบชื่อลูกค้า";
  el.manualItemCountInput.value = String(parsed.quantity || 1);
}

function openImportedOrderEditor(awb) {
  const order = state.syncedOrders.find((item) => item.awb === awb && item.alreadyIn);
  if (!order) {
    toast("ไม่พบออเดอร์ที่ต้องการแก้ไข");
    return;
  }
  state.editingImportedAwb = order.awb;
  el.editImportedAwb.value = order.awb;
  el.editImportedPlatform.value = normalizePlatformValue(order.platform);
  el.editImportedOrderNumber.value = order.orderNumber || "";
  el.editImportedBuyer.value = order.buyer || "";
  el.editImportedSku.value = order.sku || "";
  el.editImportedBarcode.value = order.barcode || order.awb || "";
  el.editImportedProductName.value = order.productName || "";
  el.editImportedQty.value = String(order.itemLines || 1);
  el.editImportedCarrier.value = order.carrier || "";
  el.editImportedOrderDialog.showModal();
}

async function saveImportedOrder(event) {
  event.preventDefault();
  if (!state.editingImportedAwb) return;

  el.saveImportedOrderBtn.disabled = true;
  try {
    const result = await api("/api/orders/update", {
      awb: state.editingImportedAwb,
      platform: el.editImportedPlatform.value,
      orderNumber: el.editImportedOrderNumber.value,
      buyer: el.editImportedBuyer.value,
      carrier: el.editImportedCarrier.value,
      itemLines: [{
        sku: el.editImportedSku.value,
        name: el.editImportedProductName.value,
        qty: Number(el.editImportedQty.value),
        barcode: el.editImportedBarcode.value
      }]
    });
    if (!result.ok) {
      toast(result.message);
      return;
    }

    el.editImportedOrderDialog.close();
    state.editingImportedAwb = "";
    toast(`อัปเดตออเดอร์ ${result.data.awb} แล้ว`);
    await syncOrders();
    if (el.labelList) {
      await loadLabels();
    }
  } finally {
    el.saveImportedOrderBtn.disabled = false;
  }
}

async function deleteImportedOrder(awb) {
  const order = state.syncedOrders.find((item) => item.awb === awb && item.alreadyIn);
  if (!order) {
    toast("ไม่พบออเดอร์ที่ต้องการลบ");
    return;
  }
  const confirmed = window.confirm(order.draft
    ? `ลบร่างใบปะหน้า ${awb} ใช่หรือไม่?`
    : `ลบออเดอร์ ${awb} ออกจาก ORDER_DB ใช่หรือไม่?`);
  if (!confirmed) return;

  const result = await api("/api/orders/delete", { awb });
  if (!result.ok) {
    toast(result.message);
    return;
  }

  if (state.editingImportedAwb === awb) {
    el.editImportedOrderDialog.close();
    state.editingImportedAwb = "";
  }
  state.syncedOrders = state.syncedOrders.filter((item) => item.awb !== awb);
  state.selectedOrderIds.delete(awb);
  renderSyncOrders();
  if (el.labelList) {
    await loadLabels();
  }
  const deletedLabels = Number(result.data?.deletedLabels || 0);
  toast(deletedLabels
    ? `ลบออเดอร์ ${awb} และใบปะหน้า ${deletedLabels} รายการแล้ว`
    : `ลบออเดอร์ ${awb} แล้ว`);
}

async function importLabelOrder(event) {
  event.preventDefault();
  const file = el.labelFileInput.files?.[0];
  if (!file) {
    toast("กรุณาเลือกไฟล์ใบปะหน้า");
    return;
  }
  el.labelImportBtn.disabled = true;
  el.labelImportStatus.textContent = "กำลังอัปโหลดไฟล์และอ่าน OCR บน server...";
  el.labelImportStatus.classList.remove("error", "success", "warning");
  el.labelImportPreview.classList.add("hidden");
  el.labelImportPreview.innerHTML = "";
  try {
    const result = await apiFile(`/api/orders/label/import?fileName=${encodeURIComponent(file.name)}`, file);
    if (!result.ok) {
      el.labelImportStatus.textContent = result.message || "อ่านใบปะหน้าไม่สำเร็จ";
      el.labelImportStatus.classList.remove("success", "warning");
      el.labelImportStatus.classList.add("error");
      renderLabelImportPreview(result.data || (result.data?.labelFile ? { labelFile: result.data.labelFile } : null));
      if (hasDuplicateImportRows(result.data)) {
        showWarningDialog("ห้ามสแกน/นำเข้าซ้ำ", duplicateImportWarning(result.data));
      }
      toast(result.message || "อ่านใบปะหน้าไม่สำเร็จ");
      return;
    }

    const parsed = result.data.parsed;
    const order = result.data.order;
    const manualCorrections = Array.isArray(result.data.manualCorrections) ? result.data.manualCorrections : [];
    const warnings = Array.isArray(result.data.warnings) ? result.data.warnings : [];
    const importedCount = result.data.importedCount ?? (order ? 1 : 0);
    const skippedCount = result.data.skippedCount ?? 0;
    const totalItems = result.data.totalLabels ?? result.data.totalPages ?? 1;
    el.labelImportStatus.textContent = importedCount
      ? `นำเข้าแล้ว ${importedCount}/${totalItems} รายการ · ซ้ำ/ข้าม ${skippedCount} รายการ`
      : `ไม่มีออเดอร์ใหม่ · ซ้ำ/ข้าม ${skippedCount} รายการ`;
    el.labelImportStatus.classList.add(skippedCount ? "warning" : "success");
    renderLabelImportPreview(result.data);
    if (hasDuplicateImportRows(result.data)) {
      showWarningDialog("ห้ามสแกน/นำเข้าซ้ำ", duplicateImportWarning(result.data));
    }
    if (manualCorrections.length) {
      const first = manualCorrections[0];
      prefillManualOrderFormFromParsed(first.parsed);
      el.importSummary.textContent = `OCR อ่าน AWB ได้แล้ว แต่ยังขาดเลขออเดอร์: ${first.parsed?.awb || "-"} · กรุณากรอกแบบแมนนวลต่อ`;
      el.labelImportStatus.textContent = `OCR อ่านได้บางส่วน · ต้องกรอกเลขออเดอร์เพิ่ม ${manualCorrections.length} รายการ`;
      el.labelImportStatus.classList.remove("success");
      el.labelImportStatus.classList.add("warning");
      toast(`พบ AWB ${first.parsed?.awb || "-"} แต่ไม่มีเลขออเดอร์ กรุณากรอกแบบแมนนวล`);
      el.manualOrderNumberInput.focus();
      el.manualOrderNumberInput.select();
    }
    if (warnings.length) {
      toast(warnings[0]);
    }
    if (order) {
      el.importSummary.textContent = `นำเข้าจากใบปะหน้าแล้ว: ${order.awb} · ${parsed.platformLabel} · ${order.itemLines} รายการ`;
      el.awbInput.value = order.awb;
      toast(`นำเข้าใบปะหน้า ${order.awb} สำเร็จ พร้อมยิงหน้า Pack Station`);
    } else if (!manualCorrections.length) {
      el.importSummary.textContent = result.message || "ไม่มีออเดอร์ใหม่จากใบปะหน้า";
      toast(result.message || "ไม่มีออเดอร์ใหม่จากใบปะหน้า");
    }
    if (skippedCount || manualCorrections.length) {
      el.syncStatus.value = "all";
    }
    await syncOrders();
  } finally {
    el.labelImportBtn.disabled = false;
  }
}

async function importLabelFromLabelsPage(event) {
  event.preventDefault();
  const file = el.labelLibraryFileInput.files?.[0];
  if (!file) {
    toast("กรุณาเลือกไฟล์ใบปะหน้า");
    return;
  }
  el.labelLibraryUploadBtn.disabled = true;
  setImportStatus(el.labelLibraryStatus, "กำลังอัปโหลดไฟล์และอ่าน OCR บน server...");
  el.labelLibraryPreview.classList.add("hidden");
  el.labelLibraryPreview.innerHTML = "";
  try {
    const result = await apiFile(`/api/orders/label/import?fileName=${encodeURIComponent(file.name)}`, file);
    if (!result.ok) {
      setImportStatus(el.labelLibraryStatus, result.message || "อ่านใบปะหน้าไม่สำเร็จ", "error");
      renderLabelImportPreviewInto(el.labelLibraryPreview, result.data || (result.data?.labelFile ? { labelFile: result.data.labelFile } : null));
      if (hasDuplicateImportRows(result.data)) {
        showWarningDialog("ห้ามสแกน/นำเข้าซ้ำ", duplicateImportWarning(result.data));
      }
      toast(result.message || "อ่านใบปะหน้าไม่สำเร็จ");
      return;
    }
    const manualCorrections = Array.isArray(result.data.manualCorrections) ? result.data.manualCorrections : [];
    const warnings = Array.isArray(result.data.warnings) ? result.data.warnings : [];
    const importedCount = result.data.importedCount ?? (result.data.order ? 1 : 0);
    const skippedCount = result.data.skippedCount ?? 0;
    const totalItems = result.data.totalLabels ?? result.data.totalPages ?? 1;
    const statusMessage = importedCount
      ? `นำเข้าแล้ว ${importedCount}/${totalItems} รายการ · ซ้ำ/ข้าม ${skippedCount} รายการ`
      : `ไม่มีออเดอร์ใหม่ · ซ้ำ/ข้าม ${skippedCount} รายการ`;
    setImportStatus(el.labelLibraryStatus, statusMessage, skippedCount ? "warning" : "success");
    renderLabelImportPreviewInto(el.labelLibraryPreview, result.data);
    if (hasDuplicateImportRows(result.data)) {
      showWarningDialog("ห้ามสแกน/นำเข้าซ้ำ", duplicateImportWarning(result.data));
    }
    if (manualCorrections.length) {
      const first = manualCorrections[0];
      prefillManualOrderFormFromParsed(first.parsed);
      setImportStatus(
        el.labelLibraryStatus,
        `OCR อ่านได้บางส่วน · ต้องกรอกเลขออเดอร์เพิ่ม ${manualCorrections.length} รายการ`,
        "warning"
      );
      el.importSummary.textContent = `OCR อ่าน AWB ได้แล้ว แต่ยังขาดเลขออเดอร์: ${first.parsed?.awb || "-"} · กรุณากรอกแบบแมนนวลต่อ`;
      toast(`พบ AWB ${first.parsed?.awb || "-"} แต่ไม่มีเลขออเดอร์ กรุณากรอกแบบแมนนวล`);
      el.manualOrderNumberInput.focus();
      el.manualOrderNumberInput.select();
    }
    if (warnings.length) {
      toast(warnings[0]);
    }
    if (skippedCount || manualCorrections.length) {
      el.syncStatus.value = "all";
    }
    await syncOrders();
    await loadLabels();
    updateLabelUploadFileName();
  } finally {
    el.labelLibraryUploadBtn.disabled = false;
  }
}

function clearLabelImport() {
  if (!el.labelImportForm || !el.labelImportStatus || !el.labelImportPreview) return;
  el.labelImportForm.reset();
  el.labelImportStatus.textContent = `OCR engine: ${state.config.ocr?.engine || "Tesseract"} · ภาษา ${state.config.ocr?.languages || "tha+eng"}`;
  el.labelImportStatus.classList.remove("error", "success", "warning");
  el.labelImportPreview.innerHTML = "";
  el.labelImportPreview.classList.add("hidden");
}

function clearLabelLibraryUpload() {
  el.labelLibraryUploadForm?.reset();
  updateLabelUploadFileName();
  setImportStatus(el.labelLibraryStatus, `OCR engine: ${state.config.ocr?.engine || "Tesseract"} · ภาษา ${state.config.ocr?.languages || "tha+eng"}`);
  el.labelLibraryPreview.classList.add("hidden");
  el.labelLibraryPreview.innerHTML = "";
}

function updateLabelUploadFileName() {
  const file = el.labelLibraryFileInput?.files?.[0];
  el.labelUploadFileName.textContent = file ? file.name : "ยังไม่ได้เลือกไฟล์";
}

function setImportStatus(target, message, tone = "") {
  if (!target) return;
  target.textContent = message;
  target.classList.remove("error", "success", "warning");
  if (tone) target.classList.add(tone);
}

function renderLabelImportPreview(data) {
  renderLabelImportPreviewInto(el.labelImportPreview, data);
}

function renderLabelImportPreviewInto(target, data) {
  if (!data) return;
  if (Array.isArray(data.imported) || Array.isArray(data.skipped) || Array.isArray(data.errors)) {
    const imported = data.imported || [];
    const skipped = data.skipped || [];
    const errors = data.errors || [];
    target.innerHTML = `
      <div class="labelImportBatch">
        <b>ผลอ่านทั้งหมด ${data.totalLabels || imported.length + skipped.length + errors.length} รายการ จาก ${data.totalPages || "-"} หน้า</b>
        ${imported.map((item) => labelImportResultRow("นำเข้าแล้ว", item.page, item.parsed, "success")).join("")}
        ${skipped.map((item) => labelImportResultRow(item.message || "ข้าม", item.page, item.parsed, item.code === "ORDER_NUMBER_REQUIRED" ? "error" : "warn")).join("")}
        ${errors.map((item) => `
          <div class="labelImportResult error">
            <span>หน้า ${escapeHtml(item.page || "-")}</span>
            <b>${escapeHtml(item.message || item.code || "อ่านไม่สำเร็จ")}</b>
          </div>
        `).join("")}
      </div>
    `;
    target.classList.remove("hidden");
    return;
  }
  const parsed = data.parsed || {};
  const labelFile = data.labelFile || data.order?.labelFile || {};
  const rows = [
    ["Platform", parsed.platformLabel],
    ["เลขออเดอร์", parsed.orderNumber],
    ["AWB", parsed.awb],
    ["ชื่อลูกค้า", parsed.customerName],
    ["SKU", productSkuText(parsed.productName, parsed.sku)],
    ["จำนวนสินค้า", parsed.quantity],
    ["ขนส่ง", parsed.carrier],
    ["ใบปะหน้าต้นฉบับ", labelFile.fileName]
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");
  target.innerHTML = `
    <div class="labelImportRows">
      ${rows.map(([label, value]) => `
        <div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>
      `).join("")}
    </div>
  `;
  target.classList.remove("hidden");
}

function labelImportResultRow(status, page, parsed, tone) {
  return `
    <div class="labelImportResult ${tone}">
      <span>หน้า ${escapeHtml(page || "-")}</span>
      <b>${escapeHtml(parsed?.awb || "-")} · ${escapeHtml(parsed?.platformLabel || parsed?.platform || "-")}</b>
      <small>${escapeHtml(status)} · Order ${escapeHtml(parsed?.orderNumber || "-")} · SKU ${escapeHtml(productSkuText(parsed?.productName, parsed?.sku))}</small>
    </div>
  `;
}

function productSkuText(productName = "", sku = "") {
  const cleanName = String(productName || "").trim();
  const cleanSku = String(sku || "").trim();
  if (cleanName && cleanSku) return `${cleanName} · ${cleanSku}`;
  if (cleanName) return `${cleanName} · SKU ว่าง`;
  if (cleanSku) return cleanSku;
  return "ว่าง / รอเติมจากไฟล์ออเดอร์";
}

function renderUserFormOptions() {
  if (!can("users:manage")) return;
  el.userRoleSelect.innerHTML = state.config.auth.roles.map((role) => `
    <option value="${escapeHtml(role.id)}">${escapeHtml(role.label)}</option>
  `).join("");
  el.employeeNameOptions.innerHTML = state.config.employees.list.map((employee) => `
    <option value="${escapeHtml(employee.name)}">${escapeHtml(employee.id)}</option>
  `).join("");
  el.employeeIdOptions.innerHTML = state.config.employees.list.map((employee) => `
    <option value="${escapeHtml(employee.id)}">${escapeHtml(employee.name)}</option>
  `).join("");
  renderPermissionMatrix(selectedRole()?.modulePermissions || [], true);
}

async function loadUsers() {
  if (!can("users:manage")) return;
  const result = await api("/api/users");
  if (!result.ok) {
    toast(result.message);
    return;
  }
  state.users = result.data.users;
  state.auditLogs = result.data.auditLogs || [];
  state.activityLogs = result.data.activityLogs || [];
  renderUsers();
  renderAuditLogs();
  renderActivityFilter();
  renderActivityLogs();
}

function renderUsers() {
  el.userCount.textContent = `${state.users.length} users`;
  el.userList.innerHTML = state.users.map((user) => `
    <article class="userRow ${user.active ? "" : "disabled"}">
      <div>
        <b>${escapeHtml(user.name)}</b>
        <small>${escapeHtml(user.email)} · ${escapeHtml(formatUserEmployee(user))}</small>
      </div>
      <div>
        <span class="rolePill">${escapeHtml(user.roleLabel)}</span>
        <small>${escapeHtml(permissionSummary(user.modulePermissions))}</small>
      </div>
      <em>${user.active ? "Active" : "Disabled"}</em>
      <div class="userActions">
        <button type="button" class="secondary" data-edit-user="${escapeHtml(user.email)}">แก้ไข</button>
        <button type="button" class="dangerButton" data-delete-user="${escapeHtml(user.email)}" ${canDeleteUser(user) ? "" : "disabled"}>ลบ</button>
      </div>
    </article>
  `).join("");
  el.userList.querySelectorAll("[data-edit-user]").forEach((button) => {
    button.addEventListener("click", () => editUser(button.dataset.editUser));
  });
  el.userList.querySelectorAll("[data-delete-user]").forEach((button) => {
    button.addEventListener("click", () => deleteUser(button.dataset.deleteUser));
  });
}

function canDeleteUser(user) {
  const actorRole = state.currentUser?.roleId || "";
  if (!["owner", "admin"].includes(actorRole)) return false;
  if (user.email === state.currentUser?.email) return false;
  if (user.roleId === "owner") return false;
  return true;
}

async function createUser(event) {
  event.preventDefault();
  const isEdit = Boolean(state.editingUserEmail);
  if (!isEdit && !el.userPasswordInput.value) {
    toast("กรุณากรอกรหัสผ่านเริ่มต้น");
    return;
  }
  const payload = {
    name: el.userNameInput.value,
    email: el.userEmailInput.value,
    employeeName: el.userEmployeeNameInput.value,
    employeeId: el.userEmployeeIdInput.value,
    roleId: el.userRoleSelect.value,
    roleName: el.customRoleNameInput.value,
    modulePermissions: collectPermissionMatrix(),
    password: el.userPasswordInput.value,
    active: el.userActiveInput.checked
  };
  const result = await api(isEdit ? "/api/users/update" : "/api/users", payload);
  if (!result.ok) {
    toast(result.message);
    return;
  }
  resetUserForm();
  toast(result.message || "สร้าง User แล้ว");
  await loadUsers();
  await loadActivityLogs();
}

async function deleteUser(email) {
  const user = state.users.find((item) => item.email === email);
  if (!user || !canDeleteUser(user)) {
    toast("บัญชีนี้ไม่สามารถลบได้ตามสิทธิ์ที่กำหนด");
    return;
  }
  const confirmed = window.confirm(`ยืนยันลบผู้ใช้งาน ${user.name} (${user.email}) ?`);
  if (!confirmed) return;
  const result = await api("/api/users/delete", { email });
  if (!result.ok) {
    toast(result.message);
    return;
  }
  state.users = state.users.filter((item) => item.email !== email);
  renderUsers();
  toast(result.message || "ลบผู้ใช้งานสำเร็จ");
  await loadUsers();
  await loadActivityLogs();
}

function renderPermissionMatrix(modulePermissions = [], readOnly = false) {
  const permissions = state.config.auth.modules.map((module) => {
    const current = modulePermissions.find((item) => item.moduleId === module.id) || {};
    return { module, canView: Boolean(current.canView), canEdit: Boolean(current.canEdit) };
  });
  el.permissionMatrix.innerHTML = `
    <div class="permissionHead">
      <span>โมดูล</span>
      <span>ดู</span>
      <span>แก้ไข</span>
    </div>
    ${permissions.map(({ module, canView, canEdit }) => `
      <label class="permissionRow" data-module-id="${escapeHtml(module.id)}">
        <span>
          <b>${escapeHtml(module.label)}</b>
          <small>${escapeHtml(module.section)}</small>
        </span>
        <input type="checkbox" data-permission-field="canView" ${canView ? "checked" : ""} ${readOnly ? "disabled" : ""}>
        <input type="checkbox" data-permission-field="canEdit" ${canEdit ? "checked" : ""} ${readOnly ? "disabled" : ""}>
      </label>
    `).join("")}
  `;
  el.permissionMatrix.querySelectorAll("[data-permission-field='canEdit']").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) return;
      const row = checkbox.closest(".permissionRow");
      row.querySelector("[data-permission-field='canView']").checked = true;
    });
  });
}

function collectPermissionMatrix() {
  return [...el.permissionMatrix.querySelectorAll(".permissionRow")].map((row) => ({
    moduleId: row.dataset.moduleId,
    canView: row.querySelector("[data-permission-field='canView']").checked,
    canEdit: row.querySelector("[data-permission-field='canEdit']").checked
  }));
}

function selectedRole() {
  return state.config.auth.roles.find((role) => role.id === el.userRoleSelect.value);
}

function syncEmployeeFromName() {
  const value = el.userEmployeeNameInput.value.trim();
  const employee = state.config.employees.list.find((item) => item.name === value);
  if (employee) el.userEmployeeIdInput.value = employee.id;
}

function syncEmployeeFromId() {
  const value = el.userEmployeeIdInput.value.trim();
  const employee = state.config.employees.list.find((item) => item.id === value);
  if (employee) el.userEmployeeNameInput.value = employee.name;
}

function editUser(email) {
  const user = state.users.find((item) => item.email === email);
  if (!user) return;
  state.editingUserEmail = user.email;
  el.userFormTitle.textContent = `แก้ไข ${user.email}`;
  el.submitUserBtn.textContent = "บันทึก User";
  el.userNameInput.value = user.name;
  el.userEmailInput.value = user.email;
  el.userEmailInput.readOnly = true;
  el.userEmployeeNameInput.value = user.employeeName || employeeNameForId(user.employeeId) || "";
  el.userEmployeeIdInput.value = user.employeeId || "";
  el.userRoleSelect.value = user.roleId;
  el.customRoleNameInput.value = user.roleName || "";
  el.customRoleNameRow.classList.toggle("hidden", user.roleId !== "custom");
  el.userPasswordInput.value = "";
  el.userActiveInput.checked = user.active;
  renderPermissionMatrix(user.modulePermissions || [], user.roleId !== "custom");
}

function resetUserForm() {
  state.editingUserEmail = "";
  el.userForm.reset();
  el.userEmailInput.readOnly = false;
  el.userActiveInput.checked = true;
  el.userFormTitle.textContent = "สร้างบัญชีใหม่";
  el.submitUserBtn.textContent = "สร้าง User";
  el.customRoleNameRow.classList.add("hidden");
  renderUserFormOptions();
}

function permissionSummary(modulePermissions = []) {
  return modulePermissions
    .filter((permission) => permission.canView)
    .map((permission) => {
      const module = state.config.auth.modules.find((item) => item.id === permission.moduleId);
      return `${module?.label || permission.moduleId}${permission.canEdit ? " (แก้ไข)" : " (ดู)"}`;
    })
    .join(", ") || "ไม่มีสิทธิ์";
}

function formatUserEmployee(user) {
  if (!user.employeeId && !user.employeeName) return "no employee";
  const employeeName = user.employeeName || employeeNameForId(user.employeeId);
  if (employeeName && user.employeeId) return `${employeeName} (${user.employeeId})`;
  return employeeName || user.employeeId;
}

function employeeNameForId(employeeId) {
  if (!employeeId) return "";
  return state.config.employees.list.find((employee) => employee.id === employeeId)?.name || "";
}

function renderAuditLogs() {
  el.auditCount.textContent = `${state.auditLogs.length} events`;
  el.auditList.innerHTML = state.auditLogs.length ? state.auditLogs.map((log) => `
    <div class="auditRow">
      <b>${escapeHtml(log.action)}</b>
      <span>${escapeHtml(log.details)}</span>
      ${(log.changes || []).map((change) => `
        <small>${escapeHtml(change.label)}: ${escapeHtml(change.before ?? "-")} → ${escapeHtml(change.after ?? "-")}</small>
      `).join("")}
      <small>${escapeHtml(log.actorEmail)} · ${formatDateTime(log.at)}</small>
    </div>
  `).join("") : `<div class="empty">ยังไม่มี audit log จากการจัดการ user ใน session นี้</div>`;
}

function renderActivityFilter() {
  const selected = el.activityUserFilter.value;
  el.activityUserFilter.innerHTML = `<option value="">ทุก User</option>` + state.users.map((user) => `
    <option value="${escapeHtml(user.email)}">${escapeHtml(user.name)} · ${escapeHtml(user.email)}</option>
  `).join("");
  el.activityUserFilter.value = selected;
}

async function loadActivityLogs() {
  if (!can("users:manage")) return;
  const query = el.activityUserFilter.value ? `?email=${encodeURIComponent(el.activityUserFilter.value)}` : "";
  const result = await api(`/api/users/activity${query}`);
  if (!result.ok) {
    toast(result.message);
    return;
  }
  state.activityLogs = result.data || [];
  renderActivityLogs();
}

function renderActivityLogs() {
  el.activityCount.textContent = `${state.activityLogs.length} events`;
  el.activityList.innerHTML = state.activityLogs.length ? state.activityLogs.map((log) => `
    <div class="auditRow">
      <b>${escapeHtml(log.action)} · ${escapeHtml(log.moduleId)}</b>
      <span>${escapeHtml(log.details || "-")}</span>
      <small>${escapeHtml(log.userEmail)}${log.targetEmail ? ` → ${escapeHtml(log.targetEmail)}` : ""} · ${formatDateTime(log.at)}</small>
    </div>
  `).join("") : `<div class="empty">ยังไม่มีประวัติการทำงานของ User ตามตัวกรองนี้</div>`;
}

async function startSession(awb) {
  const result = await api("/api/pack/start", {
    awb,
    employeeId: state.config.employees.defaultEmployeeId,
    stationId: state.config.station.defaultStationId,
    storageTargetId: deviceSettings.storageTargetId
  });

  if (!result.ok) {
    toast(result.message);
    return;
  }

  state.session = result.data;
  state.record = null;
  renderSession();
  setPackStage("pack");
  await startCamera();
  toast("เปิด pack session แล้ว");
  setTimeout(() => el.scanInput.focus(), 50);
}

async function scanCode(code) {
  if (!state.session) return;
  const result = await api("/api/pack/scan", {
    sessionId: state.session.id,
    code
  });

  if (!result.ok) {
    if (result.code === "MISSING_ITEMS") {
      state.session = result.data.session;
      showForceCloseDialog(result.data.missingItems);
      return;
    }
    if (result.data) state.session = result.data;
    renderSession();
    toast(result.message);
    return;
  }

  if (result.data.closeRequested) {
    await closeCurrentSession();
    return;
  }

  state.session = result.data;
  renderSession();
  toast(result.message || "บันทึก scan แล้ว");
}

async function closeCurrentSession() {
  if (!state.session) return;
  const result = await api("/api/pack/close", {
    sessionId: state.session.id
  });

  if (!result.ok) {
    if (result.code === "MISSING_ITEMS" || result.code === "FORCE_CLOSE_REASON_REQUIRED") {
      state.session = result.data;
      showForceCloseDialog(state.session.items.filter((item) => item.scannedQty < item.qty));
      return;
    }
    toast(result.message);
    return;
  }

  completeSession(result.data);
}

async function forceClose() {
  const result = await api("/api/pack/close", {
    sessionId: state.session.id,
    force: true,
    reason: el.forceReason.value
  });

  if (!result.ok) {
    toast(result.message);
    showForceCloseDialog(state.session.items.filter((item) => item.scannedQty < item.qty));
    return;
  }

  completeSession(result.data);
}

function completeSession(data) {
  state.session = data.session;
  state.record = data.record;
  setPackStage("upload");
  (async () => {
    const video = await stopAndUploadRecording(state.record);
    if (video) state.record.video = video;
    if (!video) state.record.videoMissingReason = missingVideoReason();
    stopCamera();
    await runUploadSimulation(video);
    renderComplete();
    setPackStage("complete");
    loadReports();
    toast(video ? "บันทึก record และวิดีโอสำเร็จ" : "บันทึกออเดอร์แล้ว แต่ไม่มีไฟล์วิดีโอ");
  })();
}

function renderSession() {
  const session = state.session;
  el.activeAwb.textContent = session.awb;
  el.activePlatform.textContent = session.platform;
  el.activeStation.textContent = session.stationId;
  el.employeeId.textContent = session.employeeId;
  el.startedAt.textContent = formatDateTime(session.startedAt);
  el.sessionStatus.textContent = session.status;
  el.itemCount.textContent = `${session.summary.scannedLineCount}/${session.summary.totalLineCount}`;
  el.progressText.textContent = `${session.summary.scannedQty}/${session.summary.totalQty} ชิ้น`;
  el.progressFill.style.width = `${session.summary.progressPct}%`;

  el.itemList.innerHTML = session.items.map((item) => {
    const complete = item.scannedQty >= item.qty;
    return `
      <div class="itemRow ${complete ? "complete" : ""}">
        <div class="check">${complete ? "✓" : ""}</div>
        <div>
          <div class="itemName">${escapeHtml(item.name)}</div>
          <div class="itemSku">AWB: ${escapeHtml(session.awb)} · SKU: ${escapeHtml(item.sku || "-")} · Barcode: ${escapeHtml(item.barcode || "-")}</div>
        </div>
        <div class="qty">${item.scannedQty}/${item.qty}</div>
      </div>
    `;
  }).join("");
}

function renderComplete() {
  const record = state.record;
  const hasVideo = Boolean(record.video);
  el.completeTitle.textContent = hasVideo ? "บันทึกสำเร็จ" : "บันทึกออเดอร์สำเร็จ แต่ไม่มีวิดีโอ";
  el.receipt.innerHTML = `
    <div><span>AWB</span><b>${escapeHtml(record.awb)}</b></div>
    <div><span>Platform</span><b>${escapeHtml(record.platform)}</b></div>
    <div><span>สถานะ</span><b>${record.status === "pass" ? "ตรวจสอบผ่าน" : "ปิดก่อนสแกนครบ"}</b></div>
    <div><span>Video Status</span><b>${hasVideo ? "อัปโหลดวิดีโอแล้ว" : "ไม่มีไฟล์วิดีโอ"}</b></div>
    <div><span>รายการสินค้า</span><b>${escapeHtml(record.itemSummary)}</b></div>
    <div><span>เวลา</span><b>${record.durationSeconds}s</b></div>
    <div><span>Storage</span><b>${escapeHtml(record.storage.provider)}</b></div>
    <div><span>Target</span><b>${escapeHtml(record.storage.label ?? record.storage.targetId ?? "-")}</b></div>
    <div><span>Video File</span><b>${hasVideo ? `${escapeHtml(record.video.fileName)} (${record.video.sizeMb} MB)` : escapeHtml(record.videoMissingReason || "ไม่มีข้อมูลวิดีโอจากกล้อง")}</b></div>
    <div><span>Destination</span><b>${escapeHtml(videoDestinationLabel(record.video))}</b></div>
    <div><span>Link</span><b>${hasVideo && record.shareLink ? `<button type="button" class="linkButton" id="copyCompleteLinkBtn">คัดลอกลิงก์วิดีโอ</button>` : "ไม่มีลิงก์วิดีโอ"}</b></div>
  `;
  document.querySelector("#copyCompleteLinkBtn")?.addEventListener("click", () => copyText(record.shareLink));
}

async function loadReports() {
  const result = await api("/api/reports");
  if (!result.ok) return;
  state.records = result.data;
  populateEmployeeFilter();
  populateReportDateFilters();
  renderReports();
}

function renderReports() {
  const all = state.records || [];
  const records = filterRecords(all);
  updateReportStats(records, all.length);
  el.reportsBody.innerHTML = records.map((record) => `
    <tr data-record-id="${record.id}">
      <td class="awbCell">${escapeHtml(record.awb)}</td>
      <td>${platformPillHtml(record.platform)}</td>
      <td class="mutedCell">${escapeHtml(record.employeeId)}</td>
      <td class="mutedCell nowrap">${formatDateTime(record.startedAt)}</td>
      <td class="mutedCell">${record.durationSeconds}s</td>
      <td class="mutedCell">${record.sizeMb ?? "-"} MB</td>
      <td>${statusBadgeHtml(record.status)}</td>
      <td>${storagePillHtml(record)}</td>
      <td>${renderReportActionButtons(record)}</td>
    </tr>
  `).join("");
  el.reportsEmpty.style.display = records.length ? "none" : "block";
  el.reportsBody.querySelectorAll("tr").forEach((row) => {
    row.addEventListener("click", (event) => {
      const openButton = event.target.closest("[data-open-url]");
      if (openButton) {
        window.open(openButton.dataset.openUrl, "_blank", "noopener");
        return;
      }
      const copyButton = event.target.closest("[data-copy-value]");
      if (copyButton) {
        copyText(copyButton.dataset.copyValue, copyButton.dataset.copyLabel);
        return;
      }
      const openRecordButton = event.target.closest("[data-open-record]");
      if (openRecordButton) {
        openRecordDetail(openRecordButton.dataset.openRecord);
        return;
      }
      openRecordDetail(row.dataset.recordId);
    });
  });
}

function updateReportStats(records, totalCount) {
  const passCount = records.filter((record) => record.status === "pass").length;
  const warnCount = records.filter((record) => record.status === "warn").length;
  const totalMb = records.reduce((sum, record) => sum + Number(record.sizeMb || 0), 0);
  el.statTotal.textContent = records.length;
  el.statPass.textContent = passCount;
  el.statWarn.textContent = warnCount;
  el.statSize.textContent = totalMb >= 1024 ? `${(totalMb / 1024).toFixed(1)} GB` : `${totalMb.toFixed(0)} MB`;
  el.reportSummary.textContent = records.length < totalCount
    ? `กรองแล้ว ${records.length} / ${totalCount} รายการ`
    : `ทั้งหมด ${totalCount} รายการ`;
}

function platformPillHtml(platform) {
  const normalized = String(platform || "").toLowerCase();
  const cls = normalized.includes("shopee") ? "shopee"
    : normalized.includes("lazada") ? "lazada"
      : normalized.includes("tiktok") ? "tiktok"
        : "custom";
  const label = normalized === "custom" ? "ทั่วไป" : platform;
  return `<span class="platformPill ${cls}">${escapeHtml(label)}</span>`;
}

function statusBadgeHtml(status) {
  if (status === "pass") return `<span class="statusBadge pass">ผ่าน</span>`;
  if (status === "warn") return `<span class="statusBadge warn">มีข้อสังเกต</span>`;
  return `<span class="statusBadge">${escapeHtml(status)}</span>`;
}

function storagePillHtml(record) {
  const provider = record.storage?.provider || "-";
  const icon = provider === "local" ? "💾" : provider === "nas" ? "🗄️" : "☁️";
  const label = provider === "nas" ? "NAS" : provider === "local" ? "local" : provider === "cloud-sync" ? "Cloud Sync" : provider;
  return `
    <div class="storageActionWrap">
      <span class="storagePill">${icon} ${escapeHtml(label)}</span>
    </div>
  `;
}

function renderReportActionButtons(record) {
  if (!record.video || !record.shareLink) {
    return `<div class="actionCell"><button type="button" class="iconBtn primary" data-open-record="${escapeHtml(record.id)}">▶ ดู</button><span class="muted">ไม่มีวิดีโอ</span></div>`;
  }
  return `
    <div class="actionCell">
      <button type="button" class="iconBtn primary" data-open-record="${escapeHtml(record.id)}">▶ ดู</button>
    </div>
  `;
}

function filterRecords(records) {
  const q = el.reportSearch.value.trim().toLowerCase();
  const status = el.statusFilter.value;
  const platform = el.platformFilter.value;
  const employee = el.employeeFilter.value;
  const selectedDay = Number(el.reportDayFilter.value || 0);
  const selectedMonth = Number(el.reportMonthFilter.value || 0);
  const selectedYear = Number(el.reportYearFilter.value || 0);
  return records.filter((record) => {
    const haystack = `${record.awb} ${record.platform} ${record.employeeId} ${record.stationId}`.toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (status && record.status !== status) return false;
    if (platform && record.platform !== platform) return false;
    if (employee && record.employeeId !== employee) return false;
    const startedAt = new Date(record.startedAt);
    if (selectedDay && startedAt.getDate() !== selectedDay) return false;
    if (selectedMonth && startedAt.getMonth() + 1 !== selectedMonth) return false;
    if (selectedYear && startedAt.getFullYear() !== selectedYear) return false;
    return true;
  });
}

function populateEmployeeFilter() {
  const selected = el.employeeFilter.value;
  const employees = [...new Set((state.records || []).map((record) => record.employeeId))].sort();
  el.employeeFilter.innerHTML = `<option value="">ทุกพนักงาน</option>` + employees.map((employee) => `
    <option value="${escapeHtml(employee)}">${escapeHtml(employee)}</option>
  `).join("");
  el.employeeFilter.value = selected;
}

function populateReportDateFilters() {
  const selectedDay = el.reportDayFilter.value;
  const selectedMonth = el.reportMonthFilter.value;
  const selectedYear = el.reportYearFilter.value;
  const years = [...new Set((state.records || []).map((record) => new Date(record.startedAt).getFullYear()).filter(Boolean))].sort((a, b) => b - a);

  el.reportDayFilter.innerHTML = `<option value="">📅 ทุกวัน</option>` + Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    return `<option value="${day}">${String(day).padStart(2, "0")}</option>`;
  }).join("");

  el.reportMonthFilter.innerHTML = `<option value="">🗓️ ทุกเดือน</option>` + Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    const label = new Date(2026, index, 1).toLocaleString("th-TH", { month: "long" });
    return `<option value="${month}">${String(month).padStart(2, "0")} · ${label}</option>`;
  }).join("");

  el.reportYearFilter.innerHTML = `<option value="">📆 ทุกปี</option>` + years.map((year) => `
    <option value="${year}">${year}</option>
  `).join("");

  el.reportDayFilter.value = selectedDay;
  el.reportMonthFilter.value = selectedMonth;
  el.reportYearFilter.value = selectedYear;
}

function openRecordDetail(recordId) {
  const record = (state.records || []).find((item) => item.id === recordId);
  if (!record) return;
  el.detailAwb.textContent = record.awb;
  el.detailShareLink.value = record.video && record.shareLink ? record.shareLink : "ไม่มีลิงก์วิดีโอ เพราะยังไม่มีไฟล์วิดีโอจริง";
  el.copyDetailLinkBtn.disabled = !(record.video && record.shareLink);
  el.detailVideoPlayer.innerHTML = record.video && record.shareLink
    ? `<div class="videoPlayerShell"><video class="recordVideo" src="${escapeHtml(record.shareLink)}" controls preload="metadata" playsinline></video><p class="videoPlaybackHint">กด ▶ เพื่อดูวิดีโอย้อนหลัง</p></div>`
    : `<div class="videoUnavailable"><span>ไม่มีวิดีโอ</span><b>${escapeHtml(record.videoMissingReason || "record นี้ยังไม่มีไฟล์วิดีโอจริง")}</b></div>`;
  el.detailVideoPlayer.querySelector("video")?.addEventListener("error", () => {
    const hint = el.detailVideoPlayer.querySelector(".videoPlaybackHint");
    if (hint) hint.textContent = "เปิดวิดีโอไม่ได้: ไฟล์เสียหรือ Browser ไม่รองรับไฟล์นี้";
    el.detailVideoPlayer.classList.add("playbackError");
  });
  const videoName = record.video?.fileName || "";
  const destination = videoDestinationLabel(record.video);
  el.detailReceipt.innerHTML = `
    <div><span>AWB</span><b>${escapeHtml(record.awb)}</b></div>
    <div><span>แพลตฟอร์ม</span><b>${platformPillHtml(record.platform)}</b></div>
    <div><span>ผู้บันทึก</span><b>${escapeHtml(record.employeeId)}</b></div>
    <div><span>วันที่ / เวลา</span><b>${formatDateTime(record.startedAt)}</b></div>
    <div><span>ระยะเวลา</span><b>${record.durationSeconds}s</b></div>
    <div><span>ขนาดไฟล์</span><b>${record.sizeMb ?? "-"} MB</b></div>
    <div><span>ไฟล์วิดีโอ</span><b class="ellipsisText" title="${escapeHtml(videoName)}">${record.video ? `${escapeHtml(truncateMiddle(videoName, 44))} (${record.video.sizeMb} MB)` : "ยังไม่มีไฟล์"}</b></div>
    <div><span>ปลายทางไฟล์</span><b class="detailPath ellipsisText" title="${escapeHtml(destination)}">${escapeHtml(truncateMiddle(destination, 56))}</b></div>
    <div><span>สถานี</span><b>${escapeHtml(record.stationId)}</b></div>
    <div><span>จัดเก็บที่</span><b>${escapeHtml(record.storage.provider)} · ${escapeHtml(record.storage.host)}</b></div>
    <div><span>สถานะ</span><b>${statusBadgeHtml(record.status)}</b></div>
  `;
  el.recordDetailDialog.showModal();
}

function showForceCloseDialog(missingItems) {
  const missingSkus = missingItems.map((item) => item.sku).filter(Boolean).join(", ") || "-";
  el.missingText.textContent = `AWB ${state.session?.awb || "-"} ยังขาด ${missingItems.length} รายการ: ${missingSkus} · ยิง AWB ซ้ำเพื่อยืนยันปิดกล่องได้`;
  el.forceReason.value = "";
  el.forceCloseDialog.showModal();
}

function setPackStage(stage) {
  el.scanPanel.classList.toggle("hidden", stage !== "scan");
  el.packPanel.classList.toggle("hidden", stage !== "pack");
  el.uploadPanel.classList.toggle("hidden", stage !== "upload");
  el.completePanel.classList.toggle("hidden", stage !== "complete");
  const order = ["scan", "pack", "upload", "complete"];
  el.stages.forEach((item) => {
    const current = item.dataset.stage;
    item.classList.toggle("active", current === stage);
    item.classList.toggle("done", order.indexOf(current) < order.indexOf(stage));
  });
}

async function runUploadSimulation(video) {
  const steps = state.config.upload.simulationSteps;
  el.uploadOrderLine.textContent = video
    ? `AWB: ${state.record.awb} · อัปโหลดไฟล์ ${video.fileName} ไปยัง ${video.storageLabel} แล้ว`
    : `AWB: ${state.record.awb} · ${missingVideoReason()} จึงบันทึกเฉพาะข้อมูลออเดอร์`;
  el.uploadFill.style.width = "0%";
  el.uploadPct.textContent = "0%";
  el.uploadSteps.innerHTML = steps.map((step) => `
    <div class="uploadStep" data-pct="${step.pct}">
      <span>○</span>
      <b>${escapeHtml(step.label)}</b>
    </div>
  `).join("");

  for (const step of steps) {
    await wait(360);
    el.uploadFill.style.width = `${step.pct}%`;
    el.uploadPct.textContent = `${step.pct}%`;
    el.uploadSteps.querySelectorAll(".uploadStep").forEach((row) => {
      const complete = Number(row.dataset.pct) <= step.pct;
      row.classList.toggle("done", complete);
      row.querySelector("span").textContent = complete ? "✓" : "○";
    });
  }
}

function resetFlow() {
  stopCamera();
  state.session = null;
  state.record = null;
  el.awbInput.value = "";
  el.scanInput.value = "";
  setPackStage("scan");
  setTimeout(() => el.awbInput.focus(), 50);
}

async function startCamera() {
  stopCamera();
  recordedChunks = [];
  recordingDiagnostics = resetRecordingDiagnostics();
  recSeconds = 0;
  el.recTimer.textContent = "00:00";
  try {
    mediaStream = await openCameraStream(deviceSettings.cameraDeviceId);
    recordingDiagnostics.cameraStarted = true;
    deviceConnection.cameraTestOk = true;
    el.webcamVideo.srcObject = mediaStream;
    el.noCamMsg.classList.add("hidden");
    el.recBadge.classList.add("show");
    startMediaRecorder(mediaStream);
    updateDeviceSummary();
  } catch (error) {
    recordingDiagnostics.cameraError = cameraErrorMessage(error);
    deviceConnection.cameraTestOk = false;
    el.webcamVideo.srcObject = null;
    el.noCamMsg.classList.remove("hidden");
    el.noCamMsg.textContent = cameraErrorMessage(error);
    el.recBadge.classList.remove("show");
    updateDeviceSummary();
    toast(cameraErrorMessage(error));
  }
  recTimerId = setInterval(() => {
    recSeconds += 1;
    const min = String(Math.floor(recSeconds / 60)).padStart(2, "0");
    const sec = String(recSeconds % 60).padStart(2, "0");
    el.recTimer.textContent = `${min}:${sec}`;
  }, 1000);
}

function stopCamera() {
  mediaRecorder = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }
  clearInterval(recTimerId);
  el.recBadge?.classList.remove("show");
}

function startMediaRecorder(stream) {
  if (!window.MediaRecorder) {
    recordingDiagnostics.recorderError = "Browser นี้ยังไม่รองรับการอัดวิดีโอ";
    toast("เบราว์เซอร์นี้ยังไม่รองรับการอัดวิดีโอ");
    return;
  }
  const preferredTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) || "";
  try {
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) {
        recordedChunks.push(event.data);
        recordingDiagnostics.chunks = recordedChunks.length;
        recordingDiagnostics.bytes += event.data.size;
      }
    });
    mediaRecorder.addEventListener("error", (event) => {
      recordingDiagnostics.recorderError = event.error?.message || "MediaRecorder error";
    });
    mediaRecorder.start(1000);
    recordingDiagnostics.recorderStarted = true;
    recordingDiagnostics.mimeType = mediaRecorder.mimeType || mimeType || "video/webm";
  } catch {
    recordingDiagnostics.recorderError = "เริ่มอัดวิดีโอไม่ได้";
    mediaRecorder = null;
    toast("เริ่มอัดวิดีโอไม่ได้");
  }
}

async function stopAndUploadRecording(record) {
  const blob = await stopRecordingBlob();
  if (!blob || blob.size === 0) return null;
  const params = new URLSearchParams({
    recordId: record.id,
    awb: record.awb,
    storageTargetId: record.storage.targetId
  });
  if (deviceSettings.customStoragePath) params.set("customPath", deviceSettings.customStoragePath);
  const response = await fetch(`/api/video/upload?${params.toString()}`, {
    method: "POST",
    headers: {
      ...(state.authToken ? { Authorization: `Bearer ${state.authToken}` } : {}),
      "Content-Type": blob.type || "video/webm"
    },
    body: blob
  });
  const result = await response.json();
  if (!result.ok) {
    recordingDiagnostics.uploadError = result.message || "อัปโหลดวิดีโอไม่สำเร็จ";
    toast(result.message || "อัปโหลดวิดีโอไม่สำเร็จ");
    return null;
  }
  return result.data;
}

function missingVideoReason() {
  if (!window.MediaRecorder) return "Browser นี้ยังไม่รองรับการอัดวิดีโอ";
  if (recordingDiagnostics.uploadError) return recordingDiagnostics.uploadError;
  if (recordingDiagnostics.cameraError) return recordingDiagnostics.cameraError;
  if (!mediaStream) return "กล้องไม่ได้เปิดหรือถูกบล็อก permission";
  if (recordingDiagnostics.recorderError) return recordingDiagnostics.recorderError;
  if (!recordingDiagnostics.cameraStarted) return "กล้องไม่ได้เริ่มทำงาน";
  if (!recordingDiagnostics.recorderStarted) return "ตัวอัดวิดีโอไม่ได้เริ่มทำงาน";
  if (!mediaRecorder) return "ตัวอัดวิดีโอไม่ได้เริ่มทำงาน";
  if (recordedChunks.length === 0) return "MediaRecorder ไม่ได้ส่งข้อมูลวิดีโอออกมา";
  return "ไม่พบไฟล์วิดีโอจากกล้อง";
}

function resetRecordingDiagnostics() {
  return {
    cameraStarted: false,
    cameraError: "",
    recorderStarted: false,
    recorderError: "",
    uploadError: "",
    mimeType: "",
    chunks: 0,
    bytes: 0
  };
}

function loadDeviceSettings() {
  const saved = JSON.parse(localStorage.getItem("smartrecord.deviceSettings") || "{}");
  const targets = state.config.upload.storageTargets || [];
  const defaultStorageTargetId = state.config.upload.defaultStorageTargetId || targets.find((target) => target.isDefault)?.id || targets[0]?.id || "";
  deviceSettings = {
    storageTargetId: saved.storageTargetId || defaultStorageTargetId,
    customStoragePath: saved.customStoragePath || "",
    cameraDeviceId: saved.cameraDeviceId || state.config.devices.camera.defaultDeviceId,
    printerDriverId: saved.printerDriverId || state.config.devices.labelPrinter.defaultDriverId,
    scannerMode: saved.scannerMode || state.config.devices.barcodeScanner.defaultMode
  };
}

function renderSettingsControls() {
  renderStorageCards();
  updateCustomPathUI();
  el.customStoragePathInput.value = deviceSettings.customStoragePath;

  el.cameraSelect.innerHTML = state.config.devices.camera.options.map((camera) => `
    <option value="${escapeHtml(camera.id)}">${escapeHtml(camera.label)}</option>
  `).join("");
  el.cameraSelect.value = deviceSettings.cameraDeviceId;
  refreshCameraDevices();

  renderPrinterOptions();
  el.printerDriverSelect.value = deviceSettings.printerDriverId;
  updatePrinterStatus();

  el.scannerModeSelect.innerHTML = state.config.devices.barcodeScanner.modes.map((mode) => `
    <option value="${escapeHtml(mode.id)}">${escapeHtml(mode.label)}</option>
  `).join("");
  el.scannerModeSelect.value = deviceSettings.scannerMode;
  updateStorageHint();
  renderPrePackImageSettings();
  updateDeviceSummary();
}

function applyPrePackGuideImage() {
  const url = state.config?.systemAssets?.prePackGuideImage?.url || "/assets/prepack-label-required.png";
  if (el.prePackGuideImg) el.prePackGuideImg.src = url;
  if (el.prePackImagePreview) el.prePackImagePreview.src = url;
}

function renderPrePackImageSettings() {
  applyPrePackGuideImage();
  const config = state.config.systemAssets?.prePackGuideImage || {};
  const maxMb = config.maxImageSizeMb || 5;
  const updatedAt = config.updatedAt ? ` · อัปเดตล่าสุด ${formatDateTime(config.updatedAt)}` : "";
  if (el.prePackImageStatus) {
    el.prePackImageStatus.textContent = `รองรับ PNG/JPG/WebP ไม่เกิน ${maxMb} MB · ไม่บังคับสัดส่วนภาพ${updatedAt}`;
    el.prePackImageStatus.classList.remove("error");
  }
  if (el.uploadPrePackImageBtn) el.uploadPrePackImageBtn.disabled = !canManageSystemAssets();
}

function renderStorageCards() {
  const targets = state.config.upload.storageTargets || [];
  const icons = { nas: "🖧", local: "💻", "cloud-sync": "☁" };
  const providerNames = { nas: "NAS", local: "เครื่องนี้", "cloud-sync": "Cloud Sync" };
  el.storageCardGroup.innerHTML = targets.map((target) => {
    const isSelected = target.id === deviceSettings.storageTargetId;
    const icon = icons[target.provider] || "💾";
    const providerName = providerNames[target.provider] || target.provider;
    const detail = target.provider === "nas"
      ? target.host
      : target.provider === "local"
        ? "บันทึกในเครื่องนี้"
        : "กรอก URL ปลายทาง";
    const statusBadge = storageTargetBadge(target);
    return `
      <button type="button" class="storageCard ${isSelected ? "selected" : ""}" data-target-id="${escapeHtml(target.id)}" aria-pressed="${isSelected}">
        <span class="storageCardIcon">${icon}</span>
        <span class="storageCardBody">
          <span class="storageCardLabel">${escapeHtml(target.label)}${statusBadge ? ` <span class="storageCardBadge ${escapeHtml(statusBadge.tone)}">${escapeHtml(statusBadge.label)}</span>` : ""}</span>
          <span class="storageCardMeta">${escapeHtml(providerName)} · ${escapeHtml(detail)}</span>
        </span>
        ${isSelected ? `<span class="storageCardCheck">✓</span>` : ""}
      </button>
    `;
  }).join("");
}

function updateCustomPathUI() {
  const selected = selectedStorageTarget();
  if (!selected) {
    el.storageCustomWrap?.classList.add("hidden");
    return;
  }
  const needsCustom = selected.provider === "cloud-sync"
    || selected.id === "custom-nas"
    || selected.label?.toLowerCase().includes("กำหนดเอง");
  const isCloud = selected.provider === "cloud-sync";
  el.storageCustomWrap?.classList.toggle("hidden", !needsCustom);
  if (el.customPathLabel) {
    el.customPathLabel.textContent = isCloud ? "Website URL หรือ Cloud Sync URL" : "Custom Path";
  }
  if (el.customStoragePathInput) {
    el.customStoragePathInput.placeholder = isCloud
      ? "https://drive.google.com/... หรือ URL ปลายทาง"
      : "เช่น /Volumes/SmartRecord/videos หรือ /data/smartrecord/videos";
  }
}

function updateStorageHint(serverStorage = null) {
  const selected = selectedStorageTarget();
  const customPath = el.customStoragePathInput.value.trim();
  const validation = validateCustomStoragePath(customPath, selected);
  const isInvalid = Boolean(customPath) && !validation.ok;
  const selectedProfile = storageTargetProfile(selected, customPath);
  el.customStoragePathInput.classList.toggle("invalid", isInvalid);
  el.customStoragePathInput.setAttribute("aria-invalid", isInvalid ? "true" : "false");
  el.saveSettingsBtn.disabled = !validation.ok;
  el.storageHint.classList.toggle("error", isInvalid);
  if (isInvalid) {
    el.storageHint.textContent = validation.message;
    return;
  }
  if (serverStorage) {
    if (serverStorage.externalUrl) {
      el.storageHint.textContent = `✓ ${serverStorage.message} · เขียนไฟล์จริงที่: ${serverStorage.actualWritePath || serverStorage.storageRoot} · ปลายทาง Cloud Sync: ${serverStorage.externalUrl}`;
      return;
    }
    if (serverStorage.mountedRequired) {
      el.storageHint.textContent = `จำลอง / ยังไม่ mount NAS · เขียนไฟล์จริงที่: ${serverStorage.actualWritePath || serverStorage.storageRoot} · NAS จะใช้งานจริงได้เมื่อ mount path แล้ว เช่น /Volumes/SmartRecord หรือ /data/smartrecord`;
      return;
    }
    el.storageHint.textContent = `✓ ${serverStorage.message} · เขียนไฟล์จริงที่: ${serverStorage.actualWritePath || serverStorage.storageRoot}`;
    return;
  }
  if (!selected) {
    el.storageHint.textContent = "ยังไม่ได้เลือกที่จัดเก็บ";
    return;
  }
  if (selectedProfile.externalUrl) {
    el.storageHint.textContent = `${storageModeHint(selected, selectedProfile)} · เขียนไฟล์จริงที่: ${selectedProfile.actualWritePath} · ปลายทาง Cloud Sync: ${selectedProfile.externalUrl}`;
    return;
  }
  if (selectedProfile.mountedRequired) {
    el.storageHint.textContent = `${storageModeHint(selected, selectedProfile)} · เขียนไฟล์จริงที่: ${selectedProfile.actualWritePath} · NAS จะใช้งานจริงได้เมื่อ mount path แล้ว เช่น /Volumes/SmartRecord หรือ /data/smartrecord`;
    return;
  }
  el.storageHint.textContent = `${storageModeHint(selected, selectedProfile)} · เขียนไฟล์จริงที่: ${selectedProfile.actualWritePath}`;
}

async function previewSelectedPrePackImage() {
  const file = el.prePackImageInput?.files?.[0];
  if (!file) {
    renderPrePackImageSettings();
    return;
  }
  if (!isAcceptedPrePackImageType(file.type)) {
    setPrePackImageStatus("รองรับเฉพาะ PNG, JPG หรือ WebP", true);
    return;
  }
  const maxBytes = (state.config.systemAssets?.prePackGuideImage?.maxImageSizeMb || 5) * 1024 * 1024;
  if (file.size > maxBytes) {
    setPrePackImageStatus(`รูปต้องไม่เกิน ${state.config.systemAssets.prePackGuideImage.maxImageSizeMb} MB`, true);
    return;
  }
  const dimensions = await readImageSize(file).catch(() => null);
  if (!dimensions) {
    setPrePackImageStatus("อ่านขนาดรูปไม่สำเร็จ", true);
    return;
  }
  const url = URL.createObjectURL(file);
  if (el.prePackImagePreview) {
    el.prePackImagePreview.onload = () => URL.revokeObjectURL(url);
    el.prePackImagePreview.src = url;
  }
  setPrePackImageStatus(`พร้อมอัปโหลด: ${file.name} (${dimensions.width}x${dimensions.height})`, false);
}

async function uploadPrePackImage() {
  if (!canManageSystemAssets()) {
    toast("เฉพาะ System Admin เท่านั้นที่เปลี่ยนรูปนี้ได้");
    return;
  }
  const file = el.prePackImageInput?.files?.[0];
  if (!file) {
    setPrePackImageStatus("กรุณาเลือกรูปก่อน", true);
    return;
  }
  el.uploadPrePackImageBtn.disabled = true;
  setPrePackImageStatus("กำลังอัปโหลดและให้ server ตรวจไฟล์รูปภาพ...", false);
  try {
    const params = new URLSearchParams({ fileName: file.name });
    const result = await apiFile(`/api/settings/prepack-image?${params.toString()}`, file);
    if (!result.ok) {
      setPrePackImageStatus(result.message || "เปลี่ยนรูปไม่สำเร็จ", true);
      toast(result.message || "เปลี่ยนรูปไม่สำเร็จ");
      return;
    }
    state.config.systemAssets.prePackGuideImage = {
      ...state.config.systemAssets.prePackGuideImage,
      ...result.data
    };
    if (el.prePackImageInput) el.prePackImageInput.value = "";
    applyPrePackGuideImage();
    renderPrePackImageSettings();
    toast(result.message || "เปลี่ยนรูปตัวอย่างแล้ว");
  } finally {
    el.uploadPrePackImageBtn.disabled = false;
  }
}

function setPrePackImageStatus(message, isError) {
  if (!el.prePackImageStatus) return;
  el.prePackImageStatus.textContent = message;
  el.prePackImageStatus.classList.toggle("error", Boolean(isError));
}

function canManageSystemAssets() {
  return can("settings:manage") && ["owner", "admin"].includes(state.currentUser?.roleId || "");
}

function isAcceptedPrePackImageType(type) {
  const accepted = state.config.systemAssets?.prePackGuideImage?.acceptedImageTypes || ["image/png", "image/jpeg", "image/webp"];
  return accepted.includes(type);
}

function readImageSize(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("IMAGE_LOAD_FAILED"));
    };
    img.src = url;
  });
}

function updateDeviceSummary() {
  const storage = selectedStorageTarget();
  const printer = selectedPrinterDriver();
  const scanner = selectedScannerMode();
  const storageValidation = validateCustomStoragePath(deviceSettings.customStoragePath || "", storage);
  const employeeName = state.currentUser
    ? state.currentUser.employeeName || employeeNameForId(state.currentUser.employeeId)
    : state.config.employees.defaultEmployeeName;
  const employeeLabel = employeeName || "ยังไม่ผูกพนักงาน";
  const cameraConnected = deviceConnection.cameraPermission === "granted" || deviceConnection.cameraTestOk || Boolean(mediaStream) || Boolean(settingsCameraStream);
  const printerConnected = isConnectedPrinter(printer);
  const scannerConnected = Boolean(scanner);
  const storageProfile = storageTargetProfile(storage, deviceSettings.customStoragePath || "");
  const storageConnected = Boolean(storage) && storageValidation.ok && !storageProfile.mountedRequired;
  const chips = [
    statusChip({ label: `พนักงาน: ${employeeLabel}`, connected: Boolean(employeeName) }),
    statusChip({ label: "กล้อง", connected: cameraConnected }),
    statusChip({ label: "เครื่องพิมพ์ฉลาก", connected: printerConnected }),
    statusChip({ label: "ที่จัดเก็บวิดีโอ", connected: storageConnected }),
    statusChip({ label: "Barcode Scanner", connected: scannerConnected })
  ];
  el.deviceSummary.innerHTML = chips.join("");
}

function renderPrinterOptions() {
  const drivers = state.config.devices.labelPrinter.drivers || [];
  const browserPrint = drivers.find((driver) => driver.id === "browser-print");
  const connectedPrinters = drivers.filter((driver) => driver.id !== "browser-print");
  el.printerDriverSelect.innerHTML = `
    ${state.detectedPrinters.length ? `
      <optgroup label="เครื่องพิมพ์ที่พบในเครื่อง">
        ${state.detectedPrinters.map((printer) => `
          <option value="${escapeHtml(printer.id)}">${escapeHtml(printer.label)}</option>
        `).join("")}
      </optgroup>
    ` : ""}
    ${connectedPrinters.length ? `
      <optgroup label="เครื่องพิมพ์ที่เคยเชื่อมต่อ">
        ${connectedPrinters.map((driver) => `
          <option value="${escapeHtml(driver.id)}">${escapeHtml(driver.label)}</option>
        `).join("")}
      </optgroup>
    ` : ""}
    ${browserPrint ? `
      <optgroup label="Browser Print ค้นหาเพื่อเชื่อมต่อเครื่องพิมพ์">
        <option value="${escapeHtml(browserPrint.id)}">${escapeHtml(browserPrint.label)} - ค้นหา/เชื่อมต่อ</option>
      </optgroup>
    ` : ""}
  `;
}

function updatePrinterStatus() {
  const printer = selectedPrinterDriver();
  if (!printer) {
    el.printerStatus.textContent = "ยังไม่ได้เลือกเครื่องพิมพ์ฉลาก";
    el.printerStatus.classList.add("error");
    return;
  }
  const connected = isConnectedPrinter(printer);
  el.printerStatus.classList.toggle("error", !connected);
  el.printerStatus.textContent = connected
    ? `${printer.source === "system" ? "พบ driver ในเครื่อง" : "เชื่อมต่อเครื่องพิมพ์ที่เคยใช้"}: ${printer.label}`
    : "Browser Print จะเปิดหน้าต่างค้นหา/เลือกเครื่องพิมพ์ตอนสั่งพิมพ์ ยังไม่ถือว่าเชื่อมต่อเครื่องเฉพาะ";
}

async function discoverPrinters() {
  el.printerStatus.classList.remove("error");
  el.printerStatus.textContent = "กำลังค้นหาเครื่องพิมพ์ในเครื่อง...";
  const result = await api("/api/devices/printers");
  if (!result.ok) {
    el.printerStatus.textContent = result.message || "ค้นหาเครื่องพิมพ์ไม่สำเร็จ";
    el.printerStatus.classList.add("error");
    updateDeviceSummary();
    return;
  }
  state.detectedPrinters = result.data.printers || [];
  localStorage.setItem("smartrecord.detectedPrinters", JSON.stringify(state.detectedPrinters));
  renderPrinterOptions();
  if (state.detectedPrinters.length > 0) {
    deviceSettings.printerDriverId = state.detectedPrinters[0].id;
  }
  el.printerDriverSelect.value = deviceSettings.printerDriverId;
  updatePrinterStatus();
  updateDeviceSummary();
}

function statusChip({ label, connected }) {
  return `
    <span class="deviceChip ${connected ? "connected" : "disconnected"}">
      <span class="deviceDot"></span>${escapeHtml(label)}
    </span>
  `;
}

async function saveDeviceSettings() {
  deviceSettings.customStoragePath = el.customStoragePathInput.value.trim();
  deviceSettings.cameraDeviceId = el.cameraSelect.value;
  deviceSettings.printerDriverId = el.printerDriverSelect.value;
  deviceSettings.scannerMode = el.scannerModeSelect.value;

  const validation = validateCustomStoragePath(deviceSettings.customStoragePath, selectedStorageTarget());
  if (!validation.ok) {
    updateStorageHint();
    toast(validation.message);
    return;
  }

  el.saveSettingsBtn.disabled = true;
  el.storageHint.classList.remove("error");
  el.storageHint.textContent = "กำลังตรวจที่จัดเก็บกับ server...";
  try {
    const storageResult = await api("/api/devices/storage/test", {
      storageTargetId: deviceSettings.storageTargetId,
      customPath: deviceSettings.customStoragePath
    });
    if (!storageResult.ok) {
      el.storageHint.classList.add("error");
      el.storageHint.textContent = storageResult.message || "ตรวจที่จัดเก็บไม่สำเร็จ";
      updateDeviceSummary();
      toast(storageResult.message || "ตรวจที่จัดเก็บไม่สำเร็จ");
      return;
    }

    localStorage.setItem("smartrecord.deviceSettings", JSON.stringify(deviceSettings));
    updateStorageHint(storageResult.data);
    updateDeviceSummary();
    toast("บันทึก Settings แล้ว");
  } finally {
    el.saveSettingsBtn.disabled = false;
  }
  closeSettingsDialog();
}

async function testCamera() {
  stopSettingsCamera();
  el.cameraStatus.textContent = "กำลังทดสอบกล้อง...";
  try {
    await updateCameraPermissionStatus();
    settingsCameraStream = await openCameraStream(deviceSettings.cameraDeviceId);
    if (el.settingsCameraPreview) {
      el.settingsCameraPreview.srcObject = settingsCameraStream;
      el.cameraPreviewWrap?.classList.remove("hidden");
    }
    await refreshCameraDevices();
    deviceConnection.cameraTestOk = true;
    el.cameraStatus.textContent = "กล้องพร้อมใช้งาน";
    updateDeviceSummary();
    toast("Test กล้องผ่าน");
  } catch (error) {
    await updateCameraPermissionStatus();
    deviceConnection.cameraTestOk = false;
    const message = cameraErrorMessage(error);
    el.cameraStatus.textContent = message;
    updateDeviceSummary();
    toast(message);
  }
}

async function updateCameraPermissionStatus() {
  if (!el.cameraPermissionStatus) return "unknown";
  if (!navigator.permissions?.query) {
    el.cameraPermissionStatus.textContent = "Browser นี้ไม่เปิดเผยสถานะ permission กล้อง ให้กดทดสอบกล้องเพื่อขอสิทธิ์";
    return "unknown";
  }
  try {
    const permission = await navigator.permissions.query({ name: "camera" });
    const messages = {
      granted: "Camera Permission: อนุญาตแล้ว",
      prompt: "Camera Permission: ยังไม่เคยอนุญาต กดทดสอบกล้องเพื่อให้ Browser ขอสิทธิ์",
      denied: "Camera Permission: ถูกบล็อกอยู่ จึงไม่มี popup ขึ้นมาอีก ต้องปลดบล็อกจาก Site Settings ของ Browser"
    };
    deviceConnection.cameraPermission = permission.state;
    el.cameraPermissionStatus.textContent = messages[permission.state] || `Camera Permission: ${permission.state}`;
    updateDeviceSummary();
    return permission.state;
  } catch {
    deviceConnection.cameraPermission = "unknown";
    el.cameraPermissionStatus.textContent = "Browser นี้ตรวจ permission กล้องไม่ได้ ให้กดทดสอบกล้องเพื่อดูผล";
    updateDeviceSummary();
    return "unknown";
  }
}

async function refreshCameraDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((device) => device.kind === "videoinput" && device.deviceId);
    const configOptions = state.config.devices.camera.options || [];
    const detectedOptions = videoInputs.map((device, index) => ({
      id: device.deviceId,
      label: device.label || `กล้อง ${index + 1}`
    }));
    const options = mergeCameraOptions(configOptions, detectedOptions);
    const currentValue = deviceSettings.cameraDeviceId;
    el.cameraSelect.innerHTML = options.map((camera) => `
      <option value="${escapeHtml(camera.id)}">${escapeHtml(camera.label)}</option>
    `).join("");
    el.cameraSelect.value = options.some((camera) => camera.id === currentValue) ? currentValue : "browser-default";
    deviceSettings.cameraDeviceId = el.cameraSelect.value;
    updateDeviceSummary();
  } catch {
    // Browser may hide device enumeration until the user grants camera permission.
  }
}

function mergeCameraOptions(configOptions, detectedOptions) {
  const seen = new Set();
  return [...configOptions, ...detectedOptions].filter((camera) => {
    if (seen.has(camera.id)) return false;
    seen.add(camera.id);
    return true;
  });
}

async function openCameraStream(cameraDeviceId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("GET_USER_MEDIA_UNSUPPORTED");
  }
  const specificVideo = cameraDeviceId && cameraDeviceId !== "browser-default"
    ? { deviceId: { exact: cameraDeviceId } }
    : true;
  try {
    return await navigator.mediaDevices.getUserMedia({ video: specificVideo, audio: false });
  } catch (error) {
    if (specificVideo !== true && ["OverconstrainedError", "NotFoundError"].includes(error.name)) {
      return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    throw error;
  }
}

function cameraErrorMessage(error) {
  const name = error?.name || error?.message;
  if (name === "GET_USER_MEDIA_UNSUPPORTED") return "Browser นี้ยังไม่รองรับการเปิดกล้อง";
  if (name === "NotAllowedError" || name === "SecurityError") return "เปิดกล้องไม่ได้: สิทธิ์กล้องถูกบล็อกหรือ browser ไม่แสดง popup ให้ปลดบล็อกจาก Site Settings แล้วลองใหม่";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "เปิดกล้องไม่ได้: ไม่พบกล้อง Webcam";
  if (name === "NotReadableError" || name === "TrackStartError") return "เปิดกล้องไม่ได้: กล้องอาจถูกโปรแกรมอื่นใช้งานอยู่";
  if (name === "OverconstrainedError") return "เปิดกล้องไม่ได้: กล้องที่เลือกไม่พร้อมใช้งาน กรุณาเลือกกล้องเริ่มต้น";
  return `เปิดกล้องไม่ได้: ${error?.message || "ไม่ทราบสาเหตุ"}`;
}

function closeSettingsDialog() {
  stopSettingsCamera();
  el.settingsDialog.close();
}

function stopSettingsCamera() {
  if (!settingsCameraStream) return;
  settingsCameraStream.getTracks().forEach((track) => track.stop());
  settingsCameraStream = null;
  if (el.settingsCameraPreview) el.settingsCameraPreview.srcObject = null;
  el.cameraPreviewWrap?.classList.add("hidden");
}

function handleScannerTest() {
  const value = el.scannerTestInput.value.trim();
  el.scannerStatus.textContent = value
    ? `รับ barcode จาก USB แล้ว: ${value}`
    : "รองรับ scanner แบบ USB Keyboard Wedge";
}

function selectedStorageTarget() {
  return (state.config.upload.storageTargets || []).find((target) => target.id === deviceSettings.storageTargetId);
}

function storageProviderLabel(provider = "") {
  return {
    nas: "NAS",
    local: "เครื่องนี้",
    "cloud-sync": "Cloud Sync"
  }[provider] || provider.toUpperCase();
}

function storageModeHint(target, profile = storageTargetProfile(target)) {
  if (target.provider === "nas" && profile.mountedRequired) {
    return `${target.label}: จำลอง / ยังไม่ mount NAS (${target.host})`;
  }
  if (target.provider === "nas") {
    return `${target.label}: เก็บลง NAS ที่ mount แล้ว (${target.host})`;
  }
  if (target.provider === "cloud-sync") {
    return `${target.label}: เก็บผ่านเว็บภายนอกหรือโฟลเดอร์ Cloud Sync`;
  }
  if (target.provider === "local") {
    return `${target.label}: เก็บลงเครื่องนี้`;
  }
  return `${target.label}: ${target.provider}`;
}

function storageDestinationLabel(rawPath) {
  return /^https?:\/\//i.test(rawPath) ? "Website URL" : "path ที่ใช้";
}

function videoDestinationLabel(video) {
  if (!video) return "-";
  if (video.externalUrl) return `${video.externalUrl} (local fallback: ${video.relativePath || "-"})`;
  return video.relativePath || video.customPath || "-";
}

function truncateMiddle(value, maxLength = 48) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  const side = Math.max(8, Math.floor((maxLength - 1) / 2));
  return `${text.slice(0, side)}…${text.slice(-side)}`;
}

function validateCustomStoragePath(rawPath, selectedTarget) {
  if (selectedTarget?.provider === "nas" && selectedTarget?.id === "custom-nas" && !rawPath) {
    return {
      ok: false,
      message: "NAS กำหนดเองต้องกรอก mounted path จริงก่อนใช้งาน เช่น /Volumes/SmartRecord หรือ /data/smartrecord"
    };
  }
  if (!rawPath) return { ok: true };
  if (/^https?:\/\//i.test(rawPath)) {
    try {
      const url = new URL(rawPath);
      if (url.username || url.password) {
        return {
          ok: false,
          message: "Website URL ห้ามใส่ username/password หรือ secret ไว้ใน URL"
        };
      }
    } catch {
      return {
        ok: false,
        message: "Website URL ไม่ถูกต้อง"
      };
    }
    if (selectedTarget?.provider === "cloud-sync") return { ok: true };
    return {
      ok: false,
      message: "URL เว็บภายนอกใช้ได้เฉพาะ Storage Target แบบ Cloud Sync"
    };
  }
  if (rawPath.includes("..")) {
    return {
      ok: false,
      message: "Custom Path ห้ามใช้ .. เพื่อย้อนออกนอกโฟลเดอร์จัดเก็บ"
    };
  }
  if (selectedTarget?.provider === "nas" && /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/i.test(rawPath)) {
    return {
      ok: false,
      message: "ห้ามกรอกเป็น IP address อย่างเดียว ต้องใช้ mounted path จริง เช่น /Volumes/SmartRecord หรือ /data/smartrecord"
    };
  }
  if (selectedTarget?.provider === "nas" && !(/^\/|^[a-z]:[\\/]/i.test(rawPath))) {
    return {
      ok: false,
      message: "NAS ต้องใช้ absolute path หรือ mounted path จริงเท่านั้น เช่น /Volumes/SmartRecord หรือ /data/smartrecord"
    };
  }
  if (rawPath.startsWith("/") || /^[a-z]:[\\/]/i.test(rawPath)) {
    const normalized = rawPath.replace(/[\\/]+$/, "");
    if (normalized === "/" || /^[a-z]:$/i.test(normalized)) {
      return {
        ok: false,
        message: "Custom Path ห้ามชี้ไปที่ root ของเครื่องโดยตรง"
      };
    }
  }
  return { ok: true };
}

function storageTargetBadge(target) {
  const profile = storageTargetProfile(target);
  if (profile.customPathRequired) return { label: "ต้องกรอก path", tone: "warning" };
  if (profile.mountedRequired) return { label: "จำลอง / ยังไม่ mount NAS", tone: "warning" };
  if (profile.externalUrl) return { label: "Cloud Sync", tone: "info" };
  return null;
}

function storageTargetProfile(target, customPath = "") {
  if (!target) {
    return {
      actualWritePath: "-",
      externalUrl: "",
      mountedRequired: false,
      customPathRequired: false
    };
  }
  const rawCustomPath = String(customPath || "").trim();
  const effectivePath = rawCustomPath || target.resolvedLocalPath || target.localPath || "-";
  const externalUrl = /^https?:\/\//i.test(rawCustomPath) ? rawCustomPath : "";
  const usesResolvedTargetPath = !rawCustomPath || externalUrl;
  const mountedRequired = target.provider === "nas"
    && (rawCustomPath
      ? !(/^\/|^[a-z]:[\\/]/i.test(rawCustomPath))
      : Boolean(target.mountedRequired));
  return {
    actualWritePath: usesResolvedTargetPath ? (target.resolvedLocalPath || target.localPath || "-") : effectivePath,
    externalUrl,
    mountedRequired,
    customPathRequired: target.provider === "nas" && target.id === "custom-nas"
  };
}

function selectedPrinterDriver() {
  return state.detectedPrinters.find((printer) => printer.id === deviceSettings.printerDriverId)
    || state.config.devices.labelPrinter.drivers.find((driver) => driver.id === deviceSettings.printerDriverId);
}

function isConnectedPrinter(printer) {
  return Boolean(printer && printer.id !== "browser-print");
}

function selectedScannerMode() {
  return state.config.devices.barcodeScanner.modes.find((mode) => mode.id === deviceSettings.scannerMode);
}

function cameraLabel(cameraDeviceId) {
  return state.config.devices.camera.options.find((camera) => camera.id === cameraDeviceId)?.label || cameraDeviceId;
}

function stopRecordingBlob() {
  return new Promise((resolve) => {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      resolve(recordedChunks.length ? new Blob(recordedChunks, { type: "video/webm" }) : null);
      return;
    }
    mediaRecorder.addEventListener("stop", () => {
      resolve(recordedChunks.length ? new Blob(recordedChunks, { type: mediaRecorder.mimeType || "video/webm" }) : null);
    }, { once: true });
    if (mediaRecorder.state === "recording" && typeof mediaRecorder.requestData === "function") {
      mediaRecorder.requestData();
    }
    mediaRecorder.stop();
  });
}

function switchView(view) {
  const tabForView = [...el.tabs].find((tab) => tab.dataset.view === view);
  const permission = tabForView?.dataset.permission;
  if (permission && !can(permission)) {
    toast("บัญชีนี้ไม่มีสิทธิ์เปิดหน้านี้");
    return;
  }
  el.tabs.forEach((tab) => tab.classList.toggle("active", tab.dataset.view === view));
  el.views.forEach((panel) => panel.classList.toggle("active", panel.id === `${view}View`));
  if (view === "reports" && can("reports:view")) loadReports();
  if (view === "connect" && can("integrations:manage") && state.syncedOrders.length === 0) syncOrders();
  if (view === "labels" && can("labels:manage")) loadLabels();
  if (view === "users" && can("users:manage")) loadUsers();
}

function platformName(platform) {
  return {
    shopee: "Shopee",
    lazada: "Lazada",
    tiktok: "TikTok",
    Tiktok: "TikTok",
    custom: "ทั่วไป",
    "3pl": "3PL"
  }[platform] ?? platform;
}

function normalizePlatformValue(platform) {
  const value = String(platform || "").trim().toLowerCase().replace(/\s+/g, "");
  if (value === "shopee") return "shopee";
  if (value === "lazada") return "lazada";
  if (value === "tiktok" || value === "tiktokshop") return "tiktok";
  return "3pl";
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyDetailLink() {
  if (!el.detailShareLink.value || el.copyDetailLinkBtn.disabled) {
    toast("ยังไม่มีลิงก์วิดีโอให้คัดลอก");
    return;
  }
  copyText(el.detailShareLink.value);
}

async function copyText(value, message = "คัดลอกลิงก์แล้ว") {
  if (!value) {
    toast("ยังไม่มีลิงก์ให้คัดลอก");
    return;
  }
  await navigator.clipboard?.writeText(value).catch(() => {});
  toast(message);
}

async function api(url, body) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  let response;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  } catch {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: "ไม่สามารถเชื่อมต่อ server ได้ กรุณารีเฟรชหรือทดลองใหม่อีกครั้ง"
    };
  }

  let result;
  try {
    result = await response.json();
  } catch {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      message: "server ตอบกลับไม่ถูกต้อง กรุณารีเฟรชแล้วลองใหม่อีกครั้ง"
    };
  }
  if ((result.code === "AUTH_REQUIRED" || result.code === "SESSION_EXPIRED") && !url.startsWith("/api/auth/")) {
    localStorage.removeItem("smartrecord.authToken");
    state.authToken = "";
    state.currentUser = null;
    showLogin(result.message);
  }
  return result;
}

async function apiFile(url, file) {
  const headers = {};
  if (file?.type) headers["Content-Type"] = file.type;
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: file
    });
  } catch {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      message: "ไม่สามารถเชื่อมต่อ server ได้ กรุณารีเฟรชหรือทดลองใหม่อีกครั้ง"
    };
  }

  let result;
  try {
    result = await response.json();
  } catch {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      message: "server ตอบกลับไม่ถูกต้อง กรุณารีเฟรชแล้วลองใหม่อีกครั้ง"
    };
  }
  if ((result.code === "AUTH_REQUIRED" || result.code === "SESSION_EXPIRED") && !url.startsWith("/api/auth/")) {
    localStorage.removeItem("smartrecord.authToken");
    state.authToken = "";
    state.currentUser = null;
    showLogin(result.message);
  }
  return result;
}

function tickClock() {
  el.clock.textContent = new Date().toLocaleTimeString("th-TH", { hour12: false });
}

function readStoredDetectedPrinters() {
  try {
    const printers = JSON.parse(localStorage.getItem("smartrecord.detectedPrinters") || "[]");
    return Array.isArray(printers) ? printers : [];
  } catch {
    return [];
  }
}

function isDuplicateOrderCode(code) {
  return ["ORDER_ALREADY_EXISTS", "ORDER_DUPLICATE_LABEL", "ORDER_AWB_CONFLICT"].includes(code);
}

function duplicateImportWarning(data = {}) {
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const duplicateRows = skipped.filter((item) => isDuplicateOrderCode(item.code));
  const rows = duplicateRows.length ? duplicateRows : skipped;
  if (!rows.length) return data.message || "พบรายการซ้ำหรือถูกข้าม";

  return rows.map((item, index) => {
    const parsed = item.parsed || {};
    const orderNumber = parsed.orderNumber || item.orderNumber || "-";
    const awb = parsed.awb || item.awb || "-";
    const message = item.message || item.code || "รายการนี้ถูกข้าม";
    return `${index + 1}. ${message}\nเลขออเดอร์: ${orderNumber}\nAWB: ${awb}`;
  }).join("\n\n");
}

function hasDuplicateImportRows(data = {}) {
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  return skipped.some((item) => isDuplicateOrderCode(item.code));
}

function showWarningDialog(title, message) {
  if (!el.warningDialog) {
    window.alert(`${title}\n\n${message}`);
    return;
  }
  el.warningTitle.textContent = title;
  el.warningMessage.textContent = message;
  if (el.warningDialog.open) el.warningDialog.close();
  el.warningDialog.showModal();
}

function formatDateTime(value) {
  return new Date(value).toLocaleString("th-TH", { hour12: false });
}

function formatOptionalDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("th-TH", { hour12: false });
}

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add("show");
  clearTimeout(el.toast._timer);
  el.toast._timer = setTimeout(() => el.toast.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;"
  })[char]);
}
