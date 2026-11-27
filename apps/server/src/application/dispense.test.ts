import { describe, expect, it } from 'vitest';
import { dispenseWithTimeout } from './dispense';
import { CapturingLogger, ScriptedDispenser, sleep } from '../testing/scripted-dispenser';

const req = { unitId: 'o:p:1', productId: 'p' };

describe('dispenseWithTimeout', () => {
  it('livraison normale', async () => {
    const d = new ScriptedDispenser();
    expect(await dispenseWithTimeout(d, req, 100, new CapturingLogger())).toEqual({ delivered: true });
  });

  it('panne signalée par le matériel : reason conservée', async () => {
    const d = new ScriptedDispenser(() => ({ delivered: false, reason: 'JAM' }));
    expect(await dispenseWithTimeout(d, req, 100, new CapturingLogger())).toEqual({ delivered: false, reason: 'JAM' });
  });

  it("le matériel lève (de façon synchrone) : unité non délivrée, jamais d'exception", async () => {
    const d = new ScriptedDispenser(() => {
      throw new Error('capteur HS');
    });
    const r = await dispenseWithTimeout(d, req, 100, new CapturingLogger());
    expect(r).toEqual({ delivered: false, reason: 'ERROR: capteur HS' });
  });

  it('le matériel rejette (promesse) : unité non délivrée', async () => {
    const d = new ScriptedDispenser(() => Promise.reject(new Error('bus')));
    expect(await dispenseWithTimeout(d, req, 100, new CapturingLogger())).toEqual({ delivered: false, reason: 'ERROR: bus' });
  });

  it('blocage : TIMEOUT après le délai, sans attendre le matériel', async () => {
    const d = new ScriptedDispenser(() => new Promise(() => undefined));
    const t0 = Date.now();
    expect(await dispenseWithTimeout(d, req, 60, new CapturingLogger())).toEqual({ delivered: false, reason: 'TIMEOUT' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('livraison TARDIVE après timeout : journalisée en erreur, résultat inchangé', async () => {
    let release: () => void = () => undefined;
    const d = new ScriptedDispenser(() => new Promise((r) => (release = () => r({ delivered: true }))));
    const log = new CapturingLogger();
    expect(await dispenseWithTimeout(d, req, 30, log)).toEqual({ delivered: false, reason: 'TIMEOUT' });
    expect(log.errors).toHaveLength(0);
    release();
    await sleep(20);
    expect(log.errors).toEqual(['Livraison tardive après délai : unité déjà considérée non délivrée']);
  });

  it('un échec tardif après timeout ne journalise rien', async () => {
    let release: () => void = () => undefined;
    const d = new ScriptedDispenser(() => new Promise((r) => (release = () => r({ delivered: false, reason: 'X' }))));
    const log = new CapturingLogger();
    await dispenseWithTimeout(d, req, 30, log);
    release();
    await sleep(20);
    expect(log.errors).toHaveLength(0);
  });
});
