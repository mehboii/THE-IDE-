class FileExplorer {
  constructor(containerEl, openFolderBtnEl) {
    this.containerEl = containerEl;
    this.openFolderBtnEl = openFolderBtnEl;
    this.currentRootDir = null;
    this.onFileSelectCallback = null;
    this.onRootChangeCallback = null;
    this.expandedDirs = new Set();
    this.watchedRootDir = null;
    this.unsubscribeFileChanges = window.electronAPI.onFileChanged(({ filePath }) => {
      // The main process watches the open root. A rerender keeps the Explorer
      // in sync when terminal agents create, rename, or remove files there.
      if (this.watchedRootDir && filePath === this.watchedRootDir) this.render();
    });

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
    // The main process returns its canonical ProjectRoot; this tree is a view
    // of that exact value instead of maintaining a second root spelling.
    const canonicalRoot = await this.onRootChangeCallback?.(dirPath) || dirPath;
    if (this.currentRootDir === canonicalRoot && !force) return;

    if (this.watchedRootDir && this.watchedRootDir !== canonicalRoot) {
      await window.electronAPI.unwatchFile(this.watchedRootDir);
      this.watchedRootDir = null;
    }
    this.currentRootDir = canonicalRoot;
    this.expandedDirs.clear();
    this.expandedDirs.add(canonicalRoot);
    if (this.watchedRootDir !== canonicalRoot) {
      const watching = await window.electronAPI.watchFile(canonicalRoot);
      if (watching) this.watchedRootDir = canonicalRoot;
    }
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
    header.className = 'file-tree-root-header tree-item folder';
    header.setAttribute('role', 'button');
    header.tabIndex = 0;
    header.setAttribute('aria-expanded', String(this.expandedDirs.has(this.currentRootDir)));
    const folderName = this.currentRootDir.split(/[/\\]/).pop() || this.currentRootDir;
    header.innerHTML = `
      <span class="tree-icon">${this.expandedDirs.has(this.currentRootDir) ? 'v' : '>'}</span>
      <span class="file-tree-root-title" title="${this.currentRootDir}"><strong>${folderName}</strong></span>
    `;
    const toggleRoot = async () => {
      if (window.__IDE_TEST_MODE__) console.info('[FileExplorer] root-toggle', this.currentRootDir);
      if (this.expandedDirs.has(this.currentRootDir)) this.expandedDirs.delete(this.currentRootDir);
      else this.expandedDirs.add(this.currentRootDir);
      // Re-render on expansion so root uses the same fs:read-dir IPC route as
      // nested folders and fresh directory contents are always displayed.
      await this.render();
    };
    header.addEventListener('click', toggleRoot);
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleRoot(); }
    });
    this.containerEl.appendChild(header);

    const rootList = document.createElement('div');
    rootList.className = 'file-tree-list';
    this.containerEl.appendChild(rootList);

    if (this.expandedDirs.has(this.currentRootDir)) await this.populateDirNode(this.currentRootDir, rootList, 0);
  }

  async populateDirNode(dirPath, parentElement, depth) {
    const entries = await window.electronAPI.readDir(dirPath);
    if (window.__IDE_TEST_MODE__) console.info('[FileExplorer] read-dir', dirPath, Array.isArray(entries) ? entries.length : 'invalid');
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
        ? (this.expandedDirs.has(entry.path) ? 'v' : '>')
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
            itemEl.querySelector('.tree-icon').textContent = '>';
          } else {
            this.expandedDirs.add(entry.path);
            childContainer.style.display = 'block';
            itemEl.querySelector('.tree-icon').textContent = 'v';
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
      case 'js': case 'jsx': case 'mjs': return 'JS';
      case 'ts': case 'tsx': return 'TS';
      case 'py': case 'pyw': return 'PY';
      case 'json': return '{}';
      case 'md': return 'MD';
      case 'html': return '<>';
      case 'css': case 'scss': case 'less': return '#';
      case 'sh': case 'bash': case 'zsh': return '>';
      default: return '-';
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileExplorer;
}
