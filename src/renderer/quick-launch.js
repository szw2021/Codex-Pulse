(() => {
  const menu = document.querySelector('#menu');
  const menuButton = document.querySelector('#quick-launch-menu');
  const modal = document.querySelector('#quick-launch-modal');
  const closeButton = document.querySelector('#quick-launch-close');
  const select = document.querySelector('#quick-launch-select');
  const openButton = document.querySelector('#quick-launch-open');
  const removeButton = document.querySelector('#quick-launch-remove');
  const form = document.querySelector('#quick-launch-form');
  const input = document.querySelector('#quick-launch-input');
  const inlineSelect = document.querySelector('#quick-launch-inline-select');
  const inlineOpen = document.querySelector('#quick-launch-inline-open');
  const inlineManage = document.querySelector('#quick-launch-inline-manage');
  let directories = [];
  let launching = false;

  const bridge = (action, details = {}) => window.codexPulse?.send(action, details);

  function render() {
    const previous = select.value;
    const inlinePrevious = inlineSelect.value;
    if (directories.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '请先添加项目目录';
      select.replaceChildren(empty);
      inlineSelect.replaceChildren(empty.cloneNode(true));
    } else {
      const options = directories.map(path => {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path;
        return option;
      });
      select.replaceChildren(...options);
      inlineSelect.replaceChildren(...options.map(option => option.cloneNode(true)));
      if (directories.includes(previous)) select.value = previous;
      if (directories.includes(inlinePrevious)) inlineSelect.value = inlinePrevious;
    }
    openButton.disabled = !select.value;
    removeButton.disabled = !select.value;
    inlineOpen.disabled = !inlineSelect.value;
  }

  function openModal(event) {
    event.stopPropagation();
    menu.hidden = true;
    modal.hidden = false;
    render();
    setTimeout(() => (select.value ? select.focus() : input.focus()), 0);
  }

  function closeModal() {
    modal.hidden = true;
  }

  async function launch(path) {
    if (!path || launching) return;
    launching = true;
    const originalLabel = inlineOpen.textContent;
    inlineOpen.disabled = true;
    inlineOpen.textContent = '启动中…';
    closeModal();
    await bridge('launchQuickDir', { path });
    setTimeout(() => {
      launching = false;
      inlineOpen.textContent = originalLabel;
      render();
    }, 600);
  }

  menuButton.addEventListener('click', openModal);
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
  select.addEventListener('change', render);
  select.addEventListener('dblclick', () => launch(select.value));
  openButton.addEventListener('click', () => launch(select.value));
  inlineOpen.addEventListener('click', () => launch(inlineSelect.value));
  inlineSelect.addEventListener('dblclick', () => launch(inlineSelect.value));
  inlineManage.addEventListener('click', openModal);
  removeButton.addEventListener('click', () => {
    if (select.value) bridge('removeQuickLaunchDir', { path: select.value });
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const path = input.value.trim();
    if (!path) return;
    input.value = '';
    bridge('addQuickLaunchDir', { path });
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.hidden) closeModal();
  });
  window.codexPulse?.onState(payload => {
    directories = Array.isArray(payload.quickLaunchDirs) ? payload.quickLaunchDirs : [];
    render();
  });
})();
