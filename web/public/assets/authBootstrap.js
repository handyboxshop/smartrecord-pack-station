export const AUTH_BOOT_TIMEOUT_MS = 8000;

export class AuthBootstrapTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "AuthBootstrapTimeoutError";
    this.code = "AUTH_BOOT_TIMEOUT";
  }
}

export async function withAbortTimeout(request, {
  timeoutMs = AUTH_BOOT_TIMEOUT_MS,
  message = "Authentication initialization timed out"
} = {}) {
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new AuthBootstrapTimeoutError(message));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => request({ signal: controller.signal })),
      timeout
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export function createAuthUiState({ app, loginScreen, loadingScreen }) {
  function setLoadingVisible(isVisible) {
    loadingScreen?.classList.toggle("hidden", !isVisible);
    loadingScreen?.setAttribute("aria-hidden", String(!isVisible));
    loadingScreen?.setAttribute("aria-busy", String(isVisible));
  }

  return {
    showLoading() {
      app?.classList.add("authLocked");
      loginScreen?.classList.add("hidden");
      setLoadingVisible(true);
    },
    showLogin() {
      app?.classList.add("authLocked");
      loginScreen?.classList.remove("hidden");
      setLoadingVisible(false);
    },
    showApp() {
      loginScreen?.classList.add("hidden");
      app?.classList.remove("authLocked");
      setLoadingVisible(false);
    }
  };
}

export async function completeLogout({ requestLogout, clearSession, clearSavedView, showLogin }) {
  try {
    await requestLogout();
  } finally {
    clearSession();
    clearSavedView();
    showLogin();
  }
}
