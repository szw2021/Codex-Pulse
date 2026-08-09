(() => {
  const storageKey = 'codex-pulse-theme-mode';
  const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
  const normalize = mode => ['light', 'dark', 'system'].includes(mode) ? mode : 'system';

  const apply = requestedMode => {
    const mode = normalize(requestedMode);
    const effectiveTheme = mode === 'system'
      ? (systemTheme.matches ? 'dark' : 'light')
      : mode;
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = effectiveTheme;
    try {
      window.localStorage.setItem(storageKey, mode);
    } catch (_) {
      // The persisted Rust setting remains the source of truth.
    }
    return mode;
  };

  systemTheme.addEventListener('change', () => {
    if (document.documentElement.dataset.themeMode === 'system') apply('system');
  });

  let storedMode = 'system';
  try {
    storedMode = window.localStorage.getItem(storageKey) || 'system';
  } catch (_) {
    // Use the system appearance when local storage is unavailable.
  }
  apply(storedMode);
  window.codexPulseTheme = Object.freeze({ apply });
})();
