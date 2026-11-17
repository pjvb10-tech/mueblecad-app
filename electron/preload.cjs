const { contextBridge, ipcRenderer } = require('electron');

// Puente mínimo: la web puede pedir guardar la pestaña actual como PDF.
contextBridge.exposeInMainWorld('muebleApp', {
  savePdf: (name) => ipcRenderer.invoke('save-pdf', name),
  // Archivos .mcad: abrir (diálogo), guardar (en la ruta conocida o con diálogo), archivo pendiente del doble clic y aviso de apertura posterior.
  openMcad: () => ipcRenderer.invoke('mcad-open'),
  saveMcad: (file, name, text, forceDialog) => ipcRenderer.invoke('mcad-save', file, name, text, !!forceDialog),
  takePendingMcad: () => ipcRenderer.invoke('mcad-take-pending'),
  onOpenMcad: (cb) => ipcRenderer.on('open-mcad', (_e, payload) => cb(payload)),
});
