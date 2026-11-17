import { edgeMeters } from './edges';
import { nest, type NestingResult } from './nesting';
import { isSolid } from './solids';
import { defaultHardware, type HardwareItem, type Project } from './types';

export interface BudgetLine {
  label: string;
  qty: number;
  unit: string;
  unitPrice: number;
  total: number;
}

export interface Budget {
  lines: BudgetLine[];
  total: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function budget(project: Project, result: NestingResult = nest(project)): Budget {
  const lines: BudgetLine[] = [];
  const counts = new Map<string, number>();
  for (const s of result.sheets) counts.set(s.material.id, (counts.get(s.material.id) ?? 0) + 1);
  for (const m of project.materials) {
    const qty = counts.get(m.id);
    if (!qty) continue;
    const unitPrice = m.price ?? 0;
    lines.push({ label: m.name, qty, unit: 'plancha', unitPrice, total: round2(qty * unitPrice) });
  }
  const meters = round2(project.parts.reduce((s, p) => s + edgeMeters(p), 0));
  if (meters > 0) {
    const unitPrice = project.edgePrice ?? 0;
    lines.push({ label: 'Tapacanto', qty: meters, unit: 'm', unitPrice, total: round2(meters * unitPrice) });
  }
  for (const h of project.hardware ?? []) {
    if (h.qty > 0) lines.push({ label: h.name, qty: h.qty, unit: 'u', unitPrice: h.price, total: round2(h.qty * h.price) });
  }
  return { lines, total: round2(lines.reduce((s, l) => s + l.total, 0)) };
}

/** Cantidades de herrajes deducidas del diseño: bisagras y manijas por puerta, soportes por repisa, correderas por cajón. */
export function hardwareCounts(project: Project): Record<'hinge' | 'handle' | 'shelfpin' | 'slide', number> {
  const c = { hinge: 0, handle: 0, shelfpin: 0, slide: 0 };
  for (const p of project.parts) {
    if (isSolid(p)) continue; // las formas sólidas no son puertas, cajones ni repisas
    const name = p.name.toLowerCase();
    const height = Math.max(...p.size);
    if (name.includes('puerta')) {
      c.hinge += height > 1600 ? 4 : height > 900 ? 3 : 2;
      c.handle += 1;
    } else if (name.includes('cajón') && name.includes('frente')) {
      c.handle += 1;
      c.slide += 1;
    } else if (name.includes('entrepaño')) {
      c.shelfpin += 4;
    }
  }
  return c;
}

/** Recalcula las cantidades de los herrajes con regla y conserva los manuales. */
export function applyAutoHardware(project: Project): HardwareItem[] {
  const counts = hardwareCounts(project);
  const items = project.hardware?.length ? project.hardware : defaultHardware();
  project.hardware = items.map((h) => (h.rule ? { ...h, qty: counts[h.rule] } : h));
  return project.hardware;
}
