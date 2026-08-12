class EditorApp {
  constructor() {
    this.manager = new CodeEditorManager(
      document.getElementById('monaco-editor-container'),
      document.getElementById('code-editor-tabs')
    );
    this.rootLabel = document.getElementById('editor-root-label');
    this.rootDirectory = null;
    window.electronAPI.onEditorOpenFile((filePath) => this.openFile(filePath));
  }

  async openFile(filePath) {
    await this.manager.openFile(filePath);
    this.rootDirectory = filePath.replace(/[\\/][^\\/]+$/, '');
    this.rootLabel.textContent = this.rootDirectory;
  }

  async openFolder() {
    const folder = await window.electronAPI.selectDirectory(this.rootDirectory || undefined);
    if (folder) {
      this.rootDirectory = folder;
      this.rootLabel.textContent = folder;
    }
  }

  save() { return this.manager.saveActiveFile(); }
  saveAs() { return this.manager.saveAsActiveFile(); }
}

document.addEventListener('DOMContentLoaded', () => {
  window.editorApp = new EditorApp();
});
