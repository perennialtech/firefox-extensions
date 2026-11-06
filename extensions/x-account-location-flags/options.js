'use strict';

const highlight = document.getElementById('highlightUncertain');
const autoBlock = document.getElementById('autoBlockSouthAsia');
const uncertain = document.getElementById('autoBlockUncertain');
const inputs = [highlight, autoBlock, uncertain];
const status = document.getElementById('status');

async function load() {
  try {
    const settings = await browser.storage.local.get(inputs.map(input => input.id));
    for (const input of inputs) {
      input.checked = settings[input.id] !== false;
      input.disabled = false;
    }
    uncertain.disabled = !autoBlock.checked;
  } catch (_) {
    status.textContent = 'Could not load settings.';
  }
}

for (const input of inputs) {
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
