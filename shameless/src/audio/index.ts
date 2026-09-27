import type { AudioSystem, GameContext } from '../core/types';

// STUB — replaced by the audio workstream.
export async function createAudio(_ctx: GameContext): Promise<AudioSystem> {
  return { async resume() {}, setMasterVolume() {}, update() {} };
}
