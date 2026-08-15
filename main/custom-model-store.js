const Store = require('electron-store');

// Kept separate from workspace layouts: endpoint secrets and model settings should
// survive layout changes and are available to every workspace.
const store = new Store({ name: 'custom-models', defaults: { models: [] } });

function list() { return store.get('models', []); }
function save(models) { store.set('models', models); return list(); }

module.exports = { list, save };
