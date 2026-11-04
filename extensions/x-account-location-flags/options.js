'use strict';

const autoBlock = document.getElementById('autoBlockSouthAsia');
const uncertain = document.getElementById('autoBlockUncertain');
const status = document.getElementById('status');

async function load() {
  try {
    const settings = await browser.storage.local.get([autoBlock.id, uncertain.id]);
    autoBlock.checked = settings[autoBlock.id] !== false;
    uncertain.checked = settings[uncertain.id] !== false;
    autoBlock.disabled = false;
    uncertain.disabled = !autoBlock.checked;
  } catch (_) {
    status.textContent = 'Could not load settings.';
  }
}

for (const input of [autoBlock, uncertain]) {
  input.addEventListener('change', async () => {
    status.textContent = '';
    uncertain.disabled = !autoBlock.checked;
    try {
      await browser.storage.local.set({ [input.id]: input.checked });
    } catch (_) {
      await load();
      status.textContent = 'Could not save the setting.';
    }
  });
}
void load();
