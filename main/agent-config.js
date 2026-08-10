const fs = require('fs');
const path = require('path');
const { app } = require('electron');

class AgentConfig {
  constructor() {
    this.defaultConfigPath = path.join(__dirname, '../config/agents.json');
    this.userConfigPath = path.join(app.getPath('userData'), 'user_agents.json');
  }

  loadAgents() {
    try {
      // First check user custom config in userData
      if (fs.existsSync(this.userConfigPath)) {
        const raw = fs.readFileSync(this.userConfigPath, 'utf-8');
        return JSON.parse(raw).agents || [];
      }
      
      // Fallback to pre-bundled config
      if (fs.existsSync(this.defaultConfigPath)) {
        const raw = fs.readFileSync(this.defaultConfigPath, 'utf-8');
        return JSON.parse(raw).agents || [];
      }
    } catch (err) {
      console.error('[AgentConfig] Error loading agent presets:', err);
    }

    return [
      { id: 'claude', name: 'Claude Code', command: 'claude', description: 'Anthropic Claude Code CLI', env: {} },
      { id: 'codex', name: 'Codex CLI', command: 'codex', description: 'OpenAI Codex CLI', env: {} },
      { id: 'aider', name: 'Aider AI', command: 'aider', description: 'Aider AI pair programmer', env: {} },
      { id: 'shell', name: 'Default Shell', command: '', description: 'Default interactive shell', env: {} }
    ];
  }

  saveAgents(agentsList) {
    try {
      const data = { agents: agentsList };
      fs.writeFileSync(this.userConfigPath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error('[AgentConfig] Error saving agent presets:', err);
      return false;
    }
  }
}

module.exports = new AgentConfig();
