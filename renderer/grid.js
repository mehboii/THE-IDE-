class GridManager {
  constructor(containerElement) {
    this.container = containerElement;
    this.preset = '2x3'; // '2x3' | '3x2'
    this.panes = new Map();
    this.columnRatios = [1, 1, 1];
    this.rowRatios = [1, 1];
    this._reflowTimer = null;

    this._initResizeObserver();
    this._installDividers();
  }

  setPreset(preset) {
    this.preset = preset;
    this.container.className = `grid-container grid-layout-${preset}`;
    if (preset === '2x3') {
      if (this.columnRatios.length < 3) this.columnRatios = [1, 1, 1];
      if (this.rowRatios.length < 2) this.rowRatios = [1, 1];
    } else {
      if (this.columnRatios.length < 2) this.columnRatios = [1, 1];
      if (this.rowRatios.length < 3) this.rowRatios = [1, 1, 1];
    }
    this._applyTracks();
    this.reflowAll();
  }

  addPaneToGrid(paneInstance) {
    this.panes.set(paneInstance.id, paneInstance);
    // Insert before dividers so dividers stay on top
    const firstDivider = this.container.querySelector('.grid-divider');
    if (firstDivider) {
      this.container.insertBefore(paneInstance.container, firstDivider);
    } else {
      this.container.appendChild(paneInstance.container);
    }
    requestAnimationFrame(() => paneInstance.fit());
  }

  removePaneFromGrid(paneId) {
    const pane = this.panes.get(paneId);
    if (pane) {
      pane.destroy();
      this.panes.delete(paneId);
      this.reflowAll();
    }
  }

  reflowAll() {
    // Coalesce rapid resize events (window drag, sash drag)
    if (this._reflowTimer) cancelAnimationFrame(this._reflowTimer);
    this._reflowTimer = requestAnimationFrame(() => {
      this._reflowTimer = null;
      for (const pane of this.panes.values()) {
        pane.fit();
      }
    });
  }

  _initResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this.reflowAll());
      return;
    }
    const resizeObserver = new ResizeObserver(() => this.reflowAll());
    resizeObserver.observe(this.container);
  }

  _applyTracks() {
    const columns = this.preset === '2x3' ? this.columnRatios.slice(0, 3) : this.columnRatios.slice(0, 2);
    const rows = this.preset === '2x3' ? this.rowRatios.slice(0, 2) : this.rowRatios.slice(0, 3);
    // Ensure ratio arrays have enough entries
    while (columns.length < (this.preset === '2x3' ? 3 : 2)) columns.push(1);
    while (rows.length < (this.preset === '2x3' ? 2 : 3)) rows.push(1);

    this.container.style.gridTemplateColumns = columns.map((n) => `${n}fr`).join(' ');
    this.container.style.gridTemplateRows = rows.map((n) => `${n}fr`).join(' ');

    const colSum = columns.reduce((a, b) => a + b, 0) || 1;
    const rowSum = rows.reduce((a, b) => a + b, 0) || 1;
    const x0 = (columns[0] / colSum) * 100;
    const x1 = columns.length > 2 ? ((columns[0] + columns[1]) / colSum) * 100 : 0;
    const y0 = (rows[0] / rowSum) * 100;
    const y1 = rows.length > 2 ? ((rows[0] + rows[1]) / rowSum) * 100 : 0;

    const setPos = (sel, prop, val) => {
      const el = this.container.querySelector(sel);
      if (el) el.style.setProperty(prop, `${val}%`);
    };
    setPos('.grid-divider-x-0', 'left', x0);
    setPos('.grid-divider-x-1', 'left', x1);
    setPos('.grid-divider-y-0', 'top', y0);
    setPos('.grid-divider-y-1', 'top', y1);
  }

  _installDividers() {
    const drag = (axis, index, event) => {
      event.preventDefault();
      event.stopPropagation();
      const divider = event.currentTarget;
      divider.classList.add('dragging');
      // Capture pointer so fast drags don't escape the divider
      divider.setPointerCapture(event.pointerId);
      const rect = this.container.getBoundingClientRect();
      const start = axis === 'x' ? event.clientX : event.clientY;
      const total = axis === 'x' ? rect.width : rect.height;
      const ratios = axis === 'x'
        ? (this.preset === '2x3' ? this.columnRatios : this.columnRatios)
        : this.rowRatios;
      // For 3x2, only first column divider is meaningful on x with 2 cols
      const maxIndex = axis === 'x'
        ? (this.preset === '2x3' ? 2 : 1)
        : (this.preset === '2x3' ? 1 : 2);
      if (index >= maxIndex) {
        divider.releasePointerCapture(event.pointerId);
        divider.classList.remove('dragging');
        return;
      }

      const before = ratios[index];
      const after = ratios[index + 1];
      if (before == null || after == null) {
        divider.releasePointerCapture(event.pointerId);
        divider.classList.remove('dragging');
        return;
      }

      const onMove = (move) => {
        const delta = (((axis === 'x' ? move.clientX : move.clientY) - start) / total) * (before + after);
        ratios[index] = Math.max(0.2, before + delta);
        ratios[index + 1] = Math.max(0.2, after - delta);
        this._applyTracks();
        this.reflowAll();
      };
      const onUp = () => {
        divider.classList.remove('dragging');
        try { divider.releasePointerCapture(event.pointerId); } catch (_) {}
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        this.reflowAll();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    };

    [['x', 0], ['x', 1], ['y', 0], ['y', 1]].forEach(([axis, index]) => {
      const divider = document.createElement('div');
      divider.className = `grid-divider grid-divider-${axis} grid-divider-${axis}-${index}`;
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-orientation', axis === 'x' ? 'vertical' : 'horizontal');
      divider.addEventListener('pointerdown', (event) => drag(axis, index, event));
      this.container.appendChild(divider);
    });
    this._applyTracks();
  }

  getPaneCount() {
    return this.panes.size;
  }

  clearAll() {
    for (const pane of this.panes.values()) {
      pane.destroy();
    }
    this.panes.clear();
  }
}

window.GridManager = GridManager;
