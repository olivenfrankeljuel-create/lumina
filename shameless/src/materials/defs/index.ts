import type { MaterialName } from '../../core/types';
import type { MatDef } from './types';
import * as arch from './architecture';
import * as ground from './ground';
import * as metal from './metal';
import * as wood from './wood';
import * as misc from './misc';
import * as gear from './gear';

export const DEFS: Record<MaterialName, MatDef> = {
  concrete: arch.concrete,
  concrete_dirty: arch.concrete_dirty,
  concrete_floor: arch.concrete_floor,
  brick_red: arch.brick_red,
  brick_tan: arch.brick_tan,
  plaster_white: arch.plaster_white,
  plaster_worn: arch.plaster_worn,
  asphalt: ground.asphalt,
  dirt: ground.dirt,
  sand: ground.sand,
  gravel: ground.gravel,
  grass_dry: ground.grass_dry,
  mud: ground.mud,
  metal_painted_green: metal.metal_painted_green,
  metal_painted_blue: metal.metal_painted_blue,
  metal_rusty: metal.metal_rusty,
  metal_corrugated: metal.metal_corrugated,
  metal_bare: metal.metal_bare,
  metal_diamond_plate: metal.metal_diamond_plate,
  wood_planks: wood.wood_planks,
  wood_pallet: wood.wood_pallet,
  wood_painted: wood.wood_painted,
  plywood: wood.plywood,
  tile_floor: misc.tile_floor,
  roof_tiles: misc.roof_tiles,
  sandbag: misc.sandbag,
  tarp: misc.tarp,
  canvas: misc.canvas,
  rubber: misc.rubber,
  glass: misc.glass,
  glass_dirty: misc.glass_dirty,
  gun_parkerized: gear.gun_parkerized,
  gun_polymer_black: gear.gun_polymer_black,
  gun_polymer_fde: gear.gun_polymer_fde,
  gun_anodized: gear.gun_anodized,
  gun_wood: wood.gun_wood,
  cloth_multicam: gear.cloth_multicam,
  cloth_olive: gear.cloth_olive,
  cloth_black: gear.cloth_black,
  glove_leather: gear.glove_leather,
  skin: gear.skin,
  car_paint_white: misc.car_paint_white,
  car_paint_red: misc.car_paint_red,
  chrome: misc.chrome,
  plastic_black: misc.plastic_black,
  emissive_light: misc.emissive_light,
};
