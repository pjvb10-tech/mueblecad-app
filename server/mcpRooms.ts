import { z } from 'zod';
import type { Kit } from './mcpKit';
import type { Store } from './store';
import { describeRoom, listOpenings, listRooms, roofInfo, setRoomName } from '../src/core/rooms';

const room = z.string().regex(/^H\d{1,3}$/, 'Clave de habitación como H5');

export function registerRoomTools(kit: Kit, store: Store) {
  kit.read('list_rooms', 'Habitaciones del plano importado: clave H#, nombre, área (m²), caja (x0,z0,x1,z1 en mm) y si tienen acabado. Las claves dependen del plano importado. EN: list rooms of the imported floor plan.', {}, () => {
    const { project } = store.readProject();
    const rooms = listRooms(project);
    return { habitaciones: rooms, techo: roofInfo(project.plan) ?? null, nota: rooms.length ? undefined : 'El proyecto no tiene plano con habitaciones (importa un DXF/DWG en la app).' };
  });

  kit.read('describe_room',
    'Geometría de una habitación H#: contorno real del piso (rectángulos), caras interiores de los muros (lado norte/sur/este/oeste, coordenada, tramo, normal hacia el interior) con las aberturas D#/V#/A# que las cruzan (posición, ancho, antepecho, alto), altura de muros, acabado asignado e información del techo (paneles, espesor, altura; solo visual). Úsala para ubicar muebles o calcular revestimientos. EN: floor outline, wall faces and openings of a room.',
    { room },
    ({ room: id }) => describeRoom(store.readProject().project, id));

  kit.read('list_openings', 'Todas las aberturas del plano con su clave: D# puertas, V# ventanas, A# por confirmar; posición a lo largo del muro, ancho, antepecho y alto (mm). EN: list doors/windows.', {}, () => {
    const { project } = store.readProject();
    return listOpenings(project.plan).map(({ x1, z1, x2, z2, ...o }) => ({ ...o, linea: [x1, z1, x2, z2] }));
  });

  kit.write('set_room_name', 'Cambia el nombre de una habitación H# del plano (por ejemplo «Cocina»). Cadena vacía = sin nombre. EN: rename a room.',
    { room, name: z.string().max(60) },
    ({ room: id, name }) => store.updateProject((p) => setRoomName(p, id, name)));
}
