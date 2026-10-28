import { Room, lineupProblems, type ServerMessage } from '../src/index';
import { readFileSync } from 'fs';
const sock = () => { const got: ServerMessage[] = []; return { got, ws: { send: (d: string) => got.push(JSON.parse(d)), close: () => console.log('CLOSE called') } }; };
const room = new Room(); const a = sock(); const b = sock();
const ca = room.connect(a.ws, '0'); const cb = room.connect(b.ws, '1');
const terms = { scale: 'expanded', settings: { killScore: 42, decapitation: true, turnLimit: 25, deploy: 'fixed', environment: 'gravity', terrain: 'city', supply: true } };
const aj = JSON.parse(readFileSync('../../logs/seat/agents6-0/' + process.argv[2], 'utf8'));
const bj = JSON.parse(readFileSync('../../logs/seat/agents6-1/sent-1793206531944.json', 'utf8'));
console.log('A problems', lineupProblems(aj.roster, 'expanded', terms.settings as never));
console.log('B problems', lineupProblems(bj.roster, 'expanded', terms.settings as never));
try { ca.message(JSON.stringify(aj)); cb.message(JSON.stringify(bj)); } catch (e) { console.log('THROW', (e as Error).stack); }
console.log(a.got.map((m) => m.t), b.got.filter((m) => m.t === 'error'), room.match?.phase);
