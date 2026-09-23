// Web Worker: holds the engine (and its memo) so the page stays responsive.
import { createEngine } from './engine.js';
import { advise } from './advisor.js';

let workerEngine = null, workerModel = null;

self.onmessage = (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === 'init') {
      workerModel = msg.config;
      workerEngine = createEngine(msg.config);
    } else if (msg.type === 'advise') {
      let last = 0;
      const advice = advise(workerEngine, msg.state, workerModel.mu, workerModel.sd, (p) => {
        if (p - last >= 0.02 || p === 1) { last = p; self.postMessage({ type: 'progress', id: msg.id, p }); }
      });
      self.postMessage({ type: 'advice', id: msg.id, advice });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: msg.id, message: String(e?.message ?? e) });
  }
};
