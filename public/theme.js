(() => {
  const storageKey = 'boson-studio-appearance';
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { preference = localStorage.getItem(storageKey) || 'system'; } catch {}
  if (!['system', 'light', 'dark'].includes(preference)) preference = 'system';
  const effective = () => preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
  function apply() {
    const theme = effective();
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#181b20' : '#f7f6f2');
  }
  window.BosonTheme = {
    getPreference: () => preference,
    getEffective: effective,
    setPreference(value) {
      if (!['system', 'light', 'dark'].includes(value)) return;
      preference = value;
      try { localStorage.setItem(storageKey, preference); } catch {}
      apply();
    },
  };
  system.addEventListener('change', () => { if (preference === 'system') apply(); });
  apply();
})();
