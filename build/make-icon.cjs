// Genera build/icon.png (1024x1024) dibujándolo con un canvas de Electron. Uso: npx electron build/make-icon.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const draw = `(() => {
  const c = document.createElement('canvas'); c.width = c.height = 1024;
  const g = c.getContext('2d');
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  const bg = g.createLinearGradient(0, 0, 1024, 1024); bg.addColorStop(0, '#3b82f6'); bg.addColorStop(1, '#1d4ed8');
  g.fillStyle = bg; rr(60, 60, 904, 904, 200); g.fill();
  // mueble: cuerpo con dos puertas, repisas y zócalo
  g.fillStyle = '#ffffff'; rr(250, 190, 524, 560, 24); g.fill();
  g.fillStyle = '#dbe7ff'; rr(282, 222, 228, 496, 12); g.fill(); rr(514, 222, 228, 496, 12); g.fill();
  g.fillStyle = '#1d4ed8'; rr(470, 440, 14, 110, 7); g.fill(); rr(540, 440, 14, 110, 7); g.fill();
  g.fillStyle = '#ffffff'; rr(290, 770, 444, 70, 14); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 10; g.setLineDash([26, 18]);
  g.beginPath(); g.moveTo(190, 905); g.lineTo(834, 905); g.stroke();
  return c.toDataURL('image/png');
})()`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<html></html>');
  const url = await win.webContents.executeJavaScript(draw);
  fs.writeFileSync(path.join(__dirname, 'icon.png'), Buffer.from(url.split(',')[1], 'base64'));
  app.quit();
});
