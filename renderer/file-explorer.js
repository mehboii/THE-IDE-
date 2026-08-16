class FileExplorer {
  constructor(containerEl, openFolderBtnEl) {
    this.containerEl = containerEl;
    this.openFolderBtnEl = openFolderBtnEl;
    this.currentRootDir = null;
    this.onFileSelectCallback = null;
    this.onRootChangeCallback = null;
    this.expandedDirs = new Set();

    if (this.openFolderBtnEl) {
      this.openFolderBtnEl.addEventListener('click', () => this.handleOpenFolderClick());
    }
  }

  onFileSelect(fn) {
    this.onFileSelectCallback = fn;
  }

  onRootChange(fn) { this.onRootChangeCallback = fn; }

  async handleOpenFolderClick() {
    const selected = await window.electronAPI.selectDirectory(this.currentRootDir || undefined);
    if (selected) {
      await this.setRootDirectory(selected, true);
    }
  }

  async setRootDirectory(dirPath, force = false) {
    if (!dirPath) return;
    if (this.currentRootDir === dirPath && !force) return;

    this.currentRootDir = dirPath;
    this.expandedDirs.clear();
    this.expandedDirs.add(dirPath);
    await this.onRootChangeCallback?.(dirPath);
    await this.render();
  }

  async render() {
    if (!this.containerEl) return;
    this.containerEl.innerHTML = '';

    if (!this.currentRootDir) {
      this.containerEl.innerHTML = `
        <div class="file-tree-empty">
          <p>No folder opened. Choose <strong>Open Folder</strong> to view real files.</p>
          <button class="btn btn-secondary btn-sm" id="btn-tree-open-folder">Open Folder</button>
        </div>
      `;
      const btn = this.containerEl.querySelector('#btn-tree-open-folder');
      if (btn) btn.addEventListener('click', () => this.handleOpenFolderClick());
      return;
    }

    const header = document.createElement('div');
    header.className = 'file-tree-root-header';
    const folderName = this.currentRootDir.split(/[/\\]/).pop() || this.currentRootDir;
    header.innerHTML = `
      <span class="file-tree-root-title" title="${this.currentRootDir}">📁 <strong>${folderName}</strong></span>
    `;
    this.containerEl.appendChild(header);

    const rootList = document.createElement('div');
    rootList.className = 'file-tree-list';
    this.containerEl.appendChild(rootList);

    await this.populateDirNode(this.currentRootDir, rootList, 0);
  }

  async populateDirNode(dirPath, parentElement, depth) {
    const entries = await window.electronAPI.readDir(dirPath);
    if (!entries || entries.length === 0) {
      if (depth > 0) {
        const emptyEl = document.createElement('div');
        emptyEl.className = 'tree-item empty';
        emptyEl.style.paddingLeft = `${depth * 14 + 16}px`;
        emptyEl.textContent = '(empty)';
        parentElement.appendChild(emptyEl);
      }
      return;
    }

    for (const entry of entries) {
      const itemEl = document.createElement('div');
      itemEl.className = `tree-item ${entry.isDirectory ? 'folder' : 'file'}`;
      itemEl.style.paddingLeft = `${depth * 14 + 8}px`;

      const icon = entry.isDirectory
        ? (this.expandedDirs.has(entry.path) ? '📂' : '📁')
        : this.getFileIcon(entry.name);

      itemEl.innerHTML = `
        <span class="tree-icon">${icon}</span>
        <span class="tree-label" title="${entry.path}">${entry.name}</span>
      `;

      parentElement.appendChild(itemEl);

      if (entry.isDirectory) {
        const childContainer = document.createElement('div');
        childContainer.className = 'tree-children';
        if (!this.expandedDirs.has(entry.path)) {
          childContainer.style.display = 'none';
        }
        parentElement.appendChild(childContainer);

        itemEl.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (this.expandedDirs.has(entry.path)) {
            this.expandedDirs.delete(entry.path);
            childContainer.style.display = 'none';
            itemEl.querySelector('.tree-icon').textContent = '📁';
          } else {
            this.expandedDirs.add(entry.path);
            childContainer.style.display = 'block';
            itemEl.querySelector('.tree-icon').textContent = '📂';
            if (childContainer.children.length === 0) {
              await this.populateDirNode(entry.path, childContainer, depth + 1);
            }
          }
        });

        if (this.expandedDirs.has(entry.path)) {
          await this.populateDirNode(entry.path, childContainer, depth + 1);
        }
      } else {
        itemEl.addEventListener('click', (e) => {
          e.stopPropagation();
          this.containerEl.querySelectorAll('.tree-item.file').forEach(el => el.classList.remove('selected'));
          itemEl.classList.add('selected');
          if (this.onFileSelectCallback) {
            this.onFileSelectCallback(entry.path);
          }
        });
      }
    }
  }

  getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    switch (ext) {
      case 'js': case 'jsx': case 'mjs': return '🟨';
      case 'ts': case 'tsx': return '🔷';
      case 'py': case 'pyw': return '🐍';
      case 'json': return '📋';
      case 'md': return '📝';
      case 'html': return '🌐';
      case 'css': case 'scss': case 'less': return '🎨';
      case 'sh': case 'bash': case 'zsh': return '🐚';
      case 'png': case 'jpg': case 'jpeg': case 'svg': case 'gif': return '🖼️';
      default: return '📄';
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileExplorer;
}
