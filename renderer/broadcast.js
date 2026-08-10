class BroadcastManager {
  constructor() {
    this.isActive = false;
    this.toggleButton = null;
    this.onToggleCallbacks = [];
  }

  init(toggleButtonElement) {
    this.toggleButton = toggleButtonElement;
    if (this.toggleButton) {
      this.toggleButton.addEventListener('click', () => this.toggle());
    }
  }

  toggle(forceState = null) {
    this.isActive = forceState !== null ? Boolean(forceState) : !this.isActive;
    this.updateUI();
    this.onToggleCallbacks.forEach((cb) => {
      try { cb(this.isActive); } catch (err) { console.error(err); }
    });
    return this.isActive;
  }

  onToggle(callback) {
    this.onToggleCallbacks.push(callback);
  }

  updateUI() {
    if (this.toggleButton) {
      const textEl = this.toggleButton.querySelector('.broadcast-text');
      if (this.isActive) {
        this.toggleButton.classList.add('active');
        if (textEl) textEl.textContent = 'Broadcast On';
      } else {
        this.toggleButton.classList.remove('active');
        if (textEl) textEl.textContent = 'Broadcast Off';
      }
    }

    // Status bar indicator
    const indicator = document.getElementById('broadcast-indicator');
    const statusText = document.getElementById('broadcast-status-text');
    const statusBar = document.getElementById('status-bar');
    if (indicator) {
      indicator.classList.toggle('on', this.isActive);
      indicator.classList.toggle('off', !this.isActive);
    }
    if (statusText) statusText.textContent = this.isActive ? 'Broadcast: On' : 'Broadcast: Off';
    if (statusBar) statusBar.classList.toggle('broadcast-on', this.isActive);
  }

  handleKeystroke(senderPaneId, data, activePanesMap) {
    if (!this.isActive || !activePanesMap) return;
    for (const [paneId, paneInstance] of activePanesMap.entries()) {
      if (paneId !== senderPaneId && paneInstance.status === 'running') {
        window.electronAPI.writePty(paneId, data);
      }
    }
  }
}

window.broadcastManager = new BroadcastManager();
