import { Game } from '../src/engine.js';
import { presetFor, expandComposition } from '../src/roles.js';
import { pickPersonas } from '../src/personas.js';
import { AIAgent } from '../src/agent.js';
import { MockProvider } from '../src/providers.js';

export function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function buildGame({ n = 9, seed = 1, cfg = {} } = {}) {
  const rng = seeded(seed);
  const comp = presetFor(n);
  const roles = expandComposition(comp);
  for (let i = roles.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [roles[i], roles[j]] = [roles[j], roles[i]]; }
  const personas = pickPersonas(n, rng);
  const players = roles.map((role, i) => ({
    seat: i + 1, name: personas[i].name, role, persona: personas[i], modelLabel: 'mock',
    agent: new AIAgent({ provider: new MockProvider({ rng }), label: 'mock' }),
  }));
  return new Game({ cfg: { playerCount: n, composition: comp, ...cfg }, players, rng });
}
