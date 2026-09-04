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
  let directories = [];

  const bridge = (action, details = {}) => window.codexPulse?.send(action, details);

  function render() {
    const previous = select.value;
    if (directories.length === 0) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '请先添加项目目录';
      select.replaceChildren(empty);
    } else {
      select.replaceChildren(...directories.map(path => {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path;
        return option;
      }));
      if (directories.includes(previous)) select.value = previous;
    }
    openButton.disabled = !select.value;
    removeButton.disabled = !select.value;
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

  function launchSelected() {
    if (!select.value) return;
    closeModal();
    bridge('launchQuickDir', { path: select.value });
  }

  menuButton.addEventListener('click', openModal);
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => {
    if (event.target === modal) closeModal();
  });
  select.addEventListener('change', render);
  select.addEventListener('dblclick', launchSelected);
  openButton.addEventListener('click', launchSelected);
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
