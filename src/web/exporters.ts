export { piecesCsv, dxf, gcode } from '../core/export';

export function download(filename: string, content: BlobPart, mime: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
